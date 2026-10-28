// Background service worker (MV3, classic script).
//
// This is the ONLY context that reads the TypeSafe API key and talks to
// api.typesafe.ai. Content scripts send it a compact description of a post
// ("fbah/classify") and get back a probability — never the key.
//
// Cost / robustness controls:
//   - cache, keyed by SHA-256 of the stable part of the post state (author, start of the message,
//     link hosts, CTA flag and text, ad-label flag, language, prompt version). Looked up in memory,
//     then chrome.storage.session, then chrome.storage.local. The local layer survives browser
//     restarts: { p, t } per hash (plus `b`, the batch prompt version, for an answer obtained in a
//     batch), at most LOCAL_CACHE_MAX entries, expired LOCAL_CACHE_TTL_MS after `t` (the last time
//     the answer was stored or used, from any layer, refreshed at most once a day), least recently
//     used evicted first. Writes are batched; the only full read of storage.local happens once per
//     worker lifetime, at its first cache write (it also drops expired entries). The session layer
//     has no TTL and no size bound: it lasts until the browser closes. A clear (clearCache) wins
//     over lookups and calls already under way.
//   - identical concurrent requests share one API call
//   - lookahead batching: requests that are not urgent and miss the cache wait in one queue. A
//     batch is formed only when a lookahead call slot is free: up to BATCH_MAX waiting posts go out
//     as ONE TypeSafe call (one question per post, the same state holding every post), as soon as
//     BATCH_MAX are waiting or BATCH_WINDOW_MS after the oldest one arrived. Posts that arrive while
//     the lookahead slots are busy therefore join the next batch instead of each getting a call. A
//     batch takes one call slot and counts as one call toward the daily cap (it may use more tokens
//     than a single call). A batch of one distinct post is sent with the single-post question.
//     Urgent requests are always sent alone and never wait for a batch; a post still waiting for
//     its batch that becomes urgent is taken out and sent alone (once its batch call has started,
//     it gets that call's answer). A batch TypeSafe refuses as malformed (400 / 413 / 422) is asked
//     again post by post on the same slot, so a refusal is final only for a post refused on its
//     own; when none is, the batch form itself was refused and lookahead posts are sent alone for
//     BATCH_OFF_MS.
//   - at most MAX_CONCURRENT API calls at a time, URGENT_RESERVED of them kept for posts inside the
//     window of a visible tab ("urgent"), which also start before waiting lookahead batches;
//     bounded wait queues
//   - daily call cap (settings.aiDailyCap), counted per local calendar day in chrome.storage.local
//   - after a 401/403 the key is marked invalid and no call is made until the key changes
//   - after a 429 / 529, calls pause for Retry-After (or a default delay). The pause is kept in
//     chrome.storage.session, so it survives Chrome stopping and restarting this worker.
//
// Also: "Test key" (models list first, else a tiny classification call; a models list answer alone
// never lifts a rate-limit pause or an invalid-key mark, the classification call confirms first)
// and the toolbar badge (number of hidden posts per Facebook tab, reported by the content scripts).

(self as unknown as { importScripts(...urls: string[]): void }).importScripts("shared.js", "typesafe.js", "adprompt.js");

(() => {
  const USAGE_KEY = "fbah.ai.usage"; // local: { day, calls }
  const STATUS_KEY = "fbah.ai.status"; // local: { keyHash, keyValid, lastError, lastErrorAt }
  const PAUSE_KEY = "fbah.ai.pause"; // session: { until, code }
  const CACHE_PREFIX = "fbah.ai.c."; // session: one entry per state hash → probability (or { p, b })
  const LOCAL_CACHE_PREFIX = "fbah.ai.lc."; // local: one entry per state hash → { p, t } (or { p, t, b })
  const LOCAL_CACHE_MAX = 3_000;
  const LOCAL_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
  /** A cache hit refreshes the entry's `t` at most this often (LRU-ish, without a write per hit). */
  const LOCAL_CACHE_TOUCH_MS = 24 * 60 * 60_000;
  /** New and refreshed local entries are written together, this long after the first one. */
  const LOCAL_CACHE_FLUSH_MS = 500;
  /**
   * Part of every cache key ("paid-ad-v3"): bump FBAH_AD_PROMPT_VERSION (src/adprompt.ts) when the
   * single-post question or the state changes, to invalidate the cache.
   */
  const PROMPT_VERSION = FBAH_AD_PROMPT_VERSION;
  /**
   * Stored with every answer obtained from a batch call; such an answer is used only while it
   * matches FBAH_AD_BATCH_PROMPT_VERSION (src/adprompt.ts). Single-post answers carry none.
   */
  const BATCH_PROMPT_VERSION = FBAH_AD_BATCH_PROMPT_VERSION;
  /** Only the start of the text is part of the cache key, so "See more" expansions reuse the answer. */
  const CACHE_KEY_TEXT_CHARS = 200;
  /**
   * Parallel TypeSafe calls. Best effort with respect to TypeSafe's rate limit (not verified by
   * this extension): a 429 / 529 still pauses every call (see pauseFor).
   */
  const MAX_CONCURRENT = 4;
  /**
   * Slots only urgent requests (a post inside the window of a visible tab) may use: lookahead
   * batches start only while fewer than MAX_CONCURRENT - URGENT_RESERVED calls run. The content
   * script mirrors this (AI_MAX_IN_FLIGHT / AI_VIEWPORT_RESERVED / AI_LOOKAHEAD_MAX_IN_FLIGHT).
   */
  const URGENT_RESERVED = 2;
  /** Lookahead posts asked about in one call at most. */
  const BATCH_MAX = FBAH_AI_BATCH_MAX;
  /** A batch is sent this long after its oldest post arrived (or later, once a slot is free), if it has not filled up before. */
  const BATCH_WINDOW_MS = 150;
  /** After TypeSafe refused the batch form itself (see runCall), lookahead posts are sent alone this long. */
  const BATCH_OFF_MS = 10 * 60_000;
  /** Per queue: urgent requests waiting for a slot; lookahead posts waiting in batches. */
  const MAX_QUEUED = 30;
  const MEMORY_CACHE_MAX = 2_000;
  const RATE_LIMIT_PAUSE_MS = 30_000;
  const OVERLOAD_PAUSE_MS = 15_000;
  /** After the client has given up on a 429 / 529, never resume sooner than this. */
  const MIN_FINAL_PAUSE_MS = 5_000;
  const MAX_PAUSE_MS = 10 * 60_000;
  const BUSY_RETRY_MS = 5_000;
  const FACEBOOK_HOST_RE = /^(?:[a-z0-9-]+\.)*facebook\.com$/;
  const FACEBOOK_TABS = "https://*.facebook.com/*";
  /** Toolbar badge background (Facebook blue). */
  const BADGE_COLOR = "#1877f2";

  // ---------- small persisted cell (chrome.storage.local / .session) ----------

  /**
   * One value in a storage area, cached in memory. The worker can be stopped at any
   * time, so anything that must outlive it goes through one of these.
   */
  class StoredCell<T extends object> {
    private value: T | null = null;
    private loading: Promise<T> | null = null;
    private writes: Promise<void> = Promise.resolve();

    constructor(
      private readonly area: chrome.storage.StorageArea,
      private readonly key: string,
      private readonly parse: (raw: unknown) => T,
    ) {}

    get(): Promise<T> {
      if (this.value !== null) return Promise.resolve(this.value);
      this.loading ??= this.area
        .get(this.key)
        .then((d) => (this.value ??= this.parse(d[this.key])))
        .catch(() => (this.value ??= this.parse(undefined)));
      return this.loading;
    }

    /** `fn` runs synchronously on the latest value, so concurrent updates are never lost. */
    async update(fn: (current: T) => T): Promise<T> {
      await this.get();
      const next = fn(this.value ?? this.parse(undefined));
      this.value = next;
      this.writes = this.writes.then(() => this.area.set({ [this.key]: next })).catch(() => undefined);
      await this.writes;
      return next;
    }
  }

  interface Usage {
    day: string;
    calls: number;
  }

  interface KeyStatus {
    /** Fingerprint of the key this status belongs to (truncated SHA-256; the key itself is never stored here). */
    keyHash: string | null;
    keyValid: boolean | null;
    lastError: string | null;
    lastErrorAt: number | null;
  }

  type PauseCode = "rate_limited" | "overloaded";

  interface Pause {
    /** Epoch ms; no API call before this. 0 = not paused. */
    until: number;
    code: PauseCode;
  }

  const NO_PAUSE: Readonly<Pause> = Object.freeze({ until: 0, code: "rate_limited" });

  const EMPTY_STATUS: Readonly<KeyStatus> = Object.freeze({
    keyHash: null,
    keyValid: null,
    lastError: null,
    lastErrorAt: null,
  });

  function parseUsage(raw: unknown): Usage {
    if (typeof raw === "object" && raw !== null) {
      const r = raw as Record<string, unknown>;
      const day = r["day"];
      const calls = r["calls"];
      if (typeof day === "string" && typeof calls === "number" && Number.isFinite(calls) && calls >= 0) {
        return { day, calls: Math.floor(calls) };
      }
    }
    return { day: localDay(), calls: 0 };
  }

  function parseStatus(raw: unknown): KeyStatus {
    if (typeof raw !== "object" || raw === null) return { ...EMPTY_STATUS };
    const r = raw as Record<string, unknown>;
    const keyHash = r["keyHash"];
    const keyValid = r["keyValid"];
    const lastError = r["lastError"];
    const lastErrorAt = r["lastErrorAt"];
    return {
      keyHash: typeof keyHash === "string" ? keyHash : null,
      keyValid: typeof keyValid === "boolean" ? keyValid : null,
      lastError: typeof lastError === "string" ? lastError : null,
      lastErrorAt: typeof lastErrorAt === "number" ? lastErrorAt : null,
    };
  }

  function parsePause(raw: unknown): Pause {
    if (typeof raw !== "object" || raw === null) return { ...NO_PAUSE };
    const r = raw as Record<string, unknown>;
    const until = r["until"];
    const code = r["code"];
    if (typeof until !== "number" || !Number.isFinite(until)) return { ...NO_PAUSE };
    return { until, code: code === "overloaded" ? "overloaded" : "rate_limited" };
  }

  const usage = new StoredCell<Usage>(chrome.storage.local, USAGE_KEY, parseUsage);
  const status = new StoredCell<KeyStatus>(chrome.storage.local, STATUS_KEY, parseStatus);
  const pause = new StoredCell<Pause>(chrome.storage.session, PAUSE_KEY, parsePause);

  // ---------- helpers ----------

  function localDay(d = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function msUntilLocalMidnight(now = new Date()): number {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return Math.max(1_000, midnight.getTime() - now.getTime());
  }

  async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function keyFingerprint(key: string): Promise<string> {
    return (await sha256Hex(`fbah-key-fingerprint|${key}`)).slice(0, 16);
  }

  /**
   * What identifies "the same post" for the cache. The content script already leaves out
   * the timestamp, reactions, counters and comments; only the start of the message is used
   * so that a truncated post ("…" + See more) and its expanded text share one answer.
   * Two posts by the same author that start with the same CACHE_KEY_TEXT_CHARS characters
   * (with the same link hosts, CTA, ad label and language) share an answer too.
   * hasAdLabel is part of the key: when Facebook's "Ad" label shows up after a "not an ad"
   * answer, the content script asks again and must get a fresh answer.
   * The same key is used whether the answer came from a single-post or a batch call: both ask
   * the same question with the same criteria (batch answers are tagged with their prompt version).
   */
  function cacheKeyMaterial(s: FBAHPostState): string {
    const textStart = s.text
      .replace(/\s*(?:…|\.{3})$/, "")
      .slice(0, CACHE_KEY_TEXT_CHARS)
      .toLowerCase();
    return JSON.stringify([
      PROMPT_VERSION,
      TYPESAFE_DEFAULTS.model,
      s.header.toLowerCase(),
      textStart,
      [...s.links].sort(),
      s.hasCallToActionButton,
      s.ctaText.toLowerCase(),
      s.hasAdLabel,
      s.language.toLowerCase(),
    ]);
  }

  function failure(error: FBAHAIErrorCode, message: string, retryAfterMs?: number): FBAHFailure {
    return retryAfterMs === undefined
      ? { ok: false, error, message }
      : { ok: false, error, message, retryAfterMs: Math.max(0, Math.round(retryAfterMs)) };
  }

  // ---------- settings & key ----------

  let settingsLoad: Promise<FBAHSettings> | null = null;
  function getSettings(): Promise<FBAHSettings> {
    settingsLoad ??= fbahLoadSettings().catch(() => {
      settingsLoad = null;
      return { ...FBAH_DEFAULT_SETTINGS };
    });
    return settingsLoad;
  }

  let keyLoad: Promise<string | null> | null = null;
  function getApiKey(): Promise<string | null> {
    keyLoad ??= chrome.storage.local
      .get(FBAH_API_KEY_STORAGE_KEY)
      .then((d) => {
        const v: unknown = d[FBAH_API_KEY_STORAGE_KEY];
        return typeof v === "string" && fbahIsPlausibleApiKey(v.trim()) ? v.trim() : null;
      })
      .catch(() => {
        keyLoad = null;
        return null;
      });
    return keyLoad;
  }

  // ---------- rate-limit / overload pause (chrome.storage.session) ----------

  /** Extends the pause to `now + ms` (never shortens it). */
  async function pauseFor(code: PauseCode, ms: number): Promise<void> {
    const until = Date.now() + Math.min(MAX_PAUSE_MS, Math.max(0, ms));
    await pause.update((p) => (until > p.until ? { until, code } : p));
  }

  async function clearPause(): Promise<void> {
    await pause.update(() => ({ ...NO_PAUSE }));
  }

  /** The failure to return while paused, or null when calls are allowed. */
  async function activePause(): Promise<FBAHFailure | null> {
    const p = await pause.get();
    const left = p.until - Date.now();
    if (left <= 0) return null;
    const message =
      p.code === "overloaded"
        ? "Paused: TypeSafe reported that it is overloaded."
        : "Paused after a TypeSafe rate-limit answer.";
    return failure(p.code, message, left);
  }

  /** Called by the client before each retry wait: record the server's pause right away, not only after the last attempt. */
  function recordRetryPause(info: TypeSafeRetryInfo): void {
    if (info.code === "rate_limited" || info.code === "overloaded") {
      void pauseFor(info.code, info.delayMs).catch(() => undefined);
    }
  }

  /** Tells the content scripts that AI calls may work again (they stop sending while there is no valid key). */
  async function notifyFacebookTabs(): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({ url: FACEBOOK_TABS });
      await Promise.all(
        tabs.map((t) =>
          t.id === undefined ? undefined : fbahSendToTab(t.id, { type: "fbah/aiResume" }).catch(() => undefined),
        ),
      );
    } catch {
      /* no Facebook tab, or the tabs API is unavailable */
    }
  }

  chrome.storage.sync.onChanged.addListener((changes) => {
    const change = changes[FBAH_STORAGE_KEY];
    if (change) settingsLoad = Promise.resolve(fbahSanitizeSettings(change.newValue));
  });

  chrome.storage.local.onChanged.addListener((changes) => {
    const change = changes[FBAH_API_KEY_STORAGE_KEY];
    if (!change) return;
    keyLoad = null; // re-read lazily; key validity is tracked per key fingerprint
    const added = typeof change.newValue === "string" && change.newValue.trim() !== "";
    void clearPause()
      .catch(() => undefined)
      .then(() => (added ? notifyFacebookTabs() : undefined));
  });

  // Best effort: keep chrome.storage.local (which holds the key) out of content
  // scripts. Chrome may only support this for storage.session; ignore failures.
  try {
    void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);
  } catch {
    /* not supported */
  }

  async function currentKeyStatus(key: string): Promise<{ keyValid: boolean | null; lastError: string | null }> {
    const [st, fp] = await Promise.all([status.get(), keyFingerprint(key)]);
    return st.keyHash === fp ? { keyValid: st.keyValid, lastError: st.lastError } : { keyValid: null, lastError: null };
  }

  /** `error`: the new last error (null clears it); absent keeps the current one. */
  async function noteOutcome(key: string, patch: { keyValid?: boolean; error?: string | null }): Promise<void> {
    const fp = await keyFingerprint(key);
    await status.update((s) => {
      const base: KeyStatus = s.keyHash === fp ? s : { ...EMPTY_STATUS, keyHash: fp };
      const error = patch.error === undefined ? base.lastError : patch.error;
      return {
        keyHash: fp,
        keyValid: patch.keyValid ?? base.keyValid,
        lastError: error,
        lastErrorAt: patch.error === undefined || patch.error === null ? base.lastErrorAt : Date.now(),
      };
    });
  }

  // ---------- daily cap ----------

  /** Atomically checks the cap and counts one call. */
  async function reserveCall(cap: number): Promise<boolean> {
    let allowed = false;
    await usage.update((u) => {
      const today = localDay();
      const calls = u.day === today ? u.calls : 0;
      allowed = calls < cap;
      return { day: today, calls: allowed ? calls + 1 : calls };
    });
    return allowed;
  }

  /** Counts one call without checking the cap ("Test key" works even when the cap is reached). */
  async function countCall(): Promise<void> {
    await usage.update((u) => {
      const today = localDay();
      return { day: today, calls: (u.day === today ? u.calls : 0) + 1 };
    });
  }

  async function callsToday(): Promise<number> {
    const u = await usage.get();
    return u.day === localDay() ? u.calls : 0;
  }

  // ---------- cache: memory → chrome.storage.session → chrome.storage.local ----------

  /**
   * A cached answer: the probability, and `b`, the batch prompt version when it was obtained in a
   * batch call (null: the single-post question).
   */
  interface Answer {
    p: number;
    b: string | null;
  }

  /** Answers obtained with a batch question other than the current one are not used. */
  function isCurrentPrompt(b: string | null | undefined): boolean {
    return b === undefined || b === null || b === BATCH_PROMPT_VERSION;
  }

  /** Insertion-ordered map with at most MEMORY_CACHE_MAX entries (the least recently set one goes first). */
  function boundedSet<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > MEMORY_CACHE_MAX) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
  }

  const memoryCache = new Map<string, Answer>();

  function remember(hash: string, a: Answer): void {
    boundedSet(memoryCache, hash, a);
  }

  /** chrome.storage.session value: the bare probability (single-post question), or { p, b } (batch). */
  function sessionValue(a: Answer): number | { p: number; b: string } {
    return a.b === null ? a.p : { p: a.p, b: a.b };
  }

  function parseSessionValue(v: unknown): Answer | null {
    if (typeof v === "number") return v >= 0 && v <= 1 ? { p: v, b: null } : null;
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    const p = r["p"];
    const b = r["b"];
    if (typeof p !== "number" || !(p >= 0 && p <= 1) || typeof b !== "string" || !isCurrentPrompt(b)) return null;
    return { p, b };
  }

  /**
   * A persistent answer: probability, the last time it was stored or used (epoch ms), and the
   * batch prompt version when it came from a batch call.
   */
  interface LocalEntry {
    p: number;
    t: number;
    b?: string;
  }

  function localEntry(a: Answer, t: number): LocalEntry {
    return a.b === null ? { p: a.p, t } : { p: a.p, t, b: a.b };
  }

  function answerOf(e: LocalEntry): Answer {
    return { p: e.p, b: e.b ?? null };
  }

  function parseLocalEntry(raw: unknown): LocalEntry | null {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const p = r["p"];
    const t = r["t"];
    const b = r["b"];
    if (typeof p !== "number" || !(p >= 0 && p <= 1) || typeof t !== "number" || !Number.isFinite(t)) return null;
    if (b === undefined) return { p, t };
    return typeof b === "string" ? { p, t, b } : null;
  }

  /**
   * Not expired (symmetric, so an entry written while the clock was far ahead does not live
   * forever) and obtained with the current prompt.
   */
  function isUsable(e: LocalEntry, now: number): boolean {
    return Math.abs(now - e.t) < LOCAL_CACHE_TTL_MS && isCurrentPrompt(e.b);
  }

  /**
   * Bumped by clearCache(). Anything read or computed before a clear (a batch, a lookup, an API
   * call) is not written to any cache layer once the generation has changed.
   */
  let cacheGeneration = 0;
  const pendingLocal = new Map<string, LocalEntry>();
  /** hash → `t` of its local entry as far as this worker knows (read, written or queued by it). */
  const localSeen = new Map<string, number>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> = Promise.resolve();
  /** hash → t of every local entry; read once per worker lifetime, at the first flush. */
  let localIndex: Promise<Map<string, number>> | null = null;

  async function readLocalIndex(): Promise<Map<string, number>> {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const index = new Map<string, number>();
    const stale: string[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(LOCAL_CACHE_PREFIX)) continue;
      const e = parseLocalEntry(value);
      if (e !== null && isUsable(e, now)) index.set(key.slice(LOCAL_CACHE_PREFIX.length), e.t);
      else stale.push(key); // expired, from an old batch prompt, or malformed
    }
    if (stale.length > 0) await chrome.storage.local.remove(stale);
    return index;
  }

  function loadLocalIndex(): Promise<Map<string, number>> {
    if (localIndex === null) {
      const load = readLocalIndex();
      localIndex = load;
      load.catch(() => {
        if (localIndex === load) localIndex = null; // try again at the next flush
      });
    }
    return localIndex;
  }

  /** Removes the least recently used entries above LOCAL_CACHE_MAX from `index`; returns their hashes. */
  function overflow(index: Map<string, number>): string[] {
    const extra = index.size - LOCAL_CACHE_MAX;
    if (extra <= 0) return [];
    const oldest = [...index].sort((a, b) => a[1] - b[1]).slice(0, extra).map(([hash]) => hash);
    for (const hash of oldest) index.delete(hash);
    return oldest;
  }

  async function flushLocal(): Promise<void> {
    if (pendingLocal.size === 0) return;
    const generation = cacheGeneration;
    const batch = [...pendingLocal];
    pendingLocal.clear();
    try {
      const index = await loadLocalIndex();
      if (generation !== cacheGeneration) return; // the cache was cleared meanwhile
      const items: Record<string, LocalEntry> = {};
      for (const [hash, e] of batch) {
        items[LOCAL_CACHE_PREFIX + hash] = e;
        index.set(hash, e.t);
      }
      const evicted = overflow(index);
      for (const hash of evicted) localSeen.delete(hash); // written again if it is used again
      await chrome.storage.local.set(items);
      if (evicted.length > 0) await chrome.storage.local.remove(evicted.map((hash) => LOCAL_CACHE_PREFIX + hash));
    } catch {
      /* quota or storage unavailable: memory + session still answer */
    }
  }

  function queueLocal(hash: string, entry: LocalEntry): void {
    pendingLocal.set(hash, entry);
    boundedSet(localSeen, hash, entry.t);
    flushTimer ??= setTimeout(() => {
      flushTimer = undefined;
      flushing = flushing.then(flushLocal);
    }, LOCAL_CACHE_FLUSH_MS);
  }

  /** The local entry's `t` is older than a day (or ahead of the clock): a use should refresh it. */
  function dueForTouch(t: number, now: number): boolean {
    return Math.abs(now - t) >= LOCAL_CACHE_TOUCH_MS;
  }

  /**
   * A hit from memory or chrome.storage.session is a use of the persistent entry too: its `t`
   * moves forward (at most once a day), and an entry pruned meanwhile is written again. An entry
   * this worker knows nothing about is read once (one key), not on every hit.
   */
  function touchLocal(hash: string, a: Answer, generation: number): void {
    const now = Date.now();
    const known = localSeen.get(hash);
    if (known !== undefined) {
      if (dueForTouch(known, now)) queueLocal(hash, localEntry(a, now));
      return;
    }
    boundedSet(localSeen, hash, now); // no second read for the hits that follow
    const key = LOCAL_CACHE_PREFIX + hash;
    chrome.storage.local
      .get(key)
      .then((d) => {
        if (generation !== cacheGeneration) return; // cleared meanwhile
        const e = parseLocalEntry(d[key]);
        if (e !== null && isUsable(e, now) && !dueForTouch(e.t, now)) boundedSet(localSeen, hash, e.t);
        else queueLocal(hash, localEntry(a, now)); // missing, expired, or not refreshed for a day
      })
      .catch(() => localSeen.delete(hash));
  }

  async function localGet(hash: string, generation: number): Promise<Answer | null> {
    const key = LOCAL_CACHE_PREFIX + hash;
    const e = parseLocalEntry((await chrome.storage.local.get(key))[key]);
    if (generation !== cacheGeneration) return null; // read before a clear: that answer is gone
    if (e === null) return null;
    const now = Date.now();
    if (!isUsable(e, now)) {
      localSeen.delete(hash);
      void chrome.storage.local.remove(key).catch(() => undefined);
      void localIndex?.then((index) => index.delete(hash)).catch(() => undefined);
      return null;
    }
    if (dueForTouch(e.t, now)) queueLocal(hash, { ...e, t: now }); // recently used again
    else boundedSet(localSeen, hash, e.t);
    return answerOf(e);
  }

  async function cacheGet(hash: string): Promise<Answer | null> {
    const generation = cacheGeneration;
    const hit = memoryCache.get(hash);
    if (hit !== undefined) {
      touchLocal(hash, hit, generation);
      return hit;
    }
    try {
      const key = CACHE_PREFIX + hash;
      const v = parseSessionValue((await chrome.storage.session.get(key))[key]);
      if (generation !== cacheGeneration) return null; // read before a clear: that answer is gone
      if (v !== null) {
        remember(hash, v);
        touchLocal(hash, v, generation);
        return v;
      }
    } catch {
      /* session storage unavailable */
    }
    try {
      const a = await localGet(hash, generation);
      if (a !== null) {
        remember(hash, a);
        return a;
      }
    } catch {
      /* local storage unavailable */
    }
    return null;
  }

  async function cacheSet(hash: string, a: Answer): Promise<void> {
    remember(hash, a);
    queueLocal(hash, localEntry(a, Date.now()));
    try {
      await chrome.storage.session.set({ [CACHE_PREFIX + hash]: sessionValue(a) });
    } catch {
      /* quota or unavailable: memory + local only */
    }
  }

  /** Deletes every cached answer (memory, session, local). Never the key, usage, status or pause. */
  async function clearCache(): Promise<FBAHClearCacheResult> {
    cacheGeneration++;
    const removed = new Set(memoryCache.keys());
    memoryCache.clear();
    localSeen.clear();
    pendingLocal.clear();
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    localIndex = null;
    await flushing; // a write already under way lands first, so it is removed below
    const [session, local] = await Promise.all([chrome.storage.session.get(null), chrome.storage.local.get(null)]);
    const sessionKeys = Object.keys(session).filter((k) => k.startsWith(CACHE_PREFIX));
    const localKeys = Object.keys(local).filter((k) => k.startsWith(LOCAL_CACHE_PREFIX));
    for (const k of sessionKeys) removed.add(k.slice(CACHE_PREFIX.length));
    for (const k of localKeys) removed.add(k.slice(LOCAL_CACHE_PREFIX.length));
    await Promise.all([
      sessionKeys.length > 0 ? chrome.storage.session.remove(sessionKeys) : undefined,
      localKeys.length > 0 ? chrome.storage.local.remove(localKeys) : undefined,
    ]);
    return { ok: true, removed: removed.size };
  }

  // ---------- concurrency ----------

  /** How urgent a classification is; shared by every request for the same post (see classify). */
  interface Priority {
    urgent: boolean;
  }

  let active = 0;
  /** Urgent single-post calls waiting for a slot. */
  const waitingUrgent: (() => void)[] = [];
  /**
   * Lookahead posts waiting for a call, oldest first. They are grouped into a batch only when a
   * lookahead slot is free (see pump), so posts that arrive while the lookahead slots are busy join
   * the next batch instead of each getting a call of their own. Until then a post can be taken out
   * (promote).
   */
  const lookaheadJobs: Job[] = [];
  /** Runs pump() when the oldest waiting lookahead post's BATCH_WINDOW_MS ends. */
  let batchTimer: { at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Until then lookahead posts are sent alone: TypeSafe refused the batch form itself (see runCall). */
  let batchOffUntil = 0;

  function batchMax(now: number): number {
    return now < batchOffUntil ? 1 : BATCH_MAX;
  }

  /**
   * When the waiting lookahead posts may leave as a batch: now when a batch is full, else at the
   * end of the oldest one's window. Infinity when none is waiting.
   */
  function batchReadyAt(now: number): number {
    const first = lookaheadJobs[0];
    if (first === undefined) return Infinity;
    return lookaheadJobs.length >= batchMax(now) ? now : first.since + BATCH_WINDOW_MS;
  }

  /**
   * Starts what the free slots allow: waiting urgent calls first (any slot), then lookahead
   * batches while fewer than MAX_CONCURRENT - URGENT_RESERVED calls run. Each batch is formed here,
   * from up to batchMax() of the lookahead posts waiting at that moment, oldest first.
   */
  function pump(): void {
    for (;;) {
      if (active < MAX_CONCURRENT) {
        const start = waitingUrgent.shift();
        if (start !== undefined) {
          active++;
          start();
          continue;
        }
      }
      const now = Date.now();
      if (active < MAX_CONCURRENT - URGENT_RESERVED && now >= batchReadyAt(now)) {
        const batch = lookaheadJobs.splice(0, batchMax(now));
        active++;
        void runBatch(batch);
        continue;
      }
      break;
    }
    armBatchTimer();
  }

  /**
   * A timer only while the oldest lookahead post's window is open: a batch that is ready but has no
   * free slot starts on the next release().
   */
  function armBatchTimer(): void {
    const now = Date.now();
    const at = batchReadyAt(now);
    const wanted = at > now && at !== Infinity ? at : null;
    if (batchTimer !== null && batchTimer.at === wanted) return;
    if (batchTimer !== null) clearTimeout(batchTimer.timer);
    batchTimer = null;
    if (wanted === null) return;
    const timer = setTimeout(() => {
      batchTimer = null;
      pump();
    }, wanted - now);
    batchTimer = { at: wanted, timer };
  }

  function acquireUrgent(): Promise<void> {
    return new Promise((start) => {
      waitingUrgent.push(start);
      pump();
    });
  }

  function release(): void {
    active--;
    pump();
  }

  // ---------- failures ----------

  const ERROR_LABELS: Record<TypeSafeErrorCode, string> = {
    invalid_key: "TypeSafe rejected the API key",
    forbidden: "TypeSafe refused the request (permission denied)",
    validation: "TypeSafe rejected the request format",
    rate_limited: "Rate limited by TypeSafe",
    overloaded: "TypeSafe is temporarily overloaded",
    server: "TypeSafe server error",
    timeout: "TypeSafe did not answer in time",
    network: "Could not reach api.typesafe.ai",
    bad_response: "Unexpected answer from TypeSafe",
    unknown: "TypeSafe request failed",
  };

  function errorMessage(e: TypeSafeError): string {
    const httpStatus = e.status === null ? "" : ` (HTTP ${e.status})`;
    return `${ERROR_LABELS[e.code]}${httpStatus}: ${e.message}`;
  }

  async function handleFailure(key: string, e: TypeSafeError): Promise<FBAHFailure> {
    const message = errorMessage(e);
    const code: FBAHAIErrorCode = e.code; // TypeSafeErrorCode ⊂ FBAHAIErrorCode
    if (e.code === "invalid_key" || e.code === "forbidden") {
      await noteOutcome(key, { keyValid: false, error: message });
      return { ...failure(code, message), apiCalled: true };
    }
    let retryAfterMs: number | undefined;
    if (e.code === "rate_limited" || e.code === "overloaded") {
      const fallback = e.code === "rate_limited" ? RATE_LIMIT_PAUSE_MS : OVERLOAD_PAUSE_MS;
      retryAfterMs = Math.min(MAX_PAUSE_MS, Math.max(MIN_FINAL_PAUSE_MS, e.retryAfterMs ?? fallback));
      await pauseFor(e.code, retryAfterMs);
    }
    await noteOutcome(key, { error: message });
    return { ...failure(code, message, retryAfterMs), apiCalled: true };
  }

  function internalError(e: unknown): FBAHFailure {
    const detail = e instanceof Error ? e.message : String(e);
    return failure("unknown", `Internal error: ${detail.slice(0, 200)}`);
  }

  // ---------- TypeSafe calls ----------

  /** One post waiting for an answer from TypeSafe (alone, or as part of a batch). */
  interface Job {
    hash: string;
    state: FBAHPostState;
    /** cacheGeneration when the request arrived: its answer is not cached across a clear. */
    generation: number;
    /** When the request started waiting in the worker (queuedMs counts from here). */
    since: number;
    resolve: (r: FBAHClassifyResult) => void;
  }

  /** The checks made once a call slot is held. Counts the call toward the daily cap when it may be made. */
  async function readyToCall(): Promise<{ ok: true; key: string } | { ok: false; failure: FBAHFailure }> {
    // Everything below may have changed while the request was waiting.
    const settings = await getSettings();
    if (!settings.enabled || !settings.aiEnabled) return { ok: false, failure: failure("disabled", "AI detection is turned off.") };
    const key = await getApiKey();
    if (!key) return { ok: false, failure: failure("no_key", "No TypeSafe API key saved.") };
    if ((await currentKeyStatus(key)).keyValid === false) {
      return {
        ok: false,
        failure: failure("invalid_key", "The saved TypeSafe API key was rejected. Update it in the options page."),
      };
    }
    const pausedNow = await activePause();
    if (pausedNow) return { ok: false, failure: pausedNow };
    if (!(await reserveCall(settings.aiDailyCap))) {
      return {
        ok: false,
        failure: failure("cap_reached", `Daily limit of ${settings.aiDailyCap} TypeSafe calls reached.`, msUntilLocalMidnight()),
      };
    }
    return { ok: true, key };
  }

  /** How one TypeSafe call for a group of jobs ended (see callOnce). */
  type CallEnd =
    /** At least one usable answer. Every job is resolved. */
    | { kind: "answered" }
    /** The single-post question was refused as malformed (400 / 413 / 422). Every job is resolved. */
    | { kind: "refused" }
    /** Any other failure, or no call could be made (pause, cap…). Every job is resolved. */
    | { kind: "failed" }
    /** A batch refused as malformed (400 / 413 / 422). No job is resolved; one group per distinct post. */
    | { kind: "split"; groups: Job[][] };

  /** TypeSafe refused the request itself (400 / 422, or 413 Payload Too Large). For a batch: its form, or one of its posts. */
  function refusedAsMalformed(e: TypeSafeError): boolean {
    return e.code === "validation" || e.status === 413;
  }

  /**
   * One TypeSafe call for `jobs`: the single-post question when there is one distinct post, else
   * one batch (one question per distinct post, identical states asked once). Counts as one call
   * toward the daily cap. A failure of the call goes to every job (apiCalled: true), except a batch
   * refused as malformed, which is left to the caller ("split"); a missing or malformed answer is
   * bad_response for its post only. Each answer is cached under its post's own hash.
   */
  async function callOnce(jobs: readonly Job[]): Promise<CallEnd> {
    const startedAt = Date.now();
    const settle = (r: FBAHClassifyResult): void => {
      for (const job of jobs) job.resolve(r);
    };
    const ready = await readyToCall();
    if (!ready.ok) {
      settle(ready.failure);
      return { kind: "failed" };
    }
    const key = ready.key;

    const posts: FBAHPostState[] = [];
    const groups: Job[][] = [];
    const indexOfState = new Map<string, number>();
    const asked = jobs.map((job) => {
      const same = JSON.stringify(fbahAdState(job.state));
      let i = indexOfState.get(same);
      if (i === undefined) {
        i = posts.length;
        posts.push(job.state);
        groups.push([]);
        indexOfState.set(same, i);
      }
      groups[i]?.push(job);
      return { job, i };
    });
    const [first] = posts;
    const request =
      first !== undefined && posts.length === 1 ? fbahBuildAdRequest({ single: first }) : fbahBuildAdRequest({ batch: posts });

    const callStart = Date.now();
    const outcome = await typesafeSystemOnePartial(
      { apiKey: key, onRetry: recordRetryPause },
      { state: request.state, questions: request.questions },
    );
    const latencyMs = Math.max(0, Date.now() - callStart);
    if (!outcome.ok) {
      if (request.kind === "batch" && refusedAsMalformed(outcome.error)) {
        await noteOutcome(key, { error: `${errorMessage(outcome.error)} (a batch of ${posts.length} posts: asked again one by one)` });
        return { kind: "split", groups };
      }
      settle(await handleFailure(key, outcome.error));
      return { kind: refusedAsMalformed(outcome.error) ? "refused" : "failed" };
    }

    const { answers, answerErrors } = outcome.value;
    // Per question: the probability, or why the answer is unusable (validated at runtime by the client).
    const found: (number | string)[] = request.ids.map(
      (id) => answers[id]?.noul ?? `answers.${id}: ${answerErrors[id] ?? "answer is missing"}.`,
    );
    const problems = found.filter((f): f is string => typeof f === "string");
    if (problems.length === found.length) {
      // Not one usable answer: the call failed as a whole.
      const e: TypeSafeError = {
        code: "bad_response",
        status: null,
        message: problems.join(" ").slice(0, 300),
        attempts: outcome.value.attempts,
        retryAfterMs: null,
        requestId: outcome.value.requestId,
      };
      settle(await handleFailure(key, e));
      return { kind: "failed" };
    }

    const batchSize = request.ids.length;
    const tag = request.kind === "batch" ? request.version : null;
    const results: [Job, FBAHClassifyResult][] = [];
    for (const { job, i } of asked) {
      const p = found[i];
      if (typeof p !== "number") {
        const message = `${ERROR_LABELS.bad_response}: ${p ?? "answer is missing"}`;
        results.push([job, { ...failure("bad_response", message), apiCalled: true }]);
        continue;
      }
      if (job.generation === cacheGeneration) await cacheSet(job.hash, { p, b: tag }); // not cached across a clear
      results.push([job, { ok: true, probability: p, cached: false, latencyMs, queuedMs: Math.max(0, startedAt - job.since), batchSize }]);
    }
    const firstProblem = problems[0];
    await noteOutcome(key, {
      keyValid: true,
      error: firstProblem === undefined ? null : `${ERROR_LABELS.bad_response}: ${firstProblem}`,
    });
    for (const [job, r] of results) job.resolve(r);
    return { kind: "answered" };
  }

  /**
   * The TypeSafe call(s) for `jobs`, made while the caller holds one call slot. Usually one call
   * (callOnce). A batch TypeSafe refuses as malformed (400 / 413 / 422) was refused because of one
   * of its posts or because of the batch form itself: each of its posts is then asked alone, one
   * after the other on this slot (one call each toward the daily cap), so that a refusal stays final
   * ("validation") only for a post refused on its own. When none of them is refused and at least one
   * is answered, the batch form is what TypeSafe rejects: lookahead posts are sent alone for
   * BATCH_OFF_MS. Resolves every job, never throws.
   */
  async function runCall(jobs: readonly Job[]): Promise<void> {
    try {
      const end = await callOnce(jobs);
      if (end.kind !== "split") return;
      let answered = 0;
      let refused = 0;
      for (const group of end.groups) {
        const alone = await callOnce(group); // one distinct post: the single-post question
        if (alone.kind === "answered") answered++;
        else if (alone.kind === "refused") refused++;
      }
      if (answered > 0 && refused === 0) batchOffUntil = Date.now() + BATCH_OFF_MS;
    } catch (e) {
      const r = internalError(e);
      for (const job of jobs) job.resolve(r); // no effect on the jobs already resolved
    }
  }

  /** An urgent post: sent alone, on a slot of its own (the reserved ones included). */
  async function runSingle(job: Job): Promise<void> {
    if (waitingUrgent.length >= MAX_QUEUED) {
      job.resolve(failure("busy", "Too many posts are waiting for classification.", BUSY_RETRY_MS));
      return;
    }
    await acquireUrgent();
    try {
      await runCall([job]);
    } finally {
      release();
    }
  }

  // ---------- lookahead batching ----------

  function addToBatch(job: Job): void {
    lookaheadJobs.push(job);
    pump();
  }

  /** A batch formed by pump(), which has already counted its slot in `active`. */
  async function runBatch(batch: readonly Job[]): Promise<void> {
    try {
      await runCall(batch);
    } finally {
      release();
    }
  }

  /**
   * A lookahead post is now urgent (on screen in a visible tab): if it is still waiting for its
   * batch, it is taken out and sent alone. Once its batch call has started, it gets that call's answer.
   */
  function promote(hash: string): void {
    const i = lookaheadJobs.findIndex((j) => j.hash === hash);
    if (i < 0) return;
    const [job] = lookaheadJobs.splice(i, 1);
    armBatchTimer(); // the oldest waiting post may have changed
    if (job !== undefined) void runSingle(job); // its wait so far still counts in queuedMs
  }

  // ---------- classification ----------

  const inflight = new Map<string, { priority: Priority; result: Promise<FBAHClassifyResult> }>();

  async function classify(state: FBAHPostState, urgent: boolean): Promise<FBAHClassifyResult> {
    const settings = await getSettings();
    if (!settings.enabled || !settings.aiEnabled) return failure("disabled", "AI detection is turned off.");
    if (!(await getApiKey())) return failure("no_key", "No TypeSafe API key saved.");

    const hash = await sha256Hex(cacheKeyMaterial(state));
    const shared = inflight.get(hash);
    if (shared) {
      if (urgent && !shared.priority.urgent) {
        shared.priority.urgent = true; // e.g. the same ad, ahead of time in one tab and on screen in another
        promote(hash);
      }
      return shared.result;
    }
    const priority: Priority = { urgent };
    const result = (async (): Promise<FBAHClassifyResult> => {
      const cached = await cacheGet(hash);
      if (cached !== null) return { ok: true, probability: cached.p, cached: true, latencyMs: 0 };
      return classifyUncached(state, hash, priority);
    })().finally(() => inflight.delete(hash));
    inflight.set(hash, { priority, result });
    return result;
  }

  async function classifyUncached(state: FBAHPostState, hash: string, priority: Priority): Promise<FBAHClassifyResult> {
    const generation = cacheGeneration;
    const paused = await activePause();
    if (paused) return paused;
    return new Promise((resolve) => {
      const job: Job = { hash, state, generation, since: Date.now(), resolve };
      // Read after every await above: the post may have become urgent meanwhile.
      if (priority.urgent) void runSingle(job);
      else if (lookaheadJobs.length >= MAX_QUEUED) resolve(failure("busy", "Too many posts are waiting for classification.", BUSY_RETRY_MS));
      else addToBatch(job);
    });
  }

  // ---------- Test key ----------

  /** A classification call succeeded: the pause and an invalid-key mark are lifted, and the tabs resume. */
  async function classificationWorks(key: string, model: string, latencyMs: number): Promise<FBAHTestKeyResult> {
    await clearPause();
    await noteOutcome(key, { keyValid: true, error: null });
    void notifyFacebookTabs();
    return { ok: true, method: "classification call", model, latencyMs };
  }

  /**
   * GET /v1/models first. 401 / 403 → the key is rejected (no second call). A models list proves
   * that the key is accepted, not that classification calls work: it is enough only when there is
   * no rate-limit / overload pause and the key is not marked invalid (e.g. a 403 from
   * /v1/systemone); the key is then marked valid, the last error kept, nothing else changed.
   * Otherwise, and after a 404 / 405 (no models list there) or an answer that is not a models list,
   * a tiny POST /v1/systemone decides: only its success lifts the pause and the invalid-key mark and
   * tells the tabs to resume. Every request sent counts as one call in today's usage (whether the
   * models list costs tokens is not documented), but "Test key" is never blocked by the daily cap.
   */
  async function testKey(): Promise<FBAHTestKeyResult> {
    const key = await getApiKey();
    if (!key) return failure("no_key", "No TypeSafe API key saved.");
    const options: TypeSafeClientOptions = { apiKey: key, maxRetries: 1, onRetry: recordRetryPause };

    await countCall();
    let started = Date.now();
    const listed = await typesafeListModels(options);
    let listOk = false;
    if (listed.ok) {
      const latencyMs = Date.now() - started;
      const models = listed.value.models;
      const model = models.includes(TYPESAFE_DEFAULTS.model) ? TYPESAFE_DEFAULTS.model : (models[0] ?? "");
      if ((await activePause()) === null && (await currentKeyStatus(key)).keyValid !== false) {
        await noteOutcome(key, { keyValid: true });
        return { ok: true, method: "models list", model, latencyMs };
      }
      listOk = true; // paused, or refused by /v1/systemone: confirmed with a classification call
    } else if (!listed.unsupported && listed.error.code !== "bad_response") {
      return { ...(await handleFailure(key, listed.error)), method: "models list" };
    }

    await countCall();
    started = Date.now();
    const outcome = await typesafeSystemOne(options, {
      state: "Connectivity check sent by the Facebook Ad Hider browser extension.",
      questions: { ping: { type: "noul", instructions: "Is this text a connectivity check?" } },
    });
    if (!outcome.ok) {
      const f = await handleFailure(key, outcome.error);
      const message = listOk ? `The models list accepts the key, but the classification check failed: ${f.message}` : f.message;
      return { ...f, message, method: "classification call" };
    }
    return classificationWorks(key, outcome.value.model, Date.now() - started);
  }

  async function aiStatus(): Promise<FBAHAIStatus> {
    const [settings, key, calls] = await Promise.all([getSettings(), getApiKey(), callsToday()]);
    const st = key ? await currentKeyStatus(key) : { keyValid: null, lastError: null };
    return { hasKey: key !== null, keyValid: st.keyValid, callsToday: calls, cap: settings.aiDailyCap, lastError: st.lastError };
  }

  // ---------- toolbar badge: hidden posts per Facebook tab ----------

  /** tabId → badge text last set by this worker (skips identical updates; Chrome keeps the badge itself). */
  const badgeTexts = new Map<number, string>();

  function badgeLabel(hiddenCount: number): string {
    if (hiddenCount <= 0) return "";
    return hiddenCount > 999 ? "999+" : String(hiddenCount);
  }

  function setTabBadge(tabId: number, hiddenCount: number): void {
    const text = badgeLabel(hiddenCount);
    if (badgeTexts.get(tabId) === text) return;
    badgeTexts.set(tabId, text);
    Promise.all([
      text === "" ? undefined : chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }),
      chrome.action.setBadgeText({ tabId, text }),
    ]).catch(() => badgeTexts.delete(tabId)); // e.g. the tab was closed meanwhile
  }

  // A new page is loading in the tab: its content script reports its own count. Unconditional,
  // since a restarted worker no longer knows which tabs have a badge.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== "loading") return;
    badgeTexts.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  });

  // Chrome drops a closed tab's badge itself.
  chrome.tabs.onRemoved.addListener((tabId) => {
    badgeTexts.delete(tabId);
  });

  // ---------- messaging ----------

  function isFacebookContentScript(sender: chrome.runtime.MessageSender): boolean {
    if (sender.tab === undefined || typeof sender.url !== "string") return false;
    try {
      const url = new URL(sender.url);
      return url.protocol === "https:" && FACEBOOK_HOST_RE.test(url.hostname);
    } catch {
      return false;
    }
  }

  function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
    return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  }

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false; // only this extension
    if (!fbahIsBackgroundMessage(msg)) return false;

    switch (msg.type) {
      case "fbah/classify": {
        const send = (r: FBAHResponse<typeof msg>) => sendResponse(r);
        if (!isFacebookContentScript(sender)) {
          send(failure("rejected", "classify is only accepted from facebook.com content scripts."));
          return false;
        }
        const state = fbahSanitizePostState(msg.state);
        if (!state) {
          send(failure("rejected", "Malformed post state."));
          return false;
        }
        classify(state, msg.urgent === true).catch(internalError).then(send);
        return true;
      }
      case "fbah/counts": {
        const send = (r: FBAHResponse<typeof msg>) => sendResponse(r);
        const tabId = sender.tab?.id;
        if (!isFacebookContentScript(sender) || tabId === undefined || tabId < 0) {
          send({ ok: false });
          return false;
        }
        setTabBadge(tabId, msg.hiddenCount);
        send({ ok: true });
        return false;
      }
      case "fbah/testKey": {
        const send = (r: FBAHResponse<typeof msg>) => sendResponse(r);
        if (!isExtensionPage(sender)) {
          send(failure("rejected", "testKey is only accepted from extension pages."));
          return false;
        }
        testKey().catch(internalError).then(send);
        return true;
      }
      case "fbah/clearCache": {
        const send = (r: FBAHResponse<typeof msg>) => sendResponse(r);
        if (!isExtensionPage(sender)) {
          send(failure("rejected", "clearCache is only accepted from extension pages."));
          return false;
        }
        clearCache().catch(internalError).then(send);
        return true;
      }
      case "fbah/aiStatus": {
        // Also answered for the status chip on facebook.com: it holds no key and no post data.
        const send = (r: FBAHResponse<typeof msg>) => sendResponse(r);
        if (!isExtensionPage(sender) && !isFacebookContentScript(sender)) return false;
        aiStatus()
          .catch(
            (e: unknown): FBAHAIStatus => ({
              hasKey: false,
              keyValid: null,
              callsToday: 0,
              cap: FBAH_DEFAULT_SETTINGS.aiDailyCap,
              lastError: internalError(e).message,
            }),
          )
          .then(send);
        return true;
      }
      case "fbah/openOptions": {
        const send = (r: FBAHResponse<typeof msg>) => sendResponse(r);
        if (!isExtensionPage(sender) && !isFacebookContentScript(sender)) {
          send({ opened: false });
          return false;
        }
        chrome.runtime.openOptionsPage().then(
          () => send({ opened: true }),
          () => send({ opened: false }),
        );
        return true;
      }
      default:
        return false;
    }
  });
})();
