import type {
  ExtensionAPI,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { type BalanceStore, collectUsageRecords } from "./balance.ts";
import {
  API_KEY_ENV,
  BASE_URL,
  CONTEXT_WINDOW,
  COST,
  type DeepSeekRuntimeState,
  type Effort,
  getObject,
  getString,
  isJsonObject,
  type JsonObject,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  PROVIDER_ID,
  THINKING_LEVEL_MAP,
  USAGE_ENTRY,
} from "./config.ts";
import type { TelemetryStore } from "./telemetry.ts";
import type { ThreadStore } from "./threads.ts";

// ---------------------------------------------------------------------------
// Provider and lifecycle registration
// ---------------------------------------------------------------------------

export const registerProvider = (pi: ExtensionAPI): void => {
  pi.registerProvider(PROVIDER_ID, {
    api: "openai-responses",
    apiKey: `$${API_KEY_ENV}`,
    baseUrl: BASE_URL,
    models: [
      {
        // The openai-responses adapter reads only OpenAIResponsesCompat fields
        // (supportsDeveloperRole, sessionAffinityFormat, supportsLongCacheRetention,
        // supportsStrictMode, supportsOpenAIGrammarTools, supportsToolSearch,
        // supportsExplicitPromptCacheMode); Chat-Completions-only flags such as
        // requiresReasoningContentOnAssistantMessages and supportsReasoningEffort
        // are therefore not shipped. DeepSeek's 400 rule (reasoning_content must be
        // replayed on every follow-up request) is handled natively by the adapter's
        // thinkingSignature replay, and effort is controlled via thinkingLevelMap
        // plus reasoning.effort.
        compat: {
          supportsDeveloperRole: false,
          supportsLongCacheRetention: false,
          // The Responses endpoint accepts strict:true function tools (live
          // verified), so the provider emits strict JSON-schema tools.
          supportsStrictMode: true,
        },
        contextWindow: CONTEXT_WINDOW,
        cost: COST,
        id: MODEL_ID,
        input: ["text"],
        maxTokens: MAX_OUTPUT_TOKENS,
        name: "DeepSeek V4 Flash",
        reasoning: true,
        thinkingLevelMap: THINKING_LEVEL_MAP,
      },
    ],
    name: "DeepSeek V4 Flash (Responses API)",
  });
};

export const stripUnsupportedThinkingParameters = (
  payload: JsonObject
): JsonObject => {
  const reasoning = getObject(payload, "reasoning");
  const thinkingOn = !reasoning || getString(reasoning, "effort") !== "none";
  if (thinkingOn) {
    for (const unsupportedParameter of [
      "temperature",
      "top_p",
      "presence_penalty",
      "frequency_penalty",
    ]) {
      Reflect.deleteProperty(payload, unsupportedParameter);
    }
  }
  return payload;
};

export const applyDefaultReasoningEffort = (
  payload: JsonObject,
  defaultEffort: Effort
): JsonObject => {
  const reasoning = getObject(payload, "reasoning");
  if (reasoning && Object.hasOwn(reasoning, "effort")) {
    return payload;
  }
  if (reasoning) {
    reasoning.effort = defaultEffort;
  } else {
    payload.reasoning = { effort: defaultEffort };
  }
  return payload;
};

export const registerLifecycleHandlers = (
  pi: ExtensionAPI,
  runtimeState: DeepSeekRuntimeState,
  telemetry: TelemetryStore,
  threads: ThreadStore,
  balance?: BalanceStore
): void => {
  pi.on("before_provider_request", (event) => {
    if (!runtimeState.enabled) {
      return;
    }
    const payload = isJsonObject(event.payload) ? event.payload : undefined;
    if (!payload || payload.model !== MODEL_ID) {
      return;
    }
    applyDefaultReasoningEffort(payload, runtimeState.defaultEffort);
    return stripUnsupportedThinkingParameters(payload);
  });

  pi.on("turn_end", (event: TurnEndEvent, context) => {
    if (!runtimeState.enabled) {
      return;
    }
    const { message } = event;
    if (
      message.role !== "assistant" ||
      message.provider !== PROVIDER_ID ||
      !message.usage
    ) {
      return;
    }
    const { usage } = message;
    pi.appendEntry(
      USAGE_ENTRY,
      telemetry.record({
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cost: usage.cost,
        input: usage.input,
        model: message.model ?? MODEL_ID,
        output: usage.output,
        reasoning: usage.reasoning,
        source: "agent",
        totalTokens: usage.totalTokens,
      })
    );
    telemetry.setFooter(context, balance);
  });

  pi.on("model_select", (_event, context) => {
    telemetry.setFooter(context, balance);
  });
  pi.on("session_start", (_event, context) => {
    threads.restore(context);
    telemetry.restore(collectUsageRecords(context.sessionManager.getBranch()));
  });
  pi.on("session_tree", (_event, context) => {
    threads.restore(context);
    telemetry.restore(collectUsageRecords(context.sessionManager.getBranch()));
  });
};
