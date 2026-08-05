# Live verification evidence — 2026-08-04

Authenticated live probes of the DeepSeek Responses API run on 2026-08-04 by
the pi-seek live-verification swarm (mesh task registry
`runs/live-2026-08-04`). All requests used the repo's own HTTP client and the
key in `~/.pi/agent/models.json` (via `createAuthService`); the key,
Authorization headers, and models.json contents were never printed, logged, or
stored. Every request was bounded: `max_tokens <= 64` with trivial prompts,
except the FIM 4096/4097 boundary probes. No API key or balance amount appears
in this document or in any mesh record.

| Lane (task id) | Date | Models used | Request shape | Result summary |
| --- | --- | --- | --- | --- |
| models | 2026-08-04 | none (GET) | `GET /models`, 1 call | 200; ids `deepseek-v4-flash` and `deepseek-v4-pro`; per-model fields `id`, `object`, `owned_by` |
| balance | 2026-08-04 | none (GET) | `GET /user/balance`, 1 call | 200; top-level fields `is_available` and `balance_infos`; entries carry `granted_balance`, `topped_up_balance`, `total_balance`; `is_available: false` observed (amounts withheld, none recorded) |
| responses-flash | 2026-08-04 | deepseek-v4-flash | `POST /responses`, stream:false, trivial prompt, max_tokens <= 64 | 200; status `completed`; output items `reasoning` + `message`; usage paths `input_tokens_details.cached_tokens` and `output_tokens_details.reasoning_tokens` |
| responses-pro | 2026-08-04 | deepseek-v4-pro | `POST /responses`, trivial prompt, max_tokens <= 64 | 400 rejected; error states Codex integration with deepseek-v4-pro will be available starting early August 2026 and asks to use deepseek-v4-flash |
| streaming | 2026-08-04 | deepseek-v4-flash | `POST /responses` stream:true, 1 call | SSE event families `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.reasoning_text.delta`, `response.reasoning_text.done`, `response.content_part.done`, `response.output_item.done`, `response.incomplete`; `sequence_number` monotonic; no keep-alive comments; no `[DONE]`; terminal event `response.incomplete` |
| prefix-fim | 2026-08-04 | deepseek-v4-flash, deepseek-v4-pro | beta `/chat/completions` prefix (flash, pro); beta `/completions` FIM (flash, pro); FIM max_tokens 4096 and 4097 boundary probes | prefix and FIM accepted on both models (HTTP 200); FIM `max_tokens: 4097` also accepted (HTTP 200), contradicting the documented 4K cap |
| function-call | 2026-08-04 | deepseek-v4-flash | `POST /responses` strict function call `make_snippet`, valid + two invalid fixtures | strict call live: `tool_call_id` present, name `make_snippet`, arguments valid JSON accepted; invalid fixtures rejected with typed validator messages (enum violation, missing required property, out-of-range minimum) |

Bound guarantees: at most one retry per failed request; lanes stopped on
repeated 429/5xx (none occurred); total spend far below one US cent. No key,
no balance amount, no full SSE payload (only event names and sequence
numbers), and no long model outputs (truncated to 200 chars) are included
anywhere in this log.
