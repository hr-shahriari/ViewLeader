/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { ViewLeader, type AnnotationDraft, type HostAdapterBundle } from '../src/index.js';

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

function note(id: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position: { x: 100, y: 100 } },
  };
}

function makeLeader(): ViewLeader {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({ boundary: root, adapters });
  leader.annotations.create(note('a1'));
  leader.annotations.create(note('a2'));
  return leader;
}

/** Position, undo depth and revision — the three things a split transaction quietly corrupts. */
function state(leader: ViewLeader): { position: unknown; undoCount: number; revision: number } {
  return {
    position: leader.annotations.get('a1')!.placement,
    undoCount: leader.history.getSnapshot().undoCount,
    revision: leader.documents.getSnapshot().documentRevision,
  };
}

describe('transaction: an async callback fails loudly', () => {
  it('throws a TypeError rather than silently splitting the undo step', () => {
    const leader = makeLeader();
    expect(() => leader.history.transaction('Move', async () => {
      leader.annotations.move('a1', { x: 300, y: 300 });
    })).toThrow(TypeError);
    leader.dispose();
  });

  it('rolls back the synchronous prefix, leaving no history entry', () => {
    const leader = makeLeader();
    const before = state(leader);

    expect(() => leader.history.transaction('Move both', async () => {
      // Runs before the first await, so today it would commit on its own.
      leader.annotations.move('a1', { x: 300, y: 300 });
      leader.annotations.move('a2', { x: 400, y: 400 });
      await Promise.resolve();
      leader.annotations.move('a1', { x: 500, y: 500 });
    })).toThrow(TypeError);

    expect(state(leader)).toEqual(before);
    expect(leader.annotations.get('a2')!.placement).toEqual({
      kind: 'manual',
      position: { x: 100, y: 100 },
    });
    leader.dispose();
  });

  it('names the remedy, not just the fault', () => {
    const leader = makeLeader();
    let message = '';
    try {
      leader.history.transaction('Move', async () => undefined);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Move');
    expect(message).toMatch(/await first/iu);
    leader.dispose();
  });

  it('catches a non-promise thenable too, since any of them splits the step', () => {
    const leader = makeLeader();
    const before = state(leader);
    expect(() => leader.history.transaction('Deferred', () => {
      leader.annotations.move('a1', { x: 300, y: 300 });
      // A jQuery-style deferred, or any library's own promise: not `instanceof Promise`, same defect.
      return { then: (resolve: (value: number) => void) => resolve(1) };
    })).toThrow(TypeError);
    expect(state(leader)).toEqual(before);
    leader.dispose();
  });

  it('leaves the engine usable afterwards rather than stuck mid-transaction', () => {
    const leader = makeLeader();
    expect(() => leader.history.transaction('Bad', async () => undefined)).toThrow(TypeError);

    // A normal transaction still works, commits once, and undoes cleanly.
    const before = leader.history.getSnapshot().undoCount;
    leader.history.transaction('Good', () => {
      leader.annotations.move('a1', { x: 300, y: 300 });
      leader.annotations.move('a2', { x: 400, y: 400 });
    });
    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);
    expect(leader.annotations.get('a1')!.placement).toEqual({
      kind: 'manual',
      position: { x: 300, y: 300 },
    });
    leader.history.undo();
    expect(leader.annotations.get('a1')!.placement).toEqual({
      kind: 'manual',
      position: { x: 100, y: 100 },
    });
    leader.dispose();
  });
});

describe('transaction: ordinary callbacks are unaffected', () => {
  it('passes through a returned value, including undefined and null', () => {
    const leader = makeLeader();
    expect(leader.history.transaction('Value', () => 42)).toBe(42);
    expect(leader.history.transaction('Undefined', () => undefined)).toBeUndefined();
    expect(leader.history.transaction('Null', () => null)).toBeNull();
    // An object without a callable `then` is an ordinary value, not a thenable.
    expect(leader.history.transaction('Object', () => ({ then: 'not a function' })))
      .toEqual({ then: 'not a function' });
    leader.dispose();
  });

  it('an async INNER callback rolls back the whole outer transaction', () => {
    const leader = makeLeader();
    const before = state(leader);

    expect(() => leader.history.transaction('Outer', () => {
      leader.annotations.move('a1', { x: 300, y: 300 });
      leader.history.transaction('Inner', async () => {
        leader.annotations.move('a2', { x: 400, y: 400 });
      });
    })).toThrow(TypeError);

    // Not half-applied: the outer mutation is gone too.
    expect(state(leader)).toEqual(before);
    expect(leader.annotations.get('a2')!.placement).toEqual({
      kind: 'manual',
      position: { x: 100, y: 100 },
    });
    leader.dispose();
  });

  it('ordinary nesting still collapses to one undo step', () => {
    const leader = makeLeader();
    const before = leader.history.getSnapshot().undoCount;
    leader.history.transaction('Outer', () => {
      leader.annotations.move('a1', { x: 300, y: 300 });
      leader.history.transaction('Inner', () => {
        leader.annotations.move('a2', { x: 400, y: 400 });
      });
    });
    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);
    leader.dispose();
  });
});
