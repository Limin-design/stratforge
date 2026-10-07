export type ChartPoint = { time: number; value: number };
export type CoordPoint = { x: number; y: number };
export type DragEntry<T> = { index: number; origin: T };
export type DragSnapshot<T> = { index: number; origin: T; group?: DragEntry<T>[] };

export const DRAW_GEOMETRY_PX = { minSegment: 8, minRectSide: 10 } as const;
export const DRAW_HIT_PX = { endpoint: 9, body: 6, rayBody: 4, hline: 7 } as const;

export function clampRayToRight(from: ChartPoint, to: ChartPoint, minStep = 1): ChartPoint {
  const step = Math.max(1, Math.round(minStep) || 1);
  if (to.time > from.time) return to;
  return { time: from.time + step, value: to.value };
}

export function snapshotsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function clampRectCornerPx(anchor: CoordPoint, moving: CoordPoint, minSidePx: number): CoordPoint {
  const minSide = Math.max(1, Number.isFinite(minSidePx) ? minSidePx : 1);
  const x = Math.abs(moving.x - anchor.x) < minSide
    ? anchor.x + (moving.x >= anchor.x ? minSide : -minSide)
    : moving.x;
  const y = Math.abs(moving.y - anchor.y) < minSide
    ? anchor.y + (moving.y >= anchor.y ? minSide : -minSide)
    : moving.y;
  return { x, y };
}

// Order a two-point segment left-to-right by time. Ties keep the first argument
// first (matches a stable sort). The trend preview and the committed trend both
// route through this so their endpoint ordering stays in parity.
export function orderSegmentByTime(a: ChartPoint, b: ChartPoint): [ChartPoint, ChartPoint] {
  return a.time <= b.time ? [a, b] : [b, a];
}

// Structural shape of a translatable drawing — kept local to the utils so the
// geometry layer stays decoupled from the panel's full DrawingSnapshot/style union.
export type DrawTranslatable =
  | { kind: "hline"; price: number; style?: unknown }
  | { kind: "trend" | "ray" | "rect"; from: ChartPoint; to: ChartPoint; style?: unknown };

// Translate a drawing by a (time, value) delta — the "move" drag transform. Shape
// is preserved; only positions shift. An hline has no time extent, so it takes the
// value delta only. Style and any other fields pass through untouched. Pure, so a
// zero delta is an exact no-op (which is what keeps no-op move drags out of history).
export function translateDrawing<T extends DrawTranslatable>(origin: T, dt: number, dv: number): T {
  if (origin.kind === "hline") {
    return { ...origin, price: origin.price + dv } as T;
  }
  return {
    ...origin,
    from: { time: origin.from.time + dt, value: origin.from.value + dv },
    to: { time: origin.to.time + dt, value: origin.to.value + dv },
  } as T;
}

// Normalize any two opposite rect corners into the closed 5-point polyline the
// chart series draws (TL → TR → BR → BL → TL). Pure + order-independent: the same
// two points in any drag direction produce identical geometry, which is what keeps
// the rect preview and the committed rect in parity.
export function rectCornerLoop(from: ChartPoint, to: ChartPoint): ChartPoint[] {
  const left = Math.min(from.time, to.time);
  const right = Math.max(from.time, to.time);
  const top = Math.max(from.value, to.value);
  const bottom = Math.min(from.value, to.value);
  return [
    { time: left, value: top },
    { time: right, value: top },
    { time: right, value: bottom },
    { time: left, value: bottom },
    { time: left, value: top },
  ];
}

// Resolve a dragged rectangle corner against its fixed anchor, keeping at least
// minSidePx on each side. The pixel clamp is zoom-independent, so this works in
// coordinate space via injected converters: chart time/value -> pixels (toCoord)
// and back (fromCoord). If either conversion is unavailable (off-screen, no candles,
// or a chart API returning null), it falls back to the raw moving point rather than
// producing a distorted corner. The injected converters are the only chart coupling,
// which makes the whole resize orchestration unit-testable with stub converters.
export function clampRectCornerWithCoords(
  anchorPt: ChartPoint,
  movingPt: ChartPoint,
  toCoord: (time: number, value: number) => CoordPoint | null,
  fromCoord: (x: number, y: number) => ChartPoint | null,
  minSidePx: number
): ChartPoint {
  const anchor = toCoord(anchorPt.time, anchorPt.value);
  const moving = toCoord(movingPt.time, movingPt.value);
  if (!anchor || !moving) return { time: movingPt.time, value: movingPt.value };
  const clamped = clampRectCornerPx(anchor, moving, minSidePx);
  return fromCoord(clamped.x, clamped.y) ?? { time: movingPt.time, value: movingPt.value };
}

export function deriveHitToleranceScale(candleSpacingPx: number, baseSpacingPx = 8): number {
  const spacing = Math.max(1, Number.isFinite(candleSpacingPx) ? candleSpacingPx : baseSpacingPx);
  const base = Math.max(1, Number.isFinite(baseSpacingPx) ? baseSpacingPx : 8);
  const raw = base / spacing;
  return Math.max(0.75, Math.min(1.8, raw));
}

// Convert two adjacent-candle x coordinates into a trustworthy pixel spacing for
// hit-tolerance scaling. A null coordinate (no mapping / off-screen) or a collapsed
// measurement (< 1px, e.g. both points clamped to the same chart edge) is treated
// as unreliable and falls back to the neutral base spacing — otherwise a collapsed
// spacing would be misread as ultra-dense candles and spike the hit tolerance to its
// max exactly at the chart edges.
export function measuredCandleSpacingPx(
  x0: number | null,
  x1: number | null,
  fallbackPx = 8
): number {
  const base = Math.max(1, Number.isFinite(fallbackPx) ? fallbackPx : 8);
  if (x0 == null || x1 == null) return base;
  const spacing = Math.abs(x1 - x0);
  if (!Number.isFinite(spacing) || spacing < 1) return base;
  return spacing;
}

export function deriveRayTimeStep(candles: Array<{ time: number }>, fallbackStep = 1): number {
  if (candles.length > 1) {
    return Math.max(1, candles[candles.length - 1].time - candles[candles.length - 2].time);
  }
  return Math.max(1, Number.isFinite(fallbackStep) ? Math.round(fallbackStep) : 1);
}

// Build the two-point polyline for a ray: anchored at `from`, extending to the right
// along the from->to slope. The endpoint is re-clamped to the right of the anchor
// (idempotent if already clamped) and extended well past the loaded data so the ray
// reads as infinite. Deterministic for identical inputs; candles drive the time step
// and extension length, so it is pure once candles are supplied (no store access).
export function buildRaySegment(
  from: ChartPoint,
  to: ChartPoint,
  candles: Array<{ time: number }>
): [ChartPoint, ChartPoint] {
  const clampedTo = clampRayToRight(from, to, deriveRayTimeStep(candles));
  const dx = clampedTo.time - from.time;
  const dy = clampedTo.value - from.value;
  const step = deriveRayTimeStep(candles, 3600);
  const fallbackEnd = Math.max(from.time, clampedTo.time) + step * 200;
  const dataEnd = candles.length ? candles[candles.length - 1].time + step * 50 : fallbackEnd;
  const endTime = Math.max(fallbackEnd, dataEnd);
  const safeDx = Math.abs(dx) < 1e-9 ? 1 : dx;
  const slope = dy / safeDx;
  const endValue = from.value + slope * (endTime - from.time);
  return [
    { time: from.time, value: from.value },
    { time: endTime, value: endValue },
  ];
}

export function hasDrawingDragChanges<T>(
  current: Array<{ snapshot: T } | undefined>,
  drag: DragSnapshot<T>
): boolean {
  if (drag.group?.length) {
    return drag.group.some((entry) => {
      const cur = current[entry.index]?.snapshot;
      return cur ? !snapshotsEqual(cur, entry.origin) : true;
    });
  }
  const cur = current[drag.index]?.snapshot;
  return cur ? !snapshotsEqual(cur, drag.origin) : true;
}

export function rollbackNoopDrawingDrag<T>(undoStack: T[], redoStack: T[], redoBefore?: T[]): T[] {
  undoStack.pop();
  return redoBefore ? redoBefore.slice() : redoStack;
}
