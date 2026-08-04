// ---------------------------------------------------------------------------
// End-to-end fixtures
//
// Shared fixture data for tests/end-to-end.test.ts: a models.json auth
// fixture, the fake key it resolves to, and JSON bodies for every endpoint
// the extension can reach. Everything here is a mock — no real credentials,
// no live API access.
// ---------------------------------------------------------------------------

import type { JsonObject } from "../../src/config.ts";

// The key is a fixture value only; it never appears in production code, logs,
// or real requests. Assertions compare the Authorization header against this
// constant without ever printing it.
export const E2E_API_KEY = "e2e-fixture-key";

export const MODELS_JSON_FIXTURE: string = JSON.stringify({
  providers: {
    "deepseek-responses": { apiKey: E2E_API_KEY },
  },
});

// Responses API: a completed response carrying one assistant message plus a
// usage block in the Responses field dialect (cached input tokens under
// input_tokens_details.cached_tokens, reasoning output under
// output_tokens_details.reasoning_tokens).
export const responsesChatCompleted: JsonObject = {
  id: "resp_e2e_chat_001",
  model: "deepseek-v4-flash",
  object: "response",
  output: [
    {
      content: [
        { text: "The current price of AAPL is $228.41.", type: "output_text" },
      ],
      id: "msg_e2e_1",
      role: "assistant",
      type: "message",
    },
  ],
  status: "completed",
  usage: {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 800 },
    output_tokens: 200,
    output_tokens_details: { reasoning_tokens: 120 },
    total_tokens: 1200,
  },
};

// Responses API: a completed web-search response with a web_search_call item
// followed by the assistant's answer.
export const responsesWebSearchCompleted: JsonObject = {
  id: "resp_e2e_search_001",
  model: "deepseek-v4-flash",
  object: "response",
  output: [
    { id: "wsc_e2e_1", type: "web_search_call" },
    {
      content: [
        {
          text: "According to the search results, the sky is blue.",
          type: "output_text",
        },
      ],
      id: "msg_e2e_ws_1",
      role: "assistant",
      type: "message",
    },
  ],
  status: "completed",
  usage: {
    input_tokens: 500,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 100,
    output_tokens_details: {},
    total_tokens: 600,
  },
};

// Beta chat/completions: an assistant message plus Chat-dialect usage
// (prompt_cache_hit_tokens / prompt_cache_miss_tokens).
export const chatCompletionResponse = (content: string): JsonObject => ({
  choices: [{ index: 0, message: { content, role: "assistant" } }],
  usage: {
    completion_tokens: 10,
    prompt_cache_hit_tokens: 5,
    prompt_cache_miss_tokens: 8,
    prompt_tokens: 13,
    total_tokens: 23,
  },
});

// Beta completions: a plain text completion choice.
export const completionResponse = (text: string): JsonObject => ({
  choices: [{ index: 0, text }],
  usage: {
    completion_tokens: 10,
    prompt_tokens: 5,
    total_tokens: 15,
  },
});

// Beta chat/completions: the model force-calls the "lookup" function with the
// given (schema-valid) arguments string.
export const functionCallCompletion = (rawArguments: string): JsonObject => ({
  choices: [
    {
      index: 0,
      message: {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: { arguments: rawArguments, name: "lookup" },
            id: "call_e2e_1",
            type: "function",
          },
        ],
      },
    },
  ],
  usage: {
    completion_tokens: 12,
    prompt_tokens: 20,
    total_tokens: 32,
  },
});

// GET /user/balance: a valid USD entry.
export const balanceResponse: JsonObject = {
  balance_infos: [
    {
      currency: "USD",
      granted_balance: "1.00",
      topped_up_balance: "24.62",
      total_balance: "25.62",
    },
  ],
  is_available: true,
};
