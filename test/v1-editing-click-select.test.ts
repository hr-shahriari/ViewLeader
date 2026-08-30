/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { ViewLeader, type AnnotationDraft, type HostAdapterBundle } from '../src/index.js';
import type { Vec2 } from '../src/types.js';

/**
 * Clicking a label has to reach the renderer's own click listener, and pointer capture is what used
 * to stop it.
 *
 * `pointerUp` deliberately does nothing when a press never became a drag — "the renderer already
 * handles selection on click, and doing it here as well would toggle a shift-click twice and cancel
 * itself out". That deferral only holds if the click actually arrives. Capturing on pointerDOWN
 * broke it: capture retargets `pointerup` to the boundary, so the browser fires `click` on the
 * nearest common ancestor of the down and up targets — the boundary — and the per-annotation
 * listener never runs. Every host with `gestures: true` had a label that could not be selected by
 * clicking it, which in the gallery meant `/direct-editing/`, `/leader-editor/` and `/ifc-studio/`
 * all showed an inspector greyed out over a leader the user had just clicked.
 *
 * Capture is still required for a real drag — a `pointer-events: none` boundary hears nothing once
 * the pointer leaves the label — so it is taken the moment the press crosses the drag threshold
 * instead of the moment it lands.
 */

const adapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
    project: (point) => ({
      point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
      depth: point.z,
      visible: true,
    }),
  },
};

function note(id: string, at: { x: number; y: number }): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
    content: { kind: 'plain-note', text: id },
    placement: { kind: 'manual', position: at },
  };
}

function pointerEvent(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, {
    clientX: x, clientY: y, pointerType: 'mouse', pointerId: 7, button: 0, buttons: 1,
  });
  return event;
}

/** The boundary, plus a log of the pointer ids capture was taken for. */
function build(): { leader: ViewLeader; root: HTMLElement; captured: number[]; centre: Vec2 } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  // jsdom measures every element as 0×0, and `normalizePointer` divides the client position by the
  // boundary's width and height — so without this every dispatched press normalizes to Infinity and
  // hit-tests against nothing. The bug under test is positional, so the rect has to be real.
  root.getBoundingClientRect = (): DOMRect => ({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0,
    toJSON: () => ({}),
  });
  const leader = new ViewLeader({ boundary: root, adapters, editing: { gestures: true } });
  const captured: number[] = [];
  root.setPointerCapture = (pointerId: number) => { captured.push(pointerId); };
  root.releasePointerCapture = () => undefined;
  leader.annotations.create(note('a1', { x: 500, y: 380 }));
  leader.update();
  // Measured, not assumed: the label is only about 23×27 px, so a hard-coded "somewhere near it"
  // point silently lands on empty space and every assertion below then grades the marquee instead.
  const label = leader.geometry.of('a1')!.label;
  const centre = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
  return { leader, root, captured, centre };
}

describe('editing: a click on a label is left for the renderer', () => {
  it('does not take the pointer for a press that has not moved', () => {
    const { leader, root, captured, centre } = build();

    root.dispatchEvent(pointerEvent('pointerdown', centre.x, centre.y));

    // The gesture is armed — this is a maybe-drag, not a no-op — but the pointer is still the
    // browser's, so `pointerup` will land on the label and the click will too.
    expect(leader.editing.getSnapshot().target).toBe('a1');
    expect(captured).toEqual([]);
    leader.dispose();
  });

  it('does not take the pointer for a wobble below the drag threshold', () => {
    const { leader, root, captured, centre } = build();

    root.dispatchEvent(pointerEvent('pointerdown', centre.x, centre.y));
    // Two pixels: under `DRAG_THRESHOLD_PX`, which is exactly the unsteady hand the threshold is
    // there to forgive. Capturing here would swallow the click just as surely as capturing on down.
    root.dispatchEvent(pointerEvent('pointermove', centre.x + 1, centre.y + 1));

    expect(captured).toEqual([]);
    expect(leader.editing.getSnapshot().target).toBe('a1');
    leader.dispose();
  });

  it('takes the pointer as soon as the press becomes a drag', () => {
    const { leader, root, captured, centre } = build();

    root.dispatchEvent(pointerEvent('pointerdown', centre.x, centre.y));
    root.dispatchEvent(pointerEvent('pointermove', centre.x + 20, centre.y + 20));

    // Past the threshold this is a drag, and a drag needs the pointer or it freezes the moment it
    // leaves the label.
    expect(captured).toEqual([7]);
    expect(leader.editing.getSnapshot().phase).toBe('dragging');
    leader.dispose();
  });

  it('captures once, not on every move of a drag', () => {
    const { leader, root, captured, centre } = build();

    root.dispatchEvent(pointerEvent('pointerdown', centre.x, centre.y));
    root.dispatchEvent(pointerEvent('pointermove', centre.x + 20, centre.y + 20));
    root.dispatchEvent(pointerEvent('pointermove', centre.x + 30, centre.y + 30));
    root.dispatchEvent(pointerEvent('pointermove', centre.x + 40, centre.y + 40));

    expect(captured).toEqual([7]);
    leader.dispose();
  });

  it('still takes the pointer immediately for a marquee, which is a drag from its first pixel', () => {
    const { leader, root, captured } = build();

    // Empty space, and no interaction adapter, so the default `marquee: 'empty-space'` applies.
    // There is no annotation under this press for a click to select, so capturing costs nothing.
    root.dispatchEvent(pointerEvent('pointerdown', 80, 80));
    expect(captured).toEqual([7]);

    // The band itself only exists once the pointer has moved — `phase` reports `pressed` until then
    // — but the capture above already had to happen, because the pointer can leave the boundary
    // before the first move arrives.
    root.dispatchEvent(pointerEvent('pointermove', 140, 140));
    expect(leader.editing.getSnapshot().phase).toBe('marquee');
    leader.dispose();
  });
});
