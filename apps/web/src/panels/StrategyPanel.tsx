import { INDICATOR_LINES, parseStrategy, type StrategySpec } from "@stratforge/dsl";
import { assessRobustness, runBacktest, type RobustnessReport } from "@stratforge/engine";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getActiveWorkspaceId, getState, setState, subscribe, type AppState } from "../store.js";
import { buildSpec, isRegimeCond, listOptimizableParams, rangeValues, specToBuilder, type Builder, type BInd, type BOp, type BCond } from "./strategyBuilder.js";
import { runOptimization, summarizeOptimization, OPTIMIZE_MAX_GRID, OPTIMIZE_MAX_TRIALS, type OptimizationSummary } from "./strategyOptimize.js";

type SweepCfg = { on: boolean; min: number; max: number; step: number };

interface StrategyPreset {
  id: string;
  label: string;
  blurb: string;
  build: () => Builder;
}

const IND_TYPES = Object.keys(INDICATOR_LINES);
const PARAMS: Record<string, [string, number][]> = {
  sma: [["period", 20]], ema: [["period", 20]], rsi: [["period", 14]],
  macd: [["fastPeriod", 12], ["slowPeriod", 26], ["signalPeriod", 9]],
  bollinger: [["period", 20], ["stdDev", 2]],
  atr: [["period", 14]], stochastic: [["kPeriod", 14], ["dPeriod", 3]],
  adx: [["period", 14]], obv: [], vwap: [["period", 20]], mfi: [["period", 14]],
};
const HAS_SOURCE = new Set(["sma", "ema", "rsi", "macd", "bollinger"]);
const SOURCES = ["open", "high", "low", "close"];
const COMPARATORS = ["crossesAbove", "crossesBelow", "greaterThan", "lessThan"];
const REGIME_TRENDS = ["up", "down", "range"];
const REGIME_VOLS = ["low", "normal", "high"];
const small = { padding: "4px 6px", fontSize: 11 } as const;

function linesFor(inds: BInd[], id?: string): string[] | null {
  const t = inds.find((i) => i.id === id)?.type;
  if (!t) return null;
  const ls = (INDICATOR_LINES as Record<string, readonly string[]>)[t];
  return ls && ls.length > 1 ? [...ls] : null;
}
function newIndicator(type: string, inds: BInd[]): BInd {
  const params: Record<string, number | string> = {};
  for (const [k, v] of PARAMS[type] ?? []) params[k] = v;
  if (HAS_SOURCE.has(type)) params.source = "close";
  const n = inds.filter((i) => i.type === type).length + 1;
  return { id: `${type}${n}`, type, params };
}
function validateBuilder(b: Builder): string | null {
  if (!b.name.trim()) return "strategy needs a name";
  if (!b.event.thesis.trim()) return "state the event thesis before backtesting";
  if (b.indicators.length === 0) return "add at least one indicator";
  if (b.event.trigger.length === 0) return "define the event trigger first";
  if (!b.event.trigger.some((c) => "op" in c && (c.op === "crossesAbove" || c.op === "crossesBelow"))) {
    return "event trigger must include at least one crossing/threshold-break condition";
  }
  if (!Number.isFinite(b.risk.positionSizePct) || b.risk.positionSizePct <= 0 || b.risk.positionSizePct > 100) {
    return "position size must be between 0 and 100";
  }
  if (b.risk.stopLossPct != null && (!Number.isFinite(b.risk.stopLossPct) || b.risk.stopLossPct <= 0 || b.risk.stopLossPct > 100)) {
    return "stop-loss must be between 0 and 100";
  }
  if (b.risk.takeProfitPct != null && (!Number.isFinite(b.risk.takeProfitPct) || b.risk.takeProfitPct <= 0 || b.risk.takeProfitPct > 500)) {
    return "take-profit must be between 0 and 500";
  }
  return null;
}

const DEFAULT: Builder = {
  name: "Golden Cross",
  event: {
    thesis: "A fast moving average crossing above a slower moving average may mark a new trend regime.",
    trigger: [{ left: { kind: "indicator", id: "fast" }, op: "crossesAbove", right: { kind: "indicator", id: "slow" } }],
    context: [],
    outcomeHorizonBars: 20,
  },
  indicators: [
    { id: "fast", type: "sma", params: { period: 10, source: "close" } },
    { id: "slow", type: "sma", params: { period: 30, source: "close" } },
  ],
  entry: [{ left: { kind: "indicator", id: "fast" }, op: "crossesAbove", right: { kind: "indicator", id: "slow" } }],
  exit: [{ left: { kind: "indicator", id: "fast" }, op: "crossesBelow", right: { kind: "indicator", id: "slow" } }],
  risk: { positionSizePct: 50, stopLossPct: 5, takeProfitPct: null },
};

const PRESETS: StrategyPreset[] = [
  {
    id: "golden-cross",
    label: "Trend · Golden Cross",
    blurb: "Classic trend-following baseline with fast/slow moving averages.",
    build: () => ({ ...DEFAULT, event: { ...DEFAULT.event, trigger: [...DEFAULT.event.trigger], context: [...DEFAULT.event.context] }, indicators: DEFAULT.indicators.map((x) => ({ ...x, params: { ...x.params } })), entry: [...DEFAULT.entry], exit: [...DEFAULT.exit], risk: { ...DEFAULT.risk } }),
  },
  {
    id: "rsi-revert",
    label: "Mean Reversion · RSI",
    blurb: "Buy oversold and exit when momentum normalizes.",
    build: () => ({
      name: "RSI Revert",
      event: {
        thesis: "An oversold RSI breakdown may identify exhaustion events where mean reversion becomes testable.",
        trigger: [{ left: { kind: "indicator", id: "rsi14" }, op: "crossesBelow", right: { kind: "value", value: 30 } }],
        context: [],
        outcomeHorizonBars: 20,
      },
      indicators: [{ id: "rsi14", type: "rsi", params: { period: 14, source: "close" } }],
      entry: [{ left: { kind: "indicator", id: "rsi14" }, op: "crossesBelow", right: { kind: "value", value: 30 } }],
      exit: [{ left: { kind: "indicator", id: "rsi14" }, op: "greaterThan", right: { kind: "value", value: 55 } }],
      risk: { positionSizePct: 35, stopLossPct: 3, takeProfitPct: 6 },
    }),
  },
  {
    id: "macd-momentum",
    label: "Momentum · MACD",
    blurb: "Momentum confirmation with MACD line cross and conservative stop.",
    build: () => ({
      name: "MACD Momentum",
      event: {
        thesis: "A MACD line crossing above signal may mark a momentum shift worth sampling as an event.",
        trigger: [{ left: { kind: "indicator", id: "macd1", line: "macd" }, op: "crossesAbove", right: { kind: "indicator", id: "macd1", line: "signal" } }],
        context: [],
        outcomeHorizonBars: 20,
      },
      indicators: [{ id: "macd1", type: "macd", params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, source: "close" } }],
      entry: [{ left: { kind: "indicator", id: "macd1", line: "macd" }, op: "crossesAbove", right: { kind: "indicator", id: "macd1", line: "signal" } }],
      exit: [{ left: { kind: "indicator", id: "macd1", line: "macd" }, op: "crossesBelow", right: { kind: "indicator", id: "macd1", line: "signal" } }],
      risk: { positionSizePct: 30, stopLossPct: 4, takeProfitPct: 10 },
    }),
  },
];

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
const fmt = (n: number) => (Number.isFinite(n) ? String(n) : "∞");
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function eventDesignWarnings(spec: StrategySpec): string[] {
  const warnings: string[] = [];
  const trigger = spec.process?.trigger ?? spec.entry;
  const hasCrossTrigger = trigger.some((c) => "op" in c && (c.op === "crossesAbove" || c.op === "crossesBelow"));
  if (!spec.process?.thesis?.trim()) warnings.push("No event thesis stated. This is indicator hunting, not research.");
  if (!hasCrossTrigger) warnings.push("Entry design has no crossing/event trigger. Threshold-only rules can stay true across many bars; use them as context plus an explicit event trigger.");
  if ((spec.process?.context.length ?? 0) === 0) warnings.push("No contextual filters. Test regimes/time/volatility context before trusting this event.");
  if (!spec.risk.stopLossPct) warnings.push("No stop-loss defined. Tail risk is under-controlled.");
  return warnings;
}

function condUsesIndicator(c: BCond, id: string): boolean {
  return "left" in c && ((c.left.kind === "indicator" && c.left.id === id) || (c.right.kind === "indicator" && c.right.id === id));
}

// ---------- operand + condition editors ----------
function OperandEditor({ op, onChange, inds }: { op: BOp; onChange: (o: BOp) => void; inds: BInd[] }) {
  const set = (patch: Partial<BOp>) => onChange({ ...op, ...patch });
  const lines = op.kind === "indicator" ? linesFor(inds, op.id) : null;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      <select
        className="cli-select"
        style={small}
        value={op.kind}
        onChange={(e) => {
          const k = e.target.value;
          if (k === "indicator") onChange({ kind: "indicator", id: inds[0]?.id ?? "" });
          else if (k === "price") onChange({ kind: "price", source: "close" });
          else if (k === "value") onChange({ kind: "value", value: 0 });
          else onChange({ kind: "factor", id: "factor1" });
        }}
      >
        <option value="indicator">indicator</option>
        <option value="price">price</option>
        <option value="value">value</option>
        <option value="factor">factor</option>
      </select>
      {op.kind === "indicator" && (
        <>
          <select className="cli-select" style={small} value={op.id} onChange={(e) => set({ id: e.target.value, line: undefined })}>
            {inds.map((i) => (
              <option key={i.id} value={i.id}>{i.id}</option>
            ))}
          </select>
          {lines && (
            <select className="cli-select" style={small} value={op.line ?? ""} onChange={(e) => set({ line: e.target.value || undefined })}>
              <option value="">(default)</option>
              {lines.map((l) => <option key={l}>{l}</option>)}
            </select>
          )}
        </>
      )}
      {op.kind === "price" && (
        <select className="cli-select" style={small} value={op.source} onChange={(e) => set({ source: e.target.value })}>
          {SOURCES.map((s) => <option key={s}>{s}</option>)}
        </select>
      )}
      {op.kind === "value" && (
        <input className="cli-input" style={{ ...small, width: 70 }} type="number" value={op.value ?? 0} onChange={(e) => set({ value: Number(e.target.value) })} />
      )}
      {op.kind === "factor" && (
        <input className="cli-input" style={{ ...small, width: 90 }} value={op.id ?? ""} onChange={(e) => set({ id: e.target.value })} placeholder="factor id" />
      )}
    </span>
  );
}

function ConditionList({ conds, setConds, inds, label }: { conds: BCond[]; setConds: (c: BCond[]) => void; inds: BInd[]; label: string }) {
  const upd = (i: number, c: BCond) => setConds(conds.map((x, j) => (j === i ? c : x)));
  return (
    <div className="cli-box" style={{ gap: 6 }}>
      <strong>{label} <span className="cli-hint" style={{ fontWeight: 400 }}>(all must be true)</span></strong>
      {conds.map((c, i) => (
        <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          {isRegimeCond(c) ? (
            <>
              <span className="cli-hint">regime</span>
              <select className="cli-select" style={small} value={c.axis} onChange={(e) => upd(i, { kind: "regime", axis: e.target.value as "trend" | "volatility", in: e.target.value === "trend" ? ["up"] : ["normal"] })}>
                <option value="trend">trend</option>
                <option value="volatility">volatility</option>
              </select>
              <span className="cli-hint">is</span>
              <select className="cli-select" style={small} value={c.in[0] ?? ""} onChange={(e) => upd(i, { ...c, in: [e.target.value] })}>
                {(c.axis === "trend" ? REGIME_TRENDS : REGIME_VOLS).map((v) => <option key={v}>{v}</option>)}
              </select>
            </>
          ) : (
            <>
              <OperandEditor op={c.left} onChange={(o) => upd(i, { ...c, left: o })} inds={inds} />
              <select className="cli-select" style={small} value={c.op} onChange={(e) => upd(i, { ...c, op: e.target.value })}>
                {COMPARATORS.map((o) => <option key={o}>{o}</option>)}
              </select>
              <OperandEditor op={c.right} onChange={(o) => upd(i, { ...c, right: o })} inds={inds} />
            </>
          )}
          <button onClick={() => setConds(conds.filter((_, j) => j !== i))} title="remove" style={{ border: 0, background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 14 }}>×</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="cli-btn" style={{ ...small, alignSelf: "flex-start", background: "var(--bg-3)", color: "var(--text)", border: "1px solid var(--border)" }}
          onClick={() => setConds([...conds, { left: { kind: "indicator", id: inds[0]?.id ?? "" }, op: "crossesAbove", right: { kind: "indicator", id: inds[1]?.id ?? inds[0]?.id ?? "" } }])}>
          + condition
        </button>
        <button className="cli-btn" style={{ ...small, alignSelf: "flex-start", background: "var(--bg-3)", color: "var(--text)", border: "1px solid var(--border)" }}
          onClick={() => setConds([...conds, { kind: "regime", axis: "trend", in: ["up"] }])}>
          + regime filter
        </button>
      </div>
    </div>
  );
}

export function StrategyPanel() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"builder" | "json">("builder");
  const [b, setB] = useState<Builder>(DEFAULT);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState(getState().result?.stats ?? null);
  const [robustness, setRobustness] = useState<RobustnessReport | null>(null);
  const [optimization, setOptimization] = useState<OptimizationSummary | null>(getState().optimization ?? null);
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [sweeps, setSweeps] = useState<Record<string, SweepCfg>>({});
  const [optWindows, setOptWindows] = useState(4);
  const [optError, setOptError] = useState<string | null>(null);
  const [optRunning, setOptRunning] = useState(false);
  const trialsRef = useRef(0);
  const lastSpecRef = useRef("");
  const wsRef = useRef<string>("");

  // Mirror the active strategy from the store: when the AI analyst (or another
  // panel) sets a new spec, load it into the builder so every parameter shows
  // and is editable. Our own runs update lastSpecRef so they don't reload.
  useEffect(() => {
    const apply = (s: AppState, workspaceId: string) => {
      if (wsRef.current !== workspaceId) {
        wsRef.current = workspaceId;
        trialsRef.current = 0;
        setRobustness(null);
        setError(null);
      }
      setStats(s.result?.stats ?? null);
      setOptimization(s.optimization ?? null);
      if (s.spec) {
        const j = JSON.stringify(s.spec);
        if (j !== lastSpecRef.current) {
          lastSpecRef.current = j;
          setB(specToBuilder(s.spec));
          setMode("builder");
        }
      }
    };
    apply(getState(), getActiveWorkspaceId());
    return subscribe(apply);
  }, []);

  const toJson = () => { setJson(JSON.stringify(buildSpec(b), null, 2)); setMode("json"); };

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    const next = p.build();
    setB(next);
    setJson(JSON.stringify(buildSpec(next), null, 2));
    setMode("builder");
    setError(null);
  };

  const run = () => {
    try {
      if (mode === "builder") {
        const v = validateBuilder(b);
        if (v) {
          setError(v);
          return;
        }
      }
      const workspaceId = getActiveWorkspaceId();
      const spec = parseStrategy(mode === "json" ? JSON.parse(json) : buildSpec(b));
      const { candles } = getState(workspaceId);
      if (candles.length === 0) { setError("no dataset loaded — open the Data Hub tab first"); return; }
      const result = runBacktest(spec, candles, { initialCapital: 10_000, feePct: 0.1, slippagePct: 0.05 });
      lastSpecRef.current = JSON.stringify(spec);
      setState({ result, spec }, workspaceId);
      setError(null);
      trialsRef.current += 1;
      const dt = candles.length > 1 ? candles[1].time - candles[0].time : 3600;
      const report = assessRobustness(result.timeline, candles, { trials: trialsRef.current, periodsPerYear: SECONDS_PER_YEAR / dt, iterations: 500, trades: result.trades, initialCapital: 10_000 });
      report.warnings.push(...eventDesignWarnings(spec));
      setRobustness(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRobustness(null);
    }
  };

  const setInd = (i: number, patch: Partial<BInd>) => setB({ ...b, indicators: b.indicators.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const r = robustness;

  // ---- optimizer (walk-forward grid) ----
  const optParams = listOptimizableParams(b);
  const sweepFor = (key: string, current: number): SweepCfg => sweeps[key] ?? { on: false, min: current, max: current + 4, step: 1 };
  const setSweep = (key: string, current: number, patch: Partial<SweepCfg>) =>
    setSweeps((prev) => ({ ...prev, [key]: { ...sweepFor(key, current), ...patch } }));

  const builtRanges: Record<string, number[]> = {};
  for (const p of optParams) {
    const cfg = sweepFor(p.key, p.current);
    if (cfg.on) {
      const vals = rangeValues(cfg.min, cfg.max, cfg.step);
      if (vals.length) builtRanges[p.key] = vals;
    }
  }
  const sweptCount = Object.keys(builtRanges).length;
  const gridSize = sweptCount ? Object.values(builtRanges).reduce((n, vs) => n * vs.length, 1) : 0;
  const estTrials = gridSize * optWindows;
  const overGrid = gridSize > OPTIMIZE_MAX_GRID;
  const overTrials = estTrials > OPTIMIZE_MAX_TRIALS;
  const optReadout =
    sweptCount === 0
      ? "select at least one parameter to sweep"
      : overGrid
        ? `grid ${gridSize} combos > cap ${OPTIMIZE_MAX_GRID} — narrow the ranges`
        : overTrials
          ? `${estTrials} backtests > cap ${OPTIMIZE_MAX_TRIALS} — reduce grid or windows`
          : `grid ${gridSize} × ${optWindows} windows = ${estTrials} backtests (each one a test you deflate for)`;
  const canOptimize = sweptCount > 0 && !overGrid && !overTrials && !optRunning;

  const runOptimize = () => {
    setOptError(null);
    const v = validateBuilder(b);
    if (v) { setOptError(v); return; }
    const workspaceId = getActiveWorkspaceId();
    const { candles } = getState(workspaceId);
    if (candles.length < 40) { setOptError(`need ≥ 40 bars for walk-forward optimization (loaded: ${candles.length})`); return; }
    let spec;
    try { spec = parseStrategy(buildSpec(b)); } catch (e) { setOptError(e instanceof Error ? e.message : String(e)); return; }
    setOptRunning(true);
    // Defer the heavy synchronous run one tick so the "optimizing…" state paints first.
    setTimeout(() => {
      try {
        const outcome = runOptimization(spec, builtRanges, candles, optWindows);
        if ("error" in outcome) { setOptError(outcome.error); return; }
        // Optimization is multiple testing — inflate this panel's trial counter so the
        // next manual backtest deflates for the search too (mirrors the agent tool).
        trialsRef.current += outcome.trialsRun;
        setState({ optimization: summarizeOptimization(outcome, spec.name) }, workspaceId);
      } catch (e) {
        setOptError(e instanceof Error ? e.message : String(e));
      } finally {
        setOptRunning(false);
      }
    }, 0);
  };

  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
      return;
    }
    if (e.altKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      if (mode === "json") setMode("builder");
      else toJson();
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onMouseDown={() => rootRef.current?.focus()}
      onKeyDown={onPanelKeyDown}
      className="cli-panel cli-panel-focusable"
      style={{ overflowY: "auto", outline: "none" }}
    >
      {/* mode toggle */}
      <div style={{ display: "flex", gap: 6 }}>
        {(["builder", "json"] as const).map((m) => (
          <button key={m} onClick={() => (m === "json" ? toJson() : setMode("builder"))}
            style={{ ...small, padding: "5px 12px", borderRadius: 7, cursor: "pointer",
              border: "1px solid " + (mode === m ? "var(--accent)" : "var(--border)"),
              background: mode === m ? "var(--accent-dim)" : "var(--bg-2)",
              color: mode === m ? "var(--white)" : "var(--text-dim)" }}>
            {m === "builder" ? "Builder" : "JSON (advanced)"}
          </button>
        ))}
      </div>

      <div className="cli-box" style={{ gap: 8 }}>
        <strong>Quick start</strong>
        <span className="cli-hint">Pick a starter profile, tweak parameters, then run. The AI analyst can refine from there.</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {PRESETS.map((p) => (
            <button key={p.id} className="cli-btn" style={{ padding: "6px 10px", fontSize: 11.5 }} onClick={() => applyPreset(p.id)} title={p.blurb}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {mode === "builder" ? (
        <>
          <input className="cli-input" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder="strategy name" />

          <div className="cli-box" style={{ gap: 6 }}>
            <strong>Indicators</strong>
            {b.indicators.map((ind, i) => (
              <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                <input className="cli-input" style={{ ...small, width: 70 }} value={ind.id} onChange={(e) => setInd(i, { id: e.target.value })} title="id" />
                <select className="cli-select" style={small} value={ind.type} onChange={(e) => setInd(i, { type: e.target.value, params: paramsFor(e.target.value) })}>
                  {IND_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
                {Object.keys(ind.params).filter((k) => k !== "source").map((k) => (
                  <input key={k} className="cli-input" style={{ ...small, width: 58 }} type="number" value={ind.params[k] as number}
                    onChange={(e) => setInd(i, { params: { ...ind.params, [k]: Number(e.target.value) } })} title={k} />
                ))}
                {"source" in ind.params && (
                  <select className="cli-select" style={small} value={ind.params.source as string} onChange={(e) => setInd(i, { params: { ...ind.params, source: e.target.value } })}>
                    {SOURCES.map((s) => <option key={s}>{s}</option>)}
                  </select>
                )}
                <button onClick={() => {
                  const rid = b.indicators[i].id;
                  const keep = (c: BCond) => !condUsesIndicator(c, rid);
                  setB({ ...b, indicators: b.indicators.filter((_, j) => j !== i), event: { ...b.event, trigger: b.event.trigger.filter(keep), context: b.event.context.filter(keep) }, entry: b.entry.filter(keep), exit: b.exit.filter(keep) });
                }} title="remove (and any conditions using it)" style={{ border: 0, background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 14 }}>×</button>
              </div>
            ))}
            <select className="cli-select" style={{ ...small, alignSelf: "flex-start" }} value="" onChange={(e) => e.target.value && setB({ ...b, indicators: [...b.indicators, newIndicator(e.target.value, b.indicators)] })}>
              <option value="">+ add indicator…</option>
              {IND_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className="cli-box" style={{ gap: 8, borderColor: "var(--accent)" }}>
            <strong>1 · Event thesis <span className="cli-hint" style={{ fontWeight: 400 }}>(why this sample should exist)</span></strong>
            <textarea
              className="cli-textarea"
              style={{ minHeight: 58, fontSize: 12 }}
              value={b.event.thesis}
              onChange={(e) => setB({ ...b, event: { ...b.event, thesis: e.target.value } })}
              placeholder="Example: a volatility breakout after compression should have positive forward drift because trapped liquidity gets forced out."
            />
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-dim)" }}>
              outcome horizon bars
              <input className="cli-input" style={{ ...small, width: 64 }} type="number" min={1} value={b.event.outcomeHorizonBars} onChange={(e) => setB({ ...b, event: { ...b.event, outcomeHorizonBars: Math.max(1, Math.round(Number(e.target.value) || 20)) } })} />
            </label>
          </div>

          <ConditionList conds={b.event.trigger} setConds={(c) => setB({ ...b, event: { ...b.event, trigger: c } })} inds={b.indicators} label="2 · Event trigger" />
          <ConditionList conds={b.event.context} setConds={(c) => setB({ ...b, event: { ...b.event, context: c } })} inds={b.indicators} label="3 · Context filters" />
          <ConditionList conds={b.exit} setConds={(c) => setB({ ...b, exit: c })} inds={b.indicators} label="Exit when" />

          <div className="cli-box" style={{ gap: 6 }}>
            <strong>Risk</strong>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              position size %
              <input className="cli-input" style={{ ...small, width: 64 }} type="number" value={b.risk.positionSizePct} onChange={(e) => setB({ ...b, risk: { ...b.risk, positionSizePct: Number(e.target.value) } })} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={b.risk.stopLossPct != null} onChange={(e) => setB({ ...b, risk: { ...b.risk, stopLossPct: e.target.checked ? 5 : null } })} />
              stop-loss %
              {b.risk.stopLossPct != null && <input className="cli-input" style={{ ...small, width: 64 }} type="number" value={b.risk.stopLossPct} onChange={(e) => setB({ ...b, risk: { ...b.risk, stopLossPct: Number(e.target.value) } })} />}
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={b.risk.takeProfitPct != null} onChange={(e) => setB({ ...b, risk: { ...b.risk, takeProfitPct: e.target.checked ? 10 : null } })} />
              take-profit %
              {b.risk.takeProfitPct != null && <input className="cli-input" style={{ ...small, width: 64 }} type="number" value={b.risk.takeProfitPct} onChange={(e) => setB({ ...b, risk: { ...b.risk, takeProfitPct: Number(e.target.value) } })} />}
            </label>
          </div>
        </>
      ) : (
        <textarea className="cli-textarea" style={{ flex: 1, minHeight: 220, fontSize: 12 }} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
      )}

      <button className="cli-btn" onClick={run}>run backtest</button>
      <span className="cli-shortcuts">shortcuts: Ctrl/Cmd+Enter run · Alt+J toggle Builder/JSON</span>
      {error && <div className="cli-error">{error}</div>}

      {/* Walk-forward optimizer */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6 }}>
        <button
          className="cli-btn"
          style={{ ...small, background: "var(--bg-2)", color: "var(--text)", border: "1px solid var(--border)" }}
          onClick={() => setOptimizeOpen((o) => !o)}
          title="Honest walk-forward parameter optimization (OOS-only, deflated for every trial)"
        >
          {optimizeOpen ? "▾" : "▸"} walk-forward optimize
        </button>
        {optimizeOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            {optParams.length === 0 ? (
              <div className="cli-prompt" style={{ fontSize: 12 }}>add indicators or risk params to the strategy first.</div>
            ) : (
              optParams.map((p) => {
                const cfg = sweepFor(p.key, p.current);
                const n = cfg.on ? rangeValues(cfg.min, cfg.max, cfg.step).length : 0;
                return (
                  <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, flexWrap: "wrap" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 150 }}>
                      <input type="checkbox" checked={cfg.on} onChange={(e) => setSweep(p.key, p.current, { on: e.target.checked })} />
                      {p.label} <span style={{ color: "var(--text-dim)" }}>({p.current})</span>
                    </label>
                    {cfg.on && (
                      <>
                        <span style={{ color: "var(--text-dim)" }}>min</span>
                        <input className="cli-input" type="number" value={cfg.min} onChange={(e) => setSweep(p.key, p.current, { min: Number(e.target.value) })} style={{ width: 56, ...small }} />
                        <span style={{ color: "var(--text-dim)" }}>max</span>
                        <input className="cli-input" type="number" value={cfg.max} onChange={(e) => setSweep(p.key, p.current, { max: Number(e.target.value) })} style={{ width: 56, ...small }} />
                        <span style={{ color: "var(--text-dim)" }}>step</span>
                        <input className="cli-input" type="number" value={cfg.step} onChange={(e) => setSweep(p.key, p.current, { step: Number(e.target.value) })} style={{ width: 50, ...small }} />
                        <span style={{ color: n > 0 ? "var(--text-dim)" : "#ef5350" }}>{n} vals</span>
                      </>
                    )}
                  </div>
                );
              })
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-dim)" }}>windows</span>
              <input
                className="cli-input"
                type="number"
                min={2}
                max={8}
                value={optWindows}
                onChange={(e) => setOptWindows(Math.max(2, Math.min(8, Math.round(Number(e.target.value) || 4))))}
                style={{ width: 48, ...small }}
              />
              <span style={{ color: overGrid || overTrials ? "var(--accent)" : "var(--text-dim)" }}>{optReadout}</span>
            </div>
            <button className="cli-btn" style={{ alignSelf: "flex-start", opacity: canOptimize ? 1 : 0.55 }} disabled={!canOptimize} onClick={runOptimize}>
              {optRunning ? "optimizing…" : "run optimization"}
            </button>
            {optError && <div className="cli-error">{optError}</div>}
          </div>
        )}
      </div>

      {stats && (
        <div className="cli-stats">
          EV/trade <b>{stats.expectancy}</b> (<b>{stats.expectancyPct}%</b>) · win probability <b>{stats.winProbability}%</b> · trades <b>{stats.trades}</b> · exposure <b>{stats.exposurePct}%</b>
          <br />
          return <b>{stats.totalReturnPct}%</b> · cagr <b>{stats.cagrPct}%</b> · max-dd <b>{stats.maxDrawdownPct}%</b> ({stats.maxDrawdownDurationBars} bars) · pf <b>{fmt(stats.profitFactor)}</b> · payoff <b>{fmt(stats.payoffRatio)}</b>
          <br />
          sharpe <b>{stats.annualizedSharpe}</b> · sortino <b>{stats.sortino}</b> · calmar <b>{stats.calmar}</b>
        </div>
      )}

      {r && (
        <div className="cli-stats">
          <span className="cli-prompt" style={{ display: "block", marginBottom: 4 }}>robustness — is the edge real? (trial #{r.sharpe.trials})</span>
          edge-confidence (PSR) <b>{pct(r.sharpe.probabilisticSharpe)}</b>
          {r.sharpe.deflatedSharpe !== undefined && <> · deflated <b>{pct(r.sharpe.deflatedSharpe)}</b></>} · timing p-value <b>{r.permutation.pValue.toFixed(3)}</b>
          <br />
          OOS sharpe <b>{r.outOfSample.inSample.sharpe.toFixed(2)}→{r.outOfSample.outOfSample.sharpe.toFixed(2)}</b> · walk-forward profitable <b>{pct(r.walkForward.profitableFraction)}</b>
          <br />
          path dependence <b>{r.pathDependence.score}/100</b> · MC max-dd 5–95% <b>{r.pathDependence.bestMaxDrawdownPct.toFixed(1)}% … {r.pathDependence.worstMaxDrawdownPct.toFixed(1)}%</b> · median MC dd <b>{r.pathDependence.medianMaxDrawdownPct.toFixed(1)}%</b>
        </div>
      )}
      {r && r.warnings.length > 0 && (
        <div style={{ borderLeft: "2px solid var(--accent)", background: "var(--bg-2)", padding: "6px 9px", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
          {r.warnings.map((w, i) => (<div key={i}><span style={{ color: "var(--text-dim)" }}>⚠ </span>{w}</div>))}
        </div>
      )}
      {r && r.warnings.length === 0 && <div className="cli-prompt" style={{ fontSize: 12 }}>no robustness red flags — but keep an out-of-sample eye on it.</div>}

      {optimization && (
        <div className="cli-stats">
          <span className="cli-prompt" style={{ display: "block", marginBottom: 4 }}>
            walk-forward optimization — {optimization.strategyName} · {optimization.gridSize}-combo grid · {optimization.windows} windows · {optimization.trialsRun} trials
          </span>
          <div style={{ marginBottom: 6 }}>{optimization.verdict}</div>
          OOS sharpe <b>{optimization.oosSharpe.toFixed(2)}</b>
          {optimization.deflatedSharpe != null && <> · deflated <b>{pct(optimization.deflatedSharpe)}</b></>}
          {" "}· OOS return <b>{optimization.oosTotalReturnPct.toFixed(1)}%</b> · windows profitable <b>{pct(optimization.profitableWindowFraction)}</b>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6, fontSize: 11 }}>
            <thead>
              <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                <th style={{ padding: "2px 4px" }}>#</th>
                <th style={{ padding: "2px 4px" }}>train</th>
                <th style={{ padding: "2px 4px" }}>test</th>
                <th style={{ padding: "2px 4px" }}>OOS %</th>
                <th style={{ padding: "2px 4px" }}>best params</th>
              </tr>
            </thead>
            <tbody>
              {optimization.perWindow.map((w, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "2px 4px" }}>{i + 1}</td>
                  <td style={{ padding: "2px 4px" }}>{w.trainBars}</td>
                  <td style={{ padding: "2px 4px" }}>{w.testBars}</td>
                  <td style={{ padding: "2px 4px", color: w.oosReturnPct >= 0 ? "#26a69a" : "#ef5350" }}>{w.oosReturnPct.toFixed(1)}%</td>
                  <td style={{ padding: "2px 4px" }}>
                    {Object.entries(w.bestParams)
                      .map(([k, v]) => `${k.replace("ind:", "").replace("risk:", "").replace(":", ".")}=${v}`)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function paramsFor(type: string): Record<string, number | string> {
  const p: Record<string, number | string> = {};
  for (const [k, v] of PARAMS[type] ?? []) p[k] = v;
  if (HAS_SOURCE.has(type)) p.source = "close";
  return p;
}
