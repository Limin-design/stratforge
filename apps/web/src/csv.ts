/**
 * Generic OHLCV CSV importer — built to swallow the formats traders actually
 * export, without the user having to tell it which one. It auto-detects:
 *
 *  Delimiters     comma, semicolon, tab, or pipe
 *  Headers        named (any order/case), MetaTrader bracketed (<DATE>,<OPEN>…),
 *                 or none (positional: Binance-style time,O,H,L,C,V,…)
 *  Timestamps     epoch s/ms/µs/ns; ISO 8601; YYYY.MM.DD / YYYY/MM/DD;
 *                 DD.MM.YYYY & MM/DD/YYYY; compact YYYYMMDD[HHMMSS];
 *                 and a SEPARATE date + time column (MT4/MT5/NinjaTrader)
 *  Numbers        decimal point, or decimal comma (e.g. "16541,77")
 *
 * All times are normalised to UTC unix-seconds. Result is sorted ascending and
 * capped to the most recent `maxBars` so a multi-hundred-MB history stays
 * responsive in the browser. Tick/quote data (bid/ask, no OHLC) and binary
 * formats are out of scope.
 */
export interface OhlcvCandle {
  time: number; // unix seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function unquote(s: string): string {
  return (s ?? "").trim().replace(/^["']|["']$/g, "");
}
function cleanHeader(h: string): string {
  return unquote(h).toLowerCase().replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

function ymdToSec(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi, s) / 1000);
}

function parseDatePart(d: string): [number, number, number] | null {
  d = d.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(d))) return [+m[1], +m[2], +m[3]];
  if ((m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/.exec(d))) {
    const a = +m[1], b = +m[2], y = +m[3];
    const sep = d.includes(".") ? "." : d.includes("/") ? "/" : "-";
    if (a > 12 && b <= 12) return [y, b, a]; // a is the day
    if (b > 12 && a <= 12) return [y, a, b]; // b is the day (US m/d)
    return sep === "." ? [y, b, a] : [y, a, b]; // dotted→DD.MM (EU), slashed→MM/DD (US)
  }
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(d))) return [+m[1], +m[2], +m[3]]; // compact YYYYMMDD
  return null;
}

function parseTimePart(t: string): [number, number, number] {
  t = (t ?? "").trim();
  if (!t) return [0, 0, 0];
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t))) return [+m[1], +m[2], +(m[3] ?? 0)];
  if ((m = /^(\d{2})(\d{2})(\d{2})$/.exec(t))) return [+m[1], +m[2], +m[3]]; // HHMMSS
  if ((m = /^(\d{2})(\d{2})$/.exec(t))) return [+m[1], +m[2], 0]; // HHMM
  return [0, 0, 0];
}

/** Coerce a date cell (optionally plus a separate time cell) into UTC seconds. */
export function parseTime(dateRaw: string, timeRaw?: string): number | null {
  const raw = unquote(dateRaw);
  if (!raw) return null;
  const sepTime = timeRaw != null ? unquote(timeRaw) : "";

  // Pure epoch — only when there's no separate time column and it's long enough
  // that it can't be a bare YYYYMMDD date.
  if (!sepTime && /^\d{10,}$/.test(raw)) {
    let n = Number(raw);
    if (raw.length >= 19) n /= 1e9;
    else if (raw.length >= 16) n /= 1e6;
    else if (raw.length >= 13) n /= 1e3;
    return Math.floor(n);
  }

  // Split an embedded "date time" cell; a separate time column wins if present.
  let datePart = raw;
  let timePart = sepTime;
  const sp = raw.split(/[ T]+/);
  if (sp.length >= 2) {
    datePart = sp[0];
    if (!timePart) timePart = sp.slice(1).join(" ");
  }

  // Compact datetime in one token, e.g. 20230101000000
  if (!timePart && /^\d{14}$/.test(datePart)) {
    return ymdToSec(+datePart.slice(0, 4), +datePart.slice(4, 6), +datePart.slice(6, 8), +datePart.slice(8, 10), +datePart.slice(10, 12), +datePart.slice(12, 14));
  }

  const ymd = parseDatePart(datePart);
  if (!ymd) return null;
  const hms = parseTimePart(timePart);
  return ymdToSec(ymd[0], ymd[1], ymd[2], hms[0], hms[1], hms[2]);
}

function num(raw: string, delim: string): number {
  let s = unquote(raw);
  if (delim !== "," && s.includes(",") && !s.includes(".")) s = s.replace(",", "."); // decimal comma
  return Number(s);
}

const DATE_NAMES = ["date", "datetime", "date_time", "timestamp", "timestamp_ms", "open_time", "opentime", "gmt time", "local time", "time", "unix", "unixtime", "time_utc"];
const isTimeCell = (s: string): boolean => /^\d{1,2}:\d{2}/.test(s) || /^\d{4}$/.test(s) || /^\d{6}$/.test(s);

interface CsvLayout {
  rows: string[];
  delim: string;
  dateIdx: number;
  timeIdx: number;
  oIdx: number;
  hIdx: number;
  lIdx: number;
  cIdx: number;
  vIdx: number;
  start: number;
}

function prepareCsvLayout(text: string): CsvLayout {
  const rows: string[] = [];
  for (const l of text.split(/\r?\n/)) if (l.trim() !== "") rows.push(l);
  if (rows.length === 0) {
    return { rows, delim: ",", dateIdx: 0, timeIdx: -1, oIdx: 1, hIdx: 2, lIdx: 3, cIdx: 4, vIdx: 5, start: 0 };
  }

  const counts = [",", ";", "\t", "|"].map((d) => [d, rows[0].split(d).length] as const);
  const sortedCounts = [...counts].sort((a, b) => b[1] - a[1]);
  const delim = sortedCounts[0][1] > 1 ? sortedCounts[0][0] : ",";

  const first = rows[0].split(delim);
  const firstClean = cleanHeader(first[0]);
  const looksHeader =
    first.some((c) => /[a-z]/i.test(unquote(c))) && !/^\d{4}[-./]\d/.test(firstClean) && !/^\d+$/.test(firstClean);

  let dateIdx = 0;
  let timeIdx = -1;
  let oIdx = 1;
  let hIdx = 2;
  let lIdx = 3;
  let cIdx = 4;
  let vIdx = 5;
  let start = 0;

  if (looksHeader) {
    start = 1;
    const head = first.map(cleanHeader);
    const find = (names: string[]) => head.findIndex((h) => names.includes(h));
    const dWith = find(["date", "datetime", "date_time", "timestamp", "open_time", "opentime", "gmt time", "local time"]);
    const tCol = find(["time"]);
    if (dWith >= 0) {
      dateIdx = dWith;
      if (tCol >= 0 && tCol !== dWith) timeIdx = tCol;
    } else {
      const d = find(DATE_NAMES);
      dateIdx = d >= 0 ? d : 0;
    }
    oIdx = find(["open", "o"]);
    hIdx = find(["high", "h"]);
    lIdx = find(["low", "l"]);
    cIdx = find(["close", "c", "close_price", "last"]);
    vIdx = find(["volume", "vol", "tickvol", "tick_volume", "base_volume", "volume_base", "basevolume", "v"]);
    if (oIdx < 0 || hIdx < 0 || lIdx < 0 || cIdx < 0) {
      dateIdx = 0;
      timeIdx = -1;
      oIdx = 1;
      hIdx = 2;
      lIdx = 3;
      cIdx = 4;
      vIdx = 5;
      start = 1;
    }
  } else if (first.length >= 6 && parseDatePart(unquote(first[0])) && isTimeCell(unquote(first[1]))) {
    dateIdx = 0;
    timeIdx = 1;
    oIdx = 2;
    hIdx = 3;
    lIdx = 4;
    cIdx = 5;
    vIdx = 6;
  }

  return { rows, delim, dateIdx, timeIdx, oIdx, hIdx, lIdx, cIdx, vIdx, start };
}

export function parseCsvCandles(text: string, maxBars = 250_000): { candles: OhlcvCandle[]; total: number } {
  const layout = prepareCsvLayout(text);
  if (layout.rows.length === 0) return { candles: [], total: 0 };

  const all: OhlcvCandle[] = [];
  const maxIdx = Math.max(layout.dateIdx, layout.timeIdx, layout.oIdx, layout.hIdx, layout.lIdx, layout.cIdx);
  for (let i = layout.start; i < layout.rows.length; i++) {
    const c = layout.rows[i].split(layout.delim);
    if (c.length <= maxIdx) continue;
    const time = parseTime(c[layout.dateIdx], layout.timeIdx >= 0 ? c[layout.timeIdx] : undefined);
    const open = num(c[layout.oIdx], layout.delim);
    const high = num(c[layout.hIdx], layout.delim);
    const low = num(c[layout.lIdx], layout.delim);
    const close = num(c[layout.cIdx], layout.delim);
    const volume = layout.vIdx >= 0 && layout.vIdx < c.length ? num(c[layout.vIdx], layout.delim) : 0;
    if (time == null || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      continue;
    }
    all.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }

  all.sort((a, b) => a.time - b.time);
  const total = all.length;
  const candles = all.length > maxBars ? all.slice(all.length - maxBars) : all;
  return { candles, total };
}

/**
 * UI-safe parser that yields to the event loop periodically to keep the app responsive on huge files.
 */
export async function parseCsvCandlesAsync(text: string, maxBars = 250_000): Promise<{ candles: OhlcvCandle[]; total: number }> {
  const layout = prepareCsvLayout(text);
  if (layout.rows.length === 0) return { candles: [], total: 0 };

  const all: OhlcvCandle[] = [];
  const maxIdx = Math.max(layout.dateIdx, layout.timeIdx, layout.oIdx, layout.hIdx, layout.lIdx, layout.cIdx);
  for (let i = layout.start; i < layout.rows.length; i++) {
    if (i > layout.start && i % 1500 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const c = layout.rows[i].split(layout.delim);
    if (c.length <= maxIdx) continue;
    const time = parseTime(c[layout.dateIdx], layout.timeIdx >= 0 ? c[layout.timeIdx] : undefined);
    const open = num(c[layout.oIdx], layout.delim);
    const high = num(c[layout.hIdx], layout.delim);
    const low = num(c[layout.lIdx], layout.delim);
    const close = num(c[layout.cIdx], layout.delim);
    const volume = layout.vIdx >= 0 && layout.vIdx < c.length ? num(c[layout.vIdx], layout.delim) : 0;
    if (time == null || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      continue;
    }
    all.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }

  all.sort((a, b) => a.time - b.time);
  const total = all.length;
  const candles = all.length > maxBars ? all.slice(all.length - maxBars) : all;
  return { candles, total };
}
