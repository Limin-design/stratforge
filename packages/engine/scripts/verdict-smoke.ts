/**
 * Phase 5 smoke test: composite robustness verdict.
 * Run with: pnpm --filter @stratforge/engine exec tsx scripts/verdict-smoke.ts
 */
import { robustnessVerdict } from "../src/index.js";
import type { OutcomeReport, RegimeAnalysis, RelativeVerdict, RobustnessReport } from "../src/index.js";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
};

function report(kind: "robust" | "overfit"): RobustnessReport {
  const robust = kind === "robust";
  return {
    sharpe: {
      sharpe: robust ? 0.18 : 0.07,
      annualizedSharpe: robust ? 2.1 : 0.4,
      standardError: 0.02,
      ci95: robust ? [0.14, 0.22] : [0.01, 0.13],
      probabilisticSharpe: robust ? 0.995 : 0.62,
      deflatedSharpe: robust ? 0.982 : 0.38,
      trials: robust ? 4 : 80,
      periods: 600,
      skewness: 0,
      kurtosis: 3,
    },
    permutation: { pValue: robust ? 0.018 : 0.46, realScore: robust ? 0.4 : -0.1, iterations: 500, betterOrEqual: robust ? 8 : 230 },
    pathDependence: {
      score: robust ? 18 : 82,
      iterations: 500,
      worstReturnPct: robust ? 8 : -30,
      medianReturnPct: robust ? 20 : 5,
      bestReturnPct: robust ? 34 : 55,
      worstMaxDrawdownPct: robust ? 12 : 48,
      medianMaxDrawdownPct: robust ? 8 : 25,
      bestMaxDrawdownPct: robust ? 4 : 5,
      warning: robust ? undefined : "Path-dependent result.",
    },
    outOfSample: {
      inSample: { periods: 420, totalReturnPct: robust ? 18 : 70, sharpe: robust ? 0.16 : 0.4 },
      outOfSample: { periods: 180, totalReturnPct: robust ? 10 : -8, sharpe: robust ? 0.14 : -0.1 },
      sharpeDegradation: robust ? 0.02 : 0.5,
    },
    walkForward: {
      folds: [],
      profitableFraction: robust ? 0.8 : 0.2,
      meanSharpe: robust ? 0.15 : -0.02,
    },
    normality: { statistic: 1, pValue: 0.6, skewness: 0, excessKurtosis: 0 },
    warnings: robust ? [] : ["Timing not significant.", "OOS collapse."],
  };
}

function benchmark(kind: "robust" | "overfit"): RelativeVerdict {
  return kind === "robust"
    ? { beatsBuyHold: true, excessReturnPct: 14, excessSharpe: 0.8, note: "Beats buy & hold." }
    : { beatsBuyHold: false, excessReturnPct: -25, excessSharpe: -1.3, note: "Underperforms buy & hold." };
}

function outcome(kind: "robust" | "overfit"): OutcomeReport {
  const robust = kind === "robust";
  const ci = robust
    ? { ev: 0.42, ciLow: 0.2, ciHigh: 0.7, excludesZero: true, n: 80 }
    : { ev: 0.03, ciLow: -0.2, ciHigh: 0.24, excludesZero: false, n: 80 };
  return {
    events: 80,
    eventRatePct: 10,
    labels: { tp: robust ? 42 : 25, sl: robust ? 20 : 35, time: 18 },
    expectancy: ci,
    baseline: { random: { ...ci, ev: robust ? 0.05 : 0.08, excludesZero: false }, driftPct: robust ? 0.03 : 0.05 },
    crossPeriod: { firstHalf: ci, secondHalf: robust ? ci : { ...ci, excludesZero: false } },
    warnings: robust ? [] : ["CI spans zero."],
  };
}

function regimes(kind: "robust" | "overfit"): RegimeAnalysis {
  const robust = kind === "robust";
  return {
    perBar: [],
    regimes: [],
    classifiedBars: 500,
    unclassifiedBars: 0,
    tradesClassified: 80,
    tradesUnclassified: 0,
    concentrationPct: robust ? 34 : 92,
    lossConcentrationPct: robust ? 35 : 80,
    worstRegimeLabel: robust ? null : "down/high",
    profitableRegimes: robust ? 4 : 1,
    warnings: robust ? [] : ["Profit concentrated in one regime."],
  };
}

const strong = robustnessVerdict({
  robustness: report("robust"),
  benchmark: benchmark("robust"),
  outcomeReport: outcome("robust"),
  regimeAnalysis: regimes("robust"),
});

const weak = robustnessVerdict({
  robustness: report("overfit"),
  benchmark: benchmark("overfit"),
  outcomeReport: outcome("overfit"),
  regimeAnalysis: regimes("overfit"),
});

const weightSum = strong.components.reduce((s, c) => s + c.weight, 0);
assert(Math.abs(weightSum - 100) < 1e-9, `component weights should sum to 100, got ${weightSum}`);
assert(strong.components.length >= 8, "verdict should expose component breakdown");
assert(strong.score >= 70 && (strong.grade === "A" || strong.grade === "B"), `robust synthetic should grade high, got ${strong.grade} ${strong.score}`);
assert(weak.score < 55 && (weak.grade === "D" || weak.grade === "F"), `overfit synthetic should grade low, got ${weak.grade} ${weak.score}`);
assert(strong.caveats.some((c) => c.includes("Backtest")), "standing backtest caveat should be present");
assert(strong.caveats.some((c) => c.includes("not future returns")), "standing non-forecast caveat should be present");

console.log("=== Phase 5: robustness verdict smoke ===");
console.log("Robust synthetic:", strong.grade, strong.score);
console.log("Overfit synthetic:", weak.grade, weak.score);
console.log("Components:", strong.components.map((c) => `${c.label}=${c.score}`).join(" | "));
console.log("\nAll verdict smoke checks passed.");
