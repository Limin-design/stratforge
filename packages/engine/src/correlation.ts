/**
 * Cross-domain correlation engine with an anti-coincidence verdict.
 *
 * Lets the agent test whether an external series (oil supply, FX, births,
 * prediction-market odds, …) is *really* related to an instrument — or whether
 * the relationship is a coincidence, a shared trend, or a multiple-testing
 * artifact. Coincidences happen; this module's job is to refuse to call them
 * real. See docs/research/07-platform-and-correlation-engine.md.
 */
import { mean, std } from "./mathstats.js";

// ---------- correlation primitives ----------

/** Pearson product-moment correlation. */
export function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

/** Average-rank transform (ties share the mean rank). */
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation — robust to non-linearity and outliers. */
export function spearman(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  return pearson(ranks(x.slice(0, n)), ranks(y.slice(0, n)));
}

/** First differences (changes) of a series. */
export function diff(xs: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) out.push(xs[i] - xs[i - 1]);
  return out;
}

export interface LagCorr {
  lag: number;
  corr: number;
}

/**
 * Cross-correlation across lags. `lag > 0` means x leads y by `lag` bars
 * (x[t] compared with y[t+lag]). Returns one entry per lag in [-maxLag, maxLag].
 */
export function crossCorrelation(x: number[], y: number[], maxLag = 10): LagCorr[] {
  const out: LagCorr[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let a: number[];
    let b: number[];
    if (lag >= 0) {
      a = x.slice(0, x.length - lag);
      b = y.slice(lag);
    } else {
      a = x.slice(-lag);
      b = y.slice(0, y.length + lag);
    }
    out.push({ lag, corr: pearson(a, b) });
  }
  return out;
}

// ---------- significance (Student's t for a correlation) ----------

function gammaln(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-tailed p-value that a correlation `r` over `n` points differs from 0. */
export function correlationPValue(r: number, n: number): number {
  if (n < 3) return 1;
  const rc = Math.min(0.999999999, Math.abs(r));
  const df = n - 2;
  const t = rc * Math.sqrt(df / (1 - rc * rc));
  return betai(df / 2, 0.5, df / (df + t * t));
}

// ---------- the anti-coincidence verdict ----------

export type CorrelationVerdict = "real" | "weak" | "likely-spurious" | "insufficient-data";

export interface CorrelationAssessment {
  n: number;
  pearsonLevels: number;
  pearsonChanges: number; // correlation of first differences — the honest one for trending series
  spearman: number;
  bestLag: number;
  bestLagCorr: number;
  pValue: number; // for the best-lag correlation, raw
  pValueAdjusted: number; // Bonferroni-corrected for hypotheses tested
  hypothesesTested: number;
  verdict: CorrelationVerdict;
  reasons: string[];
}

/**
 * Decide whether x and y are really related. Guards against the four ways a
 * correlation lies: too little data, shared trends (spurious regression),
 * lag-fishing, and multiple-testing across many candidate factors.
 *
 * `priorHypotheses` = how many OTHER factor ideas the user has already tested
 * this session — feed it in so the bar rises with every new idea (coincidences
 * accumulate). Defaults to 1.
 */
export function assessCorrelation(
  x: number[],
  y: number[],
  opts: { maxLag?: number; minObservations?: number; priorHypotheses?: number } = {}
): CorrelationAssessment {
  const maxLag = opts.maxLag ?? 10;
  const minN = opts.minObservations ?? 30;
  const priorHypotheses = Math.max(1, opts.priorHypotheses ?? 1);
  const n = Math.min(x.length, y.length);
  const xs = x.slice(0, n);
  const ys = y.slice(0, n);

  const pearsonLevels = pearson(xs, ys);
  const pearsonChanges = pearson(diff(xs), diff(ys));
  const sp = spearman(xs, ys);
  const ccf = crossCorrelation(xs, ys, maxLag);
  const best = ccf.reduce((a, b) => (Math.abs(b.corr) > Math.abs(a.corr) ? b : a), ccf[0]);

  const lagsScanned = 2 * maxLag + 1;
  const hypothesesTested = lagsScanned * priorHypotheses;
  const pValue = correlationPValue(best.corr, n - Math.abs(best.lag));
  const pValueAdjusted = Math.min(1, pValue * hypothesesTested);

  const reasons: string[] = [];
  let verdict: CorrelationVerdict;

  if (n < minN) {
    verdict = "insufficient-data";
    reasons.push(`only ${n} aligned observations — too few to conclude anything (need ≥ ${minN}).`);
    return {
      n, pearsonLevels, pearsonChanges, spearman: sp, bestLag: best.lag, bestLagCorr: best.corr,
      pValue, pValueAdjusted, hypothesesTested, verdict, reasons,
    };
  }

  const spuriousTrend = Math.abs(pearsonLevels) > 0.5 && Math.abs(pearsonChanges) < 0.2;
  if (spuriousTrend) {
    reasons.push(
      `correlation is in the levels (${pearsonLevels.toFixed(2)}) but vanishes in the changes (${pearsonChanges.toFixed(2)}) — almost certainly a shared trend, not a real link (spurious regression).`
    );
  }
  if (pValueAdjusted > 0.05) {
    reasons.push(
      `not significant after correcting for ${hypothesesTested} hypotheses tested (adjusted p=${pValueAdjusted.toFixed(3)}). Coincidences look like this.`
    );
  } else {
    reasons.push(`significant after multiple-testing correction (adjusted p=${pValueAdjusted.toFixed(3)}).`);
  }
  if (best.lag !== 0) {
    reasons.push(`strongest at lag ${best.lag} (one series leads the other) — confirm this lag is mechanistic, not lag-fishing.`);
  }

  if (spuriousTrend) {
    verdict = "likely-spurious";
  } else if (pValueAdjusted <= 0.05 && Math.abs(pearsonChanges) >= 0.1) {
    verdict = "real";
  } else {
    verdict = "weak";
    if (pValueAdjusted <= 0.05 && Math.abs(pearsonChanges) < 0.1) {
      reasons.push("significant in levels but the change-on-change link is weak — treat with caution.");
    }
  }
  reasons.push("Correlation is not causation: require an out-of-sample test and a plausible mechanism before trading it.");

  return {
    n, pearsonLevels, pearsonChanges, spearman: sp, bestLag: best.lag, bestLagCorr: best.corr,
    pValue, pValueAdjusted, hypothesesTested, verdict, reasons,
  };
}
