import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../deepseek-v4.ts";

const extract = (
  output: unknown
): ReturnType<typeof __test.extractResponsesText> =>
  __test.extractResponsesText(output);

test("a single message item yields its text", () => {
  const result = extract([
    { content: [{ text: "hi", type: "output_text" }], type: "message" },
  ]);
  assert.deepEqual(result, { calls: [], text: "hi", thinking: "" });
});

test("mixed items populate text, thinking, and calls in output order", () => {
  const result = extract([
    {
      content: [{ text: "think1", type: "reasoning_text" }],
      type: "reasoning",
    },
    { content: [{ text: "hello", type: "output_text" }], type: "message" },
    { name: "f", type: "function_call" },
    { id: "w", type: "web_search_call" },
  ]);
  assert.deepEqual(result, {
    calls: [
      { name: "f", type: "function_call" },
      { id: "w", type: "web_search_call" },
    ],
    text: "hello",
    thinking: "think1",
  });
});

test("message content concatenates accepted part types in order", () => {
  const result = extract([
    {
      content: [
        { text: "a", type: "output_text" },
        { text: "b", type: "unknown_kind" },
        { text: "c", type: "text" },
        { type: "output_text" },
      ],
      type: "message",
    },
  ]);
  assert.equal(result.text, "ac");
});

test("unknown and non-object items are ignored", () => {
  const result = extract([
    { content: [{ text: "kept", type: "output_text" }], type: "message" },
    { content: [{ text: "??", type: "output_text" }], type: "weird_thing" },
    "string-item",
    42,
    null,
    undefined,
  ]);
  assert.deepEqual(result, { calls: [], text: "kept", thinking: "" });
});

test("non-array output yields an empty result", () => {
  assert.deepEqual(extract(undefined), { calls: [], text: "", thinking: "" });
  assert.deepEqual(extract({ type: "message" }), {
    calls: [],
    text: "",
    thinking: "",
  });
  assert.deepEqual(extract("nope"), { calls: [], text: "", thinking: "" });
});
