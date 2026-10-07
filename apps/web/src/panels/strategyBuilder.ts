// Pure strategy-builder primitives shared by StrategyPanel (the editor UI) and the
// walk-forward optimizer. No React and no runtime DSL import (types are erased), so
// this module stays unit-testable in the smoke harness. The loose builder types are
// validated by parseStrategy at run time — buildSpec only assembles the plain object.
import type { StrategySpec } from "@stratforge/dsl";

export type BOp = { kind: "indicator" | "price" | "value" | "factor"; id?: string; line?: string; source?: string; value?: number };
export type BComparisonCond = { left: BOp; op: string; right: BOp };
export type BRegimeCond = { kind: "regime"; axis: "trend" | "volatility"; in: string[] };
export type BCond = BComparisonCond | BRegimeCond;

/**
 * Narrow a condition to the regime variant. A user-defined type guard is needed
 * because BComparisonCond carries no `kind` discriminant, so an inline
 * `"kind" in c && c.kind === "regime"` check narrows the true branch but leaves
 * the else branch un-narrowed (the bug that broke `tsc`).
 */
export function isRegimeCond(c: BCond): c is BRegimeCond {
  return "kind" in c && c.kind === "regime";
}
export type BInd = { id: string; type: string; params: Record<string, number | string> };
export interface Builder {
  name: string;
  event: {
    thesis: string;
    trigger: BCond[];
    context: BCond[];
    outcomeHorizonBars: number;
  };
  indicators: BInd[];
  entry: BCond[];
  exit: BCond[];
  risk: { positionSizePct: number; stopLossPct: number | null; takeProfitPct: number | null };
}

/** Turn a validated spec (e.g. one the AI analyst built) into the editable builder model. */
export function specToBuilder(spec: StrategySpec): Builder {
  const trigger = (spec.process?.trigger ?? spec.entry.filter((c) => "op" in c && (c.op === "crossesAbove" || c.op === "crossesBelow"))) as unknown as BCond[];
  const context = (spec.process?.context ?? spec.entry.filter((c) => !("op" in c) || (c.op !== "crossesAbove" && c.op !== "crossesBelow"))) as unknown as BCond[];
  return {
    name: spec.name,
    event: {
      thesis: spec.process?.thesis ?? spec.description ?? "State the market event this strategy is trying to exploit.",
      trigger: trigger.length ? trigger : ((spec.entry ?? []) as unknown as BCond[]),
      context,
      outcomeHorizonBars: spec.process?.outcome?.horizonBars ?? 20,
    },
    indicators: spec.indicators.map((i) => ({ id: i.id, type: i.type, params: { ...i.params } as Record<string, number | string> })),
    entry: (spec.entry ?? []) as unknown as BCond[],
    exit: (spec.exit ?? []) as unknown as BCond[],
    risk: {
      positionSizePct: spec.risk.positionSizePct,
      stopLossPct: spec.risk.stopLossPct ?? null,
      takeProfitPct: spec.risk.takeProfitPct ?? null,
    },
  };
}

export function buildSpec(b: Builder): unknown {
  const risk: Record<string, number> = { positionSizePct: b.risk.positionSizePct };
  if (b.risk.stopLossPct != null) risk.stopLossPct = b.risk.stopLossPct;
  if (b.risk.takeProfitPct != null) risk.takeProfitPct = b.risk.takeProfitPct;
  const entry = [...b.event.trigger, ...b.event.context];
  return {
    version: 1,
    name: b.name || "Untitled",
    description: b.event.thesis,
    indicators: b.indicators.map((i) => ({ id: i.id, type: i.type, params: i.params })),
    process: {
      thesis: b.event.thesis || "No thesis stated.",
      trigger: b.event.trigger,
      context: b.event.context,
      outcome: { horizonBars: b.event.outcomeHorizonBars || 20 },
    },
    entry,
    exit: b.exit.length ? b.exit : undefined,
    risk,
  };
}

// ---------- optimization glue ----------
// A swept parameter is addressed by a flat string key so a grid can be a plain
// Record. Indicator params:  "ind:<indicatorId>:<paramKey>"  (e.g. "ind:fast:period").
// Risk params:               "risk:<field>"                  (e.g. "risk:stopLossPct").
// Ids and param keys never contain ':', so the address parses unambiguously.

export interface OptimizableParam {
  key: string;
  label: string;
  current: number;
}

/** Expand a min/max/step sweep into its discrete values. Returns [] for invalid input
 *  (non-finite, step ≤ 0, max < min) and is hard-capped at 1000 values so a tiny step
 *  over a wide range can't hang the UI — the grid-size cap is the real limit. */
export function rangeValues(min: number, max: number, step: number): number[] {
  if (![min, max, step].every(Number.isFinite) || step <= 0 || max < min) return [];
  const out: number[] = [];
  for (let v = min; v <= max + 1e-9 && out.length < 1000; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** Enumerate the numeric knobs of a builder that an optimizer may sweep. The string
 *  "source" param and absent (null) risk fields are intentionally excluded. */
export function listOptimizableParams(b: Builder): OptimizableParam[] {
  const out: OptimizableParam[] = [];
  for (const ind of b.indicators) {
    for (const [k, v] of Object.entries(ind.params)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        out.push({ key: `ind:${ind.id}:${k}`, label: `${ind.id}.${k}`, current: v });
      }
    }
  }
  out.push({ key: "risk:positionSizePct", label: "risk.positionSizePct", current: b.risk.positionSizePct });
  if (b.risk.stopLossPct != null) out.push({ key: "risk:stopLossPct", label: "risk.stopLossPct", current: b.risk.stopLossPct });
  if (b.risk.takeProfitPct != null) out.push({ key: "risk:takeProfitPct", label: "risk.takeProfitPct", current: b.risk.takeProfitPct });
  return out;
}

/** Return a copy of `base` with the addressed numeric params overwritten. Pure: the
 *  input is never mutated. Only existing indicator params and known risk fields are
 *  written — unknown addresses and non-finite values are ignored, so a malformed grid
 *  can never inject a bogus param or corrupt the spec. */
export function applyParamsToBuilder(base: Builder, params: Record<string, number>): Builder {
  const next: Builder = {
    name: base.name,
    event: {
      thesis: base.event.thesis,
      trigger: [...base.event.trigger],
      context: [...base.event.context],
      outcomeHorizonBars: base.event.outcomeHorizonBars,
    },
    indicators: base.indicators.map((i) => ({ ...i, params: { ...i.params } })),
    entry: [...base.entry],
    exit: [...base.exit],
    risk: { ...base.risk },
  };
  for (const [key, value] of Object.entries(params)) {
    if (!Number.isFinite(value)) continue;
    const parts = key.split(":");
    if (parts[0] === "ind" && parts.length === 3) {
      const ind = next.indicators.find((i) => i.id === parts[1]);
      if (ind && parts[2] in ind.params) ind.params[parts[2]] = value;
    } else if (parts[0] === "risk" && parts.length === 2) {
      const field = parts[1];
      if (field === "positionSizePct" || field === "stopLossPct" || field === "takeProfitPct") {
        next.risk[field] = value;
      }
    }
  }
  return next;
}
