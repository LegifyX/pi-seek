import assert from "node:assert/strict";
import { test } from "node:test";

// config.ts reads MODEL_ENV at module load. node --test isolates each test
// file in its own process, so setting the variable before the first import in
// this file proves the environment wiring without affecting other files.
process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";

test("DEEPSEEK_MODEL selects V4 Pro as the tool-facing model", async () => {
  const config = await import("../src/config.ts");
  assert.equal(config.MODEL_ID, "deepseek-v4-pro");
});
