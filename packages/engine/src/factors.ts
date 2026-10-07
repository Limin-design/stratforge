/**
 * External factor data utilities: parse a pasted/loaded series and align it to
 * the instrument's candles. Used by the correlation panel and `factor` operands.
 */

export interface FactorPoint {
  time: number; // unix seconds
  value: number;
}

export interface ParsedFactor {
  points: FactorPoint[];
  /** True when the input carried timestamps; false when it was bare values. */
  hasTime: boolean;
}

/** Parse a date or epoch token to unix seconds, or NaN if not a time. */
function parseTime(token: string): number {
  const t = token.trim();
  if (t === "") return NaN;
  // Pure number → epoch seconds or milliseconds.
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (n > 1e12) return Math.floor(n / 1000); // ms → s
    if (n > 1e8) return Math.floor(n); // already seconds
    return NaN; // small integer → treat as a value, not a time
  }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 1000);
}

/**
 * Parse CSV/TSV text. Accepts either:
 *  - two columns `time,value` (time = ISO date or epoch), or
 *  - one column of bare values (aligned by position later).
 * Skips header rows and blank/garbage lines.
 */
export function parseFactorCsv(text: string): ParsedFactor {
  const points: FactorPoint[] = [];
  let hasTime = false;
  let idx = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/[,;\t]/).map((c) => c.trim());
    if (cols.length >= 2) {
      const time = parseTime(cols[0]);
      const value = Number(cols[1]);
      if (!Number.isNaN(time) && !Number.isNaN(value)) {
        points.push({ time, value });
        hasTime = true;
        continue;
      }
      // Maybe value,time order or a header — try the second col as time.
      const time2 = parseTime(cols[1]);
      const value2 = Number(cols[0]);
      if (!Number.isNaN(time2) && !Number.isNaN(value2)) {
        points.push({ time: time2, value: value2 });
        hasTime = true;
        continue;
      }
      // Fall through: treat first numeric col as a bare value.
    }
    const v = Number(cols[0]);
    if (!Number.isNaN(v)) points.push({ time: idx++, value: v });
  }
  // Keep chronological order when timestamped.
  if (hasTime) points.sort((a, b) => a.time - b.time);
  return { points, hasTime };
}

/**
 * Forward-fill align timestamped points to candle times: each candle takes the
 * most recent factor value at or before its time (NaN before the first point).
 * This is the correct, look-ahead-safe alignment — if the user timestamps a
 * factor at its publication time, releases never leak into earlier bars.
 */
export function alignToCandleTimes(points: FactorPoint[], candleTimes: number[]): number[] {
  const out = new Array<number>(candleTimes.length).fill(NaN);
  if (points.length === 0) return out;
  let p = 0;
  let last = NaN;
  for (let i = 0; i < candleTimes.length; i++) {
    while (p < points.length && points[p].time <= candleTimes[i]) {
      last = points[p].value;
      p++;
    }
    out[i] = last;
  }
  return out;
}

/**
 * Align bare values (no timestamps) to a candle count by right-anchoring:
 * the last value lines up with the last candle. Pads the front with NaN.
 */
export function alignByIndex(values: number[], length: number): number[] {
  const out = new Array<number>(length).fill(NaN);
  const offset = length - values.length;
  for (let i = 0; i < values.length; i++) {
    const j = offset + i;
    if (j >= 0 && j < length) out[j] = values[i];
  }
  return out;
}

/** Convenience: parse + align in one step against candle times. */
export function factorFromCsv(text: string, candleTimes: number[]): number[] {
  const { points, hasTime } = parseFactorCsv(text);
  return hasTime
    ? alignToCandleTimes(points, candleTimes)
    : alignByIndex(
        points.map((p) => p.value),
        candleTimes.length
      );
}

/** Trim a leading NaN warm-up from two aligned series, keeping them contiguous. */
export function trimLeadingNaN(a: number[], b: number[]): { a: number[]; b: number[] } {
  let start = 0;
  const n = Math.min(a.length, b.length);
  while (start < n && (Number.isNaN(a[start]) || Number.isNaN(b[start]))) start++;
  return { a: a.slice(start, n), b: b.slice(start, n) };
}
