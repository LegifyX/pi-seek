import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../deepseek-v4.ts";

const makeStore = (): ReturnType<typeof __test.createTelemetryStore> =>
  __test.createTelemetryStore({ defaultEffort: "high", enabled: true });

const pending = (
  input: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input,
  model: "deepseek-v4-flash",
  output: 0,
  source: "test",
  totalTokens: input,
  ...overrides,
});

test("mapChatUsage: full cache hit", () => {
  const usage = makeStore().mapChatUsage(
    {
      completion_tokens: 50,
      prompt_cache_hit_tokens: 100,
      prompt_tokens: 100,
      total_tokens: 150,
    },
    "chat"
  );
  assert.equal(usage.input, 0);
  assert.equal(usage.cacheRead, 100);
  assert.equal(usage.output, 50);
  assert.equal(usage.cacheWrite, 0);
  assert.equal(usage.totalTokens, 150);
});

test("mapChatUsage: miss tokens take precedence over the prompt-token diff", () => {
  const usage = makeStore().mapChatUsage(
    {
      completion_tokens: 50,
      prompt_cache_hit_tokens: 30,
      prompt_cache_miss_tokens: 70,
      prompt_tokens: 100,
    },
    "chat"
  );
  assert.equal(usage.input, 70);
  assert.equal(usage.cacheRead, 30);
});

test("mapChatUsage: falls back to prompt_tokens - cacheRead when miss is absent", () => {
  const usage = makeStore().mapChatUsage(
    {
      completion_tokens: 50,
      prompt_cache_hit_tokens: 40,
      prompt_tokens: 100,
    },
    "chat"
  );
  assert.equal(usage.input, 60);
  assert.equal(usage.cacheRead, 40);
});

test("mapResponsesUsage: input = input_tokens - cached - cache_write", () => {
  const usage = makeStore().mapResponsesUsage(
    {
      input_tokens: 1000,
      input_tokens_details: { cache_write_tokens: 100, cached_tokens: 400 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 120 },
      total_tokens: 1300,
    },
    "chat"
  );
  assert.equal(usage.input, 500);
  assert.equal(usage.cacheRead, 400);
  assert.equal(usage.cacheWrite, 100);
  assert.equal(usage.output, 200);
  assert.equal(usage.reasoning, 120);
  assert.equal(usage.totalTokens, 1300);
});

test("cost math: input 1M -> 0.14, output 1M -> 0.28, cacheRead 1M -> 0.0028", () => {
  const store = makeStore();
  const inputOnly = store.record(
    store.mapChatUsage(
      { completion_tokens: 0, prompt_tokens: 1_000_000 },
      "chat"
    )
  );
  assert.equal(inputOnly.cost.input, 0.14);
  const outputOnly = store.record(
    store.mapChatUsage(
      { completion_tokens: 1_000_000, prompt_tokens: 0 },
      "chat"
    )
  );
  assert.equal(outputOnly.cost.output, 0.28);
  const cacheOnly = store.record(
    store.mapChatUsage(
      {
        completion_tokens: 0,
        prompt_cache_hit_tokens: 1_000_000,
        prompt_tokens: 0,
      },
      "chat"
    )
  );
  assert.equal(cacheOnly.cost.cacheRead, 0.0028);
  assert.equal(cacheOnly.cost.cacheWrite, 0);
  const combined = store.record(
    store.mapChatUsage(
      {
        completion_tokens: 1_000_000,
        prompt_cache_hit_tokens: 1_000_000,
        prompt_tokens: 1_000_000,
      },
      "chat"
    )
  );
  assert.equal(
    combined.cost.total,
    combined.cost.input +
      combined.cost.output +
      combined.cost.cacheRead +
      combined.cost.cacheWrite
  );
  assert.ok(combined.cost.total > 0);
});

test("record: hitRate is cacheRead / (cacheRead + input)", () => {
  const store = makeStore();
  const record = store.record(
    pending(100, { cacheRead: 400 }) as Parameters<typeof store.record>[0]
  );
  assert.equal(record.hitRate, 0.8);
});

test("record: hitRate is 0, not NaN, when there is no input", () => {
  const store = makeStore();
  const record = store.record(pending(0) as Parameters<typeof store.record>[0]);
  assert.equal(record.hitRate, 0);
  assert.ok(Number.isFinite(record.hitRate));
});

test("history is capped at 100 and the oldest records are dropped", () => {
  const store = makeStore();
  for (let i = 1; i <= 5; i += 1) {
    store.record(pending(i) as Parameters<typeof store.record>[0]);
  }
  const sixth = store.record(pending(6) as Parameters<typeof store.record>[0]);
  for (let i = 7; i <= 105; i += 1) {
    store.record(pending(i) as Parameters<typeof store.record>[0]);
  }
  const history = store.getHistory();
  assert.equal(history.length, 100);
  assert.equal(history[0].input, 6);
  assert.equal(history[0].ts, sixth.ts);
  assert.equal(history.at(-1)?.input, 105);
});

test("getLastUsage returns the most recent record", () => {
  const store = makeStore();
  assert.equal(store.getLastUsage(), null);
  const first = store.record(pending(1) as Parameters<typeof store.record>[0]);
  assert.equal(store.getLastUsage(), first);
  const second = store.record(pending(2) as Parameters<typeof store.record>[0]);
  assert.equal(store.getLastUsage(), second);
});

test("setFooter with no context is a no-op", () => {
  const store = makeStore();
  store.record(pending(1) as Parameters<typeof store.record>[0]);
  assert.doesNotThrow(() => store.setFooter(undefined));
});
