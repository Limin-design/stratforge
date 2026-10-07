import type { Candle } from "@stratforge/engine";

/**
 * Binance kline parsers — Wizard #1.
 *
 * Two supported inputs:
 *  1. REST API response: GET /api/v3/klines?symbol=BTCUSDT&interval=1h
 *     -> array of arrays: [openTime(ms), open, high, low, close, volume, ...]
 *  2. CSV from data.binance.vision monthly dumps (same column order, no header).
 *
 * Both are FREE with full history — this is why crypto is wizard #1.
 */

type BinanceKline = [number, string, string, string, string, string, ...unknown[]];

export function parseBinanceKlines(klines: unknown[]): Candle[] {
  return (klines as BinanceKline[]).map((k) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

export function parseBinanceCsv(csv: string): Candle[] {
  const candles: Candle[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(",");
    if (cols.length < 6 || Number.isNaN(Number(cols[0]))) continue; // skip headers/junk
    // data.binance.vision uses ms epoch; some dumps use µs — normalize.
    let t = Number(cols[0]);
    if (t > 1e15) t = Math.floor(t / 1000); // µs -> ms
    candles.push({
      time: Math.floor(t / 1000),
      open: Number(cols[1]),
      high: Number(cols[2]),
      low: Number(cols[3]),
      close: Number(cols[4]),
      volume: Number(cols[5]),
    });
  }
  return candles;
}

/** Build a public Binance klines URL (no API key needed for historical data). */
export function binanceKlinesUrl(symbol: string, interval: string, limit = 1000): string {
  const p = new URLSearchParams({ symbol: symbol.toUpperCase(), interval, limit: String(limit) });
  return `https://api.binance.com/api/v3/klines?${p}`;
}
