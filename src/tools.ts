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
import { MAX_RETRIES, RetryWaitAbortedError, withRetries } from "./retry.ts";
import { toStrictSchema, validateStrictArguments } from "./strict-schema.ts";
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

// Time note: inject on every round unless the system already carries one.
// The note is minute-precision, so rounds within the same minute keep an
// identical instructions prefix (a KV-cache hit across rounds) while the
// model still sees a fresh timestamp. Threads remember the original system,
// so the note is applied to the request only and never stored into the
// thread.
const resolveInstructions = (thread: Thread): string | undefined =>
  systemHasTimeNote(thread.system)
    ? thread.system
    : prependTimeNote(thread.system);

// Polite interruption: never throw a raw abort error; return a bounded
// structured result so the parent agent can recover.
const createInterruptedResult = (phase: "request" | "retry_wait") => ({
  content: [{ text: "Interrupted by the caller.", type: "text" as const }],
  details: { interrupted: true, phase },
});

const isCallerAbort = (error: unknown): boolean =>
  error instanceof RetryWaitAbortedError ||
  (error instanceof Error && error.message === "Aborted by user");

// ds_call_function posts to the beta chat-completions surface, whose function
// name limit is 64 characters (the Responses surface allows 128). Reject
// invalid names locally with a typed error before any network call.
const FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const validateFunctionName = (name: string): void => {
  if (name.length > 64 || !FUNCTION_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid function name "${name}" for ds_call_function: names must be nonempty, alphanumeric/underscore/hyphen, and at most 64 characters`
    );
  }
};

const interruptedPhase = (error: unknown): "request" | "retry_wait" =>
  error instanceof RetryWaitAbortedError ? "retry_wait" : "request";

const buildChatReply = (
  text: string,
  calls: JsonObject[],
  retries: number,
  statusNote?: string
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
  if (statusNote) {
    notes.push(statusNote);
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
    error?: string;
    history_items?: number;
    incomplete_reason?: string;
    retries?: number;
    round: number;
    status?: string;
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
  const { result } = input.outcome;
  if (result.status !== undefined && result.status !== "completed") {
    details.status = result.status;
    if (isJsonObject(result.incompleteDetails)) {
      details.incomplete_reason = getString(result.incompleteDetails, "reason");
    }
    const errorMessage = getString(result.error, "message");
    if (errorMessage) {
      details.error = errorMessage;
    }
  }
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
      "Send a message to DeepSeek V4 in a named conversation thread and get the reply. Threads are stateful across calls and keep the history, so DeepSeek can be run as a sub-agent. Replay is bounded (the last 200 items / 600k chars; oldest first) and transient failures retry with backoff; a context-length failure trims the replay once and retries. Use ds_chat_reset to clear a thread. Reasoning effort accepts none, minimal, low, medium, high, xhigh, or max; structured output is available via format (text, json_object, json_schema) plus an optional json_schema.",
    async execute(_toolCallId, params, signal, onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      onUpdate?.({
        content: [{ text: "Sending to DeepSeek…", type: "text" as const }],
        details: {},
      });
      return await threads.withLock(params.thread, async () => {
        const thread = threads.getOrCreate(params.thread);
        // Stage the first-round system prompt instead of mutating the stored
        // thread up front: commit it only after the request succeeds, so a
        // caller interrupt leaves thread.system/items/round untouched and the
        // restored thread matches the live store.
        const stagedSystem =
          params.system && thread.round === 0 ? params.system : thread.system;

        const inputItems = [...thread.items, buildUserMessage(params.message)];

        // Bounded replay: cap the replayed history (items and characters),
        // dropping oldest first and always keeping the latest user message.
        const capped = trimThreadItems(inputItems);

        const outcome = await runChatWithRecovery(responses, capped.items, {
          effort: params.reasoning_effort,
          format: params.format,
          jsonSchema: params.json_schema,
          maxOutputTokens: params.max_output_tokens,
          signal: signal ?? context.signal,
          system: resolveInstructions({ ...thread, system: stagedSystem }),
          temperature: params.temperature,
          top_p: params.top_p,
        });

        if (outcome.interrupted) {
          return createInterruptedResult(outcome.phase);
        }

        thread.system = stagedSystem;
        const usage = telemetry.mapResponsesUsage(outcome.result.usage, "chat");
        const persistedItems = outcome.result.items.filter(isPersistableItem);
        thread.items = trimThreadItems([
          ...capped.items,
          ...persistedItems,
        ]).items;
        thread.round += 1;
        pi.appendEntry(USAGE_ENTRY, telemetry.record(usage));
        telemetry.setFooter(context);

        const statusNote =
          outcome.result.status !== undefined &&
          outcome.result.status !== "completed"
            ? `response ${outcome.result.status}${
                isJsonObject(outcome.result.incompleteDetails)
                  ? ` (${getString(outcome.result.incompleteDetails, "reason") ?? "unknown reason"})`
                  : ""
              }`
            : undefined;
        const reply =
          buildChatReply(
            outcome.result.text,
            outcome.result.calls,
            outcome.retries,
            statusNote
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
    async execute(_toolCallId, params, signal, onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      onUpdate?.({
        content: [
          {
            text: "Requesting DeepSeek prefix completion…",
            type: "text" as const,
          },
        ],
        details: {},
      });
      const body = buildPrefixBody(params);
      const requestSignal = signal ?? context.signal;

      try {
        const outcome = await withRetries(
          () => beta.postChatCompletion(body, requestSignal),
          { maxRetries: MAX_RETRIES, signal: requestSignal }
        );
        const response = outcome.result;
        const choice = getFirstChoice(response);
        const message = getObject(choice, "message");
        const completion = getString(message, "content") ?? "";
        const finishReason = getString(choice, "finish_reason");
        const usage = telemetry.mapChatUsage(response.usage, "prefix");
        pi.appendEntry(USAGE_ENTRY, telemetry.record(usage));
        telemetry.setFooter(context);
        const rawUsage = isJsonObject(response.usage)
          ? response.usage
          : undefined;
        const completionText = completion || "(empty completion)";
        const stopNote =
          finishReason !== undefined && finishReason !== "stop"
            ? ` [note: completion stopped: ${finishReason}]`
            : "";
        return {
          content: [
            {
              text: `${completionText}${stopNote}`,
              type: "text" as const,
            },
          ],
          details: {
            ...(outcome.retries > 0 ? { retries: outcome.retries } : {}),
            finish_reason: finishReason,
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
      } catch (error) {
        if (isCallerAbort(error)) {
          return createInterruptedResult(interruptedPhase(error));
        }
        throw error;
      }
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
    async execute(_toolCallId, params, signal, onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      onUpdate?.({
        content: [
          {
            text: "Requesting DeepSeek FIM completion…",
            type: "text" as const,
          },
        ],
        details: {},
      });
      const body = buildFimBody(params);
      const requestSignal = signal ?? context.signal;

      try {
        const outcome = await withRetries(
          () => beta.postCompletion(body, requestSignal),
          { maxRetries: MAX_RETRIES, signal: requestSignal }
        );
        const response = outcome.result;
        const choice = getFirstChoice(response);
        const completion = getString(choice, "text") ?? "";
        const finishReason = getString(choice, "finish_reason");
        const usage = telemetry.mapChatUsage(response.usage, "fim");
        pi.appendEntry(USAGE_ENTRY, telemetry.record(usage));
        telemetry.setFooter(context);
        const rawUsage = isJsonObject(response.usage)
          ? response.usage
          : undefined;
        const completionText = completion || "(empty completion)";
        const stopNote =
          finishReason !== undefined && finishReason !== "stop"
            ? ` [note: completion stopped: ${finishReason}]`
            : "";
        return {
          content: [
            {
              text: `${completionText}${stopNote}`,
              type: "text" as const,
            },
          ],
          details: {
            ...(outcome.retries > 0 ? { retries: outcome.retries } : {}),
            finish_reason: finishReason,
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
      } catch (error) {
        if (isCallerAbort(error)) {
          return createInterruptedResult(interruptedPhase(error));
        }
        throw error;
      }
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
      "Run DeepSeek's server-side web search (Responses API web_search tool) for a query and return the model's answer, including citations where available. Reasoning effort accepts none, minimal, low, medium, high, xhigh, or max.",
    async execute(_toolCallId, params, signal, onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      onUpdate?.({
        content: [
          { text: "Running DeepSeek web search…", type: "text" as const },
        ],
        details: {},
      });
      const requestSignal = signal ?? context.signal;

      try {
        const outcome = await withRetries(
          () =>
            responses.webSearch(
              params.query,
              params.reasoning_effort,
              params.max_output_tokens,
              requestSignal
            ),
          { maxRetries: MAX_RETRIES, signal: requestSignal }
        );
        const { result } = outcome;
        const usage = telemetry.mapResponsesUsage(result.usage, "search");
        pi.appendEntry(USAGE_ENTRY, telemetry.record(usage));
        telemetry.setFooter(context);
        return {
          content: [
            { text: result.text || "(no answer)", type: "text" as const },
          ],
          details: {
            ...(outcome.retries > 0 ? { retries: outcome.retries } : {}),
            query: params.query,
            responseId: result.responseId,
            searchCalls: result.calls,
            thinking: result.thinking,
            usage,
          },
        };
      } catch (error) {
        if (isCallerAbort(error)) {
          return createInterruptedResult(interruptedPhase(error));
        }
        throw error;
      }
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
      "Force DeepSeek V4 to produce the named strict-mode function call for the given JSON schema. This helper uses non-thinking mode because DeepSeek rejects forced tool choice in thinking mode. The schema is normalized to DeepSeek's strict dialect (all object properties required, additionalProperties false, strings with supported pattern/format only, numbers with bounds/multipleOf, arrays without min/maxItems, enum/anyOf/$ref/$def). Returns the parsed arguments.",
    async execute(_toolCallId, params, signal, onUpdate, context) {
      if (!requireDeepSeekEnabled(runtimeState, context)) {
        return createDisabledToolResult();
      }
      onUpdate?.({
        content: [
          { text: "Requesting DeepSeek function call…", type: "text" as const },
        ],
        details: {},
      });
      validateFunctionName(params.name);
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
      try {
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

        const validationFailures = validateStrictArguments(
          strictParameters,
          parsedArguments
        );
        if (validationFailures.length > 0) {
          throw new Error(
            `DeepSeek returned schema-invalid arguments for required function "${params.name}": ${validationFailures.slice(0, 3).join("; ")}`
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
      } catch (error) {
        if (isCallerAbort(error)) {
          return createInterruptedResult(interruptedPhase(error));
        }
        throw error;
      }
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
