import type { BacktestStats, Candle, TimelinePoint, Trade } from "./types.js";

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export interface EntryEventDiagnostics {
  trades: number;
  eventRatePct: number;
  avgBarsBetweenEntries: number;
  medianBarsBetweenEntries: number;
  minBarsBetweenEntries: number;
  clusteredTradePct: number;
  maxEntryCluster: number;
  maxConsecutiveLosses: number;
  singleTradePnlDominancePct: number;
  warnings: string[];
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function maxConsecutiveLosses(trades: Trade[]): number {
  let run = 0;
  let maxRun = 0;
  for (const t of trades) {
    if (t.pnl <= 0) {
      run += 1;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 0;
    }
  }
  return maxRun;
}

export function analyzeEntryEvents(trades: Trade[], barCount = 0): EntryEventDiagnostics {
  const sorted = [...trades].sort((a, b) => a.entryBar - b.entryBar);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(Math.max(0, sorted[i].entryBar - sorted[i - 1].entryBar));

  const avgGap = gaps.length ? gaps.reduce((s, x) => s + x, 0) / gaps.length : 0;
  const medGap = median(gaps);
  const minGap = gaps.length ? Math.min(...gaps) : 0;
  const clusterThreshold = Math.max(2, Math.floor(medGap * 0.25));
  const clustered = gaps.filter((g) => g <= clusterThreshold).length;
  const clusteredTradePct = sorted.length > 1 ? (clustered / (sorted.length - 1)) * 100 : 0;

  let currentCluster = sorted.length ? 1 : 0;
  let maxEntryCluster = currentCluster;
  for (const g of gaps) {
    if (g <= clusterThreshold) {
      currentCluster += 1;
      maxEntryCluster = Math.max(maxEntryCluster, currentCluster);
    } else {
      currentCluster = 1;
    }
  }

  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const largestAbsPnl = sorted.reduce((m, t) => Math.max(m, Math.abs(t.pnl)), 0);
  const singleTradePnlDominancePct = totalPnl !== 0 ? (largestAbsPnl / Math.abs(totalPnl)) * 100 : 0;
  const lossRun = maxConsecutiveLosses(sorted);
  const eventRatePct = barCount > 0 ? (sorted.length / barCount) * 100 : 0;

  const warnings: string[] = [];
  if (sorted.length < 30) warnings.push(`Only ${sorted.length} trades — too few samples for high confidence.`);
  if (clusteredTradePct > 40) warnings.push(`Entry clustering: ${round2(clusteredTradePct)}% of entries fire close together. This is regime-dependent and easier to overfit.`);
  if (maxEntryCluster >= 5) warnings.push(`Largest entry cluster has ${maxEntryCluster} trades in a tight window — one regime may dominate the result.`);
  if (lossRun >= 5) warnings.push(`Worst loss streak is ${lossRun} trades — size positions for that, not for the average trade.`);
  if (singleTradePnlDominancePct > 50) warnings.push(`Single-trade dominance: one trade accounts for ${round2(singleTradePnlDominancePct)}% of net PnL magnitude. Remove it before trusting the edge.`);

  return {
    trades: sorted.length,
    eventRatePct: round2(eventRatePct),
    avgBarsBetweenEntries: round2(avgGap),
    medianBarsBetweenEntries: round2(medGap),
    minBarsBetweenEntries: minGap,
    clusteredTradePct: round2(clusteredTradePct),
    maxEntryCluster,
    maxConsecutiveLosses: lossRun,
    singleTradePnlDominancePct: round2(singleTradePnlDominancePct),
    warnings,
  };
}

/** Infer bars-per-year from the median spacing of timeline timestamps. */
function barsPerYear(timeline: TimelinePoint[]): number {
  if (timeline.length < 2) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < timeline.length; i++) deltas.push(timeline[i].time - timeline[i - 1].time);
  const med = median(deltas);
  return med > 0 ? SECONDS_PER_YEAR / med : 0;
}

export function computeStats(
  trades: Trade[],
  timeline: TimelinePoint[],
  initialCapital: number
): BacktestStats {
  const finalEquity = timeline.length ? timeline[timeline.length - 1].equity : initialCapital;
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // --- Drawdown depth and duration (consecutive bars below the prior peak).
  let maxDrawdownPct = 0;
  let maxDrawdownDurationBars = 0;
  let underwater = 0;
  let peak = timeline.length ? timeline[0].equity : initialCapital;
  for (const p of timeline) {
    maxDrawdownPct = Math.max(maxDrawdownPct, p.drawdownPct);
    if (p.equity >= peak) {
      peak = p.equity;
      underwater = 0;
    } else {
      underwater += 1;
      maxDrawdownDurationBars = Math.max(maxDrawdownDurationBars, underwater);
    }
  }

  // --- Per-bar return series.
  const rets: number[] = [];
  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1].equity;
    if (prev > 0) rets.push(timeline[i].equity / prev - 1);
  }
  const mean = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;

  let sharpe = 0;
  let sortino = 0;
  if (rets.length > 2) {
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    const sd = Math.sqrt(variance);
    sharpe = sd > 0 ? mean / sd : 0;
    // Downside deviation: only negative returns penalized.
    const downside = Math.sqrt(rets.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / rets.length);
    sortino = downside > 0 ? mean / downside : 0;
  }

  const ppy = barsPerYear(timeline);
  const annFactor = ppy > 0 ? Math.sqrt(ppy) : 0;
  const annualizedSharpe = sharpe * annFactor;
  const annualizedSortino = sortino * annFactor;

  // --- CAGR from elapsed wall-clock time.
  let cagrPct = 0;
  if (timeline.length >= 2 && initialCapital > 0) {
    const years = (timeline[timeline.length - 1].time - timeline[0].time) / SECONDS_PER_YEAR;
    if (years > 0) {
      cagrPct = finalEquity > 0 ? ((finalEquity / initialCapital) ** (1 / years) - 1) * 100 : -100;
    }
  }
  const calmar = maxDrawdownPct > 0 ? cagrPct / maxDrawdownPct : 0;

  // --- Exposure (time in market).
  const barsInMarket = timeline.filter((p) => p.position > 0).length;
  const exposurePct = timeline.length ? (barsInMarket / timeline.length) * 100 : 0;

  // --- Per-trade expectancy and payoff.
  const expectancy = trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0; // absolute
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;
  const expectancyPct = initialCapital > 0 ? (expectancy / initialCapital) * 100 : 0;

  return {
    totalReturnPct: round2(totalReturnPct),
    cagrPct: round2(cagrPct),
    winRate: round2(winRate),
    trades: trades.length,
    maxDrawdownPct: round2(maxDrawdownPct),
    maxDrawdownDurationBars,
    profitFactor: Number.isFinite(profitFactor) ? round2(profitFactor) : Infinity,
    sharpe: round4(sharpe),
    annualizedSharpe: round2(annualizedSharpe),
    sortino: round2(annualizedSortino),
    calmar: round2(calmar),
    exposurePct: round2(exposurePct),
    expectancy: round2(expectancy),
    winProbability: round2(winRate),
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    expectancyPct: round4(expectancyPct),
    payoffRatio: Number.isFinite(payoffRatio) ? round2(payoffRatio) : Infinity,
  };
}

// ============================================================
// Buy-and-hold benchmark (Phase 1 — honesty check)
//
// The most intuitive sanity check: did the strategy actually beat just holding
// the asset over the same window? A "profitable" strategy that underperforms
// passive buy-and-hold (and at worse risk-adjusted return) is not an edge.
// ============================================================

export interface BenchmarkStats {
  totalReturnPct: number;
  cagrPct: number;
  annualizedSharpe: number;
  maxDrawdownPct: number;
}

/**
 * Buy-and-hold the asset from the first bar's close to the last, measured over
 * the same candle series the strategy ran on. Capital-independent (a ratio), so
 * comparable to any strategy's total return.
 */
export function buyAndHoldStats(candles: Candle[]): BenchmarkStats {
  if (candles.length < 2) return { totalReturnPct: 0, cagrPct: 0, annualizedSharpe: 0, maxDrawdownPct: 0 };
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  const totalReturnPct = first > 0 ? (last / first - 1) * 100 : 0;

  // Close-to-close returns + drawdown over the price equity curve.
  const rets: number[] = [];
  let peak = first;
  let maxDrawdownPct = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i].close;
    const prev = candles[i - 1]?.close;
    if (i > 0 && prev > 0) rets.push(c / prev - 1);
    if (c > peak) peak = c;
    const dd = peak > 0 ? ((peak - c) / peak) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  const mean = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  let sharpe = 0;
  if (rets.length > 2) {
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    const sd = Math.sqrt(variance);
    sharpe = sd > 0 ? mean / sd : 0;
  }
  const deltas: number[] = [];
  for (let i = 1; i < candles.length; i++) deltas.push(candles[i].time - candles[i - 1].time);
  const medDelta = median(deltas);
  const ppy = medDelta > 0 ? SECONDS_PER_YEAR / medDelta : 0;
  const annualizedSharpe = sharpe * (ppy > 0 ? Math.sqrt(ppy) : 0);

  let cagrPct = 0;
  const years = (last !== undefined && candles.length >= 2)
    ? (candles[candles.length - 1].time - candles[0].time) / SECONDS_PER_YEAR
    : 0;
  if (years > 0 && first > 0) cagrPct = ((last / first) ** (1 / years) - 1) * 100;

  return {
    totalReturnPct: round2(totalReturnPct),
    cagrPct: round2(cagrPct),
    annualizedSharpe: round2(annualizedSharpe),
    maxDrawdownPct: round2(maxDrawdownPct),
  };
}

export interface RelativeVerdict {
  /** Did the strategy's total return beat passive buy-and-hold? */
  beatsBuyHold: boolean;
  /** Strategy total return − benchmark total return (percentage points). */
  excessReturnPct: number;
  /** Strategy annualized Sharpe − benchmark annualized Sharpe. */
  excessSharpe: number;
  note: string;
}

/** Compare a finished backtest to buy-and-hold and produce an honest one-liner. */
export function relativeVerdict(strategy: BacktestStats, benchmark: BenchmarkStats): RelativeVerdict {
  const excessReturnPct = round2(strategy.totalReturnPct - benchmark.totalReturnPct);
  const excessSharpe = round2(strategy.annualizedSharpe - benchmark.annualizedSharpe);
  const beatsBuyHold = strategy.totalReturnPct > benchmark.totalReturnPct;
  let note: string;
  if (!beatsBuyHold) {
    note = `Underperforms buy & hold: ${strategy.totalReturnPct}% vs ${benchmark.totalReturnPct}% just holding the asset (${excessReturnPct}% excess). Doing nothing beat this.`;
  } else if (excessSharpe < 0) {
    note = `Beats buy & hold on return (+${excessReturnPct}%) but at worse risk-adjusted return — Sharpe ${strategy.annualizedSharpe} vs ${benchmark.annualizedSharpe}.`;
  } else {
    note = `Beats buy & hold: +${excessReturnPct}% excess return, Sharpe ${strategy.annualizedSharpe} vs ${benchmark.annualizedSharpe}.`;
  }
  return { beatsBuyHold, excessReturnPct, excessSharpe, note };
}

/** Plain-language band for an annualized Sharpe (Skinner's rubric: <0.5 uninvestable, <1 weak). */
export function sharpeLabel(annualizedSharpe: number): string {
  if (annualizedSharpe < 0.5) return "uninvestable (<0.5)";
  if (annualizedSharpe < 1) return "weak (<1)";
  if (annualizedSharpe < 2) return "decent (1–2)";
  return "strong (≥2)";
}
