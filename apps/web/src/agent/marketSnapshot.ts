// Compact, model-friendly snapshot of what the chart shows right now: the latest bars,
// a few standard indicator readings and whether the data is streaming live. Attached
// to every user message and returned by the get_live_market tool, so the analyst always
// reasons from the current chart instead of a stale dataset summary.
import { computeIndicator, type Candle } from "@stratforge/engine";
import { getState } from "../store.js";
import { getLiveStatus } from "../panels/live.js";

const iso = (t: number) => new Date(t * 1000).toISOString().replace(":00.000Z", "Z");
const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);

function lastOf(spec: unknown, line: string, candles: Candle[]): number | null {
  const out = computeIndicator(spec as Parameters<typeof computeIndicator>[0], candles) as Record<string, number[]>;
  const v = out[line]?.[out[line].length - 1];
  return v != null && Number.isFinite(v) ? round(v) : null;
}

const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 10000) / 100 : null);

export function marketSnapshot(workspaceId: string, bars = 20): Record<string, unknown> | null {
  const { candles, datasetName } = getState(workspaceId);
  if (candles.length === 0) return null;
  const n = Math.max(1, Math.min(300, Math.floor(bars)));
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const window = candles.slice(-n);
  const live = getLiveStatus();
  const isLive = live.state !== "off" && live.dataset === datasetName && live.workspaceId === workspaceId;
  return {
    dataset: datasetName,
    asOf: new Date().toISOString(),
    live: isLive
      ? { streaming: live.state === "live", lastUpdate: live.lastUpdate ? new Date(live.lastUpdate).toISOString() : null, note: "the last bar is still forming" }
      : { streaming: false, note: "static dataset; the last bar may be old" },
    lastPrice: round(last.close),
    lastBarOpen: iso(last.time),
    changeVsPrevClosePct: prev ? pct(last.close, prev.close) : null,
    changeOverWindowPct: pct(last.close, window[0].open),
    windowHigh: round(Math.max(...window.map((c) => c.high))),
    windowLow: round(Math.min(...window.map((c) => c.low))),
    indicators: {
      sma20: lastOf({ type: "sma", params: { period: 20, source: "close" } }, "sma", candles),
      sma50: lastOf({ type: "sma", params: { period: 50, source: "close" } }, "sma", candles),
      rsi14: lastOf({ type: "rsi", params: { period: 14, source: "close" } }, "rsi", candles),
      atr14: lastOf({ type: "atr", params: { period: 14 } }, "atr", candles),
    },
    barsColumns: ["openTimeUTC", "open", "high", "low", "close", "volume"],
    bars: window.map((c) => [iso(c.time), round(c.open), round(c.high), round(c.low), round(c.close), round(c.volume)]),
  };
}
