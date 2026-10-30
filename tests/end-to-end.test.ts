// ---------------------------------------------------------------------------
// Safe, mocked end-to-end coverage (P3)
//
// Composes the real extension services (auth, HTTP, Responses/Beta APIs,
// telemetry, threads, balance) over a stubbed fetch transport and asserts the
// full registration and request contract: exact URLs, methods, bearer
// headers (asserted, never printed), request bodies, response extraction,
// tool/command/renderer registration, and that nothing touches a live API.
// All fixtures are local; no credentials or network calls are involved.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BalanceStore } from "../src/balance.ts";
import { createBalanceStore } from "../src/balance.ts";
import type { BetaApi } from "../src/beta.ts";
import { createBetaApi } from "../src/beta.ts";
import { registerCommands } from "../src/commands.ts";
import {
  createRuntimeState,
  USAGE_ENTRY,
  type UsageRecord,
} from "../src/config.ts";
import {
  createAuthService,
  createHttpClient,
  type HttpClient,
} from "../src/http.ts";
import { registerSkillDiscovery } from "../src/index.ts";
import {
  registerLifecycleHandlers,
  registerProvider,
} from "../src/lifecycle.ts";
import { registerRenderers } from "../src/renderers.ts";
import type { ResponsesApi } from "../src/responses.ts";
import { createResponsesApi } from "../src/responses.ts";
import type { TelemetryStore } from "../src/telemetry.ts";
import { createTelemetryStore } from "../src/telemetry.ts";
import type { ThreadStore } from "../src/threads.ts";
import { createThreadStore } from "../src/threads.ts";
import { registerTools, type ToolServices } from "../src/tools.ts";
import {
  AUTH_JSON_FIXTURE,
  balanceResponse,
  chatCompletionResponse,
  completionResponse,
  E2E_API_KEY,
  functionCallCompletion,
  responsesChatCompleted,
  responsesWebSearchCompleted,
} from "./fixtures/end-to-end.fixture.ts";

// The auth service prioritizes the DEEPSEEK_API_KEY env var over the injected
// auth.json fixture. Tests must stay hermetic and must never read a real
// ambient key, so the variable is cleared for this (isolated) test process;
// the auth.json fixture is what the assertions exercise.
before(() => {
  delete process.env.DEEPSEEK_API_KEY;
});

// ---------------------------------------------------------------------------
// Recording fake pi
// ---------------------------------------------------------------------------

interface RegisteredTool {
  description: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: Record<string, unknown>
  ) => Promise<unknown>;
  label: string;
  name: string;
  parameters: unknown;
  promptSnippet?: string;
}

interface RegisteredCommand {
  description: string;
  handler: (args: string, context: unknown) => Promise<void> | void;
  name: string;
}

interface RegisteredRenderer {
  customType: string;
  renderer: unknown;
}

interface RegisteredProvider {
  config: Record<string, unknown>;
  name: string;
}

interface RecordedEntry {
  customType: string;
  data: unknown;
}

interface RecordingPi {
  commands: RegisteredCommand[];
  entries: RecordedEntry[];
  events: string[];
  handlers: Map<string, unknown>;
  providers: RegisteredProvider[];
  renderers: RegisteredRenderer[];
  tools: Map<string, RegisteredTool>;
}

// Every ExtensionAPI surface the extension touches records its arguments for
// later assertion. The object is cast to ExtensionAPI only where registration
// functions require it; the recording maps stay fully typed.
const createRecordingPi = (): { pi: ExtensionAPI; recording: RecordingPi } => {
  const commands: RegisteredCommand[] = [];
  const entries: RecordedEntry[] = [];
  const events: string[] = [];
  const handlers = new Map<string, unknown>();
  const providers: RegisteredProvider[] = [];
  const renderers: RegisteredRenderer[] = [];
  const tools = new Map<string, RegisteredTool>();

  const pi = {
    appendEntry: (customType: string, data?: unknown): void => {
      entries.push({ customType, data });
    },
    on: (event: string, handler?: unknown): void => {
      events.push(event);
      if (handler !== undefined) {
        handlers.set(event, handler);
      }
    },
    registerCommand: (
      name: string,
      options: Omit<RegisteredCommand, "name">
    ): void => {
      commands.push({ name, ...options });
    },
    registerEntryRenderer: (customType: string, renderer: unknown): void => {
      renderers.push({ customType, renderer });
    },
    registerProvider: (name: string, config: Record<string, unknown>): void => {
      providers.push({ config, name });
    },
    registerTool: (tool: RegisteredTool): void => {
      tools.set(tool.name, tool);
    },
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    recording: {
      commands,
      entries,
      events,
      handlers,
      providers,
      renderers,
      tools,
    },
  };
};

// ---------------------------------------------------------------------------
// Mock fetch transport
// ---------------------------------------------------------------------------

interface CapturedRequest {
  body?: unknown;
  headers: Headers;
  method: string;
  url: string;
}

type RouteHandler = (request: CapturedRequest) => unknown;

interface MockTransport {
  install: () => void;
  requests: CapturedRequest[];
  route: (method: string, url: string, handler: RouteHandler) => void;
  uninstall: () => void;
}

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

// Captures every request the HTTP client makes and answers each exact
// method+URL with a fixture JSON body. An unmocked route returns a 500 so a
// forgotten route fails loudly instead of touching the network.
const createMockTransport = (): MockTransport => {
  const requests: CapturedRequest[] = [];
  const routes: Array<{
    handler: RouteHandler;
    method: string;
    url: string;
  }> = [];
  let originalFetch: typeof globalThis.fetch | undefined;

  const install = (): void => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      const body =
        rawBody === undefined ? undefined : (JSON.parse(rawBody) as unknown);
      const request = { body, headers, method, url: requestUrl(input) };
      requests.push(request);
      const route = routes.find(
        (candidate) =>
          candidate.method === method && candidate.url === request.url
      );
      const payload = route
        ? route.handler(request)
        : { error: "unmocked route" };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      );
    };
  };

  const uninstall = (): void => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  };

  return {
    install,
    requests,
    route: (method, url, handler) => {
      routes.push({ handler, method, url });
    },
    uninstall,
  };
};

// ---------------------------------------------------------------------------
// Harness: real services over the stub
// ---------------------------------------------------------------------------

interface Harness {
  balance: BalanceStore;
  beta: BetaApi;
  http: HttpClient;
  pi: ExtensionAPI;
  recording: RecordingPi;
  responses: ResponsesApi;
  services: ToolServices;
  telemetry: TelemetryStore;
  threads: ThreadStore;
  transport: MockTransport;
}

const createHarness = (): Harness => {
  const transport = createMockTransport();
  const auth = createAuthService({
    agentDir: "/fake/agent",
    readFile: async () => AUTH_JSON_FIXTURE,
  });
  const http = createHttpClient(auth);
  const runtimeState = createRuntimeState();
  const responses = createResponsesApi(http);
  const beta = createBetaApi(http);
  const telemetry = createTelemetryStore(runtimeState);
  const threads = createThreadStore();
  const balance = createBalanceStore(http);
  const services: ToolServices = {
    balance,
    beta,
    responses,
    runtimeState,
    telemetry,
    threads,
  };

  const { pi, recording } = createRecordingPi();
  registerProvider(pi);
  registerLifecycleHandlers(pi, runtimeState, telemetry, threads);
  registerTools(pi, services);
  registerCommands(pi, services);
  registerRenderers(pi);

  return {
    balance,
    beta,
    http,
    pi,
    recording,
    responses,
    services,
    telemetry,
    threads,
    transport,
  };
};

const executeTool = async (
  recording: RecordingPi,
  name: string,
  params: Record<string, unknown>
): Promise<unknown> => {
  const tool = recording.tools.get(name);
  assert.ok(tool, `tool "${name}" must be registered`);
  return await tool.execute("call_e2e", params, undefined, undefined, {
    model: undefined,
    signal: undefined,
    ui: { notify: () => undefined, setStatus: () => undefined },
  });
};

const asTextResult = (result: unknown): string => {
  const raw = result as { content?: Array<{ text?: string }> };
  const text = raw.content?.[0]?.text;
  assert.ok(text !== undefined, "expected a text content in the tool result");
  return text;
};

const DEEPSEEK_PROGRESS_PATTERN = /DeepSeek/;
const INCOMPLETE_NOTE_PATTERN =
  /\[note: response incomplete \(max_output_tokens\)\]/;
const TIME_NOTE_PATTERN = /Current time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/;
const FIM_STOP_NOTE_PATTERN =
  /\[note: completion stopped: insufficient_system_resource\]/;
const PREFIX_STOP_NOTE_PATTERN = /\[note: completion stopped: length\]/;

const sortedNames = (names: string[]): string[] =>
  [...names].sort((a, b) => a.localeCompare(b));

// ---------------------------------------------------------------------------
// Registration contract
// ---------------------------------------------------------------------------

test("registers the provider, six tools, four commands, and three renderers", () => {
  const { recording } = createHarness();

  assert.equal(recording.providers.length, 1);
  const [provider] = recording.providers;
  assert.ok(provider);
  assert.equal(provider.name, "deepseek-responses");
  const providerConfig = provider.config as {
    api: string;
    baseUrl: string;
    models: Array<{ id: string }>;
  };
  assert.equal(providerConfig.api, "openai-responses");
  assert.equal(providerConfig.baseUrl, "https://api.deepseek.com");
  assert.equal(providerConfig.models.length, 2);
  assert.equal(providerConfig.models[0]?.id, "deepseek-v4-flash");
  assert.equal(providerConfig.models[1]?.id, "deepseek-v4-pro");

  const toolNames = sortedNames([...recording.tools.keys()]);
  assert.deepEqual(toolNames, [
    "ds_call_function",
    "ds_chat",
    "ds_chat_reset",
    "ds_fim",
    "ds_prefix_complete",
    "ds_web_search",
  ]);
  for (const toolName of toolNames) {
    const tool = recording.tools.get(toolName);
    assert.ok(tool, `tool "${toolName}" must be registered`);
    assert.equal(typeof tool.execute, "function");
  }

  const commandNames = sortedNames(recording.commands.map(({ name }) => name));
  assert.deepEqual(commandNames, ["deepseek", "ds", "ds-balance", "ds-cache"]);

  const rendererTypes = sortedNames(
    recording.renderers.map(({ customType }) => customType)
  );
  assert.deepEqual(rendererTypes, [
    "ds-balance-card",
    "ds-cache-card",
    "ds-reply",
  ]);

  // Lifecycle handlers are registered against the documented event names.
  for (const event of [
    "before_provider_request",
    "model_select",
    "session_start",
    "session_tree",
    "turn_end",
  ]) {
    assert.ok(
      recording.events.includes(event),
      `on("${event}") must be registered`
    );
  }
});

test("resources_discover contributes the packaged skills directory", async () => {
  const { pi, recording } = createRecordingPi();
  registerSkillDiscovery(pi);

  const handler = recording.handlers.get("resources_discover") as
    | (() => Promise<{ skillPaths?: string[] }>)
    | undefined;
  assert.ok(handler, 'on("resources_discover") must be registered');
  const result = await handler();
  const [skillPath] = result.skillPaths ?? [];
  assert.ok(skillPath, "skillPaths must contain the skills directory");
  assert.ok(
    skillPath.endsWith(`${path.sep}skills`) || skillPath.endsWith("/skills"),
    `unexpected skill path: ${skillPath}`
  );
  assert.ok(existsSync(skillPath), `skills directory must exist: ${skillPath}`);
});

// ---------------------------------------------------------------------------
// Request contract: ds_chat
// ---------------------------------------------------------------------------

test("ds_chat posts to /responses with bearer auth, the model, and the input message", async (t) => {
  const { recording, transport } = createHarness();
  transport.route(
    "POST",
    "https://api.deepseek.com/responses",
    () => responsesChatCompleted
  );
  transport.install();
  t.after(() => transport.uninstall());

  const result = await executeTool(recording, "ds_chat", {
    message: "Hello from e2e",
    thread: "e2e",
  });

  assert.equal(transport.requests.length, 1);
  const [request] = transport.requests;
  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.deepseek.com/responses");
  assert.equal(request.headers.get("authorization"), `Bearer ${E2E_API_KEY}`);
  assert.equal(request.headers.get("content-type"), "application/json");

  const body = request.body as {
    input: Array<{
      content: Array<{ text: string; type: string }>;
      role: string;
    }>;
    model: string;
    stream: boolean;
  };
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.stream, false);
  assert.equal(body.input.length, 1);
  assert.equal(body.input[0]?.role, "user");
  assert.equal(body.input[0]?.content[0]?.text, "Hello from e2e");

  assert.equal(asTextResult(result), "The current price of AAPL is $228.41.");

  const usageEntry = recording.entries.find(
    (entry) => entry.customType === USAGE_ENTRY
  );
  assert.ok(usageEntry, "ds_chat must append a usage entry");
  const usage = usageEntry.data as Pick<UsageRecord, "source">;
  assert.equal(usage.source, "chat");
});

test("ds_chat reports progress through onUpdate", async (t) => {
  const { recording, transport } = createHarness();
  transport.route(
    "POST",
    "https://api.deepseek.com/responses",
    () => responsesChatCompleted
  );
  transport.install();
  t.after(() => transport.uninstall());

  const tool = recording.tools.get("ds_chat");
  assert.ok(tool);
  const updates: Array<{ content?: Array<{ text?: string }> }> = [];
  await tool.execute(
    "call_e2e",
    { message: "progress", thread: "progress" },
    undefined,
    (partial: { content?: Array<{ text?: string }> }) => {
      updates.push(partial);
    },
    {
      model: undefined,
      signal: undefined,
      ui: { notify: () => undefined, setStatus: () => undefined },
    }
  );

  assert.ok(updates.length >= 1, "onUpdate must be called at least once");
  assert.match(updates[0]?.content?.[0]?.text ?? "", DEEPSEEK_PROGRESS_PATTERN);
});

test("ds_chat_reset clears a thread without any network call", async (t) => {
  const { recording, transport } = createHarness();
  transport.route(
    "POST",
    "https://api.deepseek.com/responses",
    () => responsesChatCompleted
  );
  transport.install();
  t.after(() => transport.uninstall());

  await executeTool(recording, "ds_chat", { message: "hi", thread: "e2e" });
  const requestsBeforeReset = transport.requests.length;
  assert.equal(requestsBeforeReset, 1);

  const result = await executeTool(recording, "ds_chat_reset", {
    thread: "e2e",
  });

  assert.equal(
    transport.requests.length,
    requestsBeforeReset,
    "ds_chat_reset must not hit the network"
  );
  assert.equal(asTextResult(result), 'Thread "e2e" reset');
  const { details } = result as { details: { reset: unknown } };
  assert.deepEqual(details.reset, { kind: "thread", name: "e2e" });
});

// ---------------------------------------------------------------------------
// Request contract: beta tools
// ---------------------------------------------------------------------------

test("ds_prefix_complete posts a prefix:true assistant message to beta chat completions", async (t) => {
  const { recording, transport } = createHarness();
  transport.route(
    "POST",
    "https://api.deepseek.com/beta/chat/completions",
    () => chatCompletionResponse("return 42")
  );
  transport.install();
  t.after(() => transport.uninstall());

  const prefix = "def answer():\n    ";
  const result = await executeTool(recording, "ds_prefix_complete", {
    prefix,
    prompt: "Write a python function",
  });

  assert.equal(transport.requests.length, 1);
  const [request] = transport.requests;
  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.deepseek.com/beta/chat/completions");
  assert.equal(request.headers.get("authorization"), `Bearer ${E2E_API_KEY}`);

  const body = request.body as {
    messages: Array<{ content: string; prefix?: boolean; role: string }>;
    model: string;
  };
  assert.equal(body.model, "deepseek-v4-flash");
  const lastMessage = body.messages.at(-1);
  assert.ok(lastMessage);
  assert.equal(lastMessage.role, "assistant");
  assert.equal(lastMessage.prefix, true);
  assert.equal(lastMessage.content, prefix);

  assert.equal(asTextResult(result), "return 42");
});

test("ds_fim posts a prompt completion to beta completions", async (t) => {
  const { recording, transport } = createHarness();
  transport.route("POST", "https://api.deepseek.com/beta/completions", () =>
    completionResponse("  return 42")
  );
  transport.install();
  t.after(() => transport.uninstall());

  const result = await executeTool(recording, "ds_fim", {
    prompt: "def answer():",
  });

  assert.equal(transport.requests.length, 1);
  const [request] = transport.requests;
  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.deepseek.com/beta/completions");
  assert.equal(request.headers.get("authorization"), `Bearer ${E2E_API_KEY}`);

  const body = request.body as { model: string; prompt: string };
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.prompt, "def answer():");

  assert.equal(asTextResult(result), "  return 42");
});

test("ds_chat passes temperature and top_p through to /responses", async (t) => {
  const { recording, transport } = createHarness();
  transport.route(
    "POST",
    "https://api.deepseek.com/responses",
    () => responsesChatCompleted
  );
  transport.install();
  t.after(() => transport.uninstall());

  await executeTool(recording, "ds_chat", {
    message: "hi",
    temperature: 0.3,
    thread: "e2e",
    top_p: 0.9,
  });

  const body = transport.requests[0]?.body as {
    temperature?: number;
    top_p?: number;
  };
  assert.equal(body.temperature, 0.3);
  assert.equal(body.top_p, 0.9);
});

test("ds_chat surfaces an incomplete response with its reason", async (t) => {
  const { recording, transport } = createHarness();
  transport.route("POST", "https://api.deepseek.com/responses", () => ({
    id: "resp_e2e_incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    model: "deepseek-v4-flash",
    object: "response",
    output: [
      {
        content: [{ text: "Partial answer", type: "output_text" }],
        id: "msg_e2e_inc",
        role: "assistant",
        type: "message",
      },
    ],
    status: "incomplete",
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 50,
      output_tokens_details: {},
      total_tokens: 150,
    },
  }));
  transport.install();
  t.after(() => transport.uninstall());

  const result = await executeTool(recording, "ds_chat", {
    message: "long answer please",
    thread: "e2e",
  });
  const { details } = result as { details: Record<string, unknown> };
  assert.equal(details.status, "incomplete");
  assert.equal(details.incomplete_reason, "max_output_tokens");
  assert.match(asTextResult(result), INCOMPLETE_NOTE_PATTERN);
});

test("ds_chat keeps the time note in instructions on every round", async (t) => {
  const { recording, transport } = createHarness();
  transport.route(
    "POST",
    "https://api.deepseek.com/responses",
    () => responsesChatCompleted
  );
  transport.install();
  t.after(() => transport.uninstall());

  await executeTool(recording, "ds_chat", {
    message: "first",
    system: "Be terse",
    thread: "e2e",
  });
  await executeTool(recording, "ds_chat", {
    message: "second",
    thread: "e2e",
  });

  assert.equal(transport.requests.length, 2);
  for (const request of transport.requests) {
    const { instructions } = request.body as { instructions?: string };
    assert.ok(instructions, "instructions must be present");
    assert.match(instructions, TIME_NOTE_PATTERN);
  }
});

test("ds_fim surfaces finish_reason and notes interrupted completions", async (t) => {
  const { recording, transport } = createHarness();
  transport.route("POST", "https://api.deepseek.com/beta/completions", () => ({
    choices: [
      {
        finish_reason: "insufficient_system_resource",
        index: 0,
        text: "  partial",
      },
    ],
    id: "cmp_e2e_1",
    object: "text_completion",
    usage: {
      completion_tokens: 2,
      prompt_cache_hit_tokens: 1,
      prompt_cache_miss_tokens: 3,
      prompt_tokens: 4,
      total_tokens: 6,
    },
  }));
  transport.install();
  t.after(() => transport.uninstall());

  const result = await executeTool(recording, "ds_fim", { prompt: "def f():" });
  const { details } = result as { details: Record<string, unknown> };
  assert.equal(details.finish_reason, "insufficient_system_resource");
  assert.match(asTextResult(result), FIM_STOP_NOTE_PATTERN);
});

test("ds_prefix_complete surfaces a length-truncated finish_reason", async (t) => {
  const { recording, transport } = createHarness();
  transport.route(
    "POST",
    "https://api.deepseek.com/beta/chat/completions",
    () => ({
      choices: [
        {
          finish_reason: "length",
          index: 0,
          message: { content: "```py", role: "assistant" },
        },
      ],
      id: "chat_e2e_trunc",
      object: "chat.completion",
      usage: {
        completion_tokens: 10,
        prompt_cache_hit_tokens: 5,
        prompt_cache_miss_tokens: 8,
        prompt_tokens: 13,
        total_tokens: 23,
      },
    })
  );
  transport.install();
  t.after(() => transport.uninstall());

  const result = await executeTool(recording, "ds_prefix_complete", {
    prefix: "```py",
    prompt: "write quick sort",
  });
  const { details } = result as { details: Record<string, unknown> };
  assert.equal(details.finish_reason, "length");
  assert.match(asTextResult(result), PREFIX_STOP_NOTE_PATTERN);
});

test("ds_web_search posts to /responses with a web_search tool", async (t) => {
  const { recording, transport } = createHarness();
  transport.route(
    "POST",
    "https://api.deepseek.com/responses",
    () => responsesWebSearchCompleted
  );
  transport.install();
  t.after(() => transport.uninstall());

  const result = await executeTool(recording, "ds_web_search", {
    query: "deepseek v4 flash",
  });

  assert.equal(transport.requests.length, 1);
  const [request] = transport.requests;
  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.deepseek.com/responses");
  assert.equal(request.headers.get("authorization"), `Bearer ${E2E_API_KEY}`);

  const body = request.body as {
    tool_choice: { type: string };
    tools: Array<{ type: string }>;
  };
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.deepEqual(body.tool_choice, { type: "web_search" });

  assert.equal(
    asTextResult(result),
    "According to the search results, the sky is blue."
  );
});

test("ds_call_function posts a strict tool and returns schema-valid arguments", async (t) => {
  const { recording, transport } = createHarness();
  transport.route(
    "POST",
    "https://api.deepseek.com/beta/chat/completions",
    () => functionCallCompletion('{"key":"abc","limit":3}')
  );
  transport.install();
  t.after(() => transport.uninstall());

  const result = await executeTool(recording, "ds_call_function", {
    context: "Find the entry for abc",
    name: "lookup",
    parameters: {
      properties: {
        key: { type: "string" },
        limit: { minimum: 1, type: "integer" },
      },
      required: ["key", "limit"],
      type: "object",
    },
  });

  assert.equal(transport.requests.length, 1);
  const [request] = transport.requests;
  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.deepseek.com/beta/chat/completions");
  assert.equal(request.headers.get("authorization"), `Bearer ${E2E_API_KEY}`);

  const body = request.body as {
    model: string;
    thinking: { type: string };
    tool_choice: { function: { name: string }; type: string };
    tools: Array<{
      function: { name: string; strict: boolean };
      type: string;
    }>;
  };
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.tool_choice, {
    function: { name: "lookup" },
    type: "function",
  });
  assert.equal(body.tools.length, 1);
  const [tool] = body.tools;
  assert.ok(tool);
  assert.equal(tool.type, "function");
  assert.equal(tool.function.name, "lookup");
  assert.equal(tool.function.strict, true);

  const { details } = result as {
    details: { arguments: unknown; name: string };
  };
  assert.equal(details.name, "lookup");
  assert.deepEqual(details.arguments, { key: "abc", limit: 3 });
});

// ---------------------------------------------------------------------------
// Request contract: balance
// ---------------------------------------------------------------------------

test("balance.get issues a bearer-authed GET to /user/balance", async (t) => {
  const { balance, transport } = createHarness();
  transport.route(
    "GET",
    "https://api.deepseek.com/user/balance",
    () => balanceResponse
  );
  transport.install();
  t.after(() => transport.uninstall());

  const state = await balance.get();

  assert.equal(transport.requests.length, 1);
  const [request] = transport.requests;
  assert.ok(request);
  assert.equal(request.method, "GET");
  assert.equal(request.url, "https://api.deepseek.com/user/balance");
  assert.equal(request.headers.get("authorization"), `Bearer ${E2E_API_KEY}`);
  assert.equal(state.isAvailable, true);
  assert.deepEqual(state.entries, [
    {
      currency: "USD",
      grantedBalance: 1,
      toppedUpBalance: 24.62,
      totalBalance: 25.62,
    },
  ]);
});
