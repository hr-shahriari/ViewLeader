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

function note(
  id: string,
  label: Vec2,
  anchor: Vec2 = { x: label.x - 40, y: label.y - 40 },
  vertices?: readonly Vec2[],
): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: worldFor(anchor.x, anchor.y) },
    routing: vertices === undefined
      ? { kind: 'automatic', mode: 'dogleg' }
      : { kind: 'manual', vertices },
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position: label },
  };
}

function at(x: number, y: number): NormalizedPointerInput {
  return {
    x: x / VIEWPORT.width,
    y: y / VIEWPORT.height,
    button: 0,
    buttons: 0,
    pointerType: 'mouse',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };
}

function makeLeader(editing: EditingOptions = { gestures: true }): {
  leader: ViewLeader;
  root: HTMLElement;
} {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({ boundary: root, adapters: fixedAdapters, editing });
  return { leader, root };
}

/** Somewhere no annotation, leader or grip reaches, given every fixture below sits top-left. */
const EMPTY: Vec2 = { x: 700, y: 550 };

describe('editing: hover cursor', () => {
  it('a label under the pointer reads as draggable', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;

    leader.editing.pointerMove(at(label.x + 2, label.y + 2));

    expect(root.style.cursor).toBe('move');
    leader.dispose();
  });

  it('a leader line reads as draggable too — dragging it moves the label', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 200, y: 200 }));
    leader.update();
    // Midpoint of the first drawn segment, not of the whole leg: a dogleg bends, so the chord
    // between its ends misses the line it is meant to be on.
    const [start, next] = leader.geometry.of('a1')!.legs[0]!;

    leader.editing.pointerMove(at((start!.x + next!.x) / 2, (start!.y + next!.y) / 2));

    expect(root.style.cursor).toBe('move');
    leader.dispose();
  });

  it('empty space hands the cursor back to the host rather than pinning `default`', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;

    leader.editing.pointerMove(at(label.x + 2, label.y + 2));
    expect(root.style.cursor).toBe('move');

    leader.editing.pointerMove(at(EMPTY.x, EMPTY.y));

    expect(root.style.cursor).toBe('');
    leader.dispose();
  });

  it('a route vertex grip moves a bend, a midpoint grip inserts one, and they say so differently', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 200, y: 200 }, { x: 100, y: 100 }, [{ x: 140, y: 180 }]));
    leader.update();
    // Grips are only hit-tested on a selected annotation, so there is nothing to hover until now.
    leader.annotations.select(['a1']);
    leader.update();
    const handles = leader.geometry.of('a1')!.routeHandles;
    const vertex = handles.find((handle) => handle.kind === 'vertex')!;
    const midpoint = handles.find((handle) => handle.kind === 'midpoint')!;

    leader.editing.pointerMove(at(vertex.at.x, vertex.at.y));
    expect(root.style.cursor).toBe('move');

    leader.editing.pointerMove(at(midpoint.at.x, midpoint.at.y));
    expect(root.style.cursor).toBe('copy');
    leader.dispose();
  });

  it('an anchor grip reads as draggable', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 200, y: 200 }));
    leader.update();
    leader.annotations.select(['a1']);
    leader.update();
    const handle = leader.geometry.of('a1')!.handles[0]!;

    leader.editing.pointerMove(at(handle.at.x, handle.at.y));

    expect(root.style.cursor).toBe('move');
    leader.dispose();
  });

  it('writes nothing at all without `gestures` — a host driving editing by hand owns its cursor', () => {
    const { leader, root } = makeLeader({});
    root.style.cursor = 'crosshair';
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;

    leader.editing.pointerMove(at(label.x + 2, label.y + 2));
    expect(root.style.cursor).toBe('crosshair');
    leader.editing.pointerMove(at(EMPTY.x, EMPTY.y));

    expect(root.style.cursor).toBe('crosshair');
    leader.dispose();
  });

  it('takes the cursor off the boundary on dispose', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;
    leader.editing.pointerMove(at(label.x + 2, label.y + 2));
    expect(root.style.cursor).toBe('move');

    leader.dispose();

    expect(root.style.cursor).toBe('');
  });

  it('leaves the cursor alone mid-drag, so a drag that wanders onto empty space still reads as one', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;

    leader.editing.pointerMove(at(label.x + 2, label.y + 2));
    leader.editing.pointerDown(at(label.x + 2, label.y + 2));
    leader.editing.pointerMove(at(EMPTY.x, EMPTY.y));
    leader.update();

    expect(leader.editing.getSnapshot().phase).toBe('dragging');
    expect(root.style.cursor).toBe('move');
    leader.dispose();
  });

  /** A pointer event carrying the fields `normalizePointer` and capture both need. */
  function pointerEvent(type: string, x: number, y: number): Event {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { clientX: x, clientY: y, pointerType: 'mouse', pointerId: 7, button: 0, buttons: 1 });
    return event;
  }

  it('hands the cursor back when the pointer leaves the boundary, not only on dispose', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;
    leader.editing.pointerMove(at(label.x + 2, label.y + 2));
    expect(root.style.cursor).toBe('move');

    root.dispatchEvent(new Event('pointerleave', { bubbles: true }));

    // Nothing chases the pointer off the element — no `pointermove` arrives out there — so this is
    // the last chance to let go before the host is stuck with `move`.
    expect(root.style.cursor).toBe('');
    leader.dispose();
  });

  it('leaves the cursor alone when a captured gesture wanders off the boundary and back', () => {
    const { leader, root } = makeLeader();
    root.setPointerCapture = () => undefined;
    root.releasePointerCapture = () => undefined;
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;
    leader.editing.pointerMove(at(label.x + 2, label.y + 2));
    // jsdom reports a zero-sized boundary, so the press normalizes to the origin and starts a
    // marquee rather than a label drag — captured either way, which is all this branch turns on.
    root.dispatchEvent(pointerEvent('pointerdown', 5, 5));

    root.dispatchEvent(new Event('pointerleave', { bubbles: true }));

    expect(leader.editing.getSnapshot().phase).not.toBe('idle');
    expect(root.style.cursor).toBe('move');
    leader.dispose();
  });

  it('does not flick the cursor off on the release that gives capture back', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;
    leader.editing.pointerMove(at(label.x + 2, label.y + 2));

    // `lostpointercapture` fires on every ordinary release, not only on a real exit, and says
    // nothing about where the pointer ended up. Clearing here would drop `move` from a label still
    // under the pointer after every single click; when the pointer really is outside, the browser
    // follows the capture loss with the `pointerleave` that does the clearing.
    root.dispatchEvent(new Event('lostpointercapture', { bubbles: true }));

    expect(root.style.cursor).toBe('move');
    leader.dispose();
  });

  it('writes nothing on the way out either without `gestures`', () => {
    const { leader, root } = makeLeader({});
    root.style.cursor = 'crosshair';
    leader.annotations.create(note('a1', { x: 100, y: 100 }));
    leader.update();

    // The exit clear lives on the `pointerleave` listener, which a host that never opted in never
    // gets — the same gate `#hover` is behind, not a second one that could disagree with it.
    root.dispatchEvent(new Event('pointerleave', { bubbles: true }));

    expect(root.style.cursor).toBe('crosshair');
    leader.dispose();
  });
});
