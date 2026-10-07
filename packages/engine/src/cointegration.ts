/**
 * Cointegration tools — the statistical foundation for pairs / stat-arb trading.
 *
 * Two trending (non-stationary) assets can still have a stationary, mean-
 * reverting linear combination — that's cointegration, and it's what makes a
 * pairs trade work where naive correlation lies (see docs/research/06 A2). This
 * module finds the hedge ratio, builds the spread, tests it for stationarity
 * (ADF), measures the mean-reversion half-life, and returns an honest verdict.
 */
import { mean } from "./mathstats.js";

// ---------- simple + multiple OLS ----------

export interface OLSResult {
  slope: number;
  intercept: number;
  residuals: number[];
  r2: number;
}

/** Ordinary least squares of y on a single regressor x. */
export function ols(x: number[], y: number[]): OLSResult {
  const n = Math.min(x.length, y.length);
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx !== 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const residuals: number[] = [];
  for (let i = 0; i < n; i++) residuals.push(y[i] - (slope * x[i] + intercept));
  const r2 = sxx !== 0 && syy !== 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept, residuals, r2 };
}

function transpose(M: number[][]): number[][] {
  return M[0].map((_, j) => M.map((row) => row[j]));
}
function matmul(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const m = B[0].length;
  const p = B.length;
  const C = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let k = 0; k < p; k++) s += A[i][k] * B[k][j];
      C[i][j] = s;
    }
  return C;
}
/** Gauss-Jordan inverse of a square matrix; null if singular. */
function inverse(M: number[][]): number[][] | null {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    for (let j = 0; j < 2 * n; j++) A[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[col][j];
    }
  }
  return A.map((row) => row.slice(n));
}

interface MultiReg {
  beta: number[];
  tStats: number[];
  residuals: number[];
}
/** Multiple regression y ~ X (X includes its own intercept column). t-stats included. */
function multipleRegression(X: number[][], y: number[]): MultiReg | null {
  const Xt = transpose(X);
  const XtXinv = inverse(matmul(Xt, X));
  if (!XtXinv) return null;
  const Xty = matmul(
    Xt,
    y.map((v) => [v])
  );
  const beta = matmul(XtXinv, Xty).map((r) => r[0]);
  const n = X.length;
  const k = X[0].length;
  const residuals = y.map((yi, i) => yi - X[i].reduce((s, xij, j) => s + xij * beta[j], 0));
  const rss = residuals.reduce((s, e) => s + e * e, 0);
  const sigma2 = n > k ? rss / (n - k) : NaN;
  const tStats = beta.map((b, j) => b / Math.sqrt(sigma2 * XtXinv[j][j]));
  return { beta, tStats, residuals };
}

// ---------- ADF stationarity test ----------

export interface ADFResult {
  statistic: number;
  lags: number;
  isStationary: boolean;
  criticalValue5pct: number;
}

/**
 * Augmented Dickey-Fuller test (constant, no trend). Regresses Δy on y[t-1] and
 * `lags` lagged differences; the t-stat on y[t-1] is the test statistic. More
 * negative than the critical value ⇒ reject the unit root ⇒ stationary.
 * Critical value is MacKinnon's large-sample 5% for the constant case (≈ −2.86).
 */
export function adfTest(series: number[], lags = 1): ADFResult {
  const y = series;
  const N = y.length;
  const crit5 = -2.86;
  const Xrows: number[][] = [];
  const Yv: number[] = [];
  for (let t = lags + 1; t < N; t++) {
    const row = [1, y[t - 1]];
    for (let L = 1; L <= lags; L++) row.push(y[t - L] - y[t - L - 1]);
    Xrows.push(row);
    Yv.push(y[t] - y[t - 1]);
  }
  const reg = Xrows.length > Xrows[0]?.length ? multipleRegression(Xrows, Yv) : null;
  const statistic = reg ? reg.tStats[1] : NaN;
  return { statistic, lags, isStationary: Number.isFinite(statistic) && statistic < crit5, criticalValue5pct: crit5 };
}

/** Ornstein-Uhlenbeck mean-reversion half-life (in bars). Infinity if not mean-reverting. */
export function halfLife(spread: number[]): number {
  const slag: number[] = [];
  const ds: number[] = [];
  for (let i = 1; i < spread.length; i++) {
    slag.push(spread[i - 1]);
    ds.push(spread[i] - spread[i - 1]);
  }
  const lambda = ols(slag, ds).slope;
  return lambda < 0 ? -Math.LN2 / lambda : Infinity;
}

// ---------- Engle-Granger cointegration ----------

export type CointegrationVerdict = "cointegrated" | "not-cointegrated" | "insufficient-data";

export interface CointegrationResult {
  hedgeRatio: number;
  intercept: number;
  spread: number[];
  adf: ADFResult;
  halfLifeBars: number;
  verdict: CointegrationVerdict;
  reasons: string[];
}

/**
 * Engle-Granger two-step: regress y on x for the hedge ratio, then test the
 * spread (residuals) for stationarity. A stationary spread with a sane half-life
 * is a tradeable, mean-reverting pair.
 */
export function engleGranger(
  x: number[],
  y: number[],
  opts: { lags?: number; minObservations?: number } = {}
): CointegrationResult {
  const minN = opts.minObservations ?? 40;
  const n = Math.min(x.length, y.length);
  const reg = ols(x.slice(0, n), y.slice(0, n));
  const spread = reg.residuals;
  const adf = adfTest(spread, opts.lags ?? 1);
  const hl = halfLife(spread);
  const hlSane = hl > 0 && hl < n / 3;

  const reasons: string[] = [];
  let verdict: CointegrationVerdict;
  if (n < minN) {
    verdict = "insufficient-data";
    reasons.push(`only ${n} aligned points — cointegration needs a longer history (≥ ${minN}).`);
  } else {
    // Residual-based test: use the Engle-Granger critical values, which are
    // stricter than a plain ADF because the spread is FITTED (1% ≈ -3.90 for two
    // variables). Even so, no single test is conclusive — a rare unlucky draw
    // still slips through, which is exactly why the verdict demands out-of-sample
    // confirmation below.
    const EG_CRIT_1PCT = -3.9;
    const stronglyStationary = adf.statistic < EG_CRIT_1PCT;
    if (stronglyStationary) {
      reasons.push(`spread is stationary at the Engle-Granger 1% level (ADF ${adf.statistic.toFixed(2)} < ${EG_CRIT_1PCT}) — strong, tradeable mean reversion.`);
    } else if (adf.isStationary) {
      reasons.push(`spread passes a plain ADF but NOT the stricter Engle-Granger 1% bar (ADF ${adf.statistic.toFixed(2)}) — borderline; a fitted spread needs the higher bar, so don't trade it.`);
    } else {
      reasons.push(`spread is NOT stationary (ADF ${adf.statistic.toFixed(2)} ≥ ${adf.criticalValue5pct}) — no stable equilibrium; the "pair" will drift apart.`);
    }
    reasons.push(
      Number.isFinite(hl)
        ? `mean-reversion half-life ≈ ${hl.toFixed(1)} bars (hedge ratio ${reg.slope.toFixed(3)}).`
        : `no mean reversion detected — infinite half-life.`
    );
    verdict = stronglyStationary && hlSane ? "cointegrated" : "not-cointegrated";
  }
  reasons.push("Cointegration can break with a regime shift — re-test out-of-sample before trading the spread.");

  return { hedgeRatio: reg.slope, intercept: reg.intercept, spread, adf, halfLifeBars: hl, verdict, reasons };
}
