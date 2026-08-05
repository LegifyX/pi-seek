import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BalanceStore } from "../src/balance.ts";
import type { BetaApi } from "../src/beta.ts";
import { runChatWithRecovery } from "../src/chat.ts";
import {
  createRuntimeState,
  type ResponseChatOptions,
  type ResponsesResult,
} from "../src/config.ts";
import type { ResponsesApi } from "../src/responses.ts";
import { createTelemetryStore } from "../src/telemetry.ts";
import { createThreadStore } from "../src/threads.ts";
import { registerTools, type ToolServices } from "../src/tools.ts";

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

// ---------------------------------------------------------------------------
// ds_chat tool-level contract: atomic thread mutation and structured output
// ---------------------------------------------------------------------------

type ChatBehavior = (
  options: ResponseChatOptions
) => ResponsesResult | Promise<ResponsesResult>;

const createChatHarness = () => {
  const runtimeState = createRuntimeState();
  const telemetry = createTelemetryStore(runtimeState);
  const threads = createThreadStore();
  const tools = new Map<string, unknown>();
  const pi = {
    appendEntry: () => undefined,
    registerTool: (tool: unknown) => {
      tools.set((tool as { name: string }).name, tool);
    },
  } as unknown as ExtensionAPI;

  const chatBehaviors: ChatBehavior[] = [];
  const chatCalls: Array<{ input: unknown[]; options: ResponseChatOptions }> =
    [];
  const responses: ResponsesApi = {
    chat: (input, options) => {
      chatCalls.push({ input, options });
      const behavior = chatBehaviors.shift();
      if (!behavior) {
        return Promise.reject(new Error("unexpected extra chat call"));
      }
      return Promise.resolve(behavior(options));
    },
    webSearch: () => Promise.reject(new Error("unused in chat-recovery tests")),
  };
  const beta = {
    postChatCompletion: () =>
      Promise.reject(new Error("unused in chat-recovery tests")),
    postCompletion: () =>
      Promise.reject(new Error("unused in chat-recovery tests")),
  } as BetaApi;

  registerTools(pi, {
    balance: {} as BalanceStore,
    beta,
    responses,
    runtimeState,
    telemetry,
    threads,
  } satisfies ToolServices);

  const execute = (
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const tool = tools.get("ds_chat") as {
      execute: (
        toolCallId: string,
        toolParams: Record<string, unknown>,
        toolSignal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown
      ) => Promise<unknown>;
    };
    return tool.execute("call_1", params, signal, undefined, {
      model: undefined,
      signal: undefined,
      ui: { notify: () => undefined, setStatus: () => undefined },
    });
  };

  return { chatBehaviors, chatCalls, execute, threads };
};

// Mirrors a fetch that stays pending until the caller aborts: rejects with the
// http-level abort marker "Aborted by user" when the signal fires.
const abortDuringRequest = (
  options: ResponseChatOptions
): Promise<ResponsesResult> =>
  new Promise((_resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Aborted by user"));
      return;
    }
    options.signal?.addEventListener(
      "abort",
      () => reject(new Error("Aborted by user")),
      { once: true }
    );
  });

test("an aborted first ds_chat leaves the thread system/round/items untouched", async () => {
  const harness = createChatHarness();
  const controller = new AbortController();
  harness.chatBehaviors.push(abortDuringRequest);
  setTimeout(() => controller.abort(), 10);
  const result = await harness.execute(
    { message: "hi", system: "Be terse", thread: "t" },
    controller.signal
  );
  const { details } = result as { details: Record<string, unknown> };
  assert.equal(details.interrupted, true);
  assert.equal(details.phase, "request");

  // The live thread is untouched: no system, no items, round 0.
  const thread = harness.threads.getOrCreate("t");
  assert.equal(thread.round, 0);
  assert.deepEqual(thread.items, []);
  assert.equal(thread.system, undefined);

  // Restore from a branch that carries the interrupted tool result (whose
  // details carry no thread snapshot) reproduces the same empty state.
  harness.threads.restore({
    sessionManager: {
      getBranch: () => [
        {
          message: {
            details: { interrupted: true, phase: "request" },
            role: "toolResult",
            toolName: "ds_chat",
          },
          type: "message",
        },
      ],
    },
  } as unknown as ExtensionContext);
  assert.deepEqual(harness.threads.snapshot(), {});
});

test("ds_chat commits the first-round system prompt only after a successful round", async () => {
  const harness = createChatHarness();
  harness.chatBehaviors.push(() => okResult("done"));
  await harness.execute({ message: "hi", system: "Be terse", thread: "t" });
  const thread = harness.threads.getOrCreate("t");
  assert.equal(thread.round, 1);
  assert.equal(thread.system, "Be terse");
  assert.equal(thread.items.length, 2);
});

test("ds_chat plumbs format and json_schema into the request options", async () => {
  const harness = createChatHarness();
  harness.chatBehaviors.push(() => okResult("done"));
  const jsonSchema = {
    properties: { name: { type: "string" } },
    type: "object",
  };
  await harness.execute({
    format: "json_schema",
    json_schema: jsonSchema,
    message: "hi",
    thread: "t",
  });
  const lastCall = harness.chatCalls.at(-1);
  assert.ok(lastCall);
  assert.equal(lastCall.options.format, "json_schema");
  assert.deepEqual(lastCall.options.jsonSchema, jsonSchema);
});
