# Plan 003: Scale request timeout with `max_output_tokens`

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

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md
- **Category**: bug/perf
- **Planned at**: commit `7d0d7a0`, 2026-08-01

## Why this matters

Every DeepSeek call in the extension is non-streaming (`stream: false` at
lines 360, 384, 1093, 1149, 1268) and every call is cut off after a **hard
90-second timeout** (`REQUEST_TIMEOUT_MS = 90_000`, line 28, applied at line
230). But the extension advertises and accepts `max_output_tokens` up to
**393,216** (line 36). A long reasoning generation — or a queued request —
can easily exceed 90 seconds, so the tool dies with
`DeepSeek request timed out` on exactly the biggest requests, with no retry.
The timeout budget must scale with the requested output size, and be
overridable by the operator.

## Current state

- Line 28: `const REQUEST_TIMEOUT_MS = 90_000;`
- Line 36: `const MAX_OUTPUT_TOKENS = 393_216;`
- The HTTP client (`createHttpClient`, lines ~221–260):
  ```ts
  const postJson = async (
    path: string,
    body: unknown,
    signal?: AbortSignal,
    baseUrl = BASE_URL
  ): Promise<unknown> => {
    const key = await auth.resolveApiKey();
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    // ... fetch(`${baseUrl}${path}`, { body: JSON.stringify(body), ... })
  };
  ```
- The request bodies that carry an output-token budget:
  - `responses.chat` (line ~360): `body.max_output_tokens` set when
    `options.maxOutputTokens` is truthy
  - `responses.webSearch` (line ~384): same
  - `ds_prefix_complete` (line ~1093): `body.max_tokens`
  - `ds_fim` (line ~1149): `body.max_tokens` (4K cap)
  - `ds_call_function` (line ~1268): no token field

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Tests     | `npm test`                       | exit 0, all pass    |
| Typecheck | `npm run typecheck`              | exit 0, no errors   |
| Lint      | `npm exec -- ultracite check`    | exit 0              |

(Requires plan 001: `tsconfig.json`, `tests/` runner.)

## Scope

**In scope**:
- `deepseek-v4.ts` — timeout computation only (constants, one helper, one
  line in `postJson`, one export)
- `tests/timeout.test.ts` — create

**Out of scope** (do NOT touch, even though they look related):
- Streaming (`stream: true`) — that is a redesign; direction item D1
- Retry/backoff on timeout — no retry layer exists; a maintainer decision
- The 4K FIM cap, the 393K max, or any other token policy
- `README.md` — plan 007 documents the new env var

## Git workflow

- Branch: `advisor/003-timeout-scaling`
- One commit per logical unit; message style like `Scale request timeout by max_output_tokens`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the timeout helper

In `deepseek-v4.ts`, next to the existing constants (near line 28), add:

```ts
const TIMEOUT_MS_PER_TOKEN = 1; // 1ms per requested output token beyond the base
const TIMEOUT_ENV = "DEEPSEEK_REQUEST_TIMEOUT_MS"; // seconds; absolute override

const resolveTimeoutMs = (body: unknown): number => {
  const envValue = Number(process.env[TIMEOUT_ENV]);
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue * 1000;
  }
  const maxOutputTokens = isJsonObject(body)
    ? getNumber(body, "max_output_tokens")
    : undefined;
  const tokens = maxOutputTokens ?? 0;
  return tokens > 0
    ? REQUEST_TIMEOUT_MS + tokens * TIMEOUT_MS_PER_TOKEN
    : REQUEST_TIMEOUT_MS;
};
```

Notes: `isJsonObject` and `getNumber` already exist in the file (used in the
schema section). The formula yields ~8 minutes for a full 393,216-token
request (90s + 393s). `ds_prefix_complete`/`ds_fim` use `max_tokens`, not
`max_output_tokens` — see Step 2.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Wire it into `postJson` (and cover `max_tokens` bodies)

In `createHttpClient`'s `postJson`, replace:

```ts
const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
```

with:

```ts
const timeoutSignal = AbortSignal.timeout(resolveTimeoutMs(body));
```

Then make the beta endpoints' bodies carry their token budget under the same
key the helper reads. In `registerBetaTools`, for `ds_prefix_complete` and
`ds_fim`, change the body assignment from `body.max_tokens = params.max_tokens;`
to also set `body.max_output_tokens = params.max_tokens;` (the beta API
ignores unknown fields, and the helper reads `max_output_tokens`). Keep the
existing `max_tokens` field unchanged — it is what the beta API consumes.
`ds_call_function` has no token budget; it keeps the base timeout.

**Verify**: `npm run typecheck` → exit 0;
`grep -n "AbortSignal.timeout(" deepseek-v4.ts` → exactly one occurrence, on
the `resolveTimeoutMs(body)` line.

### Step 3: Write tests

Create `tests/timeout.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimeoutMs } from "../deepseek-v4.ts";
```

(Add `resolveTimeoutMs` to a named export — same pattern as plan 002's
`export { toStrictSchema };`.) Cases:

1. No body / no token field → `90_000`.
2. `{ max_output_tokens: 16 }` → `90_000 + 16`.
3. `{ max_output_tokens: 393_216 }` → `90_000 + 393_216`.
4. `{ max_tokens: 4096 }` (helper ignores it) → `90_000` — pins that only
   `max_output_tokens` counts (Step 2 makes callers set both).
5. `process.env.DEEPSEEK_REQUEST_TIMEOUT_MS = "300"` → `300_000`
   (absolute override); restore/delete the env var afterward (`t.after` or
   try/finally) so other tests are unaffected.
6. Invalid env (`"abc"`, `"0"`, `"-5"`) → falls back to the computed value.

**Verify**: `npm test` → exit 0, all six pass.

### Step 4: Final gates

1. `npm run typecheck` → exit 0
2. `npm test` → exit 0
3. `npm exec -- ultracite check` → exit 0

## Test plan

- `tests/timeout.test.ts` — the six cases above. Model on the existing
  `tests/smoke.test.ts` structure (node:test + assert/strict).
- No network calls in tests: `resolveTimeoutMs` is pure.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm test` exits 0; `tests/timeout.test.ts` exists with 6 passing tests
- [ ] `npm run typecheck` exits 0
- [ ] `npm exec -- ultracite check` exits 0
- [ ] `grep -n "AbortSignal.timeout(" deepseek-v4.ts` returns exactly the one
      `resolveTimeoutMs(body)` call site
- [ ] `grep -n "max_output_tokens = params.max_tokens" deepseek-v4.ts` →
      present in both beta tools
- [ ] No files outside `deepseek-v4.ts` and `tests/timeout.test.ts` are
      modified (`git status`)
- [ ] `plans/README.md` status row for 003 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The live code doesn't match the excerpts (drift).
- Setting `max_output_tokens` alongside `max_tokens` in the beta bodies turns
  out to break the beta API (this plan assumes unknown fields are ignored —
  the extension already sends `stop`, `suffix`, etc. conditionally; if a
  live smoke test shows a 4xx, report rather than removing the field).
- `process.env` mutation in tests leaks into other suites — fix ordering, and
  if you can't, report.

## Maintenance notes

- If streaming (direction D1) lands, this timeout logic still applies to the
  whole stream; revisit the per-token factor then.
- The env override (`DEEPSEEK_REQUEST_TIMEOUT_MS`, seconds) is the operator
  escape hatch; plan 007 documents it in the README.
- A reviewer should sanity-check the math for a typical 8K-token reasoning
  request: 90s + 8s ≈ 98s — no observable change for normal use.
