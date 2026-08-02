import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../deepseek-v4.ts";

const API_KEY_ENV = "DEEPSEEK_API_KEY";
const NOT_FOUND_MESSAGE =
  'DeepSeek API key not found: set DEEPSEEK_API_KEY (or configure an apiKey for the "deepseek-responses" provider in models.json).';

type ReadFile = (path: string) => Promise<string>;

// Builds the literal `${NAME}` placeholder string at runtime so no `${` token
// appears inside a regular string literal (which the linter flags).
const envPlaceholder = (name: string): string => `\${${name}}`;

const createAuth = (
  readFile: ReadFile
): ReturnType<typeof __test.createAuthService> =>
  __test.createAuthService({ agentDir: "/fake/agent", readFile });

const modelsJson = (apiKey: string): string =>
  JSON.stringify({
    providers: {
      "deepseek-responses": { apiKey },
    },
  });

test("env var wins over models.json and models.json is never read", async (t) => {
  process.env[API_KEY_ENV] = "env-key";
  t.after(() => {
    delete process.env[API_KEY_ENV];
  });
  const auth = createAuth(() => {
    throw new Error("models.json should not be read");
  });
  assert.equal(await auth.resolveApiKey(), "env-key");
});

test("models.json literal apiKey is used when the env var is unset", async (t) => {
  delete process.env[API_KEY_ENV];
  t.after(() => {
    delete process.env[API_KEY_ENV];
  });
  const auth = createAuth(() => Promise.resolve(modelsJson("literal-key")));
  assert.equal(await auth.resolveApiKey(), "literal-key");
});

test(`models.json ${envPlaceholder("DEEPSEEK_API_KEY")} placeholder interpolates from env`, async (t) => {
  process.env[API_KEY_ENV] = "placeholder-key";
  t.after(() => {
    delete process.env[API_KEY_ENV];
  });
  const auth = createAuth(() =>
    Promise.resolve(modelsJson(envPlaceholder("DEEPSEEK_API_KEY")))
  );
  assert.equal(await auth.resolveApiKey(), "placeholder-key");
});

test("models.json placeholder for a different env var resolves generically", async (t) => {
  delete process.env[API_KEY_ENV];
  process.env.MY_OTHER_KEY = "other-key";
  t.after(() => {
    delete process.env[API_KEY_ENV];
    delete process.env.MY_OTHER_KEY;
  });
  let reads = 0;
  const auth = createAuth(() => {
    reads += 1;
    return Promise.resolve(modelsJson(envPlaceholder("MY_OTHER_KEY")));
  });
  assert.equal(await auth.resolveApiKey(), "other-key");
  assert.equal(reads, 1);
});

test("placeholder naming an unset env var throws the not-found error", async (t) => {
  delete process.env[API_KEY_ENV];
  t.after(() => {
    delete process.env[API_KEY_ENV];
  });
  const auth = createAuth(() =>
    Promise.resolve(modelsJson(envPlaceholder("DEEPSEEK_API_KEY")))
  );
  await assert.rejects(auth.resolveApiKey(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, NOT_FOUND_MESSAGE);
    return true;
  });
});

test("resolveApiKey caches and does not re-read models.json", async (t) => {
  delete process.env[API_KEY_ENV];
  t.after(() => {
    delete process.env[API_KEY_ENV];
  });
  let reads = 0;
  const auth = createAuth(() => {
    reads += 1;
    return Promise.resolve(modelsJson("cached-key"));
  });
  assert.equal(await auth.resolveApiKey(), "cached-key");
  assert.equal(await auth.resolveApiKey(), "cached-key");
  assert.equal(reads, 1);
});

test("missing models.json falls through to the not-found error", async (t) => {
  delete process.env[API_KEY_ENV];
  t.after(() => {
    delete process.env[API_KEY_ENV];
  });
  const auth = createAuth(() => {
    throw new Error("ENOENT: no such file");
  });
  await assert.rejects(auth.resolveApiKey(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, NOT_FOUND_MESSAGE);
    return true;
  });
});

test("interpolateEnv passes through non-placeholder strings unchanged", () => {
  assert.equal(__test.interpolateEnv("sk-literal"), "sk-literal");
  assert.equal(__test.interpolateEnv("$VAR"), "$VAR");
  assert.equal(
    __test.interpolateEnv(`${envPlaceholder("VAR")}x`),
    `${envPlaceholder("VAR")}x`
  );
  assert.equal(
    __test.interpolateEnv(envPlaceholder("lowercase")),
    envPlaceholder("lowercase")
  );
  assert.equal(__test.interpolateEnv(""), "");
});

test(`interpolateEnv resolves ${envPlaceholder("VAR")} from process.env, trimming the value`, (t) => {
  process.env.MY_OTHER_KEY = "  spaced-key  ";
  t.after(() => {
    delete process.env.MY_OTHER_KEY;
  });
  assert.equal(
    __test.interpolateEnv(envPlaceholder("MY_OTHER_KEY")),
    "spaced-key"
  );
});

test(`interpolateEnv returns undefined for ${envPlaceholder("VAR")} with an unset env var`, (t) => {
  delete process.env.MY_OTHER_KEY;
  t.after(() => {
    delete process.env.MY_OTHER_KEY;
  });
  assert.equal(
    __test.interpolateEnv(envPlaceholder("MY_OTHER_KEY")),
    undefined
  );
});
