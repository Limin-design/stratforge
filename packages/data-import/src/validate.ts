import type { Candle } from "@stratforge/engine";

export interface ValidationReport {
  ok: boolean;
  bars: number;
  duplicatesRemoved: number;
  gaps: Array<{ afterTime: number; missingBars: number }>;
  /** Most common bar interval in seconds (inferred) */
  inferredIntervalSec: number | null;
  issues: string[];
}

/**
 * Normalize an imported series: sort by time, drop duplicates, detect gaps,
 * flag bad OHLC rows. Returns cleaned candles + a report the wizard shows
 * to the user before saving the dataset.
 */
export function validateCandles(input: Candle[]): { candles: Candle[]; report: ValidationReport } {
  const issues: string[] = [];

  // Drop structurally invalid rows.
  const valid = input.filter((c) => {
    const finite = [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite);
    const sane = c.high >= c.low && c.high >= Math.max(c.open, c.close) - 1e-9 && c.low <= Math.min(c.open, c.close) + 1e-9;
    return finite && sane;
  });
  if (valid.length < input.length) {
    issues.push(`${input.length - valid.length} malformed row(s) dropped`);
  }

  // Sort + dedupe by timestamp (keep first occurrence).
  valid.sort((a, b) => a.time - b.time);
  const seen = new Set<number>();
  const candles: Candle[] = [];
  for (const c of valid) {
    if (!seen.has(c.time)) {
      seen.add(c.time);
      candles.push(c);
    }
  }
  const duplicatesRemoved = valid.length - candles.length;

  // Infer interval from the most frequent delta.
  let inferredIntervalSec: number | null = null;
  if (candles.length > 2) {
    const freq = new Map<number, number>();
    for (let i = 1; i < candles.length; i++) {
      const d = candles[i].time - candles[i - 1].time;
      freq.set(d, (freq.get(d) ?? 0) + 1);
    }
    inferredIntervalSec = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  // Gap detection (ignores single weekend-sized gaps for daily forex data —
  // anything > 1 missing bar is reported; the UI decides what to surface).
  const gaps: ValidationReport["gaps"] = [];
  if (inferredIntervalSec) {
    for (let i = 1; i < candles.length; i++) {
      const d = candles[i].time - candles[i - 1].time;
      if (d > inferredIntervalSec) {
        gaps.push({
          afterTime: candles[i - 1].time,
          missingBars: Math.round(d / inferredIntervalSec) - 1,
        });
      }
    }
  }

  if (candles.length < 100) issues.push("Fewer than 100 bars — backtest results will be unreliable");

  return {
    candles,
    report: {
      ok: issues.length === 0,
      bars: candles.length,
      duplicatesRemoved,
      gaps,
      inferredIntervalSec,
      issues,
    },
  };
}
