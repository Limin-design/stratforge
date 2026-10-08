// Live candles: streams the current Binance pair over the public market-data WebSocket
// and folds each kline into the workspace's dataset (update the forming bar, append a
// new one). Updates are batched to one store write per second so the chart and the
// indicators redraw at a steady rate. No key is involved: this is public market data.
import type { Candle } from "@stratforge/engine";
import { getState, setState, subscribe } from "../store.js";
import { parseDatasetName } from "./timeframe.js";

export type LiveState = "off" | "connecting" | "live" | "reconnecting";

export interface LiveStatus {
  state: LiveState;
  dataset: string;
  workspaceId: string;
  lastPrice: number | null;
  lastUpdate: number | null; // ms epoch of the last message
  detail: string;
}

export interface ClosedCandle {
  workspaceId: string;
  dataset: string;
  candle: Candle;
}

const STREAM_BASE = "wss://data-stream.binance.vision/ws";
const FLUSH_MS = 1000;
const RECONNECT_MS = 3000;
const MAX_BARS = 5000;

let ws: WebSocket | null = null;
let status: LiveStatus = { state: "off", dataset: "", workspaceId: "", lastPrice: null, lastUpdate: null, detail: "" };
let pending: Candle | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let unsubStore: (() => void) | null = null;
const statusListeners = new Set<(s: LiveStatus) => void>();
const closeListeners = new Set<(c: ClosedCandle) => void>();

function emit(patch: Partial<LiveStatus>): void {
  status = { ...status, ...patch };
  for (const l of statusListeners) l(status);
}

export function getLiveStatus(): LiveStatus {
  return status;
}

export function onLiveStatus(l: (s: LiveStatus) => void): () => void {
  statusListeners.add(l);
  return () => statusListeners.delete(l);
}

/** Fires once per closed bar while live is on (used by the AI analyst's watch mode). */
export function onCandleClose(l: (c: ClosedCandle) => void): () => void {
  closeListeners.add(l);
  return () => closeListeners.delete(l);
}

/** Live streaming is available for Binance pairs loaded from the Data tab or the timeframe buttons. */
export function liveSupported(datasetName: string): boolean {
  return parseDatasetName(datasetName)?.exchange === "Binance";
}

function mergeCandle(candles: Candle[], c: Candle): Candle[] | null {
  const last = candles[candles.length - 1];
  if (!last) return null;
  if (c.time === last.time) return [...candles.slice(0, -1), c];
  if (c.time > last.time) return [...candles, c].slice(-MAX_BARS);
  return null; // stale message for an older bar
}

function flush(): void {
  flushTimer = null;
  if (!pending) return;
  const c = pending;
  pending = null;
  const s = getState(status.workspaceId);
  if (s.datasetName !== status.dataset) return;
  const next = mergeCandle(s.candles, c);
  if (next) setState({ candles: next }, status.workspaceId);
}

function connect(): void {
  const ref = parseDatasetName(status.dataset);
  if (!ref) return;
  const url = `${STREAM_BASE}/${ref.symbol.toLowerCase()}@kline_${ref.interval}`;
  const socket = new WebSocket(url);
  ws = socket;
  socket.onopen = () => {
    if (ws === socket) emit({ state: "live", detail: "" });
  };
  socket.onmessage = (ev) => {
    if (ws !== socket) return;
    let k: Record<string, unknown> | undefined;
    try {
      k = (JSON.parse(String(ev.data)) as { k?: Record<string, unknown> }).k;
    } catch {
      return;
    }
    if (!k) return;
    const candle: Candle = {
      time: Math.floor(Number(k.t) / 1000),
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
    };
    if (![candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) return;
    pending = candle;
    emit({ lastPrice: candle.close, lastUpdate: Date.now() });
    if (k.x === true) {
      // Bar closed: write it now so listeners read a dataset that includes it.
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      for (const l of closeListeners) l({ workspaceId: status.workspaceId, dataset: status.dataset, candle });
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS);
    }
  };
  socket.onerror = () => {
    if (ws === socket) emit({ detail: "connection error" });
  };
  socket.onclose = () => {
    if (ws !== socket || status.state === "off") return;
    emit({ state: "reconnecting" });
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  };
}

/** Start streaming the given workspace's dataset. Returns an error message, or null on success. */
export function startLive(workspaceId: string): string | null {
  const dataset = getState(workspaceId).datasetName;
  if (!liveSupported(dataset)) return "live data needs a Binance pair (use the timeframe buttons or the Data tab)";
  stopLive();
  emit({ state: "connecting", dataset, workspaceId, lastPrice: null, lastUpdate: null, detail: "" });
  // A new dataset (other pair, timeframe or file) ends the stream for the old one.
  unsubStore = subscribe(() => {
    if (status.state !== "off" && getState(status.workspaceId).datasetName !== status.dataset) stopLive();
  });
  connect();
  return null;
}

export function stopLive(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (flushTimer) clearTimeout(flushTimer);
  reconnectTimer = flushTimer = null;
  pending = null;
  unsubStore?.();
  unsubStore = null;
  const socket = ws;
  ws = null;
  socket?.close();
  if (status.state !== "off") emit({ state: "off", detail: "" });
}
