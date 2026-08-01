# Plan 008: Usage tracking + remaining-credit (balance) display

> **Status**: RESEARCH COMPLETE — ready for implementation. Produced 2026-08-01 by
> orchestrated research (3 parallel scouts + live API verification) against the
> post-plan-007 codebase (commit `9d16dee`, branch `main`).
>
> This is a research + design document. It answers *how to add* a feature that
> (a) tracks DeepSeek usage persistently and (b) shows how many credits remain on
> the user's DeepSeek API key/account. It contains verified findings, a concrete
> design anchored to `deepseek-v4.ts` line numbers, implementation steps, a test
> plan, and done criteria — ready for an implementation agent.

## Why this matters

The extension already computes per-request usage and cost (`createTelemetryStore`,
`/ds-cache`, footer) — but the history is **in-memory only** (lost on restart) and
there is **no view of how much credit remains** on the DeepSeek account. Users who
rely on DeepSeek V4 Flash want to know: *how much have I used (this session, today,
total) and how much is left before my key stops working?* Both halves are now fully
researched and verified:

1. DeepSeek exposes an official, key-authenticated **balance endpoint** — verified
   live against the user's account (HTTP 200).
2. There is **no official usage-history/spend API** — persistent usage must be
   tracked locally by the extension (it already computes usage; persistence is the
   gap).

## Research findings (verified)

### F1. The balance endpoint (LIVE-VERIFIED)

- **Endpoint**: `GET https://api.deepseek.com/user/balance` — no query params, no body.
- **Auth**: `Authorization: Bearer <DEEPSEEK_API_KEY>` (same key as chat calls).
- **Official docs**: https://api-docs.deepseek.com/api/get-user-balance/ (HTTP 200;
  contains `is_available` / `total_balance` schema terms).
- **Live response** (this repo's account, 2026-08-01, HTTP 200):
  ```json
  {"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"24.62","granted_balance":"0.00","topped_up_balance":"24.62"}]}
  ```
- **Schema** (docs + live): `is_available: boolean`; `balance_infos: Array<{
  currency: string (CNY | USD), total_balance: string, granted_balance: string,
  topped_up_balance: string }>` — **all amounts are STRINGS** (parse with
  `parseFloat`); the array can hold multiple currencies (iterate, prefer USD).
  `total_balance ≈ granted_balance + topped_up_balance`; `is_available: false`
  means calls will fail with insufficient balance.
- **Error behavior (live-verified)**: invalid key → HTTP 401
  `{"error":{"message":"Authentication Fails, Your api key: ****-123 is invalid","type":"authentication_error",...}}`;
  missing header → HTTP 401 `Authentication Fails (governor)`.

### F2. Usage history — no official API

DeepSeek does **not** expose a public spend/usage-history REST endpoint (scout +
docs research). Per-request `usage` objects in responses (already consumed by this
extension) plus the balance endpoint are the only programmatic surfaces. Local
ledgering is therefore required and sufficient.

### F3. Ecosystem precedents (verified via web research)

- **pi-deepseek-usage** (github.com/shaftoe/pi-deepseek-usage, master) — a pi
  extension doing exactly this feature; source reviewed: GETs
  `https://api.deepseek.com/user/balance` with Bearer auth, parses
  `is_available` + `balance_infos`, prefers **USD** entry then falls back to the
  first entry, renders a footer status with currency symbols (`$`/`¥`) and
  credit-based coloring; caches ~30s. (It uses a shared `pi-usage-lib` runtime dep —
  pi-seek must NOT take that; the pattern is what we copy, self-contained.)
- **deepseek-sdk** (Rust crate `deepseek-sdk`, .NET `yuezhishun/deepseek-sdk`,
  Go, Dart) — native `Balance::get()` / `GetBalanceAsync()` / `getUserBalance()`
  clients for the same endpoint.
- **CodexBar** (steipete/CodexBar, docs/deepseek.md) — shows remaining credit in a
  menu via `GET /user/balance` (`is_available` + `balance_infos`).
- **dsbc** (merlos/dsbc) — Python CLI printing a balance report per currency with
  JSON output for scripting.
- **deepseek-mcp-server** — exposes a `get_user_balance` MCP tool.
- **UsageBoard** — bundled `deepseek-usage-plugin.py` colors balance red below a
  threshold.
- **Negative results**: litellm and chatbox do NOT surface DeepSeek's balance
  endpoint (litellm tracks spend via its own virtual-key API).

### F4. pi platform facts (verified against installed pi 0.83.0)

- pi itself has **no balance support** (no `/user/balance` anywhere in the dist).
- Session files are append-only JSONL under `~/.pi/agent/sessions/...`; each
  message persists a `Usage` object — pi's own per-request ledger.
- Extension persistence options: **only session custom entries** —
  `pi.appendEntry(customType, data)` (write; `types.d.ts:923`) and
  `context.sessionManager.getBranch()` / `getEntries()` (read). **No** `context.store`,
  **no** timers/setInterval, **no** `session_end` (closest teardown: `session_shutdown`).
- Footer: `ctx.ui.setStatus(key, text)`; full custom footers via `setFooter(render)`
  (the `custom-footer.ts` example aggregates `getBranch()` usage — the exact pattern
  for a session cost meter).
- The extension's own `ThreadStore` (deepseek-v4.ts `restore`, ~L687-726) is the
  in-repo precedent for persist-via-custom-entry + replay-on-`session_start`.

### F5. pi-seek integration map (codebase scout, line anchors in deepseek-v4.ts)

- Telemetry: `UsageRecord` L111-122, `UsageCost` L103-109, `createTelemetryStore`
  L487-587 (in-memory `usageHistory`, cap `USAGE_HISTORY_LIMIT = 100` L53),
  `calculateCost` L469-483, `setFooter` L559-578, `record` call sites L1126, L1221,
  L1280, L1330, L1406, L1569, L1636.
- `/ds-cache`: `showCacheTelemetry` L1652-1673 (writes `CACHE_CARD_ENTRY` custom
  entry), renderer L1949-2008. Menu: options L1678-1694, action union L79,
  `MENU_STATUS` L1790, switch L1797-1836.
- HTTP: `createHttpClient(auth)` L240-286 — **POST-only** (`postJson`); error
  mapping L254-275 (`DeepSeek API ${status}: ...` truncated to 400 chars,
  `Aborted by user`, `DeepSeek request timed out`); `BASE_URL` L26.
- Auth: `createAuthService` L189-226 — env `DEEPSEEK_API_KEY` first, then
  `<agentDir>/models.json` `providers["deepseek-responses"].apiKey`.
- Threads persistence precedent: `applyEntry` L679, `restore` L715 (custom-entry
  write + replay on `session_start`/`session_tree` L1586-1592).
- Tests: `__test` seam L2019-2029 + named exports L2019-2021; `http.test.ts`
  stubs `globalThis.fetch` and restores in `t.after`.
- Constraints: single source file (header L1-4); `package.json` devDependencies
  only; no pi-chimera; `pi -ne` must keep working.

## Design ("how to add" — the feature)

### Part A — Balance query (credit remaining)

1. **Add a GET method to the HTTP client** (deepseek-v4.ts, `createHttpClient`
   ~L240-286): generalize the request path or add `getJson(path, signal?, baseUrl?)`
   alongside `postJson`, reusing: `auth.resolveApiKey()`, `Authorization: Bearer`,
   timeout via `resolveTimeoutMs(body)` (balance body has no token budget → base
   90s), `AbortSignal.any`, and the existing error mapping (non-ok → `DeepSeek API
   ${status}: ${detail.slice(0,400)}`; abort → `Aborted by user`; timeout →
   `DeepSeek request timed out`). 401s surface naturally with DeepSeek's error body.
2. **Add a `getBalance()` helper**: `GET ${BASE_URL}/user/balance`; parse
   **defensively** (mirror the codebase's `getNumber(...) ?? 0` pattern): amounts
   are strings → `parseFloat`, missing fields → `0`; `balance_infos` may be missing
   or multi-currency → pick **USD first, else first entry**; `is_available`
   defaults `true` if absent. Return a normalized
   `{ isAvailable, currency, totalBalance, grantedBalance, toppedUpBalance, fetchedAt }`.

### Part B — Balance store with caching

3. **`createBalanceStore()`** (new module-private factory, alongside
   `createTelemetryStore`): holds `{ data, fetchedAt }`; `get()` returns cached
   data if **fresh (< 60s TTL)**; otherwise fetches via the HTTP client, caches,
   and returns; on fetch failure **keeps the stale cache** and rethrows (caller
   decides UX). No timers needed (pi has none) — refresh is lazy on demand.
   Optionally piggyback a refresh on `turn_end` when stale (≤ 1 fetch per minute).

### Part C — UI surfaces

4. **New command `/ds-balance`** (mirror `/ds-cache`): fetch (or serve cached)
   balance → `pi.appendEntry(BALANCE_ENTRY, { ...normalized, ts })` →
   `BALANCE_ENTRY` renderer (new, beside the CACHE_CARD_ENTRY block at L1949):
   shows `is_available` status, currency
   symbol + `total_balance` (and granted/topped-up breakdown when non-zero),
   "updated <time>" line. On failure: `ctx.ui.notify("ds-balance: ...")` with the
   mapped error (401 → hint to check `DEEPSEEK_API_KEY`), keep stale value if any.
   Warn when `is_available === false` ("insufficient balance").
5. **Menu action "balance"** in `/deepseek` (add `"balance"` to the action union
   L79, an option in `getDeepSeekMenuOptions` L1678-1694, a `MENU_STATUS` entry
   L1790, a switch case L1797-1836) — reuses the same handler as `/ds-balance`.
6. **Optional footer integration**: extend `setFooter` (L559-578) with a balance
   segment **only when a fresh cached value exists** (e.g.
   `DS v4-flash · cache 2.0K hit / 3.0K miss · $0.0042 · bal $24.62`) — never fetch
   inside `setFooter`; keep the footer dependency-free and offline-safe. Consider
   red coloring below a configurable threshold (e.g. < $5) like UsageBoard /
   pi-deepseek-usage.

### Part D — Persistent usage ledger (how much used)

7. **Persist usage via custom entries** (the `ThreadStore` precedent: `applyEntry`
   L679 / `restore` L715): on each
   `telemetry.record` call site (L1126, L1221, L1280, L1330, L1406, L1569, L1636) —
   or batched at the end of each record — write
   `pi.appendEntry(USAGE_ENTRY, { usage: UsageRecord, ts })`. Custom entries do not
   participate in LLM context, so transcript bloat is bounded (~200 bytes/record).
8. **Restore on `session_start` / `session_tree`** (alongside `threads.restore`,
   L1586-1592): scan `context.sessionManager.getBranch()` for `USAGE_ENTRY` custom
   entries, replay into `usageHistory` (respect `USAGE_HISTORY_LIMIT`, newest wins,
   dedupe by `ts`). Optional per-day aggregation: a `UsageLedger.summarize()` that
   groups history by calendar day → the `/ds-balance` card can show
   "today $X · session $Y · history N calls" (all derived from the local COST
   constants — an estimate; authoritative billing is DeepSeek's side, which is
   what the balance endpoint reports).
9. **Caveat to document**: cost is estimated from local COST rates; balance from
   `/user/balance` is the authoritative "credits left".

### Part E — Testing & verification

10. **`tests/balance.test.ts`** (model on `http.test.ts`): stub `globalThis.fetch`
    with `Response` bodies — success parse (strings→numbers, USD preference,
    multi-currency, missing fields default 0); 401 mapping (message contains
    status + body snippet); timeout; abort; cache freshness (second `get()` within
    TTL does NOT refetch — count fetch calls); stale-cache-kept-on-error.
11. **`tests/usage-ledger.test.ts`**: restore-from-branch replay (interleaved
    entries, dedupe, cap), daily aggregation, round-trip via a fake `getBranch()`.
12. **Seam**: add `createBalanceStore` (and the ledger helpers) to `__test`
    (L2023-2029) following the established pattern.
13. **Gates**: `npm run typecheck`, `npm test`, `npm exec -- ultracite check` all
    exit 0. **Live check**: `curl -s https://api.deepseek.com/user/balance -H
    "Authorization: Bearer $DEEPSEEK_API_KEY"` (already verified 200); after
    implementation, `/ds-balance` in `pi -ne -e deepseek-v4.ts` shows the real
    balance; unset the key → the 401 path renders the hint instead of crashing.

## Implementation steps (for the executor)

1. `createHttpClient`: add `getJson` (or generalize request core); keep all error
   mapping identical. **Verify**: `npm run typecheck`; `tests/http.test.ts` still
   green; add a GET-path test.
2. Add `getBalance()` + `createBalanceStore()` (60s TTL cache, stale-keep-on-error).
   **Verify**: new `tests/balance.test.ts` green.
3. Add `BALANCE_ENTRY` constant + renderer + `/ds-balance` command +
   "balance" menu action (union/option/status/switch). **Verify**: manual
   `/ds-balance` in `pi -ne`; `/deepseek` menu shows the new entry.
4. Add `USAGE_ENTRY` custom-entry writes at the 7 `telemetry.record` sites (or one
   batched helper) + restore in the `session_start`/`session_tree` handler.
   **Verify**: new `tests/usage-ledger.test.ts` green; restart a pi session → usage
   history survives.
5. Extend `setFooter` with the cached-balance segment (offline-safe).
6. Full gates + live check; update this row in `plans/README.md` to DONE.

## Test plan

- `tests/balance.test.ts` — parsing, currency preference, error mapping, caching
  (fetch-count assertions), stale-on-error.
- `tests/usage-ledger.test.ts` — replay, dedupe, cap, daily rollup.
- Existing suites must stay green (smoke, to-strict-schema, timeout,
  threads-restore, telemetry, threads, responses, payload, http).

## Done criteria (machine-checkable)

- [ ] `grep -n "user/balance" deepseek-v4.ts` → present
- [ ] `grep -n "getJson" deepseek-v4.ts` → present (GET path in HttpClient)
- [ ] `grep -n "ds-balance" deepseek-v4.ts` → command + menu action present
- [ ] `grep -n "USAGE_ENTRY\|usage-entry" deepseek-v4.ts` → persistent ledger present
- [ ] `npm run typecheck`, `npm test`, `npm exec -- ultracite check` all exit 0
- [ ] `tests/balance.test.ts` and `tests/usage-ledger.test.ts` exist and pass
- [ ] Live: `/ds-balance` (or `curl` with the same auth path) returns the real
      balance; unset key → hint message, no crash
- [ ] No runtime deps added; no pi-chimera references; `pi -ne` still works
- [ ] `plans/README.md` row 008 → DONE

## STOP conditions

- The balance endpoint's schema changes incompatibly (verify live before coding;
  the live call above is the ground truth).
- `parseFloat` on a non-numeric `total_balance` (schema drift) — do not guess; report.
- pi adds an official usage-history API — prefer it over the local ledger.
- Anything that would require a runtime dependency or pi-chimera.

## Maintenance notes

- Balance amounts are strings and currencies vary (`CNY` default in docs; this
  account is `USD`) — always prefer USD, fall back to first entry.
- Docs domain has moved before (`api-docs.deepseek.com` ↔ `docs.deepseek.com`);
  the live endpoint is the source of truth.
- The 60s TTL and low-balance threshold (if colored footer is added) should be
  constants at the top of the file next to the other tunables.
- Local cost is an estimate from the COST constants; if DeepSeek pricing changes,
  `tests/telemetry.test.ts` case 5 is the tripwire (by design).
