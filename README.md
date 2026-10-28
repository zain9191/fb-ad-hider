# Facebook Ad Hider (Chrome, Manifest V3, TypeScript)

Hides sponsored posts, right-column ads, sponsored Reels/Marketplace tiles and
(optionally) "Suggested for you" posts on facebook.com.

**AI-first (default):** [TypeSafe AI](https://typesafe.ai) (model Jev, your own
API key) decides which feed posts are ads. Every feed post on screen, up to
about two screens below or one screen above is asked one yes/no question,
"is this a paid ad or sponsored post?", and is hidden if the answer's probability
is at or above your threshold. Posts on screen are normally sent alone; posts ahead of the
screen are sent in batches of up to 5 per call (see "Batching" below). Facebook renders posts before you reach them, so the answer
usually arrives before the post scrolls into view. Facebook's own
"Ad" / "Sponsored" label is passed to the AI as a strong signal (`hasAdLabel`),
not used as the decision: in the 2026 feed it is rendered outside the post, after
the post, and in a background tab often not at all.

**Fallback:** when TypeSafe can't answer (no key, invalid key, forbidden, daily
cap reached, AI turned off in the worker) or a post failed 3 attempts, the local
rule decides: the post is hidden if Facebook's label was found.

**Rules only** (AI toggle off): ad-disclosure links, aria labels, SVG labels and
de-obfuscated "Sponsored" / "Ad" text hide a post directly, with no network call.
The right-column "Sponsored" block and Reels / Marketplace tiles are always
handled by the rules.

Without an API key nothing leaves the browser: no server, no tracking.

## Build and test
    npm install
    npm run build      # strict type-check + output to dist/
    npm test           # build, then test the TypeSafe client against a local mock server
                       # and the background worker against a mocked chrome.* API
    TYPESAFE_API_KEY=… npm run live-check   # optional: real calls, see "Live accuracy check"

## Install in Chrome
1. chrome://extensions → enable "Developer mode"
2. "Load unpacked" → select the `dist/` folder
3. Reload your Facebook tab

## Set up AI detection
1. Create an API key at https://console.typesafe.ai/keys
2. Open the extension's options page: click "AI settings…" in the popup, or
   right-click the toolbar icon → Options.
3. Paste the key → **Save** → **Test key**. The background first asks TypeSafe
   for its models list (`GET /v1/models`, the endpoint of the official JS SDK's
   models resource, with your key). If TypeSafe answers 404 / 405 there (no such
   list), or with something that is not a models list, it sends a tiny real
   classification request instead (`POST /v1/systemone`). You should see
   "Key works (checked with the models list, jev-latest available): TypeSafe
   answered in … ms" or "Key works (checked with a classification call): jev-…
   answered in … ms". A 401 / 403 on the models list reports the key as rejected,
   without a second request. A models list answer only shows that the key is
   accepted: while AI calls are paused after a rate-limit / overload answer, or
   when the key was refused by the classification endpoint (e.g. 403), the tiny
   classification request is sent too, and only its success lifts the pause or the
   refusal and lets the Facebook tabs resume. Each request counts in today's calls;
   TypeSafe's documentation does not say whether the models list uses tokens.
4. Reload Facebook. The status chip at the bottom left reads
   "Ad Hider · TypeSafe: Active · N/300 calls today · M hidden by AI", and every
   feed post gets a one-line verdict above it (see below). The popup shows the
   same status and the per-page counts split as "X by rules · Y by AI".

The "AI decides which posts are ads" toggle (popup or options page) turns the AI
off without removing the key. **Remove** deletes the key from the browser.

## What you see on Facebook
With "Show TypeSafe verdicts on posts" on (popup, default on):
- **Badge above each post** (our own element, inserted before the post, never
  inside Facebook's markup, text only):
  - `TypeSafe · checking…` — waiting to come within two screens / stable, or in flight
  - `TypeSafe · still checking…` — a held post (see below) shown again after 4 s
    without an answer
  - `TypeSafe · not an ad (4%) · 420 ms` — TypeSafe answered below your threshold;
    the end is the duration of the API call, or `· cached` for an answer from the cache.
    `· 420 ms + 300 ms queued` means the request also waited 300 ms in the background
    worker (for its batch to fill, at most 150 ms, and for a free call slot; shown from
    10 ms). `· batch of 5` at the end means the post was asked about in one call together
    with other posts ahead of the screen; the time is then that of the whole batch call
  - `TypeSafe · error: timeout, retrying` — a temporary error; retried
  - `Rules · AI unavailable: no API key` (or `invalid API key`, `daily cap reached`…),
    `Rules · AI failed 3 times: network error` — TypeSafe did not decide; the local
    rule did (this post had no "Ad" label, so it stays visible)
  - `Rules · Suggested for you, not sent to TypeSafe`
  Badges disappear when Facebook unmounts a post (`data-virtualized="true"`) and
  come back from the stored verdict when it re-renders, without a new call.
- **Hidden posts** keep a placeholder with the reason, e.g.
  "Ad hidden by TypeSafe (93%) · 420 ms — click to show" or
  "Ad hidden by rules (AI unavailable: no API key) — click to show". A post you
  reveal gets the badge "TypeSafe · ad (93%) · 420 ms, shown on request".
- **Held posts:** a post whose answer is still pending and that carries a strong ad
  signal (Facebook's "Ad" label, or an ad-style button such as "Shop now") is
  collapsed into a thin "Checking with TypeSafe…" placeholder until the answer
  arrives: ad → the hidden placeholder above; not an ad → shown with its badge; AI
  unavailable → the local rule. This happens on screen, and already when the post is
  up to one screen below the window, so that it is collapsed before you scroll to it
  (posts above the window are never collapsed this way, so nothing you are looking at
  moves). It stays held while it is within two screens below, and is let go further
  away. A post is never held more than 4 s on screen: the count starts when its
  placeholder enters the window, then it is shown with "TypeSafe · still checking…".
  Posts without such a signal are never held, and held posts are not counted as
  hidden. The hold placeholder is shown in "Remove completely" mode too; clicking it
  shows the post at once, and the post then stays shown on that page even if
  TypeSafe later says it is an ad (badge "…, shown on request").
- **Toolbar icon:** the number of posts hidden on the current Facebook tab (blue
  badge, empty when none). The content script reports its count to the background
  when it changes (at most every 300 ms); the badge is cleared when the tab loads a
  new page. No extra permission is needed (`chrome.action`, from the manifest's
  `action` key).
- **Status chip** (bottom left): `TypeSafe: Active · 12/300 calls today · 3 hidden by AI`,
  `TypeSafe: no API key — click to open settings`, `TypeSafe: invalid key — click to fix`,
  `TypeSafe: daily cap reached (300/300)` or `TypeSafe: off`. Hover it for the last
  TypeSafe error. Clicking it opens the options page. It refreshes every 15 s and
  after each answer.

Badges, placeholders and the chip follow Facebook's dark mode (`__fb-dark-mode` class
on `<html>` or `<body>`) and otherwise the system colour scheme.

### "Nothing is done by TypeSafe"
Look at the chip first. `no API key` / `invalid key` / `daily cap reached`: fix it in
the options page (the posts are decided by the rules meanwhile and show why). `off`:
the AI toggle (or "Sponsored feed posts") is off. `status unavailable`: reload the
extension in chrome://extensions, then the tab. If the chip says Active but posts
stay on `checking…`, they are more than two screens away or keep changing; if they
show no badge at all, the feed markup was not recognised (see `FEED_UNIT_SELECTOR`
in src/content.ts).

## How the AI decision works
- **Which posts:** every rendered feed post (`[role="main"] [data-virtualized]`
  list items that are not `data-virtualized="true"`, plus the older feed layouts)
  that has an author heading and is not a comment, once it is **inside the window
  or within the lookahead**: up to 2 viewport heights below the window, and 1 above
  it for upward scrolling (measured with `getBoundingClientRect`, which also works
  in background tabs; a post we hide is measured on its placeholder), and its
  content signature (element count + resolved `aria-labelledby` targets) has not
  changed for **0.3 s** (or has kept changing for 1.5 s inside the window, 5 s
  ahead of it, e.g. an autoplaying video). Posts beyond the lookahead are not sent.
- **Order:** posts inside the window first, then by distance below it (nearest
  first), then those above it. Requests for posts inside the window of the visible
  tab are marked `urgent`. Per tab, at most 4 urgent requests and 10 lookahead
  requests (2 batches of 5) are in flight. The worker has 4 call slots: lookahead
  batches (and background tabs) use at most 2 of them, urgent posts are sent alone,
  start before any waiting batch and never wait for a batch. When a post whose
  lookahead request is still in flight comes on screen in the visible tab, the tab
  sends it again as `urgent` (same description, not a new attempt; it counts
  toward the 4 urgent requests): if the post is still waiting for its batch in the
  worker, it is taken out and sent alone. The same happens when another tab asks
  for it urgently. If its batch call has already started, the post gets that
  call's answer (no second call). Up to 2 posts you are looking at therefore start
  at once, whatever the lookahead is doing.
- **When:** checked on every DOM change (MutationObserver), on scroll and resize,
  after each answer (which also frees a slot), and by a one-shot timer at the exact
  time something becomes due without a DOM change: a post's content has been stable
  for 0.3 s (or has kept changing for 1.5 s / 5 s), a retry wait or a pause ends, or
  a hold reaches 4 s; plus about once a second while a post is held below the
  window. There is no periodic timer. No IntersectionObserver: it does not fire in
  hidden tabs.
- **Last look:** right before a post is sent, the "Suggested for you" and "Ad" label
  checks run once more (they are otherwise limited to one per second per post), so
  a label that appeared in the meantime is taken into account.
- **Hold gate:** see "Held posts" above.
- **Decision:** hidden iff TypeSafe's probability ≥ your threshold (reason "AI").
- **Late "Ad" label:** if TypeSafe said "not an ad" before Facebook's label showed
  up, the post is asked once more with `hasAdLabel: true` (a different cache key).
- **Hard caps per post element and page:** at most 2 answers and 3 counted requests
  (requests the worker turns away without calling TypeSafe are not counted, see below).
- **Fallback (reason "rules"):** worker answers `no_key`, `invalid_key`,
  `forbidden`, `cap_reached` or `disabled` → no further request is sent from the
  tab, every post gets the local rule and shows why. When a key is saved or
  verified (the worker sends `fbah/aiResume`), the settings change, "Rescan this
  page" is clicked or (daily cap) the day changes, the unlabelled posts are asked
  again; labelled ones stay hidden. After 3 failed requests (timeout, network,
  server, a rate-limit or overload answer from TypeSafe, worker unreachable) the
  rule applies for good on that page. `rejected` / `validation` apply it at once
  (the worker returns `validation` only for a post TypeSafe refused on its own,
  see "Batching"). Rate limits and overload also pause the tab for the worker's
  `retryAfterMs`. A full queue in the worker (`busy`, e.g. several Facebook tabs
  in the background) does not pause the tab: only the post turned away waits
  (5 s), and a lookahead request turned away that way does not delay the post
  once it is on screen in the visible tab (it is then sent as `urgent`, which has
  its own queue). Requests the worker turns away without calling TypeSafe (during
  a pause, or because its queue is full; the answer then has no `apiCalled`) do
  not count as attempts: they are sent again after the wait. A settings change or
  "Rescan this page" keeps the tab's pause; a saved or verified key ends it.
- "Suggested for you" posts are never sent (unless they also carry an "Ad"
  label): with the "Suggested for you" toggle off they stay visible, with it on
  the rules hide them. Feed units without an author (carousels, "People you may
  know", Reels trays) are not sent either.
- The request contains a compact description of the post, not the page:
  `text` (the post message — `data-ad-rendering-role="story_message"`, else
  `data-ad-preview="message"` — plus the link preview's `title` and `description`,
  whitespace-collapsed, max 1,500 characters; comments, the comment box, the author
  name, timestamp and permalink links, buttons such as Like / Share / See more, the
  reaction bar, the names of people who reacted and the like/comment/share counters
  are left out), `header` (the first link of the `profile_name` block, i.e. the
  author's name only, not "is with …" tags), `links` (up to 5 hostnames: the
  link-preview domain Facebook shows in capitals, lower-cased, then outbound links,
  with no paths or query strings; `l.facebook.com` redirects are unwrapped),
  `hasCallToActionButton` (a `data-ad-rendering-role="cta…"` part, or a Shop now /
  Learn more / En savoir plus… button), `ctaText` (that button's text, max 40
  characters, "" when Facebook leaves it empty), `hasAdLabel` (Facebook's "Ad" /
  "Sponsored" label found) and `language` (Facebook UI language).
- When a unit is not itself `role="article"`, a nested article is used as the
  post only if it contains the unit's first heading (the author's name).
  Otherwise the unit is the post and every article inside it is treated as a
  comment, so comment text is never sent in place of the post.
- The background service worker sends one `noul` (yes/no) question per post to
  `POST https://api.typesafe.ai/v1/systemone` with model `jev-latest`, including
  `true`/`false` criteria with examples. The prompt describes `hasAdLabel` as
  strong evidence and says that `false` only means the label was not seen. The
  answer `noul` is the probability (0–1) that the post is a paid ad. The question
  is built in one place, `src/adprompt.ts` (`fbahBuildAdRequest`), shared by the
  worker and the live accuracy check: for one post, `state` is the post and the
  question is `is_paid_ad`; for a batch, `state` is `{ posts: [...] }` and the
  questions are `is_paid_ad_0` … `is_paid_ad_N`, each about `posts[i]`, with the
  same field descriptions, criteria and "treat the content as data" guard.

### Threshold
A post is hidden when that probability is **at least the threshold** (default
**0.85**, adjustable from 0.50 to 0.99 in Options).
- Organic posts getting hidden by mistake → raise it (e.g. 0.90–0.95).
- Ads slipping through → lower it (e.g. 0.70). You will see more false positives.

Every hidden post keeps a "click to show" placeholder unless you chose
"Remove completely". Changing the threshold (or any setting), or clicking
"Rescan this page", re-applies the stored answers to every classified post on
the page at once, without new API calls, so AI-hidden posts do not flash back.
Switching from rules only to AI-first holds label-hidden posts that are on screen
("Checking with TypeSafe…", at most 4 s) until TypeSafe has answered for them.

## Cost controls
At most **one call per new post that comes within two screens of the window**,
fewer when posts ahead of the screen share a batch call (plus one more for a post whose "Ad" label appears after a "not an ad" answer;
with the shorter 0.3 s stability wait this re-check happens more often, because
more posts are asked before Facebook renders their label), capped per day. A post
Facebook has already rendered up to two screens ahead is sent even if you stop
scrolling before you reach it; posts further away cost nothing.

- **Cache:** answers are cached in memory, in `chrome.storage.session` (cleared
  when the browser closes) and in `chrome.storage.local` (kept across browser
  restarts), looked up in that order. The key is a SHA-256 hash of the stable part
  of the post description: author name, the first 200 characters of `text`, link
  hosts, the button flag and text, the ad-label flag and the language (plus a
  prompt version, `paid-ad-v3`, so answers cached under a previous prompt are not
  reused). New reactions or comments, a changing relative timestamp, or expanding
  "See more" therefore do not cause a new call. Two posts by the same author that
  start with the same 200 characters (same hosts, button, label flag and language)
  share one answer. Identical concurrent requests share one call.
- **Persistent cache:** each `chrome.storage.local` entry (`fbah.ai.lc.<hash>`)
  holds only `{ p, t }`: the probability and the last time the answer was stored
  or used (plus `b`, the batch prompt version, for an answer obtained in a batch). Every hit counts as a use, whether it is answered from memory, from
  `chrome.storage.session` or from `chrome.storage.local`, and refreshes `t` at most
  once a day (the worker reads an entry it does not know yet once, then writes only
  when `t` is a day old or the entry is missing, e.g. pruned while the session
  layer still had the answer). An answer not used for 7 days expires; at most 3,000
  are kept, the least recently used being evicted first.
  Writes are batched (about 0.5 s); the worker reads the whole local area once per
  lifetime, at its first cache write, to count the entries and drop expired ones.
  A repeated ad is therefore hidden at once, without a call, even after a browser
  restart. **Clear TypeSafe cache** (options page) deletes the cached answers in
  memory, session and local storage, never the key or the usage counters; a cache
  lookup or a TypeSafe call already under way when you click it does not write its
  answer back. Open Facebook tabs keep the verdicts they already have until reloaded.
- **Session layer:** `chrome.storage.session` has no 7-day expiry and no 3,000
  limit: it keeps every answer obtained since the browser started, until the
  browser closes (or the cache is cleared).
- **Batching (lookahead only):** posts ahead of the screen that are not in the
  cache wait in one queue in the worker and are sent together in ONE call, up to 5
  posts per call: as soon as 5 are waiting, or 150 ms after the oldest one arrived.
  The batch is formed when a lookahead call slot is free, so posts that arrive
  while both lookahead slots are busy join the next batch instead of each getting a
  call. The state is `{ posts: [...] }` with one question per post (TypeSafe's
  "speculative fan-out" pattern: many questions about the same state in one
  request). A batch takes one call slot and counts as **1 call** toward the daily
  cap. How many tokens a batch uses, and whether it is billed less than separate
  calls, is not documented: expect a batch to use more tokens than a single call
  (it carries every post and one question per post). Identical posts are asked
  once. Each post gets its own probability and its own cache entry; a missing or
  malformed answer fails only that post (`bad_response`), a failed call (e.g. a
  429) fails every post of the batch with the same error. A batch TypeSafe refuses
  as malformed (HTTP 400, 413 or 422) is asked again post by post, one after the
  other on the same slot (one more call each toward the daily cap): only a post
  refused on its own gets `validation` (final for that post on that page). When
  none is refused on its own, the batch form itself was refused: lookahead posts
  are then sent alone for 10 minutes (kept in the worker's memory only: a restarted
  worker tries a batch again). Posts on
  screen in the visible tab are sent alone, except one whose batch call had already
  started when it came on screen (see "Order"). A batch with a single post left is
  sent with the single-post question. Answers from a batch
  are stored with the batch prompt version (`paid-ad-batch-v1`), so they are not
  reused once the batch question changes. Accuracy of batched answers versus single
  ones has not been measured: see "Live accuracy check". The idea of one question
  per page element in one request comes from
  [typesafe-adblock](https://github.com/realZachi/typesafe-adblock) (MIT).
- **Concurrency:** at most 4 TypeSafe calls at a time, 2 of them kept for posts on
  screen in the visible tab (see "Order" above), with bounded queues. This is best effort with respect to TypeSafe's rate limit (not verified by
  this extension); 429 / 529 answers still pause the calls (below).
- **Daily cap:** default **300 calls per local calendar day**, adjustable in
  Options. When it is reached, AI calls stop until midnight and the local rules keep
  working. Each TypeSafe call counts once, including failed ones: a single-post
  call, a batch of up to 5 posts (plus one call per post when a refused batch is
  asked again post by post), and each request sent by "Test key" (1, or 2 when it
  falls back to, or confirms with, the classification call). The client's
  automatic retries inside one call are not counted separately.
- **Invalid key:** after a 401/403 the key is marked invalid and no more calls are
  made until you save a different key or a "Test key" succeeds (with the
  classification call: a models list answer alone does not lift it). Open Facebook
  tabs stop sending posts while there is no usable key (the rules decide, and the
  badges and chip say so), and resume when the background tells them a key was
  saved or verified.
- **Rate limits:** 408/429/5xx (including 529 Overloaded), timeouts and network
  errors are retried up to 3 times with exponential backoff and jitter
  (500 ms doubling to at most 8 s), honouring `Retry-After` / `retry-after-ms`.
  If the server asks to wait longer than 20 s, the extension pauses AI calls
  for that long instead (at most 10 minutes, and at least 5 s once the retries
  are used up). The pause is stored in `chrome.storage.session`, and recorded
  before each retry wait, so it survives Chrome stopping the idle service
  worker. The content scripts wait for the remaining pause time returned by the
  background. Each attempt times out after 15 s.

Pricing (external, may change): TypeSafe's models page lists Jev 1.13 at
$0.042 per million input tokens, and output tokens are free
(https://docs.typesafe.ai/models, consulted 2026-09-28). The token count of
one of this extension's requests (single post or batch) has not been measured. **Illustrative
assumption:** at about 1,000 input tokens per call, 300 calls/day cost
300 × 1,000 × 0.042 / 1,000,000 = $0.0126 per day, about $0.38 per 30 days.
Check your usage in the TypeSafe console.

## Privacy
**When AI detection is on, the text of feed posts on screen, up to about two
screens below or one screen above is sent to TypeSafe AI (api.typesafe.ai) for
classification**, including posts that carry Facebook's "Ad" label (posts ahead of
the screen in batches of up to 5 per request). Posts Facebook
has prepared ahead of the window can be sent even if you never scroll to them, and
so can posts up to one screen above it that you may never have had on screen (for
example when Facebook restores the scroll position or inserts posts above it). This includes whatever
the post text contains (friends' names, for example). Comments, reactions and the
names of people who reacted or
were tagged in the header, full URLs and your Facebook cookies are not sent
(`credentials: "omit"`). "Suggested for you" posts are never sent (unless they
also carry an "Ad" label). With no key, or with the toggle off, nothing leaves
the browser.

Answers are cached in this browser (`chrome.storage.local`, not synced) for 7 days
after their last use (at most 3,000): each entry holds only a SHA-256 fingerprint of
the post description, the probability and the time it was last used (and, for an
answer obtained in a batch, the batch prompt version), no post text.
While the browser is open, every answer since it started is also kept in
`chrome.storage.session`, with no 7-day or 3,000 limit, until the browser closes.
Someone with access to the browser profile who can rebuild a post's exact
description could tell whether, and roughly when, it was classified. "Clear
TypeSafe cache" in the options page deletes them.

Per-post state (checked, hidden, AI answer, errors) is kept in the content
script's memory, not in DOM attributes, so facebook.com scripts cannot read
the per-post probabilities or the key status, and cannot exempt a post from
classification by setting an attribute. `data-fbah-hidden` is still written on
hidden posts for the CSS rule, but never read back.

Permissions: `storage`, plus host access to `https://*.facebook.com/*` (content
script, and reading the active tab's URL in the popup) and
`https://api.typesafe.ai/*`. The toolbar counter uses `chrome.action` (available
through the manifest's `action` key) and `chrome.tabs.onUpdated` / `onRemoved`
(no permission needed; the background reads only the tab id and loading status).

Key handling:
- The key is stored in `chrome.storage.local` under its own entry
  (`fbah.typesafe.apiKey`). It is never synced and is not part of the settings.
- Only the background service worker reads it and puts it in the
  `Authorization: Bearer` header of requests to `api.typesafe.ai`. It is never
  logged and is redacted from error messages.
- The content script never receives it. It only listens to `storage.sync`
  changes; `fbah/classify` returns a probability and `fbah/aiStatus` (used by
  the chip) returns has-key / key-valid flags, the call count, the cap and the
  last error text, never the key.
  The background also asks Chrome to restrict `storage.local` to trusted
  contexts. This is best effort, because some Chrome versions only support it
  for `storage.session`.
- The background only accepts messages from this extension. It accepts
  `fbah/classify` and `fbah/counts` (the hidden count, a non-negative integer)
  only from content scripts in a tab on `https://*.facebook.com`,
  `fbah/aiStatus` and `fbah/openOptions` from those content scripts or the
  extension's own pages, and `fbah/testKey` and `fbah/clearCache` only from the
  extension's own pages.

## Structure
- src/shared.ts     – typed settings (incl. aiEnabled / aiThreshold / aiDailyCap), storage helpers,
                      post-state validation, typed message contract (FBAHMessage / FBAHResponses)
- src/typesafe.ts   – typed TypeSafe System One client (noul / choice / score types, runtime response
                      validation, per-answer validation for batches, models list, retries, timeouts,
                      typed errors); no chrome.* so it runs in Node tests
- src/adprompt.ts   – the ad question (single post and batch forms), its versions and criteria:
                      fbahBuildAdRequest, shared by the worker and scripts/live-check.mjs
- src/background.ts – service worker: key storage, cache (memory / session / persistent local),
                      priority queues (urgent / lookahead), lookahead batching, daily cap, persisted
                      rate-limit pause, sender checks, TypeSafe calls, call latency and queue wait,
                      cache clearing, Test key (models list / classification call), toolbar badge
- src/content.ts    – AI-first scheduling (lookahead + stable, viewport first), hold gate,
                      2026-layout post extraction, local rules (label signal / fallback / rules-only),
                      hiding, badges, status chip
- src/popup.ts      – settings UI (incl. "Show TypeSafe verdicts on posts"), per-tab counters, AI status
- src/options.ts    – API key (save / show / test / remove, with the check used), threshold, daily cap,
                      Clear TypeSafe cache
- public/           – manifest.json, popup.html, options.html
- scripts/test-typesafe.mjs – Node test (no deps) of dist/typesafe.js against a mock /v1/systemone and
                      /v1/models (partial answers; models list parse variants, 401, 404 / 405 signal)
- scripts/test-background.mjs – Node test (no deps) of dist/background.js with a mocked chrome.* API
                      (pause across worker restarts, cache key incl. hasAdLabel, prompt version, cap,
                      resume broadcast, sanitizer, aiStatus / openOptions sender checks, 4 concurrent
                      calls and queuedMs, urgent priority (2 reserved slots, urgent first, promotion),
                      apiCalled, latencyMs, persistent cache across a browser restart, 7-day expiry,
                      3,000-entry bound and LRU eviction, session hits refreshing the local entry,
                      Clear TypeSafe cache, including lookups and calls under way; batching: flush at
                      5 and at 150 ms, urgent bypass and take-out, one cap unit per batch, per-post
                      answers and cache entries, dedupe, missing answer, whole-batch 429, batch
                      prompt version, a refused batch asked again post by post (413 / 422) and the
                      batch form switched off, batches formed when a slot frees, an urgent request
                      for a post whose batch already started; toolbar badge sender checks; Test key
                      fallback, and a models list that never lifts a pause or a refused key alone)
- scripts/live-check.mjs – optional live accuracy check with your key (see below); not part of `npm test`
- scripts/mock-feed.html – browser check of dist/content.js on a mock of the 2026 feed (data-virtualized
                      wrappers, data-ad-rendering-role parts, a portal "Ad" label that appears 1 s after
                      its post, an unlabelled ad with a CTA, a virtualized-then-re-rendered post, late
                      label, lookahead, urgent flag, hold gate and its 4 s release, hold before the
                      post scrolls into view, a reveal kept after the hold, a pending lookahead post
                      promoted to urgent once on screen, a "busy" answer delaying only its post,
                      "batch of 5" badge and placeholder text, hidden count sent for the toolbar
                      badge, failures, no key, rules only)
                      with a stubbed chrome.* API whose classify answer is deterministic (ad iff
                      ctaText or hasAdLabel, latencyMs 42) and can be held back per author. Serve the
                      project folder over http://localhost, open the page, read the PASS/FAIL list.
                      Not part of `npm test`: it needs a browser.

Facebook changes its markup often; if posts get no badge at all, check
`FEED_UNIT_SELECTOR` / `isRendered()`; if the AI misses ads, check what is sent
(`extractPostState()`), and for the rules add the label in `SPONSORED_LABELS` /
`SHORT_AD_LABELS` (all in `src/content.ts`).

## Live accuracy check
`scripts/live-check.mjs` (no dependencies) sends 11 hand-written, fictional
Facebook-style posts with known answers to the real API, with the extension's own
question (`dist/adprompt.js`, loaded with `node:vm` together with `dist/shared.js`
and `dist/typesafe.js`): shop ad with a button and the "Ad" label, ad without label
but with a button and a shop domain, sponsored app install, influencer paid
partnership, a friend's birthday post, a news page post with a link, a group
discussion, a local business's organic post about a product, a meme page post, a
French ad and an Arabic organic news post.

    TYPESAFE_API_KEY=… npm run live-check

The key is read only from that environment variable (it stays in your shell, is
sent only in the `Authorization` header and is never printed). It runs two modes:
**single** (one call per post) and **batch** (all posts in one call, one question per
post). For each post it prints `p=…`, the expected answer and ✅ / ❌ at the default
threshold 0.85, then per mode the number correct at 0.85, the best threshold(s)
between 0.50 and 0.99, the total latency and the token usage if the API reports it.
It makes **at most 12 real requests** (11 single + 1 batch), billed to your key like
any other call; they are not counted in the extension's daily cap. There is no
automatic retry (a timeout or server error leaves that answer missing), and the
script stops at the first invalid-key, forbidden, rate-limit or overload answer
instead of sending the remaining requests. The extension's own batches
hold at most 5 posts, the live check's batch holds all 11. 11 posts are an
indication, not a benchmark.

## Known limitations
- Not yet verified against the live API with a real key. The request/response
  format follows TypeSafe's published OpenAPI spec (v0.2.0) and official SDKs, and
  is covered by the mock-server test.
- TypeSafe rejects browser CORS preflights from unknown origins. The call is made
  from the extension service worker, whose `host_permissions` for
  `https://api.typesafe.ai/*` should exempt it from CORS. Confirm with "Test key".
- Jev is trained mainly on English. Other languages work, but TypeSafe says accuracy
  is lower.
- Post text is data, but TypeSafe notes that text inside the state can still sway
  answers (prompt injection). An ad could try to look organic. In a batch, one
  post's text could also try to sway the answers about the other posts of the same
  call; the batch question tells the model to ignore instructions about other
  items, which has not been tested against such posts.
- Whether batched answers are as accurate as single ones, how many tokens a batch
  uses and how it is billed are not known; run the live accuracy check with your key.
- Telling the post body apart from comments, reactions, counters and the
  timestamp relies on Facebook's markup (`data-ad-rendering-role` parts,
  `data-ad-preview="message"` containers, `role` attributes, heading elements,
  comment `aria-label`s). The 2026 structure comes from one DOM inspection of an
  English feed (2026-09-30) and was reproduced on a mock page, not tested on the
  live site by the test suite. Comments are excluded when they are
  `role="article"`; if Facebook renders some comments without it, their text
  could end up in the fallback text of a post that has no message part.
- Badges, placeholders and the chip are inserted into Facebook's page (next to
  the posts, and at the end of `<body>`); facebook.com scripts can see them.
- Most posts are answered before they scroll into view. A post that appears
  directly on screen (at page load, after a fast scroll, or when Facebook renders
  it late) still needs 0.3 s of stable content plus TypeSafe's answer time: with a
  strong signal it is held meanwhile (at most 4 s), without one it stays visible
  until the answer, so an unlabelled ad without a button can still show briefly.
  A post with a strong signal that comes from below is usually collapsed before it
  is visible; after a very fast scroll the first scan can still run up to about
  200 ms after the post was painted.
- A post with an ad-style button is held while pending even if it turns out to be
  organic (it then reappears after the answer, at most 4 s after it reached the
  window; usually before you reach it, since the hold starts one screen below).
- Hidden posts still carry `data-fbah-hidden` (`hold` while a held post waits for
  its answer), and facebook.com scripts can see whether a post they inserted was
  hidden or held. The per-post probability itself is not exposed.
