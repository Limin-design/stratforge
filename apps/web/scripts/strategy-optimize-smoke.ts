import {
  applyParamsToBuilder,
  buildSpec,
  listOptimizableParams,
  rangeValues,
  type Builder,
} from "../src/panels/strategyBuilder.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const goldenCross = { left: { kind: "indicator", id: "fast" }, op: "crossesAbove", right: { kind: "indicator", id: "slow" } } as const;
const base: Builder = {
  name: "Golden Cross",
  event: { thesis: "fast SMA crosses above slow SMA", trigger: [goldenCross], context: [], outcomeHorizonBars: 20 },
  indicators: [
    { id: "fast", type: "sma", params: { period: 10, source: "close" } },
    { id: "slow", type: "sma", params: { period: 30, source: "close" } },
  ],
  entry: [goldenCross],
  exit: [],
  risk: { positionSizePct: 50, stopLossPct: 5, takeProfitPct: null },
};

// listOptimizableParams: numeric indicator params + present risk fields only. The
// string "source" param and the absent (null) takeProfit must not be sweepable.
const opt = listOptimizableParams(base);
const keys = opt.map((o) => o.key);
assert(keys.includes("ind:fast:period") && keys.includes("ind:slow:period"), "indicator periods must be optimizable");
assert(!keys.some((k) => k.includes("source")), "the string 'source' param must not be optimizable");
assert(keys.includes("risk:positionSizePct") && keys.includes("risk:stopLossPct"), "present risk fields must be optimizable");
assert(!keys.includes("risk:takeProfitPct"), "a null risk field must be excluded");
assert(opt.find((o) => o.key === "ind:fast:period")?.current === 10, "current value must reflect the builder");
assert(opt.find((o) => o.key === "ind:fast:period")?.label === "fast.period", "label must be the human address");

// applyParamsToBuilder: substitutes the addressed numeric fields, leaves the rest.
const next = applyParamsToBuilder(base, { "ind:fast:period": 5, "ind:slow:period": 40, "risk:stopLossPct": 2 });
assert(next.indicators[0].params.period === 5, "fast period must be substituted");
assert(next.indicators[1].params.period === 40, "slow period must be substituted");
assert(next.risk.stopLossPct === 2, "risk stop-loss must be substituted");
assert(next.indicators[0].params.source === "close", "non-swept params must be preserved");

// Purity: the base builder must not be mutated by a substitution.
assert(base.indicators[0].params.period === 10 && base.risk.stopLossPct === 5, "applyParamsToBuilder must not mutate its input");

// Guard rails: unknown addresses, non-existent ids/params, and non-finite values are
// all ignored — a malformed grid can never inject a bogus param or corrupt the spec.
const safe = applyParamsToBuilder(base, {
  "ind:fast:bogus": 99,
  "ind:ghost:period": 7,
  "risk:unknown": 1,
  "ind:fast:period": Number.NaN,
});
assert(!("bogus" in safe.indicators[0].params), "an unknown indicator param must not be injected");
assert(safe.indicators.length === 2 && !safe.indicators.some((i) => i.id === "ghost"), "a non-existent indicator id must be ignored");
assert(safe.indicators[0].params.period === 10, "a non-finite value must be ignored (period unchanged)");

// buildSpec over the substituted builder emits a valid versioned spec object.
const spec = buildSpec(next) as {
  version: number;
  name: string;
  indicators: Array<{ params: Record<string, number | string> }>;
  exit?: unknown;
  risk: Record<string, number | undefined>;
};
assert(spec.version === 1 && spec.name === "Golden Cross", "buildSpec must emit a versioned, named spec");
assert(spec.indicators[0].params.period === 5, "buildSpec must carry the substituted param");
assert(spec.exit === undefined, "an empty exit must be omitted");
assert(spec.risk.stopLossPct === 2 && spec.risk.takeProfitPct === undefined, "risk must reflect substitution; null fields omitted");

// rangeValues: the grid-UI min/max/step expander. Inclusive of both ends, rejects
// degenerate input, fractional steps are exact, and a runaway step is hard-capped.
assert(JSON.stringify(rangeValues(5, 20, 5)) === JSON.stringify([5, 10, 15, 20]), "range must be inclusive of both ends");
assert(rangeValues(10, 10, 1).length === 1, "min == max yields a single value");
assert(JSON.stringify(rangeValues(1, 2, 0.5)) === JSON.stringify([1, 1.5, 2]), "fractional steps must be exact (no float drift)");
assert(rangeValues(20, 5, 1).length === 0, "max < min yields no values");
assert(rangeValues(0, 10, 0).length === 0, "a non-positive step yields no values");
assert(rangeValues(0, 10, Number.NaN).length === 0, "a non-finite step yields no values");
assert(rangeValues(0, 1e9, 1).length === 1000, "a runaway range is hard-capped at 1000 values");

console.log("strategy optimize smoke passed");
