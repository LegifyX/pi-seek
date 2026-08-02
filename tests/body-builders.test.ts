import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../deepseek-v4.ts";

const { buildChatBody, buildFimBody, buildPrefixBody, buildWebSearchBody } =
  __test;

const INPUT = [{ content: [{ text: "hi", type: "input_text" }], role: "user" }];

test("chat body with every option set", () => {
  assert.deepStrictEqual(
    buildChatBody(INPUT, {
      effort: "max",
      maxOutputTokens: 1000,
      system: "Be terse",
    }),
    {
      input: INPUT,
      instructions: "Be terse",
      max_output_tokens: 1000,
      model: "deepseek-v4-flash",
      reasoning: { effort: "max" },
      stream: false,
    }
  );
});

test("chat body minimal has no instructions or max_output_tokens keys", () => {
  const body = buildChatBody(INPUT, {});
  assert.equal("instructions" in body, false);
  assert.equal("max_output_tokens" in body, false);
  assert.deepStrictEqual(body, {
    input: INPUT,
    model: "deepseek-v4-flash",
    reasoning: { effort: "high" },
    stream: false,
  });
});

test("chat body with system only adds instructions, no max_output_tokens", () => {
  const body = buildChatBody(INPUT, { system: "You are terse" });
  assert.equal("max_output_tokens" in body, false);
  assert.deepStrictEqual(body, {
    input: INPUT,
    instructions: "You are terse",
    model: "deepseek-v4-flash",
    reasoning: { effort: "high" },
    stream: false,
  });
});

test("webSearch body defaults the effort to low", () => {
  assert.deepStrictEqual(buildWebSearchBody("query", undefined, undefined), {
    input: [{ content: [{ text: "query", type: "input_text" }], role: "user" }],
    model: "deepseek-v4-flash",
    reasoning: { effort: "low" },
    stream: false,
    tool_choice: { type: "web_search" },
    tools: [{ type: "web_search" }],
  });
});

test("webSearch body honors effort and maxOutputTokens", () => {
  assert.deepStrictEqual(buildWebSearchBody("query", "high", 500), {
    input: [{ content: [{ text: "query", type: "input_text" }], role: "user" }],
    max_output_tokens: 500,
    model: "deepseek-v4-flash",
    reasoning: { effort: "high" },
    stream: false,
    tool_choice: { type: "web_search" },
    tools: [{ type: "web_search" }],
  });
});

test("prefix body minimal never sets max_output_tokens", () => {
  const body = buildPrefixBody({ prefix: "```python\n", prompt: "write code" });
  assert.equal("max_output_tokens" in body, false);
  assert.deepStrictEqual(body, {
    messages: [
      { content: "write code", role: "user" },
      { content: "```python\n", prefix: true, role: "assistant" },
    ],
    model: "deepseek-v4-flash",
    stream: false,
  });
});

test("prefix body with max_tokens and stop sets only max_tokens", () => {
  const body = buildPrefixBody({
    max_tokens: 128,
    prefix: "```",
    prompt: "write quick sort",
    stop: ["```"],
  });
  assert.equal("max_output_tokens" in body, false);
  assert.deepStrictEqual(body, {
    max_tokens: 128,
    messages: [
      { content: "write quick sort", role: "user" },
      { content: "```", prefix: true, role: "assistant" },
    ],
    model: "deepseek-v4-flash",
    stop: ["```"],
    stream: false,
  });
});

test("fim body minimal never sets max_output_tokens", () => {
  const body = buildFimBody({ prompt: "const x = " });
  assert.equal("max_output_tokens" in body, false);
  assert.deepStrictEqual(body, {
    model: "deepseek-v4-flash",
    prompt: "const x = ",
    stream: false,
  });
});

test("fim body with all fields sets max_tokens, never max_output_tokens", () => {
  const body = buildFimBody({
    max_tokens: 256,
    prompt: "before",
    stop: ["end"],
    suffix: "after",
  });
  assert.equal("max_output_tokens" in body, false);
  assert.deepStrictEqual(body, {
    max_tokens: 256,
    model: "deepseek-v4-flash",
    prompt: "before",
    stop: ["end"],
    stream: false,
    suffix: "after",
  });
});
