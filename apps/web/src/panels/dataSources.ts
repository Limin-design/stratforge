// Data-source fetch layer, extracted from DataPanel so both the UI and the agent's
// load_data tool fetch through the exact same code (no duplicated exchange logic).
// No React here — pure fetch/parse, compile-checked.
import { binanceKlinesUrl, parseBinanceKlines } from "@stratforge/data-import";
import type { Candle } from "@stratforge/engine";

export const EXCHANGES = ["Binance", "Bybit", "OKX", "Coinbase", "Twelve Data", "Polygon", "MT5 file", "CSV file"] as const;
export type Exchange = (typeof EXCHANGES)[number];

const QUOTE_ASSETS = ["USDT", "USDC", "FDUSD", "TUSD", "DAI", "BUSD", "BTC", "ETH", "EUR", "USD"];
export function splitSymbol(sym: string): { base: string; quote: string } {
  const normalized = sym.trim().toUpperCase().replace(/[\s/_-]+/g, "");
  const q = QUOTE_ASSETS.find((x) => normalized.length > x.length && normalized.endsWith(x));
  if (!q) return { base: normalized, quote: "USDT" };
  return { base: normalized.slice(0, normalized.length - q.length), quote: q };
}

// timeframe code per exchange (null = unsupported)
export const IV: Record<Exchange, Record<string, string | null>> = {
  Binance: { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" },
  Bybit: { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "1w": "W" },
  OKX: { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W" },
  Coinbase: { "1m": "60", "5m": "300", "15m": "900", "1h": "3600", "4h": null, "1d": "86400", "1w": null },
  "Twelve Data": { "1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day", "1w": "1week" },
  Polygon: { "1m": "1|minute", "5m": "5|minute", "15m": "15|minute", "1h": "1|hour", "4h": "4|hour", "1d": "1|day", "1w": "1|week" },
  "MT5 file": {},
  "CSV file": {},
};

// Exchanges the agent can load without a key (public klines, CORS-friendly). Keyed
// vendors and file imports stay user-only — the agent never handles API keys/files.
export const CRYPTO_EXCHANGES = ["Binance", "Bybit", "OKX", "Coinbase"] as const;
export const DATA_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;

export interface LoadRequest {
  exchange: Exchange;
  symbol: string;
  interval: string;
}

/** Validate an agent-issued load request (crypto-only, supported timeframe, real
 *  symbol). Pure — no network — so it's unit-testable and gives the model a precise
 *  reason on failure before any fetch is attempted. */
export function validateLoadRequest(exchange: string, symbol: string, interval: string): LoadRequest | { error: string } {
  if (!(CRYPTO_EXCHANGES as readonly string[]).includes(exchange)) {
    return {
      error: `load_data supports public crypto exchanges only: ${CRYPTO_EXCHANGES.join(", ")}. Keyed vendors (Twelve Data, Polygon) and file imports (CSV, MT5) must be loaded by the user in the Data tab.`,
    };
  }
  const sym = symbol.trim().toUpperCase();
  if (!sym) return { error: "Provide a symbol, e.g. BTCUSDT." };
  if (!(DATA_INTERVALS as readonly string[]).includes(interval)) {
    return { error: `interval must be one of: ${DATA_INTERVALS.join(", ")}.` };
  }
  if (IV[exchange as Exchange][interval] == null) {
    return { error: `${exchange} doesn't offer the ${interval} timeframe — pick another.` };
  }
  return { exchange: exchange as Exchange, symbol: sym, interval };
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FETCH_RETRIES = 2;
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pickMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const cands = [o.error, o.message, o.reason, o.detail];
  const msg = cands.find((v) => typeof v === "string" && v.trim().length > 0);
  return typeof msg === "string" ? msg.trim() : null;
}

export async function fetchJsonWithTimeout(url: string, source: string): Promise<unknown> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const text = await res.text();
      let payload: unknown = null;
      if (text.trim().length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error(`${source}: invalid JSON response`);
        }
      }
      if (res.ok) return payload;
      const msg = pickMessage(payload) ?? `${res.status} ${res.statusText}`;
      if (RETRYABLE_HTTP.has(res.status) && attempt < MAX_FETCH_RETRIES) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      throw new Error(`${source}: ${msg}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /abort|timeout|network|failed to fetch/i.test(msg);
      if (retryable && attempt < MAX_FETCH_RETRIES) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      lastErr = new Error(`${source}: ${msg}`);
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error(`${source}: request failed`);
}

function num(value: unknown, field: string, row: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid ${field} at row ${row + 1}`);
  return n;
}

export function parseTwelveData(payload: unknown): Candle[] {
  if (!payload || typeof payload !== "object") throw new Error("Twelve Data: malformed response");
  const p = payload as Record<string, unknown>;
  if (p.status === "error") {
    const msg = String(p.message ?? "request failed");
    if (/limit|quota|429|too many/i.test(msg)) throw new Error("Twelve Data: rate limit hit — wait a bit and retry");
    throw new Error(`Twelve Data: ${msg}`);
  }
  const values = p.values;
  if (!Array.isArray(values)) throw new Error("Twelve Data: missing values array");

  const toSec = (x: string) => Math.floor(Date.parse(x.length > 10 ? x.replace(" ", "T") + "Z" : x + "T00:00:00Z") / 1000);
  const out: Candle[] = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const t = toSec(String(r.datetime ?? ""));
    const open = num(r.open, "open", i);
    const high = num(r.high, "high", i);
    const low = num(r.low, "low", i);
    const close = num(r.close, "close", i);
    const volume = r.volume == null ? 0 : num(r.volume, "volume", i);
    if (Number.isFinite(t)) out.push({ time: t, open, high, low, close, volume });
  }
  return out.sort((a, b) => a.time - b.time);
}

export function parsePolygon(payload: unknown): Candle[] {
  if (!payload || typeof payload !== "object") throw new Error("Polygon: malformed response");
  const p = payload as Record<string, unknown>;
  if (p.status === "ERROR" || p.error) {
    const msg = String(p.error ?? p.message ?? "request failed");
    if (/limit|quota|429|too many/i.test(msg)) throw new Error("Polygon: rate limit hit — wait a bit and retry");
    throw new Error(`Polygon: ${msg}`);
  }
  if (!Array.isArray(p.results)) {
    if (p.resultsCount === 0) return [];
    throw new Error("Polygon: missing results array");
  }
  return (p.results as Array<Record<string, unknown>>)
    .map((k, i) => ({
      time: Math.floor(num(k.t, "t", i) / 1000),
      open: num(k.o, "o", i),
      high: num(k.h, "h", i),
      low: num(k.l, "l", i),
      close: num(k.c, "c", i),
      volume: k.v == null ? 0 : num(k.v, "v", i),
    }))
    .sort((a, b) => a.time - b.time);
}

export async function fetchKlines(exchange: Exchange, symbol: string, interval: string, apiKey: string): Promise<Candle[]> {
  const normalizedSymbol = symbol.trim().toUpperCase().replace(/[\s/_-]+/g, "");
  const iv = IV[exchange][interval];
  if (iv == null) throw new Error(`${exchange} doesn't support the ${interval} timeframe`);
  const { base, quote } = splitSymbol(normalizedSymbol);
  if (exchange === "Binance") {
    return parseBinanceKlines((await fetchJsonWithTimeout(binanceKlinesUrl(normalizedSymbol, interval, 1000), "Binance")) as unknown[]);
  }
  if (exchange === "Bybit") {
    const j = await fetchJsonWithTimeout(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${normalizedSymbol}&interval=${iv}&limit=1000`, "Bybit");
    const list: string[][] = (j as { result?: { list?: string[][] } } | null)?.result?.list ?? [];
    return list.map((k) => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })).reverse();
  }
  if (exchange === "OKX") {
    const j = await fetchJsonWithTimeout(`https://www.okx.com/api/v5/market/candles?instId=${base}-${quote}&bar=${iv}&limit=300`, "OKX");
    const data: string[][] = (j as { data?: string[][] } | null)?.data ?? [];
    return data.map((k) => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })).reverse();
  }
  if (exchange === "Coinbase") {
    const prod = `${base}-${quote === "USDT" ? "USD" : quote}`;
    const data = (await fetchJsonWithTimeout(`https://api.exchange.coinbase.com/products/${prod}/candles?granularity=${iv}`, "Coinbase")) as number[][]; // [time, low, high, open, close, volume], newest first
    return data.map((k) => ({ time: k[0], open: k[3], high: k[2], low: k[1], close: k[4], volume: k[5] })).reverse();
  }
  if (exchange === "Twelve Data") {
    // One endpoint covers stocks (AAPL), forex (EUR/USD) and crypto (BTC/USD).
    if (!apiKey) throw new Error("This source needs an API key — add one above.");
    const u = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}&interval=${iv}&outputsize=5000&order=ASC&apikey=${encodeURIComponent(apiKey)}`;
    return parseTwelveData(await fetchJsonWithTimeout(u, "Twelve Data"));
  }
  if (exchange === "Polygon") {
    if (!apiKey) throw new Error("This source needs an API key — add one above.");
    // Accept natural symbols: EUR/USD → C:EURUSD, BTC/USD → X:BTCUSD, AAPL stays.
    const polySym = (s: string): string => {
      const t = s.trim().toUpperCase();
      if (/^[A-Z]:/.test(t)) return t;
      if (t.includes("/")) {
        const [a, b] = t.split("/");
        const fiat = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNH", "HKD", "SGD"];
        return fiat.includes(a) && fiat.includes(b) ? `C:${a}${b}` : `X:${a}${b}`;
      }
      return t;
    };
    const [mult, span] = iv.split("|");
    const days = span === "minute" ? 45 : span === "hour" ? 400 : span === "week" ? 9000 : 3650;
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const u = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(polySym(symbol))}/range/${mult}/${span}/${ymd(new Date(Date.now() - days * 864e5))}/${ymd(new Date())}?adjusted=true&sort=desc&limit=5000&apiKey=${encodeURIComponent(apiKey)}`;
    return parsePolygon(await fetchJsonWithTimeout(u, "Polygon"));
  }
  return [];
}
