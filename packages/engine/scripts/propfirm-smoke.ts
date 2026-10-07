import { simulatePropFirm, type PropFirmRuleset } from "../src/propfirm.js";
import { classifyRegimes } from "../src/regimes.js";
import type { Candle, Trade } from "../src/types.js";

function trade(pnlPct: number, i: number): Trade {
  return {
    entryBar: i * 2,
    exitBar: i * 2 + 1,
    entryTime: 1_700_000_000 + i * 3600,
    exitTime: 1_700_003_600 + i * 3600,
    entryPrice: 100,
    exitPrice: 100 * (1 + pnlPct / 100),
    size: 1,
    pnl: pnlPct,
    pnlPct,
    exitReason: "signal",
  };
}

function makeTrades(pattern: number[], n = 240): Trade[] {
  return Array.from({ length: n }, (_, i) => trade(pattern[i % pattern.length], i));
}

function regimeCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 360; i++) {
    const open = price;
    const close = price * (1 + 0.002 + Math.sin(i / 8) * 0.0005);
    candles.push({ time: 1_700_000_000 + i * 3600, open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close, volume: 1000 });
    price = close;
  }
  for (let i = 0; i < 360; i++) {
    const open = price;
    const close = price * (1 + Math.sin(i / 2) * 0.018 - 0.0005);
    candles.push({ time: 1_701_296_000 + i * 3600, open, high: Math.max(open, close) * 1.025, low: Math.min(open, close) * 0.975, close, volume: 1000 });
    price = close;
  }
  return candles;
}

function regimeTrade(entryBar: number, pnlPct: number, i: number): Trade {
  const entryPrice = 100;
  return {
    entryBar,
    exitBar: entryBar + 1,
    entryTime: 1_700_000_000 + entryBar * 3600,
    exitTime: 1_700_003_600 + entryBar * 3600,
    entryPrice,
    exitPrice: entryPrice * (1 + pnlPct / 100),
    size: 1,
    pnl: pnlPct,
    pnlPct,
    exitReason: i % 2 === 0 ? "signal" : "stopLoss",
  };
}

function clusteredRegimeTrades(candles: Candle[]): Trade[] {
  const perBar = classifyRegimes(candles);
  const byLabel = new Map<string, number[]>();
  for (let i = 0; i < perBar.length - 2; i++) {
    const label = perBar[i]?.label;
    if (!label) continue;
    const arr = byLabel.get(label);
    if (arr) arr.push(i);
    else byLabel.set(label, [i]);
  }
  const labels = [...byLabel.entries()].filter(([, bars]) => bars.length >= 30).sort((a, b) => b[1].length - a[1].length);
  assert(labels.length >= 2, "synthetic candles should produce at least two classifiable regimes");
  const goodBars = labels[0][1];
  const badBars = labels[1][1];
  const trades: Trade[] = [];
  for (let block = 0; block < 4; block++) {
    for (let j = 0; j < 12; j++) trades.push(regimeTrade(goodBars[(block * 12 + j) % goodBars.length], 0.35, trades.length));
    for (let j = 0; j < 12; j++) trades.push(regimeTrade(badBars[(block * 12 + j) % badBars.length], -0.3, trades.length));
  }
  return trades;
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const base: PropFirmRuleset = {
  startingBalance: 50_000,
  profitTargetPct: 4,
  maxDrawdownPct: 3,
  trailing: false,
  dailyDrawdownPct: 3,
  minTradingDays: 5,
  maxTradingDays: 20,
  profitSplitPct: 80,
  payoutCadenceDays: 14,
  challengeFee: 150,
  activationFee: 0,
};

// Both patterns are roughly zero-EV. The first is high-win/low-RR and lower variance;
// the second is low-win/high-RR and lumpy. Prop challenges should prefer the first.
const smoothZeroEv = makeTrades([0.4, 0.4, 0.4, 0.4, -1.6]);
const lumpyZeroEv = makeTrades([3.2, -0.8, -0.8, -0.8, -0.8]);

const smooth = simulatePropFirm(smoothZeroEv, base, { iterations: 1200, seed: 44, tradesPerDay: 4 });
const lumpy = simulatePropFirm(lumpyZeroEv, base, { iterations: 1200, seed: 44, tradesPerDay: 4 });
const trailing = simulatePropFirm(smoothZeroEv, { ...base, trailing: true }, { iterations: 1200, seed: 44, tradesPerDay: 4 });

const bucketSum = smooth.outcomeBuckets.pass + smooth.outcomeBuckets.fail + smooth.outcomeBuckets.timeout;
assert(Math.abs(bucketSum - 100) <= 0.02, `bucket percentages should sum to 100, got ${bucketSum}`);
assert(smooth.pPass > lumpy.pPass, `smooth geometry should pass more often (${smooth.pPass} <= ${lumpy.pPass})`);
assert(smooth.riskGeometry.winRatePct > lumpy.riskGeometry.winRatePct, "smooth pattern should have higher win rate");
assert(smooth.riskGeometry.pnlStdDev < lumpy.riskGeometry.pnlStdDev, "smooth pattern should have lower PnL stddev");
assert(Math.abs(smooth.pPass - trailing.pPass) > 0.01, "trailing drawdown should change pPass vs static drawdown");
assert(smooth.warnings.some((w) => w.includes("convex") || w.includes("geometry")), "report should warn that prop odds are geometry, not edge");

const candles = regimeCandles();
const regimeTrades = clusteredRegimeTrades(candles);
const iidProp = simulatePropFirm(regimeTrades, base, { iterations: 1200, seed: 91, tradesPerDay: 4 });
const regimeProp = simulatePropFirm(regimeTrades, base, { iterations: 1200, seed: 91, tradesPerDay: 4, regimeAware: true, candles });
assert(regimeProp.regimeAware?.enabled, "regimeAware should enable when candles classify trades into ≥2 regimes");
assert((regimeProp.regimeAware?.states.length ?? 0) >= 2, "regimeAware report should include Markov states");
assert(regimeProp.warnings.some((w) => w.includes("Markov chain")), "regimeAware report should explain Markov regime sampling");
assert(Math.abs(regimeProp.pPass - iidProp.pPass) > 0.1, "regime-aware sampling should change prop pass odds vs IID bootstrap on clustered trades");

console.log({
  smooth: { pPass: smooth.pPass, buckets: smooth.outcomeBuckets, risk: smooth.riskGeometry, netEv: smooth.netEvPerAccount },
  lumpy: { pPass: lumpy.pPass, buckets: lumpy.outcomeBuckets, risk: lumpy.riskGeometry, netEv: lumpy.netEvPerAccount },
  trailing: { pPass: trailing.pPass, buckets: trailing.outcomeBuckets },
  regimeAware: { iidPass: iidProp.pPass, regimePass: regimeProp.pPass, states: regimeProp.regimeAware?.states, steadyStatePct: regimeProp.regimeAware?.steadyStatePct },
});
