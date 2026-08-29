/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type Vec2,
} from '../src/index.js';
import { EditingKeyboard, type EditingKeyboardOptions } from '../src/internal/keyboard.js';

/**
 * The keyboard controller is the one piece of this effort with no rAF and no per-frame DOM writes:
 * a `KeyboardEvent` goes in and capability calls come out. So everything here is a real event
 * dispatched at the real listener, on the boundary's `ownerDocument` where the controller binds it.
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

/** A plain screen pin, so `move()` writes the position straight back and the maths is checkable. */
function note(id: string, position: Vec2): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'plain-note', text: id },
    placement: { kind: 'manual', position },
  };
}

const built: Array<{ leader: ViewLeader; keyboard: EditingKeyboard }> = [];

interface Harness {
  readonly leader: ViewLeader;
  readonly keyboard: EditingKeyboard;
  /** Where a keypress is aimed by default: inside the boundary, so it bubbles to the document. */
  readonly host: HTMLElement;
}

function build(ids: readonly string[], options: EditingKeyboardOptions = {}): Harness {
  const boundary = document.createElement('div');
  document.body.appendChild(boundary);
  const host = document.createElement('div');
  boundary.appendChild(host);
  const leader = new ViewLeader({ boundary, adapters });
  for (const [index, id] of ids.entries()) leader.annotations.create(note(id, { x: 500 + index * 60, y: 380 }));
  leader.update();
  leader.annotations.select(ids);
  const keyboard = new EditingKeyboard(leader, options);
  built.push({ leader, keyboard });
  return { leader, keyboard, host };
}

afterEach(() => {
  for (const { leader, keyboard } of built.splice(0)) {
    keyboard.dispose();
    leader.dispose();
  }
  document.body.replaceChildren();
});

interface Press {
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

function press(target: EventTarget, key: string, modifiers: Press = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  }));
}

/** The stored pin, which for a plain manual placement is exactly what the label is drawn at. */
function positionOf(leader: ViewLeader, id: string): Vec2 {
  const placement = leader.annotations.get(id)?.placement;
  if (placement?.kind !== 'manual') throw new Error(`expected a manual placement for ${id}`);
  return placement.position;
}

function undoCount(leader: ViewLeader): number {
  return leader.history.getSnapshot().undoCount;
}

describe('the bound keys', () => {
  it('nudges the selection one pixel per arrow press, in screen axes', () => {
    const { leader, host } = build(['a']);
    const start = positionOf(leader, 'a');

    press(host, 'ArrowRight');
    expect(positionOf(leader, 'a')).toEqual({ x: start.x + 1, y: start.y });

    leader.update();
    press(host, 'ArrowDown');
    expect(positionOf(leader, 'a')).toEqual({ x: start.x + 1, y: start.y + 1 });

    leader.update();
    press(host, 'ArrowLeft');
    leader.update();
    press(host, 'ArrowUp');
    expect(positionOf(leader, 'a')).toEqual(start);
  });

  it('multiplies the step when Shift is held', () => {
    const { leader, host } = build(['a']);
    const start = positionOf(leader, 'a');

    press(host, 'ArrowRight', { shiftKey: true });

    expect(positionOf(leader, 'a')).toEqual({ x: start.x + 10, y: start.y });
  });

  it('moves the whole selection as one undo step', () => {
    const { leader, host } = build(['a', 'b']);
    const before = undoCount(leader);
    const starts = [positionOf(leader, 'a'), positionOf(leader, 'b')];

    press(host, 'ArrowRight');

    expect(positionOf(leader, 'a').x).toBe(starts[0]!.x + 1);
    expect(positionOf(leader, 'b').x).toBe(starts[1]!.x + 1);
    expect(undoCount(leader) - before).toBe(1);
    expect(leader.history.undo()).toBe(true);
    expect(positionOf(leader, 'a')).toEqual(starts[0]);
    expect(positionOf(leader, 'b')).toEqual(starts[1]);
  });

  it('removes the selection on Delete and on Backspace, one undo step each', () => {
    const { leader, host } = build(['a', 'b']);
    const before = undoCount(leader);

    press(host, 'Delete');

    expect(leader.annotations.get('a')).toBeUndefined();
    expect(leader.annotations.get('b')).toBeUndefined();
    expect(undoCount(leader) - before).toBe(1);
    expect(leader.history.undo()).toBe(true);
    expect(leader.annotations.get('a')).toBeDefined();

    leader.annotations.select(['a', 'b']);
    press(host, 'Backspace');
    expect(leader.annotations.getSnapshot().annotations).toHaveLength(0);
  });

  it('clears the selection on Escape, without spending an undo entry', () => {
    const { leader, host } = build(['a']);
    const before = undoCount(leader);

    press(host, 'Escape');

    expect(leader.annotations.getSnapshot().selectedIds).toEqual([]);
    expect(undoCount(leader)).toBe(before);
  });
});

describe('a run of key repeats', () => {
  it('is one undo step, and still moves the full distance', () => {
    const { leader, host } = build(['a']);
    const before = undoCount(leader);
    const start = positionOf(leader, 'a');

    // The first press of a held key reports `repeat: false`; every one after it reports `true`.
    // No `update()` between them on purpose: at 30 repeats a second against a heavy scene, two
    // presses inside one frame is ordinary, and neither the step nor the undo entry may be lost.
    for (let index = 0; index < 40; index += 1) press(host, 'ArrowRight', { repeat: index > 0 });

    expect(positionOf(leader, 'a').x).toBe(start.x + 40);
    expect(undoCount(leader) - before).toBe(1);
    expect(leader.history.undo()).toBe(true);
    expect(positionOf(leader, 'a')).toEqual(start);
  });

  it('keeps reading the laid-out rect once a frame has run between presses', () => {
    const { leader, host } = build(['a']);
    const start = positionOf(leader, 'a');

    for (let index = 0; index < 5; index += 1) {
      press(host, 'ArrowRight', { repeat: index > 0 });
      leader.update();
    }

    expect(positionOf(leader, 'a').x).toBe(start.x + 5);
  });

  it('starts a new undo entry when the key is released and pressed again', () => {
    const { leader, host } = build(['a']);
    const before = undoCount(leader);

    press(host, 'ArrowRight', { repeat: false });
    press(host, 'ArrowRight', { repeat: true });
    press(host, 'ArrowRight', { repeat: false });

    expect(undoCount(leader) - before).toBe(2);
  });
});

describe('keys the controller must not take', () => {
  it('leaves Delete and the arrows to a focused textarea', () => {
    const { leader, host } = build(['a']);
    const textarea = document.createElement('textarea');
    host.appendChild(textarea);
    const start = positionOf(leader, 'a');

    press(textarea, 'Delete');
    press(textarea, 'ArrowRight');
    press(textarea, 'Escape');

    expect(leader.annotations.get('a')).toBeDefined();
    expect(positionOf(leader, 'a')).toEqual(start);
    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a']);
  });

  it('leaves them to an input, a select and a contenteditable region', () => {
    const { leader, host } = build(['a']);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inside = document.createElement('span');
    editable.appendChild(inside);
    host.append(document.createElement('input'), document.createElement('select'), editable);

    for (const target of [...host.children, inside]) press(target, 'Delete');

    expect(leader.annotations.get('a')).toBeDefined();
  });

  it('does not bind undo or redo — undo scope is application scope', () => {
    const { leader, host } = build(['a']);
    const start = positionOf(leader, 'a');
    press(host, 'ArrowRight');
    const nudged = positionOf(leader, 'a');
    const after = undoCount(leader);

    press(host, 'z', { metaKey: true });
    press(host, 'z', { ctrlKey: true });
    press(host, 'Z', { metaKey: true, shiftKey: true });
    press(host, 'y', { ctrlKey: true });

    expect(positionOf(leader, 'a')).toEqual(nudged);
    expect(undoCount(leader)).toBe(after);
    // Still undoable through the host's own call — the entry is there, nothing consumed it.
    expect(leader.history.undo()).toBe(true);
    expect(positionOf(leader, 'a')).toEqual(start);
  });
});

describe('lifetime', () => {
  it('binds nothing when disabled', () => {
    const { leader, host } = build(['a'], { enabled: false });
    const start = positionOf(leader, 'a');

    press(host, 'ArrowRight');
    press(host, 'Delete');
    press(host, 'Escape');

    expect(positionOf(leader, 'a')).toEqual(start);
    expect(leader.annotations.get('a')).toBeDefined();
    expect(leader.annotations.getSnapshot().selectedIds).toEqual(['a']);
  });

  it('removes the listener on dispose, and disposes twice without complaint', () => {
    const { leader, keyboard, host } = build(['a']);
    const start = positionOf(leader, 'a');

    keyboard.dispose();
    keyboard.dispose();
    press(host, 'ArrowRight');
    press(host, 'Delete');

    expect(positionOf(leader, 'a')).toEqual(start);
    expect(leader.annotations.get('a')).toBeDefined();
  });
});
