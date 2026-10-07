import { z } from "zod";

/**
 * StratForge Strategy DSL
 * -----------------------
 * Strategies are DATA, not code. Users (and plugged-in AI agents) submit this
 * JSON shape; the engine executes it. No arbitrary code ever runs, which keeps
 * the AI sandbox safe by construction.
 */

// ---------- Indicators ----------

/** All indicator type names (handy for UIs / agent enumeration). */
export const IndicatorType = z.enum([
  "sma",
  "ema",
  "rsi",
  "macd",
  "bollinger",
  "atr",
  "stochastic",
  "adx",
  "obv",
  "vwap",
  "mfi",
]);

/**
 * Output lines each indicator exposes. The FIRST entry is the default line
 * referenced when a condition's operand omits `line`. Conditions can target a
 * specific line, e.g. the MACD signal or a Bollinger band.
 */
export const INDICATOR_LINES = {
  sma: ["sma"],
  ema: ["ema"],
  rsi: ["rsi"],
  macd: ["macd", "signal", "histogram"],
  bollinger: ["upper", "middle", "lower"],
  atr: ["atr"],
  stochastic: ["k", "d"],
  adx: ["adx", "plusDI", "minusDI"],
  obv: ["obv"],
  vwap: ["vwap"],
  mfi: ["mfi"],
} as const satisfies Record<z.infer<typeof IndicatorType>, readonly string[]>;

/** Default (primary) line for an indicator type. */
export function defaultLine(type: z.infer<typeof IndicatorType>): string {
  return INDICATOR_LINES[type][0];
}

const Source = z.enum(["open", "high", "low", "close"]);
const Period = z.number().int().min(1).max(500);
export const TrendState = z.enum(["up", "down", "range"]);
export const VolBucket = z.enum(["low", "normal", "high"]);

/** Params shared by the price-source moving-average family (sma/ema/rsi). */
const MovingAvgParams = z.object({
  period: Period,
  source: Source.default("close"),
});

/**
 * Indicators are a discriminated union on `type` so each carries exactly the
 * params it needs (with sensible defaults the agent can rely on).
 */
export const IndicatorSpec = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("sma"), params: MovingAvgParams }),
  z.object({ id: z.string().min(1), type: z.literal("ema"), params: MovingAvgParams }),
  z.object({ id: z.string().min(1), type: z.literal("rsi"), params: MovingAvgParams }),
  z.object({
    id: z.string().min(1),
    type: z.literal("macd"),
    params: z.object({
      fastPeriod: Period.default(12),
      slowPeriod: Period.default(26),
      signalPeriod: Period.default(9),
      source: Source.default("close"),
    }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("bollinger"),
    params: z.object({
      period: Period.default(20),
      stdDev: z.number().min(0.1).max(10).default(2),
      source: Source.default("close"),
    }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("atr"),
    params: z.object({ period: Period.default(14) }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("stochastic"),
    params: z.object({ kPeriod: Period.default(14), dPeriod: Period.default(3) }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("adx"),
    params: z.object({ period: Period.default(14) }),
  }),
  z.object({ id: z.string().min(1), type: z.literal("obv"), params: z.object({}).default({}) }),
  z.object({
    id: z.string().min(1),
    type: z.literal("vwap"),
    params: z.object({ period: Period.default(20) }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("mfi"),
    params: z.object({ period: Period.default(14) }),
  }),
]);

// ---------- Condition operands ----------

export const Operand = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("indicator"),
    id: z.string(),
    /** Optional output line (e.g. "signal", "upper"); defaults to the indicator's primary line. */
    line: z.string().optional(),
  }),
  z.object({
    kind: z.literal("price"),
    source: Source.default("close"),
  }),
  z.object({ kind: z.literal("value"), value: z.number() }),
  /**
   * An external time series (oil supply, FX, prediction-market odds, …) aligned
   * to the candles and supplied to the engine at runtime as `factors[id]`. Lets
   * a strategy trade on cross-domain data. Validity of `id` is checked at run
   * time, not parse time, since factors live outside the strategy JSON.
   */
  z.object({ kind: z.literal("factor"), id: z.string() }),
]);

export const Comparator = z.enum(["crossesAbove", "crossesBelow", "greaterThan", "lessThan"]);

export const ComparisonCondition = z.object({
  left: Operand,
  op: Comparator,
  right: Operand,
});

/**
 * Regime filter condition, evaluated from the same trend×volatility classifier
 * used by regime attribution. Intended for `process.context`, e.g. "only trade
 * this event in up/normal or up/high regimes". It is a context filter, not an
 * event trigger.
 */
export const RegimeCondition = z.discriminatedUnion("axis", [
  z.object({ kind: z.literal("regime"), axis: z.literal("trend"), in: z.array(TrendState).min(1) }),
  z.object({ kind: z.literal("regime"), axis: z.literal("volatility"), in: z.array(VolBucket).min(1) }),
]);

export const Condition = z.union([ComparisonCondition, RegimeCondition]);

/** All conditions in a group must be true on the same bar (AND semantics). */
export const ConditionGroup = z.array(Condition).min(1);

// ---------- Event-first research process ----------

export const EventProcessSpec = z.object({
  /** Plain-English reason this event should exist. Forces the user/agent to state the hypothesis. */
  thesis: z.string().min(1).max(1000),
  /** The actual event/decision trigger. Prefer crosses/threshold breaks, not always-on filters. */
  trigger: ConditionGroup,
  /** Optional regime/context filters that must also be true when the trigger fires. */
  context: z.array(Condition).default([]),
  /** Optional forward outcome label used for research/debugging, not execution. */
  outcome: z
    .object({
      horizonBars: z.number().int().min(1).max(10_000).default(20),
      success: z.array(Condition).default([]),
    })
    .optional(),
});

// ---------- Risk ----------

export const RiskSpec = z.object({
  /** % of current equity allocated per trade (1–100) */
  positionSizePct: z.number().min(0.1).max(100).default(10),
  /** Optional stop-loss, % below entry price */
  stopLossPct: z.number().min(0.05).max(50).optional(),
  /** Optional take-profit, % above entry price */
  takeProfitPct: z.number().min(0.05).max(200).optional(),
});

// ---------- Strategy ----------

export const StrategySpec = z.object({
  /** Schema version for forward compatibility */
  version: z.literal(1).default(1),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  indicators: z.array(IndicatorSpec).max(20).default([]),
  /** Event-first research structure. `entry` remains the executable trigger+context group for engine v1. */
  process: EventProcessSpec.optional(),
  /** Long-only in v1; "side" reserved for shorts later */
  entry: ConditionGroup,
  exit: ConditionGroup.optional(),
  risk: RiskSpec.default({ positionSizePct: 10 }),
});

export type IndicatorType = z.infer<typeof IndicatorType>;
export type IndicatorSpec = z.infer<typeof IndicatorSpec>;
export type Operand = z.infer<typeof Operand>;
export type ComparisonCondition = z.infer<typeof ComparisonCondition>;
export type RegimeCondition = z.infer<typeof RegimeCondition>;
export type Condition = z.infer<typeof Condition>;
export type EventProcessSpec = z.infer<typeof EventProcessSpec>;
export type RiskSpec = z.infer<typeof RiskSpec>;
export type StrategySpec = z.infer<typeof StrategySpec>;

function conditionKey(c: Condition): string {
  return JSON.stringify(c);
}

/** Validate unknown input (e.g., JSON from an AI agent). Throws on failure. */
export function parseStrategy(input: unknown): StrategySpec {
  const spec = StrategySpec.parse(input);

  // Cross-field checks: conditions may only reference declared indicator ids,
  // and a referenced `line` must exist for that indicator's type.
  const idType = new Map(spec.indicators.map((i) => [i.id, i.type]));
  const refs = [
    ...spec.entry,
    ...(spec.exit ?? []),
    ...(spec.process?.trigger ?? []),
    ...(spec.process?.context ?? []),
    ...(spec.process?.outcome?.success ?? []),
  ].flatMap((c) =>
    "left" in c ? [c.left, c.right].filter((o) => o.kind === "indicator") : []
  ) as Array<{ kind: "indicator"; id: string; line?: string }>;

  for (const r of refs) {
    const type = idType.get(r.id);
    if (!type) {
      throw new Error(`Condition references undeclared indicator "${r.id}"`);
    }
    if (r.line && !(INDICATOR_LINES[type] as readonly string[]).includes(r.line)) {
      throw new Error(
        `Indicator "${r.id}" (${type}) has no line "${r.line}"; valid lines: ${INDICATOR_LINES[type].join(", ")}`
      );
    }
  }
  if (spec.process) {
    const expected = [...spec.process.trigger, ...spec.process.context].map(conditionKey);
    const actual = spec.entry.map(conditionKey);
    const sameLength = expected.length === actual.length;
    const sameOrder = sameLength && expected.every((k, i) => k === actual[i]);
    if (!sameOrder) {
      throw new Error("Strategy process mismatch: executable entry must equal process.trigger followed by process.context");
    }
  }
  return spec;
}
