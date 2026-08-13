import {
  BASE_URL,
  BETA_URL,
  CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  PRO_MODEL_ID,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Versioned compatibility matrix
// ---------------------------------------------------------------------------
// Single source of truth for the model × surface × endpoint × streaming ×
// tools × reasoning × limits facts verified in docs/research/deepseek-api-
// surface-2026-08-04.md. Rows are built from the config constants so the
// matrix cannot drift from provider registration. Facts the research labels
// "Unresolved" stay unresolved here; they are never promoted to documented
// behavior without fresh primary evidence.

export const VERSION = "2026-08-04";

export type SurfaceAvailability = "documented" | "unresolved" | "unsupported";

// Feature names no DeepSeek surface supports: Responses is stateless, so
// pi-seek must never rely on server-side continuation.
export const STATELESS_UNSUPPORTED = [
  "previous_response_id",
  "conversation",
  "store",
] as const;

export interface CompatibilityLimits {
  contextWindow?: number;
  fimMaxTokens?: number;
  maxOutputTokens?: number;
}

export interface CompatibilityRow {
  /** V4 Flash availability on this surface, per the research report. */
  availability: SurfaceAvailability;
  baseUrl: string;
  documentedModels: string[];
  limits: CompatibilityLimits;
  /** Live probe verification record (2026-08-04). */
  liveProbe?: LiveProbe;
  method: "GET" | "POST";
  notes: string[];
  path: string;
  reasoning: string[];
  sources: string[];
  streaming: string;
  surface: string;
  tools: string[];
  /** Features pi-seek must not rely on for this surface. */
  unsupportedFeatures: string[];
}

interface LiveProbe {
  date: string;
  result: string;
  source: string;
}

export const COMPATIBILITY_MATRIX: readonly CompatibilityRow[] = [
  {
    availability: "documented",
    baseUrl: BASE_URL,
    documentedModels: [MODEL_ID, PRO_MODEL_ID],
    limits: {
      contextWindow: CONTEXT_WINDOW,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    liveProbe: {
      date: "2026-08-04",
      result:
        "deepseek-v4-flash accepted; deepseek-v4-pro rejected (HTTP 400; Pro integration available early August 2026). Streaming: 9 event families, monotonic sequence_number, no [DONE], terminal response.incomplete, no keep-alive. Strict function-call validator live.",
      source: "live probe 2026-08-04",
    },
    method: "POST",
    notes: [
      "stateless; previous_response_id/conversation/store and server-side persistence are unsupported",
      "documented model max is 384K output tokens; local registration uses 393216",
      "Pro support live since early August 2026; documented on Models & Pricing 2026-08-12",
      "live probe 2026-08-04: deepseek-v4-pro rejected on POST /responses (HTTP 400: Codex integration with deepseek-v4-pro available starting early August 2026)",
      "live probe 2026-08-04: non-streaming call returned reasoning + message output items; usage paths input_tokens_details.cached_tokens and output_tokens_details.reasoning_tokens",
      "live probe 2026-08-04: streaming emitted response.created, response.in_progress, response.output_item.added, response.content_part.added, response.reasoning_text.delta, response.reasoning_text.done, response.content_part.done, response.output_item.done, response.incomplete; sequence_number monotonic; no keep-alive comments; no [DONE]; terminal event response.incomplete",
      "live probe 2026-08-04: strict function-call accepted valid arguments (tool_call_id, name, valid JSON) and rejected invalid fixtures with typed validator messages",
    ],
    path: "/responses",
    reasoning: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    sources: [
      "https://api-docs.deepseek.com/api/create-response/",
      "https://api-docs.deepseek.com/guides/responses_api/",
    ],
    streaming:
      "semantic SSE with monotonically increasing sequence_number and no [DONE] marker; pi-seek sends stream:false",
    surface: "responses",
    tools: ["function", "web_search"],
    unsupportedFeatures: [...STATELESS_UNSUPPORTED],
  },
  {
    availability: "documented",
    baseUrl: BASE_URL,
    documentedModels: [MODEL_ID, "deepseek-v4-pro"],
    limits: { contextWindow: CONTEXT_WINDOW },
    method: "POST",
    notes: [],
    path: "/chat/completions",
    reasoning: ["thinking enabled/disabled", "reasoning_effort"],
    sources: ["https://api-docs.deepseek.com/api/create-chat-completion/"],
    streaming: "data-only SSE with [DONE]",
    surface: "chat",
    tools: ["function"],
    unsupportedFeatures: [...STATELESS_UNSUPPORTED],
  },
  {
    availability: "documented",
    baseUrl: BETA_URL,
    documentedModels: [MODEL_ID, "deepseek-v4-pro"],
    limits: { contextWindow: CONTEXT_WINDOW },
    liveProbe: {
      date: "2026-08-04",
      result:
        "beta /chat/completions prefix accepted deepseek-v4-flash and deepseek-v4-pro (HTTP 200)",
      source: "live probe 2026-08-04",
    },
    method: "POST",
    notes: [
      "final assistant message must use prefix:true",
      "live probe 2026-08-04: beta prefix accepted deepseek-v4-flash and deepseek-v4-pro (HTTP 200)",
    ],
    path: "/chat/completions",
    reasoning: ["thinking enabled/disabled", "reasoning_effort"],
    sources: [
      "https://api-docs.deepseek.com/guides/chat_prefix_completion/",
      "https://api-docs.deepseek.com/api/create-chat-completion/",
    ],
    streaming: "data-only SSE with [DONE]",
    surface: "prefix",
    tools: [],
    unsupportedFeatures: [...STATELESS_UNSUPPORTED],
  },
  {
    availability: "documented",
    baseUrl: BETA_URL,
    documentedModels: [MODEL_ID, "deepseek-v4-pro"],
    limits: { fimMaxTokens: 4096 },
    liveProbe: {
      date: "2026-08-04",
      result:
        "beta /completions accepted deepseek-v4-flash and deepseek-v4-pro; max_tokens 4097 accepted, contradicting the documented 4K cap (kept at 4096)",
      source: "live probe 2026-08-04",
    },
    method: "POST",
    notes: [
      "max_tokens cap is documented as 4K; kept at 4096",
      "finish_reason insufficient_system_resource documented (interrupted request); surfaced in details.finish_reason",
      "live probe 2026-08-04: beta /completions accepted deepseek-v4-flash and deepseek-v4-pro (HTTP 200)",
      "live probe 2026-08-04: max_tokens 4097 was ACCEPTED (HTTP 200), contradicting the documented 4K cap; cap stays 4096 as documented",
    ],
    path: "/completions",
    reasoning: [],
    sources: [
      "https://api-docs.deepseek.com/api/create-completion/",
      "https://api-docs.deepseek.com/quick_start/pricing/",
    ],
    streaming: "data-only SSE with [DONE]",
    surface: "fim",
    tools: [],
    unsupportedFeatures: [...STATELESS_UNSUPPORTED],
  },
  {
    availability: "documented",
    baseUrl: BASE_URL,
    documentedModels: [],
    limits: {},
    liveProbe: {
      date: "2026-08-04",
      result:
        "GET /user/balance 200; top-level is_available + balance_infos; entries with granted_balance/topped_up_balance/total_balance; is_available false observed",
      source: "live probe 2026-08-04",
    },
    method: "GET",
    notes: [
      "Bearer auth; response contains balance information",
      "live probe 2026-08-04: top-level fields is_available and balance_infos; entries carry granted_balance, topped_up_balance, total_balance; is_available false observed (no balance amounts recorded)",
    ],
    path: "/user/balance",
    reasoning: [],
    sources: ["https://api-docs.deepseek.com/api/get-user-balance/"],
    streaming: "n/a",
    surface: "balance",
    tools: [],
    unsupportedFeatures: [...STATELESS_UNSUPPORTED],
  },
  {
    availability: "documented",
    baseUrl: BASE_URL,
    documentedModels: [MODEL_ID, PRO_MODEL_ID],
    limits: {},
    liveProbe: {
      date: "2026-08-04",
      result:
        "GET /models 200; ids deepseek-v4-flash and deepseek-v4-pro; per-model fields id, object, owned_by",
      source: "live probe 2026-08-04",
    },
    method: "GET",
    notes: [
      "official listing endpoint; not called during research",
      "live probe 2026-08-04: returns deepseek-v4-flash and deepseek-v4-pro; per-model fields id, object, owned_by",
    ],
    path: "/models",
    reasoning: [],
    sources: ["https://api-docs.deepseek.com/api/list-models/"],
    streaming: "n/a",
    surface: "models",
    tools: [],
    unsupportedFeatures: [...STATELESS_UNSUPPORTED],
  },
];

// Looks up a matrix row by surface name (e.g. "responses", "fim").
export const getSurface = (surface: string): CompatibilityRow | undefined =>
  COMPATIBILITY_MATRIX.find((row) => row.surface === surface);
