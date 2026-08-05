// ---------------------------------------------------------------------------
// Thin default composition
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// Absolute path to the packaged skills directory, resolved relative to the
// extension entry so it works both in development (src/) and in an installed
// package (dist/). Contributed via resources_discover so child Pi processes
// (one-shot agents, persistent actors) that load the extension discover the
// same SKILL.md as the main session; the package.json "pi.skills" manifest
// covers the main process.
const EXTENSION_ENTRY_PATH = path.resolve(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(
  path.dirname(EXTENSION_ENTRY_PATH),
  "..",
  "skills"
);

export const registerSkillDiscovery = (pi: ExtensionAPI): void => {
  pi.on("resources_discover", async () =>
    existsSync(SKILLS_DIR) ? { skillPaths: [SKILLS_DIR] } : {}
  );
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
  registerLifecycleHandlers(pi, runtimeState, telemetry, threads, balance);
  registerTools(pi, services);
  registerCommands(pi, services);
  registerRenderers(pi);
  registerSkillDiscovery(pi);
}
