/** @vitest-environment jsdom */
/**
 * Phase 2.3. Two knobs that existed but could not be reached: `runtime.ts` hardcoded `'sides'` at
 * the one `computePlacements` call site, making `'rows'` and `'auto'` dead code along with
 * `LabelPlacer.lastUseRows` and `AUTO_ROWS_EXIT_MARGIN`; and it passed `undefined` for `insets`, so
 * a host could not say "my toolbar owns the bottom 80 px" and labels landed under the chrome.
 *
 * Both are now public on `ViewLeader`. These tests grade that they are reachable *and* that they
 * change the drawing — a setter that stores a value nobody reads is the defect, not the fix.
 */
import { describe, expect, it } from 'vitest';
import { ViewLeader, type HostAdapterBundle, type PlacementMode } from 'viewleader';
import { ORBIT_STEPS, overlappingPairs, scene } from './crowded-scene-harness.js';

const VIEWPORT = { width: 900, height: 640 };

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

/** A tall model box, so the layout frame is unambiguously taller than it is wide. */
function adapters(): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
      project: (point) => ({ point: { x: 450 + point.x * 30, y: 320 - point.y * 30 }, depth: 0, visible: true }),
      getRevision: () => 1,
    },
    modelBounds: { get: () => ({ min: { x: -2, y: -4, z: 0 }, max: { x: 2, y: 4, z: 0 } }) },
  };
}

function withNotes(count: number): ViewLeader {
  const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    leader.annotations.create({
      id: `n${String(index).padStart(2, '0')}`,
      anchor: { kind: 'world-point', point: { x: Math.cos(angle) * 1.8, y: Math.sin(angle) * 3.6, z: 0 } },
      content: { kind: 'plain-note', text: `NOTE ${index}` },
    });
  }
  leader.update();
  return leader;
}

/** The layout frame in screen pixels, for each model box below, under the projection above. */
const TALL_FRAME = { left: 390, right: 510, top: 200, bottom: 440 };
const WIDE_FRAME = { left: 210, right: 690, top: 290, bottom: 350 };

/**
 * Which arrangement the frame was laid out in.
 *
 * Not "is this label beside or above the frame" — a label in the bottom row of a narrow frame is
 * both, and classifying it by whichever test runs first reports whichever test ran first. What
 * separates the two modes is which *band* every label clears: columns clear the frame's horizontal
 * band, rows clear its vertical one.
 */
function arrangement(
  leader: ViewLeader,
  ids: readonly string[],
  frame: { left: number; right: number; top: number; bottom: number },
): 'columns' | 'rows' | 'mixed' {
  const boxes = ids.map((id) => leader.geometry.of(id)?.label).filter((box) => box !== undefined);
  if (boxes.length === 0) return 'mixed';
  const clearsX = boxes.every((box) => box!.x + box!.width <= frame.left || box!.x >= frame.right);
  const clearsY = boxes.every((box) => box!.y + box!.height <= frame.top || box!.y >= frame.bottom);
  return clearsX && !clearsY ? 'columns' : clearsY && !clearsX ? 'rows' : 'mixed';
}

describe('placement mode is public and all three modes are reachable', () => {
  it('defaults to auto', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    expect(leader.placementMode).toBe('auto');
    leader.dispose();
  });

  it('puts labels in columns under sides and above/below under rows', () => {
    const ids = Array.from({ length: 8 }, (_, index) => `n${String(index).padStart(2, '0')}`);

    const sides = withNotes(8);
    sides.setPlacementMode('sides');
    sides.update();
    expect(arrangement(sides, ids, TALL_FRAME)).toBe('columns');
    sides.dispose();

    const rows = withNotes(8);
    rows.setPlacementMode('rows');
    rows.update();
    // The whole point of the mode: a different arrangement, not a different name for the same one.
    expect(arrangement(rows, ids, TALL_FRAME)).toBe('rows');
    rows.dispose();
  });

  it('auto follows the frame aspect ratio, in both directions', () => {
    // AUTO_ROWS_ASPECT = 2. This frame is 120 x 240 px — taller than wide — so auto must choose
    // columns; the wide model below is 480 x 60, well past the threshold, so it must choose rows.
    const tall = withNotes(8);
    expect(tall.placementMode).toBe('auto');
    const ids = Array.from({ length: 8 }, (_, index) => `n${String(index).padStart(2, '0')}`);
    expect(arrangement(tall, ids, TALL_FRAME)).toBe('columns');
    tall.dispose();

    const wide = new ViewLeader({
      boundary: boundary(),
      adapters: {
        projection: {
          getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
          project: (point) => ({ point: { x: 450 + point.x * 30, y: 320 - point.y * 30 }, depth: 0, visible: true }),
          getRevision: () => 1,
        },
        modelBounds: { get: () => ({ min: { x: -8, y: -1, z: 0 }, max: { x: 8, y: 1, z: 0 } }) },
      },
    });
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2;
      wide.annotations.create({
        id: `n${String(index).padStart(2, '0')}`,
        anchor: { kind: 'world-point', point: { x: Math.cos(angle) * 7, y: Math.sin(angle) * 0.9, z: 0 } },
        content: { kind: 'plain-note', text: `NOTE ${index}` },
      });
    }
    wide.update();
    expect(arrangement(wide, ids, WIDE_FRAME)).toBe('rows');
    wide.dispose();
  });

  it('ignores a mode it does not know rather than blanking the overlay', () => {
    const leader = withNotes(4);
    leader.setPlacementMode('sides');
    leader.setPlacementMode('diagonal' as PlacementMode);
    expect(leader.placementMode).toBe('sides');
    leader.dispose();
  });
});

describe('viewport insets are public and both layout stages honour them', () => {
  const INSETS = { top: 56, right: 0, bottom: 80, left: 0 };

  it('starts unclaimed — which is not the same as all zeroes', () => {
    const leader = withNotes(4);
    expect(leader.viewportInsets).toBeUndefined();
    leader.dispose();
  });

  it('keeps every label out of the claimed edges', () => {
    const leader = withNotes(14);
    leader.setViewportInsets(INSETS);
    leader.update();
    const boxes = leader.annotations.getSnapshot().annotations
      .map((annotation) => leader.geometry.of(annotation.id)?.label)
      .filter((box): box is NonNullable<typeof box> => box !== undefined);
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box.y).toBeGreaterThanOrEqual(INSETS.top);
      expect(box.y + box.height).toBeLessThanOrEqual(VIEWPORT.height - INSETS.bottom);
    }
    leader.dispose();
  });

  it('moves labels that were already there — the claim is retroactive', () => {
    // Otherwise a host that shows its toolbar after the first frame gets a permanently covered note.
    const leader = withNotes(14);
    const before = leader.geometry.of('n00')!.label;
    leader.setViewportInsets({ top: 300, right: 0, bottom: 0, left: 0 });
    leader.update();
    const after = leader.geometry.of('n00')!.label;
    expect(after).not.toEqual(before);
    expect(after.y).toBeGreaterThanOrEqual(300);
    leader.dispose();
  });

  it('clears back to unclaimed with null', () => {
    const leader = withNotes(4);
    leader.setViewportInsets(INSETS);
    leader.setViewportInsets(null);
    expect(leader.viewportInsets).toBeUndefined();
    leader.dispose();
  });

  it('refuses a nonsense inset as a whole rather than applying half of it', () => {
    // A half-applied inset is worse than none: the host cannot tell which of its edges took.
    const leader = withNotes(4);
    for (const bad of [
      { top: Number.NaN, right: 0, bottom: 0, left: 0 },
      { top: 10, right: -5, bottom: 0, left: 0 },
      { top: 0, right: 0, bottom: Number.POSITIVE_INFINITY, left: 0 },
    ]) {
      leader.setViewportInsets(bad);
      expect(leader.viewportInsets).toBeUndefined();
    }
    leader.dispose();
  });
});

/**
 * The measurement that reopened phase 2.1, now that all three modes are reachable to compare.
 *
 * `'auto'` is a verbatim port of OLD's and decides on the *frame's* aspect ratio. Scene A's frame is
 * the projected model box — about 1.3:1 at every yaw — so `'auto'` picks `'sides'` at both
 * viewports. It picks the worse arrangement both times, and on the wide-short viewport it picks the
 * far worse one. Frame shape does not predict which arrangement the labels fit in; capacity does,
 * and nothing in the placer models capacity.
 *
 * Recorded here rather than argued: phase 2.1's zero-overlap criterion is decided by this number.
 */
describe('measured: which arrangement scene A actually fits in', () => {
  const worstOverOrbit = (viewport: { width: number; height: number }, mode: PlacementMode): number => {
    const handle = scene(viewport);
    handle.leader.setPlacementMode(mode);
    handle.leader.update();
    let worst = 0;
    for (let step = 0; step <= ORBIT_STEPS; step += 1) {
      handle.orbitTo((step / ORBIT_STEPS) * Math.PI * 2);
      worst = Math.max(worst, overlappingPairs(handle.boxes()).length);
    }
    handle.leader.dispose();
    return worst;
  };

  // Six 360° orbits of a thirty-annotation scene, each re-laying out and separating every frame.
  // Genuinely slow rather than accidentally slow, and it was intermittently blowing vitest's 5 s
  // default under load — which reads as a layout defect when it is nothing of the kind.
  it('rows beats sides on scene A, and auto picks sides', () => {
    const wide = { width: 1280, height: 400 };
    const sides = worstOverOrbit(VIEWPORT, 'sides');
    const rows = worstOverOrbit(VIEWPORT, 'rows');
    const auto = worstOverOrbit(VIEWPORT, 'auto');
    // Rows is clean across the whole orbit at this viewport. Sides is not.
    expect(rows).toBe(0);
    expect(sides).toBeGreaterThan(rows);
    expect(auto).toBe(sides);

    // ...and the gap is far wider on the wide-short viewport the oracle pins. Each measured once:
    // recomputing the same orbit to read it twice is where a third of the runtime went.
    const wideSides = worstOverOrbit(wide, 'sides');
    expect(worstOverOrbit(wide, 'rows')).toBeLessThan(wideSides);
    expect(worstOverOrbit(wide, 'auto')).toBe(wideSides);
  }, 30_000);
});
