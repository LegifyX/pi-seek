# pi-seek implementation evidence — 2026-08-04

**Workflow:** Pi Fabric dynamic workflow (root + 6 agents on `deepseek-responses/deepseek-v4-flash`, maximum reasoning `max` for every worker).
**Artifact type:** implementation of the prioritized backlog in `docs/research/deepseek-api-surface-2026-08-04.md`; read-only research companion.

## Model verification
- Root: `agents.self()` → `model: "deepseek-responses/deepseek-v4-flash"`, session thinking `high`.
- Every worker spawn explicitly declared `model: "deepseek-responses/deepseek-v4-flash"`, `thinking: "max"`, `runner: "pi"`, `extensions: false` — no inheritance, no substitution. Model confirmed present in `tools.models()` before work began.

## Files changed (delta vs baseline `b7bc9c1`)

### Modified
- `src/config.ts` — `CONTEXT_WINDOW` single source of truth; `parseBalance`/`parseAmount` hardening (no NaN/Infinity; unavailable/malformed vs valid-zero distinction; negatives preserved; USD preference kept).
- `src/lifecycle.ts` — consumes `CONTEXT_WINDOW` instead of hardcoded literal; registration values otherwise unchanged.
- `src/responses.ts` — `ParsedResponsesResult` exposes `status`/`incompleteDetails`; `parseResponsesResult` exported; existing exports/signatures unchanged.
- `src/strict-schema.ts` — new pure `validateStrictArguments(schema, value): string[]` (strict-subset validator: object/required/additionalProperties, string pattern/format, number/integer bounds + multipleOf, boolean, array items, enum, anyOf, const, `$ref` against hoisted `$def`; never throws; circular-ref safe).
- `src/tools.ts` — `ds_call_function` validates parsed arguments against the normalized strict schema and rejects schema-invalid arguments with a typed user-visible error; `ds_prefix_complete`, `ds_fim`, `ds_web_search` wrapped in `withRetries(MAX_RETRIES)` with caller-abort → structured `Interrupted by the caller.` result (`phase: request|retry_wait`) and `details.retries`; `ds_chat`/`ds_call_function` retry behavior untouched.
- `src/telemetry.ts` — strict surface separation (Responses `input_tokens_details.cached_tokens` vs Chat/FIM `prompt_cache_hit_tokens`), Chat/FIM reasoning via `completion_tokens_details.reasoning_tokens`, finiteness guarantees in mappers/`record()`/`calculateCost`.
- `tests/balance.test.ts`, `tests/telemetry.test.ts` — extended coverage for the new contracts.

### New
- `src/compatibility.ts` — versioned (`2026-08-04`) model×surface×endpoint×streaming×tools×reasoning×limits matrix; prefix/FIM V4 Flash availability kept `"unresolved"`; stateless features (`previous_response_id`/`conversation`/`store`) marked unsupported.
- `tests/compatibility-matrix.test.ts`, `tests/lifecycle.test.ts`, `tests/parse-balance.test.ts` (seek-meta)
- `tests/accounting-hardening.test.ts` (seek-accounting)
- `tests/validate-arguments.test.ts`, `tests/retry-contract.test.ts` (seek-tools)
- `tests/fixtures/responses-events.ts`, `tests/responses-events.test.ts` (seek-responses-events)
- `tests/end-to-end.test.ts`, `tests/fixtures/end-to-end.fixture.ts` (seek-e2e)

## Checks and results (authoritative, final state)
| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | PASS, exit 0 |
| `npm exec -- ultracite check src tests` | PASS — 45 files checked, no errors |
| `node --test "tests/**/*.test.ts"` | **269 tests, 269 pass, 0 fail** |
| `npm run verify` | ultracite step fails ONLY on `.pi/fabric/mesh/state.json` — a live Fabric host runtime file (participant state, actively written by this workflow's own agent spawning; `.pi/` is user-owned untracked content). Typecheck and tests are green standalone. No repo file is flagged. |

Worker self-verification totals (point-in-time during parallel work): seek-meta 17/17 + full 191/191; seek-accounting 68/68; seek-tools 60/60 targeted + full 261/261; seek-responses-events 21/21; seek-e2e 8/8 + full 269/269.

## Independent verifier findings (read-only agent)
- Ownership disjointness: every changed/new file under `src/` and `tests/` maps to exactly one worker; no cross-worker file edits; no out-of-plan file touched.
- Preservation: `package.json` diff is only the user's pre-existing `skills` entry; `docs/`, `skills/`, `.pi/` still untracked; research report untouched (mtime predates all worker edits).
- No live API calls; no real credentials read; tests stub `globalThis.fetch`/inject fixtures (e2e deletes `DEEPSEEK_API_KEY`).
- No mutating git: HEAD still `b7bc9c1`; no commits/stash/checkout created.
- Evidence-only: matrix keeps prefix/FIM Flash `unresolved`; no `[DONE]`-requirement or stateless-feature claims; usage fields separated per surface; parseBalance finite; arguments validated; retry wrappers use the shared taxonomy with interruption semantics.
- Code-quality spot check: no blocking findings. Minor pre-existing observation (non-regression): `ds_call_function` does not convert caller abort into an interrupted result (unchanged from baseline).

## Remaining limitations / live-test approval still needed
- V4 Flash beta prefix/FIM availability remains **unresolved** (documented only for Pro in the FIM reference; pricing lists both) — intentionally not promoted to fact.
- Responses Pro support on `POST /responses`, exact numeric request limits, cache-write pricing, full field-level SSE schemas, official retry/idempotency guidance, and `GET /user/balance` schema details remain unresolved per the research report.
- No live/authenticated DeepSeek call was made. The report's approval-gated plan (GET /models, GET /user/balance, minimal POST /responses, beta prefix/FIM availability, strict function-call behavior, retry/429 behavior) still requires explicit user approval plus a non-production credential.

## Live verification (2026-08-04)

Follow-up live-verification swarm (`runs/live-2026-08-04`; evidence log in
`docs/research/live-verification-2026-08-04.md`) ran authenticated probes
against the production API on 2026-08-04. The compatibility matrix
(`src/compatibility.ts`) now carries dated `live probe 2026-08-04`
annotations for every verified finding.

**Resolved (live-verified):**
- Beta prefix and FIM surfaces accept both `deepseek-v4-flash` and
  `deepseek-v4-pro` (HTTP 200); V4 Flash availability is no longer
  `unresolved` on either surface.
- `GET /models` returns `deepseek-v4-flash` and `deepseek-v4-pro` with
  per-model fields `id`, `object`, `owned_by`.
- `GET /user/balance` schema: top-level `is_available` + `balance_infos`;
  entries carry `granted_balance`, `topped_up_balance`, `total_balance`;
  `is_available: false` observed.
- Responses streaming confirmed: monotonic `sequence_number`, no `[DONE]`,
  terminal event `response.incomplete`, observed event families recorded.
- Strict function-call + validator behavior confirmed live (valid accepted;
  invalid fixtures rejected with typed messages).
- `POST /responses` with `deepseek-v4-flash` returns `reasoning` +
  `message` output items and the documented usage paths
  (`input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`).

**Still unresolved / contradictions:**
- `deepseek-v4-pro` on `POST /responses` is rejected (HTTP 400; integration
  announced for early August 2026) — Pro support stays `unresolved` on the
  Responses surface.
- FIM boundary probe: `max_tokens: 4097` was **accepted** (HTTP 200),
  contradicting the documented 4K cap; the matrix keeps 4096 as documented and
  records the contradiction.

