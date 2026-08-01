/**
 * DeepSeek V4 Flash extension for pi.
 *
 * Keep this extension in one source file. The global extension loader loads
 * one file, while the sections below keep each API surface independent.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Configuration and shared types
// ---------------------------------------------------------------------------

const PROVIDER_ID = "deepseek-responses";
const MODEL_ID = "deepseek-v4-flash";
const BASE_URL = "https://api.deepseek.com";
const BETA_URL = "https://api.deepseek.com/beta";
const API_KEY_ENV = "DEEPSEEK_API_KEY";
const REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_EFFORT = "high";
const FOOTER_KEY = "ds-cache";
const THREADS_ENTRY = "ds-reply";
const CACHE_CARD_ENTRY = "ds-cache-card";
const MENU_STATUS_KEY = "deepseek-menu";
const MAX_OUTPUT_TOKENS = 393_216;
const USAGE_HISTORY_LIMIT = 100;
const TOKENS_PER_MILLION = 1_000_000;

// Prices per 1M tokens for deepseek-v4-flash. DeepSeek does not publish a
// cache-write price for this model.
const COST = {
  cacheRead: 0.0028,
  cacheWrite: 0,
  input: 0.14,
  output: 0.28,
};

// deepseek-v4-flash clamps xhigh to high. Keep unsupported values out of the
// request payload.
const THINKING_LEVEL_MAP = {
  high: "high",
  low: "low",
  max: "max",
  medium: "high",
  minimal: "low",
  off: "none",
  xhigh: "high",
} as const;

type JsonObject = Record<string, unknown>;
type Effort = "low" | "high" | "max";
type DeepSeekMenuAction =
  | "toggle"
  | "effort"
  | "chat"
  | "reset"
  | "cache"
  | "close";
type DeepSeekResetAction =
  | { kind: "all" }
  | { kind: "thread"; name: string };

interface DeepSeekRuntimeState {
  defaultEffort: Effort;
  enabled: boolean;
}

interface DeepSeekMenuOption {
  action: DeepSeekMenuAction;
  label: string;
}

const createRuntimeState = (): DeepSeekRuntimeState => ({
  defaultEffort: DEFAULT_EFFORT,
  enabled: true,
});

interface UsageCost {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  total: number;
}

interface UsageRecord {
  cacheRead: number;
  cacheWrite: number;
  cost: UsageCost;
  hitRate: number;
  input: number;
  model: string;
  output: number;
  reasoning?: number;
  source: string;
  totalTokens: number;
  ts: number;
}

type PendingUsageRecord = Omit<UsageRecord, "hitRate" | "ts">;

interface ResponsesResult {
  calls: JsonObject[];
  items: unknown[];
  responseId?: string;
  text: string;
  thinking: string;
  usage: unknown;
}

interface Thread {
  items: unknown[];
  round: number;
  system?: string;
}

interface ResponseChatOptions {
  effort?: Effort;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  system?: string;
}

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getObject = (
  record: JsonObject | undefined,
  key: string
): JsonObject | undefined => {
  const value = record?.[key];
  return isJsonObject(value) ? value : undefined;
};

const getArray = (record: JsonObject | undefined, key: string): unknown[] => {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
};

const getNumber = (
  record: JsonObject | undefined,
  key: string
): number | undefined => {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
};

const getString = (
  record: JsonObject | undefined,
  key: string
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

// ---------------------------------------------------------------------------
// Authentication and HTTP client
// ---------------------------------------------------------------------------

interface AuthService {
  resolveApiKey: () => Promise<string>;
}

const createAuthService = (): AuthService => {
  let cachedKey: string | undefined;

  const resolveApiKey = async (): Promise<string> => {
    if (cachedKey) {
      return cachedKey;
    }

    const environmentKey = process.env[API_KEY_ENV]?.trim();
    if (environmentKey) {
      cachedKey = environmentKey;
      return environmentKey;
    }

    try {
      const rawConfig = await readFile(
        join(getAgentDir(), "models.json"),
        "utf8"
      );
      const config = JSON.parse(rawConfig) as {
        providers?: Record<string, { apiKey?: string }>;
      };
      const configuredKey = config.providers?.[PROVIDER_ID]?.apiKey?.trim();
      if (configuredKey) {
        cachedKey = configuredKey;
        return configuredKey;
      }
    } catch {
      // The error below gives the user both supported key locations.
    }

    throw new Error(
      `DeepSeek API key not found: set ${API_KEY_ENV} (or configure an apiKey for the "${PROVIDER_ID}" provider in models.json).`
    );
  };

  return { resolveApiKey };
};

interface HttpClient {
  postJson: (
    path: string,
    body: unknown,
    signal?: AbortSignal,
    baseUrl?: string
  ) => Promise<unknown>;
}

const getErrorName = (error: unknown): string | undefined =>
  error instanceof Error ? error.name : undefined;

const createHttpClient = (auth: AuthService): HttpClient => {
  const postJson = async (
    path: string,
    body: unknown,
    signal?: AbortSignal,
    baseUrl = BASE_URL
  ): Promise<unknown> => {
    const key = await auth.resolveApiKey();
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Aborted by user", { cause: error });
      }
      const errorName = getErrorName(error);
      if (errorName === "TimeoutError" || errorName === "AbortError") {
        throw new Error("DeepSeek request timed out", { cause: error });
      }
      throw error;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `DeepSeek API ${response.status}: ${detail.slice(0, 400)}`
      );
    }

    return await response.json();
  };

  return { postJson };
};

// ---------------------------------------------------------------------------
// Responses API service
// ---------------------------------------------------------------------------

interface ResponsesApi {
  chat: (
    input: unknown[],
    options: ResponseChatOptions
  ) => Promise<ResponsesResult>;
  webSearch: (
    query: string,
    effort: Effort | undefined,
    maxOutputTokens: number | undefined,
    signal: AbortSignal | undefined
  ) => Promise<ResponsesResult>;
}

const extractContentText = (
  item: JsonObject,
  acceptedTypes?: ReadonlySet<string>
): string => {
  let text = "";
  for (const rawPart of getArray(item, "content")) {
    if (!isJsonObject(rawPart)) {
      continue;
    }
    const partType = getString(rawPart, "type");
    const acceptsPartType =
      !acceptedTypes || (partType !== undefined && acceptedTypes.has(partType));
    if (!acceptsPartType) {
      continue;
    }
    text += getString(rawPart, "text") ?? "";
  }
  return text;
};

const MESSAGE_CONTENT_TYPES = new Set(["output_text", "text"]);

const extractResponsesText = (
  output: unknown
): Pick<ResponsesResult, "text" | "thinking" | "calls"> => {
  let text = "";
  let thinking = "";
  const calls: JsonObject[] = [];

  for (const rawItem of Array.isArray(output) ? output : []) {
    if (!isJsonObject(rawItem)) {
      continue;
    }
    switch (getString(rawItem, "type")) {
      case "message":
        text += extractContentText(rawItem, MESSAGE_CONTENT_TYPES);
        break;
      case "reasoning":
        thinking += extractContentText(rawItem);
        break;
      case "function_call":
      case "web_search_call":
        calls.push(rawItem);
        break;
      default:
        break;
    }
  }

  return { calls, text, thinking };
};

const parseResponsesResult = (rawResponse: unknown): ResponsesResult => {
  const response = isJsonObject(rawResponse) ? rawResponse : {};
  const output = getArray(response, "output");
  const extracted = extractResponsesText(output);
  return {
    ...extracted,
    items: output,
    responseId: getString(response, "id"),
    usage: response.usage,
  };
};

const createResponsesApi = (http: HttpClient): ResponsesApi => {
  const chat = async (
    input: unknown[],
    options: ResponseChatOptions
  ): Promise<ResponsesResult> => {
    const body: JsonObject = {
      input,
      model: MODEL_ID,
      reasoning: { effort: options.effort ?? DEFAULT_EFFORT },
      stream: false,
    };
    if (options.system) {
      body.instructions = options.system;
    }
    if (options.maxOutputTokens) {
      body.max_output_tokens = options.maxOutputTokens;
    }

    return parseResponsesResult(
      await http.postJson("/responses", body, options.signal)
    );
  };

  const webSearch = async (
    query: string,
    effort: Effort | undefined,
    maxOutputTokens: number | undefined,
    signal: AbortSignal | undefined
  ): Promise<ResponsesResult> => {
    const body: JsonObject = {
      input: [{ content: [{ text: query, type: "input_text" }], role: "user" }],
      model: MODEL_ID,
      reasoning: { effort: effort ?? "low" },
      stream: false,
      tool_choice: { type: "web_search" },
      tools: [{ type: "web_search" }],
    };
    if (maxOutputTokens) {
      body.max_output_tokens = maxOutputTokens;
    }

    return parseResponsesResult(
      await http.postJson("/responses", body, signal)
    );
  };

  return { chat, webSearch };
};

// ---------------------------------------------------------------------------
// Beta API service
// ---------------------------------------------------------------------------

interface BetaApi {
  postChatCompletion: (
    body: JsonObject,
    signal?: AbortSignal
  ) => Promise<JsonObject>;
  postCompletion: (
    body: JsonObject,
    signal?: AbortSignal
  ) => Promise<JsonObject>;
}

const createBetaApi = (http: HttpClient): BetaApi => {
  const post = async (
    path: string,
    body: JsonObject,
    signal?: AbortSignal
  ): Promise<JsonObject> => {
    const response = await http.postJson(path, body, signal, BETA_URL);
    return isJsonObject(response) ? response : {};
  };

  return {
    postChatCompletion: async (body, signal) =>
      await post("/chat/completions", body, signal),
    postCompletion: async (body, signal) =>
      await post("/completions", body, signal),
  };
};

const getFirstChoice = (response: JsonObject): JsonObject | undefined => {
  const [firstChoice] = getArray(response, "choices");
  return isJsonObject(firstChoice) ? firstChoice : undefined;
};

// ---------------------------------------------------------------------------
// Telemetry store
// ---------------------------------------------------------------------------

interface TelemetryStore {
  getHistory: () => UsageRecord[];
  getLastUsage: () => UsageRecord | null;
  mapChatUsage: (usage: unknown, source: string) => PendingUsageRecord;
  mapResponsesUsage: (usage: unknown, source: string) => PendingUsageRecord;
  record: (record: PendingUsageRecord) => UsageRecord;
  setFooter: (context?: ExtensionContext) => void;
}

const calculateCost = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number
): UsageCost => {
  const cost = {
    cacheRead: (cacheRead * COST.cacheRead) / TOKENS_PER_MILLION,
    cacheWrite: (cacheWrite * COST.cacheWrite) / TOKENS_PER_MILLION,
    input: (input * COST.input) / TOKENS_PER_MILLION,
    output: (output * COST.output) / TOKENS_PER_MILLION,
  };
  return {
    ...cost,
    total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite,
  };
};

const createTelemetryStore = (
  runtimeState: DeepSeekRuntimeState
): TelemetryStore => {
  let lastUsage: UsageRecord | null = null;
  const usageHistory: UsageRecord[] = [];

  const record = (pending: PendingUsageRecord): UsageRecord => {
    const inputTotal = pending.cacheRead + pending.input;
    const fullRecord: UsageRecord = {
      ...pending,
      hitRate: inputTotal > 0 ? pending.cacheRead / inputTotal : 0,
      ts: Date.now(),
    };
    lastUsage = fullRecord;
    usageHistory.push(fullRecord);
    if (usageHistory.length > USAGE_HISTORY_LIMIT) {
      usageHistory.shift();
    }
    return fullRecord;
  };

  const mapResponsesUsage = (
    rawUsage: unknown,
    source: string
  ): PendingUsageRecord => {
    const usage = isJsonObject(rawUsage) ? rawUsage : undefined;
    const inputDetails = getObject(usage, "input_tokens_details");
    const outputDetails = getObject(usage, "output_tokens_details");
    const inputTokens = getNumber(usage, "input_tokens") ?? 0;
    const cacheRead = getNumber(inputDetails, "cached_tokens") ?? 0;
    const cacheWrite = getNumber(inputDetails, "cache_write_tokens") ?? 0;
    const input = Math.max(0, inputTokens - cacheRead - cacheWrite);
    const output = getNumber(usage, "output_tokens") ?? 0;
    const reasoning = getNumber(outputDetails, "reasoning_tokens");
    return {
      cacheRead,
      cacheWrite,
      cost: calculateCost(input, output, cacheRead, cacheWrite),
      input,
      model: MODEL_ID,
      output,
      reasoning,
      source,
      totalTokens:
        getNumber(usage, "total_tokens") ?? input + output + cacheRead,
    };
  };

  const mapChatUsage = (
    rawUsage: unknown,
    source: string
  ): PendingUsageRecord => {
    const usage = isJsonObject(rawUsage) ? rawUsage : undefined;
    const cacheRead = getNumber(usage, "prompt_cache_hit_tokens") ?? 0;
    const promptTokens = getNumber(usage, "prompt_tokens") ?? 0;
    const input =
      getNumber(usage, "prompt_cache_miss_tokens") ??
      Math.max(0, promptTokens - cacheRead);
    const output = getNumber(usage, "completion_tokens") ?? 0;
    return {
      cacheRead,
      cacheWrite: 0,
      cost: calculateCost(input, output, cacheRead, 0),
      input,
      model: MODEL_ID,
      output,
      source,
      totalTokens:
        getNumber(usage, "total_tokens") ?? input + cacheRead + output,
    };
  };

  const setFooter = (context?: ExtensionContext): void => {
    if (!context) {
      return;
    }
    if (
      !runtimeState.enabled ||
      context.model?.provider !== PROVIDER_ID ||
      !lastUsage
    ) {
      context.ui.setStatus(FOOTER_KEY, undefined);
      return;
    }
    const cacheHit = (lastUsage.cacheRead / 1000).toFixed(1);
    const cacheMiss = (lastUsage.input / 1000).toFixed(1);
    context.ui.setStatus(
      FOOTER_KEY,
      `DS v4-flash · cache ${cacheHit}K hit / ${cacheMiss}K miss · $${lastUsage.cost.total.toFixed(4)}`
    );
  };

  return {
    getHistory: () => [...usageHistory],
    getLastUsage: () => lastUsage,
    mapChatUsage,
    mapResponsesUsage,
    record,
    setFooter,
  };
};

// ---------------------------------------------------------------------------
// Thread store
// ---------------------------------------------------------------------------

interface ThreadStore {
  getOrCreate: (name: string) => Thread;
  reset: (name?: string) => Promise<void>;
  restore: (context: ExtensionContext) => void;
  snapshot: () => Record<string, Thread>;
  withLock: <Result>(
    name: string,
    action: () => Result | Promise<Result>
  ) => Promise<Result>;
}

const createThreadStore = (): ThreadStore => {
  const threads = new Map<string, Thread>();
  const threadTails = new Map<string, Promise<void>>();

  const withLock = async <Result>(
    name: string,
    action: () => Result | Promise<Result>
  ): Promise<Result> => {
    const predecessor = threadTails.get(name) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => gate);
    threadTails.set(name, tail);

    await predecessor;
    try {
      return await action();
    } finally {
      release();
      if (threadTails.get(name) === tail) {
        threadTails.delete(name);
      }
    }
  };

  const getOrCreate = (name: string): Thread => {
    const existingThread = threads.get(name);
    if (existingThread) {
      return existingThread;
    }
    const newThread: Thread = { items: [], round: 0 };
    threads.set(name, newThread);
    return newThread;
  };

  const reset = async (name?: string): Promise<void> => {
    if (name) {
      await withLock(name, () => {
        threads.delete(name);
      });
      return;
    }

    const names = new Set([...threads.keys(), ...threadTails.keys()]);
    await Promise.all(
      [...names].map((threadName) =>
        withLock(threadName, () => {
          threads.delete(threadName);
        })
      )
    );
  };

  const snapshot = (): Record<string, Thread> =>
    Object.fromEntries(threads.entries());

  const restore = (context: ExtensionContext): void => {
    threads.clear();
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type !== "message") {
        continue;
      }
      const { message } = entry;
      const isThreadTool =
        message.role === "toolResult" &&
        (message.toolName === "ds_chat" ||
          message.toolName === "ds_chat_reset");
      if (!isThreadTool) {
        continue;
      }
      const details = message.details as
        | { threads?: Record<string, Thread> }
        | undefined;
      if (!details?.threads) {
        continue;
      }
      threads.clear();
      for (const [name, thread] of Object.entries(details.threads)) {
        threads.set(name, thread);
      }
    }
  };

  return { getOrCreate, reset, restore, snapshot, withLock };
};

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

const rewriteLocalRef = (reference: string): string => {
  if (!reference.startsWith("#/")) {
    return reference;
  }
  const segments = reference.slice(2).split("/");
  const rewritten = segments.map((segment) =>
    segment === "$defs" ? "$def" : segment
  );
  return `#/${rewritten.join("/")}`;
};

const resolveLocalRef = (schema: JsonObject, reference: string): unknown => {
  if (!reference.startsWith("#/")) {
    return;
  }
  let value: unknown = schema;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isJsonObject(value)) {
      return;
    }
    value = value[segment];
  }
  return value;
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

const normalizeSchemaType = (source: JsonObject, target: JsonObject): void => {
  switch (source.type) {
    case "object": {
      const properties = isJsonObject(source.properties)
        ? source.properties
        : {};
      const strictProperties: JsonObject = {};
      for (const [key, property] of Object.entries(properties)) {
        strictProperties[key] = toStrictSchema(property, false);
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
        target.items = toStrictSchema(source.items, false);
      }
      break;
    case "boolean":
      target.type = "boolean";
      break;
    default:
      break;
  }
};

const normalizeDefinitions = (source: JsonObject): JsonObject => {
  const definitions: JsonObject = {};
  for (const definitionsSource of [source.$defs, source.$def]) {
    if (definitionsSource === undefined) {
      continue;
    }
    if (!isJsonObject(definitionsSource)) {
      throw new Error("Strict schema definitions must be an object");
    }
    for (const [name, definition] of Object.entries(definitionsSource)) {
      definitions[name] = toStrictSchema(definition, false);
    }
  }
  return definitions;
};

/** Convert TypeBox or JSON Schema input to DeepSeek's strict-mode dialect. */
function toStrictSchema(schema: unknown, root = true): unknown {
  if (!isJsonObject(schema)) {
    return Array.isArray(schema)
      ? schema.map((item) => toStrictSchema(item, false))
      : schema;
  }

  const strictSchema: JsonObject = {};
  if (typeof schema.description === "string") {
    strictSchema.description = schema.description;
  }
  if (typeof schema.$ref === "string") {
    strictSchema.$ref = rewriteLocalRef(schema.$ref);
  }

  normalizeSchemaType(schema, strictSchema);

  if (typeof schema.const === "string" || typeof schema.const === "boolean") {
    strictSchema.enum = [schema.const];
  } else if (typeof schema.const === "number") {
    strictSchema.const = schema.const;
  }
  if (Array.isArray(schema.enum)) {
    strictSchema.enum = schema.enum;
  }
  if (Array.isArray(schema.anyOf)) {
    strictSchema.anyOf = schema.anyOf.map((branch) =>
      toStrictSchema(branch, false)
    );
  }

  const definitions = normalizeDefinitions(schema);
  if (Object.keys(definitions).length > 0) {
    strictSchema.$def = definitions;
  }

  if (root && typeof strictSchema.$ref === "string") {
    const target = resolveLocalRef(strictSchema, strictSchema.$ref);
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
    return { ...target, $def: strictSchema.$def };
  }

  return strictSchema;
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const EffortParam = Type.Optional(
  Type.Union([Type.Literal("low"), Type.Literal("high"), Type.Literal("max")], {
    description: "Reasoning effort for this call",
  })
);

const ChatParams = Type.Object({
  max_output_tokens: Type.Optional(
    Type.Integer({
      description: "Maximum output tokens for this round",
      minimum: 16,
    })
  ),
  message: Type.String({ description: "The user message to send to DeepSeek" }),
  reasoning_effort: EffortParam,
  system: Type.Optional(
    Type.String({
      description:
        "System prompt for a NEW thread; ignored when the thread already exists",
    })
  ),
  thread: Type.String({
    description:
      "Name of the conversation thread to continue (created on first use)",
  }),
});

const ChatResetParams = Type.Object({
  thread: Type.Optional(
    Type.String({ description: "Thread to reset; omit to reset all threads" })
  ),
});

const PrefixParams = Type.Object({
  max_tokens: Type.Optional(
    Type.Integer({
      description:
        "Maximum tokens for the completion (up to the model's 384K output limit)",
      maximum: MAX_OUTPUT_TOKENS,
      minimum: 1,
    })
  ),
  prefix: Type.String({
    description:
      'Assistant prefix the model continues from, e.g. "```python\\n"',
  }),
  prompt: Type.String({
    description: 'User instruction, e.g. "Please write quick sort code"',
  }),
  stop: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Stop sequences, e.g. ["```"]',
    })
  ),
});

const FimParams = Type.Object({
  max_tokens: Type.Optional(
    Type.Integer({
      description: "Maximum tokens (FIM cap is 4K)",
      maximum: 4096,
      minimum: 1,
    })
  ),
  prompt: Type.String({ description: "Code before the gap to fill" }),
  stop: Type.Optional(
    Type.Array(Type.String(), { description: "Stop sequences" })
  ),
  suffix: Type.Optional(
    Type.String({ description: "Code after the gap (optional)" })
  ),
});

const WebSearchParams = Type.Object({
  max_output_tokens: Type.Optional(Type.Integer({ minimum: 16 })),
  query: Type.String({ description: "The search query" }),
  reasoning_effort: EffortParam,
});

const CallFunctionParams = Type.Object({
  context: Type.Optional(
    Type.String({
      description:
        "Context the model uses to decide the arguments (the 'user' turn)",
    })
  ),
  description: Type.Optional(
    Type.String({ description: "What the function does" })
  ),
  name: Type.String({
    description: "Name of the function the model should call",
  }),
  parameters: Type.Any({
    description:
      "JSON schema for the function parameters. Accepts a TypeBox-style object schema or plain JSON Schema; it is normalized to DeepSeek's strict-mode dialect.",
  }),
});

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

interface ToolServices {
  beta: BetaApi;
  responses: ResponsesApi;
  telemetry: TelemetryStore;
  threads: ThreadStore;
}

const registerChatTools = (pi: ExtensionAPI, services: ToolServices): void => {
  const { responses, telemetry, threads } = services;

  pi.registerTool({
    description:
      "Send a message to DeepSeek V4 Flash in a named conversation thread and get the reply. Threads are stateful across calls and keep the full history, so DeepSeek can be run as a sub-agent. Use ds_chat_reset to clear a thread.",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      return await threads.withLock(params.thread, async () => {
        const thread = threads.getOrCreate(params.thread);
        if (params.system && thread.round === 0) {
          thread.system = params.system;
        }

        const inputItems = [...thread.items];
        inputItems.push({
          content: [{ text: params.message, type: "input_text" }],
          role: "user",
        });

        const result = await responses.chat(inputItems, {
          effort: params.reasoning_effort,
          maxOutputTokens: params.max_output_tokens,
          signal: signal ?? context.signal,
          system: thread.system,
        });

        thread.items = [...inputItems, ...result.items];
        thread.round += 1;
        const usage = telemetry.mapResponsesUsage(result.usage, "chat");
        telemetry.record(usage);
        telemetry.setFooter(context);

        const reply =
          result.calls.length > 0
            ? `${result.text}\n\n[note: unexpected function calls in a plain chat: ${JSON.stringify(result.calls).slice(0, 500)}]`
            : result.text;
        return {
          content: [{ text: reply || "(empty reply)", type: "text" as const }],
          details: {
            round: thread.round,
            thinking: result.thinking,
            thread: params.thread,
            threads: threads.snapshot(),
            usage,
          },
        };
      });
    },
    label: "DeepSeek Chat",
    name: "ds_chat",
    parameters: ChatParams,
    promptSnippet:
      "ds_chat(thread, message) - chat with DeepSeek in a named thread",
  });

  pi.registerTool({
    description:
      "Reset one named DeepSeek chat thread (or all threads), discarding its history.",
    async execute(_toolCallId, params) {
      await threads.reset(params.thread);
      return {
        content: [
          {
            text: params.thread
              ? `Thread "${params.thread}" reset`
              : "All DeepSeek threads reset",
            type: "text" as const,
          },
        ],
        details: { thread: params.thread, threads: threads.snapshot() },
      };
    },
    label: "DeepSeek Chat Reset",
    name: "ds_chat_reset",
    parameters: ChatResetParams,
    promptSnippet: "ds_chat_reset(thread?) - clear DeepSeek chat thread state",
  });
};

const registerBetaTools = (pi: ExtensionAPI, services: ToolServices): void => {
  const { beta, telemetry } = services;

  pi.registerTool({
    description:
      'Beta Chat Prefix Completion: give a user instruction plus an assistant prefix (e.g. "```python\\n") and get the model\'s continuation, optionally stopping at a sequence like "```". Use for code/structured completions.',
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const body: JsonObject = {
        messages: [
          { content: params.prompt, role: "user" },
          { content: params.prefix, prefix: true, role: "assistant" },
        ],
        model: MODEL_ID,
        stream: false,
      };
      if (params.stop?.length) {
        body.stop = params.stop;
      }
      if (params.max_tokens) {
        body.max_tokens = params.max_tokens;
      }

      const response = await beta.postChatCompletion(
        body,
        signal ?? context.signal
      );
      const message = getObject(getFirstChoice(response), "message");
      const completion = getString(message, "content") ?? "";
      const usage = telemetry.mapChatUsage(response.usage, "prefix");
      telemetry.record(usage);
      telemetry.setFooter(context);
      const rawUsage = isJsonObject(response.usage)
        ? response.usage
        : undefined;
      return {
        content: [
          { text: completion || "(empty completion)", type: "text" as const },
        ],
        details: {
          full: params.prefix + completion,
          prompt_cache_hit_tokens: getNumber(
            rawUsage,
            "prompt_cache_hit_tokens"
          ),
          prompt_cache_miss_tokens: getNumber(
            rawUsage,
            "prompt_cache_miss_tokens"
          ),
          usage,
        },
      };
    },
    label: "DeepSeek Prefix Completion",
    name: "ds_prefix_complete",
    parameters: PrefixParams,
    promptSnippet:
      "ds_prefix_complete(prompt, prefix, stop?) - continue from an assistant prefix",
  });

  pi.registerTool({
    description:
      "Beta Fill-In-the-Middle completion: give the code before the gap (prompt) and optionally the code after it (suffix); DeepSeek completes the middle. Max tokens is capped at 4K by the API.",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const body: JsonObject = {
        model: MODEL_ID,
        prompt: params.prompt,
        stream: false,
      };
      if (params.suffix) {
        body.suffix = params.suffix;
      }
      if (params.max_tokens) {
        body.max_tokens = params.max_tokens;
      }
      if (params.stop?.length) {
        body.stop = params.stop;
      }

      const response = await beta.postCompletion(
        body,
        signal ?? context.signal
      );
      const completion = getString(getFirstChoice(response), "text") ?? "";
      const usage = telemetry.mapChatUsage(response.usage, "fim");
      telemetry.record(usage);
      telemetry.setFooter(context);
      const rawUsage = isJsonObject(response.usage)
        ? response.usage
        : undefined;
      return {
        content: [
          { text: completion || "(empty completion)", type: "text" as const },
        ],
        details: {
          prompt_cache_hit_tokens: getNumber(
            rawUsage,
            "prompt_cache_hit_tokens"
          ),
          prompt_cache_miss_tokens: getNumber(
            rawUsage,
            "prompt_cache_miss_tokens"
          ),
          usage,
        },
      };
    },
    label: "DeepSeek FIM Completion",
    name: "ds_fim",
    parameters: FimParams,
    promptSnippet:
      "ds_fim(prompt, suffix?) - fill the middle between prompt and suffix",
  });
};

const registerResponsesTools = (
  pi: ExtensionAPI,
  services: ToolServices
): void => {
  const { responses, telemetry } = services;

  pi.registerTool({
    description:
      "Run DeepSeek's server-side web search (Responses API web_search tool) for a query and return the model's answer, including citations where available.",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const result = await responses.webSearch(
        params.query,
        params.reasoning_effort,
        params.max_output_tokens,
        signal ?? context.signal
      );
      const usage = telemetry.mapResponsesUsage(result.usage, "search");
      telemetry.record(usage);
      telemetry.setFooter(context);
      return {
        content: [
          { text: result.text || "(no answer)", type: "text" as const },
        ],
        details: {
          query: params.query,
          responseId: result.responseId,
          searchCalls: result.calls,
          thinking: result.thinking,
          usage,
        },
      };
    },
    label: "DeepSeek Web Search",
    name: "ds_web_search",
    parameters: WebSearchParams,
    promptSnippet: "ds_web_search(query) - server-side web search via DeepSeek",
  });
};

const registerFunctionTool = (
  pi: ExtensionAPI,
  services: ToolServices
): void => {
  const { beta, telemetry } = services;

  pi.registerTool({
    description:
      "Force DeepSeek V4 Flash to produce the named strict-mode function call for the given JSON schema. This helper uses non-thinking mode because DeepSeek rejects forced tool choice in thinking mode. The schema is normalized to DeepSeek's strict dialect (all object properties required, additionalProperties false, strings with supported pattern/format only, numbers with bounds/multipleOf, arrays without min/maxItems, enum/anyOf/$ref/$def). Returns the parsed arguments.",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const strictParameters = toStrictSchema(params.parameters);
      const body: JsonObject = {
        messages: [
          {
            content:
              "You call the provided function with exactly correct arguments based on the context. Output only the function call.",
            role: "system",
          },
          {
            content:
              params.context ??
              "Determine the correct arguments for this function call.",
            role: "user",
          },
        ],
        model: MODEL_ID,
        stream: false,
        thinking: { type: "disabled" },
        tool_choice: { function: { name: params.name }, type: "function" },
        tools: [
          {
            function: {
              description: params.description ?? "",
              name: params.name,
              parameters: strictParameters,
              strict: true,
            },
            type: "function",
          },
        ],
      };

      const response = await beta.postChatCompletion(
        body,
        signal ?? context.signal
      );
      const message = getObject(getFirstChoice(response), "message");
      const [rawToolCall] = getArray(message, "tool_calls");
      const toolCall = isJsonObject(rawToolCall) ? rawToolCall : undefined;
      const calledFunction = getObject(toolCall, "function");
      const usage = telemetry.mapChatUsage(response.usage, "function");
      telemetry.record(usage);
      telemetry.setFooter(context);

      if (!toolCall) {
        const content = getString(message, "content") ?? "(no content)";
        throw new Error(
          `DeepSeek did not call the required function "${params.name}": ${content}`
        );
      }

      const calledName = getString(calledFunction, "name");
      if (calledName !== params.name) {
        throw new Error(
          `DeepSeek called "${calledName ?? "(unnamed)"}" instead of required function "${params.name}"`
        );
      }

      const rawArguments = getString(calledFunction, "arguments");
      if (rawArguments === undefined) {
        throw new Error(
          `DeepSeek returned no arguments for required function "${params.name}"`
        );
      }

      let parsedArguments: unknown;
      try {
        parsedArguments = JSON.parse(rawArguments);
      } catch (error) {
        throw new Error(
          `DeepSeek returned invalid JSON arguments for required function "${params.name}"`,
          { cause: error }
        );
      }

      return {
        content: [
          {
            text: `Function call: ${calledName}\nArguments: ${JSON.stringify(parsedArguments, null, 2)}`,
            type: "text" as const,
          },
        ],
        details: {
          arguments: parsedArguments,
          name: calledName,
          rawArguments,
          reasoning: getString(message, "reasoning_content"),
          strictSchema: strictParameters,
          usage,
        },
      };
    },
    label: "DeepSeek Call Function",
    name: "ds_call_function",
    parameters: CallFunctionParams,
    promptSnippet:
      "ds_call_function(name, parameters, context?) - strict-mode DeepSeek function call",
  });
};

const registerTools = (pi: ExtensionAPI, services: ToolServices): void => {
  registerChatTools(pi, services);
  registerBetaTools(pi, services);
  registerResponsesTools(pi, services);
  registerFunctionTool(pi, services);
};

// ---------------------------------------------------------------------------
// Provider and lifecycle registration
// ---------------------------------------------------------------------------

const registerProvider = (pi: ExtensionAPI): void => {
  pi.registerProvider(PROVIDER_ID, {
    api: "openai-responses",
    apiKey: `$${API_KEY_ENV}`,
    baseUrl: BASE_URL,
    models: [
      {
        compat: {
          requiresAssistantContentForToolCalls: true,
          requiresReasoningContentOnAssistantMessages: true,
          supportsDeveloperRole: false,
          supportsLongCacheRetention: false,
          supportsReasoningEffort: true,
          supportsStrictMode: false,
          supportsToolChoice: false,
        },
        contextWindow: 1_048_576,
        cost: COST,
        id: MODEL_ID,
        input: ["text"],
        maxTokens: MAX_OUTPUT_TOKENS,
        name: "DeepSeek V4 Flash",
        reasoning: true,
        thinkingLevelMap: THINKING_LEVEL_MAP,
      },
    ],
    name: "DeepSeek V4 Flash (Responses API)",
  });
};

const stripUnsupportedThinkingParameters = (
  payload: JsonObject
): JsonObject => {
  const reasoning = getObject(payload, "reasoning");
  const thinkingOn = !reasoning || getString(reasoning, "effort") !== "none";
  if (thinkingOn) {
    for (const unsupportedParameter of [
      "temperature",
      "top_p",
      "presence_penalty",
      "frequency_penalty",
    ]) {
      Reflect.deleteProperty(payload, unsupportedParameter);
    }
  }
  return payload;
};

const registerLifecycleHandlers = (
  pi: ExtensionAPI,
  telemetry: TelemetryStore,
  threads: ThreadStore
): void => {
  pi.on("before_provider_request", (event) => {
    const payload = isJsonObject(event.payload) ? event.payload : undefined;
    if (!payload || payload.model !== MODEL_ID) {
      return;
    }
    return stripUnsupportedThinkingParameters(payload);
  });

  pi.on("turn_end", (event: TurnEndEvent, context) => {
    const { message } = event;
    if (!message || message.provider !== PROVIDER_ID || !message.usage) {
      return;
    }
    const { usage } = message;
    telemetry.record({
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost,
      input: usage.input,
      model: message.model ?? MODEL_ID,
      output: usage.output,
      reasoning: usage.reasoning,
      source: "agent",
      totalTokens: usage.totalTokens,
    });
    telemetry.setFooter(context);
  });

  pi.on("model_select", (_event, context) => {
    telemetry.setFooter(context);
  });
  pi.on("session_start", (_event, context) => {
    threads.restore(context);
  });
  pi.on("session_tree", (_event, context) => {
    threads.restore(context);
  });
};

// ---------------------------------------------------------------------------
// Command registration seam
// ---------------------------------------------------------------------------

interface CommandServices {
  responses: ResponsesApi;
  telemetry: TelemetryStore;
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const registerCommands = (
  pi: ExtensionAPI,
  services: CommandServices
): void => {
  const { responses, telemetry } = services;

  pi.registerCommand("ds", {
    description:
      "One-shot chat with DeepSeek V4 Flash (Responses API). Usage: /ds <prompt>",
    handler: async (args, context) => {
      const prompt = args.trim();
      if (!prompt) {
        context.ui.notify("Usage: /ds <prompt>", "info");
        return;
      }

      try {
        const result = await responses.chat(
          [
            {
              content: [{ text: prompt, type: "input_text" }],
              role: "user",
            },
          ],
          { signal: context.signal }
        );
        const usage = telemetry.mapResponsesUsage(result.usage, "command");
        telemetry.record(usage);
        telemetry.setFooter(context);
        pi.appendEntry(THREADS_ENTRY, {
          prompt,
          reply: result.text || "(empty reply)",
          thinking: result.thinking,
          ts: Date.now(),
          usage,
        });
      } catch (error) {
        context.ui.notify(`DeepSeek error: ${getErrorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("ds-cache", {
    description:
      "Show KV-cache hit/miss tokens and cost for the last DeepSeek request",
    handler: (_args, context) => {
      const lastUsage = telemetry.getLastUsage();
      if (!lastUsage) {
        context.ui.notify(
          "No DeepSeek request recorded in this session yet — send a message first.",
          "info"
        );
        return;
      }
      pi.appendEntry(CACHE_CARD_ENTRY, {
        history: telemetry.getHistory(),
        ts: Date.now(),
        usage: lastUsage,
      });
      context.ui.setStatus(FOOTER_KEY, undefined);
      telemetry.setFooter(context);
    },
  });
};

// ---------------------------------------------------------------------------
// Entry renderers
// ---------------------------------------------------------------------------

const createEntryBox = (
  theme: Parameters<Parameters<ExtensionAPI["registerEntryRenderer"]>[1]>[2]
): Box => new Box(1, 1, (text) => theme.bg("customMessageBg", text));

const registerRenderers = (pi: ExtensionAPI): void => {
  pi.registerEntryRenderer<{
    prompt: string;
    reply: string;
    thinking?: string;
    usage?: UsageRecord;
    ts: number;
  }>(THREADS_ENTRY, (entry, _options, theme) => {
    const { data } = entry;
    const box = createEntryBox(theme);
    box.addChild(
      new Text(theme.fg("accent", "[ds] ") + theme.fg("dim", data.prompt), 0, 0)
    );
    box.addChild(new Text("", 0, 0));
    box.addChild(new Text(data.reply, 0, 0));
    if (data.usage) {
      box.addChild(
        new Text(
          theme.fg(
            "muted",
            `cache ${(data.usage.cacheRead / 1000).toFixed(1)}K hit / ${(data.usage.input / 1000).toFixed(1)}K miss · $${data.usage.cost.total.toFixed(4)}`,
            0,
            0
          ),
          0,
          0
        )
      );
    }
    return box;
  });

  pi.registerEntryRenderer<{
    usage: UsageRecord;
    history: UsageRecord[];
    ts: number;
  }>(CACHE_CARD_ENTRY, (entry, _options, theme) => {
    const { usage, history } = entry.data;
    const box = createEntryBox(theme);
    box.addChild(
      new Text(
        `${theme.fg("accent", "[ds-cache]")} ${(usage.hitRate * 100).toFixed(1)}% hit rate`,
        0,
        0
      )
    );
    box.addChild(
      new Text(
        `hit ${usage.cacheRead} tok · miss ${usage.input} tok · output ${usage.output} tok${usage.reasoning === undefined ? "" : ` (reasoning ${usage.reasoning})`}${usage.cacheWrite ? ` · cacheWrite ${usage.cacheWrite}` : ""}`,
        0,
        0
      )
    );
    box.addChild(
      new Text(
        `cost input $${usage.cost.input.toFixed(5)} · output $${usage.cost.output.toFixed(5)} · cacheRead $${usage.cost.cacheRead.toFixed(6)} · total $${usage.cost.total.toFixed(5)}`,
        0,
        0
      )
    );
    box.addChild(
      new Text(
        theme.fg(
          "muted",
          `source: ${usage.source} · model: ${usage.model} · ${new Date(usage.ts).toLocaleTimeString()}`
        ),
        0,
        0
      )
    );

    if (history.length > 1) {
      const totalCacheRead = history.reduce(
        (sum, record) => sum + record.cacheRead,
        0
      );
      const totalInput = history.reduce(
        (sum, record) => sum + record.cacheRead + record.input,
        0
      );
      const aggregateHitRate = (totalCacheRead / Math.max(1, totalInput)) * 100;
      box.addChild(
        new Text(
          theme.fg(
            "muted",
            `${history.length} requests this session · aggregate hit rate ${aggregateHitRate.toFixed(1)}%`
          ),
          0,
          0
        )
      );
    }
    return box;
  });
};

// ---------------------------------------------------------------------------
// Thin default composition
// ---------------------------------------------------------------------------

export default (pi: ExtensionAPI): void => {
  const auth = createAuthService();
  const http = createHttpClient(auth);
  const responses = createResponsesApi(http);
  const beta = createBetaApi(http);
  const telemetry = createTelemetryStore();
  const threads = createThreadStore();
  const services: ToolServices = { beta, responses, telemetry, threads };

  registerProvider(pi);
  registerLifecycleHandlers(pi, telemetry, threads);
  registerTools(pi, services);
  registerCommands(pi, { responses, telemetry });
  registerRenderers(pi);
};
