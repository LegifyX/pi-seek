import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { toStrictSchema } from "../deepseek-v4.ts";

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value)
  );
  return value as Record<string, unknown>;
};

const typeOf = (value: unknown): unknown => record(value).type;

test("root name-based $ref resolves to the object schema", () => {
  const result = record(
    toStrictSchema(
      Type.Ref("User", { $defs: { User: Type.Object({ id: Type.Integer() }) } })
    )
  );
  assert.equal(result.type, "object");
  assert.equal(result.$ref, undefined);
  const user = record(record(result.$def).User);
  assert.equal(typeOf(record(user.properties).id), "integer");
});

test("nested name-based refs normalize to root $def pointers", () => {
  const result = record(
    toStrictSchema(
      Type.Object(
        { a: Type.Ref("Thing"), b: Type.Ref("Thing") },
        { $defs: { Thing: Type.Object({ x: Type.Integer() }) } }
      )
    )
  );
  const properties = record(result.properties);
  assert.equal(record(properties.a).$ref, "#/$def/Thing");
  assert.equal(record(properties.b).$ref, "#/$def/Thing");
  const def = record(result.$def);
  assert.equal(Object.keys(def).length, 1);
  assert.equal(typeOf(record(record(def.Thing).properties).x), "integer");
});

test("pointer-style input refs are normalized", () => {
  const result = record(
    toStrictSchema({
      $defs: {
        User: { properties: { id: { type: "integer" } }, type: "object" },
      },
      properties: { u: { $ref: "#/$defs/User" } },
      type: "object",
    })
  );
  assert.equal(record(record(result.properties).u).$ref, "#/$def/User");
  const user = record(record(result.$def).User);
  assert.equal(typeOf(record(user.properties).id), "integer");
});

test("recursive self-refs terminate and point at the root $def", () => {
  const result = record(
    toStrictSchema({
      $defs: {
        Node: { properties: { next: { $ref: "Node" } }, type: "object" },
      },
      $ref: "Node",
    })
  );
  assert.equal(result.type, "object");
  const node = record(record(result.$def).Node);
  assert.equal(record(record(node.properties).next).$ref, "#/$def/Node");
});

test("golden pin: plain object schema converts exactly as before", () => {
  assert.deepEqual(
    toStrictSchema(
      Type.Object({
        age: Type.Integer({ minimum: 0 }),
        name: Type.String(),
      })
    ),
    {
      additionalProperties: false,
      properties: {
        age: { minimum: 0, type: "integer" },
        name: { type: "string" },
      },
      required: ["age", "name"],
      type: "object",
    }
  );
});

test("keyword pins: const/enum/anyOf/format/pattern unchanged", () => {
  assert.deepEqual(
    toStrictSchema(
      Type.Object({
        code: Type.Number({ const: 42 }),
        email: Type.String({ format: "email" }),
        slug: Type.String({ pattern: "^[a-z]+$" }),
        status: Type.Union([Type.Literal("a"), Type.Literal("b")]),
      })
    ),
    {
      additionalProperties: false,
      properties: {
        code: { const: 42, type: "number" },
        email: { format: "email", type: "string" },
        slug: { pattern: "^[a-z]+$", type: "string" },
        status: {
          anyOf: [
            { enum: ["a"], type: "string" },
            { enum: ["b"], type: "string" },
          ],
        },
      },
      required: ["code", "email", "slug", "status"],
      type: "object",
    }
  );
});

test("root $ref to a non-object schema throws", () => {
  assert.throws(
    () => toStrictSchema(Type.Ref("Name", { $defs: { Name: Type.String() } })),
    { message: "Strict function parameters must resolve to an object schema" }
  );
});

test("unresolvable non-root $ref throws instead of passing through", () => {
  assert.throws(
    () =>
      toStrictSchema({
        properties: { p: { $ref: "#/components/schemas/Foo" } },
        type: "object",
      }),
    {
      message:
        "Strict schema reference cannot be resolved: #/components/schemas/Foo",
    }
  );
});

test("enum-only schemas infer a uniform string type", () => {
  assert.deepEqual(toStrictSchema({ enum: ["a", "b"] }), {
    enum: ["a", "b"],
    type: "string",
  });
});

test("string const maps to a single-value enum with inferred string type", () => {
  assert.deepEqual(toStrictSchema({ const: "x" }), {
    enum: ["x"],
    type: "string",
  });
});

test("enum-only schemas infer a uniform number type", () => {
  assert.deepEqual(toStrictSchema({ enum: [1, 2] }), {
    enum: [1, 2],
    type: "number",
  });
});

test("enum-only schemas infer a uniform boolean type", () => {
  assert.deepEqual(toStrictSchema({ enum: [true] }), {
    enum: [true],
    type: "boolean",
  });
});

test("mixed-kind enums leave type unset", () => {
  assert.deepEqual(toStrictSchema({ enum: ["a", 1] }), { enum: ["a", 1] });
});

test("empty enums leave type unset", () => {
  assert.deepEqual(toStrictSchema({ enum: [] }), { enum: [] });
});

test("explicit type wins over enum inference", () => {
  assert.deepEqual(toStrictSchema({ enum: ["a"], type: "string" }), {
    enum: ["a"],
    type: "string",
  });
});

test("root $ref through singular $def to a non-object schema throws", () => {
  assert.throws(
    () =>
      toStrictSchema({ $def: { Foo: { type: "string" } }, $ref: "#/$def/Foo" }),
    { message: "Strict function parameters must resolve to an object schema" }
  );
});

test("singular $def key resolves property-level refs and hoists", () => {
  assert.deepEqual(
    toStrictSchema({
      $def: { Foo: { type: "string" } },
      properties: { p: { $ref: "#/$def/Foo" } },
      type: "object",
    }),
    {
      $def: { Foo: { type: "string" } },
      additionalProperties: false,
      properties: { p: { $ref: "#/$def/Foo" } },
      required: ["p"],
      type: "object",
    }
  );
});

test("anyOf branches resolve refs against the hoisted $def registry", () => {
  assert.deepEqual(
    toStrictSchema({
      $defs: { Foo: { type: "number" } },
      anyOf: [{ type: "string" }, { $ref: "#/$defs/Foo" }],
    }),
    {
      $def: { Foo: { type: "number" } },
      anyOf: [{ type: "string" }, { $ref: "#/$def/Foo" }],
    }
  );
});

test("array schemas keep converted items", () => {
  assert.deepEqual(
    toStrictSchema({ items: { type: "string" }, type: "array" }),
    { items: { type: "string" }, type: "array" }
  );
});

test("format filtering keeps allowed formats and drops unsupported ones", () => {
  assert.deepEqual(
    toStrictSchema(
      Type.Object({
        email: Type.String({ format: "email" }),
        when: Type.String({ format: "date-time" }),
      })
    ),
    {
      additionalProperties: false,
      properties: {
        email: { format: "email", type: "string" },
        when: { type: "string" },
      },
      required: ["email", "when"],
      type: "object",
    }
  );
});
