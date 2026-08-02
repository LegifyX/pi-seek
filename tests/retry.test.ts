import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpClient } from "../src/http.ts";
import {
  backoffDelayMs,
  classifyError,
  isContextLengthError,
  RetryWaitAbortedError,
  withRetries,
} from "../src/retry.ts";

const originalFetch = globalThis.fetch;
const STATUS_503 = /DeepSeek API 503/;

const createClient = (): ReturnType<typeof createHttpClient> =>
  createHttpClient({ resolveApiKey: async () => "k" });

const noWait = (): Promise<void> => Promise.resolve();

const CONTEXT_ERROR_RE = /DeepSeek API 400/;
const ABORTED_USER_RE = /Aborted by user/;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("classifyError: 429 and 5xx statuses are retryable", () => {
  assert.equal(
    classifyError(new Error("DeepSeek API 429: rate limited")),
    "retryable"
  );
  assert.equal(classifyError(new Error("DeepSeek API 500: boom")), "retryable");
  assert.equal(
    classifyError(new Error("DeepSeek API 502: bad gateway")),
    "retryable"
  );
  assert.equal(
    classifyError(new Error("DeepSeek API 503: unavailable")),
    "retryable"
  );
});

test("classifyError: other 4xx statuses are non-retryable", () => {
  for (const status of ["400", "401", "403", "404", "413", "422"]) {
    assert.equal(
      classifyError(new Error(`DeepSeek API ${status}: rejected`)),
      "non-retryable"
    );
  }
});

test("classifyError: timeouts are retryable", () => {
  assert.equal(
    classifyError(new Error("DeepSeek request timed out")),
    "retryable"
  );
});

test("classifyError: invalid JSON and API misuse are non-retryable", () => {
  assert.equal(
    classifyError(new Error("DeepSeek API returned an invalid JSON response")),
    "non-retryable"
  );
  assert.equal(
    classifyError(new Error("body validation failed")),
    "non-retryable"
  );
  assert.equal(classifyError("not an error object"), "non-retryable");
  assert.equal(classifyError(undefined), "non-retryable");
});

test("classifyError: caller aborts are never retried", () => {
  assert.equal(classifyError(new Error("Aborted by user")), "abort");
  assert.equal(classifyError(new RetryWaitAbortedError()), "abort");
});

test("classifyError: fetch-level network failures are retryable", () => {
  assert.equal(classifyError(new TypeError("fetch failed")), "retryable");
  const reset = new Error("read ECONNRESET");
  (reset as { code?: string }).code = "ECONNRESET";
  assert.equal(
    classifyError(new Error("fetch failed", { cause: reset })),
    "retryable"
  );
  assert.equal(
    classifyError(
      new TypeError("fetch failed", {
        cause: new AggregateError([reset], "fetch failed"),
      })
    ),
    "retryable"
  );
  const unknown = new Error("weird");
  (unknown as { code?: string }).code = "SOMETHING_ELSE";
  assert.equal(classifyError(unknown), "non-retryable");
});

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

test("backoffDelayMs doubles per attempt with jitter 1.0 at random()=0.5", () => {
  const random = () => 0.5;
  assert.equal(backoffDelayMs(0, random), 200);
  assert.equal(backoffDelayMs(1, random), 400);
  assert.equal(backoffDelayMs(2, random), 800);
  assert.equal(backoffDelayMs(3, random), 1600);
  assert.equal(backoffDelayMs(4, random), 3200);
});

test("backoffDelayMs jitter stays within 0.9x-1.1x of the base", () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (let i = 0; i < 100; i += 1) {
      const base = 200 * 2 ** attempt;
      const delay = backoffDelayMs(attempt);
      assert.ok(delay >= Math.round(base * 0.9), `${delay} < 0.9x of ${base}`);
      assert.ok(delay <= Math.round(base * 1.1), `${delay} > 1.1x of ${base}`);
    }
  }
});

test("backoffDelayMs caps the delay at 10s", () => {
  const random = () => 0.5;
  assert.equal(backoffDelayMs(10, random), 10_000);
  assert.equal(backoffDelayMs(20, random), 10_000);
});

// ---------------------------------------------------------------------------
// Retry loop with a fake fetch
// ---------------------------------------------------------------------------

test("withRetries retries 503s then succeeds, reporting the retry count", async () => {
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    if (calls < 3) {
      return Promise.resolve(new Response("busy", { status: 503 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
  };
  try {
    const outcome = await withRetries(
      () => createClient().postJson("/responses", {}),
      { wait: noWait }
    );
    assert.equal(outcome.retries, 2);
    assert.deepEqual(outcome.result, { ok: true });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("withRetries stops after maxRetries and throws the last error", async () => {
  globalThis.fetch = () =>
    Promise.resolve(new Response("busy", { status: 503 }));
  try {
    await assert.rejects(
      withRetries(() => createClient().postJson("/responses", {}), {
        maxRetries: 2,
        wait: noWait,
      }),
      STATUS_503
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("withRetries never retries non-retryable statuses", async () => {
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(new Response("bad", { status: 400 }));
  };
  try {
    await assert.rejects(
      withRetries(() => createClient().postJson("/responses", {}), {
        wait: noWait,
      }),
      CONTEXT_ERROR_RE
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("withRetries never retries aborted requests", async () => {
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.reject(new Error("fetch aborted"));
  };
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      withRetries(
        () => createClient().postJson("/responses", {}, controller.signal),
        {
          wait: noWait,
        }
      ),
      ABORTED_USER_RE
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("withRetries aborts the backoff wait when the signal fires", async () => {
  const controller = new AbortController();
  let calls = 0;
  const operation = (): Promise<unknown> => {
    calls += 1;
    throw new Error("DeepSeek API 503: busy");
  };
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    withRetries(operation, { signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof RetryWaitAbortedError);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("withRetries honors an injectable wait", async () => {
  const delays: number[] = [];
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(new Response("busy", { status: 429 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
  };
  try {
    const outcome = await withRetries(
      () => createClient().postJson("/responses", {}),
      {
        wait: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }
    );
    assert.equal(outcome.retries, 1);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 180 && delays[0] <= 220, `delay ${delays[0]}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Context-length detection
// ---------------------------------------------------------------------------

test("isContextLengthError matches DeepSeek context overflow messages", () => {
  assert.equal(
    isContextLengthError(
      new Error(
        'DeepSeek API 400: {"error":{"message":"Input is invalid: prompt length 500000 exceeds context length 131072"}}'
      )
    ),
    true
  );
  assert.equal(
    isContextLengthError(
      new Error(
        "DeepSeek API 400: This model's maximum context length is 1048576 tokens"
      )
    ),
    true
  );
  assert.equal(
    isContextLengthError(
      new Error("DeepSeek API 400: input exceeds the context window")
    ),
    true
  );
  assert.equal(
    isContextLengthError(new Error("DeepSeek API 400: invalid input format")),
    false
  );
  assert.equal(
    isContextLengthError(new Error("DeepSeek API 503: overloaded")),
    false
  );
  assert.equal(isContextLengthError("not an error"), false);
});
