import {
  DEFAULT_EFFORT,
  type Effort,
  getArray,
  getString,
  isJsonObject,
  type JsonObject,
  MODEL_ID,
  type ResponseChatOptions,
  type ResponsesResult,
} from "./config.ts";
import type { HttpClient } from "./http.ts";

// ---------------------------------------------------------------------------
// Responses API service
// ---------------------------------------------------------------------------

export interface ResponsesApi {
  chat: (
    input: unknown[],
    options: ResponseChatOptions
  ) => Promise<ResponsesResult>;
  webSearch: (
    query: string,
    effort: Effort | undefined,
    maxOutputTokens: number | undefined,
    signal: AbortSignal | undefined
  ) => Promise<ResponsesResult>;
}

const extractContentText = (
  item: JsonObject,
  acceptedTypes?: ReadonlySet<string>
): string => {
  let text = "";
  for (const rawPart of getArray(item, "content")) {
    if (!isJsonObject(rawPart)) {
      continue;
    }
    const partType = getString(rawPart, "type");
    const acceptsPartType =
      !acceptedTypes || (partType !== undefined && acceptedTypes.has(partType));
    if (!acceptsPartType) {
      continue;
    }
    text += getString(rawPart, "text") ?? "";
  }
  return text;
};

const MESSAGE_CONTENT_TYPES = new Set(["output_text", "text"]);

export const extractResponsesText = (
  output: unknown
): Pick<ResponsesResult, "text" | "thinking" | "calls"> => {
  let text = "";
  let thinking = "";
  const calls: JsonObject[] = [];

  for (const rawItem of Array.isArray(output) ? output : []) {
    if (!isJsonObject(rawItem)) {
      continue;
    }
    switch (getString(rawItem, "type")) {
      case "message":
        text += extractContentText(rawItem, MESSAGE_CONTENT_TYPES);
        break;
      case "reasoning":
        thinking += extractContentText(rawItem);
        break;
      case "function_call":
      case "web_search_call":
        calls.push(rawItem);
        break;
      default:
        break;
    }
  }

  return { calls, text, thinking };
};

// Result enriched with lifecycle fields from the response envelope: the
// terminal status and, on an incomplete response, the incomplete_details
// payload. The base ResponsesResult (in config.ts) stays untouched; this
// extension lives at the parsing layer.
export interface ParsedResponsesResult extends ResponsesResult {
  incompleteDetails?: unknown;
  status?: string;
}

export const parseResponsesResult = (
  rawResponse: unknown
): ParsedResponsesResult => {
  const response = isJsonObject(rawResponse) ? rawResponse : {};
  const output = getArray(response, "output");
  const extracted = extractResponsesText(output);
  return {
    ...extracted,
    incompleteDetails: response.incomplete_details,
    items: output,
    responseId: getString(response, "id"),
    status: getString(response, "status"),
    usage: response.usage,
  };
};

export const buildChatBody = (
  input: unknown[],
  options: ResponseChatOptions
): JsonObject => {
  const body: JsonObject = {
    input,
    model: MODEL_ID,
    reasoning: { effort: options.effort ?? DEFAULT_EFFORT },
    stream: false,
  };
  if (options.system) {
    body.instructions = options.system;
  }
  if (options.maxOutputTokens) {
    body.max_output_tokens = options.maxOutputTokens;
  }
  return body;
};

export const buildWebSearchBody = (
  query: string,
  effort: Effort | undefined,
  maxOutputTokens: number | undefined
): JsonObject => {
  const body: JsonObject = {
    input: [{ content: [{ text: query, type: "input_text" }], role: "user" }],
    model: MODEL_ID,
    reasoning: { effort: effort ?? "low" },
    stream: false,
    tool_choice: { type: "web_search" },
    tools: [{ type: "web_search" }],
  };
  if (maxOutputTokens) {
    body.max_output_tokens = maxOutputTokens;
  }
  return body;
};

export const buildPrefixBody = (params: {
  max_tokens?: number;
  prefix: string;
  prompt: string;
  stop?: string[];
}): JsonObject => {
  const body: JsonObject = {
    messages: [
      { content: params.prompt, role: "user" },
      { content: params.prefix, prefix: true, role: "assistant" },
    ],
    model: MODEL_ID,
    stream: false,
  };
  if (params.stop?.length) {
    body.stop = params.stop;
  }
  if (params.max_tokens) {
    body.max_tokens = params.max_tokens;
  }
  return body;
};

export const buildFimBody = (params: {
  max_tokens?: number;
  prompt: string;
  stop?: string[];
  suffix?: string;
}): JsonObject => {
  const body: JsonObject = {
    model: MODEL_ID,
    prompt: params.prompt,
    stream: false,
  };
  if (params.suffix) {
    body.suffix = params.suffix;
  }
  if (params.max_tokens) {
    body.max_tokens = params.max_tokens;
  }
  if (params.stop?.length) {
    body.stop = params.stop;
  }
  return body;
};

export const createResponsesApi = (http: HttpClient): ResponsesApi => {
  const chat = async (
    input: unknown[],
    options: ResponseChatOptions
  ): Promise<ResponsesResult> =>
    parseResponsesResult(
      await http.postJson(
        "/responses",
        buildChatBody(input, options),
        options.signal
      )
    );

  const webSearch = async (
    query: string,
    effort: Effort | undefined,
    maxOutputTokens: number | undefined,
    signal: AbortSignal | undefined
  ): Promise<ResponsesResult> =>
    parseResponsesResult(
      await http.postJson(
        "/responses",
        buildWebSearchBody(query, effort, maxOutputTokens),
        signal
      )
    );

  return { chat, webSearch };
};
