import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  BALANCE_TTL_MS,
  BALANCE_URL,
  type BalanceState,
  isJsonObject,
  parseBalance,
  USAGE_ENTRY,
  type UsageRecord,
  type UsageSummary,
} from "./config.ts";
import type { HttpClient } from "./http.ts";

// ---------------------------------------------------------------------------
// Balance store + usage ledger helpers
// ---------------------------------------------------------------------------

export interface BalanceStore {
  get: () => Promise<BalanceState>;
  peek: () => BalanceState | null;
}

// Lazy-refreshing cache: balance changes slowly and the endpoint is a network
// round trip, so serve a fresh value for BALANCE_TTL_MS and keep the stale
// value on fetch failure (the caller decides how to surface it).
export const createBalanceStore = (
  http: HttpClient,
  ttlMs = BALANCE_TTL_MS
): BalanceStore => {
  let cached: BalanceState | null = null;

  const get = async (): Promise<BalanceState> => {
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      return cached;
    }
    const balance = {
      ...parseBalance(await http.getJson(BALANCE_URL)),
      fetchedAt: Date.now(),
    };
    cached = balance;
    return balance;
  };

  const peek = (): BalanceState | null => cached;

  return { get, peek };
};

export const summarizeUsage = (
  records: UsageRecord[],
  sinceTs?: number
): UsageSummary => {
  const included =
    sinceTs === undefined ? records : records.filter((r) => r.ts >= sinceTs);
  return {
    cacheRead: included.reduce((sum, record) => sum + record.cacheRead, 0),
    calls: included.length,
    costTotal: included.reduce((sum, record) => sum + record.cost.total, 0),
    input: included.reduce((sum, record) => sum + record.input, 0),
    output: included.reduce((sum, record) => sum + record.output, 0),
  };
};

const isUsageRecord = (value: unknown): value is UsageRecord =>
  isJsonObject(value) &&
  typeof value.ts === "number" &&
  typeof value.input === "number" &&
  typeof value.output === "number" &&
  isJsonObject(value.cost) &&
  typeof value.cost.total === "number";

export const collectUsageRecords = (
  branch: readonly SessionEntry[]
): UsageRecord[] => {
  const records: UsageRecord[] = [];
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== USAGE_ENTRY) {
      continue;
    }
    if (isUsageRecord(entry.data)) {
      records.push(entry.data);
    }
  }
  return records;
};
