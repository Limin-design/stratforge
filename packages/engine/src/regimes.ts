/**
 * Regime analysis — per-regime performance attribution.
 *
 * Classifies every bar into a market regime (trend direction × volatility bucket)
 * and attributes each trade to the regime at its ENTRY bar, then reports how the
 * strategy performed in each. The point is honesty, not decoration: an "edge" that
 * only exists in one regime is usually overfit to that regime, and this surfaces it.
 *
 * Classification is descriptive post-hoc labelling of historical bars (used only to
 * group already-realized trades), not a tradeable signal — so full-sample volatility
 * percentiles are appropriate here and introduce no backtest look-ahead.
 *
 * Pure TS, deterministic. Reuses the Wilder ADX/ATR primitives from indicators.ts.
 */
import { adx, atr } from "./indicators.js";
import { mulberry32 } from "./mathstats.js";
import type { Candle, Trade } from "./types.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type TrendState = "up" | "down" | "range";
export type VolBucket = "low" | "normal" | "high";

/** Per-bar classification, aligned 1:1 to candles. `null` = warm-up / unclassifiable. */
export interface BarRegime {
  trend: TrendState;
  volatility: VolBucket;
  /** Combined label, e.g. "up/high". */
  label: string;
}

export interface RegimePerformance {
  label: string;
  trend: TrendState;
  volatility: VolBucket;
  /** Bars classified into this regime. */
  bars: number;
  /** Share of all classified bars (%). */
  barPct: number;
  /** Trades whose ENTRY bar fell in this regime. */
  trades: number;
  winRatePct: number;
  /** Net PnL of those trades, account currency. */
  totalPnl: number;
  /** Mean PnL per trade in this regime, account currency. */
  expectancy: number;
  profitFactor: number;
  /** Signed share of the strategy's net PnL produced here (%). */
  pnlSharePct: number;
}

export interface RegimeAnalysis {
  /** Per-bar labels, aligned to candles (null during warm-up). */
  perBar: (BarRegime | null)[];
  /** Performance rows, sorted by trade count desc. */
  regimes: RegimePerformance[];
  classifiedBars: number;
  unclassifiedBars: number;
  tradesClassified: number;
  tradesUnclassified: number;
  /** Largest signed PnL share from any single regime (%). High = edge depends on one regime. */
  concentrationPct: number;
  /** Largest share of gross losses from a single regime (%). High = losses are regime-specific. */
  lossConcentrationPct: number;
  /** Regime label carrying the largest share of gross losses, or null if no losses. */
  worstRegimeLabel: string | null;
  /** Number of regimes in which the strategy was net profitable. */
  profitableRegimes: number;
  warnings: string[];
}

export interface RegimeOptions {
  /** ADX period (Wilder). Default 14. */
  adxPeriod?: number;
  /** ATR period (Wilder). Default 14. */
  atrPeriod?: number;
  /** ADX level above which a bar is "trending" (else "range"). Default 25. */
  trendThreshold?: number;
  /**
   * Volatility bucket cut points as quantiles of ATR-as-%-of-price across the
   * sample, [lowMax, normalMax]. Default [0.33, 0.66] (terciles).
   */
  volQuantiles?: [number, number];
}

/** Value at quantile `q` (0..1) of an already-sorted ascending array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[pos];
}

/**
 * Classify each bar by trend (ADX + directional index) and volatility (ATR% bucket).
 * Bars are `null` until both ADX and ATR are warm.
 */
export function classifyRegimes(candles: Candle[], opts: RegimeOptions = {}): (BarRegime | null)[] {
  const n = candles.length;
  const adxPeriod = opts.adxPeriod ?? 14;
  const atrPeriod = opts.atrPeriod ?? 14;
  const trendThreshold = opts.trendThreshold ?? 25;
  const [lowQ, normQ] = opts.volQuantiles ?? [0.33, 0.66];

  const { adx: adxLine, plusDI, minusDI } = adx(candles, adxPeriod);
  const atrLine = atr(candles, atrPeriod);

  // ATR as a fraction of price, so the buckets are comparable across instruments.
  const atrPct = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const c = candles[i].close;
    if (!Number.isNaN(atrLine[i]) && c > 0) atrPct[i] = atrLine[i] / c;
  }
  const finiteAtr = atrPct.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  const lowMax = quantile(finiteAtr, lowQ);
  const normalMax = quantile(finiteAtr, normQ);

  const out: (BarRegime | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(adxLine[i]) || Number.isNaN(atrPct[i])) continue;

    let trend: TrendState;
    if (adxLine[i] < trendThreshold) trend = "range";
    else trend = plusDI[i] >= minusDI[i] ? "up" : "down";

    let volatility: VolBucket;
    if (atrPct[i] <= lowMax) volatility = "low";
    else if (atrPct[i] <= normalMax) volatility = "normal";
    else volatility = "high";

    out[i] = { trend, volatility, label: `${trend}/${volatility}` };
  }
  return out;
}

/**
 * Classify bars, attribute trades to their entry-bar regime, and report
 * per-regime performance plus honest concentration warnings.
 */
export function analyzeRegimes(
  candles: Candle[],
  trades: Trade[],
  opts: RegimeOptions = {}
): RegimeAnalysis {
  const perBar = classifyRegimes(candles, opts);

  const classifiedBars = perBar.reduce((s, r) => s + (r ? 1 : 0), 0);
  const unclassifiedBars = perBar.length - classifiedBars;

  // Bar counts per regime label.
  const barCounts = new Map<string, number>();
  for (const r of perBar) if (r) barCounts.set(r.label, (barCounts.get(r.label) ?? 0) + 1);

  // Bucket trades by the regime at their entry bar.
  const buckets = new Map<string, Trade[]>();
  let tradesUnclassified = 0;
  for (const t of trades) {
    const r = perBar[t.entryBar];
    if (!r) {
      tradesUnclassified += 1;
      continue;
    }
    const arr = buckets.get(r.label);
    if (arr) arr.push(t);
    else buckets.set(r.label, [t]);
  }

  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const parse = (label: string): { trend: TrendState; volatility: VolBucket } => {
    const [trend, volatility] = label.split("/") as [TrendState, VolBucket];
    return { trend, volatility };
  };

  // Build a row for every regime that has either bars or trades.
  const labels = new Set<string>([...barCounts.keys(), ...buckets.keys()]);
  const regimes: RegimePerformance[] = [];
  for (const label of labels) {
    const ts = buckets.get(label) ?? [];
    const wins = ts.filter((t) => t.pnl > 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(ts.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const totalPnl = ts.reduce((s, t) => s + t.pnl, 0);
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const { trend, volatility } = parse(label);
    const bars = barCounts.get(label) ?? 0;
    regimes.push({
      label,
      trend,
      volatility,
      bars,
      barPct: classifiedBars > 0 ? round2((bars / classifiedBars) * 100) : 0,
      trades: ts.length,
      winRatePct: ts.length ? round2((wins.length / ts.length) * 100) : 0,
      totalPnl: round2(totalPnl),
      expectancy: ts.length ? round2(totalPnl / ts.length) : 0,
      profitFactor: Number.isFinite(profitFactor) ? round2(profitFactor) : Infinity,
      pnlSharePct: netPnl !== 0 ? round2((totalPnl / netPnl) * 100) : 0,
    });
  }
  regimes.sort((a, b) => b.trades - a.trades);

  const tradesClassified = trades.length - tradesUnclassified;
  const profitableRegimes = regimes.filter((r) => r.totalPnl > 0).length;
  // Concentration: largest single-regime contribution as a share of net PnL.
  const concentrationPct =
    netPnl > 0
      ? round2(
          (Math.max(0, ...regimes.map((r) => r.totalPnl)) / netPnl) * 100
        )
      : 0;

  const warnings: string[] = [];
  if (tradesClassified < 30)
    warnings.push(
      `Only ${tradesClassified} trades land in a classified regime — too few to trust per-regime breakdowns.`
    );
  if (netPnl > 0 && concentrationPct > 70)
    warnings.push(
      `Edge concentration: ${concentrationPct}% of net PnL comes from a single regime. The strategy may only work in that regime — validate before trusting it elsewhere.`
    );
  const regimesWithTrades = regimes.filter((r) => r.trades > 0).length;
  if (regimesWithTrades >= 3 && profitableRegimes <= 1 && netPnl > 0)
    warnings.push(
      `Profitable in only ${profitableRegimes} of ${regimesWithTrades} traded regimes — the result is carried by one regime and is fragile.`
    );
  // Symmetric to concentration: are the LOSSES carried by one regime? If so, the
  // honest fix is usually to filter entries out of that regime, not to keep the strategy.
  let lossConcentrationPct = 0;
  let worstRegimeLabel: string | null = null;
  if (tradesClassified > 0) {
    const grossLossByRegime = regimes.map((r) => (r.totalPnl < 0 ? -r.totalPnl : 0));
    const totalGrossLoss = grossLossByRegime.reduce((s, x) => s + x, 0);
    const worst = Math.max(0, ...grossLossByRegime);
    if (totalGrossLoss > 0) {
      lossConcentrationPct = round2((worst / totalGrossLoss) * 100);
      worstRegimeLabel = regimes[grossLossByRegime.indexOf(worst)]?.label ?? null;
      if (lossConcentrationPct > 70)
        warnings.push(
          `Losses are concentrated: ${lossConcentrationPct}% of gross losses came from the '${worstRegimeLabel}' regime — filtering entries out of it is usually the honest fix.`
        );
    }
  }
  if (tradesUnclassified > 0)
    warnings.push(
      `${tradesUnclassified} trade(s) entered during indicator warm-up and are excluded from the regime breakdown.`
    );

  return {
    perBar,
    regimes,
    classifiedBars,
    unclassifiedBars,
    tradesClassified,
    tradesUnclassified,
    concentrationPct,
    lossConcentrationPct,
    worstRegimeLabel,
    profitableRegimes,
    warnings,
  };
}

// ============================================================
// Phase 3b — regime transition model + regime-aware Monte Carlo
//
// Plain reshuffling Monte Carlo assumes trade returns are IID; in reality they
// cluster by regime. We tag each trade with its entry regime, learn a Markov
// transition matrix between regimes, and resample equity paths that WALK that
// chain — drawing each trade's PnL from its own regime's distribution. This
// preserves the clustering structure that drives real drawdowns. Deterministic
// (seeded). See docs/research/10 (Monte Carlo + Markov videos).
// ============================================================

export interface RegimeTransitionModel {
  states: string[];
  /** matrix[i][j] = P(next regime = states[j] | current = states[i]). Rows sum to 1. */
  matrix: number[][];
  /** Long-run fraction of time per state (steady-state vector), aligned to `states`. */
  steadyState: number[];
}

/** Steady-state distribution via power iteration (π = πP), normalized to sum 1. */
export function steadyStateVector(matrix: number[][], iterations = 500): number[] {
  const n = matrix.length;
  if (n === 0) return [];
  let v = new Array<number>(n).fill(1 / n);
  for (let it = 0; it < iterations; it++) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) next[j] += v[i] * matrix[i][j];
    const sum = next.reduce((s, x) => s + x, 0);
    if (sum > 0) for (let j = 0; j < n; j++) next[j] /= sum;
    let diff = 0;
    for (let j = 0; j < n; j++) diff += Math.abs(next[j] - v[j]);
    v = next;
    if (diff < 1e-12) break;
  }
  return v;
}

/** Count consecutive-trade regime transitions and row-normalize into a Markov matrix. */
export function buildRegimeTransitionModel(labels: string[]): RegimeTransitionModel {
  const states = [...new Set(labels)];
  const idx = new Map(states.map((s, i) => [s, i]));
  const n = states.length;
  const counts = states.map(() => new Array<number>(n).fill(0));
  for (let i = 1; i < labels.length; i++) {
    const a = idx.get(labels[i - 1]);
    const b = idx.get(labels[i]);
    if (a !== undefined && b !== undefined) counts[a][b] += 1;
  }
  const matrix = counts.map((row, i) => {
    const sum = row.reduce((s, x) => s + x, 0);
    if (sum === 0) {
      const r = new Array<number>(n).fill(0); // no observed exits → self-absorbing
      r[i] = 1;
      return r;
    }
    return row.map((x) => x / sum);
  });
  return { states, matrix, steadyState: steadyStateVector(matrix) };
}

export interface RegimeMonteCarloResult {
  states: string[];
  transitionMatrix: number[][];
  steadyState: number[];
  /** Long-run time-in-regime as label→% for display. */
  steadyStatePct: Record<string, number>;
  iterations: number;
  tradesUsed: number;
  worstReturnPct: number;
  medianReturnPct: number;
  bestReturnPct: number;
  worstMaxDrawdownPct: number;
  medianMaxDrawdownPct: number;
  bestMaxDrawdownPct: number;
  warning?: string;
}

/**
 * Regime-aware Monte Carlo: tag each trade with its entry regime, learn the
 * transition matrix, then resample equity paths that walk the chain and draw
 * each trade's PnL from its regime's own distribution. Reports drawdown / return
 * percentiles that respect return clustering (vs. the IID `tradePathDependence`).
 */
export function regimeAwareMonteCarlo(
  candles: Candle[],
  trades: Trade[],
  opts: RegimeOptions & { iterations?: number; seed?: number; initialCapital?: number } = {}
): RegimeMonteCarloResult {
  const perBar = classifyRegimes(candles, opts);
  const tradeLabels: string[] = [];
  const pnlByRegime = new Map<string, number[]>();
  for (const t of trades) {
    const r = perBar[t.entryBar];
    if (!r) continue;
    tradeLabels.push(r.label);
    const arr = pnlByRegime.get(r.label);
    if (arr) arr.push(t.pnl);
    else pnlByRegime.set(r.label, [t.pnl]);
  }
  const model = buildRegimeTransitionModel(tradeLabels);
  const initial = opts.initialCapital ?? 10_000;
  const steadyStatePct: Record<string, number> = {};
  model.states.forEach((s, i) => (steadyStatePct[s] = round2(model.steadyState[i] * 100)));

  const base: RegimeMonteCarloResult = {
    states: model.states,
    transitionMatrix: model.matrix,
    steadyState: model.steadyState,
    steadyStatePct,
    iterations: 0,
    tradesUsed: tradeLabels.length,
    worstReturnPct: 0,
    medianReturnPct: 0,
    bestReturnPct: 0,
    worstMaxDrawdownPct: 0,
    medianMaxDrawdownPct: 0,
    bestMaxDrawdownPct: 0,
  };
  if (model.states.length < 2 || tradeLabels.length < 10) {
    return {
      ...base,
      warning:
        model.states.length < 2
          ? "Only one regime among the trades — regime-aware MC adds nothing here; use the standard path-dependence test."
          : "Too few classified trades for regime-aware Monte Carlo (need ≥10).",
    };
  }

  const iterations = opts.iterations ?? 500;
  const rng = mulberry32(opts.seed ?? 0x5eed1234);
  const sampleState = (probs: number[]): number => {
    let r = rng();
    for (let i = 0; i < probs.length; i++) {
      r -= probs[i];
      if (r <= 0) return i;
    }
    return probs.length - 1;
  };
  const nTrades = tradeLabels.length;
  const returns: number[] = [];
  const drawdowns: number[] = [];
  for (let sim = 0; sim < iterations; sim++) {
    let cur = sampleState(model.steadyState);
    let equity = initial;
    let peak = initial;
    let maxDD = 0;
    for (let k = 0; k < nTrades; k++) {
      const pnls = pnlByRegime.get(model.states[cur]);
      if (pnls && pnls.length) equity += pnls[Math.floor(rng() * pnls.length)];
      peak = Math.max(peak, equity);
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      maxDD = Math.max(maxDD, dd);
      cur = sampleState(model.matrix[cur]);
    }
    returns.push(initial > 0 ? ((equity - initial) / initial) * 100 : 0);
    drawdowns.push(maxDD);
  }
  returns.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  return {
    ...base,
    iterations,
    worstReturnPct: round2(quantile(returns, 0.05)),
    medianReturnPct: round2(quantile(returns, 0.5)),
    bestReturnPct: round2(quantile(returns, 0.95)),
    worstMaxDrawdownPct: round2(quantile(drawdowns, 0.95)),
    medianMaxDrawdownPct: round2(quantile(drawdowns, 0.5)),
    bestMaxDrawdownPct: round2(quantile(drawdowns, 0.05)),
  };
}
