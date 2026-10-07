import type { Candle } from "@stratforge/engine";

/**
 * MetaTrader 5 export parser — Wizard #2.
 *
 * In-app guide for users: MT5 -> View -> Symbols -> Bars tab -> select symbol
 * + timeframe + date range -> Request -> Export Bars (button saves CSV/TSV).
 * Any broker demo account works; the data is free.
 *
 * Typical format (tab- or comma-separated):
 *   <DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>
 *   2024.01.02\t00:00:00\t1.10437\t1.10547\t1.10437\t1.10522\t1234\t0\t5
 * Daily exports may omit the TIME column.
 */
export function parseMt5Csv(text: string): Candle[] {
  const candles: Candle[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<")) continue; // header row
    const cols = trimmed.split(/[\t,;]/).map((c) => c.trim());
    if (cols.length < 5) continue;

    const hasTime = /^\d{2}:\d{2}/.test(cols[1] ?? "");
    const dateStr = cols[0].replace(/\./g, "-");
    const timeStr = hasTime ? cols[1] : "00:00:00";
    const ts = Date.parse(`${dateStr}T${timeStr}Z`);
    if (Number.isNaN(ts)) continue;

    const o = hasTime ? 2 : 1;
    const open = Number(cols[o]);
    const high = Number(cols[o + 1]);
    const low = Number(cols[o + 2]);
    const close = Number(cols[o + 3]);
    if ([open, high, low, close].some(Number.isNaN)) continue;

    candles.push({
      time: Math.floor(ts / 1000),
      open,
      high,
      low,
      close,
      volume: Number(cols[o + 4] ?? 0) || 0, // tick volume
    });
  }
  return candles;
}
