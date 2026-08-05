// Configuration and shared types
// ---------------------------------------------------------------------------
// Configuration and shared types
// ---------------------------------------------------------------------------

export const PROVIDER_ID = "deepseek-responses";
export const MODEL_ID = "deepseek-v4-flash";
export const BASE_URL = "https://api.deepseek.com";
export const BETA_URL = "https://api.deepseek.com/beta";
export const API_KEY_ENV = "DEEPSEEK_API_KEY";
const REQUEST_TIMEOUT_MS = 90_000;
const TIMEOUT_MS_PER_TOKEN = 1; // 1ms per requested output token beyond the base
const TIMEOUT_ENV = "DEEPSEEK_REQUEST_TIMEOUT_S"; // seconds; absolute override

export const resolveTimeoutMs = (body: unknown): number => {
  const envValue = Number(process.env[TIMEOUT_ENV]);
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue * 1000;
  }
  // Scale on whichever token cap the body carries: Responses requests use
  // max_output_tokens, beta chat/completion requests use max_tokens.
  const tokenBudget = isJsonObject(body)
    ? Math.max(
        getNumber(body, "max_output_tokens") ?? 0,
        getNumber(body, "max_tokens") ?? 0
      )
    : 0;
  const tokens = tokenBudget;
  return tokens > 0
    ? REQUEST_TIMEOUT_MS + tokens * TIMEOUT_MS_PER_TOKEN
    : REQUEST_TIMEOUT_MS;
};

export const DEFAULT_EFFORT = "high";
export const FOOTER_KEY = "ds-cache";
export const THREADS_ENTRY = "ds-reply";
export const CACHE_CARD_ENTRY = "ds-cache-card";
export const BALANCE_ENTRY = "ds-balance-card";
export const USAGE_ENTRY = "ds-usage";
export const MENU_STATUS_KEY = "deepseek-menu";
export const BALANCE_URL = "/user/balance";
export const BALANCE_TTL_MS = 60_000;
export const CONTEXT_WINDOW = 1_048_576;
export const MAX_OUTPUT_TOKENS = 393_216;
export const USAGE_HISTORY_LIMIT = 100;
export const TOKENS_PER_MILLION = 1_000_000;

// Bounded thread replay: threads never replay more than THREAD_MAX_ITEMS
// items or THREAD_MAX_CHARS characters (whichever binds first); oldest items
// are dropped, keeping the most recent user message. The context-length
// trim-and-retry targets half of these caps so the retried request fits
// comfortably.
export const THREAD_MAX_ITEMS = 200;
export const THREAD_MAX_CHARS = 600_000;
export const CONTEXT_RETRY_MAX_ITEMS = 100;
export const CONTEXT_RETRY_MAX_CHARS = 300_000;

// Time note injected into ds_chat instructions (see prependTimeNote).
// Minute precision keeps the note bounded and stable enough that repeated
// calls within the same minute do not churn the prompt cache.
export const TIME_NOTE_PATTERN = /current\s*time\s*[:：]?/i;

// Bounded ISO 8601 UTC timestamp, e.g. "2025-08-02T12:34Z".
export const formatTimeNote = (now: Date): string =>
  `Current time: ${now.toISOString().slice(0, 16)}Z.`;

export const systemHasTimeNote = (system: string | undefined): boolean =>
  system !== undefined && TIME_NOTE_PATTERN.test(system);

// Prepends a fresh time note unless the system already carries one. Callers
// decide when injection applies (ds_chat injects only on the first call or
// while no caller system is set); threads remember the original system, so
// the note never gets baked into the stored thread.
export const prependTimeNote = (
  system: string | undefined,
  now: Date = new Date()
): string | undefined => {
  if (systemHasTimeNote(system)) {
    return system;
  }
  const note = formatTimeNote(now);
  return system === undefined || system.trim() === ""
    ? note
    : `${note} ${system}`;
};

// Prices per 1M tokens for deepseek-v4-flash. DeepSeek does not publish a
// cache-write price for this model.
export const COST = {
  cacheRead: 0.0028,
  cacheWrite: 0,
  input: 0.14,
  output: 0.28,
};

// Maps pi thinking levels (off/minimal/low/medium/high/xhigh/max) to the
// DeepSeek Responses reasoning-effort values documented in docs/research/
// deepseek-api-surface-2026-08-04.md (none, minimal, low, medium, high,
// xhigh, max). Every documented level is exposed; none are silently clamped
// away. pi documents xhigh mapping to DeepSeek's max effort for V4 Flash
// (pi CHANGELOG #3944), so xhigh resolves to "max".
export const THINKING_LEVEL_MAP = {
  high: "high",
  low: "low",
  max: "max",
  medium: "medium",
  minimal: "minimal",
  off: "none",
  xhigh: "max",
} as const;

export type JsonObject = Record<string, unknown>;
// DeepSeek Responses documents reasoning effort as none, minimal, low,
// medium, high, xhigh, or max (docs/research/deepseek-api-surface-2026-08-04).
export type Effort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
// Structured-output formats documented for Responses text.format.
export type ResponseFormat = "text" | "json_object" | "json_schema";
export type DeepSeekMenuAction =
  | "toggle"
  | "effort"
  | "chat"
  | "reset"
  | "cache"
  | "balance"
  | "close";
export type DeepSeekResetAction =
  | { kind: "all" }
  | { kind: "thread"; name: string };

export interface DeepSeekRuntimeState {
  defaultEffort: Effort;
  enabled: boolean;
}

export interface DeepSeekMenuOption {
  action: DeepSeekMenuAction;
  label: string;
}

export const createRuntimeState = (): DeepSeekRuntimeState => ({
  defaultEffort: DEFAULT_EFFORT,
  enabled: true,
});

export interface UsageCost {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  total: number;
}

export interface UsageRecord {
  cacheRead: number;
  cacheWrite: number;
  cost: UsageCost;
  hitRate: number;
  input: number;
  model: string;
  output: number;
  reasoning?: number;
  source: string;
  totalTokens: number;
  ts: number;
}

export type PendingUsageRecord = Omit<UsageRecord, "hitRate" | "ts">;

interface RawBalanceInfo {
  currency: string;
  grantedBalance?: number;
  toppedUpBalance?: number;
  totalBalance?: number;
}

export interface BalanceState {
  currency: string;
  fetchedAt: number;
  grantedBalance: number;
  isAvailable: boolean;
  toppedUpBalance: number;
  totalBalance: number;
}

export interface UsageSummary {
  cacheRead: number;
  calls: number;
  costTotal: number;
  input: number;
  output: number;
}

// Parses a balance amount that arrives as a string ("24.62"). Anything that
// is not a finite number (missing, non-numeric, NaN, Infinity) returns
// undefined so callers can tell a real zero from a malformed value.
const parseAmount = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? parsed
    : undefined;
};

// Balance amounts arrive as strings ("24.62"); parse defensively and prefer
// the USD entry when an account carries multiple currencies. Unparseable
// amounts normalize to 0, but a payload with no usable balance info at all
// (a non-object body, absent/empty balance_infos, every entry malformed) or
// an explicit is_available:false reports as unavailable, so a valid zero
// balance stays distinguishable from a malformed response.
export const parseBalance = (raw: unknown): Omit<BalanceState, "fetchedAt"> => {
  const body = isJsonObject(raw) ? raw : {};
  const entries: RawBalanceInfo[] = getArray(body, "balance_infos")
    .filter(isJsonObject)
    .map((info) => ({
      currency: getString(info, "currency") ?? "USD",
      grantedBalance: parseAmount(info.granted_balance),
      toppedUpBalance: parseAmount(info.topped_up_balance),
      totalBalance: parseAmount(info.total_balance),
    }));
  const hasUsableEntry = entries.some(
    (entry) =>
      entry.grantedBalance !== undefined ||
      entry.toppedUpBalance !== undefined ||
      entry.totalBalance !== undefined
  );
  const preferred =
    entries.find((entry) => entry.currency === "USD") ?? entries[0];
  const isAvailable = body.is_available !== false && hasUsableEntry;
  return {
    currency: preferred?.currency ?? "USD",
    grantedBalance: preferred?.grantedBalance ?? 0,
    isAvailable,
    toppedUpBalance: preferred?.toppedUpBalance ?? 0,
    totalBalance: preferred?.totalBalance ?? 0,
  };
};

export const currencySymbol = (currency: string): string => {
  if (currency === "USD") {
    return "$";
  }
  if (currency === "CNY") {
    return "¥";
  }
  return `${currency} `;
};

export interface ResponsesResult {
  calls: JsonObject[];
  items: unknown[];
  responseId?: string;
  text: string;
  thinking: string;
  usage: unknown;
}

export interface Thread {
  items: unknown[];
  round: number;
  system?: string;
}

export interface ResponseChatOptions {
  effort?: Effort;
  format?: ResponseFormat;
  jsonSchema?: unknown;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  system?: string;
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const getObject = (
  record: JsonObject | undefined,
  key: string
): JsonObject | undefined => {
  const value = record?.[key];
  return isJsonObject(value) ? value : undefined;
};

export const getArray = (
  record: JsonObject | undefined,
  key: string
): unknown[] => {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
};

export const getNumber = (
  record: JsonObject | undefined,
  key: string
): number | undefined => {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
};

export const getString = (
  record: JsonObject | undefined,
  key: string
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};
