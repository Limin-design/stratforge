import type { OutcomeReport } from "./outcomes.js";
import type { PropFirmReport } from "./propfirm.js";
import type { RegimeAnalysis } from "./regimes.js";
import type { RobustnessReport } from "./robustness.js";
import type { RelativeVerdict } from "./stats.js";

export type VerdictGrade = "A" | "B" | "C" | "D" | "F";

export interface VerdictComponent {
  label: string;
  value: string | number;
  /** Component weight as a share of the total score, in percentage points. */
  weight: number;
  /** Component score, 0–100. */
  score: number;
  note: string;
}

export interface RobustnessVerdict {
  grade: VerdictGrade;
  score: number;
  components: VerdictComponent[];
  caveats: string[];
}

export interface RobustnessVerdictInput {
  robustness: RobustnessReport;
  benchmark: RelativeVerdict;
  outcomeReport?: OutcomeReport | null;
  regimeAnalysis?: RegimeAnalysis | null;
  propFirm?: PropFirmReport | null;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number) => `${round1(n * 100)}%`;

function grade(score: number): VerdictGrade {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

function probabilityScore(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return clamp(((p - 0.5) / 0.49) * 100);
}

function permutationScore(pValue: number): number {
  if (!Number.isFinite(pValue)) return 0;
  if (pValue <= 0.01) return 100;
  if (pValue <= 0.05) return 80 + ((0.05 - pValue) / 0.04) * 20;
  if (pValue <= 0.2) return 35 + ((0.2 - pValue) / 0.15) * 45;
  return clamp(35 - (pValue - 0.2) * 80);
}

function degradationScore(degradation: number): number {
  if (!Number.isFinite(degradation)) return 0;
  if (degradation <= 0) return 100;
  if (degradation <= 0.25) return 85;
  if (degradation <= 0.5) return 65;
  if (degradation <= 1) return 35;
  return clamp(35 - (degradation - 1) * 20);
}

function regimeScore(regimeAnalysis?: RegimeAnalysis | null): { score: number; value: string; note: string; caveat?: string } {
  if (!regimeAnalysis || regimeAnalysis.tradesClassified === 0) {
    return {
      score: 45,
      value: "not run",
      note: "No regime attribution supplied; concentration risk is unknown.",
      caveat: "Regime concentration was not fully measured, so the verdict is provisional.",
    };
  }
  const concentrationPenalty = clamp((regimeAnalysis.concentrationPct - 35) * 1.4, 0, 55);
  const breadthPenalty = regimeAnalysis.profitableRegimes >= 3 ? 0 : regimeAnalysis.profitableRegimes === 2 ? 10 : 25;
  const score = clamp(100 - concentrationPenalty - breadthPenalty);
  return {
    score,
    value: `${regimeAnalysis.concentrationPct}% / ${regimeAnalysis.profitableRegimes} profitable`,
    note:
      score >= 70
        ? "Profits are not dominated by one obvious regime."
        : "Profit concentration suggests the edge may be regime-specific or overfit.",
  };
}

function outcomeScore(outcomeReport?: OutcomeReport | null): { score: number; value: string; note: string; caveat?: string } {
  if (!outcomeReport) {
    return {
      score: 45,
      value: "not run",
      note: "Event-level EV CI was not supplied; trigger quality is unknown.",
      caveat: "Event outcome confidence was not fully measured, so the verdict is provisional.",
    };
  }
  const ev = outcomeReport.expectancy.ev;
  const excludesZero = outcomeReport.expectancy.excludesZero;
  const beatsDrift = ev > outcomeReport.baseline.driftPct;
  const secondHalfStable = outcomeReport.crossPeriod.secondHalf.excludesZero;
  const score = clamp(
    (excludesZero ? 55 : 15) +
      (ev > 0 ? 15 : -15) +
      (beatsDrift ? 15 : 0) +
      (secondHalfStable ? 15 : 0)
  );
  return {
    score,
    value: `${ev}% CI [${outcomeReport.expectancy.ciLow}, ${outcomeReport.expectancy.ciHigh}]`,
    note:
      excludesZero && ev > 0 && beatsDrift
        ? "Event EV has a positive CI and beats drift."
        : "Event EV is weak, unsigned, or no better than market drift.",
  };
}

function propFirmScore(propFirm?: PropFirmReport | null): { score: number; value: string; note: string; caveat?: string } {
  if (!propFirm) {
    return {
      score: 50,
      value: "not run",
      note: "Prop-firm simulation omitted; this does not affect edge evidence much.",
    };
  }
  const score = clamp((propFirm.pPass - 20) * 1.2 + (propFirm.netEvPerAccount > 0 ? 25 : 0));
  return {
    score,
    value: `${propFirm.pPass}% pass / EV ${propFirm.netEvPerAccount}`,
    note: "Low weight: prop odds measure payout geometry, not market edge.",
    caveat: "Prop-firm pass probability is not evidence of a live trading edge.",
  };
}

/**
 * Composite robustness grade. This grades fragility evidence, not future returns.
 * Components are intentionally transparent so the UI/agent can show exactly why
 * a strategy received its score.
 */
export function robustnessVerdict(inputs: RobustnessVerdictInput): RobustnessVerdict {
  const { robustness, benchmark, outcomeReport, regimeAnalysis, propFirm } = inputs;
  const sharpeProb = robustness.sharpe.deflatedSharpe ?? robustness.sharpe.probabilisticSharpe;
  const sharpeLabel = robustness.sharpe.deflatedSharpe === undefined ? "Probabilistic Sharpe" : "Deflated Sharpe";
  const regime = regimeScore(regimeAnalysis);
  const outcome = outcomeScore(outcomeReport);
  const prop = propFirmScore(propFirm);

  const components: VerdictComponent[] = [
    {
      label: sharpeLabel,
      value: pct(sharpeProb),
      weight: 18,
      score: round1(probabilityScore(sharpeProb)),
      note:
        robustness.sharpe.deflatedSharpe === undefined
          ? "Probability Sharpe is above zero before multiple-testing deflation."
          : `Deflated for ${robustness.sharpe.trials} tried variant(s).`,
    },
    {
      label: "Timing permutation p-value",
      value: robustness.permutation.pValue,
      weight: 14,
      score: round1(permutationScore(robustness.permutation.pValue)),
      note: "Low p-value means the entry timing beat same-density random exposure.",
    },
    {
      label: "OOS Sharpe degradation",
      value: round1(robustness.outOfSample.sharpeDegradation),
      weight: 14,
      score: round1(degradationScore(robustness.outOfSample.sharpeDegradation)),
      note: "Large in-sample to out-of-sample decay is classic overfit behavior.",
    },
    {
      label: "Walk-forward consistency",
      value: pct(robustness.walkForward.profitableFraction),
      weight: 12,
      score: round1(clamp(robustness.walkForward.profitableFraction * 100)),
      note: "Share of contiguous windows that stayed profitable.",
    },
    {
      label: "Path-dependence risk",
      value: `${robustness.pathDependence.score}/100 fragility`,
      weight: 10,
      score: round1(clamp(100 - robustness.pathDependence.score)),
      note: "Penalizes strategies whose drawdown depends heavily on trade order.",
    },
    {
      label: "Beats buy & hold",
      value: benchmark.beatsBuyHold ? `yes, ${benchmark.excessReturnPct}% excess` : `no, ${benchmark.excessReturnPct}% excess`,
      weight: 12,
      score: benchmark.beatsBuyHold ? round1(clamp(70 + Math.max(0, benchmark.excessSharpe) * 10)) : 10,
      note: benchmark.note,
    },
    {
      label: "Event EV CI excludes zero",
      value: outcome.value,
      weight: 10,
      score: round1(outcome.score),
      note: outcome.note,
    },
    {
      label: "Regime concentration",
      value: regime.value,
      weight: 8,
      score: round1(regime.score),
      note: regime.note,
    },
    {
      label: "Prop-firm geometry",
      value: prop.value,
      weight: 2,
      score: round1(prop.score),
      note: prop.note,
    },
  ];

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const score = round1(components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight);
  const caveats = [
    "Grades robustness/fragility, not future returns or profitability.",
    "Backtest ≠ live trading.",
    "Fresh out-of-sample or forward validation is required before risking capital.",
    ...(outcome.caveat ? [outcome.caveat] : []),
    ...(regime.caveat ? [regime.caveat] : []),
    ...(prop.caveat ? [prop.caveat] : []),
    ...robustness.warnings,
  ];

  return { grade: grade(score), score, components, caveats: [...new Set(caveats)] };
}
