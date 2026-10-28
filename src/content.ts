// Content script: decides which Facebook feed posts are ads and hides them.
//
// AI-first (settings.aiEnabled, the default): TypeSafe AI decides. Every rendered feed post that
// is on screen or within the lookahead (AI_LOOKAHEAD_SCREENS viewport heights below the window,
// AI_LOOKBEHIND_SCREENS above it) and whose content has stopped changing for AI_STABLE_MS is
// summarised into a compact FBAHPostState and sent to the background service worker
// ("fbah/classify"), which asks TypeSafe. Facebook renders posts ahead of the window, so the answer
// usually arrives before the post is seen. Posts inside the window are sent first, flagged
// `urgent` when the tab is visible (the worker sends them alone, keeps call slots for them and
// starts them before lookahead requests), then the nearest ones below. Lookahead requests are
// grouped by the worker into batches of up to FBAH_AI_BATCH_MAX posts per TypeSafe call. A post
// whose lookahead request is still in flight when it enters the window of a visible tab is asked
// again with `urgent` (same state, not a new attempt; see promote): the worker takes it out of its
// batch queue and sends it alone, unless its batch call has already started. The post is hidden
// when the probability is >= settings.aiThreshold.
// Facebook's own "Ad" / "Sponsored" label (hasSponsoredLabel) is only a signal in that state
// (hasAdLabel): in the 2026 feed it is rendered outside the post, later than the post, and in a
// background tab often not at all.
//
// Hold gate: a post whose answer is still pending and that has a strong local signal (the label,
// or an ad-style button) is collapsed into a "Checking with TypeSafe…" placeholder until the
// answer arrives: inside the window, and already up to AI_PREHOLD_SCREENS below it, so that it is
// collapsed before it scrolls into view. The AI_HOLD_MAX_MS limit counts from the moment the
// placeholder is inside the window. Other posts are never held.
//
// Timing: no periodic timer. Scans run on DOM changes, scroll and resize, after each answer, and
// at the exact time something becomes due (content settled, retry time, end of a pause, end of a
// hold), plus a re-measure every AI_PREHOLD_RECHECK_MS while a post is held below the window.
//
// Fallback, so ads still disappear when the AI can't answer: when the worker reports that the AI
// is unavailable (no key, invalid key, forbidden, daily cap, turned off) or a post used up its
// AI_MAX_ATTEMPTS attempts, the local rule decides: the post is hidden if the label was found.
//
// Rules only (settings.aiEnabled off): the label hides the post directly. The right-column block
// and Reels / Marketplace tiles are always rule-based.
//
// Diagnostics (settings.showAIBadges): a one-line badge above every feed post with its verdict,
// the reason in the "click to show" placeholder, and a status chip at the bottom left. Badges and
// placeholders are our own elements, inserted next to the post (never inside Facebook's
// subtree) and only ever filled with textContent. The number of hidden posts is also reported to
// the worker ("fbah/counts", at most every COUNTS_REPORT_MS) for the toolbar badge.
//
// This script never sees the API key and never talks to TypeSafe itself. All per-post state
// lives in this script's memory: facebook.com scripts share the DOM with us, so nothing is read
// back from DOM attributes (data-fbah-hidden is written only for the CSS rule).

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

  /**
   * Short disclosure labels ("Ad", used in the English feed since 2026). Too generic to match
   * against free visible text, so they only count when Facebook itself points at them:
   * aria-label, aria-labelledby or an SVG <use> reference.
   */
  const SHORT_AD_LABELS: ReadonlySet<string> = new Set(["Ad"].map(normalize));
  const ANY_AD_LABELS: ReadonlySet<string> = new Set([...SPONSORED_LABELS, ...SHORT_AD_LABELS]);

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
      "Listen now", "Watch more", "See menu", "Request time", "Get promotions", "Send message",
      // French
      "En savoir plus", "Acheter", "Acheter maintenant", "Achetez maintenant", "S'inscrire",
      "Inscrivez-vous", "Réserver", "Réserver maintenant", "Commander", "Commander maintenant",
      "Télécharger", "Installer", "Installer maintenant", "Utiliser l'application", "Jouer",
      "Obtenir l'offre", "Profiter de l'offre", "Demander un devis", "Commencer", "Postuler",
      "Postuler maintenant", "Nous contacter", "S'abonner", "Faire un don", "Voir le menu",
      "Envoyer un message",
      // German / Spanish / Italian
      "Jetzt einkaufen", "Mehr dazu", "Registrieren", "Jetzt buchen", "Herunterladen",
      "Comprar ahora", "Más información", "Registrarte", "Reservar ahora", "Descargar",
      "Acquista ora", "Scopri di più", "Iscriviti", "Prenota ora", "Scarica",
    ].map(ctaNormalize),
  );

  /** Label checks per content signature (some labels hydrate without any DOM insertion)… */
  const MAX_CHECKS_PER_UNIT = 6;
  /** …at most one per this period, after the immediate one on new content. */
  const LABEL_RECHECK_MS = 1_000;
  const HIDDEN_ATTR = "data-fbah-hidden"; // written for the CSS rule only; never read back
  const PLACEHOLDER_CLASS = "fbah-placeholder";
  const BADGE_CLASS = "fbah-badge";
  const CHIP_CLASS = "fbah-chip";

  // `[role="main"] [data-virtualized]`: the 2026 feed wraps every post in a virtualized-list
  // item ("true" = unmounted empty shell, "false" = rendered) and no longer uses role="feed",
  // aria-posinset or data-pagelet. The older selectors are kept for other layouts.
  const FEED_UNIT_SELECTOR =
    '[role="main"] [data-virtualized], [role="feed"] > div, [data-pagelet^="FeedUnit"], ' +
    'div[aria-posinset], div[role="article"][aria-describedby]';
  const ARTICLE = '[role="article"]';
  /** The post author's name is the first heading of the post. */
  const HEADING = "h2, h3, h4";
  /** Facebook's container for the post message (older layouts; the 2026 one also has STORY_MESSAGE). */
  const MESSAGE = '[data-ad-preview="message"], [data-ad-comet-preview="message"]';
  // data-ad-rendering-role marks the parts of every post, organic ones included: layout only,
  // never an ad signal by itself.
  const PROFILE_NAME = '[data-ad-rendering-role="profile_name"]';
  const STORY_MESSAGE = '[data-ad-rendering-role="story_message"]';
  const PREVIEW_TITLE = '[data-ad-rendering-role="title"]';
  const PREVIEW_DESCRIPTION = '[data-ad-rendering-role="description"]';
  /** The link-preview domain, shown in capitals ("CIRQUEDUSOLEIL.COM", "m.me"). */
  const PREVIEW_DOMAIN = '[data-ad-rendering-role="meta"]';
  /** Call-to-action container ("cta-…"); its text is often empty in the DOM. */
  const CTA_PART = '[data-ad-rendering-role^="cta"]';
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

  /** A post is asked about once its content signature has not changed for this long… */
  const AI_STABLE_MS = 300;
  /** …or once it has kept changing for this long (autoplaying videos never settle) ahead of the window… */
  const AI_MAX_UNSTABLE_MS = 5_000;
  /** …and inside the window, where the user is already looking at it. */
  const AI_MAX_UNSTABLE_VISIBLE_MS = 1_500;
  /** Posts are classified ahead of time: up to this many viewport heights below the window… */
  const AI_LOOKAHEAD_SCREENS = 2;
  /** …and this many above it (scrolling up). Posts further away are not sent. */
  const AI_LOOKBEHIND_SCREENS = 1;
  /** Urgent requests in flight per tab; equal to the worker's MAX_CONCURRENT call slots. */
  const AI_MAX_IN_FLIGHT = 4;
  /**
   * Slots only urgent requests (inside the window of a visible tab) may use, as in the worker
   * (URGENT_RESERVED): up to this many posts being looked at start at once, whatever the lookahead is doing.
   */
  const AI_VIEWPORT_RESERVED = 2;
  /**
   * Lookahead requests in flight per tab: the worker sends them in batches of up to
   * FBAH_AI_BATCH_MAX posts, on at most AI_MAX_IN_FLIGHT - AI_VIEWPORT_RESERVED call slots, so this
   * many can be answered without queuing behind each other. One whose post enters the window of a
   * visible tab while it still waits is promoted to an urgent request (see promote).
   */
  const AI_LOOKAHEAD_MAX_IN_FLIGHT = (AI_MAX_IN_FLIGHT - AI_VIEWPORT_RESERVED) * FBAH_AI_BATCH_MAX;
  /** A held post is shown again after this long inside the window at most, answer or not. */
  const AI_HOLD_MAX_MS = 4_000;
  /**
   * A post with a strong signal is held already when it is at most this many viewport heights
   * below the window (it stays held while it remains within the lookahead below).
   */
  const AI_PREHOLD_SCREENS = 1;
  /** Re-measure period while a post is held below the window (our own hides can move it into view). */
  const AI_PREHOLD_RECHECK_MS = 1_000;
  /** The worker's queue wait is shown in badges from this many ms. */
  const QUEUED_SHOWN_MS = 10;
  const HOLD_TEXT = "Checking with TypeSafe…";
  const AI_MIN_CONTENT_CHARS = 12;
  const AI_MAX_EMPTY_TRIES = 3; // post not hydrated yet → look again a little later
  const AI_EMPTY_RETRY_MS = 1_000;
  /** Hard caps per post element and page: requests sent, and answers received. */
  const AI_MAX_ATTEMPTS = 3;
  const AI_MAX_ANSWERS = 2;
  const AI_RETRY_MS = 5_000; // × failed attempts; the worker has already retried inside each request
  const AI_DEFAULT_PAUSE_MS = 30_000;
  const STATUS_REFRESH_MS = 15_000;
  /** The hidden count is sent to the worker (toolbar badge) at most this often, when it changed. */
  const COUNTS_REPORT_MS = 300;
  const META_HOST_RE = /(?:^|\.)(?:facebook\.com|fb\.com|fb\.me|fb\.watch|fbcdn\.net|messenger\.com|m\.me)$/;

  type LocalErrorCode = "unreachable" | "no_answer";
  type ErrorCode = FBAHAIErrorCode | LocalErrorCode;

  /** Short human reasons, shown in badges, placeholders and the status chip. */
  const ERROR_TEXT: Readonly<Record<ErrorCode, string>> = {
    disabled: "AI turned off",
    no_key: "no API key",
    invalid_key: "invalid API key",
    cap_reached: "daily cap reached",
    busy: "too many posts queued",
    rejected: "request refused by the extension",
    forbidden: "API key not allowed",
    validation: "request rejected by TypeSafe",
    rate_limited: "rate limited",
    overloaded: "TypeSafe overloaded",
    server: "TypeSafe server error",
    timeout: "timeout",
    network: "network error",
    bad_response: "unexpected answer",
    unknown: "unknown error",
    unreachable: "extension worker unreachable",
    no_answer: "no answer from the extension",
  };

  let settings: FBAHSettings = { ...FBAH_DEFAULT_SETTINGS };

  /** Our own elements (placeholders, badges, chip): some feed selectors would match them otherwise. */
  const ours = new WeakSet<Element>();

  /** "hold": collapsed while TypeSafe's answer is pending (never counted as hidden). */
  type HideReason = "AI" | "rules" | "sponsored" | "suggested" | "sidebar" | "hold";

  interface HiddenEntry {
    reason: HideReason;
    /** Placeholder text, without " — click to show" (a hold placeholder has no such suffix). */
    label: string;
    placeholder: HTMLElement | null;
    /** The user clicked the placeholder: the element stays visible. */
    revealed: boolean;
  }
  const hiddenUnits = new Map<HTMLElement, HiddenEntry>(); // pruned when the element is detached

  // ---------- per-post state (memory only) ----------

  /** Why the local rule decided instead of TypeSafe. */
  type FallbackCause =
    | "unavailable" // no key, invalid key, cap…: asked again when AI calls may work again
    | "failed" //      AI_MAX_ATTEMPTS used up: final for this page
    | "rejected" //    the request was refused and would be refused again: final
    | "empty"; //      nothing to send: asked again once the post's content changes

  type Verdict =
    | { kind: "none" }
    /**
     * `sawLabel`: the hasAdLabel value TypeSafe was given. `latencyMs`: duration of the API call
     * (null when unknown); `queuedMs`: time waited in the worker before it (batch filling + free
     * slot); `cached`: answered from the worker's cache; `batchSize`: posts asked about in that
     * call (1 = alone).
     */
    | {
        kind: "ai";
        probability: number;
        sawLabel: boolean;
        latencyMs: number | null;
        queuedMs: number;
        cached: boolean;
        batchSize: number;
      }
    | { kind: "rules"; cause: FallbackCause; why: string };

  interface UnitRecord {
    /** Content signature (element count + resolved aria-labelledby targets) and when it last changed. */
    sig: string;
    sigSince: number;
    /** Start of the current run of signature changes. */
    unstableSince: number;
    /** Label / button checks run for the current signature, and when the last one ran. */
    checks: number;
    lastCheck: number;
    /** Sticky: Facebook does not take a disclosure back, but may not render it again. */
    hasAdLabel: boolean;
    /** Sticky: an ad-style call-to-action button was found (a strong signal for the hold gate). */
    hasCta: boolean;
    suggested: boolean;
    verdict: Verdict;
    /** A request of the current round (`asking`) is in flight and no answer to that round has arrived yet. */
    pending: boolean;
    /** The current (or last) round of asking; null before the first request. */
    asking: Asking | null;
    attempts: number;
    answers: number;
    notBefore: number;
    /**
     * Not sent again as a lookahead request before this: the worker's lookahead queue was full
     * ("busy", e.g. because of other Facebook tabs). Inside the window of a visible tab the post is
     * sent at once, as an urgent request.
     */
    lookaheadNotBefore: number;
    /** Short reason of the last temporary failure, while a retry is due. */
    lastError: string | null;
    emptyTries: number;
    /**
     * Where the post was at the last scan while it awaited an answer (measured on our placeholder
     * while we hide it); null when it was not measured or has no box.
     */
    place: Place | null;
    /** Collapsed by the hold gate (inside the window, or just below it). */
    held: boolean;
    /** When the held placeholder was first inside the window (the AI_HOLD_MAX_MS count); 0 = not yet. */
    holdSince: number;
    /** The hold of this round of asking ran out: the post stays visible until TypeSafe answers. */
    holdReleased: boolean;
    /** The user clicked one of this post's placeholders: whatever hides it later, it stays shown. */
    revealedByUser: boolean;
  }

  /**
   * One round of asking TypeSafe about a post: one request, plus its promotion when the post enters
   * the window of a visible tab while a lookahead request is still in flight (see promote).
   */
  interface Asking {
    state: FBAHPostState;
    /** Sent as an urgent request, or promoted to one since. */
    urgent: boolean;
    /** The first answer (to the request or to its promotion) has ended the round. */
    done: boolean;
  }

  const units = new Map<HTMLElement, UnitRecord>(); // pruned when the element is detached
  const badges = new Map<HTMLElement, HTMLElement>(); // unit → its badge

  type UnavailableCode = Extract<FBAHAIErrorCode, "disabled" | "no_key" | "invalid_key" | "forbidden" | "cap_reached">;
  /** The worker said TypeSafe can't answer: posts get the local rule without being sent, until `until`. */
  let unavailable: { code: UnavailableCode; until: number } | null = null;
  /** Rate limit or overload: nothing is sent before this (a full worker queue delays one post only). */
  let pausedUntil = 0;
  let pauseReason = "";
  /** Requests sent to the worker and not answered yet: urgent ones, and lookahead ones. */
  let inFlightUrgent = 0;
  let inFlightLookahead = 0;
  /** One-shot rescan at the earliest time something becomes due without any DOM change. */
  let wake: { at: number; timer: number } | null = null;

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

  function shownText(el: HTMLElement): string {
    return fbahCollapseWhitespace(el.innerText || el.textContent || "");
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

  /** Visible elements of `post` matching `selectors` (in that order), comments excluded, outermost only. */
  function ownParts(post: HTMLElement, selectors: readonly string[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const selector of selectors) {
      for (const el of post.querySelectorAll<HTMLElement>(selector)) {
        if (belowArticle(el, post) || out.some((o) => o.contains(el)) || !isVisible(el)) continue;
        out.push(el);
      }
    }
    return out;
  }

  /**
   * The element that holds the post itself. A feed unit is not always role="article" (the 2026
   * feed uses none): then the first nested article may be a comment, so an article is accepted
   * as the post only if it contains the unit's first heading (the author's name). Otherwise the
   * unit itself is used, and every article inside it is treated as a comment.
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

  /** The first visible heading of the post that is not in a comment. */
  function authorHeading(post: HTMLElement): HTMLElement | null {
    for (const h of post.querySelectorAll<HTMLElement>(HEADING)) {
      if (!belowArticle(h, post) && isVisible(h)) return h;
    }
    return null;
  }

  /** The author block: Facebook's profile_name part, else the first heading. */
  function authorBlock(post: HTMLElement): HTMLElement | null {
    return ownParts(post, [PROFILE_NAME])[0] ?? authorHeading(post);
  }

  /**
   * The author's name: the block's first link with text. The rest of the line can name other
   * people ("… is with Paul Martin"), who are never sent.
   */
  function authorName(block: HTMLElement): string {
    for (const a of block.querySelectorAll<HTMLElement>("a")) {
      if (a.matches('[role="button"]')) continue; // "Follow"
      const name = shownText(a);
      if (name !== "") return name;
    }
    return shownText(block);
  }

  // ---------- detection (local rules) ----------

  function hasSponsoredLabel(unit: Element): boolean {
    // 1. Ad-disclosure links ("Why am I seeing this ad?"). Not /ads/library: anyone can link to the Ad Library.
    if (ownElements(unit, 'a[href*="/ads/about"]').length > 0) return true;

    // 2. aria-label / aria-labelledby pointing at a "Sponsored" / "Ad" string.
    for (const el of ownElements<HTMLElement>(unit, "[aria-label]")) {
      if (matchesAny(el.getAttribute("aria-label"), ANY_AD_LABELS)) return true;
    }
    for (const el of ownElements<HTMLElement>(unit, "[aria-labelledby]")) {
      for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/)) {
        const ref = id ? document.getElementById(id) : null;
        if (ref && matchesAny(ref.textContent, ANY_AD_LABELS)) return true;
      }
    }

    // 3. SVG <use> referencing a hidden <text> node containing the label.
    for (const use of ownElements(unit, "svg use")) {
      const href = use.getAttribute("href") ?? use.getAttribute("xlink:href");
      if (href?.startsWith("#")) {
        const target = document.getElementById(href.slice(1));
        if (target && matchesAny(target.textContent, ANY_AD_LABELS)) return true;
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
    const found = [...document.querySelectorAll<HTMLElement>(FEED_UNIT_SELECTOR)].filter(
      // our own placeholders and badges sit in the feed too; comment articles are not feed units
      (el) => !ours.has(el) && !(el.matches(ARTICLE) && isCommentLabelled(el)),
    );
    // Several selectors can match the same post at different depths: keep the outermost only,
    // so a post is checked, counted and sent to the AI once.
    const set = new Set(found);
    return found.filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
  }

  /** A post Facebook has actually rendered: not an empty virtualized shell, has an author, not a comment. */
  function isRendered(el: HTMLElement): boolean {
    return (
      el.getAttribute("data-virtualized") !== "true" &&
      el.querySelector(`${HEADING}, ${PROFILE_NAME}`) !== null &&
      !isCommentUnit(el)
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

  /**
   * Sponsored Reels / Stories / Marketplace tiles (rules only). A "tile" that is itself a feed
   * post, or contains one, is skipped: feed posts are decided by the feed logic, and a container
   * holding the whole feed must never be hidden because one of its ads is labelled.
   */
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
      if (hiddenUnits.has(tile) || tile.matches(FEED_UNIT_SELECTOR) || tile.querySelector(FEED_UNIT_SELECTOR) !== null) continue;
      if (hasSponsoredLabel(tile)) found.push(tile);
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

  /** Titles of the post's outbound links (layouts without link-preview parts). */
  function linkTitles(post: HTMLElement, messages: readonly HTMLElement[], author: HTMLElement | null, budget: number): string {
    let raw = "";
    const seen = new Set<string>();
    for (const a of post.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (raw.length >= budget) break;
      if (belowArticle(a, post) || messages.some((m) => m.contains(a)) || author?.contains(a)) continue;
      if (a.closest('button, [role="button"], [aria-hidden="true"]') !== null || !isVisible(a)) continue;
      if (outboundHost(a.getAttribute("href") ?? "") === null) continue;
      const title = fbahCollapseWhitespace(collectText(a, 300));
      if (title !== "" && !seen.has(title)) {
        seen.add(title);
        raw += ` ${title}`;
      }
    }
    return raw;
  }

  /**
   * The post body: its message, then the title and description of its link preview (or, in
   * older layouts, the titles of its outbound links). Without any of those, the post minus its
   * header, controls, reactions, counters and comments. Never includes the author name (sent
   * separately as `header`).
   */
  function postText(post: HTMLElement, author: HTMLElement | null, max: number): string {
    const budget = max * 1.5;
    let messages = ownParts(post, [STORY_MESSAGE]);
    if (messages.length === 0) messages = ownParts(post, [MESSAGE]);
    const preview = ownParts(post, [PREVIEW_TITLE, PREVIEW_DESCRIPTION]).filter(
      (p) => !messages.some((m) => m.contains(p) || p.contains(m)),
    );
    let raw = "";
    if (messages.length + preview.length > 0) {
      for (const part of [...messages, ...preview]) raw += ` ${collectText(part, budget - raw.length)}`;
      if (preview.length === 0) raw += linkTitles(post, messages, author, budget - raw.length);
    } else {
      // Text before the author block is the social-context line ("X commented"), not the post.
      raw = collectText(post, budget, { exclude: author, after: author, dropNoise: true });
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

  /** The link-preview domain ("CIRQUEDUSOLEIL.COM" → "cirquedusoleil.com"), or null if it is not a hostname. */
  function previewDomain(el: HTMLElement): string | null {
    const host = shownText(el).toLowerCase().replace(/^www\./, "");
    return FBAH_HOSTNAME_RE.test(host) ? host : null;
  }

  function linkHosts(post: HTMLElement): string[] {
    const hosts = new Set<string>();
    for (const el of ownParts(post, [PREVIEW_DOMAIN])) {
      const host = previewDomain(el);
      if (host) hosts.add(host);
    }
    for (const a of post.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (hosts.size >= FBAH_POST_LIMITS.links) break;
      if (belowArticle(a, post)) continue; // link inside a comment
      const host = outboundHost(a.getAttribute("href") ?? "");
      if (host) hosts.add(host);
    }
    return [...hosts].slice(0, FBAH_POST_LIMITS.links);
  }

  /** A short label on the CTA part or one of its buttons, "" when there is none (Facebook often leaves it empty). */
  function ctaLabel(part: HTMLElement): string {
    for (const el of [part, ...part.querySelectorAll<HTMLElement>('[role="button"], button, a, [aria-label]')]) {
      const text = shownText(el);
      if (text !== "" && text.length <= FBAH_POST_LIMITS.ctaText) return text;
      const label = fbahCollapseWhitespace(el.getAttribute("aria-label") ?? "");
      if (label !== "" && label.length <= FBAH_POST_LIMITS.ctaText) return label;
    }
    return "";
  }

  /** The text of a button whose label is a known ad call to action, or null. */
  function knownCtaButton(post: HTMLElement): string | null {
    let inspected = 0;
    for (const el of post.querySelectorAll<HTMLElement>('[role="button"], button, a[role="link"], a[role="button"]')) {
      if (belowArticle(el, post)) continue;
      const label = fbahCollapseWhitespace(el.getAttribute("aria-label") ?? "");
      if (label && label.length <= FBAH_POST_LIMITS.ctaText && CTA_LABELS.has(ctaNormalize(label))) return label;
      const text = fbahCollapseWhitespace(el.textContent ?? "");
      if (text.length < 3 || text.length > FBAH_POST_LIMITS.ctaText) continue;
      if (++inspected > 80) break;
      if (CTA_LABELS.has(ctaNormalize(text))) return text;
    }
    return null;
  }

  /** Facebook's CTA part, or a button with a known CTA label. */
  function callToAction(post: HTMLElement): { present: boolean; text: string } {
    const parts = ownElements<HTMLElement>(post, CTA_PART);
    for (const part of parts) {
      const text = ctaLabel(part);
      if (text !== "") return { present: true, text };
    }
    const known = knownCtaButton(post);
    return known !== null ? { present: true, text: known } : { present: parts.length > 0, text: "" };
  }

  function extractPostState(unit: HTMLElement, hasAdLabel: boolean): FBAHPostState | null {
    const post = postRoot(unit);
    const author = authorBlock(post);
    // Every feed post (organic or ad) starts with its author's name. Units without one
    // (carousels, "People you may know", Reels trays, a post still loading) are not sent.
    const header = author ? authorName(author) : "";
    if (header === "") return null;
    const text = postText(post, author, FBAH_POST_LIMITS.text);
    const links = linkHosts(post);
    const cta = callToAction(post);
    if (text.length + header.length < AI_MIN_CONTENT_CHARS && links.length === 0 && !cta.present && !hasAdLabel) {
      return null;
    }
    return fbahSanitizePostState({
      text,
      header,
      links,
      hasCallToActionButton: cta.present,
      ctaText: cta.text,
      hasAdLabel,
      language: document.documentElement.lang || navigator.language || "",
    });
  }

  // ---------- per-post decision ----------

  function aiWanted(): boolean {
    return settings.enabled && settings.hideFeedAds && settings.aiEnabled;
  }

  /** aria-labelledby targets inside `el` that exist and have text. */
  function resolvedLabelCount(el: Element): number {
    let n = 0;
    for (const ref of el.querySelectorAll("[aria-labelledby]")) {
      for (const id of (ref.getAttribute("aria-labelledby") ?? "").split(/\s+/)) {
        if (id && document.getElementById(id)?.textContent) n++;
      }
    }
    return n;
  }

  /**
   * Facebook fills a post in over several renders. The "Ad" label arrives in two steps — the
   * header's aria-labelledby first, the element holding the word later and outside the post —
   * so resolved label targets are part of the signature too: the label is looked for again
   * once its text exists.
   */
  function signature(el: HTMLElement): string {
    return `${el.getElementsByTagName("*").length}/${resolvedLabelCount(el)}`;
  }

  /** Creates or updates the record of a rendered unit and runs the label rules on new content. */
  function refreshUnit(el: HTMLElement, now: number): UnitRecord {
    const sig = signature(el);
    let rec = units.get(el);
    if (rec === undefined) {
      rec = {
        sig, sigSince: now, unstableSince: now, checks: 0, lastCheck: 0, hasAdLabel: false, hasCta: false,
        suggested: false, verdict: { kind: "none" }, pending: false, asking: null, attempts: 0, answers: 0,
        notBefore: 0, lookaheadNotBefore: 0, lastError: null, emptyTries: 0, place: null, held: false,
        holdSince: 0, holdReleased: false, revealedByUser: false,
      };
      units.set(el, rec);
    } else if (rec.sig !== sig) {
      if (now - rec.sigSince >= AI_STABLE_MS) rec.unstableSince = now;
      rec.sig = sig;
      rec.sigSince = now;
      rec.checks = 0;
      rec.lastCheck = 0;
      rec.emptyTries = 0;
      if (rec.verdict.kind === "rules" && rec.verdict.cause === "empty") rec.verdict = { kind: "none" };
    }
    if (rec.checks < MAX_CHECKS_PER_UNIT && now - rec.lastCheck >= LABEL_RECHECK_MS) {
      rec.checks++;
      rec.lastCheck = now;
      if (!rec.hasAdLabel) rec.hasAdLabel = hasSponsoredLabel(el);
      if (!rec.suggested) rec.suggested = hasSuggestedLabel(el);
      // Only needed for the hold gate, i.e. while an answer is awaited.
      if (!rec.hasCta && aiWanted() && awaitingAI(rec)) rec.hasCta = callToAction(postRoot(el)).present;
    }
    return rec;
  }

  /** "Suggested for you" posts follow the Suggested setting and are never sent, unless they also carry an ad label. */
  function suggestedDecides(rec: UnitRecord): boolean {
    return rec.suggested && (settings.hideSuggested || !rec.hasAdLabel);
  }

  /** TypeSafe said "not an ad" before Facebook's "Ad" label appeared: it is asked once more (or is being asked). */
  function lateLabel(rec: UnitRecord, v: { probability: number; sawLabel: boolean }): boolean {
    return (
      !v.sawLabel &&
      rec.hasAdLabel &&
      v.probability < settings.aiThreshold &&
      (rec.pending || (rec.answers < AI_MAX_ANSWERS && rec.attempts < AI_MAX_ATTEMPTS))
    );
  }

  /** The post still needs an answer from TypeSafe (possibly one already in flight). */
  function awaitingAI(rec: UnitRecord): boolean {
    if (suggestedDecides(rec)) return false;
    const v = rec.verdict;
    return v.kind === "none" || (v.kind === "ai" && lateLabel(rec, v));
  }

  function needsAI(rec: UnitRecord): boolean {
    return !rec.pending && rec.attempts < AI_MAX_ATTEMPTS && awaitingAI(rec);
  }

  /**
   * Where a post is relative to the window: inside it, at most AI_PREHOLD_SCREENS below it
   * ("near"), further below, or above it.
   */
  type Zone = "window" | "near" | "below" | "above";

  interface Place {
    zone: Zone;
    /** Inside the window or the lookahead (AI_LOOKAHEAD_SCREENS below, AI_LOOKBEHIND_SCREENS above): may be sent. */
    inRange: boolean;
    /** Sort key: 0 inside the window, then 1 + px below it, then (after every post below) px above it. */
    rank: number;
  }

  /** The box standing for the post: its own, or our placeholder's while we hide it. Null when it has none. */
  function layoutBox(el: HTMLElement): DOMRect | null {
    const entry = hiddenUnits.get(el);
    const target = entry === undefined || entry.revealed ? el : entry.placeholder;
    if (target === null || !target.isConnected) return null;
    const r = target.getBoundingClientRect();
    return r.width === 0 && r.height === 0 ? null : r;
  }

  /**
   * The post's place, or null when it has no box. Measured with getBoundingClientRect, which also
   * works in hidden tabs (no IntersectionObserver: it does not fire there).
   */
  function placeOf(el: HTMLElement): Place | null {
    const r = layoutBox(el);
    const vh = window.innerHeight;
    if (r === null || vh <= 0) return null;
    if (r.bottom > 0 && r.top < vh) return { zone: "window", inRange: true, rank: 0 };
    if (r.top >= vh) {
      const below = r.top - vh;
      return {
        zone: below <= AI_PREHOLD_SCREENS * vh ? "near" : "below",
        inRange: below <= AI_LOOKAHEAD_SCREENS * vh,
        rank: 1 + below,
      };
    }
    const above = -r.bottom;
    return { zone: "above", inRange: above <= AI_LOOKBEHIND_SCREENS * vh, rank: 2 + AI_LOOKAHEAD_SCREENS * vh + above };
  }

  function fallback(rec: UnitRecord, cause: FallbackCause, why: string): void {
    rec.verdict = { kind: "rules", cause, why };
    rec.lastError = null;
  }

  /** Posts decided by the rules only because the AI was unavailable are asked again. Labelled ones stay hidden. */
  function retryUnavailable(): void {
    unavailable = null;
    for (const rec of units.values()) {
      const v = rec.verdict;
      if (v.kind === "rules" && v.cause === "unavailable" && !rec.hasAdLabel) rec.verdict = { kind: "none" };
    }
  }

  type Triage =
    | { kind: "idle" } //                  nothing to send (decided, in flight, or beyond the lookahead)
    | { kind: "later"; at: number } //     within the lookahead, not before `at`: content settling, retry time, end of a pause
    | { kind: "due"; place: Place }; //    ready to be sent

  const IDLE: Triage = { kind: "idle" };

  /** Whether `el` should be sent now. Also records where it is (for the hold gate). */
  function triage(el: HTMLElement, rec: UnitRecord, now: number): Triage {
    if (!awaitingAI(rec)) {
      rec.place = null;
      return IDLE;
    }
    const place = placeOf(el);
    rec.place = place;
    if (!needsAI(rec)) return IDLE; // in flight
    if (unavailable !== null) {
      fallback(rec, "unavailable", `AI unavailable: ${ERROR_TEXT[unavailable.code]}`);
      return IDLE;
    }
    if (place === null || !place.inRange) return IDLE; // beyond the lookahead: not sent
    // Exact time the content counts as settled: stable for AI_STABLE_MS, or changing for too long.
    const maxUnstable = place.zone === "window" ? AI_MAX_UNSTABLE_VISIBLE_MS : AI_MAX_UNSTABLE_MS;
    const settled = Math.min(rec.sigSince + AI_STABLE_MS, rec.unstableSince + maxUnstable);
    // A full lookahead queue in the worker delays only this post's lookahead requests.
    const urgentNow = place.zone === "window" && document.visibilityState === "visible";
    const at = Math.max(settled, rec.notBefore, pausedUntil, urgentNow ? 0 : rec.lookaheadNotBefore);
    return now < at ? { kind: "later", at } : { kind: "due", place };
  }

  /** A strong local ad signal: Facebook's label, or an ad-style call-to-action button. */
  function strongSignal(rec: UnitRecord): boolean {
    return rec.hasAdLabel || rec.hasCta;
  }

  /**
   * Hold gate. A post with a strong signal whose answer is pending (waiting for stability, queued
   * or in flight) is held:
   *  - already when it is at most AI_PREHOLD_SCREENS below the window, so it is collapsed before it
   *    scrolls into view (never when it is above the window: nothing on screen moves). It stays
   *    held while it remains within the lookahead below, and is let go further away;
   *  - when it is inside the window.
   * The AI_HOLD_MAX_MS count starts once the held placeholder is inside the window (or above it,
   * if it was scrolled past without being measured inside), at most once per round of asking. The
   * round ends with an answer or a fallback.
   */
  function updateHold(rec: UnitRecord, now: number): void {
    if (!aiWanted() || !awaitingAI(rec) || !strongSignal(rec)) {
      rec.held = false;
      rec.holdSince = 0;
      rec.holdReleased = false;
      return;
    }
    if (rec.holdReleased) return;
    const zone = rec.place?.zone ?? null;
    if (rec.holdSince === 0) {
      if (zone === "window" || (rec.held && zone === "above")) {
        rec.held = true;
        rec.holdSince = now;
      } else if (zone === "near") {
        rec.held = true;
      } else if (!(zone === "below" && rec.place?.inRange === true)) {
        rec.held = false; // far below, or no box: held again if it comes near
      }
    }
    if (rec.holdSince !== 0 && now - rec.holdSince >= AI_HOLD_MAX_MS) {
      rec.held = false;
      rec.holdSince = 0;
      rec.holdReleased = true; // a slow API never swallows a post
    }
  }

  /** When a held post needs a scan without any DOM change: the end of its hold, or a re-measure below the window. */
  function holdWake(rec: UnitRecord, now: number): number {
    if (!rec.held) return Infinity;
    return rec.holdSince !== 0 ? rec.holdSince + AI_HOLD_MAX_MS : now + AI_PREHOLD_RECHECK_MS;
  }

  type Outcome =
    | { ok: true; probability: number; latencyMs: number | null; queuedMs: number; cached: boolean; batchSize: number }
    /** `apiCalled`: the worker made a TypeSafe call for this failure (false when it turned the request away). */
    | { ok: false; error: ErrorCode; retryAfterMs: number | undefined; apiCalled: boolean };

  function isErrorCode(v: unknown): v is ErrorCode {
    return typeof v === "string" && Object.hasOwn(ERROR_TEXT, v);
  }

  /** Runtime check of the worker's answer. */
  function readClassifyResult(v: unknown): Outcome {
    if (typeof v === "object" && v !== null) {
      const r = v as Record<string, unknown>;
      const p = r["probability"];
      if (r["ok"] === true && typeof p === "number" && p >= 0 && p <= 1) {
        const lat = r["latencyMs"];
        const queued = r["queuedMs"];
        const size = r["batchSize"];
        const cached = r["cached"] === true;
        const latencyMs = !cached && typeof lat === "number" && Number.isFinite(lat) && lat >= 0 ? Math.round(lat) : null;
        const queuedMs = !cached && typeof queued === "number" && Number.isFinite(queued) && queued >= 0 ? Math.round(queued) : 0;
        const batchSize = !cached && typeof size === "number" && Number.isSafeInteger(size) && size >= 1 ? size : 1;
        return { ok: true, probability: p, latencyMs, queuedMs, cached, batchSize };
      }
      const error = r["error"];
      const retry = r["retryAfterMs"];
      if (r["ok"] === false && isErrorCode(error)) {
        return {
          ok: false,
          error,
          retryAfterMs: typeof retry === "number" && Number.isFinite(retry) && retry >= 0 ? retry : undefined,
          apiCalled: r["apiCalled"] === true,
        };
      }
    }
    return { ok: false, error: "no_answer", retryAfterMs: undefined, apiCalled: false };
  }

  /**
   * Runs `fn` with our display:none rule lifted from `el` (a held post, for instance): the
   * extraction skips invisible elements. Synchronous, so nothing is painted in between.
   */
  function whileShown<T>(el: HTMLElement, fn: () => T): T {
    const entry = hiddenUnits.get(el);
    if (entry === undefined || entry.revealed) return fn();
    el.setAttribute(HIDDEN_ATTR, "revealed");
    try {
      return fn();
    } finally {
      el.setAttribute(HIDDEN_ATTR, entry.reason);
    }
  }

  /**
   * Last look before sending, whatever the label-check throttle says: a "Suggested for you" or
   * "Ad" label that hydrated since the last check (a text-only change does not reset the throttle)
   * is seen before the post leaves the browser.
   */
  function lastLook(el: HTMLElement, rec: UnitRecord): void {
    if (!rec.suggested) rec.suggested = hasSuggestedLabel(el);
    if (!rec.hasAdLabel) rec.hasAdLabel = hasSponsoredLabel(el);
  }

  /** `urgent`: the post is inside the window of a visible tab (the worker serves it first). */
  function ask(el: HTMLElement, rec: UnitRecord, urgent: boolean): void {
    const state = whileShown(el, () => {
      lastLook(el, rec);
      return awaitingAI(rec) ? extractPostState(el, rec.hasAdLabel) : undefined;
    });
    if (state === undefined) return; // decided by the last look (e.g. "Suggested for you"): not sent
    if (state === null) {
      if (++rec.emptyTries >= AI_MAX_EMPTY_TRIES) fallback(rec, "empty", "nothing to send to TypeSafe");
      else rec.notBefore = Date.now() + AI_EMPTY_RETRY_MS;
      return;
    }
    if (state.hasCallToActionButton) rec.hasCta = true;
    rec.pending = true;
    rec.attempts++;
    const asking: Asking = { state, urgent, done: false };
    rec.asking = asking;
    send(el, rec, asking, urgent);
  }

  /** A lookahead request of this round is in flight and no answer has arrived: it can be promoted. */
  function promotable(rec: UnitRecord): boolean {
    const a = rec.asking;
    return rec.pending && a !== null && !a.urgent && !a.done;
  }

  /**
   * The post entered the window of a visible tab while its lookahead request is still in flight:
   * the same state is sent again as an urgent request. The worker shares one answer between the
   * two and, if the post is still waiting for its batch, takes it out and sends it alone. Not a new
   * attempt; counted as an urgent request in flight until its own answer arrives.
   */
  function promote(el: HTMLElement, rec: UnitRecord): void {
    const asking = rec.asking;
    if (asking === null) return;
    asking.urgent = true;
    send(el, rec, asking, true);
  }

  /** One fbah/classify request of the round `asking`. The first answer of the round decides. */
  function send(el: HTMLElement, rec: UnitRecord, asking: Asking, urgent: boolean): void {
    if (urgent) inFlightUrgent++;
    else inFlightLookahead++;
    fbahSendToBackground({ type: "fbah/classify", state: asking.state, urgent })
      .then(
        (res: unknown) => readClassifyResult(res),
        // e.g. the worker was stopped mid-request
        (): Outcome => ({ ok: false, error: "unreachable", retryAfterMs: undefined, apiCalled: false }),
      )
      .then((outcome) => {
        if (urgent) inFlightUrgent--;
        else inFlightLookahead--;
        if (!asking.done) {
          asking.done = true;
          rec.pending = false;
          onOutcome(rec, outcome, asking.state.hasAdLabel, urgent);
        } else if (outcome.ok && rec.asking === asking && rec.verdict.kind === "none") {
          // The other request of this round failed first (e.g. this one reached the worker after
          // the first had ended); an answer for the same state is still an answer.
          onOutcome(rec, outcome, asking.state.hasAdLabel, urgent);
        } else {
          scheduleScan(); // the round was decided by the other request: only a slot was freed
          return;
        }
        if (units.get(el) === rec) applyUnit(el, rec, isRendered(el), Date.now());
        scheduleScan(); // the next posts
        queueStatusRefresh();
      });
  }

  /** `urgent`: the answered request was an urgent one (or a promotion). */
  function onOutcome(rec: UnitRecord, o: Outcome, sawLabel: boolean, urgent: boolean): void {
    if (o.ok) {
      rec.answers++;
      rec.lastError = null;
      rec.verdict = {
        kind: "ai",
        probability: o.probability,
        sawLabel,
        latencyMs: o.latencyMs,
        queuedMs: o.queuedMs,
        cached: o.cached,
        batchSize: o.batchSize,
      };
      return;
    }
    const why = ERROR_TEXT[o.error];
    switch (o.error) {
      case "disabled":
      case "no_key":
      case "invalid_key":
      case "forbidden":
      case "cap_reached":
        // Nothing works until a key is saved or verified (the worker then sends fbah/aiResume),
        // the settings change, or (daily cap) local midnight. The worker made no API call.
        rec.attempts--;
        unavailable = {
          code: o.error,
          until: o.error === "cap_reached" ? Date.now() + (o.retryAfterMs ?? 60 * 60_000) : Infinity,
        };
        fallback(rec, "unavailable", `AI unavailable: ${why}`);
        return;
      case "rejected":
      case "validation":
        fallback(rec, "rejected", `TypeSafe refused this post: ${why}`); // would be refused again
        return;
      case "rate_limited":
      case "overloaded":
        pausedUntil = Math.max(pausedUntil, Date.now() + (o.retryAfterMs ?? AI_DEFAULT_PAUSE_MS));
        pauseReason = why;
        // Turned away by the worker without a TypeSafe call (during a pause): not an attempt.
        // The pause paces the retries; real 429 / 529 answers from TypeSafe still count.
        if (!o.apiCalled) rec.attempts--;
        break;
      case "busy": {
        // The worker's queue is full, often because of other Facebook tabs: only this post waits,
        // the rest of the tab is not paused. Turned away without a TypeSafe call: not an attempt.
        // A lookahead request is delayed as a lookahead request only (urgent ones have their own
        // queue): once the post is inside the window of a visible tab it is sent at once.
        if (!o.apiCalled) rec.attempts--;
        const retryAt = Date.now() + (o.retryAfterMs ?? AI_RETRY_MS);
        if (urgent) rec.notBefore = retryAt;
        else rec.lookaheadNotBefore = retryAt;
        rec.lastError = why;
        return;
      }
      default: // timeout, network, server, bad_response, unknown, unreachable, no_answer
        break;
    }
    if (rec.attempts >= AI_MAX_ATTEMPTS) {
      fallback(rec, "failed", `AI failed ${AI_MAX_ATTEMPTS} times: ${why}`);
      return;
    }
    rec.lastError = why;
    rec.notBefore = Date.now() + (o.retryAfterMs ?? AI_RETRY_MS * (rec.attempts - rec.answers));
  }

  // ---------- what to show ----------

  type Tone = "ok" | "warn" | "bad" | "wait" | "off";

  type Plan =
    | { hide: HideReason; label: string; badge: string; tone: Tone }
    | { hide: null; badge: string | null; tone: Tone };

  function percent(p: number): string {
    return `${Math.round(p * 100)}%`;
  }

  /**
   * " · 420 ms" (duration of the API call), " · 420 ms + 300 ms queued" (plus the wait in the
   * worker), then " · batch of 5" when the post was asked about together with other lookahead
   * posts (420 ms is then the whole batch call); " · cached", or "" when the worker did not say.
   */
  function timing(v: { latencyMs: number | null; queuedMs: number; cached: boolean; batchSize: number }): string {
    if (v.cached) return " · cached";
    const batch = v.batchSize > 1 ? ` · batch of ${v.batchSize}` : "";
    if (v.latencyMs === null) return batch;
    const queued = v.queuedMs >= QUEUED_SHOWN_MS ? ` + ${v.queuedMs} ms queued` : "";
    return ` · ${v.latencyMs} ms${queued}${batch}`;
  }

  function planFor(rec: UnitRecord, now: number): Plan {
    if (!settings.enabled) return { hide: null, badge: null, tone: "off" }; // e.g. an answer arriving after "Enabled" was turned off
    if (!aiWanted()) {
      // Rules only.
      if (settings.hideFeedAds && rec.hasAdLabel) {
        return { hide: "sponsored", label: "Ad hidden by rules (Sponsored label)", badge: "", tone: "off" };
      }
      if (settings.hideSuggested && rec.suggested) {
        return { hide: "suggested", label: "Suggested post hidden", badge: "", tone: "off" };
      }
      return { hide: null, badge: null, tone: "off" };
    }
    if (suggestedDecides(rec)) {
      return settings.hideSuggested
        ? { hide: "suggested", label: "Suggested post hidden", badge: "Rules · Suggested for you", tone: "off" }
        : { hide: null, badge: "Rules · Suggested for you, not sent to TypeSafe", tone: "off" };
    }
    const v = rec.verdict;
    if (v.kind === "rules") {
      return rec.hasAdLabel
        ? { hide: "rules", label: `Ad hidden by rules (${v.why})`, badge: `Rules · ad (${v.why})`, tone: "warn" }
        : { hide: null, badge: `Rules · ${v.why}`, tone: "warn" };
    }
    if (v.kind === "ai" && !lateLabel(rec, v)) {
      const p = percent(v.probability);
      const t = timing(v);
      if (v.probability >= settings.aiThreshold) {
        return { hide: "AI", label: `Ad hidden by TypeSafe (${p})${t}`, badge: `TypeSafe · ad (${p})${t}`, tone: "bad" };
      }
      if (!v.sawLabel && rec.hasAdLabel) {
        // The "Ad" label appeared after the answer and this post has no attempt left to re-check it.
        const why = `"Ad" label appeared after TypeSafe's ${p}, no re-check left`;
        return { hide: "rules", label: `Ad hidden by rules (${why})`, badge: `Rules · ad (${why})`, tone: "warn" };
      }
      return { hide: null, badge: `TypeSafe · not an ad (${p})${t}`, tone: "ok" };
    }
    // No answer yet, or asked again after a late "Ad" label.
    if (rec.held) return { hide: "hold", label: HOLD_TEXT, badge: "TypeSafe · checking…", tone: "wait" };
    if (rec.lastError !== null) return { hide: null, badge: `TypeSafe · error: ${rec.lastError}, retrying`, tone: "bad" };
    const paused = now < pausedUntil ? ` (paused: ${pauseReason})` : "";
    const checking = rec.holdReleased ? "still checking…" : "checking…";
    return { hide: null, badge: `TypeSafe · ${checking}${paused}`, tone: "wait" };
  }

  /** Brings the page in line with the record's plan (hold gate included). Badges only on rendered posts. */
  function applyUnit(el: HTMLElement, rec: UnitRecord, rendered: boolean, now: number): void {
    updateHold(rec, now);
    const plan = planFor(rec, now);
    if (plan.hide !== null) {
      const entry = setHidden(el, plan.hide, plan.label);
      setBadge(el, rendered && entry?.revealed ? `${plan.badge}, shown on request` : null, plan.tone);
    } else {
      unhide(el);
      setBadge(el, rendered ? plan.badge : null, plan.tone);
    }
  }

  // ---------- hiding, placeholders, badges ----------

  function hasHiddenAncestor(el: Element): boolean {
    for (let p = el.parentElement; p !== null; p = p.parentElement) {
      if (p instanceof HTMLElement && hiddenUnits.has(p)) return true;
    }
    return false;
  }

  function setHidden(el: HTMLElement, reason: HideReason, label: string): HiddenEntry | null {
    let entry = hiddenUnits.get(el);
    if (entry === undefined) {
      if (hasHiddenAncestor(el)) return null; // already hidden with its container
      // A post the user opened stays open, e.g. when an "ad" answer arrives after its hold ended.
      entry = { reason, label, placeholder: null, revealed: units.get(el)?.revealedByUser === true };
      hiddenUnits.set(el, entry);
    }
    entry.reason = reason;
    entry.label = label;
    el.setAttribute(HIDDEN_ATTR, entry.revealed ? "revealed" : reason); // attributes are not observed: no rescan loop
    syncPlaceholder(el, entry);
    return entry;
  }

  function syncPlaceholder(el: HTMLElement, entry: HiddenEntry): void {
    // A hold is temporary: its placeholder is shown in "remove" mode too, so the post does not
    // vanish without a word (and so its position can still be measured).
    const hold = entry.reason === "hold";
    if ((settings.mode !== "collapse" && !hold) || entry.revealed) {
      entry.placeholder?.remove();
      entry.placeholder = null;
      return;
    }
    let ph = entry.placeholder;
    if (ph === null) {
      ph = document.createElement("div");
      ph.className = PLACEHOLDER_CLASS;
      ph.addEventListener("click", () => {
        entry.revealed = true;
        const rec = units.get(el);
        if (rec !== undefined) rec.revealedByUser = true; // outlives this entry (a hold ends, a new verdict)
        el.setAttribute(HIDDEN_ATTR, "revealed");
        entry.placeholder?.remove();
        entry.placeholder = null;
        scheduleScan(); // shows the post's badge
      });
      ours.add(ph);
      entry.placeholder = ph;
    }
    const text = hold ? entry.label : `${entry.label} — click to show`;
    if (ph.textContent !== text) ph.textContent = text;
    if (ph.nextSibling !== el) el.before(ph);
  }

  function unhide(el: HTMLElement): void {
    const entry = hiddenUnits.get(el);
    if (entry === undefined) return;
    entry.placeholder?.remove();
    el.removeAttribute(HIDDEN_ATTR);
    hiddenUnits.delete(el);
  }

  /** Our badge, as the previous sibling of the post. Writes only when something changed (no mutation loop). */
  function setBadge(el: HTMLElement, text: string | null, tone: Tone): void {
    let badge = badges.get(el);
    if (text === null || !settings.showAIBadges || !aiWanted()) {
      badge?.remove();
      badges.delete(el);
      return;
    }
    if (badge === undefined) {
      badge = document.createElement("div");
      ours.add(badge);
      badges.set(el, badge);
    }
    const cls = `${BADGE_CLASS} fbah-tone-${tone}`;
    if (badge.className !== cls) badge.className = cls;
    if (badge.textContent !== text) badge.textContent = text;
    if (badge.nextSibling !== el) el.before(badge);
  }

  /** Forgets detached elements and removes the badges of posts Facebook unmounted. */
  function prune(): void {
    for (const el of units.keys()) if (!el.isConnected) units.delete(el);
    for (const [el, badge] of badges) {
      if (!el.isConnected || el.getAttribute("data-virtualized") === "true") {
        badge.remove();
        badges.delete(el);
      }
    }
    for (const [el, entry] of hiddenUnits) {
      if (!el.isConnected) {
        entry.placeholder?.remove();
        hiddenUnits.delete(el);
      }
    }
  }

  function clearPage(): void {
    for (const el of [...hiddenUnits.keys()]) unhide(el);
    for (const badge of badges.values()) badge.remove();
    badges.clear();
  }

  function counts(): FBAHHiddenCounts {
    let hiddenByAI = 0;
    let hiddenByRules = 0;
    for (const entry of hiddenUnits.values()) {
      if (entry.reason === "hold") continue; // not decided yet
      if (entry.reason === "AI") hiddenByAI++;
      else hiddenByRules++;
    }
    return { hiddenCount: hiddenByAI + hiddenByRules, hiddenByRules, hiddenByAI };
  }

  // ---------- toolbar badge (hidden count, shown by the worker) ----------

  /** Last hidden count sent to the worker, with the page URL at that time; null = nothing sent yet. */
  let reported: { count: number; href: string } | null = null;
  let countsTimer: number | undefined;

  function countsUnchanged(): boolean {
    return reported !== null && reported.count === counts().hiddenCount && reported.href === location.href;
  }

  /**
   * Sends the hidden count to the worker ("fbah/counts") when it changed, at most every
   * COUNTS_REPORT_MS (the latest value is sent). Also when the page URL changed: the worker clears
   * the tab's badge when the tab starts loading, which Facebook's in-page navigations can trigger
   * while this script and its count stay. Called after every scan.
   */
  function queueCountsReport(): void {
    if (countsTimer !== undefined || countsUnchanged()) return;
    countsTimer = window.setTimeout(() => {
      countsTimer = undefined;
      if (countsUnchanged()) return;
      const sent = { count: counts().hiddenCount, href: location.href };
      reported = sent;
      fbahSendToBackground({ type: "fbah/counts", hiddenCount: sent.count }).catch(() => {
        if (reported === sent) reported = null; // e.g. the worker was restarting: sent again after the next scan
      });
    }, COUNTS_REPORT_MS);
  }

  // ---------- status chip ----------

  let chip: HTMLButtonElement | null = null;
  /** Last fbah/aiStatus answer; "error" when the worker did not answer properly. */
  let aiStatus: FBAHAIStatus | "error" | null = null;
  let statusTimer: number | undefined;
  let statusQueued = false;

  function isAIStatus(v: unknown): v is FBAHAIStatus {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Record<string, unknown>;
    return (
      typeof r["hasKey"] === "boolean" &&
      (r["keyValid"] === null || typeof r["keyValid"] === "boolean") &&
      typeof r["callsToday"] === "number" &&
      typeof r["cap"] === "number" &&
      (r["lastError"] === null || typeof r["lastError"] === "string")
    );
  }

  async function refreshStatus(): Promise<void> {
    try {
      const res: unknown = await fbahSendToBackground({ type: "fbah/aiStatus" });
      aiStatus = isAIStatus(res) ? res : "error";
    } catch {
      aiStatus = "error";
    }
    renderChip();
  }

  function queueStatusRefresh(): void {
    if (statusQueued || chip === null) return;
    statusQueued = true;
    window.setTimeout(() => {
      statusQueued = false;
      void refreshStatus();
    }, 500);
  }

  function openOptions(): void {
    fbahSendToBackground({ type: "fbah/openOptions" }).catch(() => undefined);
  }

  function chipView(): { text: string; tone: Tone; title: string } {
    const lead = "Ad Hider · TypeSafe: ";
    const settingsHint = "Click to open the Ad Hider settings.";
    if (!aiWanted()) return { text: `${lead}off`, tone: "off", title: `AI detection is off. ${settingsHint}` };
    if (aiStatus === null) return { text: `${lead}checking status…`, tone: "wait", title: settingsHint };
    if (aiStatus === "error") {
      return { text: `${lead}status unavailable`, tone: "bad", title: "The extension's background worker did not answer. Reload the extension." };
    }
    const st = aiStatus;
    const lastError = st.lastError ? `Last TypeSafe error: ${st.lastError}. ` : "";
    if (!st.hasKey) return { text: `${lead}no API key — click to open settings`, tone: "bad", title: `Posts are decided by the local rules. ${settingsHint}` };
    if (st.keyValid === false) return { text: `${lead}invalid key — click to fix`, tone: "bad", title: `${lastError}${settingsHint}` };
    if (st.callsToday >= st.cap) {
      return { text: `${lead}daily cap reached (${st.callsToday}/${st.cap})`, tone: "warn", title: `The local rules decide until midnight. ${settingsHint}` };
    }
    const paused = Date.now() < pausedUntil ? ` · paused: ${pauseReason}` : "";
    return {
      text: `${lead}Active · ${st.callsToday}/${st.cap} calls today · ${counts().hiddenByAI} hidden by AI${paused}`,
      tone: paused ? "warn" : "ok",
      title: `${st.keyValid === null ? "Key not verified yet. " : ""}${lastError}${settingsHint}`,
    };
  }

  function renderChip(): void {
    const body = document.body;
    if (!settings.enabled || !settings.showAIBadges || body === null) {
      chip?.remove();
      chip = null;
      if (statusTimer !== undefined) window.clearInterval(statusTimer);
      statusTimer = undefined;
      return;
    }
    if (chip === null) {
      chip = document.createElement("button");
      chip.type = "button";
      chip.addEventListener("click", openOptions);
      ours.add(chip);
    }
    if (statusTimer === undefined) {
      statusTimer = window.setInterval(() => void refreshStatus(), STATUS_REFRESH_MS);
      void refreshStatus();
    }
    const view = chipView();
    const cls = `${CHIP_CLASS} fbah-tone-${view.tone}`;
    if (chip.className !== cls) chip.className = cls;
    if (chip.textContent !== view.text) chip.textContent = view.text;
    if (chip.title !== view.title) chip.title = view.title;
    if (chip.parentNode !== body) body.append(chip);
  }

  // ---------- scanning ----------

  /**
   * One rescan at `at` (content settled, a retry time, the end of a pause or of a hold); Infinity
   * cancels it. Runs the scan directly: an idle callback could add up to 200 ms.
   */
  function setWake(at: number): void {
    if (wake !== null && wake.at === at) return;
    if (wake !== null) window.clearTimeout(wake.timer);
    wake = null;
    if (at === Infinity) return;
    const timer = window.setTimeout(() => {
      wake = null;
      scan();
    }, Math.max(0, at - Date.now()));
    wake = { at, timer };
  }

  function scan(): void {
    prune();
    if (!settings.enabled) {
      clearPage();
      setWake(Infinity);
      renderChip();
      queueCountsReport();
      return;
    }
    const now = Date.now();
    if (unavailable !== null && now >= unavailable.until) retryUnavailable(); // daily cap: a new day
    let wakeAt = Infinity;
    if (settings.hideFeedAds || settings.hideSuggested) {
      const seen: [HTMLElement, UnitRecord][] = [];
      const due: { el: HTMLElement; rec: UnitRecord; place: Place }[] = [];
      const promotions: { el: HTMLElement; rec: UnitRecord }[] = [];
      const visible = document.visibilityState === "visible";
      for (const el of feedUnits()) {
        if (!isRendered(el)) {
          // A held post that Facebook unmounted is still released (or decided) on time.
          const rec = units.get(el);
          if (rec !== undefined && rec.held) {
            rec.place = null;
            applyUnit(el, rec, false, now);
            wakeAt = Math.min(wakeAt, holdWake(rec, now));
          }
          continue;
        }
        const rec = refreshUnit(el, now);
        seen.push([el, rec]);
        if (!aiWanted()) continue;
        const t = triage(el, rec, now);
        if (t.kind === "later") wakeAt = Math.min(wakeAt, t.at);
        else if (t.kind === "due") due.push({ el, rec, place: t.place });
        else if (visible && rec.place?.zone === "window" && promotable(rec)) promotions.push({ el, rec });
      }
      // On screen in this visible tab while its lookahead request still waits in the worker: moved
      // ahead first (those posts were found earlier). Blocked by the limit: the next answer rescans.
      for (const p of promotions) {
        if (inFlightUrgent >= AI_MAX_IN_FLIGHT) break;
        promote(p.el, p.rec);
      }
      // Inside the window first, then the nearest below, then above. Urgent and lookahead requests
      // have separate limits, so lookahead batches never hold back the posts being looked at.
      due.sort((a, b) => a.place.rank - b.place.rank);
      for (const c of due) {
        const urgent = visible && c.place.zone === "window";
        // Blocked by the limit: no timer needed, every answer frees a place and rescans (ask()).
        if (urgent ? inFlightUrgent >= AI_MAX_IN_FLIGHT : inFlightLookahead >= AI_LOOKAHEAD_MAX_IN_FLIGHT) continue;
        ask(c.el, c.rec, urgent);
        if (needsAI(c.rec)) wakeAt = Math.min(wakeAt, c.rec.notBefore); // nothing to send yet
      }
      for (const [el, rec] of seen) {
        applyUnit(el, rec, true, now);
        wakeAt = Math.min(wakeAt, holdWake(rec, now)); // released on time even without any DOM change
      }
    }
    if (settings.hideRightRailAds) {
      for (const block of rightRailAdBlocks()) setHidden(block, "sidebar", "Ad hidden by rules (right column)");
    }
    if (settings.hideReelsAndMarketplaceAds) {
      for (const tile of reelsAndMarketplaceAds()) setHidden(tile, "sponsored", "Ad hidden by rules (Sponsored label)");
    }
    setWake(wakeAt);
    renderChip();
    queueCountsReport();
  }

  let scheduled = false;
  function scheduleScan(): void {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      scan();
    };
    if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 200 });
    else setTimeout(run, 100);
  }

  /**
   * After a settings change, a manual rescan or fbah/aiResume: re-decide every known post from
   * the stored verdicts in the same task (no flash, no API call), then scan. Posts decided by the
   * rules only because the AI was unavailable (and without an ad label) are asked again.
   * `resume` (fbah/aiResume: a key was saved or verified, and the worker cleared its pause): the
   * tab's pause and retry waits end too. Otherwise they are kept, so a settings change or "Rescan"
   * during a rate-limit pause does not send requests the worker would only turn away.
   */
  function reevaluate(resume: boolean): void {
    if (resume) {
      pausedUntil = 0;
      for (const rec of units.values()) {
        rec.notBefore = 0;
        rec.lookaheadNotBefore = 0;
      }
    }
    retryUnavailable();
    for (const rec of units.values()) {
      rec.checks = 0;
      rec.lastCheck = 0;
    }
    for (const el of [...hiddenUnits.keys()]) if (!units.has(el)) unhide(el); // right column, tiles: found again by scan()
    const now = Date.now();
    if (settings.enabled) units.forEach((rec, el) => applyUnit(el, rec, isRendered(el), now));
    scan();
  }

  // ---------- wiring ----------

  function injectStyles(): void {
    const dark = (scope: string): string => `
      ${scope} .${PLACEHOLDER_CLASS}, ${scope} .${BADGE_CLASS} { color: #b0b3b8; background: rgba(255,255,255,.06); }
      ${scope} .${PLACEHOLDER_CLASS}:hover { background: rgba(255,255,255,.1); }
      ${scope} .${CHIP_CLASS} { color: #e4e6eb; background: #242526; border-color: rgba(255,255,255,.16); }
      ${scope} .${CHIP_CLASS}:hover { background: #3a3b3c; }`;
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
      .${BADGE_CLASS} {
        display: block; box-sizing: border-box; max-width: 680px; margin: 6px auto 2px; padding: 2px 10px;
        border-radius: 6px; font: 11px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #65676b; background: rgba(0,0,0,.04); text-align: left; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; user-select: none; pointer-events: none;
      }
      .${CHIP_CLASS} {
        all: initial; position: fixed; left: 12px; bottom: 12px; z-index: 2147483600; box-sizing: border-box;
        max-width: calc(100vw - 24px); padding: 5px 12px; border: 1px solid rgba(0,0,0,.12); border-radius: 999px;
        font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c1e21; background: #fff;
        box-shadow: 0 2px 8px rgba(0,0,0,.15); cursor: pointer; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis;
      }
      .${CHIP_CLASS}:hover { background: #f2f3f5; }
      .${CHIP_CLASS}:focus-visible { outline: 2px solid #1877f2; outline-offset: 2px; }
      .${BADGE_CLASS}::before, .${CHIP_CLASS}::before {
        content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px;
        border-radius: 50%; background: #8a8d91;
      }
      .fbah-tone-ok::before { background: #31a24c; }
      .fbah-tone-warn::before { background: #e4a11b; }
      .fbah-tone-bad::before { background: #e41e3f; }
      .fbah-tone-wait::before { background: #1877f2; }
      @media (prefers-color-scheme: dark) { ${dark("html:not(.__fb-light-mode)")} }
      ${dark("html.__fb-dark-mode")}
      ${dark("body.__fb-dark-mode")}
    `;
    (document.head ?? document.documentElement).appendChild(style);
  }

  // Only the sync area (settings). The API key lives in storage.local, which
  // this script deliberately does not subscribe to.
  chrome.storage.sync.onChanged.addListener((changes) => {
    const change = changes[FBAH_STORAGE_KEY];
    if (!change) return;
    settings = fbahSanitizeSettings(change.newValue);
    reevaluate(false);
    queueStatusRefresh();
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
        reevaluate(false);
        const res: FBAHResponse<typeof msg> = counts();
        sendResponse(res);
        break;
      }
      case "fbah/aiResume": {
        reevaluate(true);
        queueStatusRefresh();
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
    // Posts scrolled into view become due without any DOM change; labels can hydrate without one too.
    window.addEventListener("scroll", scheduleScan, { passive: true });
    window.addEventListener("resize", scheduleScan, { passive: true });
    // A tab brought to the front: its posts inside the window become urgent (pending lookahead
    // requests among them are promoted), without waiting for a DOM change.
    document.addEventListener("visibilitychange", scheduleScan);
    // Restored from the back/forward cache: the worker cleared the tab's badge when it started
    // loading, while this script's count and URL did not change. Report again.
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      reported = null;
      queueCountsReport();
    });
  })();
})();
