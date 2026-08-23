/**
 * Phase 3.3 — obstacle-aware routing.
 *
 * `routeLegs` received only its own label's bounds, so avoiding a neighbour was not unimplemented,
 * it was structurally impossible: the router could not see one. The goal names `leader-through-label`
 * as unreachable by placement work for exactly this reason, and notes neither repo does it — the
 * reference only detects it, and its Z-shape fallback avoids the MODEL BOX, not foreign labels.
 */
import { describe, expect, it } from 'vitest';
import { routeLegs } from '../src/routing.js';
import { segmentThroughInterior } from '../src/lint.js';

const LABEL = { x: 400, y: 100, width: 120, height: 30 };
const ANCHOR = { x: 100, y: 300 };

function hits(points: readonly { x: number; y: number }[], rect: typeof LABEL): number {
  let count = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (segmentThroughInterior({ start: points[index - 1]!, end: points[index]! }, rect)) count += 1;
  }
  return count;
}

function route(obstacles: readonly (typeof LABEL)[]): readonly { x: number; y: number }[] {
  return routeLegs(
    [{ id: 'leg', anchor: ANCHOR, route: { mode: 'dogleg' } }],
    LABEL,
    undefined,
    { obstacles },
  )[0]!.points;
}

describe('a leader bends around a label it would otherwise run through', () => {
  /** Squarely on the diagonal from the anchor up to the label's shoulder. */
  const inTheWay = { x: 230, y: 190, width: 120, height: 40 };

  it('runs straight through when nothing is told to it', () => {
    // The premise: without obstacles the direct route really does cross, so the test below is
    // measuring avoidance rather than a route that was never in trouble.
    expect(hits(route([]), inTheWay)).toBeGreaterThan(0);
  });

  it('clears the obstacle once it is passed in', () => {
    expect(hits(route([inTheWay]), inTheWay)).toBe(0);
  });

  it('keeps the shoulder and landing it would have had', () => {
    // Only the APPROACH changes. The landing run is what makes a leader read as a leader, and it is
    // also what phase 3.2's shared fan-in depends on.
    expect(route([inTheWay]).slice(-2)).toEqual(route([]).slice(-2));
  });

  it('takes the short way round rather than swinging to the bounding corner', () => {
    const detoured = route([inTheWay]);
    const direct = route([]);
    const span = (points: readonly { x: number; y: number }[]): number => points.slice(1).reduce(
      (total, point, index) => total + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y),
      0,
    );
    // A detour is longer than the straight line by definition; it must not be dramatically longer,
    // because every extra pixel of leader is more of it available to cross a neighbour's leader.
    expect(span(detoured)).toBeGreaterThan(span(direct));
    expect(span(detoured)).toBeLessThan(span(direct) * 1.5);
  });

  it('leaves the route alone when no bend helps', () => {
    // An obstacle straddling the label itself cannot be escaped by one bend. A pointless dog-leg is
    // worse than a straight diagonal a drafter can at least read, so nothing changes.
    const unavoidable = { x: 380, y: 60, width: 200, height: 200 };
    expect(route([unavoidable])).toEqual(route([]));
  });

  it('is deterministic and never mutates the obstacle list', () => {
    const obstacles = [inTheWay];
    const snapshot = JSON.stringify(obstacles);
    expect(route(obstacles)).toEqual(route(obstacles));
    expect(JSON.stringify(obstacles)).toBe(snapshot);
  });

  it('does not disturb a leader that was never in trouble', () => {
    const elsewhere = { x: 700, y: 500, width: 80, height: 20 };
    expect(route([elsewhere])).toEqual(route([]));
  });
});
