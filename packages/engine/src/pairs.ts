/**
 * Pairs / spread backtest — the multi-asset path.
 *
 * Trades the spread of a cointegrated pair: when the z-score of (B − β·A) is
 * extreme, go long the cheap leg and short the rich one, and exit as it reverts.
 * Two legs, real shorting, fees + slippage on both legs, short-leg borrow cost,
 * next-bar fills (no look-ahead). The hedge ratio β is estimated on a training
 * window only, so the traded period is genuinely out-of-sample.
 *
 * Place in packages/engine/src/pairs.ts and add `export * from "./pairs.js";`
 * to packages/engine/src/index.ts. The cointegration math lives in
 * cointegration.ts; this is the execution path.
 */
import { ols } from "./cointegration.js";
import { computeStats } from "./stats.js";
import type { BacktestStats, Candle, TimelinePoint } from "./types.js";

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

export interface PairsSpec {
  lookback?: number; // z-score rolling window (default 30)
  entryZ?: number; // enter when |z| > entryZ (default 2)
  exitZ?: number; // exit when the spread reverts past this (default 0.5)
  stopZ?: number; // stop when |z| > stopZ — divergence protection (default 4)
  trainFraction?: number; // fraction of the series used to estimate β (default 0.3)
  hedgeRatio?: number; // fixed β; if set, skips estimation (trainBars = lookback)
  legNotionalPct?: number; // notional per leg as % of equity (default 100)
}

export interface PairsOptions {
  initialCapital?: number; // default 10_000
  feePct?: number; // per leg per side, % (default 0.1)
  slippagePct?: number; // per leg per side, % (default 0.05)
  borrowCostAnnualPct?: number; // financing on the short leg, % per year (default 0)
}

export interface PairsTrade {
  side: "longSpread" | "shortSpread"; // longSpread = long B, short A
  entryBar: number;
  exitBar: number;
  entryTime: number;
  exitTime: number;
  entryZ: number;
  exitZ: number;
  pnl: number;
  pnlPct: number;
  exitReason: "meanReversion" | "stop" | "endOfData";
}

export interface PairsResult {
  stats: BacktestStats;
  trades: PairsTrade[];
  timeline: TimelinePoint[];
  spread: number[];
  zscore: number[];
  hedgeRatio: number;
  intercept: number;
  trainBars: number;
}

/** Inner-join two candle series on timestamp → aligned close prices. */
export function alignPair(a: Candle[], b: Candle[]): { time: number; a: number; b: number }[] {
  const mapB = new Map(b.map((c) => [c.time, c.close]));
  const out: { time: number; a: number; b: number }[] = [];
  for (const c of a) {
    const bb = mapB.get(c.time);
    if (bb !== undefined) out.push({ time: c.time, a: c.close, b: bb });
  }
  return out;
}

function rollingMeanStd(xs: number[], period: number): { mean: number[]; std: number[] } {
  const mean = new Array<number>(xs.length).fill(NaN);
  const std = new Array<number>(xs.length).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    sumSq += xs[i] * xs[i];
    if (i >= period) {
      sum -= xs[i - period];
      sumSq -= xs[i - period] * xs[i - period];
    }
    if (i >= period - 1) {
      const m = sum / period;
      mean[i] = m;
      std[i] = Math.sqrt(Math.max(0, sumSq / period - m * m));
    }
  }
  return { mean, std };
}

/** Run a z-score pairs strategy on two assets. */
export function runPairsBacktest(
  candlesA: Candle[],
  candlesB: Candle[],
  spec: PairsSpec = {},
  opts: PairsOptions = {}
): PairsResult {
  const aligned = alignPair(candlesA, candlesB);
  const n = aligned.length;
  const pa = aligned.map((p) => p.a);
  const pb = aligned.map((p) => p.b);
  const times = aligned.map((p) => p.time);

  const lookback = spec.lookback ?? 30;
  const entryZ = spec.entryZ ?? 2;
  const exitZ = spec.exitZ ?? 0.5;
  const stopZ = spec.stopZ ?? 4;
  const legPct = (spec.legNotionalPct ?? 100) / 100;

  const fee = (opts.feePct ?? 0.1) / 100;
  const slip = (opts.slippagePct ?? 0.05) / 100;
  const borrow = (opts.borrowCostAnnualPct ?? 0) / 100;
  const initialCapital = opts.initialCapital ?? 10_000;

  // Hedge ratio from the training window only (causal — earliest data).
  const trainBars =
    spec.hedgeRatio !== undefined
      ? lookback
      : Math.max(lookback, Math.floor(n * (spec.trainFraction ?? 0.3)));
  let beta = spec.hedgeRatio ?? 0;
  let intercept = 0;
  if (spec.hedgeRatio === undefined && trainBars >= 5) {
    const reg = ols(pa.slice(0, trainBars), pb.slice(0, trainBars));
    beta = reg.slope;
    intercept = reg.intercept;
  }

  const spread = pb.map((b, i) => b - (beta * pa[i] + intercept));
  const { mean: sMean, std: sStd } = rollingMeanStd(spread, lookback);
  const zscore = spread.map((s, i) => (sStd[i] > 0 ? (s - sMean[i]) / sStd[i] : NaN));

  // adverse fill: buying (units>0) pays up, shorting (units<0) receives less
  const fill = (units: number, price: number) => (units > 0 ? price * (1 + slip) : price * (1 - slip));

  let cash = initialCapital;
  let pos = 0; // 0 flat, +1 long-spread (long B, short A), -1 short-spread
  let holdA = 0; // signed units of A
  let holdB = 0; // signed units of B
  let entryBar = -1;
  let entryZv = 0;
  let cashBeforeEntry = 0;

  const trades: PairsTrade[] = [];
  const timeline: TimelinePoint[] = [];
  let peakEquity = initialCapital;
  let pendingEntry = 0; // +1 / -1 queued for next bar
  let pendingExit: PairsTrade["exitReason"] | null = null;

  const openAt = (bar: number, dir: number, equityNow: number) => {
    cashBeforeEntry = cash;
    const unitsB = (equityNow * legPct) / pb[bar];
    holdB = dir * unitsB;
    holdA = -dir * beta * unitsB;
    const fillB = fill(holdB, pb[bar]);
    const fillA = fill(holdA, pa[bar]);
    cash -= holdB * fillB + holdA * fillA;
    cash -= fee * (Math.abs(holdB) * fillB + Math.abs(holdA) * fillA);
    pos = dir;
    entryBar = bar;
    entryZv = zscore[bar];
  };

  const closeAt = (bar: number, reason: PairsTrade["exitReason"]) => {
    const fillB = fill(-holdB, pb[bar]);
    const fillA = fill(-holdA, pa[bar]);
    cash += holdB * fillB + holdA * fillA;
    cash -= fee * (Math.abs(holdB) * fillB + Math.abs(holdA) * fillA);
    const pnl = cash - cashBeforeEntry;
    trades.push({
      side: pos > 0 ? "longSpread" : "shortSpread",
      entryBar,
      exitBar: bar,
      entryTime: times[entryBar],
      exitTime: times[bar],
      entryZ: entryZv,
      exitZ: zscore[bar],
      pnl,
      pnlPct: (pnl / cashBeforeEntry) * 100,
      exitReason: reason,
    });
    pos = 0;
    holdA = 0;
    holdB = 0;
  };

  for (let bar = 0; bar < n; bar++) {
    // 1. Execute queued orders at this bar's price (next-bar fill).
    if (pendingExit && pos !== 0) closeAt(bar, pendingExit);
    pendingExit = null;
    if (pendingEntry !== 0 && pos === 0) {
      openAt(bar, pendingEntry, cash); // flat ⇒ equity == cash
    }
    pendingEntry = 0;

    // 2. Short-leg borrow cost for holding through this bar.
    if (pos !== 0 && borrow > 0) {
      const dt = bar > 0 ? times[bar] - times[bar - 1] : 0;
      const shortNotional = pos > 0 ? Math.abs(holdA) * pa[bar] : Math.abs(holdB) * pb[bar];
      cash -= borrow * shortNotional * (dt / SECONDS_PER_YEAR);
    }

    // 3. Signals on this bar's z → queue for next bar. Trade only after training.
    const z = zscore[bar];
    if (!Number.isNaN(z) && bar >= trainBars) {
      if (pos === 0) {
        if (z > entryZ) pendingEntry = -1; // spread rich → short B, long A
        else if (z < -entryZ) pendingEntry = 1; // spread cheap → long B, short A
      } else if (Math.abs(z) > stopZ) {
        pendingExit = "stop";
      } else if ((pos > 0 && z >= -exitZ) || (pos < 0 && z <= exitZ)) {
        pendingExit = "meanReversion";
      }
    }

    // 4. Mark to market and record.
    const equity = cash + holdB * pb[bar] + holdA * pa[bar];
    peakEquity = Math.max(peakEquity, equity);
    timeline.push({
      time: times[bar],
      equity,
      position: pos !== 0 ? 1 : 0,
      drawdownPct: peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0,
    });
  }

  // Force-close at the end for clean accounting.
  if (pos !== 0) {
    closeAt(n - 1, "endOfData");
    const last = timeline[timeline.length - 1];
    last.equity = cash;
    last.position = 0;
  }

  return {
    stats: computeStats(
      trades as unknown as Parameters<typeof computeStats>[0],
      timeline,
      initialCapital
    ),
    trades,
    timeline,
    spread,
    zscore,
    hedgeRatio: beta,
    intercept,
    trainBars,
  };
}
