// Shared, type-safe contracts between the content script, the popup, the
// options page and the background service worker.
// Loaded as a classic script (before content.js / popup.js / options.js, and
// via importScripts() in background.js), so everything here is global. Keep
// names prefixed with `FBAH` / `fbah` to avoid collisions.
//
// The TypeSafe API key is NOT part of the synced settings: it lives in
// chrome.storage.local under FBAH_API_KEY_STORAGE_KEY and is only read by the
// background service worker (and written by the options page).

type FBAHHideMode = "collapse" | "remove";

interface FBAHSettings {
  enabled: boolean;
  /** Sponsored posts in the news feed. */
  hideFeedAds: boolean;
  /** "Sponsored" block in the right-hand column. */
  hideRightRailAds: boolean;
  /** Sponsored Reels / Stories / Marketplace tiles. */
  hideReelsAndMarketplaceAds: boolean;
  /** "Suggested for you" posts (not ads strictly speaking — off by default). */
  hideSuggested: boolean;
  /** collapse = thin clickable placeholder, remove = gone entirely. */
  mode: FBAHHideMode;
  /**
   * TypeSafe AI decides which feed posts are ads; Facebook's own "Ad" label is only a signal.
   * When the AI can't answer (no key, invalid key, daily cap…), the local rules decide.
   */
  aiEnabled: boolean;
  /** Hide a post when TypeSafe's "is this an ad" probability is >= this value. */
  aiThreshold: number;
  /** Maximum TypeSafe API calls per local calendar day. */
  aiDailyCap: number;
  /** Show a one-line verdict above each feed post and a status chip on facebook.com. */
  showAIBadges: boolean;
}

const FBAH_AI_THRESHOLD_MIN = 0.5;
const FBAH_AI_THRESHOLD_MAX = 0.99;
const FBAH_AI_CAP_MIN = 1;
const FBAH_AI_CAP_MAX = 10_000;

const FBAH_DEFAULT_SETTINGS: Readonly<FBAHSettings> = Object.freeze({
  enabled: true,
  hideFeedAds: true,
  hideRightRailAds: true,
  hideReelsAndMarketplaceAds: true,
  hideSuggested: false,
  mode: "collapse",
  aiEnabled: true,
  aiThreshold: 0.85,
  aiDailyCap: 300,
  showAIBadges: true,
});

/** chrome.storage.sync — settings only, never the API key. */
const FBAH_STORAGE_KEY = "fbah.settings" as const;
/** chrome.storage.local — the TypeSafe API key (background + options page only). */
const FBAH_API_KEY_STORAGE_KEY = "fbah.typesafe.apiKey" as const;

// ---------- AI classification contract ----------

/** Compact, structured description of one feed post, sent to TypeSafe as `state`. */
interface FBAHPostState {
  /**
   * The post's message plus the title and description of its link preview,
   * whitespace-collapsed, at most FBAH_POST_LIMITS.text chars. Excludes the author name
   * (sent as `header`), the timestamp, reactions, counters, buttons and comments.
   */
  text: string;
  /** The post author's name as shown at the top of the post (short). No timestamp or audience. */
  header: string;
  /**
   * Up to FBAH_POST_LIMITS.links hostnames: the link-preview domain Facebook displays, then
   * outbound link targets (hostnames only, no paths or query strings).
   */
  links: string[];
  /** An ad-style call-to-action button (Shop now, Learn more, En savoir plus…) was found. */
  hasCallToActionButton: boolean;
  /** Text of that button, at most FBAH_POST_LIMITS.ctaText chars; "" when unknown (Facebook often renders it empty). */
  ctaText: string;
  /** Facebook's own "Ad" / "Sponsored" disclosure label was found on the post. */
  hasAdLabel: boolean;
  /** UI language of the Facebook page (BCP 47 tag, may be ""). */
  language: string;
}

const FBAH_POST_LIMITS = Object.freeze({ text: 1500, header: 200, links: 5, ctaText: 40, language: 16 });

/**
 * Lookahead requests (posts not inside the window of a visible tab) are sent to TypeSafe
 * together, at most this many posts in one call ("fan-out": one question per post, same state).
 * Urgent requests are always sent alone.
 */
const FBAH_AI_BATCH_MAX = 5;

/** Why a classification did not produce a probability. */
type FBAHAIErrorCode =
  // decided locally, no API call made
  | "disabled"
  | "no_key"
  | "invalid_key"
  | "cap_reached"
  | "busy"
  | "rejected"
  // returned by the TypeSafe client
  | "forbidden"
  | "validation"
  | "rate_limited"
  | "overloaded"
  | "server"
  | "timeout"
  | "network"
  | "bad_response"
  | "unknown";

interface FBAHFailure {
  ok: false;
  error: FBAHAIErrorCode;
  message: string;
  /**
   * How long no AI call will be made (rate limit / overload pause, daily cap until
   * local midnight, busy queue), in ms. Absent when there is no known delay.
   */
  retryAfterMs?: number;
  /**
   * True when the failure came back from a TypeSafe call (counted in the daily usage). Absent when
   * the worker turned the request away without calling TypeSafe (pause, full queue, no key…).
   */
  apiCalled?: boolean;
}

type FBAHClassifyResult =
  | {
      ok: true;
      probability: number;
      cached: false;
      /**
       * Duration of the TypeSafe call made for this answer, measured in the background worker
       * (the client's automatic retries included, time spent waiting for a free slot excluded), in ms.
       */
      latencyMs: number;
      /**
       * Time the request waited in the worker before that call, in ms: for a lookahead request, the
       * wait for its batch to fill (at most 150 ms) plus the wait for a free call slot.
       */
      queuedMs: number;
      /**
       * Number of posts asked about in that call (diagnostics): 1 = the post was sent alone, more =
       * it was part of a batch of lookahead posts, and latencyMs is the time of the whole batch call.
       */
      batchSize: number;
    }
  /** Answered from the cache (memory, chrome.storage.session or chrome.storage.local): no API call. */
  | { ok: true; probability: number; cached: true; latencyMs: 0 }
  | FBAHFailure;

/** "Clear TypeSafe cache" (options page): `removed` = distinct cached answers deleted. */
type FBAHClearCacheResult = { ok: true; removed: number } | FBAHFailure;

/**
 * How "Test key" checked the key: GET /v1/models first; when TypeSafe has no such endpoint (404 /
 * 405) or its answer is not a models list, a tiny POST /v1/systemone classification instead. The
 * classification call also confirms a models list answer when AI calls are paused (rate limit,
 * overload) or the key is marked invalid: a models list alone lifts neither.
 */
type FBAHTestKeyMethod = "models list" | "classification call";

type FBAHTestKeyResult =
  | {
      ok: true;
      method: FBAHTestKeyMethod;
      /**
       * Classification call: the model that answered. Models list: the default model ("jev-latest")
       * when it is listed, else the first model listed, "" when the list is empty.
       */
      model: string;
      /** Duration of the call that succeeded, in ms. */
      latencyMs: number;
    }
  /** `method`: the check that failed; absent when no call was made (e.g. no key). */
  | (FBAHFailure & { method?: FBAHTestKeyMethod });

interface FBAHAIStatus {
  hasKey: boolean;
  /** null = not verified yet (no successful or 401 answer since the key was set). */
  keyValid: boolean | null;
  callsToday: number;
  cap: number;
  lastError: string | null;
}

// ---------- messages ----------

/** Messages handled by the content script (sent with chrome.tabs.sendMessage). */
type FBAHTabMessage =
  | { type: "fbah/getStats" }
  | { type: "fbah/rescan" }
  /** From the background: a key was saved or verified, so AI calls may work again. */
  | { type: "fbah/aiResume" };

/** Messages handled by the background service worker (sent with chrome.runtime.sendMessage). */
type FBAHBackgroundMessage =
  /**
   * `urgent`: the post is inside the window of a visible tab. The worker sends urgent requests
   * alone, starts them before waiting lookahead ones and keeps some call slots for them. Lookahead
   * requests (absent = false) are sent in batches of up to FBAH_AI_BATCH_MAX posts; an urgent
   * request for a post that is still waiting for its batch (sent by another tab, or by the same tab
   * again once the post entered the window) takes it out and sends it alone, and both requests get
   * the same answer.
   */
  | { type: "fbah/classify"; state: FBAHPostState; urgent?: boolean }
  /** From extension pages and facebook.com content scripts (the status contains no secret). */
  | { type: "fbah/aiStatus" }
  | { type: "fbah/testKey" }
  /** From extension pages only: deletes the cached answers (never the key or the usage counters). */
  | { type: "fbah/clearCache" }
  /** From the status chip on facebook.com (or an extension page): opens the options page. */
  | { type: "fbah/openOptions" }
  /**
   * From facebook.com content scripts only: the tab's number of hidden posts changed (sent at most
   * every 300 ms). The worker shows it on the toolbar icon of that tab ("" when 0).
   */
  | { type: "fbah/counts"; hiddenCount: number };

/** Every message the extension can send. Discriminated on `type`. */
type FBAHMessage = FBAHTabMessage | FBAHBackgroundMessage;

interface FBAHHiddenCounts {
  hiddenCount: number;
  hiddenByRules: number;
  hiddenByAI: number;
}

/** Maps each request type to its response payload. */
interface FBAHResponses {
  "fbah/getStats": FBAHHiddenCounts & { url: string };
  "fbah/rescan": FBAHHiddenCounts;
  "fbah/aiResume": { resumed: boolean };
  "fbah/classify": FBAHClassifyResult;
  "fbah/aiStatus": FBAHAIStatus;
  "fbah/testKey": FBAHTestKeyResult;
  "fbah/clearCache": FBAHClearCacheResult;
  "fbah/openOptions": { opened: boolean };
  /** `ok`: the sender was accepted and the toolbar badge updated (or being updated). */
  "fbah/counts": { ok: boolean };
}

type FBAHResponse<M extends FBAHMessage> = FBAHResponses[M["type"]];

function fbahMessageType(value: unknown): unknown {
  return typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
}

function fbahIsTabMessage(value: unknown): value is FBAHTabMessage {
  const t = fbahMessageType(value);
  return t === "fbah/getStats" || t === "fbah/rescan" || t === "fbah/aiResume";
}

/** Shape check only; the background still sanitizes `state` with fbahSanitizePostState. */
function fbahIsBackgroundMessage(value: unknown): value is FBAHBackgroundMessage {
  const t = fbahMessageType(value);
  if (t === "fbah/aiStatus" || t === "fbah/testKey" || t === "fbah/clearCache" || t === "fbah/openOptions") return true;
  if (t === "fbah/counts") {
    const n = (value as { hiddenCount?: unknown }).hiddenCount;
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  }
  if (t !== "fbah/classify") return false;
  const { state, urgent } = value as { state?: unknown; urgent?: unknown };
  if (urgent !== undefined && typeof urgent !== "boolean") return false;
  return typeof state === "object" && state !== null && !Array.isArray(state);
}

// ---------- validation helpers ----------

function fbahCollapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Truncates on a code-point boundary. */
function fbahTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out; // don't split a surrogate pair
}

const FBAH_HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const FBAH_LANGUAGE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * Validates and normalizes a post state coming from an untrusted-ish context
 * (a content script running on facebook.com). Returns null if the shape is wrong.
 */
function fbahSanitizePostState(raw: unknown): FBAHPostState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = r["text"];
  const header = r["header"];
  const links = r["links"];
  const cta = r["hasCallToActionButton"];
  const ctaText = r["ctaText"];
  const hasAdLabel = r["hasAdLabel"];
  const language = r["language"];
  if (typeof text !== "string" || typeof header !== "string") return null;
  if (!Array.isArray(links) || typeof cta !== "boolean") return null;
  if (typeof ctaText !== "string" || typeof hasAdLabel !== "boolean") return null;
  if (typeof language !== "string") return null;

  const hosts: string[] = [];
  for (const h of links) {
    if (typeof h !== "string") return null;
    const host = h.trim().toLowerCase();
    if (FBAH_HOSTNAME_RE.test(host) && !hosts.includes(host)) hosts.push(host);
    if (hosts.length >= FBAH_POST_LIMITS.links) break;
  }
  const lang = language.trim().slice(0, FBAH_POST_LIMITS.language);
  return {
    text: fbahTruncate(fbahCollapseWhitespace(text), FBAH_POST_LIMITS.text),
    header: fbahTruncate(fbahCollapseWhitespace(header), FBAH_POST_LIMITS.header),
    links: hosts,
    hasCallToActionButton: cta,
    ctaText: fbahTruncate(fbahCollapseWhitespace(ctaText), FBAH_POST_LIMITS.ctaText),
    hasAdLabel,
    language: FBAH_LANGUAGE_RE.test(lang) ? lang : "",
  };
}

/** Same rule as the official Python SDK: printable ASCII, no whitespace. */
function fbahIsPlausibleApiKey(key: string): boolean {
  return key.length >= 8 && key.length <= 512 && /^[\x21-\x7e]+$/.test(key);
}

function fbahClampNumber(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Merges whatever is in storage with defaults, dropping unknown/mistyped keys. */
function fbahSanitizeSettings(raw: unknown): FBAHSettings {
  const out: FBAHSettings = { ...FBAH_DEFAULT_SETTINGS };
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  const boolKeys = [
    "enabled",
    "hideFeedAds",
    "hideRightRailAds",
    "hideReelsAndMarketplaceAds",
    "hideSuggested",
    "aiEnabled",
    "showAIBadges",
  ] as const satisfies readonly (keyof FBAHSettings)[];
  for (const k of boolKeys) {
    const v = r[k];
    if (typeof v === "boolean") out[k] = v;
  }
  if (r["mode"] === "collapse" || r["mode"] === "remove") out.mode = r["mode"];

  const threshold = r["aiThreshold"];
  if (typeof threshold === "number" && Number.isFinite(threshold)) {
    out.aiThreshold =
      Math.round(fbahClampNumber(threshold, FBAH_AI_THRESHOLD_MIN, FBAH_AI_THRESHOLD_MAX) * 100) / 100;
  }
  const cap = r["aiDailyCap"];
  if (typeof cap === "number" && Number.isFinite(cap)) {
    out.aiDailyCap = Math.round(fbahClampNumber(cap, FBAH_AI_CAP_MIN, FBAH_AI_CAP_MAX));
  }
  return out;
}

async function fbahLoadSettings(): Promise<FBAHSettings> {
  const data = await chrome.storage.sync.get(FBAH_STORAGE_KEY);
  return fbahSanitizeSettings(data[FBAH_STORAGE_KEY]);
}

async function fbahSaveSettings(settings: FBAHSettings): Promise<void> {
  await chrome.storage.sync.set({ [FBAH_STORAGE_KEY]: fbahSanitizeSettings(settings) });
}

/** Type-safe wrapper around chrome.tabs.sendMessage (popup → content script). */
async function fbahSendToTab<M extends FBAHTabMessage>(
  tabId: number,
  message: M,
): Promise<FBAHResponse<M>> {
  return (await chrome.tabs.sendMessage(tabId, message)) as FBAHResponse<M>;
}

/** Type-safe wrapper around chrome.runtime.sendMessage (→ background service worker). */
async function fbahSendToBackground<M extends FBAHBackgroundMessage>(
  message: M,
): Promise<FBAHResponse<M>> {
  return (await chrome.runtime.sendMessage(message)) as FBAHResponse<M>;
}
