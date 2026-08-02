import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type BalanceStore, summarizeUsage } from "./balance.ts";
import {
  BALANCE_ENTRY,
  type BalanceState,
  CACHE_CARD_ENTRY,
  type DeepSeekMenuAction,
  type DeepSeekMenuOption,
  type DeepSeekResetAction,
  type DeepSeekRuntimeState,
  type Effort,
  FOOTER_KEY,
  MENU_STATUS_KEY,
  THREADS_ENTRY,
  USAGE_ENTRY,
} from "./config.ts";
import type { ResponsesApi } from "./responses.ts";
import type { TelemetryStore } from "./telemetry.ts";
import type { ThreadStore } from "./threads.ts";
import { requireDeepSeekEnabled } from "./tools.ts";

// ---------------------------------------------------------------------------
// Command registration seam
// ---------------------------------------------------------------------------

interface CommandServices {
  balance: BalanceStore;
  responses: ResponsesApi;
  runtimeState: DeepSeekRuntimeState;
  telemetry: TelemetryStore;
  threads: ThreadStore;
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runOneShotChat = async (
  pi: ExtensionAPI,
  prompt: string,
  context: ExtensionContext,
  services: CommandServices
): Promise<void> => {
  const { responses, runtimeState, telemetry } = services;
  if (!requireDeepSeekEnabled(runtimeState, context)) {
    return;
  }
  if (!prompt) {
    context.ui.notify("Usage: /ds <prompt>", "info");
    return;
  }

  try {
    const result = await responses.chat(
      [
        {
          content: [{ text: prompt, type: "input_text" }],
          role: "user",
        },
      ],
      {
        effort: runtimeState.defaultEffort,
        signal: context.signal,
      }
    );
    const usage = telemetry.record(
      telemetry.mapResponsesUsage(result.usage, "command")
    );
    pi.appendEntry(USAGE_ENTRY, usage);
    telemetry.setFooter(context);
    pi.appendEntry(THREADS_ENTRY, {
      prompt,
      reply: result.text || "(empty reply)",
      thinking: result.thinking,
      ts: Date.now(),
      usage,
    });
  } catch (error) {
    context.ui.notify(`DeepSeek error: ${getErrorMessage(error)}`, "error");
  }
};

const showCacheTelemetry = (
  pi: ExtensionAPI,
  context: ExtensionContext,
  services: CommandServices
): void => {
  const { runtimeState, telemetry } = services;
  if (!requireDeepSeekEnabled(runtimeState, context)) {
    return;
  }
  const lastUsage = telemetry.getLastUsage();
  if (!lastUsage) {
    context.ui.notify(
      "No DeepSeek request is recorded in this session. Send a message first.",
      "info"
    );
    return;
  }
  pi.appendEntry(CACHE_CARD_ENTRY, {
    history: telemetry.getHistory(),
    ts: Date.now(),
    usage: lastUsage,
  });
  context.ui.setStatus(FOOTER_KEY, undefined);
  telemetry.setFooter(context);
};

const showBalance = async (
  pi: ExtensionAPI,
  context: ExtensionContext,
  services: CommandServices
): Promise<void> => {
  const { balance, runtimeState, telemetry } = services;
  if (!requireDeepSeekEnabled(runtimeState, context)) {
    return;
  }
  let balanceState: BalanceState;
  try {
    balanceState = await balance.get();
  } catch (error) {
    const stale = balance.peek();
    if (stale) {
      context.ui.notify(
        `ds-balance: refresh failed (${getErrorMessage(error)}); showing cached value.`,
        "warning"
      );
      balanceState = stale;
    } else {
      context.ui.notify(
        `ds-balance: balance query failed (${getErrorMessage(error)})`,
        "error"
      );
      return;
    }
  }
  const history = telemetry.getHistory();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = summarizeUsage(history, startOfToday.getTime());
  const session = summarizeUsage(history);
  pi.appendEntry(BALANCE_ENTRY, {
    ...balanceState,
    sessionCalls: session.calls,
    sessionCostTotal: session.costTotal,
    todayCalls: today.calls,
    todayCostTotal: today.costTotal,
    ts: Date.now(),
  });
  if (!balanceState.isAvailable) {
    context.ui.notify(
      "DeepSeek balance is insufficient: API calls fail until the account is topped up.",
      "warning"
    );
  }
};

const getDeepSeekMenuOptions = (
  runtimeState: DeepSeekRuntimeState
): DeepSeekMenuOption[] => [
  {
    action: "toggle",
    label: `${runtimeState.enabled ? "Disable" : "Enable"} integration (currently ${runtimeState.enabled ? "enabled" : "disabled"})`,
  },
  {
    action: "effort",
    label: `Default thinking effort: ${runtimeState.defaultEffort}`,
  },
  { action: "chat", label: "One-shot chat (/ds)" },
  { action: "reset", label: "Reset chat threads" },
  { action: "balance", label: "Show remaining balance (/ds-balance)" },
  { action: "cache", label: "Show cache telemetry (/ds-cache)" },
  { action: "close", label: "Close" },
];

const selectMenuAction = async (
  context: ExtensionContext,
  runtimeState: DeepSeekRuntimeState
): Promise<DeepSeekMenuAction | undefined> => {
  const options = getDeepSeekMenuOptions(runtimeState);
  const selectedLabel = await context.ui.select(
    "DeepSeek integration",
    options.map(({ label }) => label)
  );
  return options.find(({ label }) => label === selectedLabel)?.action;
};

const isEffort = (value: string): value is Effort =>
  value === "low" || value === "high" || value === "max";

const selectDefaultEffort = async (
  context: ExtensionContext,
  runtimeState: DeepSeekRuntimeState
): Promise<void> => {
  const options: Effort[] = ["low", "high", "max"];
  const labels = options.map((effort) =>
    effort === runtimeState.defaultEffort ? `${effort} (current)` : effort
  );
  const selectedLabel = await context.ui.select(
    `Default thinking effort: ${runtimeState.defaultEffort}`,
    labels
  );
  const selectedEffort = selectedLabel?.split(" ", 1)[0];
  if (!(selectedEffort && isEffort(selectedEffort))) {
    return;
  }
  runtimeState.defaultEffort = selectedEffort;
  context.ui.notify(
    `Default DeepSeek thinking effort set to ${selectedEffort}.`,
    "info"
  );
};

const selectResetAction = async (
  context: ExtensionContext,
  threads: ThreadStore
): Promise<DeepSeekResetAction | undefined> => {
  const threadNames = Object.keys(threads.snapshot()).sort();
  const options: Array<{
    action: DeepSeekResetAction;
    label: string;
  }> = [
    {
      action: { kind: "all" },
      label: `All threads (${threadNames.length})`,
    },
    ...threadNames.map((name) => ({
      action: { kind: "thread" as const, name },
      label: `Thread: ${name}`,
    })),
  ];
  const selectedLabel = await context.ui.select(
    "Reset DeepSeek chat",
    options.map(({ label }) => label)
  );
  return options.find(({ label }) => label === selectedLabel)?.action;
};

const resetThreadsFromMenu = async (
  context: ExtensionContext,
  services: CommandServices
): Promise<void> => {
  const { runtimeState, threads } = services;
  if (!requireDeepSeekEnabled(runtimeState, context)) {
    return;
  }
  const action = await selectResetAction(context, threads);
  if (!action) {
    return;
  }
  const target =
    action.kind === "all"
      ? "all DeepSeek chat threads"
      : `thread "${action.name}"`;
  const confirmed = await context.ui.confirm(
    "Reset DeepSeek chat",
    `Reset ${target}? This removes its saved conversation history.`
  );
  if (!confirmed) {
    return;
  }
  await threads.reset(action.kind === "thread" ? action.name : undefined);
  context.ui.notify(
    action.kind === "all"
      ? "All DeepSeek chat threads reset."
      : `DeepSeek chat thread "${action.name}" reset.`,
    "info"
  );
};

const MENU_STATUS: Record<DeepSeekMenuAction, string> = {
  balance: "DeepSeek: loading account balance...",
  cache: "DeepSeek: loading cache telemetry...",
  chat: "DeepSeek: one-shot chat...",
  close: "DeepSeek",
  effort: "DeepSeek: changing thinking effort...",
  reset: "DeepSeek: resetting chat threads...",
  toggle: "DeepSeek: changing integration state...",
};

const runMenuAction = async (
  action: DeepSeekMenuAction,
  pi: ExtensionAPI,
  context: ExtensionContext,
  services: CommandServices
): Promise<void> => {
  context.ui.setStatus(MENU_STATUS_KEY, MENU_STATUS[action]);
  try {
    switch (action) {
      case "toggle":
        services.runtimeState.enabled = !services.runtimeState.enabled;
        if (services.runtimeState.enabled) {
          services.telemetry.setFooter(context);
        } else {
          context.ui.setStatus(FOOTER_KEY, undefined);
        }
        context.ui.notify(
          `DeepSeek integration ${services.runtimeState.enabled ? "enabled" : "disabled"}.`,
          "info"
        );
        break;
      case "effort":
        await selectDefaultEffort(context, services.runtimeState);
        break;
      case "chat": {
        if (!requireDeepSeekEnabled(services.runtimeState, context)) {
          break;
        }
        const prompt = await context.ui.input(
          "DeepSeek one-shot chat",
          "Enter a prompt"
        );
        if (prompt?.trim()) {
          await runOneShotChat(pi, prompt.trim(), context, services);
        }
        break;
      }
      case "reset":
        await resetThreadsFromMenu(context, services);
        break;
      case "balance":
        await showBalance(pi, context, services);
        break;
      case "cache":
        showCacheTelemetry(pi, context, services);
        break;
      case "close":
        break;
      default:
        throw new Error(`Unknown DeepSeek menu action: ${String(action)}`);
    }
  } finally {
    context.ui.setStatus(MENU_STATUS_KEY, undefined);
  }
};

const openDeepSeekMenu = async (
  pi: ExtensionAPI,
  context: ExtensionContext,
  services: CommandServices
): Promise<void> => {
  let action = await selectMenuAction(context, services.runtimeState);
  while (action && action !== "close") {
    // biome-ignore lint/performance/noAwaitInLoops: Menu actions must run in user-selected order.
    await runMenuAction(action, pi, context, services);
    action = await selectMenuAction(context, services.runtimeState);
  }
};

export const registerCommands = (
  pi: ExtensionAPI,
  services: CommandServices
): void => {
  pi.registerCommand("ds", {
    description:
      "One-shot chat with DeepSeek V4 Flash (Responses API). Usage: /ds <prompt>",
    handler: async (args, context) => {
      const prompt = args.trim();
      await runOneShotChat(pi, prompt, context, services);
    },
  });

  pi.registerCommand("ds-cache", {
    description:
      "Show KV-cache hit/miss tokens and cost for the last DeepSeek request",
    handler: async (_args, context) => {
      await showCacheTelemetry(pi, context, services);
    },
  });

  pi.registerCommand("ds-balance", {
    description:
      "Show the remaining balance (credits left) on the DeepSeek account, plus usage today and this session",
    handler: async (_args, context) => {
      try {
        await showBalance(pi, context, services);
      } catch (error) {
        context.ui.notify(
          `ds-balance error: ${getErrorMessage(error)}`,
          "error"
        );
      }
    },
  });

  pi.registerCommand("deepseek", {
    description:
      "Configure DeepSeek, run one-shot chat, reset threads, or show cache telemetry",
    handler: async (_args, context) => {
      try {
        await openDeepSeekMenu(pi, context, services);
      } catch (error) {
        context.ui.notify(
          `DeepSeek menu error: ${getErrorMessage(error)}`,
          "error"
        );
      } finally {
        context.ui.setStatus(MENU_STATUS_KEY, undefined);
      }
    },
  });
};
