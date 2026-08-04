import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  API_KEY_ENV,
  BASE_URL,
  CONTEXT_WINDOW,
  COST,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  PROVIDER_ID,
  THINKING_LEVEL_MAP,
} from "../src/config.ts";
import { registerProvider } from "../src/lifecycle.ts";

interface RegisteredModel {
  compat: {
    requiresReasoningContentOnAssistantMessages: boolean;
    supportsDeveloperRole: boolean;
    supportsLongCacheRetention: boolean;
    supportsReasoningEffort: boolean;
    supportsStrictMode: boolean;
  };
  contextWindow: number;
  cost: typeof COST;
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

test("registerProvider records the DeepSeek V4 Flash registration contract", () => {
  const pi = createFakePi();
  registerProvider(pi as unknown as ExtensionAPI);
  assert.ok(pi.registered, "registerProvider must call pi.registerProvider");
  assert.equal(pi.registered.providerId, PROVIDER_ID);

  const { spec } = pi.registered;
  assert.equal(spec.api, "openai-responses");
  assert.equal(spec.apiKey, `$${API_KEY_ENV}`);
  assert.equal(spec.baseUrl, BASE_URL);
  assert.equal(spec.name, "DeepSeek V4 Flash (Responses API)");
  assert.equal(spec.models.length, 1);

  const [model] = spec.models;
  assert.equal(model.id, MODEL_ID);
  assert.equal(model.name, "DeepSeek V4 Flash");
  assert.equal(model.contextWindow, CONTEXT_WINDOW);
  assert.equal(model.maxTokens, MAX_OUTPUT_TOKENS);
  assert.deepEqual(model.cost, COST);
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, THINKING_LEVEL_MAP);
  assert.deepEqual(model.compat, {
    requiresReasoningContentOnAssistantMessages: true,
    supportsDeveloperRole: false,
    supportsLongCacheRetention: false,
    supportsReasoningEffort: true,
    supportsStrictMode: false,
  });
});
