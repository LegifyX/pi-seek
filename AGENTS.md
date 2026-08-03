## Engineering principles

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

# AGENTS.md

This repository is a Pi extension. The package name is `pi-seek`.
It adds DeepSeek V4 Flash Responses-API tools to Pi: `ds_chat`,
`ds_chat_reset`, `ds_prefix_complete`, `ds_fim`, `ds_web_search`, and
`ds_call_function`.

## Work commands

Run `npm install` once after you clone.

| Command | What it does |
| --- | --- |
| `npm run verify` | Run lint, typecheck, and the full test suite. |
| `npm run check` | Run the ultracite lint check. |
| `npm run test` | Run the test suite. |
| `npm run typecheck` | Type-check the source with `tsc --noEmit`. |
| `npm run fix` | Format and lint-fix with ultracite. |

Run `npm run verify` before you commit.

## Layout

- `src/index.ts` — the extension entry: registers the tools and commands.
- `src/tools.ts` — the tool implementations.
- `src/threads.ts` — thread replay and trim-and-retry.
- `src/retry.ts` — the retry taxonomy and backoff.
- `src/params.ts` — request parameters and the FIM 4K cap.
- `src/http.ts` — the transport layer.
- `tests/` — the test suite.

## Code standards

This repository uses Ultracite, a zero-config preset for strict code
quality. Follow the ultracite skill.

Quick reference:

- Format code: `npm exec -- ultracite fix`
- Check for issues: `npm exec -- ultracite check`
- Diagnose setup: `npm exec -- ultracite doctor`

Write code that is accessible, performant, type-safe, and maintainable.

- Name every variable for the value it holds.
- Use explicit types where they clarify the code.
- Use `const` by default; use `let` only when reassignment is needed.
- Await every promise in an async function. Use the return value.
- Use `try-catch` where a rejection needs handling; let other errors
  propagate.
- Throw `Error` objects with descriptive messages.
- Use early returns to reduce nesting.
- Keep functions focused; extract complex conditions into named boolean
  variables.
- Keep production code free of `console.log`, `debugger`, and `alert`
  statements.
- Write assertions inside `it()` or `test()` blocks. Remove `.only` and
  `.skip` before you commit.
- Keep test suites flat: nest `describe` blocks at most two levels.

## Extension specifics

The tools use the DeepSeek Responses API. Keys and endpoints come from the
environment configuration.

- Keep the retry taxonomy and backoff values current with the API
  behavior.
- Keep the FIM cap at 4K output tokens.
- Keep the thread replay bounded: replay the last 200 items or 600K
  characters, oldest first.
- Keep the interruption path: a caller interrupt surfaces as
  "Interrupted by the caller."
