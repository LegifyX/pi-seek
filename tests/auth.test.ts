import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { __test } from "../src/index.ts";

const API_KEY_ENV = "DEEPSEEK_API_KEY";
const AGENT_DIR = "/fake/agent";
const NOT_FOUND_MESSAGE = `DeepSeek API key not found: set ${API_KEY_ENV}, or sign in with pi so ${join(AGENT_DIR, "auth.json")} holds an API key for the "deepseek-responses" or "deepseek" provider.`;

type ReadFile = (path: string) => Promise<string>;

const createAuth = (
  readFile: ReadFile
): ReturnType<typeof __test.createAuthService> =>
  __test.createAuthService({ agentDir: AGENT_DIR, readFile });

const authJson = (providers: Record<string, unknown>): string =>
  JSON.stringify(providers);

const apiKeyEntry = (key: string): unknown => ({ key, type: "api_key" });

const withEnvCleared = (t: { after: (fn: () => void) => void }): void => {
  delete process.env[API_KEY_ENV];
  t.after(() => {
    delete process.env[API_KEY_ENV];
  });
};

test("env var wins over auth.json, and auth.json is never read", async (t) => {
  process.env[API_KEY_ENV] = "env-key";
  t.after(() => {
    delete process.env[API_KEY_ENV];
  });
  const auth = createAuth(() => {
    throw new Error("auth.json should not be read");
  });
  assert.equal(await auth.resolveApiKey(), "env-key");
});

test("auth.json key for the deepseek-responses provider is used", async (t) => {
  withEnvCleared(t);
  const auth = createAuth(() =>
    Promise.resolve(
      authJson({ "deepseek-responses": apiKeyEntry("sk-response") })
    )
  );
  assert.equal(await auth.resolveApiKey(), "sk-response");
});

// The common install: the account is logged in as pi's built-in deepseek
// provider, so pi-seek must accept that id instead of demanding its own.
test("auth.json key for pi's built-in deepseek provider is used", async (t) => {
  withEnvCleared(t);
  const auth = createAuth(() =>
    Promise.resolve(authJson({ deepseek: apiKeyEntry("sk-builtin") }))
  );
  assert.equal(await auth.resolveApiKey(), "sk-builtin");
});

test("deepseek-responses wins when auth.json holds both providers", async (t) => {
  withEnvCleared(t);
  const auth = createAuth(() =>
    Promise.resolve(
      authJson({
        deepseek: apiKeyEntry("sk-builtin"),
        "deepseek-responses": apiKeyEntry("sk-response"),
      })
    )
  );
  assert.equal(await auth.resolveApiKey(), "sk-response");
});

test("blank keys are skipped and the value is trimmed", async (t) => {
  withEnvCleared(t);
  const auth = createAuth(() =>
    Promise.resolve(
      authJson({
        deepseek: apiKeyEntry("  sk-builtin  "),
        "deepseek-responses": apiKeyEntry("   "),
      })
    )
  );
  assert.equal(await auth.resolveApiKey(), "sk-builtin");
});

test("a provider entry without a key (oauth) falls through to the not-found error", async (t) => {
  withEnvCleared(t);
  const auth = createAuth(() =>
    Promise.resolve(authJson({ radius: { type: "oauth" } }))
  );
  await assert.rejects(auth.resolveApiKey(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, NOT_FOUND_MESSAGE);
    return true;
  });
});

test("malformed auth.json falls through to the not-found error", async (t) => {
  withEnvCleared(t);
  const auth = createAuth(() => Promise.resolve("{not json"));
  await assert.rejects(auth.resolveApiKey(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, NOT_FOUND_MESSAGE);
    return true;
  });
});

test("missing auth.json falls through to the not-found error", async (t) => {
  withEnvCleared(t);
  const auth = createAuth(() => {
    throw new Error("ENOENT: no such file");
  });
  await assert.rejects(auth.resolveApiKey(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, NOT_FOUND_MESSAGE);
    return true;
  });
});

test("resolveApiKey caches the resolved key and reads auth.json once", async (t) => {
  withEnvCleared(t);
  let reads = 0;
  const auth = createAuth(() => {
    reads += 1;
    return Promise.resolve(authJson({ deepseek: apiKeyEntry("cached-key") }));
  });
  assert.equal(await auth.resolveApiKey(), "cached-key");
  assert.equal(await auth.resolveApiKey(), "cached-key");
  assert.equal(reads, 1);
});
