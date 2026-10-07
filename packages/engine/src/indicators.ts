import { defaultLine, type IndicatorSpec } from "@stratforge/dsl";
import type { Candle } from "./types.js";

/** Named output lines for one indicator, aligned to candles (NaN until warm). */
export type IndicatorOutput = Record<string, number[]>;

// ============================================================
// Single-line primitives
// ============================================================

/** Simple moving average. NaN until `period` bars are available. */
export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with SMA of the first `period` bars. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/**
 * EMA over a series that may have a NaN warm-up prefix (e.g. the MACD line).
 * Seeds from the first `period` finite values and leaves the prefix NaN.
 */
function emaFromFirstValid(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const start = values.findIndex((v) => !Number.isNaN(v));
  if (start < 0 || values.length - start < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i];
  out[start + period - 1] = seed / period;
  for (let i = start + period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Wilder's RSI (0–100). NaN until warm. */
export function rsi(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Rolling population standard deviation. NaN until `period` bars. */
function rollingStd(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
    if (i >= period) {
      sum -= values[i - period];
      sumSq -= values[i - period] * values[i - period];
    }
    if (i >= period - 1) {
      const mean = sum / period;
      const variance = Math.max(0, sumSq / period - mean * mean);
      out[i] = Math.sqrt(variance);
    }
  }
  return out;
}

/** Wilder smoothing (RMA): seed = SMA of first `period`, then recursive. */
function wilderSmooth(values: number[], period: number, startIdx = 0): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const firstSeed = startIdx + period - 1;
  if (values.length <= firstSeed) return out;
  let seed = 0;
  for (let i = startIdx; i < startIdx + period; i++) seed += values[i];
  out[firstSeed] = seed / period;
  for (let i = firstSeed + 1; i < values.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  }
  return out;
}

// ============================================================
// Multi-line indicators
// ============================================================

/** MACD: macd line, signal line, histogram. */
export function macd(
  values: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdLine = values.map((_, i) =>
    Number.isNaN(fast[i]) || Number.isNaN(slow[i]) ? NaN : fast[i] - slow[i]
  );
  const signal = emaFromFirstValid(macdLine, signalPeriod);
  const histogram = values.map((_, i) =>
    Number.isNaN(macdLine[i]) || Number.isNaN(signal[i]) ? NaN : macdLine[i] - signal[i]
  );
  return { macd: macdLine, signal, histogram };
}

/** Bollinger Bands around an SMA, ±`mult` population std devs. */
export function bollinger(
  values: number[],
  period: number,
  mult: number
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = sma(values, period);
  const std = rollingStd(values, period);
  const upper = middle.map((m, i) => (Number.isNaN(m) ? NaN : m + mult * std[i]));
  const lower = middle.map((m, i) => (Number.isNaN(m) ? NaN : m - mult * std[i]));
  return { upper, middle, lower };
}

/** True Range series. TR[0] = high-low (no previous close). */
function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

/** Wilder's Average True Range. */
export function atr(candles: Candle[], period: number): number[] {
  return wilderSmooth(trueRange(candles), period);
}

/** Stochastic oscillator: %K (fast) and %D (SMA of %K). */
export function stochastic(
  candles: Candle[],
  kPeriod: number,
  dPeriod: number
): { k: number[]; d: number[] } {
  const k = new Array<number>(candles.length).fill(NaN);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    const range = hh - ll;
    k[i] = range === 0 ? 100 : (100 * (candles[i].close - ll)) / range;
  }
  const d = sma(k, dPeriod);
  return { k, d };
}

/** Wilder's ADX with +DI / -DI. */
export function adx(
  candles: Candle[],
  period: number
): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const n = candles.length;
  const tr = trueRange(candles);
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  // Smooth TR and DM over `period` starting at index 1 (DM undefined at 0).
  const trN = wilderSmooth(tr, period, 1);
  const plusN = wilderSmooth(plusDM, period, 1);
  const minusN = wilderSmooth(minusDM, period, 1);

  const plusDI = new Array<number>(n).fill(NaN);
  const minusDI = new Array<number>(n).fill(NaN);
  const dx = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(trN[i]) || trN[i] === 0) continue;
    plusDI[i] = (100 * plusN[i]) / trN[i];
    minusDI[i] = (100 * minusN[i]) / trN[i];
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / sum;
  }

  // ADX = Wilder smoothing of DX, beginning at the first valid DX index.
  const firstDx = dx.findIndex((v) => !Number.isNaN(v));
  const adxLine =
    firstDx < 0 ? new Array<number>(n).fill(NaN) : wilderSmooth(dx, period, firstDx);

  return { adx: adxLine, plusDI, minusDI };
}

/** On-Balance Volume — running total of volume signed by close direction. */
export function obv(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    out[i] = out[i - 1] + (d > 0 ? candles[i].volume : d < 0 ? -candles[i].volume : 0);
  }
  return out;
}

/** Rolling VWAP: volume-weighted average of typical price over `period` bars. */
export function vwap(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  let pv = 0; // Σ typical·volume
  let vol = 0; // Σ volume
  for (let i = 0; i < candles.length; i++) {
    pv += tp[i] * candles[i].volume;
    vol += candles[i].volume;
    if (i >= period) {
      pv -= tp[i - period] * candles[i - period].volume;
      vol -= candles[i - period].volume;
    }
    if (i >= period - 1) out[i] = vol > 0 ? pv / vol : NaN;
  }
  return out;
}

/** Money Flow Index (0–100): a volume-weighted RSI on typical price. */
export function mfi(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const posFlow = new Array<number>(candles.length).fill(0);
  const negFlow = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const rmf = tp[i] * candles[i].volume;
    if (tp[i] > tp[i - 1]) posFlow[i] = rmf;
    else if (tp[i] < tp[i - 1]) negFlow[i] = rmf;
  }
  let pos = 0;
  let neg = 0;
  for (let i = 1; i < candles.length; i++) {
    pos += posFlow[i];
    neg += negFlow[i];
    const drop = i - period;
    if (drop >= 1) {
      pos -= posFlow[drop];
      neg -= negFlow[drop];
    }
    if (i >= period) out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

// ============================================================
// Dispatch
// ============================================================

/** Compute an indicator's named output lines, aligned to `candles`. */
export function computeIndicator(spec: IndicatorSpec, candles: Candle[]): IndicatorOutput {
  switch (spec.type) {
    case "sma":
      return { sma: sma(candles.map((c) => c[spec.params.source]), spec.params.period) };
    case "ema":
      return { ema: ema(candles.map((c) => c[spec.params.source]), spec.params.period) };
    case "rsi":
      return { rsi: rsi(candles.map((c) => c[spec.params.source]), spec.params.period) };
    case "macd":
      return macd(
        candles.map((c) => c[spec.params.source]),
        spec.params.fastPeriod,
        spec.params.slowPeriod,
        spec.params.signalPeriod
      );
    case "bollinger":
      return bollinger(
        candles.map((c) => c[spec.params.source]),
        spec.params.period,
        spec.params.stdDev
      );
    case "atr":
      return { atr: atr(candles, spec.params.period) };
    case "stochastic":
      return stochastic(candles, spec.params.kPeriod, spec.params.dPeriod);
    case "adx":
      return adx(candles, spec.params.period);
    case "obv":
      return { obv: obv(candles) };
    case "vwap":
      return { vwap: vwap(candles, spec.params.period) };
    case "mfi":
      return { mfi: mfi(candles, spec.params.period) };
  }
}

/** Resolve the default (primary) line name for an indicator spec. */
export function primaryLine(spec: IndicatorSpec): string {
  return defaultLine(spec.type);
}
