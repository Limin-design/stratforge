import { mulberry32 } from "./mathstats.js";
import { buildRegimeTransitionModel, classifyRegimes, type RegimeOptions } from "./regimes.js";
import type { Candle, Trade } from "./types.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PropFirmRuleset {
  startingBalance: number;
  profitTargetPct: number;
  maxDrawdownPct: number;
  trailing: boolean;
  dailyDrawdownPct?: number;
  minTradingDays?: number;
  maxTradingDays?: number;
  profitSplitPct: number;
  payoutCadenceDays: number;
  challengeFee: number;
  activationFee?: number;
}

export interface PropFirmSimulationOptions {
  iterations?: number;
  seed?: number;
  regimeAware?: boolean;
  candles?: Candle[];
  regimeOptions?: RegimeOptions;
  tradesPerDay?: number;
  fundedDays?: number;
}

export interface PropFirmReport {
  ruleset: PropFirmRuleset;
  iterations: number;
  tradesUsed: number;
  pPass: number;
  eChallengesToFund: number;
  eDaysToPass: number;
  eDaysToFirstPayout: number;
  ePayoutGivenFunded: number;
  netEvPerAccount: number;
  outcomeBuckets: { pass: number; fail: number; timeout: number };
  funded: {
    pFirstPayout: number;
    medianPayout: number;
    p5Payout: number;
    p95Payout: number;
  };
  regimeAware?: {
    enabled: boolean;
    states: string[];
    tradesUsed: number;
    steadyStatePct: Record<string, number>;
    warning?: string;
  };
  riskGeometry: RiskGeometry;
  warnings: string[];
}

export interface RiskGeometry {
  winRatePct: number;
  avgRR: number;
  pnlStdDev: number;
  avgWin: number;
  avgLoss: number;
  guidance: string;
}

interface ChallengePath {
  outcome: "pass" | "fail" | "timeout";
  days: number;
}

interface PnlSamplerPlan {
  newPathSampler: () => () => number;
  tradesUsed: number;
  regimeAware?: PropFirmReport["regimeAware"];
  warning?: string;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function scaleTradePnl(trade: Trade, startingBalance: number): number {
  return (trade.pnlPct / 100) * startingBalance;
}

function sampleIndex(probs: number[], rng: () => number): number {
  let r = rng();
  for (let i = 0; i < probs.length; i++) {
    r -= probs[i];
    if (r <= 0) return i;
  }
  return Math.max(0, probs.length - 1);
}

function iidSamplerPlan(pnls: number[], rng: () => number): PnlSamplerPlan {
  return {
    tradesUsed: pnls.length,
    newPathSampler: () => () => pnls[Math.floor(rng() * pnls.length)],
  };
}

function regimeSamplerPlan(trades: Trade[], rules: PropFirmRuleset, opts: PropFirmSimulationOptions, rng: () => number): PnlSamplerPlan {
  const fallbackPnls = trades.map((t) => scaleTradePnl(t, rules.startingBalance)).filter(Number.isFinite);
  if (!opts.regimeAware) return iidSamplerPlan(fallbackPnls, rng);
  if (!opts.candles || opts.candles.length === 0) {
    return { ...iidSamplerPlan(fallbackPnls, rng), warning: "regimeAware requested but no candles were supplied; used ordinary trade bootstrap." };
  }

  const perBar = classifyRegimes(opts.candles, opts.regimeOptions);
  const labels: string[] = [];
  const pnlByRegime = new Map<string, number[]>();
  for (const t of trades) {
    const regime = perBar[t.entryBar];
    if (!regime) continue;
    const pnl = scaleTradePnl(t, rules.startingBalance);
    if (!Number.isFinite(pnl)) continue;
    labels.push(regime.label);
    const existing = pnlByRegime.get(regime.label);
    if (existing) existing.push(pnl);
    else pnlByRegime.set(regime.label, [pnl]);
  }

  const model = buildRegimeTransitionModel(labels);
  const steadyStatePct: Record<string, number> = {};
  model.states.forEach((s, i) => (steadyStatePct[s] = round2((model.steadyState[i] ?? 0) * 100)));
  if (model.states.length < 2 || labels.length < 10) {
    return {
      ...iidSamplerPlan(fallbackPnls, rng),
      warning:
        model.states.length < 2
          ? "regimeAware requested, but trades occupy fewer than two classified regimes; used ordinary trade bootstrap."
          : "regimeAware requested, but fewer than 10 trades were classified by regime; used ordinary trade bootstrap.",
      regimeAware: { enabled: false, states: model.states, tradesUsed: labels.length, steadyStatePct },
    };
  }

  return {
    tradesUsed: labels.length,
    regimeAware: { enabled: true, states: model.states, tradesUsed: labels.length, steadyStatePct },
    newPathSampler: () => {
      let state = sampleIndex(model.steadyState, rng);
      return () => {
        const bucket = pnlByRegime.get(model.states[state]) ?? fallbackPnls;
        const pnl = bucket[Math.floor(rng() * bucket.length)];
        state = sampleIndex(model.matrix[state], rng);
        return pnl;
      };
    },
  };
}

function simulateChallengePath(drawPnl: () => number, rules: PropFirmRuleset, tradesPerDay: number): ChallengePath {
  const start = rules.startingBalance;
  const targetEq = start * (1 + rules.profitTargetPct / 100);
  const staticFloor = start * (1 - rules.maxDrawdownPct / 100);
  const maxDays = rules.maxTradingDays ?? 30;
  const minDays = rules.minTradingDays ?? 0;
  let equity = start;
  let highWater = start;
  for (let day = 1; day <= maxDays; day++) {
    const dayStart = equity;
    for (let t = 0; t < tradesPerDay; t++) {
      equity += drawPnl();
      highWater = Math.max(highWater, equity);
      const trailingFloor = highWater * (1 - rules.maxDrawdownPct / 100);
      const drawdownFloor = rules.trailing ? Math.max(staticFloor, trailingFloor) : staticFloor;
      const dailyFloor = rules.dailyDrawdownPct != null ? dayStart * (1 - rules.dailyDrawdownPct / 100) : -Infinity;
      if (equity <= Math.max(drawdownFloor, dailyFloor)) return { outcome: "fail", days: day };
      if (equity >= targetEq && day >= minDays) return { outcome: "pass", days: day };
    }
  }
  return { outcome: "timeout", days: maxDays };
}

function simulateFundedPayout(drawPnl: () => number, rules: PropFirmRuleset, tradesPerDay: number, fundedDays: number): number {
  const start = rules.startingBalance;
  const staticFloor = start * (1 - rules.maxDrawdownPct / 100);
  let equity = start;
  let highWater = start;
  for (let day = 1; day <= fundedDays; day++) {
    const dayStart = equity;
    for (let t = 0; t < tradesPerDay; t++) {
      equity += drawPnl();
      highWater = Math.max(highWater, equity);
      const trailingFloor = highWater * (1 - rules.maxDrawdownPct / 100);
      const drawdownFloor = rules.trailing ? Math.max(staticFloor, trailingFloor) : staticFloor;
      const dailyFloor = rules.dailyDrawdownPct != null ? dayStart * (1 - rules.dailyDrawdownPct / 100) : -Infinity;
      if (equity <= Math.max(drawdownFloor, dailyFloor)) return 0;
    }
  }
  return Math.max(0, equity - start) * (rules.profitSplitPct / 100);
}

export function riskGeometry(trades: Trade[]): RiskGeometry {
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const avgWin = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, p) => s + p, 0) / losses.length) : 0;
  const winRatePct = pnls.length ? (wins.length / pnls.length) * 100 : 0;
  const avgRR = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;
  const pnlStdDev = stddev(pnls);
  const guidance =
    winRatePct >= 55 && Number.isFinite(avgRR) && avgRR <= 1.5
      ? "High-win/lower-variance geometry usually improves prop-challenge survival, but that is payout convexity — not proof of market edge."
      : "This payoff shape is volatile for prop rules; pass odds may be poor even if raw expectancy is positive.";
  return { winRatePct: round2(winRatePct), avgRR: Number.isFinite(avgRR) ? round2(avgRR) : Infinity, pnlStdDev: round2(pnlStdDev), avgWin: round2(avgWin), avgLoss: round2(avgLoss), guidance };
}

export function simulatePropFirm(
  trades: Trade[],
  ruleset: PropFirmRuleset,
  opts: PropFirmSimulationOptions = {}
): PropFirmReport {
  const iterations = opts.iterations ?? 2000;
  const tradesPerDay = Math.max(1, Math.round(opts.tradesPerDay ?? 3));
  const fundedDays = Math.max(1, Math.round(opts.fundedDays ?? ruleset.payoutCadenceDays));
  const rng = mulberry32(opts.seed ?? 20260623);
  const warnings: string[] = [];
  const pnls = trades.map((t) => scaleTradePnl(t, ruleset.startingBalance)).filter(Number.isFinite);
  const samplerPlan = regimeSamplerPlan(trades, ruleset, opts, rng);

  if (pnls.length < 5) {
    return {
      ruleset,
      iterations: 0,
      tradesUsed: pnls.length,
      pPass: 0,
      eChallengesToFund: Infinity,
      eDaysToPass: Infinity,
      eDaysToFirstPayout: Infinity,
      ePayoutGivenFunded: 0,
      netEvPerAccount: -(ruleset.challengeFee + (ruleset.activationFee ?? 0)),
      outcomeBuckets: { pass: 0, fail: 0, timeout: 0 },
      funded: { pFirstPayout: 0, medianPayout: 0, p5Payout: 0, p95Payout: 0 },
      regimeAware: samplerPlan.regimeAware,
      riskGeometry: riskGeometry(trades),
      warnings: ["Need at least 5 historical trades for a prop-firm simulation. This estimate would be noise."],
    };
  }

  let pass = 0;
  let fail = 0;
  let timeout = 0;
  const passDays: number[] = [];
  const fundedPayouts: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const path = simulateChallengePath(samplerPlan.newPathSampler(), ruleset, tradesPerDay);
    if (path.outcome === "pass") {
      pass += 1;
      passDays.push(path.days);
      fundedPayouts.push(simulateFundedPayout(samplerPlan.newPathSampler(), ruleset, tradesPerDay, fundedDays));
    } else if (path.outcome === "fail") {
      fail += 1;
    } else {
      timeout += 1;
    }
  }

  const pPassRaw = pass / iterations;
  const pPass = round2(pPassRaw * 100);
  const eChallengesToFund = pPassRaw > 0 ? 1 / pPassRaw : Infinity;
  const eDaysToPass = passDays.length ? passDays.reduce((s, d) => s + d, 0) / passDays.length : Infinity;
  const ePayoutGivenFunded = fundedPayouts.length ? fundedPayouts.reduce((s, p) => s + p, 0) / fundedPayouts.length : 0;
  const activationFee = ruleset.activationFee ?? 0;
  const netEvPerAccount = pPassRaw * ePayoutGivenFunded - eChallengesToFund * ruleset.challengeFee - activationFee;
  const payoutWins = fundedPayouts.filter((p) => p > 0).length;

  if (pnls.length < 30) warnings.push(`Only ${pnls.length} trades feed the prop simulation — treat pass/EV estimates as fragile.`);
  if (samplerPlan.warning) warnings.push(samplerPlan.warning);
  if (samplerPlan.regimeAware?.enabled) warnings.push("Regime-aware prop simulation used a Markov chain over entry regimes and regime-conditioned PnL buckets. This preserves clustering better than IID bootstrap, but still assumes historical regime behavior repeats.");
  if (timeout / iterations > 0.2) warnings.push(`${round2((timeout / iterations) * 100)}% of simulations timed out before pass/fail. The strategy may be too slow for this rule set.`);
  if (netEvPerAccount < 0) warnings.push("Net EV per account is negative after challenge fees. Passing sometimes is not enough if the fee drag dominates.");
  warnings.push("Prop-firm pass odds exploit payout geometry and rule constraints; they are not evidence of a market edge. Validate the strategy first.");

  return {
    ruleset,
    iterations,
    tradesUsed: pnls.length,
    pPass,
    eChallengesToFund: Number.isFinite(eChallengesToFund) ? round2(eChallengesToFund) : Infinity,
    eDaysToPass: Number.isFinite(eDaysToPass) ? round2(eDaysToPass) : Infinity,
    eDaysToFirstPayout: Number.isFinite(eDaysToPass) ? round2(eDaysToPass + ruleset.payoutCadenceDays) : Infinity,
    ePayoutGivenFunded: round2(ePayoutGivenFunded),
    netEvPerAccount: Number.isFinite(netEvPerAccount) ? round2(netEvPerAccount) : -Infinity,
    outcomeBuckets: { pass: round2((pass / iterations) * 100), fail: round2((fail / iterations) * 100), timeout: round2((timeout / iterations) * 100) },
    funded: {
      pFirstPayout: round2((payoutWins / Math.max(1, fundedPayouts.length)) * 100),
      medianPayout: round2(quantile(fundedPayouts, 0.5) || 0),
      p5Payout: round2(quantile(fundedPayouts, 0.05) || 0),
      p95Payout: round2(quantile(fundedPayouts, 0.95) || 0),
    },
    regimeAware: samplerPlan.regimeAware,
    riskGeometry: riskGeometry(trades),
    warnings,
  };
}

export const DEFAULT_PROP_FIRM_RULESET: PropFirmRuleset = {
  startingBalance: 50_000,
  profitTargetPct: 8,
  maxDrawdownPct: 6,
  trailing: true,
  dailyDrawdownPct: 3,
  minTradingDays: 1,
  maxTradingDays: 30,
  profitSplitPct: 80,
  payoutCadenceDays: 14,
  challengeFee: 150,
  activationFee: 0,
};
