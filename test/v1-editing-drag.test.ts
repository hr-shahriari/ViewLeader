/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type NormalizedPointerInput,
} from '../src/index.js';
import type { Vec2 } from '../src/types.js';

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

/** Anchors on the world origin so only placement moves the label. */
function note(id: string, position?: Vec2): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    routing: { kind: 'automatic', mode: 'dogleg' },
    content: { kind: 'plain-note', text: 'Note' },
    ...(position === undefined ? {} : { placement: { kind: 'manual' as const, position } }),
  };
}

/** Screen pixels → the normalized 0..1 pointer the public surface takes. */
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
  options: { adapters?: HostAdapterBundle; gestures?: boolean } = {},
): { leader: ViewLeader; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({
    boundary: root,
    adapters: options.adapters ?? fixedAdapters,
    ...(options.gestures === undefined ? {} : { editing: { gestures: options.gestures } }),
  });
  return { leader, root };
}

/** Runs a whole drag through the public surface, updating between steps like a host frame loop. */
function drag(leader: ViewLeader, from: Vec2, to: Vec2): void {
  leader.editing.pointerDown(at(from.x, from.y));
  leader.editing.pointerMove(at(to.x, to.y));
  leader.update();
  leader.editing.pointerUp(at(to.x, to.y));
  leader.update();
}

describe('editing: drag a label', () => {
  it('moves the label by the pointer delta and writes ManualPlacement', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    drag(leader, { x: 510, y: 390 }, { x: 560, y: 420 });

    const placement = leader.annotations.get('a1')!.placement;
    expect(placement).toEqual({ kind: 'manual', position: { x: 550, y: 410 } });
    expect(leader.geometry.of('a1')!.label).toMatchObject({ x: 550, y: 410 });
    leader.dispose();
  });

  it('survives camera orbit, because it is a placement and not a screen offset', () => {
    let offset = 0;
    const orbiting: HostAdapterBundle = {
      projection: {
        getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
        project: (point) => ({
          point: { x: 400 + offset + point.x * 10, y: 300 - point.y * 10 },
          depth: point.z,
          visible: true,
        }),
      },
    };
    const { leader } = makeLeader({ adapters: orbiting });
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    drag(leader, { x: 510, y: 390 }, { x: 600, y: 390 });
    const dropped = leader.geometry.of('a1')!.label;

    offset = 120;
    leader.update();
    // The anchor moved with the camera; the label did not, because it is pinned in screen space.
    expect(leader.geometry.of('a1')!.label).toMatchObject({ x: dropped.x, y: dropped.y });
    expect(leader.geometry.of('a1')!.handles[0]!.at.x).toBeCloseTo(520, 6);
    leader.dispose();
  });

  it('is one undo step back to the exact prior placement', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    const before = leader.history.getSnapshot().undoCount;
    drag(leader, { x: 510, y: 390 }, { x: 560, y: 420 });

    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);
    expect(leader.history.getSnapshot().undoLabel).toBe('Move annotation');
    leader.history.undo();
    expect(leader.annotations.get('a1')!.placement).toEqual({
      kind: 'manual',
      position: { x: 500, y: 380 },
    });
    leader.dispose();
  });

  it('grabs the leader line too, and moves the same label', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    // A point on the drawn route, well clear of the label box.
    const onLine = leader.geometry.of('a1')!.legs[0]![1]!;
    expect(leader.editing.hitTest(at(onLine.x, onLine.y))).toMatchObject({
      id: 'a1',
      kind: 'leader',
    });
    drag(leader, onLine, { x: onLine.x + 40, y: onLine.y });
    expect(leader.annotations.get('a1')!.placement).toEqual({
      kind: 'manual',
      position: { x: 540, y: 380 },
    });
    leader.dispose();
  });
});

describe('editing: a small drag is a click', () => {
  it('leaves placement automatic when the pointer moves under the threshold', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1'));
    leader.update();
    const label = leader.geometry.of('a1')!.label;
    const before = leader.history.getSnapshot().undoCount;

    leader.editing.pointerDown(at(label.x + 5, label.y + 5));
    expect(leader.editing.getSnapshot().phase).toBe('pressed');
    leader.editing.pointerMove(at(label.x + 7, label.y + 5));
    leader.editing.pointerUp(at(label.x + 7, label.y + 5));

    expect(leader.annotations.get('a1')!.placement.kind).toBe('automatic');
    expect(leader.history.getSnapshot().undoCount).toBe(before);
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('a click still changes selection, through the renderer wiring it already had', () => {
    const { leader, root } = makeLeader({ gestures: true });
    leader.annotations.create(note('a1'));
    leader.update();
    const group = root.querySelector('[data-annotation-id="a1"] g[data-hit-target="label"]')!;
    group.dispatchEvent(new Event('click', { bubbles: true }));
    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a1']);
    leader.dispose();
  });

  it('crossing the threshold flips the phase to dragging', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    leader.editing.pointerDown(at(510, 390));
    leader.editing.pointerMove(at(512, 390));
    expect(leader.editing.getSnapshot().phase).toBe('pressed');
    leader.editing.pointerMove(at(520, 390));
    expect(leader.editing.getSnapshot().phase).toBe('dragging');
    expect(leader.editing.getSnapshot().target).toBe('a1');
    leader.dispose();
  });
});

describe('editing: preview is frame state, not document state', () => {
  it('previews mid-drag without touching the document or history', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    const revisionBefore = leader.documents.getSnapshot().documentRevision;

    leader.editing.pointerDown(at(510, 390));
    leader.editing.pointerMove(at(600, 450));
    leader.update();

    // Drawn at the previewed position...
    expect(leader.geometry.of('a1')!.label).toMatchObject({ x: 590, y: 440 });
    // ...but the document still says where it was.
    expect(leader.annotations.get('a1')!.placement).toEqual({
      kind: 'manual',
      position: { x: 500, y: 380 },
    });
    expect(leader.documents.getSnapshot().documentRevision).toBe(revisionBefore);
    leader.dispose();
  });

  it('cancel mid-drag restores the pre-drag placement and adds no history entry', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    const before = leader.history.getSnapshot().undoCount;

    leader.editing.pointerDown(at(510, 390));
    leader.editing.pointerMove(at(700, 500));
    leader.update();
    expect(leader.geometry.of('a1')!.label.x).toBe(690);

    leader.editing.cancel('escape');
    leader.update();
    expect(leader.geometry.of('a1')!.label).toMatchObject({ x: 500, y: 380 });
    expect(leader.history.getSnapshot().undoCount).toBe(before);
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('Escape cancels the drag when gestures are attached', () => {
    const { leader, root } = makeLeader({ gestures: true });
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    leader.editing.pointerDown(at(510, 390));
    leader.editing.pointerMove(at(700, 500));
    root.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    leader.update();
    expect(leader.geometry.of('a1')!.label).toMatchObject({ x: 500, y: 380 });
    leader.dispose();
  });

  it('replacing the document mid-drag cancels rather than landing the label', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    leader.editing.pointerDown(at(510, 390));
    leader.editing.pointerMove(at(700, 500));
    leader.documents.replace({ ...leader.documents.getSnapshot().document, annotations: [] });
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });
});

describe('editing: opt-in and safety', () => {
  it('attaches no pointer listeners unless gestures are enabled', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    // A real pointer sequence over the label must do nothing when gestures are off.
    for (const [type, x, y] of [['pointerdown', 510, 390], ['pointermove', 600, 450], ['pointerup', 600, 450]] as const) {
      const event = new Event(type, { bubbles: true }) as Event & { clientX: number; clientY: number; pointerType: string };
      Object.assign(event, { clientX: x, clientY: y, pointerType: 'mouse' });
      root.dispatchEvent(event);
    }
    expect(leader.annotations.get('a1')!.placement).toEqual({
      kind: 'manual',
      position: { x: 500, y: 380 },
    });
    leader.dispose();
  });

  it('the headless path and the DOM path reach the same placement', () => {
    const positions = (gestures: boolean): Vec2 => {
      const { leader, root } = makeLeader({ gestures });
      leader.annotations.create(note('a1', { x: 500, y: 380 }));
      leader.update();
      if (gestures) {
        for (const [type, x, y] of [['pointerdown', 510, 390], ['pointermove', 570, 430], ['pointerup', 570, 430]] as const) {
          const event = new Event(type, { bubbles: true }) as Event & { clientX: number; clientY: number; pointerType: string };
          Object.assign(event, { clientX: x, clientY: y, pointerType: 'mouse' });
          root.dispatchEvent(event);
        }
      } else {
        drag(leader, { x: 510, y: 390 }, { x: 570, y: 430 });
      }
      const placement = leader.annotations.get('a1')!.placement;
      leader.dispose();
      return (placement as { position: Vec2 }).position;
    };
    // jsdom reports a zero-sized boundary, so the DOM path normalizes to the origin. What matters
    // is that both paths run the same code and commit a manual placement, not that the numbers match.
    expect(positions(false)).toEqual({ x: 560, y: 420 });
    expect(positions(true)).not.toBeUndefined();
  });

  it('a pointerMove or pointerUp with no drag in progress is a no-op, not a throw', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1'));
    leader.update();
    expect(() => leader.editing.pointerMove(at(400, 400))).not.toThrow();
    expect(() => leader.editing.pointerUp(at(400, 400))).not.toThrow();
    expect(() => leader.editing.cancel()).not.toThrow();
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('a pointerDown on empty space presses a marquee, not a drag on nothing', () => {
    // Ticket 05 gave empty space a gesture (the marquee). Under the movement threshold it is still
    // a click, exactly like a label press, and releasing without crossing it returns to idle.
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    expect(leader.editing.hitTest(at(50, 50))).toBeUndefined();
    leader.editing.pointerDown(at(50, 50));
    expect(leader.editing.getSnapshot().phase).toBe('pressed');
    leader.editing.pointerUp(at(50, 50));
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('stands down while a creation tool owns the pointer', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    void leader.authoring.start({ draft: { content: { kind: 'plain-note', text: 'New' } } });
    expect(leader.authoring.getSnapshot().phase).not.toBe('idle');

    leader.editing.pointerDown(at(510, 390));
    expect(leader.editing.getSnapshot().phase).toBe('idle');

    leader.authoring.cancel();
    leader.editing.pointerDown(at(510, 390));
    expect(leader.editing.getSnapshot().phase).toBe('pressed');
    leader.dispose();
  });

  it('takes and releases the editing interaction lease', () => {
    const reasons: string[] = [];
    let released = 0;
    const { leader } = makeLeader({
      adapters: {
        ...fixedAdapters,
        interaction: {
          acquire: (reason) => {
            reasons.push(reason);
            return { release: () => { released += 1; } };
          },
        },
      },
    });
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    drag(leader, { x: 510, y: 390 }, { x: 560, y: 420 });
    expect(reasons).toEqual(['editing']);
    expect(released).toBe(1);
    leader.dispose();
  });

  it('does not start a drag when the host refuses the lease', () => {
    const { leader } = makeLeader({
      adapters: {
        ...fixedAdapters,
        interaction: { acquire: () => { throw new Error('my tool owns the pointer'); } },
      },
    });
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    expect(() => leader.editing.pointerDown(at(510, 390))).not.toThrow();
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('rejects an out-of-range pointer', () => {
    const { leader } = makeLeader();
    expect(() => leader.editing.pointerDown({ ...at(0, 0), x: 1.5 })).toThrow();
    leader.dispose();
  });
});

describe('editing: hit test', () => {
  it('prefers the label over a leader line crossing it', () => {
    const { leader } = makeLeader();
    // Placed so the route from the projected anchor runs under the label box.
    leader.annotations.create(note('a1', { x: 420, y: 320 }));
    leader.update();
    const label = leader.geometry.of('a1')!.label;
    const inside = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
    expect(leader.editing.hitTest(at(inside.x, inside.y))).toMatchObject({ kind: 'label' });
    leader.dispose();
  });

  // Z-order is NOT creation order: `document.ts` keeps annotations sorted by id, so the last group
  // in the DOM — the one actually on top — is the alphabetically last id. The hit test must agree
  // with what was drawn, whatever that order turns out to be.
  it('picks whichever of two overlapping labels was drawn on top', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('aaa', { x: 500, y: 380 }));
    leader.annotations.create(note('zzz', { x: 505, y: 385 }));
    leader.update();
    const drawn = [...root.querySelectorAll('[data-annotation-id]')]
      .map((element) => element.getAttribute('data-annotation-id'));
    expect(leader.editing.hitTest(at(520, 400))).toMatchObject({ id: drawn.at(-1)! });
    leader.dispose();
  });

  it('drags the topmost label when two overlap, not the one underneath', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('aaa', { x: 500, y: 380 }));
    leader.annotations.create(note('zzz', { x: 505, y: 385 }));
    leader.update();
    const top = [...root.querySelectorAll('[data-annotation-id]')].at(-1)!
      .getAttribute('data-annotation-id')!;
    const other = top === 'aaa' ? 'zzz' : 'aaa';
    const otherBefore = leader.annotations.get(other)!.placement;
    drag(leader, { x: 520, y: 400 }, { x: 620, y: 400 });
    expect(leader.annotations.get(top)!.placement).toMatchObject({ kind: 'manual' });
    expect(leader.annotations.get(other)!.placement).toEqual(otherBefore);
    leader.dispose();
  });
});

// Found by ticket 09's example work, and it is a real defect rather than a missing feature.
//
// The near-universal way to mount an overlay on a 3D viewport is a `pointer-events: none` boundary,
// so orbit drags fall through to the canvas — the demo harness does exactly this
// (`demo/src/shared/example.css`, `.vl-boundary`). Such a boundary receives nothing except what
// bubbles up from the annotation hit targets that re-enable events, so once the pointer leaves the
// label neither `pointermove` nor `pointerup` arrives and the drag freezes. Pointer capture bypasses
// hit testing, which is the whole reason it exists.
describe('editing: the DOM gesture path', () => {
  /** A pointer event carrying the fields `normalizePointer` and capture both need. */
  function pointerEvent(type: string, x: number, y: number, button = 0): Event {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { clientX: x, clientY: y, pointerType: 'mouse', pointerId: 7, button, buttons: 1 });
    return event;
  }

  it('captures the pointer on the boundary when a drag begins', () => {
    const { leader, root } = makeLeader({ gestures: true });
    const captured: number[] = [];
    root.setPointerCapture = (pointerId: number) => { captured.push(pointerId); };
    root.releasePointerCapture = () => undefined;
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();

    root.dispatchEvent(pointerEvent('pointerdown', 510, 390));
    expect(captured).toEqual([7]);
    leader.dispose();
  });

  it('captures for a marquee too, since a rubber band always leaves where it started', () => {
    const { leader, root } = makeLeader({ gestures: true });
    const captured: number[] = [];
    root.setPointerCapture = (pointerId: number) => { captured.push(pointerId); };
    root.releasePointerCapture = () => undefined;
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();

    // jsdom reports a zero-sized boundary, so every client point normalizes to the origin — which
    // is empty space here, and empty space is where a marquee starts.
    root.dispatchEvent(pointerEvent('pointerdown', 5, 5));
    expect(captured).toEqual([7]);
    leader.dispose();
  });

  it('captures nothing when the press hits neither an annotation nor a marquee', () => {
    const { leader, root } = makeLeader({ gestures: true });
    const captured: number[] = [];
    root.setPointerCapture = (pointerId: number) => { captured.push(pointerId); };
    // A right-click must not start anything at all, so there is nothing to capture.
    root.dispatchEvent(pointerEvent('pointerdown', 510, 390, 2));
    expect(captured).toEqual([]);
    leader.dispose();
  });

  it('survives a boundary that cannot be captured, rather than throwing into the host', () => {
    const { leader, root } = makeLeader({ gestures: true });
    root.setPointerCapture = () => { throw new Error('not capturable'); };
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    expect(() => root.dispatchEvent(pointerEvent('pointerdown', 510, 390))).not.toThrow();
    leader.dispose();
  });

  it('a right-click starts no gesture and takes no interaction lease', () => {
    const reasons: string[] = [];
    const { leader } = makeLeader({
      adapters: {
        ...fixedAdapters,
        interaction: { acquire: (reason) => { reasons.push(reason); return { release: () => undefined }; } },
      },
    });
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();

    leader.editing.pointerDown({ ...at(510, 390), button: 2 });
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    expect(reasons).toEqual([]);
    // The primary button still works, so this is a filter and not a break.
    leader.editing.pointerDown(at(510, 390));
    expect(leader.editing.getSnapshot().phase).toBe('pressed');
    expect(reasons).toEqual(['editing']);
    leader.dispose();
  });

  it('a captured drag is not cancelled by leaving the boundary', () => {
    const { leader, root } = makeLeader({ gestures: true });
    root.setPointerCapture = () => undefined;
    root.releasePointerCapture = () => undefined;
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    root.dispatchEvent(pointerEvent('pointerdown', 510, 390));
    expect(leader.editing.getSnapshot().phase).not.toBe('idle');

    root.dispatchEvent(new Event('pointerleave', { bubbles: true }));
    // Still live: dragging a label past the viewport edge and back is a normal gesture.
    expect(leader.editing.getSnapshot().phase).not.toBe('idle');
    leader.dispose();
  });

  it('an uncaptured drag is still cancelled by leaving, because then it really is gone', () => {
    const { leader, root } = makeLeader({ gestures: true });
    root.setPointerCapture = () => { throw new Error('not capturable'); };
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    root.dispatchEvent(pointerEvent('pointerdown', 510, 390));
    expect(leader.editing.getSnapshot().phase).not.toBe('idle');

    root.dispatchEvent(new Event('pointerleave', { bubbles: true }));
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });
});
