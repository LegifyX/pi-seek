# Plan 004: Stop embedding full thread snapshots in tool results

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
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md
- **Category**: perf
- **Planned at**: commit `7d0d7a0`, 2026-08-01

## Why this matters

`ds_chat` persists thread state by embedding it in tool-result `details`,
which pi stores in the session transcript. Currently every single `ds_chat`
round embeds the **entire thread map — every thread's full item history** —
via `threads: threads.snapshot()` (line 1037), and `ds_chat_reset` does the
same (line 1067). But `restore()` (lines 644–668) only ever uses the **last**
matching entry's snapshot to rebuild state. So every intermediate snapshot is
pure dead weight: session transcripts grow roughly quadratically with total
chat volume (round N duplicates all items from rounds 1..N-1 of all threads),
and every round's details payload is far larger than it needs to be. The fix:
embed only the touched thread, and make `restore()` replay the branch
chronologically.

## Current state

- `Thread` shape (lines ~139–146): `{ items: unknown[]; round: number; system?: string }`
- `snapshot()` (lines 641–642):
  ```ts
  const snapshot = (): Record<string, Thread> =>
    Object.fromEntries(threads.entries());
  ```
- `restore()` (lines 644–668) — clears and replaces wholesale:
  ```ts
  const restore = (context: ExtensionContext): void => {
    threads.clear();
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type !== "message") {
        continue;
      }
      const { message } = entry;
      const isThreadTool =
        message.role === "toolResult" &&
        (message.toolName === "ds_chat" ||
          message.toolName === "ds_chat_reset");
      if (!isThreadTool) {
        continue;
      }
      const details = message.details as
        | { threads?: Record<string, Thread> }
        | undefined;
      if (!details?.threads) {
        continue;
      }
      threads.clear();
      for (const [name, thread] of Object.entries(details.threads)) {
        threads.set(name, thread);
      }
    }
  };
  ```
- `ds_chat` result details (lines ~1028–1040) include
  `round`, `thinking`, `thread: params.thread`, `threads: threads.snapshot()`, `usage`.
- `ds_chat_reset` result details (lines ~1060–1068): `{ thread, threads: threads.snapshot() }`.
- `restore()` is invoked on `session_start` and `session_tree` (lines ~1445–1450).
- `snapshot()` is also used by `selectResetAction` (line ~1560) to list thread
  names in the menu — that use stays.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Tests     | `npm test`                       | exit 0, all pass    |
| Typecheck | `npm run typecheck`              | exit 0, no errors   |
| Lint      | `npm exec -- ultracite check`    | exit 0              |

(Requires plan 001.)

## Scope

**In scope**:
- `deepseek-v4.ts` — `restore()`, the two tool-result `details` blocks
  (`ds_chat`, `ds_chat_reset`)
- `tests/threads-restore.test.ts` — create

**Out of scope** (do NOT touch):
- The `Thread`/`ThreadStore` interfaces' other members (`withLock`, `reset`,
  `getOrCreate`, `snapshot`) — the menu still needs `snapshot()`
- The persistence mechanism itself (tool-result details) — that is the
  documented design; this plan only shrinks what is persisted
- `ds_chat`'s replay mechanics (`thread.items` growth) — inherent to the
  stateless API

## Git workflow

- Branch: `advisor/004-thread-snapshot-budget`
- One commit per logical unit; message style like `Persist only the touched thread in tool results`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Shrink the `ds_chat` details

In the `ds_chat` tool result (around line 1037), replace
`threads: threads.snapshot(),` with:

```ts
thread: {
  items: thread.items,
  name: params.thread,
  round: thread.round,
  system: thread.system,
},
```

(This is the single thread that changed this round.)

### Step 2: Shrink the `ds_chat_reset` details

In the `ds_chat_reset` tool result (around line 1067), replace the details
object with:

```ts
details: {
  reset: params.thread
    ? { kind: "thread" as const, name: params.thread }
    : { kind: "all" as const },
  thread: params.thread,
},
```

### Step 3: Make `restore()` replay chronologically

Replace the body of `restore()` with sequential replay semantics:

```ts
const restore = (context: ExtensionContext): void => {
  threads.clear();
  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type !== "message") {
      continue;
    }
    const { message } = entry;
    const isThreadTool =
      message.role === "toolResult" &&
      (message.toolName === "ds_chat" ||
        message.toolName === "ds_chat_reset");
    if (!isThreadTool) {
      continue;
    }
    const details = message.details as
      | {
          reset?: { kind: "all" } | { kind: "thread"; name: string };
          thread?: Thread & { name: string };
          threads?: Record<string, Thread>;
        }
      | undefined;
    if (details?.threads) {
      // Legacy shape from versions that snapshotted the whole map.
      threads.clear();
      for (const [name, thread] of Object.entries(details.threads)) {
        threads.set(name, thread);
      }
      continue;
    }
    if (message.toolName === "ds_chat" && details?.thread?.name) {
      const { items, name, round, system } = details.thread;
      threads.set(name, { items, round, system });
    } else if (message.toolName === "ds_chat_reset" && details?.reset) {
      if (details.reset.kind === "all") {
        threads.clear();
      } else {
        threads.delete(details.reset.name);
      }
    }
  }
};
```

The branch is chronological, so applying set/delete in order reconstructs
the final state correctly: a thread's last entry wins; a later reset removes
it. The legacy branch keeps old sessions' transcripts restorable.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Write tests

Create `tests/threads-restore.test.ts`. `restore` needs an `ExtensionContext`;
build a minimal fake and cast it:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

// createThreadStore is not exported; test through a small seam:
// add `export const __test = { createThreadStore };` near export default,
// same pattern as plan 002's named export.
```

If you prefer not to add a seam, note that `createThreadStore` is module-
private — this plan's seam is the `__test` namespace (also used by plan 006).
Add it.

Cases (build fake branch entries with `type: "message"`,
`message: { role: "toolResult", toolName, details }` and pass
`{ sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext`):

1. **Single thread, two rounds** → restored `items` length equals round 2's,
   `round` equals 2.
2. **Two threads interleaved** (A1, B1, A2) → both exist; A has round-2
   state, B round-1 state.
3. **Reset-all after rounds** → no threads.
4. **Reset one thread** → the other survives.
5. **Create-after-reset** (A1, reset A, A2) → A exists with round-2 state.
6. **Legacy entry** (`details.threads` map) → wholesale-replace behavior
   preserved.

**Verify**: `npm test` → exit 0, all six pass.

### Step 5: Final gates

1. `npm run typecheck` → exit 0
2. `npm test` → exit 0
3. `npm exec -- ultracite check` → exit 0

## Test plan

- `tests/threads-restore.test.ts` — the six scenarios above, using the
  `__test.createThreadStore` seam. No network, no pi runtime needed.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm test` exits 0; `tests/threads-restore.test.ts` exists with 6 passing tests
- [ ] `npm run typecheck` exits 0
- [ ] `npm exec -- ultracite check` exits 0
- [ ] `grep -n "threads: threads.snapshot()" deepseek-v4.ts` → no matches
- [ ] `grep -n "thread: {" deepseek-v4.ts` → the `ds_chat` details block
      present (and `reset:` in `ds_chat_reset` details)
- [ ] `snapshot()` still exists (menu uses it) and is still called by
      `selectResetAction`
- [ ] No files outside `deepseek-v4.ts` and `tests/threads-restore.test.ts`
      are modified (`git status`)
- [ ] `plans/README.md` status row for 004 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The live code doesn't match the excerpts (drift).
- The branch entry shape in pi 0.83.0 differs from
  `{ type: "message", message: { role: "toolResult", toolName, details } }`
  (check `dist/core/extensions/types.d.ts` in the pi install if unsure) —
  report what you find.
- Restoring an OLD session (written before this plan) yields wrong threads
  despite the legacy branch — report with the session file evidence.

## Maintenance notes

- If pi ever truncates or caps tool-result `details`, the restore mechanism
  itself (not just its size) needs revisiting — this plan is the first step
  in making the design safe for such a cap.
- The legacy `details.threads` path can be deleted once no pre-change
  sessions matter; keep it until then.
- A reviewer should verify that `ds_chat_reset`'s details still tell the
  model which threads remain (the model can infer from subsequent tool
  results; thread names remain visible in each `thread.name`).
