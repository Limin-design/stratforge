/**
 * Trade-log analysis in market context.
 *
 * Users bring their own fills/trades. This module aligns those trades to the
 * loaded candles, reads the market state around each entry, and reports where
 * the trader actually makes or loses money. No broker integration, no secrets,
 * no licensed data dependency.
 */
import { rsi, atr } from "./indicators.js";
import { classifyRegimes } from "./regimes.js";
import { DEFAULT_FEATURE_SPECS, featureSeries, type FeatureSpec } from "./features.js";
import type { Candle, Trade } from "./types.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export type ExternalTradeSide = "long" | "short";

export interface ExternalTrade {
  entryTime: number;
  exitTime?: number;
  side: ExternalTradeSide;
  entryPrice?: number;
  exitPrice?: number;
  quantity?: number;
  pnl?: number;
  symbol?: string;
  tag?: string;
  notes?: string;
}

export interface TradeLogParseIssue {
  row: number;
  issue: string;
}

export interface TradeLogParseResult {
  trades: ExternalTrade[];
  issues: TradeLogParseIssue[];
}

export interface InstrumentMetadata {
  symbol?: string;
  assetClass?: "equity" | "future" | "forex" | "crypto" | "option" | "other";
  exchange?: string;
  session?: string;
  tickSize?: number;
  pointValue?: number;
  currency?: string;
}

export interface TradeContextRow {
  trade: ExternalTrade;
  entryBar: number;
  exitBar: number | null;
  holdingBars: number | null;
  regime: string | null;
  session: string;
  hourUtc: number;
  atrPct: number | null;
  rsi14: number | null;
  pnl: number;
  pnlPct: number;
  featureValues: Record<string, number>;
}

export interface TradeGroupStats {
  key: string;
  trades: number;
  winRatePct: number;
  totalPnl: number;
  expectancy: number;
  profitFactor: number;
  pnlSharePct: number;
}

export interface TradeLogSummary {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnl: number;
  expectancy: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: number;
  worstTrade: number;
  avgHoldBars: number;
}

export interface TradeLogAnalysis {
  metadata?: InstrumentMetadata;
  summary: TradeLogSummary;
  rows: TradeContextRow[];
  byRegime: TradeGroupStats[];
  bySession: TradeGroupStats[];
  byTag: TradeGroupStats[];
  byFeature: TradeGroupStats[];
  engineTrades: Trade[];
  warnings: string[];
}

const ENTRY_TIME_KEYS = ["entrytime", "entry_time", "entry date", "entrydate", "open time", "opentime", "open_date", "open date", "time", "date"];
const EXIT_TIME_KEYS = ["exittime", "exit_time", "exit date", "exitdate", "close time", "closetime", "close_date", "close date"];
const SIDE_KEYS = ["side", "direction", "type", "longshort", "long/short"];
const ENTRY_PRICE_KEYS = ["entry", "entryprice", "entry_price", "openprice", "open price", "pricein", "price in"];
const EXIT_PRICE_KEYS = ["exit", "exitprice", "exit_price", "closeprice", "close price", "priceout", "price out"];
const QTY_KEYS = ["qty", "quantity", "size", "contracts", "shares", "units"];
const PNL_KEYS = ["pnl", "p&l", "profit", "profitloss", "profit/loss", "netpnl", "net pnl"];
const SYMBOL_KEYS = ["symbol", "ticker", "instrument", "market"];
const TAG_KEYS = ["tag", "setup", "strategy", "playbook", "label"];

function key(s: string): string {
  return s.trim().toLowerCase().replace(/[\s._-]+/g, " ");
}

function pick(row: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const direct = row[key(k)];
    if (direct != null && direct.trim() !== "") return direct.trim();
  }
  return undefined;
}

function parseNumber(s: string | undefined): number | undefined {
  if (s == null || s.trim() === "") return undefined;
  const cleaned = s.trim().replace(/[$,%]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function parseTime(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const raw = s.trim();
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (n > 1e17) return Math.floor(n / 1e9); // ns
    if (n > 1e14) return Math.floor(n / 1e6); // µs
    if (n > 1e11) return Math.floor(n / 1000); // ms
    if (n > 1e9) return Math.floor(n); // s
  }
  const normalized = raw.includes(".") && /^\d{4}\.\d{2}\.\d{2}/.test(raw) ? raw.replace(/\./g, "-") : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delimiter && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function detectDelimiter(line: string): string {
  const candidates = [",", ";", "\t", "|"];
  return candidates
    .map((d) => ({ d, n: splitLine(line, d).length }))
    .sort((a, b) => b.n - a.n)[0]?.d ?? ",";
}

function parseSide(s: string | undefined): ExternalTradeSide {
  const v = (s ?? "long").trim().toLowerCase();
  if (v.includes("short") || v === "sell" || v === "s") return "short";
  return "long";
}

export function parseTradeLogCsv(text: string): TradeLogParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { trades: [], issues: [{ row: 0, issue: "empty trade log" }] };
  const delimiter = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delimiter).map(key);
  const trades: ExternalTrade[] = [];
  const issues: TradeLogParseIssue[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delimiter);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => (row[h] = cells[j] ?? ""));
    const entryTime = parseTime(pick(row, ENTRY_TIME_KEYS));
    if (entryTime == null) {
      issues.push({ row: i + 1, issue: "missing or invalid entry time" });
      continue;
    }
    const entryPrice = parseNumber(pick(row, ENTRY_PRICE_KEYS));
    const exitPrice = parseNumber(pick(row, EXIT_PRICE_KEYS));
    const pnl = parseNumber(pick(row, PNL_KEYS));
    const quantity = parseNumber(pick(row, QTY_KEYS));
    if (pnl == null && (entryPrice == null || exitPrice == null)) {
      issues.push({ row: i + 1, issue: "need either pnl or both entry/exit prices" });
      continue;
    }
    trades.push({
      entryTime,
      exitTime: parseTime(pick(row, EXIT_TIME_KEYS)),
      side: parseSide(pick(row, SIDE_KEYS)),
      entryPrice,
      exitPrice,
      quantity,
      pnl,
      symbol: pick(row, SYMBOL_KEYS),
      tag: pick(row, TAG_KEYS),
    });
  }
  return { trades, issues };
}

function upperBoundTime(candles: Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, Math.min(candles.length - 1, lo - 1));
}

function sessionLabel(hourUtc: number): string {
  if (hourUtc >= 13 && hourUtc < 21) return "US cash / NY";
  if (hourUtc >= 7 && hourUtc < 16) return "Europe / London";
  if (hourUtc >= 0 && hourUtc < 8) return "Asia";
  return "Globex / off-hours";
}

function tradePnl(t: ExternalTrade): { pnl: number; pnlPct: number; entryPrice: number; exitPrice: number } {
  const entryPrice = t.entryPrice ?? 0;
  const exitPrice = t.exitPrice ?? entryPrice;
  const direction = t.side === "short" ? -1 : 1;
  const qty = t.quantity ?? 1;
  const rawMove = entryPrice > 0 && exitPrice > 0 ? direction * (exitPrice - entryPrice) : 0;
  const pnl = t.pnl ?? rawMove * qty;
  const pnlPct = entryPrice > 0 && exitPrice > 0 ? (rawMove / entryPrice) * 100 : 0;
  return { pnl, pnlPct, entryPrice, exitPrice };
}

function groupStats(rows: TradeContextRow[], group: (r: TradeContextRow) => string | null): TradeGroupStats[] {
  const totalAbs = Math.abs(rows.reduce((s, r) => s + r.pnl, 0));
  const buckets = new Map<string, TradeContextRow[]>();
  for (const row of rows) {
    const k = group(row);
    if (!k) continue;
    const xs = buckets.get(k) ?? [];
    xs.push(row);
    buckets.set(k, xs);
  }
  return [...buckets.entries()]
    .map(([k, xs]) => {
      const wins = xs.filter((r) => r.pnl > 0);
      const losses = xs.filter((r) => r.pnl <= 0);
      const grossProfit = wins.reduce((s, r) => s + r.pnl, 0);
      const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
      const totalPnl = xs.reduce((s, r) => s + r.pnl, 0);
      return {
        key: k,
        trades: xs.length,
        winRatePct: round2((wins.length / xs.length) * 100),
        totalPnl: round2(totalPnl),
        expectancy: round2(totalPnl / xs.length),
        profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0,
        pnlSharePct: totalAbs > 0 ? round2((totalPnl / totalAbs) * 100) : 0,
      };
    })
    .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
}

function featureBucket(row: TradeContextRow): string | null {
  const z = row.featureValues.zClose50;
  if (Number.isFinite(z)) {
    if (z >= 1) return "extended high (zClose ≥ 1)";
    if (z <= -1) return "extended low (zClose ≤ -1)";
  }
  const rsiValue = row.rsi14;
  if (rsiValue != null) {
    if (rsiValue >= 70) return "overbought RSI ≥ 70";
    if (rsiValue <= 30) return "oversold RSI ≤ 30";
  }
  return "neutral feature bucket";
}

export function analyzeTradeLogInMarketContext(
  candles: Candle[],
  trades: ExternalTrade[],
  opts: { metadata?: InstrumentMetadata; featureSpecs?: FeatureSpec[] } = {}
): TradeLogAnalysis {
  const warnings: string[] = [];
  if (candles.length < 30) warnings.push("Need more candle history for reliable market-context attribution.");
  if (trades.length < 30) warnings.push(`Only ${trades.length} imported trades — conclusions are provisional.`);

  const regimes = classifyRegimes(candles);
  const atr14 = atr(candles, 14);
  const rsi14 = rsi(candles.map((c) => c.close), 14);
  const features = (opts.featureSpecs ?? DEFAULT_FEATURE_SPECS).map((s) => featureSeries(s, candles));
  const rows: TradeContextRow[] = [];
  const engineTrades: Trade[] = [];

  for (const t of trades) {
    if (candles.length === 0) continue;
    const entryBar = upperBoundTime(candles, t.entryTime);
    const exitBar = t.exitTime != null ? upperBoundTime(candles, t.exitTime) : null;
    const entryCandle = candles[entryBar];
    const exitCandle = exitBar != null ? candles[exitBar] : undefined;
    const hourUtc = new Date(entryCandle.time * 1000).getUTCHours();
    const pnlInfo = tradePnl({
      ...t,
      entryPrice: t.entryPrice ?? entryCandle.close,
      exitPrice: t.exitPrice ?? exitCandle?.close ?? t.entryPrice ?? entryCandle.close,
    });
    const featureValues = Object.fromEntries(features.map((f) => [f.spec.id, round4(f.values[entryBar])])) as Record<string, number>;
    rows.push({
      trade: t,
      entryBar,
      exitBar,
      holdingBars: exitBar != null ? Math.max(0, exitBar - entryBar) : null,
      regime: regimes[entryBar]?.label ?? null,
      session: sessionLabel(hourUtc),
      hourUtc,
      atrPct: Number.isFinite(atr14[entryBar]) && entryCandle.close > 0 ? round4((atr14[entryBar] / entryCandle.close) * 100) : null,
      rsi14: Number.isFinite(rsi14[entryBar]) ? round2(rsi14[entryBar]) : null,
      pnl: round2(pnlInfo.pnl),
      pnlPct: round4(pnlInfo.pnlPct),
      featureValues,
    });
    if (exitBar != null) {
      engineTrades.push({
        entryBar,
        exitBar,
        entryTime: entryCandle.time,
        exitTime: candles[exitBar].time,
        entryPrice: pnlInfo.entryPrice,
        exitPrice: pnlInfo.exitPrice,
        size: t.quantity ?? 1,
        pnl: pnlInfo.pnl,
        pnlPct: pnlInfo.pnlPct,
        exitReason: "signal",
      });
    }
  }

  const wins = rows.filter((r) => r.pnl > 0);
  const losses = rows.filter((r) => r.pnl <= 0);
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const grossProfit = wins.reduce((s, r) => s + r.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
  const holds = rows.map((r) => r.holdingBars).filter((x): x is number => x != null);
  const summary: TradeLogSummary = {
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: rows.length ? round2((wins.length / rows.length) * 100) : 0,
    totalPnl: round2(totalPnl),
    expectancy: rows.length ? round2(totalPnl / rows.length) : 0,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0,
    avgWin: wins.length ? round2(grossProfit / wins.length) : 0,
    avgLoss: losses.length ? round2(grossLoss / losses.length) : 0,
    bestTrade: rows.length ? round2(Math.max(...rows.map((r) => r.pnl))) : 0,
    worstTrade: rows.length ? round2(Math.min(...rows.map((r) => r.pnl))) : 0,
    avgHoldBars: holds.length ? round2(holds.reduce((s, h) => s + h, 0) / holds.length) : 0,
  };

  const byRegime = groupStats(rows, (r) => r.regime);
  const bySession = groupStats(rows, (r) => r.session);
  const byTag = groupStats(rows, (r) => r.trade.tag ?? null);
  const byFeature = groupStats(rows, featureBucket);

  const dominantRegime = byRegime[0];
  if (dominantRegime && Math.abs(dominantRegime.pnlSharePct) > 70) {
    warnings.push(`Trade-log PnL is dominated by ${dominantRegime.key} (${dominantRegime.pnlSharePct}% share). Your edge may be one-regime only.`);
  }
  const worstSession = [...bySession].sort((a, b) => a.totalPnl - b.totalPnl)[0];
  if (worstSession && worstSession.totalPnl < 0) warnings.push(`Worst session is ${worstSession.key} (${worstSession.totalPnl} PnL). Consider filtering or sizing down there.`);
  if (summary.expectancy <= 0) warnings.push("Imported trade log has non-positive expectancy. Fix execution/setup selection before optimizing strategy rules.");

  return { metadata: opts.metadata, summary, rows, byRegime, bySession, byTag, byFeature, engineTrades, warnings };
}
