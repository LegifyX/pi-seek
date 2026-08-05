# Fabric integration contract for pi-seek — how extension tools play nicely with Fabric

**Access date:** 2026-08-05
**Source scanned (read-only):** ~/projects/pi-fabric (pi-fabric 0.36.0 source; docs/, src/)
**Artifact:** determination of how pi-seek and its tools interact with the Fabric system, what Fabric guarantees, and what pi-seek should do. No source file in pi-fabric was modified.

## How Fabric sees pi-seek today

Fabric captures every tool any extension registers through pi.registerTool() by intercepting ExtensionRunner.getAllRegisteredTools() (src/capture/interceptor.ts + catalog.ts), regardless of load order. Captured tools become lazy actions under the `extensions` provider:

- ref extensions.<toolName> (proxy when the name is a valid JS property), namespace extension:<sourceLabel> (pi-seek's source label is the pi-* package segment: pi-seek), description annotated "(captured from pi-seek)".
- The captured definition's prepareArguments() (TypeBox validation) and original executor run with the owning extension context. Pi's tool_call / tool_result / tool_execution_* lifecycle handlers are applied to nested captured calls.
- Result shape preserved: content, text (joined text parts), details, isError, terminate, plus source provenance.
- Default behavior in full code mode: captured tools are hidden from Pi's model-facing registry (capture.hideFromModel: true, keepVisible: ["fabric_exec"]) — the extension stays loaded (commands, events, UI keep working); discovery/invocation is lazy via tools.search / tools.describe / tools.call or the extensions.* proxy inside fabric_exec.
- Cancellation: context.signal propagates through runAbortable; a thrown error becomes isError: true with details.capturedToolError and is re-thrown to the caller.
- Progress: if a tool calls its onUpdate callback, Fabric streams tool_execution_update events and shows live activity; otherwise a single result row appears.
- Scheduling: definition.executionMode (sequential/parallel) is honored per captured tool.
- Results pass through Pi's tool_result middleware (patchable); oversized nested results are bounded by executor.maxNestedResultChars (default 2,000,000 chars) and truncated in audits/previews.

### Verified this session
pi-seek's six tools are captured and callable inside fabric_exec (extensions.ds_chat_reset etc. worked end-to-end in this host), and the registered provider deepseek-responses/deepseek-v4-flash is what Pi's native model machinery runs on. pi-seek's result shape (content/text/details/isError) and its signal-based "Interrupted by the caller." behavior already match Fabric's captured-tool contract.

## Risk and approvals (the main operator-facing knob)

Fabric risk classes: read | write | execute | network | agent; approval policies: allow | ask | auto | deny. Because Pi tool definitions do not declare effects, captured tools default to the conservative execute risk; exact per-tool overrides live in capture.risks of the Fabric config (.pi/fabric.json project-trusted or ~/.pi/agent/fabric.json global).

**Implication for pi-seek:** five of its six tools perform authenticated, billable network calls but are classified execute by default. Operators who want correct approval semantics (e.g. an ask/auto policy on network) need an explicit override. pi-seek should ship the recommended snippet in its skill/README:

```json
{
  "capture": {
    "risks": {
      "ds_chat": "network",
      "ds_web_search": "network",
      "ds_prefix_complete": "network",
      "ds_fim": "network",
      "ds_call_function": "network",
      "ds_chat_reset": "execute"
    }
  }
}
```

## What pi-seek already does right

1. Tools via pi.registerTool() → captured automatically, no Fabric-specific code needed.
2. Result shape conforms to the captured-tool result contract (content/text/details/isError).
3. TypeBox parameter schemas → validated by Fabric's prepareArguments on every captured call.
4. Signal handling: aborts return structured "Interrupted by the caller." results instead of throwing — matches runAbortable/throwIfAborted semantics.
5. Skills shipped via the package.json pi.skills manifest.
6. Package metadata added in the 2026-08-04 integration pass (peerDependencies *, pi-package keyword) matches docs/packages.md and pi-fabric's own manifest shape.
7. Registered provider powers the native Pi provider path (the host itself runs on it); lifecycle hooks (before_provider_request, turn_end usage, model_select, session restore) fire for both native and nested calls.

## Recommended follow-ups (evidence-backed, none required for basic capture)

1. **Document capture.risks** (skill + README): classify the five fetch tools as network (see snippet). The single most useful operator-facing integration improvement.
2. **Contribute skills via resources_discover**: pi-fabric returns { skillPaths: [...] } from pi.on("resources_discover") so child Pi processes (one-shot agents, actors launched with -e) discover the same skills as the main agent. pi-seek can mirror this so skills/pi-seek/SKILL.md is visible to child agents.
3. **Update SKILL.md with Fabric usage**: in full code mode the ds_* tools are hidden from the model registry; the skill should say they are reached via extensions.ds_* / tools.search inside fabric_exec, or natively when full code mode is off — plus the risk snippet and the result contract.
4. **Bound details size**: ds_chat details carry the full thread.items (up to ~600K chars by the replay cap). Nested results are bounded at 2M chars and audits truncate at ~16K, but lean details (counts + last few items; full state stays in the thread store) keep nested results and audit traces small.
5. **Emit progress via onUpdate**: at least one update per long call (e.g. "requesting…", "retrying…") so Fabric's activity/dashboard shows live progress and tool_execution_update fires.
6. **Declare engines.node >= 24** in package.json (additive; matches pi-fabric's declaration and the runtime already used).
7. Optional: add promptGuidelines to tool definitions (defineTool supports them; fabric_exec uses them) to teach models effective usage of each ds_* tool.
8. Optional future: the Fabric external-provider protocol (FABRIC_PROVIDER_REGISTER_EVENT / FABRIC_PROVIDER_DISCOVER_EVENT, version 1) if pi-seek ever wants richer risk declarations or a data-driven activity surface (e.g. balance as a provider with context.activity); not needed for the current tool set.
9. Not needed: the nested tool_result proxy pattern (only for results >6K chars that must be externalized — pi-seek results are bounded), and FABRIC_NESTED_TOOL_CALL_ID_PREFIX detection (only relevant if pi-seek hooks must distinguish nested fabric calls).

## Guarantees Fabric provides (pi-seek does not need to implement)

Lazy capture and hiding, argument validation, approval gates per risk class (incl. the auto-approval classifier), audit traces with bounded previews, cancellation propagation, progress streaming, per-tool execution-mode scheduling, result patching via Pi middleware, and replayed tool lifecycle events.


## Status of recommended follow-ups (2026-08-05)

1. **Document capture.risks** — SKIPPED by owner decision (manual approval workflow).
2. **resources_discover** — IMPLEMENTED: src/index.ts exports registerSkillDiscovery (SKILLS_DIR resolved from the entry path, existsSync-guarded) and piSeek registers it; e2e test asserts the handler returns the packaged skills directory.
3. **SKILL.md Fabric usage** — PRESENT (Invocation section); hideFromModel nuance added 2026-08-05.
4. **Leaner ds_chat details** — SKIPPED: details.thread.items is the session-restore source; trimming would drop history on restore.
5. **onUpdate progress** — IMPLEMENTED: the five fetch tools emit an initial progress update (details: {}) through the onUpdate callback; e2e test asserts ds_chat reports progress.
6. **engines.node >= 24** — IMPLEMENTED in package.json.

## Bonus (owner request, 2026-08-05)

The status line (footer) now appends the remaining balance after DeepSeek usage: setFooter(context, balance) refreshes it via the TTL-cached balance store (at most one GET /user/balance per 60s, fire-and-forget with a failure-safe base line, "balance unavailable" when the account reports no usable balance). Plumbed through registerLifecycleHandlers (turn_end/model_select) and all five fetch tools; lifecycle tests cover the appended balance, the unavailable case, and fetch-failure fallback.
