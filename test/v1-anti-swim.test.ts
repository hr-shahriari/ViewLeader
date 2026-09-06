/** @vitest-environment jsdom */
/**
 * Phase 2.4 — anti-swim, measured rather than asserted.
 *
 * "Labels must not swim" was previously a claim with no number behind it. This grades the two
 * things the goal names, on the pinned oracle over a 360-step orbit — one degree per frame, which
 * is a slow deliberate drag, the camera motion where swimming is most visible and least excusable.
 */
import { describe, expect, it } from 'vitest';
import { LabelPlacer, SECTOR_HYSTERESIS } from '../src/labelPlacer.js';
import { SCALE, VIEWPORT, scene } from './crowded-scene-harness.js';

/** One degree per step. Coarser steps hide swim by making every real motion look like a jump. */
const ORBIT_STEPS = 360;

/**
 * How far a label may move in one frame BEYOND its own anchor's movement, in screen pixels.
 *
 * Tracking the anchor is not swimming — if the model turns, the notes go with it, and a budget that
 * counted that would be a budget against the camera working. What this measures is the residual:
 * movement layout invented. 8 px is the measured p90 on scene A at one degree per frame (5.99 px)
 * rounded up to leave headroom for a scene with more labels, and it is well under a label's own
 * height, so a reader tracking one note never sees it leave the place they last looked.
 */
export const CREEP_BUDGET_PX = 8;

const MODEL = { min: { x: -3.3, y: 0, z: -3.3 }, max: { x: 3.3, y: 5.2, z: 3.3 } };

/** The layout frame's centre X: the projected model AABB, which is what the placer rails around. */
function frameCentreX(yaw: number): number {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const x of [MODEL.min.x, MODEL.max.x]) {
    for (const z of [MODEL.min.z, MODEL.max.z]) {
      const screenX = VIEWPORT.width / 2 + (x * cos - z * sin) * SCALE;
      low = Math.min(low, screenX);
      high = Math.max(high, screenX);
    }
  }
  return (low + high) / 2;
}

interface Sample { box: { x: number; y: number; width: number; height: number }; anchor: { x: number; y: number } }

function orbit(): { creeps: number[]; flipsTotal: number; flipsInDeadBand: number } {
  const handle = scene();
  const sample = (): Map<string, Sample> => new Map(handle.ids.flatMap((id) => {
    const geometry = handle.leader.geometry.of(id);
    const anchor = geometry?.legs[0]?.[0];
    return geometry === undefined || anchor === undefined ? [] : [[id, { box: geometry.label, anchor }] as const];
  }));

  let previous = sample();
  const creeps: number[] = [];
  let flipsTotal = 0;
  let flipsInDeadBand = 0;

  for (let step = 1; step <= ORBIT_STEPS; step += 1) {
    const yaw = (step / ORBIT_STEPS) * Math.PI * 2;
    handle.orbitTo(yaw);
    const centreX = frameCentreX(yaw);
    const now = sample();
    for (const [id, current] of now) {
      const before = previous.get(id);
      if (before === undefined) continue;
      const wasLeft = before.box.x + before.box.width / 2 < VIEWPORT.width / 2;
      const isLeft = current.box.x + current.box.width / 2 < VIEWPORT.width / 2;
      if (wasLeft === isLeft) {
        // Creep is what layout invented, so the anchor's own travel is subtracted out.
        creeps.push(Math.hypot(
          (current.box.x - before.box.x) - (current.anchor.x - before.anchor.x),
          (current.box.y - before.box.y) - (current.anchor.y - before.anchor.y),
        ));
        continue;
      }
      // A side change is legitimate once the anchor is genuinely past the centre line — over a full
      // orbit every anchor crosses twice, so demanding zero flips would demand a broken drawing.
      flipsTotal += 1;
      if (Math.abs(current.anchor.x - centreX) < SECTOR_HYSTERESIS) flipsInDeadBand += 1;
    }
    previous = now;
  }
  handle.leader.dispose();
  return { creeps, flipsTotal, flipsInDeadBand };
}

describe('anti-swim over a 360° orbit of scene A', () => {
  const result = orbit();

  it('never flips a label to the other side while its anchor is inside the dead-band', () => {
    // This is the criterion `SECTOR_HYSTERESIS = 24` exists to satisfy, and it holds: every one of
    // the side changes over a full orbit happened with the anchor genuinely past the centre line.
    expect(result.flipsInDeadBand).toBe(0);
    // ...and flips do happen, so the assertion above is not passing because nothing ever moves.
    expect(result.flipsTotal).toBeGreaterThan(20);
  });

  it('holds the typical frame well inside the creep budget', () => {
    const sorted = [...result.creeps].sort((left, right) => left - right);
    const percentile = (fraction: number): number => sorted[Math.floor(sorted.length * fraction)]!;
    expect(sorted.length).toBeGreaterThan(5_000);
    expect(percentile(0.5)).toBeLessThanOrEqual(CREEP_BUDGET_PX);
    expect(percentile(0.9)).toBeLessThanOrEqual(CREEP_BUDGET_PX);
  });

  it('does not turn a near-tie depth reorder into a primary/overflow jump', () => {
    const placer = new LabelPlacer();
    const frame = { min: { x: 300, y: 200 }, max: { x: 500, y: 400 } };
    const dims = new Map(['a', 'b', 'c'].map((id) => [id, { width: 96, height: 70 }]));
    const place = (xs: readonly number[]) => placer.computePlacements(
      ['a', 'b', 'c'].map((id, index) => ({ id, screenPos: { x: xs[index]!, y: 220 + index * 4 } })),
      frame,
      { x: 800, y: 600 },
      dims,
      undefined,
      'auto',
    ).map(({ annotationId, position, overflow }) => ({ annotationId, position, overflow }));
    const before = place([310, 310.01, 310.02]);
    expect(place([310.03, 310.01, 310])).toEqual(before);
  });
});
