/**
 * Phase 3a smoke: regime filters as executable DSL context.
 * Run with: pnpm --filter @stratforge/engine exec tsx scripts/regime-filter-smoke.ts
 */
import { parseStrategy } from "@stratforge/dsl";
import { classifyRegimes, runBacktest } from "../src/index.js";
import type { Candle } from "../src/types.js";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
};

function regimeCandles(perPhase: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  let t = 0;
  for (let i = 0; i < perPhase; i++, t++) {
    const open = price;
    const close = price * (1 + 0.0015 + Math.sin(i * 7.13) * 0.0002);
    candles.push({ time: 1700000000 + t * 3600, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1000 });
    price = close;
  }
  for (let i = 0; i < perPhase; i++, t++) {
    const open = price;
    const close = price * (1 + Math.sin(i / 2) * 0.02);
    candles.push({ time: 1700000000 + t * 3600, open, high: Math.max(open, close) * 1.02, low: Math.min(open, close) * 0.98, close, volume: 1000 });
    price = close;
  }
  return candles;
}

const candles = regimeCandles(500);
const base = {
  version: 1,
  name: "Regime filter smoke",
  indicators: [
    { id: "fast", type: "sma", params: { period: 10, source: "close" } },
    { id: "slow", type: "sma", params: { period: 30, source: "close" } },
  ],
  process: {
    thesis: "Only take fast/slow cross events when the surrounding regime matches the hypothesis.",
    trigger: [{ left: { kind: "indicator", id: "fast" }, op: "crossesAbove", right: { kind: "indicator", id: "slow" } }],
    context: [],
    outcome: { horizonBars: 20 },
  },
  entry: [{ left: { kind: "indicator", id: "fast" }, op: "crossesAbove", right: { kind: "indicator", id: "slow" } }],
  exit: [{ left: { kind: "indicator", id: "fast" }, op: "crossesBelow", right: { kind: "indicator", id: "slow" } }],
  risk: { positionSizePct: 50, stopLossPct: 5 },
} as const;

const all = parseStrategy(base);
const upOnly = parseStrategy({
  ...base,
  process: { ...base.process, context: [{ kind: "regime", axis: "trend", in: ["up"] }] },
  entry: [...base.process.trigger, { kind: "regime", axis: "trend", in: ["up"] }],
});
const impossible = parseStrategy({
  ...base,
  process: { ...base.process, context: [{ kind: "regime", axis: "trend", in: ["down"] }] },
  entry: [...base.process.trigger, { kind: "regime", axis: "trend", in: ["down"] }],
});

const perBar = classifyRegimes(candles);
const upBars = perBar.filter((r) => r?.trend === "up").length;
assert(upBars > 0, "synthetic sample has up-regime bars");

const allResult = runBacktest(all, candles, { initialCapital: 10_000, feePct: 0.1 });
const upResult = runBacktest(upOnly, candles, { initialCapital: 10_000, feePct: 0.1 });
const impossibleResult = runBacktest(impossible, candles, { initialCapital: 10_000, feePct: 0.1 });

assert(allResult.stats.trades > 0, "unfiltered strategy should trade");
assert(upResult.stats.trades <= allResult.stats.trades, "up-regime filter cannot add trades");
assert(impossibleResult.stats.trades === 0, "down-regime filter should block all entries in this up/range sample");

console.log("=== Phase 3a: regime filter smoke ===");
console.log("Trades all/up/down:", allResult.stats.trades, upResult.stats.trades, impossibleResult.stats.trades);
console.log("Up-regime bars:", upBars, "of", candles.length);
console.log("\nAll regime-filter smoke checks passed.");