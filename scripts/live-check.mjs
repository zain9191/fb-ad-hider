// Live accuracy check of the extension's TypeSafe question against the REAL API.
//
//   TYPESAFE_API_KEY=… npm run live-check        (= npm run build && node scripts/live-check.mjs)
//
// Classifies the hand-written, fictional Facebook-style posts below twice:
//   - mode "single": one call per post, with the single-post question (as for posts on screen);
//   - mode "batch":  ONE call for all the posts, one question per post (the fan-out form the
//     extension uses for lookahead posts, there with at most 5 posts per call).
// That is at most POSTS.length + 1 real requests billed to your key: no automatic retry, and the
// script stops at the first answer that the other calls would only repeat (invalid key, forbidden,
// rate limited, overloaded). They are not counted in the extension's daily cap (that counter lives
// in the browser).
//
// The key is read only from the TYPESAFE_API_KEY environment variable, sent only in the
// Authorization header to api.typesafe.ai, and never printed. No dependencies: the compiled
// dist/shared.js, dist/typesafe.js and dist/adprompt.js (the code the extension's worker runs) are
// loaded into a node:vm context. Not part of `npm test`.

import { readFileSync } from "node:fs";
import vm from "node:vm";

const THRESHOLD = 0.85; // the extension's default
const THRESHOLD_MIN = 50; // the options page allows 0.50 … 0.99
const THRESHOLD_MAX = 99;

const key = (process.env.TYPESAFE_API_KEY ?? "").trim();
if (key === "") {
  console.error("TYPESAFE_API_KEY is not set. Run:  TYPESAFE_API_KEY=<your key> npm run live-check");
  console.error("(the key stays in your shell; this script never prints it)");
  process.exit(2);
}

const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, console, URL, TextEncoder });
for (const name of ["shared.js", "typesafe.js", "adprompt.js"]) {
  const path = new URL(`../dist/${name}`, import.meta.url);
  vm.runInContext(readFileSync(path, "utf8"), context, { filename: `dist/${name}` });
}
const fromDist = (name) => vm.runInContext(name, context);
const sanitize = fromDist("fbahSanitizePostState");
const buildRequest = fromDist("fbahBuildAdRequest");
const systemOnePartial = fromDist("typesafeSystemOnePartial");
const isPlausibleKey = fromDist("fbahIsPlausibleApiKey");
const DEFAULTS = fromDist("TYPESAFE_DEFAULTS");

if (!isPlausibleKey(key)) {
  console.error("TYPESAFE_API_KEY does not look like an API key (8-512 printable characters, no spaces).");
  process.exit(2);
}

// ---------- fictional posts (FBAHPostState) with the expected answer ----------

const post = (fields) => ({ links: [], hasCallToActionButton: false, ctaText: "", hasAdLabel: false, language: "en", ...fields });

const POSTS = [
  {
    label: "shop ad, CTA + 'Ad' label",
    ad: true,
    state: post({
      header: "Brindlewood Boots",
      text: "Winter sale: 40% off all hiking boots until Sunday. Free returns on every order. Waterproof Leather Hiker, now €89",
      links: ["brindlewood-boots.com"],
      hasCallToActionButton: true,
      ctaText: "Shop now",
      hasAdLabel: true,
    }),
  },
  {
    label: "ad without label, CTA + shop domain",
    ad: true,
    state: post({
      header: "Lumora Skincare",
      text: "Dermatologist-tested serum that visibly reduces fine lines in 14 days. New customers get 25% off with code GLOW25. Lumora Renew Serum 30 ml",
      links: ["lumora-skin.com"],
      hasCallToActionButton: true,
      ctaText: "Learn more",
    }),
  },
  {
    label: "sponsored app install",
    ad: true,
    state: post({
      header: "PocketPlanner Budget App",
      text: "Stop wondering where your money went. PocketPlanner sorts your spending automatically. Free for 30 days. PocketPlanner Finance, free to install",
      links: ["play.google.com"],
      hasCallToActionButton: true,
      ctaText: "Install now",
      hasAdLabel: true,
    }),
  },
  {
    label: "influencer paid partnership",
    ad: true,
    state: post({
      header: "Chloé Marlowe",
      text: "Paid partnership with Velora Coffee. My mornings start with the new Velora oat latte pods. Two weeks of testing and I'm hooked. Use CHLOE15 for 15% off your first box! #ad #partner",
      links: ["velora-coffee.com"],
    }),
  },
  {
    label: "friend's birthday post",
    ad: false,
    state: post({
      header: "Julien Bernard",
      text: "Happy 30th birthday to my little sister! So proud of everything you did this year. Dinner at mum's on Saturday, don't be late 🎂",
    }),
  },
  {
    label: "news page post with link",
    ad: false,
    state: post({
      header: "The Morning Ledger",
      text: "The city council approved a new cycle lane along the river after a two-year consultation. Council approves riverside cycle lane. Work on the 4 km route begins next spring",
      links: ["morningledger-news.com"],
    }),
  },
  {
    label: "group discussion",
    ad: false,
    state: post({
      header: "Elena Novak",
      text: "Has anyone else had trouble with slugs on the lettuces this week? Mine are completely gone. Any tips that don't involve pellets?",
    }),
  },
  {
    label: "local business, organic post about a product",
    ad: false,
    state: post({
      header: "Le Fournil de Clara",
      text: "Fresh out of the oven this morning: our new hazelnut and fig loaf! It will be on the shelves every Saturday from now on. Thanks to everyone who came to the tasting last week",
    }),
  },
  {
    label: "meme page post",
    ad: false,
    state: post({
      header: "Monday Mood Memes",
      text: "Me: I'll just check one email before bed. Also me at 2 am: reorganising my entire inbox by colour",
    }),
  },
  {
    label: "French ad (Sponsorisé, CTA)",
    ad: true,
    state: post({
      header: "Maison Verdelle",
      text: "Soldes d'hiver : jusqu'à -50 % sur toute la literie. Livraison offerte dès 49 €. Matelas Confort Plus, 299 € au lieu de 599 €",
      links: ["maison-verdelle.fr"],
      hasCallToActionButton: true,
      ctaText: "Acheter",
      hasAdLabel: true,
      language: "fr",
    }),
  },
  {
    label: "Arabic organic news post",
    ad: false,
    state: post({
      header: "أخبار المدينة",
      text: "افتتاح المكتبة العامة الجديدة في وسط المدينة يوم السبت، مع قاعة مطالعة للأطفال وساعات عمل أطول خلال العطلة.",
      links: ["madina-news.com"],
      language: "ar",
    }),
  },
];

const states = POSTS.map((p, i) => {
  const s = sanitize(p.state);
  if (s === null) throw new Error(`post ${i + 1} (${p.label}) is not a valid FBAHPostState`);
  return JSON.parse(JSON.stringify(s)); // plain object of this realm
});

// ---------- calls ----------

// One HTTP request per call (no retry), so the number of requests is the number announced above.
const client = { apiKey: key, maxRetries: 0 };
/** Errors every following call would get too: the script stops instead of sending them. */
const STOP_ON = new Set(["invalid_key", "forbidden", "rate_limited", "overloaded"]);
let requestsSent = 0;

function describeError(e) {
  return `${e.code}${e.status === null ? "" : ` (HTTP ${e.status})`}: ${e.message}`;
}

/** One call; returns, per question id of `request`, the probability or an error string. */
async function ask(request) {
  const started = Date.now();
  requestsSent++;
  const out = await systemOnePartial(client, { state: request.state, questions: request.questions });
  const ms = Date.now() - started;
  if (!out.ok && STOP_ON.has(out.error.code)) {
    const wait = out.error.retryAfterMs === null ? "" : ` (the server asks to wait ${Math.ceil(out.error.retryAfterMs / 1000)} s)`;
    console.error(`\nStopped after ${requestsSent} request(s): ${describeError(out.error)}${wait}.`);
    console.error("The other calls would get the same answer, so they were not sent.");
    process.exit(1);
  }
  if (!out.ok) return { ms, model: null, usage: null, values: request.ids.map(() => `error: ${describeError(out.error)}`) };
  const v = out.value;
  return {
    ms,
    model: v.model,
    usage: v.usage,
    values: request.ids.map((id) => v.answers[id]?.noul ?? `error: ${v.answerErrors[id] ?? "answer is missing"}`),
  };
}

async function runSingle() {
  const values = [];
  let ms = 0;
  let calls = 0;
  const usage = { inputTokens: 0, outputTokens: 0, reported: 0 };
  let model = null;
  for (const s of states) {
    const r = await ask(buildRequest({ single: s }));
    calls++;
    ms += r.ms;
    model ??= r.model;
    values.push(r.values[0]);
    if (r.usage && r.usage.inputTokens !== null) {
      usage.inputTokens += r.usage.inputTokens;
      usage.outputTokens += r.usage.outputTokens ?? 0;
      usage.reported++;
    }
  }
  return { name: "single", calls, ms, model, usage, values };
}

async function runBatch() {
  const r = await ask(buildRequest({ batch: states }));
  const usage = { inputTokens: 0, outputTokens: 0, reported: 0 };
  if (r.usage && r.usage.inputTokens !== null) {
    usage.inputTokens = r.usage.inputTokens;
    usage.outputTokens = r.usage.outputTokens ?? 0;
    usage.reported = 1;
  }
  return { name: "batch", calls: 1, ms: r.ms, model: r.model, usage, values: r.values };
}

// ---------- report ----------

const isCorrect = (v, i, t) => typeof v === "number" && (v >= t) === POSTS[i].ad;
const correctAt = (values, t) => values.filter((v, i) => isCorrect(v, i, t)).length;

/** Thresholds in the options page's range (0.50 … 0.99) with the most correct answers, as ranges. */
function bestThresholds(values) {
  let best = -1;
  let at = [];
  for (let n = THRESHOLD_MIN; n <= THRESHOLD_MAX; n++) {
    const c = correctAt(values, n / 100);
    if (c > best) [best, at] = [c, [n]];
    else if (c === best) at.push(n);
  }
  const ranges = [];
  for (const n of at) {
    const last = ranges.at(-1);
    if (last && last[1] === n - 1) last[1] = n;
    else ranges.push([n, n]);
  }
  const fmt = (n) => (n / 100).toFixed(2);
  return { correct: best, text: ranges.map(([a, b]) => (a === b ? fmt(a) : `${fmt(a)}-${fmt(b)}`)).join(", ") };
}

function report(mode) {
  const n = POSTS.length;
  const plural = mode.calls === 1 ? "call" : "calls";
  console.log(`\nMode "${mode.name}": ${mode.calls} ${plural}${mode.name === "batch" ? `, ${n} posts in it` : ""}, model ${mode.model ?? "(no answer)"}`);
  for (const [i, v] of mode.values.entries()) {
    const expected = POSTS[i].ad ? "ad" : "not ad";
    const ok = isCorrect(v, i, THRESHOLD);
    const p = typeof v === "number" ? `p=${v.toFixed(3)}` : v;
    console.log(`  ${ok ? "✅" : "❌"} ${String(i + 1).padStart(2)}. ${POSTS[i].label.padEnd(46)} expected ${expected.padEnd(6)}  ${p}`);
  }
  const best = bestThresholds(mode.values);
  console.log(`  correct at threshold ${THRESHOLD.toFixed(2)}: ${correctAt(mode.values, THRESHOLD)}/${n}`);
  console.log(`  best threshold(s) in 0.50-0.99: ${best.text} (${best.correct}/${n} correct)`);
  console.log(`  total latency: ${mode.ms} ms${mode.calls > 1 ? ` (sum of ${mode.calls} sequential calls)` : ""}`);
  console.log(
    mode.usage.reported === 0
      ? "  tokens: not reported by the API"
      : `  tokens: ${mode.usage.inputTokens} input, ${mode.usage.outputTokens} output` +
          (mode.usage.reported < mode.calls ? ` (reported for ${mode.usage.reported} of ${mode.calls} calls)` : ""),
  );
}

const single0 = buildRequest({ single: states[0] });
const batch0 = buildRequest({ batch: states });
console.log(`TypeSafe live accuracy check: ${POSTS.length} fictional posts, model alias ${DEFAULTS.model}, threshold ${THRESHOLD}`);
console.log(
  `Prompt versions: single ${single0.version}, batch ${batch0.version}. ` +
    `This makes at most ${POSTS.length + 1} real requests with your key (no retry; stops at an invalid key, a refusal or a rate limit).`,
);

const modes = [await runSingle(), await runBatch()];
for (const mode of modes) report(mode);
const failures = modes.flatMap((m) => m.values).filter((v) => typeof v !== "number").length;
if (failures > 0) console.log(`\n${failures} answer(s) missing because of errors (see above).`);
process.exit(failures > 0 ? 1 : 0);
