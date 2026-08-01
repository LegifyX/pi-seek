# pi-seek — DeepSeek V4 Flash toolset for pi

A pi extension that turns DeepSeek V4 Flash's Responses API into a complete
toolset.

## Installation

**Requirements**: pi ≥ 0.83.0 (the release this extension is verified against;
see "Reasoning passthrough" below) and Node ≥ 22
(`@earendil-works/pi-coding-agent` requires `node >=22.19.0`).

1. **Load the extension.** pi's `docs/extensions.md` ("Extension Locations")
auto-discovers one-file extensions from `~/.pi/agent/extensions/*.ts` (global)
or `.pi/extensions/*.ts` (project-local); `docs/usage.md` documents the
explicit form `-e` / `--extension <source>` — "Load an extension from path,
npm, or git; repeatable". Either copy `deepseek-v4.ts` into one of the
auto-discovered locations, or run `pi -e /path/to/deepseek-v4.ts`.
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
three commands (`/ds`, `/ds-cache`, `/deepseek`) — see the table below.

## What it provides

| Piece | Phase | Notes |
|---|---|---|
| `deepseek-responses` provider (`deepseek-v4-flash`) | 1 | `api: "openai-responses"`, base `https://api.deepseek.com`, apiKey `$DEEPSEEK_API_KEY`, thinking levels `off→none, minimal/low→low, medium/high→high, xhigh→high (clamped), max→max`, contextWindow 1,048,576, maxTokens 393,216, cost input 0.14 / output 0.28 / cacheRead 0.0028 / cacheWrite 0 (per 1M, from the pricing page) |
| `before_provider_request` guard | 1 | Strips `temperature`/`top_p` while thinking mode is on (the default); the Responses API ignores them in thinking mode but payloads stay clean |
| `ds_chat` / `ds_chat_reset` | 2 | Named, stateful threads. The DeepSeek Responses API is stateless (`previous_response_id` unsupported), so each round replays full history — same mechanism the runtime itself uses. State persists in tool-result `details`, restored from the session branch |
| `ds_prefix_complete` | 3 | Beta `https://api.deepseek.com/beta/chat/completions`, assistant `prefix: true` message + `stop` |
| `ds_fim` | 3 | Beta `https://api.deepseek.com/beta/completions`, `prompt`/`suffix`/`max_tokens` (4K cap) |
| `ds_web_search` | 4 | Server-side `web_search` tool via the Responses API |
| `ds_call_function` + `toStrictSchema` | 4 | Strict-mode function calling at `/beta`, with a TypeBox→strict JSON-Schema converter honoring DeepSeek's strict dialect exactly (object: all required + `additionalProperties:false`; string: pattern/format only; number/integer: const/default/bounds/multipleOf; array: no min/maxItems; enum/anyOf/$ref/$def) |
| `ds_cache`-style telemetry | 5 | `/ds-cache` command, footer `ctx.ui.setStatus` while the provider is active (hit/miss + cost), per-message cost incl. cacheRead/cacheWrite on `turn_end`, hit/miss on every tool call |
| `/ds` command | 5 | One-shot chat with DeepSeek, rendered as a session entry |

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

The extension is self-contained: `pi -ne -e deepseek-v4.ts` (equivalently
`pi --no-extensions -e deepseek-v4.ts`) is a complete environment for the six
tools and three commands with no other extension loaded. pi's CLI help and
`docs/usage.md` define `--no-extensions, -ne` as "Disable extension discovery
(explicit -e paths still work)": `-ne` turns off discovery of every
auto-discovered extension (`~/.pi/agent/extensions/`, `.pi/extensions/`,
`settings.json` entries), while the extension passed explicitly with `-e`
still loads.

The extension does not require pi-chimera or any other extension, and does
not conflict with them when present: pi's docs describe no cross-extension
conflict or name-deduplication behavior, and this extension's tool names
(`ds_chat`, `ds_chat_reset`, `ds_prefix_complete`, `ds_fim`, `ds_web_search`,
`ds_call_function`) and commands (`/ds`, `/ds-cache`, `/deepseek`) are
specific to it.

### Operator verification

1. `pi -ne -e /path/to/deepseek-v4.ts` in a scratch directory.
2. Run `/deepseek` — the menu opens: integration on/off, default thinking
effort, one-shot chat, reset threads, cache telemetry, close.
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
(`deepseek-v4.ts:221`). Both locations are named in the message.
- **HTTP 400 in thinking mode with tools** — DeepSeek requires
`reasoning_content` to be passed back on every subsequent request or the API
returns 400; the runtime's responses provider replays it natively. See
"Reasoning passthrough (the 400 rule)" above.
- **`DeepSeek request timed out`** — the request timeout scales with
`max_output_tokens`: 90s base + 1ms per requested output token
(`deepseek-v4.ts:29`–`42`). Set `DEEPSEEK_REQUEST_TIMEOUT_MS` (seconds) for an
absolute override (`deepseek-v4.ts:31`).
- **`ds_call_function` with a `$ref` schema** — `$ref`/`$def` schemas are
supported: `toStrictSchema` collects definitions from every visited node,
hoists them to a root `$def`, and rewrites refs to `#/$def/<Name>` pointers
(`export { toStrictSchema }` at `deepseek-v4.ts:2017`).
- **Strict-mode gotchas** — `toStrictSchema` enforces DeepSeek's strict
dialect exactly: object properties are all required with
`additionalProperties: false` (`deepseek-v4.ts:917`); string schemas need
`enum`/`const`/`pattern`/`format`, with formats limited to `email`,
`hostname`, `ipv4`, `ipv6`, `uuid` (`deepseek-v4.ts:730`); numbers accept
`const`/`default`/bounds/`multipleOf`; arrays must not set
`minItems`/`maxItems`.
