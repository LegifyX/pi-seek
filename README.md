# pi-seek — DeepSeek V4 Flash toolset for pi

A pi extension that turns DeepSeek V4 Flash's Responses API into a complete
toolset.

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

## Verify

```sh
./verify.sh            # live checks (requires a key; falls back to models.json)
```

Phases verified live on 2026-07-31 against `pi@0.83.0` (see verify.sh output).
