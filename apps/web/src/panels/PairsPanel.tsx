/**
 * Pairs / stat-arb panel. Loads two symbols, tests cointegration (Engle-Granger),
 * and backtests the spread (long one leg, short the other) with the engine's
 * pairs backtester. Honest verdict first; trade it only if it holds up.
 */
import { binanceKlinesUrl, parseBinanceKlines, validateCandles } from "@stratforge/data-import";
import { engleGranger, runPairsBacktest, type BacktestStats, type CointegrationResult } from "@stratforge/engine";
import { useState } from "react";

const VERDICT_COLOR: Record<CointegrationResult["verdict"], string> = {
  cointegrated: "var(--good)",
  "not-cointegrated": "var(--text-dim)",
  "insufficient-data": "var(--text-faint)",
};

export function PairsPanel() {
  const [symA, setSymA] = useState("ETHUSDT");
  const [symB, setSymB] = useState("BTCUSDT");
  const [iv, setIv] = useState("1h");
  const [lookback, setLookback] = useState(60);
  const [entryZ, setEntryZ] = useState(2);
  const [exitZ, setExitZ] = useState(0.5);
  const [status, setStatus] = useState("pick two related symbols, then analyze");
  const [coint, setCoint] = useState<CointegrationResult | null>(null);
  const [bt, setBt] = useState<{ stats: BacktestStats; trades: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchCandles = async (sym: string) => {
    const r = await fetch(binanceKlinesUrl(sym, iv, 1000));
    if (!r.ok) throw new Error(`${sym}: binance ${r.status}`);
    return validateCandles(parseBinanceKlines(await r.json())).candles;
  };

  const analyze = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(`loading ${symA} & ${symB}…`);
    setCoint(null);
    setBt(null);
    try {
      const [A, B] = await Promise.all([fetchCandles(symA), fetchCandles(symB)]);
      // Inner-join on time for the cointegration test (A = x, B = y → spread = B − β·A).
      const mapB = new Map(B.map((c) => [c.time, c.close]));
      const xs: number[] = [];
      const ys: number[] = [];
      for (const c of A) {
        const bb = mapB.get(c.time);
        if (bb !== undefined) { xs.push(c.close); ys.push(bb); }
      }
      if (xs.length < 60) {
        setStatus(`only ${xs.length} overlapping bars — need ≥ 60 (try a longer timeframe)`);
        return;
      }
      const cg = engleGranger(xs, ys);
      setCoint(cg);
      const res = runPairsBacktest(
        A,
        B,
        { lookback, entryZ, exitZ, hedgeRatio: cg.hedgeRatio },
        { feePct: 0.1, slippagePct: 0.05 }
      );
      setBt({ stats: res.stats, trades: res.trades.length });
      setStatus(`${xs.length} aligned bars · spread tested`);
    } catch (e) {
      setStatus(`error: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cli-panel" style={{ overflowY: "auto" }}>
      <span className="cli-prompt">pairs / statistical arbitrage</span>

      <div className="cli-box" style={{ gap: 6 }}>
        <strong>Pair</strong>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input className="cli-input" style={{ flex: 1, minWidth: 90 }} value={symA} onChange={(e) => setSymA(e.target.value.toUpperCase())} placeholder="symbol A" />
          <span style={{ color: "var(--text-dim)", alignSelf: "center" }}>vs</span>
          <input className="cli-input" style={{ flex: 1, minWidth: 90 }} value={symB} onChange={(e) => setSymB(e.target.value.toUpperCase())} placeholder="symbol B" />
          <select className="cli-select" value={iv} onChange={(e) => setIv(e.target.value)}>
            {["15m", "1h", "4h", "1d"].map((i) => <option key={i}>{i}</option>)}
          </select>
        </div>
        <span className="cli-hint">Binance pairs (v1). Spread = B − β·A; β is estimated by cointegration.</span>
      </div>

      <div className="cli-box" style={{ gap: 6 }}>
        <strong>Spread signal</strong>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)" }}>
          <label>z-lookback <input className="cli-input" style={{ width: 60, padding: "4px 6px" }} type="number" value={lookback} onChange={(e) => setLookback(Math.max(10, +e.target.value || 60))} /></label>
          <label>entry z <input className="cli-input" style={{ width: 56, padding: "4px 6px" }} type="number" step="0.1" value={entryZ} onChange={(e) => setEntryZ(+e.target.value || 2)} /></label>
          <label>exit z <input className="cli-input" style={{ width: 56, padding: "4px 6px" }} type="number" step="0.1" value={exitZ} onChange={(e) => setExitZ(+e.target.value || 0.5)} /></label>
        </div>
      </div>

      <button className="cli-btn" onClick={analyze} disabled={busy}>{busy ? "analyzing…" : "analyze pair"}</button>

      {coint && (
        <div style={{ borderLeft: `2px solid ${VERDICT_COLOR[coint.verdict]}`, background: "var(--bg-2)", padding: "8px 10px" }}>
          <div style={{ color: VERDICT_COLOR[coint.verdict], fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            {coint.verdict.replace("-", " ")}
          </div>
          <div className="cli-stats" style={{ borderTop: "none", paddingTop: 4 }}>
            hedge ratio β <b>{coint.hedgeRatio.toFixed(3)}</b> · half-life <b>{Number.isFinite(coint.halfLifeBars) ? `${coint.halfLifeBars.toFixed(1)} bars` : "∞"}</b> · ADF <b>{coint.adf.statistic.toFixed(2)}</b>
          </div>
          <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
            {coint.reasons.map((r, i) => (<div key={i}><span style={{ color: "var(--text-dim)" }}>❯ </span>{r}</div>))}
          </div>
        </div>
      )}

      {bt && (
        <div className="cli-stats">
          <span className="cli-prompt" style={{ display: "block", marginBottom: 4 }}>spread backtest (with costs)</span>
          return <b>{bt.stats.totalReturnPct}%</b> · sharpe <b>{bt.stats.annualizedSharpe}</b> · max-dd <b>{bt.stats.maxDrawdownPct}%</b> · trades <b>{bt.trades}</b> · win-rate <b>{bt.stats.winRate}%</b>
          {coint && coint.verdict !== "cointegrated" && (
            <div style={{ color: "var(--text-dim)", marginTop: 4 }}>⚠ pair isn't cointegrated — these results are likely not tradeable; the spread can drift apart.</div>
          )}
        </div>
      )}

      <span className="cli-prompt" style={{ fontSize: 12 }}>{status}</span>
    </div>
  );
}
