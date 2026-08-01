# Plan 002: Fix `toStrictSchema` `$ref`/`$def` resolution

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
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: plans/001-verification-baseline.md
- **Category**: bug
- **Planned at**: commit `7d0d7a0`, 2026-08-01

## Why this matters

`ds_call_function` advertises that it accepts "a TypeBox-style object schema
or plain JSON Schema" and converts it to DeepSeek's strict-mode dialect,
"honoring DeepSeek's strict dialect exactly" — including `$ref`/`$def`. But
the converter is broken for TypeBox's native reference encoding, which is the
encoding TypeBox always produces:

- A root-level `Type.Ref("User", { $defs: { User: ... } })` **throws**
  `Strict schema root reference cannot be resolved: User` — the tool fails
  outright.
- A nested `Type.Ref("User")` passes through as `"$ref": "User"` — a bare
  name, which is not a valid JSON-Schema reference (JSON Schema requires a
  URI fragment), and the `$def` registry lands at the wrong document level.

Both were reproduced empirically by extracting the converter from
`deepseek-v4.ts` and running it against typebox 1.3.7 schemas (exact outputs
in "Current state"). The reference-resolution feature — a headline capability
of the strict-schema tool — does not work for the advertised input shape.

## Current state

The converter lives in `deepseek-v4.ts` (module-private; not exported):

- `rewriteLocalRef` (lines 686–695): only touches refs starting with `#/`
  (rewrites `$defs` → `$def` in the pointer).
- `resolveLocalRef` (lines 697–710): only resolves refs starting with `#/`,
  by walking the OUTPUT document — it never resolves bare names.
- `normalizeDefinitions` (lines ~772–786): reads `source.$defs` and
  `source.$def` of the **current node** and writes them to that node's
  `$def` — defs are not hoisted to the document root.
- `toStrictSchema` (lines ~790–848):
  ```ts
  function toStrictSchema(schema: unknown, root = true): unknown {
    ...
    if (typeof schema.$ref === "string") {
      strictSchema.$ref = rewriteLocalRef(schema.$ref);
    }
    normalizeSchemaType(schema, strictSchema);
    ...
    if (root && typeof strictSchema.$ref === "string") {
      const target = resolveLocalRef(strictSchema, strictSchema.$ref);
      if (!isJsonObject(target)) {
        throw new Error(
          `Strict schema root reference cannot be resolved: ${strictSchema.$ref}`
        );
      }
      if (target.type !== "object") {
        throw new Error(
          "Strict function parameters must resolve to an object schema"
        );
      }
      return { ...target, $def: strictSchema.$def };
    }
    return strictSchema;
  }
  ```

Reproduced behavior (typebox 1.3.7 input → converter output):

```
Type.Ref("User", { $defs: { User: Type.Object({ id: Type.Integer() }) } })
  → THROWS: Strict schema root reference cannot be resolved: User

Type.Object({ a: Type.Ref("Thing"), b: Type.Ref("Thing") },
            { $defs: { Thing: Type.Object({ x: Type.Integer() }) } })
  → properties a/b get {"$ref": "Thing"} (bare name, invalid JSON Schema);
    "$def": {"Thing": {...}} emitted at the enclosing node, not the root
```

(These are the exact reproductions to turn into tests in Step 1.)

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Tests     | `npm test`                       | exit 0, all pass    |
| Typecheck | `npm run typecheck`              | exit 0, no errors   |
| Lint      | `npm exec -- ultracite check`    | exit 0              |
| Format    | `npm exec -- ultracite fix`      | exit 0              |

(Requires plan 001 to have landed: `tsconfig.json`, `tests/` runner, and the
`typebox` devDependency.)

## Scope

**In scope**:
- `deepseek-v4.ts` — the `$ref`/`$def` handling in the strict-schema section
  (lines ~686–848) plus an `export { toStrictSchema };` statement near
  `export default` (line 1897)
- `tests/to-strict-schema.test.ts` — create (new test file)

**Out of scope** (do NOT touch, even though they look related):
- The tool registration/description of `ds_call_function` — description text
  already claims `$ref`/`$def` support; this plan makes it true
- `normalizeSchemaType`'s handling of strings/numbers/arrays/booleans,
  `const`/`enum`/`anyOf`, formats, patterns — all pinned by tests, unchanged
- `tests/telemetry.test.ts` etc. — plan 006 owns the other suites
- Any behavior outside the strict-schema section

## Git workflow

- Branch: `advisor/002-strict-schema-refs`
- One commit per logical unit; message style like `Fix toStrictSchema ref resolution`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write failing regression tests

Create `tests/to-strict-schema.test.ts`. It imports the converter via the new
named export:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { toStrictSchema } from "../deepseek-v4.ts";
```

Add the `export { toStrictSchema };` line to `deepseek-v4.ts` first (near
`export default`, line 1897 — the extension loader imports the default, so
this is safe), then write these tests, modeled on the reproductions above:

1. **Root name-based ref (the throw)**: input
   `Type.Ref("User", { $defs: { User: Type.Object({ id: Type.Integer() }) } })`
   → must NOT throw; output `type: "object"`, `$ref` absent (root refs are
   resolved into the object), root `$def.User` present with
   `{ type: "integer" }` inside.
2. **Nested name-based refs**: input
   `Type.Object({ a: Type.Ref("Thing"), b: Type.Ref("Thing") }, { $defs: { Thing: ... } })`
   → `properties.a.$ref === "#/$def/Thing"`, same for `b`; root `$def.Thing`
   present; exactly one `Thing` entry.
3. **Pointer-style input refs**: input
   `{ type: "object", properties: { u: { $ref: "#/$defs/User" } }, $defs: { User: { type: "object", properties: { id: { type: "integer" } } } } }`
   → `properties.u.$ref === "#/$def/User"`; root `$def.User` present.
4. **Recursive/self refs**: `Type.Recursive` (or a hand-written
   `{ $ref: "Node", $defs: { Node: { type: "object", properties: { next: { $ref: "Node" } } } } }`)
   → completes without stack overflow; `$def.Node.properties.next.$ref === "#/$def/Node"`.
5. **Golden pin (no refs)**: a plain object schema converts to the exact
   existing output (deepStrictEqual against a literal) — pins that unrelated
   behavior is untouched. Use
   `Type.Object({ name: Type.String(), age: Type.Integer({ minimum: 0 }) })`.
6. **Behavior pins**: `const`/`enum`/`anyOf`/`format`/`pattern` cases produce
   the same output as before (copy expected JSON from current behavior —
   run the current converter once with a scratch script if unsure).
7. **Root ref to non-object**: `$ref` resolving to a `string` def → throws
   `Strict function parameters must resolve to an object schema`.

**Verify**: `npm test` → the new tests FAIL on current code (tests 1–4 at
least; 5–7 may pass). Expected: failures, not crashes. This is the red phase.

### Step 2: Rework the converter (Option A — keep refs, normalize)

Replace the `$ref`/`$def` machinery (lines ~686–710 and the root block
inside `toStrictSchema`) with registry-based resolution:

- Add an internal worklist that collects **source** defs by name from
  `$defs`/`$def` of *every* node visited during conversion (first definition
  of a name wins; document with a comment). Bare-name refs and pointer refs
  (`#/$defs/X`, `#/$def/X`) both resolve against this registry.
- Emit every ref as `#/$def/<Name>` (normalized pointer).
- After converting the tree, convert each registry entry and attach the
  result as `$def` on the **root** output object (only when the registry is
  non-empty — keep the existing "omit `$def` when empty" behavior).
- Root-ref case: when the root schema is itself a `$ref`, resolve the target
  from the registry, require `type: "object"` (keep the existing error
  message for non-objects), return the converted target with the root `$def`
  attached.
- Never follow a ref while converting (refs are rewritten, not inlined), so
  recursive schemas terminate naturally.
- Keep `toStrictSchema(schema, root = true)`'s public signature unchanged.

Preserve everything else exactly: `description` copying, `normalizeSchemaType`
behavior, `const`/`enum`/`anyOf` handling, and the numeric-field copy list.

**Verify**: `npm test` → all to-strict-schema tests pass (red → green).

### Step 3: Optional live verification against the DeepSeek API

If `DEEPSEEK_API_KEY` is available in the environment, verify a `$ref`
schema is accepted end-to-end: in a scratch pi session (or a small script
using the extension's own `ds_call_function` tool), call with parameters
containing a `$def`/`$ref` pair; expected: DeepSeek returns a function call.
If the API rejects `#/$def/...` refs (HTTP 4xx), STOP and report — the
fallback (Option B, below) needs a maintainer decision.

**Option B (only if the live check fails)**: inline refs instead of emitting
them: resolve each ref to its converted definition and substitute it at the
ref site; track the resolution stack by name and throw a descriptive
`Recursive $ref "<name>" cannot be inlined` error instead of overflowing the
stack. All tests above still pass under B except 4 (recursive refs), which
becomes the documented limitation.

### Step 4: Final gates

1. `npm run typecheck` → exit 0
2. `npm test` → exit 0, all suites pass
3. `npm exec -- ultracite check` → exit 0

## Test plan

- New file `tests/to-strict-schema.test.ts` with the seven cases in Step 1
  (root name-ref, nested name-refs, pointer refs, recursion, golden pin,
  keyword pins, non-object root ref error). Model assertions on
  `node:assert/strict` `deepStrictEqual` for structural checks.
- These tests are the regression net for any future change to the converter.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm test` exits 0; `tests/to-strict-schema.test.ts` exists with ≥ 6 passing tests
- [ ] `npm run typecheck` exits 0
- [ ] `npm exec -- ultracite check` exits 0
- [ ] `grep -n "resolveLocalRef" deepseek-v4.ts` — function removed or no
      longer used by `toStrictSchema` (dead code cleaned up)
- [ ] `grep -n "export { toStrictSchema }" deepseek-v4.ts` — present
- [ ] No files outside `deepseek-v4.ts` and `tests/to-strict-schema.test.ts`
      are modified (`git status`)
- [ ] `plans/README.md` status row for 002 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The current-code excerpts don't match the live file.
- The live API check (Step 3) rejects `#/$def/...` refs — Option B requires
  a maintainer decision, do not silently pick it.
- A test passes for a reason you can't explain (e.g. the registry silently
  resolves to the wrong def).
- `Type.Recursive` behaves differently from the hand-written self-ref schema
  in test 4 — report what you observed.

## Maintenance notes

- Future schema keywords added to `normalizeSchemaType` must keep the
  registry/hoisting behavior consistent — refs must always point at the root
  `$def`.
- The empty/typeless schema case (`Type.Any()` → `{}`) is a known limitation
  of the converter, unchanged by this plan; DeepSeek strict mode may reject
  it. Do not extend scope to fix it here.
- If DeepSeek later documents that `$def` refs are name-based rather than
  pointer-based, the normalization in this plan is the single place to flip.
- A reviewer should verify the worklist conversion terminates for
  mutually-recursive defs (A → B → A) and that duplicate def names resolve
  deterministically (first-wins, per the code comment).
