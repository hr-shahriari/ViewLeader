/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type EditingOptions,
  type HostAdapterBundle,
  type NormalizedPointerInput,
} from '../src/index.js';
import type { Vec2, Vec3 } from '../src/types.js';

const VIEWPORT = { width: 800, height: 600 };

const fixedAdapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
    project: (point) => ({
      point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
      depth: point.z,
      visible: true,
    }),
  },
};

/** World point that projects, through `fixedAdapters`, to screen `(x, y)`. */
function worldFor(x: number, y: number): Vec3 {
  return { x: (x - 400) / 10, y: (300 - y) / 10, z: 0 };
}

/** A note anchored (and manually placed) at screen coordinates, so its label lands at `label`. The
 * anchor defaults a little off the label rather than coincident with it, so routing sees a real leg. */
function note(id: string, label: Vec2, anchor: Vec2 = { x: label.x - 40, y: label.y - 40 }): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: worldFor(anchor.x, anchor.y) },
    routing: { kind: 'automatic', mode: 'dogleg' },
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position: label },
  };
}

function at(x: number, y: number, extra: Partial<NormalizedPointerInput> = {}): NormalizedPointerInput {
  return {
    x: x / VIEWPORT.width,
    y: y / VIEWPORT.height,
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...extra,
  };
}

function makeLeader(
  adapters: HostAdapterBundle = fixedAdapters,
  editing?: EditingOptions,
): { leader: ViewLeader; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({
    boundary: root,
    adapters,
    ...(editing === undefined ? {} : { editing }),
  });
  return { leader, root };
}

/** `fixedAdapters` plus an interaction adapter that counts leases, so a test can assert that a
 * declined marquee never took one — a lease is what would disable a host's camera controls. */
function countingAdapters(counter: { acquired: number }): HostAdapterBundle {
  return {
    ...fixedAdapters,
    interaction: {
      acquire: () => {
        counter.acquired += 1;
        return { release: () => {} };
      },
    },
  };
}

/** Drives a whole marquee through the public surface, updating between steps like a host frame loop. */
function marquee(leader: ViewLeader, from: Vec2, to: Vec2, extra: Partial<NormalizedPointerInput> = {}): void {
  leader.editing.pointerDown(at(from.x, from.y, extra));
  leader.editing.pointerMove(at(to.x, to.y, extra));
  leader.update();
  leader.editing.pointerUp(at(to.x, to.y, extra));
  leader.update();
}

describe('editing: marquee select', () => {
  it('selects exactly the labels a drag covers', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.annotations.create(note('a2', { x: 300, y: 100 }));
    leader.annotations.create(note('a3', { x: 100, y: 300 }));
    leader.annotations.create(note('a4', { x: 600, y: 500 }));
    leader.update();

    marquee(leader, { x: 50, y: 50 }, { x: 400, y: 400 });

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1', 'a2', 'a3']);
    leader.dispose();
  });

  it('does not select an annotation whose leader crosses the marquee but whose label does not', () => {
    const { leader } = makeLeader();
    // Anchored inside the marquee, but placed far outside it — the leader's near end sits inside
    // the rectangle the marquee draws, and only the hit rule on the label keeps it out of the pick.
    leader.annotations.create(note('crossed', { x: 600, y: 600 }, { x: 200, y: 200 }));
    leader.update();
    // Sanity: the leader really does run through the marquee's area.
    const anchorPoint = leader.geometry.of('crossed')!.legs[0]![0]!;
    expect(anchorPoint.x).toBeGreaterThan(150);
    expect(anchorPoint.x).toBeLessThan(250);
    expect(anchorPoint.y).toBeGreaterThan(150);
    expect(anchorPoint.y).toBeLessThan(250);

    marquee(leader, { x: 150, y: 150 }, { x: 250, y: 250 });

    expect(leader.annotations.getSnapshot().selectedIds).toEqual([]);
    leader.dispose();
  });

  it('plain drag replaces the selection', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.annotations.create(note('a2', { x: 300, y: 300 }));
    leader.update();
    leader.annotations.select(['a2']);

    marquee(leader, { x: 50, y: 50 }, { x: 200, y: 200 });

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1']);
    leader.dispose();
  });

  it('shift-drag adds to the existing selection', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.annotations.create(note('a2', { x: 300, y: 300 }));
    leader.update();
    leader.annotations.select(['a2']);

    marquee(leader, { x: 50, y: 50 }, { x: 200, y: 200 }, { shiftKey: true });

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1', 'a2']);
    leader.dispose();
  });

  it('alt-drag removes from the existing selection', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.annotations.create(note('a2', { x: 300, y: 300 }));
    leader.update();
    leader.annotations.select(['a1', 'a2']);

    marquee(leader, { x: 50, y: 50 }, { x: 200, y: 200 }, { altKey: true });

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a2']);
    leader.dispose();
  });

  it('a marquee that hits nothing clears the selection', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    leader.annotations.select(['a1']);

    marquee(leader, { x: 400, y: 400 }, { x: 500, y: 500 });

    expect(leader.annotations.getSnapshot().selectedIds).toEqual([]);
    leader.dispose();
  });

  it('starts only on empty space — a drag beginning on a label is that drag, not a marquee', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;

    leader.editing.pointerDown(at(label.x + 2, label.y + 2));
    leader.editing.pointerMove(at(label.x + 40, label.y + 40));
    leader.update();

    expect(leader.editing.getSnapshot().phase).toBe('dragging');
    expect(leader.editing.getSnapshot().target).toBe('a1');
    expect(root.querySelector('[data-viewleader-marquee]')).toBeNull();
    leader.dispose();
  });

  it('Escape mid-marquee leaves the prior selection untouched', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.annotations.create(note('a2', { x: 300, y: 300 }));
    leader.update();
    leader.annotations.select(['a2']);

    leader.editing.pointerDown(at(50, 50));
    leader.editing.pointerMove(at(200, 200));
    leader.update();
    expect(leader.editing.getSnapshot().phase).toBe('marquee');
    expect(root.querySelector('[data-viewleader-marquee]')).not.toBeNull();

    leader.editing.cancel();
    leader.update();

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a2']);
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    expect(root.querySelector('[data-viewleader-marquee]')).toBeNull();
    leader.dispose();
  });

  it('adds nothing to history — selection is not a document mutation', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.annotations.create(note('a2', { x: 300, y: 300 }));
    leader.update();
    const before = leader.history.getSnapshot().undoCount;
    const documentRevisionBefore = leader.documents.getSnapshot().documentRevision;

    marquee(leader, { x: 50, y: 50 }, { x: 400, y: 400 });

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1', 'a2']);
    expect(leader.history.getSnapshot().undoCount).toBe(before);
    expect(leader.documents.getSnapshot().documentRevision).toBe(documentRevisionBefore);
    leader.dispose();
  });

  it('skips an off-screen annotation rather than throwing', () => {
    const offscreenAdapters: HostAdapterBundle = {
      projection: {
        getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
        project: (point) => point.z === -1
          ? { point: { x: 0, y: 0 }, depth: point.z, visible: false }
          : { point: { x: 400 + point.x * 10, y: 300 - point.y * 10 }, depth: point.z, visible: true },
      },
    };
    const { leader } = makeLeader(offscreenAdapters);
    leader.annotations.create(note('visible', { x: 100, y: 100 }));
    leader.annotations.create({
      id: 'hidden',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: -1 } },
      routing: { kind: 'automatic', mode: 'dogleg' },
      content: { kind: 'plain-note', text: 'Gone' },
    });
    leader.update();
    expect(leader.geometry.of('hidden')).toBeUndefined();

    expect(() => marquee(leader, { x: 50, y: 50 }, { x: 400, y: 400 })).not.toThrow();
    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['visible']);
    leader.dispose();
  });

  it('draws one dashed rect in the overlay while dragging, and removes it on release', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();

    leader.editing.pointerDown(at(50, 50));
    leader.editing.pointerMove(at(300, 250));
    leader.update();
    const rect = root.querySelector('[data-viewleader-marquee]');
    expect(rect).not.toBeNull();
    expect(rect!.getAttribute('x')).toBe('50');
    expect(rect!.getAttribute('y')).toBe('50');
    expect(rect!.getAttribute('width')).toBe('250');
    expect(rect!.getAttribute('height')).toBe('200');

    leader.editing.pointerUp(at(300, 250));
    leader.update();
    expect(root.querySelector('[data-viewleader-marquee]')).toBeNull();
    leader.dispose();
  });

  it('with no interaction adapter the default is every plain press on empty space', () => {
    const { leader } = makeLeader(fixedAdapters);
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();

    marquee(leader, { x: 50, y: 50 }, { x: 200, y: 200 });

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1']);
    leader.dispose();
  });

  it('with an interaction adapter the default declines, and takes no interaction lease', () => {
    const counter = { acquired: 0 };
    const { leader } = makeLeader(countingAdapters(counter));
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();

    leader.editing.pointerDown(at(50, 50));
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.editing.pointerMove(at(200, 200));
    leader.update();

    expect(leader.editing.getSnapshot().phase).toBe('idle');
    // The lease is the whole point: a host that wires it to its camera controls keeps left-drag
    // orbit on every press that misses an annotation, without having to know this option exists.
    expect(counter.acquired).toBe(0);
    leader.editing.pointerUp(at(200, 200));
    expect(leader.annotations.getSnapshot().selectedIds).toEqual([]);
    leader.dispose();
  });

  it("an explicit marquee: 'empty-space' outranks the interaction adapter", () => {
    // The migration path for a host that supplies `interaction` for authoring rather than for a
    // camera, and wants the rubber band back. Without this case, an implementation that lets the
    // adapter override what the host typed passes every other test here.
    const counter = { acquired: 0 };
    const { leader } = makeLeader(countingAdapters(counter), { marquee: 'empty-space' });
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();

    marquee(leader, { x: 50, y: 50 }, { x: 200, y: 200 });

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1']);
    expect(counter.acquired).toBe(1);
    leader.dispose();
  });

  it("marquee: 'modifier' leaves a plain press idle, and takes no interaction lease", () => {
    const counter = { acquired: 0 };
    const { leader } = makeLeader(countingAdapters(counter), { marquee: 'modifier' });
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    leader.annotations.select(['a1']);

    leader.editing.pointerDown(at(50, 50));
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.editing.pointerMove(at(200, 200));
    leader.update();

    expect(leader.editing.getSnapshot().phase).toBe('idle');
    // The lease is the whole point: without one the host's camera controls stay enabled.
    expect(counter.acquired).toBe(0);
    leader.editing.pointerUp(at(200, 200));
    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1']);
    leader.dispose();
  });

  it("marquee: 'modifier' still marquees on a shift-press", () => {
    const { leader } = makeLeader(fixedAdapters, { marquee: 'modifier' });
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.annotations.create(note('a2', { x: 300, y: 300 }));
    leader.update();
    leader.annotations.select(['a2']);

    leader.editing.pointerDown(at(50, 50, { shiftKey: true }));
    leader.editing.pointerMove(at(200, 200, { shiftKey: true }));
    leader.update();
    expect(leader.editing.getSnapshot().phase).toBe('marquee');

    leader.editing.pointerUp(at(200, 200, { shiftKey: true }));
    leader.update();
    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1', 'a2']);
    leader.dispose();
  });

  it("marquee: 'modifier' still marquees on an alt-press", () => {
    const { leader } = makeLeader(fixedAdapters, { marquee: 'modifier' });
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.annotations.create(note('a2', { x: 300, y: 300 }));
    leader.update();
    leader.annotations.select(['a1', 'a2']);

    marquee(leader, { x: 50, y: 50 }, { x: 200, y: 200 }, { altKey: true });

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a2']);
    leader.dispose();
  });

  it("marquee: 'none' never marquees, with or without a modifier", () => {
    const counter = { acquired: 0 };
    const { leader, root } = makeLeader(countingAdapters(counter), { marquee: 'none' });
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    leader.annotations.select(['a1']);

    for (const extra of [{}, { shiftKey: true }, { altKey: true }]) {
      marquee(leader, { x: 50, y: 50 }, { x: 200, y: 200 }, extra);
      expect(leader.editing.getSnapshot().phase).toBe('idle');
      expect(root.querySelector('[data-viewleader-marquee]')).toBeNull();
    }

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1']);
    expect(counter.acquired).toBe(0);
    leader.dispose();
  });

  it("declining a marquee still lets a press on a label start its drag", () => {
    const { leader } = makeLeader(fixedAdapters, { marquee: 'none' });
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;

    leader.editing.pointerDown(at(label.x + 2, label.y + 2));
    leader.editing.pointerMove(at(label.x + 40, label.y + 40));
    leader.update();

    expect(leader.editing.getSnapshot().phase).toBe('dragging');
    expect(leader.editing.getSnapshot().target).toBe('a1');
    leader.dispose();
  });

  it('a pointer-down-then-up under the threshold is a click, not a marquee, and leaves selection alone', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    leader.annotations.select(['a1']);

    leader.editing.pointerDown(at(400, 400));
    expect(leader.editing.getSnapshot().phase).toBe('pressed');
    leader.editing.pointerMove(at(401, 401));
    leader.editing.pointerUp(at(401, 401));

    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1']);
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });
});
