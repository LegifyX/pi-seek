import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_RETRY_MAX_CHARS,
  CONTEXT_RETRY_MAX_ITEMS,
  THREAD_MAX_CHARS,
  THREAD_MAX_ITEMS,
  type Thread,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Thread store
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bounded replay helpers (pure)
// ---------------------------------------------------------------------------

const getRole = (item: unknown): string | undefined => {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return;
  }
  const { role } = item as { role?: unknown };
  return typeof role === "string" ? role : undefined;
};

const isUserItem = (item: unknown): boolean => getRole(item) === "user";

const isSystemItem = (item: unknown): boolean => getRole(item) === "system";

const estimateItemChars = (item: unknown): number => {
  try {
    return JSON.stringify(item)?.length ?? 0;
  } catch {
    return 1000;
  }
};

export interface ThreadTrimResult {
  items: unknown[];
  trimmed: number;
}

// Finds the index of the most recent user item; everything from there on is
// always preserved (the latest user message and anything after it).
const lastUserIndex = (items: unknown[]): number => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isUserItem(items[index])) {
      return index;
    }
  }
  return -1;
};

// Bounded replay cap: drops the oldest items until the history fits both
// `maxItems` and `maxChars` (whichever binds first). Never drops the most
// recent user message or anything after it; a single-item history is kept
// whole.
export const trimThreadItems = (
  items: unknown[],
  maxItems: number = THREAD_MAX_ITEMS,
  maxChars: number = THREAD_MAX_CHARS
): ThreadTrimResult => {
  if (items.length <= 1) {
    return { items, trimmed: 0 };
  }
  const preserveFrom = Math.max(0, lastUserIndex(items));
  let totalChars = items.reduce<number>(
    (sum, item) => sum + estimateItemChars(item),
    0
  );
  let dropped = 0;
  while (
    dropped < preserveFrom &&
    (items.length - dropped > maxItems || totalChars > maxChars)
  ) {
    totalChars -= estimateItemChars(items[dropped]);
    dropped += 1;
  }
  return dropped === 0
    ? { items, trimmed: 0 }
    : { items: items.slice(dropped), trimmed: dropped };
};

// Context-length trim-and-retry: keeps the leading system item (if any) and
// the most recent user message (plus everything after it), and drops from the
// oldest part of the middle — assistant/tool/reasoning turns before user
// messages. The kept head stays contiguous so the prompt cache keeps hitting
// on the surviving prefix. Targets CONTEXT_RETRY_* caps (half of the bounded
// replay caps) so the retried request fits comfortably.
export const trimThreadForContext = (
  items: unknown[],
  maxItems: number = CONTEXT_RETRY_MAX_ITEMS,
  maxChars: number = CONTEXT_RETRY_MAX_CHARS
): ThreadTrimResult => {
  const head = items.length > 0 && isSystemItem(items[0]) ? 1 : 0;
  const tailFrom = Math.max(head, lastUserIndex(items));
  if (tailFrom === -1 || tailFrom - head < 1) {
    return { items, trimmed: 0 };
  }
  const droppable = items.slice(head, tailFrom);
  if (droppable.length === 0) {
    return { items, trimmed: 0 };
  }
  // Drop order: oldest assistant/tool/reasoning turns first, then older user
  // messages. Kept items stay in their original relative order.
  const ordered: number[] = [];
  for (let index = 0; index < droppable.length; index += 1) {
    if (!isUserItem(droppable[index])) {
      ordered.push(index);
    }
  }
  for (let index = 0; index < droppable.length; index += 1) {
    if (isUserItem(droppable[index])) {
      ordered.push(index);
    }
  }
  let totalChars = droppable.reduce<number>(
    (sum, item) => sum + estimateItemChars(item),
    0
  );
  let dropCount = 0;
  while (
    dropCount < ordered.length &&
    (droppable.length - dropCount > maxItems || totalChars > maxChars)
  ) {
    totalChars -= estimateItemChars(droppable[ordered[dropCount]]);
    dropCount += 1;
  }
  if (dropCount === 0) {
    return { items, trimmed: 0 };
  }
  const dropSet = new Set(ordered.slice(0, dropCount));
  const kept = items.filter(
    (_, index) =>
      index < head || index >= tailFrom || !dropSet.has(index - head)
  );
  return { items: kept, trimmed: dropCount };
};

export interface ThreadStore {
  getOrCreate: (name: string) => Thread;
  reset: (name?: string) => Promise<void>;
  restore: (context: ExtensionContext) => void;
  snapshot: () => Record<string, Thread>;
  withLock: <Result>(
    name: string,
    action: () => Result | Promise<Result>
  ) => Promise<Result>;
}

export const createThreadStore = (): ThreadStore => {
  const threads = new Map<string, Thread>();
  const threadTails = new Map<string, Promise<void>>();

  const withLock = async <Result>(
    name: string,
    action: () => Result | Promise<Result>
  ): Promise<Result> => {
    const predecessor = threadTails.get(name) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => gate);
    threadTails.set(name, tail);

    await predecessor;
    try {
      return await action();
    } finally {
      release();
      if (threadTails.get(name) === tail) {
        threadTails.delete(name);
      }
    }
  };

  const getOrCreate = (name: string): Thread => {
    const existingThread = threads.get(name);
    if (existingThread) {
      return existingThread;
    }
    const newThread: Thread = { items: [], round: 0 };
    threads.set(name, newThread);
    return newThread;
  };

  const reset = async (name?: string): Promise<void> => {
    if (name) {
      await withLock(name, () => {
        threads.delete(name);
      });
      return;
    }

    const names = new Set([...threads.keys(), ...threadTails.keys()]);
    await Promise.all(
      [...names].map((threadName) =>
        withLock(threadName, () => {
          threads.delete(threadName);
        })
      )
    );
  };

  const snapshot = (): Record<string, Thread> =>
    Object.fromEntries(threads.entries());

  const applyLegacySnapshot = (snapshotMap: Record<string, Thread>): void => {
    threads.clear();
    for (const [name, thread] of Object.entries(snapshotMap)) {
      threads.set(name, thread);
    }
  };

  const applyReset = (
    resetAction: { kind: "all" } | { kind: "thread"; name: string }
  ): void => {
    if (resetAction.kind === "all") {
      threads.clear();
      return;
    }
    threads.delete(resetAction.name);
  };

  const applyEntry = (entry: SessionEntry): void => {
    if (entry.type !== "message") {
      return;
    }
    const { message } = entry;
    if (message.role !== "toolResult") {
      return;
    }
    if (
      message.toolName !== "ds_chat" &&
      message.toolName !== "ds_chat_reset"
    ) {
      return;
    }
    const details = message.details as
      | {
          reset?: { kind: "all" } | { kind: "thread"; name: string };
          thread?: Thread & { name: string };
          threads?: Record<string, Thread>;
        }
      | undefined;
    if (details?.threads) {
      // Legacy shape from versions that snapshotted the whole map.
      applyLegacySnapshot(details.threads);
      return;
    }
    if (message.toolName === "ds_chat" && details?.thread?.name) {
      const { items, name, round, system } = details.thread;
      threads.set(name, { items, round, system });
      return;
    }
    if (message.toolName === "ds_chat_reset" && details?.reset) {
      applyReset(details.reset);
    }
  };

  const restore = (context: ExtensionContext): void => {
    threads.clear();
    for (const entry of context.sessionManager.getBranch()) {
      applyEntry(entry);
    }
  };

  return { getOrCreate, reset, restore, snapshot, withLock };
};
