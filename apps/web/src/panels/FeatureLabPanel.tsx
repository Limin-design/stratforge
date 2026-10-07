import {
  DEFAULT_FEATURE_SPECS,
  cusumEvents,
  featureAttribution,
  featureSeries,
  tripleBarrier,
  type AttributionReport,
} from "@stratforge/engine";
import { Fragment, useEffect, useRef, useState } from "react";
import { getActiveWorkspaceId, getState, subscribe, type AppState } from "../store.js";

const verdictColor = (v: string) => v === "real" ? "var(--good)" : v === "likely-spurious" ? "var(--bad)" : "var(--text-dim)";

export function FeatureLabPanel() {
  const [snap, setSnap] = useState<AppState>(getState());
  const [atrMult, setAtrMult] = useState(1.5);
  const [maxHoldBars, setMaxHoldBars] = useState(20);
  const [result, setResult] = useState<AttributionReport | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef(getActiveWorkspaceId());

  useEffect(
    () =>
      subscribe((s, workspaceId) => {
        if (wsRef.current !== workspaceId) {
          wsRef.current = workspaceId;
          setResult(null);
          setError(null);
          setEventCount(0);
        }
        setSnap(s);
      }),
    []
  );

  const run = () => {
    setError(null);
    setResult(null);
    const candles = snap.candles;
    if (candles.length < 80) {
      setError("Load at least 80 bars in Data Hub first. Feature Lab needs enough history for transforms and forward labels.");
      return;
    }
    const events = cusumEvents(candles, { atrMult });
    setEventCount(events.length);
    if (events.length === 0) {
      setError("CUSUM found no events. Lower the ATR multiple or load more volatile data.");
      return;
    }
    const labels = tripleBarrier(candles, events, { maxHoldBars });
    if (labels.length < 10) {
      setError(`Only ${labels.length} labelled events after ATR warm-up/forward horizon. Lower horizon or load more data.`);
      return;
    }
    setResult(featureAttribution(labels, DEFAULT_FEATURE_SPECS.map((s) => featureSeries(s, candles))));
  };

  return (
    <div className="cli-panel" style={{ overflowY: "auto" }}>
      <span className="cli-prompt">feature lab — validate predictors before building a strategy</span>
      <div className="cli-box">
        <strong>Event sampler</strong>
        <span className="cli-hint">
          CUSUM detects volatility-normalized price moves, then triple-barrier labels forward outcomes.
          This is pre-strategy research: feature signal first, rules later.
        </span>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)", alignItems: "center" }}>
          <label>ATR multiple <input className="cli-input" style={{ width: 64, padding: "4px 6px" }} type="number" step="0.1" value={atrMult} onChange={(e) => setAtrMult(+e.target.value || 1.5)} /></label>
          <label>max hold bars <input className="cli-input" style={{ width: 64, padding: "4px 6px" }} type="number" value={maxHoldBars} onChange={(e) => setMaxHoldBars(+e.target.value || 20)} /></label>
          <button className="cli-btn" style={{ padding: "5px 12px" }} onClick={run}>run feature attribution</button>
          <span>{snap.datasetName} · {snap.candles.length} bars</span>
        </div>
        {error && <div className="cli-error">{error}</div>}
      </div>

      {result && (
        <>
          <div className="cli-box">
            <strong>Attribution verdicts</strong>
            <span className="cli-hint">
              Events detected: {eventCount}. Labelled: {result.events}. A REAL verdict is a research lead, not a strategy. Demand OOS validation.
            </span>
            <div className="cli-stats" style={{ borderTop: "1px solid var(--border)", marginTop: 4, fontSize: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.4fr .7fr .7fr .8fr 1.7fr", gap: "2px 10px", alignItems: "center" }}>
                <span style={{ color: "var(--text-dim)" }}>feature</span>
                <span style={{ color: "var(--text-dim)", textAlign: "right" }}>verdict</span>
                <span style={{ color: "var(--text-dim)", textAlign: "right" }}>corr</span>
                <span style={{ color: "var(--text-dim)", textAlign: "right" }}>hi-low EV</span>
                <span style={{ color: "var(--text-dim)" }}>note</span>
                {result.features.map((f) => (
                  <Fragment key={f.featureId}>
                    <span>{f.label}</span>
                    <span style={{ textAlign: "right", color: verdictColor(f.correlation.verdict), fontWeight: 700 }}>{f.correlation.verdict}</span>
                    <span style={{ textAlign: "right" }}>{f.correlation.pearsonLevels.toFixed(2)}</span>
                    <span style={{ textAlign: "right", color: f.spreadHighMinusLow > 0 ? "var(--good)" : f.spreadHighMinusLow < 0 ? "var(--bad)" : "var(--text)" }}>{f.spreadHighMinusLow}</span>
                    <span style={{ color: "var(--text-dim)" }}>{f.note}</span>
                  </Fragment>
                ))}
              </div>
            </div>
          </div>

          {result.warnings.length > 0 && (
            <div style={{ borderLeft: "2px solid var(--accent)", background: "var(--bg-2)", padding: "7px 9px", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              {result.warnings.map((w, i) => (<div key={i}><span style={{ color: "var(--text-dim)" }}>⚠ </span>{w}</div>))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
