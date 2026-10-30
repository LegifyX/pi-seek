import assert from "node:assert/strict";
import { test } from "node:test";
import { createBalanceStore } from "../src/balance.ts";
import type { HttpClient } from "../src/http.ts";
import { createTelemetryStore } from "../src/telemetry.ts";

// ---------------------------------------------------------------------------
// P2 accounting hardening: usage fixtures, surface separation, finiteness,
// and balance store behavior (TTL, stale fallback, unavailable vs zero).
// Everything here runs against local mocks/fixtures only.
// ---------------------------------------------------------------------------

type TelemetryStore = ReturnType<typeof createTelemetryStore>;
type PendingUsage = Parameters<TelemetryStore["record"]>[0];

const FETCH_FAILED = /fetch failed/;

const makeTelemetry = (): TelemetryStore =>
  createTelemetryStore({ defaultEffort: "high", enabled: true });

// Every required numeric field a PendingUsageRecord may carry, for finiteness
// sweeps. reasoning is optional and is asserted separately.
const numericPendingFields = (pending: PendingUsage): number[] => [
  pending.cacheRead,
  pending.cacheWrite,
  pending.input,
  pending.output,
  pending.totalTokens,
  pending.cost.cacheRead,
  pending.cost.cacheWrite,
  pending.cost.input,
  pending.cost.output,
  pending.cost.total,
];

const assertAllFinite = (values: number[]): void => {
  for (const value of values) {
    assert.ok(Number.isFinite(value), `expected a finite number, got ${value}`);
  }
};

// ---------------------------------------------------------------------------
// Responses usage fixtures
// ---------------------------------------------------------------------------

test("responses fixture: cached tokens split out of input", () => {
  const pending = makeTelemetry().mapResponsesUsage(
    {
      input_tokens: 1000,
      input_tokens_details: { cache_write_tokens: 100, cached_tokens: 400 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 120 },
      total_tokens: 1300,
    },
    "responses"
  );
  assert.equal(pending.input, 500);
  assert.equal(pending.cacheRead, 400);
  assert.equal(pending.cacheWrite, 100);
  assert.equal(pending.output, 200);
  assert.equal(pending.reasoning, 120);
  assert.equal(pending.totalTokens, 1300);
  assertAllFinite(numericPendingFields(pending));
});

test("responses fixture: reasoning maps from output_tokens_details", () => {
  const pending = makeTelemetry().mapResponsesUsage(
    {
      input_tokens: 10,
      input_tokens_details: {},
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 15,
    },
    "responses"
  );
  assert.equal(pending.reasoning, 3);
});

test("responses fixture: missing fields map to zeros and an absent reasoning", () => {
  const pending = makeTelemetry().mapResponsesUsage({}, "responses");
  assert.equal(pending.input, 0);
  assert.equal(pending.cacheRead, 0);
  assert.equal(pending.cacheWrite, 0);
  assert.equal(pending.output, 0);
  assert.equal(pending.reasoning, undefined);
  assert.equal(pending.totalTokens, 0);
  assertAllFinite(numericPendingFields(pending));
});

test("responses fixture: total_tokens fallback sums the present fields", () => {
  const pending = makeTelemetry().mapResponsesUsage(
    {
      input_tokens: 1000,
      input_tokens_details: { cache_write_tokens: 100, cached_tokens: 400 },
      output_tokens: 200,
    },
    "responses"
  );
  // input 500 + output 200 + cacheRead 400 + cacheWrite 100 = 1200
  assert.equal(pending.totalTokens, 1200);
});

test("responses fixture: zero values survive mapping", () => {
  const pending = makeTelemetry().mapResponsesUsage(
    {
      input_tokens: 0,
      input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
    "responses"
  );
  assert.equal(pending.input, 0);
  assert.equal(pending.cacheRead, 0);
  assert.equal(pending.cacheWrite, 0);
  assert.equal(pending.output, 0);
  assert.equal(pending.reasoning, 0);
  assert.equal(pending.totalTokens, 0);
});

test("responses fixture: malformed numbers collapse to 0 or absent", () => {
  const pending = makeTelemetry().mapResponsesUsage(
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
  assert.equal(pending.input, 0);
  assert.equal(pending.cacheRead, 0);
  assert.equal(pending.cacheWrite, 0);
  assert.equal(pending.output, 0);
  assert.equal(pending.reasoning, undefined);
  assert.equal(pending.totalTokens, 0);
  assertAllFinite(numericPendingFields(pending));
});

// ---------------------------------------------------------------------------
// Chat/FIM usage fixtures
// ---------------------------------------------------------------------------

test("chat fixture: hit tokens become cacheRead", () => {
  const pending = makeTelemetry().mapChatUsage(
    {
      completion_tokens: 50,
      prompt_cache_hit_tokens: 100,
      prompt_tokens: 100,
      total_tokens: 150,
    },
    "chat"
  );
  assert.equal(pending.input, 0);
  assert.equal(pending.cacheRead, 100);
  assert.equal(pending.output, 50);
  assert.equal(pending.cacheWrite, 0);
  assert.equal(pending.reasoning, undefined);
  assert.equal(pending.totalTokens, 150);
});

test("chat fixture: miss tokens stay separate from hit tokens", () => {
  const pending = makeTelemetry().mapChatUsage(
    {
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 20 },
      prompt_cache_hit_tokens: 30,
      prompt_cache_miss_tokens: 70,
      prompt_tokens: 100,
      total_tokens: 150,
    },
    "chat"
  );
  assert.equal(pending.input, 70);
  assert.equal(pending.cacheRead, 30);
  assert.equal(pending.cacheWrite, 0);
  assert.equal(pending.reasoning, 20);
  assert.equal(pending.totalTokens, 150);
});

test("chat fixture: reasoning comes from completion_tokens_details and is absent when missing", () => {
  const withReasoning = makeTelemetry().mapChatUsage(
    {
      completion_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 7 },
      prompt_tokens: 20,
    },
    "chat"
  );
  assert.equal(withReasoning.reasoning, 7);
  const withoutReasoning = makeTelemetry().mapChatUsage(
    { completion_tokens: 10, prompt_tokens: 20 },
    "chat"
  );
  assert.equal(withoutReasoning.reasoning, undefined);
});

test("chat fixture: malformed numbers collapse to 0 or absent", () => {
  const pending = makeTelemetry().mapChatUsage(
    {
      completion_tokens: Number.NaN,
      completion_tokens_details: { reasoning_tokens: Number.POSITIVE_INFINITY },
      prompt_cache_hit_tokens: Number.POSITIVE_INFINITY,
      prompt_cache_miss_tokens: Number.NaN,
      prompt_tokens: Number.NaN,
      total_tokens: Number.NaN,
    },
    "chat"
  );
  assert.equal(pending.input, 0);
  assert.equal(pending.cacheRead, 0);
  assert.equal(pending.cacheWrite, 0);
  assert.equal(pending.output, 0);
  assert.equal(pending.reasoning, undefined);
  assert.equal(pending.totalTokens, 0);
  assertAllFinite(numericPendingFields(pending));
});

// ---------------------------------------------------------------------------
// Surface separation: cross-surface field substitution must be ignored
// ---------------------------------------------------------------------------

test("cross-surface: Responses mapper ignores Chat/FIM fields with absurd values", () => {
  const pending = makeTelemetry().mapResponsesUsage(
    {
      completion_tokens: 9_000_000,
      completion_tokens_details: { reasoning_tokens: 9_100_000 },
      input_tokens: 1000,
      input_tokens_details: { cache_write_tokens: 100, cached_tokens: 400 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 120 },
      prompt_cache_hit_tokens: 9_200_000,
      prompt_cache_miss_tokens: 9_300_000,
      prompt_tokens: 9_400_000,
      total_tokens: 1300,
    },
    "responses"
  );
  assert.equal(pending.input, 500);
  assert.equal(pending.cacheRead, 400);
  assert.equal(pending.cacheWrite, 100);
  assert.equal(pending.output, 200);
  assert.equal(pending.reasoning, 120);
  assert.equal(pending.totalTokens, 1300);
});

test("cross-surface: Chat mapper ignores Responses fields, including input_tokens_details", () => {
  const pending = makeTelemetry().mapChatUsage(
    {
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 12 },
      input_tokens: 9_000_000,
      input_tokens_details: {
        cache_write_tokens: 9_100_000,
        cached_tokens: 9_200_000,
      },
      output_tokens: 9_300_000,
      output_tokens_details: { reasoning_tokens: 9_400_000 },
      prompt_cache_hit_tokens: 30,
      prompt_cache_miss_tokens: 60,
      prompt_tokens: 90,
      total_tokens: 140,
    },
    "chat"
  );
  assert.equal(pending.input, 60);
  assert.equal(pending.cacheRead, 30);
  assert.equal(pending.cacheWrite, 0);
  assert.equal(pending.output, 50);
  assert.equal(pending.reasoning, 12);
  assert.equal(pending.totalTokens, 140);
});

test("cross-surface: Chat mapper never reads input_tokens_details", () => {
  const pending = makeTelemetry().mapChatUsage(
    {
      input_tokens: 1234,
      input_tokens_details: { cache_write_tokens: 888, cached_tokens: 999 },
      output_tokens: 777,
      output_tokens_details: { reasoning_tokens: 555 },
    },
    "chat"
  );
  assert.equal(pending.input, 0);
  assert.equal(pending.cacheRead, 0);
  assert.equal(pending.cacheWrite, 0);
  assert.equal(pending.output, 0);
  assert.equal(pending.reasoning, undefined);
  assert.equal(pending.totalTokens, 0);
});

// ---------------------------------------------------------------------------
// record() finiteness
// ---------------------------------------------------------------------------

test("record: non-finite pending fields are sanitized to finite numbers", () => {
  const store = makeTelemetry();
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
  assertAllFinite([
    record.cacheRead,
    record.cacheWrite,
    record.input,
    record.output,
    record.totalTokens,
    record.hitRate,
    record.ts,
    record.cost.cacheRead,
    record.cost.cacheWrite,
    record.cost.input,
    record.cost.output,
    record.cost.total,
  ]);
});

test("record: mapped usage stays finite through the store", () => {
  const store = makeTelemetry();
  const responses = store.record(
    store.mapResponsesUsage(
      {
        input_tokens: Number.NaN,
        input_tokens_details: { cached_tokens: Number.POSITIVE_INFINITY },
        output_tokens: Number.NEGATIVE_INFINITY,
      },
      "responses"
    )
  );
  const chat = store.record(
    store.mapChatUsage(
      {
        completion_tokens: Number.POSITIVE_INFINITY,
        prompt_cache_hit_tokens: Number.NaN,
        prompt_tokens: Number.NaN,
      },
      "chat"
    )
  );
  for (const usageRecord of [responses, chat]) {
    assertAllFinite([
      usageRecord.cacheRead,
      usageRecord.cacheWrite,
      usageRecord.input,
      usageRecord.output,
      usageRecord.totalTokens,
      usageRecord.hitRate,
      usageRecord.ts,
      usageRecord.cost.total,
    ]);
  }
});

// ---------------------------------------------------------------------------
// Balance store: TTL, stale fallback, unavailable vs zero, finiteness
// ---------------------------------------------------------------------------

interface BalanceHttp {
  enqueue: (result: unknown | Error) => void;
  http: HttpClient;
}

// Deterministic stub that lets each test script the exact sequence of balance
// payloads (or failures) without touching globalThis.fetch.
const makeBalanceHttp = (): BalanceHttp => {
  const results: Array<unknown | Error> = [];
  const http: HttpClient = {
    getJson: () => {
      const result = results.shift();
      return result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
    },
    postJson: async () => ({}),
  };
  return { enqueue: (result) => results.push(result), http };
};

const balanceBody = (total: string, isAvailable = true): unknown => ({
  balance_infos: [
    {
      currency: "USD",
      granted_balance: "0.00",
      topped_up_balance: total,
      total_balance: total,
    },
  ],
  is_available: isAvailable,
});

test("balance store: TTL refresh fetches a fresh value after expiry", async () => {
  const harness = makeBalanceHttp();
  const store = createBalanceStore(harness.http, 0);
  harness.enqueue(balanceBody("10.00"));
  const first = await store.get();
  harness.enqueue(balanceBody("20.00"));
  const second = await store.get();
  assert.equal(first.entries[0]?.totalBalance, 10);
  assert.equal(second.entries[0]?.totalBalance, 20);
});

test("balance store: cached value is served inside the TTL without refetching", async () => {
  const harness = makeBalanceHttp();
  const store = createBalanceStore(harness.http, 60_000);
  harness.enqueue(balanceBody("10.00"));
  harness.enqueue(balanceBody("20.00"));
  const first = await store.get();
  const second = await store.get();
  assert.equal(first.entries[0]?.totalBalance, 10);
  assert.equal(second.entries[0]?.totalBalance, 10);
});

test("balance store: stale value is kept and the refresh failure rethrows", async () => {
  const harness = makeBalanceHttp();
  const store = createBalanceStore(harness.http, 0);
  harness.enqueue(balanceBody("10.00"));
  const first = await store.get();
  harness.enqueue(new Error("fetch failed"));
  await assert.rejects(store.get(), FETCH_FAILED);
  assert.equal(store.peek(), first);
});

test("balance store: unavailable payload carries isAvailable false", async () => {
  const harness = makeBalanceHttp();
  const store = createBalanceStore(harness.http);
  harness.enqueue(balanceBody("0.00", false));
  const balance = await store.get();
  assert.equal(balance.isAvailable, false);
  assert.equal(balance.entries[0]?.totalBalance, 0);
});

test("balance store: valid zero balance stays available and finite", async () => {
  const harness = makeBalanceHttp();
  const store = createBalanceStore(harness.http);
  harness.enqueue(balanceBody("0.00", true));
  const balance = await store.get();
  assert.equal(balance.isAvailable, true);
  assert.equal(balance.entries[0]?.totalBalance, 0);
  assert.ok(Number.isFinite(balance.entries[0]?.totalBalance));
});

test("balance store: malformed payload yields finite numbers and unavailable state", async () => {
  const harness = makeBalanceHttp();
  const store = createBalanceStore(harness.http);
  harness.enqueue({
    balance_infos: [
      {
        currency: "USD",
        granted_balance: "NaN",
        topped_up_balance: "Infinity",
        total_balance: "garbage",
      },
    ],
  });
  const balance = await store.get();
  assert.equal(balance.isAvailable, false);
  assert.deepEqual(balance.entries, []);
  assert.ok(Number.isFinite(balance.fetchedAt));
});

test("balance store: non-object payload yields an empty unavailable state", () => {
  const harness = makeBalanceHttp();
  const store = createBalanceStore(harness.http);
  harness.enqueue("definitely not a balance payload");
  return store.get().then((balance) => {
    assert.equal(balance.isAvailable, false);
    assert.deepEqual(balance.entries, []);
  });
});
