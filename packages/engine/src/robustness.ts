/**
 * Robustness battery (P1) — the anti-overfitting core.
 *
 * Every function is deterministic (permutations are seeded). These operate on a
 * per-bar return series derived from a backtest's equity curve, plus — for the
 * permutation test — the market return and the strategy's in-market mask.
 *
 * Methods and caveats are documented in docs/research/04-statistical-toolkit.md.
 */
import {
  kurtosis,
  mean,
  mulberry32,
  normalCdf,
  normalPpf,
  shuffleInPlace,
  skewness,
  std,
} from "./mathstats.js";
import type { Candle, TimelinePoint } from "./types.js";
import type { Trade } from "./types.js";

const EULER_MASCHERONI = 0.5772156649015328606;

// ---------- series extraction ----------

/** Per-bar simple returns from the equity curve. */
export function equityReturns(timeline: TimelinePoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1].equity;
    if (prev > 0) out.push(timeline[i].equity / prev - 1);
  }
  return out;
}

/** 1 when the strategy held a position on that bar, else 0. */
export function inMarketMask(timeline: TimelinePoint[]): number[] {
  return timeline.map((p) => (p.position > 0 ? 1 : 0));
}

/** Close-to-close market returns aligned to `timeline` bars. */
export function marketReturns(candles: Candle[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    out.push(prev > 0 ? candles[i].close / prev - 1 : 0);
  }
  return out;
}

// ---------- Sharpe family ----------

/** Per-period Sharpe (rf = 0). */
export function sharpeRatio(returns: number[]): number {
  const s = std(returns);
  return s > 0 ? mean(returns) / s : 0;
}

/** Lo (2002) large-sample standard error of the Sharpe ratio (IID). */
export function sharpeStandardError(sr: number, T: number): number {
  if (T < 2) return NaN;
  return Math.sqrt((1 + 0.5 * sr * sr) / T);
}

/**
 * Probabilistic Sharpe Ratio: P(true SR > benchmark), correcting for sample
 * length and non-normality. `sr`/`benchmark` in per-period units, `kurt` is RAW
 * kurtosis (normal = 3).
 */
export function probabilisticSharpe(
  sr: number,
  T: number,
  skew: number,
  kurt: number,
  benchmark = 0
): number {
  if (T < 2) return NaN;
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normalCdf(((sr - benchmark) * Math.sqrt(T - 1)) / denom);
}

/** Expected maximum Sharpe across N independent trials (Bailey & López de Prado). */
export function expectedMaxSharpe(varSharpe: number, N: number, meanSharpe = 0): number {
  if (N < 2) return meanSharpe;
  const g = EULER_MASCHERONI;
  return (
    meanSharpe +
    Math.sqrt(Math.max(0, varSharpe)) *
      ((1 - g) * normalPpf(1 - 1 / N) + g * normalPpf(1 - 1 / (N * Math.E)))
  );
}

/**
 * Deflated Sharpe Ratio: PSR with the benchmark set to the expected maximum
 * Sharpe across N trials. `varSharpe` is the variance of Sharpe across those
 * trials; when unknown, callers may pass the single-strategy Sharpe variance
 * (sharpeStandardError² ) as an approximation.
 */
export function deflatedSharpe(
  sr: number,
  T: number,
  skew: number,
  kurt: number,
  N: number,
  varSharpe: number
): number {
  const sr0 = expectedMaxSharpe(varSharpe, N, 0);
  return probabilisticSharpe(sr, T, skew, kurt, sr0);
}

export interface SharpeAssessment {
  sharpe: number;
  annualizedSharpe?: number;
  standardError: number;
  ci95: [number, number];
  probabilisticSharpe: number;
  deflatedSharpe?: number;
  trials: number;
  periods: number;
  skewness: number;
  kurtosis: number;
}

/**
 * Bundle the Sharpe-significance view. `trials` = number of strategy variants
 * tried to find this one (drives the deflation). `varSharpe` optional (see above).
 */
export function assessSharpe(
  returns: number[],
  opts: { trials?: number; varSharpe?: number; periodsPerYear?: number } = {}
): SharpeAssessment {
  const T = returns.length;
  const sr = sharpeRatio(returns);
  const sk = skewness(returns);
  const ku = kurtosis(returns);
  const se = sharpeStandardError(sr, T);
  const trials = Math.max(1, opts.trials ?? 1);
  const out: SharpeAssessment = {
    sharpe: sr,
    standardError: se,
    ci95: [sr - 1.96 * se, sr + 1.96 * se],
    probabilisticSharpe: probabilisticSharpe(sr, T, sk, ku, 0),
    trials,
    periods: T,
    skewness: sk,
    kurtosis: ku,
  };
  if (opts.periodsPerYear && opts.periodsPerYear > 0) {
    out.annualizedSharpe = sr * Math.sqrt(opts.periodsPerYear);
  }
  if (trials > 1) {
    const varSharpe = opts.varSharpe ?? se * se;
    out.deflatedSharpe = deflatedSharpe(sr, T, sk, ku, trials, varSharpe);
  }
  return out;
}

// ---------- Monte Carlo position permutation ----------

export interface PermutationResult {
  pValue: number;
  realScore: number;
  iterations: number;
  betterOrEqual: number;
}

export interface TradePathDependenceResult {
  score: number;
  iterations: number;
  worstReturnPct: number;
  medianReturnPct: number;
  bestReturnPct: number;
  worstMaxDrawdownPct: number;
  medianMaxDrawdownPct: number;
  bestMaxDrawdownPct: number;
  warning?: string;
}

/**
 * "Is the timing skill or luck?" Compares the strategy's realized exposure to
 * random exposures of the SAME density against the real market returns. A low
 * p-value means the rules beat coin-flip positioning. Tests timing only
 * (ignores sizing/fees), and is seeded for reproducibility.
 */
export function monteCarloPermutation(
  inMarket: number[],
  marketRet: number[],
  iterations = 1000,
  seed = 12345
): PermutationResult {
  const n = Math.min(inMarket.length, marketRet.length);
  const mask = inMarket.slice(0, n);
  const ret = marketRet.slice(0, n);
  const score = (m: number[]) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += m[i] * ret[i];
    return s;
  };
  const realScore = score(mask);
  const rng = mulberry32(seed);
  let betterOrEqual = 0;
  for (let it = 0; it < iterations; it++) {
    const permuted = shuffleInPlace(mask.slice(), rng);
    if (score(permuted) >= realScore) betterOrEqual++;
  }
  return {
    pValue: (betterOrEqual + 1) / (iterations + 1),
    realScore,
    iterations,
    betterOrEqual,
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[pos];
}

function simulatedTradePath(pnls: number[], initialCapital: number): { returnPct: number; maxDrawdownPct: number } {
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdownPct = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);
  }
  return {
    returnPct: initialCapital > 0 ? ((equity - initialCapital) / initialCapital) * 100 : 0,
    maxDrawdownPct,
  };
}

export function tradePathDependence(
  trades: Trade[],
  initialCapital = 10_000,
  iterations = 500,
  seed = 20260621
): TradePathDependenceResult {
  const pnls = trades.map((t) => t.pnl);
  if (pnls.length < 5) {
    return {
      score: 0,
      iterations: 0,
      worstReturnPct: 0,
      medianReturnPct: 0,
      bestReturnPct: 0,
      worstMaxDrawdownPct: 0,
      medianMaxDrawdownPct: 0,
      bestMaxDrawdownPct: 0,
      warning: "Too few trades for path-dependence analysis.",
    };
  }

  const rng = mulberry32(seed);
  const returns: number[] = [];
  const drawdowns: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sim = simulatedTradePath(shuffleInPlace(pnls.slice(), rng), initialCapital);
    returns.push(sim.returnPct);
    drawdowns.push(sim.maxDrawdownPct);
  }
  returns.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  const worstReturnPct = percentile(returns, 0.05);
  const medianReturnPct = percentile(returns, 0.5);
  const bestReturnPct = percentile(returns, 0.95);
  const medianMaxDrawdownPct = percentile(drawdowns, 0.5);
  const worstMaxDrawdownPct = percentile(drawdowns, 0.95);
  const bestMaxDrawdownPct = percentile(drawdowns, 0.05);
  const ddSpread = Math.max(0, worstMaxDrawdownPct - bestMaxDrawdownPct);
  const score = Math.max(0, Math.min(100, Math.round(ddSpread * 4 + medianMaxDrawdownPct * 0.5)));
  const warning =
    score >= 60
      ? `Path-dependent result: score ${score}/100. Trade order materially changes drawdown risk; do not trust the single equity curve.`
      : undefined;

  return {
    score,
    iterations,
    worstReturnPct,
    medianReturnPct,
    bestReturnPct,
    worstMaxDrawdownPct,
    medianMaxDrawdownPct,
    bestMaxDrawdownPct,
    warning,
  };
}

// ---------- Out-of-sample & walk-forward ----------

function totalReturn(returns: number[]): number {
  let eq = 1;
  for (const r of returns) eq *= 1 + r;
  return eq - 1;
}

export interface SplitStats {
  periods: number;
  totalReturnPct: number;
  sharpe: number;
}
export interface OutOfSampleResult {
  inSample: SplitStats;
  outOfSample: SplitStats;
  /** Sharpe degradation (in-sample − out-of-sample). Large positive = overfit. */
  sharpeDegradation: number;
}

const splitStats = (r: number[]): SplitStats => ({
  periods: r.length,
  totalReturnPct: totalReturn(r) * 100,
  sharpe: sharpeRatio(r),
});

/** Hold out the last `1 - fraction` of the series as untouched out-of-sample. */
export function outOfSampleSplit(returns: number[], fraction = 0.7): OutOfSampleResult {
  const cut = Math.floor(returns.length * fraction);
  const inSample = splitStats(returns.slice(0, cut));
  const outOfSample = splitStats(returns.slice(cut));
  return { inSample, outOfSample, sharpeDegradation: inSample.sharpe - outOfSample.sharpe };
}

export interface WalkForwardResult {
  folds: SplitStats[];
  profitableFraction: number;
  meanSharpe: number;
}

/** Split into `folds` contiguous windows and report per-window consistency. */
export function walkForward(returns: number[], folds = 5): WalkForwardResult {
  const out: SplitStats[] = [];
  const size = Math.floor(returns.length / folds);
  if (size < 2) return { folds: [], profitableFraction: 0, meanSharpe: 0 };
  for (let i = 0; i < folds; i++) {
    const start = i * size;
    const end = i === folds - 1 ? returns.length : start + size;
    out.push(splitStats(returns.slice(start, end)));
  }
  const profitable = out.filter((f) => f.totalReturnPct > 0).length;
  return {
    folds: out,
    profitableFraction: out.length ? profitable / out.length : 0,
    meanSharpe: mean(out.map((f) => f.sharpe)),
  };
}

// ---------- Distribution tests ----------

export interface NormalityResult {
  statistic: number;
  pValue: number;
  skewness: number;
  excessKurtosis: number;
}

/** Jarque–Bera normality test. pValue via chi-square(df=2) survival = exp(-JB/2). */
export function jarqueBera(returns: number[]): NormalityResult {
  const n = returns.length;
  const sk = skewness(returns);
  const exKurt = kurtosis(returns) - 3;
  const jb = (n / 6) * (sk * sk + (exKurt * exKurt) / 4);
  return { statistic: jb, pValue: Math.exp(-jb / 2), skewness: sk, excessKurtosis: exKurt };
}

/** One-sample Kolmogorov–Smirnov D against a fitted normal. Lower = closer to normal. */
export function ksTestNormal(returns: number[]): { statistic: number; criticalValue05: number } {
  const n = returns.length;
  if (n === 0) return { statistic: NaN, criticalValue05: NaN };
  const m = mean(returns);
  const sd = std(returns);
  const sorted = [...returns].sort((a, b) => a - b);
  let d = 0;
  for (let i = 0; i < n; i++) {
    const cdf = sd > 0 ? normalCdf((sorted[i] - m) / sd) : 0.5;
    d = Math.max(d, Math.abs((i + 1) / n - cdf), Math.abs(cdf - i / n));
  }
  return { statistic: d, criticalValue05: 1.36 / Math.sqrt(n) };
}

// ---------- Top-level agent tool ----------

export interface RobustnessReport {
  sharpe: SharpeAssessment;
  permutation: PermutationResult;
  pathDependence: TradePathDependenceResult;
  outOfSample: OutOfSampleResult;
  walkForward: WalkForwardResult;
  normality: NormalityResult;
  /** Plain-language flags the agent should not ignore. */
  warnings: string[];
}

/**
 * Run the whole P1 battery on a finished backtest. `trials` = how many variants
 * were tried to arrive at this strategy (critical for honest deflation).
 */
export function assessRobustness(
  timeline: TimelinePoint[],
  candles: Candle[],
  opts: { trials?: number; periodsPerYear?: number; iterations?: number; oosFraction?: number; trades?: Trade[]; initialCapital?: number } = {}
): RobustnessReport {
  const returns = equityReturns(timeline);
  const sharpe = assessSharpe(returns, { trials: opts.trials, periodsPerYear: opts.periodsPerYear });
  const permutation = monteCarloPermutation(
    inMarketMask(timeline),
    marketReturns(candles),
    opts.iterations ?? 1000
  );
  const outOfSample = outOfSampleSplit(returns, opts.oosFraction ?? 0.7);
  const wf = walkForward(returns, 5);
  const normality = jarqueBera(returns);
  const pathDependence = tradePathDependence(opts.trades ?? [], opts.initialCapital ?? 10_000, opts.iterations ?? 500);

  const warnings: string[] = [];
  if (permutation.pValue > 0.05)
    warnings.push(
      `Timing not significant: ${(permutation.pValue * 100).toFixed(1)}% of random entries did as well (p>${0.05}).`
    );
  if (sharpe.deflatedSharpe !== undefined && sharpe.deflatedSharpe < 0.95)
    warnings.push(
      `Deflated Sharpe ${(sharpe.deflatedSharpe * 100).toFixed(0)}% after ${sharpe.trials} trials — below 95% confidence of a real edge.`
    );
  if (outOfSample.sharpeDegradation > 0.5)
    warnings.push(
      `Out-of-sample Sharpe collapses from ${outOfSample.inSample.sharpe.toFixed(2)} to ${outOfSample.outOfSample.sharpe.toFixed(2)} — likely overfit.`
    );
  if (wf.profitableFraction < 0.6)
    warnings.push(
      `Only ${(wf.profitableFraction * 100).toFixed(0)}% of walk-forward windows were profitable — inconsistent across time.`
    );
  if (pathDependence.warning) warnings.push(pathDependence.warning);

  return { sharpe, permutation, pathDependence, outOfSample, walkForward: wf, normality, warnings };
}
