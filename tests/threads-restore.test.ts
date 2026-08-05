import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BalanceStore } from "../src/balance.ts";
import type { BetaApi } from "../src/beta.ts";
import { createRuntimeState } from "../src/config.ts";
import { __test } from "../src/index.ts";
import type { ResponsesApi } from "../src/responses.ts";
import { createTelemetryStore } from "../src/telemetry.ts";
import { registerTools, type ToolServices } from "../src/tools.ts";

interface BranchEntry {
  message: {
    role: "toolResult";
    toolName: string;
    details: unknown;
  };
  type: "message";
}

interface ThreadLike {
  items: unknown[];
  round: number;
  system?: string;
}

const chat = (name: string, round: number, itemCount: number): BranchEntry => ({
  message: {
    details: {
      thread: {
        items: Array.from({ length: itemCount }, (_, i) => `${name}#${i}`),
        name,
        round,
      },
    },
    role: "toolResult",
    toolName: "ds_chat",
  },
  type: "message",
});

const reset = (name?: string): BranchEntry => ({
  message: {
    details: {
      reset: name ? { kind: "thread", name } : { kind: "all" },
      thread: name,
    },
    role: "toolResult",
    toolName: "ds_chat_reset",
  },
  type: "message",
});

const normalize = (thread: ThreadLike): ThreadLike => {
  const { system, ...rest } = thread;
  return system === undefined ? rest : thread;
};

const restore = (entries: BranchEntry[]) => {
  const store = __test.createThreadStore();
  store.restore({
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionContext);
  return store;
};

test("single thread, two rounds: the last round wins", () => {
  const store = restore([chat("a", 1, 2), chat("a", 2, 3)]);
  const thread = store.getOrCreate("a");
  assert.equal(thread.round, 2);
  assert.equal(thread.items.length, 3);
});

test("two threads interleaved: each keeps its last state", () => {
  const store = restore([chat("a", 1, 1), chat("b", 1, 1), chat("a", 2, 2)]);
  const a = store.getOrCreate("a");
  const b = store.getOrCreate("b");
  assert.equal(a.round, 2);
  assert.equal(a.items.length, 2);
  assert.equal(b.round, 1);
  assert.equal(b.items.length, 1);
});

test("reset-all after rounds clears every thread", () => {
  const store = restore([chat("a", 1, 2), chat("b", 1, 1), reset()]);
  assert.deepEqual(store.snapshot(), {});
});

test("resetting one thread leaves the others intact", () => {
  const store = restore([chat("a", 1, 2), chat("b", 1, 1), reset("a")]);
  const snapshot = Object.fromEntries(
    Object.entries(store.snapshot()).map(([name, thread]) => [
      name,
      normalize(thread),
    ])
  );
  assert.deepEqual(snapshot, {
    b: { items: ["b#0"], round: 1 },
  });
});

test("create-after-reset rebuilds the thread", () => {
  const store = restore([chat("a", 1, 2), reset("a"), chat("a", 2, 1)]);
  const thread = store.getOrCreate("a");
  assert.equal(thread.round, 2);
  assert.equal(thread.items.length, 1);
});

test("an aborted first ds_chat leaves the thread unchanged and restore reproduces it", async () => {
  // Real store so the in-memory thread state is observable after the abort.
  const threads = __test.createThreadStore();
  const tools = new Map<string, unknown>();
  const pi = {
    appendEntry: () => undefined,
    registerTool: (definition: unknown) => {
      tools.set((definition as { name: string }).name, definition);
    },
  } as unknown as ExtensionAPI;

  const runtimeState = createRuntimeState();
  const telemetry = createTelemetryStore(runtimeState);
  // Mirrors a fetch that stays pending until the caller aborts: rejects with
  // the http-level abort marker when the signal fires.
  const responses: ResponsesApi = {
    chat: (_input, options) =>
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
      }),
    webSearch: () => Promise.reject(new Error("unused in this test")),
  };

  registerTools(pi, {
    balance: {} as BalanceStore,
    beta: {} as BetaApi,
    responses,
    runtimeState,
    telemetry,
    threads,
  } satisfies ToolServices);

  const chatTool = tools.get("ds_chat") as {
    execute: (
      toolCallId: string,
      toolParams: Record<string, unknown>,
      toolSignal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown
    ) => Promise<unknown>;
  };

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const result = (await chatTool.execute(
    "call_1",
    { message: "hello", system: "You are terse", thread: "t" },
    controller.signal,
    undefined,
    {
      model: undefined,
      signal: undefined,
      ui: { notify: () => undefined, setStatus: () => undefined },
    }
  )) as { details: { interrupted?: boolean; phase?: string } };

  assert.equal(result.details.interrupted, true);
  assert.equal(result.details.phase, "request");

  // Atomicity: an aborted first round must not have committed the caller
  // system, any items, or a round bump.
  const live = threads.getOrCreate("t");
  assert.deepEqual(live, { items: [], round: 0 });

  // The interrupted result carries no thread snapshot, so a restore from the
  // branch reproduces the same empty state instead of diverging.
  const branch: BranchEntry[] = [
    {
      message: {
        details: result.details,
        role: "toolResult",
        toolName: "ds_chat",
      },
      type: "message",
    },
  ];
  const restored = __test.createThreadStore();
  restored.restore({
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext);
  assert.deepEqual(restored.getOrCreate("t"), live);
});
