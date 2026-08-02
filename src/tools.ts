import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BalanceStore } from "./balance.ts";
import type { BetaApi } from "./beta.ts";
import { getFirstChoice } from "./beta.ts";
import {
  type DeepSeekRuntimeState,
  getArray,
  getNumber,
  getObject,
  getString,
  isJsonObject,
  type JsonObject,
  MODEL_ID,
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
import { toStrictSchema } from "./strict-schema.ts";
import type { TelemetryStore } from "./telemetry.ts";
import type { ThreadStore } from "./threads.ts";

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

const registerChatTools = (pi: ExtensionAPI, services: ToolServices): void => {
  const { responses, runtimeState, telemetry, threads } = services;

  pi.registerTool({
    description:
      "Send a message to DeepSeek V4 Flash in a named conversation thread and get the reply. Threads are stateful across calls and keep the full history, so DeepSeek can be run as a sub-agent. Use ds_chat_reset to clear a thread.",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      return await threads.withLock(params.thread, async () => {
        const thread = threads.getOrCreate(params.thread);
        if (params.system && thread.round === 0) {
          thread.system = params.system;
        }

        const inputItems = [...thread.items];
        inputItems.push({
          content: [{ text: params.message, type: "input_text" }],
          role: "user",
        });

        const result = await responses.chat(inputItems, {
          effort: params.reasoning_effort,
          maxOutputTokens: params.max_output_tokens,
          signal: signal ?? context.signal,
          system: thread.system,
        });

        thread.items = [
          ...inputItems,
          ...result.items.filter(isPersistableItem),
        ];
        thread.round += 1;
        const usage = telemetry.mapResponsesUsage(result.usage, "chat");
        pi.appendEntry(USAGE_ENTRY, telemetry.record(usage));
        telemetry.setFooter(context);

        const reply =
          result.calls.length > 0
            ? `${result.text}\n\n[note: unexpected function calls in a plain chat: ${JSON.stringify(result.calls).slice(0, 500)}]`
            : result.text;
        return {
          content: [{ text: reply || "(empty reply)", type: "text" as const }],
          details: {
            round: thread.round,
            thinking: result.thinking,
            thread: {
              items: thread.items,
              name: params.thread,
              round: thread.round,
              system: thread.system,
            },
            usage,
          },
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

      const response = await beta.postChatCompletion(
        body,
        signal ?? context.signal
      );
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

      return {
        content: [
          {
            text: `Function call: ${calledName}\nArguments: ${JSON.stringify(parsedArguments, null, 2)}`,
            type: "text" as const,
          },
        ],
        details: {
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
