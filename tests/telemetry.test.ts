import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../src/index.ts";

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

test("mapChatUsage: maps completion_tokens_details.reasoning_tokens", () => {
  const usage = makeStore().mapChatUsage(
    {
      completion_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 12 },
      prompt_cache_hit_tokens: 30,
      prompt_cache_miss_tokens: 60,
      prompt_tokens: 90,
      total_tokens: 130,
    },
    "chat"
  );
  assert.equal(usage.reasoning, 12);
});

test("mapChatUsage: reasoning is absent when the detail field is missing", () => {
  const withoutDetails = makeStore().mapChatUsage(
    { completion_tokens: 10, prompt_tokens: 10 },
    "chat"
  );
  assert.equal(withoutDetails.reasoning, undefined);
  const emptyDetails = makeStore().mapChatUsage(
    { completion_tokens: 10, completion_tokens_details: {}, prompt_tokens: 10 },
    "chat"
  );
  assert.equal(emptyDetails.reasoning, undefined);
});

test("mapResponsesUsage: reasoning is absent when missing", () => {
  const usage = makeStore().mapResponsesUsage(
    { input_tokens: 10, output_tokens: 5 },
    "responses"
  );
  assert.equal(usage.reasoning, undefined);
});

test("mapResponsesUsage: zero values are preserved", () => {
  const usage = makeStore().mapResponsesUsage(
    {
      input_tokens: 0,
      input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
    "responses"
  );
  assert.equal(usage.input, 0);
  assert.equal(usage.cacheRead, 0);
  assert.equal(usage.cacheWrite, 0);
  assert.equal(usage.output, 0);
  assert.equal(usage.reasoning, 0);
  assert.equal(usage.totalTokens, 0);
});

test("mapResponsesUsage: ignores Chat/FIM fields with absurd values", () => {
  const usage = makeStore().mapResponsesUsage(
    {
      completion_tokens: 7_000_000,
      completion_tokens_details: { reasoning_tokens: 8_000_000 },
      input_tokens: 1000,
      input_tokens_details: { cache_write_tokens: 100, cached_tokens: 400 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 120 },
      prompt_cache_hit_tokens: 9_000_000,
      prompt_cache_miss_tokens: 9_100_000,
      prompt_tokens: 9_200_000,
      total_tokens: 1300,
    },
    "responses"
  );
  assert.equal(usage.input, 500);
  assert.equal(usage.cacheRead, 400);
  assert.equal(usage.cacheWrite, 100);
  assert.equal(usage.output, 200);
  assert.equal(usage.reasoning, 120);
  assert.equal(usage.totalTokens, 1300);
});

test("mapChatUsage: ignores Responses fields and never reads input_tokens_details", () => {
  const usage = makeStore().mapChatUsage(
    {
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 12 },
      input_tokens: 7_000_000,
      input_tokens_details: {
        cache_write_tokens: 8_000_000,
        cached_tokens: 9_000_000,
      },
      output_tokens: 9_100_000,
      output_tokens_details: { reasoning_tokens: 9_200_000 },
      prompt_cache_hit_tokens: 30,
      prompt_cache_miss_tokens: 60,
      prompt_tokens: 90,
      total_tokens: 140,
    },
    "chat"
  );
  assert.equal(usage.input, 60);
  assert.equal(usage.cacheRead, 30);
  assert.equal(usage.cacheWrite, 0);
  assert.equal(usage.output, 50);
  assert.equal(usage.reasoning, 12);
  assert.equal(usage.totalTokens, 140);
});

test("mapChatUsage: a payload with only input_tokens_details maps to zeros", () => {
  const usage = makeStore().mapChatUsage(
    {
      input_tokens: 1234,
      input_tokens_details: { cache_write_tokens: 888, cached_tokens: 999 },
      output_tokens: 777,
      output_tokens_details: { reasoning_tokens: 555 },
    },
    "chat"
  );
  assert.equal(usage.input, 0);
  assert.equal(usage.cacheRead, 0);
  assert.equal(usage.cacheWrite, 0);
  assert.equal(usage.output, 0);
  assert.equal(usage.reasoning, undefined);
  assert.equal(usage.totalTokens, 0);
});

test("mapResponsesUsage: malformed numbers collapse to 0 or absent, never NaN", () => {
  const usage = makeStore().mapResponsesUsage(
    {
      input_tokens: Number.NaN,
      input_tokens_details: {
        cache_write_tokens: Number.POSITIVE_INFINITY,
        cached_tokens: Number.NEGATIVE_INFINITY,
      },
      output_tokens: Number.NaN,
      output_tokens_details: { reasoning_tokens: Number.POSITIVE_INFINITY },
      total_tokens: Number.NaN,
    },
    "responses"
  );
  assert.equal(usage.input, 0);
  assert.equal(usage.cacheRead, 0);
  assert.equal(usage.cacheWrite, 0);
  assert.equal(usage.output, 0);
  assert.equal(usage.reasoning, undefined);
  assert.equal(usage.totalTokens, 0);
  assert.ok(Number.isFinite(usage.cost.total));
});

test("mapChatUsage: malformed numbers collapse to 0 or absent, never NaN", () => {
  const usage = makeStore().mapChatUsage(
    {
      completion_tokens: Number.NaN,
      completion_tokens_details: {
        reasoning_tokens: Number.POSITIVE_INFINITY,
      },
      prompt_cache_hit_tokens: Number.NaN,
      prompt_cache_miss_tokens: Number.NaN,
      prompt_tokens: Number.NaN,
      total_tokens: Number.NaN,
    },
    "chat"
  );
  assert.equal(usage.input, 0);
  assert.equal(usage.cacheRead, 0);
  assert.equal(usage.output, 0);
  assert.equal(usage.reasoning, undefined);
  assert.equal(usage.totalTokens, 0);
  assert.ok(Number.isFinite(usage.cost.total));
});

test("mapResponsesUsage: clamps negative input to 0 when cached exceeds input", () => {
  const usage = makeStore().mapResponsesUsage(
    {
      input_tokens: 10,
      input_tokens_details: { cache_write_tokens: 4, cached_tokens: 30 },
      output_tokens: 5,
    },
    "responses"
  );
  assert.equal(usage.input, 0);
  assert.equal(usage.totalTokens, 39);
});

test("record: sanitizes non-finite pending fields to finite values", () => {
  const store = makeStore();
  const record = store.record({
    cacheRead: Number.NaN,
    cacheWrite: Number.POSITIVE_INFINITY,
    cost: {
      cacheRead: Number.NaN,
      cacheWrite: Number.POSITIVE_INFINITY,
      input: Number.NEGATIVE_INFINITY,
      output: Number.NaN,
      total: Number.NaN,
    },
    input: Number.NaN,
    model: "deepseek-v4-flash",
    output: Number.POSITIVE_INFINITY,
    reasoning: Number.NaN,
    source: "test",
    totalTokens: Number.NEGATIVE_INFINITY,
  });
  assert.equal(record.cacheRead, 0);
  assert.equal(record.cacheWrite, 0);
  assert.equal(record.input, 0);
  assert.equal(record.output, 0);
  assert.equal(record.totalTokens, 0);
  assert.equal(record.reasoning, undefined);
  assert.equal(record.hitRate, 0);
  assert.equal(record.cost.total, 0);
  assert.ok(Number.isFinite(record.ts));
});

test("record: preserves a finite reasoning value", () => {
  const store = makeStore();
  const record = store.record(
    pending(10, { reasoning: 5 }) as Parameters<typeof store.record>[0]
  );
  assert.equal(record.reasoning, 5);
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

test("cost math for V4 Pro: input 1M -> 0.435, output 1M -> 0.87, cacheRead 1M -> 0.003625", () => {
  const store = makeStore();
  const inputOnly = store.record(
    store.mapChatUsage(
      { completion_tokens: 0, prompt_tokens: 1_000_000 },
      "chat",
      "deepseek-v4-pro"
    )
  );
  assert.equal(inputOnly.model, "deepseek-v4-pro");
  assert.equal(inputOnly.cost.input, 0.435);
  const outputOnly = store.record(
    store.mapChatUsage(
      { completion_tokens: 1_000_000, prompt_tokens: 0 },
      "chat",
      "deepseek-v4-pro"
    )
  );
  assert.equal(outputOnly.cost.output, 0.87);
  const cacheOnly = store.record(
    store.mapChatUsage(
      {
        completion_tokens: 0,
        prompt_cache_hit_tokens: 1_000_000,
        prompt_tokens: 1_000_000,
      },
      "chat",
      "deepseek-v4-pro"
    )
  );
  assert.equal(cacheOnly.cost.cacheRead, 0.003_625);
  assert.equal(cacheOnly.cost.cacheWrite, 0);
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
