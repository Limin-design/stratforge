import { analyzeTradeLogInMarketContext, parseTradeLogCsv, simulatePropFirm, DEFAULT_PROP_FIRM_RULESET, type InstrumentMetadata, type TradeLogAnalysis } from "@stratforge/engine";
import { useEffect, useMemo, useState } from "react";
import { getState, subscribe, type AppState } from "../store.js";

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "∞");

function GroupTable({ title, rows }: { title: string; rows: NonNullable<TradeLogAnalysis>["byRegime"] }) {
  return (
    <div className="cli-box">
      <strong>{title}</strong>
      {rows.length === 0 ? (
        <span className="cli-hint">No grouped rows yet.</span>
      ) : (
        <div className="cli-stats" style={{ borderTop: "1px solid var(--border)", fontSize: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr repeat(5, 1fr)", gap: "2px 10px", alignItems: "center" }}>
            <span style={{ color: "var(--text-dim)" }}>group</span>
            <span style={{ color: "var(--text-dim)", textAlign: "right" }}>trades</span>
            <span style={{ color: "var(--text-dim)", textAlign: "right" }}>win %</span>
            <span style={{ color: "var(--text-dim)", textAlign: "right" }}>PnL</span>
            <span style={{ color: "var(--text-dim)", textAlign: "right" }}>EV</span>
            <span style={{ color: "var(--text-dim)", textAlign: "right" }}>share</span>
            {rows.map((r) => (
              <>
                <span key={`${title}-${r.key}-k`}>{r.key}</span>
                <span key={`${title}-${r.key}-t`} style={{ textAlign: "right" }}>{r.trades}</span>
                <span key={`${title}-${r.key}-w`} style={{ textAlign: "right" }}>{r.winRatePct}%</span>
                <span key={`${title}-${r.key}-p`} style={{ textAlign: "right", color: r.totalPnl > 0 ? "var(--good)" : r.totalPnl < 0 ? "var(--bad)" : "var(--text)" }}>{r.totalPnl}</span>
                <span key={`${title}-${r.key}-e`} style={{ textAlign: "right" }}>{r.expectancy}</span>
                <span key={`${title}-${r.key}-s`} style={{ textAlign: "right" }}>{r.pnlSharePct}%</span>
              </>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function TradeLogPanel() {
  const [snap, setSnap] = useState<AppState>(getState());
  const [status, setStatus] = useState("Load OHLCV data first, then import a trade log CSV.");
  const [analysis, setAnalysis] = useState<TradeLogAnalysis | null>(null);
  const [metadata, setMetadata] = useState<InstrumentMetadata>({ assetClass: "future", exchange: "", session: "", tickSize: 0.25, pointValue: 50 });

  useEffect(() => subscribe((s) => setSnap(s)), []);

  const propFirm = useMemo(() => {
    if (!analysis || analysis.engineTrades.length < 5) return null;
    return simulatePropFirm(analysis.engineTrades, DEFAULT_PROP_FIRM_RULESET, {
      iterations: 1000,
      seed: 20260628,
      regimeAware: true,
      candles: snap.candles,
    });
  }, [analysis, snap.candles]);

  const loadTradeLog = async (file: File) => {
    if (snap.candles.length === 0) {
      setStatus("No OHLCV dataset loaded. Load the matching market data in Data Hub first.");
      return;
    }
    try {
      const parsed = parseTradeLogCsv(await file.text());
      if (parsed.trades.length === 0) {
        setStatus(`No usable trades parsed. ${parsed.issues[0]?.issue ?? "Check columns."}`);
        return;
      }
      const report = analyzeTradeLogInMarketContext(snap.candles, parsed.trades, { metadata });
      setAnalysis(report);
      setStatus(`loaded ${report.summary.trades} trades from ${file.name}${parsed.issues.length ? ` · ${parsed.issues.length} row issue(s)` : ""}`);
    } catch (e) {
      setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="cli-panel" style={{ overflowY: "auto" }}>
      <span className="cli-prompt">trade-log analyzer</span>
      <div className="cli-box">
        <strong>Bring-your-own trade log</strong>
        <span className="cli-hint">
          Import CSV trades and align every entry to the loaded candles. Required: entry time plus either PnL or entry/exit prices. Optional: side, size, symbol, tag/setup.
        </span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(90px, 1fr))", gap: 6 }}>
          <label className="cli-hint">asset class
            <select className="cli-select" value={metadata.assetClass ?? "other"} onChange={(e) => setMetadata({ ...metadata, assetClass: e.target.value as InstrumentMetadata["assetClass"] })}>
              {(["future", "equity", "forex", "crypto", "option", "other"] as const).map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label className="cli-hint">exchange
            <input className="cli-input" value={metadata.exchange ?? ""} onChange={(e) => setMetadata({ ...metadata, exchange: e.target.value })} placeholder="CME / NYSE" />
          </label>
          <label className="cli-hint">session
            <input className="cli-input" value={metadata.session ?? ""} onChange={(e) => setMetadata({ ...metadata, session: e.target.value })} placeholder="RTH / ETH" />
          </label>
          <label className="cli-hint">tick size
            <input className="cli-input" type="number" value={metadata.tickSize ?? ""} onChange={(e) => setMetadata({ ...metadata, tickSize: Number(e.target.value) || undefined })} />
          </label>
          <label className="cli-hint">point value
            <input className="cli-input" type="number" value={metadata.pointValue ?? ""} onChange={(e) => setMetadata({ ...metadata, pointValue: Number(e.target.value) || undefined })} />
          </label>
        </div>
        <input className="cli-input" type="file" accept=".csv,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadTradeLog(f); }} />
        <span className="cli-hint">{status}</span>
      </div>

      {analysis && (
        <>
          <div className="cli-box">
            <strong>Trade-log summary</strong>
            <div className="kpi-grid">
              <div className="kpi-card"><span className="kpi-label">Trades</span><b>{analysis.summary.trades}</b></div>
              <div className="kpi-card"><span className="kpi-label">Total PnL</span><b style={{ color: analysis.summary.totalPnl >= 0 ? "var(--good)" : "var(--bad)" }}>{analysis.summary.totalPnl}</b></div>
              <div className="kpi-card"><span className="kpi-label">EV / trade</span><b style={{ color: analysis.summary.expectancy > 0 ? "var(--good)" : "var(--bad)" }}>{analysis.summary.expectancy}</b></div>
              <div className="kpi-card"><span className="kpi-label">Win rate</span><b>{analysis.summary.winRatePct}%</b></div>
              <div className="kpi-card"><span className="kpi-label">Profit factor</span><b>{fmt(analysis.summary.profitFactor)}</b></div>
              <div className="kpi-card"><span className="kpi-label">Avg hold</span><b>{analysis.summary.avgHoldBars} bars</b></div>
              <div className="kpi-card"><span className="kpi-label">Best</span><b>{analysis.summary.bestTrade}</b></div>
              <div className="kpi-card"><span className="kpi-label">Worst</span><b>{analysis.summary.worstTrade}</b></div>
            </div>
            {analysis.warnings.length > 0 && (
              <div style={{ borderLeft: "2px solid var(--accent)", background: "var(--bg-2)", padding: "7px 9px", marginTop: 8, fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {analysis.warnings.map((w, i) => <div key={i}><span style={{ color: "var(--text-dim)" }}>⚠ </span>{w}</div>)}
              </div>
            )}
          </div>

          {propFirm && (
            <div className="cli-box">
              <strong>Prop-firm read from imported trades</strong>
              <span className="cli-hint">Uses the imported trades, not a strategy backtest. This measures rule convexity and execution history, not proof of edge.</span>
              <div className="cli-stats" style={{ borderTop: "1px solid var(--border)" }}>
                pass <b>{propFirm.pPass}%</b> · fail <b>{propFirm.outcomeBuckets.fail}%</b> · timeout <b>{propFirm.outcomeBuckets.timeout}%</b> · net EV/account <b style={{ color: propFirm.netEvPerAccount >= 0 ? "var(--good)" : "var(--bad)" }}>{propFirm.netEvPerAccount}</b>
                {propFirm.regimeAware && <><br />regime-aware <b>{propFirm.regimeAware.enabled ? "on" : "fallback"}</b></>}
              </div>
            </div>
          )}

          <GroupTable title="PnL by entry regime" rows={analysis.byRegime} />
          <GroupTable title="PnL by session" rows={analysis.bySession} />
          <GroupTable title="PnL by setup/tag" rows={analysis.byTag} />
          <GroupTable title="PnL by feature bucket" rows={analysis.byFeature} />

          <div className="cli-box">
            <strong>Recent aligned trades</strong>
            <div className="cli-stats" style={{ borderTop: "1px solid var(--border)", fontSize: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "2px 10px", alignItems: "center" }}>
                <span style={{ color: "var(--text-dim)" }}>bar</span>
                <span style={{ color: "var(--text-dim)" }}>side</span>
                <span style={{ color: "var(--text-dim)" }}>regime</span>
                <span style={{ color: "var(--text-dim)", textAlign: "right" }}>RSI</span>
                <span style={{ color: "var(--text-dim)", textAlign: "right" }}>ATR%</span>
                <span style={{ color: "var(--text-dim)" }}>tag</span>
                <span style={{ color: "var(--text-dim)", textAlign: "right" }}>PnL</span>
                {analysis.rows.slice(-20).map((r, i) => (
                  <>
                    <span key={`${i}-bar`}>{r.entryBar}</span>
                    <span key={`${i}-side`}>{r.trade.side}</span>
                    <span key={`${i}-regime`}>{r.regime ?? "—"}</span>
                    <span key={`${i}-rsi`} style={{ textAlign: "right" }}>{r.rsi14 ?? "—"}</span>
                    <span key={`${i}-atr`} style={{ textAlign: "right" }}>{r.atrPct ?? "—"}</span>
                    <span key={`${i}-tag`}>{r.trade.tag ?? "—"}</span>
                    <span key={`${i}-pnl`} style={{ textAlign: "right", color: r.pnl > 0 ? "var(--good)" : r.pnl < 0 ? "var(--bad)" : "var(--text)" }}>{r.pnl}</span>
                  </>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <span className="cli-hint">Not good enough to trade from alone: this diagnoses your existing execution. Use it to decide which setups/regimes deserve a proper strategy test.</span>
    </div>
  );
}
