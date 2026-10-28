// Minimal typed client for the TypeSafe AI "System One" HTTP API (Jev models).
//
//   POST {baseUrl}/v1/systemone
//   Authorization: Bearer <API key>
//   { "state": ..., "model": "jev-latest", "questions": { "<id>": { "type": "noul", ... } } }
//
// Wire format from docs.typesafe.ai/api, https://api.typesafe.ai/openapi.json
// (v0.2.0) and the official SDKs (typesafe-sdk-js v0.6.0, typesafe-sdk-python v0.7.2).
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
  /** API root; "/v1/systemone" is appended. Default https://api.typesafe.ai */
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
  url: string;
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
  const base = (o.baseUrl ?? d.baseUrl).replace(/\/+$/, "");
  return {
    apiKey: o.apiKey.trim(),
    url: `${base}/v1/systemone`,
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

type TypeSafeParsed<Q extends TypeSafeQuestions> =
  | { ok: true; model: string; answers: TypeSafeResult<Q>["answers"]; usage: TypeSafeResult<Q>["usage"] }
  | { ok: false; message: string };

function typesafeParseResponse<Q extends TypeSafeQuestions>(text: string, questions: Q): TypeSafeParsed<Q> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: "Response body is not valid JSON." };
  }
  if (!typesafeIsRecord(json)) return { ok: false, message: "Response body is not a JSON object." };
  const rawAnswers = json["answers"];
  if (!typesafeIsRecord(rawAnswers)) return { ok: false, message: 'Response has no "answers" object.' };

  const answers: { [id: string]: TypeSafeAnswer } = {};
  for (const [id, question] of Object.entries(questions)) {
    const parsed = typesafeParseAnswer(rawAnswers[id], question.type);
    if (typeof parsed === "string") return { ok: false, message: `answers.${id}: ${parsed}.` };
    answers[id] = parsed; // unrequested / unknown answer kinds are ignored
  }

  const usage = typesafeIsRecord(json["usage"]) ? json["usage"] : {};
  return {
    ok: true,
    model: typeof json["model"] === "string" ? json["model"] : "unknown",
    // Every requested id was validated against its own question type above.
    answers: answers as TypeSafeResult<Q>["answers"],
    usage: {
      inputTokens: typesafeNumber(usage["input_tokens"]),
      outputTokens: typesafeNumber(usage["output_tokens"]),
    },
  };
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

async function typesafeAttempt(cfg: TypeSafeResolvedOptions, body: string): Promise<TypeSafeAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await cfg.fetch(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      signal: controller.signal,
      credentials: "omit", // never send cookies
      redirect: "error", // never replay the Authorization header elsewhere
    });
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

/**
 * Calls POST /v1/systemone. Retries 408 / 429 / 5xx (incl. 529), timeouts and
 * network errors with exponential backoff + jitter, honouring Retry-After.
 * Never throws for API or network failures: returns a typed outcome.
 */
async function typesafeSystemOne<Q extends TypeSafeQuestions>(
  options: TypeSafeClientOptions,
  request: TypeSafeRequest<Q>,
): Promise<TypeSafeOutcome<TypeSafeResult<Q>>> {
  const cfg = typesafeResolveOptions(options);
  const fail = (
    code: TypeSafeErrorCode,
    message: string,
    attempts: number,
    extra: { status?: number; retryAfterMs?: number | null; requestId?: string | null } = {},
  ): TypeSafeOutcome<TypeSafeResult<Q>> => ({
    ok: false,
    error: {
      code,
      status: extra.status ?? null,
      message: typesafeSafeMessage(message, cfg.apiKey),
      attempts,
      retryAfterMs: extra.retryAfterMs ?? null,
      requestId: extra.requestId ?? null,
    },
  });

  if (!cfg.apiKey) return fail("invalid_key", "No API key configured.", 0);
  if (Object.keys(request.questions).length === 0) return fail("validation", "At least one question is required.", 0);

  const body = JSON.stringify({
    state: request.state,
    model: request.model ?? cfg.model,
    questions: request.questions,
  });

  for (let attempt = 1; ; attempt++) {
    const result = await typesafeAttempt(cfg, body);
    const canRetry = attempt <= cfg.maxRetries;
    let delayMs = typesafeBackoffMs(cfg, attempt - 1);
    let retry: Omit<TypeSafeRetryInfo, "attempt" | "delayMs">;

    if (result.kind === "timeout") {
      if (!canRetry) return fail("timeout", `No response within ${cfg.timeoutMs} ms.`, attempt);
      retry = { code: "timeout", status: null, retryAfterMs: null };
    } else if (result.kind === "network") {
      if (!canRetry) return fail("network", `Could not reach TypeSafe (${result.detail}).`, attempt);
      retry = { code: "network", status: null, retryAfterMs: null };
    } else {
      const requestId = result.headers.get("x-typesafe-request-id");
      if (result.status >= 200 && result.status < 300) {
        const parsed = typesafeParseResponse(result.text, request.questions);
        if (!parsed.ok) return fail("bad_response", parsed.message, attempt, { status: result.status, requestId });
        return {
          ok: true,
          value: { model: parsed.model, answers: parsed.answers, usage: parsed.usage, requestId, attempts: attempt },
        };
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

      if (!typesafeIsRetryableStatus(result.status) || !canRetry) return fail(code, message, attempt, extra);
      if (retryAfterMs !== null) {
        if (retryAfterMs > cfg.maxRetryAfterMs) return fail(code, message, attempt, extra);
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
