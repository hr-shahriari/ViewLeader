/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type ModelBounds,
  type ModelBoundsAdapter,
} from '../src/index.js';

// world (x,y,z) → screen: (400 + x*10, 300 - y*10). A model AABB of ±5 projects to the screen
// rectangle x∈[350,450], y∈[250,350] — the frame labels must be railed OUTSIDE of.
const FRAME = { x: 350, y: 250, width: 100, height: 100 };

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function adapters(overrides: Partial<HostAdapterBundle> = {}): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
      project: (point) => ({ point: { x: 400 + point.x * 10, y: 300 - point.y * 10 }, depth: point.z, visible: true }),
      getRevision: () => 1,
    },
    ...overrides,
  };
}

function modelBoundsAdapter(min: ModelBounds['min'], max: ModelBounds['max']): ModelBoundsAdapter {
  return { get: () => ({ min, max }) };
}

function note(id: string, point: { x: number; y: number; z: number }): AnnotationDraft {
  return { id, anchor: { kind: 'world-point', point }, content: { kind: 'plain-note', text: id } };
}

/** Reconstructs the on-screen label rectangle from the rendered group. */
function labelRect(root: Element, id: string): { x: number; y: number; width: number; height: number } {
  const label = root.querySelector(`[data-annotation-id="${id}"] [data-hit-target="label"]`)!;
  const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(label.getAttribute('transform') ?? '')!;
  const tx = Number(match[1]);
  const ty = Number(match[2]);
  const rect = label.querySelector('rect')!;
  return {
    x: tx + Number(rect.getAttribute('x')) + 4,
    y: ty + Number(rect.getAttribute('y')) + 4,
    width: Number(rect.getAttribute('width')) - 8,
    height: Number(rect.getAttribute('height')) - 8,
  };
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof FRAME): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('v1 layout frame — labels are placed outside the model box / drawn rectangle', () => {
  it('rails labels outside the projected model bounding box', () => {
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({ modelBounds: modelBoundsAdapter({ x: -5, y: -5, z: 0 }, { x: 5, y: 5, z: 0 }) }),
    });
    // Both anchors project INSIDE the frame (370,300) and (430,300) — the old placer left labels there.
    leader.annotations.create(note('left-note', { x: -3, y: 0, z: 0 }));
    leader.annotations.create(note('right-note', { x: 3, y: 0, z: 0 }));
    leader.update();

    const left = labelRect(root, 'left-note');
    const right = labelRect(root, 'right-note');
    expect(overlaps(left, FRAME)).toBe(false);
    expect(overlaps(right, FRAME)).toBe(false);
    expect(left.x + left.width).toBeLessThanOrEqual(FRAME.x);
    expect(right.x).toBeGreaterThanOrEqual(FRAME.x + FRAME.width);
  });

  /**
   * REWRITTEN IN PHASE 2.3, and the two assertions that changed are named in the commit message.
   *
   * This test used to assert that a host with no `modelBounds` adapter and no drawn rect got
   * "legacy placement" — labels sitting on top of where the model is, because `resolveLayoutFrame`
   * returned nothing and the runtime fell through to `placeLabels`, a different algorithm with its
   * own hysteresis and its own stability cache. Its final assertion was that clearing a drawn frame
   * *reverted* to that algorithm.
   *
   * Phase 2.3 requires one placement path, so that second algorithm is gone: with no frame source
   * the annotations' own projected anchors supply the frame. The old assertions asserted the
   * existence of exactly what the phase deletes, so they could not both stand. What replaces them
   * is stronger, not weaker — labels are now railed off their anchors in every configuration, and
   * gaining or losing a frame no longer swaps algorithm underneath the drawing.
   */
  it('rails labels off the anchors themselves when the host offers no frame source', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() }); // no modelBounds adapter
    leader.annotations.create(note('inside', { x: -3, y: 0, z: 0 })); // projects to (370,300)

    // No frame source at all, and the label is still railed clear of its own anchor rather than
    // dropped on top of it. This is the assertion that changed: it used to expect the overlap.
    leader.update();
    const unframed = labelRect(root, 'inside');
    expect(overlaps(unframed, { x: 366, y: 296, width: 8, height: 8 })).toBe(false);

    // Draw a framing rectangle → the label must move outside it.
    leader.setLayoutFrame({ rect: FRAME, unit: 'pixels' });
    leader.update();
    expect(overlaps(labelRect(root, 'inside'), FRAME)).toBe(false);

    // Clearing the frame does not swap algorithm. A FRESH label — no cached position, so nothing
    // is holding it in place — is still railed off its own anchor, which is the whole point of
    // having one path: a frustum exit or a cleared rect must not re-lay-out the drawing.
    leader.setLayoutFrame(null);
    leader.annotations.create(note('after-clear', { x: 2, y: 0, z: 0 })); // projects to (420,300)
    leader.update();
    const fresh = labelRect(root, 'after-clear');
    expect(overlaps(fresh, { x: 416, y: 296, width: 8, height: 8 })).toBe(false);
  });

  /**
   * Replaces the culling half of `v1-content-markup`'s `placeLabels` test, which phase 2.3 deleted.
   * That version graded the culling inside the placer; the live path culls upstream, at projection,
   * so this grades it where it now happens — and at the level that actually matters, since "an
   * annotation renders or it does not" is the observable behaviour, not which stage dropped it.
   */
  it('renders nothing for an anchor that does not project, and loses nothing either', () => {
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({
        projection: {
          getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
          // Two ways a host says "not on screen": `null`, and a point it marks not visible. A
          // non-finite point is neither — that is a host bug, and `HostIntegration.project` raises
          // an AdapterError for it rather than quietly dropping the annotation.
          project: (point) => (point.x < 0
            ? null
            : { point: { x: 400 + point.x * 10, y: 300 - point.y * 10 }, depth: 0, visible: point.y >= 0 }),
          getRevision: () => 1,
        },
      }),
    });
    leader.annotations.create(note('no-projection', { x: -1, y: 0, z: 0 }));
    leader.annotations.create(note('not-visible', { x: 1, y: -1, z: 0 }));
    leader.annotations.create(note('fine', { x: 1, y: 1, z: 0 }));
    leader.update();

    expect(root.querySelector('[data-annotation-id="no-projection"]')).toBeNull();
    expect(root.querySelector('[data-annotation-id="not-visible"]')).toBeNull();
    expect(root.querySelector('[data-annotation-id="fine"]')).not.toBeNull();
    // Not rendering is not the same as losing: all three are still in the document.
    expect(leader.annotations.getSnapshot().annotations).toHaveLength(3);
  });

  /**
   * The defect one placement path exists to fix, stated directly: the goal's definition of done
   * says "gaining or losing a layout frame mid-orbit moves nothing".
   */
  it('does not move every label when the model box appears mid-orbit', () => {
    const root = boundary();
    let bounds: ModelBounds | null = null;
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({ modelBounds: { get: () => bounds } }),
    });
    for (let index = 0; index < 6; index += 1) {
      leader.annotations.create(note(`n${index}`, { x: index - 3, y: (index % 3) - 1, z: 0 }));
    }
    leader.update();
    const before = Array.from({ length: 6 }, (_, index) => labelRect(root, `n${index}`));

    // The model box resolves for the first time — a frustum re-entry, or a late-loading fragment.
    bounds = { min: { x: -3, y: -1, z: 0 }, max: { x: 2, y: 1, z: 0 } };
    leader.update();
    const after = Array.from({ length: 6 }, (_, index) => labelRect(root, `n${index}`));

    // The synthesized frame is the anchor cloud and the real frame is the model box around the same
    // anchors, so the two agree: same algorithm, same sectors, same slots, nothing jumps.
    for (let index = 0; index < 6; index += 1) {
      expect(after[index]!.x).toBeCloseTo(before[index]!.x, 6);
      expect(after[index]!.y).toBeCloseTo(before[index]!.y, 6);
    }
  });
});
