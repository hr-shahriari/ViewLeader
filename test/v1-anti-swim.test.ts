/** @vitest-environment jsdom */
/**
 * Phase 2.4 — anti-swim, measured rather than asserted.
 *
 * "Labels must not swim" was previously a claim with no number behind it. This grades the two
 * things the goal names, on the pinned oracle over a 360-step orbit — one degree per frame, which
 * is a slow deliberate drag, the camera motion where swimming is most visible and least excusable.
 */
import { describe, expect, it } from 'vitest';
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

/**
 * The dead-band a label's anchor must cross before its side is allowed to change, in screen pixels.
 * Mirrors `SECTOR_HYSTERESIS` in `labelPlacer.ts`, which is the number being graded.
 */
const DEAD_BAND_PX = 24;

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
      if (Math.abs(current.anchor.x - centreX) < DEAD_BAND_PX) flipsInDeadBand += 1;
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

  /**
   * **The tail is over budget and this records it rather than hiding it.**
   *
   * Measured: p99 is about 121 px and the worst single frame about 256 px, in labels that never
   * changed column. The cause is not drift and not the slot ordering — it is membership of the
   * primary/overflow split in `placeQuadrant`. Overflow labels stack AWAY from the frame (above
   * `boundary.min.y` for the top quadrants) while primary labels sit beside it, so a label crossing
   * that boundary teleports the whole distance between the two regions in one frame. The jumps have
   * exactly that signature: y 115 → 378 with x unchanged, at a camera step of one degree.
   *
   * The split is decided by an X-sorted budget walk with no hysteresis of any kind, and X order
   * churns continuously during an orbit. Fixing it needs membership memory, the same way
   * `stickySector` needed sector memory. Tracked as a bounded number until then: it may fall, never
   * rise.
   */
  it('records the tail, which is primary/overflow churn and is not yet within budget', () => {
    const sorted = [...result.creeps].sort((left, right) => left - right);
    const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
    expect(p99).toBeGreaterThan(CREEP_BUDGET_PX); // if this ever fails, the tail was fixed — raise the bar
    expect(p99).toBeLessThanOrEqual(130);
    expect(sorted[sorted.length - 1]!).toBeLessThanOrEqual(260);
  });
});
