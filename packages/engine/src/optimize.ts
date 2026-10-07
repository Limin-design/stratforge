/**
 * Parameter optimization with overfitting guards baked in.
 *
 * The danger of optimization is that searching a grid IS multiple testing — try
 * enough parameter sets and one looks brilliant by luck. So every search here
 * counts its trials and feeds them into the Deflated Sharpe, and walk-forward
 * optimization only ever reports OUT-OF-SAMPLE performance. The optimizer
 * cannot fool itself. See docs/research/04 §2.
 */
import type { StrategySpec } from "@stratforge/dsl";
import { runBacktest, type BacktestOptions } from "./backtest.js";
import { assessSharpe, equityReturns, sharpeRatio } from "./robustness.js";
import type { BacktestStats, Candle } from "./types.js";

export type SpecBuilder<P> = (params: P) => StrategySpec;
export type Objective = (stats: BacktestStats) => number; // higher = better

const DEFAULT_OBJECTIVE: Objective = (s) => s.sharpe;
const DEFAULT_BT: BacktestOptions = { feePct: 0.1, slippagePct: 0.05 };

/** Cartesian product of parameter ranges → a flat grid of param objects. */
export function makeGrid<P extends Record<string, number>>(ranges: {
  [K in keyof P]: number[];
}): P[] {
  let combos: Record<string, number>[] = [{}];
  for (const key of Object.keys(ranges)) {
    const next: Record<string, number>[] = [];
    for (const combo of combos) {
      for (const v of (ranges as Record<string, number[]>)[key]) {
        next.push({ ...combo, [key]: v });
      }
    }
    combos = next;
  }
  return combos as P[];
}

export interface GridResult<P> {
  params: P;
  stats: BacktestStats;
  score: number;
}

/** Rank every parameter combination on the full sample (in-sample). */
export function gridSearch<P>(
  build: SpecBuilder<P>,
  candles: Candle[],
  grid: P[],
  opts: { objective?: Objective; backtest?: BacktestOptions } = {}
): GridResult<P>[] {
  const objective = opts.objective ?? DEFAULT_OBJECTIVE;
  const bt = opts.backtest ?? DEFAULT_BT;
  const results = grid.map((params) => {
    const stats = runBacktest(build(params), candles, bt).stats;
    return { params, stats, score: objective(stats) };
  });
  results.sort((a, b) => b.score - a.score);
  return results;
}

export interface WfoWindow<P> {
  trainBars: number;
  testBars: number;
  bestParams: P;
  inSampleScore: number;
  oosReturnPct: number;
}

export interface WfoResult<P> {
  windows: WfoWindow<P>[];
  oosReturns: number[];
  oosTotalReturnPct: number;
  oosSharpe: number;
  deflatedSharpe: number | undefined;
  totalTrials: number;
  profitableWindowFraction: number;
  /** In-sample best score on the full sample, for the inflation comparison. */
  inSampleBestScore: number;
  verdict: string;
}

function compound(returns: number[]): number {
  let eq = 1;
  for (const r of returns) eq *= 1 + r;
  return (eq - 1) * 100;
}

/**
 * Anchored walk-forward optimization: for each test block, pick the best params
 * on all PRIOR data (in-sample), then measure them on the unseen block. Stitch
 * the out-of-sample returns and deflate by the total number of trials run.
 */
export function walkForwardOptimize<P>(
  build: SpecBuilder<P>,
  candles: Candle[],
  grid: P[],
  opts: { windows?: number; objective?: Objective; backtest?: BacktestOptions } = {}
): WfoResult<P> {
  const windows = opts.windows ?? 4;
  const objective = opts.objective ?? DEFAULT_OBJECTIVE;
  const bt = opts.backtest ?? DEFAULT_BT;
  const n = candles.length;
  const block = Math.floor(n / (windows + 1)); // first block reserved as the initial training base

  const wfWindows: WfoWindow<P>[] = [];
  const oosReturns: number[] = [];
  let evaluated = 0;

  for (let w = 1; w <= windows; w++) {
    const ts = w * block;
    const te = w === windows ? n : (w + 1) * block;
    if (ts < block || te - ts < 5) continue;

    const train = candles.slice(0, ts);
    const best = gridSearch(build, train, grid, { objective, backtest: bt })[0];

    // Run the chosen params over [0, te) so indicators are warm, then take the
    // returns generated during the unseen test block [ts, te).
    const full = runBacktest(build(best.params), candles.slice(0, te), bt);
    const testRets = equityReturns(full.timeline).slice(ts);
    oosReturns.push(...testRets);

    wfWindows.push({
      trainBars: ts,
      testBars: te - ts,
      bestParams: best.params,
      inSampleScore: best.score,
      oosReturnPct: compound(testRets),
    });
    evaluated += 1;
  }

  const totalTrials = grid.length * Math.max(1, evaluated);
  const oosSharpe = sharpeRatio(oosReturns);
  const assess = assessSharpe(oosReturns, { trials: totalTrials });
  const profitable = wfWindows.filter((w) => w.oosReturnPct > 0).length;
  const profitableWindowFraction = wfWindows.length ? profitable / wfWindows.length : 0;
  const inSampleBestScore = gridSearch(build, candles, grid, { objective, backtest: bt })[0]?.score ?? 0;

  let verdict: string;
  if (oosReturns.length < 10) {
    verdict = "insufficient out-of-sample data to judge.";
  } else if (oosSharpe <= 0) {
    verdict = `overfit — in-sample looks good (best score ${inSampleBestScore.toFixed(2)}) but out-of-sample Sharpe is ${oosSharpe.toFixed(2)} across ${totalTrials} trials.`;
  } else if (assess.deflatedSharpe !== undefined && assess.deflatedSharpe >= 0.95) {
    verdict = `robust — survives walk-forward, OOS Sharpe ${oosSharpe.toFixed(2)}, Deflated Sharpe ${(assess.deflatedSharpe * 100).toFixed(0)}% after ${totalTrials} trials.`;
  } else {
    verdict = `weak — some OOS edge (Sharpe ${oosSharpe.toFixed(2)}) but not significant after deflating for ${totalTrials} trials (Deflated Sharpe ${((assess.deflatedSharpe ?? 0) * 100).toFixed(0)}%).`;
  }

  return {
    windows: wfWindows,
    oosReturns,
    oosTotalReturnPct: compound(oosReturns),
    oosSharpe,
    deflatedSharpe: assess.deflatedSharpe,
    totalTrials,
    profitableWindowFraction,
    inSampleBestScore,
    verdict,
  };
}
