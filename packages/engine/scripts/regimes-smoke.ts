/**
 * Regime-analysis smoke test.
 * Builds synthetic data with two engineered regimes (a calm low-vol uptrend, then a
 * choppy high-vol range), runs a backtest, and checks that classifyRegimes /
 * analyzeRegimes split and attribute the result honestly.
 * Run with: pnpm --filter @stratforge/engine exec tsx scripts/regimes-smoke.ts
 */
import { parseStrategy } from "@stratforge/dsl";
import { analyzeRegimes, classifyRegimes, runBacktest } from "../src/index.js";
import type { Candle } from "../src/types.js";

// Phase A: smooth low-vol uptrend (high ADX-up, low ATR%).
// Phase B: high-vol choppy range (low ADX, high ATR%).
function twoRegimeCandles(perPhase: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  const push = (open: number, close: number, wickFrac: number, t: number) => {
    const high = Math.max(open, close) * (1 + wickFrac);
    const low = Math.min(open, close) * (1 - wickFrac);
    candles.push({ time: 1700000000 + t * 3600, open, high, low, close, volume: 1000 });
  };
  let t = 0;
  // Phase A — calm uptrend.
  for (let i = 0; i < perPhase; i++, t++) {
    const open = price;
    const close = price * (1 + 0.0015 + Math.sin(i * 7.13) * 0.0002);
    push(open, close, 0.001, t);
    price = close;
  }
  // Phase B — violent chop, no net direction.
  for (let i = 0; i < perPhase; i++, t++) {
    const open = price;
    const close = price * (1 + Math.sin(i / 2) * 0.02);
    push(open, close, 0.02, t);
    price = close;
  }
  return candles;
}

const strategy = parseStrategy({
  version: 1,
  name: "Regime smoke",
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

const candles = twoRegimeCandles(500);
const result = runBacktest(strategy, candles, { initialCapital: 10_000, feePct: 0.1 });
const perBar = classifyRegimes(candles);
const analysis = analyzeRegimes(candles, result.trades);

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
};

// --- Structural invariants
assert(perBar.length === candles.length, "perBar aligns 1:1 to candles");
assert(
  analysis.classifiedBars + analysis.unclassifiedBars === candles.length,
  "classified + unclassified bars == total bars"
);
assert(
  analysis.tradesClassified + analysis.tradesUnclassified === result.trades.length,
  "classified + unclassified trades == total trades"
);
assert(
  analysis.regimes.reduce((s, r) => s + r.trades, 0) === analysis.tradesClassified,
  "per-regime trade counts sum to classified trades"
);
assert(
  Math.abs(analysis.regimes.reduce((s, r) => s + r.barPct, 0) - 100) < 1.0 || analysis.classifiedBars === 0,
  "regime bar shares sum to ~100%"
);

// --- Behavioural: the two phases must produce distinct regimes.
const labels = new Set(perBar.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.label));
assert(labels.size >= 2, `expected multiple regimes, got ${[...labels].join(", ") || "none"}`);
const phaseA = perBar.slice(0, 500).filter((r) => r !== null);
const phaseB = perBar.slice(500).filter((r) => r !== null);
const upInA = phaseA.filter((r) => r!.trend === "up").length / Math.max(1, phaseA.length);
const highVolInB = phaseB.filter((r) => r!.volatility === "high").length / Math.max(1, phaseB.length);
assert(upInA > 0.5, `Phase A should be mostly 'up' trend, was ${(upInA * 100).toFixed(0)}%`);
assert(highVolInB > 0.5, `Phase B should be mostly 'high' vol, was ${(highVolInB * 100).toFixed(0)}%`);

// --- Concentration metric is well-formed.
const netPnl = result.trades.reduce((s, t) => s + t.pnl, 0);
if (netPnl > 0) {
  assert(
    analysis.concentrationPct >= 0 && analysis.concentrationPct <= 100 + 1e-9,
    `concentrationPct in [0,100], was ${analysis.concentrationPct}`
  );
}

console.log("=== Regime analysis smoke ===");
console.log("Bars:", candles.length, "| Trades:", result.trades.length, "| Net PnL:", netPnl.toFixed(2));
console.log("Distinct regimes:", [...labels].sort().join(", "));
console.table(
  analysis.regimes.map((r) => ({
    regime: r.label,
    bars: r.bars,
    "bar%": r.barPct,
    trades: r.trades,
    "win%": r.winRatePct,
    pnl: r.totalPnl,
    "pnl%": r.pnlSharePct,
    pf: r.profitFactor,
  }))
);
console.log("Concentration:", analysis.concentrationPct + "%", "| Profitable regimes:", analysis.profitableRegimes);
console.log("Warnings:");
for (const w of analysis.warnings) console.log("  -", w);
console.log("\nAll regime smoke checks passed.");
