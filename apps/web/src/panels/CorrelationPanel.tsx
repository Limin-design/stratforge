import {
  assessCorrelation,
  factorFromCsv,
  trimLeadingNaN,
  type CorrelationAssessment,
} from "@stratforge/engine";
import { useEffect, useRef, useState } from "react";
import { getActiveWorkspaceId, getState, subscribe } from "../store.js";

const SAMPLE = `# paste an external series: "date,value" or "epoch,value" (or bare values, one per line)
2024-01-01,72.1
2024-02-01,74.3
2024-03-01,69.8`;

const VERDICT_STYLE: Record<CorrelationAssessment["verdict"], { label: string; color: string }> = {
  real: { label: "REAL", color: "var(--white)" },
  weak: { label: "WEAK / INCONCLUSIVE", color: "var(--text-dim)" },
  "likely-spurious": { label: "LIKELY SPURIOUS", color: "var(--white)" },
  "insufficient-data": { label: "INSUFFICIENT DATA", color: "var(--text-faint)" },
};

export function CorrelationPanel() {
  const [text, setText] = useState(SAMPLE);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CorrelationAssessment | null>(null);
  // Every test in the active workspace raises the multiple-testing bar.
  const hypothesesRef = useRef(0);
  const wsRef = useRef(getActiveWorkspaceId());

  useEffect(
    () =>
      subscribe((_s, workspaceId) => {
        if (wsRef.current !== workspaceId) {
          wsRef.current = workspaceId;
          hypothesesRef.current = 0;
          setResult(null);
          setError(null);
        }
      }),
    []
  );

  const run = () => {
    setError(null);
    const { candles, datasetName } = getState();
    if (candles.length < 30) {
      setError("load a dataset first (data-hub tab) — need at least 30 bars to test");
      setResult(null);
      return;
    }
    const aligned = factorFromCsv(
      text,
      candles.map((c) => c.time)
    );
    const closes = candles.map((c) => c.close);
    const { a: factor, b: price } = trimLeadingNaN(aligned, closes);
    if (factor.length < 30) {
      setError(`only ${factor.length} overlapping points after aligning to ${datasetName} — need ≥ 30`);
      setResult(null);
      return;
    }
    hypothesesRef.current += 1;
    setResult(assessCorrelation(factor, price, { priorHypotheses: hypothesesRef.current }));
  };

  const r = result;
  const v = r ? VERDICT_STYLE[r.verdict] : null;

  return (
    <div className="cli-panel">
      <span className="cli-prompt">paste a factor series, then test its correlation with price</span>
      <textarea
        className="cli-textarea"
        style={{ flex: 1, fontSize: 12, minHeight: 90 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <button className="cli-btn" onClick={run}>
        test correlation
      </button>
      {error && <div className="cli-error">{error}</div>}

      {r && v && (
        <>
          <div
            style={{
              borderLeft: `2px solid ${v.color}`,
              background: "var(--bg-2)",
              padding: "8px 10px",
            }}
          >
            <div style={{ color: v.color, fontWeight: 700, letterSpacing: "0.04em" }}>{v.label}</div>
            <div className="cli-stats" style={{ borderTop: "none", paddingTop: 4 }}>
              corr(levels) <b>{r.pearsonLevels.toFixed(2)}</b> · corr(changes){" "}
              <b>{r.pearsonChanges.toFixed(2)}</b> · spearman <b>{r.spearman.toFixed(2)}</b>
              <br />
              best lag <b>{r.bestLag}</b> ({r.bestLagCorr.toFixed(2)}) · adj p-value{" "}
              <b>{r.pValueAdjusted.toFixed(3)}</b>
              <br />
              n <b>{r.n}</b> · hypotheses tested this session <b>{r.hypothesesTested}</b>
            </div>
          </div>
          <div
            style={{
              fontSize: 12,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              color: "var(--text)",
            }}
          >
            {r.reasons.map((reason, i) => (
              <div key={i}>
                <span style={{ color: "var(--text-dim)" }}>❯ </span>
                {reason}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
