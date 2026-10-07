/**
 * Condition evaluation — shared by the backtest executor and the outcome/feature
 * research flows. Extracted verbatim from backtest.ts so a strategy's trigger can be
 * evaluated over candles WITHOUT running a full backtest (no look-ahead: every
 * series is read at the given bar, crossings look one bar back).
 */
import type { Condition, Operand, StrategySpec } from "@stratforge/dsl";
import { computeIndicator, primaryLine } from "./indicators.js";
import type { BarRegime } from "./regimes.js";
import type { Candle } from "./types.js";

/** Precomputed indicator series + default-line map + external factors for a spec. */
export interface IndicatorContext {
  indicators: Record<string, Record<string, number[]>>;
  idDefaultLine: Record<string, string>;
  factors: Record<string, number[]>;
  regimes?: (BarRegime | null)[];
}

/** Build the indicator context for a spec (same computation runBacktest does internally). */
export function buildIndicatorContext(
  spec: StrategySpec,
  candles: Candle[],
  factors: Record<string, number[]> = {},
  regimes?: (BarRegime | null)[]
): IndicatorContext {
  const indicators: Record<string, Record<string, number[]>> = {};
  const idDefaultLine: Record<string, string> = {};
  for (const ind of spec.indicators) {
    indicators[ind.id] = computeIndicator(ind, candles);
    idDefaultLine[ind.id] = primaryLine(ind);
  }
  return { indicators, idDefaultLine, factors, regimes };
}

export function operandSeries(
  op: Operand,
  candles: Candle[],
  indicators: Record<string, Record<string, number[]>>,
  idDefaultLine: Record<string, string>,
  factors: Record<string, number[]>
): (bar: number) => number {
  switch (op.kind) {
    case "indicator": {
      const lines = indicators[op.id];
      const lineName = op.line ?? idDefaultLine[op.id];
      const series = lines?.[lineName];
      return (bar) => (series ? series[bar] : NaN);
    }
    case "price":
      return (bar) => candles[bar][op.source];
    case "value":
      return () => op.value;
    case "factor": {
      const series = factors[op.id];
      return (bar) => (series ? series[bar] : NaN);
    }
  }
}

export function evalCondition(
  c: Condition,
  bar: number,
  candles: Candle[],
  indicators: Record<string, Record<string, number[]>>,
  idDefaultLine: Record<string, string>,
  factors: Record<string, number[]>,
  regimes?: (BarRegime | null)[]
): boolean {
  if (!("left" in c)) {
    const regime = regimes?.[bar];
    if (!regime) return false;
    return (c.in as readonly string[]).includes(regime[c.axis]);
  }
  const left = operandSeries(c.left, candles, indicators, idDefaultLine, factors);
  const right = operandSeries(c.right, candles, indicators, idDefaultLine, factors);
  const l = left(bar);
  const r = right(bar);
  if (Number.isNaN(l) || Number.isNaN(r)) return false;
  switch (c.op) {
    case "greaterThan":
      return l > r;
    case "lessThan":
      return l < r;
    case "crossesAbove": {
      if (bar === 0) return false;
      const lp = left(bar - 1);
      const rp = right(bar - 1);
      return !Number.isNaN(lp) && !Number.isNaN(rp) && lp <= rp && l > r;
    }
    case "crossesBelow": {
      if (bar === 0) return false;
      const lp = left(bar - 1);
      const rp = right(bar - 1);
      return !Number.isNaN(lp) && !Number.isNaN(rp) && lp >= rp && l < r;
    }
  }
  return false;
}

/** True when every condition in the group holds at `bar`. */
export function evalConditionGroup(
  conds: Condition[],
  bar: number,
  candles: Candle[],
  ctx: IndicatorContext
): boolean {
  return conds.every((c) => evalCondition(c, bar, candles, ctx.indicators, ctx.idDefaultLine, ctx.factors, ctx.regimes));
}

/** Bars at which a condition group fires — the "event" timestamps for outcome research. */
export function triggerEventBars(conds: Condition[], candles: Candle[], ctx: IndicatorContext): number[] {
  const bars: number[] = [];
  for (let bar = 0; bar < candles.length; bar++) {
    if (evalConditionGroup(conds, bar, candles, ctx)) bars.push(bar);
  }
  return bars;
}
