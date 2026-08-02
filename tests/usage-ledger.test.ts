import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../deepseek-v4.ts";

type UsageRecord = Parameters<
  ReturnType<typeof __test.createTelemetryStore>["restore"]
>[0][number];

type BranchEntry = Parameters<typeof __test.collectUsageRecords>[0][number];

const makeStore = (): ReturnType<typeof __test.createTelemetryStore> =>
  __test.createTelemetryStore({ defaultEffort: "high", enabled: true });

const makeRecord = (
  ts: number,
  overrides: Partial<UsageRecord> = {}
): UsageRecord => ({
  cacheRead: 1,
  cacheWrite: 0,
  cost: {
    cacheRead: 0.000_002_8,
    cacheWrite: 0,
    input: 0.000_001_4,
    output: 0,
    total: 0.000_004_2,
  },
  hitRate: 0.1,
  input: 10,
  model: "deepseek-v4-flash",
  output: 2,
  source: "test",
  totalTokens: 13,
  ts,
  ...overrides,
});

const usageEntry = (record: UsageRecord): BranchEntry =>
  ({
    customType: "ds-usage",
    data: record,
    type: "custom",
  }) as BranchEntry;

test("restore replays records in chronological order", () => {
  const store = makeStore();
  store.restore([makeRecord(300), makeRecord(100), makeRecord(200)]);
  assert.deepEqual(
    store.getHistory().map((record) => record.ts),
    [100, 200, 300]
  );
});

test("restore dedupes by timestamp, keeping the last occurrence", () => {
  const store = makeStore();
  store.restore([makeRecord(100, { input: 1 }), makeRecord(100, { input: 2 })]);
  const history = store.getHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].input, 2);
});

test("restore keeps distinct records that share a timestamp", () => {
  const store = makeStore();
  store.restore([
    makeRecord(100, { source: "a", totalTokens: 10 }),
    makeRecord(100, { source: "b", totalTokens: 20 }),
  ]);
  const history = store.getHistory();
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((record) => record.totalTokens).sort((a, b) => a - b),
    [10, 20]
  );
});

test("restore keeps records that differ only by source", () => {
  const store = makeStore();
  store.restore([
    makeRecord(100, { source: "test" }),
    makeRecord(100, { source: "other" }),
  ]);
  const history = store.getHistory();
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((record) => record.source).sort(), [
    "other",
    "test",
  ]);
});

test("restore keeps only the newest 100 records", () => {
  const store = makeStore();
  store.restore(Array.from({ length: 105 }, (_, i) => makeRecord(i + 1)));
  const history = store.getHistory();
  assert.equal(history.length, 100);
  assert.equal(history[0].ts, 6);
  assert.equal(history.at(-1)?.ts, 105);
});

test("restore merges with existing in-memory history without duplicating", () => {
  const store = makeStore();
  const recorded = store.record({
    cacheRead: 1,
    cacheWrite: 0,
    cost: {
      cacheRead: 0.000_002_8,
      cacheWrite: 0,
      input: 0.000_001_4,
      output: 0,
      total: 0.000_004_2,
    },
    input: 10,
    model: "deepseek-v4-flash",
    output: 2,
    source: "test",
    totalTokens: 13,
  });
  store.restore([recorded, makeRecord(recorded.ts - 1000)]);
  const history = store.getHistory();
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((record) => record.ts).sort((a, b) => a - b),
    [recorded.ts - 1000, recorded.ts]
  );
});

test("summarizeUsage totals calls, tokens, and estimated cost", () => {
  const summary = __test.summarizeUsage([
    makeRecord(100, { input: 10, output: 2 }),
    makeRecord(200, { input: 20, output: 4 }),
    makeRecord(300, { input: 30, output: 6 }),
  ]);
  assert.equal(summary.calls, 3);
  assert.equal(summary.input, 60);
  assert.equal(summary.output, 12);
  assert.equal(summary.cacheRead, 3);
  assert.ok(Math.abs(summary.costTotal - 3 * 0.000_004_2) < 1e-12);
});

test("summarizeUsage filters by sinceTs", () => {
  const summary = __test.summarizeUsage(
    [makeRecord(100, { input: 10 }), makeRecord(200, { input: 20 })],
    200
  );
  assert.equal(summary.calls, 1);
  assert.equal(summary.input, 20);
});

test("collectUsageRecords extracts ds-usage entries and skips everything else", () => {
  const valid = makeRecord(100);
  const branch = [
    usageEntry(valid),
    {
      customType: "other",
      data: { anything: true },
      type: "custom",
    },
    {
      customType: "ds-usage",
      data: { not: "a usage record" },
      type: "custom",
    },
    {
      message: { role: "user" },
      type: "message",
    },
  ] as BranchEntry[];
  const records = __test.collectUsageRecords(branch);
  assert.equal(records.length, 1);
  assert.equal(records[0], valid);
});

test("round trip: branch entries restore into the store", () => {
  const store = makeStore();
  const branch = [
    usageEntry(makeRecord(100, { input: 1 })),
    usageEntry(makeRecord(200, { input: 2 })),
  ];
  store.restore(__test.collectUsageRecords(branch));
  const history = store.getHistory();
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((record) => record.input),
    [1, 2]
  );
});
