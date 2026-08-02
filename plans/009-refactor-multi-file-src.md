# Plan 009: Split the deepseek-v4.ts monolith into a multi-file `src/` package

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2733f78..HEAD -- deepseek-v4.ts tests src package.json README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-008 (all DONE; the verification baseline they built is this plan's safety net)
- **Category**: tech-debt | migration
- **Planned at**: commit `2733f78`, 2026-08-02

## Why this matters

`deepseek-v4.ts` is a 2523-line monolith — the only pi extension in
`~/Development/pi/` structured this way. Its three siblings
(`pi-ast-grep`, `pi-codemode`, `pi-chimera`) are all multi-file packages with
a `src/` (or package-named) directory, an `index.ts` entry exporting one
default factory, sibling modules exporting named functions, and a
`"pi": { "extensions": ["./src/index.ts"] }` manifest in `package.json`.
pi's own docs make multi-file extensions first-class:
`docs/extensions.md` "Extension Styles" documents "Directory with index.ts",
auto-discovery covers `~/.pi/agent/extensions/*/index.ts` and
`extensions/*/package.json`, `settings.json` accepts
`"extensions": ["/path/to/local/extension/dir"]`, and the loader
(`dist/core/package-manager.js:1040-1059, 1747-1884`) resolves a directory
source by reading its `package.json` `pi.extensions` array (glob patterns and
`!exclusions` supported; the same manifest drives npm/git package installs).
Explicit `-e` paths are loaded through the same resolution even under
`pi -ne` (`dist/core/resource-loader.js:315-317`), and the entry loads via
jiti with no bundling — sibling local `.ts` imports work as-is
(`dist/core/extensions/loader.js:335-352`). The file header's "Keep this
extension in one source file" claim (deepseek-v4.ts:1-7) is obsolete.

Concrete costs of the monolith: every change to any concern (auth, telemetry,
threads, schema conversion, commands) requires scanning 2500 lines; the
`__test` object exists solely because internal modules can't be imported
directly; review diffs are large; the file's documented `deepseek-v4.ts:N`
line references drift on every change (they had to be re-anchored in round 2).

What improves when this lands: modules importable by tests directly (sibling
convention), reviewable diffs, README install via `pi -e ./src/index.ts` or
the repo directory, and the same package shape as the sibling extensions.

## Current state

Facts verified at commit `2733f78`:

- `deepseek-v4.ts` — 2523 lines, one file. 14 banner-delimited sections
  (line ranges verified by `grep -n "^// ---"`):
  | Range | Section (banner text) | Target module |
  |-------|----------------------|---------------|
  | 1–18 | file header (imports + "keep in one source file" comment) | delete |
  | 20–253 | Configuration and shared types | `src/config.ts` |
  | 255–438 | Authentication and HTTP client | `src/http.ts` |
  | 440–633 | Responses API service (incl. all four `build*Body` builders) | `src/responses.ts` |
  | 635–671 | Beta API service | `src/beta.ts` |
  | 673–825 | Telemetry store | `src/telemetry.ts` |
  | 827–898 | Balance store + usage ledger helpers | `src/balance.ts` |
  | 900–1034 | Thread store | `src/threads.ts` |
  | 1036–1269 | Strict JSON-Schema converter | `src/strict-schema.ts` |
  | 1271–1371 | Tool parameter schemas | `src/params.ts` |
  | 1373–1790 | Tool registrations | `src/tools.ts` |
  | 1792–1917 | Provider and lifecycle registration | `src/lifecycle.ts` |
  | 1919–2298 | Command registration seam | `src/commands.ts` |
  | 2300–2473 | Entry renderers | `src/renderers.ts` |
  | 2475–2523 | Thin default composition | `src/index.ts` (rewritten) |
- Current public surface (deepseek-v4.ts:2477-2523): `export { resolveTimeoutMs, toStrictSchema }`; `export const __test = { applyDefaultReasoningEffort, buildChatBody, buildFimBody, buildPrefixBody, buildWebSearchBody, collectUsageRecords, createAuthService, createBalanceStore, createHttpClient, createTelemetryStore, createThreadStore, extractRequiredFunctionCall, extractResponsesText, interpolateEnv, isPersistableItem, parseBalance, stripUnsupportedThinkingParameters, summarizeUsage }`; `export default (pi: ExtensionAPI): void => { ... }` composing `createRuntimeState()` → `createAuthService()` → `createHttpClient(auth)` → `createResponsesApi(http)` → `createBetaApi(http)` → `createTelemetryStore(runtimeState)` → `createThreadStore()` → `createBalanceStore(http)` → `ToolServices` → `registerProvider` / `registerLifecycleHandlers` / `registerTools` / `registerCommands` / `registerRenderers`.
- Tests: 15 files in `tests/`; every one imports from `../deepseek-v4.ts`:
  12 files `import { __test } from "../deepseek-v4.ts";` (auth, balance, body-builders, function-call, http, payload, responses, telemetry, threads-filter, threads-restore, threads, usage-ledger), `tests/smoke.test.ts` `import extension from "../deepseek-v4.ts";`, `tests/timeout.test.ts` `import { resolveTimeoutMs }`, `tests/to-strict-schema.test.ts` `import { toStrictSchema }`.
- `tsconfig.json`: `include: ["deepseek-v4.ts", "tests"]`, module NodeNext, `allowImportingTsExtensions: true`, strict, noEmit.
- `package.json`: no `"type"` field, no `"pi"` field; scripts `check`, `fix`, `test` (`node --test "tests/**/*.test.ts"`), `test:watch`, `typecheck`, `verify` (`ultracite check && tsc --noEmit && node --test "tests/**/*.test.ts"`).
- Gates are green at the planned commit: `npm run verify` → typecheck clean, ultracite clean, 118/118 tests.
- README: installation section (lines ~14-28) instructs copying `deepseek-v4.ts` into auto-discovered locations or `pi -e /path/to/deepseek-v4.ts`; "Standalone" section (~73-90) documents `pi -ne -e deepseek-v4.ts`; Troubleshooting (~100-135) contains six `deepseek-v4.ts:N` line references.
- `plans/README.md` "Findings considered and rejected" lists "Single-file layout: deliberate, documented in the file header. Plans keep it." — this plan supersedes that decision; the index must be updated (Step 8).
- Node version in use: v26.5.1 (native TS type stripping; no flags needed).
- `pi --list-models [search]` is the offline runtime gate: loads extensions, lists registered models.

Repo conventions to match (from siblings `pi-ast-grep/src`, `pi-codemode/src`, `pi-chimera/pi-chimera`):
- Entry `src/index.ts` exports ONE default factory named after the package: `export default function piSeek(pi: ExtensionAPI): void`.
- Sibling modules export named functions/consts/types only — no default exports.
- Relative imports ALWAYS carry the `.ts` extension: `import { X } from "./config.ts"`.
- Type-only imports use inline `import { type X }` style (existing style in deepseek-v4.ts).
- No bundling, no build step; tests import `.ts` sources directly.
- `package.json` gets `"type": "module"` and `"pi": { "extensions": ["./src/index.ts"] }` (see pi-ast-grep/package.json for the exact manifest shape).
- Errors/patterns inside moved code stay byte-identical — this plan MOVES code, it does not improve it.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0, no errors |
| Lint+format check | `npm run check` | exit 0 |
| Format | `npm exec -- ultracite fix` | exit 0 (auto-fixes import style) |
| Tests | `npm test` | 118 pass (0 fail) |
| Full gate | `npm run verify` | exit 0 |
| Runtime smoke (entry file) | `pi -ne -e ./src/index.ts --list-models deepseek-v4-flash` | exit 0, output contains `deepseek-v4-flash` |
| Runtime smoke (manifest dir) | `pi -ne -e . --list-models deepseek-v4-flash` | exit 0, output contains `deepseek-v4-flash` |
| JSON validity | `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"` | prints ok |

## Scope

**In scope** (the only files you may modify/create/delete):
- `deepseek-v4.ts` (delete after Step 4)
- `src/config.ts`, `src/http.ts`, `src/responses.ts`, `src/beta.ts`, `src/telemetry.ts`, `src/balance.ts`, `src/threads.ts`, `src/strict-schema.ts`, `src/params.ts`, `src/tools.ts`, `src/lifecycle.ts`, `src/commands.ts`, `src/renderers.ts`, `src/index.ts` (create)
- `tests/*.test.ts` (import-path updates only — 15 files, one line each)
- `tsconfig.json` (include array)
- `package.json` (`"type": "module"`, `"pi"` manifest — nothing else)
- `README.md` (install/standalone/troubleshooting references; final line-ref re-anchor)
- `plans/README.md` (status row + supersede note)

**Out of scope** (do NOT touch, even though they look related):
- `models.json`, `.github/`, `AGENTS.md`, `biome.jsonc`, `package-lock.json`
- Any behavior change, identifier rename, or refactoring of the moved logic — this plan is a pure file split. "While you're in there" improvements are out of scope; note them in your report instead.
- Renaming the extension's tool/command/provider IDs.

## Git workflow

- Branch: work on `main` (repo convention — all prior plans committed directly to main).
- Commit once at the end of Step 9 (or per step if you prefer); message style matches `git log`: `Plan 009: split deepseek-v4.ts into a multi-file src/ package`.
- Do NOT push.

## Steps

### Step 1: Create the 13 module files by moving sections verbatim

1. `mkdir src`.
2. For each section row in the table above (rows 2-13 of the table: config through renderers), cut the code block between its banner comments (inclusive of the banner) from `deepseek-v4.ts` and paste it verbatim into the target file. Move code EXACTLY — do not rename identifiers, do not reorder statements, do not delete "unused" code (ultracite may flag unused vars; if a moved symbol is flagged as unused, it is still used by another module — see Step 2; the final gate resolves this).
3. Delete the file header comment (lines 1-18) — it is obsolete ("Keep this extension in one source file"). `node:fs/promises` and `node:path` imports belong to `src/http.ts`; `@earendil-works/pi-tui` (`Box`, `Text`) to `src/renderers.ts`; `typebox` (`Type`) to `src/params.ts`; `@earendil-works/pi-coding-agent` imports go to whichever modules use them (types `ExtensionAPI`/`ExtensionContext`/`SessionEntry`/`TurnEndEvent` and `getAgentDir` — see Step 2).
4. Add per-module import headers per the dependency rule:

   **Dependency rule (DAG — no cycles allowed)**: each module may import ONLY from `./config.ts` and modules listed EARLIER in the section table (config < http < responses < beta < telemetry < balance < threads < strict-schema < params < tools < lifecycle < commands < renderers). The expected edges:
   - `config.ts` — no internal imports (pure constants/types/helpers).
   - `http.ts` — `node:fs/promises` (`readFile`), `node:path` (`join`), `@earendil-works/pi-coding-agent` (`getAgentDir`), `./config.ts`.
   - `responses.ts` — `./config.ts`, `./http.ts` (type `HttpClient`).
   - `beta.ts` — `./config.ts`, `./http.ts` (type `HttpClient`).
   - `telemetry.ts` — `./config.ts`, `@earendil-works/pi-coding-agent` (type `ExtensionContext`).
   - `balance.ts` — `./config.ts`, `./http.ts` (type `HttpClient`).
   - `threads.ts` — `./config.ts`, `@earendil-works/pi-coding-agent` (type `SessionEntry`).
   - `strict-schema.ts` — `./config.ts`.
   - `params.ts` — `./config.ts`, `typebox`.
   - `tools.ts` — `./config.ts`, `./responses.ts`, `./beta.ts`, `./telemetry.ts`, `./threads.ts`, `./balance.ts`, `./strict-schema.ts` (`toStrictSchema`), `./params.ts`, `@earendil-works/pi-coding-agent`.
   - `lifecycle.ts` — `./config.ts`, `./telemetry.ts`, `./threads.ts`, `@earendil-works/pi-coding-agent`.
   - `commands.ts` — `./config.ts`, `./responses.ts`, `./telemetry.ts`, `./threads.ts`, `./balance.ts`, `@earendil-works/pi-coding-agent`.
   - `renderers.ts` — `./config.ts`, `@earendil-works/pi-tui` (`Box`, `Text`), `@earendil-works/pi-coding-agent` (type `ExtensionAPI` for the theme parameter type).
   - `index.ts` (Step 2) — `./config.ts` (`createRuntimeState`, `resolveTimeoutMs`, `toStrictSchema` — no, see Step 2 for exact re-exports), `./http.ts`, `./responses.ts`, `./beta.ts`, `./telemetry.ts`, `./threads.ts`, `./balance.ts`, `./strict-schema.ts`, `./params.ts`? (no — params is imported by tools only), `./tools.ts` (type `ToolServices`), `./lifecycle.ts`, `./commands.ts`, `./renderers.ts`, `@earendil-works/pi-coding-agent` (type `ExtensionAPI`).
   Use `import { type X }` inline style for types (matches current code; ultracite fix will normalize).
5. `deepseek-v4.ts` will now be missing its moved sections — do NOT delete it yet; leave it as-is (broken is fine until Step 4) or, if you prefer, do Steps 1-4 atomically with a scripted cut: the file must not be re-verified until Step 5.

**Verify**: `node --test tests/timeout.test.ts tests/to-strict-schema.test.ts` still passes (they import the old entry, which is still present) — if you left `deepseek-v4.ts` intact. If you already deleted sections from it, skip this check and proceed to Step 2.

### Step 2: Rewrite `src/index.ts` as the composition root

Replace the moved "Thin default composition" content with an entry module shaped like this (exact structure below; import lists must resolve per the dependency rule):

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAuthService } from "./http.ts";
import { createBetaApi } from "./beta.ts";
import { createBalanceStore } from "./balance.ts";
import { createResponsesApi } from "./responses.ts";
import { createRuntimeState } from "./config.ts";
// ... all other imports needed by the exports below
```

Note: `ToolServices` is defined in `src/tools.ts` (section "Tool registrations"
defines `interface ToolServices`), so import it from `./tools.ts`.
`createRuntimeState` and `DeepSeekRuntimeState` live in `src/config.ts`.

The new `src/index.ts` must contain EXACTLY:
1. `export { resolveTimeoutMs, toStrictSchema };` — re-exported from `./config.ts` and `./strict-schema.ts` respectively (`toStrictSchema` is defined in `src/strict-schema.ts`; `resolveTimeoutMs` in `src/config.ts`).
2. `export const __test = { ... };` — with the EXACT same 18 keys as today (list in "Current state"), each imported from its defining module:
   - `applyDefaultReasoningEffort`, `stripUnsupportedThinkingParameters` → `./lifecycle.ts`
   - `buildChatBody`, `buildWebSearchBody`, `extractResponsesText` → `./responses.ts`
   - `buildFimBody`, `buildPrefixBody` → `./responses.ts` (they physically live in the Responses section — import them from there)
   - `collectUsageRecords`, `summarizeUsage` → `./balance.ts`
   - `createAuthService`, `interpolateEnv` → `./http.ts`
   - `createBalanceStore` → `./balance.ts`
   - `createHttpClient` → `./http.ts`
   - `createTelemetryStore` → `./telemetry.ts`
   - `createThreadStore` → `./threads.ts`
   - `extractRequiredFunctionCall`, `isPersistableItem` → `./tools.ts`
   - `parseBalance` → `./config.ts`
3. The default export, named: `export default function piSeek(pi: ExtensionAPI): void { ... }` with the EXACT body of the current default export (composition of the six factories into `ToolServices` and the five registration calls).

**Verify**: `npm run typecheck` — expect errors ONLY for symbols still referenced by the old `deepseek-v4.ts` body (which is now missing its sections). If `src/*.ts` itself has errors, fix import lists (add the missing symbol's module per the dependency rule) and re-run until `src/` is clean.

### Step 3: Update tsconfig include

In `tsconfig.json`, change `"include": ["deepseek-v4.ts", "tests"]` to `"include": ["src", "tests"]`.

**Verify**: `npm run typecheck` → the only errors reported (if any) are in `deepseek-v4.ts` itself (the mutilated file). If errors are reported in `src/` or `tests/`, fix them (Step 2 note) before continuing.

### Step 4: Update the 15 test import lines, then delete the monolith

1. In every `tests/*.test.ts` file, replace the import path `"../deepseek-v4.ts"` with `"../src/index.ts"` (15 files, one line each — listed in "Current state"). Nothing else in the test files changes.
2. `git rm deepseek-v4.ts` (or `rm` + `git add -A`).
3. `grep -rn "deepseek-v4.ts" tests/ src/` → must return NO matches.

**Verify**: `npm run typecheck` → exit 0, no errors. `npm test` → 118 pass, 0 fail.

### Step 5: package.json — module type + pi manifest

Add to `package.json` (preserving existing fields, formatting with 2-space indent to match the file):
- `"type": "module"` (top-level, sibling convention; the repo has no `.js` files so this is safe)
- `"pi": { "extensions": ["./src/index.ts"] }` (top-level, matching pi-ast-grep/package.json's manifest shape)

**Verify**: JSON validity command → prints ok; `npm test` → 118 pass; `npm run typecheck` → exit 0.

### Step 6: README updates

1. Installation section (~lines 14-28): replace the copy-`deepseek-v4.ts` instructions with the directory form: copy the whole project directory (or just `src/`) into `~/.pi/agent/extensions/` (auto-discovery of `extensions/*/index.ts`), or run `pi -e /path/to/pi-seek/src/index.ts`, or `pi -e /path/to/pi-seek` (directory with the `pi` manifest). Keep the requirement text (pi ≥ 0.83.0, Node ≥ 22) unchanged.
2. Standalone section (~73-90): `pi -ne -e deepseek-v4.ts` → `pi -ne -e ./src/index.ts` (and mention the equivalent `pi -ne -e .` from the repo root via the manifest).
3. Troubleshooting (~100-135): the six `deepseek-v4.ts:N` references are now stale. Replace each `deepseek-v4.ts:N` with the symbol name plus a fresh line number from the NEW file layout — after Steps 1-4 are green, locate the current line numbers with `grep -n` for: the key-not-found message (in `src/http.ts`), `resolveTimeoutMs` const + `TIMEOUT_ENV` (in `src/config.ts`), `export { toStrictSchema }` / `export { resolveTimeoutMs, toStrictSchema }` (in `src/index.ts`), `target.additionalProperties = false` (in `src/strict-schema.ts`), `STRICT_STRING_FORMATS = new Set` (in `src/strict-schema.ts`). Use the format `src/http.ts:NNN` / `src/config.ts:NNN` etc. Verify each number by reading the line.
4. If README elsewhere says "one source file" or similar (grep for "one file" / "one source"), update to describe the multi-file layout.

**Verify**: `grep -rn "deepseek-v4.ts" README.md` → no matches; every `src/*.ts:NNN` reference in README points at the claimed content (spot-check each with `sed -n`).

### Step 7: plans/README.md index update

1. Add row `| 009 | Split the deepseek-v4.ts monolith into a multi-file src/ package | P1 | M | 001-008 | DONE |` to the status table.
2. Under "Findings considered and rejected", replace the line `- Single-file layout: deliberate, documented in the file header. Plans keep it.` with `- Single-file layout: originally deliberate (file header); SUPERSEDED by Plan 009 — pi's loader supports multi-file extensions (directory index.ts, pi.extensions manifest), and the sibling extensions are all multi-file.`
3. Add a dependency note: `009 needs 001-008` (the 118-test baseline is the parity safety net for the file split).

**Verify**: re-read the updated section; no stale text remains.

### Step 8: Full verification suite

Run, in order, and record outputs:
1. `npm run verify` → exit 0 (typecheck + ultracite + 118 tests).
2. `pi -ne -e ./src/index.ts --list-models deepseek-v4-flash` → exit 0, output contains `deepseek-v4-flash` (proves the new entry loads standalone).
3. `pi -ne -e . --list-models deepseek-v4-flash` → exit 0, output contains `deepseek-v4-flash` (proves the manifest-driven directory load, same path npm/git packages take).
4. `grep -rn "deepseek-v4.ts" README.md tests/ src/ package.json tsconfig.json` → no matches.
5. `git status` → only the in-scope files appear.

**Verify**: all five pass; record each output in your report.

### Step 9: Commit

Commit all changes with message `Plan 009: split deepseek-v4.ts into a multi-file src/ package`. Include the deleted file. Do not push.

## Test plan

- No new tests are required by this plan: the 118 existing tests ARE the parity test (they exercise every moved module through `__test`, `resolveTimeoutMs`, `toStrictSchema`, and the default export).
- The structural pattern for future tests changes after this plan: new tests may import modules directly (e.g. `import { createThreadStore } from "../src/threads.ts"`) instead of going through `__test` — this is the sibling convention and the main payoff of the refactor.
- Verification: `npm test` → 118 pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run verify` exits 0 (typecheck, ultracite check, 118/118 tests)
- [ ] `pi -ne -e ./src/index.ts --list-models deepseek-v4-flash` exits 0 and lists the model
- [ ] `pi -ne -e . --list-models deepseek-v4-flash` exits 0 and lists the model
- [ ] `deepseek-v4.ts` no longer exists; `grep -rn "deepseek-v4.ts" README.md tests/ src/ package.json tsconfig.json` returns nothing
- [ ] `src/` contains the 14 files from the table; `src/index.ts` exports the default factory, `resolveTimeoutMs`, `toStrictSchema`, and `__test` with all 18 keys
- [ ] No identifier was renamed and no behavior changed (spot-check: `git diff deepseek-v4.ts` is a pure move — every moved line appears unchanged in `src/`)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated and the single-file note superseded

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the section ranges in "Current state" doesn't match the excerpts (the file has drifted since this plan was written).
- A verification command fails twice after a reasonable fix attempt.
- You discover an import cycle between the new modules (config → X → config, etc.) — the dependency rule forbids it; if moving code verbatim creates one, report the offending symbols.
- The runtime smoke (`pi --list-models`) fails even though all static gates pass — report the exact output (could be an environment issue; do not debug pi itself).
- `npm test` drops below 118 passing tests or any existing test needed modification beyond its import line (if a test must change, STOP — the move should be transparent).

## Maintenance notes

For the owner after this lands:

- The README line references (`src/*.ts:NNN`) will drift again on future edits — consider converting them to symbol names only when next touching the Troubleshooting section.
- `buildFimBody`/`buildPrefixBody` physically live in `src/responses.ts` (they were part of the Responses section when the file was split). If you later touch the beta tools, moving them to `src/beta.ts` is a safe two-minute cleanup.
- The `__test` object on `src/index.ts` is now redundant with direct module imports — migrating individual test files to `import { X } from "../src/Y.ts"` and dropping keys is a low-risk follow-up; do it incrementally.
- `package.json` now declares `"pi": { "extensions": ["./src/index.ts"] }` — this makes the repo installable as a pi package (`pi install git:github.com/bjoernaagaard/pi-seek`) with no further changes, provided runtime deps stay resolvable from the pi install (the existing hard requirement; do not add runtime `dependencies` without revisiting it).
- The extension must remain loadable via `pi -ne -e ./src/index.ts` — the README operator-verification procedure is the regression test for that; run it after any future structural change.
