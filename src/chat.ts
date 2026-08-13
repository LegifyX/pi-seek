import type { ResponseChatOptions } from "./config.ts";
import type { ParsedResponsesResult } from "./responses.ts";
import {
  isContextLengthError,
  MAX_RETRIES,
  type RetryOptions,
  type RetryOutcome,
  RetryWaitAbortedError,
  withRetries,
} from "./retry.ts";
import { trimThreadForContext } from "./threads.ts";

// ---------------------------------------------------------------------------
// ds_chat request orchestration: retries, trim-and-retry, interruption
// ---------------------------------------------------------------------------

export interface ChatService {
  chat: (
    input: unknown[],
    options: ResponseChatOptions
  ) => Promise<ParsedResponsesResult>;
}

export type ChatOutcome =
  | {
      interrupted: false;
      result: ParsedResponsesResult;
      retries: number;
      // Items dropped by the context-length trim-and-retry (0 when no trim).
      trimmed: number;
    }
  | {
      interrupted: true;
      // "retry_wait" when the caller's abort signal fired while waiting
      // between backoff retries; "request" when it fired mid-request.
      phase: "request" | "retry_wait";
    };

const isAbortError = (error: unknown): boolean =>
  error instanceof RetryWaitAbortedError ||
  (error instanceof Error && error.message === "Aborted by user");

const interruptedOutcome = (
  error: unknown
): Extract<ChatOutcome, { interrupted: true }> => ({
  interrupted: true,
  phase: error instanceof RetryWaitAbortedError ? "retry_wait" : "request",
});

// Runs a ds_chat request with capped-exponential-backoff HTTP retries. On a
// context-length failure the replay is trimmed once (oldest assistant/tool
// turns first, then older user messages; system prompt and the most recent
// user message are kept) and the request is retried exactly once. Caller
// aborts never throw: they return a bounded structured outcome with
// `interrupted: true` so the caller can recover gracefully.
export const runChatWithRecovery = async (
  service: ChatService,
  input: unknown[],
  options: ResponseChatOptions,
  deps: { wait?: RetryOptions["wait"] } = {}
): Promise<ChatOutcome> => {
  const attempt = (
    items: unknown[]
  ): Promise<RetryOutcome<ParsedResponsesResult>> =>
    withRetries(() => service.chat(items, options), {
      maxRetries: MAX_RETRIES,
      signal: options.signal,
      wait: deps.wait,
    });

  try {
    const outcome = await attempt(input);
    return {
      interrupted: false,
      result: outcome.result,
      retries: outcome.retries,
      trimmed: 0,
    };
  } catch (error) {
    if (isAbortError(error)) {
      return interruptedOutcome(error);
    }
    if (!isContextLengthError(error)) {
      throw error;
    }
    const trimmed = trimThreadForContext(input);
    if (trimmed.trimmed === 0) {
      throw error;
    }
    try {
      const outcome = await attempt(trimmed.items);
      return {
        interrupted: false,
        result: outcome.result,
        retries: outcome.retries,
        trimmed: trimmed.trimmed,
      };
    } catch (retryError) {
      if (isAbortError(retryError)) {
        return interruptedOutcome(retryError);
      }
      throw retryError;
    }
  }
};
