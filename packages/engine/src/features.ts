/**
 * Feature lab (Phase 6) — validate predictive features before building a strategy.
 *
 * This module is intentionally small and declarative: transforms are deterministic,
 * feature specs are safe for the AI to generate, and attribution reuses the
 * anti-spurious correlation verdict instead of pretending every pattern is real.
 */
import { assessCorrelation, type CorrelationAssessment } from "./correlation.js";
import { atr, rsi, sma } from "./indicators.js";
import type { OutcomeLabel } from "./outcomes.js";
import type { Candle } from "./types.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export type FeatureValueType = "continuous" | "binary" | "ordinal";

export type FeatureKind =
  | "close"
  | "returnPct"
  | "smaSlopePct"
  | "rsi"
  | "zscoreClose"
  | "volumeZscore"
  | "cusumDirection";

export interface FeatureSpec {
  id: string;
  label: string;
  valueType: FeatureValueType;
  kind: FeatureKind;
  /** Generic lookback window. Used by returnPct, zscoreClose, volumeZscore, and RSI. */
  window?: number;
  /** SMA period for smaSlopePct. */
  period?: number;
  /** Optional lag for slope/return style features. */
  lag?: number;
  /** CUSUM event threshold in ATR multiples when kind = cusumDirection. */
  atrMult?: number;
}

export interface FeatureSeries {
  spec: FeatureSpec;
  values: number[];
}

export interface CusumOptions {
  atrPeriod?: number;
  atrMult?: number;
}

export interface AttributionRow {
  featureId: string;
  label: string;
  valueType: FeatureValueType;
  n: number;
  correlation: CorrelationAssessment;
  meanOutcomeHigh: number;
  meanOutcomeLow: number;
  spreadHighMinusLow: number;
  note: string;
  warnings: string[];
}

export interface AttributionReport {
  events: number;
  features: AttributionRow[];
  warnings: string[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[pos];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function normalizePct(series: number[], base?: number[]): number[] {
  return series.map((v, i) => {
    const b = base ? base[i] : series[i - 1];
    return b !== undefined && Number.isFinite(v) && Number.isFinite(b) && Math.abs(b) > 1e-12
      ? ((v - b) / Math.abs(b)) * 100
      : NaN;
  });
}

export function ratio(a: number[], b: number[]): number[] {
  const n = Math.min(a.length, b.length);
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) out[i] = Number.isFinite(a[i]) && Number.isFinite(b[i]) && Math.abs(b[i]) > 1e-12 ? a[i] / b[i] : NaN;
  return out;
}

export function difference(a: number[], bOrLag: number[] | number = 1): number[] {
  if (Array.isArray(bOrLag)) {
    const n = Math.min(a.length, bOrLag.length);
    const out = new Array<number>(n).fill(NaN);
    for (let i = 0; i < n; i++) out[i] = Number.isFinite(a[i]) && Number.isFinite(bOrLag[i]) ? a[i] - bOrLag[i] : NaN;
    return out;
  }
  const lag = Math.max(1, Math.round(bOrLag));
  return a.map((v, i) => (i >= lag && Number.isFinite(v) && Number.isFinite(a[i - lag]) ? v - a[i - lag] : NaN));
}

export function zscore(series: number[], window: number): number[] {
  const w = Math.max(2, Math.round(window));
  const out = new Array<number>(series.length).fill(NaN);
  for (let i = w - 1; i < series.length; i++) {
    const slice = series.slice(i - w + 1, i + 1).filter(Number.isFinite);
    if (slice.length < w) continue;
    const m = mean(slice);
    const variance = slice.reduce((s, x) => s + (x - m) ** 2, 0) / slice.length;
    const sd = Math.sqrt(variance);
    out[i] = sd > 0 ? (series[i] - m) / sd : 0;
  }
  return out;
}

/** Volatility-normalized CUSUM events on close-to-close movement. */
export function cusumEvents(candles: Candle[], opts: CusumOptions = {}): number[] {
  const atrPeriod = opts.atrPeriod ?? 14;
  const atrMult = Math.max(0.05, opts.atrMult ?? 1.5);
  const atrLine = atr(candles, atrPeriod);
  const events: number[] = [];
  let pos = 0;
  let neg = 0;
  for (let i = 1; i < candles.length; i++) {
    const threshold = atrLine[i] * atrMult;
    if (!Number.isFinite(threshold) || threshold <= 0) continue;
    const d = candles[i].close - candles[i - 1].close;
    pos = Math.max(0, pos + d);
    neg = Math.min(0, neg + d);
    if (pos > threshold || neg < -threshold) {
      events.push(i);
      pos = 0;
      neg = 0;
    }
  }
  return events;
}

export function featureSeries(spec: FeatureSpec, candles: Candle[]): FeatureSeries {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const window = Math.max(2, Math.round(spec.window ?? 20));
  const lag = Math.max(1, Math.round(spec.lag ?? 1));
  let values: number[];

  switch (spec.kind) {
    case "close":
      values = closes.slice();
      break;
    case "returnPct":
      values = closes.map((c, i) => (i >= window && closes[i - window] > 0 ? (c / closes[i - window] - 1) * 100 : NaN));
      break;
    case "smaSlopePct": {
      const period = Math.max(2, Math.round(spec.period ?? window));
      const line = sma(closes, period);
      values = normalizePct(line, line.map((_, i) => (i >= lag ? line[i - lag] : NaN)));
      break;
    }
    case "rsi":
      values = rsi(closes, window);
      break;
    case "zscoreClose":
      values = zscore(closes, window);
      break;
    case "volumeZscore":
      values = zscore(volumes, window);
      break;
    case "cusumDirection": {
      const eventSet = new Map<number, number>();
      for (const b of cusumEvents(candles, { atrMult: spec.atrMult })) {
        eventSet.set(b, candles[b].close >= candles[b - 1].close ? 1 : -1);
      }
      values = candles.map((_, i) => eventSet.get(i) ?? 0);
      break;
    }
  }

  return { spec, values };
}

export const DEFAULT_FEATURE_SPECS: FeatureSpec[] = [
  { id: "ret20", label: "20-bar return %", valueType: "continuous", kind: "returnPct", window: 20 },
  { id: "sma20Slope", label: "SMA 20 slope %", valueType: "continuous", kind: "smaSlopePct", period: 20, lag: 5 },
  { id: "rsi14", label: "RSI 14", valueType: "ordinal", kind: "rsi", window: 14 },
  { id: "zClose50", label: "Close z-score 50", valueType: "continuous", kind: "zscoreClose", window: 50 },
  { id: "volZ50", label: "Volume z-score 50", valueType: "continuous", kind: "volumeZscore", window: 50 },
];

function attributionRow(labels: OutcomeLabel[], feature: FeatureSeries, priorHypotheses: number): AttributionRow {
  const pairs = labels
    .map((l) => ({ x: feature.values[l.eventBar], y: l.returnPct }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const xs = pairs.map((p) => p.x);
  const ys = pairs.map((p) => p.y);
  const corr = assessCorrelation(xs, ys, { maxLag: 0, priorHypotheses, minObservations: 20 });
  const sorted = [...xs].sort((a, b) => a - b);
  const qLow = quantile(sorted, 0.33);
  const qHigh = quantile(sorted, 0.67);
  const low = pairs.filter((p) => p.x <= qLow).map((p) => p.y);
  const high = pairs.filter((p) => p.x >= qHigh).map((p) => p.y);
  const meanOutcomeHigh = round4(mean(high));
  const meanOutcomeLow = round4(mean(low));
  const spreadHighMinusLow = round4(meanOutcomeHigh - meanOutcomeLow);
  const warnings: string[] = [];
  if (pairs.length < 30) warnings.push(`Only ${pairs.length} feature/event pairs — attribution is provisional.`);
  if (corr.verdict !== "real") warnings.push(`Anti-spurious verdict is ${corr.verdict}; do not build a strategy from this feature alone.`);
  if (Math.abs(spreadHighMinusLow) < 0.05) warnings.push("High-vs-low feature buckets have little outcome separation.");
  const note =
    corr.verdict === "real" && Math.abs(spreadHighMinusLow) >= 0.05
      ? "Feature has defensible relationship to forward outcomes; still needs OOS validation."
      : "Feature relationship is weak, noisy, or likely spurious.";

  return {
    featureId: feature.spec.id,
    label: feature.spec.label,
    valueType: feature.spec.valueType,
    n: pairs.length,
    correlation: corr,
    meanOutcomeHigh,
    meanOutcomeLow,
    spreadHighMinusLow,
    note,
    warnings,
  };
}

export function featureAttribution(labels: OutcomeLabel[], features: FeatureSeries[]): AttributionReport {
  const rows = features.map((f, i) => attributionRow(labels, f, Math.max(1, features.length + i)));
  const warnings: string[] = [];
  if (labels.length < 30) warnings.push(`Only ${labels.length} labelled events — feature lab result is provisional.`);
  if (!rows.some((r) => r.correlation.verdict === "real")) warnings.push("No feature cleared the anti-spurious bar. Do not convert this into a strategy yet.");
  return { events: labels.length, features: rows, warnings };
}
