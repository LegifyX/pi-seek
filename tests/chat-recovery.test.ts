import assert from "node:assert/strict";
import { test } from "node:test";
import { runChatWithRecovery } from "../src/chat.ts";
import type { ResponseChatOptions, ResponsesResult } from "../src/config.ts";

const INVALID_INPUT_RE = /DeepSeek API 400: invalid input format/;

const user = (n: number | string): unknown => ({
  content: [{ text: `u${n}`, type: "input_text" }],
  role: "user",
});

const okResult = (text = "hi"): ResponsesResult => ({
  calls: [],
  items: [
    {
      content: [{ text, type: "output_text" }],
      role: "assistant",
      type: "message",
    },
  ],
  text,
  thinking: "",
  usage: {},
});

const CONTEXT_ERROR = new Error(
  'DeepSeek API 400: {"error":{"message":"Input is invalid: prompt length exceeds context length"}}'
);

const makeService = (
  behaviors: Array<() => ResponsesResult | Promise<ResponsesResult>>
): {
  calls: unknown[][];
  service: {
    chat: (
      input: unknown[],
      options: ResponseChatOptions
    ) => Promise<ResponsesResult>;
  };
} => {
  const calls: unknown[][] = [];
  const service = {
    chat: (input: unknown[], _options: ResponseChatOptions) => {
      calls.push(input);
      const next = behaviors.shift();
      if (!next) {
        throw new Error("unexpected extra service call");
      }
      return Promise.resolve(next());
    },
  };
  return { calls, service };
};

test("a context-length failure trims the replay once and retries", async () => {
  const { calls, service } = makeService([
    () => {
      throw CONTEXT_ERROR;
    },
    () => okResult("recovered"),
  ]);
  const input = Array.from({ length: 150 }, (_, i) =>
    i % 2 === 0
      ? user(i)
      : { content: [{ text: `a${i}`, type: "output_text" }], role: "assistant" }
  );
  const outcome = await runChatWithRecovery(service, input, {});
  assert.equal(outcome.interrupted, false);
  assert.equal(outcome.result.text, "recovered");
  // Oldest assistant turns dropped first (48 of 74), user turns kept.
  assert.equal(outcome.trimmed, 48);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 150);
  assert.equal(calls[1].length, 102);
  // The leading prefix stays contiguous for prompt-cache hits.
  assert.deepEqual(calls[1][0], user(0));
  assert.deepEqual(calls[1].at(-2), user(148));
});

test("a context-length error with nothing to trim propagates", async () => {
  const { service } = makeService([
    () => {
      throw CONTEXT_ERROR;
    },
  ]);
  await assert.rejects(
    runChatWithRecovery(service, [user(1)], {}),
    (error: unknown) => {
      assert.equal(error, CONTEXT_ERROR);
      return true;
    }
  );
});

test("non-retryable errors propagate without retrying", async () => {
  const { calls, service } = makeService([
    () => {
      throw new Error("DeepSeek API 400: invalid input format");
    },
  ]);
  await assert.rejects(
    runChatWithRecovery(service, [user(1)], {}),
    INVALID_INPUT_RE
  );
  assert.equal(calls.length, 1);
});

test("transient failures retry with backoff inside a chat round", async () => {
  let calls = 0;
  const service = {
    chat: () => {
      calls += 1;
      if (calls < 3) {
        return Promise.reject(new Error("DeepSeek API 503: busy"));
      }
      return Promise.resolve(okResult("finally"));
    },
  };
  const outcome = await runChatWithRecovery(
    service,
    [user(1)],
    {},
    {
      wait: async () => undefined,
    }
  );
  assert.equal(outcome.interrupted, false);
  assert.equal(outcome.result.text, "finally");
  assert.equal(outcome.retries, 2);
  assert.equal(outcome.trimmed, 0);
  assert.equal(calls, 3);
});

test("an abort mid-request returns an interrupted outcome, not a thrown error", async () => {
  const controller = new AbortController();
  const service = {
    chat: (_input: unknown[], options: ResponseChatOptions) =>
      new Promise<ResponsesResult>((_resolve, reject) => {
        // Mirrors a fetch that never resolves until the caller aborts.
        if (options.signal?.aborted) {
          reject(new Error("Aborted by user"));
          return;
        }
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("Aborted by user")),
          { once: true }
        );
      }),
  };
  setTimeout(() => controller.abort(), 10);
  const outcome = await runChatWithRecovery(service, [user(1)], {
    signal: controller.signal,
  });
  assert.equal(outcome.interrupted, true);
  assert.equal(outcome.phase, "request");
});

test("an abort during the backoff wait reports phase retry_wait", async () => {
  const controller = new AbortController();
  let calls = 0;
  const service = {
    chat: () => {
      calls += 1;
      return Promise.reject(new Error("DeepSeek API 503: busy"));
    },
  };
  // Fires while the first 200ms backoff is still running.
  setTimeout(() => controller.abort(), 20);
  const outcome = await runChatWithRecovery(service, [user(1)], {
    signal: controller.signal,
  });
  assert.equal(outcome.interrupted, true);
  assert.equal(outcome.phase, "retry_wait");
  assert.equal(calls, 1);
});
