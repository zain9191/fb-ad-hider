# Facebook Ad Hider (Chrome, Manifest V3, TypeScript)

Hides sponsored posts, right-column ads, sponsored Reels/Marketplace tiles and
(optionally) "Suggested for you" posts on facebook.com.

Two detection layers:

1. **Local rules** (always on, 100% local): ad-disclosure links, aria labels,
   SVG labels, de-obfuscated "Sponsored" text. A post they recognise is hidden
   immediately, with no network call.
2. **TypeSafe AI** (optional, needs your own API key): feed posts the rules
   can't classify are sent to [TypeSafe AI](https://typesafe.ai) (model Jev)
   with a single yes/no question, "is this a paid ad or sponsored post?".
   The post is hidden if the answer's probability is at or above your threshold.

Without an API key the extension behaves exactly as before: no server, no tracking.

## Build and test
    npm install
    npm run build      # strict type-check + output to dist/
    npm test           # build, then test the TypeSafe client against a local mock server
                       # and the background worker against a mocked chrome.* API

## Install in Chrome
1. chrome://extensions → enable "Developer mode"
2. "Load unpacked" → select the `dist/` folder
3. Reload your Facebook tab

## Set up AI detection
1. Create an API key at https://console.typesafe.ai/keys
2. Open the extension's options page: click "AI settings…" in the popup, or
   right-click the toolbar icon → Options.
3. Paste the key → **Save** → **Test key**. A tiny real request is sent. You
   should see "Key works: jev-… answered in … ms".
4. The popup now shows "Active · N/300 calls today" and the per-page counts
   split as "X by rules · Y by AI". Posts hidden by the AI show "Ad hidden (AI 93%)".

The "AI detection" toggle (popup or options page) turns the AI layer off
without removing the key. **Remove** deletes the key from the browser.

## How the AI decision works
- The content script only considers feed posts that the rules left unresolved,
  and only once they have been on screen for about 0.8 s: at least 120 px of the
  post (or half of a shorter post) inside the window. Posts below the window are
  not sent. The rules get one last look first, because labels often hydrate late.
- "Suggested for you" posts are never sent: with the "Suggested for you" toggle
  off they stay visible, with it on the rules hide them. Feed units without an
  author heading (carousels, "People you may know", Reels trays) are not sent either.
- Each post is asked about once. Only a real answer (or a request the background
  refuses) is final. After a temporary error (rate limit, overload, busy queue,
  daily cap, no key or invalid key, timeout, network or server error, worker
  restarted) the post stays eligible and is asked again once AI calls resume.
  Timeouts and network/server errors count as failures: after 3 failed calls
  the post is left alone until the next rescan or settings change.
- The request contains a compact description of the post, not the page:
  `text` (the post message plus the titles of its outbound link attachments,
  whitespace-collapsed, max 1,500 characters; comments, the comment box, the
  author name, timestamp and permalink links, buttons such as Like / Share /
  See more, the reaction bar, the names of people who reacted and the
  like/comment/share counters are left out), `header` (the author's name only),
  `links` (up to 5 outbound hostnames, with no paths or query strings; `l.facebook.com`
  redirects are unwrapped), `hasCallToActionButton` (Shop now / Learn more /
  En savoir plus / Acheter… found) and `language` (Facebook UI language).
- When a unit is not itself `role="article"`, a nested article is used as the
  post only if it contains the unit's first heading (the author's name).
  Otherwise the unit is the post and every article inside it is treated as a
  comment, so comment text is never sent in place of the post.
- The background service worker sends one `noul` (yes/no) question to
  `POST https://api.typesafe.ai/v1/systemone` with model `jev-latest`, including
  `true`/`false` criteria with examples. The answer `noul` is the probability (0–1)
  that the post is a paid ad.

### Threshold
A post is hidden when that probability is **at least the threshold** (default
**0.85**, adjustable from 0.50 to 0.99 in Options).
- Organic posts getting hidden by mistake → raise it (e.g. 0.90–0.95).
- Ads slipping through → lower it (e.g. 0.70). You will see more false positives.

Every hidden post keeps a "click to show" placeholder unless you chose
"Remove completely". Changing the threshold (or any setting), or clicking
"Rescan this page", re-applies the stored answers to every classified post on
the page at once, without new API calls, so AI-hidden posts do not flash back.

## Cost controls
- **Cache:** answers are cached in memory and in `chrome.storage.session`
  (cleared when the browser closes), keyed by a SHA-256 hash of the stable part
  of the post description: author name, the first 200 characters of `text`,
  link hosts, the button flag and the language. New reactions or comments, a
  changing relative timestamp, or expanding "See more" therefore do not cause a
  new call, and the same post (on a reload or in another tab) is normally
  classified once per browser session. Two posts by the same author that start
  with the same 200 characters (same hosts, button flag and language) share one
  answer. Identical concurrent requests share one call.
- **Concurrency:** at most 2 TypeSafe calls at a time (3 in flight per tab), with a
  bounded queue.
- **Daily cap:** default **300 calls per local calendar day**, adjustable in
  Options. When it is reached, AI calls stop until midnight and the local rules keep
  working. Each classification request counts once, including failed ones
  and "Test key". The client's automatic retries inside one request are not
  counted separately.
- **Invalid key:** after a 401/403 the key is marked invalid and no more calls are
  made until you save a different key or a "Test key" succeeds. Open Facebook
  tabs stop sending posts while there is no usable key, and resume when the
  background tells them a key was saved or verified.
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
one of this extension's requests has not been measured. **Illustrative
assumption:** at about 1,000 input tokens per call, 300 calls/day cost
300 × 1,000 × 0.042 / 1,000,000 = $0.0126 per day, about $0.38 per 30 days.
Check your usage in the TypeSafe console.

## Privacy
**When AI detection is on, the text of posts that local rules can't classify is
sent to TypeSafe AI (api.typesafe.ai) for classification.** This includes
whatever the post text contains (friends' names, for example). Comments,
reactions and the names of people who reacted, full URLs and your Facebook
cookies are not sent (`credentials: "omit"`). Posts already recognised by the
rules, and "Suggested for you" posts, are never sent. With no key, or with the
toggle off, nothing leaves the browser.

Per-post state (checked, hidden, AI answer, errors) is kept in the content
script's memory, not in DOM attributes, so facebook.com scripts cannot read
the per-post probabilities or the key status, and cannot exempt a post from
classification by setting an attribute. `data-fbah-hidden` is still written on
hidden posts for the CSS rule, but never read back.

Permissions: `storage`, plus host access to `https://*.facebook.com/*` (content
script, and reading the active tab's URL in the popup) and
`https://api.typesafe.ai/*`.

Key handling:
- The key is stored in `chrome.storage.local` under its own entry
  (`fbah.typesafe.apiKey`). It is never synced and is not part of the settings.
- Only the background service worker reads it and puts it in the
  `Authorization: Bearer` header of requests to `api.typesafe.ai`. It is never
  logged and is redacted from error messages.
- The content script never receives it. It only listens to `storage.sync`
  changes, and its only AI message (`fbah/classify`) returns a probability.
  The background also asks Chrome to restrict `storage.local` to trusted
  contexts. This is best effort, because some Chrome versions only support it
  for `storage.session`.
- The background only accepts messages from this extension. It accepts
  `fbah/classify` only from content scripts on `https://*.facebook.com`, and
  status/test messages only from the extension's own pages.

## Structure
- src/shared.ts     – typed settings (incl. aiEnabled / aiThreshold / aiDailyCap), storage helpers,
                      post-state validation, typed message contract (FBAHMessage / FBAHResponses)
- src/typesafe.ts   – typed TypeSafe System One client (noul / choice / score types, runtime response
                      validation, retries, timeouts, typed errors); no chrome.* so it runs in Node tests
- src/background.ts – service worker: key storage, cache, queue, daily cap, persisted rate-limit pause,
                      sender checks, TypeSafe calls
- src/content.ts    – local rules + on-screen post extraction for the AI + hiding
- src/popup.ts      – settings UI, per-tab counters (rules / AI), AI status
- src/options.ts    – API key (save / show / test / remove), threshold, daily cap
- public/           – manifest.json, popup.html, options.html
- scripts/test-typesafe.mjs – Node test (no deps) of dist/typesafe.js against a mock /v1/systemone
- scripts/test-background.mjs – Node test (no deps) of dist/background.js with a mocked chrome.* API
                      (pause across worker restarts, cache key, cap, resume broadcast)
- scripts/mock-feed.html – manual browser check of dist/content.js on a mock feed with a stubbed
                      chrome.* API (serve the project folder over http://localhost, open the page,
                      read the PASS/FAIL list). Not part of `npm test`: it needs a browser.

Facebook changes its markup often; if ads slip through, add the label or
selector in `src/content.ts` (SPONSORED_LABELS / CTA_LABELS / feedUnits()).

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
  answers (prompt injection). An ad could try to look organic.
- Telling the post body apart from comments, reactions, counters and the
  timestamp relies on Facebook's markup (`data-ad-preview="message"` containers,
  `role` attributes, heading elements, comment `aria-label`s). This was only
  checked on a mock page; if Facebook changes it, some of that text may be
  included, or a post may not be sent at all.
- Hidden posts still carry `data-fbah-hidden`, and facebook.com scripts can see
  whether a post they inserted was hidden. The per-post probability itself is
  not exposed.
