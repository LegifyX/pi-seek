import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { __test } from "../src/index.ts";
import {
  CallFunctionParams,
  ChatParams,
  FimParams,
  WebSearchParams,
} from "../src/params.ts";

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

test("chat body with format json_object sets text.format", () => {
  assert.deepStrictEqual(buildChatBody(INPUT, { format: "json_object" }), {
    input: INPUT,
    model: "deepseek-v4-flash",
    reasoning: { effort: "high" },
    stream: false,
    text: { format: "json_object" },
  });
});

test("chat body with format json_schema normalizes the schema into text", () => {
  assert.deepStrictEqual(
    buildChatBody(INPUT, {
      format: "json_schema",
      jsonSchema: Type.Object({ name: Type.String() }),
    }),
    {
      input: INPUT,
      model: "deepseek-v4-flash",
      reasoning: { effort: "high" },
      stream: false,
      text: {
        format: "json_schema",
        json_schema: {
          additionalProperties: false,
          properties: { name: { type: "string" } },
          required: ["name"],
          type: "object",
        },
      },
    }
  );
});

test("chat body with format text emits the explicit text format", () => {
  assert.deepStrictEqual(buildChatBody(INPUT, { format: "text" }), {
    input: INPUT,
    model: "deepseek-v4-flash",
    reasoning: { effort: "high" },
    stream: false,
    text: { format: "text" },
  });
});

test("chat body passes every documented reasoning effort through verbatim", () => {
  const efforts = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const;
  for (const effort of efforts) {
    assert.deepStrictEqual(buildChatBody(INPUT, { effort }).reasoning, {
      effort,
    });
  }
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

test("chat body passes documented sampling params through", () => {
  const body = buildChatBody(INPUT, {
    effort: "none",
    temperature: 0.3,
    top_p: 0.9,
  });
  assert.deepEqual(body.temperature, 0.3);
  assert.deepEqual(body.top_p, 0.9);
});

test("prefix body accepts a single stop string and sampling params", () => {
  const body = buildPrefixBody({
    prefix: "```",
    prompt: "write quick sort",
    stop: "```",
    temperature: 0.2,
    top_p: 0.8,
  });
  assert.equal(body.stop, "```");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.8);
});

test("fim body accepts a single stop string, logprobs, and sampling params", () => {
  const body = buildFimBody({
    logprobs: 5,
    prompt: "before",
    stop: "END",
    suffix: "after",
    temperature: 0.1,
    top_p: 0.7,
  });
  assert.equal(body.stop, "END");
  assert.equal(body.logprobs, 5);
  assert.equal(body.temperature, 0.1);
  assert.equal(body.top_p, 0.7);
});

test("tool parameter schemas enforce documented caps", () => {
  const chatMax = ChatParams.properties.max_output_tokens as {
    maximum?: number;
  };
  assert.equal(chatMax.maximum, 393_216);
  const searchMax = WebSearchParams.properties.max_output_tokens as {
    maximum?: number;
  };
  assert.equal(searchMax.maximum, 393_216);
  const fimLogprobs = FimParams.properties.logprobs as { maximum?: number };
  assert.equal(fimLogprobs.maximum, 20);
  const stopSchema = FimParams.properties.stop as {
    anyOf?: Array<{ maxItems?: number; type?: string }>;
  };
  const stopArray = stopSchema.anyOf?.find((branch) => branch.type === "array");
  assert.equal(stopArray?.maxItems, 16);
  const nameSchema = CallFunctionParams.properties.name as {
    maxLength?: number;
  };
  assert.equal(nameSchema.maxLength, 64);
});
