import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getArray,
  getString,
  isJsonObject,
  type JsonObject,
} from "../src/config.ts";
import { parseResponsesResult } from "../src/responses.ts";
import {
  allResponsesStreams,
  completedResponseResult,
  completedStream,
  customToolCompletedResponseResult,
  customToolStream,
  DOCUMENTED_EVENT_FAMILIES,
  failedResponseResult,
  failedStream,
  incompleteResponseResult,
  incompleteStream,
  KEEP_ALIVE_COMMENT,
  RESPONSES_TERMINAL_TYPES,
  type ResponsesEvent,
  type ResponsesStream,
  responsesUsageFixture,
  serializeResponsesStream,
  webSearchCompletedResponseResult,
  webSearchStream,
} from "./fixtures/responses-events.ts";

const eventsOf = (stream: ResponsesStream): ResponsesEvent[] =>
  stream.lines
    .filter((line) => line.kind === "event")
    .map((line) => line.event);

// Concatenates every `delta` payload for one event family in stream order.
const accumulatedDeltas = (
  stream: ResponsesStream,
  deltaType: string
): string => {
  let text = "";
  for (const event of eventsOf(stream)) {
    if (event.type !== deltaType) {
      continue;
    }
    const { delta } = event as { delta?: unknown };
    if (typeof delta === "string") {
      text += delta;
    }
  }
  return text;
};

const terminalResponse = (stream: ResponsesStream): JsonObject => {
  const terminal = eventsOf(stream).at(-1);
  assert.ok(terminal, `${stream.name}: stream has no events`);
  assert.ok(
    (RESPONSES_TERMINAL_TYPES as readonly string[]).includes(terminal.type),
    `${stream.name}: last event ${terminal.type} is not terminal`
  );
  const { response } = terminal as { response?: unknown };
  assert.ok(
    isJsonObject(response),
    `${stream.name}: terminal event carries no response`
  );
  return response;
};

const outputItemOf = (
  result: JsonObject,
  itemType: string
): JsonObject | undefined =>
  getArray(result, "output").find(
    (item): item is JsonObject =>
      isJsonObject(item) && getString(item, "type") === itemType
  );

const reasoningSummaryOf = (item: JsonObject): string =>
  getString(
    getArray(item, "summary")
      .filter(isJsonObject)
      .find((part) => getString(part, "type") === "reasoning_text"),
    "text"
  ) ?? "";

const messageTextOf = (item: JsonObject): string =>
  getString(
    getArray(item, "content")
      .filter(isJsonObject)
      .find((part) => getString(part, "type") === "output_text"),
    "text"
  ) ?? "";

// Fixture integrity --------------------------------------------------------

test("sequence numbers strictly increase within every stream", () => {
  for (const stream of allResponsesStreams) {
    let previous = -1;
    for (const event of eventsOf(stream)) {
      assert.ok(
        event.sequence_number > previous,
        `${stream.name}: sequence_number ${event.sequence_number} is not greater than ${previous}`
      );
      previous = event.sequence_number;
    }
  }
});

test("every stream ends with a terminal event", () => {
  for (const stream of allResponsesStreams) {
    const terminal = eventsOf(stream).at(-1);
    assert.ok(terminal, `${stream.name}: stream has no events`);
    assert.ok(
      (RESPONSES_TERMINAL_TYPES as readonly string[]).includes(terminal.type),
      `${stream.name}: last event ${terminal.type} is not terminal`
    );
  }
});

test("keep-alive comments are optional: fixtures cover streams with and without them", () => {
  const withKeepAlive = allResponsesStreams.filter((stream) =>
    stream.lines.some(
      (line) => line.kind === "comment" && line.text === KEEP_ALIVE_COMMENT
    )
  );
  const withoutKeepAlive = allResponsesStreams.filter(
    (stream) =>
      !stream.lines.some(
        (line) => line.kind === "comment" && line.text === KEEP_ALIVE_COMMENT
      )
  );
  // Streaming requests "may" receive keep-alives (research doc), and the
  // live probe observed a stream with none, so both shapes must be fixtures.
  assert.ok(
    withKeepAlive.length > 0,
    "at least one stream should carry keep-alive comments"
  );
  assert.ok(
    withoutKeepAlive.length > 0,
    "at least one stream should omit keep-alive comments"
  );
});

test("keep-alive comments are ignorable on the wire", () => {
  const kept = allResponsesStreams.find((stream) =>
    stream.lines.some(
      (line) => line.kind === "comment" && line.text === KEEP_ALIVE_COMMENT
    )
  );
  assert.ok(kept, "expected a stream carrying keep-alive comments");
  const serialized = serializeResponsesStream(kept);
  assert.ok(
    serialized.includes(KEEP_ALIVE_COMMENT),
    "keep-alive comment should pass through serialization verbatim"
  );
  // Comment lines never render as `event:`/`data:` pairs, so an SSE reader
  // that ignores them still sees the full event sequence.
  assert.equal(
    serialized.filter(
      (line) => line.startsWith("event: ") || line.startsWith("data: ")
    ).length,
    eventsOf(kept).length * 2
  );
});

test("no fixture serializes to SSE text containing the [DONE] marker", () => {
  const serialized = [
    ...allResponsesStreams.flatMap((stream) =>
      serializeResponsesStream(stream)
    ),
    JSON.stringify(completedResponseResult),
    JSON.stringify(incompleteResponseResult),
    JSON.stringify(failedResponseResult),
    JSON.stringify(webSearchCompletedResponseResult),
    JSON.stringify(customToolCompletedResponseResult),
    JSON.stringify(responsesUsageFixture),
  ].join("\n");
  assert.ok(!serialized.includes("[DONE]"), "found [DONE] in a fixture");
});

test("every documented event family is represented in the fixtures", () => {
  const present = new Set(
    allResponsesStreams.flatMap((stream) =>
      eventsOf(stream).map((event) => event.type)
    )
  );
  for (const family of DOCUMENTED_EVENT_FAMILIES) {
    assert.ok(present.has(family), `missing event family: ${family}`);
  }
});

test("each stream's terminal response carries its documented terminal status", () => {
  const statuses = [
    [completedStream, "completed"],
    [incompleteStream, "incomplete"],
    [failedStream, "failed"],
    [webSearchStream, "completed"],
    [customToolStream, "completed"],
  ] as const;
  for (const [stream, expectedStatus] of statuses) {
    assert.equal(
      getString(terminalResponse(stream), "status"),
      expectedStatus,
      stream.name
    );
  }
});

// Usage shape --------------------------------------------------------------

test("Responses usage fixture never carries chat-style prompt_cache_* fields", () => {
  const serialized = JSON.stringify(responsesUsageFixture);
  assert.ok(!serialized.includes("prompt_cache_hit_tokens"));
  assert.ok(!serialized.includes("prompt_cache_miss_tokens"));
  const inputDetails = responsesUsageFixture.input_tokens_details;
  const outputDetails = responsesUsageFixture.output_tokens_details;
  assert.ok(isJsonObject(inputDetails) && "cached_tokens" in inputDetails);
  assert.ok(isJsonObject(outputDetails) && "reasoning_tokens" in outputDetails);
});

// Result shapes ------------------------------------------------------------

test("parseResponsesResult maps a completed response: status, text, and calls", () => {
  const result = parseResponsesResult(completedResponseResult);
  assert.equal(result.status, "completed");
  assert.equal(result.incompleteDetails, undefined);
  assert.equal(result.responseId, "resp_completed_001");
  assert.equal(result.text, "The current price of AAPL is $228.41.");
  assert.equal(result.calls.length, 1);
  const [call] = result.calls;
  assert.equal(getString(call, "type"), "function_call");
  assert.equal(getString(call, "call_id"), "call_abc123");
  assert.equal(getString(call, "arguments"), '{"symbol":"AAPL"}');
  const reasoningItem = outputItemOf(completedResponseResult, "reasoning");
  assert.ok(reasoningItem);
  assert.ok(reasoningSummaryOf(reasoningItem).length > 0);
});

test("parseResponsesResult maps an incomplete response with incomplete_details", () => {
  const result = parseResponsesResult(incompleteResponseResult);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.incompleteDetails, { reason: "max_output_tokens" });
  assert.equal(result.text, "The answer is");
});

test("parseResponsesResult maps a failed response and leaves incompleteDetails unset", () => {
  const result = parseResponsesResult(failedResponseResult);
  assert.equal(result.status, "failed");
  assert.equal(result.incompleteDetails, undefined);
  assert.equal(result.responseId, "resp_failed_001");
});

test("parseResponsesResult on a non-envelope input leaves lifecycle fields unset", () => {
  // A bare output array is not a response envelope: no status, no
  // incomplete_details, and no output to extract.
  const result = parseResponsesResult([
    { content: [{ text: "hi", type: "output_text" }], type: "message" },
  ]);
  assert.equal(result.status, undefined);
  assert.equal(result.incompleteDetails, undefined);
  assert.equal(result.text, "");
  assert.deepEqual(result.items, []);
});

// Delta accumulation -------------------------------------------------------

test("reasoning_text deltas accumulate to the terminal reasoning summary", () => {
  const reasoningItem = outputItemOf(completedResponseResult, "reasoning");
  assert.ok(reasoningItem);
  const summaryText = reasoningSummaryOf(reasoningItem);
  assert.ok(summaryText.length > 0, "terminal summary should not be empty");
  assert.equal(
    accumulatedDeltas(completedStream, "response.reasoning_text.delta"),
    summaryText
  );
});

test("output_text deltas accumulate to the terminal message text", () => {
  const messageItem = outputItemOf(completedResponseResult, "message");
  assert.ok(messageItem);
  const messageText = messageTextOf(messageItem);
  assert.ok(messageText.length > 0, "terminal message should not be empty");
  assert.equal(
    accumulatedDeltas(completedStream, "response.output_text.delta"),
    messageText
  );
});

test("function_call_arguments deltas accumulate to the terminal arguments", () => {
  const callItem = outputItemOf(completedResponseResult, "function_call");
  assert.ok(callItem);
  const argumentsText = getString(callItem, "arguments");
  assert.ok(argumentsText !== undefined);
  assert.equal(
    accumulatedDeltas(
      completedStream,
      "response.function_call_arguments.delta"
    ),
    argumentsText
  );
});

test("custom_tool_call_input deltas accumulate to the terminal input", () => {
  const toolItem = outputItemOf(
    customToolCompletedResponseResult,
    "custom_tool_call"
  );
  assert.ok(toolItem);
  const inputText = getString(toolItem, "input");
  assert.ok(inputText !== undefined);
  assert.equal(
    accumulatedDeltas(
      customToolStream,
      "response.custom_tool_call_input.delta"
    ),
    inputText
  );
});

// web_search_call lifecycle ------------------------------------------------

test("web_search_call lifecycle events and result shape", () => {
  const lifecycle = eventsOf(webSearchStream)
    .filter((event) => event.type.startsWith("response.web_search_call."))
    .map((event) => event.type);
  assert.deepEqual(lifecycle, [
    "response.web_search_call.in_progress",
    "response.web_search_call.searching",
    "response.web_search_call.completed",
  ]);

  const result = parseResponsesResult(webSearchCompletedResponseResult);
  assert.equal(result.status, "completed");
  const searchCall = result.calls.find(
    (call) => getString(call, "type") === "web_search_call"
  );
  assert.ok(searchCall);
  assert.equal(getString(searchCall, "id"), "wsc_1");
  assert.equal(
    result.text,
    "According to the search results, the sky is blue."
  );
});
