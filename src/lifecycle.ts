import type {
  ExtensionAPI,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { collectUsageRecords } from "./balance.ts";
import {
  API_KEY_ENV,
  BASE_URL,
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
        compat: {
          requiresReasoningContentOnAssistantMessages: true,
          supportsDeveloperRole: false,
          supportsLongCacheRetention: false,
          supportsReasoningEffort: true,
          supportsStrictMode: false,
        },
        contextWindow: 1_048_576,
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
  threads: ThreadStore
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
    telemetry.setFooter(context);
  });

  pi.on("model_select", (_event, context) => {
    telemetry.setFooter(context);
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
