/**
 * Outcome-label diagnostics (Phase 2) — "is this event edge or luck?"
 *
 * Given event bars (e.g. a strategy's trigger fired here), label what happened next
 * with a triple barrier (ATR-based take-profit / stop-loss / time barrier), then ask
 * whether the average outcome is statistically distinguishable from zero, from random
 * entries, and from just being in the market — and whether it holds up across periods.
 *
 * Long-direction outcomes (StratForge is long-only). Deterministic: bootstrap uses a
 * seeded RNG. No look-ahead: barriers come from ATR at the event bar; scan is forward-only.
 */
import { atr } from "./indicators.js";
import { mulberry32 } from "./mathstats.js";
import type { Candle } from "./types.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export interface OutcomeLabel {
  eventBar: number;
  exitBar: number;
  hit: "tp" | "sl" | "time";
  /** Long-direction return from the event bar's close to the exit, percent. */
  returnPct: number;
  /** tp → +1, sl → −1, time barrier → 0. */
  label: 1 | -1 | 0;
}

export interface TripleBarrierOptions {
  atrPeriod?: number; // default 14
  tpAtrMult?: number; // take-profit distance in ATRs. default 2
  slAtrMult?: number; // stop-loss distance in ATRs. default 2
  maxHoldBars?: number; // time barrier. default 20
}

/**
 * Label each event with the outcome of a long held from the event bar's close until
 * the first of: take-profit (entry + tpAtrMult·ATR), stop-loss (entry − slAtrMult·ATR),
 * or the time barrier. Stop is checked before target intrabar (conservative). Events in
 * the ATR warm-up or with no forward bar are skipped.
 */
export function tripleBarrier(
  candles: Candle[],
  eventBars: number[],
  opts: TripleBarrierOptions = {}
): OutcomeLabel[] {
  const atrPeriod = opts.atrPeriod ?? 14;
  const tpMult = opts.tpAtrMult ?? 2;
  const slMult = opts.slAtrMult ?? 2;
  const maxHold = opts.maxHoldBars ?? 20;
  const atrSeries = atr(candles, atrPeriod);
  const last = candles.length - 1;

  const out: OutcomeLabel[] = [];
  for (const eventBar of eventBars) {
    if (eventBar < 0 || eventBar >= last) continue; // need ≥1 forward bar
    const a = atrSeries[eventBar];
    const entry = candles[eventBar].close;
    if (Number.isNaN(a) || a <= 0 || entry <= 0) continue;
    const upper = entry + tpMult * a;
    const lower = entry - slMult * a;
    const limit = Math.min(eventBar + maxHold, last);

    let resolved = false;
    for (let j = eventBar + 1; j <= limit; j++) {
      if (candles[j].low <= lower) {
        out.push({ eventBar, exitBar: j, hit: "sl", returnPct: round4((lower / entry - 1) * 100), label: -1 });
        resolved = true;
        break;
      }
      if (candles[j].high >= upper) {
        out.push({ eventBar, exitBar: j, hit: "tp", returnPct: round4((upper / entry - 1) * 100), label: 1 });
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      out.push({ eventBar, exitBar: limit, hit: "time", returnPct: round4((candles[limit].close / entry - 1) * 100), label: 0 });
    }
  }
  return out;
}

export interface ExpectancyCI {
  /** Mean return per event, percent. */
  ev: number;
  ciLow: number;
  ciHigh: number;
  /** True when the 95% CI is entirely above or below zero (a real, signed edge). */
  excludesZero: boolean;
  n: number;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[pos];
}

/** Bootstrap a 95% confidence interval for the mean return per event. */
export function expectancyWithCI(
  returnsPct: number[],
  opts: { iterations?: number; seed?: number } = {}
): ExpectancyCI {
  const n = returnsPct.length;
  const ev = round4(mean(returnsPct));
  if (n < 2) return { ev, ciLow: ev, ciHigh: ev, excludesZero: false, n };
  const iterations = opts.iterations ?? 2000;
  const rng = mulberry32(opts.seed ?? 0x0c0ffee);
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += returnsPct[Math.floor(rng() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const ciLow = round4(percentile(means, 0.025));
  const ciHigh = round4(percentile(means, 0.975));
  return { ev, ciLow, ciHigh, excludesZero: ciLow > 0 || ciHigh < 0, n };
}

export interface OutcomeReport {
  events: number;
  eventRatePct: number;
  labels: { tp: number; sl: number; time: number };
  expectancy: ExpectancyCI;
  baseline: {
    /** Same number of random entry bars, labelled the same way. */
    random: ExpectancyCI;
    /** Average forward return over the hold horizon across all bars (being-in-the-market drift). */
    driftPct: number;
  };
  crossPeriod: { firstHalf: ExpectancyCI; secondHalf: ExpectancyCI };
  warnings: string[];
}

function randomBars(count: number, candles: Candle[], atrPeriod: number, rng: () => number): number[] {
  const lo = atrPeriod + 1;
  const hi = candles.length - 2; // need ≥1 forward bar
  const out: number[] = [];
  if (hi < lo) return out;
  for (let i = 0; i < count; i++) out.push(lo + Math.floor(rng() * (hi - lo + 1)));
  return out;
}

/**
 * Full outcome report for a set of event bars: triple-barrier EV with a bootstrap CI,
 * versus a random-entry baseline and the market's drift over the same horizon, plus a
 * first-half/second-half stability check. The honest question is whether the CI excludes
 * zero AND beats the baselines — and whether it still does in the later period.
 */
export function outcomeReport(
  candles: Candle[],
  eventBars: number[],
  opts: TripleBarrierOptions & { iterations?: number; seed?: number } = {}
): OutcomeReport {
  const atrPeriod = opts.atrPeriod ?? 14;
  const maxHold = opts.maxHoldBars ?? 20;
  const seed = opts.seed ?? 0x0c0ffee;

  const labels = tripleBarrier(candles, eventBars, opts);
  const returns = labels.map((l) => l.returnPct);
  const counts = { tp: 0, sl: 0, time: 0 };
  for (const l of labels) counts[l.hit] += 1;

  const expectancy = expectancyWithCI(returns, { iterations: opts.iterations, seed });

  // Random-entry baseline: same count of labelled events.
  const rng = mulberry32(seed ^ 0x5151);
  const randLabels = tripleBarrier(candles, randomBars(labels.length, candles, atrPeriod, rng), opts);
  const random = expectancyWithCI(randLabels.map((l) => l.returnPct), { iterations: opts.iterations, seed: seed ^ 0x9e3779b9 });

  // Drift: average forward return over the hold horizon across all valid bars.
  let driftSum = 0;
  let driftN = 0;
  for (let b = atrPeriod; b < candles.length - 1; b++) {
    const exit = Math.min(b + maxHold, candles.length - 1);
    if (candles[b].close > 0) {
      driftSum += (candles[exit].close / candles[b].close - 1) * 100;
      driftN += 1;
    }
  }
  const driftPct = round4(driftN ? driftSum / driftN : 0);

  // Cross-period stability: split events by the midpoint bar.
  const mid = candles.length / 2;
  const firstHalf = expectancyWithCI(labels.filter((l) => l.eventBar < mid).map((l) => l.returnPct), { iterations: opts.iterations, seed: seed ^ 0x1111 });
  const secondHalf = expectancyWithCI(labels.filter((l) => l.eventBar >= mid).map((l) => l.returnPct), { iterations: opts.iterations, seed: seed ^ 0x2222 });

  const eventRatePct = candles.length ? round2((labels.length / candles.length) * 100) : 0;

  const warnings: string[] = [];
  if (labels.length < 30)
    warnings.push(`Only ${labels.length} labelled events — too few for a reliable CI; treat the verdict as provisional.`);
  if (eventRatePct > 50)
    warnings.push(`Events fire on ${eventRatePct}% of bars — this is close to sampling every candle, so the "event" may carry little information. Define a sparser, more specific event.`);
  if (!expectancy.excludesZero)
    warnings.push(`Event EV ${expectancy.ev}% has a 95% CI of [${expectancy.ciLow}, ${expectancy.ciHigh}] that spans zero — statistically indistinguishable from no edge.`);
  if (expectancy.excludesZero && expectancy.ev > 0 && expectancy.ev <= driftPct)
    warnings.push(`Event EV (${expectancy.ev}%) does not beat market drift over the same horizon (${driftPct}%) — the event adds nothing over simply being in the market.`);
  if (expectancy.excludesZero && expectancy.ev > 0 && random.excludesZero && random.ev > 0 && expectancy.ev <= random.ev)
    warnings.push(`Random entries did as well (random EV ${random.ev}% vs event EV ${expectancy.ev}%) — the timing isn't what's producing the result.`);
  if (firstHalf.excludesZero && !secondHalf.excludesZero)
    warnings.push(`Edge present in the first half (CI excludes 0) but not the second — likely overfit or decayed; validate on fresh data before trusting it.`);

  return {
    events: labels.length,
    eventRatePct,
    labels: counts,
    expectancy,
    baseline: { random, driftPct },
    crossPeriod: { firstHalf, secondHalf },
    warnings,
  };
}
