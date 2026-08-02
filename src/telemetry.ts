import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  COST,
  type DeepSeekRuntimeState,
  FOOTER_KEY,
  getNumber,
  getObject,
  isJsonObject,
  MODEL_ID,
  type PendingUsageRecord,
  PROVIDER_ID,
  TOKENS_PER_MILLION,
  USAGE_HISTORY_LIMIT,
  type UsageCost,
  type UsageRecord,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Telemetry store
// ---------------------------------------------------------------------------

export interface TelemetryStore {
  getHistory: () => UsageRecord[];
  getLastUsage: () => UsageRecord | null;
  mapChatUsage: (usage: unknown, source: string) => PendingUsageRecord;
  mapResponsesUsage: (usage: unknown, source: string) => PendingUsageRecord;
  record: (record: PendingUsageRecord) => UsageRecord;
  restore: (records: UsageRecord[]) => void;
  setFooter: (context?: ExtensionContext) => void;
}

const calculateCost = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number
): UsageCost => {
  const cost = {
    cacheRead: (cacheRead * COST.cacheRead) / TOKENS_PER_MILLION,
    cacheWrite: (cacheWrite * COST.cacheWrite) / TOKENS_PER_MILLION,
    input: (input * COST.input) / TOKENS_PER_MILLION,
    output: (output * COST.output) / TOKENS_PER_MILLION,
  };
  return {
    ...cost,
    total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite,
  };
};

export const createTelemetryStore = (
  runtimeState: DeepSeekRuntimeState
): TelemetryStore => {
  let lastUsage: UsageRecord | null = null;
  const usageHistory: UsageRecord[] = [];

  const record = (pending: PendingUsageRecord): UsageRecord => {
    const inputTotal = pending.cacheRead + pending.input;
    const fullRecord: UsageRecord = {
      ...pending,
      hitRate: inputTotal > 0 ? pending.cacheRead / inputTotal : 0,
      ts: Date.now(),
    };
    lastUsage = fullRecord;
    usageHistory.push(fullRecord);
    if (usageHistory.length > USAGE_HISTORY_LIMIT) {
      usageHistory.shift();
    }
    return fullRecord;
  };

  const restore = (records: UsageRecord[]): void => {
    // Key by ts plus identity fields: two distinct records sharing a
    // millisecond must not collapse, while true duplicates still dedupe
    // (last occurrence wins).
    const byTimestamp = new Map<string, UsageRecord>();
    for (const usageRecord of [...usageHistory, ...records]) {
      byTimestamp.set(
        `${usageRecord.ts}|${usageRecord.source}|${usageRecord.totalTokens}`,
        usageRecord
      );
    }
    const merged = [...byTimestamp.values()].sort((a, b) => a.ts - b.ts);
    usageHistory.length = 0;
    usageHistory.push(...merged.slice(-USAGE_HISTORY_LIMIT));
    if (!lastUsage) {
      lastUsage = usageHistory.at(-1) ?? null;
    }
  };

  const mapResponsesUsage = (
    rawUsage: unknown,
    source: string
  ): PendingUsageRecord => {
    const usage = isJsonObject(rawUsage) ? rawUsage : undefined;
    const inputDetails = getObject(usage, "input_tokens_details");
    const outputDetails = getObject(usage, "output_tokens_details");
    const inputTokens = getNumber(usage, "input_tokens") ?? 0;
    const cacheRead = getNumber(inputDetails, "cached_tokens") ?? 0;
    const cacheWrite = getNumber(inputDetails, "cache_write_tokens") ?? 0;
    const input = Math.max(0, inputTokens - cacheRead - cacheWrite);
    const output = getNumber(usage, "output_tokens") ?? 0;
    const reasoning = getNumber(outputDetails, "reasoning_tokens");
    return {
      cacheRead,
      cacheWrite,
      cost: calculateCost(input, output, cacheRead, cacheWrite),
      input,
      model: MODEL_ID,
      output,
      reasoning,
      source,
      totalTokens:
        getNumber(usage, "total_tokens") ?? input + output + cacheRead,
    };
  };

  const mapChatUsage = (
    rawUsage: unknown,
    source: string
  ): PendingUsageRecord => {
    const usage = isJsonObject(rawUsage) ? rawUsage : undefined;
    const cacheRead = getNumber(usage, "prompt_cache_hit_tokens") ?? 0;
    const promptTokens = getNumber(usage, "prompt_tokens") ?? 0;
    const input =
      getNumber(usage, "prompt_cache_miss_tokens") ??
      Math.max(0, promptTokens - cacheRead);
    const output = getNumber(usage, "completion_tokens") ?? 0;
    return {
      cacheRead,
      cacheWrite: 0,
      cost: calculateCost(input, output, cacheRead, 0),
      input,
      model: MODEL_ID,
      output,
      source,
      totalTokens:
        getNumber(usage, "total_tokens") ?? input + cacheRead + output,
    };
  };

  const setFooter = (context?: ExtensionContext): void => {
    if (!context) {
      return;
    }
    if (
      !runtimeState.enabled ||
      context.model?.provider !== PROVIDER_ID ||
      !lastUsage
    ) {
      context.ui.setStatus(FOOTER_KEY, undefined);
      return;
    }
    const cacheHit = (lastUsage.cacheRead / 1000).toFixed(1);
    const cacheMiss = (lastUsage.input / 1000).toFixed(1);
    context.ui.setStatus(
      FOOTER_KEY,
      `DS v4-flash · cache ${cacheHit}K hit / ${cacheMiss}K miss · $${lastUsage.cost.total.toFixed(4)}`
    );
  };

  return {
    getHistory: () => [...usageHistory],
    getLastUsage: () => lastUsage,
    mapChatUsage,
    mapResponsesUsage,
    record,
    restore,
    setFooter,
  };
};
