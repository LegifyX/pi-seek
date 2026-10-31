import type {
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { type BalanceStore, collectUsageRecords } from "./balance.ts";
import {
  API_KEY_ENV,
  BASE_URL,
  CONTEXT_WINDOW,
  type DeepSeekRuntimeState,
  type Effort,
  FLASH_MODEL_ID,
  getObject,
  getString,
  isJsonObject,
  isSupportedModelId,
  type JsonObject,
  MAX_OUTPUT_TOKENS,
  MODEL_COSTS,
  MODEL_ID,
  PRO_MODEL_ID,
  PROVIDER_ID,
  THINKING_LEVEL_MAP,
  USAGE_ENTRY,
} from "./config.ts";
import { loadHolidayCalendar } from "./holidays.ts";
import { nextPhaseChange, setHolidayDates } from "./peak.ts";
import type { TelemetryStore } from "./telemetry.ts";
import type { ThreadStore } from "./threads.ts";

// A boundary that has just passed must not spin the timer.
const MIN_PHASE_TIMER_MS = 1000;

// ---------------------------------------------------------------------------
// Provider and lifecycle registration
// ---------------------------------------------------------------------------

// The openai-responses adapter reads only OpenAIResponsesCompat fields
// (supportsDeveloperRole, sessionAffinityFormat, supportsLongCacheRetention,
// supportsStrictMode, supportsOpenAIGrammarTools, supportsToolSearch,
// supportsExplicitPromptCacheMode); Chat-Completions-only flags such as
// requiresReasoningContentOnAssistantMessages and supportsReasoningEffort
// are therefore not shipped. DeepSeek's 400 rule (reasoning_content must be
// replayed on every follow-up request) is handled natively by the adapter's
// thinkingSignature replay, and effort is controlled via thinkingLevelMap
// plus reasoning.effort.
const PROVIDER_MODEL_BASE = {
  compat: {
    supportsDeveloperRole: false,
    supportsLongCacheRetention: false,
    // The Responses endpoint accepts strict:true function tools (live
    // verified), so the provider emits strict JSON-schema tools.
    supportsStrictMode: true,
  },
  contextWindow: CONTEXT_WINDOW,
  input: ["text"] as ("text" | "image")[],
  maxTokens: MAX_OUTPUT_TOKENS,
  reasoning: true,
  thinkingLevelMap: THINKING_LEVEL_MAP,
};

export const registerProvider = (pi: ExtensionAPI): void => {
  pi.registerProvider(PROVIDER_ID, {
    api: "openai-responses",
    apiKey: `$${API_KEY_ENV}`,
    baseUrl: BASE_URL,
    models: [
      {
        ...PROVIDER_MODEL_BASE,
        cost: MODEL_COSTS[FLASH_MODEL_ID],
        id: FLASH_MODEL_ID,
        name: "DeepSeek V4 Flash",
      },
      {
        ...PROVIDER_MODEL_BASE,
        cost: MODEL_COSTS[PRO_MODEL_ID],
        id: PRO_MODEL_ID,
        name: "DeepSeek V4 Pro",
      },
    ],
    name: "DeepSeek V4 (Responses API)",
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
  // The footer quotes the billing window, which changes at wall-clock
  // boundaries while a session sits idle and pi fires no event. One timer for
  // the next boundary keeps it honest; it never holds the process open.
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  let lastContext: ExtensionContext | undefined;

  const refreshFooter = (context: ExtensionContext): void => {
    lastContext = context;
    telemetry.setFooter(context, balance);
    if (phaseTimer) {
      clearTimeout(phaseTimer);
    }
    const delay = nextPhaseChange().getTime() - Date.now();
    phaseTimer = setTimeout(
      () => {
        if (lastContext) {
          refreshFooter(lastContext);
        }
      },
      Math.max(MIN_PHASE_TIMER_MS, delay)
    );
    phaseTimer.unref?.();
  };

  pi.on("before_provider_request", (event) => {
    if (!runtimeState.enabled) {
      return;
    }
    const payload = isJsonObject(event.payload) ? event.payload : undefined;
    if (!(payload && isSupportedModelId(payload.model))) {
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
    refreshFooter(context);
  });

  pi.on("model_select", (_event, context) => {
    refreshFooter(context);
  });
  pi.on("session_start", (_event, context) => {
    threads.restore(context);
    telemetry.restore(collectUsageRecords(context.sessionManager.getBranch()));
    refreshFooter(context);
    // The holiday calendar decides a fraction of the year; load it beside the
    // session rather than gating the footer on a network round trip.
    loadHolidayCalendar()
      .then(({ dates }) => {
        setHolidayDates(dates);
        if (lastContext) {
          refreshFooter(lastContext);
        }
      })
      .catch(() => undefined);
  });
  pi.on("session_tree", (_event, context) => {
    threads.restore(context);
    telemetry.restore(collectUsageRecords(context.sessionManager.getBranch()));
    refreshFooter(context);
  });
  pi.on("session_shutdown", () => {
    if (phaseTimer) {
      clearTimeout(phaseTimer);
      phaseTimer = undefined;
    }
  });
};
