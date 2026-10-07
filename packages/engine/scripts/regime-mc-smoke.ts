/**
 * Phase 3b smoke: regime transition model + regime-aware Monte Carlo.
 * Run with: pnpm --filter @stratforge/engine exec tsx scripts/regime-mc-smoke.ts
 */
import { buildRegimeTransitionModel, regimeAwareMonteCarlo, runBacktest, steadyStateVector } from "../src/index.js";
import { parseStrategy } from "@stratforge/dsl";
import type { Candle } from "../src/types.js";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
};

// --- Transition-model unit checks on a known label sequence.
const labels = ["calm", "calm", "calm", "vol", "vol", "calm", "vol", "vol", "vol", "calm"];
const model = buildRegimeTransitionModel(labels);
assert(model.states.length === 2, "two distinct states");
for (const row of model.matrix) {
  const sum = row.reduce((s, x) => s + x, 0);
  assert(Math.abs(sum - 1) < 1e-9, `each transition-matrix row sums to 1 (got ${sum})`);
}
const ssSum = model.steadyState.reduce((s, x) => s + x, 0);
assert(Math.abs(ssSum - 1) < 1e-9, `steady state sums to 1 (got ${ssSum})`);
assert(model.steadyState.every((p) => p >= 0 && p <= 1), "steady-state entries are probabilities");

// Steady state of a known 2x2 chain: P=[[0.9,0.1],[0.2,0.8]] → π=[2/3,1/3].
const ss = steadyStateVector([[0.9, 0.1], [0.2, 0.8]]);
assert(Math.abs(ss[0] - 2 / 3) < 1e-3 && Math.abs(ss[1] - 1 / 3) < 1e-3, `known steady state ≈ [0.667,0.333] (got [${ss.map((x) => x.toFixed(3))}])`);

// --- Two-regime synthetic: calm low-vol uptrend, then volatile chop.
function twoRegimeCandles(perPhase: number): Candle[] {
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

const strategy = parseStrategy({
  version: 1,
  name: "Regime MC smoke",
  indicators: [
    { id: "fast", type: "sma", params: { period: 10, source: "close" } },
    { id: "slow", type: "sma", params: { period: 30, source: "close" } },
  ],
  entry: [{ left: { kind: "indicator", id: "fast" }, op: "crossesAbove", right: { kind: "indicator", id: "slow" } }],
  exit: [{ left: { kind: "indicator", id: "fast" }, op: "crossesBelow", right: { kind: "indicator", id: "slow" } }],
  risk: { positionSizePct: 50, stopLossPct: 5 },
});
const candles = twoRegimeCandles(500);
const result = runBacktest(strategy, candles, { initialCapital: 10_000, feePct: 0.1 });
const mc = regimeAwareMonteCarlo(candles, result.trades, { iterations: 400 });

assert(mc.tradesUsed <= result.trades.length, "trades used ≤ total trades");
const ssTotal = Object.values(mc.steadyStatePct).reduce((s, x) => s + x, 0);
assert(mc.states.length === 0 || Math.abs(ssTotal - 100) < 1.0, "steadyStatePct sums to ~100%");
if (!mc.warning) {
  assert(mc.iterations === 400, "ran the requested iterations when enough data");
  assert(mc.worstMaxDrawdownPct >= mc.medianMaxDrawdownPct && mc.medianMaxDrawdownPct >= mc.bestMaxDrawdownPct, "drawdown percentiles ordered worst ≥ median ≥ best");
  assert(mc.bestReturnPct >= mc.medianReturnPct && mc.medianReturnPct >= mc.worstReturnPct, "return percentiles ordered best ≥ median ≥ worst");
}

console.log("=== Phase 3b: regime-aware Monte Carlo smoke ===");
console.log("States:", mc.states.join(", ") || "(none)", "| steady-state%:", JSON.stringify(mc.steadyStatePct));
if (mc.warning) console.log("Warning:", mc.warning);
else console.log(`MC (${mc.iterations} sims, ${mc.tradesUsed} trades): maxDD worst/median/best = ${mc.worstMaxDrawdownPct}/${mc.medianMaxDrawdownPct}/${mc.bestMaxDrawdownPct}% · return worst/median/best = ${mc.worstReturnPct}/${mc.medianReturnPct}/${mc.bestReturnPct}%`);
console.log("\nAll regime-MC smoke checks passed.");
