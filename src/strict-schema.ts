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

// ---------------------------------------------------------------------------
// Strict argument validation
// ---------------------------------------------------------------------------

// Formats are checked only for the values toStrictSchema actually emits
// (email/hostname/ipv4/ipv6/uuid); any other format carries no documented
// constraint and is skipped.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_PATTERN =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validateStringFormat = (format: string, value: string): boolean => {
  switch (format) {
    case "email":
      return EMAIL_PATTERN.test(value);
    case "hostname":
      return HOSTNAME_PATTERN.test(value);
    case "ipv4": {
      const match = IPV4_PATTERN.exec(value);
      return match?.slice(1).every((octet) => Number(octet) <= 255) ?? false;
    }
    case "ipv6":
      return IPV6_PATTERN.test(value);
    case "uuid":
      return UUID_PATTERN.test(value);
    default:
      return true;
  }
};

const describeValue = (value: unknown): string => {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return "object";
  }
  return JSON.stringify(value);
};

const isMultipleOf = (value: number, multiple: number): boolean => {
  if (!(multiple > 0)) {
    return true;
  }
  const ratio = value / multiple;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
};

// Runs one node of the normalized strict schema against a value, appending
// human-readable failures (empty when the value is valid). Never throws on
// weird schema shapes: unresolvable refs, circular refs, and malformed
// patterns are reported as failures instead.
type ValidateNode = (
  schema: unknown,
  value: unknown,
  path: string,
  refChain: Set<string>,
  failures: string[]
) => void;

const validateString = (
  schema: JsonObject,
  value: unknown,
  path: string,
  failures: string[]
): void => {
  if (typeof value !== "string") {
    failures.push(`${path}: expected string, got ${describeValue(value)}`);
    return;
  }
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern).test(value)) {
        failures.push(`${path}: does not match pattern ${schema.pattern}`);
      }
    } catch {
      failures.push(`${path}: invalid pattern ${schema.pattern}`);
    }
  }
  if (
    typeof schema.format === "string" &&
    STRICT_STRING_FORMATS.has(schema.format) &&
    !validateStringFormat(schema.format, value)
  ) {
    failures.push(`${path}: invalid ${schema.format} format`);
  }
};

const validateNumber = (
  schema: JsonObject,
  value: unknown,
  path: string,
  failures: string[]
): void => {
  if (typeof value !== "number") {
    failures.push(
      `${path}: expected ${schema.type as string}, got ${describeValue(value)}`
    );
    return;
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    failures.push(`${path}: expected integer, got ${value}`);
  }
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    failures.push(`${path}: must be >= ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    failures.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (
    typeof schema.exclusiveMinimum === "number" &&
    value <= schema.exclusiveMinimum
  ) {
    failures.push(`${path}: must be > ${schema.exclusiveMinimum}`);
  }
  if (
    typeof schema.exclusiveMaximum === "number" &&
    value >= schema.exclusiveMaximum
  ) {
    failures.push(`${path}: must be < ${schema.exclusiveMaximum}`);
  }
  if (
    typeof schema.multipleOf === "number" &&
    !isMultipleOf(value, schema.multipleOf)
  ) {
    failures.push(`${path}: must be a multiple of ${schema.multipleOf}`);
  }
};

const validateArray = (
  schema: JsonObject,
  value: unknown,
  path: string,
  refChain: Set<string>,
  failures: string[],
  validateNode: ValidateNode
): void => {
  if (!Array.isArray(value)) {
    failures.push(`${path}: expected array, got ${describeValue(value)}`);
    return;
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => {
      validateNode(schema.items, item, `${path}[${index}]`, refChain, failures);
    });
  }
};

const validateObject = (
  schema: JsonObject,
  value: unknown,
  path: string,
  refChain: Set<string>,
  failures: string[],
  validateNode: ValidateNode
): void => {
  if (!isJsonObject(value)) {
    failures.push(`${path}: expected object, got ${describeValue(value)}`);
    return;
  }
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in value)) {
      failures.push(`${path}: missing required property "${key}"`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        failures.push(`${path}: additional property "${key}" is not allowed`);
      }
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (key in value) {
      validateNode(
        propertySchema,
        value[key],
        `${path}.${key}`,
        refChain,
        failures
      );
    }
  }
};

/**
 * Validate parsed function-call arguments against the NORMALIZED strict
 * schema produced by toStrictSchema. Returns a list of human-readable
 * failure messages (empty when the arguments are valid). The validator
 * implements DeepSeek's documented strict subset: object (required
 * properties, additionalProperties false), string (pattern; format only for
 * the formats toStrictSchema emits), number/integer bounds and multipleOf,
 * boolean, array items, enum, anyOf, const, and $ref resolution against the
 * hoisted `$def` registry. It never throws on weird schema shapes.
 */
export const validateStrictArguments = (
  schema: unknown,
  value: unknown
): string[] => {
  const root = isJsonObject(schema) ? schema : {};
  const definitions = isJsonObject(root.$def) ? root.$def : {};
  const issues: string[] = [];

  const resolveReference = (
    node: JsonObject,
    nodeValue: unknown,
    path: string,
    refChain: Set<string>,
    failures: string[],
    recurse: ValidateNode
  ): boolean => {
    const reference = node.$ref;
    if (typeof reference !== "string") {
      return false;
    }
    const name = refName(reference) ?? reference;
    if (refChain.has(name)) {
      failures.push(`${path}: circular $ref "${reference}"`);
      return true;
    }
    const target = definitions[name];
    if (!isJsonObject(target)) {
      failures.push(`${path}: cannot resolve $ref "${reference}"`);
      return true;
    }
    refChain.add(name);
    recurse(target, nodeValue, path, refChain, failures);
    refChain.delete(name);
    return true;
  };

  const validateAnyOf = (
    node: JsonObject,
    nodeValue: unknown,
    path: string,
    refChain: Set<string>,
    failures: string[],
    recurse: ValidateNode
  ): boolean => {
    if (!Array.isArray(node.anyOf)) {
      return false;
    }
    const anyOfMatches = node.anyOf.some((branch) => {
      const branchFailures: string[] = [];
      recurse(branch, nodeValue, path, new Set(refChain), branchFailures);
      return branchFailures.length === 0;
    });
    if (!anyOfMatches) {
      failures.push(`${path}: value does not match any allowed variant`);
    }
    return true;
  };

  const enumOrConstMismatch = (
    node: JsonObject,
    nodeValue: unknown,
    path: string,
    failures: string[]
  ): boolean => {
    if (Array.isArray(node.enum)) {
      if (node.enum.some((allowed) => Object.is(allowed, nodeValue))) {
        return false;
      }
      failures.push(
        `${path}: value ${describeValue(nodeValue)} is not in the allowed enum`
      );
      return true;
    }
    const constant = node.const;
    if (
      typeof constant !== "string" &&
      typeof constant !== "number" &&
      typeof constant !== "boolean"
    ) {
      return false;
    }
    if (Object.is(constant, nodeValue)) {
      return false;
    }
    failures.push(
      `${path}: expected constant value ${JSON.stringify(constant)}, got ${describeValue(nodeValue)}`
    );
    return true;
  };

  const dispatchType = (
    node: JsonObject,
    nodeValue: unknown,
    path: string,
    refChain: Set<string>,
    failures: string[],
    recurse: ValidateNode
  ): void => {
    switch (node.type) {
      case "object":
        validateObject(node, nodeValue, path, refChain, failures, recurse);
        break;
      case "string":
        validateString(node, nodeValue, path, failures);
        break;
      case "number":
      case "integer":
        validateNumber(node, nodeValue, path, failures);
        break;
      case "array":
        validateArray(node, nodeValue, path, refChain, failures, recurse);
        break;
      case "boolean":
        if (typeof nodeValue !== "boolean") {
          failures.push(
            `${path}: expected boolean, got ${describeValue(nodeValue)}`
          );
        }
        break;
      default:
        break;
    }
  };

  const validate: ValidateNode = (
    nodeSchema,
    nodeValue,
    path,
    refChain,
    failures
  ) => {
    const node = isJsonObject(nodeSchema) ? nodeSchema : {};
    if (resolveReference(node, nodeValue, path, refChain, failures, validate)) {
      return;
    }
    if (validateAnyOf(node, nodeValue, path, refChain, failures, validate)) {
      return;
    }
    if (enumOrConstMismatch(node, nodeValue, path, failures)) {
      return;
    }
    dispatchType(node, nodeValue, path, refChain, failures, validate);
  };

  validate(root, value, "arguments", new Set(), issues);
  return issues;
};

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
