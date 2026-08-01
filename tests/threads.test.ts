import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../deepseek-v4.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const makeStore = (): ReturnType<typeof __test.createThreadStore> =>
  __test.createThreadStore();

const BOOM_ERROR = /boom/;

test("withLock serializes actions on the same thread", async () => {
  const store = makeStore();
  const order: string[] = [];
  const first = store.withLock("t", async () => {
    order.push("first-start");
    await sleep(20);
    order.push("first-end");
  });
  const second = store.withLock("t", async () => {
    order.push("second-start");
    await sleep(5);
    order.push("second-end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "first-start",
    "first-end",
    "second-start",
    "second-end",
  ]);
});

test("a slow action on one thread does not block another thread", async () => {
  const store = makeStore();
  const slow = store.withLock("a", async () => {
    await sleep(80);
    return "slow";
  });
  const fast = await Promise.race([
    store.withLock("b", async () => "fast"),
    sleep(30).then(() => "blocked"),
  ]);
  assert.equal(fast, "fast");
  assert.equal(await slow, "slow");
});

test("a throwing action rejects its caller and does not deadlock the thread", async () => {
  const store = makeStore();
  await assert.rejects(
    store.withLock("t", () => {
      throw new Error("boom");
    }),
    BOOM_ERROR
  );
  assert.equal(await store.withLock("t", async () => "ok"), "ok");
});

test("reset(name) clears only that thread; reset() clears all", async () => {
  const store = makeStore();
  store.getOrCreate("a");
  store.getOrCreate("b");
  await store.reset("a");
  assert.deepEqual(store.snapshot(), { b: { items: [], round: 0 } });
  await store.reset();
  assert.deepEqual(store.snapshot(), {});
});

test("withLock stays ordered and usable across a reset", async () => {
  const store = makeStore();
  store.getOrCreate("t");
  const log: string[] = [];
  const first = store.withLock("t", async () => {
    log.push("first");
    await sleep(10);
    log.push("first-done");
  });
  const resetPromise = store.reset("t");
  const after = store.withLock("t", () => {
    log.push("after");
  });
  await Promise.all([first, resetPromise, after]);
  assert.deepEqual(log, ["first", "first-done", "after"]);
  assert.deepEqual(store.snapshot(), {});
  assert.equal(await store.withLock("t", async () => "works"), "works");
});
