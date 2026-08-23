/**
 * Phase 3.3 — leader breaks (DIMBREAK).
 *
 * The goal names them as the only remedy for a crossing the placer cannot swap away, and phase 3.3's
 * measurement agreed: after obstacle-aware routing, the residue was dominated by leaders with nowhere
 * better to go and by a three-leg fan whose swept triangle every neighbour must cross. A break is the
 * drafting convention for exactly that — the leader keeps its route and stops being DRAWN where
 * something else owns the pixels.
 *
 * The representation question — is a broken leader still one polyline — is answered by the code
 * rather than by preference: `runtime.ts` index-maps `geometry.legs[index]` to the annotation's legs,
 * so a leg cannot become two entries. The logical route therefore stays one polyline (grips, hit
 * testing and that index mapping all keep working), and the break is a derived DRAWN geometry that
 * the renderer paints and `lintFrame` grades. Both read the same pieces, which is the point: a break
 * the drawing shows and the grader cannot see would make the drawing right and the grader wrong.
 */
import { describe, expect, it } from 'vitest';
import { breakAroundObstacles } from '../src/routing.js';
import { segmentThroughInterior } from '../src/lint.js';

const LEADER = [{ x: 0, y: 100 }, { x: 400, y: 100 }] as const;
const IN_THE_WAY = { x: 150, y: 60, width: 100, height: 80 };

function crosses(pieces: readonly (readonly { x: number; y: number }[])[], rect: typeof IN_THE_WAY): boolean {
  return pieces.some((piece) => piece.slice(1).some((point, index) =>
    segmentThroughInterior({ start: piece[index]!, end: point }, rect)));
}

describe('a leader is gapped where it passes under a foreign label', () => {
  it('leaves a leader alone when nothing is in the way', () => {
    expect(breakAroundObstacles(LEADER, [])).toEqual([LEADER]);
    expect(breakAroundObstacles(LEADER, [{ x: 0, y: 500, width: 50, height: 50 }])).toEqual([LEADER]);
  });

  it('splits into two pieces that no longer enter the label', () => {
    const pieces = breakAroundObstacles(LEADER, [IN_THE_WAY]);
    expect(pieces).toHaveLength(2);
    expect(crosses(pieces, IN_THE_WAY)).toBe(false);
    // The unbroken leader did cross it, so the assertion above is not passing on a route that was
    // never in trouble.
    expect(crosses([LEADER], IN_THE_WAY)).toBe(true);
  });

  it('keeps both ends where they were', () => {
    const pieces = breakAroundObstacles(LEADER, [IN_THE_WAY]);
    expect(pieces[0]![0]).toEqual(LEADER[0]);
    expect(pieces.at(-1)!.at(-1)).toEqual(LEADER[1]);
  });

  it('leaves clear air on both sides of the label, not a hairline', () => {
    const [before, after] = breakAroundObstacles(LEADER, [IN_THE_WAY]);
    // The gap starts before the label's edge and resumes after it, so it reads as deliberate.
    expect(before!.at(-1)!.x).toBeLessThan(IN_THE_WAY.x);
    expect(after![0]!.x).toBeGreaterThan(IN_THE_WAY.x + IN_THE_WAY.width);
  });

  /**
   * The case phase 3.3 measured as 21 of 34 residual pairs: the note is pointing at something a
   * foreign label is sitting on top of. Breaking there would delete the end that points at the thing
   * being annotated — worse than the overlap it would hide.
   */
  it('refuses to break a leader whose own arrowhead is under the label', () => {
    const startsInside = [{ x: 200, y: 100 }, { x: 400, y: 100 }] as const;
    expect(breakAroundObstacles(startsInside, [IN_THE_WAY])).toEqual([startsInside]);
  });

  it('handles several labels in a row, and a bend', () => {
    const second = { x: 300, y: 60, width: 40, height: 80 };
    const pieces = breakAroundObstacles(LEADER, [IN_THE_WAY, second]);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(crosses(pieces, IN_THE_WAY)).toBe(false);
    expect(crosses(pieces, second)).toBe(false);

    const bent = [{ x: 0, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 400 }] as const;
    const across = { x: 160, y: 200, width: 90, height: 60 };
    expect(crosses(breakAroundObstacles(bent, [across]), across)).toBe(false);
  });

  it('is pure and deterministic', () => {
    const obstacles = [IN_THE_WAY];
    const snapshot = JSON.stringify([LEADER, obstacles]);
    expect(breakAroundObstacles(LEADER, obstacles)).toEqual(breakAroundObstacles(LEADER, obstacles));
    expect(JSON.stringify([LEADER, obstacles])).toBe(snapshot);
  });
});
