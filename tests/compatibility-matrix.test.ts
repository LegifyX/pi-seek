import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPATIBILITY_MATRIX,
  getSurface,
  STATELESS_UNSUPPORTED,
  VERSION,
} from "../src/compatibility.ts";
import {
  BASE_URL,
  BETA_URL,
  CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
} from "../src/config.ts";

test("matrix version is pinned to the research report date", () => {
  assert.equal(VERSION, "2026-08-04");
});

test("responses row agrees with the registered provider constants", () => {
  const responses = getSurface("responses");
  assert.ok(responses);
  assert.equal(responses.method, "POST");
  assert.equal(responses.baseUrl, BASE_URL);
  assert.equal(responses.path, "/responses");
  assert.ok(responses.documentedModels.includes(MODEL_ID));
  assert.equal(responses.availability, "documented");
  assert.equal(responses.limits.contextWindow, CONTEXT_WINDOW);
  assert.equal(responses.limits.maxOutputTokens, MAX_OUTPUT_TOKENS);
  assert.equal(responses.liveProbe?.date, "2026-08-04");
  assert.equal(responses.liveProbe?.source, "live probe 2026-08-04");
});

test("chat row agrees with the config constants", () => {
  const chat = getSurface("chat");
  assert.ok(chat);
  assert.equal(chat.method, "POST");
  assert.equal(chat.baseUrl, BASE_URL);
  assert.equal(chat.path, "/chat/completions");
  assert.ok(chat.documentedModels.includes(MODEL_ID));
  assert.equal(chat.limits.contextWindow, CONTEXT_WINDOW);
});

test("prefix and FIM use the beta base; Flash availability is live-verified", () => {
  const prefix = getSurface("prefix");
  assert.ok(prefix);
  assert.equal(prefix.baseUrl, BETA_URL);
  assert.equal(prefix.path, "/chat/completions");
  assert.equal(prefix.availability, "documented");
  assert.ok(prefix.documentedModels.includes(MODEL_ID));
  assert.equal(prefix.liveProbe?.date, "2026-08-04");
  assert.equal(prefix.liveProbe?.source, "live probe 2026-08-04");

  const fim = getSurface("fim");
  assert.ok(fim);
  assert.equal(fim.baseUrl, BETA_URL);
  assert.equal(fim.path, "/completions");
  assert.equal(fim.availability, "documented");
  assert.equal(fim.limits.fimMaxTokens, 4096);
  assert.equal(fim.liveProbe?.date, "2026-08-04");
});

test("balance and models rows use the base URL and carry live schema facts", () => {
  const balance = getSurface("balance");
  assert.ok(balance);
  assert.equal(balance.baseUrl, BASE_URL);
  assert.equal(balance.path, "/user/balance");
  assert.equal(balance.liveProbe?.source, "live probe 2026-08-04");

  const models = getSurface("models");
  assert.ok(models);
  assert.equal(models.baseUrl, BASE_URL);
  assert.equal(models.path, "/models");
  assert.equal(models.liveProbe?.source, "live probe 2026-08-04");
});

test("no row claims support for previous_response_id/conversation/store", () => {
  for (const row of COMPATIBILITY_MATRIX) {
    for (const feature of STATELESS_UNSUPPORTED) {
      assert.ok(
        row.unsupportedFeatures.includes(feature),
        `${row.surface} must mark ${feature} unsupported`
      );
    }
  }
});

test("getSurface returns undefined for an unknown surface", () => {
  assert.equal(getSurface("does-not-exist"), undefined);
});
