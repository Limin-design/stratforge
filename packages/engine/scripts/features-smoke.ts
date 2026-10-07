/**
 * Phase 6 smoke test: feature transforms, CUSUM events, and attribution.
 * Run with: pnpm --filter @stratforge/engine exec tsx scripts/features-smoke.ts
 */
import { featureAttribution, featureSeries, normalizePct, cusumEvents, type FeatureSpec } from "../src/index.js";
import type { Candle, OutcomeLabel } from "../src/index.js";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
};

function candles(n: number, scale = 1): Candle[] {
  const out: Candle[] = [];
  let price = 100 * scale;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 8) * 0.8 * scale;
    const drift = i % 50 < 25 ? 0.35 * scale : -0.1 * scale;
    const open = price;
    const close = Math.max(1, price + drift + wave);
    out.push({
      time: 1700000000 + i * 3600,
      open,
      high: Math.max(open, close) + 0.8 * scale,
      low: Math.min(open, close) - 0.8 * scale,
      close,
      volume: 1000 + (i % 20) * 20,
    });
    price = close;
  }
  return out;
}

function avgFiniteAbs(xs: number[]): number {
  const finite = xs.filter(Number.isFinite).map(Math.abs);
  return finite.reduce((s, x) => s + x, 0) / finite.length;
}

const c1 = candles(220, 1);
const c10 = candles(220, 10);
const spec: FeatureSpec = { id: "slope", label: "SMA slope", valueType: "continuous", kind: "smaSlopePct", period: 20, lag: 5 };
const slope1 = featureSeries(spec, c1).values;
const slope10 = featureSeries(spec, c10).values;
assert(Math.abs(avgFiniteAbs(slope1) - avgFiniteAbs(slope10)) < 0.01, "normalized SMA slope should be scale-invariant");

const raw = [100, 102, 101, 104];
const norm = normalizePct(raw);
assert(Math.abs(norm[1] - 2) < 1e-9, "normalizePct should produce percent move from prior value");

const moreEvents = cusumEvents(c1, { atrMult: 0.8 }).length;
const fewerEvents = cusumEvents(c1, { atrMult: 2.2 }).length;
assert(moreEvents > fewerEvents, `lower ATR multiple should produce more CUSUM events (${moreEvents} vs ${fewerEvents})`);

const plantedValues = new Array<number>(160).fill(NaN);
const noiseValues = new Array<number>(160).fill(NaN);
const labels: OutcomeLabel[] = [];
for (let i = 30; i < 150; i++) {
  const x = Math.sin(i / 5) + (i % 11) * 0.03;
  plantedValues[i] = x;
  noiseValues[i] = Math.sin(i * 2.37);
  labels.push({
    eventBar: i,
    exitBar: i + 1,
    hit: x > 0 ? "tp" : "sl",
    label: x > 0 ? 1 : -1,
    returnPct: x * 1.4,
  });
}

const report = featureAttribution(labels, [
  { spec: { id: "planted", label: "Planted feature", valueType: "continuous", kind: "close" }, values: plantedValues },
  { spec: { id: "noise", label: "Noise feature", valueType: "continuous", kind: "close" }, values: noiseValues },
]);
const planted = report.features.find((f) => f.featureId === "planted");
const noise = report.features.find((f) => f.featureId === "noise");
assert(!!planted && planted.correlation.verdict === "real", `planted feature should clear anti-spurious verdict, got ${planted?.correlation.verdict}`);
assert(!!noise && noise.correlation.verdict !== "real", `noise feature should not clear anti-spurious verdict, got ${noise?.correlation.verdict}`);
assert((planted?.spreadHighMinusLow ?? 0) > 1, "planted feature should separate high/low outcome buckets");

console.log("=== Phase 6: feature lab smoke ===");
console.log("SMA slope avg abs:", avgFiniteAbs(slope1).toFixed(4), avgFiniteAbs(slope10).toFixed(4));
console.log("CUSUM events low/high threshold:", moreEvents, fewerEvents);
console.log("Attribution:", report.features.map((f) => `${f.featureId}=${f.correlation.verdict}/${f.correlation.pearsonLevels.toFixed(2)}`).join(" | "));
console.log("\nAll feature smoke checks passed.");
