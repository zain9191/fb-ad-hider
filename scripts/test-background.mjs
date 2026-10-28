// Tests for the background service worker (dist/background.js) with a mocked
// chrome.* API and a mocked fetch. No dependencies, no network, no real key.
//
//   npm test      (= npm run build && … && node scripts/test-background.mjs)
//
// Each "worker" is a fresh vm context that loads background.js (which itself
// importScripts() shared.js and typesafe.js). Storage areas are shared between
// workers, like chrome.storage is shared between service-worker restarts, while
// in-memory state is not: that is how Chrome stopping an idle worker is simulated.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const FAKE_KEY = "ts-test-FAKE-key-0000000000"; // not a real key
const OTHER_KEY = "ts-test-FAKE-key-1111111111";
const KEY_ENTRY = "fbah.typesafe.apiKey";
const EXT_ID = "fbah-test-extension";
const dist = (name) => new URL(`../dist/${name}`, import.meta.url);

// ---------- shared (persistent) chrome.storage ----------

let stores;
let liveWorkers;
let fetches;
let tabMessages;
let respond; // (n, url, init) => { status, body, headers }

function reset() {
  stores = { sync: new Map(), local: new Map(), session: new Map() };
  liveWorkers = new Set();
  fetches = [];
  tabMessages = [];
  respond = () => ({ status: 500, body: { detail: "no handler" } });
}

function storageArea(name) {
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const fire = (changes) => {
    for (const w of liveWorkers) for (const fn of w.listeners[name]) fn(changes, name);
  };
  return {
    async get(keys) {
      const list = keys == null ? [...stores[name].keys()] : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (stores[name].has(k)) out[k] = clone(stores[name].get(k));
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(stores[name].get(k)), newValue: clone(v) };
        stores[name].set(k, clone(v));
      }
      fire(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (!stores[name].has(k)) continue;
        changes[k] = { oldValue: clone(stores[name].get(k)) };
        stores[name].delete(k);
      }
      fire(changes);
    },
    async setAccessLevel() {},
  };
}

/** What the options page does: write chrome.storage.local directly. */
const optionsPage = { local: null };

// ---------- one service-worker instance ----------

function startWorker() {
  const worker = { listeners: { sync: [], local: [], session: [] }, onMessage: null };
  const area = (name) => ({
    ...storageArea(name),
    onChanged: { addListener: (fn) => worker.listeners[name].push(fn) },
  });
  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      onMessage: { addListener: (fn) => (worker.onMessage = fn) },
    },
    storage: { sync: area("sync"), local: area("local"), session: area("session") },
    tabs: {
      async query(q) {
        assert.equal(q.url, "https://*.facebook.com/*");
        return [{ id: 7, url: "https://www.facebook.com/" }];
      },
      async sendMessage(tabId, msg) {
        tabMessages.push({ tabId, msg: JSON.parse(JSON.stringify(msg)) }); // plain object from this realm
        return { resumed: true };
      },
    },
  };
  const fetch = async (url, init) => {
    fetches.push({ url, init, body: JSON.parse(init.body) });
    const r = respond(fetches.length, url, init);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  };
  const context = vm.createContext({
    chrome,
    fetch,
    crypto: globalThis.crypto,
    AbortController,
    TextEncoder,
    URL,
    console,
    setTimeout,
    clearTimeout,
  });
  context.self = context;
  context.importScripts = (...names) => {
    for (const n of names) vm.runInContext(readFileSync(dist(n), "utf8"), context, { filename: `dist/${n}` });
  };
  vm.runInContext(readFileSync(dist("background.js"), "utf8"), context, { filename: "dist/background.js" });
  assert.equal(typeof worker.onMessage, "function", "background.js must register runtime.onMessage");
  liveWorkers.add(worker);

  worker.send = (msg, sender) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${msg.type}`)), 10_000);
      const async = worker.onMessage(msg, sender, (r) => {
        clearTimeout(timer);
        resolve(JSON.parse(JSON.stringify(r)));
      });
      if (async !== true) setTimeout(() => reject(new Error(`${msg.type}: listener did not answer`)), 50);
    });
  worker.classify = (state) =>
    worker.send(
      { type: "fbah/classify", state },
      { id: EXT_ID, tab: { id: 7 }, url: "https://www.facebook.com/" },
    );
  worker.testKey = () => worker.send({ type: "fbah/testKey" }, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/options.html` });
  /** Chrome stopping the idle worker: memory is gone, storage stays, no more events. */
  worker.stop = () => liveWorkers.delete(worker);
  return worker;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (text, extra = {}) => ({
  text,
  header: "Boulangerie Martin",
  links: ["boulangerie.example"],
  hasCallToActionButton: false,
  language: "fr",
  ...extra,
});
const ok200 = (noul = 0.2) => ({
  status: 200,
  body: { model: "jev-1.13.0", answers: { is_paid_ad: { type: "noul", noul } }, usage: { input_tokens: 300, output_tokens: 20 } },
});
const usageCalls = () => stores.local.get("fbah.ai.usage")?.calls ?? 0;

// ---------- tests ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("rate-limit pause survives Chrome stopping and restarting the worker", async () => {
  respond = () => ({ status: 429, body: { detail: { message: "slow down" } }, headers: { "retry-after": "300" } });
  const w1 = startWorker();
  const first = await w1.classify(post("Pain au levain tout frais ce matin"));
  assert.equal(first.ok, false);
  assert.equal(first.error, "rate_limited");
  assert.ok(first.retryAfterMs > 299_000 && first.retryAfterMs <= 300_000, `retryAfterMs ${first.retryAfterMs}`);
  assert.equal(fetches.length, 1, "Retry-After above 20 s: no retry inside the call");

  const again = await w1.classify(post("Another post, same worker"));
  assert.equal(again.error, "rate_limited");
  assert.equal(fetches.length, 1);

  w1.stop();
  const w2 = startWorker(); // new worker: empty memory, same chrome.storage
  const afterRestart = await w2.classify(post("A third post after the restart"));
  assert.equal(afterRestart.ok, false);
  assert.equal(afterRestart.error, "rate_limited");
  assert.ok(afterRestart.retryAfterMs > 290_000, `remaining pause ${afterRestart.retryAfterMs}`);
  assert.equal(fetches.length, 1, "no API call during the server's Retry-After");
  assert.equal(usageCalls(), 1, "no daily-cap call used during the pause");
});

test("a 429 inside the retry sequence is persisted before the retry wait", async () => {
  respond = (n) =>
    n === 1 ? { status: 429, body: { detail: { message: "slow down" } }, headers: { "retry-after-ms": "600" } } : ok200(0.1);
  const w1 = startWorker();
  const pending = w1.classify(post("Slow post in a retry sequence"));
  while (fetches.length < 1) await sleep(5);
  await sleep(30); // the retry wait has started
  const stored = stores.session.get("fbah.ai.pause");
  assert.ok(stored && stored.until > Date.now(), "pause written to chrome.storage.session");
  assert.equal(stored.code, "rate_limited");

  // Chrome stops w1 during the wait (simulated: a second worker starts meanwhile).
  const w2 = startWorker();
  const blocked = await w2.classify(post("Other post while the first one waits"));
  assert.equal(blocked.error, "rate_limited");
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 600);
  assert.equal(fetches.length, 1);

  const done = await pending; // w1 finishes its retry
  assert.equal(done.ok, true);
  assert.equal(fetches.length, 2);
});

test("saving a new key clears the pause and tells Facebook tabs to resume", async () => {
  respond = () => ({ status: 429, body: { detail: { message: "slow down" } }, headers: { "retry-after": "120" } });
  const w = startWorker();
  assert.equal((await w.classify(post("First"))).error, "rate_limited");
  assert.equal(tabMessages.length, 0);

  await optionsPage.local.set({ [KEY_ENTRY]: OTHER_KEY });
  for (let i = 0; i < 20 && tabMessages.length === 0; i++) await sleep(5);
  assert.deepEqual(tabMessages, [{ tabId: 7, msg: { type: "fbah/aiResume" } }]);
  assert.equal(stores.session.get("fbah.ai.pause").until, 0);

  respond = () => ok200(0.9);
  const res = await w.classify(post("Second"));
  assert.equal(res.ok, true);
  assert.equal(fetches.at(-1).init.headers.Authorization, `Bearer ${OTHER_KEY}`);
});

test("no key: no_key without any API call, and no pause is invented", async () => {
  stores.local.delete(KEY_ENTRY);
  const w = startWorker();
  const res = await w.classify(post("Anything"));
  assert.equal(res.error, "no_key");
  assert.equal(res.retryAfterMs, undefined);
  assert.equal(fetches.length, 0);
});

test("successful Test key clears a pause and notifies the tabs", async () => {
  stores.session.set("fbah.ai.pause", { until: Date.now() + 60_000, code: "overloaded" });
  const w = startWorker();
  assert.equal((await w.classify(post("Paused"))).error, "overloaded");
  respond = () => ({ status: 200, body: { model: "jev-1.13.0", answers: { ping: { type: "noul", noul: 1 } }, usage: {} } });
  const t = await w.testKey();
  assert.equal(t.ok, true);
  for (let i = 0; i < 20 && tabMessages.length === 0; i++) await sleep(5);
  assert.equal(tabMessages.length, 1);
  respond = () => ok200(0.3);
  assert.equal((await w.classify(post("Not paused any more"))).ok, true);
});

test("cache: counters, a longer 'See more' text and a new worker reuse one answer", async () => {
  respond = () => ok200(0.12);
  const start = "Nous sommes ouverts ce dimanche de 7 h à 13 h. ".repeat(6); // > 200 characters
  const w1 = startWorker();
  const a = await w1.classify(post(`${start.slice(0, 240)}…`));
  assert.equal(a.ok, true);
  assert.equal(a.cached, false);

  const expanded = await w1.classify(post(`${start} Venez goûter la nouvelle brioche !`));
  assert.equal(expanded.cached, true, "expanded text shares the cached answer");

  w1.stop();
  const w2 = startWorker(); // memory cache gone; chrome.storage.session keeps it
  const reload = await w2.classify(post(`${start.slice(0, 240)}…`));
  assert.equal(reload.cached, true);
  assert.equal(fetches.length, 1);

  const other = await w2.classify(post("Un tout autre message de la boulangerie"));
  assert.equal(other.cached, false);
  assert.equal(fetches.length, 2);
});

test("daily cap: cap_reached with the time until local midnight, no API call", async () => {
  stores.sync.set("fbah.settings", { aiDailyCap: 1 });
  respond = () => ok200();
  const w = startWorker();
  assert.equal((await w.classify(post("First post of the day"))).ok, true);
  const capped = await w.classify(post("Second post of the day"));
  assert.equal(capped.error, "cap_reached");
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  assert.ok(Math.abs(capped.retryAfterMs - (midnight - now.getTime())) < 5_000, `retryAfterMs ${capped.retryAfterMs}`);
  assert.equal(fetches.length, 1);
});

test("request: the prompt describes `header` as the author's name only", async () => {
  respond = () => ok200();
  const w = startWorker();
  await w.classify(post("Hello"));
  const q = fetches[0].body.questions.is_paid_ad;
  assert.match(q.instructions, /`header` \(the name of the post's author only\)/);
  assert.doesNotMatch(q.instructions, /meta line/);
  assert.deepEqual(fetches[0].body.state, post("Hello"));
});

// ---------- runner ----------

let failed = 0;
for (const { name, fn } of tests) {
  reset();
  stores.local.set(KEY_ENTRY, FAKE_KEY);
  optionsPage.local = storageArea("local");
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n  ${String(e?.stack ?? e).split("\n").join("\n  ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
