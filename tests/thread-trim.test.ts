import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatTimeNote,
  prependTimeNote,
  systemHasTimeNote,
  THREAD_MAX_CHARS,
  THREAD_MAX_ITEMS,
} from "../src/config.ts";
import { trimThreadForContext, trimThreadItems } from "../src/threads.ts";

const user = (n: number | string): unknown => ({
  content: [{ text: `u${n}`, type: "input_text" }],
  role: "user",
});
const assistant = (n: number | string): unknown => ({
  content: [{ text: `a${n}`, type: "output_text" }],
  role: "assistant",
});
const systemItem = (): unknown => ({ content: "sys", role: "system" });

// ---------------------------------------------------------------------------
// Bounded replay cap
// ---------------------------------------------------------------------------

test("trimThreadItems leaves a history under the caps untouched", () => {
  const items = [user(1), assistant(1), user(2)];
  const result = trimThreadItems(items);
  assert.equal(result.trimmed, 0);
  assert.equal(result.items, items);
});

test("trimThreadItems drops oldest items first, keeping the latest user message", () => {
  const items = [user(1), assistant(1), user(2), assistant(2), user(3)];
  const result = trimThreadItems(items, 3);
  assert.equal(result.trimmed, 2);
  assert.deepEqual(result.items, [user(2), assistant(2), user(3)]);
});

test("trimThreadItems keeps the latest user message even at the smallest cap", () => {
  const items = [user(1), assistant(1), user(2)];
  const result = trimThreadItems(items, 1);
  assert.equal(result.trimmed, 2);
  assert.deepEqual(result.items, [user(2)]);
});

test("trimThreadItems caps by characters when chars bind first", () => {
  const big = "x".repeat(1000);
  const items = [
    { content: [{ text: big, type: "input_text" }], role: "user" },
    { content: [{ text: big, type: "output_text" }], role: "assistant" },
    user(2),
  ];
  const result = trimThreadItems(items, THREAD_MAX_ITEMS, 1500);
  // One drop brings the history under the char cap; the latest user message
  // is always preserved.
  assert.equal(result.trimmed, 1);
  assert.deepEqual(result.items, [
    { content: [{ text: big, type: "output_text" }], role: "assistant" },
    user(2),
  ]);
});

test("trimThreadItems honors the exported defaults", () => {
  assert.equal(THREAD_MAX_ITEMS, 200);
  assert.equal(THREAD_MAX_CHARS, 600_000);
  const over = Array.from({ length: 210 }, (_, i) =>
    i % 2 === 0 ? user(i) : assistant(i)
  );
  const result = trimThreadItems(over);
  assert.equal(result.trimmed, 10);
  assert.equal(result.items.length, 200);
  assert.deepEqual(result.items[0], user(10));
});

test("trimThreadItems leaves a single item whole", () => {
  assert.deepEqual(trimThreadItems([user(1)], 1), {
    items: [user(1)],
    trimmed: 0,
  });
  assert.deepEqual(trimThreadItems([], 1), { items: [], trimmed: 0 });
});

// ---------------------------------------------------------------------------
// Context-length trim-and-retry
// ---------------------------------------------------------------------------

test("trimThreadForContext drops the oldest assistant turns before user messages", () => {
  const items = [user(1), assistant(1), user(2), assistant(2), user(3)];
  const result = trimThreadForContext(items, 3);
  assert.equal(result.trimmed, 1);
  assert.deepEqual(result.items, [user(1), user(2), assistant(2), user(3)]);
});

test("trimThreadForContext drops assistant turns first, then older users", () => {
  const items = [user(1), assistant(1), user(2), assistant(2), user(3)];
  const result = trimThreadForContext(items, 1);
  // Non-user turns (a1, a2) drop first, then the oldest user message.
  assert.equal(result.trimmed, 3);
  assert.deepEqual(result.items, [user(2), user(3)]);
});

test("trimThreadForContext keeps the leading system item and the latest user message", () => {
  const items = [systemItem(), user(1), assistant(1), user(2)];
  const result = trimThreadForContext(items, 1);
  assert.equal(result.trimmed, 1);
  assert.deepEqual(result.items, [systemItem(), user(1), user(2)]);
});

test("trimThreadForContext trims by characters when chars bind first", () => {
  const big = "y".repeat(1000);
  const items = [
    user(1),
    { content: [{ text: big, type: "output_text" }], role: "assistant" },
    user(2),
  ];
  const result = trimThreadForContext(items, 100, 500);
  assert.equal(result.trimmed, 1);
  assert.deepEqual(result.items, [user(1), user(2)]);
});

test("trimThreadForContext leaves small histories untouched", () => {
  const items = [user(1), assistant(1), user(2)];
  const result = trimThreadForContext(items);
  assert.equal(result.trimmed, 0);
  assert.deepEqual(result.items, items);
});

test("trimThreadForContext leaves histories without droppable items untouched", () => {
  assert.deepEqual(trimThreadForContext([user(1)]), {
    items: [user(1)],
    trimmed: 0,
  });
  assert.deepEqual(trimThreadForContext([assistant(1), assistant(2)]), {
    items: [assistant(1), assistant(2)],
    trimmed: 0,
  });
  assert.deepEqual(trimThreadForContext([]), { items: [], trimmed: 0 });
});

// ---------------------------------------------------------------------------
// Time note injection
// ---------------------------------------------------------------------------

test("formatTimeNote emits a bounded ISO 8601 UTC timestamp at minute precision", () => {
  assert.equal(
    formatTimeNote(new Date("2025-08-02T12:34:56.789Z")),
    "Current time: 2025-08-02T12:34Z."
  );
});

test("prependTimeNote prepends to an absent or empty system", () => {
  const now = new Date("2025-01-01T00:00:00Z");
  assert.equal(
    prependTimeNote(undefined, now),
    "Current time: 2025-01-01T00:00Z."
  );
  assert.equal(prependTimeNote("", now), "Current time: 2025-01-01T00:00Z.");
  assert.equal(
    prependTimeNote("Be terse", now),
    "Current time: 2025-01-01T00:00Z. Be terse"
  );
});

test("prependTimeNote never double-injects when a note is already present", () => {
  const system = "Current time: 2025-01-01T00:00Z. Be terse";
  const later = new Date("2025-06-01T00:00:00Z");
  assert.equal(prependTimeNote(system, later), system);
});

test("systemHasTimeNote detects notes case-insensitively", () => {
  assert.equal(systemHasTimeNote("Current time: x"), true);
  assert.equal(systemHasTimeNote("current time: x"), true);
  assert.equal(systemHasTimeNote("Be terse"), false);
  assert.equal(systemHasTimeNote(undefined), false);
});
