# DeepSeek API surface research for pi-seek

**Access date:** 2026-08-04  
**Artifact:** read-only research; no implementation changes or authenticated/billable DeepSeek requests were made.

## Executive summary

DeepSeek documents an OpenAI-compatible API with three relevant transport families: stable Chat Completions, a beta FIM/prefix surface, and the newer Responses API. For pi-seek, the most important facts are:

1. The Responses endpoint is `POST https://api.deepseek.com/responses`, currently documented for `deepseek-v4-flash`; the Responses guide says Pro support is planned for early August 2026. [DeepSeek Responses guide](https://api-docs.deepseek.com/guides/responses_api/) · [Responses reference](https://api-docs.deepseek.com/api/create-response/)
2. Responses is stateless. `previous_response_id`, `conversation`, `store`, and server-side response persistence are unsupported; pi-seek's bounded local thread replay is therefore the correct architectural seam. [Responses reference](https://api-docs.deepseek.com/api/create-response/) · [Multi-round guide](https://api-docs.deepseek.com/guides/multi_round_chat/)
3. Responses uses semantic SSE events and a different usage shape from Chat/FIM. Responses cache usage is `usage.input_tokens_details.cached_tokens`; Chat/FIM expose `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. [Responses guide](https://api-docs.deepseek.com/guides/responses_api/) · [Token usage](https://api-docs.deepseek.com/quick_start/token_usage/)
4. The official docs contain material conflicts: the FIM reference names Pro while pricing says FIM is available for both models; the Pi integration page lists a Flash cache-read price ten times the canonical pricing table. These conflicts must become explicit compatibility/verification gates, not speculative code changes. [FIM reference](https://api-docs.deepseek.com/api/create-completion/) · [Pricing](https://api-docs.deepseek.com/quick_start/pricing/) · [Pi integration](https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono/)
5. Highest-value pi-seek work is contract testing and accounting hardening: model/endpoint matrices, event fixtures, usage-field separation, local function-argument validation, registration/composition tests, and protection against malformed numeric/balance payloads.

### Evidence labels

- **Verified fact:** directly stated or structurally shown by an official source, or directly observed in local source.
- **Observed local behavior:** what the checked pi-seek files/tests currently do; not evidence that the remote API accepts it.
- **Inference:** a reasoned compatibility or risk conclusion from verified facts and local behavior.
- **Recommendation:** proposed work, not a current API fact.
- **Unresolved:** conflicting, absent, or approval-gated evidence.

## Research workflow and scope

The workflow used Fabric with the root and all newly launched workers explicitly assigned to `openai-codex/gpt-5.6-luna` with `thinking: high`. Workers were bounded and read-only. The original run's three completed scout result payloads (`responses-surface`, `capabilities-models`, and `changelog-compat`) were not present in the live participant registry after interruption; their subject matter was independently re-covered in the completed API-reference memo and final synthesis rather than treated as unrecoverable evidence. Only the two incomplete lanes were rerun, followed by one synthesis worker. No worker edited the repository.

The review covered the starting Responses guide and linked/relevant official DeepSeek navigation, API references, operational guides, examples, integrations, updates/news, plus first-party OpenAI Responses and JSON Schema references where compatibility matters. It did not call DeepSeek's API, `/models`, `/user/balance`, or any billable endpoint.

## Source inventory and site map

### DeepSeek API and reference

- [API overview](https://api-docs.deepseek.com/api/deepseek-api) — base URL, authentication, compatibility overview.
- [Create chat completion](https://api-docs.deepseek.com/api/create-chat-completion) — stable Chat Completions request/response fields.
- [Create completion](https://api-docs.deepseek.com/api/create-completion) — beta FIM completion reference.
- [Create response](https://api-docs.deepseek.com/api/create-response) — Responses request/response reference.
- [List models](https://api-docs.deepseek.com/api/list-models) — `GET /models`.
- [Get user balance](https://api-docs.deepseek.com/api/get-user-balance) — `GET /user/balance`.

### Starting guide and linked/relevant guides

- [Responses API guide](https://api-docs.deepseek.com/guides/responses_api) — lifecycle, examples, tools, semantic streaming.
- [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) — reasoning/thinking request behavior.
- [Multi-round chat](https://api-docs.deepseek.com/guides/multi_round_chat) — local/stateless continuation pattern.
- [Chat prefix completion](https://api-docs.deepseek.com/guides/chat_prefix_completion) — assistant-prefix beta behavior.
- [FIM completion](https://api-docs.deepseek.com/guides/fim_completion) — fill-in-the-middle behavior.
- [JSON mode](https://api-docs.deepseek.com/guides/json_mode) — JSON output caveats.
- [Context caching](https://api-docs.deepseek.com/guides/kv_cache) — automatic prefix caching.
- [Tool calls](https://api-docs.deepseek.com/guides/tool_calls) — function tools and strict mode.
- [Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api) and [coding agents](https://api-docs.deepseek.com/guides/coding_agents) — compatibility/integration context.

### Operations, examples, and release history

- [Pricing](https://api-docs.deepseek.com/quick_start/pricing), [token usage](https://api-docs.deepseek.com/quick_start/token_usage), [rate limits](https://api-docs.deepseek.com/quick_start/rate_limit), and [error codes](https://api-docs.deepseek.com/quick_start/error_codes).
- [Pi integration](https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono), [Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex), and [Claude Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code).
- [Chat cURL](https://api-docs.deepseek.com/api_samples/chat_curl), [Node.js](https://api-docs.deepseek.com/api_samples/chat_nodejs), [Python](https://api-docs.deepseek.com/api_samples/chat_python), and thinking/tool-call examples: [non-streaming](https://api-docs.deepseek.com/api_samples/thinking_mode_api_example_non_streaming), [streaming](https://api-docs.deepseek.com/api_samples/thinking_mode_api_example_streaming), [tool call](https://api-docs.deepseek.com/api_samples/thinking_mode_api_example_tool_call), [tool output](https://api-docs.deepseek.com/api_samples/thinking_mode_api_example_tool_call_output).
- [Change Log](https://api-docs.deepseek.com/updates), [V4 announcement](https://api-docs.deepseek.com/news/news260424), and [V3.2 announcement](https://api-docs.deepseek.com/news/news251201).

### Dates and update metadata

- **Verified page/update date:** the official change log shows a latest update dated **2026-07-31**, announcing public-beta V4 Flash and Responses/Codex support. [Change Log](https://api-docs.deepseek.com/updates)
- **Verified announcement date:** the V4 preview announcement is dated **2026-04-24**. [V4 announcement](https://api-docs.deepseek.com/news/news260424)
- Most API reference and guide pages reviewed expose no separate visible publication/update date. The report therefore records the access date rather than assigning an unsupported page date.

### First-party protocol/spec references

- [OpenAI Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create) — protocol-shaped comparison only; DeepSeek's own reference controls DeepSeek behavior.
- [JSON Schema reference](https://json-schema.org/understanding-json-schema/) — schema vocabulary comparison only; DeepSeek's strict-tool subset controls acceptance.

## Capability and compatibility matrix

| Surface | Official endpoint/base | Documented model(s) | Relevant behavior | pi-seek mapping |
|---|---|---|---|---|
| Responses | `POST /responses` on `https://api.deepseek.com` | `deepseek-v4-flash`; Pro planned in guide | Stateless; string/array input; reasoning, function calls, web search; semantic SSE | `src/responses.ts`, `src/lifecycle.ts`, `src/tools.ts` |
| Chat Completions | `POST /chat/completions` | V4 Flash and Pro | Text, thinking, JSON object, function tools, data-only SSE | `src/chat.ts`, `src/tools.ts` |
| Prefix completion | `POST /chat/completions` on beta base `https://api.deepseek.com/beta` | Examples use Pro; Flash availability unresolved | Final assistant message must use `prefix: true` | `src/tools.ts`, `src/config.ts` |
| FIM | `POST /completions` on beta base | Reference lists Pro; pricing says both | `max_tokens` cap is 4K | `src/tools.ts`, `src/config.ts`, `src/params.ts` |
| Balance | `GET /user/balance` | Account operation | Bearer auth; response contains balance information | `src/balance.ts`, `src/commands.ts` |
| Models | `GET /models` | Account/model discovery | Official listing endpoint; not called during this research | No current adapter call |

**Verified external facts:** base URL, paths, model names, and limits are from the linked DeepSeek references above. **Observed local behavior:** the provider registers `deepseek-v4-flash`, a 1,048,576-token context window, and 393,216 max tokens in `src/lifecycle.ts`; this is close to the documented 1M/384K model figures but is not a remote probe. **Recommendation:** centralize these versioned facts and test registration against one source of truth.

## Responses API lifecycle and state model

### Non-streaming request lifecycle

1. Construct a request with `model` and at least one of `input` or `instructions`. [Create response](https://api-docs.deepseek.com/api/create-response/)
2. `instructions` is inserted as the first system message. Input can be a string or item array; message roles include `user`, `assistant`, `system`, and `developer`, with `developer` treated as `system`. [Responses guide](https://api-docs.deepseek.com/guides/responses_api/)
3. The service returns an object with `object: "response"`, `status`, `output`, optional `error`/`incomplete_details`, and `usage`. [Create response](https://api-docs.deepseek.com/api/create-response/)
4. Output items can be messages, reasoning items, function calls, or web-search calls. Function-call arguments are JSON text and must be checked by the caller. [Responses guide](https://api-docs.deepseek.com/guides/responses_api/) · [Tool calls](https://api-docs.deepseek.com/guides/tool_calls/)
5. For a tool loop, submit a matching `function_call_output` with the same nonempty, unique `call_id`; local state must preserve the sequence. [Create response](https://api-docs.deepseek.com/api/create-response/)
6. The API remains stateless: pi-seek must replay bounded local state instead of relying on `previous_response_id`, `conversation`, or `store`. [Create response](https://api-docs.deepseek.com/api/create-response/)

### State machine

```text
local thread
  ├─ build input/instructions
  ├─ POST /responses
  │    ├─ response.in_progress
  │    ├─ output item(s): message/reasoning/function_call/web_search_call
  │    └─ terminal: completed | incomplete | failed
  ├─ if function_call: execute/validate locally
  ├─ append function_call_output with matching call_id
  └─ replay bounded local items for the next request
```

**Verified statuses:** `in_progress`, `completed`, `incomplete`, and `failed`. [Create response](https://api-docs.deepseek.com/api/create-response/)  
**Observed local behavior:** `src/threads.ts` bounds replay to 200 items or 600,000 estimated characters and has a 100-item/300,000-character context retry. This fits the stateless model and should remain bounded.  
**Inference:** preserving exact output item types and call IDs is more important than attempting server-side conversation persistence, which DeepSeek documents as unsupported.

## Request/response schemas and examples

The following are compact, evidence-oriented shapes, not a replacement for the official schemas.

### Responses request

```json
{
  "model": "deepseek-v4-flash",
  "instructions": "You are a coding assistant.",
  "input": [
    {"role": "user", "content": [{"type": "input_text", "text": "Inspect this change."}]}
  ],
  "reasoning": {"effort": "high"},
  "max_output_tokens": 4096,
  "stream": false,
  "tools": [
    {"type": "function", "name": "lookup", "description": "Look up a value", "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": false}}
  ]
}
```

**Verified constraints:** `input` or `instructions` is required; `max_output_tokens` includes visible and reasoning tokens; `text.format` supports `text`, `json_object`, or `json_schema`; function names are unique, nonempty, alphanumeric/underscore/hyphen, and at most 128 characters; `top_logprobs` is 0–20. [Create response](https://api-docs.deepseek.com/api/create-response/)

### Responses result

```json
{
  "id": "response-id",
  "object": "response",
  "created_at": 0,
  "status": "completed",
  "model": "deepseek-v4-flash",
  "output": [
    {"type": "reasoning", "summary": [{"type": "reasoning_text", "text": "..."}]},
    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Done."}]}
  ],
  "usage": {
    "input_tokens": 100,
    "input_tokens_details": {"cached_tokens": 80},
    "output_tokens": 30,
    "output_tokens_details": {"reasoning_tokens": 10},
    "total_tokens": 130
  }
}
```

The response fields and usage paths above are documented in [Create response](https://api-docs.deepseek.com/api/create-response/) and [Token usage](https://api-docs.deepseek.com/quick_start/token_usage/). Exact optional output-item details should be treated as source-versioned fixtures.

### Function-call loop

```json
{"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{\"key\":\"value\"}"}
```

After local execution and validation:

```json
{"type":"function_call_output","call_id":"call-1","output":"{\"result\":\"value\"}"}
```

**Verified:** matching, nonempty, unique `call_id` values are required. **Recommendation:** reject invalid JSON or schema-invalid arguments before tool execution; do not treat JSON parsing alone as validation.

### Chat/FIM compatibility shape

Chat uses `messages` plus `model`; FIM uses `prompt`, optional `suffix`, and `max_tokens` with a 4K maximum. Chat/FIM use data-only SSE and `[DONE]`, unlike Responses semantic SSE. [Chat reference](https://api-docs.deepseek.com/api/create-chat-completion/) · [FIM reference](https://api-docs.deepseek.com/api/create-completion/) · [FIM guide](https://api-docs.deepseek.com/guides/fim_completion/)

## Streaming and event model

### Responses events

Responses streaming uses semantic SSE with monotonically increasing `sequence_number` and no `[DONE]` marker. The documented event families are:

| Event | State transition / pi-seek implication |
|---|---|
| `response.created` | establish response identity |
| `response.in_progress` | request accepted, not terminal |
| `response.output_item.added` / `.done` | open/close message, reasoning, call, or search item |
| `response.content_part.added` / `.done` | open/close content part |
| `response.reasoning_text.delta` / `.done` | accumulate reasoning text |
| `response.output_text.delta` / `.done` | accumulate visible text |
| `response.function_call_arguments.delta` / `.done` | accumulate arguments before executing a function |
| `response.custom_tool_call_input.delta` / `.done` | accumulate custom-tool input if used |
| `response.web_search_call.in_progress` / `.searching` / `.completed` | represent server-side search lifecycle |
| `response.completed` / `.incomplete` / `.failed` | terminal response state |

Sources: [Responses guide](https://api-docs.deepseek.com/guides/responses_api/) and [Create response](https://api-docs.deepseek.com/api/create-response/).

**Operational facts:** streaming requests may receive `: keep-alive` comments; if inference has not started after 10 minutes, the server closes the connection. [Rate limits](https://api-docs.deepseek.com/quick_start/rate_limit/)

**Recommendation:** add event fixtures that assert sequence ordering, accumulation, terminal handling, keep-alive ignoring, incomplete/failed mapping, and no dependence on `[DONE]` for Responses.

## Tools, reasoning, JSON, and structured output

- Responses reasoning effort is documented as `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; Chat thinking uses enabled/disabled and also accepts `reasoning_effort` values documented by the Chat surface. [Create response](https://api-docs.deepseek.com/api/create-response/) · [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- Responses `temperature` is 0–2 and has no effect in thinking mode; `top_p` is 0–1 and likewise has no effect in thinking mode. [Create response](https://api-docs.deepseek.com/api/create-response/)
- Responses supports function tools and server-side `web_search`; Chat documents function tools only. [Responses guide](https://api-docs.deepseek.com/guides/responses_api/) · [Tool calls](https://api-docs.deepseek.com/guides/tool_calls/)
- Chat JSON mode uses `response_format: {"type":"json_object"}` and the prompt should explicitly request JSON; insufficient output budget can truncate JSON and empty output can occur. [JSON mode](https://api-docs.deepseek.com/guides/json_mode/)
- Beta strict tools require `strict: true`. Documented supported vocabulary includes object, string, number, integer, boolean, array, enum, `anyOf`, `$def`, and `$ref`; object properties must be required and objects must set `additionalProperties: false`. [Tool calls](https://api-docs.deepseek.com/guides/tool_calls/) · [JSON Schema](https://json-schema.org/understanding-json-schema/)
- Unsupported schema constraints include `minLength`, `maxLength`, `minItems`, and `maxItems` in the documented strict subset. [Tool calls](https://api-docs.deepseek.com/guides/tool_calls/)

**Inference for pi-seek:** `src/strict-schema.ts` should remain a compatibility normalizer, but normalization is not runtime validation. Add a second, explicit validation step or clearly report that the provider only validates syntax.

## Caching, usage, pricing, and limits

### Usage accounting matrix

| Surface | Cache fields | Generation fields | Local risk |
|---|---|---|---|
| Responses | `input_tokens_details.cached_tokens` | `output_tokens_details.reasoning_tokens`, `output_tokens`, `total_tokens` | Do not reuse Chat field names or infer cache-write billing. |
| Chat/FIM | `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens` | `completion_tokens_details.reasoning_tokens`, `completion_tokens`, `total_tokens` | Preserve hit/miss fields independently. |

Sources: [Token usage](https://api-docs.deepseek.com/quick_start/token_usage/) and [Create response](https://api-docs.deepseek.com/api/create-response/).

### Context and output limits

The model pages document 1M context and 384K maximum output for V4 Flash and V4 Pro. FIM separately documents a 4K maximum output cap. [Pricing/models](https://api-docs.deepseek.com/quick_start/pricing/) · [FIM reference](https://api-docs.deepseek.com/api/create-completion/)

**Observed local behavior:** `src/lifecycle.ts` registers 1,048,576 context and 393,216 max tokens; `src/params.ts` preserves a 4K FIM cap. **Recommendation:** add explicit tests for these registrations and keep model limits versioned rather than duplicated.

### Pricing

The canonical pricing table lists per 1M tokens:

| Model | Cache hit | Cache miss | Output |
|---|---:|---:|---:|
| `deepseek-v4-flash` | $0.0028 | $0.14 | $0.28 |
| `deepseek-v4-pro` | $0.003625 | $0.435 | $0.87 |

Source: [Pricing](https://api-docs.deepseek.com/quick_start/pricing/). The [Pi integration page](https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono/) visibly gives Flash cache-read as `$0.028`, conflicting with the canonical table. The pricing page also mentions possible future 2× peak-hour pricing without an effective date. Cache writes have no separately published current price in the reviewed material.

**Observed local behavior:** `src/config.ts` hardcodes `COST`; `src/telemetry.ts` estimates cost and currently treats cache-write cost as zero. **Inference:** displayed costs are not authoritative and can be wrong after pricing/version changes.

### Rate limits, authentication, and errors

- Auth is `Authorization: Bearer <API key>` against `https://api.deepseek.com`. [API overview](https://api-docs.deepseek.com/api/deepseek-api/)
- Documented HTTP errors: 400 invalid format, 401 authentication failure, 402 insufficient balance, 422 invalid parameters, 429 rate/concurrency limit, 500 server error, and 503 overload. [Error codes](https://api-docs.deepseek.com/quick_start/error_codes/)
- Concurrency is documented account-wide: 500 for V4 Pro and 2,500 for V4 Flash; increased-quota accounts may also be limited by `user_id`. `user_id` can provide content-safety, KV-cache, and scheduling isolation. [Rate limits](https://api-docs.deepseek.com/quick_start/rate_limit/)
- Retry-After semantics, idempotency keys, and a formal retry taxonomy were not found in the reviewed official pages. **Unresolved.**

**Observed local behavior:** `src/http.ts` builds bearer-authenticated JSON GET/POST requests; `src/retry.ts` and `src/chat.ts` classify/retry selected failures. **Observed mismatch:** README says all five fetch tools retry transient failures, but source wraps only `ds_chat` and `ds_call_function`; prefix, FIM, and web search call adapters directly.

## Current pi-seek state map

| Concern | Files/symbols | Current behavior | Evidence status |
|---|---|---|---|
| Composition | `src/index.ts` | Constructs auth, HTTP, Responses/Beta adapters, telemetry, balance, threads; registers tools/commands/renderers/lifecycle | Observed local |
| Provider | `src/lifecycle.ts:registerProvider` | `deepseek-responses`, model `deepseek-v4-flash`, `openai-responses`, 1,048,576 context, 393,216 max tokens, hardcoded costs | Observed local |
| Transport | `src/http.ts` | Bearer auth; JSON GET/POST; env key then `<agentDir>/models.json` precedence | Observed local |
| Responses | `src/responses.ts` | `POST /responses`; builds/consumes Responses payloads and outputs | Observed local |
| Beta | `src/config.ts`, `src/tools.ts` | Prefix `/beta/chat/completions`, FIM `/beta/completions`, function call `/beta/chat/completions` | Observed local |
| Tools | `src/tools.ts` | `ds_chat`, reset, prefix, FIM, web search, function call | Observed local |
| Threads | `src/threads.ts` | Replay bounded at 200 items/600K estimated chars; tighter context retry | Observed local |
| Retries | `src/chat.ts`, `src/retry.ts` | Chat recovery and function-call retry; no wrapper for prefix/FIM/web search | Observed local |
| Usage | `src/telemetry.ts` | Maps Responses/Chat usage, estimates local cost, caps 100 records, restores `ds-usage` | Observed local |
| Balance | `src/balance.ts`, `src/config.ts`, `src/commands.ts` | Parses `balance_infos`, prefers USD, stale-cache fallback and summaries | Observed local |
| Metadata | `src/lifecycle.ts`, `src/config.ts`, `models.json`, `README.md` | Duplicated provider/model/cost information | Observed local |
| Schema | `src/strict-schema.ts` | Normalizes strict schema keywords/references | Observed local |

### Test map and coverage gaps

Existing mocked tests cover auth (`tests/auth.test.ts`), balance (`tests/balance.test.ts`), body builders (`tests/body-builders.test.ts`), payload defaults (`tests/payload.test.ts`), HTTP (`tests/http.test.ts`), retry and chat recovery, telemetry/ledger, thread trim/restore/filtering, Responses extraction, function-call extraction, strict-schema conversion, timeout, and smoke loading. The complete inventory is visible in the repository's `tests/` directory.

No test directly covers command registration, lifecycle/provider registration, renderer registration, complete tool execution, exact composed URLs, auth headers end-to-end, or balance-command rendering. Tests were inspected but not executed during research.

## File/test-specific gap and risk matrix

| Priority | Verified fact + local observation | Risk | Recommended evidence/test |
|---|---|---|---|
| P0 | FIM reference says Pro; pricing says both; local beta model metadata is hardcoded | Switching to Flash or assuming Pro support can break prefix/FIM | Add a model/surface compatibility matrix fixture and keep Flash/Pro behavior approval-gated until docs reconcile or a permitted live test proves it |
| P1 | Responses and Chat/FIM usage field names differ; local telemetry maps both | Cache hit/miss and cost reports can silently drift | Add separate fixtures for all usage shapes, missing fields, zero values, malformed numbers, and reasoning tokens |
| P1 | Function arguments may be invalid; local `ds_call_function` parses but does not schema-validate | Tool may execute invalid or unsafe arguments | Test valid JSON/schema-valid, valid JSON/schema-invalid, invalid JSON, missing call ID, and duplicate call ID |
| P1 | README retry claim conflicts with source | Users get incorrect reliability expectations | Correct documentation or add explicit wrappers; test transient/4xx/timeout/abort per tool |
| P2 | Provider metadata is duplicated | Model limits, costs, API type, or endpoints can drift | Add a registration contract test and one source-of-truth metadata fixture |
| P2 | Successful unexpected balance/usage payloads can become zero, negative, NaN, or misleading | Account/cost UI lies without a hard failure | Reject non-finite values and distinguish unavailable/malformed from zero |
| P2 | No registration/composed-tool integration coverage | A valid unit payload can still be wired to the wrong endpoint/tool | Mock HTTP and assert provider, commands, renderers, all six tools, paths, methods, headers, and payloads |
| P3 | Interrupt before first request can leave thread `system` metadata changed | Retry/reset state can be inconsistent | Add an interruption test asserting atomic thread metadata/item behavior |
| P3 | `/deepseek` runtime enable/effort changes are in-memory only | Restart loses operator state | Decide explicitly whether persistence is desired; if yes, add a test and documented storage contract |

## Prioritized improvement backlog with acceptance tests

### P0 — Compatibility gates before behavior changes

- Record a versioned matrix for model × surface × endpoint × streaming × tools × reasoning × limits.
- Mark V4 Flash beta prefix/FIM availability as unresolved; do not infer it from pricing alone.
- Acceptance: fixture tests make the current unresolved matrix visible and fail on accidental model/endpoint changes; any live verification requires approval and credentials.

### P1 — Make Responses lifecycle and usage contracts explicit

- Add event fixtures for every documented Responses event family, monotonic sequence numbers, delta accumulation, terminal states, keep-alives, incomplete, and failed responses.
- Add usage fixtures separating Responses cached tokens from Chat/FIM hit/miss tokens and reasoning-token paths.
- Acceptance: tests prove no `[DONE]` requirement for Responses and no cross-surface field substitution.

### P1 — Validate function-call outputs locally

- Preserve strict-schema normalization, then validate parsed arguments before execution and reject invalid JSON/schema data with a typed, user-visible error.
- Acceptance: malformed JSON, missing/duplicate call IDs, and schema-invalid arguments never execute; valid arguments execute once.

### P1 — Correct retry contract

- Either update README to state the actual retry set or add deliberate retries to prefix/FIM/web search with the shared taxonomy and interruption semantics.
- Acceptance: every registered fetch tool has a test for transient failure, 4xx non-retry, timeout, abort, and retry-wait interruption.

### P2 — Centralize and test provider metadata

- Remove or mechanically verify duplicated model/limits/cost/API metadata in `src/lifecycle.ts`, `src/config.ts`, and `models.json`.
- Acceptance: one registration contract test confirms provider ID, model ID, API type, context/max tokens, costs, endpoints, tools, commands, and renderers.

### P2 — Harden accounting and balance parsing

- Reject non-finite numeric values; preserve unknown/malformed balance responses as unavailable rather than zero; keep cache-write billing explicitly unknown until officially priced.
- Acceptance: malformed, negative, absent, and unexpected 200 payloads are distinguishable from valid zero balances and produce finite telemetry.

### P3 — Add safe, mocked end-to-end coverage

- Cover exact URL composition, bearer headers without logging secrets, request bodies, response extraction, tool registration, command rendering, and interruption behavior.
- Acceptance: all tests remain unauthenticated/local-mock; no test requires credits or real credentials.

## Unresolved questions

1. Did Responses Pro support ship after the guide's early-August plan, and is it accepted by `POST /responses`?
2. Does V4 Flash support beta prefix/FIM despite the FIM reference naming Pro?
3. What exact numeric request limits apply to `max_tokens` and `max_output_tokens` beyond the model maximums?
4. Is cache-write billing separate, and what is its current price?
5. Which full field-level schemas and error payloads apply to every Responses SSE event?
6. What are the official Retry-After, idempotency, and retry recommendations?
7. What is the complete `GET /user/balance` schema and exact meaning of `is_available`?
8. Is DeepSeek's `openai-responses` compatibility path formally supported by Pi, or merely protocol-shaped compatibility?
9. Should pi-seek persist `/deepseek` runtime state across restarts?

## Approval-gated live-test plan

No live test was run. With explicit user approval, a credential supplied for this purpose, and a non-production/test account:

1. `GET /models` — record only model IDs and documented metadata; redact keys and account data.
2. `GET /user/balance` — verify schema and currency handling; do not expose balance details in logs.
3. Minimal `POST /responses` with Flash — verify response status, output item types, reasoning fields, usage paths, and streaming terminal events.
4. Minimal beta prefix and FIM calls for each documented candidate model — verify actual availability, 4K FIM cap, and endpoint behavior.
5. Strict function-call test with a valid schema plus provider-returned invalid-argument fixture handling; never execute an untrusted returned call.
6. Retry/429/5xx behavior only through a provider-provided safe test facility; do not intentionally induce production rate limits.

All live tests must be opt-in, bounded, redacted, and stopped before any paid multi-token experiment.

## Validation, coverage, and limitations

- **Link validation:** 36 cited public URLs were checked with unauthenticated `curl -L` GET requests on 2026-08-04; all returned HTTP 200. DeepSeek documentation URLs normalized with a trailing slash. The OpenAI reference resolved without a trailing slash; JSON Schema resolved to its `/reference` page.
- **Source coverage:** API overview, endpoints, request/response references, starting Responses guide, relevant guides, operations, examples, integrations, updates/news, OpenAI Responses protocol reference, and JSON Schema reference are inventoried above.
- **Repository validation:** local source and test inventory was read-only; tests were not executed. No source file was modified.
- **Worktree preservation:** pre-existing `package.json` modification and untracked `.pi/` and `skills/` content were preserved. The only intended new artifact is this Markdown file.
- **Limitations:** public documentation can be internally inconsistent; no authenticated API behavior, live model availability, account limits, response event payloads beyond published examples, or billing behavior was probed. Claims labeled unresolved must not be promoted to implementation facts without refreshed primary evidence.

## Appendix: official URL inventory

The complete URL set checked for this report is:

```text
https://api-docs.deepseek.com/
https://api-docs.deepseek.com/api/deepseek-api
https://api-docs.deepseek.com/api/create-chat-completion
https://api-docs.deepseek.com/api/create-completion
https://api-docs.deepseek.com/api/create-response
https://api-docs.deepseek.com/api/list-models
https://api-docs.deepseek.com/api/get-user-balance
https://api-docs.deepseek.com/quick_start/pricing
https://api-docs.deepseek.com/quick_start/token_usage
https://api-docs.deepseek.com/quick_start/rate_limit
https://api-docs.deepseek.com/quick_start/error_codes
https://api-docs.deepseek.com/guides/responses_api
https://api-docs.deepseek.com/guides/thinking_mode
https://api-docs.deepseek.com/guides/multi_round_chat
https://api-docs.deepseek.com/guides/chat_prefix_completion
https://api-docs.deepseek.com/guides/fim_completion
https://api-docs.deepseek.com/guides/json_mode
https://api-docs.deepseek.com/guides/kv_cache
https://api-docs.deepseek.com/guides/tool_calls
https://api-docs.deepseek.com/guides/anthropic_api
https://api-docs.deepseek.com/guides/coding_agents
https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono
https://api-docs.deepseek.com/quick_start/agent_integrations/codex
https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
https://api-docs.deepseek.com/api_samples/chat_curl
https://api-docs.deepseek.com/api_samples/chat_nodejs
https://api-docs.deepseek.com/api_samples/chat_python
https://api-docs.deepseek.com/api_samples/thinking_mode_api_example_non_streaming
https://api-docs.deepseek.com/api_samples/thinking_mode_api_example_streaming
https://api-docs.deepseek.com/api_samples/thinking_mode_api_example_tool_call
https://api-docs.deepseek.com/api_samples/thinking_mode_api_example_tool_call_output
https://api-docs.deepseek.com/updates
https://api-docs.deepseek.com/news/news260424
https://api-docs.deepseek.com/news/news251201
https://developers.openai.com/api/reference/resources/responses/methods/create
https://json-schema.org/understanding-json-schema/
```
