/**
 * Phase 2 smoke test: triple-barrier labelling + bootstrap EV/CI + outcome report.
 * Run with: pnpm --filter @stratforge/engine exec tsx scripts/outcomes-smoke.ts
 */
import { outcomeReport, tripleBarrier } from "../src/index.js";
import type { Candle } from "../src/types.js";

// Flat-ish series with a planted edge: 8 up-bars after each event start, noise elsewhere.
function plantedEdge(n = 1600): { candles: Candle[]; eventBars: number[] } {
  const boost = new Array<number>(n).fill(0);
  const eventBars: number[] = [];
  for (let e = 20; e < n - 12; e += 50) {
    eventBars.push(e);
    for (let k = 1; k <= 8; k++) boost[e + k] += 0.006;
  }
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const noise = Math.sin(i * 17.17) * 0.0008;
    const close = price * (1 + noise + boost[i]);
    const open = price;
    candles.push({ time: 1700000000 + i * 3600, open, high: Math.max(open, close) * 1.0008, low: Math.min(open, close) * 0.9992, close, volume: 1000 });
    price = close;
  }
  return { candles, eventBars };
}

// Symmetric oscillation, mean ≈ 0 — no edge.
function noise(n = 1600): { candles: Candle[]; eventBars: number[] } {
  const candles: Candle[] = [];
  const eventBars: number[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const ret = Math.sin(i * 12.9898) * Math.cos(i * 4.233) * 0.004;
    const open = price;
    const close = price * (1 + ret);
    candles.push({ time: 1700000000 + i * 3600, open, high: Math.max(open, close) * 1.003, low: Math.min(open, close) * 0.997, close, volume: 1000 });
    price = close;
    if (i >= 20 && i % 10 === 0) eventBars.push(i);
  }
  return { candles, eventBars };
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
};

// --- Structural: no look-ahead, exit within the time barrier.
const edge = plantedEdge();
const labels = tripleBarrier(edge.candles, edge.eventBars, { maxHoldBars: 20 });
assert(labels.length > 0, "should label some events");
assert(labels.every((l) => l.exitBar > l.eventBar), "no look-ahead: exit strictly after the event bar");
assert(labels.every((l) => l.exitBar <= l.eventBar + 20), "exit within the time barrier");
assert(labels.every((l) => (l.hit === "tp") === (l.label === 1) && (l.hit === "sl") === (l.label === -1)), "label matches hit");

// --- Planted edge is detected: positive EV, CI excludes zero, more TP than SL.
const edgeRep = outcomeReport(edge.candles, edge.eventBars, { maxHoldBars: 20 });
assert(edgeRep.expectancy.ev > 0, `planted edge should have positive EV (got ${edgeRep.expectancy.ev})`);
assert(edgeRep.expectancy.excludesZero, `planted edge CI should exclude zero (got [${edgeRep.expectancy.ciLow}, ${edgeRep.expectancy.ciHigh}])`);
assert(edgeRep.labels.tp > edgeRep.labels.sl, "planted edge should hit TP more than SL");
assert(edgeRep.labels.tp + edgeRep.labels.sl + edgeRep.labels.time === edgeRep.events, "label counts sum to events");

// --- Pure noise: CI spans zero (no edge).
const n2 = noise();
const noiseRep = outcomeReport(n2.candles, n2.eventBars, { maxHoldBars: 20 });
assert(!noiseRep.expectancy.excludesZero, `noise CI should span zero (got [${noiseRep.expectancy.ciLow}, ${noiseRep.expectancy.ciHigh}], ev ${noiseRep.expectancy.ev})`);

console.log("=== Phase 2: outcome-label diagnostics smoke ===");
console.log("Edge:", `${edgeRep.events} events, EV ${edgeRep.expectancy.ev}% CI [${edgeRep.expectancy.ciLow}, ${edgeRep.expectancy.ciHigh}]`, `tp/sl/time = ${edgeRep.labels.tp}/${edgeRep.labels.sl}/${edgeRep.labels.time}`, `drift ${edgeRep.baseline.driftPct}%`);
console.log("Noise:", `${noiseRep.events} events, EV ${noiseRep.expectancy.ev}% CI [${noiseRep.expectancy.ciLow}, ${noiseRep.expectancy.ciHigh}] (excludesZero=${noiseRep.expectancy.excludesZero})`);
console.log("\nAll outcome smoke checks passed.");
