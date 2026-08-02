// ---------------------------------------------------------------------------
// Thin default composition
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectUsageRecords,
  createBalanceStore,
  summarizeUsage,
} from "./balance.ts";
import { createBetaApi } from "./beta.ts";
import { registerCommands } from "./commands.ts";
import { createRuntimeState, parseBalance } from "./config.ts";
import { createAuthService, createHttpClient, interpolateEnv } from "./http.ts";
import {
  applyDefaultReasoningEffort,
  registerLifecycleHandlers,
  registerProvider,
  stripUnsupportedThinkingParameters,
} from "./lifecycle.ts";
import { registerRenderers } from "./renderers.ts";
import {
  buildChatBody,
  buildFimBody,
  buildPrefixBody,
  buildWebSearchBody,
  createResponsesApi,
  extractResponsesText,
} from "./responses.ts";
import { createTelemetryStore } from "./telemetry.ts";
import { createThreadStore } from "./threads.ts";
import {
  extractRequiredFunctionCall,
  isPersistableItem,
  registerTools,
  type ToolServices,
} from "./tools.ts";

// biome-ignore lint/performance/noBarrelFile: entry module re-exports the extension's required public surface (resolveTimeoutMs, toStrictSchema)
export { resolveTimeoutMs } from "./config.ts";
export { toStrictSchema } from "./strict-schema.ts";

export const __test = {
  applyDefaultReasoningEffort,
  buildChatBody,
  buildFimBody,
  buildPrefixBody,
  buildWebSearchBody,
  collectUsageRecords,
  createAuthService,
  createBalanceStore,
  createHttpClient,
  createTelemetryStore,
  createThreadStore,
  extractRequiredFunctionCall,
  extractResponsesText,
  interpolateEnv,
  isPersistableItem,
  parseBalance,
  stripUnsupportedThinkingParameters,
  summarizeUsage,
};

export default function piSeek(pi: ExtensionAPI): void {
  const runtimeState = createRuntimeState();
  const auth = createAuthService();
  const http = createHttpClient(auth);
  const responses = createResponsesApi(http);
  const beta = createBetaApi(http);
  const telemetry = createTelemetryStore(runtimeState);
  const threads = createThreadStore();
  const balance = createBalanceStore(http);
  const services: ToolServices = {
    balance,
    beta,
    responses,
    runtimeState,
    telemetry,
    threads,
  };

  registerProvider(pi);
  registerLifecycleHandlers(pi, runtimeState, telemetry, threads);
  registerTools(pi, services);
  registerCommands(pi, services);
  registerRenderers(pi);
}
