/**
 * Engine smoke test: golden-cross strategy on synthetic trending data.
 * Run with: pnpm demo
 */
import { parseStrategy } from "@stratforge/dsl";
import { runBacktest } from "../src/index.js";
import type { Candle } from "../src/types.js";

// --- Synthetic data: sine wave + drift + deterministic noise -> cyclical uptrend
function syntheticCandles(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = 0.0005;
    const cycle = Math.sin(i / 25) * 0.004;
    const noise = Math.sin(i * 7.13) * 0.003;
    const ret = drift + cycle + noise;
    const open = price;
    const close = price * (1 + ret);
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    candles.push({ time: 1700000000 + i * 3600, open, high, low, close, volume: 1000 });
    price = close;
  }
  return candles;
}

const strategy = parseStrategy({
  version: 1,
  name: "Golden Cross demo",
  indicators: [
    { id: "fast", type: "sma", params: { period: 10, source: "close" } },
    { id: "slow", type: "sma", params: { period: 30, source: "close" } },
  ],
  entry: [
    { left: { kind: "indicator", id: "fast" }, op: "crossesAbove", right: { kind: "indicator", id: "slow" } },
  ],
  exit: [
    { left: { kind: "indicator", id: "fast" }, op: "crossesBelow", right: { kind: "indicator", id: "slow" } },
  ],
  risk: { positionSizePct: 50, stopLossPct: 5 },
});

const candles = syntheticCandles(1000);
const result = runBacktest(strategy, candles, { initialCapital: 10_000, feePct: 0.1 });

console.log("=== StratForge engine demo ===");
console.log("Bars:", candles.length, "| Trades:", result.stats.trades);
console.table(result.stats);
console.log("First 3 trades:");
for (const t of result.trades.slice(0, 3)) {
  console.log(
    `  #${t.entryBar}->${t.exitBar}  in ${t.entryPrice.toFixed(2)} out ${t.exitPrice.toFixed(2)}  pnl ${t.pnlPct.toFixed(2)}% (${t.exitReason})`
  );
}

// --- Sanity assertions
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
};
assert(result.stats.trades > 3, "expected several trades on cyclical data");
assert(result.timeline.length === candles.length, "timeline must have one point per bar");
assert(
  Math.abs(
    result.timeline[result.timeline.length - 1].equity -
      (10_000 + result.trades.reduce((s, t) => s + t.pnl, 0))
  ) < 1e-6,
  "final equity must equal initial capital + sum of trade PnL"
);
assert(result.stats.maxDrawdownPct >= 0, "drawdown must be non-negative");
console.log("\nAll sanity checks passed.");
