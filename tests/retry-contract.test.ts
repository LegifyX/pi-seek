import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BalanceStore } from "../src/balance.ts";
import type { BetaApi } from "../src/beta.ts";
import type { ResponsesResult } from "../src/config.ts";
import { createRuntimeState, type JsonObject } from "../src/config.ts";
import type { ResponsesApi } from "../src/responses.ts";
import { createTelemetryStore } from "../src/telemetry.ts";
import type { ThreadStore } from "../src/threads.ts";
import { registerTools, type ToolServices } from "../src/tools.ts";

// ds_chat and ds_call_function already run through the shared retry taxonomy:
// tests/retry.test.ts covers withRetries itself (classifyError, backoff, abort,
// non-retryable propagation) and tests/chat-recovery.test.ts covers ds_chat's
// orchestration (trim-and-retry, retries, request/retry_wait interruption
// phases). This file pins the same retry contract onto the remaining fetch
// tools that previously called their adapters directly: ds_prefix_complete,
// ds_fim, ds_web_search, and ds_call_function.

type ChatBehavior = (signal?: AbortSignal) => JsonObject | Promise<JsonObject>;
type SearchBehavior = (
  signal?: AbortSignal
) => ResponsesResult | Promise<ResponsesResult>;

const TRANSIENT = (): never => {
  throw new Error("DeepSeek API 503: overloaded");
};
const NOT_RETRYABLE = (): never => {
  throw new Error("DeepSeek API 400: invalid input format");
};
const TIMEOUT = (): never => {
  throw new Error("DeepSeek request timed out");
};

// Mirrors a fetch that stays pending until the caller aborts: rejects with the
// http-level abort marker "Aborted by user" when the signal fires.
const abortDuringRequest = (signal?: AbortSignal): Promise<JsonObject> =>
  new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted by user"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(new Error("Aborted by user")),
      { once: true }
    );
  });

const prefixResponse = (completion = "quicksort"): JsonObject => ({
  choices: [{ index: 0, message: { content: completion, role: "assistant" } }],
  usage: {},
});

const fimResponse = (completion = "middle"): JsonObject => ({
  choices: [{ index: 0, text: completion }],
  usage: {},
});

const searchResult = (text = "answer"): ResponsesResult => ({
  calls: [],
  items: [],
  text,
  thinking: "",
  usage: {},
});

const functionResponse = (): JsonObject => ({
  choices: [
    {
      index: 0,
      message: {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: { arguments: '{"key":"v"}', name: "lookup" },
            id: "call_1",
            type: "function",
          },
        ],
      },
    },
  ],
  usage: {},
});

const createHarness = () => {
  const runtimeState = createRuntimeState();
  const telemetry = createTelemetryStore(runtimeState);
  const tools = new Map<string, unknown>();
  const pi = {
    appendEntry: () => undefined,
    registerTool: (tool: unknown) => {
      tools.set((tool as { name: string }).name, tool);
    },
  } as unknown as ExtensionAPI;

  const betaBehaviors: ChatBehavior[] = [];
  const fimBehaviors: ChatBehavior[] = [];
  const searchBehaviors: SearchBehavior[] = [];
  const queues: Record<string, unknown[]> = {
    ds_call_function: betaBehaviors,
    ds_fim: fimBehaviors,
    ds_prefix_complete: betaBehaviors,
    ds_web_search: searchBehaviors,
  };

  const beta: BetaApi = {
    postChatCompletion: async (_body, signal) => {
      const behavior = betaBehaviors.shift();
      if (!behavior) {
        throw new Error("unexpected extra postChatCompletion call");
      }
      return await behavior(signal);
    },
    postCompletion: async (_body, signal) => {
      const behavior = fimBehaviors.shift();
      if (!behavior) {
        throw new Error("unexpected extra postCompletion call");
      }
      return await behavior(signal);
    },
  };
  const responses: ResponsesApi = {
    chat: () => Promise.reject(new Error("unused in retry-contract tests")),
    webSearch: async (_query, _effort, _maxOutputTokens, signal) => {
      const behavior = searchBehaviors.shift();
      if (!behavior) {
        throw new Error("unexpected extra webSearch call");
      }
      return await behavior(signal);
    },
  };

  registerTools(pi, {
    balance: {} as BalanceStore,
    beta,
    responses,
    runtimeState,
    telemetry,
    threads: {} as ThreadStore,
  } satisfies ToolServices);

  const execute = (
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const tool = tools.get(name) as {
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

  return {
    execute,
    queue: (
      toolName: string,
      behaviors: Array<ChatBehavior | SearchBehavior>
    ): void => {
      queues[toolName].push(...behaviors);
    },
    remaining: (toolName: string): unknown[] => queues[toolName],
  };
};

interface ToolResult {
  content: Array<{ text?: string; type?: string }>;
  details: Record<string, unknown>;
}

const asToolResult = (result: unknown): ToolResult => {
  const raw = result as {
    content?: Array<{ text?: string; type?: string }>;
    details?: Record<string, unknown>;
  };
  assert.ok(raw.content, "expected a content array in the tool result");
  assert.ok(raw.details, "expected details in the tool result");
  return { content: raw.content, details: raw.details };
};

const TOOLS = [
  {
    name: "ds_prefix_complete",
    params: { prefix: "def quicksort", prompt: "write quicksort" },
    respond: () => prefixResponse(),
    text: "quicksort",
  },
  {
    name: "ds_fim",
    params: { prompt: "def quicksort" },
    respond: () => fimResponse(),
    text: "middle",
  },
  {
    name: "ds_web_search",
    params: { query: "deepseek v4 flash" },
    respond: () => searchResult(),
    text: "answer",
  },
  {
    name: "ds_call_function",
    params: {
      name: "lookup",
      parameters: Type.Object({ key: Type.String() }),
    },
    respond: () => functionResponse(),
    // ds_call_function appends a retry note to its content (unlike the other
    // tools), so the expected text carries the note for the retried cases.
    text: 'Function call: lookup\nArguments: {\n  "key": "v"\n}\n\n[note: retried 1x]',
  },
];

const NON_RETRYABLE_RE = /DeepSeek API 400: invalid input format/;

for (const tool of TOOLS) {
  describe(tool.name, () => {
    test("transient failure then success retries and surfaces retries in details", async () => {
      const harness = createHarness();
      harness.queue(tool.name, [TRANSIENT, tool.respond]);
      const result = asToolResult(
        await harness.execute(tool.name, tool.params)
      );
      assert.equal(result.details.retries, 1);
      assert.equal(result.content[0]?.text, tool.text);
    });

    test("4xx failures are not retried and propagate", async () => {
      const harness = createHarness();
      harness.queue(tool.name, [NOT_RETRYABLE]);
      await assert.rejects(
        harness.execute(tool.name, tool.params),
        NON_RETRYABLE_RE
      );
      assert.deepEqual(harness.remaining(tool.name), []);
    });

    test("timeouts are retried", async () => {
      const harness = createHarness();
      harness.queue(tool.name, [TIMEOUT, tool.respond]);
      const result = asToolResult(
        await harness.execute(tool.name, tool.params)
      );
      assert.equal(result.details.retries, 1);
      assert.equal(result.content[0]?.text, tool.text);
    });

    test("abort during the request returns an interrupted result with phase request", async () => {
      const harness = createHarness();
      const controller = new AbortController();
      harness.queue(tool.name, [abortDuringRequest]);
      setTimeout(() => controller.abort(), 10);
      const result = asToolResult(
        await harness.execute(tool.name, tool.params, controller.signal)
      );
      assert.equal(result.details.interrupted, true);
      assert.equal(result.details.phase, "request");
      assert.equal(result.content[0]?.text, "Interrupted by the caller.");
    });

    test("abort during the backoff wait returns an interrupted result with phase retry_wait", async () => {
      const harness = createHarness();
      const controller = new AbortController();
      harness.queue(tool.name, [TRANSIENT]);
      // Fires while the first ~200ms backoff is still running.
      setTimeout(() => controller.abort(), 20);
      const result = asToolResult(
        await harness.execute(tool.name, tool.params, controller.signal)
      );
      assert.equal(result.details.interrupted, true);
      assert.equal(result.details.phase, "retry_wait");
      assert.equal(result.content[0]?.text, "Interrupted by the caller.");
    });
  });
}
