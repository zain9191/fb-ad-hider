// Tests for the TypeSafe client (dist/typesafe.js) against a local mock of
// POST /v1/systemone and GET /v1/models. No dependencies, no network access, no real API key.
//
//   npm test      (= npm run build && node scripts/test-typesafe.mjs)
//
// The compiled classic script is evaluated in a fresh vm context that only
// contains web-platform globals (fetch, AbortController, timers): this also
// proves the client does not depend on any chrome.* API.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import vm from "node:vm";

const FAKE_KEY = "ts-test-FAKE-key-0000000000"; // not a real key
const clientPath = new URL("../dist/typesafe.js", import.meta.url);

const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, console, URL, TextEncoder });
vm.runInContext(readFileSync(clientPath, "utf8"), context, { filename: "dist/typesafe.js" });
const systemOne = vm.runInContext("typesafeSystemOne", context);
const systemOnePartial = vm.runInContext("typesafeSystemOnePartial", context);
const listModels = vm.runInContext("typesafeListModels", context);
const DEFAULTS = vm.runInContext("TYPESAFE_DEFAULTS", context);
assert.equal(typeof systemOne, "function", "dist/typesafe.js must define typesafeSystemOne");
assert.equal(typeof systemOnePartial, "function", "dist/typesafe.js must define typesafeSystemOnePartial");
assert.equal(typeof listModels, "function", "dist/typesafe.js must define typesafeListModels");

// ---------- mock server ----------

let requests = [];
let handler = () => {
  throw new Error("no handler");
};
const hung = new Set();

const server = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const record = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(record);
    handler(res, record, requests.length);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

function reply(res, status, payload, headers = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
}

function hang(res) {
  hung.add(res); // never answered; destroyed at the end
}

const ok200 = (noul = 0.93) => ({
  model: "jev-1.13.0",
  answers: { is_paid_ad: { type: "noul", noul } },
  usage: { input_tokens: 296, output_tokens: 20 },
});

const QUESTIONS = {
  is_paid_ad: {
    type: "noul",
    instructions: "Is this Facebook feed item a paid advertisement or sponsored post?",
    criteria: { true: "A paid placement", false: "Organic content" },
  },
};

// Same shape as FBAHPostState (the content script's post summary), sent unchanged as `state`.
const STATE = {
  text: "Summer sale: 40% off all sneakers.",
  header: "Sneaker Shop",
  links: ["sneakers.example"],
  hasCallToActionButton: true,
  ctaText: "Shop now",
  hasAdLabel: true,
  language: "en",
};

const fast = { apiKey: FAKE_KEY, baseUrl, backoffInitialMs: 5, backoffMaxMs: 20, random: () => 0.5 };
const call = (opts = {}, request = { state: STATE, questions: QUESTIONS }) => systemOne({ ...fast, ...opts }, request);

// ---------- tests ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("defaults: api.typesafe.ai root, jev-latest", () => {
  assert.equal(DEFAULTS.baseUrl, "https://api.typesafe.ai");
  assert.equal(DEFAULTS.model, "jev-latest");
  assert.equal(DEFAULTS.maxRetries, 3);
});

test("sends the documented request shape and headers; parses a noul answer", async () => {
  handler = (res) => reply(res, 200, ok200(0.93), { "x-typesafe-request-id": "req_test_1" });
  const out = await call();

  assert.equal(requests.length, 1);
  const [r] = requests;
  assert.equal(r.method, "POST");
  assert.equal(r.url, "/v1/systemone");
  assert.equal(r.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.match(r.headers["content-type"], /^application\/json/);
  assert.equal(r.headers.accept, "application/json");
  assert.equal(r.headers.cookie, undefined);
  const body = JSON.parse(r.body);
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(body.state, STATE);
  assert.deepEqual(body.questions, QUESTIONS);

  assert.equal(out.ok, true);
  assert.equal(out.value.answers.is_paid_ad.type, "noul");
  assert.equal(out.value.answers.is_paid_ad.noul, 0.93);
  assert.equal(out.value.model, "jev-1.13.0");
  assert.equal(out.value.usage.inputTokens, 296);
  assert.equal(out.value.usage.outputTokens, 20);
  assert.equal(out.value.requestId, "req_test_1");
  assert.equal(out.value.attempts, 1);
});

test("trailing slash in baseUrl still targets /v1/systemone", async () => {
  handler = (res) => reply(res, 200, ok200());
  const out = await call({ baseUrl: `${baseUrl}/` });
  assert.equal(out.ok, true);
  assert.equal(requests[0].url, "/v1/systemone");
});

test("429 then 200: retried (honouring retry-after-ms) and succeeds", async () => {
  handler = (res, _r, n) =>
    n === 1
      ? reply(res, 429, { detail: { message: "Too many requests" } }, { "retry-after-ms": "40" })
      : reply(res, 200, ok200(0.2));
  const t0 = Date.now();
  const out = await call();
  assert.equal(out.ok, true);
  assert.equal(out.value.answers.is_paid_ad.noul, 0.2);
  assert.equal(out.value.attempts, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body, requests[0].body, "retry must resend the same body");
  assert.ok(Date.now() - t0 >= 35, "waited for retry-after-ms");
});

test("onRetry: called before each retry wait with the code and the delay actually used", async () => {
  handler = (res, _r, n) =>
    n === 1
      ? reply(res, 429, { detail: { message: "Too many requests" } }, { "retry-after-ms": "30" })
      : n === 2
        ? reply(res, 529, { detail: "Overloaded" })
        : reply(res, 200, ok200());
  const seen = [];
  const out = await call({
    onRetry: (info) => {
      seen.push({ ...info });
      throw new Error("observer errors must not break the request");
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.value.attempts, 3);
  assert.deepEqual(seen[0], { attempt: 1, delayMs: 30, code: "rate_limited", status: 429, retryAfterMs: 30 });
  assert.equal(seen[1].attempt, 2);
  assert.equal(seen[1].code, "overloaded");
  assert.equal(seen[1].status, 529);
  assert.equal(seen[1].retryAfterMs, null);
  assert.equal(seen.length, 2, "no call after the successful attempt");
});

test("529 overloaded then 200: retried and succeeds", async () => {
  handler = (res, _r, n) => (n === 1 ? reply(res, 529, { detail: "Overloaded" }) : reply(res, 200, ok200()));
  const out = await call();
  assert.equal(out.ok, true);
  assert.equal(out.value.attempts, 2);
});

test("persistent 429: rate_limited after maxRetries, Retry-After reported", async () => {
  handler = (res) => reply(res, 429, { detail: { message: "slow down" } }, { "retry-after": "0" });
  const out = await call({ maxRetries: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "rate_limited");
  assert.equal(out.error.status, 429);
  assert.equal(out.error.attempts, 3);
  assert.equal(out.error.retryAfterMs, 0);
  assert.equal(requests.length, 3);
});

test("Retry-After above maxRetryAfterMs: no retry, delay reported to the caller", async () => {
  handler = (res) => reply(res, 429, { detail: { message: "slow down" } }, { "retry-after": "120" });
  const out = await call();
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "rate_limited");
  assert.equal(out.error.attempts, 1);
  assert.equal(out.error.retryAfterMs, 120_000);
  assert.equal(requests.length, 1);
});

test("401: invalid_key, no retry, server message kept, key never echoed", async () => {
  handler = (res) =>
    reply(res, 401, {
      detail: {
        error_type: "authentication_error",
        message: `Cannot authenticate with the server. Please check your API key and try again. (${FAKE_KEY})`,
      },
    });
  const out = await call();
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid_key");
  assert.equal(out.error.status, 401);
  assert.equal(out.error.attempts, 1);
  assert.equal(requests.length, 1);
  assert.match(out.error.message, /Cannot authenticate/);
  assert.ok(!out.error.message.includes(FAKE_KEY), "API key must be redacted from messages");
});

test("403 authentication_error (missing key, as seen live): invalid_key, no retry", async () => {
  handler = (res) =>
    reply(res, 403, { detail: { error_type: "authentication_error", message: "Must supply an API key!" } });
  const out = await call();
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid_key");
  assert.equal(requests.length, 1);
});

test("422: validation error with field path from detail[]", async () => {
  handler = (res) =>
    reply(res, 422, {
      detail: [{ loc: ["body", "questions", "is_paid_ad", "criteria"], msg: "Field required", type: "missing" }],
    });
  const out = await call();
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "validation");
  assert.equal(out.error.message, "questions.is_paid_ad.criteria: Field required");
  assert.equal(out.error.attempts, 1);
});

test("malformed JSON on 200: bad_response, no retry", async () => {
  handler = (res) => reply(res, 200, '{"model": "jev-1.13.0", "answers": {');
  const out = await call();
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "bad_response");
  assert.match(out.error.message, /not valid JSON/);
  assert.equal(out.error.attempts, 1);
  assert.equal(requests.length, 1);
});

test("200 with the wrong shape: bad_response (runtime validation, no blind casts)", async () => {
  const bodies = [
    { model: "jev-1.13.0", usage: {} }, // no answers
    { model: "jev-1.13.0", answers: {} }, // requested answer missing
    { model: "jev-1.13.0", answers: { is_paid_ad: { type: "noul", noul: "high" } } },
    { model: "jev-1.13.0", answers: { is_paid_ad: { type: "noul", noul: 7 } } }, // not a probability
    { model: "jev-1.13.0", answers: { is_paid_ad: { type: "choice", choice: "yes" } } }, // wrong kind
    [1, 2, 3],
  ];
  for (const payload of bodies) {
    handler = (res) => reply(res, 200, payload);
    const out = await call();
    assert.equal(out.ok, false, JSON.stringify(payload));
    assert.equal(out.error.code, "bad_response", JSON.stringify(payload));
  }
});

test("tolerant parsing: numeric strings, missing type/usage, extra fields; choice + score answers", async () => {
  handler = (res) =>
    reply(res, 200, {
      id: "gen-123",
      provider: "TypeSafe",
      model: "jev-1.13.0",
      answers: {
        is_paid_ad: { noul: "0.5" },
        kind: { type: "choice", choice: "shop", probabilities: { shop: 0.9, app: 0.1, bogus: "x" }, confidence: 0.8 },
        pushiness: {
          type: "score",
          score: 1.05,
          legend: { 0: "Calm", 1: "Pushy", 2: "Aggressive" },
          probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
          confidence: 0.92,
        },
        unrequested: { type: "future_kind" },
      },
    });
  const out = await call(
    {},
    {
      state: "Buy now!",
      questions: {
        ...QUESTIONS,
        kind: { type: "choice", instructions: "What is promoted?", criteria: { shop: null, app: null } },
        pushiness: { type: "score", instructions: "How pushy?", criteria: ["Calm", "Pushy", "Aggressive"] },
      },
    },
  );
  assert.equal(out.ok, true);
  const a = out.value.answers;
  assert.deepEqual({ ...a.is_paid_ad }, { type: "noul", noul: 0.5 });
  assert.equal(a.kind.choice, "shop");
  assert.equal(a.kind.confidence, 0.8);
  assert.deepEqual({ ...a.kind.probabilities }, { shop: 0.9, app: 0.1 });
  assert.equal(a.pushiness.score, 1.05);
  assert.equal(a.pushiness.probabilities["1"], 0.95);
  assert.equal(a.pushiness.legend["2"], "Aggressive");
  assert.equal(out.value.usage.inputTokens, null);
});

test("timeout: hung requests are aborted after timeoutMs and retried", async () => {
  handler = (res, _r, n) => {
    if (n === 1) return hang(res); // no headers at all
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"model":"jev-1.13.0",'); // headers + partial body, then nothing
    hang(res);
  };
  const t0 = Date.now();
  const out = await call({ timeoutMs: 150, maxRetries: 1 });
  const elapsed = Date.now() - t0;
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "timeout");
  assert.equal(out.error.status, null);
  assert.equal(out.error.attempts, 2);
  assert.equal(requests.length, 2);
  assert.ok(elapsed >= 290 && elapsed < 2000, `elapsed ${elapsed} ms`);
});

test("network error: retried, then reported as network", async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const deadUrl = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));
  const out = await call({ baseUrl: deadUrl, maxRetries: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "network");
  assert.equal(out.error.attempts, 2);
});

test("no key: invalid_key without sending anything", async () => {
  handler = (res) => reply(res, 200, ok200());
  const out = await call({ apiKey: "   " });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid_key");
  assert.equal(out.error.attempts, 0);
  assert.equal(requests.length, 0);
});

// ---------- partial answers (several questions in one call) ----------

test("partial answers: a missing or malformed answer drops only that answer", async () => {
  handler = (res) =>
    reply(res, 200, {
      model: "jev-1.13.0",
      answers: { q0: { type: "noul", noul: 0.9 }, q2: { type: "noul", noul: 3 } },
      usage: { input_tokens: 1200, output_tokens: 30 },
    });
  const noul = (instructions) => ({ type: "noul", instructions });
  const out = await systemOnePartial(fast, { state: { posts: [STATE, STATE, STATE] }, questions: { q0: noul("0?"), q1: noul("1?"), q2: noul("2?") } });
  assert.equal(out.ok, true);
  assert.deepEqual({ ...out.value.answers.q0 }, { type: "noul", noul: 0.9 });
  assert.equal(out.value.answers.q1, undefined);
  assert.equal(out.value.answers.q2, undefined);
  assert.equal(out.value.answerErrors.q1, "answer is missing");
  assert.match(out.value.answerErrors.q2, /not a probability/);
  assert.equal(out.value.answerErrors.q0, undefined);
  assert.equal(out.value.usage.inputTokens, 1200);
  assert.deepEqual(JSON.parse(requests[0].body).state, { posts: [STATE, STATE, STATE] });

  for (const payload of [{ model: "jev-1.13.0" }, "not json", [1]]) {
    handler = (res) => reply(res, 200, payload);
    const whole = await systemOnePartial(fast, { state: "x", questions: { q0: noul("0?") } });
    assert.equal(whole.ok, false, JSON.stringify(payload));
    assert.equal(whole.error.code, "bad_response", "no answers object at all: the whole call is bad_response");
  }
});

// ---------- GET /v1/models ----------

test("models list: GET /v1/models with the key and no body; parses an array, { models: [...] } and { data: [...] }", async () => {
  const variants = [
    [["jev-latest", "jev-1.13.0"], ["jev-latest", "jev-1.13.0"]],
    [{ models: [{ id: "jev-latest" }, { name: "jev-1.13.0" }, 42, { other: true }, " "] }, ["jev-latest", "jev-1.13.0"]],
    [{ object: "list", data: [{ id: "jev-1.13.0", object: "model" }, "jev-1.13.0"] }, ["jev-1.13.0"]],
    [{ data: [] }, []],
  ];
  for (const [payload, expected] of variants) {
    requests = [];
    handler = (res) => reply(res, 200, payload, { "x-typesafe-request-id": "req_models" });
    const out = await listModels(fast);
    assert.equal(out.ok, true, JSON.stringify(payload));
    assert.deepEqual([...out.value.models], expected, JSON.stringify(payload));
    assert.equal(out.value.requestId, "req_models");
    assert.equal(out.value.attempts, 1);
    assert.equal(requests.length, 1);
    const [r] = requests;
    assert.equal(r.method, "GET");
    assert.equal(r.url, "/v1/models");
    assert.equal(r.headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(r.headers.accept, "application/json");
    assert.equal(r.headers["content-type"], undefined);
    assert.equal(r.headers.cookie, undefined);
    assert.equal(r.body, "");
  }
});

test("models list: a 200 that is not a models list → bad_response (not the fallback signal)", async () => {
  for (const payload of [{ model: "jev-1.13.0", answers: {} }, "<html>hi</html>", { models: "jev-latest" }]) {
    requests = [];
    handler = (res) => reply(res, 200, payload);
    const out = await listModels(fast);
    assert.equal(out.ok, false, JSON.stringify(payload));
    assert.equal(out.error.code, "bad_response");
    assert.equal(out.unsupported, false);
    assert.equal(requests.length, 1, "not retried");
  }
});

test("models list: 401 → invalid_key, no retry, key never echoed; 403 authentication_error → invalid_key", async () => {
  handler = (res) =>
    reply(res, 401, { detail: { error_type: "authentication_error", message: `Bad key ${FAKE_KEY}` } });
  const out = await listModels(fast);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid_key");
  assert.equal(out.error.status, 401);
  assert.equal(out.unsupported, false);
  assert.equal(requests.length, 1);
  assert.ok(!out.error.message.includes(FAKE_KEY), "API key must be redacted from messages");

  requests = [];
  handler = (res) => reply(res, 403, { detail: { error_type: "authentication_error", message: "Must supply an API key!" } });
  const forbidden = await listModels(fast);
  assert.equal(forbidden.error.code, "invalid_key");
  assert.equal(forbidden.unsupported, false);
  assert.equal(requests.length, 1);
});

test("models list: 404 / 405 → unsupported (the fallback signal), not retried; 5xx is retried and is not the signal", async () => {
  for (const status of [404, 405]) {
    requests = [];
    handler = (res) => reply(res, status, { detail: "Not Found" });
    const out = await listModels(fast);
    assert.equal(out.ok, false);
    assert.equal(out.unsupported, true, String(status));
    assert.equal(out.error.status, status);
    assert.equal(requests.length, 1, "not retried");
  }
  requests = [];
  handler = (res) => reply(res, 500, { detail: "boom" });
  const server = await listModels({ ...fast, maxRetries: 1 });
  assert.equal(server.ok, false);
  assert.equal(server.error.code, "server");
  assert.equal(server.unsupported, false);
  assert.equal(requests.length, 2, "retried like any call");
});

test("models list: timeout and no key behave like the other calls", async () => {
  handler = (res) => hang(res);
  const out = await listModels({ ...fast, timeoutMs: 100, maxRetries: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "timeout");
  assert.equal(out.unsupported, false);
  requests = [];
  const none = await listModels({ ...fast, apiKey: "  " });
  assert.equal(none.error.code, "invalid_key");
  assert.equal(none.error.attempts, 0);
  assert.equal(requests.length, 0);
});

// ---------- runner ----------

let failed = 0;
for (const { name, fn } of tests) {
  requests = [];
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n  ${String(e?.stack ?? e).split("\n").join("\n  ")}`);
  }
}
for (const res of hung) res.destroy();
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
