// ---------------------------------------------------------------------------
// Responses lifecycle / event / usage fixtures
//
// Source-versioned fixtures for the DeepSeek Responses streaming event model
// and result shapes documented in
// docs/research/deepseek-api-surface-2026-08-04.md. Responses SSE carries
// semantic events with monotonically increasing sequence numbers and
// optional `: keep-alive` comment lines; it has no `[DONE]` marker
// (unlike the Chat/FIM SSE surface). Responses usage uses
// input_tokens_details.cached_tokens and output_tokens_details.reasoning_tokens
// and never the Chat/FIM prompt_cache_* fields.
// ---------------------------------------------------------------------------

import type { JsonObject } from "../../src/config.ts";

export const KEEP_ALIVE_COMMENT = ": keep-alive";

export const RESPONSES_TERMINAL_TYPES = [
  "response.completed",
  "response.incomplete",
  "response.failed",
] as const;

// Every event family documented in the research report's Responses event
// table. Fixtures must represent all of these.
export const DOCUMENTED_EVENT_FAMILIES = [
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta",
  "response.custom_tool_call_input.done",
  "response.web_search_call.in_progress",
  "response.web_search_call.searching",
  "response.web_search_call.completed",
  "response.completed",
  "response.incomplete",
  "response.failed",
] as const;

// Event union --------------------------------------------------------------

interface EventBase {
  sequence_number: number;
}

export interface ResponseCreatedEvent extends EventBase {
  response: JsonObject;
  type: "response.created";
}

export interface ResponseInProgressEvent extends EventBase {
  response: JsonObject;
  type: "response.in_progress";
}

export interface OutputItemAddedEvent extends EventBase {
  item: JsonObject;
  output_index: number;
  type: "response.output_item.added";
}

export interface OutputItemDoneEvent extends EventBase {
  item: JsonObject;
  output_index: number;
  type: "response.output_item.done";
}

export interface ContentPartAddedEvent extends EventBase {
  content_index: number;
  item_id: string;
  output_index: number;
  part: JsonObject;
  type: "response.content_part.added";
}

export interface ContentPartDoneEvent extends EventBase {
  content_index: number;
  item_id: string;
  output_index: number;
  part: JsonObject;
  type: "response.content_part.done";
}

export interface ReasoningTextDeltaEvent extends EventBase {
  content_index: number;
  delta: string;
  item_id: string;
  output_index: number;
  type: "response.reasoning_text.delta";
}

export interface ReasoningTextDoneEvent extends EventBase {
  content_index: number;
  item_id: string;
  output_index: number;
  text: string;
  type: "response.reasoning_text.done";
}

export interface OutputTextDeltaEvent extends EventBase {
  content_index: number;
  delta: string;
  item_id: string;
  output_index: number;
  type: "response.output_text.delta";
}

export interface OutputTextDoneEvent extends EventBase {
  content_index: number;
  item_id: string;
  output_index: number;
  text: string;
  type: "response.output_text.done";
}

export interface FunctionCallArgumentsDeltaEvent extends EventBase {
  delta: string;
  item_id: string;
  output_index: number;
  type: "response.function_call_arguments.delta";
}

export interface FunctionCallArgumentsDoneEvent extends EventBase {
  arguments: string;
  item_id: string;
  output_index: number;
  type: "response.function_call_arguments.done";
}

export interface CustomToolCallInputDeltaEvent extends EventBase {
  delta: string;
  item_id: string;
  output_index: number;
  type: "response.custom_tool_call_input.delta";
}

export interface CustomToolCallInputDoneEvent extends EventBase {
  input: string;
  item_id: string;
  output_index: number;
  type: "response.custom_tool_call_input.done";
}

export interface WebSearchCallInProgressEvent extends EventBase {
  item_id: string;
  output_index: number;
  type: "response.web_search_call.in_progress";
}

export interface WebSearchCallSearchingEvent extends EventBase {
  item_id: string;
  output_index: number;
  type: "response.web_search_call.searching";
}

export interface WebSearchCallCompletedEvent extends EventBase {
  item_id: string;
  output_index: number;
  type: "response.web_search_call.completed";
}

export interface ResponseCompletedEvent extends EventBase {
  response: JsonObject;
  type: "response.completed";
}

export interface ResponseIncompleteEvent extends EventBase {
  response: JsonObject;
  type: "response.incomplete";
}

export interface ResponseFailedEvent extends EventBase {
  response: JsonObject;
  type: "response.failed";
}

export type ResponsesEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | OutputItemAddedEvent
  | OutputItemDoneEvent
  | ContentPartAddedEvent
  | ContentPartDoneEvent
  | ReasoningTextDeltaEvent
  | ReasoningTextDoneEvent
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  | CustomToolCallInputDeltaEvent
  | CustomToolCallInputDoneEvent
  | WebSearchCallInProgressEvent
  | WebSearchCallSearchingEvent
  | WebSearchCallCompletedEvent
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseFailedEvent;

// Stream shape -------------------------------------------------------------

export type StreamLine =
  | { event: ResponsesEvent; kind: "event" }
  | { kind: "comment"; text: string };

export interface ResponsesStream {
  lines: StreamLine[];
  name: string;
}

// Serializes a stream to raw SSE text lines (comments pass through verbatim,
// events render as `event:` plus `data:` JSON) so tests can assert on the
// wire format, including the absence of a [DONE] marker.
export const serializeResponsesStream = (stream: ResponsesStream): string[] => {
  const lines: string[] = [];
  for (const line of stream.lines) {
    if (line.kind === "comment") {
      lines.push(line.text);
      continue;
    }
    lines.push(`event: ${line.event.type}`);
    lines.push(`data: ${JSON.stringify(line.event)}`);
  }
  return lines;
};

// Terminal result shapes ---------------------------------------------------
// Documented response envelope: object "response", a terminal status, output
// items, and (for incomplete/failed) incomplete_details/error.

export const completedResponseResult: JsonObject = {
  id: "resp_completed_001",
  model: "deepseek-v4-flash",
  object: "response",
  output: [
    {
      id: "rs_1",
      summary: [
        {
          text: "The user asks for a stock price lookup.",
          type: "reasoning_text",
        },
      ],
      type: "reasoning",
    },
    {
      arguments: '{"symbol":"AAPL"}',
      call_id: "call_abc123",
      id: "fc_1",
      name: "lookup_price",
      type: "function_call",
    },
    {
      content: [
        { text: "The current price of AAPL is $228.41.", type: "output_text" },
      ],
      id: "msg_1",
      role: "assistant",
      type: "message",
    },
  ],
  status: "completed",
};

export const incompleteResponseResult: JsonObject = {
  id: "resp_incomplete_001",
  incomplete_details: { reason: "max_output_tokens" },
  object: "response",
  output: [
    {
      content: [{ text: "The answer is", type: "output_text" }],
      id: "msg_partial_1",
      role: "assistant",
      type: "message",
    },
  ],
  status: "incomplete",
};

export const failedResponseResult: JsonObject = {
  error: {
    code: "server_error",
    message: "The server encountered an error while processing the response.",
  },
  id: "resp_failed_001",
  object: "response",
  output: [],
  status: "failed",
};

export const webSearchCompletedResponseResult: JsonObject = {
  id: "resp_web_search_001",
  model: "deepseek-v4-flash",
  object: "response",
  output: [
    { id: "wsc_1", type: "web_search_call" },
    {
      content: [
        {
          text: "According to the search results, the sky is blue.",
          type: "output_text",
        },
      ],
      id: "msg_ws_1",
      role: "assistant",
      type: "message",
    },
  ],
  status: "completed",
};

export const customToolCompletedResponseResult: JsonObject = {
  id: "resp_custom_tool_001",
  model: "deepseek-v4-flash",
  object: "response",
  output: [
    {
      id: "ctc_1",
      input: '{"city":"Paris"}',
      name: "get_weather",
      type: "custom_tool_call",
    },
  ],
  status: "completed",
};

// Streams ------------------------------------------------------------------
// Each stream: monotonically increasing sequence_number, a terminal event,
// and no [DONE] marker. Keep-alive comments are optional: streaming requests
// "may" receive them (research doc) and the live probe observed none, so the
// fixtures cover streams both with and without them.

export const completedStream: ResponsesStream = {
  lines: [
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    {
      event: {
        response: {
          id: "resp_completed_001",
          model: "deepseek-v4-flash",
          object: "response",
          status: "in_progress",
        },
        sequence_number: 0,
        type: "response.created",
      },
      kind: "event",
    },
    {
      event: {
        response: {
          id: "resp_completed_001",
          model: "deepseek-v4-flash",
          object: "response",
          status: "in_progress",
        },
        sequence_number: 1,
        type: "response.in_progress",
      },
      kind: "event",
    },
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    // reasoning item: deltas accumulate into the summary
    {
      event: {
        item: { id: "rs_1", summary: [], type: "reasoning" },
        output_index: 0,
        sequence_number: 2,
        type: "response.output_item.added",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "rs_1",
        output_index: 0,
        part: { text: "", type: "reasoning_text" },
        sequence_number: 3,
        type: "response.content_part.added",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        delta: "The user asks ",
        item_id: "rs_1",
        output_index: 0,
        sequence_number: 4,
        type: "response.reasoning_text.delta",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        delta: "for a stock price lookup.",
        item_id: "rs_1",
        output_index: 0,
        sequence_number: 5,
        type: "response.reasoning_text.delta",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "rs_1",
        output_index: 0,
        sequence_number: 6,
        text: "The user asks for a stock price lookup.",
        type: "response.reasoning_text.done",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "rs_1",
        output_index: 0,
        part: {
          text: "The user asks for a stock price lookup.",
          type: "reasoning_text",
        },
        sequence_number: 7,
        type: "response.content_part.done",
      },
      kind: "event",
    },
    {
      event: {
        item: {
          id: "rs_1",
          summary: [
            {
              text: "The user asks for a stock price lookup.",
              type: "reasoning_text",
            },
          ],
          type: "reasoning",
        },
        output_index: 0,
        sequence_number: 8,
        type: "response.output_item.done",
      },
      kind: "event",
    },
    // function_call item: argument deltas accumulate into `arguments`
    {
      event: {
        item: {
          arguments: "",
          call_id: "call_abc123",
          id: "fc_1",
          name: "lookup_price",
          type: "function_call",
        },
        output_index: 1,
        sequence_number: 9,
        type: "response.output_item.added",
      },
      kind: "event",
    },
    {
      event: {
        delta: '{"symbol":"',
        item_id: "fc_1",
        output_index: 1,
        sequence_number: 10,
        type: "response.function_call_arguments.delta",
      },
      kind: "event",
    },
    {
      event: {
        delta: 'AAPL"}',
        item_id: "fc_1",
        output_index: 1,
        sequence_number: 11,
        type: "response.function_call_arguments.delta",
      },
      kind: "event",
    },
    {
      event: {
        arguments: '{"symbol":"AAPL"}',
        item_id: "fc_1",
        output_index: 1,
        sequence_number: 12,
        type: "response.function_call_arguments.done",
      },
      kind: "event",
    },
    {
      event: {
        item: {
          arguments: '{"symbol":"AAPL"}',
          call_id: "call_abc123",
          id: "fc_1",
          name: "lookup_price",
          type: "function_call",
        },
        output_index: 1,
        sequence_number: 13,
        type: "response.output_item.done",
      },
      kind: "event",
    },
    // message item: output_text deltas accumulate into the visible text
    {
      event: {
        item: {
          content: [{ text: "", type: "output_text" }],
          id: "msg_1",
          role: "assistant",
          type: "message",
        },
        output_index: 2,
        sequence_number: 14,
        type: "response.output_item.added",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "msg_1",
        output_index: 2,
        part: { text: "", type: "output_text" },
        sequence_number: 15,
        type: "response.content_part.added",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        delta: "The current price ",
        item_id: "msg_1",
        output_index: 2,
        sequence_number: 16,
        type: "response.output_text.delta",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        delta: "of AAPL is $228.41.",
        item_id: "msg_1",
        output_index: 2,
        sequence_number: 17,
        type: "response.output_text.delta",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "msg_1",
        output_index: 2,
        sequence_number: 18,
        text: "The current price of AAPL is $228.41.",
        type: "response.output_text.done",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "msg_1",
        output_index: 2,
        part: {
          text: "The current price of AAPL is $228.41.",
          type: "output_text",
        },
        sequence_number: 19,
        type: "response.content_part.done",
      },
      kind: "event",
    },
    {
      event: {
        item: {
          content: [
            {
              text: "The current price of AAPL is $228.41.",
              type: "output_text",
            },
          ],
          id: "msg_1",
          role: "assistant",
          type: "message",
        },
        output_index: 2,
        sequence_number: 20,
        type: "response.output_item.done",
      },
      kind: "event",
    },
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    {
      event: {
        response: completedResponseResult,
        sequence_number: 21,
        type: "response.completed",
      },
      kind: "event",
    },
  ],
  name: "completed",
};

// Mirrors the live-verified streaming probe (terminal `response.incomplete`,
// no keep-alive comments): keep-alives are optional on this surface.
export const incompleteStream: ResponsesStream = {
  lines: [
    {
      event: {
        response: {
          id: "resp_incomplete_001",
          model: "deepseek-v4-flash",
          object: "response",
          status: "in_progress",
        },
        sequence_number: 0,
        type: "response.created",
      },
      kind: "event",
    },
    {
      event: {
        response: {
          id: "resp_incomplete_001",
          model: "deepseek-v4-flash",
          object: "response",
          status: "in_progress",
        },
        sequence_number: 1,
        type: "response.in_progress",
      },
      kind: "event",
    },
    {
      event: {
        item: {
          content: [{ text: "", type: "output_text" }],
          id: "msg_partial_1",
          role: "assistant",
          type: "message",
        },
        output_index: 0,
        sequence_number: 2,
        type: "response.output_item.added",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "msg_partial_1",
        output_index: 0,
        part: { text: "", type: "output_text" },
        sequence_number: 3,
        type: "response.content_part.added",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        delta: "The answer is",
        item_id: "msg_partial_1",
        output_index: 0,
        sequence_number: 4,
        type: "response.output_text.delta",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "msg_partial_1",
        output_index: 0,
        sequence_number: 5,
        text: "The answer is",
        type: "response.output_text.done",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "msg_partial_1",
        output_index: 0,
        part: { text: "The answer is", type: "output_text" },
        sequence_number: 6,
        type: "response.content_part.done",
      },
      kind: "event",
    },
    {
      event: {
        item: {
          content: [{ text: "The answer is", type: "output_text" }],
          id: "msg_partial_1",
          role: "assistant",
          type: "message",
        },
        output_index: 0,
        sequence_number: 7,
        type: "response.output_item.done",
      },
      kind: "event",
    },
    {
      event: {
        response: incompleteResponseResult,
        sequence_number: 8,
        type: "response.incomplete",
      },
      kind: "event",
    },
  ],
  name: "incomplete",
};

export const failedStream: ResponsesStream = {
  lines: [
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    {
      event: {
        response: {
          id: "resp_failed_001",
          model: "deepseek-v4-flash",
          object: "response",
          status: "in_progress",
        },
        sequence_number: 0,
        type: "response.created",
      },
      kind: "event",
    },
    {
      event: {
        response: {
          id: "resp_failed_001",
          model: "deepseek-v4-flash",
          object: "response",
          status: "in_progress",
        },
        sequence_number: 1,
        type: "response.in_progress",
      },
      kind: "event",
    },
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    {
      event: {
        response: failedResponseResult,
        sequence_number: 2,
        type: "response.failed",
      },
      kind: "event",
    },
  ],
  name: "failed",
};

export const webSearchStream: ResponsesStream = {
  lines: [
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    {
      event: {
        response: {
          id: "resp_web_search_001",
          model: "deepseek-v4-flash",
          object: "response",
          status: "in_progress",
        },
        sequence_number: 0,
        type: "response.created",
      },
      kind: "event",
    },
    {
      event: {
        response: {
          id: "resp_web_search_001",
          model: "deepseek-v4-flash",
          object: "response",
          status: "in_progress",
        },
        sequence_number: 1,
        type: "response.in_progress",
      },
      kind: "event",
    },
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    {
      event: {
        item: { id: "wsc_1", type: "web_search_call" },
        output_index: 0,
        sequence_number: 2,
        type: "response.output_item.added",
      },
      kind: "event",
    },
    {
      event: {
        item_id: "wsc_1",
        output_index: 0,
        sequence_number: 3,
        type: "response.web_search_call.in_progress",
      },
      kind: "event",
    },
    {
      event: {
        item_id: "wsc_1",
        output_index: 0,
        sequence_number: 4,
        type: "response.web_search_call.searching",
      },
      kind: "event",
    },
    {
      event: {
        item_id: "wsc_1",
        output_index: 0,
        sequence_number: 5,
        type: "response.web_search_call.completed",
      },
      kind: "event",
    },
    {
      event: {
        item: { id: "wsc_1", type: "web_search_call" },
        output_index: 0,
        sequence_number: 6,
        type: "response.output_item.done",
      },
      kind: "event",
    },
    {
      event: {
        item: {
          content: [{ text: "", type: "output_text" }],
          id: "msg_ws_1",
          role: "assistant",
          type: "message",
        },
        output_index: 1,
        sequence_number: 7,
        type: "response.output_item.added",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "msg_ws_1",
        output_index: 1,
        part: { text: "", type: "output_text" },
        sequence_number: 8,
        type: "response.content_part.added",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        delta: "According to ",
        item_id: "msg_ws_1",
        output_index: 1,
        sequence_number: 9,
        type: "response.output_text.delta",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        delta: "the search results, the sky is blue.",
        item_id: "msg_ws_1",
        output_index: 1,
        sequence_number: 10,
        type: "response.output_text.delta",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "msg_ws_1",
        output_index: 1,
        sequence_number: 11,
        text: "According to the search results, the sky is blue.",
        type: "response.output_text.done",
      },
      kind: "event",
    },
    {
      event: {
        content_index: 0,
        item_id: "msg_ws_1",
        output_index: 1,
        part: {
          text: "According to the search results, the sky is blue.",
          type: "output_text",
        },
        sequence_number: 12,
        type: "response.content_part.done",
      },
      kind: "event",
    },
    {
      event: {
        item: {
          content: [
            {
              text: "According to the search results, the sky is blue.",
              type: "output_text",
            },
          ],
          id: "msg_ws_1",
          role: "assistant",
          type: "message",
        },
        output_index: 1,
        sequence_number: 13,
        type: "response.output_item.done",
      },
      kind: "event",
    },
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    {
      event: {
        response: webSearchCompletedResponseResult,
        sequence_number: 14,
        type: "response.completed",
      },
      kind: "event",
    },
  ],
  name: "web_search",
};

export const customToolStream: ResponsesStream = {
  lines: [
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    {
      event: {
        response: {
          id: "resp_custom_tool_001",
          model: "deepseek-v4-flash",
          object: "response",
          status: "in_progress",
        },
        sequence_number: 0,
        type: "response.created",
      },
      kind: "event",
    },
    {
      event: {
        response: {
          id: "resp_custom_tool_001",
          model: "deepseek-v4-flash",
          object: "response",
          status: "in_progress",
        },
        sequence_number: 1,
        type: "response.in_progress",
      },
      kind: "event",
    },
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    {
      event: {
        item: {
          id: "ctc_1",
          input: "",
          name: "get_weather",
          type: "custom_tool_call",
        },
        output_index: 0,
        sequence_number: 2,
        type: "response.output_item.added",
      },
      kind: "event",
    },
    {
      event: {
        delta: '{"city":"',
        item_id: "ctc_1",
        output_index: 0,
        sequence_number: 3,
        type: "response.custom_tool_call_input.delta",
      },
      kind: "event",
    },
    {
      event: {
        delta: 'Paris"}',
        item_id: "ctc_1",
        output_index: 0,
        sequence_number: 4,
        type: "response.custom_tool_call_input.delta",
      },
      kind: "event",
    },
    {
      event: {
        input: '{"city":"Paris"}',
        item_id: "ctc_1",
        output_index: 0,
        sequence_number: 5,
        type: "response.custom_tool_call_input.done",
      },
      kind: "event",
    },
    {
      event: {
        item: {
          id: "ctc_1",
          input: '{"city":"Paris"}',
          name: "get_weather",
          type: "custom_tool_call",
        },
        output_index: 0,
        sequence_number: 6,
        type: "response.output_item.done",
      },
      kind: "event",
    },
    { kind: "comment", text: KEEP_ALIVE_COMMENT },
    {
      event: {
        response: customToolCompletedResponseResult,
        sequence_number: 7,
        type: "response.completed",
      },
      kind: "event",
    },
  ],
  name: "custom_tool",
};

export const allResponsesStreams: ResponsesStream[] = [
  completedStream,
  incompleteStream,
  failedStream,
  webSearchStream,
  customToolStream,
];

// Usage shape --------------------------------------------------------------
// Responses usage: cached input under input_tokens_details.cached_tokens,
// reasoning output under output_tokens_details.reasoning_tokens. The
// Chat/FIM prompt_cache_* fields never appear on this surface.

export const responsesUsageFixture: JsonObject = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 800 },
  output_tokens: 200,
  output_tokens_details: { reasoning_tokens: 120 },
  total_tokens: 1200,
};
