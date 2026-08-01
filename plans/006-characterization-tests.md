# Plan 006: Characterization tests for telemetry, threads, parsing, payload transforms

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7d0d7a0..HEAD -- deepseek-v4.ts tests/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md, plans/002-strict-schema-ref-resolution.md
- **Category**: tests
- **Planned at**: commit `7d0d7a0`, 2026-08-01

## Why this matters

The extension's money math and state machinery are entirely untested: usage
→ cost conversion (the numbers users see in the footer and `/ds-cache` card),
the per-thread lock that serializes chat rounds, the response parser that
extracts text/thinking/tool calls, and the provider-payload transforms. Plan
002 already adds tests for `toStrictSchema` (the case that caught a real
bug). This plan characterizes the rest of the pure logic so future changes —
especially the refactors in plans 003/004 — have a regression net. These are
**characterization tests**: they pin current behavior; if a test's expectation
conflicts with clearly wrong behavior, flag it in your summary rather than
silently "fixing" it (see STOP conditions).

## Current state

Module-private functions and factory closures in `deepseek-v4.ts`:

- `createTelemetryStore(runtimeState)` (line ~478) returns an object exposing
  `mapChatUsage`, `mapResponsesUsage`, `record`, `getHistory`, `getLastUsage`,
  `setFooter`. Cost constants: `COST` (lines 40–45): input 0.14, output 0.28,
  cacheRead 0.0028, cacheWrite 0 per 1M tokens.
- `calculateCost` (lines ~455–470): per-million scaling; total = sum.
- `record()` (lines ~482–495): computes `hitRate = cacheRead / (cacheRead + input)`
  (0 when total is 0), stamps `ts`, caps history at `USAGE_HISTORY_LIMIT` (100).
- `mapResponsesUsage(rawUsage, source)` (lines 490–515): reads
  `input_tokens`, `input_tokens_details.cached_tokens` / `cache_write_tokens`,
  `output_tokens`, `output_tokens_details.reasoning_tokens`; `input` =
  `input_tokens - cacheRead - cacheWrite` (clamped ≥ 0).
- `mapChatUsage(rawUsage, source)` (lines 517–545): reads
  `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `prompt_tokens`,
  `completion_tokens`; `input` = miss tokens, falling back to
  `prompt_tokens - cacheRead` when miss is absent; `cacheWrite` always 0.
- `createThreadStore()` (line 586): `withLock` promise-chain serialization
  per thread name; `reset(name?)`; `getOrCreate`; `restore` (plan 004 owns
  restore tests in `tests/threads-restore.test.ts` — do not duplicate).
- `extractResponsesText(output)` (line 309): walks response `output` items —
  `message` → text parts, `reasoning` → thinking, `function_call` /
  `web_search_call` → calls array.
- `stripUnsupportedThinkingParameters(payload)` (line 1393): deletes
  `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` when
  thinking is on (effort ≠ "none").
- `applyDefaultReasoningEffort(payload, defaultEffort)` (line 1411): fills
  `reasoning.effort` when absent.
- `createHttpClient(auth)` (line ~221): `postJson` — the only network seam;
  uses global `fetch`.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Tests     | `npm test`                       | exit 0, all pass    |
| Typecheck | `npm run typecheck`              | exit 0, no errors   |
| Lint      | `npm exec -- ultracite check`    | exit 0              |

(Requires plans 001 + 002: runner, tsconfig, `typebox` devDep, and the test
conventions established there.)

## Scope

**In scope**:
- `deepseek-v4.ts` — one additive seam: `export const __test = { ... };`
  (module-private functions only; the factories already come back from their
  `create*` calls, so they need no seam)
- New test files (all under `tests/`):
  - `tests/telemetry.test.ts`
  - `tests/threads.test.ts` (locking; restore tests live in
    `tests/threads-restore.test.ts` from plan 004)
  - `tests/responses.test.ts` (extraction/parsing)
  - `tests/payload.test.ts` (provider payload transforms)
  - `tests/http.test.ts` (error mapping via stubbed `fetch`)

**Out of scope** (do NOT touch):
- `tests/to-strict-schema.test.ts` (plan 002) and `tests/threads-restore.test.ts`
  (plan 004) — owned by those plans
- The production code's behavior — characterization only
- `createAuthService` — reads real files/env; only the env branch is cheap
  to test, and it is low-risk — skip it

## Git workflow

- Branch: `advisor/006-characterization-tests`
- One commit per logical unit; message style like `Add characterization tests for telemetry and threads`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the `__test` seam

Near `export default` (line 1897), add:

```ts
export const __test = {
  applyDefaultReasoningEffort,
  extractResponsesText,
  stripUnsupportedThinkingParameters,
};
```

`createTelemetryStore`, `createThreadStore`, and `createHttpClient` need no
seam — tests call them directly. **Verify**: `npm run typecheck` → exit 0.

### Step 2: `tests/telemetry.test.ts`

Construct `createTelemetryStore(createRuntimeState())`-equivalent state
(you need a `DeepSeekRuntimeState` — build it inline:
`{ defaultEffort: "high", enabled: true }`). Cases:

1. `mapChatUsage` full cache hit: `{ prompt_cache_hit_tokens: 100,
   prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }` →
   `input: 0`, `cacheRead: 100`, `output: 50`, `cacheWrite: 0`,
   `totalTokens: 150`.
2. `mapChatUsage` with miss: `{ prompt_cache_hit_tokens: 30,
   prompt_cache_miss_tokens: 70, prompt_tokens: 100, completion_tokens: 50 }`
   → `input: 70`, `cacheRead: 30`.
3. `mapChatUsage` fallback: no `prompt_cache_miss_tokens` → `input =
   prompt_tokens - cacheRead`.
4. `mapResponsesUsage`: `{ input_tokens: 1000, input_tokens_details:
   { cached_tokens: 400, cache_write_tokens: 100 }, output_tokens: 200,
   output_tokens_details: { reasoning_tokens: 120 }, total_tokens: 1300 }`
   → `input: 500`, `cacheRead: 400`, `cacheWrite: 100`, `output: 200`,
   `reasoning: 120`, `totalTokens: 1300`.
5. Cost math via `record`: input 1_000_000 tokens → `cost.input` exactly
   `0.14`; output 1M → `0.28`; cacheRead 1M → `0.0028`; `cost.total` is the
   sum of the four components (cacheWrite is 0).
6. `hitRate`: record `{ cacheRead: 400, input: 100 }` → `hitRate: 0.8`;
   record with `cacheRead: 0, input: 0` → `hitRate: 0` (no NaN).
7. History cap: record 105 records → `getHistory().length === 100`, the
   oldest is dropped (compare the first kept record's `ts`).
8. `getLastUsage` returns the most recent record; `setFooter` with
   `context = undefined` is a no-op (no throw).

### Step 3: `tests/threads.test.ts` (locking)

1. **Serialization**: run two `withLock("t", ...)` actions that each append
   to a shared array with an `await` delay between push and pop; assert the
   final order is strictly sequential (no interleaving).
2. **No cross-thread blocking**: a slow action on thread "a" does not delay
   an action on thread "b" (assert completion within a short timeout).
3. **Exception propagation**: a throwing action rejects its caller and does
   not deadlock the next action on the same thread (the next `withLock`
   completes).
4. **reset(name)** removes only that thread; **reset()** clears all.
5. **withLock ordering after reset**: actions enqueued before a reset still
   complete, and the chain stays usable afterward.

### Step 4: `tests/responses.test.ts`

`extractResponsesText` cases:

1. Output with one `message` item containing `content: [{ type: "output_text", text: "hi" }]` → `text: "hi"`.
2. Mixed items: `reasoning` item with thinking parts, `message` item, a
   `function_call` item, a `web_search_call` item → `text`, `thinking`, and
   `calls` all populated in order.
3. Unknown item types and non-object items are ignored (no throw).
4. Non-array output (e.g. `undefined`) → empty result, no throw.

### Step 5: `tests/payload.test.ts`

1. `stripUnsupportedThinkingParameters({ reasoning: { effort: "high" },
   temperature: 0.7, top_p: 0.9, presence_penalty: 0, frequency_penalty: 0,
   model: "deepseek-v4-flash" })` → the four keys deleted, everything else kept.
2. Thinking off: `{ reasoning: { effort: "none" }, temperature: 0.7 }` →
   `temperature` kept.
3. No `reasoning` key at all → treated as thinking on → keys stripped.
4. `applyDefaultReasoningEffort({}, "low")` → `{ reasoning: { effort: "low" } }`.
5. Explicit effort preserved: `{ reasoning: { effort: "max" } }` with default
   "low" → effort stays "max".
6. `{ reasoning: { summary: "x" } }` (no effort) → `effort` added, other keys
   intact.

### Step 6: `tests/http.test.ts` (error mapping)

Stub the global fetch per test (Node 18+ has `Response`):

```ts
const originalFetch = globalThis.fetch;
test("...", async (t) => {
  globalThis.fetch = async () => new Response("bad", { status: 400 });
  t.after(() => { globalThis.fetch = originalFetch; });
  // createHttpClient needs an auth service: { resolveApiKey: async () => "k" }
  // postJson("/responses", {}) rejects with an Error whose message includes "400"
});
```

1. Non-ok response → error message contains the status code and the body
   snippet, truncated to 400 chars (body of 1000 chars → message length
   ≤ ~420).
2. Ok response → returns parsed JSON.
3. Aborted caller signal → error message `Aborted by user`.
4. Network failure (`fetch` throws a plain Error) → the original error
   propagates (not wrapped as timeout).

**Verify** (after each file): `npm test` → the file's tests pass.

### Step 7: Final gates

1. `npm run typecheck` → exit 0
2. `npm test` → exit 0 (all suites: smoke, strict-schema, timeout,
   threads-restore, and the five new files)
3. `npm exec -- ultracite check` → exit 0

## Test plan

- Five new files with the cases above; plus plan 002's and 004's files
  already in `tests/`. Every expectation is a concrete number/string —
  these pin current behavior so plans 003/004 refactors can't silently
  change cost math or locking semantics.
- No network access; `fetch` is stubbed in `tests/http.test.ts` only.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm test` exits 0; five new test files exist and pass (≥ 25 test cases total across them)
- [ ] `npm run typecheck` exits 0
- [ ] `npm exec -- ultracite check` exits 0
- [ ] `grep -n "export const __test" deepseek-v4.ts` → present
- [ ] No files outside `deepseek-v4.ts` and `tests/` are modified (`git status`)
- [ ] `plans/README.md` status row for 006 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The live code doesn't match the excerpts (drift).
- A characterization expectation conflicts with obviously wrong behavior
  (e.g. cost math that doesn't add up, `hitRate > 1`). Do NOT "fix" the
  production code to make the test pass — report the discrepancy; it becomes
  a new finding.
- `setFooter` or `createHttpClient` turn out to need pi runtime state that
  can't be faked — report rather than skipping the case.

## Maintenance notes

- These tests are the safety net for the plan-003 (timeout) and plan-004
  (restore) changes: run the full suite when landing either.
- If the COST constants change (pricing update), `tests/telemetry.test.ts`
  case 5 is the place to update — the test file should name the constant
  values explicitly so a pricing bump shows up as a failing test, not a
  silent drift.
- The `__test` seam is for module-private pure functions only; if it grows
  beyond four entries, split the file instead (maintainer decision — the
  single-file constraint applies to the extension surface, not the tests).
