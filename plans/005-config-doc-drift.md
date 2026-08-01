# Plan 005: Align models.json with code + README (xhigh, contextWindow, compat)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7d0d7a0..HEAD -- models.json README.md deepseek-v4.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md
- **Category**: docs/config
- **Planned at**: commit `7d0d7a0`, 2026-08-01

## Why this matters

The repo describes the same model facts three times, and the shipped
`models.json` disagrees with the other two sources on both facts:

| Fact | `models.json` | `README.md:10` | `deepseek-v4.ts` |
|------|---------------|----------------|------------------|
| xhigh thinking level | `"xhigh": "xhigh"` (line 27) | `xhigh→high (clamped)` | `xhigh: "high"` (line 56), comment at 47: "deepseek-v4-flash clamps xhigh to high" |
| contextWindow | `1000000` (line 32) | `1,048,576` | `1_048_576` (line 1379) |
| supportsDeveloperRole | `true` (line 15) | not stated | `false` (line 1361) |

Two sources agree on `xhigh` and `contextWindow`; the code path is the one
that was verified against pi 0.83.0 (per README's "Reasoning passthrough"
section). The config users actually load disagrees. Whoever reads
`models.json` gets wrong model behavior; whoever reads the README gets facts
that contradict the shipped config. This plan makes all three agree and
documents the decision so the drift cannot silently return.

## Current state

`models.json` (complete file, 34 lines) — key excerpts:

```json
{
  "providers": {
    "deepseek-responses": {
      "name": "DeepSeek (Responses API)",
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-responses",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "compat": {
        "supportsDeveloperRole": true,
        "supportsReasoningEffort": true,
        "supportsLongCacheRetention": false,
        "supportsStrictMode": false,
        "supportsOpenAIGrammarTools": false,
        "supportsToolSearch": false
      },
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash (Responses API)",
          "reasoning": true,
          "thinkingLevelMap": { ... "xhigh": "xhigh", ... },
          "input": ["text"],
          "cost": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 },
          "contextWindow": 1000000,
          "maxTokens": 393216
        }
      ]
    }
  }
}
```

The extension registers the same provider programmatically
(`registerProvider`, deepseek-v4.ts lines ~1340–1385) with a compat block
that has a **different key set**: `requiresAssistantContentForToolCalls`,
`requiresReasoningContentOnAssistantMessages`, `supportsToolChoice` (pi
0.83.0 flags) vs. `supportsOpenAIGrammarTools`, `supportsToolSearch`
(models.json-only keys). Both may be merged by pi at runtime; the plan
aligns the conflicting *values* and documents the key-set difference.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Lint/format | `npm exec -- ultracite check`  | exit 0              |
| Format    | `npm exec -- ultracite fix`      | exit 0              |
| Tests     | `npm test`                       | exit 0              |
| Typecheck | `npm run typecheck`              | exit 0              |
| pi source lookup | `grep -rn "registerProvider" <pi install>/dist/core` | see Step 2 |

## Scope

**In scope**:
- `models.json` — the three fact values + a sync comment
- `README.md` — only if a fact must change there too (expected: no)
- Nothing else

**Out of scope** (do NOT touch):
- `deepseek-v4.ts` behavior — code wins; config aligns to it
- `ds_call_function`/tools — unrelated
- The pricing fields (`cost`) — they already agree
- `maxTokens` — already agrees (393216 everywhere)

## Git workflow

- Branch: `advisor/005-config-drift`
- One commit per logical unit; message style like `Align models.json facts with code and README`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Align the facts in models.json

Edit `models.json`:

1. `thinkingLevelMap`: change `"xhigh": "xhigh"` → `"xhigh": "high"`.
2. `contextWindow`: change `1000000` → `1048576`.
3. `compat.supportsDeveloperRole`: change `true` → `false` (matches
   `registerProvider`, which is the tested registration).
4. Add a one-line comment at the top of the file:
   `// Keep model facts (thinkingLevelMap, contextWindow, compat) in sync with deepseek-v4.ts and README.md.`

If Biome's formatter wants to realign the file, run
`npm exec -- ultracite fix` afterward.

**Verify**: `npm exec -- ultracite check` → exit 0;
`grep -n '"xhigh"' models.json` → `"xhigh": "high"`;
`grep -n 'contextWindow' models.json` → `1048576`.

### Step 2: Confirm the compat-flag reconciliation

Find the pi install (usually
`/Users/bsa/.local/share/mise/installs/node/26.5.1/lib/node_modules/@earendil-works/pi-coding-agent`),
then check how extension-registered providers interact with `models.json`
providers:

```
grep -rn "registerProvider\|mergeProviders\|providers" <pi>/dist/core/model-runtime.js <pi>/dist/core/extensions/runner.js | head -30
```

Goal: determine whether pi merges compat flags per-key, or one registration
wins. Then:

- **If per-key merge or the extension wins**: `models.json` compat keys that
  also exist in the code must match the code's values (done in Step 1);
  keys unique to one side stay. No further edits.
- **If models.json wins outright**: STOP and report — the direction of
  alignment flips and the code's compat block (not just config) must change.

Also note the name/contextWindow `name` field ("DeepSeek (Responses API)" vs
code's "DeepSeek V4 Flash (Responses API)") — cosmetic; leave it.

**Verify**: you can state in your summary which mechanism you found, with the
grep evidence.

### Step 3: Update the README only if a fact changed there

Expected: no README change needed — README already says
`xhigh→high (clamped)` and `contextWindow 1,048,576`. If Step 1 forced a
different truth, update `README.md:10` to match and say so in your summary.

### Step 4: Final gates

1. `npm run typecheck` → exit 0
2. `npm test` → exit 0
3. `npm exec -- ultracite check` → exit 0

## Test plan

- No unit tests: this is config alignment. The gate is grep-based (below)
  plus the existing suites staying green.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n '"xhigh"' models.json README.md deepseek-v4.ts` → every hit
      consistent: `"high"` in all three (README's table row counts)
- [ ] `grep -n 'contextWindow\|1_048_576\|1048576' models.json` → `1048576`
- [ ] `grep -n 'supportsDeveloperRole' models.json` → `false`
- [ ] `npm exec -- ultracite check` exits 0
- [ ] `npm test` and `npm run typecheck` exit 0
- [ ] The sync comment exists at the top of `models.json`
- [ ] No files outside `models.json` (and `README.md` only if Step 3
      required it) are modified (`git status`)
- [ ] `plans/README.md` status row for 005 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The live files don't match the excerpts.
- Step 2's pi-source investigation shows models.json wins outright over the
  extension registration.
- A live pi session (if you run one) shows the provider behaving differently
  than the code claims after your edits.

## Maintenance notes

- The comment added in Step 1 is the tripwire; if a future change updates
  `THINKING_LEVEL_MAP` or `contextWindow` in `deepseek-v4.ts`, models.json
  must change in the same commit.
- The two compat key sets (code vs config) should eventually be consolidated
  into one place — out of scope here, but worth a maintainer decision.
- A reviewer should double-check the `xhigh: "high"` claim against DeepSeek
  docs when they're reachable; if DeepSeek does support `xhigh` on
  deepseek-v4-flash, the code comment (line 47) is the record to update, and
  the clamp should be removed — not the other way around.
