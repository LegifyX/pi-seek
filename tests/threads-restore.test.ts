import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __test } from "../src/index.ts";

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

const legacy = (threads: Record<string, ThreadLike>): BranchEntry => ({
  message: {
    details: { threads },
    role: "toolResult",
    toolName: "ds_chat",
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

test("legacy whole-map snapshot replaces all threads", () => {
  const store = restore([
    chat("a", 1, 2),
    legacy({ x: { items: ["x#0"], round: 3 } }),
  ]);
  assert.deepEqual(store.snapshot(), {
    x: { items: ["x#0"], round: 3 },
  });
});
