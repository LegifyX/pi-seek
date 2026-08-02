import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BalanceStore } from "./balance.ts";
import type { BetaApi } from "./beta.ts";
import { getFirstChoice } from "./beta.ts";
import { type ChatOutcome, runChatWithRecovery } from "./chat.ts";
import {
  type DeepSeekRuntimeState,
  getArray,
  getNumber,
  getObject,
  getString,
  isJsonObject,
  type JsonObject,
  MODEL_ID,
  type PendingUsageRecord,
  prependTimeNote,
  systemHasTimeNote,
  type Thread,
  USAGE_ENTRY,
} from "./config.ts";
import {
  CallFunctionParams,
  ChatParams,
  ChatResetParams,
  FimParams,
  PrefixParams,
  WebSearchParams,
} from "./params.ts";
import {
  buildFimBody,
  buildPrefixBody,
  type ResponsesApi,
} from "./responses.ts";
import { MAX_RETRIES, withRetries } from "./retry.ts";
import { toStrictSchema } from "./strict-schema.ts";
import type { TelemetryStore } from "./telemetry.ts";
import type { ThreadStore } from "./threads.ts";
import { type ThreadTrimResult, trimThreadItems } from "./threads.ts";

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

export interface ToolServices {
  balance: BalanceStore;
  beta: BetaApi;
  responses: ResponsesApi;
  runtimeState: DeepSeekRuntimeState;
  telemetry: TelemetryStore;
  threads: ThreadStore;
}

const notifyDeepSeekDisabled = (context: ExtensionContext): void => {
  context.ui.notify(
    "DeepSeek integration is disabled. Run /deepseek to enable it.",
    "warning"
  );
};

export const requireDeepSeekEnabled = (
  runtimeState: DeepSeekRuntimeState,
  context: ExtensionContext
): boolean => {
  if (runtimeState.enabled) {
    return true;
  }
  notifyDeepSeekDisabled(context);
  return false;
};

const createDisabledToolResult = () => ({
  content: [
    {
      text: "DeepSeek integration is disabled. Run /deepseek to enable it.",
      type: "text" as const,
    },
  ],
  details: { disabled: true },
});

// Raw Responses output can include function_call / web_search_call items.
// Replaying those as input on the next round (without a paired
// function_call_output) violates the Responses input contract, so only
// persistable items are carried across ds_chat rounds.
export const isPersistableItem = (item: unknown): boolean => {
  if (!isJsonObject(item)) {
    return true;
  }
  const type = getString(item, "type");
  return type !== "function_call" && type !== "web_search_call";
};

const buildUserMessage = (text: string): JsonObject => ({
  content: [{ text, type: "input_text" }],
  role: "user",
});

// Time note: inject only on the first call or while no caller system is set,
// and only when the caller did not already provide one. Threads remember the
// original system, so the note is applied to the request only and never
// stored into the thread.
const resolveInstructions = (thread: Thread): string | undefined => {
  const injectTimeNote =
    (thread.round === 0 || thread.system === undefined) &&
    !systemHasTimeNote(thread.system);
  return injectTimeNote ? prependTimeNote(thread.system) : thread.system;
};

// Polite interruption: never throw a raw abort error; return a bounded
// structured result so the parent agent can recover.
const createInterruptedResult = (phase: "request" | "retry_wait") => ({
  content: [{ text: "Interrupted by the caller.", type: "text" as const }],
  details: { interrupted: true, phase },
});

const buildChatReply = (
  text: string,
  calls: JsonObject[],
  retries: number
): string => {
  const notes: string[] = [];
  if (calls.length > 0) {
    notes.push(
      `unexpected function calls in a plain chat: ${JSON.stringify(calls).slice(0, 500)}`
    );
  }
  if (retries > 0) {
    notes.push(`retried ${retries}x`);
  }
  return notes.length > 0 ? `${text}\n\n[note: ${notes.join("; ")}]` : text;
};

interface ChatDetailsInput {
  capped: ThreadTrimResult;
  historyItems: number;
  outcome: Extract<ChatOutcome, { interrupted: false }>;
  round: number;
  system: string | undefined;
  threadItems: unknown[];
  threadName: string;
  usage: PendingUsageRecord;
}

const buildChatDetails = (input: ChatDetailsInput) => {
  const details: {
    history_items?: number;
    retries?: number;
    round: number;
    thinking: string;
    thread: {
      items: unknown[];
      name: string;
      round: number;
      system?: string;
    };
    trimmed?: number;
    trimmed_history?: number;
    usage: PendingUsageRecord;
  } = {
    round: input.round,
    thinking: input.outcome.result.thinking,
    thread: {
      items: input.threadItems,
      name: input.threadName,
      round: input.round,
      system: input.system,
    },
    usage: input.usage,
  };
  if (input.outcome.trimmed > 0) {
    details.trimmed = input.outcome.trimmed;
  }
  if (input.capped.trimmed > 0) {
    details.history_items = input.historyItems;
    details.trimmed_history = input.capped.trimmed;
  }
  if (input.outcome.retries > 0) {
    details.retries = input.outcome.retries;
  }
  return details;
};

const registerChatTools = (pi: ExtensionAPI, services: ToolServices): void => {
  const { responses, runtimeState, telemetry, threads } = services;

  pi.registerTool({
    description:
      "Send a message to DeepSeek V4 Flash in a named conversation thread and get the reply. Threads are stateful across calls and keep the history, so DeepSeek can be run as a sub-agent. Replay is bounded (the last 200 items / 600k chars; oldest first) and transient failures retry with backoff; a context-length failure trims the replay once and retries. Use ds_chat_reset to clear a thread.",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      return await threads.withLock(params.thread, async () => {
        const thread = threads.getOrCreate(params.thread);
        if (params.system && thread.round === 0) {
          thread.system = params.system;
        }

        const inputItems = [...thread.items, buildUserMessage(params.message)];

        // Bounded replay: cap the replayed history (items and characters),
        // dropping oldest first and always keeping the latest user message.
        const capped = trimThreadItems(inputItems);

        const outcome = await runChatWithRecovery(responses, capped.items, {
          effort: params.reasoning_effort,
          maxOutputTokens: params.max_output_tokens,
          signal: signal ?? context.signal,
          system: resolveInstructions(thread),
        });

        if (outcome.interrupted) {
          return createInterruptedResult(outcome.phase);
        }

        const usage = telemetry.mapResponsesUsage(outcome.result.usage, "chat");
        const persistedItems = outcome.result.items.filter(isPersistableItem);
        thread.items = trimThreadItems([
          ...capped.items,
          ...persistedItems,
        ]).items;
        thread.round += 1;
        pi.appendEntry(USAGE_ENTRY, telemetry.record(usage));
        telemetry.setFooter(context);

        const reply =
          buildChatReply(
            outcome.result.text,
            outcome.result.calls,
            outcome.retries
          ) || "(empty reply)";
        return {
          content: [{ text: reply, type: "text" as const }],
          details: buildChatDetails({
            capped,
            historyItems: inputItems.length,
            outcome,
            round: thread.round,
            system: thread.system,
            threadItems: thread.items,
            threadName: params.thread,
            usage,
          }),
        };
      });
    },
    label: "DeepSeek Chat",
    name: "ds_chat",
    parameters: ChatParams,
    promptSnippet:
      "ds_chat(thread, message) - chat with DeepSeek in a named thread",
  });

  pi.registerTool({
    description:
      "Reset one named DeepSeek chat thread (or all threads), discarding its history.",
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      await threads.reset(params.thread);
      return {
        content: [
          {
            text: params.thread
              ? `Thread "${params.thread}" reset`
              : "All DeepSeek threads reset",
            type: "text" as const,
          },
        ],
        details: {
          reset: params.thread
            ? { kind: "thread" as const, name: params.thread }
            : { kind: "all" as const },
          thread: params.thread,
        },
      };
    },
    label: "DeepSeek Chat Reset",
    name: "ds_chat_reset",
    parameters: ChatResetParams,
    promptSnippet: "ds_chat_reset(thread?) - clear DeepSeek chat thread state",
  });
};

const registerBetaTools = (pi: ExtensionAPI, services: ToolServices): void => {
  const { beta, runtimeState, telemetry } = services;

  pi.registerTool({
    description:
      'Beta Chat Prefix Completion: give a user instruction plus an assistant prefix (e.g. "```python\\n") and get the model\'s continuation, optionally stopping at a sequence like "```". Use for code/structured completions.',
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      const body = buildPrefixBody(params);

      const response = await beta.postChatCompletion(
        body,
        signal ?? context.signal
      );
      const message = getObject(getFirstChoice(response), "message");
      const completion = getString(message, "content") ?? "";
      const usage = telemetry.mapChatUsage(response.usage, "prefix");
      pi.appendEntry(USAGE_ENTRY, telemetry.record(usage));
      telemetry.setFooter(context);
      const rawUsage = isJsonObject(response.usage)
        ? response.usage
        : undefined;
      return {
        content: [
          { text: completion || "(empty completion)", type: "text" as const },
        ],
        details: {
          full: params.prefix + completion,
          prompt_cache_hit_tokens: getNumber(
            rawUsage,
            "prompt_cache_hit_tokens"
          ),
          prompt_cache_miss_tokens: getNumber(
            rawUsage,
            "prompt_cache_miss_tokens"
          ),
          usage,
        },
      };
    },
    label: "DeepSeek Prefix Completion",
    name: "ds_prefix_complete",
    parameters: PrefixParams,
    promptSnippet:
      "ds_prefix_complete(prompt, prefix, stop?) - continue from an assistant prefix",
  });

  pi.registerTool({
    description:
      "Beta Fill-In-the-Middle completion: give the code before the gap (prompt) and optionally the code after it (suffix); DeepSeek completes the middle. Max tokens is capped at 4K by the API.",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      const body = buildFimBody(params);

      const response = await beta.postCompletion(
        body,
        signal ?? context.signal
      );
      const completion = getString(getFirstChoice(response), "text") ?? "";
      const usage = telemetry.mapChatUsage(response.usage, "fim");
      pi.appendEntry(USAGE_ENTRY, telemetry.record(usage));
      telemetry.setFooter(context);
      const rawUsage = isJsonObject(response.usage)
        ? response.usage
        : undefined;
      return {
        content: [
          { text: completion || "(empty completion)", type: "text" as const },
        ],
        details: {
          prompt_cache_hit_tokens: getNumber(
            rawUsage,
            "prompt_cache_hit_tokens"
          ),
          prompt_cache_miss_tokens: getNumber(
            rawUsage,
            "prompt_cache_miss_tokens"
          ),
          usage,
        },
      };
    },
    label: "DeepSeek FIM Completion",
    name: "ds_fim",
    parameters: FimParams,
    promptSnippet:
      "ds_fim(prompt, suffix?) - fill the middle between prompt and suffix",
  });
};

const registerResponsesTools = (
  pi: ExtensionAPI,
  services: ToolServices
): void => {
  const { responses, runtimeState, telemetry } = services;

  pi.registerTool({
    description:
      "Run DeepSeek's server-side web search (Responses API web_search tool) for a query and return the model's answer, including citations where available.",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      const result = await responses.webSearch(
        params.query,
        params.reasoning_effort,
        params.max_output_tokens,
        signal ?? context.signal
      );
      const usage = telemetry.mapResponsesUsage(result.usage, "search");
      pi.appendEntry(USAGE_ENTRY, telemetry.record(usage));
      telemetry.setFooter(context);
      return {
        content: [
          { text: result.text || "(no answer)", type: "text" as const },
        ],
        details: {
          query: params.query,
          responseId: result.responseId,
          searchCalls: result.calls,
          thinking: result.thinking,
          usage,
        },
      };
    },
    label: "DeepSeek Web Search",
    name: "ds_web_search",
    parameters: WebSearchParams,
    promptSnippet: "ds_web_search(query) - server-side web search via DeepSeek",
  });
};

export const extractRequiredFunctionCall = (
  message: JsonObject,
  expectedName: string
): { calledName: string; rawArguments: string } => {
  const [rawToolCall] = getArray(message, "tool_calls");
  const toolCall = isJsonObject(rawToolCall) ? rawToolCall : undefined;
  const calledFunction = getObject(toolCall, "function");

  if (!toolCall) {
    const content = getString(message, "content") ?? "(no content)";
    throw new Error(
      `DeepSeek did not call the required function "${expectedName}": ${content}`
    );
  }

  const calledName = getString(calledFunction, "name");
  if (calledName !== expectedName) {
    throw new Error(
      `DeepSeek called "${calledName ?? "(unnamed)"}" instead of required function "${expectedName}"`
    );
  }

  const rawArguments = getString(calledFunction, "arguments");
  if (rawArguments === undefined) {
    throw new Error(
      `DeepSeek returned no arguments for required function "${expectedName}"`
    );
  }

  return { calledName, rawArguments };
};

const registerFunctionTool = (
  pi: ExtensionAPI,
  services: ToolServices
): void => {
  const { beta, runtimeState, telemetry } = services;

  pi.registerTool({
    description:
      "Force DeepSeek V4 Flash to produce the named strict-mode function call for the given JSON schema. This helper uses non-thinking mode because DeepSeek rejects forced tool choice in thinking mode. The schema is normalized to DeepSeek's strict dialect (all object properties required, additionalProperties false, strings with supported pattern/format only, numbers with bounds/multipleOf, arrays without min/maxItems, enum/anyOf/$ref/$def). Returns the parsed arguments.",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      const strictParameters = toStrictSchema(params.parameters);
      const body: JsonObject = {
        messages: [
          {
            content:
              "You call the provided function with exactly correct arguments based on the context. Output only the function call.",
            role: "system",
          },
          {
            content:
              params.context ??
              "Determine the correct arguments for this function call.",
            role: "user",
          },
        ],
        model: MODEL_ID,
        stream: false,
        thinking: { type: "disabled" },
        tool_choice: { function: { name: params.name }, type: "function" },
        tools: [
          {
            function: {
              description: params.description ?? "",
              name: params.name,
              parameters: strictParameters,
              strict: true,
            },
            type: "function",
          },
        ],
      };

      const requestSignal = signal ?? context.signal;
      const outcome = await withRetries(
        () => beta.postChatCompletion(body, requestSignal),
        { maxRetries: MAX_RETRIES, signal: requestSignal }
      );
      const response = outcome.result;
      const message = getObject(getFirstChoice(response), "message");
      const usage = telemetry.mapChatUsage(response.usage, "function");
      pi.appendEntry(USAGE_ENTRY, telemetry.record(usage));
      telemetry.setFooter(context);

      const { calledName, rawArguments } = extractRequiredFunctionCall(
        message ?? {},
        params.name
      );

      let parsedArguments: unknown;
      try {
        parsedArguments = JSON.parse(rawArguments);
      } catch (error) {
        throw new Error(
          `DeepSeek returned invalid JSON arguments for required function "${params.name}"`,
          { cause: error }
        );
      }

      const callText = `Function call: ${calledName}\nArguments: ${JSON.stringify(parsedArguments, null, 2)}`;
      return {
        content: [
          {
            text:
              outcome.retries > 0
                ? `${callText}\n\n[note: retried ${outcome.retries}x]`
                : callText,
            type: "text" as const,
          },
        ],
        details: {
          ...(outcome.retries > 0 ? { retries: outcome.retries } : {}),
          arguments: parsedArguments,
          name: calledName,
          rawArguments,
          reasoning: getString(message, "reasoning_content"),
          strictSchema: strictParameters,
          usage,
        },
      };
    },
    label: "DeepSeek Call Function",
    name: "ds_call_function",
    parameters: CallFunctionParams,
    promptSnippet:
      "ds_call_function(name, parameters, context?) - strict-mode DeepSeek function call",
  });
};

export const registerTools = (
  pi: ExtensionAPI,
  services: ToolServices
): void => {
  registerChatTools(pi, services);
  registerBetaTools(pi, services);
  registerResponsesTools(pi, services);
  registerFunctionTool(pi, services);
};
