import assert from "node:assert/strict";
import { test } from "node:test";
import { THINKING_LEVEL_MAP } from "../src/config.ts";
import { __test } from "../src/index.ts";

const strip = __test.stripUnsupportedThinkingParameters;
const applyEffort = __test.applyDefaultReasoningEffort;

test("THINKING_LEVEL_MAP maps every pi level to a documented Responses effort", () => {
  // pi thinking levels (off/minimal/low/medium/high/xhigh/max) map to the
  // DeepSeek Responses effort values documented in docs/research/
  // deepseek-api-surface-2026-08-04.md; xhigh resolves to max per pi's own
  // V4 Flash catalog (CHANGELOG #3944) instead of being clamped to high.
  assert.deepEqual(THINKING_LEVEL_MAP, {
    high: "high",
    low: "low",
    max: "max",
    medium: "medium",
    minimal: "minimal",
    off: "none",
    xhigh: "max",
  });
});

test("stripUnsupportedThinkingParameters: thinking on removes the four sampling keys", () => {
  const payload = {
    frequency_penalty: 0,
    model: "deepseek-v4-flash",
    presence_penalty: 0,
    reasoning: { effort: "high" },
    temperature: 0.7,
    top_p: 0.9,
  };
  const result = strip(payload);
  assert.equal(result, payload);
  assert.deepEqual(result, {
    model: "deepseek-v4-flash",
    reasoning: { effort: "high" },
  });
});

test("stripUnsupportedThinkingParameters: thinking off keeps the sampling keys", () => {
  const payload = {
    reasoning: { effort: "none" },
    temperature: 0.7,
    top_p: 0.9,
  };
  assert.deepEqual(strip(payload), payload);
});

test("stripUnsupportedThinkingParameters: no reasoning key is treated as thinking on", () => {
  const payload = { model: "m", presence_penalty: 0.5, temperature: 0.7 };
  assert.deepEqual(strip(payload), { model: "m" });
});

test("applyDefaultReasoningEffort: empty payload gets the default effort", () => {
  const payload = {};
  const result = applyEffort(payload, "low");
  assert.equal(result, payload);
  assert.deepEqual(result, { reasoning: { effort: "low" } });
});

test("applyDefaultReasoningEffort: an explicit effort is preserved", () => {
  const payload = { reasoning: { effort: "max" } };
  assert.deepEqual(applyEffort(payload, "low"), {
    reasoning: { effort: "max" },
  });
});

test("applyDefaultReasoningEffort: effort is added without touching other keys", () => {
  const payload = { model: "m", reasoning: { summary: "x" } };
  assert.deepEqual(applyEffort(payload, "low"), {
    model: "m",
    reasoning: { effort: "low", summary: "x" },
  });
});
