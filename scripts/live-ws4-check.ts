// Live verification of pi-seek's post-WS4 chat path with the real
// DEEPSEEK_API_KEY: createResponsesApi + runChatWithRecovery (retries,
// time-note injection, interrupt handling) against api.deepseek.com.

import { runChatWithRecovery } from "../src/chat.ts";
import { prependTimeNote, systemHasTimeNote } from "../src/config.ts";
import { createAuthService, createHttpClient } from "../src/http.ts";
import { createResponsesApi } from "../src/responses.ts";
import { trimThreadItems } from "../src/threads.ts";

const auth = createAuthService();
const http = createHttpClient(auth);
const responses = createResponsesApi(http);

const input = [
  {
    content: [{ text: "Reply with exactly: LIVE_OK", type: "input_text" }],
    role: "user",
  },
];

const outcome = await runChatWithRecovery(responses, input, {
  maxOutputTokens: 64,
  signal: undefined,
});
if (outcome.interrupted) {
  console.log("INTERRUPTED", outcome.phase);
  process.exit(2);
}
console.log("RETRIES:", outcome.retries);
console.log("TRIMMED:", outcome.trimmed);
console.log("TEXT:", JSON.stringify(outcome.result.text));

// Time-note helper sanity: note is bounded, ISO 8601 UTC, minute precision.
const note = prependTimeNote(undefined);
console.log("TIME_NOTE:", JSON.stringify(note));
console.log("HAS_NOTE:", systemHasTimeNote(note));
console.log("NOTE_LEN:", note.length);

// Trim helper sanity on a synthetic thread.
const items = [
  { content: "sys", role: "system" },
  ...[0, 1, 2, 3].map((i) => ({
    content: `m${i}`,
    role: i % 2 === 0 ? "assistant" : "user",
  })),
];
const trimmed = trimThreadItems(items, { maxItems: 3 });
console.log("TRIM:", JSON.stringify(trimmed));
