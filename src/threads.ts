import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Thread } from "./config.ts";

// ---------------------------------------------------------------------------
// Thread store
// ---------------------------------------------------------------------------

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
