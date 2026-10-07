// Integration smoke for the walk-forward optimization orchestration. Unlike the pure
// strategy-optimize smoke, this exercises the REAL engine (tsx resolves @stratforge/*
// from src), so it validates the grid guard rails AND a full optimization run end to
// end: trial counting, determinism, and the engine's honest OOS verdict.
import { parseStrategy } from "@stratforge/dsl";
import type { Candle } from "@stratforge/engine";
import {
  OPTIMIZE_MAX_GRID,
  OPTIMIZE_MAX_TRIALS,
  planOptimization,
  runOptimization,
  summarizeOptimization,
} from "../src/panels/strategyOptimize.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const baseSpec = parseStrategy({
  version: 1,
  name: "Golden Cross",
  indicators: [
    { id: "fast", type: "sma", params: { period: 10, source: "close" } },
    { id: "slow", type: "sma", params: { period: 30, source: "close" } },
  ],
  entry: [{ left: { kind: "indicator", id: "fast" }, op: "crossesAbove", right: { kind: "indicator", id: "slow" } }],
  exit: [{ left: { kind: "indicator", id: "fast" }, op: "crossesBelow", right: { kind: "indicator", id: "slow" } }],
  risk: { positionSizePct: 50, stopLossPct: 5 },
});

// Deterministic synthetic series with trend + cycles so an SMA cross actually trades.
const candles: Candle[] = [];
let t = 1_700_000_000;
for (let i = 0; i < 240; i++) {
  const mid = 100 + i * 0.15 + Math.sin(i / 6) * 9 + Math.sin(i / 23) * 4;
  const close = mid + Math.sin(i / 3) * 1.2;
  const open = mid;
  candles.push({
    time: t,
    open,
    close,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    volume: 1000,
  });
  t += 3600;
}

// --- Plan validation (pure guard rails) ---

const unknownPlan = planOptimization(baseSpec, { "ind:ghost:period": [1, 2] });
assert("error" in unknownPlan, "an unknown address must be rejected");
assert(unknownPlan.error.includes("Unknown"), "the error must name the problem as an unknown address");
assert(Array.isArray(unknownPlan.validAddresses) && unknownPlan.validAddresses.includes("ind:fast:period"), "rejection must list valid addresses for the model");

assert("error" in planOptimization(baseSpec, {}), "an empty grid must be rejected");
const badRange = planOptimization(baseSpec, { "ind:fast:period": [] });
assert("error" in badRange && badRange.error.includes("non-empty"), "an empty range array must be rejected");
const nanRange = planOptimization(baseSpec, { "ind:fast:period": [Number.NaN] });
assert("error" in nanRange, "a non-finite range value must be rejected");

// Grid-size cap: 21 × 21 = 441 > 400.
const big = Array.from({ length: 21 }, (_, i) => i + 1);
const gridCap = planOptimization(baseSpec, { "ind:fast:period": big, "ind:slow:period": big });
assert("error" in gridCap && gridCap.error.includes(String(OPTIMIZE_MAX_GRID)), "an oversized grid must hit the grid cap");

// Trials cap: a 300-point single-axis grid × 8 windows = 2400 > 2000 (under the grid cap).
const huge = Array.from({ length: 300 }, (_, i) => i + 1);
const trialsCap = planOptimization(baseSpec, { "ind:fast:period": huge }, 8);
assert("error" in trialsCap && trialsCap.error.includes(String(OPTIMIZE_MAX_TRIALS)), "an oversized trial count must hit the trials cap");

// Valid plan expands to the cartesian grid with clamped windows.
const okPlan = planOptimization(baseSpec, { "ind:fast:period": [5, 10], "ind:slow:period": [30, 50] }, 3);
assert(!("error" in okPlan), "a valid grid must produce a plan");
if (!("error" in okPlan)) {
  assert(okPlan.gridSize === 4 && okPlan.grid.length === 4, "grid must be the 2×2 cartesian product");
  assert(okPlan.windows === 3 && okPlan.estimatedTrials === 12, "plan must carry clamped windows and estimated trials");
}

// --- Full optimization run (real engine) ---

const ranges = { "ind:fast:period": [5, 10], "ind:slow:period": [20, 40] };
const outcome = runOptimization(baseSpec, ranges, candles, 3);
assert(!("error" in outcome), "a valid optimization over sufficient data must run");
if (!("error" in outcome)) {
  const r = outcome.result;
  assert(outcome.gridSize === 4 && outcome.windows === 3, "outcome must report grid size and window count");
  assert(r.windows.length === 3, "all three windows must be evaluated on 240 bars");
  assert(outcome.trialsRun === r.totalTrials, "trialsRun (fed to the session counter) must equal the engine's totalTrials");
  assert(outcome.trialsRun === 12, "trials must be gridSize × evaluated windows = 4 × 3");
  assert(typeof r.verdict === "string" && r.verdict.length > 0, "the engine must return a plain verdict string");
  assert(Number.isFinite(r.oosSharpe), "OOS Sharpe must be finite");
  assert(
    r.windows.every((w) => {
      const p = w.bestParams as Record<string, number>;
      return "ind:fast:period" in p && "ind:slow:period" in p && ranges["ind:fast:period"].includes(p["ind:fast:period"]);
    }),
    "each window's bestParams must carry the swept addresses with values drawn from the grid"
  );

  // Determinism: identical inputs must give an identical result (no hidden RNG drift).
  const again = runOptimization(baseSpec, ranges, candles, 3);
  assert(!("error" in again), "second run must also succeed");
  if (!("error" in again)) {
    assert(again.result.oosSharpe === r.oosSharpe, "optimization must be deterministic (OOS Sharpe)");
    assert(again.result.totalTrials === r.totalTrials, "optimization must be deterministic (trial count)");
    assert(again.result.verdict === r.verdict, "optimization must be deterministic (verdict)");
  }

  // summarizeOptimization: the serializable view the store/Strategy-tab render from.
  const summary = summarizeOptimization(outcome, "Golden Cross");
  assert(summary.strategyName === "Golden Cross", "summary must carry the strategy name");
  assert(summary.verdict === r.verdict && summary.oosSharpe === r.oosSharpe, "summary must mirror the engine result");
  assert(summary.trialsRun === outcome.trialsRun && summary.gridSize === 4 && summary.windows === 3, "summary must carry run metadata");
  assert(summary.deflatedSharpe === (r.deflatedSharpe ?? null), "undefined deflated Sharpe must normalize to null for the store");
  assert(summary.perWindow.length === 3 && "ind:fast:period" in summary.perWindow[0].bestParams, "summary must include per-window best params");
  assert(JSON.parse(JSON.stringify(summary)).trialsRun === summary.trialsRun, "summary must be JSON-serializable for workspace state");
}

console.log("strategy optimize run smoke passed");
