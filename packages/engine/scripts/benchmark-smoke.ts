/**
 * Phase 1 smoke test: buy-and-hold benchmark + relative verdict + Sharpe rubric.
 * Run with: pnpm --filter @stratforge/engine exec tsx scripts/benchmark-smoke.ts
 */
import { parseStrategy } from "@stratforge/dsl";
import { buyAndHoldStats, relativeVerdict, runBacktest, sharpeLabel } from "../src/index.js";
import type { Candle } from "../src/types.js";

// Strong, steady uptrend so buy-and-hold is hard to beat.
function uptrendCandles(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price * (1 + 0.002 + Math.sin(i * 7.13) * 0.0015);
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    candles.push({ time: 1700000000 + i * 3600, open, high, low, close, volume: 1000 });
    price = close;
  }
  return candles;
}

const strategy = parseStrategy({
  version: 1,
  name: "Benchmark smoke",
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

const candles = uptrendCandles(800);
const result = runBacktest(strategy, candles, { initialCapital: 10_000, feePct: 0.1 });
const bench = buyAndHoldStats(candles);
const verdict = relativeVerdict(result.stats, bench);

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
};

// --- buy-and-hold return matches the raw close ratio.
const expectedBH = (candles[candles.length - 1].close / candles[0].close - 1) * 100;
assert(Math.abs(bench.totalReturnPct - Math.round(expectedBH * 100) / 100) < 0.05, `B&H return should match close ratio (got ${bench.totalReturnPct}, expected ~${expectedBH.toFixed(2)})`);
assert(bench.totalReturnPct > 0, "B&H should be positive on an uptrend");
assert(bench.maxDrawdownPct >= 0, "B&H max drawdown must be non-negative");

// --- verdict is internally consistent with the numbers.
assert(verdict.beatsBuyHold === result.stats.totalReturnPct > bench.totalReturnPct, "beatsBuyHold must reflect the return comparison");
assert(Math.abs(verdict.excessReturnPct - (Math.round((result.stats.totalReturnPct - bench.totalReturnPct) * 100) / 100)) < 0.05, "excessReturnPct must equal strategy − benchmark");
// A 50%-sizing, in-and-out crossover strategy on a steady uptrend should NOT beat fully-invested buy-and-hold.
assert(verdict.beatsBuyHold === false, "an in-and-out half-size strategy should underperform fully-invested buy-and-hold on a clean uptrend");

// --- Sharpe rubric bands.
assert(sharpeLabel(0.2) === "uninvestable (<0.5)", "0.2 → uninvestable");
assert(sharpeLabel(0.7) === "weak (<1)", "0.7 → weak");
assert(sharpeLabel(1.5) === "decent (1–2)", "1.5 → decent");
assert(sharpeLabel(3) === "strong (≥2)", "3 → strong");

console.log("=== Phase 1: buy-and-hold benchmark smoke ===");
console.log("Strategy:", result.stats.totalReturnPct + "%", "| Sharpe", result.stats.annualizedSharpe, `(${sharpeLabel(result.stats.annualizedSharpe)})`);
console.log("Buy & hold:", bench.totalReturnPct + "%", "| Sharpe", bench.annualizedSharpe, `(${sharpeLabel(bench.annualizedSharpe)})`);
console.log("Verdict:", verdict.note);
console.log("\nAll benchmark smoke checks passed.");
