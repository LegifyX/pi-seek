# Plan 007: README — install & standalone (`pi -ne`) documentation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7d0d7a0..HEAD -- README.md`
> If README.md changed since this plan was written, compare the "Current
> state" excerpts before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but see "Why this matters" for interplay with plans
  002, 003, 005)
- **Category**: dx/docs
- **Planned at**: commit `7d0d7a0`, 2026-08-01

## Why this matters

The README documents *what* the extension provides but never *how to install
and run it*. There is no setup section: no requirements, no wiring steps, no
verification. The maintainer's hard requirement is that **the extension must
work fully standalone with `pi -ne`** (no other extensions) — that guarantee
is currently asserted nowhere and verified by nobody. This plan documents
installation, the standalone guarantee, and a troubleshooting section, and
gives the operator a concrete `pi -ne` verification procedure.

## Current state

- `README.md` (2,834 bytes) has sections: title + tagline, "What it
  provides" (a table of the 8 pieces), "Reasoning passthrough (the 400
  rule)", "API key". **No Installation section, no requirements, no
  verification steps.**
- The extension file is `deepseek-v4.ts` (1918 lines) at the repo root; it
  registers tools (`ds_chat`, `ds_chat_reset`, `ds_prefix_complete`,
  `ds_fim`, `ds_web_search`, `ds_call_function`), commands (`/ds`,
  `/ds-cache`, `/deepseek`), a provider (`deepseek-responses` /
  `deepseek-v4-flash`), entry renderers, and lifecycle handlers.
- Runtime resolution: the extension imports `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, and `typebox`, which pi's extension loader
  resolves from the pi installation itself — **no npm install needed in this
  repo for the extension to run** (package.json has devDependencies only).
- The API key lives in `DEEPSEEK_API_KEY` env or
  `<agentDir>/models.json` → `providers["deepseek-responses"].apiKey`
  (deepseek-v4.ts lines ~90–135; `getAgentDir()` is pi's agent config dir).
  `models.json` in this repo is the copy users merge into their agent dir.
- pi's extension-loading mechanism is documented in the pi package itself:
  read `docs/extensions.md` under the pi install (locate it with
  `npm root -g`, then
  `<root>/@earendil-works/pi-coding-agent/docs/extensions.md`).

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Locate pi | `npm root -g`                    | path to global node_modules |
| Read mechanism | `read <pi>/docs/extensions.md` | describes how pi loads one-file extensions |
| Check     | `npm exec -- ultracite check`    | exit 0 (README is not linted by Biome by default, but the repo gate must stay green) |

## Scope

**In scope**:
- `README.md` — add three sections: "Installation", "Standalone (pi -ne)",
  "Troubleshooting" (and fold requirements/verification into them)

**Out of scope** (do NOT touch):
- `deepseek-v4.ts`, `models.json`, `package.json` — no code changes in this
  plan
- The existing README sections' content — preserve them; only add
- Writing a pi config file into the user's home directory

## Git workflow

- Branch: `advisor/007-readme-install-standalone`
- One commit; message style like `Document installation and standalone usage`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read pi's extension docs

Locate the pi install and read its extension documentation:
`docs/extensions.md` (and `docs/config.md` if referenced) under
`<npm root -g>/@earendil-works/pi-coding-agent/`. Establish, from the docs:

1. How pi discovers/loads a one-file extension (config key, path, or flag).
2. Whether `pi -ne` disables other extensions but keeps the configured
   extension loaded (the standalone guarantee depends on this).
3. Where the agent dir lives (`getAgentDir()`), so the README can say where
   `models.json` goes.

**Verify**: you can answer all three questions with doc citations.

### Step 2: Write the Installation section

Add to `README.md` (after the intro, before "What it provides"):

- **Requirements**: pi ≥ 0.83.0 (verified version; the `thinkingSignature`
  replay support), Node ≥ 22.
- **Install** (steps derived from Step 1's findings — quote the config key
  and path exactly as the docs state):
  1. Place `deepseek-v4.ts` where pi loads extensions (per the docs'
     mechanism).
  2. Set `DEEPSEEK_API_KEY` (recommended), **or** merge the
     `deepseek-responses` provider block from this repo's `models.json`
     into `<agentDir>/models.json` (key `providers.deepseek-responses.apiKey`;
     the `${DEEPSEEK_API_KEY}` placeholder works there too).
  3. No npm install in this repo is required — the extension resolves its
     imports from the pi installation.
- **What you get**: one short list of the tools/commands/provider, pointing
  at the existing table.

### Step 3: Write the Standalone section

Add a "Standalone (`pi -ne`)" section stating:

- The extension runs with no other extensions: `pi -ne` + this extension is
  a complete environment for the six tools and three commands.
- It does not require pi-chimera or any other extension, and does not
  conflict with them when present (dedupe by tool name if the docs show pi
  errors on duplicates — cite what you found in Step 1).
- **Verification procedure** (operator-facing, manual):
  1. `pi -ne` in a scratch directory with the extension configured.
  2. Run `/deepseek` — the menu opens (integration, effort, chat, reset,
     cache, close).
  3. Ask the model to use `ds_chat` (or run `/ds hello`) — a reply is
     rendered as a session entry; footer shows `DS v4-flash · cache …`
     after a turn.
  4. Expected failure mode check: unset `DEEPSEEK_API_KEY` → tools return
     the "DeepSeek API key not found" message instead of crashing.

### Step 4: Write the Troubleshooting section

- `DeepSeek API key not found: set DEEPSEEK_API_KEY (or configure an
  apiKey …)` — explains the two supported locations.
- HTTP 400 in thinking mode with tools — the "Reasoning passthrough"
  section already covers the rule; link to it.
- `DeepSeek request timed out` — explain the timeout scales with
  `max_output_tokens` (plan 003's formula) and the
  `DEEPSEEK_REQUEST_TIMEOUT_MS` override (seconds) **if** plan 003 has
  landed; otherwise document only the 90s base and note the override is
  coming. Check the live code before writing this bullet.
- `ds_call_function` with `$ref` schemas — document that `$ref`/`$def`
  schemas are supported **if** plan 002 landed (check `deepseek-v4.ts` for
  the `export { toStrictSchema }` marker); otherwise note refs are
  unsupported.
- Strict-mode gotchas: all properties required, `additionalProperties:
  false`, strings need `enum`/`const`/`pattern`/`format` (formats limited to
  email/hostname/ipv4/ipv6/uuid).

**Verify** each bullet against the live code before writing it (grep the
error strings; they must match exactly).

### Step 5: Final gates

1. `npm exec -- ultracite check` → exit 0 (README edits shouldn't affect it,
   but the gate must stay green)
2. `npm run typecheck` → exit 0 (unchanged code, but run it)
3. `npm test` → exit 0
4. Markdown sanity: the README renders with the new sections in order
   (Installation → What it provides → … → Standalone → Troubleshooting) and
   every file path it references exists in the repo.

## Test plan

- No unit tests: documentation. The verification is the operator procedure
  in Step 3 plus the grep checks below.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "Installation" README.md` → present
- [ ] `grep -n "pi -ne" README.md` → present (standalone section)
- [ ] `grep -n "Troubleshooting" README.md` → present
- [ ] Every error-string quoted in Troubleshooting matches the live code
      (`grep -n "DeepSeek API key not found" deepseek-v4.ts` etc.)
- [ ] The Requirements line states pi ≥ 0.83.0 and Node ≥ 22
- [ ] The install steps match the pi extension docs read in Step 1 (cite
      the doc name in the README)
- [ ] `npm exec -- ultracite check`, `npm run typecheck`, `npm test` all
      exit 0
- [ ] No files outside `README.md` are modified (`git status`)
- [ ] `plans/README.md` status row for 007 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The pi docs (Step 1) describe an extension-loading mechanism that
  contradicts the repo layout (e.g. extensions must live inside the pi
  config dir, not the repo) — write down exactly what the docs say and
  report; the README must document reality, not the plan's assumption.
- The docs do not confirm `pi -ne` keeps the configured extension loaded —
  report; the standalone claim needs a maintainer decision on wording.
- Any error-string grep in Step 4 fails — the live code drifted; reconcile
  or report.

## Maintenance notes

- The Troubleshooting bullets that depend on plans 002/003 must be revisited
  when those plans land if they were written before (or without) them.
- When pi bumps versions, re-verify the Requirements line and the extension
  mechanism citation against the new docs.
- A reviewer should check that the README never overpromises: every tool,
  command, and behavior mentioned must exist in the code.
