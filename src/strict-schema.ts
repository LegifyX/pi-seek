import { isJsonObject, type JsonObject } from "./config.ts";

// ---------------------------------------------------------------------------
// Strict JSON-Schema converter
// ---------------------------------------------------------------------------

const STRICT_STRING_FORMATS = new Set([
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

// Refs are normalized to `#/$def/<Name>` pointers. Bare names and the
// pointer forms `#/$defs/<Name>` and `#/$def/<Name>` all resolve against the
// hoisted `$def` definition registry; any other reference is unresolvable and
// throws instead of leaking into the strict output.

const refName = (reference: string): string | undefined => {
  if (reference.startsWith("#/$defs/") || reference.startsWith("#/$def/")) {
    return reference
      .slice(reference.lastIndexOf("/") + 1)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
  }
  if (!reference.startsWith("#/")) {
    return reference;
  }
};

const emitRef = (name: string): string =>
  `#/$def/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;

type DefinitionRegistry = Map<string, JsonObject>;

/**
 * Collect source definitions from a node's `$defs`/`$def` into the registry.
 * The first definition of a name wins; later duplicates are ignored so that
 * resolution stays deterministic across mutually-referencing definitions.
 */
const collectDefinitions = (
  source: JsonObject,
  registry: DefinitionRegistry
): void => {
  for (const definitionsSource of [source.$defs, source.$def]) {
    if (definitionsSource === undefined) {
      continue;
    }
    if (!isJsonObject(definitionsSource)) {
      throw new Error("Strict schema definitions must be an object");
    }
    for (const [name, definition] of Object.entries(definitionsSource)) {
      if (isJsonObject(definition) && !registry.has(name)) {
        registry.set(name, definition);
      }
    }
  }
};

const convertNode = (
  schema: unknown,
  registry: DefinitionRegistry
): unknown => {
  if (!isJsonObject(schema)) {
    return Array.isArray(schema)
      ? schema.map((item) => convertNode(item, registry))
      : schema;
  }

  const strictSchema: JsonObject = {};
  if (typeof schema.description === "string") {
    strictSchema.description = schema.description;
  }
  if (typeof schema.$ref === "string") {
    const name = refName(schema.$ref);
    if (name === undefined) {
      throw new Error(
        `Strict schema reference cannot be resolved: ${schema.$ref}`
      );
    }
    strictSchema.$ref = emitRef(name);
  }

  normalizeSchemaType(schema, strictSchema, registry);

  if (typeof schema.const === "string" || typeof schema.const === "boolean") {
    strictSchema.enum = [schema.const];
  } else if (typeof schema.const === "number") {
    strictSchema.const = schema.const;
  }
  if (Array.isArray(schema.enum)) {
    strictSchema.enum = schema.enum;
  }
  if (
    strictSchema.type === undefined &&
    Array.isArray(strictSchema.enum) &&
    strictSchema.enum.length > 0
  ) {
    const enumType = typeof strictSchema.enum[0];
    if (
      (enumType === "string" ||
        enumType === "number" ||
        enumType === "boolean") &&
      strictSchema.enum.every((value) => typeof value === enumType)
    ) {
      strictSchema.type = enumType;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    strictSchema.anyOf = schema.anyOf.map((branch) =>
      convertNode(branch, registry)
    );
  }

  collectDefinitions(schema, registry);

  return strictSchema;
};

/** Convert TypeBox or JSON Schema input to DeepSeek's strict-mode dialect. */
export function toStrictSchema(schema: unknown, root = true): unknown {
  if (!isJsonObject(schema)) {
    return Array.isArray(schema)
      ? schema.map((item) => toStrictSchema(item, false))
      : schema;
  }

  // Definitions are collected from every visited node (first definition of a
  // name wins) and hoisted to the root `$def`. Refs are rewritten to
  // normalized `#/$def/<Name>` pointers, never followed, so recursive
  // schemas terminate naturally.
  const registry: DefinitionRegistry = new Map();
  const strictSchema = convertNode(schema, registry) as JsonObject;

  const definitions: JsonObject = {};
  for (const [name, definition] of registry) {
    definitions[name] = convertNode(definition, registry);
  }

  if (root && typeof strictSchema.$ref === "string") {
    const name = refName(strictSchema.$ref);
    const target = name === undefined ? undefined : registry.get(name);
    if (!isJsonObject(target)) {
      throw new Error(
        `Strict schema root reference cannot be resolved: ${strictSchema.$ref}`
      );
    }
    if (target.type !== "object") {
      throw new Error(
        "Strict function parameters must resolve to an object schema"
      );
    }
    const resolved = convertNode(target, registry) as JsonObject;
    if (Object.keys(definitions).length > 0) {
      resolved.$def = definitions;
    }
    return resolved;
  }

  if (Object.keys(definitions).length > 0) {
    strictSchema.$def = definitions;
  }
  return strictSchema;
}

const copyNumericSchemaFields = (
  source: JsonObject,
  target: JsonObject
): void => {
  const keys = [
    "const",
    "default",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ];
  for (const key of keys) {
    if (typeof source[key] === "number") {
      target[key] = source[key];
    }
  }
};

const normalizeSchemaType = (
  source: JsonObject,
  target: JsonObject,
  registry: DefinitionRegistry
): void => {
  switch (source.type) {
    case "object": {
      const properties = isJsonObject(source.properties)
        ? source.properties
        : {};
      const strictProperties: JsonObject = {};
      for (const [key, property] of Object.entries(properties)) {
        strictProperties[key] = convertNode(property, registry);
      }
      target.type = "object";
      target.properties = strictProperties;
      target.required = Object.keys(strictProperties);
      target.additionalProperties = false;
      break;
    }
    case "string":
      target.type = "string";
      if (typeof source.pattern === "string") {
        target.pattern = source.pattern;
      }
      if (
        typeof source.format === "string" &&
        STRICT_STRING_FORMATS.has(source.format)
      ) {
        target.format = source.format;
      }
      break;
    case "number":
    case "integer":
      target.type = source.type;
      copyNumericSchemaFields(source, target);
      break;
    case "array":
      target.type = "array";
      if (source.items !== undefined) {
        target.items = convertNode(source.items, registry);
      }
      break;
    case "boolean":
      target.type = "boolean";
      break;
    default:
      break;
  }
};
