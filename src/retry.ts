// ---------------------------------------------------------------------------
// Error taxonomy and capped exponential-backoff retries
// ---------------------------------------------------------------------------

// Retryable failures: rate limiting (429), server errors (5xx), network
// failures (ECONNRESET & friends), and request timeouts. Non-retryable:
// client errors (other 4xx), invalid JSON bodies, and API misuse — retrying
// those cannot succeed and only wastes time and tokens.
export type ErrorClass = "abort" | "non-retryable" | "retryable";

export const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 200;
const JITTER_MIN = 0.9;
const JITTER_MAX = 1.1;
const MAX_BACKOFF_MS = 10_000;

// Node's fetch surfaces network failures as `TypeError: fetch failed` with
// the underlying error (carrying a `code`) in `cause`; undici may wrap them
// in an AggregateError. Recognize the common transport-level codes.
const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// Thrown when the caller's abort signal fires while waiting between retries,
// so callers can distinguish an interruption during the backoff wait from an
// interruption during the request itself.
export class RetryWaitAbortedError extends Error {
  constructor() {
    super("DeepSeek request aborted while waiting to retry");
    this.name = "RetryWaitAbortedError";
  }
}

const extractErrorCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (
    current !== null &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current);
    const { code } = current as { code?: unknown };
    if (typeof code === "string") {
      return code;
    }
    const { cause } = current as { cause?: unknown };
    current = cause;
  }
};

const HTTP_STATUS_PATTERN = /DeepSeek API (\d{3})/;

// Classifies an error thrown by the HTTP client (or fetch itself) for the
// retry loop. Anything unrecognized is treated as non-retryable so API-misuse
// and body-validation errors never get replayed.
export const classifyError = (error: unknown): ErrorClass => {
  if (error instanceof RetryWaitAbortedError) {
    return "abort";
  }
  if (!(error instanceof Error)) {
    return "non-retryable";
  }
  const { message } = error;
  if (message === "Aborted by user") {
    return "abort";
  }
  if (message === "DeepSeek request timed out") {
    return "retryable";
  }
  if (message === "DeepSeek API returned an invalid JSON response") {
    return "non-retryable";
  }
  const status = Number(HTTP_STATUS_PATTERN.exec(message)?.[1]);
  if (Number.isInteger(status) && status >= 400) {
    return status === 429 || status >= 500 ? "retryable" : "non-retryable";
  }
  // fetch-level failures: TypeError from fetch, or an error (or cause chain)
  // carrying a transport error code.
  if (error instanceof TypeError) {
    return "retryable";
  }
  const code = extractErrorCode(error);
  return code && NETWORK_ERROR_CODES.has(code) ? "retryable" : "non-retryable";
};

// Capped exponential backoff: base 200ms * 2^retryCount, jittered 0.9-1.1.
// `random` is injectable for deterministic tests.
export const backoffDelayMs = (
  retryCount: number,
  random: () => number = Math.random
): number => {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** retryCount, MAX_BACKOFF_MS);
  const jitter = JITTER_MIN + random() * (JITTER_MAX - JITTER_MIN);
  return Math.round(base * jitter);
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryWaitAbortedError());
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(new RetryWaitAbortedError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface RetryOutcome<T> {
  result: T;
  retries: number;
}

export interface RetryOptions {
  maxRetries?: number;
  signal?: AbortSignal;
  // Injectable for tests; defaults to an abort-aware sleep honoring `signal`.
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// Runs `operation`, retrying retryable failures with capped exponential
// backoff. Aborts and non-retryable errors propagate immediately (wrapped in
// RetryWaitAbortedError only when the signal fires during a backoff wait).
// The recursion is at most maxRetries deep, so no stack growth concern.
export const withRetries = <T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryOutcome<T>> => {
  const { maxRetries = MAX_RETRIES, signal } = options;
  const wait = options.wait ?? sleep;
  const run = async (retries: number): Promise<RetryOutcome<T>> => {
    try {
      return { result: await operation(), retries };
    } catch (error) {
      const decision = classifyError(error);
      if (
        decision === "abort" ||
        signal?.aborted ||
        decision !== "retryable" ||
        retries >= maxRetries
      ) {
        throw error;
      }
      await wait(backoffDelayMs(retries), signal);
      return run(retries + 1);
    }
  };
  return run(0);
};

// DeepSeek reports context overflow as a 400 whose body mentions the context
// length/window. This drives the trim-and-retry path in ds_chat: the request
// itself is NOT retried (400s are non-retryable), but the caller may re-issue
// it once with a trimmed replay.
const CONTEXT_LENGTH_PATTERN =
  /context.{0,40}(length|window|limit)|(length|window|limit).{0,40}context|exceed.{0,40}context|too\s+long/i;

export const isContextLengthError = (error: unknown): boolean =>
  error instanceof Error && CONTEXT_LENGTH_PATTERN.test(error.message);
