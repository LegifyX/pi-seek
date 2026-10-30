import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BalanceStore } from "../src/balance.ts";
import {
  API_KEY_ENV,
  BASE_URL,
  CONTEXT_WINDOW,
  createRuntimeState,
  type DeepSeekRuntimeState,
  FLASH_MODEL_ID,
  FOOTER_KEY,
  MAX_OUTPUT_TOKENS,
  MODEL_COSTS,
  MODEL_ID,
  PRO_MODEL_ID,
  PROVIDER_ID,
  THINKING_LEVEL_MAP,
  type TokenCost,
  USAGE_ENTRY,
  type UsageRecord,
} from "../src/config.ts";
import {
  registerLifecycleHandlers,
  registerProvider,
} from "../src/lifecycle.ts";
import { createTelemetryStore, type TelemetryStore } from "../src/telemetry.ts";
import { createThreadStore, type ThreadStore } from "../src/threads.ts";

interface RegisteredModel {
  compat: {
    supportsDeveloperRole: boolean;
    supportsLongCacheRetention: boolean;
    supportsStrictMode: boolean;
  };
  contextWindow: number;
  cost: TokenCost;
  id: string;
  input: string[];
  maxTokens: number;
  name: string;
  reasoning: boolean;
  thinkingLevelMap: typeof THINKING_LEVEL_MAP;
}

interface RegisteredSpec {
  api: string;
  apiKey: string;
  baseUrl: string;
  models: RegisteredModel[];
  name: string;
}

interface RecordingPi {
  registered?: { providerId: string; spec: RegisteredSpec };
  registerProvider: (providerId: string, spec: RegisteredSpec) => void;
}

const createFakePi = (): RecordingPi => {
  const pi: RecordingPi = {
    registerProvider(providerId: string, spec: RegisteredSpec): void {
      pi.registered = { providerId, spec };
    },
  };
  return pi;
};

// ---------------------------------------------------------------------------
// registerProvider contract
// ---------------------------------------------------------------------------

test("registerProvider records the DeepSeek V4 Flash and Pro registration contract", () => {
  const pi = createFakePi();
  registerProvider(pi as unknown as ExtensionAPI);
  assert.ok(pi.registered, "registerProvider must call pi.registerProvider");
  assert.equal(pi.registered.providerId, PROVIDER_ID);

  const { spec } = pi.registered;
  assert.equal(spec.api, "openai-responses");
  assert.equal(spec.apiKey, `$${API_KEY_ENV}`);
  assert.equal(spec.baseUrl, BASE_URL);
  assert.equal(spec.name, "DeepSeek V4 (Responses API)");
  assert.equal(spec.models.length, 2);

  const [flash, pro] = spec.models;
  assert.equal(flash.id, FLASH_MODEL_ID);
  assert.equal(flash.name, "DeepSeek V4 Flash");
  assert.deepEqual(flash.cost, MODEL_COSTS[FLASH_MODEL_ID]);
  assert.equal(pro.id, PRO_MODEL_ID);
  assert.equal(pro.name, "DeepSeek V4 Pro");
  assert.deepEqual(pro.cost, MODEL_COSTS[PRO_MODEL_ID]);

  for (const model of spec.models) {
    assert.equal(model.contextWindow, CONTEXT_WINDOW);
    assert.equal(model.maxTokens, MAX_OUTPUT_TOKENS);
    assert.deepEqual(model.input, ["text"]);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.thinkingLevelMap, THINKING_LEVEL_MAP);
    // Only OpenAIResponsesCompat fields: requiresReasoningContentOnAssistantMessages
    // and supportsReasoningEffort are Chat-Completions-only and never read by the
    // openai-responses adapter; supportsStrictMode is on because the Responses
    // endpoint verifiably accepts strict:true function tools.
    assert.deepEqual(model.compat, {
      supportsDeveloperRole: false,
      supportsLongCacheRetention: false,
      supportsStrictMode: true,
    });
  }
});

// The shipped models.json layer must not drift from the in-code registration:
// pi's provider-composer replaces the extension's models/compat with the
// models.json models/compat when the extension loads, so a divergence would
// silently change the effective provider behavior.
test("models.json providers.deepseek-responses matches the registered spec", () => {
  const pi = createFakePi();
  registerProvider(pi as unknown as ExtensionAPI);
  assert.ok(pi.registered);
  const { spec } = pi.registered;

  const raw = readFileSync(new URL("../models.json", import.meta.url), "utf8");
  const modelsJson = JSON.parse(raw) as {
    providers: Record<
      string,
      {
        api: string;
        apiKey: string;
        baseUrl: string;
        compat: Record<string, unknown>;
        models: Record<string, unknown>[];
        name: string;
      }
    >;
  };
  const provider = modelsJson.providers[PROVIDER_ID];
  assert.ok(provider, `models.json must define the "${PROVIDER_ID}" provider`);

  assert.equal(provider.name, spec.name);
  assert.equal(provider.api, spec.api);
  assert.equal(provider.baseUrl, spec.baseUrl);
  assert.equal(provider.apiKey, spec.apiKey);
  assert.deepEqual(provider.compat, spec.models[0].compat);

  assert.equal(provider.models.length, spec.models.length);
  for (const [index, model] of provider.models.entries()) {
    const registered = spec.models[index];
    assert.ok(registered, `registered spec must define model ${index}`);
    assert.equal(model.id, registered.id);
    assert.equal(model.name, registered.name);
    assert.deepEqual(model.thinkingLevelMap, registered.thinkingLevelMap);
    assert.deepEqual(model.cost, registered.cost);
    assert.equal(model.contextWindow, registered.contextWindow);
    assert.equal(model.maxTokens, registered.maxTokens);
  }
});

// ---------------------------------------------------------------------------
// registerLifecycleHandlers
// ---------------------------------------------------------------------------

type LifecycleHandler = (event: unknown, context: unknown) => unknown;

interface RecordingHandlers {
  appendEntry: (customType: string, data?: unknown) => void;
  entries: Array<{ customType: string; data?: unknown }>;
  handlers: Map<string, LifecycleHandler>;
  on: (event: string, handler: LifecycleHandler) => void;
}

interface HandlerHarness {
  balance?: BalanceStore;
  pi: RecordingHandlers;
  runtimeState: DeepSeekRuntimeState;
  telemetry: TelemetryStore;
  threads: ThreadStore;
}

const createRecordingHandlers = (): RecordingHandlers => {
  const handlers = new Map<string, LifecycleHandler>();
  const entries: Array<{ customType: string; data?: unknown }> = [];
  return {
    appendEntry(customType: string, data?: unknown): void {
      entries.push({ customType, data });
    },
    entries,
    handlers,
    on(event: string, handler: LifecycleHandler): void {
      handlers.set(event, handler);
    },
  };
};

const createHandlerHarness = (balance?: BalanceStore): HandlerHarness => {
  const pi = createRecordingHandlers();
  const runtimeState = createRuntimeState();
  const telemetry = createTelemetryStore(runtimeState);
  const threads = createThreadStore();
  registerLifecycleHandlers(
    pi as unknown as ExtensionAPI,
    runtimeState,
    telemetry,
    threads,
    balance
  );
  return { balance, pi, runtimeState, telemetry, threads };
};

const createContext = (
  overrides: { branch?: unknown[]; model?: { provider?: string } } = {}
): {
  calls: Array<{ key: string; value: string | undefined }>;
  context: ExtensionContext;
} => {
  const calls: Array<{ key: string; value: string | undefined }> = [];
  const context = {
    model: overrides.model,
    sessionManager: { getBranch: () => overrides.branch ?? [] },
    ui: {
      setStatus: (key: string, value: string | undefined) => {
        calls.push({ key, value });
      },
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
  return { calls, context };
};

const getHandler = (pi: RecordingHandlers, event: string): LifecycleHandler => {
  const handler = pi.handlers.get(event);
  assert.ok(handler, `on("${event}") must be registered`);
  return handler;
};

const FOOTER_PATTERN = /^[☀☾] (?:peak|off-peak 50%)$/;
const BALANCE_SUFFIX_PATTERN = / · \$5\.20$/;

const asObject = (value: unknown): Record<string, unknown> => {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "handler must return a payload object"
  );
  return value as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// before_provider_request
// ---------------------------------------------------------------------------

test("before_provider_request injects the default reasoning effort and strips sampling params", () => {
  const { pi, runtimeState } = createHandlerHarness();
  const handler = getHandler(pi, "before_provider_request");

  const result = asObject(
    handler(
      {
        payload: { model: MODEL_ID, temperature: 0.7, top_p: 0.9 },
        type: "before_provider_request",
      },
      {}
    )
  );
  const reasoning = asObject(result.reasoning);
  assert.equal(reasoning.effort, runtimeState.defaultEffort);
  assert.equal(Object.hasOwn(result, "temperature"), false);
  assert.equal(Object.hasOwn(result, "top_p"), false);
});

test("before_provider_request applies the default reasoning effort to pro payloads too", () => {
  const { pi, runtimeState } = createHandlerHarness();
  const handler = getHandler(pi, "before_provider_request");

  const result = asObject(
    handler(
      {
        payload: { model: PRO_MODEL_ID, temperature: 0.7, top_p: 0.9 },
        type: "before_provider_request",
      },
      {}
    )
  );
  const reasoning = asObject(result.reasoning);
  assert.equal(reasoning.effort, runtimeState.defaultEffort);
  assert.equal(Object.hasOwn(result, "temperature"), false);
  assert.equal(Object.hasOwn(result, "top_p"), false);
});

test("before_provider_request is a no-op for other models and when disabled", () => {
  const { pi, runtimeState } = createHandlerHarness();
  const handler = getHandler(pi, "before_provider_request");

  const otherPayload = { model: "some-other-model", temperature: 0.7 };
  assert.equal(
    handler({ payload: otherPayload, type: "before_provider_request" }, {}),
    undefined
  );
  assert.deepEqual(otherPayload, {
    model: "some-other-model",
    temperature: 0.7,
  });

  runtimeState.enabled = false;
  const payload = { model: MODEL_ID, temperature: 0.7 };
  assert.equal(
    handler({ payload, type: "before_provider_request" }, {}),
    undefined
  );
  assert.deepEqual(payload, { model: MODEL_ID, temperature: 0.7 });
});

test("before_provider_request preserves temperature/top_p when reasoning effort is none", () => {
  const { pi } = createHandlerHarness();
  const handler = getHandler(pi, "before_provider_request");

  const result = asObject(
    handler(
      {
        payload: {
          model: MODEL_ID,
          reasoning: { effort: "none" },
          temperature: 0.7,
          top_p: 0.9,
        },
        type: "before_provider_request",
      },
      {}
    )
  );
  assert.equal(result.temperature, 0.7);
  assert.equal(result.top_p, 0.9);
  assert.equal(asObject(result.reasoning).effort, "none");
});

// ---------------------------------------------------------------------------
// turn_end
// ---------------------------------------------------------------------------

const usage = {
  cacheRead: 20,
  cacheWrite: 0,
  cost: {
    cacheRead: 0.001,
    cacheWrite: 0,
    input: 0.01,
    output: 0.02,
    total: 0.031,
  },
  input: 100,
  output: 50,
  reasoning: 10,
  totalTokens: 150,
};

const turnEnd = (
  message: Record<string, unknown>
): Record<string, unknown> => ({
  message,
  toolResults: [],
  turnIndex: 0,
  type: "turn_end",
});

test("turn_end records a ds-usage entry for a matching assistant message", () => {
  const { pi, telemetry } = createHandlerHarness();
  const handler = getHandler(pi, "turn_end");
  const { context } = createContext();

  handler(
    turnEnd({
      model: MODEL_ID,
      provider: PROVIDER_ID,
      role: "assistant",
      usage,
    }),
    context
  );

  assert.equal(pi.entries.length, 1);
  const [entry] = pi.entries;
  assert.equal(entry.customType, USAGE_ENTRY);
  assert.deepEqual(entry.data, telemetry.getLastUsage());
  const record = entry.data as UsageRecord;
  assert.equal(record.input, usage.input);
  assert.equal(record.output, usage.output);
  assert.equal(record.cacheRead, usage.cacheRead);
  assert.equal(record.cacheWrite, usage.cacheWrite);
  assert.equal(record.reasoning, usage.reasoning);
  assert.equal(record.totalTokens, usage.totalTokens);
  assert.equal(record.model, MODEL_ID);
  assert.equal(record.source, "agent");
  assert.deepEqual(record.cost, usage.cost);
});

test("turn_end is a no-op for user messages, other providers, missing usage, and when disabled", () => {
  const { pi, runtimeState } = createHandlerHarness();
  const handler = getHandler(pi, "turn_end");
  const { context } = createContext();

  handler(turnEnd({ provider: PROVIDER_ID, role: "user", usage }), context);
  handler(
    turnEnd({ provider: "other-provider", role: "assistant", usage }),
    context
  );
  handler(turnEnd({ provider: PROVIDER_ID, role: "assistant" }), context);
  assert.equal(pi.entries.length, 0);

  runtimeState.enabled = false;
  handler(
    turnEnd({ provider: PROVIDER_ID, role: "assistant", usage }),
    context
  );
  assert.equal(pi.entries.length, 0);
});

// ---------------------------------------------------------------------------
// model_select
// ---------------------------------------------------------------------------

const recordedUsage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 1000,
  model: MODEL_ID,
  output: 200,
  source: "agent",
  totalTokens: 1200,
};

test("model_select refreshes the footer when the DeepSeek provider is active", () => {
  const { pi, telemetry } = createHandlerHarness();
  telemetry.record(recordedUsage);
  const handler = getHandler(pi, "model_select");
  const { calls, context } = createContext({
    model: { provider: PROVIDER_ID },
  });

  handler(
    {
      model: {},
      previousModel: undefined,
      source: "set",
      type: "model_select",
    },
    context
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, FOOTER_KEY);
  assert.match(calls[0].value ?? "", FOOTER_PATTERN);
});

test("model_select clears the footer for a non-DeepSeek model", () => {
  const { pi, telemetry } = createHandlerHarness();
  telemetry.record(recordedUsage);
  const handler = getHandler(pi, "model_select");
  const { calls, context } = createContext({ model: { provider: "other" } });

  handler(
    {
      model: {},
      previousModel: undefined,
      source: "set",
      type: "model_select",
    },
    context
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, FOOTER_KEY);
  assert.equal(calls[0].value, undefined);
});

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const BALANCE_UNAVAILABLE_PATTERN = / · unavailable$/;

const usableBalance = (
  totalBalance: number,
  isAvailable = true
): BalanceStore => ({
  get: () =>
    Promise.resolve({
      entries: [
        {
          currency: "USD",
          grantedBalance: 0,
          toppedUpBalance: 0,
          totalBalance,
        },
      ],
      fetchedAt: Date.now(),
      isAvailable,
    }),
  peek: () => null,
});

test("footer appends the remaining balance when a balance store is provided", async () => {
  const { pi, telemetry } = createHandlerHarness(usableBalance(5.2));
  telemetry.record(recordedUsage);
  const handler = getHandler(pi, "model_select");
  const { calls, context } = createContext({
    model: { provider: PROVIDER_ID },
  });

  handler(
    {
      model: {},
      previousModel: undefined,
      source: "set",
      type: "model_select",
    },
    context
  );
  await settle();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].key, FOOTER_KEY);
  assert.match(calls[0].value ?? "", FOOTER_PATTERN);
  assert.equal(calls[1].key, FOOTER_KEY);
  assert.match(calls[1].value ?? "", BALANCE_SUFFIX_PATTERN);
});

test("footer shows 'balance unavailable' when the account reports no usable balance", async () => {
  const { pi, telemetry } = createHandlerHarness(usableBalance(0, false));
  telemetry.record(recordedUsage);
  const handler = getHandler(pi, "model_select");
  const { calls, context } = createContext({
    model: { provider: PROVIDER_ID },
  });

  handler(
    {
      model: {},
      previousModel: undefined,
      source: "set",
      type: "model_select",
    },
    context
  );
  await settle();

  const last = calls.at(-1);
  assert.equal(last?.key, FOOTER_KEY);
  assert.match(last?.value ?? "", BALANCE_UNAVAILABLE_PATTERN);
});

test("footer keeps the base line when the balance fetch fails", async () => {
  const balance: BalanceStore = {
    get: () => Promise.reject(new Error("network down")),
    peek: () => null,
  };
  const { pi, telemetry } = createHandlerHarness(balance);
  telemetry.record(recordedUsage);
  const handler = getHandler(pi, "model_select");
  const { calls, context } = createContext({
    model: { provider: PROVIDER_ID },
  });

  handler(
    {
      model: {},
      previousModel: undefined,
      source: "set",
      type: "model_select",
    },
    context
  );
  await settle();

  assert.equal(calls.length, 1);
  assert.match(calls[0].value ?? "", FOOTER_PATTERN);
});

// ---------------------------------------------------------------------------
// session_start / session_tree
// ---------------------------------------------------------------------------

const branch = (): unknown[] => [
  {
    message: {
      details: { thread: { items: ["hello"], name: "default", round: 2 } },
      role: "toolResult",
      toolName: "ds_chat",
    },
    type: "message",
  },
  {
    customType: USAGE_ENTRY,
    data: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0.0014,
        output: 0.0028,
        total: 0.0042,
      },
      hitRate: 0,
      input: 10,
      model: MODEL_ID,
      output: 10,
      source: "agent",
      totalTokens: 20,
      ts: 1234,
    },
    type: "custom",
  },
];

const assertBranchRestored = (
  pi: RecordingHandlers,
  threads: ThreadStore,
  telemetry: TelemetryStore,
  eventName: "session_start" | "session_tree",
  event: Record<string, unknown>
): void => {
  const handler = getHandler(pi, eventName);
  const { context } = createContext({ branch: branch() });

  handler(event, context);

  const snapshot = threads.snapshot();
  assert.deepEqual(Object.keys(snapshot), ["default"]);
  assert.deepEqual(snapshot.default.items, ["hello"]);
  assert.equal(snapshot.default.round, 2);
  assert.equal(telemetry.getHistory().length, 1);
  const [record] = telemetry.getHistory();
  assert.equal(record.ts, 1234);
  assert.equal(record.source, "agent");
  assert.equal(record.model, MODEL_ID);
  assert.equal(record.input, 10);
};

test("session_start rebuilds threads and usage history from the branch", () => {
  const { pi, telemetry, threads } = createHandlerHarness();
  assertBranchRestored(pi, threads, telemetry, "session_start", {
    reason: "startup",
    type: "session_start",
  });
});

test("session_tree rebuilds threads and usage history from the branch", () => {
  const { pi, telemetry, threads } = createHandlerHarness();
  assertBranchRestored(pi, threads, telemetry, "session_tree", {
    newLeafId: null,
    oldLeafId: null,
    type: "session_tree",
  });
});
