import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../deepseek-v4.ts";

const isPersistable = __test.isPersistableItem;

test("function_call items are filtered out", () => {
  assert.equal(isPersistable({ type: "function_call" }), false);
  assert.equal(
    isPersistable({ id: "fc_1", name: "get_weather", type: "function_call" }),
    false
  );
});

test("web_search_call items are filtered out", () => {
  assert.equal(isPersistable({ id: "ws_1", type: "web_search_call" }), false);
});

test("message and reasoning items are kept", () => {
  assert.equal(
    isPersistable({
      content: [{ text: "hi", type: "output_text" }],
      type: "message",
    }),
    true
  );
  assert.equal(
    isPersistable({
      content: [{ text: "think", type: "reasoning_text" }],
      type: "reasoning",
    }),
    true
  );
});

test("objects without a type are kept", () => {
  assert.equal(isPersistable({ id: "x" }), true);
  assert.equal(isPersistable({}), true);
  assert.equal(isPersistable({ content: [] }), true);
});

test("non-object items are passed through", () => {
  assert.equal(isPersistable("raw-string"), true);
  assert.equal(isPersistable(42), true);
  assert.equal(isPersistable(null), true);
  assert.equal(isPersistable(undefined), true);
  assert.equal(isPersistable(["array"]), true);
});

test("filtering a mixed array drops only the two call item types", () => {
  const input = [
    { type: "function_call" },
    { id: "ws_1", type: "web_search_call" },
    { content: [{ text: "hi", type: "output_text" }], type: "message" },
    { content: [{ text: "think", type: "reasoning_text" }], type: "reasoning" },
    { id: "no-type" },
    "raw-string",
    7,
  ];
  assert.deepEqual(input.filter(isPersistable), [
    { content: [{ text: "hi", type: "output_text" }], type: "message" },
    { content: [{ text: "think", type: "reasoning_text" }], type: "reasoning" },
    { id: "no-type" },
    "raw-string",
    7,
  ]);
});

test("empty input maps to an empty filtered result", () => {
  assert.deepEqual([].filter(isPersistable), []);
});
