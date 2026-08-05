import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BalanceStore } from "../src/balance.ts";
import type { BetaApi } from "../src/beta.ts";
import { createRuntimeState, type JsonObject } from "../src/config.ts";
import type { ResponsesApi } from "../src/responses.ts";
import {
  toStrictSchema,
  validateStrictArguments,
} from "../src/strict-schema.ts";
import { createTelemetryStore } from "../src/telemetry.ts";
import type { ThreadStore } from "../src/threads.ts";
import { registerTools, type ToolServices } from "../src/tools.ts";

const INVALID_SCHEMA_ARGS_RE =
  /DeepSeek returned schema-invalid arguments for required function "lookup": arguments\.key: expected string/;
const INVALID_JSON_ARGS_RE =
  /DeepSeek returned invalid JSON arguments for required function "lookup"/;
const NO_TOOL_CALL_RE =
  /did not call the required function "lookup": I won't call/;
const WRONG_FUNCTION_RE =
  /called "other_fn" instead of required function "lookup"/;
const MISSING_ARGUMENTS_RE =
  /returned no arguments for required function "lookup"/;
const INVALID_FUNCTION_NAME_RE =
  /Invalid function name ".*" for ds_call_function: names must be nonempty, alphanumeric\/underscore\/hyphen, and at most 128 characters/;

// ---------------------------------------------------------------------------
// Pure validator coverage
// ---------------------------------------------------------------------------

test("object required properties: missing property is reported", () => {
  const schema = toStrictSchema(Type.Object({ name: Type.String() }));
  assert.deepEqual(validateStrictArguments(schema, { name: "x" }), []);
  assert.deepEqual(validateStrictArguments(schema, {}), [
    'arguments: missing required property "name"',
  ]);
});

test("additionalProperties false rejects extra keys", () => {
  const schema = toStrictSchema(Type.Object({ name: Type.String() }));
  assert.deepEqual(validateStrictArguments(schema, { extra: 1, name: "x" }), [
    'arguments: additional property "extra" is not allowed',
  ]);
});

test("enum values must be members of the allowed set", () => {
  const schema = toStrictSchema({ enum: ["a", "b"], type: "string" });
  assert.deepEqual(validateStrictArguments(schema, "a"), []);
  assert.deepEqual(validateStrictArguments(schema, "c"), [
    'arguments: value "c" is not in the allowed enum',
  ]);
});

test("anyOf accepts a value matching any single branch", () => {
  const schema = toStrictSchema({
    anyOf: [{ type: "string" }, { type: "number" }],
  });
  assert.deepEqual(validateStrictArguments(schema, "x"), []);
  assert.deepEqual(validateStrictArguments(schema, 5), []);
  assert.deepEqual(validateStrictArguments(schema, true), [
    "arguments: value does not match any allowed variant",
  ]);
});

test("$ref resolves against the hoisted $def registry", () => {
  const schema = toStrictSchema({
    $defs: {
      Point: {
        additionalProperties: false,
        properties: { x: { type: "integer" } },
        required: ["x"],
        type: "object",
      },
    },
    properties: { point: { $ref: "#/$defs/Point" } },
    type: "object",
  });
  assert.deepEqual(validateStrictArguments(schema, { point: { x: 1 } }), []);
  assert.deepEqual(validateStrictArguments(schema, { point: { x: "no" } }), [
    'arguments.point.x: expected integer, got "no"',
  ]);
  assert.deepEqual(validateStrictArguments(schema, { point: {} }), [
    'arguments.point: missing required property "x"',
  ]);
});

test("number bounds: minimum, maximum, exclusive bounds, and multipleOf", () => {
  const bounds = toStrictSchema({
    properties: { n: { maximum: 10, minimum: 0, type: "number" } },
    type: "object",
  });
  assert.deepEqual(validateStrictArguments(bounds, { n: 5 }), []);
  assert.deepEqual(validateStrictArguments(bounds, { n: -1 }), [
    "arguments.n: must be >= 0",
  ]);
  assert.deepEqual(validateStrictArguments(bounds, { n: 11 }), [
    "arguments.n: must be <= 10",
  ]);

  const exclusive = toStrictSchema({
    properties: {
      n: {
        exclusiveMaximum: 10,
        exclusiveMinimum: 0,
        type: "number",
      },
    },
    type: "object",
  });
  assert.deepEqual(validateStrictArguments(exclusive, { n: 5 }), []);
  assert.deepEqual(validateStrictArguments(exclusive, { n: 0 }), [
    "arguments.n: must be > 0",
  ]);
  assert.deepEqual(validateStrictArguments(exclusive, { n: 10 }), [
    "arguments.n: must be < 10",
  ]);

  const multiples = toStrictSchema({
    properties: { n: { multipleOf: 2, type: "number" } },
    type: "object",
  });
  assert.deepEqual(validateStrictArguments(multiples, { n: 4 }), []);
  assert.deepEqual(validateStrictArguments(multiples, { n: 3 }), [
    "arguments.n: must be a multiple of 2",
  ]);
});

test("integer rejects fractional values", () => {
  const schema = toStrictSchema(Type.Object({ n: Type.Integer() }));
  assert.deepEqual(validateStrictArguments(schema, { n: 3 }), []);
  assert.deepEqual(validateStrictArguments(schema, { n: 3.5 }), [
    "arguments.n: expected integer, got 3.5",
  ]);
});

test("array items validate each element by path", () => {
  const schema = toStrictSchema({ items: { type: "string" }, type: "array" });
  assert.deepEqual(validateStrictArguments(schema, ["a", "b"]), []);
  assert.deepEqual(validateStrictArguments(schema, ["a", 1]), [
    "arguments[1]: expected string, got 1",
  ]);
});

test("string pattern and supported formats", () => {
  const schema = toStrictSchema({
    properties: {
      email: { format: "email", type: "string" },
      id: { format: "uuid", type: "string" },
      slug: { pattern: "^[a-z]+$", type: "string" },
    },
    type: "object",
  });
  const valid = {
    email: "a@example.com",
    id: "123e4567-e89b-12d3-a456-426614174000",
    slug: "abc",
  };
  assert.deepEqual(validateStrictArguments(schema, valid), []);
  assert.deepEqual(
    validateStrictArguments(schema, { ...valid, email: "not-an-email" }),
    ["arguments.email: invalid email format"]
  );
  assert.deepEqual(validateStrictArguments(schema, { ...valid, slug: "ABC" }), [
    "arguments.slug: does not match pattern ^[a-z]+$",
  ]);
  assert.deepEqual(
    validateStrictArguments(schema, { ...valid, id: "not-a-uuid" }),
    ["arguments.id: invalid uuid format"]
  );
});

test("weird schema shapes never throw; they return failures or pass through", () => {
  assert.deepEqual(validateStrictArguments(undefined, { a: 1 }), []);
  assert.deepEqual(validateStrictArguments("not a schema", 5), []);
  assert.deepEqual(validateStrictArguments(null, null), []);

  const unresolvable = validateStrictArguments(
    {
      $def: {},
      additionalProperties: false,
      properties: { p: { $ref: "#/$def/Missing" } },
      required: ["p"],
      type: "object",
    },
    { p: 1 }
  );
  assert.ok(
    unresolvable.some((failure) => failure.includes("cannot resolve $ref"))
  );

  const badPattern = validateStrictArguments(
    {
      additionalProperties: false,
      properties: { p: { pattern: "(", type: "string" } },
      required: ["p"],
      type: "object",
    },
    { p: "x" }
  );
  assert.ok(badPattern.some((failure) => failure.includes("invalid pattern")));
});

test("circular $refs report a failure instead of looping forever", () => {
  const failures = validateStrictArguments(
    {
      $def: { A: { $ref: "#/$def/B" }, B: { $ref: "#/$def/A" } },
      $ref: "#/$def/A",
    },
    1
  );
  assert.ok(failures.some((failure) => failure.includes("circular $ref")));
});

// ---------------------------------------------------------------------------
// ds_call_function integration: validation gates execution
// ---------------------------------------------------------------------------

const createFunctionHarness = () => {
  const runtimeState = createRuntimeState();
  const telemetry = createTelemetryStore(runtimeState);
  const tools = new Map<string, unknown>();
  const pi = {
    appendEntry: () => undefined,
    registerTool: (tool: unknown) => {
      tools.set((tool as { name: string }).name, tool);
    },
  } as unknown as ExtensionAPI;

  const betaBehaviors: Array<
    (signal?: AbortSignal) => JsonObject | Promise<JsonObject>
  > = [];
  const beta: BetaApi = {
    postChatCompletion: async (_body, signal) => {
      const behavior = betaBehaviors.shift();
      if (!behavior) {
        throw new Error("unexpected extra postChatCompletion call");
      }
      return await behavior(signal);
    },
    postCompletion: () =>
      Promise.reject(new Error("unused in validate-arguments tests")),
  };
  const responses: ResponsesApi = {
    chat: () => Promise.reject(new Error("unused in validate-arguments tests")),
    webSearch: () =>
      Promise.reject(new Error("unused in validate-arguments tests")),
  };

  registerTools(pi, {
    balance: {} as BalanceStore,
    beta,
    responses,
    runtimeState,
    telemetry,
    threads: {} as ThreadStore,
  } satisfies ToolServices);

  const execute = (
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const tool = tools.get("ds_call_function") as {
      execute: (
        toolCallId: string,
        toolParams: Record<string, unknown>,
        toolSignal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown
      ) => Promise<unknown>;
    };
    return tool.execute("call_1", params, signal, undefined, {
      model: undefined,
      signal: undefined,
      ui: { notify: () => undefined, setStatus: () => undefined },
    });
  };

  return { betaBehaviors, execute };
};

const completionWithCall = (
  calledName: string,
  rawArguments: string
): JsonObject => ({
  choices: [
    {
      index: 0,
      message: {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: { arguments: rawArguments, name: calledName },
            id: "call_1",
            type: "function",
          },
        ],
      },
    },
  ],
  usage: {},
});

test("valid JSON and schema-valid arguments are returned and used", async () => {
  const { betaBehaviors, execute } = createFunctionHarness();
  betaBehaviors.push(() =>
    completionWithCall("lookup", '{"key":"abc","limit":3}')
  );
  const result = await execute({
    name: "lookup",
    parameters: Type.Object({
      key: Type.String(),
      limit: Type.Integer({ minimum: 1 }),
    }),
  });
  const { details } = result as { details: Record<string, unknown> };
  assert.deepEqual(details.arguments, { key: "abc", limit: 3 });
  assert.equal(details.name, "lookup");
  assert.equal(details.rawArguments, '{"key":"abc","limit":3}');
});

test("valid JSON but schema-invalid arguments are rejected and never returned", async () => {
  const { betaBehaviors, execute } = createFunctionHarness();
  betaBehaviors.push(() => completionWithCall("lookup", '{"key":42}'));
  await assert.rejects(
    execute({
      name: "lookup",
      parameters: Type.Object({ key: Type.String() }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, INVALID_SCHEMA_ARGS_RE);
      return true;
    }
  );
});

test("invalid JSON arguments are rejected", async () => {
  const { betaBehaviors, execute } = createFunctionHarness();
  betaBehaviors.push(() => completionWithCall("lookup", "{not json"));
  await assert.rejects(
    execute({
      name: "lookup",
      parameters: Type.Object({ key: Type.String() }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, INVALID_JSON_ARGS_RE);
      return true;
    }
  );
});

test("a response without tool_calls is rejected", async () => {
  const { betaBehaviors, execute } = createFunctionHarness();
  betaBehaviors.push(() => ({
    choices: [
      { index: 0, message: { content: "I won't call", role: "assistant" } },
    ],
    usage: {},
  }));
  await assert.rejects(
    execute({ name: "lookup", parameters: Type.Object({}) }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, NO_TOOL_CALL_RE);
      return true;
    }
  );
});

test("a different function name is rejected", async () => {
  const { betaBehaviors, execute } = createFunctionHarness();
  betaBehaviors.push(() => completionWithCall("other_fn", "{}"));
  await assert.rejects(
    execute({ name: "lookup", parameters: Type.Object({}) }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, WRONG_FUNCTION_RE);
      return true;
    }
  );
});

test("invalid function names are rejected before any network call", async () => {
  const { betaBehaviors, execute } = createFunctionHarness();
  const invalidNames = [
    "bad name!",
    "",
    "lookup.fn",
    "Ünïcode",
    "x".repeat(129),
  ];
  const results = await Promise.all(
    invalidNames.map(async (name) => {
      try {
        await execute({ name, parameters: Type.Object({}) });
        return { error: undefined, name };
      } catch (error) {
        return { error, name };
      }
    })
  );
  for (const { error, name } of results) {
    assert.ok(
      error instanceof Error,
      `name "${name}" must be rejected before any network call`
    );
    assert.match(error.message, INVALID_FUNCTION_NAME_RE);
  }
  assert.deepEqual(
    betaBehaviors,
    [],
    "invalid names must be rejected before any network call"
  );
});

// Mirrors a fetch that stays pending until the caller aborts: rejects with the
// http-level abort marker "Aborted by user" when the signal fires.
const abortDuringRequest = (signal?: AbortSignal): Promise<JsonObject> =>
  new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted by user"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(new Error("Aborted by user")),
      { once: true }
    );
  });

const interruptedResult = (result: unknown): Record<string, unknown> => {
  const raw = result as {
    content?: Array<{ text?: string }>;
    details?: Record<string, unknown>;
  };
  assert.ok(raw.content, "expected a content array in the tool result");
  assert.ok(raw.details, "expected details in the tool result");
  return { content: raw.content, ...raw.details };
};

test("ds_call_function converts an abort during the request into an interrupted result", async () => {
  const { betaBehaviors, execute } = createFunctionHarness();
  const controller = new AbortController();
  betaBehaviors.push(abortDuringRequest);
  setTimeout(() => controller.abort(), 10);
  const result = interruptedResult(
    await execute(
      { name: "lookup", parameters: Type.Object({}) },
      controller.signal
    )
  );
  assert.equal(result.interrupted, true);
  assert.equal(result.phase, "request");
  assert.equal(
    (result.content as Array<{ text?: string }>)[0]?.text,
    "Interrupted by the caller."
  );
});

test("ds_call_function converts an abort during the backoff wait into an interrupted result", async () => {
  const { betaBehaviors, execute } = createFunctionHarness();
  const controller = new AbortController();
  betaBehaviors.push(() => {
    throw new Error("DeepSeek API 503: overloaded");
  });
  // Fires while the first ~200ms backoff is still running.
  setTimeout(() => controller.abort(), 20);
  const result = interruptedResult(
    await execute(
      { name: "lookup", parameters: Type.Object({}) },
      controller.signal
    )
  );
  assert.equal(result.interrupted, true);
  assert.equal(result.phase, "retry_wait");
  assert.equal(
    (result.content as Array<{ text?: string }>)[0]?.text,
    "Interrupted by the caller."
  );
});

test("missing arguments are rejected", async () => {
  const { betaBehaviors, execute } = createFunctionHarness();
  betaBehaviors.push(() => ({
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          tool_calls: [
            {
              function: { name: "lookup" },
              id: "call_1",
              type: "function",
            },
          ],
        },
      },
    ],
    usage: {},
  }));
  await assert.rejects(
    execute({ name: "lookup", parameters: Type.Object({}) }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, MISSING_ARGUMENTS_RE);
      return true;
    }
  );
});
