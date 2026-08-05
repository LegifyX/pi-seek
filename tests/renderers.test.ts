import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Box } from "@earendil-works/pi-tui";
import {
  BALANCE_ENTRY,
  CACHE_CARD_ENTRY,
  THREADS_ENTRY,
  type UsageRecord,
} from "../src/config.ts";
import { registerRenderers } from "../src/renderers.ts";

interface RegisteredRenderer {
  customType: string;
  renderer: unknown;
}

type Renderer = (
  entry: { data?: unknown },
  options: { expanded: boolean },
  theme: Theme
) => Box;

const fgColors = {
  accent: 36,
  dim: 2,
  error: 31,
  muted: 90,
  success: 32,
  thinkingMax: 33,
  thinkingXhigh: 33,
} as unknown as ConstructorParameters<typeof Theme>[0];
const bgColors = { customMessageBg: 40 } as unknown as ConstructorParameters<
  typeof Theme
>[1];
const theme = new Theme(fgColors, bgColors, "truecolor");

const createRecordingPi = (): {
  pi: ExtensionAPI;
  renderers: RegisteredRenderer[];
} => {
  const renderers: RegisteredRenderer[] = [];
  const pi = {
    registerEntryRenderer: (customType: string, renderer: unknown): void => {
      renderers.push({ customType, renderer });
    },
  };
  return { pi: pi as unknown as ExtensionAPI, renderers };
};

const rendererFor = (
  renderers: RegisteredRenderer[],
  customType: string
): Renderer => {
  const registered = renderers.find(
    ({ customType: type }) => type === customType
  );
  assert.ok(registered, `renderer "${customType}" must be registered`);
  return registered.renderer as Renderer;
};

const renderLines = (
  renderer: Renderer,
  data: unknown,
  expanded: boolean
): string[] => renderer({ data }, { expanded }, theme).render(120);

const ansiSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (line: string): string => line.replace(ansiSequence, "");

const contentLines = (lines: string[]): string[] =>
  lines.map(stripAnsi).filter((line) => line.trim() !== "");

const hasLine = (lines: string[], text: string): boolean =>
  lines.some((line) => stripAnsi(line).includes(text));

const makeUsage = (): UsageRecord => ({
  cacheRead: 1200,
  cacheWrite: 0,
  cost: {
    cacheRead: 0.003_36,
    cacheWrite: 0,
    input: 0.042,
    output: 0.056,
    total: 0.101_36,
  },
  hitRate: 0.8,
  input: 300,
  model: "deepseek-v4-flash",
  output: 200,
  reasoning: 50,
  source: "ds_chat",
  totalTokens: 1700,
  ts: 1000,
});

test("registerRenderers registers the three entry renderers", () => {
  const { pi, renderers } = createRecordingPi();
  registerRenderers(pi);
  const byName = (a: string, b: string): number => a.localeCompare(b);
  assert.deepEqual(
    renderers.map(({ customType }) => customType).sort(byName),
    [BALANCE_ENTRY, CACHE_CARD_ENTRY, THREADS_ENTRY].sort(byName)
  );
});

test("ds-reply: compact view shows prompt and reply but hides the usage line", () => {
  const { pi, renderers } = createRecordingPi();
  registerRenderers(pi);
  const renderer = rendererFor(renderers, THREADS_ENTRY);
  const data = {
    prompt: "hello",
    reply: "hi there",
    ts: 1,
    usage: makeUsage(),
  };

  const compact = contentLines(renderLines(renderer, data, false));
  assert.equal(compact.length, 2);
  assert.ok(hasLine(compact, "[ds] hello"));
  assert.ok(hasLine(compact, "hi there"));
  assert.ok(compact.every((line) => !line.includes("cache")));

  const expanded = contentLines(renderLines(renderer, data, true));
  assert.equal(expanded.length, 3);
  assert.ok(hasLine(expanded, "[ds] hello"));
  assert.ok(hasLine(expanded, "hi there"));
  assert.ok(hasLine(expanded, "cache 1.2K hit / 0.3K miss"));
});

test("ds-reply: missing data renders an empty box", () => {
  const { pi, renderers } = createRecordingPi();
  registerRenderers(pi);
  const renderer = rendererFor(renderers, THREADS_ENTRY);
  assert.deepEqual(renderLines(renderer, undefined, true), []);
});

test("ds-cache-card: compact view shows header and summary but hides cost and history detail", () => {
  const { pi, renderers } = createRecordingPi();
  registerRenderers(pi);
  const renderer = rendererFor(renderers, CACHE_CARD_ENTRY);
  const data = {
    history: [makeUsage(), makeUsage()],
    ts: 1,
    usage: makeUsage(),
  };

  const compact = contentLines(renderLines(renderer, data, false));
  assert.equal(compact.length, 2);
  assert.ok(hasLine(compact, "[ds-cache] 80.0% hit rate"));
  assert.ok(hasLine(compact, "hit 1200 tok · miss 300 tok · output 200 tok"));
  assert.ok(compact.every((line) => !line.includes("cost input")));
  assert.ok(compact.every((line) => !line.includes("source:")));
  assert.ok(compact.every((line) => !line.includes("requests this session")));

  const expanded = contentLines(renderLines(renderer, data, true));
  assert.equal(expanded.length, 5);
  assert.ok(hasLine(expanded, "[ds-cache] 80.0% hit rate"));
  assert.ok(hasLine(expanded, "hit 1200 tok · miss 300 tok · output 200 tok"));
  assert.ok(hasLine(expanded, "cost input $0.04200"));
  assert.ok(hasLine(expanded, "source: ds_chat · model: deepseek-v4-flash"));
  assert.ok(hasLine(expanded, "2 requests this session"));
});

test("ds-cache-card: history aggregate is omitted when only one request exists", () => {
  const { pi, renderers } = createRecordingPi();
  registerRenderers(pi);
  const renderer = rendererFor(renderers, CACHE_CARD_ENTRY);
  const data = { history: [makeUsage()], ts: 1, usage: makeUsage() };

  const expanded = contentLines(renderLines(renderer, data, true));
  assert.equal(expanded.length, 4);
  assert.ok(expanded.every((line) => !line.includes("requests this session")));
});

test("ds-balance-card: compact view shows only the status header", () => {
  const { pi, renderers } = createRecordingPi();
  registerRenderers(pi);
  const renderer = rendererFor(renderers, BALANCE_ENTRY);
  const data = {
    currency: "USD",
    fetchedAt: 2000,
    grantedBalance: 5,
    isAvailable: true,
    sessionCalls: 3,
    sessionCostTotal: 0.1,
    todayCalls: 10,
    todayCostTotal: 0.5,
    toppedUpBalance: 20,
    totalBalance: 25,
    ts: 1,
  };

  const compact = contentLines(renderLines(renderer, data, false));
  assert.equal(compact.length, 1);
  assert.ok(hasLine(compact, "[ds-balance] available · $25.00"));
  assert.ok(compact.every((line) => !line.includes("granted")));
  assert.ok(compact.every((line) => !line.includes("usage today")));
  assert.ok(compact.every((line) => !line.includes("updated")));

  const expanded = contentLines(renderLines(renderer, data, true));
  assert.equal(expanded.length, 4);
  assert.ok(hasLine(expanded, "[ds-balance] available · $25.00"));
  assert.ok(hasLine(expanded, "granted $5.00 · topped up $20.00"));
  assert.ok(hasLine(expanded, "usage today 10 calls"));
  assert.ok(hasLine(expanded, "updated"));
});

test("ds-balance-card: insufficient balance renders the error status", () => {
  const { pi, renderers } = createRecordingPi();
  registerRenderers(pi);
  const renderer = rendererFor(renderers, BALANCE_ENTRY);
  const data = {
    currency: "USD",
    fetchedAt: 2000,
    grantedBalance: 0,
    isAvailable: false,
    sessionCalls: 0,
    sessionCostTotal: 0,
    todayCalls: 0,
    todayCostTotal: 0,
    toppedUpBalance: 0,
    totalBalance: 0,
    ts: 1,
  };

  const expanded = contentLines(renderLines(renderer, data, true));
  assert.equal(expanded.length, 2);
  assert.ok(hasLine(expanded, "[ds-balance] INSUFFICIENT BALANCE · $0.00"));
  assert.ok(hasLine(expanded, "updated"));
});
