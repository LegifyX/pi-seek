import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../src/index.ts";

test("extension module loads and exports a default factory", () => {
  assert.equal(typeof extension, "function");
});
