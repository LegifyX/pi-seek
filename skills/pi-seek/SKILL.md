---
name: pi-seek
description: >-
  DeepSeek V4 (Flash and Pro) toolset for pi. Use when the user wants to chat with
  DeepSeek in a named conversation thread (running it as a sub-agent with
  persistent history), complete code or structured text from an assistant
  prefix or fill the middle of a file, get a web answer with citations
  through DeepSeek's server-side search, or force DeepSeek to emit a
  strict-mode function call. Also use for DeepSeek diagnostics: remaining
  account balance, KV-cache hit/miss cost of the last request, and enabling
  or disabling the integration.
---

# pi-seek — DeepSeek V4 (Flash and Pro) toolset

Six tools (`ds_chat`, `ds_chat_reset`, `ds_prefix_complete`, `ds_fim`, `ds_web_search`, `ds_call_function`) plus four user-run commands (`/ds`, `/ds-cache`, `/ds-balance`, `/deepseek`). Pick a branch by the user's intent; each branch below carries its selection rule, inputs, caveats, and completion criterion.

## Gate: enabled + retries

Every tool checks the integration gate first: while disabled, all six return "DeepSeek integration is disabled. Run /deepseek to enable it." with `details.disabled: true` — on that result, ask the user to run `/deepseek` and toggle it on. All five fetch tools (`ds_chat`, `ds_prefix_complete`, `ds_fim`, `ds_web_search`, `ds_call_function`) retry transient failures (429, 5xx, network, timeout) through `withRetries` with capped exponential backoff, at most 4 retries; `ds_chat_reset` makes no network call. Retry counts surface as `details.retries` on every fetch tool; `ds_chat` and `ds_call_function` additionally append a bounded `[note: retried Nx]` text suffix. An aborted request — mid-call or while waiting between retries — returns "Interrupted by the caller." with `details.interrupted` instead of throwing. A thrown non-transient error means the call itself was wrong — fix the inputs.

## Branch map

| User intent | Tool | Selection rule |
|---|---|---|
| Multi-round chat, DeepSeek as a sub-agent | `ds_chat` | named thread; clear with `ds_chat_reset` |
| Continue code/structured text from a fixed prefix | `ds_prefix_complete` | assistant prefix + optional stop sequences |
| Fill the gap between code before and after | `ds_fim` | `prompt` required, `suffix` optional; 4K token cap |
| Web-grounded answer with citations | `ds_web_search` | fresh facts beyond training |
| Structured output as a strict function call | `ds_call_function` | typed extraction; thinking is off |
| Balance / cache / enable state | `/ds-balance`, `/ds-cache`, `/deepseek` | user-run, see Diagnostics |

## Threaded chat — `ds_chat`, `ds_chat_reset`

Intent: multi-round conversation with persistent history; DeepSeek runs as a **sub-agent** on a named **thread**.

`ds_chat` — required `thread` (created on first use) and `message`. Optional `system` (applies only to a NEW thread; ignored once the thread exists), `reasoning_effort` (`none`|`minimal`|`low`|`medium`|`high`|`xhigh`|`max`), `max_output_tokens` (16–393216), `temperature` (0–2) and `top_p` (0–1) — both have no effect while thinking is enabled (any `reasoning_effort` other than `none`).

Caveats, co-located:
- History replay is bounded to the last 200 items / 600k chars, oldest first, latest user message always kept; `details.trimmed_history` and `details.history_items` appear when a trim happened.
- Every call prepends a bounded "Current time: …" note to the instructions
  unless the caller's system already carries a time note; the note is
  minute-precision, so rounds within the same minute keep an identical
  instructions prefix (KV-cache friendly). Threads remember the original
  system, never the injected note.
- A context-length 400 trims the replay once and retries once (`details.trimmed`); if nothing is droppable the error propagates.
- An aborted request returns "Interrupted by the caller." with `details.interrupted` and the thread untouched — resume with the same name.
- `function_call` / `web_search_call` items are not persisted across rounds.
- A response that is not `completed` (e.g. cut off at `max_output_tokens`) surfaces `details.status` / `details.incomplete_reason` / `details.error` and a `[note: response incomplete …]` suffix; retry with a higher `max_output_tokens` or a trimmed thread.
- Reply text can carry a `[note: …]` suffix (retries, unexpected function calls — unexpected calls mean the chat should have been `ds_call_function`); an empty reply comes back as `(empty reply)`.

`ds_chat_reset` — optional `thread`; omit to reset ALL threads. Returns the cleared thread's name, or a confirmation that all threads were reset.

Safe ordering: reset a thread before reusing its name for a new topic — the reset also makes `system` apply again on the next `ds_chat`.

Completion criterion (checkable): the reply answers the current `message`; if it is `(empty reply)`, interrupted, or the user needs a next round, call `ds_chat` again on the same `thread` name and the history continues. For `ds_chat_reset`, the returned text confirms exactly what the user asked to clear (`Thread "<name>" reset` or `All DeepSeek threads reset`).

## Code completion — `ds_prefix_complete`, `ds_fim`

Intent: complete code or structured text where the model continues from given context rather than answering freely.

`ds_prefix_complete` — required `prompt` (instruction) and `prefix` (assistant text to continue from, e.g. `"```python\n"`). Optional `stop` (one sequence or up to 16, e.g. `["```"]`), `max_tokens` (1–393216), `temperature` (0–2), `top_p` (0–1). Returns the continuation; `details.full` is `prefix + completion`; `details.finish_reason` reports how generation ended (`stop` is normal; `length`/`content_filter`/`insufficient_system_resource` get a `[note: completion stopped: …]` suffix).

`ds_fim` — required `prompt` (code before the gap). Optional `suffix` (code after the gap), `stop` (one sequence or up to 16), `max_tokens` (API cap 4096), `temperature` (0–2), `top_p` (0–1), `logprobs` (0–20). Returns the middle; `details.finish_reason` reports how generation ended.

Selection: code on both sides of the gap → `ds_fim`; continuing from a known prefix in structured output → `ds_prefix_complete`; both accept `stop` to end at a delimiter.

Completion criterion (checkable): the pieces assemble — `prompt + completion + suffix`, or `prefix + completion` checked against `details.full` — into the intended text, ending at the configured `stop` sequence when one was set.

## Web search — `ds_web_search`

Intent: an answer grounded in live web results, with citations where the API provides them.

`ds_web_search` — required `query`. Optional `reasoning_effort` (`low`|`high`|`max`), `max_output_tokens` (≥ 16). The result is the model's answer, not a raw result list; `details.searchCalls` shows the calls.

Completion criterion (checkable): the answer addresses the query and cites sources when the API returned any; `(no answer)` means reword the query and retry.

## Strict function call — `ds_call_function`

Intent: structured extraction — DeepSeek must emit one named function call whose arguments satisfy a strict schema, rather than free text.

`ds_call_function` — required `name` and `parameters` (a TypeBox-style object schema or plain JSON Schema; normalized to DeepSeek's strict dialect). Optional `context` (the user turn; default "Determine the correct arguments for this function call.") and `description`.

Caveats, co-located:
- Thinking is disabled for this call — DeepSeek rejects forced tool choice in thinking mode.
- The strict dialect: object properties all required with `additionalProperties: false`; strings via `enum`/`const`/`pattern`/`format` (formats limited to `email`, `hostname`, `ipv4`, `ipv6`, `uuid`); numbers via `const`/`default`/bounds/`multipleOf`; arrays without `minItems`/`maxItems`; `enum`/`anyOf`/`$ref`/`$def` supported, refs hoisted to `#/$def/<Name>`.
- It returns the parsed arguments (`details.arguments`) — it does not execute your function.
- Throws when the model calls no function or a different one (the error carries the model's content) or returns invalid JSON arguments.

Completion criterion (checkable): `details.name` equals the requested `name` and `details.arguments` parse and satisfy the strict schema; on a throw, tighten the schema or enrich `context`, then retry.

## Invocation

All six tool identifiers are plain snake_case, so Fabric reaches them directly in full code mode:

`extensions.ds_chat({thread, message, system?, reasoning_effort?, max_output_tokens?, temperature?, top_p?})` · `extensions.ds_chat_reset({thread?})` · `extensions.ds_prefix_complete({prompt, prefix, stop?, max_tokens?, temperature?, top_p?})` · `extensions.ds_fim({prompt, suffix?, stop?, max_tokens?, temperature?, top_p?, logprobs?})` · `extensions.ds_web_search({query, reasoning_effort?, max_output_tokens?})` · `extensions.ds_call_function({name, parameters, context?, description?})`

Discovery fallback: `tools.search({query: "deepseek"})` to find the tools, `tools.describe({ref: "extensions.<name>"})` for the full input schema, `tools.call({ref, args})` to invoke. Refs are namespaced — bare names are rejected.

In full code mode Fabric hides captured extension tools from Pi's direct model registry, so the six tools are reachable only through `fabric_exec` (the `extensions.*` proxy or `tools.search`/`tools.call` above). Outside full code mode they appear as ordinary Pi tools.

## Diagnostics — user-run commands

The four commands are typed by the user; recommend them rather than faking them:

- `/deepseek` — menu: enable/disable the integration, set the default thinking
  effort (`low`|`high`|`max`; default `high`) used by `/ds` and the agent's own
  DeepSeek provider requests — tool calls ignore it: `ds_chat` defaults to
  `high` and `ds_web_search` to `low` when `reasoning_effort` is omitted — plus
  one-shot chat, reset threads, balance, cache telemetry. Point the user here
  when a tool returns the disabled result.
- `/ds <prompt>` — one-shot chat, no thread.
- `/ds-cache` — KV-cache hit/miss tokens and cost of the last request.
- `/ds-balance` — remaining account balance for every currency the account holds (USD and CNY are listed side by side), the current billing phase, and usage today and this session (60s TTL, falls back to the cached value on fetch failure).

The status line (footer) shows the billing phase and the remaining balance after DeepSeek usage — `☾ off-peak 50% · $0.00 · ¥39.22`, or `☀ peak` — refreshed at most every 60s; `unavailable` as the balance when the account reports no usable balance. The phase marks DeepSeek's billing windows (peak Mon-Fri 09:00-12:00 and 14:00-18:00 UTC+8, off-peak 50%, weekends off-peak) and is display-only: the reported cost stays on the peak rate. To keep the phase coloured, list `"ds"` in the statusline plugin's `extensionStatusRaw`; without that the host renders the row in its own colour and prefixes the key (`ds ☾ off-peak 50% …`). Cache hit/miss and cost are the statusline's own segments; `/ds-cache` shows them directly. Open `/ds-balance` for the full card.
