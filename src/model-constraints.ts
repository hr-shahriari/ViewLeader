import type { Bounds2 } from './frame.js';
import type { ConnectionEdge } from './labelPlacer.js';
import type { ScreenBounds } from './routing.js';

/** A small visible gap between model and label; unlike the rail distance, this is a hard minimum. */
export const MODEL_CLEARANCE = 12;

/** A drawn guide can enlarge a protected rectangle, but can never shrink the model. */
export function enclosingBounds(model: Bounds2, guide?: Bounds2): Bounds2 {
  if (guide === undefined) return model;
  return {
    min: { x: Math.min(model.min.x, guide.min.x), y: Math.min(model.min.y, guide.min.y) },
    max: { x: Math.max(model.max.x, guide.max.x), y: Math.max(model.max.y, guide.max.y) },
  };
}

/**
 * Preserve a feasible position, otherwise move the whole label out to its assigned side. Manual
 * positions have no assigned side and use the shortest correction, with deterministic ties.
 * This never clamps to the viewport: model clearance wins when there is no visible room.
 */
export function constrainOutsideModel(
  label: ScreenBounds,
  model: Bounds2,
  edge?: ConnectionEdge,
): ScreenBounds {
  const left = model.min.x - MODEL_CLEARANCE - label.width;
  const right = model.max.x + MODEL_CLEARANCE;
  const top = model.min.y - MODEL_CLEARANCE - label.height;
  const bottom = model.max.y + MODEL_CLEARANCE;
  if (label.x <= left || label.x >= right || label.y <= top || label.y >= bottom) return label;
  const choices = [
    { ...label, x: left },
    { ...label, x: right },
    { ...label, y: top },
    { ...label, y: bottom },
  ];
  if (edge !== undefined) return choices[{ right: 0, left: 1, bottom: 2, top: 3 }[edge]]!;
  return choices.reduce((best, next) =>
    Math.hypot(next.x - label.x, next.y - label.y) < Math.hypot(best.x - label.x, best.y - label.y)
      ? next : best);
}
