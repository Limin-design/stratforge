import {
  buildRaySegment,
  clampRayToRight,
  clampRectCornerPx,
  clampRectCornerWithCoords,
  deriveHitToleranceScale,
  deriveRayTimeStep,
  hasDrawingDragChanges,
  measuredCandleSpacingPx,
  orderSegmentByTime,
  rectCornerLoop,
  rollbackNoopDrawingDrag,
  snapshotsEqual,
  translateDrawing,
} from "../src/panels/chartDrawingUtils.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const anchor = { time: 1000, value: 42 };

const right = clampRayToRight(anchor, { time: 1050, value: 45 }, 60);
assert(right.time === 1050, "ray endpoint on the right should remain unchanged");
assert(right.value === 45, "ray endpoint value on the right should remain unchanged");

const left = clampRayToRight(anchor, { time: 980, value: 39 }, 60);
assert(left.time === 1060, "ray endpoint must clamp to anchor + step when dragged left");
assert(left.value === 39, "ray endpoint clamp must preserve value");

const a = { kind: "ray", from: anchor, to: { time: 1060, value: 39 } };
const b = { kind: "ray", from: anchor, to: { time: 1060, value: 39 } };
const c = { kind: "ray", from: anchor, to: { time: 1061, value: 39 } };
assert(snapshotsEqual(a, b), "snapshot equality should detect identical snapshots");
assert(!snapshotsEqual(a, c), "snapshot equality should detect changed snapshots");

const rectAnchor = { x: 200, y: 100 };
const rectMovingNear = { x: 204, y: 96 };
const rectClamped = clampRectCornerPx(rectAnchor, rectMovingNear, 10);
assert(Math.abs(rectClamped.x - rectAnchor.x) >= 10, "rect x side must clamp to minimum size");
assert(Math.abs(rectClamped.y - rectAnchor.y) >= 10, "rect y side must clamp to minimum size");

const denseScale = deriveHitToleranceScale(3);
const sparseScale = deriveHitToleranceScale(24);
assert(denseScale > 1, "dense candle spacing should increase hit tolerance");
assert(sparseScale < 1, "sparse candle spacing should decrease hit tolerance");
assert(deriveHitToleranceScale(0.2) <= 1.8, "hit tolerance should respect max clamp");
assert(deriveHitToleranceScale(1000) >= 0.75, "hit tolerance should respect min clamp");

const sampleCandles = [{ time: 1000 }, { time: 1060 }, { time: 1120 }];
assert(deriveRayTimeStep(sampleCandles) === 60, "ray time step should use latest candle delta");
assert(deriveRayTimeStep([], 3600) === 3600, "ray time step should honor fallback when candles missing");

const draw0 = { kind: "trend", from: { time: 1000, value: 42 }, to: { time: 1100, value: 46 } };
const draw1 = { kind: "hline", price: 40 };
const currentNoOp = [{ snapshot: draw0 }, { snapshot: draw1 }];
const groupNoOp = {
  index: 0,
  origin: draw0,
  group: [
    { index: 0, origin: draw0 },
    { index: 1, origin: draw1 },
  ],
};
assert(!hasDrawingDragChanges(currentNoOp, groupNoOp), "multi-select no-op drag must not be treated as changed");

const currentChanged = [{ snapshot: { ...draw0, to: { time: 1120, value: 47 } } }, { snapshot: draw1 }];
assert(hasDrawingDragChanges(currentChanged, groupNoOp), "multi-select drag with changed member must be treated as changed");

const undoStack = [{ drawings: [draw0], selectedIndices: [0] }, { drawings: [draw0, draw1], selectedIndices: [1] }];
const redoStack = [{ drawings: [draw1], selectedIndices: [0] }];
const redoBefore = [{ drawings: [draw0], selectedIndices: [0] }];
const restoredRedo = rollbackNoopDrawingDrag(undoStack, redoStack, redoBefore);
assert(undoStack.length === 1, "no-op drag rollback must remove the speculative undo snapshot");
assert(restoredRedo.length === 1 && snapshotsEqual(restoredRedo[0], redoBefore[0]), "no-op drag rollback must restore pre-drag redo history");
assert(restoredRedo !== redoBefore, "no-op drag rollback must return a defensive redo copy");

// --- Edge cases: extreme zoom, sparse/degenerate candles, non-finite inputs ---

// deriveHitToleranceScale: sub-pixel spacing pins to the max clamp, very sparse
// spacing pins to the min clamp, spacing == base is neutral, non-finite falls back
// to base (neutral). These bound the zoom-aware hit tolerance exactly.
assert(deriveHitToleranceScale(0.2) === 1.8, "sub-pixel candle spacing must pin hit tolerance to the 1.8 max");
assert(deriveHitToleranceScale(100000) === 0.75, "extremely sparse spacing must pin hit tolerance to the 0.75 min");
assert(deriveHitToleranceScale(8) === 1, "spacing equal to base spacing should be neutral (scale 1)");
assert(deriveHitToleranceScale(Number.NaN) === 1, "non-finite spacing must fall back to neutral base scale");
assert(deriveHitToleranceScale(4) > deriveHitToleranceScale(16), "denser spacing must yield a larger tolerance than sparser spacing");

// deriveRayTimeStep: 0 and 1 candle both hit the fallback path; 2+ candles use the
// last interval; unequal intervals use only the most recent delta; degenerate equal
// timestamps clamp to >=1; non-finite / negative fallbacks clamp to 1.
assert(deriveRayTimeStep([]) === 1, "no candles with default fallback must yield step 1");
assert(deriveRayTimeStep([{ time: 1000 }]) === 1, "single candle with default fallback must yield step 1");
assert(deriveRayTimeStep([{ time: 1000 }], 3600) === 3600, "single candle must honor explicit fallback");
assert(deriveRayTimeStep([{ time: 1000 }, { time: 1090 }]) === 90, "two candles must use their interval");
assert(deriveRayTimeStep([{ time: 1000 }, { time: 1060 }, { time: 1090 }]) === 30, "unequal intervals must use the most recent delta");
assert(deriveRayTimeStep([{ time: 1000 }, { time: 1000 }]) === 1, "degenerate equal timestamps must clamp step to >=1");
assert(deriveRayTimeStep([], Number.NaN) === 1, "non-finite fallback must clamp to 1");
assert(deriveRayTimeStep([], -50) === 1, "negative fallback must clamp to 1");

// clampRectCornerPx: a zero-area (same point) drag must still open a min-side box,
// biased toward +min; dragging up/left biases negative; non-finite minSide -> 1.
const degenRect = clampRectCornerPx({ x: 200, y: 100 }, { x: 200, y: 100 }, 10);
assert(degenRect.x === 210 && degenRect.y === 110, "same-point rect corner must open a +minSide box on both axes");
const upLeftRect = clampRectCornerPx({ x: 200, y: 100 }, { x: 196, y: 95 }, 10);
assert(upLeftRect.x === 190 && upLeftRect.y === 90, "up/left near-corner must clamp toward -minSide");
const nanSideRect = clampRectCornerPx({ x: 0, y: 0 }, { x: 0, y: 0 }, Number.NaN);
assert(nanSideRect.x === 1 && nanSideRect.y === 1, "non-finite minSide must fall back to 1px");

// clampRayToRight: a zero-dx endpoint must push right by the step; fractional step
// rounds; zero/non-finite step falls back to 1.
const zeroDx = clampRayToRight({ time: 1000, value: 5 }, { time: 1000, value: 7 }, 60);
assert(zeroDx.time === 1060 && zeroDx.value === 7, "zero-dx ray must push right by step, preserving value");
assert(clampRayToRight({ time: 1000, value: 5 }, { time: 990, value: 7 }, 2.4).time === 1002, "fractional step must round before clamping");
assert(clampRayToRight({ time: 1000, value: 5 }, { time: 990, value: 7 }, 0).time === 1001, "zero step must fall back to 1");
assert(clampRayToRight({ time: 1000, value: 5 }, { time: 990, value: 7 }, Number.NaN).time === 1001, "non-finite step must fall back to 1");

// rectCornerLoop: the rect preview and the committed rect both route through this
// pure builder, so locking it locks preview/commit parity. The loop must be a
// closed 5-point TL→TR→BR→BL→TL polyline, normalized to min/max regardless of which
// opposite corners are passed or in which drag direction.
const cornerA = { time: 1000, value: 50 };
const cornerB = { time: 1200, value: 30 };
const loopForward = rectCornerLoop(cornerA, cornerB);
const loopReverse = rectCornerLoop(cornerB, cornerA);
const loopCrossed = rectCornerLoop({ time: 1200, value: 50 }, { time: 1000, value: 30 });
assert(loopForward.length === 5, "rect loop must have 5 points (closed polyline)");
assert(snapshotsEqual(loopForward, loopReverse), "rect geometry must be identical regardless of corner order (preview/commit parity)");
assert(snapshotsEqual(loopForward, loopCrossed), "rect geometry must be identical regardless of drag direction");
assert(snapshotsEqual(loopForward[0], loopForward[4]), "rect loop must close on its first point");
const xs = loopForward.map((p) => p.time);
const ys = loopForward.map((p) => p.value);
assert(Math.min(...xs) === 1000 && Math.max(...xs) === 1200, "rect loop must span the full time extent");
assert(Math.min(...ys) === 30 && Math.max(...ys) === 50, "rect loop must span the full value extent");
const degenLoop = rectCornerLoop({ time: 1000, value: 40 }, { time: 1000, value: 40 });
assert(degenLoop.length === 5 && degenLoop.every((p) => p.time === 1000 && p.value === 40), "degenerate rect loop must stay a valid 5-point collapse");

// orderSegmentByTime: the trend preview and the committed trend both route through
// this, so locking it locks trend endpoint parity. Output must be left-to-right by
// time regardless of input order; equal-time inputs must keep the first argument
// first (stable-sort parity with the previous inline .sort).
const segL = { time: 1000, value: 50 };
const segR = { time: 1200, value: 30 };
const orderedForward = orderSegmentByTime(segL, segR);
const orderedReverse = orderSegmentByTime(segR, segL);
assert(orderedForward[0].time === 1000 && orderedForward[1].time === 1200, "segment must be ordered left-to-right by time");
assert(snapshotsEqual(orderedForward, orderedReverse), "segment geometry must be identical regardless of input order (preview/commit parity)");
const tieA = { time: 1000, value: 7 };
const tieB = { time: 1000, value: 9 };
const orderedTie = orderSegmentByTime(tieA, tieB);
assert(orderedTie[0].value === 7 && orderedTie[1].value === 9, "equal-time segment must keep the first argument first (stable)");

// measuredCandleSpacingPx: feeds hitToleranceScale. A real measured spacing passes
// through; a null coordinate or a collapsed measurement (< 1px, e.g. both adjacent
// candle x's clamped to the same chart edge) is unreliable and falls back to the
// neutral base spacing — which keeps deriveHitToleranceScale at the neutral scale (1)
// instead of spiking to its 1.8 max at the chart edges.
assert(measuredCandleSpacingPx(100, 124) === 24, "a real measured spacing must pass through unchanged");
assert(measuredCandleSpacingPx(124, 100) === 24, "spacing must be magnitude-only (order-independent)");
assert(measuredCandleSpacingPx(null, 124) === 8, "a null left coordinate must fall back to base spacing");
assert(measuredCandleSpacingPx(100, null) === 8, "a null right coordinate must fall back to base spacing");
assert(measuredCandleSpacingPx(300, 300) === 8, "a collapsed (0px) edge measurement must fall back to base spacing");
assert(measuredCandleSpacingPx(300, 300.4) === 8, "a sub-pixel collapsed measurement must fall back to base spacing");
assert(measuredCandleSpacingPx(null, null, 12) === 12, "an explicit fallback must be honored when coords are null");
assert(measuredCandleSpacingPx(300, 300, Number.NaN) === 8, "a non-finite fallback must clamp to base 8");
// Regression guard: the collapsed measurement must NOT spike hit tolerance to its max.
assert(deriveHitToleranceScale(measuredCandleSpacingPx(300, 300)) === 1, "collapsed-edge spacing must keep hit tolerance neutral, not at the 1.8 max");

// translateDrawing: the "move" drag transform (single + multi-select group). Both
// endpoints shift by the same (dt, dv); an hline shifts by dv only (no time extent);
// style and shape are preserved; a zero delta is an exact no-op (which is what keeps
// no-op move drags from being recorded as changes).
const segOrigin = { kind: "trend", from: { time: 1000, value: 40 }, to: { time: 1100, value: 50 }, style: { color: "#abc" } };
const segMoved = translateDrawing(segOrigin, 25, -3);
assert(segMoved.kind === "trend" && segMoved.from.time === 1025 && segMoved.from.value === 37, "move must shift the from endpoint by (dt, dv)");
assert(segMoved.to.time === 1125 && segMoved.to.value === 47, "move must shift the to endpoint by the same (dt, dv)");
assert(segMoved.to.time - segMoved.from.time === 100 && segMoved.to.value - segMoved.from.value === 10, "move must preserve segment shape (translation only)");
assert(snapshotsEqual(segMoved.style, segOrigin.style), "move must preserve style");
assert(snapshotsEqual(segOrigin, { kind: "trend", from: { time: 1000, value: 40 }, to: { time: 1100, value: 50 }, style: { color: "#abc" } }), "translateDrawing must not mutate its input");

const hlineOrigin = { kind: "hline", price: 42, style: { color: "#def" } };
const hlineMoved = translateDrawing(hlineOrigin, 999, 8);
assert(hlineMoved.kind === "hline" && hlineMoved.price === 50, "hline move must apply the value delta to price");
assert(!("from" in hlineMoved), "hline move must not gain segment endpoints");
assert(snapshotsEqual(hlineMoved.style, hlineOrigin.style), "hline move must preserve style");

const noOpMove = translateDrawing(segOrigin, 0, 0);
assert(snapshotsEqual(noOpMove, segOrigin), "a zero-delta move must be an exact no-op");

// clampRectCornerWithCoords: the endpoint-resize orchestration, previously only
// reachable through the live chart. Stub converters (identity px<->coord mapping)
// exercise the null-coord guards, the min-side pixel clamp, and the round-trip.
const idToCoord = (time: number, value: number) => ({ x: time, y: value });
const idFromCoord = (x: number, y: number) => ({ time: x, value: y });
// Comfortably-sized corner: passes through unchanged (no clamp needed).
const bigCorner = clampRectCornerWithCoords({ time: 100, value: 100 }, { time: 140, value: 140 }, idToCoord, idFromCoord, 10);
assert(bigCorner.time === 140 && bigCorner.value === 140, "a corner beyond the min side must pass through unchanged");
// Too-small corner: must be pushed out to the min side on both axes (identity mapping).
const tightCorner = clampRectCornerWithCoords({ time: 100, value: 100 }, { time: 103, value: 96 }, idToCoord, idFromCoord, 10);
assert(tightCorner.time === 110 && tightCorner.value === 90, "a sub-min corner must clamp to anchor +/- min side via the round-trip");
// Null anchor conversion: must fall back to the raw moving point, not distort.
const nullAnchor = clampRectCornerWithCoords({ time: 100, value: 100 }, { time: 103, value: 96 }, () => null, idFromCoord, 10);
assert(nullAnchor.time === 103 && nullAnchor.value === 96, "a null anchor conversion must fall back to the raw moving point");
// Null moving conversion: same fallback.
const nullMoving = clampRectCornerWithCoords({ time: 100, value: 100 }, { time: 103, value: 96 }, (t, v) => (v === 96 ? null : { x: t, y: v }), idFromCoord, 10);
assert(nullMoving.time === 103 && nullMoving.value === 96, "a null moving conversion must fall back to the raw moving point");
// fromCoord returns null after a successful clamp: must still fall back, not throw.
const nullBack = clampRectCornerWithCoords({ time: 100, value: 100 }, { time: 103, value: 96 }, idToCoord, () => null, 10);
assert(nullBack.time === 103 && nullBack.value === 96, "a null inverse conversion must fall back to the raw moving point");

// buildRaySegment: the last geometry builder, previously reachable only via the store.
// A ray is anchored at `from` and extends right along the from->clamped slope. The
// internal re-clamp must be idempotent (a raw-left and a pre-clamped endpoint produce
// identical geometry), the anchor must be preserved, and the extension must stay on
// the anchor->endpoint line and to the right of the anchor.
const rayCandles = [{ time: 1000 }, { time: 1060 }, { time: 1120 }]; // step 60
const rayFrom = { time: 1000, value: 10 };
const rayRawLeftTo = { time: 980, value: 20 };   // left of anchor -> clamps to anchor + step
const rayPreClampedTo = { time: 1060, value: 20 }; // already clamped
const rayFromRaw = buildRaySegment(rayFrom, rayRawLeftTo, rayCandles);
const rayFromClamped = buildRaySegment(rayFrom, rayPreClampedTo, rayCandles);
assert(snapshotsEqual(rayFromRaw, rayFromClamped), "ray geometry must be identical for raw-left vs pre-clamped endpoint (re-clamp is idempotent)");
assert(snapshotsEqual(rayFromRaw[0], rayFrom), "ray must keep its anchor point unchanged");
assert(rayFromRaw[1].time > rayFrom.time, "ray must extend to the right of its anchor");
const raySlope = (rayPreClampedTo.value - rayFrom.value) / (rayPreClampedTo.time - rayFrom.time);
const rayExpectedEnd = rayFrom.value + raySlope * (rayFromRaw[1].time - rayFrom.time);
assert(Math.abs(rayFromRaw[1].value - rayExpectedEnd) < 1e-6, "ray endpoint must preserve the anchor->endpoint slope");
const rayFlat = buildRaySegment({ time: 1000, value: 42 }, { time: 1100, value: 42 }, rayCandles);
assert(rayFlat[0].value === 42 && rayFlat[1].value === 42, "a horizontal ray must stay flat");
const rayNoCandles = buildRaySegment(rayFrom, { time: 1100, value: 30 }, []);
assert(rayNoCandles[1].time > rayFrom.time && Number.isFinite(rayNoCandles[1].value), "ray must extend right with a finite value even with no candles loaded");
assert(snapshotsEqual(buildRaySegment(rayFrom, rayRawLeftTo, rayCandles), rayFromRaw), "ray builder must be deterministic for identical inputs");

console.log("chart drawings smoke passed");
