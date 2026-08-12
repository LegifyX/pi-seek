import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FLASH_MODEL_ID,
  isSupportedModelId,
  MODEL_COSTS,
  PRO_MODEL_ID,
  resolveModelId,
} from "../src/config.ts";

const UNKNOWN_MODEL_ERROR =
  /DEEPSEEK_MODEL must be one of deepseek-v4-flash, deepseek-v4-pro; got "deepseek-v3"/;

test("resolveModelId defaults to V4 Flash for empty input", () => {
  assert.equal(resolveModelId(undefined), FLASH_MODEL_ID);
  assert.equal(resolveModelId(""), FLASH_MODEL_ID);
  assert.equal(resolveModelId("   "), FLASH_MODEL_ID);
});

test("resolveModelId accepts deepseek-v4-pro", () => {
  assert.equal(resolveModelId("deepseek-v4-pro"), PRO_MODEL_ID);
});

test("resolveModelId rejects unknown models with a descriptive error", () => {
  assert.throws(() => resolveModelId("deepseek-v3"), UNKNOWN_MODEL_ERROR);
});

test("isSupportedModelId guards the supported set", () => {
  assert.equal(isSupportedModelId("deepseek-v4-flash"), true);
  assert.equal(isSupportedModelId("deepseek-v4-pro"), true);
  assert.equal(isSupportedModelId("deepseek-v4"), false);
  assert.equal(isSupportedModelId(42), false);
});

test("V4 Pro prices match the Models & Pricing page", () => {
  assert.deepEqual(MODEL_COSTS[PRO_MODEL_ID], {
    cacheRead: 0.003_625,
    cacheWrite: 0,
    input: 0.435,
    output: 0.87,
  });
});
