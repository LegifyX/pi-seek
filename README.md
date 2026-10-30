# pi-seek

pi-seek is an extension for Pi. It connects Pi to the DeepSeek V4 Flash and V4 Pro models. It uses the DeepSeek Responses API and the DeepSeek beta API.

## What pi-seek adds to Pi

pi-seek adds one provider, six tools, and four commands to Pi.

**Provider.** Pi can use DeepSeek V4 Flash or V4 Pro as its model provider. The provider name is `deepseek-responses`. The model names are `deepseek-v4-flash` and `deepseek-v4-pro`; the model picker selects the agent model. The `ds_*` tools use the model from the `DEEPSEEK_MODEL` setting.

**Tools.**

| Tool | What it does |
|---|---|
| `ds_chat` | Sends a message to DeepSeek in a named thread. Keeps the history for later messages. |
| `ds_chat_reset` | Clears a thread. Removes all history in that thread. |
| `ds_prefix_complete` | Continues a text from a fixed prefix. Use it for code and structured text. |
| `ds_fim` | Fills the middle of code. It uses the code before the gap and the code after the gap. |
| `ds_web_search` | Runs a DeepSeek web search. Returns an answer with citations. |
| `ds_call_function` | Forces DeepSeek to make one strict function call. Validates the arguments before it returns them. |

**Commands.**

| Command | What it does |
|---|---|
| `/ds` | Starts a chat that does not keep history. |
| `/ds-cache` | Shows the cache hit and miss tokens of the last request. Shows the cost. |
| `/ds-balance` | Shows the account balance of every currency, the billing phase, and the usage today. |
| `/deepseek` | Opens the settings menu. Controls the integration and the default reasoning effort. |

**Status line.** After each use, the status line shows the billing phase (`☾ off-peak 50% until 09:00`, or `☀ peak`) and the remaining balance of every currency — `☾ off-peak 50% until 09:00 · $0.00 · ¥39.22`. The `until` clock is the next window on DeepSeek's UTC+8 billing calendar, so it tells you when the peak rate resumes. The phase is coloured (green off-peak, amber peak) and is display-only: the reported cost stays on the peak rate. Colours survive only under `@signalridge/pi-statusline` with `"extensionStatusRaw": ["ds"]` set; without it the row still reads correctly, just uncoloured. Cache hit/miss and cost have their own statusline segments — `/ds-cache` shows them on demand.

## How pi-seek integrates DeepSeek

**Authentication.** pi-seek reads the API key from two places. The first place is the environment variable `DEEPSEEK_API_KEY`. The second place is the `deepseek-responses` entry of pi's own `auth.json`, falling back to pi's built-in `deepseek` entry, so an account already logged in with pi works without extra setup. pi-seek sends the key in the `Authorization` header of each request.

**Endpoints.** pi-seek uses the Responses API for chat and for web search. It uses the beta API for prefix completion and for FIM.

**Reasoning.** DeepSeek has seven reasoning effort levels: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. pi-seek sends the level in each request. The default level is `high` for chat and `low` for web search.

**Structured output.** `ds_chat` can return text, JSON object, or JSON schema output. Use the `format` parameter to select the output. For JSON schema output, add the `json_schema` parameter.

**Threads.** The DeepSeek Responses API is stateless. It does not keep history between requests. pi-seek keeps the history in a named thread. Each round sends the history again. The replay is bounded: at most 200 items or 600,000 characters. The latest user message is always kept. pi-seek restores the threads when a session starts.

**Reliability.** All five fetch tools retry transient failures. A transient failure is a 429 response, a 5xx response, a network failure, or a timeout. The tools retry at most four times with exponential backoff. If the caller aborts a request, the tool returns "Interrupted by the caller." It does not throw an error. If a `ds_chat` request fails because the context is too long, pi-seek trims the history and retries once.

**Function calls.** `ds_call_function` converts a JSON schema to the DeepSeek strict dialect. It validates the returned arguments against the schema before it returns them.

**Telemetry.** pi-seek records the usage of each request. It records the input tokens, the output tokens, the reasoning tokens, the cache tokens, and the cost. It estimates the cost from the published prices. It keeps the last 100 records in the session.

**Balance.** The `/ds-balance` command fetches the account balance from DeepSeek. The balance is cached for 60 seconds. If the fetch fails, pi-seek uses the cached value.

## Requirements

- Pi 0.83 or newer.
- Node 24 or newer.

## Installation

**From npm (preferred).** The extension is published on npm.

```
pi install npm:@juvio15/pi-seek
```

To update the extension:

```
pi update npm:@juvio15/pi-seek
```

To remove the extension:

```
pi remove npm:@juvio15/pi-seek
```

**From GitHub.** The source code is on GitHub.

```
pi install git:github.com/bjoernaagaard/pi-seek
```

You can pin a release. Add `@v0.3.0` to the command.

**From a local copy.**

```
pi install /path/to/pi-seek
```

**Try without installing.** Add the `-e` option. The extension loads for the current run only.

```
pi -e npm:@juvio15/pi-seek
```

**Set the API key.** Sign in with pi (`pi` then `/login`) for the `deepseek` or `deepseek-responses` provider, or set the environment variable `DEEPSEEK_API_KEY`.

## Configuration

| Setting | What it does |
|---|---|
| `DEEPSEEK_API_KEY` | The DeepSeek API key. |
| `DEEPSEEK_REQUEST_TIMEOUT_S` | The absolute request timeout in seconds. Without it, the timeout scales with the token budget. |
| `DEEPSEEK_MODEL` | The model the `ds_*` tools use: `deepseek-v4-flash` (default) or `deepseek-v4-pro`. |
| `reasoning_effort` | The reasoning effort of a request. The default is `high`. |

## Notes

- Each tool call is a paid DeepSeek API request. Keep `max_output_tokens` small for tests.
- The billing phase is display-only: DeepSeek charges a 50% discount off-peak, but the reported cost stays on the peak rate.
- The FIM tool has a maximum of 4096 output tokens.
- `ds_call_function` uses non-thinking mode. DeepSeek rejects a forced tool choice in thinking mode.
- Do not put the API key in source code or in log files.
