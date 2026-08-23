/** @vitest-environment jsdom */
/**
 * Phase 3.1 — the highest-severity single defect the audit found.
 *
 * `projectRegion` mapped every outline point through the host's projection and bailed all-or-nothing
 * the moment one came back invisible. `visible` is an NDC box test — `packages/three/src/index.ts`
 * requires x, y AND z within [-1, 1] — so it goes false as soon as a corner crosses the edge of the
 * screen, not just when the point is behind the camera.
 *
 * The result: zoom in on a revision cloud until one corner leaves the view, which is the normal
 * working zoom for a reviewer reading a markup, and the cloud AND its note vanish. Not clip —
 * vanish, along with the leader and the label, with no diagnostic.
 */
import { describe, expect, it } from 'vitest';
import { ViewLeader, type AnnotationDraft, type HostAdapterBundle } from 'viewleader';

const VIEWPORT = { width: 800, height: 600 };

/** The front wall, with the region drawn on it as a 4 m square. */
const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
} as const;

/**
 * Four DISTINCT x values, so panning takes the corners off screen one at a time. An axis-aligned
 * square has only two, so it can only ever be 0, 2 or 4 corners outside — the criterion's 1 and 3
 * would have been unreachable and the test would have quietly graded the same case twice.
 */
const CORNERS = [{ x: -3, y: -2 }, { x: 1, y: -2 }, { x: 3, y: 2 }, { x: -1, y: 2 }] as const;

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

/**
 * A camera at `pan`, with the same NDC visibility rule a real three.js adapter applies: a point is
 * `visible` only when it is inside the viewport box AND in front of the camera. `behind` flips the
 * whole scene behind the lens, where a perspective projection cannot produce an honest point.
 */
function adapters(pan: number, behind = false): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
      project: (point) => {
        if (behind) return null;
        const at = { x: 400 + (point.x - pan) * 60, y: 300 - point.y * 60 };
        return {
          point: at,
          depth: 0.5,
          visible: at.x >= 0 && at.x <= VIEWPORT.width && at.y >= 0 && at.y <= VIEWPORT.height,
        };
      },
      getRevision: () => pan,
    },
  };
}

function regionDraft(): AnnotationDraft {
  return {
    id: 'cloud',
    anchor: {
      kind: 'region',
      plane: PLANE,
      vertices: CORNERS,
      shape: 'revision-cloud',
      fallbackPoint: { x: 0, y: 0, z: 0 },
    },
    content: { kind: 'plain-note', text: 'RFI 041 — CLARIFY' },
  };
}

/** How many of the square's corners the camera at `pan` puts outside the viewport. */
function cornersOutside(pan: number): number {
  return CORNERS.filter((corner) => {
    const x = 400 + (corner.x - pan) * 60;
    return x < 0 || x > VIEWPORT.width;
  }).length;
}

function rendered(pan: number, behind = false): { drawn: boolean; outlinePoints: number } {
  const root = boundary();
  const leader = new ViewLeader({ boundary: root, adapters: adapters(pan, behind) });
  leader.annotations.create(regionDraft());
  leader.update();
  const group = root.querySelector('[data-annotation-id="cloud"]');
  const geometry = leader.geometry.of('cloud');
  const result = {
    drawn: group !== null && geometry !== undefined,
    outlinePoints: geometry?.regionHandles.length ?? 0,
  };
  leader.dispose();
  return result;
}

describe('a region survives its outline leaving the viewport', () => {
  it('renders whole while every corner is on screen', () => {
    expect(cornersOutside(0)).toBe(0);
    expect(rendered(0).drawn).toBe(true);
  });

  /**
   * The criterion, stated by the goal as "1, 2 and 3 of 4 corners outside the viewport all still
   * emit a `PlannedAnnotation`". Each pan below is chosen so a different number of corners is off
   * screen, asserted rather than assumed — a test that thought it was panning further than it was
   * would pass while grading the same frame three times.
   */
  it('still renders with 1, 2 and 3 of 4 corners outside', () => {
    // Corner cx leaves the left edge once pan > cx + 20/3, so these give exactly 1, 2 and 3.
    const pans = [4, 6, 8];
    const seen = new Set<number>();
    for (const pan of pans) {
      const outside = cornersOutside(pan);
      seen.add(outside);
      expect(outside).toBeGreaterThan(0);
      expect(outside).toBeLessThan(4);
      const result = rendered(pan);
      expect(result.drawn, `pan ${pan}: ${outside} of 4 corners outside`).toBe(true);
      // The outline keeps all four points: the off-screen ones still have a real screen position
      // and the SVG viewport clips them. Dropping them would deform the square into a triangle.
      expect(result.outlinePoints).toBeGreaterThanOrEqual(4);
    }
    // ...and the three pans really did produce three different amounts of clipping.
    expect(seen.size).toBe(3);
  });

  it('drops the region only once every corner is off screen', () => {
    // Nothing to clip and nothing to draw — this is the one case where vanishing is correct.
    const pan = 10;
    expect(cornersOutside(pan)).toBe(4);
    expect(rendered(pan).drawn).toBe(false);
  });

  it('emits nothing when the host cannot project the anchor at all', () => {
    // The easy case: `project` returns null, so there is no honest place to draw it.
    expect(rendered(0, true).drawn).toBe(false);
  });

  /**
   * The hard case, and the one keeping off-screen points made possible.
   *
   * A perspective projection BEHIND the lens still returns finite numbers — mirrored ones, because
   * the w-divide flips sign. So "finite" proves nothing, and a rule that kept every projectable
   * point would happily draw a region that is behind the viewer, at coordinates that are a
   * reflection of where it really is.
   *
   * `visible` is the only signal that separates them, since it is an NDC box test including z, and
   * `depth` cannot help: hosts disagree about what it means. So a region with no visible point is
   * drawn only when its outline CONTAINS the viewport — the zoomed-in-past-the-corners case — and
   * a mirrored outline that merely lands on screen is refused.
   */
  it('refuses a mirrored outline from behind the camera even though it projects finitely', () => {
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: {
        projection: {
          getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
          // Finite, on-screen, and never visible — exactly what a point behind the lens looks like.
          project: (point) => ({
            point: { x: 400 - point.x * 60, y: 300 + point.y * 60 },
            depth: -1,
            visible: false,
          }),
          getRevision: () => 1,
        },
      },
    });
    leader.annotations.create(regionDraft());
    leader.update();
    expect(root.querySelector('[data-annotation-id="cloud"]')).toBeNull();
    leader.dispose();
  });

  it('still draws a region zoomed in on until it is bigger than the window', () => {
    // No corner visible and every corner off screen, but the outline covers everything the user can
    // see. This is the case that separates "contains the viewport" from "intersects" it.
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: {
        projection: {
          getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
          project: (point) => {
            const at = { x: 400 + point.x * 900, y: 300 - point.y * 900 };
            return {
              point: at,
              depth: 0.5,
              visible: at.x >= 0 && at.x <= VIEWPORT.width && at.y >= 0 && at.y <= VIEWPORT.height,
            };
          },
          getRevision: () => 1,
        },
      },
    });
    leader.annotations.create(regionDraft());
    leader.update();
    expect(root.querySelector('[data-annotation-id="cloud"]')).not.toBeNull();
    leader.dispose();
  });

  /**
   * The defect as a user meets it: a smooth zoom in on the markup. Between any two adjacent frames
   * the annotation must not blink out — before this change it disappeared the instant the first
   * corner crossed the edge, and reappeared only if the user zoomed back out.
   */
  it('never blinks out between adjacent frames of a pan sweep', () => {
    const blinks: string[] = [];
    let previous = rendered(0).drawn;
    for (let step = 1; step <= 60; step += 1) {
      const pan = step * 0.25;
      const now = rendered(pan).drawn;
      // Losing it for good once the whole square is off screen is fine; flickering is not.
      if (previous && !now && cornersOutside(pan) < 4) blinks.push(`pan ${pan}`);
      previous = now;
    }
    expect(blinks).toEqual([]);
  });
});
