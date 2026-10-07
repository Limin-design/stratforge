/**
 * Strategy stats tab. Shows the backtest's headline metrics, a Monte Carlo
 * (trade-bootstrap) outcome distribution with a prop-firm pass rate, and any
 * custom tests the AI analyst added to the workspace (store.customStats).
 */
import { DEFAULT_PROP_FIRM_RULESET, analyzeEntryEvents, analyzeRegimes, assessRobustness, buildIndicatorContext, buyAndHoldStats, outcomeReport, relativeVerdict, robustnessVerdict, sharpeLabel, simulatePropFirm, tradePathDependence, triggerEventBars, type PropFirmReport } from "@stratforge/engine";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { getActiveWorkspaceId, getState, subscribe, type AppState } from "../store.js";

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "∞");
const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

function verdictColor(score: number): string {
  if (score >= 70) return "var(--good)";
  if (score >= 55) return "var(--accent)";
  return "var(--bad)";
}

export function StatsPanel() {
  const [snap, setSnap] = useState<AppState>(getState());
  const [target, setTarget] = useState(8);
  const [maxDD, setMaxDD] = useState(10);
  const [trailing, setTrailing] = useState(true);
  const [regimeAwareProp, setRegimeAwareProp] = useState(true);
  const [propFirm, setPropFirm] = useState<PropFirmReport | null>(null);

  const wsRef = useRef(getActiveWorkspaceId());

  useEffect(
    () =>
      subscribe((s, workspaceId) => {
        if (wsRef.current !== workspaceId) {
          wsRef.current = workspaceId;
          setPropFirm(null);
        }
        setSnap(s);
      }),
    []
  );

  const result = snap.result;
  const stats = result?.stats ?? null;
  const entryDiagnostics = result ? analyzeEntryEvents(result.trades, result.timeline.length) : null;
  const pathDependence = result ? tradePathDependence(result.trades, 10_000, 500) : null;
  const regimes =
    result && snap.candles.length > 0 && result.trades.length > 0
      ? analyzeRegimes(snap.candles, result.trades)
      : null;
  const benchmark = result && snap.candles.length > 1 ? buyAndHoldStats(snap.candles) : null;
  const benchmarkVerdict = stats && benchmark ? relativeVerdict(stats, benchmark) : null;
  const robustness = useMemo(() => {
    if (!result || snap.candles.length < 2) return null;
    const dt = snap.candles[1].time - snap.candles[0].time || 3600;
    return assessRobustness(result.timeline, snap.candles, {
      trials: 1,
      periodsPerYear: SECONDS_PER_YEAR / dt,
      iterations: 500,
      trades: result.trades,
      initialCapital: 10_000,
    });
  }, [result, snap.candles]);
  // Outcome diagnostics are heavier (bootstrap), so memoize on the inputs that change them.
  const outcomes = useMemo(() => {
    const spec = snap.spec;
    if (!result || !spec || snap.candles.length === 0) return null;
    const conds = spec.process?.trigger?.length ? spec.process.trigger : spec.entry;
    const ctx = buildIndicatorContext(spec, snap.candles);
    const eventBars = triggerEventBars(conds, snap.candles, ctx);
    if (eventBars.length === 0) return null;
    return outcomeReport(snap.candles, eventBars);
  }, [result, snap.spec, snap.candles]);
  const verdict = robustness && benchmarkVerdict
    ? robustnessVerdict({ robustness, benchmark: benchmarkVerdict, outcomeReport: outcomes, regimeAnalysis: regimes, propFirm })
    : null;

  const runMC = () => {
    if (!result || result.trades.length < 5) return;
    setPropFirm(
      simulatePropFirm(
        result.trades,
        { ...DEFAULT_PROP_FIRM_RULESET, profitTargetPct: target, maxDrawdownPct: maxDD, trailing },
        { iterations: 3000, seed: 20260616, regimeAware: regimeAwareProp, candles: snap.candles }
      )
    );
  };

  return (
    <div className="cli-panel" style={{ overflowY: "auto" }}>
      <span className="cli-prompt">strategy statistics</span>

      {!stats ? (
        <div className="cli-hint">No backtest yet — build and run a strategy in the Strategy tab.</div>
      ) : (
        <>
          <div className="cli-box">
            <strong>Performance</strong>
            {verdict && (
              <div className="kpi-banner" style={{ borderColor: verdictColor(verdict.score), flexDirection: "column", alignItems: "stretch" }}>
                <div>
                  <span className="kpi-banner-label" style={{ color: verdictColor(verdict.score) }}>Robustness grade {verdict.grade} · {verdict.score}/100</span>
                  <span className="cli-hint"> Grades fragility, not future returns.</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1.5fr .5fr .5fr 2fr", gap: "2px 10px", marginTop: 6, fontSize: 11 }}>
                  <span style={{ color: "var(--text-dim)" }}>component</span>
                  <span style={{ color: "var(--text-dim)", textAlign: "right" }}>score</span>
                  <span style={{ color: "var(--text-dim)", textAlign: "right" }}>weight</span>
                  <span style={{ color: "var(--text-dim)" }}>note</span>
                  {verdict.components.map((c) => (
                    <Fragment key={c.label}>
                      <span>{c.label}</span>
                      <span style={{ textAlign: "right", color: c.score >= 70 ? "var(--good)" : c.score < 45 ? "var(--bad)" : "var(--text)" }}>{c.score}</span>
                      <span style={{ textAlign: "right" }}>{c.weight}%</span>
                      <span style={{ color: "var(--text-dim)" }}>{c.value} · {c.note}</span>
                    </Fragment>
                  ))}
                </div>
                <span className="cli-hint">{verdict.caveats.slice(0, 3).join(" ")}</span>
              </div>
            )}
            <div className="kpi-grid">
              <div className="kpi-card"><span className="kpi-label">EV / trade</span><b style={{ color: stats.expectancy > 0 ? "var(--good)" : "var(--bad)" }}>{stats.expectancy}</b></div>
              <div className="kpi-card"><span className="kpi-label">EV % / trade</span><b style={{ color: stats.expectancyPct > 0 ? "var(--good)" : "var(--bad)" }}>{stats.expectancyPct}%</b></div>
              <div className="kpi-card"><span className="kpi-label">Win probability</span><b>{stats.winProbability}%</b></div>
              <div className="kpi-card"><span className="kpi-label">Payoff ratio</span><b>{fmt(stats.payoffRatio)}</b></div>
              <div className="kpi-card"><span className="kpi-label">Path dependence</span><b style={{ color: pathDependence && pathDependence.score >= 60 ? "var(--bad)" : "var(--text)" }}>{pathDependence?.score ?? 0}/100</b></div>
              <div className="kpi-card"><span className="kpi-label">Entry clustering</span><b style={{ color: entryDiagnostics && entryDiagnostics.clusteredTradePct > 40 ? "var(--bad)" : "var(--text)" }}>{entryDiagnostics?.clusteredTradePct ?? 0}%</b></div>
              <div className="kpi-card"><span className="kpi-label">Trades</span><b>{stats.trades}</b></div>
              <div className="kpi-card"><span className="kpi-label">Max drawdown</span><b>{stats.maxDrawdownPct}%</b></div>
              <div className="kpi-card"><span className="kpi-label">Total return</span><b>{stats.totalReturnPct}%</b></div>
              <div className="kpi-card"><span className="kpi-label">CAGR</span><b>{stats.cagrPct}%</b></div>
              <div className="kpi-card"><span className="kpi-label">Profit factor</span><b>{fmt(stats.profitFactor)}</b></div>
              <div className="kpi-card" title={sharpeLabel(stats.annualizedSharpe)}><span className="kpi-label">Sharpe</span><b>{stats.annualizedSharpe}</b></div>
              <div className="kpi-card"><span className="kpi-label">Sortino</span><b>{stats.sortino}</b></div>
            </div>
            {benchmark && benchmarkVerdict && (
              <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: "2px 10px", fontSize: 12, alignItems: "center" }}>
                  <span style={{ color: "var(--text-dim)" }} />
                  <span style={{ color: "var(--text-dim)", textAlign: "right" }}>return</span>
                  <span style={{ color: "var(--text-dim)", textAlign: "right" }}>Sharpe</span>
                  <span style={{ color: "var(--text-dim)", textAlign: "right" }}>max DD</span>
                  <span>Strategy</span>
                  <span style={{ textAlign: "right" }}>{stats.totalReturnPct}%</span>
                  <span style={{ textAlign: "right" }}>{stats.annualizedSharpe}</span>
                  <span style={{ textAlign: "right" }}>{stats.maxDrawdownPct}%</span>
                  <span style={{ color: "var(--text-dim)" }}>Buy &amp; hold</span>
                  <span style={{ textAlign: "right", color: "var(--text-dim)" }}>{benchmark.totalReturnPct}%</span>
                  <span style={{ textAlign: "right", color: "var(--text-dim)" }}>{benchmark.annualizedSharpe}</span>
                  <span style={{ textAlign: "right", color: "var(--text-dim)" }}>{benchmark.maxDrawdownPct}%</span>
                </div>
                <div className="kpi-banner" style={{ borderColor: benchmarkVerdict.beatsBuyHold ? "var(--good)" : "var(--bad)", marginTop: 8 }}>
                  <span className="kpi-banner-label" style={{ color: benchmarkVerdict.beatsBuyHold ? "var(--good)" : "var(--bad)" }}>{benchmarkVerdict.beatsBuyHold ? "Beats buy & hold" : "Underperforms buy & hold"}</span>
                  <span className="cli-hint">{benchmarkVerdict.note}</span>
                </div>
              </div>
            )}
            {entryDiagnostics && pathDependence && (entryDiagnostics.warnings.length > 0 || pathDependence.warning || stats.expectancy <= 0) && (
              <div style={{ borderLeft: "2px solid var(--accent)", background: "var(--bg-2)", padding: "7px 9px", marginTop: 8, fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {stats.expectancy <= 0 && <div><span style={{ color: "var(--text-dim)" }}>⚠ </span>EV is non-positive after costs. Do not treat win rate as evidence of an edge.</div>}
                {pathDependence.warning && <div><span style={{ color: "var(--text-dim)" }}>⚠ </span>{pathDependence.warning}</div>}
                {entryDiagnostics.warnings.map((w, i) => (<div key={i}><span style={{ color: "var(--text-dim)" }}>⚠ </span>{w}</div>))}
              </div>
            )}
          </div>

          <div className="cli-box">
            <strong>Monte Carlo &amp; prop-firm check</strong>
            <span className="cli-hint">Resamples your trade sequence against a challenge account. This measures rule convexity, not proof of live edge.</span>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)" }}>
              <label>profit target % <input className="cli-input" style={{ width: 56, padding: "4px 6px" }} type="number" value={target} onChange={(e) => setTarget(+e.target.value || 8)} /></label>
              <label>max drawdown % <input className="cli-input" style={{ width: 56, padding: "4px 6px" }} type="number" value={maxDD} onChange={(e) => setMaxDD(+e.target.value || 10)} /></label>
              <label style={{ display: "flex", alignItems: "center", gap: 5 }}><input type="checkbox" checked={trailing} onChange={(e) => setTrailing(e.target.checked)} /> trailing DD</label>
              <label style={{ display: "flex", alignItems: "center", gap: 5 }}><input type="checkbox" checked={regimeAwareProp} onChange={(e) => setRegimeAwareProp(e.target.checked)} /> regime-aware</label>
              <button className="cli-btn" style={{ padding: "5px 12px" }} onClick={runMC}>run {stats.trades >= 5 ? "" : "(need ≥5 trades)"}</button>
            </div>
            {propFirm && (
              <div className="cli-stats" style={{ borderTop: "1px solid var(--border)", marginTop: 4 }}>
                <span style={{ color: propFirm.pPass >= 60 ? "var(--good)" : "var(--accent)", fontWeight: 700 }}>prop-firm pass rate {propFirm.pPass.toFixed(1)}%</span> over {propFirm.iterations} simulations
                <br />
                buckets pass/fail/timeout <b>{propFirm.outcomeBuckets.pass.toFixed(1)}%</b> / <b>{propFirm.outcomeBuckets.fail.toFixed(1)}%</b> / <b>{propFirm.outcomeBuckets.timeout.toFixed(1)}%</b>
                <br />
                net EV/account <b style={{ color: propFirm.netEvPerAccount >= 0 ? "var(--good)" : "var(--bad)" }}>{propFirm.netEvPerAccount}</b> · challenges to fund <b>{fmt(propFirm.eChallengesToFund)}</b> · days to pass <b>{fmt(propFirm.eDaysToPass)}</b>
                <br />
                geometry: win <b>{propFirm.riskGeometry.winRatePct}%</b> · avg RR <b>{fmt(propFirm.riskGeometry.avgRR)}</b> · PnL σ <b>{propFirm.riskGeometry.pnlStdDev}</b>
                {propFirm.regimeAware && <><br />regime-aware <b>{propFirm.regimeAware.enabled ? "on" : "fallback"}</b>{propFirm.regimeAware.enabled && <> · states <b>{propFirm.regimeAware.states.length}</b></>}</>}
                {propFirm.warnings.length > 0 && <><br /><span style={{ color: "var(--text-dim)" }}>⚠ {propFirm.warnings[0]}</span></>}
              </div>
            )}
          </div>

          {regimes && regimes.tradesClassified > 0 && (
            <div className="cli-box">
              <strong>Regime breakdown</strong>
              <span className="cli-hint">
                Performance split by market regime (trend × volatility) at each trade's entry. An edge that lives in
                one regime is usually overfit to it.
              </span>
              <div className="cli-stats" style={{ borderTop: "1px solid var(--border)", marginTop: 4, fontSize: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.4fr repeat(5, 1fr)", gap: "2px 10px", alignItems: "center" }}>
                  <span style={{ color: "var(--text-dim)" }}>regime</span>
                  <span style={{ color: "var(--text-dim)", textAlign: "right" }}>bar %</span>
                  <span style={{ color: "var(--text-dim)", textAlign: "right" }}>trades</span>
                  <span style={{ color: "var(--text-dim)", textAlign: "right" }}>win %</span>
                  <span style={{ color: "var(--text-dim)", textAlign: "right" }}>PnL</span>
                  <span style={{ color: "var(--text-dim)", textAlign: "right" }}>PnL %</span>
                  {regimes.regimes
                    .filter((r) => r.trades > 0)
                    .map((r) => (
                      <Fragment key={r.label}>
                        <span>{r.label}</span>
                        <span style={{ textAlign: "right" }}>{r.barPct}</span>
                        <span style={{ textAlign: "right" }}>{r.trades}</span>
                        <span style={{ textAlign: "right" }}>{r.winRatePct}</span>
                        <span style={{ textAlign: "right", color: r.totalPnl > 0 ? "var(--good)" : r.totalPnl < 0 ? "var(--bad)" : "var(--text)" }}>{r.totalPnl}</span>
                        <span style={{ textAlign: "right" }}>{r.pnlSharePct}%</span>
                      </Fragment>
                    ))}
                </div>
                <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
                  {regimes.concentrationPct > 0 && <>profit concentration <b style={{ color: regimes.concentrationPct > 70 ? "var(--bad)" : "var(--text)" }}>{regimes.concentrationPct}%</b> · </>}
                  profitable in <b>{regimes.profitableRegimes}</b> regime(s)
                  {regimes.tradesUnclassified > 0 && <> · {regimes.tradesUnclassified} trade(s) in warm-up excluded</>}
                </div>
              </div>
              {regimes.warnings.length > 0 && (
                <div style={{ borderLeft: "2px solid var(--accent)", background: "var(--bg-2)", padding: "7px 9px", marginTop: 8, fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  {regimes.warnings.map((w, i) => (<div key={i}><span style={{ color: "var(--text-dim)" }}>⚠ </span>{w}</div>))}
                </div>
              )}
            </div>
          )}

          {outcomes && (
            <div className="cli-box">
              <strong>Event outcomes <span className="cli-hint" style={{ fontWeight: 400 }}>(triple-barrier, long-direction)</span></strong>
              <span className="cli-hint">
                What happens after the trigger fires — expected return per event with a bootstrap 95% CI, vs. random
                entries and market drift. A CI that excludes zero is a real signed edge; it must also beat drift and
                survive into the second half.
              </span>
              <div className="cli-stats" style={{ borderTop: "1px solid var(--border)", marginTop: 4, fontSize: 12, lineHeight: 1.8 }}>
                <div>
                  EV / event{" "}
                  <b style={{ color: outcomes.expectancy.excludesZero ? (outcomes.expectancy.ev > 0 ? "var(--good)" : "var(--bad)") : "var(--text)" }}>{outcomes.expectancy.ev}%</b>
                  {" "}· 95% CI <b>[{outcomes.expectancy.ciLow}, {outcomes.expectancy.ciHigh}]</b>{" "}
                  {outcomes.expectancy.excludesZero ? <span style={{ color: "var(--good)" }}>excludes 0</span> : <span style={{ color: "var(--bad)" }}>spans 0</span>}
                </div>
                <div style={{ color: "var(--text-dim)" }}>
                  {outcomes.events} events ({outcomes.eventRatePct}% of bars) · tp/sl/time {outcomes.labels.tp}/{outcomes.labels.sl}/{outcomes.labels.time}
                </div>
                <div style={{ color: "var(--text-dim)" }}>
                  baseline: drift {outcomes.baseline.driftPct}% · random EV {outcomes.baseline.random.ev}% · stability 1st {outcomes.crossPeriod.firstHalf.excludesZero ? "edge" : "—"} / 2nd {outcomes.crossPeriod.secondHalf.excludesZero ? "edge" : "—"}
                </div>
              </div>
              {outcomes.warnings.length > 0 && (
                <div style={{ borderLeft: "2px solid var(--accent)", background: "var(--bg-2)", padding: "7px 9px", marginTop: 8, fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  {outcomes.warnings.map((w, i) => (<div key={i}><span style={{ color: "var(--text-dim)" }}>⚠ </span>{w}</div>))}
                </div>
              )}
            </div>
          )}

          {snap.customStats && snap.customStats.length > 0 && (
            <div className="cli-box">
              <strong>Custom tests <span className="cli-hint" style={{ fontWeight: 400 }}>(added by the AI analyst)</span></strong>
              <div className="cli-stats" style={{ borderTop: "none", paddingTop: 0, lineHeight: 2 }}>
                {snap.customStats.map((s, i) => (
                  <div key={i}>{s.name} · <b>{s.value}</b></div>
                ))}
              </div>
            </div>
          )}
          <span className="cli-hint">Ask the AI analyst to run a specific test (e.g. "add a Sharpe confidence interval") and it appears here.</span>
        </>
      )}
    </div>
  );
}
