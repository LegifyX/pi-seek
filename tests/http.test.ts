import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../src/index.ts";

const originalFetch = globalThis.fetch;
const STATUS_PREFIX = /DeepSeek API/;
const STATUS_CODE = /503/;

const createClient = (
  resolveApiKey: () => Promise<string> = async () => "k"
): ReturnType<typeof __test.createHttpClient> =>
  __test.createHttpClient({ resolveApiKey });

test("non-ok response surfaces the status and a truncated body snippet", async (t) => {
  globalThis.fetch = () =>
    Promise.resolve(new Response("x".repeat(1000), { status: 503 }));
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(
    createClient().postJson("/responses", {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, STATUS_PREFIX);
      assert.match(error.message, STATUS_CODE);
      assert.ok(error.message.length <= 420);
      return true;
    }
  );
});

test("postJson maps a non-JSON 200 body to an invalid JSON error", async (t) => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response("<!doctype html><html><body>gateway</body></html>", {
        status: 200,
      })
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(
    createClient().postJson("/responses", {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "DeepSeek API returned an invalid JSON response"
      );
      return true;
    }
  );
});

test("getJson maps a non-JSON 200 body to an invalid JSON error", async (t) => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response("<!doctype html><html><body>gateway</body></html>", {
        status: 200,
      })
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(
    createClient().getJson("/user/balance"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "DeepSeek API returned an invalid JSON response"
      );
      return true;
    }
  );
});

test("ok response returns the parsed JSON body", async (t) => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "r1", ok: true }), { status: 200 })
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const result = await createClient().postJson("/responses", {});
  assert.deepEqual(result, { id: "r1", ok: true });
});

test("an aborted caller signal maps to Aborted by user", async (t) => {
  globalThis.fetch = () => Promise.reject(new Error("fetch aborted"));
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createClient().postJson("/responses", {}, controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Aborted by user");
      return true;
    }
  );
});

test("a network failure propagates the original error, not a timeout wrapper", async (t) => {
  const networkError = new Error("network down");
  globalThis.fetch = () => Promise.reject(networkError);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(
    createClient().postJson("/responses", {}),
    (error: unknown) => {
      assert.equal(error, networkError);
      assert.ok(error instanceof Error);
      assert.equal(error.message, "network down");
      return true;
    }
  );
});
