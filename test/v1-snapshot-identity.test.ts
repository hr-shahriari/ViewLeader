/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
} from '../src/index.js';

/**
 * `useSyncExternalStore` compares consecutive `getSnapshot()` results with `Object.is` and
 * re-renders whenever they differ. A capability that allocates a fresh object per call therefore
 * reads as a store that changed on every render — React's documented infinite-loop condition, and
 * the reason `useViewLeaderSnapshot` could never have worked.
 *
 * The revision each snapshot already carries is the cache key: `#runtimeRevision` is bumped by
 * `#publishRuntimeChange` for every state change, transient ones included.
 */

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function adapters(): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
      project: (point) => ({
        point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
        depth: point.z,
        visible: true,
      }),
    },
  };
}

function note(id: string, text = id): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
    content: { kind: 'plain-note', text },
  };
}

function build(): ViewLeader {
  const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
  leader.annotations.create(note('a'));
  leader.annotations.create(note('b'));
  return leader;
}

/** Every capability a host can hand to `useViewLeaderSnapshot`. */
const capabilities = [
  ['annotations', (l: ViewLeader) => l.annotations],
  ['authoring', (l: ViewLeader) => l.authoring],
  ['documents', (l: ViewLeader) => l.documents],
  ['history', (l: ViewLeader) => l.history],
  ['definitions', (l: ViewLeader) => l.definitions],
  ['editing', (l: ViewLeader) => l.editing],
] as const;

describe('snapshot identity is stable between changes', () => {
  for (const [name, pick] of capabilities) {
    it(`${name}: two reads with nothing in between are the same object`, () => {
      const leader = build();
      const capability = pick(leader);
      expect(Object.is(capability.getSnapshot(), capability.getSnapshot())).toBe(true);
      leader.dispose();
    });

    it(`${name}: a change produces a different object`, () => {
      const leader = build();
      const capability = pick(leader);
      const before = capability.getSnapshot();
      leader.annotations.create(note('c'));
      expect(Object.is(before, capability.getSnapshot())).toBe(false);
      leader.dispose();
    });
  }

  it('a definition write invalidates the definitions snapshot', () => {
    // The generic case above mutates an annotation, which would not catch a definitions cache keyed
    // on something that only annotations move.
    const leader = build();
    const before = leader.definitions.getSnapshot();
    leader.definitions.create({
      kind: 'style',
      id: 'house',
      name: 'House',
      lineColor: '#1f2937',
      lineWidth: 1.5,
      textColor: '#111827',
      fontFamily: 'sans-serif',
      fontSize: 14,
      terminatorId: 'builtin.terminator.arrow',
    });
    const after = leader.definitions.getSnapshot();
    expect(Object.is(before, after)).toBe(false);
    expect(after.definitions.some((entry) => entry.id === 'house')).toBe(true);
    expect(Object.is(after, leader.definitions.getSnapshot())).toBe(true);
    leader.dispose();
  });

  it('an editing gesture invalidates the editing snapshot', () => {
    // Editing phase lives in the controller, not the document, so this proves transient publishes
    // reach the same revision the cache is keyed on.
    const leader = build();
    const before = leader.editing.getSnapshot();
    leader.editing.pointerDown({
      x: 0.5, y: 0.5, button: 0, buttons: 1, pointerType: 'mouse',
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    });
    const after = leader.editing.getSnapshot();
    expect(Object.is(before, after)).toBe(false);
    expect(Object.is(after, leader.editing.getSnapshot())).toBe(true);
    leader.dispose();
  });

  it('a transient change alone invalidates the annotations snapshot', () => {
    const leader = build();
    const before = leader.annotations.getSnapshot();
    leader.annotations.select(['a']);
    const after = leader.annotations.getSnapshot();
    expect(Object.is(before, after)).toBe(false);
    expect(after.selectedIds).toEqual(['a']);
    expect(Object.is(after, leader.annotations.getSnapshot())).toBe(true);
    leader.dispose();
  });
});
