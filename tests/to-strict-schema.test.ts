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
