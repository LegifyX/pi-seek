import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTimeoutMs } from "../deepseek-v4.ts";

const TIMEOUT_ENV = "DEEPSEEK_REQUEST_TIMEOUT_MS";

test("resolveTimeoutMs uses the base timeout without a body", () => {
  assert.equal(resolveTimeoutMs(undefined), 90_000);
});

test("resolveTimeoutMs scales by max_output_tokens", () => {
  assert.equal(resolveTimeoutMs({ max_output_tokens: 16 }), 90_016);
});

test("resolveTimeoutMs scales to the maximum output budget", () => {
  assert.equal(
    resolveTimeoutMs({ max_output_tokens: 393_216 }),
    90_000 + 393_216
  );
});

test("resolveTimeoutMs scales by max_tokens", () => {
  assert.equal(resolveTimeoutMs({ max_tokens: 4096 }), 94_096);
});

test("resolveTimeoutMs takes the larger of the two token caps", () => {
  assert.equal(
    resolveTimeoutMs({ max_output_tokens: 16, max_tokens: 4096 }),
    94_096
  );
});

test("resolveTimeoutMs honors a positive env override", (t) => {
  t.after(() => {
    delete process.env[TIMEOUT_ENV];
  });
  process.env[TIMEOUT_ENV] = "300";
  assert.equal(resolveTimeoutMs({ max_output_tokens: 393_216 }), 300_000);
});

test("resolveTimeoutMs falls back on invalid env values", (t) => {
  t.after(() => {
    delete process.env[TIMEOUT_ENV];
  });
  for (const invalid of ["abc", "0", "-5"]) {
    process.env[TIMEOUT_ENV] = invalid;
    assert.equal(resolveTimeoutMs({ max_output_tokens: 16 }), 90_016);
  }
});
