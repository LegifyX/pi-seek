import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BalanceStore } from "./balance.ts";
import {
  costForModel,
  type DeepSeekRuntimeState,
  FOOTER_KEY,
  formatBalance,
  getNumber,
  getObject,
  isJsonObject,
  MODEL_ID,
  type PendingUsageRecord,
  TOKENS_PER_MILLION,
  USAGE_HISTORY_LIMIT,
  type UsageCost,
  type UsageRecord,
} from "./config.ts";
import { formatPhase, isPeak } from "./peak.ts";

// ---------------------------------------------------------------------------
// Telemetry store
// ---------------------------------------------------------------------------

export interface TelemetryStore {
  getHistory: () => UsageRecord[];
  getLastUsage: () => UsageRecord | null;
  mapChatUsage: (
    usage: unknown,
    source: string,
    model?: string
  ) => PendingUsageRecord;
  mapResponsesUsage: (
    usage: unknown,
    source: string,
    model?: string
  ) => PendingUsageRecord;
  record: (record: PendingUsageRecord) => UsageRecord;
  restore: (records: UsageRecord[]) => void;
  setFooter: (context?: ExtensionContext, balance?: BalanceStore) => void;
}

// Malformed usage fields (NaN/±Infinity) must never leak into produced
// numbers: they collapse to 0 for required fields and to absent for the
// optional reasoning field. Real JSON cannot carry non-finite numbers, but
// mocks and downstream transforms can, so every number read here is guarded.
const finite = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) ? value : undefined;

const calculateCost = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  model: string
): UsageCost => {
  const prices = costForModel(model);
  const cost = {
    cacheRead: (cacheRead * prices.cacheRead) / TOKENS_PER_MILLION,
    cacheWrite: (cacheWrite * prices.cacheWrite) / TOKENS_PER_MILLION,
    input: (input * prices.input) / TOKENS_PER_MILLION,
    output: (output * prices.output) / TOKENS_PER_MILLION,
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
    // Normalize every stored number so the ledger never carries NaN or
    // ±Infinity, no matter what a caller hands in. The dedupe/restore key is
    // computed after normalization, so it always sees finite values.
    const cacheRead = finite(pending.cacheRead) ?? 0;
    const cacheWrite = finite(pending.cacheWrite) ?? 0;
    const input = finite(pending.input) ?? 0;
    const output = finite(pending.output) ?? 0;
    const costInput = finite(pending.cost.input) ?? 0;
    const costOutput = finite(pending.cost.output) ?? 0;
    const costCacheRead = finite(pending.cost.cacheRead) ?? 0;
    const costCacheWrite = finite(pending.cost.cacheWrite) ?? 0;
    const totalTokens = finite(pending.totalTokens) ?? 0;
    const reasoning = finite(pending.reasoning);
    const inputTotal = cacheRead + input;
    const fullRecord: UsageRecord = {
      cacheRead,
      cacheWrite,
      cost: {
        cacheRead: costCacheRead,
        cacheWrite: costCacheWrite,
        input: costInput,
        output: costOutput,
        total: costInput + costOutput + costCacheRead + costCacheWrite,
      },
      hitRate: inputTotal > 0 ? cacheRead / inputTotal : 0,
      input,
      model: pending.model,
      output,
      reasoning,
      source: pending.source,
      totalTokens,
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
    source: string,
    model: string = MODEL_ID
  ): PendingUsageRecord => {
    // Responses surface only: never read Chat/FIM field names here.
    const usage = isJsonObject(rawUsage) ? rawUsage : undefined;
    const inputDetails = getObject(usage, "input_tokens_details");
    const outputDetails = getObject(usage, "output_tokens_details");
    const inputTokens = finite(getNumber(usage, "input_tokens")) ?? 0;
    const cacheRead = finite(getNumber(inputDetails, "cached_tokens")) ?? 0;
    const cacheWrite =
      finite(getNumber(inputDetails, "cache_write_tokens")) ?? 0;
    const input = Math.max(0, inputTokens - cacheRead - cacheWrite);
    const output = finite(getNumber(usage, "output_tokens")) ?? 0;
    const reasoning = finite(getNumber(outputDetails, "reasoning_tokens"));
    return {
      cacheRead,
      cacheWrite,
      cost: calculateCost(input, output, cacheRead, cacheWrite, model),
      input,
      model,
      output,
      reasoning,
      source,
      totalTokens:
        finite(getNumber(usage, "total_tokens")) ??
        input + output + cacheRead + cacheWrite,
    };
  };

  const mapChatUsage = (
    rawUsage: unknown,
    source: string,
    model: string = MODEL_ID
  ): PendingUsageRecord => {
    // Chat/FIM surface only: never read Responses field names here.
    const usage = isJsonObject(rawUsage) ? rawUsage : undefined;
    const outputDetails = getObject(usage, "completion_tokens_details");
    const cacheRead = finite(getNumber(usage, "prompt_cache_hit_tokens")) ?? 0;
    const promptTokens = finite(getNumber(usage, "prompt_tokens")) ?? 0;
    const missTokens = finite(getNumber(usage, "prompt_cache_miss_tokens"));
    const input = missTokens ?? Math.max(0, promptTokens - cacheRead);
    const output = finite(getNumber(usage, "completion_tokens")) ?? 0;
    const reasoning = finite(getNumber(outputDetails, "reasoning_tokens"));
    return {
      cacheRead,
      cacheWrite: 0,
      cost: calculateCost(input, output, cacheRead, 0, model),
      input,
      model,
      output,
      reasoning,
      source,
      totalTokens:
        finite(getNumber(usage, "total_tokens")) ?? input + cacheRead + output,
    };
  };

  const setFooter = (
    context?: ExtensionContext,
    balance?: BalanceStore
  ): void => {
    if (!context) {
      return;
    }
    if (!runtimeState.enabled) {
      context.ui.setStatus(FOOTER_KEY, undefined);
      return;
    }
    // This row carries what the host cannot know: the billing window and the
    // wallet. Cache and cost already have segments of their own. The value is
    // rendered verbatim by the statusline plugin, so it styles itself, and every
    // run ends on a reset. See "extensionStatusRaw" in pi-statusline. It belongs
    // to the account, not to the selected model: the phase is a clock fact and
    // the wallet is fetched from the stored key, so it stays visible on every
    // model. A status row must never throw, so an unstyled host renders plain.
    const paint = (
      color: "success" | "warning" | "muted",
      text: string
    ): string => (context.ui.theme ? context.ui.theme.fg(color, text) : text);
    const peak = isPeak();
    const phase = paint(
      peak ? "warning" : "success",
      `${peak ? "☀" : "☾"} ${formatPhase()}`
    );
    // The label is the host's job: pi-statusline prefixes the status key, and a
    // key listed in its extensionStatusRaw gets this value verbatim instead.
    // Writing "ds" here too would double it in the first case.
    const status = phase;
    context.ui.setStatus(FOOTER_KEY, status);
    if (!balance) {
      return;
    }
    // Fire-and-forget balance refresh (TTL-cached, at most one GET per TTL):
    // the phase is set synchronously and the wallet lands when the fetch
    // settles; a failed fetch keeps the phase-only line.
    balance
      .get()
      .then((state) => {
        if (!runtimeState.enabled) {
          return;
        }
        const balanceLabel = state.isAvailable
          ? formatBalance(state.entries)
          : "unavailable";
        context.ui.setStatus(
          FOOTER_KEY,
          `${status} · ${paint("muted", balanceLabel)}`
        );
      })
      .catch(() => undefined);
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
