// Walk-forward optimization orchestration: bridges the editor's Builder model to the
// engine's walkForwardOptimize. Runtime DSL/engine imports live here (not in the pure
// strategyBuilder module) so the builder primitives stay smoke-testable on their own.
import { parseStrategy, type StrategySpec } from "@stratforge/dsl";
import { makeGrid, walkForwardOptimize, type Candle, type WfoResult } from "@stratforge/engine";
import {
  applyParamsToBuilder,
  buildSpec,
  listOptimizableParams,
  specToBuilder,
  type Builder,
} from "./strategyBuilder.js";

/** A concrete point in the parameter grid: addressed numeric overrides for a builder. */
export type SweepParams = Record<string, number>;

/** The SpecBuilder<P> the engine's walkForwardOptimize expects: substitute swept
 *  numeric params into the base builder and produce a validated StrategySpec. Throws
 *  (via parseStrategy) if a substitution yields an invalid strategy, surfacing a bad
 *  grid early rather than silently backtesting garbage. */
export function makeSpecBuilder(base: Builder): (params: SweepParams) => StrategySpec {
  return (params) => parseStrategy(buildSpec(applyParamsToBuilder(base, params)));
}

// Guard rails. A grid is multiple testing — these caps keep the run responsive AND
// stop the analyst from running an absurd, statistically dishonest search. They are
// deliberately conservative; the engine deflates by the trial count regardless.
export const OPTIMIZE_MAX_GRID = 400; // cartesian grid points
export const OPTIMIZE_MAX_TRIALS = 2000; // grid points × windows (total backtests)
export const OPTIMIZE_WINDOW_RANGE = { min: 2, max: 8, default: 4 } as const;

export interface OptimizePlanError {
  error: string;
  validAddresses?: string[];
}
export interface OptimizePlan {
  builder: Builder;
  grid: SweepParams[];
  gridSize: number;
  windows: number;
  estimatedTrials: number;
}
export interface OptimizeOutcome {
  result: WfoResult<SweepParams>;
  gridSize: number;
  windows: number;
  /** grid points × windows actually evaluated — the number to add to the session
   *  multiple-testing counter so later backtests inherit the inflated trial count. */
  trialsRun: number;
}

// Serializable, store-friendly view of an optimization run — rendered in the Strategy
// tab and persisted in workspace state. Plain numbers/strings only (no engine types).
export interface OptimizationWindowSummary {
  trainBars: number;
  testBars: number;
  bestParams: SweepParams;
  oosReturnPct: number;
}
export interface OptimizationSummary {
  strategyName: string;
  verdict: string;
  oosSharpe: number;
  deflatedSharpe: number | null;
  oosTotalReturnPct: number;
  profitableWindowFraction: number;
  gridSize: number;
  windows: number;
  trialsRun: number;
  perWindow: OptimizationWindowSummary[];
}

export function summarizeOptimization(outcome: OptimizeOutcome, strategyName: string): OptimizationSummary {
  const r = outcome.result;
  return {
    strategyName,
    verdict: r.verdict,
    oosSharpe: r.oosSharpe,
    deflatedSharpe: r.deflatedSharpe ?? null,
    oosTotalReturnPct: r.oosTotalReturnPct,
    profitableWindowFraction: r.profitableWindowFraction,
    gridSize: outcome.gridSize,
    windows: outcome.windows,
    trialsRun: outcome.trialsRun,
    perWindow: r.windows.map((w) => ({
      trainBars: w.trainBars,
      testBars: w.testBars,
      bestParams: w.bestParams,
      oosReturnPct: w.oosReturnPct,
    })),
  };
}

function clampWindows(windows: number): number {
  const { min, max, default: def } = OPTIMIZE_WINDOW_RANGE;
  if (!Number.isFinite(windows)) return def;
  return Math.max(min, Math.min(max, Math.round(windows)));
}

/** Validate a requested grid against the strategy and the guard-rail caps, and expand
 *  it to a concrete list of parameter combinations. Pure — no backtests run here. */
export function planOptimization(
  baseSpec: StrategySpec,
  ranges: Record<string, number[]>,
  windows: number = OPTIMIZE_WINDOW_RANGE.default
): OptimizePlan | OptimizePlanError {
  const builder = specToBuilder(baseSpec);
  const valid = listOptimizableParams(builder).map((p) => p.key);
  const validSet = new Set(valid);

  const addresses = Object.keys(ranges);
  if (addresses.length === 0) {
    return { error: "Provide at least one parameter range to sweep.", validAddresses: valid };
  }
  const unknown = addresses.filter((a) => !validSet.has(a));
  if (unknown.length) {
    return { error: `Unknown parameter address(es): ${unknown.join(", ")}.`, validAddresses: valid };
  }
  for (const a of addresses) {
    const vs = ranges[a];
    if (!Array.isArray(vs) || vs.length === 0 || !vs.every((v) => Number.isFinite(v))) {
      return { error: `Range for "${a}" must be a non-empty array of finite numbers.` };
    }
  }

  const gridSize = addresses.reduce((n, a) => n * ranges[a].length, 1);
  if (gridSize > OPTIMIZE_MAX_GRID) {
    return {
      error: `Grid is ${gridSize} combinations (cap ${OPTIMIZE_MAX_GRID}). Narrow the ranges — every combination is another test to deflate for.`,
    };
  }
  const w = clampWindows(windows);
  const estimatedTrials = gridSize * w;
  if (estimatedTrials > OPTIMIZE_MAX_TRIALS) {
    return {
      error: `That grid implies ~${estimatedTrials} backtests (cap ${OPTIMIZE_MAX_TRIALS}). Reduce the grid or the window count.`,
    };
  }

  const grid = makeGrid(ranges as Record<string, number[]>) as SweepParams[];
  return { builder, grid, gridSize, windows: w, estimatedTrials };
}

/** Run anchored walk-forward optimization for a base strategy over a parameter grid.
 *  Returns the engine's honest, OOS-only, trial-deflated result plus the trial count
 *  the caller should fold into the session multiple-testing counter. */
export function runOptimization(
  baseSpec: StrategySpec,
  ranges: Record<string, number[]>,
  candles: Candle[],
  windows: number = OPTIMIZE_WINDOW_RANGE.default
): OptimizeOutcome | OptimizePlanError {
  const plan = planOptimization(baseSpec, ranges, windows);
  if ("error" in plan) return plan;
  const build = makeSpecBuilder(plan.builder);
  const result = walkForwardOptimize(build, candles, plan.grid, { windows: plan.windows });
  return { result, gridSize: plan.gridSize, windows: plan.windows, trialsRun: result.totalTrials };
}
