import { computeIndicator } from "@stratforge/engine";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { getActiveWorkspaceId, getState, subscribe, type AppState } from "../store.js";
import {
  buildRaySegment,
  clampRayToRight,
  clampRectCornerWithCoords,
  deriveHitToleranceScale,
  deriveRayTimeStep,
  DRAW_GEOMETRY_PX,
  DRAW_HIT_PX,
  hasDrawingDragChanges,
  measuredCandleSpacingPx,
  orderSegmentByTime,
  rectCornerLoop,
  rollbackNoopDrawingDrag,
  translateDrawing,
} from "./chartDrawingUtils.js";
import { RiskRewardPrimitive } from "./rrBox.js";

type Tool = "cursor" | "hline" | "trend" | "ray" | "rect";
type MagnetMode = "off" | "weak" | "strong";
type IndType = "sma" | "ema" | "bollinger" | "vwap" | "rsi" | "macd" | "atr" | "stochastic" | "adx" | "mfi";
interface AddedInd { id: string; type: IndType; period: number; }
type DrawingKind = "hline" | "trend" | "ray" | "rect";
type DrawingLineStyle = "solid" | "dashed" | "dotted";
type DrawingStyle = { color: string; width: number; lineStyle: DrawingLineStyle; opacity: number };
type DrawingSnapshot =
  | { kind: "hline"; price: number; style?: DrawingStyle }
  | { kind: "trend"; from: { time: number; value: number }; to: { time: number; value: number }; style?: DrawingStyle }
  | { kind: "ray"; from: { time: number; value: number }; to: { time: number; value: number }; style?: DrawingStyle }
  | { kind: "rect"; from: { time: number; value: number }; to: { time: number; value: number }; style?: DrawingStyle };
interface WorkspaceChartUi {
  tool: Tool;
  magnetMode: MagnetMode;
  drawDefaults: Record<DrawingKind, DrawingStyle>;
  addType: IndType;
  addPeriod: number;
  inds: AddedInd[];
  drawings: DrawingSnapshot[];
}
type ChartDrawingRef = { kind: "pl" | "ls"; ref: IPriceLine | ISeriesApi<"Line">; snapshot: DrawingSnapshot };
type DrawingHitMode = "move" | "from" | "to" | "price";
type DrawingDrag = {
  index: number;
  mode: DrawingHitMode;
  start: { time: UTCTimestamp; value: number };
  origin: DrawingSnapshot;
  group?: Array<{ index: number; origin: DrawingSnapshot }>;
  redoBefore?: DrawingHistoryEntry[];
};
type DrawingHistoryEntry = {
  drawings: DrawingSnapshot[];
  selectedIndices: number[];
};

const TYPES: IndType[] = ["sma", "ema", "bollinger", "vwap", "rsi", "macd", "atr", "stochastic", "adx", "mfi"];
const OVERLAY = new Set<IndType>(["sma", "ema", "bollinger", "vwap"]); // share the price scale
const PALETTE = ["#8aa6cf", "#cbab7e", "#73b1a0", "#b196cf", "#d195a3", "#7fb0bb", "#c4a988"];
const CHART_UI_KEY = "stratforge.chartui.workspaces";
const chartUiByWorkspace = new Map<string, WorkspaceChartUi>();
const SNAP_PRICE_PX_WEAK = 10;
const SNAP_PRICE_PX_STRONG = 16;
const DRAW_HISTORY_MAX = 100;
const DEFAULT_DRAW_STYLE: DrawingStyle = { color: "#e0a35e", width: 2, lineStyle: "solid", opacity: 1 };
const DEFAULT_HLINE_STYLE: DrawingStyle = { color: "#e0a35e", width: 1, lineStyle: "dashed", opacity: 1 };
const DRAW_STYLE_PRESETS: Array<{ id: string; label: string; style: DrawingStyle }> = [
  { id: "amber", label: "Amber", style: { color: "#e0a35e", width: 2, lineStyle: "solid", opacity: 1 } },
  { id: "teal", label: "Teal", style: { color: "#5fc2b4", width: 2, lineStyle: "solid", opacity: 0.95 } },
  { id: "violet", label: "Violet", style: { color: "#b196cf", width: 2, lineStyle: "dashed", opacity: 0.95 } },
  { id: "focus", label: "Focus", style: { color: "#f3be7a", width: 3, lineStyle: "solid", opacity: 1 } },
];

function clampPeriod(n: number): number {
  if (!Number.isFinite(n)) return 20;
  return Math.max(2, Math.min(400, Math.round(n)));
}

function normalizeColor(v: unknown, fallback: string): string {
  const s = String(v ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    const c = s.slice(1);
    return `#${c[0]}${c[0]}${c[1]}${c[1]}${c[2]}${c[2]}`;
  }
  return fallback;
}
function clampOpacity(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.1, Math.min(1, n));
}
function clampWidth(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(4, Math.round(n)));
}
function normalizeLineStyle(v: unknown): DrawingLineStyle {
  return v === "dashed" || v === "dotted" ? (v as DrawingLineStyle) : "solid";
}
function sanitizeDrawingStyle(raw: unknown, fallback: DrawingStyle): DrawingStyle {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    color: normalizeColor(o.color, fallback.color),
    width: clampWidth(o.width ?? fallback.width),
    lineStyle: normalizeLineStyle(o.lineStyle ?? fallback.lineStyle),
    opacity: clampOpacity(o.opacity ?? fallback.opacity),
  };
}
function mergeDrawingStyle(base: DrawingStyle, patch: Partial<DrawingStyle>): DrawingStyle {
  return sanitizeDrawingStyle({ ...base, ...patch }, base);
}
function defaultDrawDefaults(): Record<DrawingKind, DrawingStyle> {
  return {
    hline: { ...DEFAULT_HLINE_STYLE },
    trend: { ...DEFAULT_DRAW_STYLE },
    ray: { ...DEFAULT_DRAW_STYLE },
    rect: { ...DEFAULT_DRAW_STYLE },
  };
}
function toChartLineStyle(v: DrawingLineStyle): LineStyle {
  return v === "dashed" ? LineStyle.Dashed : v === "dotted" ? LineStyle.Dotted : LineStyle.Solid;
}
function withOpacity(hex: string, opacity: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0.1, Math.min(1, opacity))})`;
}
function asLineWidth(v: number): 1 | 2 | 3 | 4 {
  return Math.max(1, Math.min(4, Math.round(v))) as 1 | 2 | 3 | 4;
}

function sanitizeUi(raw: unknown): WorkspaceChartUi {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tool = o.tool === "hline" || o.tool === "trend" || o.tool === "ray" || o.tool === "rect" ? (o.tool as Tool) : "cursor";
  const magnetMode = o.magnetMode === "off" || o.magnetMode === "weak" || o.magnetMode === "strong"
    ? (o.magnetMode as MagnetMode)
    : o.magnet === false
      ? "off"
      : "strong";
  const defaultsBase = defaultDrawDefaults();
  const rawDefaults = o.drawDefaults && typeof o.drawDefaults === "object" ? (o.drawDefaults as Record<string, unknown>) : {};
  const drawDefaults: Record<DrawingKind, DrawingStyle> = {
    hline: sanitizeDrawingStyle(rawDefaults.hline, defaultsBase.hline),
    trend: sanitizeDrawingStyle(rawDefaults.trend, defaultsBase.trend),
    ray: sanitizeDrawingStyle(rawDefaults.ray, defaultsBase.ray),
    rect: sanitizeDrawingStyle(rawDefaults.rect, defaultsBase.rect),
  };

  const addType = TYPES.includes(o.addType as IndType) ? (o.addType as IndType) : "sma";
  const addPeriod = clampPeriod(Number(o.addPeriod ?? 20));
  const inds = Array.isArray(o.inds)
    ? o.inds
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const y = x as Record<string, unknown>;
          const type = TYPES.includes(y.type as IndType) ? (y.type as IndType) : null;
          if (!type) return null;
          const period = clampPeriod(Number(y.period ?? 20));
          const id = String(y.id ?? `${type}-${Date.now()}`).trim() || `${type}-${Date.now()}`;
          return { id, type, period } as AddedInd;
        })
        .filter((x): x is AddedInd => Boolean(x))
    : [];
  const drawings = Array.isArray(o.drawings)
    ? o.drawings
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const y = x as Record<string, unknown>;
          if (y.kind === "hline") {
            const price = Number(y.price);
            if (!Number.isFinite(price)) return null;
            return { kind: "hline", price, style: sanitizeDrawingStyle(y.style, drawDefaults.hline) } as DrawingSnapshot;
          }
          if (y.kind === "trend" || y.kind === "ray" || y.kind === "rect") {
            const from = y.from as Record<string, unknown> | undefined;
            const to = y.to as Record<string, unknown> | undefined;
            const ft = Number(from?.time);
            const fv = Number(from?.value);
            const tt = Number(to?.time);
            const tv = Number(to?.value);
            if (![ft, fv, tt, tv].every(Number.isFinite)) return null;
            return {
              kind: y.kind,
              from: { time: ft, value: fv },
              to: { time: tt, value: tv },
              style: sanitizeDrawingStyle(y.style, drawDefaults[y.kind as DrawingKind]),
            } as DrawingSnapshot;
          }
          return null;
        })
        .filter((x): x is DrawingSnapshot => Boolean(x))
    : [];
  return { tool, magnetMode, drawDefaults, addType, addPeriod, inds, drawings };
}

function loadChartUiCache(): void {
  if (chartUiByWorkspace.size > 0) return;
  try {
    const raw = localStorage.getItem(CHART_UI_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [workspaceId, ui] of Object.entries(parsed)) {
      chartUiByWorkspace.set(workspaceId, sanitizeUi(ui));
    }
  } catch {
    // ignore malformed cache
  }
}

function persistChartUiCache(): void {
  try {
    localStorage.setItem(CHART_UI_KEY, JSON.stringify(Object.fromEntries(chartUiByWorkspace.entries())));
  } catch {
    // ignore quota/storage errors
  }
}

function defaultUi(): WorkspaceChartUi {
  return { tool: "cursor", magnetMode: "strong", drawDefaults: defaultDrawDefaults(), addType: "sma", addPeriod: 20, inds: [], drawings: [] };
}

function getWorkspaceUi(workspaceId: string): WorkspaceChartUi {
  loadChartUiCache();
  const existing = chartUiByWorkspace.get(workspaceId);
  if (existing) return existing;
  const fresh = defaultUi();
  chartUiByWorkspace.set(workspaceId, fresh);
  return fresh;
}

function updateWorkspaceUi(workspaceId: string, patch: Partial<WorkspaceChartUi>): void {
  const prev = getWorkspaceUi(workspaceId);
  chartUiByWorkspace.set(workspaceId, { ...prev, ...patch });
  persistChartUiCache();
}

function buildSpec(ind: AddedInd): unknown {
  const p = ind.period;
  switch (ind.type) {
    case "bollinger": return { id: ind.id, type: "bollinger", params: { period: p, stdDev: 2, source: "close" } };
    case "vwap": return { id: ind.id, type: "vwap", params: { period: p } };
    case "atr": return { id: ind.id, type: "atr", params: { period: p } };
    case "adx": return { id: ind.id, type: "adx", params: { period: p } };
    case "mfi": return { id: ind.id, type: "mfi", params: { period: p } };
    case "stochastic": return { id: ind.id, type: "stochastic", params: { kPeriod: p, dPeriod: 3 } };
    case "macd": return { id: ind.id, type: "macd", params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, source: "close" } };
    default: return { id: ind.id, type: ind.type, params: { period: p, source: "close" } };
  }
}

const svg = (paths: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
);
const TOOL_ICON: Record<Tool | "clear", ReactNode> = {
  cursor: svg(<><path d="M5 3l6 18 2-7 7-2z" /></>),
  hline: svg(<><path d="M3 12h18" /></>),
  trend: svg(<><path d="M4 18L20 6" /><circle cx="4" cy="18" r="1.6" /><circle cx="20" cy="6" r="1.6" /></>),
  ray: svg(<><path d="M5 17L20 7" /><circle cx="5" cy="17" r="1.6" /><path d="M16.5 7h3.5v3.5" /></>),
  rect: svg(<><rect x="4.5" y="6" width="15" height="12" rx="1.3" /><path d="M4.5 12h15" /></>),
  clear: svg(<><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></>),
};

export function ChartPanel() {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const indSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const drawingsRef = useRef<ChartDrawingRef[]>([]);
  const selectedDrawingRef = useRef<number | null>(null);
  const selectedDrawingSetRef = useRef<Set<number>>(new Set());
  const drawingDragRef = useRef<DrawingDrag | null>(null);
  const toolRef = useRef<Tool>("cursor");
  const magnetModeRef = useRef<MagnetMode>("strong");
  const drawDefaultsRef = useRef<Record<DrawingKind, DrawingStyle>>(defaultDrawDefaults());
  const trendPtRef = useRef<{ time: UTCTimestamp; value: number } | null>(null);
  const rayPtRef = useRef<{ time: UTCTimestamp; value: number } | null>(null);
  const rectPtRef = useRef<{ time: UTCTimestamp; value: number } | null>(null);
  const trendDragActiveRef = useRef(false);
  const rayDragActiveRef = useRef(false);
  const rectDragActiveRef = useRef(false);
  const drawDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const drawDragMovedRef = useRef(false);
  const suppressNextTrendClickRef = useRef(false);
  const suppressNextRayClickRef = useRef(false);
  const suppressNextRectClickRef = useRef(false);
  const previewTrendRef = useRef<ISeriesApi<"Line"> | null>(null);
  const previewRayRef = useRef<ISeriesApi<"Line"> | null>(null);
  const previewRectRef = useRef<ISeriesApi<"Line"> | null>(null);
  const previewHLineRef = useRef<IPriceLine | null>(null);
  const indsRef = useRef<AddedInd[]>([]);
  const recomputeRef = useRef<() => void>(() => {});
  const workspaceRef = useRef<string>("");
  const magnetHudRef = useRef<HTMLDivElement>(null);
  const undoStackRef = useRef<DrawingHistoryEntry[]>([]);
  const redoStackRef = useRef<DrawingHistoryEntry[]>([]);
  const pushUndoSnapshotRef = useRef<() => void>(() => {});
  const undoDrawingsRef = useRef<() => boolean>(() => false);
  const redoDrawingsRef = useRef<() => boolean>(() => false);
  const cancelDraftRef = useRef<() => boolean>(() => false);

  const [tool, setTool] = useState<Tool>("cursor");
  const [magnetMode, setMagnetMode] = useState<MagnetMode>("strong");
  const [drawDefaults, setDrawDefaults] = useState<Record<DrawingKind, DrawingStyle>>(defaultDrawDefaults());
  const [styleTool, setStyleTool] = useState<DrawingKind>("trend");
  const [inds, setInds] = useState<AddedInd[]>([]);
  const [addType, setAddType] = useState<IndType>("sma");
  const [addPeriod, setAddPeriod] = useState(20);
  const [, setSelectionNonce] = useState(0);

  const clearDraftDrawing = () => {
    if (previewHLineRef.current) {
      candleRef.current?.removePriceLine(previewHLineRef.current);
      previewHLineRef.current = null;
    }
    if (previewTrendRef.current) {
      chartRef.current?.removeSeries(previewTrendRef.current);
      previewTrendRef.current = null;
    }
    if (previewRayRef.current) {
      chartRef.current?.removeSeries(previewRayRef.current);
      previewRayRef.current = null;
    }
    if (previewRectRef.current) {
      chartRef.current?.removeSeries(previewRectRef.current);
      previewRectRef.current = null;
    }
  };

  useEffect(() => {
    toolRef.current = tool;
    const chart = chartRef.current;
    if (chart) {
      const drawMode = tool !== "cursor";
      chart.applyOptions({
        handleScroll: !drawMode,
        handleScale: !drawMode,
      });
    }
    if (tool === "cursor") {
      trendPtRef.current = null;
      rayPtRef.current = null;
      rectPtRef.current = null;
      trendDragActiveRef.current = false;
      rayDragActiveRef.current = false;
      rectDragActiveRef.current = false;
      drawDragStartRef.current = null;
      drawDragMovedRef.current = false;
      clearDraftDrawing();
    }
  }, [tool]);
  useEffect(() => {
    magnetModeRef.current = magnetMode;
    if (workspaceRef.current) updateWorkspaceUi(workspaceRef.current, { magnetMode });
  }, [magnetMode]);
  useEffect(() => {
    drawDefaultsRef.current = drawDefaults;
    for (let i = 0; i < drawingsRef.current.length; i++) {
      const d = drawingsRef.current[i];
      const defaults = drawDefaults[d.snapshot.kind];
      const style = sanitizeDrawingStyle(d.snapshot.style, defaults);
      d.snapshot = { ...d.snapshot, style } as DrawingSnapshot;
      const selected = selectedDrawingSetRef.current.has(i);
      if (d.snapshot.kind === "hline") {
        (d.ref as IPriceLine).applyOptions({
          color: withOpacity(style.color, selected ? Math.min(1, style.opacity + 0.08) : style.opacity),
          lineWidth: asLineWidth(style.width + (selected ? 1 : 0)),
          lineStyle: toChartLineStyle(style.lineStyle),
          axisLabelVisible: true,
          title: d.snapshot.price.toFixed(2),
        });
      } else {
        (d.ref as ISeriesApi<"Line">).applyOptions({
          color: withOpacity(style.color, selected ? Math.min(1, style.opacity + 0.08) : style.opacity),
          lineWidth: asLineWidth(style.width + (selected ? 1 : 0)),
          lineStyle: toChartLineStyle(style.lineStyle),
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }
    }
    if (workspaceRef.current) updateWorkspaceUi(workspaceRef.current, { drawDefaults });
  }, [drawDefaults]);
  useEffect(() => {
    indsRef.current = inds;
    recomputeRef.current();
    if (workspaceRef.current) updateWorkspaceUi(workspaceRef.current, { inds });
  }, [inds]);
  useEffect(() => {
    if (workspaceRef.current) updateWorkspaceUi(workspaceRef.current, { tool });
  }, [tool]);
  useEffect(() => {
    if (workspaceRef.current) updateWorkspaceUi(workspaceRef.current, { addType });
  }, [addType]);
  useEffect(() => {
    if (workspaceRef.current) updateWorkspaceUi(workspaceRef.current, { addPeriod });
  }, [addPeriod]);

  useEffect(() => {
    const el = containerRef.current!;
    const chart = createChart(el, {
      layout: {
        background: { color: "#15171b" },
        textColor: "#99a1ad",
        fontFamily: 'ui-monospace, "Cascadia Code", Menlo, Consolas, monospace',
        fontSize: 11,
      },
      grid: { vertLines: { color: "#1c2026" }, horzLines: { color: "#1c2026" } },
      crosshair: { vertLine: { color: "#373d47", labelBackgroundColor: "#262a31" }, horzLine: { color: "#373d47", labelBackgroundColor: "#262a31" } },
      timeScale: { borderColor: "#252a32" },
      rightPriceScale: { borderColor: "#252a32" },
      autoSize: true,
    });
    chartRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a", downColor: "#ef5350",
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
      borderVisible: false,
    });
    candleRef.current = candle;
    const equity = chart.addSeries(LineSeries, { color: "#8893a6", lineWidth: 1, priceScaleId: "equity", title: "equity" }, 1);
    const markers = createSeriesMarkers(candle, []);
    const rrBox = new RiskRewardPrimitive(chart, candle);
    candle.attachPrimitive(rrBox);

    const recompute = () => {
      for (const s of indSeriesRef.current) chart.removeSeries(s);
      indSeriesRef.current = [];
      const st = getState();
      const candles = st.candles;
      if (candles.length === 0) return;
      // Draw the active strategy's own indicators (from the store) plus any the
      // user added by hand on the toolbar. Strategy indicators come first.
      const stratInds = (st.spec?.indicators ?? []).map((i) => ({
        spec: i as Parameters<typeof computeIndicator>[0],
        type: String((i as { type: string }).type),
        id: String((i as { id: string }).id),
      }));
      const manual = indsRef.current.map((ind) => ({
        spec: buildSpec(ind) as Parameters<typeof computeIndicator>[0],
        type: ind.type as string,
        id: ind.type as string,
      }));
      let pane = 2;
      let colorIdx = 0;
      for (const item of [...stratInds, ...manual]) {
        const overlay = OVERLAY.has(item.type as IndType);
        const paneIndex = overlay ? 0 : pane++;
        let out: Record<string, number[]>;
        try {
          out = computeIndicator(item.spec, candles) as Record<string, number[]>;
        } catch {
          continue; // a malformed indicator shouldn't blank the whole chart
        }
        for (const [line, vals] of Object.entries(out)) {
          const series = chart.addSeries(
            LineSeries,
            {
              color: PALETTE[colorIdx++ % PALETTE.length],
              lineWidth: overlay ? 2 : 1,
              priceLineVisible: false,
              lastValueVisible: overlay,
              title: item.id + (line !== item.type ? "." + line : ""),
            },
            paneIndex
          );
          series.setData(
            vals
              .map((v, i) => ({ time: candles[i].time as UTCTimestamp, value: v }))
              .filter((p) => !Number.isNaN(p.value))
          );
          indSeriesRef.current.push(series);
        }
      }
    };
    recomputeRef.current = recompute;

    const normalizeRaySnapshot = <T extends DrawingSnapshot>(snapshot: T): T => {
      if (snapshot.kind !== "ray") return snapshot;
      const candles = getState().candles;
      const to = clampRayToRight(snapshot.from, snapshot.to, deriveRayTimeStep(candles));
      if (to.time === snapshot.to.time && to.value === snapshot.to.value) return snapshot;
      return { ...snapshot, to } as T;
    };

    const buildRayData = (
      from: { time: number; value: number },
      to: { time: number; value: number }
    ): { time: UTCTimestamp; value: number }[] =>
      // Shared pure ray geometry (chartDrawingUtils) over the live candles → branded
      // UTCTimestamp at the series boundary.
      buildRaySegment(from, to, getState().candles).map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));

    const buildRectData = (
      from: { time: number; value: number },
      to: { time: number; value: number }
    ): { time: UTCTimestamp; value: number }[] =>
      // Shared pure geometry (chartDrawingUtils) → cast time to the chart's branded
      // UTCTimestamp at the series boundary. Preview + commit both route through here.
      rectCornerLoop(from, to).map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));

    const buildTrendData = (
      from: { time: number; value: number },
      to: { time: number; value: number }
    ): { time: UTCTimestamp; value: number }[] =>
      // Shared time-ordering (chartDrawingUtils) → branded UTCTimestamp at the series
      // boundary. Preview + commit both route through here so endpoints stay in parity.
      orderSegmentByTime(from, to).map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));

    const findNearestCandleIndex = (time: number): number => {
      const candles = getState().candles;
      if (!candles.length) return -1;
      let lo = 0;
      let hi = candles.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (candles[mid].time < time) lo = mid + 1;
        else hi = mid;
      }
      const right = lo;
      const left = Math.max(0, right - 1);
      if (right >= candles.length) return candles.length - 1;
      return Math.abs(candles[right].time - time) < Math.abs(candles[left].time - time) ? right : left;
    };

    const snapPoint = (rawTime: number, rawPrice: number, pointerY?: number) => {
      const mode = magnetModeRef.current;
      if (mode === "off") return { time: rawTime as UTCTimestamp, price: rawPrice };
      const idx = findNearestCandleIndex(rawTime);
      if (idx < 0) return { time: rawTime as UTCTimestamp, price: rawPrice };
      const c = getState().candles[idx];
      const snappedTime = c.time as UTCTimestamp;
      if (pointerY == null) return { time: snappedTime, price: rawPrice };
      const levels = [c.open, c.high, c.low, c.close];
      let best = rawPrice;
      let bestPx = Number.POSITIVE_INFINITY;
      for (const lv of levels) {
        const y = candle.priceToCoordinate(lv);
        if (y == null) continue;
        const dy = Math.abs(pointerY - y);
        if (dy < bestPx) {
          bestPx = dy;
          best = lv;
        }
      }
      const thresholdPx = mode === "strong" ? SNAP_PRICE_PX_STRONG : SNAP_PRICE_PX_WEAK;
      return { time: snappedTime, price: bestPx <= thresholdPx ? best : rawPrice };
    };

    const isSmallSegment = (from: { time: number; value: number }, to: { time: number; value: number }) => {
      const a = toCoord(from.time, from.value);
      const b = toCoord(to.time, to.value);
      if (!a || !b) return Math.abs(from.time - to.time) < 1e-9 && Math.abs(from.value - to.value) < 1e-9;
      return Math.hypot(a.x - b.x, a.y - b.y) < DRAW_GEOMETRY_PX.minSegment;
    };

    const isSmallRect = (from: { time: number; value: number }, to: { time: number; value: number }) => {
      const a = toCoord(from.time, from.value);
      const b = toCoord(to.time, to.value);
      if (!a || !b) return Math.abs(from.time - to.time) < 1e-9 || Math.abs(from.value - to.value) < 1e-9;
      return Math.abs(a.x - b.x) < DRAW_GEOMETRY_PX.minRectSide || Math.abs(a.y - b.y) < DRAW_GEOMETRY_PX.minRectSide;
    };

    const cloneSnapshot = (d: DrawingSnapshot): DrawingSnapshot => JSON.parse(JSON.stringify(d)) as DrawingSnapshot;
    const resolveDrawingStyle = (snapshot: DrawingSnapshot): DrawingStyle => {
      const defaults = drawDefaultsRef.current[snapshot.kind];
      return sanitizeDrawingStyle(snapshot.style, defaults);
    };
    const withStyle = (snapshot: DrawingSnapshot): DrawingSnapshot => {
      const normalized = normalizeRaySnapshot(snapshot);
      const style = resolveDrawingStyle(normalized);
      return { ...normalized, style } as DrawingSnapshot;
    };
    const createDrawingRef = (snapshot: DrawingSnapshot): ChartDrawingRef => {
      const snap = withStyle(snapshot);
      if (snap.kind === "hline") {
        const pl = candle.createPriceLine({
          price: snap.price,
          color: withOpacity(snap.style?.color ?? DEFAULT_HLINE_STYLE.color, snap.style?.opacity ?? 1),
          lineWidth: asLineWidth(snap.style?.width ?? DEFAULT_HLINE_STYLE.width),
          lineStyle: toChartLineStyle(snap.style?.lineStyle ?? DEFAULT_HLINE_STYLE.lineStyle),
          axisLabelVisible: true,
          title: snap.price.toFixed(2),
        });
        return { kind: "pl", ref: pl, snapshot: snap };
      }
      const ls = chart.addSeries(LineSeries, {
        color: withOpacity(snap.style?.color ?? DEFAULT_DRAW_STYLE.color, snap.style?.opacity ?? 1),
        lineWidth: asLineWidth(snap.style?.width ?? DEFAULT_DRAW_STYLE.width),
        lineStyle: toChartLineStyle(snap.style?.lineStyle ?? DEFAULT_DRAW_STYLE.lineStyle),
        priceLineVisible: false,
        lastValueVisible: false,
      });
      if (snap.kind === "ray") ls.setData(buildRayData(snap.from, snap.to));
      else if (snap.kind === "rect") ls.setData(buildRectData(snap.from, snap.to));
      else ls.setData([{ time: snap.from.time as UTCTimestamp, value: snap.from.value }, { time: snap.to.time as UTCTimestamp, value: snap.to.value }]);
      return { kind: "ls", ref: ls, snapshot: snap };
    };

    const syncWorkspaceDrawings = () => {
      if (!workspaceRef.current) return;
      updateWorkspaceUi(workspaceRef.current, {
        drawings: drawingsRef.current.map((d) => d.snapshot),
      });
    };

    const snapshotHistoryState = (): DrawingHistoryEntry => ({
      drawings: drawingsRef.current.map((d) => cloneSnapshot(d.snapshot)),
      selectedIndices: Array.from(selectedDrawingSetRef.current).sort((a, b) => a - b),
    });

    const restoreHistoryState = (entry: DrawingHistoryEntry) => {
      for (const d of drawingsRef.current) {
        if (d.kind === "pl") candleRef.current?.removePriceLine(d.ref as IPriceLine);
        else chartRef.current?.removeSeries(d.ref as ISeriesApi<"Line">);
      }
      drawingsRef.current = [];
      for (const dr of entry.drawings) drawingsRef.current.push(createDrawingRef(dr));
      drawingDragRef.current = null;
      const nextSelected = entry.selectedIndices
        .filter((idx) => idx >= 0 && idx < drawingsRef.current.length)
        .sort((a, b) => a - b);
      setSelectedDrawings(nextSelected.length ? nextSelected : null);
      syncWorkspaceDrawings();
    };

    const pushUndoSnapshot = () => {
      undoStackRef.current.push(snapshotHistoryState());
      if (undoStackRef.current.length > DRAW_HISTORY_MAX) undoStackRef.current.shift();
      redoStackRef.current = [];
    };

    const applyDrawingGeometry = (drawing: ChartDrawingRef) => {
      drawing.snapshot = withStyle(drawing.snapshot);
      if (drawing.snapshot.kind === "hline") {
        (drawing.ref as IPriceLine).applyOptions({
          price: drawing.snapshot.price,
          title: drawing.snapshot.price.toFixed(2),
        });
        return;
      }
      const ls = drawing.ref as ISeriesApi<"Line">;
      if (drawing.snapshot.kind === "trend") {
        ls.setData([
          { time: drawing.snapshot.from.time as UTCTimestamp, value: drawing.snapshot.from.value },
          { time: drawing.snapshot.to.time as UTCTimestamp, value: drawing.snapshot.to.value },
        ]);
      } else if (drawing.snapshot.kind === "ray") {
        ls.setData(buildRayData(drawing.snapshot.from, drawing.snapshot.to));
      } else if (drawing.snapshot.kind === "rect") {
        ls.setData(buildRectData(drawing.snapshot.from, drawing.snapshot.to));
      }
    };

    const refreshDrawingStyles = () => {
      for (let i = 0; i < drawingsRef.current.length; i++) {
        const d = drawingsRef.current[i];
        const selected = selectedDrawingSetRef.current.has(i);
        const style = resolveDrawingStyle(d.snapshot);
        d.snapshot = { ...d.snapshot, style } as DrawingSnapshot;
        if (d.snapshot.kind === "hline") {
          (d.ref as IPriceLine).applyOptions({
            color: withOpacity(style.color, selected ? Math.min(1, style.opacity + 0.08) : style.opacity),
            lineWidth: asLineWidth(style.width + (selected ? 1 : 0)),
            lineStyle: toChartLineStyle(style.lineStyle),
            axisLabelVisible: true,
            title: d.snapshot.price.toFixed(2),
          });
        } else {
          (d.ref as ISeriesApi<"Line">).applyOptions({
            color: withOpacity(style.color, selected ? Math.min(1, style.opacity + 0.08) : style.opacity),
            lineWidth: asLineWidth(style.width + (selected ? 1 : 0)),
            lineStyle: toChartLineStyle(style.lineStyle),
            priceLineVisible: false,
            lastValueVisible: false,
          });
        }
      }
    };

    const setSelectedDrawings = (indices: number[] | null) => {
      const next = new Set<number>();
      if (indices) {
        for (const idx of indices) {
          if (idx >= 0 && idx < drawingsRef.current.length) next.add(idx);
        }
      }
      selectedDrawingSetRef.current = next;
      selectedDrawingRef.current = next.size ? Math.max(...Array.from(next)) : null;
      refreshDrawingStyles();
      setSelectionNonce((v) => v + 1);
    };

    const updateDrawingAt = (index: number, snapshot: DrawingSnapshot, persist = true) => {
      const target = drawingsRef.current[index];
      if (!target) return;
      target.snapshot = normalizeRaySnapshot(snapshot);
      applyDrawingGeometry(target);
      refreshDrawingStyles();
      if (persist) syncWorkspaceDrawings();
    };

    const cancelActiveDraft = () => {
      const hadDraft = Boolean(
        trendPtRef.current ||
        rayPtRef.current ||
        rectPtRef.current ||
        trendDragActiveRef.current ||
        rayDragActiveRef.current ||
        rectDragActiveRef.current ||
        previewHLineRef.current ||
        previewTrendRef.current ||
        previewRayRef.current ||
        previewRectRef.current
      );
      trendPtRef.current = null;
      rayPtRef.current = null;
      rectPtRef.current = null;
      trendDragActiveRef.current = false;
      rayDragActiveRef.current = false;
      rectDragActiveRef.current = false;
      drawDragStartRef.current = null;
      drawDragMovedRef.current = false;
      suppressNextTrendClickRef.current = false;
      suppressNextRayClickRef.current = false;
      suppressNextRectClickRef.current = false;
      clearDraftDrawing();
      return hadDraft;
    };

    pushUndoSnapshotRef.current = pushUndoSnapshot;
    undoDrawingsRef.current = () => {
      const prev = undoStackRef.current.pop();
      if (!prev) return false;
      redoStackRef.current.push(snapshotHistoryState());
      if (redoStackRef.current.length > DRAW_HISTORY_MAX) redoStackRef.current.shift();
      restoreHistoryState(prev);
      return true;
    };
    redoDrawingsRef.current = () => {
      const next = redoStackRef.current.pop();
      if (!next) return false;
      undoStackRef.current.push(snapshotHistoryState());
      if (undoStackRef.current.length > DRAW_HISTORY_MAX) undoStackRef.current.shift();
      restoreHistoryState(next);
      return true;
    };
    cancelDraftRef.current = cancelActiveDraft;

    const toCoord = (time: number, value: number): { x: number; y: number } | null => {
      const x = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
      const y = candle.priceToCoordinate(value);
      if (x == null || y == null) return null;
      return { x, y };
    };

    const fromCoord = (x: number, y: number): { time: number; value: number } | null => {
      const time = chart.timeScale().coordinateToTime(x) as UTCTimestamp | null;
      const value = candle.coordinateToPrice(y);
      if (time == null || value == null) return null;
      return { time: time as number, value };
    };

    // Clamp a dragged rectangle corner to keep at least minRectSide px on each side
    // from the fixed anchor corner. Orchestration (null-coord guards, pixel clamp,
    // round-trip fallback) lives in the shared, unit-tested chartDrawingUtils helper;
    // this binds it to the live chart converters.
    const clampRectCornerPoint = (
      anchorPt: { time: number; value: number },
      movingPt: { time: number; value: number }
    ): { time: number; value: number } =>
      clampRectCornerWithCoords(anchorPt, movingPt, toCoord, fromCoord, DRAW_GEOMETRY_PX.minRectSide);

    const pointToSegDistance = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
      const vx = bx - ax;
      const vy = by - ay;
      const wx = px - ax;
      const wy = py - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 <= 1e-9) return Math.hypot(px - ax, py - ay);
      const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
      const cx = ax + t * vx;
      const cy = ay + t * vy;
      return Math.hypot(px - cx, py - cy);
    };

    const hitToleranceScale = (mouseX: number) => {
      const candles = getState().candles;
      if (candles.length < 2) return 1;
      const step = deriveRayTimeStep(candles);
      const nearTime = (chart.timeScale().coordinateToTime(mouseX) as number | null) ?? candles[candles.length - 1].time;
      const x0 = chart.timeScale().timeToCoordinate(nearTime as UTCTimestamp);
      const x1 = chart.timeScale().timeToCoordinate((nearTime + step) as UTCTimestamp);
      const spacing = measuredCandleSpacingPx(x0, x1);
      return deriveHitToleranceScale(spacing);
    };

    const hitTestDrawing = (ev: MouseEvent): { index: number; mode: DrawingHitMode } | null => {
      const rect = el.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const hitScale = hitToleranceScale(px);
      const endpointHitPx = DRAW_HIT_PX.endpoint * hitScale;
      const bodyHitPx = DRAW_HIT_PX.body * hitScale;
      const rayBodyHitPx = DRAW_HIT_PX.rayBody * hitScale;
      const hlineHitPx = DRAW_HIT_PX.hline * hitScale;
      const candles = getState().candles;
      const rayStep = deriveRayTimeStep(candles);
      for (let i = drawingsRef.current.length - 1; i >= 0; i--) {
        const snap = drawingsRef.current[i].snapshot;
        if (snap.kind === "hline") {
          const y = candle.priceToCoordinate(snap.price);
          if (y != null && Math.abs(py - y) <= hlineHitPx) return { index: i, mode: "price" };
          continue;
        }
        const rayTo = snap.kind === "ray" ? clampRayToRight(snap.from, snap.to, rayStep) : snap.to;
        const a = toCoord(snap.from.time, snap.from.value);
        const b = toCoord(rayTo.time, rayTo.value);
        if (!a || !b) continue;
        const da = Math.hypot(px - a.x, py - a.y);
        if (da <= endpointHitPx) return { index: i, mode: "from" };
        const db = Math.hypot(px - b.x, py - b.y);
        if (db <= endpointHitPx) return { index: i, mode: "to" };
        if (snap.kind === "rect") {
          const left = Math.min(a.x, b.x);
          const right = Math.max(a.x, b.x);
          const top = Math.min(a.y, b.y);
          const bottom = Math.max(a.y, b.y);
          if (px >= left && px <= right && py >= top && py <= bottom) return { index: i, mode: "move" };
        } else {
          if (snap.kind === "ray") {
            const rayData = buildRayData(snap.from, snap.to);
            const rayEnd = rayData[rayData.length - 1];
            const endCoord = toCoord(rayEnd.time as number, rayEnd.value);
            if (endCoord) {
              const d = pointToSegDistance(px, py, a.x, a.y, endCoord.x, endCoord.y);
              if (d <= rayBodyHitPx) return { index: i, mode: "move" };
              continue;
            }
          }
          const d = pointToSegDistance(px, py, a.x, a.y, b.x, b.y);
          if (d <= bodyHitPx) return { index: i, mode: "move" };
        }
      }
      return null;
    };

    const render = (s: AppState, workspaceId: string) => {
      if (workspaceRef.current !== workspaceId) {
        workspaceRef.current = workspaceId;
        const ui = getWorkspaceUi(workspaceId);
        setTool(ui.tool);
        setMagnetMode(ui.magnetMode);
        setDrawDefaults(ui.drawDefaults);
        setAddType(ui.addType);
        setAddPeriod(ui.addPeriod);
        indsRef.current = ui.inds;
        setInds(ui.inds);
        for (const d of drawingsRef.current) {
          if (d.kind === "pl") candleRef.current?.removePriceLine(d.ref as IPriceLine);
          else chartRef.current?.removeSeries(d.ref as ISeriesApi<"Line">);
        }
        drawingsRef.current = [];
        selectedDrawingRef.current = null;
        selectedDrawingSetRef.current = new Set();
        setSelectionNonce((v) => v + 1);
        drawingDragRef.current = null;
        trendPtRef.current = null;
        rayPtRef.current = null;
        rectPtRef.current = null;
        trendDragActiveRef.current = false;
        rayDragActiveRef.current = false;
        rectDragActiveRef.current = false;
        drawDragStartRef.current = null;
        drawDragMovedRef.current = false;
        undoStackRef.current = [];
        redoStackRef.current = [];
        clearDraftDrawing();
        for (const dr of ui.drawings) drawingsRef.current.push(createDrawingRef(dr));
        refreshDrawingStyles();
      }
      candle.setData(
        s.candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
      );
      recompute();
      if (s.result) {
        markers.setMarkers(
          s.result.trades
            .flatMap((t) => [
              { time: t.entryTime as UTCTimestamp, position: "belowBar" as const, color: "#26a69a", shape: "arrowUp" as const, text: `long ${t.entryPrice.toFixed(2)}` },
              { time: t.exitTime as UTCTimestamp, position: "aboveBar" as const, color: t.pnl >= 0 ? "#26a69a" : "#ef5350", shape: "arrowDown" as const, text: `${t.exitReason} ${t.pnlPct.toFixed(1)}%` },
            ])
            .sort((a, b) => (a.time as number) - (b.time as number))
        );
        equity.setData(s.result.timeline.map((p) => ({ time: p.time as UTCTimestamp, value: p.equity })));
      } else {
        markers.setMarkers([]);
        equity.setData([]);
      }
      // Risk/reward box on the most recent trade, from the strategy's stop/target.
      const trades = s.result?.trades ?? [];
      const lastT = trades.length ? trades[trades.length - 1] : null;
      const risk = s.spec?.risk;
      if (lastT && risk && (risk.stopLossPct != null || risk.takeProfitPct != null)) {
        const dt = s.candles.length > 1 ? s.candles[1].time - s.candles[0].time : 3600;
        const entry = lastT.entryPrice;
        rrBox.setData({
          entry,
          stop: risk.stopLossPct != null ? entry * (1 - risk.stopLossPct / 100) : null,
          target: risk.takeProfitPct != null ? entry * (1 + risk.takeProfitPct / 100) : null,
          from: lastT.entryTime as UTCTimestamp,
          to: (lastT.exitTime > lastT.entryTime ? lastT.exitTime : lastT.entryTime + 6 * dt) as UTCTimestamp,
        });
      } else {
        rrBox.setData(null);
      }
      chart.timeScale().fitContent();
    };

    render(getState(), getActiveWorkspaceId());
    const unsub = subscribe(render);

    const startTrendDraft = (time: UTCTimestamp, value: number) => {
      trendPtRef.current = { time, value };
      if (!previewTrendRef.current) {
        previewTrendRef.current = chart.addSeries(LineSeries, {
          color: "#e0a35e99",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }
      previewTrendRef.current.setData([{ time, value }, { time, value }]);
    };

    const commitTrend = (time: UTCTimestamp, value: number) => {
      if (!trendPtRef.current) return;
      const rawPts = [trendPtRef.current, { time, value }];
      if (isSmallSegment(rawPts[0], rawPts[1])) {
        trendPtRef.current = null;
        trendDragActiveRef.current = false;
        clearDraftDrawing();
        return;
      }
      const pts = buildTrendData(rawPts[0], rawPts[1]);
      pushUndoSnapshot();
      const ls = chart.addSeries(LineSeries, { color: "#e0a35e", lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
      ls.setData(pts);
      const snapshot: DrawingSnapshot = {
        kind: "trend",
        from: { time: pts[0].time, value: pts[0].value },
        to: { time: pts[1].time, value: pts[1].value },
        style: sanitizeDrawingStyle(undefined, drawDefaultsRef.current.trend),
      };
      drawingsRef.current.push({ kind: "ls", ref: ls, snapshot });
      setSelectedDrawings([drawingsRef.current.length - 1]);
      syncWorkspaceDrawings();
      trendPtRef.current = null;
      trendDragActiveRef.current = false;
      clearDraftDrawing();
    };

    const startRayDraft = (time: UTCTimestamp, value: number) => {
      rayPtRef.current = { time, value };
      if (!previewRayRef.current) {
        previewRayRef.current = chart.addSeries(LineSeries, {
          color: "#e0a35e99",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }
      previewRayRef.current.setData([{ time, value }, { time, value }]);
    };

    const commitRay = (time: UTCTimestamp, value: number) => {
      if (!rayPtRef.current) return;
      const anchor = rayPtRef.current;
      if (isSmallSegment(anchor, { time, value })) {
        rayPtRef.current = null;
        rayDragActiveRef.current = false;
        clearDraftDrawing();
        return;
      }
      pushUndoSnapshot();
      const ls = chart.addSeries(LineSeries, {
        color: "#e0a35e",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const candles = getState().candles;
      const to = clampRayToRight(anchor, { time, value }, deriveRayTimeStep(candles));
      ls.setData(buildRayData(anchor, to));
      const snapshot: DrawingSnapshot = {
        kind: "ray",
        from: { time: anchor.time, value: anchor.value },
        to,
        style: sanitizeDrawingStyle(undefined, drawDefaultsRef.current.ray),
      };
      drawingsRef.current.push({ kind: "ls", ref: ls, snapshot });
      setSelectedDrawings([drawingsRef.current.length - 1]);
      syncWorkspaceDrawings();
      rayPtRef.current = null;
      rayDragActiveRef.current = false;
      clearDraftDrawing();
    };

    const startRectDraft = (time: UTCTimestamp, value: number) => {
      rectPtRef.current = { time, value };
      if (!previewRectRef.current) {
        previewRectRef.current = chart.addSeries(LineSeries, {
          color: "#e0a35e99",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }
      previewRectRef.current.setData(buildRectData({ time, value }, { time, value }));
    };

    const commitRect = (time: UTCTimestamp, value: number) => {
      if (!rectPtRef.current) return;
      const anchor = rectPtRef.current;
      if (isSmallRect(anchor, { time, value })) {
        rectPtRef.current = null;
        rectDragActiveRef.current = false;
        clearDraftDrawing();
        return;
      }
      pushUndoSnapshot();
      const ls = chart.addSeries(LineSeries, {
        color: "#e0a35e",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      ls.setData(buildRectData(anchor, { time, value }));
      const snapshot: DrawingSnapshot = {
        kind: "rect",
        from: { time: anchor.time, value: anchor.value },
        to: { time, value },
        style: sanitizeDrawingStyle(undefined, drawDefaultsRef.current.rect),
      };
      drawingsRef.current.push({ kind: "ls", ref: ls, snapshot });
      setSelectedDrawings([drawingsRef.current.length - 1]);
      syncWorkspaceDrawings();
      rectPtRef.current = null;
      rectDragActiveRef.current = false;
      clearDraftDrawing();
    };

    const pointFromMouse = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
      const price = candle.coordinateToPrice(y);
      const time = chart.timeScale().coordinateToTime(x) as UTCTimestamp | null;
      if (price == null || time == null) return null;
      const snapped = snapPoint(time, price, y);
      return { time: snapped.time, price: snapped.price };
    };

    // Drawing: clicks place horizontal / trend lines based on the active tool.
    const onClick = (param: any) => {
      // Only the horizontal-line tool places on click. Trend/ray/rect are driven
      // entirely by the DOM mousedown/mouseup flow below for deterministic placement
      // (the chart's click event is unreliable while drawing, which left drafts stuck
      // to the cursor). Keeping hline here is safe — it has no mousedown draft.
      if (toolRef.current !== "hline" || !param.point) return;
      const rawPrice = candle.coordinateToPrice(param.point.y);
      const rawTime = (param.time as UTCTimestamp) ?? (chart.timeScale().coordinateToTime(param.point.x) as UTCTimestamp);
      if (rawPrice == null || rawTime == null) return;
      const { price } = snapPoint(rawTime, rawPrice, param.point.y);
      pushUndoSnapshot();
      clearDraftDrawing();
      const pl = candle.createPriceLine({ price, color: "#e0a35e", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: price.toFixed(2) });
      const snapshot: DrawingSnapshot = { kind: "hline", price, style: sanitizeDrawingStyle(undefined, drawDefaultsRef.current.hline) };
      drawingsRef.current.push({ kind: "pl", ref: pl, snapshot });
      setSelectedDrawings([drawingsRef.current.length - 1]);
      syncWorkspaceDrawings();
    };

    const onCrosshairMove = (param: any) => {
      const t = toolRef.current;
      const hud = magnetHudRef.current;
      if (hud) {
        if (param.point && t !== "cursor") {
          const label = magnetModeRef.current === "off" ? "OFF" : magnetModeRef.current === "weak" ? "WEAK" : "STRONG";
          hud.style.display = "block";
          hud.style.left = `${param.point.x + 14}px`;
          hud.style.top = `${param.point.y + 14}px`;
          hud.textContent = `🧲 ${label}`;
        } else {
          hud.style.display = "none";
        }
      }
      if (t === "cursor" || !param.point) {
        if ((t !== "trend" || !trendPtRef.current) && (t !== "ray" || !rayPtRef.current) && (t !== "rect" || !rectPtRef.current)) clearDraftDrawing();
        return;
      }
      const rawPrice = candle.coordinateToPrice(param.point.y);
      const rawTime = (param.time as UTCTimestamp) ?? (chart.timeScale().coordinateToTime(param.point.x) as UTCTimestamp);
      if (rawPrice == null || rawTime == null) return;
      const snapped = snapPoint(rawTime, rawPrice, param.point.y);
      const price = snapped.price;
      const time = snapped.time;

      if (t === "hline") {
        if (!previewHLineRef.current) {
          previewHLineRef.current = candle.createPriceLine({
            price,
            color: "#e0a35e99",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `preview ${price.toFixed(2)}`,
          });
        } else {
          previewHLineRef.current.applyOptions({
            price,
            title: `preview ${price.toFixed(2)}`,
          });
        }
        if (previewTrendRef.current) {
          chart.removeSeries(previewTrendRef.current);
          previewTrendRef.current = null;
        }
        if (previewRayRef.current) {
          chart.removeSeries(previewRayRef.current);
          previewRayRef.current = null;
        }
        if (previewRectRef.current) {
          chart.removeSeries(previewRectRef.current);
          previewRectRef.current = null;
        }
        return;
      }

      if (t === "trend") {
        if (previewHLineRef.current) {
          candle.removePriceLine(previewHLineRef.current);
          previewHLineRef.current = null;
        }
        if (previewRayRef.current) {
          chart.removeSeries(previewRayRef.current);
          previewRayRef.current = null;
        }
        if (previewRectRef.current) {
          chart.removeSeries(previewRectRef.current);
          previewRectRef.current = null;
        }
        if (!trendPtRef.current) return;
        if (!previewTrendRef.current) {
          previewTrendRef.current = chart.addSeries(LineSeries, {
            color: "#e0a35e99",
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: false,
          });
        }
        const pts = buildTrendData(trendPtRef.current, { time, value: price });
        previewTrendRef.current.setData(pts);
        return;
      }

      if (t === "ray") {
        if (previewHLineRef.current) {
          candle.removePriceLine(previewHLineRef.current);
          previewHLineRef.current = null;
        }
        if (previewTrendRef.current) {
          chart.removeSeries(previewTrendRef.current);
          previewTrendRef.current = null;
        }
        if (previewRectRef.current) {
          chart.removeSeries(previewRectRef.current);
          previewRectRef.current = null;
        }
        if (!rayPtRef.current) return;
        if (!previewRayRef.current) {
          previewRayRef.current = chart.addSeries(LineSeries, {
            color: "#e0a35e99",
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: false,
          });
        }
        const candles = getState().candles;
        const rayTo = clampRayToRight(rayPtRef.current, { time, value: price }, deriveRayTimeStep(candles));
        previewRayRef.current.setData(buildRayData(rayPtRef.current, rayTo));
        return;
      }

      if (t === "rect") {
        if (previewHLineRef.current) {
          candle.removePriceLine(previewHLineRef.current);
          previewHLineRef.current = null;
        }
        if (previewTrendRef.current) {
          chart.removeSeries(previewTrendRef.current);
          previewTrendRef.current = null;
        }
        if (previewRayRef.current) {
          chart.removeSeries(previewRayRef.current);
          previewRayRef.current = null;
        }
        if (!rectPtRef.current) return;
        if (!previewRectRef.current) {
          previewRectRef.current = chart.addSeries(LineSeries, {
            color: "#e0a35e99",
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: false,
          });
        }
        previewRectRef.current.setData(buildRectData(rectPtRef.current, { time, value: price }));
      }
    };

    const onMouseMove = (ev: MouseEvent) => {
      if (toolRef.current !== "cursor") {
        const start = drawDragStartRef.current;
        if (start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) >= 3) drawDragMovedRef.current = true;
        return;
      }
      const drag = drawingDragRef.current;
      if (!drag) return;
      const p = pointFromMouse(ev);
      if (!p) return;
      const dt = (p.time as number) - (drag.start.time as number);
      const dv = p.price - drag.start.value;
      const src = drag.origin;
      if (drag.group && drag.mode === "move") {
        for (const entry of drag.group) {
          updateDrawingAt(entry.index, translateDrawing(entry.origin, dt, dv), false);
        }
        return;
      }
      if (drag.mode === "price" && src.kind === "hline") {
        updateDrawingAt(drag.index, { kind: "hline", price: p.price, style: src.style }, false);
        return;
      }
      if (src.kind === "hline") return;
      if (drag.mode === "move") {
        updateDrawingAt(drag.index, translateDrawing(src, dt, dv), false);
      } else if (drag.mode === "from" || drag.mode === "to") {
        // Endpoint drag: one corner moves, the opposite corner stays anchored. For
        // rects the moving corner is clamped in pixel space against the anchor to
        // preserve the minimum side; segments take the raw (snapped) pointer.
        const movingIsFrom = drag.mode === "from";
        const anchorPt = movingIsFrom ? src.to : src.from;
        const movedPt = src.kind === "rect"
          ? clampRectCornerPoint(anchorPt, { time: p.time, value: p.price })
          : { time: p.time, value: p.price };
        const next = movingIsFrom
          ? { kind: src.kind, from: movedPt, to: src.to, style: src.style }
          : { kind: src.kind, from: src.from, to: movedPt, style: src.style };
        if ((src.kind === "trend" || src.kind === "ray") && isSmallSegment(next.from, next.to)) return;
        if (src.kind === "rect" && isSmallRect(next.from, next.to)) return;
        updateDrawingAt(drag.index, next, false);
      }
    };

    const onMouseDown = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      const p = pointFromMouse(ev);
      if (!p) return;
      if (toolRef.current === "cursor") {
        const hit = hitTestDrawing(ev);
        const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
        if (!hit) {
          if (!additive) setSelectedDrawings(null);
          drawingDragRef.current = null;
          return;
        }

        const existing = Array.from(selectedDrawingSetRef.current).sort((a, b) => a - b);
        const alreadySelected = selectedDrawingSetRef.current.has(hit.index);
        if (additive) {
          if (alreadySelected) {
            setSelectedDrawings(existing.filter((idx) => idx !== hit.index));
          } else {
            setSelectedDrawings([...existing, hit.index]);
          }
          drawingDragRef.current = null;
          ev.preventDefault();
          return;
        }

        const nextSelection = alreadySelected && existing.length > 1 ? existing : [hit.index];
        setSelectedDrawings(nextSelection);
        const redoBeforeDrag = redoStackRef.current.slice();
        pushUndoSnapshot();
        drawingDragRef.current = {
          index: hit.index,
          mode: hit.mode,
          start: { time: p.time, value: p.price },
          origin: cloneSnapshot(drawingsRef.current[hit.index].snapshot),
          redoBefore: redoBeforeDrag,
          group:
            hit.mode === "move" && nextSelection.length > 1
              ? nextSelection.map((idx) => ({ index: idx, origin: cloneSnapshot(drawingsRef.current[idx].snapshot) }))
              : undefined,
        };
        ev.preventDefault();
        return;
      }
      // Trend/ray/rect: the first press creates the anchor; every press records a
      // drag-start so both a click-drag and a second click commit on mouseup. The
      // *DragActive flag marks "this press created the anchor" (used to distinguish a
      // stationary first click — which keeps the anchor — from a committing release).
      if (toolRef.current === "trend") {
        if (!trendPtRef.current) {
          startTrendDraft(p.time, p.price);
          trendDragActiveRef.current = true;
        }
        drawDragStartRef.current = { x: ev.clientX, y: ev.clientY };
        drawDragMovedRef.current = false;
        ev.preventDefault();
      } else if (toolRef.current === "ray") {
        if (!rayPtRef.current) {
          startRayDraft(p.time, p.price);
          rayDragActiveRef.current = true;
        }
        drawDragStartRef.current = { x: ev.clientX, y: ev.clientY };
        drawDragMovedRef.current = false;
        ev.preventDefault();
      } else if (toolRef.current === "rect") {
        if (!rectPtRef.current) {
          startRectDraft(p.time, p.price);
          rectDragActiveRef.current = true;
        }
        drawDragStartRef.current = { x: ev.clientX, y: ev.clientY };
        drawDragMovedRef.current = false;
        ev.preventDefault();
      }
    };

    const onMouseUp = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      const p = pointFromMouse(ev);
      if (toolRef.current === "cursor" && drawingDragRef.current) {
        const drag = drawingDragRef.current;
        const changed = hasDrawingDragChanges(drawingsRef.current, drag);
        if (!changed) {
          redoStackRef.current = rollbackNoopDrawingDrag(undoStackRef.current, redoStackRef.current, drag.redoBefore);
        } else {
          syncWorkspaceDrawings();
        }
        drawingDragRef.current = null;
        ev.preventDefault();
      } else if (toolRef.current === "trend" && trendPtRef.current) {
        const moved = drawDragMovedRef.current;
        const startedThisPress = trendDragActiveRef.current;
        drawDragStartRef.current = null;
        drawDragMovedRef.current = false;
        trendDragActiveRef.current = false;
        if (startedThisPress && !moved) {
          // Stationary first click: keep the anchor; the next click commits.
        } else if (p) {
          commitTrend(p.time, p.price); // click-drag release, or the second click
        } else {
          trendPtRef.current = null;
          clearDraftDrawing();
        }
        ev.preventDefault();
      } else if (toolRef.current === "ray" && rayPtRef.current) {
        const moved = drawDragMovedRef.current;
        const startedThisPress = rayDragActiveRef.current;
        drawDragStartRef.current = null;
        drawDragMovedRef.current = false;
        rayDragActiveRef.current = false;
        if (startedThisPress && !moved) {
          // Stationary first click: keep the anchor; the next click commits.
        } else if (p) {
          commitRay(p.time, p.price);
        } else {
          rayPtRef.current = null;
          clearDraftDrawing();
        }
        ev.preventDefault();
      } else if (toolRef.current === "rect" && rectPtRef.current) {
        const moved = drawDragMovedRef.current;
        const startedThisPress = rectDragActiveRef.current;
        drawDragStartRef.current = null;
        drawDragMovedRef.current = false;
        rectDragActiveRef.current = false;
        if (startedThisPress && !moved) {
          // Stationary first click: keep the anchor; the next click commits.
        } else if (p) {
          commitRect(p.time, p.price);
        } else {
          rectPtRef.current = null;
          clearDraftDrawing();
        }
        ev.preventDefault();
      }
    };

    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    chart.subscribeClick(onClick);
    chart.subscribeCrosshairMove(onCrosshairMove);

    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      drawingDragRef.current = null;
      drawDragStartRef.current = null;
      drawDragMovedRef.current = false;
      pushUndoSnapshotRef.current = () => {};
      undoDrawingsRef.current = () => false;
      redoDrawingsRef.current = () => false;
      cancelDraftRef.current = () => false;
      if (magnetHudRef.current) magnetHudRef.current.style.display = "none";
      unsub();
      clearDraftDrawing();
      chart.unsubscribeClick(onClick);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
    };
  }, []);

  const addInd = () => setInds((xs) => [...xs, { id: `${addType}-${Date.now()}`, type: addType, period: addPeriod }]);
  const removeInd = (id: string) => setInds((xs) => xs.filter((i) => i.id !== id));
  const deleteSelectedDrawing = () => {
    const selected = Array.from(selectedDrawingSetRef.current).sort((a, b) => b - a);
    if (!selected.length) {
      const idx = selectedDrawingRef.current;
      if (idx == null) return false;
      selected.push(idx);
    }
    const valid = selected.filter((idx) => idx >= 0 && idx < drawingsRef.current.length);
    if (!valid.length) return false;
    pushUndoSnapshotRef.current();
    for (const idx of valid) {
      const d = drawingsRef.current[idx];
      if (!d) continue;
      if (d.kind === "pl") candleRef.current?.removePriceLine(d.ref as IPriceLine);
      else chartRef.current?.removeSeries(d.ref as ISeriesApi<"Line">);
      drawingsRef.current.splice(idx, 1);
    }
    selectedDrawingRef.current = null;
    selectedDrawingSetRef.current = new Set();
    setSelectionNonce((v) => v + 1);
    drawingDragRef.current = null;
    if (workspaceRef.current) {
      updateWorkspaceUi(workspaceRef.current, { drawings: drawingsRef.current.map((x) => x.snapshot) });
    }
    return true;
  };

  const clearDrawings = () => {
    if (drawingsRef.current.length) pushUndoSnapshotRef.current();
    for (const d of drawingsRef.current) {
      if (d.kind === "pl") candleRef.current?.removePriceLine(d.ref as IPriceLine);
      else chartRef.current?.removeSeries(d.ref as ISeriesApi<"Line">);
    }
    drawingsRef.current = [];
    selectedDrawingRef.current = null;
    selectedDrawingSetRef.current = new Set();
    setSelectionNonce((v) => v + 1);
    drawingDragRef.current = null;
    trendPtRef.current = null;
    rayPtRef.current = null;
    rectPtRef.current = null;
    trendDragActiveRef.current = false;
    rayDragActiveRef.current = false;
    rectDragActiveRef.current = false;
    drawDragStartRef.current = null;
    drawDragMovedRef.current = false;
    clearDraftDrawing();
    if (workspaceRef.current) updateWorkspaceUi(workspaceRef.current, { drawings: [] });
  };

  const updateDefaultDrawingStyle = (kind: DrawingKind, patch: Partial<DrawingStyle>) => {
    setDrawDefaults((prev) => ({
      ...prev,
      [kind]: mergeDrawingStyle(prev[kind], patch),
    }));
  };
  const applyStyleToSelected = (patch: Partial<DrawingStyle>) => {
    const selected = Array.from(selectedDrawingSetRef.current).sort((a, b) => a - b);
    const fallback = selectedDrawingRef.current != null ? [selectedDrawingRef.current] : [];
    const targets = (selected.length ? selected : fallback).filter((idx) => idx >= 0 && idx < drawingsRef.current.length);
    if (!targets.length) return;

    const updates = targets.map((idx) => {
      const target = drawingsRef.current[idx];
      const base = sanitizeDrawingStyle(target.snapshot.style, drawDefaultsRef.current[target.snapshot.kind]);
      const nextStyle = mergeDrawingStyle(base, patch);
      return { idx, nextStyle, changed: JSON.stringify(base) !== JSON.stringify(nextStyle) };
    });
    if (!updates.some((u) => u.changed)) return;

    pushUndoSnapshotRef.current();
    for (const { idx, nextStyle } of updates) {
      const target = drawingsRef.current[idx];
      target.snapshot = { ...target.snapshot, style: nextStyle } as DrawingSnapshot;
      const selected = selectedDrawingSetRef.current.has(idx);
      if (target.snapshot.kind === "hline") {
        (target.ref as IPriceLine).applyOptions({
          color: withOpacity(nextStyle.color, selected ? Math.min(1, nextStyle.opacity + 0.08) : nextStyle.opacity),
          lineWidth: asLineWidth(nextStyle.width + (selected ? 1 : 0)),
          lineStyle: toChartLineStyle(nextStyle.lineStyle),
          axisLabelVisible: true,
          title: target.snapshot.price.toFixed(2),
        });
      } else {
        (target.ref as ISeriesApi<"Line">).applyOptions({
          color: withOpacity(nextStyle.color, selected ? Math.min(1, nextStyle.opacity + 0.08) : nextStyle.opacity),
          lineWidth: asLineWidth(nextStyle.width + (selected ? 1 : 0)),
          lineStyle: toChartLineStyle(nextStyle.lineStyle),
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }
    }
    if (workspaceRef.current) updateWorkspaceUi(workspaceRef.current, { drawings: drawingsRef.current.map((x) => x.snapshot) });
  };

  const nextMagnetMode = (mode: MagnetMode): MagnetMode => {
    if (mode === "off") return "weak";
    if (mode === "weak") return "strong";
    return "off";
  };
  const magnetLabel = magnetMode === "off" ? "OFF" : magnetMode === "weak" ? "WEAK" : "STRONG";
  const styleValue = drawDefaults[styleTool];
  const selectedIndices = Array.from(selectedDrawingSetRef.current).sort((a, b) => a - b);
  const selectedCount = selectedIndices.length;
  const selectedDrawingKind = selectedIndices.length
    ? drawingsRef.current[selectedIndices[selectedIndices.length - 1]]?.snapshot.kind ?? null
    : selectedDrawingRef.current != null
      ? drawingsRef.current[selectedDrawingRef.current]?.snapshot.kind ?? null
      : null;

  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    const k = e.key.toLowerCase();
    const hasCmd = e.ctrlKey || e.metaKey;
    if (!e.altKey && hasCmd) {
      if (k === "z" && e.shiftKey) {
        if (redoDrawingsRef.current()) e.preventDefault();
        return;
      }
      if (k === "z") {
        if (undoDrawingsRef.current()) e.preventDefault();
        return;
      }
      if (k === "y") {
        if (redoDrawingsRef.current()) e.preventDefault();
        return;
      }
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (k === "escape") {
      if (cancelDraftRef.current()) e.preventDefault();
      return;
    }

    if (k === "v") setTool("cursor");
    else if (k === "h") setTool("hline");
    else if (k === "t") setTool("trend");
    else if (k === "r") setTool("ray");
    else if (k === "z") setTool("rect");
    else if (k === "m") setMagnetMode((v) => nextMagnetMode(v));
    else if (k === "i") addInd();
    else if (k === "delete" || k === "backspace") {
      if (!deleteSelectedDrawing()) clearDrawings();
    }
    else return;
    e.preventDefault();
  };

  const toolBtn = (t: Tool | "clear", label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      title={label}
      style={{
        width: 30, height: 30, display: "grid", placeItems: "center", cursor: "pointer", borderRadius: 7,
        border: "1px solid " + (tool === t ? "var(--accent)" : "transparent"),
        background: tool === t ? "var(--accent-dim)" : "transparent",
        color: tool === t ? "var(--accent)" : "var(--text-dim)",
      }}
    >
      {TOOL_ICON[t]}
    </button>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onMouseDown={() => rootRef.current?.focus()}
      onKeyDown={onPanelKeyDown}
      className="cli-panel-focusable"
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-1)", outline: "none" }}
    >
      {/* Indicator toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <select className="cli-select" value={addType} onChange={(e) => setAddType(e.target.value as IndType)} style={{ padding: "4px 6px" }}>
          {TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
        <input
          className="cli-input"
          type="number"
          min={2}
          max={400}
          value={addPeriod}
          onChange={(e) => setAddPeriod(Math.max(2, Number(e.target.value) || 20))}
          style={{ width: 56, padding: "4px 6px" }}
          title="period"
        />
        <button className="cli-btn" style={{ padding: "5px 10px" }} onClick={addInd}>+ Indicator</button>
        {inds.map((i, n) => (
          <span
            key={i.id}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, padding: "3px 4px 3px 8px",
              borderRadius: 14, border: "1px solid var(--border)", color: "var(--text)",
              borderLeft: `3px solid ${PALETTE[n % PALETTE.length]}`,
            }}
          >
            {i.type}·{i.period}
            <button onClick={() => removeInd(i.id)} title="remove" style={{ border: 0, background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 13 }}>×</button>
          </span>
        ))}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, borderLeft: "1px solid var(--border)", paddingLeft: 8 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Style</span>
          <select className="cli-select" value={styleTool} onChange={(e) => setStyleTool(e.target.value as DrawingKind)} style={{ padding: "3px 5px", fontSize: 11 }}>
            <option value="hline">hline</option>
            <option value="trend">trend</option>
            <option value="ray">ray</option>
            <option value="rect">rect</option>
          </select>
          <input
            type="color"
            value={styleValue.color}
            onChange={(e) => updateDefaultDrawingStyle(styleTool, { color: e.target.value })}
            title={`Default ${styleTool} color`}
            style={{ width: 26, height: 24, padding: 0, border: "1px solid var(--border)", background: "transparent", borderRadius: 4, cursor: "pointer" }}
          />
          <input
            className="cli-input"
            type="number"
            min={1}
            max={4}
            value={styleValue.width}
            onChange={(e) => updateDefaultDrawingStyle(styleTool, { width: Number(e.target.value) })}
            title={`Default ${styleTool} width`}
            style={{ width: 40, padding: "3px 5px", fontSize: 11 }}
          />
          <select
            className="cli-select"
            value={styleValue.lineStyle}
            onChange={(e) => updateDefaultDrawingStyle(styleTool, { lineStyle: e.target.value as DrawingLineStyle })}
            style={{ padding: "3px 5px", fontSize: 11 }}
          >
            <option value="solid">solid</option>
            <option value="dashed">dashed</option>
            <option value="dotted">dotted</option>
          </select>
          <input
            className="cli-input"
            type="number"
            min={10}
            max={100}
            value={Math.round(styleValue.opacity * 100)}
            onChange={(e) => updateDefaultDrawingStyle(styleTool, { opacity: Number(e.target.value) / 100 })}
            title={`Default ${styleTool} opacity (%)`}
            style={{ width: 48, padding: "3px 5px", fontSize: 11 }}
          />
          {DRAW_STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="cli-btn"
              style={{ padding: "3px 7px", fontSize: 11 }}
              title={`Apply ${preset.label} preset`}
              onClick={() => updateDefaultDrawingStyle(styleTool, preset.style)}
            >
              {preset.label}
            </button>
          ))}
          <button
            className="cli-btn"
            disabled={selectedDrawingKind == null}
            onClick={() => applyStyleToSelected(styleValue)}
            style={{ padding: "3px 7px", fontSize: 11, opacity: selectedDrawingKind == null ? 0.55 : 1 }}
            title={selectedDrawingKind == null ? "Select a drawing first" : `Apply current ${styleTool} style to ${selectedCount} selected ${selectedDrawingKind}${selectedCount > 1 ? "s" : ""}`}
          >
            Apply selected{selectedCount > 1 ? ` (${selectedCount})` : ""}
          </button>
        </div>
        <span className="cli-shortcuts" style={{ marginLeft: "auto" }}>
          shortcuts: V cursor · H line · T trend · R ray · Z zone · M magnet cycle · Shift/Ctrl+click multi-select · Esc cancel draft · Ctrl/Cmd+Z undo · Ctrl/Cmd+Y redo · I add indicator · Del delete selected / clear
        </span>
      </div>

      {/* Chart + drawing tool strip */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <div
          style={{
            position: "absolute", top: 8, left: 8, zIndex: 5, display: "flex", flexDirection: "column", gap: 3,
            background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 9, padding: 3,
          }}
        >
          {toolBtn("cursor", "Cursor", () => setTool("cursor"))}
          {toolBtn("hline", "Horizontal line — click to place", () => setTool("hline"))}
          {toolBtn("trend", "Trend line — click two points", () => setTool("trend"))}
          {toolBtn("ray", "Ray — anchor and direction, extends to the right", () => setTool("ray"))}
          {toolBtn("rect", "Rectangle zone — drag to define range", () => setTool("rect"))}
          <button
            onClick={() => setMagnetMode((v) => nextMagnetMode(v))}
            title={`Magnet ${magnetLabel} — M (cycle off/weak/strong)`}
            style={{
              width: 30,
              height: 30,
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
              borderRadius: 7,
              border:
                "1px solid " +
                (magnetMode === "strong" ? "var(--accent)" : magnetMode === "weak" ? "#cbab7e" : "transparent"),
              background:
                magnetMode === "strong" ? "var(--accent-dim)" : magnetMode === "weak" ? "#cbab7e22" : "transparent",
              color: magnetMode === "off" ? "var(--text-dim)" : magnetMode === "strong" ? "var(--accent)" : "#cbab7e",
              fontSize: 15,
            }}
          >
            🧲
          </button>
          {toolBtn("clear", "Clear drawings", clearDrawings)}
        </div>
        <div
          ref={magnetHudRef}
          style={{
            position: "absolute",
            left: -9999,
            top: -9999,
            zIndex: 6,
            pointerEvents: "none",
            display: "none",
            fontSize: 10,
            letterSpacing: 0.3,
            padding: "3px 6px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            color: "var(--text)",
            background: "#15171bee",
          }}
        />
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}
