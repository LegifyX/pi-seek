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
import { runChatWithRecovery } from "./chat.ts";
import { registerCommands } from "./commands.ts";
import {
  createRuntimeState,
  formatTimeNote,
  parseBalance,
  prependTimeNote,
  systemHasTimeNote,
} from "./config.ts";
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
import {
  backoffDelayMs,
  classifyError,
  isContextLengthError,
  RetryWaitAbortedError,
  withRetries,
} from "./retry.ts";
import { createTelemetryStore } from "./telemetry.ts";
import {
  createThreadStore,
  trimThreadForContext,
  trimThreadItems,
} from "./threads.ts";
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
  backoffDelayMs,
  buildChatBody,
  buildFimBody,
  buildPrefixBody,
  buildWebSearchBody,
  classifyError,
  collectUsageRecords,
  createAuthService,
  createBalanceStore,
  createHttpClient,
  createTelemetryStore,
  createThreadStore,
  extractRequiredFunctionCall,
  extractResponsesText,
  formatTimeNote,
  interpolateEnv,
  isContextLengthError,
  isPersistableItem,
  parseBalance,
  prependTimeNote,
  RetryWaitAbortedError,
  runChatWithRecovery,
  stripUnsupportedThinkingParameters,
  summarizeUsage,
  systemHasTimeNote,
  trimThreadForContext,
  trimThreadItems,
  withRetries,
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
