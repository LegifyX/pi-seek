import {
  BASE_URL,
  BETA_URL,
  CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
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

export const COMPATIBILITY_MATRIX: readonly CompatibilityRow[] = [
  {
    availability: "documented",
    baseUrl: BASE_URL,
    documentedModels: [MODEL_ID],
    limits: {
      contextWindow: CONTEXT_WINDOW,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    method: "POST",
    notes: [
      "stateless; previous_response_id/conversation/store and server-side persistence are unsupported",
      "documented model max is 384K output tokens; local registration uses 393216",
      "Pro support is planned in the guide; not yet documented",
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
    availability: "unresolved",
    baseUrl: BETA_URL,
    documentedModels: ["deepseek-v4-pro"],
    limits: { contextWindow: CONTEXT_WINDOW },
    method: "POST",
    notes: [
      "final assistant message must use prefix:true",
      "documented examples use Pro; V4 Flash availability is unresolved",
    ],
    path: "/chat/completions",
    reasoning: [],
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
    availability: "unresolved",
    baseUrl: BETA_URL,
    documentedModels: ["deepseek-v4-pro"],
    limits: { fimMaxTokens: 4096 },
    method: "POST",
    notes: [
      "max_tokens cap is 4K",
      "reference lists Pro while pricing says both models; Flash availability is unresolved",
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
    method: "GET",
    notes: ["Bearer auth; response contains balance information"],
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
    documentedModels: [],
    limits: {},
    method: "GET",
    notes: ["official listing endpoint; not called during research"],
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
