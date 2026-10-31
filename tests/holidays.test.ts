import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  CALENDAR_CACHE_BASENAME,
  CALENDAR_URL,
  expandCalendar,
  loadHolidayCalendar,
} from "../src/holidays.ts";

// The feed is the upstream plugin's holidays.json: one array of {start,end}
// ranges per year, plus a `workdays` list this extension deliberately ignores.
const FEED = {
  source: "国务院办公厅关于2026年部分节假日安排的通知",
  updatedAt: "2025-11-04",
  version: 1,
  workdays: ["2026-09-19"],
  years: {
    "2026": [
      { end: "2026-10-07", name: "国庆节", start: "2026-10-01" },
      { end: "2026-09-27", name: "中秋节", start: "2026-09-25" },
    ],
  },
};

const realFetch = globalThis.fetch;

const stubFetch = (impl: () => Promise<Response>): void => {
  globalThis.fetch = impl as typeof globalThis.fetch;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("expandCalendar expands inclusive days and sorts them", () => {
  const dates = expandCalendar(FEED);
  assert.equal(dates.length, 3 + 7);
  assert.deepEqual(dates.slice(0, 3), [
    "2026-09-25",
    "2026-09-26",
    "2026-09-27",
  ]);
  assert.equal(dates.at(-1), "2026-10-07");
  assert.deepEqual(dates, [...new Set(dates)].sort());
});

test("expandCalendar ignores workdays and survives junk payloads", () => {
  assert.ok(!expandCalendar(FEED).includes("2026-09-19"));
  assert.deepEqual(expandCalendar(undefined), []);
  assert.deepEqual(
    expandCalendar({ years: { "2026": [{ start: "nope" }] } }),
    []
  );
  // A missing end means a one-day holiday; an inverted range is dropped.
  assert.deepEqual(
    expandCalendar({ years: { "2026": [{ start: "2026-01-01" }] } }),
    ["2026-01-01"]
  );
  assert.deepEqual(
    expandCalendar({
      years: { "2026": [{ end: "2026-01-01", start: "2026-01-05" }] },
    }),
    []
  );
});

test("loadHolidayCalendar caches a fetched feed and reuses it when offline", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-seek-holidays-"));
  stubFetch(async () => new Response(JSON.stringify(FEED), { status: 200 }));

  const fetched = await loadHolidayCalendar({ agentDir });
  assert.equal(fetched.source, "network");
  assert.ok(fetched.dates.includes("2026-10-01"));

  const cache = JSON.parse(
    await readFile(join(agentDir, CALENDAR_CACHE_BASENAME), "utf8")
  ) as { dates: string[]; fetchedAt: number };
  assert.deepEqual(cache.dates, fetched.dates);
  assert.equal(typeof cache.fetchedAt, "number");

  // Offline, still inside the TTL: the cache answers without a request.
  stubFetch(() => Promise.reject(new Error("network down")));
  const cached = await loadHolidayCalendar({ agentDir });
  assert.equal(cached.source, "cache");
  assert.deepEqual(cached.dates, fetched.dates);
});

test("loadHolidayCalendar falls back to the built-in 2026 table when cold and offline", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-seek-holidays-"));
  stubFetch(() => Promise.reject(new Error("network down")));

  const calendar = await loadHolidayCalendar({ agentDir });
  assert.equal(calendar.source, "fallback");
  assert.ok(calendar.dates.includes("2026-10-01"));
  assert.ok(calendar.dates.includes("2026-10-07"));
});

test("loadHolidayCalendar treats a feed with no dates as a failure", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-seek-holidays-"));
  stubFetch(
    async () => new Response(JSON.stringify({ years: {} }), { status: 200 })
  );

  const calendar = await loadHolidayCalendar({ agentDir });
  assert.equal(calendar.source, "fallback");
  assert.equal(CALENDAR_URL.endsWith("holidays.json"), true);
});
