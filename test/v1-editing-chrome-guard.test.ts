/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
} from '../src/index.js';

/**
 * A host that mounts its own chrome inside the boundary — an inline text editor over the label is
 * the obvious case, and the `leader-editor` gallery page does exactly this — has that chrome's
 * pointer events bubble to the boundary listener. `pointerDown` hit-tests by position and never
 * looked at what was actually pressed, so drag-selecting text in the editor dragged the label out
 * from under it.
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

function pointerDownAt(x: number, y: number): Event {
  const event = new Event('pointerdown', { bubbles: true });
  Object.assign(event, {
    clientX: x, clientY: y, pointerType: 'mouse', pointerId: 7, button: 0, buttons: 1,
  });
  return event;
}

function build(): { leader: ViewLeader; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({
    boundary: root,
    adapters,
    editing: { gestures: true },
  });
  root.setPointerCapture = () => undefined;
  root.releasePointerCapture = () => undefined;
  leader.annotations.create(note('a1', { x: 500, y: 380 }));
  leader.update();
  return { leader, root };
}

describe('pointerdown ignores the host’s own chrome', () => {
  it('does not start a gesture when the press came from a textarea inside the boundary', () => {
    const { leader, root } = build();
    // Exactly what demo/src/pages/leader-editor.ts does: the field is appended to the boundary and
    // sits on top of the label it is editing.
    const field = root.ownerDocument.createElement('textarea');
    root.append(field);

    field.dispatchEvent(pointerDownAt(510, 390));

    expect(leader.editing.getSnapshot().phase).toBe('idle');
    expect(leader.editing.getSnapshot().target).toBeNull();
    leader.dispose();
  });

  it('honours an explicit opt-out for chrome that is not a form control', () => {
    const { leader, root } = build();
    const toolbar = root.ownerDocument.createElement('div');
    toolbar.setAttribute('data-viewleader-ignore', '');
    const button = root.ownerDocument.createElement('button');
    toolbar.append(button);
    root.append(toolbar);

    button.dispatchEvent(pointerDownAt(510, 390));

    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('still starts a gesture for a press that did not come from host chrome', () => {
    const { leader, root } = build();
    root.dispatchEvent(pointerDownAt(510, 390));
    expect(leader.editing.getSnapshot().phase).not.toBe('idle');
    leader.dispose();
  });

  it('still lets a press on empty space begin a marquee', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const leader = new ViewLeader({
      boundary: root,
      adapters,
      editing: { gestures: true, marquee: 'empty-space' },
    });
    root.setPointerCapture = () => undefined;
    root.releasePointerCapture = () => undefined;
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();

    // A host canvas under the overlay is not chrome — pressing through it must still marquee.
    const canvas = root.ownerDocument.createElement('canvas');
    root.append(canvas);
    canvas.dispatchEvent(pointerDownAt(5, 5));

    expect(leader.editing.getSnapshot().phase).toBe('pressed');
    leader.dispose();
  });
});
