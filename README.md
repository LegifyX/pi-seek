# pi-seek — DeepSeek V4 Flash toolset for pi

A pi extension that turns DeepSeek V4 Flash's Responses API into a complete
toolset.

## Installation

**Requirements**: pi ≥ 0.83.0 (the release this extension is verified against;
see "Reasoning passthrough" below) and Node ≥ 22
(`@earendil-works/pi-coding-agent` requires `node >=22.19.0`).

1. **Load the extension.** pi's `docs/extensions.md` ("Extension Locations")
auto-discovers extensions from `~/.pi/agent/extensions/*/index.ts` (global)
or `.pi/extensions/*/index.ts` (project-local); `docs/usage.md` documents the
explicit form `-e` / `--extension <source>` — "Load an extension from path,
npm, or git; repeatable". The extension is a multi-file package: either copy
this whole project directory (or just `src/`) into one of the
auto-discovered locations, or run `pi -e /path/to/pi-seek/src/index.ts`, or
run `pi -e /path/to/pi-seek` (the directory form uses the `pi.extensions`
manifest in `package.json`).
2. **Provide an API key** — from `DEEPSEEK_API_KEY` or the `models.json` merge
below; both are documented in the "API key" section.
3. **No `npm install` is required in this repo.** The extension imports
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`,
which pi's extension loader (via jiti) resolves from the pi installation
itself; `package.json` carries devDependencies only.

The API key can come from either location:

- Set the `DEEPSEEK_API_KEY` environment variable (recommended), or
- Merge the `providers.deepseek-responses` block from this repo's `models.json`
into `~/.pi/agent/models.json` — pi's `docs/models.md` places custom providers
in `~/.pi/agent/models.json`, the agent config dir returned by pi's
`getAgentDir()` (overridable via `PI_CODING_AGENT_DIR`; default
`~/.pi/agent` per `docs/environment-variables.md`). The
`providers.deepseek-responses.apiKey` value uses pi's config syntax, so the
`${DEEPSEEK_API_KEY}` placeholder works there too.

With the extension loaded you get the `deepseek-responses` provider
(`deepseek-v4-flash`), the six tools (`ds_chat`, `ds_chat_reset`,
`ds_prefix_complete`, `ds_fim`, `ds_web_search`, `ds_call_function`), and the
four commands (`/ds`, `/ds-cache`, `/ds-balance`, `/deepseek`) — see the
table below.

## What it provides

| Piece | Notes |
|---|---|
| `deepseek-responses` provider (`deepseek-v4-flash`) |  `api: "openai-responses"`, base `https://api.deepseek.com`, apiKey `$DEEPSEEK_API_KEY`, thinking levels `off→none, minimal/low→low, medium/high→high, xhigh→high (clamped), max→max`, contextWindow 1,048,576, maxTokens 393,216, cost input 0.14 / output 0.28 / cacheRead 0.0028 / cacheWrite 0 (per 1M, from the pricing page) |
| `before_provider_request` guard |  Strips `temperature`/`top_p` while thinking mode is on (the default); the Responses API ignores them in thinking mode but payloads stay clean |
| `ds_chat` / `ds_chat_reset` |  Named, stateful threads. The DeepSeek Responses API is stateless (`previous_response_id` unsupported), so each round replays history — bounded to the last 200 items / 600k chars (oldest first; latest user message always kept). State persists in tool-result `details`, restored from the session branch |
| `ds_prefix_complete` |  Beta `https://api.deepseek.com/beta/chat/completions`, assistant `prefix: true` message + `stop` |
| `ds_fim` |  Beta `https://api.deepseek.com/beta/completions`, `prompt`/`suffix`/`max_tokens` (4K cap) |
| `ds_web_search` |  Server-side `web_search` tool via the Responses API |
| `ds_call_function` + `toStrictSchema` |  Strict-mode function calling at `/beta`, with a TypeBox→strict JSON-Schema converter honoring DeepSeek's strict dialect exactly (object: all required + `additionalProperties:false`; string: pattern/format only; number/integer: const/default/bounds/multipleOf; array: no min/maxItems; enum/anyOf/$ref/$def) |
| Retries + error taxonomy |  All five fetch tools retry transient failures (429, 5xx, network, timeouts) with capped exponential backoff, max 4 retries. Details in [Resilience](#resilience-retries-bounded-history-interrupts) |
| Context trim-and-retry |  A context-length 400 on `ds_chat` trims the replay once and retries exactly once. Details in [Resilience](#resilience-retries-bounded-history-interrupts) |
| Bounded thread replay |  Threads replay at most 200 items / 600k chars. Details in [Resilience](#resilience-retries-bounded-history-interrupts) |
| Interruption → structured result |  An aborted `ds_chat` returns "Interrupted by the caller." with `details.interrupted`. Details in [Resilience](#resilience-retries-bounded-history-interrupts) |
| Time note injection |  `ds_chat` prepends a bounded ISO 8601 UTC note unless the caller provides one. Details in [Resilience](#resilience-retries-bounded-history-interrupts) |
| `ds_cache`-style telemetry |  `/ds-cache` command, footer `ctx.ui.setStatus` while the provider is active (hit/miss + cost), per-message cost incl. cacheRead/cacheWrite on `turn_end`, hit/miss on every tool call |
| `/ds` command |  One-shot chat with DeepSeek, rendered as a session entry |
| `/ds-balance` command |  Remaining DeepSeek account balance plus estimated usage today and this session, lazily refreshed (60s TTL), with fallback to the cached value on fetch failure |

## Resilience (retries, bounded history, interrupts)

- **Error taxonomy** (`src/retry.ts`): errors are classified as retryable (429,
  5xx, `ECONNRESET`-family network failures, request timeouts), non-retryable
  (other 4xx, invalid JSON, API misuse), or abort (caller aborted). Unknown
  errors default to non-retryable so body-validation and misuse failures are
  never replayed.
- **Backoff**: capped exponential — 200ms · 2ⁿ, jittered ×0.9–1.1, at most 4
  retries per request. Retry counts surface as `retries` in tool `details` and
  as a bounded `[note: retried Nx]` suffix in the tool text.
- **Trim-and-retry**: a context-length 400 on `ds_chat` (body mentioning
  context length/window/exceed) trims the oldest replay items — assistant/tool
  turns before user messages — while keeping the system prompt and the most
  recent user message, then retries exactly once. The surviving head of the
  replay stays contiguous so the prompt cache keeps hitting. `trimmed` reports
  the dropped count; if nothing is droppable (e.g. the overflow is the latest
  message itself) the original error propagates.
- **Bounded replay**: threads replay at most 200 items / 600k chars
  (`THREAD_MAX_ITEMS` / `THREAD_MAX_CHARS` in `src/config.ts`), dropping
  oldest first and always keeping the latest user message; `history_items` and
  `trimmed_history` appear in `details` when trimming happened.
- **Interruptions**: aborting a `ds_chat` request never throws a raw abort
  error — the tool returns "Interrupted by the caller." with
  `details: { interrupted: true, phase }` where `phase` is `"request"` or
  `"retry_wait"` (abort during the backoff wait). The thread state is left
  untouched so a later call resumes cleanly.
- **Time note**: on the first `ds_chat` call — or any call while no caller
  system is set — the instructions get a bounded prepended note
  "Current time: YYYY-MM-DDTHH:MMZ." (ISO 8601 UTC, minute precision, so
  repeated calls within a minute do not churn the prompt cache). Callers that
  provide their own system — or already include a time note — are left alone;
  threads remember the original system, never the injected note.

## Reasoning passthrough (the 400 rule)

DeepSeek docs: in thinking mode with tools, `reasoning_content` must be passed
back on every subsequent request or the API returns 400. The runtime's
responses provider handles this natively: `openai-responses-shared.ts` stores
each reasoning item (`thinkingSignature`) and replays the full `reasoning` item
on the next request. Verified against `pi@0.83.0` — no extension-layer fix
needed; the compat flag `requiresReasoningContentOnAssistantMessages` is set on
the model as documentation of the rule.

## API key

Provider registered with `apiKey: "$DEEPSEEK_API_KEY"` (env interpolation).
Fetch-based tools resolve `$DEEPSEEK_API_KEY` first, then fall back to the
`apiKey` configured for `deepseek-responses` in `models.json`. No secrets in
source.

## Standalone (`pi -ne`)

The extension is self-contained: `pi -ne -e ./src/index.ts` (equivalently
`pi --no-extensions -e ./src/index.ts`, or `pi -ne -e .` from the repo root
via the `pi.extensions` manifest in `package.json`) is a complete
environment for the six tools and four commands with no other extension
loaded. pi's CLI help and `docs/usage.md` define `--no-extensions, -ne` as
"Disable extension discovery". The `-ne` flag turns
off discovery of every auto-discovered extension (`~/.pi/agent/extensions/`,
`.pi/extensions/`, `settings.json` entries), while the extension passed
explicitly with `-e` still loads.

The extension does not require pi-chimera or any other extension, and does
not conflict with them when present: pi's docs describe no cross-extension
conflict or name-deduplication behavior, and this extension's tool names
(`ds_chat`, `ds_chat_reset`, `ds_prefix_complete`, `ds_fim`, `ds_web_search`,
`ds_call_function`) and commands (`/ds`, `/ds-cache`, `/ds-balance`,
`/deepseek`) are specific to it.

### Operator verification

1. `pi -ne -e /path/to/pi-seek/src/index.ts` in a scratch directory.
2. Run `/deepseek` — the menu opens: integration on/off, default thinking
effort, one-shot chat, reset threads, remaining balance, cache telemetry,
close.
3. Ask the model to use `ds_chat` (or run `/ds hello`) — the reply renders as
a session entry, and the footer shows `DS v4-flash · cache …` after a turn.
4. Expected failure mode: unset `DEEPSEEK_API_KEY` and ask again — the tool
returns "DeepSeek API key not found: set DEEPSEEK_API_KEY (or configure an
apiKey for the "deepseek-responses" provider in models.json)." instead of
crashing.

## Troubleshooting

- **`DeepSeek API key not found: set DEEPSEEK_API_KEY (or configure an apiKey
for the "deepseek-responses" provider in models.json).`** — the key is
resolved from the `DEEPSEEK_API_KEY` env var first, then from
`providers["deepseek-responses"].apiKey` in `<agentDir>/models.json`
(`src/http.ts:70`; a `${VAR}` placeholder in models.json is resolved
against the environment). Both locations are named in the message.
- **HTTP 400 in thinking mode with tools** — DeepSeek requires
`reasoning_content` to be passed back on every subsequent request or the API
returns 400; the runtime's responses provider replays it natively. See
"Reasoning passthrough (the 400 rule)" above.
- **`DeepSeek request timed out`** — the request timeout scales with the
requested token budget: 90s base + 1ms per token (`max_output_tokens` on
Responses requests, `max_tokens` on beta requests)
(`src/config.ts:15`). Set `DEEPSEEK_REQUEST_TIMEOUT_MS` (seconds) for an
absolute override (`src/config.ts:13`). Timeouts are retryable, so the five
fetch tools retry them up to 4 times with backoff.
- **`[note: retried 2x]` in a tool reply** — transient failures (429/5xx/
network/timeout) were retried with capped exponential backoff; the exact
count is also in the tool `details.retries`. Persistent failures still
surface the last error with its status code and a short body reason (plus a
`(retry after Ns)` hint when the API sent a `Retry-After` header).
- **`Interrupted by the caller.`** — the `ds_chat` request was aborted
mid-request (`details.phase: "request"`) or while waiting between retries
(`details.phase: "retry_wait"`). The thread was not modified, so the next
call resumes from the same history.
- **`DeepSeek API 400: ... context length ...`** — the replay exceeded the
context window. `ds_chat` trims the oldest items (assistant/tool turns
first, keeping the system prompt and the latest user message) and retries
once; `details.trimmed` reports how many items were dropped. If the overflow
is inside the parts that must be kept (e.g. the latest message itself), the
error propagates as-is.
- **`ds_call_function` with a `$ref` schema** — `$ref`/`$def` schemas are
supported: `toStrictSchema` collects definitions from every visited node,
hoists them to a root `$def`, and rewrites refs to `#/$def/<Name>` pointers
(`export { toStrictSchema }` at `src/index.ts:59`).
- **Strict-mode gotchas** — `toStrictSchema` enforces DeepSeek's strict
dialect exactly: object properties are all required with
`additionalProperties: false` (`src/strict-schema.ts:204`); string schemas need
`enum`/`const`/`pattern`/`format`, with formats limited to `email`,
`hostname`, `ipv4`, `ipv6`, `uuid` (`src/strict-schema.ts:7`); numbers accept
`const`/`default`/bounds/`multipleOf`; arrays must not set
`minItems`/`maxItems`.