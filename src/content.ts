// Content script: finds sponsored units in Facebook's DOM and hides them.
// Facebook obfuscates the "Sponsored" label (split letters, decoy characters,
// CSS `order` shuffling, SVG <use> references), so detection combines several
// signals. These local rules are the fast path: a definite ad is hidden
// immediately, with no network call.
//
// Optional AI path: a feed post that the rules can't resolve, once it is
// actually on screen, is summarised into a compact FBAHPostState and sent to
// the background service worker ("fbah/classify"), which asks TypeSafe AI.
// This script never sees the API key and never talks to TypeSafe itself.
//
// All per-post state (checked, hidden, AI verdicts) lives in this script's
// memory. facebook.com scripts share the DOM with us, so nothing is read back
// from DOM attributes: data-fbah-hidden is written only for the CSS rule.

(() => {
  const SPONSORED_LABELS: ReadonlySet<string> = new Set(
    [
      "Sponsored", "Sponsorisé", "Sponsorisée", "Gesponsert", "Patrocinado",
      "Patrocinada", "Sponsorizzato", "Sponsorizzata", "Gesponsord", "Sponsrad",
      "Sponset", "Sponsoreret", "Sponsorowane", "Sponsorlu", "Реклама",
      "Спонсорирано", "Sponzorováno", "Szponzorált", "Χορηγούμενη", "ممول",
      "广告", "赞助内容", "広告", "광고",
    ].map(normalize),
  );

  const SUGGESTED_LABELS: ReadonlySet<string> = new Set(
    [
      "Suggested for you", "Suggestions pour vous", "Suggestion pour vous",
      "Vorgeschlagen für dich", "Sugerencias para ti", "Suggeriti per te",
    ].map(normalize),
  );

  /** Ad-style call-to-action button labels (a signal for the AI, not a rule on its own). */
  const CTA_LABELS: ReadonlySet<string> = new Set(
    [
      // English
      "Shop now", "Learn more", "Sign up", "Book now", "Buy now", "Order now", "Start order",
      "Download", "Install now", "Use app", "Play game", "Get offer", "Get quote", "Get started",
      "Apply now", "Contact us", "Subscribe", "Donate now", "Buy tickets", "Get showtimes",
      "Listen now", "Watch more", "See menu", "Request time", "Get promotions",
      // French
      "En savoir plus", "Acheter", "Acheter maintenant", "Achetez maintenant", "S'inscrire",
      "Inscrivez-vous", "Réserver", "Réserver maintenant", "Commander", "Commander maintenant",
      "Télécharger", "Installer", "Installer maintenant", "Utiliser l'application", "Jouer",
      "Obtenir l'offre", "Profiter de l'offre", "Demander un devis", "Commencer", "Postuler",
      "Postuler maintenant", "Nous contacter", "S'abonner", "Faire un don", "Voir le menu",
      // German / Spanish / Italian
      "Jetzt einkaufen", "Mehr dazu", "Registrieren", "Jetzt buchen", "Herunterladen",
      "Comprar ahora", "Más información", "Registrarte", "Reservar ahora", "Descargar",
      "Acquista ora", "Scopri di più", "Iscriviti", "Prenota ora", "Scarica",
    ].map(ctaNormalize),
  );

  const MAX_CHECKS_PER_UNIT = 6; // posts render lazily; re-check a few times
  const HIDDEN_ATTR = "data-fbah-hidden"; // written for the CSS rule only; never read back
  const PLACEHOLDER_CLASS = "fbah-placeholder";

  const FEED_UNIT_SELECTOR =
    '[role="feed"] > div, [data-pagelet^="FeedUnit"], div[aria-posinset], div[role="article"][aria-describedby]';
  const ARTICLE = '[role="article"]';
  /** The post author's name is the first heading of the post. */
  const HEADING = "h2, h3, h4";
  /** Facebook's container for the post message. */
  const MESSAGE = '[data-ad-preview="message"], [data-ad-comet-preview="message"]';
  /** aria-label of comment / reply articles ("Comment by …", "Commentaire de …"). A heuristic, not a Facebook API. */
  const COMMENT_LABEL_RE =
    /^(?:comment|reply|commentaire|réponse|kommentar|antwort|comentario|respuesta|commento|risposta)\b/i;

  /** Never part of the text sent to the AI. */
  const TEXT_SKIP_SELECTOR = [
    "script", "style", "noscript", "svg", "form", "abbr", "time",
    '[role="textbox"]', '[role="dialog"]', '[aria-hidden="true"]',
    ARTICLE, // comments and replies are nested articles
    "button", '[role="button"]', '[role="toolbar"]', '[role="menu"]', // Like / Comment / Share, reactions, "See more"
    'a[href="#"]', 'a[href*="/posts/"]', 'a[href*="/permalink"]', 'a[href*="story_fbid="]', // timestamp / permalink links
  ].join(", ");

  // Footer and meta-line fragments that change on their own (used only when there is no message container).
  const NUMBER_ONLY_RE = /^[\d\s.,]+[KkMm]?$/;
  const COUNTER_RE =
    /^[\d\s.,]+[KkMm]?\s*(?:comments?|shares?|views?|plays?|reactions?|commentaires?|partages?|vues?|lectures?|réactions?|Kommentare?|Mal geteilt|Aufrufe|comentarios?|veces compartido|reproducciones|commenti|condivisioni|visualizzazioni)$/i;
  const OTHERS_RE =
    /(?:^|\s)(?:and|et|und|y|e)\s+[\d\s.,]+[KkMm]?\s+(?:others?|autres(?: personnes)?|weitere(?: Personen)?|personas más|más|altri|altre persone)$/i;
  const RELATIVE_TIME_RE = /^\d+\s*(?:s|m|min|mins|h|hr|hrs|d|j|w|sem|mo|y|yr|yrs|an|ans|Std\.?|T\.?|Tg\.?)$/i;

  const AI_DWELL_MS = 800; // on screen this long before we spend an API call on it
  /** This much of the post (or half of a short one) must be inside the window, not just below it. */
  const AI_MIN_VISIBLE_PX = 120;
  const AI_IO_THRESHOLDS = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const AI_MAX_IN_FLIGHT = 3; // per tab; the background also caps concurrency globally
  const AI_MIN_CONTENT_CHARS = 12;
  const AI_MAX_EMPTY_RETRIES = 3; // post not hydrated yet → look again a few times
  /** Failed calls (timeout, network, server error…) for one post before it is given up until the next rescan. */
  const AI_MAX_FAILURES = 3;
  const AI_FAILURE_RETRY_MS = 15_000; // × number of failures
  const AI_DEFAULT_PAUSE_MS = 30_000;
  const MAX_TIMER_MS = 2 ** 31 - 1;
  const META_HOST_RE = /(?:^|\.)(?:facebook\.com|fb\.com|fb\.me|fb\.watch|fbcdn\.net|messenger\.com|m\.me)$/;

  let settings: FBAHSettings = { ...FBAH_DEFAULT_SETTINGS };
  let hiddenByRules = 0;
  let hiddenByAI = 0;
  let checks = new WeakMap<Element, number>();

  interface HiddenEntry {
    reason: string;
    placeholder: HTMLElement | null;
  }
  const hiddenUnits = new Map<HTMLElement, HiddenEntry>(); // hidden or revealed by a click
  const placeholders = new WeakSet<Element>();

  // ---------- AI bookkeeping (memory only) ----------

  /**
   * - pending: a request is in flight
   * - done: TypeSafe answered; the probability is kept so that settings changes re-evaluate locally
   * - final: resolved without the AI (Suggested post, comment, duplicate unit, nothing to send,
   *   rejected request, too many failures); eligible again after the next rescan / settings change
   * - retry: a temporary error; eligible again once `notBefore` has passed and AI calls resume
   */
  type AIState =
    | { kind: "pending"; epoch: number; failures: number }
    | { kind: "done"; epoch: number; probability: number }
    | { kind: "final"; epoch: number; reason: string }
    | { kind: "retry"; epoch: number; failures: number; notBefore: number };

  const aiState = new WeakMap<Element, AIState>(); // verdicts survive rescans; `epoch` expires the rest
  const classified = new Set<HTMLElement>(); // units with a "done" verdict (pruned when detached)
  let aiEpoch = 0; // bumped by a rescan or a settings change
  let aiEmptyTries = new WeakMap<Element, number>();
  let aiInFlight = 0;
  let aiSuspendedUntil = 0; // Infinity = until the background says a key works, or settings change
  let aiResumeTimer: number | undefined;
  const intersecting = new Set<HTMLElement>();
  const dwellTimers = new Map<HTMLElement, number>();
  const candidates = new Set<HTMLElement>();

  // ---------- text helpers ----------

  function normalize(s: string): string {
    return s
      .normalize("NFKC")
      .replace(/[​-‍⁠﻿­]/g, "") // zero-width / soft hyphen
      .replace(/[\s\-·•]+/g, "")
      .toLowerCase();
  }

  function ctaNormalize(s: string): string {
    return normalize(s).replace(/[’‘`´]/g, "'");
  }

  /** Text a human actually sees: skips hidden decoys and honours flex `order`. */
  function visibleText(el: Element, depth = 0): string {
    if (depth > 8) return "";
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0" ||
      parseFloat(style.fontSize) === 0 ||
      style.position === "absolute" ||
      style.position === "fixed"
    ) {
      return "";
    }
    const parts: { order: number; index: number; text: string }[] = [];
    el.childNodes.forEach((node, index) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push({ order: 0, index, text: node.textContent ?? "" });
      } else if (node instanceof Element) {
        const order = parseInt(getComputedStyle(node).order, 10) || 0;
        parts.push({ order, index, text: visibleText(node, depth + 1) });
      }
    });
    parts.sort((a, b) => a.order - b.order || a.index - b.index);
    return parts.map((p) => p.text).join("");
  }

  function matchesAny(text: string | null | undefined, labels: ReadonlySet<string>): boolean {
    return !!text && labels.has(normalize(text));
  }

  function isVisible(el: Element): boolean {
    return el.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
      checkOpacity: true,
      checkVisibilityCSS: true,
    });
  }

  // ---------- post structure ----------

  function isCommentLabelled(article: Element): boolean {
    return COMMENT_LABEL_RE.test((article.getAttribute("aria-label") ?? "").trim());
  }

  /**
   * True when `el` sits in a comment below `unit`: inside a comment-labelled article, or
   * inside an article that is itself nested in an article (Facebook renders comments and
   * replies as nested role="article" elements).
   */
  function inComment(el: Element, unit: Element): boolean {
    for (let a = el.closest(ARTICLE); a !== null && a !== unit && unit.contains(a); a = a.parentElement?.closest(ARTICLE) ?? null) {
      if (isCommentLabelled(a)) return true;
      const outer = a.parentElement?.closest(ARTICLE) ?? null;
      if (outer !== null && unit.contains(outer)) return true; // contains() is inclusive: covers an article unit
    }
    return false;
  }

  /** A feed-unit match that is really a comment (or a reply) and must never be sent to the AI. */
  function isCommentUnit(el: Element): boolean {
    return el.matches(ARTICLE) && (isCommentLabelled(el) || el.parentElement?.closest(ARTICLE) != null);
  }

  /** Elements of `unit` matching `selector`, comments excluded. */
  function ownElements<T extends Element>(unit: Element, selector: string): T[] {
    return [...unit.querySelectorAll<T>(selector)].filter((el) => !inComment(el, unit));
  }

  /** True when `el` is inside an article below `post` (i.e. in a comment of that post). */
  function belowArticle(el: Element, post: Element): boolean {
    const a = el.closest(ARTICLE);
    return a !== null && a !== post && post.contains(a);
  }

  /**
   * The element that holds the post itself. A feed unit is not always role="article":
   * then the first nested article may be a comment, so an article is accepted as the post
   * only if it contains the unit's first heading (the author's name). Otherwise the unit
   * itself is used, and every article inside it is treated as a comment.
   */
  function postRoot(unit: HTMLElement): HTMLElement {
    if (unit.matches(ARTICLE)) return unit;
    const heading = ownElements<HTMLElement>(unit, HEADING)[0];
    if (heading === undefined) return unit;
    for (const a of unit.querySelectorAll<HTMLElement>(ARTICLE)) {
      if (a.contains(heading) && !isCommentLabelled(a) && !inComment(a, unit)) return a;
    }
    return unit;
  }

  /** The author's name: the first visible heading of the post that is not in a comment. */
  function authorHeading(post: HTMLElement): HTMLElement | null {
    for (const h of post.querySelectorAll<HTMLElement>(HEADING)) {
      if (!belowArticle(h, post) && isVisible(h)) return h;
    }
    return null;
  }

  // ---------- detection (local rules) ----------

  function hasSponsoredLabel(unit: Element): boolean {
    // 1. Ad-disclosure links ("Why am I seeing this ad?"). Not /ads/library: anyone can link to the Ad Library.
    if (ownElements(unit, 'a[href*="/ads/about"]').length > 0) return true;

    // 2. aria-label / aria-labelledby pointing at a "Sponsored" string.
    for (const el of ownElements<HTMLElement>(unit, "[aria-label]")) {
      if (matchesAny(el.getAttribute("aria-label"), SPONSORED_LABELS)) return true;
    }
    for (const el of ownElements<HTMLElement>(unit, "[aria-labelledby]")) {
      for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/)) {
        const ref = id ? document.getElementById(id) : null;
        if (ref && matchesAny(ref.textContent, SPONSORED_LABELS)) return true;
      }
    }

    // 3. SVG <use> referencing a hidden <text> node containing the label.
    for (const use of ownElements(unit, "svg use")) {
      const href = use.getAttribute("href") ?? use.getAttribute("xlink:href");
      if (href?.startsWith("#")) {
        const target = document.getElementById(href.slice(1));
        if (target && matchesAny(target.textContent, SPONSORED_LABELS)) return true;
      }
    }

    // 4. Obfuscated visible text in the post header (links/spans with short text), comments excluded.
    let inspected = 0;
    for (const el of unit.querySelectorAll<HTMLElement>('a[role="link"], a[href="#"], span[dir="auto"]')) {
      const raw = el.textContent ?? "";
      if (raw.length < 2 || raw.length > 80) continue;
      if (inComment(el, unit)) continue;
      if (++inspected > 60) break; // perf cap — the label is always near the top
      if (matchesAny(visibleText(el), SPONSORED_LABELS)) return true;
    }
    return false;
  }

  function hasSuggestedLabel(unit: Element): boolean {
    let inspected = 0;
    for (const el of unit.querySelectorAll<HTMLElement>("span")) {
      const raw = el.textContent ?? "";
      if (raw.length < 5 || raw.length > 60) continue;
      if (inComment(el, unit)) continue;
      if (++inspected > 40) break;
      if (matchesAny(raw, SUGGESTED_LABELS)) return true;
    }
    return false;
  }

  function feedUnits(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(FEED_UNIT_SELECTOR)].filter(
      // our own placeholders sit in the feed too; comment articles are not feed units
      (el) => !placeholders.has(el) && !(el.matches(ARTICLE) && isCommentLabelled(el)),
    );
  }

  function rightRailAdBlocks(): HTMLElement[] {
    const rail = document.querySelector<HTMLElement>('[data-pagelet="RightRail"], [role="complementary"]');
    if (!rail) return [];
    const found: HTMLElement[] = [];
    for (const heading of rail.querySelectorAll<HTMLElement>("h3, span")) {
      if ((heading.textContent ?? "").length > 40) continue;
      if (!matchesAny(visibleText(heading), SPONSORED_LABELS)) continue;
      // Climb until the block also contains the outbound ad links.
      let node: HTMLElement | null = heading;
      while (node && node !== rail) {
        if (node.querySelector('a[target="_blank"], a[href*="l.facebook.com"]')) {
          found.push(node);
          break;
        }
        node = node.parentElement;
      }
    }
    return found;
  }

  function reelsAndMarketplaceAds(): HTMLElement[] {
    const found: HTMLElement[] = [];
    const selectors = [
      '[data-pagelet*="Reels"] [data-video-id]',
      '[aria-label*="Reel"]',
      '[data-pagelet*="Stories"] [role="button"]',
      'a[href*="/marketplace/item/"]',
    ];
    for (const el of document.querySelectorAll<HTMLElement>(selectors.join(","))) {
      const tile = el.closest<HTMLElement>('[role="article"], [data-pagelet], div[style*="max-width"]') ?? el;
      if (!hiddenUnits.has(tile) && hasSponsoredLabel(tile)) found.push(tile);
    }
    return found;
  }

  // ---------- post summary for the AI ----------

  function isNoise(text: string): boolean {
    const t = fbahCollapseWhitespace(text);
    return (
      t === "" ||
      t === "·" ||
      NUMBER_ONLY_RE.test(t) ||
      COUNTER_RE.test(t) ||
      OTHERS_RE.test(t) ||
      RELATIVE_TIME_RE.test(t)
    );
  }

  /**
   * Visible text below `root`, skipping TEXT_SKIP_SELECTOR subtrees, `exclude`, hidden
   * nodes and (when `after` is set) everything that comes before `after` in the document.
   */
  function collectText(
    root: Element,
    budget: number,
    opts: { exclude?: Element | null; after?: Element | null; dropNoise?: boolean } = {},
  ): string {
    const exclude = opts.exclude ?? null;
    const after = opts.after ?? null;
    let out = "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node): number {
        if (node.nodeType === Node.TEXT_NODE) {
          if (after !== null && !(after.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) {
            return NodeFilter.FILTER_SKIP;
          }
          if (opts.dropNoise && isNoise(node.textContent ?? "")) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
        if (node === root || !(node instanceof Element)) return NodeFilter.FILTER_SKIP;
        if (node === exclude || node.matches(TEXT_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return isVisible(node) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
      },
    });
    for (let n = walker.nextNode(); n !== null && out.length < budget; n = walker.nextNode()) {
      out += ` ${n.textContent ?? ""}`;
    }
    return out;
  }

  /** Message containers of the post (not of its comments), outermost only. */
  function messageBlocks(post: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const m of post.querySelectorAll<HTMLElement>(MESSAGE)) {
      if (belowArticle(m, post) || out.some((o) => o.contains(m)) || !isVisible(m)) continue;
      out.push(m);
    }
    return out;
  }

  /**
   * The post body: its message plus the titles of its outbound link attachments. Without a
   * message container, the post minus its header, controls, reactions, counters and
   * comments. Never includes the author name (sent separately as `header`).
   */
  function postText(post: HTMLElement, heading: HTMLElement | null, max: number): string {
    const budget = max * 1.5;
    const messages = messageBlocks(post);
    let raw = "";
    if (messages.length > 0) {
      for (const m of messages) raw += collectText(m, budget - raw.length);
      const seen = new Set<string>();
      for (const a of post.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        if (raw.length >= budget) break;
        if (belowArticle(a, post) || messages.some((m) => m.contains(a)) || heading?.contains(a)) continue;
        if (a.closest('button, [role="button"], [aria-hidden="true"]') !== null || !isVisible(a)) continue;
        if (outboundHost(a.getAttribute("href") ?? "") === null) continue;
        const title = fbahCollapseWhitespace(collectText(a, 300));
        if (title !== "" && !seen.has(title)) {
          seen.add(title);
          raw += ` ${title}`;
        }
      }
    } else {
      // Text before the author heading is the social-context line ("X commented"), not the post.
      raw = collectText(post, budget, { exclude: heading, after: heading, dropNoise: true });
    }
    return fbahTruncate(fbahCollapseWhitespace(raw), max);
  }

  /** Hostname of an outbound link (unwrapping l.facebook.com/l.php?u=…), or null for Facebook-internal links. */
  function outboundHost(href: string, depth = 0): string | null {
    let url: URL;
    try {
      url = new URL(href, location.href);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (META_HOST_RE.test(host) || host === location.hostname) {
      const target = url.searchParams.get("u");
      return depth === 0 && target && url.pathname.startsWith("/l.php") ? outboundHost(target, 1) : null;
    }
    return host.replace(/^www\./, "");
  }

  function outboundHosts(post: HTMLElement): string[] {
    const hosts = new Set<string>();
    for (const a of post.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (belowArticle(a, post)) continue; // link inside a comment
      const host = outboundHost(a.getAttribute("href") ?? "");
      if (host) hosts.add(host);
      if (hosts.size >= FBAH_POST_LIMITS.links) break;
    }
    return [...hosts];
  }

  function hasCallToAction(post: HTMLElement): boolean {
    let inspected = 0;
    for (const el of post.querySelectorAll<HTMLElement>('[role="button"], button, a[role="link"], a[role="button"]')) {
      if (belowArticle(el, post)) continue;
      const label = el.getAttribute("aria-label") ?? "";
      const text = el.textContent ?? "";
      if (label && label.length <= 40 && CTA_LABELS.has(ctaNormalize(label))) return true;
      if (text.length < 3 || text.length > 40) continue;
      if (++inspected > 80) break;
      if (CTA_LABELS.has(ctaNormalize(text))) return true;
    }
    return false;
  }

  function extractPostState(unit: HTMLElement): FBAHPostState | null {
    const post = postRoot(unit);
    const heading = authorHeading(post);
    // Every feed post (organic or ad) starts with its author's name. Units without one
    // (carousels, "People you may know", Reels trays, a post still loading) are not sent.
    const header = heading ? fbahCollapseWhitespace(heading.innerText || heading.textContent || "") : "";
    if (header === "") return null;
    const text = postText(post, heading, FBAH_POST_LIMITS.text);
    const links = outboundHosts(post);
    if (text.length + header.length < AI_MIN_CONTENT_CHARS && links.length === 0) return null;
    return fbahSanitizePostState({
      text,
      header,
      links,
      hasCallToActionButton: hasCallToAction(post),
      language: document.documentElement.lang || navigator.language || "",
    });
  }

  // ---------- AI scheduling (only posts that are actually on screen) ----------

  function aiWanted(): boolean {
    return settings.enabled && settings.hideFeedAds && settings.aiEnabled;
  }

  function aiEligible(el: Element): boolean {
    const s = aiState.get(el);
    if (s === undefined || s.kind === "retry") return true;
    if (s.kind === "final") return s.epoch !== aiEpoch;
    return false; // pending, done
  }

  function markResolved(el: HTMLElement, reason: string): void {
    aiState.set(el, { kind: "final", epoch: aiEpoch, reason });
    stopWatching(el);
  }

  // No rootMargin: a post below the window has not been seen and is not sent.
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target;
        if (!(el instanceof HTMLElement)) continue;
        if (entry.isIntersecting) {
          intersecting.add(el);
          armDwell(el);
        } else {
          intersecting.delete(el);
          disarm(el);
        }
      }
    },
    { threshold: AI_IO_THRESHOLDS },
  );

  /** At least AI_MIN_VISIBLE_PX of the post (or half of a shorter one) is inside the window. */
  function onScreen(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return visible > 0 && visible >= Math.min(AI_MIN_VISIBLE_PX, r.height / 2);
  }

  function armDwell(el: HTMLElement, delay = AI_DWELL_MS): void {
    if (!aiWanted() || !aiEligible(el) || dwellTimers.has(el) || candidates.has(el)) return;
    const s = aiState.get(el);
    const wait = s?.kind === "retry" && s.epoch === aiEpoch ? Math.max(delay, s.notBefore - Date.now()) : delay;
    dwellTimers.set(
      el,
      window.setTimeout(() => {
        dwellTimers.delete(el);
        // Re-armed by the next intersection change or scroll if it is only partly in view.
        if (!intersecting.has(el) || !onScreen(el)) return;
        candidates.add(el);
        pumpAI();
      }, Math.min(wait, MAX_TIMER_MS)),
    );
  }

  function disarm(el: HTMLElement): void {
    const t = dwellTimers.get(el);
    if (t !== undefined) window.clearTimeout(t);
    dwellTimers.delete(el);
    candidates.delete(el);
  }

  function stopWatching(el: HTMLElement): void {
    io.unobserve(el);
    intersecting.delete(el);
    disarm(el);
  }

  function watchForAI(unit: HTMLElement): void {
    if (!aiWanted() || !aiEligible(unit)) return;
    io.observe(unit); // no-op if already observed
    if (intersecting.has(unit)) armDwell(unit);
  }

  function rearmVisible(): void {
    if (!aiWanted()) return;
    for (const el of intersecting) armDwell(el);
  }

  function pumpAI(): void {
    if (!aiWanted()) return;
    const now = Date.now();
    if (now < aiSuspendedUntil) {
      if (aiResumeTimer === undefined && Number.isFinite(aiSuspendedUntil)) {
        aiResumeTimer = window.setTimeout(
          () => {
            aiResumeTimer = undefined;
            pumpAI();
          },
          Math.min(aiSuspendedUntil - now, MAX_TIMER_MS),
        );
      }
      return;
    }
    for (const el of [...candidates]) {
      if (aiInFlight >= AI_MAX_IN_FLIGHT) break;
      candidates.delete(el);
      askAI(el);
    }
  }

  function suspendAI(ms: number): void {
    aiSuspendedUntil = Math.max(aiSuspendedUntil, Date.now() + ms);
  }

  function resumeAI(): void {
    aiSuspendedUntil = 0;
    if (aiResumeTimer !== undefined) window.clearTimeout(aiResumeTimer);
    aiResumeTimer = undefined;
    rearmVisible();
    pumpAI();
  }

  function hasHiddenAncestor(el: Element): boolean {
    for (let p = el.parentElement; p !== null; p = p.parentElement) {
      if (p instanceof HTMLElement && hiddenUnits.has(p)) return true;
    }
    return false;
  }

  /**
   * Wrapper and inner article can both be feed units for the same post: only one of them is
   * asked about. A related unit counts only while it is in flight, answered or waiting for a
   * retry; "final" marks (duplicate, comment, empty…) never block the other unit.
   */
  function relatedUnitHasState(el: HTMLElement): boolean {
    const active = (x: Element): boolean => {
      const s = aiState.get(x);
      return s !== undefined && s.kind !== "final";
    };
    for (let p = el.parentElement; p !== null; p = p.parentElement) {
      if (active(p)) return true;
    }
    for (const d of el.querySelectorAll(FEED_UNIT_SELECTOR)) {
      if (active(d)) return true;
    }
    return false;
  }

  function askAI(el: HTMLElement): void {
    if (!el.isConnected || !aiEligible(el) || hiddenUnits.has(el) || hasHiddenAncestor(el)) {
      stopWatching(el);
      return;
    }
    if (isCommentUnit(el)) {
      markResolved(el, "comment");
      return;
    }
    if (relatedUnitHasState(el)) {
      markResolved(el, "duplicate");
      return;
    }
    // The free local rules get a last look: labels often hydrate late.
    if (settings.hideFeedAds && hasSponsoredLabel(el)) {
      hide(el, "sponsored");
      return;
    }
    if (hasSuggestedLabel(el)) {
      if (settings.hideSuggested) hide(el, "suggested");
      else markResolved(el, "suggested"); // the user keeps Suggested posts: never sent to the AI
      return;
    }

    const state = extractPostState(el);
    if (!state) {
      const tries = (aiEmptyTries.get(el) ?? 0) + 1;
      aiEmptyTries.set(el, tries);
      if (tries < AI_MAX_EMPTY_RETRIES) armDwell(el, AI_DWELL_MS * 2);
      else markResolved(el, "empty");
      return;
    }

    const prev = aiState.get(el);
    const failures = prev?.kind === "retry" && prev.epoch === aiEpoch ? prev.failures : 0;
    aiState.set(el, { kind: "pending", epoch: aiEpoch, failures });
    stopWatching(el);
    aiInFlight++;
    fbahSendToBackground({ type: "fbah/classify", state })
      .then((res) => onAIResult(el, res))
      .catch(() => onAIFailure(el, "unreachable", undefined)) // e.g. the worker was stopped mid-request
      .finally(() => {
        aiInFlight--;
        pumpAI();
      });
  }

  function applyVerdict(el: HTMLElement, probability: number): void {
    if (aiWanted() && el.isConnected && probability >= settings.aiThreshold) {
      hide(el, "AI", `${Math.round(probability * 100)}%`);
    }
  }

  function onAIResult(el: HTMLElement, res: FBAHClassifyResult | undefined): void {
    if (typeof res !== "object" || res === null) {
      onAIFailure(el, "no_answer", undefined);
      return;
    }
    if (!res.ok) {
      onAIFailure(el, res.error, res.retryAfterMs);
      return;
    }
    if (typeof res.probability !== "number" || !Number.isFinite(res.probability)) {
      onAIFailure(el, "no_answer", undefined);
      return;
    }
    aiState.set(el, { kind: "done", epoch: aiEpoch, probability: res.probability });
    classified.add(el);
    applyVerdict(el, res.probability);
  }

  /**
   * Only answers that will not change mark a post as finished. After a temporary error
   * the post stays eligible and is watched again, so it is asked once AI calls resume.
   */
  function onAIFailure(el: HTMLElement, code: FBAHAIErrorCode | "unreachable" | "no_answer", retryAfterMs: number | undefined): void {
    const pending = aiState.get(el);
    const failures = pending?.kind === "pending" && pending.epoch === aiEpoch ? pending.failures : 0;
    const retry = (count: number, delayMs: number): void => {
      aiState.set(el, { kind: "retry", epoch: aiEpoch, failures: count, notBefore: Date.now() + delayMs });
    };
    switch (code) {
      case "rejected":
      case "validation":
        markResolved(el, code); // the same post state would be refused again
        return;
      case "disabled":
      case "no_key":
      case "invalid_key":
      case "forbidden":
        // Nothing will work until a key is saved / verified (the background tells us) or settings change.
        retry(failures, 0);
        suspendAI(Infinity);
        break;
      case "cap_reached":
        retry(failures, 0);
        suspendAI(retryAfterMs ?? 60 * 60_000); // background sends the time until local midnight
        break;
      case "rate_limited":
      case "overloaded":
        retry(failures, 0);
        suspendAI(retryAfterMs ?? AI_DEFAULT_PAUSE_MS); // the background's (persisted) pause
        break;
      case "busy":
        retry(failures, 0);
        suspendAI(retryAfterMs ?? 5_000);
        break;
      default: // timeout, network, server, bad_response, unknown, unreachable, no_answer
        if (failures + 1 >= AI_MAX_FAILURES) {
          markResolved(el, `failed:${code}`);
          return;
        }
        retry(failures + 1, AI_FAILURE_RETRY_MS * (failures + 1));
        break;
    }
    if (el.isConnected && aiWanted()) io.observe(el); // IntersectionObserver reports its current state
  }

  /** Re-applies the stored AI verdicts with the current settings (no API call). */
  function reapplyVerdicts(): void {
    for (const el of classified) {
      if (!el.isConnected) {
        classified.delete(el);
        continue;
      }
      const s = aiState.get(el);
      if (s?.kind === "done") applyVerdict(el, s.probability);
    }
  }

  // ---------- hiding ----------

  function hide(unit: HTMLElement, reason: string, detail?: string): void {
    stopWatching(unit);
    // Wrapper and inner article can both match feedUnits(): count and hide one post once.
    if (hiddenUnits.has(unit) || hasHiddenAncestor(unit)) return;
    unit.setAttribute(HIDDEN_ATTR, reason);
    const entry: HiddenEntry = { reason, placeholder: null };
    hiddenUnits.set(unit, entry);
    if (reason === "AI") hiddenByAI++;
    else hiddenByRules++;

    if (settings.mode === "collapse") {
      const ph = document.createElement("div");
      ph.className = PLACEHOLDER_CLASS;
      ph.textContent = `Ad hidden (${detail ? `${reason} ${detail}` : reason}) — click to show`;
      ph.addEventListener("click", () => {
        unit.setAttribute(HIDDEN_ATTR, "revealed");
        entry.placeholder = null;
        ph.remove();
      });
      placeholders.add(ph);
      entry.placeholder = ph;
      unit.before(ph);
    }
  }

  function unhideAll(): void {
    hiddenUnits.forEach((entry, unit) => {
      entry.placeholder?.remove();
      unit.removeAttribute(HIDDEN_ATTR);
    });
    hiddenUnits.clear();
    hiddenByRules = 0;
    hiddenByAI = 0;
  }

  function counts(): FBAHHiddenCounts {
    return { hiddenCount: hiddenByRules + hiddenByAI, hiddenByRules, hiddenByAI };
  }

  function shouldCheck(el: HTMLElement): boolean {
    if (hiddenUnits.has(el)) return false;
    const n = checks.get(el) ?? 0;
    if (n >= MAX_CHECKS_PER_UNIT) return false;
    checks.set(el, n + 1);
    return true;
  }

  function scan(): void {
    if (!settings.enabled) return;

    if (settings.hideFeedAds || settings.hideSuggested) {
      for (const unit of feedUnits()) {
        if (!shouldCheck(unit)) continue;
        if (settings.hideFeedAds && hasSponsoredLabel(unit)) hide(unit, "sponsored");
        else if ((settings.hideSuggested || aiWanted()) && hasSuggestedLabel(unit)) {
          if (settings.hideSuggested) hide(unit, "suggested");
          else markResolved(unit, "suggested"); // kept visible by the user's choice: not sent to the AI
        } else watchForAI(unit); // unresolved by rules → AI, once it is on screen
      }
    }
    if (settings.hideRightRailAds) {
      rightRailAdBlocks().forEach((b) => hide(b, "sidebar"));
    }
    if (settings.hideReelsAndMarketplaceAds) {
      reelsAndMarketplaceAds().forEach((t) => hide(t, "sponsored"));
    }
    rearmVisible(); // posts that were only partly in view when their dwell ended
  }

  // ---------- wiring ----------

  function injectStyles(): void {
    const style = document.createElement("style");
    style.id = "fbah-styles";
    style.textContent = `
      [${HIDDEN_ATTR}]:not([${HIDDEN_ATTR}="revealed"]) { display: none !important; }
      .${PLACEHOLDER_CLASS} {
        margin: 8px auto; padding: 6px 12px; max-width: 680px; border-radius: 8px;
        font: 12px/1.4 system-ui, sans-serif; color: #65676b; background: rgba(0,0,0,.04);
        cursor: pointer; text-align: center; user-select: none;
      }
      .${PLACEHOLDER_CLASS}:hover { background: rgba(0,0,0,.08); }
      @media (prefers-color-scheme: dark) {
        .${PLACEHOLDER_CLASS} { color: #b0b3b8; background: rgba(255,255,255,.06); }
      }
    `;
    (document.head ?? document.documentElement).appendChild(style);
  }

  let scheduled = false;
  function scheduleScan(): void {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      scan();
    };
    if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 500 });
    else setTimeout(run, 200);
  }

  /**
   * After a settings change or a manual rescan: re-run the rules and re-apply the stored
   * AI verdicts in the same task (no flash, no API call). Posts without a verdict, and
   * posts that failed or were resolved without the AI, become eligible again.
   */
  function rescanFromScratch(): void {
    aiEpoch++;
    aiEmptyTries = new WeakMap();
    aiSuspendedUntil = 0; // the background still enforces its own pause and answers with its remaining time
    if (aiResumeTimer !== undefined) window.clearTimeout(aiResumeTimer);
    aiResumeTimer = undefined;
    dwellTimers.forEach((t) => window.clearTimeout(t));
    dwellTimers.clear();
    candidates.clear();
    intersecting.clear();
    io.disconnect(); // re-observed by scan(); observe() reports the current state
    unhideAll();
    checks = new WeakMap();
    scan();
    reapplyVerdicts();
  }

  // Only the sync area (settings). The API key lives in storage.local, which
  // this script deliberately does not subscribe to.
  chrome.storage.sync.onChanged.addListener((changes) => {
    const change = changes[FBAH_STORAGE_KEY];
    if (!change) return;
    settings = fbahSanitizeSettings(change.newValue);
    rescanFromScratch();
  });

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !fbahIsTabMessage(msg)) return false;
    switch (msg.type) {
      case "fbah/getStats": {
        const res: FBAHResponse<typeof msg> = { ...counts(), url: location.href };
        sendResponse(res);
        break;
      }
      case "fbah/rescan": {
        rescanFromScratch();
        const res: FBAHResponse<typeof msg> = counts();
        sendResponse(res);
        break;
      }
      case "fbah/aiResume": {
        resumeAI();
        const res: FBAHResponse<typeof msg> = { resumed: aiWanted() };
        sendResponse(res);
        break;
      }
    }
    return false;
  });

  void (async () => {
    settings = await fbahLoadSettings();
    injectStyles();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    scan();
    // Some labels hydrate after scroll stops without DOM insertions; partly visible posts re-arm here too.
    window.addEventListener("scroll", scheduleScan, { passive: true });
  })();
})();
