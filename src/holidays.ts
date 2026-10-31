// Chinese statutory holidays bill off-peak all day, so the phase needs a
// calendar DeepSeek does not expose over the API. The State Council publishes
// one year at a time and it never follows a computable rule, so the dates are
// fetched from the maintained feed published by xavier711/dsh-deepseek-usage
// (the same file its own DeepSeek usage panel reads, refreshed every 6 h) and
// cached on disk. A cold cache with an unreachable feed falls back to the 2026
// notice below: holidays then read as peak, which overstates cost by 2x at
// worst and never understates it.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CALENDAR_URL =
  "https://raw.githubusercontent.com/xavier711/dsh-deepseek-usage/main/holidays.json";
export const CALENDAR_CACHE_BASENAME = "pi-seek-holidays.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 400;
const FETCH_TIMEOUT_MS = 10_000;

interface HolidayRange {
  end: string;
  name?: string;
  start: string;
}

export interface HolidayCalendar {
  dates: string[];
  source: "cache" | "network" | "fallback";
}

// 国务院办公厅关于2026年部分节假日安排的通知, as published in the feed above.
const FALLBACK_2026: HolidayRange[] = [
  { end: "2026-01-03", name: "元旦", start: "2026-01-01" },
  { end: "2026-02-23", name: "春节", start: "2026-02-15" },
  { end: "2026-04-06", name: "清明节", start: "2026-04-04" },
  { end: "2026-05-05", name: "劳动节", start: "2026-05-01" },
  { end: "2026-06-21", name: "端午节", start: "2026-06-19" },
  { end: "2026-09-27", name: "中秋节", start: "2026-09-25" },
  { end: "2026-10-07", name: "国庆节", start: "2026-10-01" },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const toDateKey = (value: unknown): string | undefined =>
  typeof value === "string" && DATE_KEY_PATTERN.test(value) ? value : undefined;

const expandRange = (range: HolidayRange): string[] => {
  const start = Date.parse(`${range.start}T00:00:00Z`);
  const end = Date.parse(`${range.end}T00:00:00Z`);
  if (!(Number.isFinite(start) && Number.isFinite(end)) || end < start) {
    return [];
  }
  const dates: string[] = [];
  for (
    let ms = start;
    ms <= end && dates.length < MAX_RANGE_DAYS;
    ms += DAY_MS
  ) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
};

const parseRanges = (value: unknown): HolidayRange[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const ranges: HolidayRange[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const start = toDateKey(entry.start);
    const end = toDateKey(entry.end) ?? start;
    if (start && end) {
      ranges.push({ end, start });
    }
  }
  return ranges;
};

// The feed groups ranges per year: { years: { "2026": [{ start, end, name }] } }.
// `workdays` (make-up working Saturdays) is deliberately ignored: DeepSeek
// bills those off-peak too, so a weekday+holiday test already covers them.
export const expandCalendar = (payload: unknown): string[] => {
  if (!isRecord(payload)) {
    return [];
  }
  const years = isRecord(payload.years) ? Object.values(payload.years) : [];
  const ranges = years.flatMap((year) => parseRanges(year));
  return [...new Set(ranges.flatMap(expandRange))].sort();
};

const cachePath = (agentDir: string): string =>
  join(agentDir, CALENDAR_CACHE_BASENAME);

const readCache = async (
  agentDir: string
): Promise<{ dates: string[]; fetchedAt: number } | undefined> => {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(cachePath(agentDir), "utf8")
    );
    if (!isRecord(parsed)) {
      return;
    }
    const dates = Array.isArray(parsed.dates)
      ? parsed.dates.filter((date): date is string => typeof date === "string")
      : [];
    if (dates.length === 0) {
      return;
    }
    return {
      dates,
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
    };
  } catch {
    // A missing or corrupt cache is a miss, not an error.
  }
};

const fetchCalendar = async (): Promise<string[]> => {
  const response = await fetch(CALENDAR_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`holiday feed returned ${response.status}`);
  }
  const dates = expandCalendar(await response.json());
  if (dates.length === 0) {
    throw new Error("holiday feed carried no dates");
  }
  return dates;
};

const writeCache = async (agentDir: string, dates: string[]): Promise<void> => {
  try {
    await writeFile(
      cachePath(agentDir),
      `${JSON.stringify({ dates, fetchedAt: Date.now() }, null, "\t")}\n`,
      "utf8"
    );
  } catch {
    // A read-only agent dir must not cost the phase its calendar.
  }
};

/** Billing-calendar dates DeepSeek bills off-peak all day. Never throws. */
export const loadHolidayCalendar = async (
  options: { agentDir?: string; now?: number } = {}
): Promise<HolidayCalendar> => {
  const agentDir = options.agentDir ?? getAgentDir();
  const now = options.now ?? Date.now();
  const cached = await readCache(agentDir);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { dates: cached.dates, source: "cache" };
  }
  try {
    const dates = await fetchCalendar();
    await writeCache(agentDir, dates);
    return { dates, source: "network" };
  } catch {
    return cached
      ? { dates: cached.dates, source: "cache" }
      : { dates: FALLBACK_2026.flatMap(expandRange), source: "fallback" };
  }
};
