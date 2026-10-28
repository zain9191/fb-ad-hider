// Minimal typed client for the TypeSafe AI "System One" HTTP API (Jev models).
//
//   POST {baseUrl}/v1/systemone
//   Authorization: Bearer <API key>
//   { "state": ..., "model": "jev-latest", "questions": { "<id>": { "type": "noul", ... } } }
//
//   GET {baseUrl}/v1/models          (models list, as in the official JS SDK's models resource)
//   Authorization: Bearer <API key>
//
// Wire format from docs.typesafe.ai/api, https://api.typesafe.ai/openapi.json
// (v0.2.0) and the official SDKs (typesafe-sdk-js v0.6.0, typesafe-sdk-python v0.7.2).
// The models list's response shape is not documented: it is parsed tolerantly (an array, or an
// object with a "models" or "data" array), and whether it costs tokens is not documented either.
//
// Classic script: no import/export and NO chrome.* APIs, so the same file runs
// in the extension service worker (importScripts) and in Node for the tests
// (scripts/test-typesafe.mjs). It only uses fetch, AbortController,
// setTimeout/clearTimeout and JSON. Globals are prefixed `TypeSafe` / `typesafe`.
//
// The API key is only ever placed in the Authorization header. It is never
// logged and never included in error messages.

// ---------- request types ----------

type TypeSafeJson = string | number | boolean | null | TypeSafeJson[] | { [key: string]: TypeSafeJson };

/** Instructions and criteria entries: plain text, or structured JSON (object / array). */
type TypeSafeEntry = string | { [key: string]: TypeSafeJson } | TypeSafeJson[] | null;

/** The content to evaluate. Text only; the API does not accept null. */
type TypeSafeState = string | { [key: string]: TypeSafeJson } | TypeSafeJson[];

/** Yes/no question. Answer: probability of "yes" (0..1). Phrase it so that a high value means yes. */
interface TypeSafeNoulQuestion {
  type: "noul";
  instructions: TypeSafeEntry;
  /** What a yes (near 1) and a no (near 0) mean. Optional. */
  criteria?: { true?: TypeSafeEntry; false?: TypeSafeEntry } | null;
}

/** Pick one option. `criteria` maps option label → description (or null). Up to 255 options. */
interface TypeSafeChoiceQuestion {
  type: "choice";
  instructions: TypeSafeEntry;
  criteria: { [label: string]: TypeSafeEntry };
}

/** Ordered scale. `criteria[i]` describes level i. 2..10 levels. */
interface TypeSafeScoreQuestion {
  type: "score";
  instructions: TypeSafeEntry;
  criteria: readonly [
    NonNullable<TypeSafeEntry>,
    NonNullable<TypeSafeEntry>,
    ...NonNullable<TypeSafeEntry>[],
  ];
}

type TypeSafeQuestion = TypeSafeNoulQuestion | TypeSafeChoiceQuestion | TypeSafeScoreQuestion;

/** Question id → question. The id is yours; answers come back under the same id. */
type TypeSafeQuestions = { [id: string]: TypeSafeQuestion };

interface TypeSafeRequest<Q extends TypeSafeQuestions> {
  state: TypeSafeState;
  questions: Q;
  /** Defaults to the client's model ("jev-latest"). */
  model?: string;
}

// ---------- answer types ----------

interface TypeSafeNoulAnswer {
  type: "noul";
  /** Probability of "yes", 0..1. Noul answers carry no separate confidence. */
  noul: number;
}

interface TypeSafeChoiceAnswer {
  type: "choice";
  /** Highest-probability option. */
  choice: string;
  /** 0..1, null if the server omitted it. */
  confidence: number | null;
  probabilities: { [label: string]: number };
}

interface TypeSafeScoreAnswer {
  type: "score";
  /** Probability-weighted mean of the level indices (can fall between levels). */
  score: number;
  confidence: number | null;
  /** "0".."n-1" → the level description that was sent. */
  legend: { [level: string]: TypeSafeJson };
  probabilities: { [level: string]: number };
}

type TypeSafeAnswer = TypeSafeNoulAnswer | TypeSafeChoiceAnswer | TypeSafeScoreAnswer;

interface TypeSafeAnswerByType {
  noul: TypeSafeNoulAnswer;
  choice: TypeSafeChoiceAnswer;
  score: TypeSafeScoreAnswer;
}

type TypeSafeAnswerFor<Q extends TypeSafeQuestion> = TypeSafeAnswerByType[Q["type"]];

interface TypeSafeResult<Q extends TypeSafeQuestions> {
  /** Concrete model version (e.g. "jev-1.13.0"); may differ from the alias sent. */
  model: string;
  answers: { [K in keyof Q]: TypeSafeAnswerFor<Q[K]> };
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** `x-typesafe-request-id` response header. */
  requestId: string | null;
  /** HTTP attempts made (1 = no retry). */
  attempts: number;
}

/**
 * Result of typesafeSystemOnePartial: like TypeSafeResult, but a missing or malformed answer only
 * drops that answer (listed in `answerErrors`) instead of failing the whole call. Useful when one
 * call carries many independent questions (one per item of the state).
 */
interface TypeSafePartialResult<Q extends TypeSafeQuestions> {
  model: string;
  /** The well-formed answers; a question whose answer is missing or malformed has no entry. */
  answers: { [K in keyof Q]?: TypeSafeAnswerFor<Q[K]> };
  /** Question id → why its answer was dropped. Empty when every answer is present and valid. */
  answerErrors: { [K in keyof Q]?: string };
  usage: TypeSafeResult<Q>["usage"];
  requestId: string | null;
  attempts: number;
}

/** GET /v1/models. */
interface TypeSafeModelList {
  /** Model ids in the server's order: string items, or the `id` (else `name`) of object items. */
  models: string[];
  requestId: string | null;
  attempts: number;
}

// ---------- errors ----------

type TypeSafeErrorCode =
  | "invalid_key" //  401 (or 403 authentication_error): missing / invalid API key
  | "forbidden" //    other 403
  | "validation" //   400 / 422: malformed request
  | "rate_limited" // 429
  | "overloaded" //   529 / 503
  | "server" //       other 5xx
  | "timeout" //      no complete response within timeoutMs (or 408)
  | "network" //      DNS / TLS / connection failure
  | "bad_response" // 2xx whose body is not the documented JSON shape
  | "unknown"; //     anything else

interface TypeSafeError {
  code: TypeSafeErrorCode;
  /** HTTP status, or null when no response was received. */
  status: number | null;
  /** Human-readable; never contains the API key. */
  message: string;
  attempts: number;
  /** Server-requested delay (Retry-After / retry-after-ms), if any. */
  retryAfterMs: number | null;
  requestId: string | null;
}

type TypeSafeOutcome<T> = { ok: true; value: T } | { ok: false; error: TypeSafeError };

type TypeSafeModelsOutcome =
  | { ok: true; value: TypeSafeModelList }
  | {
      ok: false;
      error: TypeSafeError;
      /**
       * HTTP 404 / 405: there is no models list at this API root. The caller can check the key
       * another way (e.g. a tiny POST /v1/systemone).
       */
      unsupported: boolean;
    };

/** Passed to `onRetry` before the client waits for the next attempt. */
interface TypeSafeRetryInfo {
  /** The attempt that just failed (1 = the first request). */
  attempt: number;
  code: TypeSafeErrorCode;
  /** HTTP status, or null for a timeout / network error. */
  status: number | null;
  /** How long the client waits before the next attempt (the server's Retry-After when it sent one). */
  delayMs: number;
  /** Server-requested delay (Retry-After / retry-after-ms), if any. */
  retryAfterMs: number | null;
}

// ---------- client options ----------

interface TypeSafeClientOptions {
  apiKey: string;
  /** API root; "/v1/systemone" (or "/v1/models") is appended. Default https://api.typesafe.ai */
  baseUrl?: string;
  /** Default "jev-latest". */
  model?: string;
  /** Per attempt, including reading the body. Default 15000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** Fraction (0..1) randomly subtracted from each backoff delay. */
  backoffJitter?: number;
  /** A longer Retry-After ends the retries and is reported in `retryAfterMs`. */
  maxRetryAfterMs?: number;
  /**
   * Called synchronously before each retry wait, e.g. to persist a server-requested
   * pause before a long wait. Exceptions thrown by it are ignored.
   */
  onRetry?: (info: TypeSafeRetryInfo) => void;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
}

const TYPESAFE_DEFAULTS = Object.freeze({
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  timeoutMs: 15_000,
  maxRetries: 3,
  backoffInitialMs: 500,
  backoffMaxMs: 8_000,
  backoffJitter: 0.25,
  maxRetryAfterMs: 20_000,
});

interface TypeSafeResolvedOptions {
  apiKey: string;
  /** API root without a trailing slash. */
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  backoffJitter: number;
  maxRetryAfterMs: number;
  onRetry: (info: TypeSafeRetryInfo) => void;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  random: () => number;
}

function typesafeFiniteOr(v: number | undefined, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function typesafeResolveOptions(o: TypeSafeClientOptions): TypeSafeResolvedOptions {
  const d = TYPESAFE_DEFAULTS;
  return {
    apiKey: o.apiKey.trim(),
    baseUrl: (o.baseUrl ?? d.baseUrl).replace(/\/+$/, ""),
    model: o.model ?? d.model,
    timeoutMs: typesafeFiniteOr(o.timeoutMs, d.timeoutMs, 1, 120_000),
    maxRetries: Math.floor(typesafeFiniteOr(o.maxRetries, d.maxRetries, 0, 10)),
    backoffInitialMs: typesafeFiniteOr(o.backoffInitialMs, d.backoffInitialMs, 0, 60_000),
    backoffMaxMs: typesafeFiniteOr(o.backoffMaxMs, d.backoffMaxMs, 0, 120_000),
    backoffJitter: typesafeFiniteOr(o.backoffJitter, d.backoffJitter, 0, 1),
    maxRetryAfterMs: typesafeFiniteOr(o.maxRetryAfterMs, d.maxRetryAfterMs, 0, 600_000),
    onRetry: o.onRetry ?? (() => undefined),
    // Wrapped so fetch is never called with a foreign `this` ("Illegal invocation").
    fetch: o.fetch ?? ((input, init) => fetch(input, init)),
    random: o.random ?? Math.random,
  };
}

// ---------- small runtime-validation helpers ----------

function typesafeIsRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typesafeNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A 0..1 value; tolerates tiny rounding overshoot, rejects anything else. */
function typesafeProbability(v: unknown): number | null {
  const n = typesafeNumber(v);
  if (n === null || n < -0.001 || n > 1.001) return null;
  return Math.min(1, Math.max(0, n));
}

function typesafeNumberMap(v: unknown): { [key: string]: number } {
  const out: { [key: string]: number } = {};
  if (!typesafeIsRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    const n = typesafeNumber(raw);
    if (n !== null) out[k] = n;
  }
  return out;
}

/** Values produced by JSON.parse are JSON by construction. */
function typesafeJsonRecord(v: unknown): { [key: string]: TypeSafeJson } {
  return typesafeIsRecord(v) ? (v as { [key: string]: TypeSafeJson }) : {};
}

function typesafeDescribe(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.slice(0, 40));
  return typeof v;
}

// ---------- response parsing ----------

/** Validates one answer against the question type that was asked. Returns an error string on failure. */
function typesafeParseAnswer(raw: unknown, expected: TypeSafeQuestion["type"]): TypeSafeAnswer | string {
  if (!typesafeIsRecord(raw)) return "answer is missing";
  // Tolerate a missing discriminant (the value field still has to be right).
  const type = raw["type"] === undefined ? expected : raw["type"];
  if (type !== expected) return `expected type "${expected}", got ${typesafeDescribe(type)}`;
  switch (expected) {
    case "noul": {
      const p = typesafeProbability(raw["noul"]);
      if (p === null) return `"noul" is not a probability (${typesafeDescribe(raw["noul"])})`;
      return { type: "noul", noul: p };
    }
    case "choice": {
      const choice = raw["choice"];
      if (typeof choice !== "string") return `"choice" is not a string (${typesafeDescribe(choice)})`;
      return {
        type: "choice",
        choice,
        confidence: typesafeProbability(raw["confidence"]),
        probabilities: typesafeNumberMap(raw["probabilities"]),
      };
    }
    case "score": {
      const score = typesafeNumber(raw["score"]);
      if (score === null) return `"score" is not a number (${typesafeDescribe(raw["score"])})`;
      return {
        type: "score",
        score,
        confidence: typesafeProbability(raw["confidence"]),
        legend: typesafeJsonRecord(raw["legend"]),
        probabilities: typesafeNumberMap(raw["probabilities"]),
      };
    }
    default:
      return `unsupported question type ${typesafeDescribe(expected)}`;
  }
}

/** A 2xx body turned into a value, or why it could not be (reported as bad_response). */
type TypeSafeBodyParse<V> = { ok: true; value: V } | { ok: false; message: string };

/** The parts shared by every /v1/systemone response: the JSON object and its "answers" object. */
function typesafeParseEnvelope(
  text: string,
): { ok: true; json: Record<string, unknown>; answers: Record<string, unknown> } | { ok: false; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: "Response body is not valid JSON." };
  }
  if (!typesafeIsRecord(json)) return { ok: false, message: "Response body is not a JSON object." };
  const answers = json["answers"];
  if (!typesafeIsRecord(answers)) return { ok: false, message: 'Response has no "answers" object.' };
  return { ok: true, json, answers };
}

function typesafeModelName(json: Record<string, unknown>): string {
  return typeof json["model"] === "string" ? json["model"] : "unknown";
}

function typesafeUsage(json: Record<string, unknown>): { inputTokens: number | null; outputTokens: number | null } {
  const usage = typesafeIsRecord(json["usage"]) ? json["usage"] : {};
  return { inputTokens: typesafeNumber(usage["input_tokens"]), outputTokens: typesafeNumber(usage["output_tokens"]) };
}

/** Every requested answer must be present and valid, or the whole response is rejected. */
function typesafeParseResponse<Q extends TypeSafeQuestions>(
  text: string,
  questions: Q,
): TypeSafeBodyParse<Pick<TypeSafeResult<Q>, "model" | "answers" | "usage">> {
  const envelope = typesafeParseEnvelope(text);
  if (!envelope.ok) return envelope;
  const answers: { [id: string]: TypeSafeAnswer } = {};
  for (const [id, question] of Object.entries(questions)) {
    const parsed = typesafeParseAnswer(envelope.answers[id], question.type);
    if (typeof parsed === "string") return { ok: false, message: `answers.${id}: ${parsed}.` };
    answers[id] = parsed; // unrequested / unknown answer kinds are ignored
  }
  return {
    ok: true,
    value: {
      model: typesafeModelName(envelope.json),
      // Every requested id was validated against its own question type above.
      answers: answers as TypeSafeResult<Q>["answers"],
      usage: typesafeUsage(envelope.json),
    },
  };
}

/** Like typesafeParseResponse, but a missing or malformed answer only drops that answer. */
function typesafeParsePartialResponse<Q extends TypeSafeQuestions>(
  text: string,
  questions: Q,
): TypeSafeBodyParse<Pick<TypeSafePartialResult<Q>, "model" | "answers" | "answerErrors" | "usage">> {
  const envelope = typesafeParseEnvelope(text);
  if (!envelope.ok) return envelope;
  const answers: { [id: string]: TypeSafeAnswer } = {};
  const answerErrors: { [id: string]: string } = {};
  for (const [id, question] of Object.entries(questions)) {
    const parsed = typesafeParseAnswer(envelope.answers[id], question.type);
    if (typeof parsed === "string") answerErrors[id] = parsed;
    else answers[id] = parsed;
  }
  return {
    ok: true,
    value: {
      model: typesafeModelName(envelope.json),
      // Each id present here was validated against its own question type above.
      answers: answers as TypeSafePartialResult<Q>["answers"],
      answerErrors: answerErrors as TypeSafePartialResult<Q>["answerErrors"],
      usage: typesafeUsage(envelope.json),
    },
  };
}

const TYPESAFE_MAX_MODELS = 200;

/** GET /v1/models, parsed tolerantly: an array, or an object with a "models" or "data" array. */
function typesafeParseModels(text: string): TypeSafeBodyParse<string[]> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: "Response body is not valid JSON." };
  }
  let list: unknown[] | null = null;
  if (Array.isArray(json)) list = json;
  else if (typesafeIsRecord(json)) {
    const models = json["models"];
    const data = json["data"];
    if (Array.isArray(models)) list = models;
    else if (Array.isArray(data)) list = data;
  }
  if (list === null) return { ok: false, message: 'Response is not a models list (an array, or a "models" / "data" array).' };
  const ids: string[] = [];
  for (const item of list) {
    if (ids.length >= TYPESAFE_MAX_MODELS) break;
    let id: unknown = item;
    if (typesafeIsRecord(item)) id = typeof item["id"] === "string" ? item["id"] : item["name"];
    if (typeof id !== "string") continue; // unknown item shape: skipped
    const clean = id.trim().slice(0, 100);
    if (clean !== "" && !ids.includes(clean)) ids.push(clean);
  }
  return { ok: true, value: ids };
}

/** Same precedence as both official SDKs: error, error.message, message, detail, detail.message, detail[]. */
function typesafeExtractErrorMessage(body: unknown): string | null {
  if (!typesafeIsRecord(body)) return null;
  const error = body["error"];
  const message = body["message"];
  const detail = body["detail"];
  if (typeof error === "string") return error;
  if (typesafeIsRecord(error) && typeof error["message"] === "string") return error["message"];
  if (typeof message === "string") return message;
  if (typeof detail === "string") return detail;
  if (typesafeIsRecord(detail) && typeof detail["message"] === "string") return detail["message"];
  if (Array.isArray(detail)) {
    const parts: string[] = [];
    for (const item of detail) {
      if (!typesafeIsRecord(item)) continue;
      const loc = Array.isArray(item["loc"])
        ? item["loc"].filter((p) => p !== "body").map((p) => String(p)).join(".")
        : "";
      const msg = typeof item["msg"] === "string" ? item["msg"] : "invalid";
      parts.push(loc ? `${loc}: ${msg}` : msg);
    }
    if (parts.length > 0) return parts.join("; ");
  }
  return null;
}

function typesafeErrorType(body: unknown): string | null {
  if (!typesafeIsRecord(body)) return null;
  const detail = body["detail"];
  return typesafeIsRecord(detail) && typeof detail["error_type"] === "string" ? detail["error_type"] : null;
}

function typesafeCodeForStatus(status: number, body: unknown): TypeSafeErrorCode {
  if (status === 401) return "invalid_key";
  if (status === 403) return typesafeErrorType(body) === "authentication_error" ? "invalid_key" : "forbidden";
  if (status === 400 || status === 422) return "validation";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 500 && status <= 599) return "server";
  return "unknown";
}

function typesafeIsRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** retry-after-ms (milliseconds) first, then Retry-After (seconds or HTTP date). */
function typesafeRetryAfterMs(headers: { get(name: string): string | null }, now: number): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "") {
    const v = Number(ms);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  const ra = headers.get("retry-after");
  if (ra !== null && ra.trim() !== "") {
    const seconds = Number(ra);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  return null;
}

function typesafeBackoffMs(cfg: TypeSafeResolvedOptions, retryIndex: number): number {
  const exponential = Math.min(cfg.backoffInitialMs * 2 ** retryIndex, cfg.backoffMaxMs);
  return Math.round(exponential * (1 - cfg.random() * cfg.backoffJitter));
}

function typesafeSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clips a server-provided message and removes the key if a server ever echoed it. */
function typesafeSafeMessage(message: string, apiKey: string): string {
  const scrubbed = apiKey ? message.split(apiKey).join("[redacted]") : message;
  return scrubbed.length > 300 ? `${scrubbed.slice(0, 297)}...` : scrubbed;
}

// ---------- transport ----------

type TypeSafeAttempt =
  | { kind: "http"; status: number; headers: { get(name: string): string | null }; text: string }
  | { kind: "timeout" }
  | { kind: "network"; detail: string };

type TypeSafeMethod = "GET" | "POST";

async function typesafeAttempt(
  cfg: TypeSafeResolvedOptions,
  method: TypeSafeMethod,
  path: string,
  body: string | null,
): Promise<TypeSafeAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" };
  if (body !== null) headers["Content-Type"] = "application/json";
  const init: RequestInit = {
    method,
    headers,
    signal: controller.signal,
    credentials: "omit", // never send cookies
    redirect: "error", // never replay the Authorization header elsewhere
  };
  if (body !== null) init.body = body;
  try {
    const response = await cfg.fetch(`${cfg.baseUrl}${path}`, init);
    const text = await response.text(); // still covered by the timeout
    return { kind: "http", status: response.status, headers: response.headers, text };
  } catch (e) {
    if (controller.signal.aborted) return { kind: "timeout" };
    // Errors may come from another realm (tests), so don't rely on instanceof.
    const name = typesafeIsRecord(e) && typeof e["name"] === "string" ? e["name"] : "Error";
    const msg = typesafeIsRecord(e) && typeof e["message"] === "string" ? e["message"].slice(0, 120) : "";
    return { kind: "network", detail: msg ? `${name}: ${msg}` : name };
  } finally {
    clearTimeout(timer);
  }
}

function typesafeFail(
  cfg: TypeSafeResolvedOptions,
  code: TypeSafeErrorCode,
  message: string,
  attempts: number,
  extra: { status?: number; retryAfterMs?: number | null; requestId?: string | null } = {},
): { ok: false; error: TypeSafeError } {
  return {
    ok: false,
    error: {
      code,
      status: extra.status ?? null,
      message: typesafeSafeMessage(message, cfg.apiKey),
      attempts,
      retryAfterMs: extra.retryAfterMs ?? null,
      requestId: extra.requestId ?? null,
    },
  };
}

/** A parsed 2xx answer, with the request id and the number of HTTP attempts made. */
interface TypeSafeReply<V> {
  value: V;
  requestId: string | null;
  attempts: number;
}

/**
 * One API request with the client's retry policy: 408 / 429 / 5xx (incl. 529), timeouts and
 * network errors are retried with exponential backoff + jitter, honouring Retry-After. A 2xx body
 * goes through `parse` (failure → bad_response, not retried). Never throws for API or network
 * failures: returns a typed outcome.
 */
async function typesafeRequest<V>(
  cfg: TypeSafeResolvedOptions,
  method: TypeSafeMethod,
  path: string,
  body: string | null,
  parse: (text: string) => TypeSafeBodyParse<V>,
): Promise<TypeSafeOutcome<TypeSafeReply<V>>> {
  for (let attempt = 1; ; attempt++) {
    const result = await typesafeAttempt(cfg, method, path, body);
    const canRetry = attempt <= cfg.maxRetries;
    let delayMs = typesafeBackoffMs(cfg, attempt - 1);
    let retry: Omit<TypeSafeRetryInfo, "attempt" | "delayMs">;

    if (result.kind === "timeout") {
      if (!canRetry) return typesafeFail(cfg, "timeout", `No response within ${cfg.timeoutMs} ms.`, attempt);
      retry = { code: "timeout", status: null, retryAfterMs: null };
    } else if (result.kind === "network") {
      if (!canRetry) return typesafeFail(cfg, "network", `Could not reach TypeSafe (${result.detail}).`, attempt);
      retry = { code: "network", status: null, retryAfterMs: null };
    } else {
      const requestId = result.headers.get("x-typesafe-request-id");
      if (result.status >= 200 && result.status < 300) {
        const parsed = parse(result.text);
        if (!parsed.ok) {
          return typesafeFail(cfg, "bad_response", parsed.message, attempt, { status: result.status, requestId });
        }
        return { ok: true, value: { value: parsed.value, requestId, attempts: attempt } };
      }

      let errorBody: unknown = null;
      try {
        errorBody = JSON.parse(result.text);
      } catch {
        errorBody = null;
      }
      const code = typesafeCodeForStatus(result.status, errorBody);
      const message = typesafeExtractErrorMessage(errorBody) ?? `HTTP ${result.status}`;
      const retryAfterMs = typesafeRetryAfterMs(result.headers, Date.now());
      const extra = { status: result.status, retryAfterMs, requestId };

      if (!typesafeIsRetryableStatus(result.status) || !canRetry) return typesafeFail(cfg, code, message, attempt, extra);
      if (retryAfterMs !== null) {
        if (retryAfterMs > cfg.maxRetryAfterMs) return typesafeFail(cfg, code, message, attempt, extra);
        delayMs = retryAfterMs;
      }
      retry = { code, status: result.status, retryAfterMs };
    }
    try {
      cfg.onRetry({ attempt, delayMs, ...retry });
    } catch {
      /* an observer must never break the request */
    }
    await typesafeSleep(delayMs);
  }
}

/** Checks done before anything is sent to /v1/systemone; null when the request may go out. */
function typesafePrecheck(cfg: TypeSafeResolvedOptions, questions: TypeSafeQuestions): { ok: false; error: TypeSafeError } | null {
  if (!cfg.apiKey) return typesafeFail(cfg, "invalid_key", "No API key configured.", 0);
  if (Object.keys(questions).length === 0) return typesafeFail(cfg, "validation", "At least one question is required.", 0);
  return null;
}

function typesafeRequestBody<Q extends TypeSafeQuestions>(cfg: TypeSafeResolvedOptions, request: TypeSafeRequest<Q>): string {
  return JSON.stringify({ state: request.state, model: request.model ?? cfg.model, questions: request.questions });
}

/**
 * Calls POST /v1/systemone. Every requested answer must come back well-formed, otherwise the
 * outcome is bad_response. Retries as described in typesafeRequest.
 */
async function typesafeSystemOne<Q extends TypeSafeQuestions>(
  options: TypeSafeClientOptions,
  request: TypeSafeRequest<Q>,
): Promise<TypeSafeOutcome<TypeSafeResult<Q>>> {
  const cfg = typesafeResolveOptions(options);
  const refused = typesafePrecheck(cfg, request.questions);
  if (refused) return refused;
  const reply = await typesafeRequest(cfg, "POST", "/v1/systemone", typesafeRequestBody(cfg, request), (text) =>
    typesafeParseResponse(text, request.questions),
  );
  if (!reply.ok) return reply;
  const { value, requestId, attempts } = reply.value;
  return { ok: true, value: { model: value.model, answers: value.answers, usage: value.usage, requestId, attempts } };
}

/**
 * Calls POST /v1/systemone for a request that carries several independent questions (e.g. one
 * per item of the state, the "speculative fan-out" pattern): a missing or malformed answer only
 * drops that answer (see TypeSafePartialResult.answerErrors). A body that is not the documented
 * JSON object with an "answers" object is still bad_response for the whole call.
 */
async function typesafeSystemOnePartial<Q extends TypeSafeQuestions>(
  options: TypeSafeClientOptions,
  request: TypeSafeRequest<Q>,
): Promise<TypeSafeOutcome<TypeSafePartialResult<Q>>> {
  const cfg = typesafeResolveOptions(options);
  const refused = typesafePrecheck(cfg, request.questions);
  if (refused) return refused;
  const reply = await typesafeRequest(cfg, "POST", "/v1/systemone", typesafeRequestBody(cfg, request), (text) =>
    typesafeParsePartialResponse(text, request.questions),
  );
  if (!reply.ok) return reply;
  const { value, requestId, attempts } = reply.value;
  return {
    ok: true,
    value: { model: value.model, answers: value.answers, answerErrors: value.answerErrors, usage: value.usage, requestId, attempts },
  };
}

/**
 * Calls GET /v1/models (Bearer auth, same timeout, redirect and retry policy as the other calls).
 * 401 / 403 map to invalid_key / forbidden as usual; 404 / 405 set `unsupported` (no models list
 * at this API root). Whether this call costs tokens is not documented.
 */
async function typesafeListModels(options: TypeSafeClientOptions): Promise<TypeSafeModelsOutcome> {
  const cfg = typesafeResolveOptions(options);
  if (!cfg.apiKey) return { ...typesafeFail(cfg, "invalid_key", "No API key configured.", 0), unsupported: false };
  const reply = await typesafeRequest(cfg, "GET", "/v1/models", null, typesafeParseModels);
  if (!reply.ok) {
    const status = reply.error.status;
    return { ok: false, error: reply.error, unsupported: status === 404 || status === 405 };
  }
  return { ok: true, value: { models: reply.value.value, requestId: reply.value.requestId, attempts: reply.value.attempts } };
}
