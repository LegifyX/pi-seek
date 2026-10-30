import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  BALANCE_ENTRY,
  type BalanceEntry,
  CACHE_CARD_ENTRY,
  currencySymbol,
  THREADS_ENTRY,
  type UsageRecord,
} from "./config.ts";
import { formatPhase, PEAK_RULE_NOTE } from "./peak.ts";

// ---------------------------------------------------------------------------
// Entry renderers
// ---------------------------------------------------------------------------

const createEntryBox = (
  theme: Parameters<Parameters<ExtensionAPI["registerEntryRenderer"]>[1]>[2]
): Box => new Box(1, 1, (text) => theme.bg("customMessageBg", text));

export const registerRenderers = (pi: ExtensionAPI): void => {
  pi.registerEntryRenderer<{
    prompt: string;
    reply: string;
    thinking?: string;
    usage?: UsageRecord;
    ts: number;
  }>(THREADS_ENTRY, (entry, { expanded }, theme) => {
    const { data } = entry;
    const box = createEntryBox(theme);
    if (!data) {
      return box;
    }
    box.addChild(
      new Text(theme.fg("accent", "[ds] ") + theme.fg("dim", data.prompt), 0, 0)
    );
    box.addChild(new Text("", 0, 0));
    box.addChild(new Text(data.reply, 0, 0));
    if (expanded && data.usage) {
      box.addChild(
        new Text(
          theme.fg(
            "muted",
            `cache ${(data.usage.cacheRead / 1000).toFixed(1)}K hit / ${(data.usage.input / 1000).toFixed(1)}K miss · $${data.usage.cost.total.toFixed(4)}`
          ),
          0,
          0
        )
      );
    }
    return box;
  });

  pi.registerEntryRenderer<{
    usage: UsageRecord;
    history: UsageRecord[];
    ts: number;
  }>(CACHE_CARD_ENTRY, (entry, { expanded }, theme) => {
    const { data } = entry;
    const box = createEntryBox(theme);
    if (!data) {
      return box;
    }
    const { usage, history } = data;
    box.addChild(
      new Text(
        `${theme.fg("accent", "[ds-cache]")} ${(usage.hitRate * 100).toFixed(1)}% hit rate`,
        0,
        0
      )
    );
    box.addChild(
      new Text(
        `hit ${usage.cacheRead} tok · miss ${usage.input} tok · output ${usage.output} tok${usage.reasoning === undefined ? "" : ` (reasoning ${usage.reasoning})`}${usage.cacheWrite ? ` · cacheWrite ${usage.cacheWrite}` : ""}`,
        0,
        0
      )
    );
    if (expanded) {
      box.addChild(
        new Text(
          `cost input $${usage.cost.input.toFixed(5)} · output $${usage.cost.output.toFixed(5)} · cacheRead $${usage.cost.cacheRead.toFixed(6)} · total $${usage.cost.total.toFixed(5)}`,
          0,
          0
        )
      );
      box.addChild(
        new Text(
          theme.fg(
            "muted",
            `source: ${usage.source} · model: ${usage.model} · ${new Date(usage.ts).toLocaleTimeString()}`
          ),
          0,
          0
        )
      );

      if (history.length > 1) {
        const totalCacheRead = history.reduce(
          (sum, record) => sum + record.cacheRead,
          0
        );
        const totalInput = history.reduce(
          (sum, record) => sum + record.cacheRead + record.input,
          0
        );
        const aggregateHitRate =
          (totalCacheRead / Math.max(1, totalInput)) * 100;
        box.addChild(
          new Text(
            theme.fg(
              "muted",
              `${history.length} requests this session · aggregate hit rate ${aggregateHitRate.toFixed(1)}%`
            ),
            0,
            0
          )
        );
      }
    }
    return box;
  });

  pi.registerEntryRenderer<{
    entries: BalanceEntry[];
    fetchedAt: number;
    isAvailable: boolean;
    sessionCalls: number;
    sessionCostTotal: number;
    todayCalls: number;
    todayCostTotal: number;
    ts: number;
  }>(BALANCE_ENTRY, (entry, { expanded }, theme) => {
    const { data } = entry;
    const box = createEntryBox(theme);
    if (!data) {
      return box;
    }
    const status = data.isAvailable
      ? theme.fg("success", "available")
      : theme.fg("error", "INSUFFICIENT BALANCE");
    box.addChild(
      new Text(
        `${theme.fg("accent", "[ds-balance]")} ${status} · ${formatPhase()}`,
        0,
        0
      )
    );
    for (const balance of data.entries) {
      const symbol = currencySymbol(balance.currency);
      box.addChild(
        new Text(
          `${symbol}${balance.totalBalance.toFixed(2)} ${balance.currency} (granted ${symbol}${balance.grantedBalance.toFixed(2)} · topped up ${symbol}${balance.toppedUpBalance.toFixed(2)})`,
          0,
          0
        )
      );
    }
    if (expanded) {
      if (data.sessionCalls > 0) {
        box.addChild(
          new Text(
            theme.fg(
              "muted",
              `usage today ${data.todayCalls} calls · $${data.todayCostTotal.toFixed(4)} · session ${data.sessionCalls} calls · $${data.sessionCostTotal.toFixed(4)} (est.)`
            ),
            0,
            0
          )
        );
      }
      box.addChild(
        new Text(
          theme.fg(
            "muted",
            `updated ${new Date(data.fetchedAt).toLocaleTimeString()} · ${PEAK_RULE_NOTE}`
          ),
          0,
          0
        )
      );
    }
    return box;
  });
};
