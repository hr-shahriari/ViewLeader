/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
} from '../src/index.js';

/**
 * A held arrow key delivers each `keydown` in its own task, so every repeat lands at transaction
 * depth 0 and pushes its own undo entry. With the default capacity of 100 that evicts the entire
 * history in about three seconds of key repeat, and eight taps then undo gives back one pixel.
 *
 * The caller knows it is a repeat — `KeyboardEvent.repeat` says so — so it opts in rather than the
 * engine inferring a run from timing. Core stays clock-free, and two deliberate edits that happen
 * to land close together are never silently merged.
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

function note(id: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
    content: { kind: 'plain-note', text: id },
    placement: { kind: 'manual', position: { x: 100, y: 100 } },
  };
}

function build(): ViewLeader {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const leader = new ViewLeader({ boundary: element, adapters });
  leader.annotations.create(note('a'));
  return leader;
}

/** Creating the fixture is itself one undo entry, so every count here is measured against it. */
function undoEntriesSince(leader: ViewLeader, baseline: number): number {
  return leader.history.getSnapshot().undoCount - baseline;
}

function positionOf(leader: ViewLeader, id: string): { x: number; y: number } {
  const placement = leader.annotations.get(id)?.placement;
  if (placement?.kind !== 'manual') throw new Error('expected a manual placement');
  return placement.position;
}

/** One press of a held arrow key. `repeat` is false for the first, true for every one after. */
function nudge(leader: ViewLeader, id: string, step: number, repeat: boolean): void {
  const from = positionOf(leader, id);
  leader.history.transaction(
    'Nudge annotation',
    () => leader.annotations.move(id, { x: from.x + step, y: from.y }),
    { coalesce: repeat },
  );
}

describe('a run of repeated edits is one undo step', () => {
  it('collapses 150 key repeats into a single entry instead of evicting the history', () => {
    const leader = build();
    const baseline = leader.history.getSnapshot().undoCount;
    const start = positionOf(leader, 'a');

    for (let index = 0; index < 150; index += 1) nudge(leader, 'a', 1, index > 0);

    expect(positionOf(leader, 'a').x).toBe(start.x + 150);
    // One entry for the whole run, so nothing older was pushed off the end.
    expect(undoEntriesSince(leader, baseline)).toBe(1);

    expect(leader.history.undo()).toBe(true);
    expect(positionOf(leader, 'a')).toEqual(start);
    leader.dispose();
  });

  it('does not merge presses that did not opt in', () => {
    const leader = build();
    const baseline = leader.history.getSnapshot().undoCount;
    for (let index = 0; index < 3; index += 1) nudge(leader, 'a', 1, false);
    expect(undoEntriesSince(leader, baseline)).toBe(3);
    leader.dispose();
  });

  it('will not merge across a different label', () => {
    const leader = build();
    const baseline = leader.history.getSnapshot().undoCount;
    nudge(leader, 'a', 1, false);
    const before = positionOf(leader, 'a');
    leader.history.transaction(
      'Something else',
      () => leader.annotations.update('a', { content: { kind: 'plain-note', text: 'changed' } }),
      { coalesce: true },
    );
    expect(undoEntriesSince(leader, baseline)).toBe(2);
    expect(leader.history.getSnapshot().undoLabel).toBe('Something else');
    expect(positionOf(leader, 'a')).toEqual(before);
    leader.dispose();
  });

  it('does not merge into an entry that an undo has already stepped off', () => {
    // Matching on the label alone is not enough. Reachable for real: hold an arrow key, press undo
    // mid-hold, and the still-repeating key arrives with `repeat: true` against a head entry that
    // no longer describes the current state. Rewriting it destroys the step undo just returned to.
    const leader = build();
    const start = positionOf(leader, 'a');

    nudge(leader, 'a', 10, false);   // entry A → start + 10
    nudge(leader, 'a', 10, false);   // entry B → start + 20, same label, separate entry
    expect(positionOf(leader, 'a').x).toBe(start.x + 20);

    expect(leader.history.undo()).toBe(true);
    expect(positionOf(leader, 'a').x).toBe(start.x + 10);

    // The key is still held, so this arrives coalescing — but entry A is not a run this commit is
    // continuing, and merging into it would erase the start + 10 state entirely.
    nudge(leader, 'a', 5, true);
    expect(positionOf(leader, 'a').x).toBe(start.x + 15);

    expect(leader.history.undo()).toBe(true);
    expect(positionOf(leader, 'a').x).toBe(start.x + 10);
    leader.dispose();
  });

  it('keeps the whole run undoable as one step even past the history capacity', () => {
    const leader = build();
    const baseline = leader.history.getSnapshot().undoCount;
    const start = positionOf(leader, 'a');
    for (let index = 0; index < 400; index += 1) nudge(leader, 'a', 1, index > 0);
    expect(undoEntriesSince(leader, baseline)).toBe(1);
    leader.history.undo();
    expect(positionOf(leader, 'a')).toEqual(start);
    leader.dispose();
  });
});
