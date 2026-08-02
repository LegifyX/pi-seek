import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../deepseek-v4.ts";

const extract = __test.extractRequiredFunctionCall;

const withToolCall = (
  toolCall: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  tool_calls: [{ id: "call_1", type: "function", ...toolCall }],
  type: "message",
  ...extra,
});

test("a valid call returns calledName and rawArguments", () => {
  const result = extract(
    withToolCall({
      function: { arguments: '{"a":1}', name: "my_fn" },
    }),
    "my_fn"
  );
  assert.deepEqual(result, {
    calledName: "my_fn",
    rawArguments: '{"a":1}',
  });
});

test("no tool_calls throws with the content appended", () => {
  assert.throws(
    () => extract({ content: "I refuse", type: "message" }, "req_fn"),
    {
      message: 'DeepSeek did not call the required function "req_fn": I refuse',
    }
  );
});

test("no tool_calls and no content yields the (no content) suffix", () => {
  assert.throws(() => extract({ type: "message" }, "req_fn"), {
    message:
      'DeepSeek did not call the required function "req_fn": (no content)',
  });
});

test("a wrong function name throws with the exact message", () => {
  assert.throws(
    () =>
      extract(
        withToolCall({
          function: { arguments: "{}", name: "other_fn" },
        }),
        "req_fn"
      ),
    {
      message:
        'DeepSeek called "other_fn" instead of required function "req_fn"',
    }
  );
});

test("an unnamed wrong call reports (unnamed)", () => {
  assert.throws(
    () => extract(withToolCall({ function: { arguments: "{}" } }), "req_fn"),
    {
      message:
        'DeepSeek called "(unnamed)" instead of required function "req_fn"',
    }
  );
});

test("missing arguments throws with the exact message", () => {
  assert.throws(
    () => extract(withToolCall({ function: { name: "req_fn" } }), "req_fn"),
    {
      message: 'DeepSeek returned no arguments for required function "req_fn"',
    }
  );
});
