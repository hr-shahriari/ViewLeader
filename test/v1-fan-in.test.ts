/**
 * Phase 3.2 — a multi-leg annotation produces ONE shared shoulder.
 *
 * `routeLegs` mapped each leg through `routeLeg` independently, and `doglegRoute` resolves both
 * `side: 'auto'` and the ASME Y14.5 ¶1.7.4 first-line/last-line rule from the leg's own anchor. So a
 * three-leg keynote whose anchors straddle the label got shoulders on OPPOSITE EDGES of it, and one
 * whose anchors straddle the label's middle got two shoulders at different text lines on the same
 * edge. A keynote is one note pointing at three things; it reads as one note only if the leaders
 * meet.
 */
import { describe, expect, it } from 'vitest';
// `lintFrame` and `CAP_RATIO` from the package entry — phase 1.4's criterion is that a host can
// lint with no internal imports. `routeLegs` is a layout primitive, not public surface, so it comes
// from the module the way every other routing test reaches it.
import { CAP_RATIO, lintFrame } from 'viewleader';
import { routeLegs, type RouteLegInput } from '../src/routing.js';

const LABEL = { x: 300, y: 200, width: 120, height: 40 };

function dogleg(id: string, x: number, y: number): RouteLegInput {
  return { id, anchor: { x, y }, route: { mode: 'dogleg' } };
}

/** The landing run every leg should share: its last two points. */
function shoulder(points: readonly { x: number; y: number }[]): string {
  return points.slice(-2).map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' → ');
}

describe('a multi-leg annotation lands on one shoulder', () => {
  it('shares a shoulder even when the anchors straddle the label', () => {
    // Two anchors left of the label, one well to its right — the case that used to produce a
    // shoulder on each edge, with the label sitting between two leaders pointing away from it.
    const legs = routeLegs(
      [dogleg('a', 100, 400), dogleg('b', 200, 420), dogleg('c', 600, 410)],
      LABEL,
    );
    expect(new Set(legs.map((leg) => shoulder(leg.points))).size).toBe(1);
    // The shared side follows the centroid of the anchors, which is left of the label here.
    expect(legs[0]!.points.at(-1)!.x).toBeLessThan(LABEL.x + LABEL.width / 2);
  });

  it('shares one text line rather than splitting first and last', () => {
    // Anchors above and below the label's middle. Per-leg resolution sent the top one to the first
    // line and the others to the last, so one label grew two landings a text line apart.
    const legs = routeLegs(
      [dogleg('a', 100, 100), dogleg('b', 120, 300), dogleg('c', 140, 500)],
      LABEL,
      { textLines: { first: 10, last: 30 } },
    );
    expect(new Set(legs.map((leg) => shoulder(leg.points))).size).toBe(1);
  });

  it('still obeys an explicit side — a drafter who wrote one said something', () => {
    const legs = routeLegs(
      [dogleg('a', 100, 400), dogleg('b', 200, 420), dogleg('c', 600, 410)],
      LABEL,
      { side: 'right' },
    );
    expect(new Set(legs.map((leg) => shoulder(leg.points))).size).toBe(1);
    for (const leg of legs) expect(leg.points.at(-1)!.x).toBeGreaterThan(LABEL.x + LABEL.width / 2);
  });

  it('leaves a single-leg annotation exactly as it was', () => {
    // Nothing to share, so nothing may change: this is the overwhelmingly common case.
    const alone = routeLegs([dogleg('only', 100, 400)], LABEL);
    const withOthers = routeLegs([dogleg('only', 100, 400)], LABEL, { side: 'left' });
    expect(shoulder(alone[0]!.points)).toBe(shoulder(withOthers[0]!.points));
  });

  it('ignores non-dogleg legs when deciding the shared side', () => {
    // Straight and manual routes never read `landing`, so they must not drag the fan across the
    // label — only the legs that actually land on the shoulder get a say in where it is.
    const legs = routeLegs([
      dogleg('a', 100, 400),
      dogleg('b', 120, 420),
      { id: 'straight', anchor: { x: 900, y: 400 }, route: { mode: 'straight' } },
    ], LABEL);
    const doglegs = legs.filter((leg) => leg.id !== 'straight');
    expect(new Set(doglegs.map((leg) => shoulder(leg.points))).size).toBe(1);
    expect(doglegs[0]!.points.at(-1)!.x).toBeLessThan(LABEL.x + LABEL.width / 2);
  });
});

/**
 * Phase 1.4 built the exemption; this is the case it was built for. `MERGE_EPS = 0.5` exempts a
 * crossing whose segments share an endpoint, because a fan-in MEETS rather than crosses — and
 * `leader-crossing` is severity `error` and is the oracle phases 2 and 3 are graded on, so a fan-in
 * that trips it would make the grader unusable at exactly the moment this phase built one.
 */
describe('the standards lint does not call a fan-in a crossing', () => {
  it('reports nothing for three legs meeting at one shoulder', () => {
    const legs = routeLegs(
      [dogleg('a', 100, 400), dogleg('b', 200, 420), dogleg('c', 600, 410)],
      LABEL,
    );
    const findings = lintFrame(
      legs.map((leg) => ({
        annotationId: 'keynote',
        legId: leg.id,
        points: leg.points,
        label: LABEL,
        fontSize: 12,
        capHeightRatio: CAP_RATIO,
        annotationScale: 1,
      })),
      { pixelsPerMillimetre: 96 / 25.4, minimumTextHeightMm: 2.5, angleToleranceDegrees: 2 },
    );
    expect(findings.filter((finding) => finding.ruleId === 'leader-crossing')).toEqual([]);
  });
});
