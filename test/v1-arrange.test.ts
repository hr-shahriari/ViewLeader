/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { ViewLeader, type AnnotationDraft, type HostAdapterBundle } from '../src/index.js';
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

/**
 * `fontSize` drives label size, not text length: content layout wraps a long note rather than
 * widening it, so text is the wrong knob for making two labels deliberately unequal.
 */
function note(id: string, position: Vec2, fontSize?: number): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    routing: { kind: 'automatic', mode: 'dogleg' },
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position },
    ...(fontSize === undefined ? {} : { styleOverride: { fontSize } }),
  };
}

function makeLeader(): ViewLeader {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return new ViewLeader({ boundary: root, adapters: fixedAdapters });
}

/** Creates the notes, selects them all, and renders one frame. */
function withNotes(drafts: readonly AnnotationDraft[]): ViewLeader {
  const leader = makeLeader();
  for (const draft of drafts) leader.annotations.create(draft);
  leader.annotations.select(drafts.map(({ id }) => id!));
  leader.update();
  return leader;
}

function labels(leader: ViewLeader, ids: readonly string[]): { x: number; y: number; width: number; height: number }[] {
  return ids.map((id) => {
    const { x, y, width, height } = leader.geometry.of(id)!.label;
    return { x, y, width, height };
  });
}

const SIX = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

/** Deliberately UNEVEN: equal spacing would make `distribute` a legitimate no-op. */
const SIX_Y = [80, 96, 130, 200, 210, 430];

function sixNotes(): readonly AnnotationDraft[] {
  return SIX.map((id, index) => note(id, { x: 120 + index * 37, y: SIX_Y[index]! }));
}

describe('align', () => {
  it('brings six labels onto one left edge, the leftmost', () => {
    const leader = withNotes(sixNotes());
    const leftmost = Math.min(...labels(leader, SIX).map(({ x }) => x));
    leader.annotations.align('left');
    leader.update();
    for (const label of labels(leader, SIX)) expect(label.x).toBeCloseTo(leftmost, 6);
    leader.dispose();
  });

  it('aligns right edges, not left, when asked for right', () => {
    const leader = withNotes([
      note('short', { x: 100, y: 100 }, 10),
      note('long', { x: 300, y: 200 }, 30),
    ]);
    const widths = labels(leader, ['short', 'long']).map(({ width }) => width);
    expect(widths[0]).not.toBeCloseTo(widths[1]!, 1);
    const rightmost = Math.max(...labels(leader, ['short', 'long']).map(({ x, width }) => x + width));
    leader.annotations.align('right');
    leader.update();
    const [a, b] = labels(leader, ['short', 'long']);
    expect(a!.x + a!.width).toBeCloseTo(rightmost, 6);
    expect(b!.x + b!.width).toBeCloseTo(rightmost, 6);
    // Different widths, so equal right edges means unequal left edges — proving it is not left-align.
    expect(a!.x).not.toBeCloseTo(b!.x, 3);
    leader.dispose();
  });

  it('centres on the selection midpoint, not the viewport centre', () => {
    const leader = withNotes([note('a', { x: 100, y: 100 }), note('b', { x: 200, y: 300 })]);
    const before = labels(leader, ['a', 'b']);
    const midpoint = (Math.min(...before.map(({ x }) => x))
      + Math.max(...before.map(({ x, width }) => x + width))) / 2;
    expect(midpoint).not.toBeCloseTo(VIEWPORT.width / 2, 0);

    leader.annotations.align('center-x');
    leader.update();
    for (const label of labels(leader, ['a', 'b'])) {
      expect(label.x + label.width / 2).toBeCloseTo(midpoint, 6);
    }
    leader.dispose();
  });

  it('writes manual placements that survive camera orbit', () => {
    let offset = 0;
    const root = document.createElement('div');
    document.body.appendChild(root);
    const leader = new ViewLeader({
      boundary: root,
      adapters: {
        projection: {
          getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
          project: (point) => ({
            point: { x: 400 + offset + point.x * 10, y: 300 - point.y * 10 },
            depth: point.z,
            visible: true,
          }),
        },
      },
    });
    for (const draft of [note('a', { x: 100, y: 100 }), note('b', { x: 260, y: 300 })]) {
      leader.annotations.create(draft);
    }
    leader.annotations.select(['a', 'b']);
    leader.update();
    leader.annotations.align('left');
    leader.update();
    const aligned = labels(leader, ['a', 'b']);
    for (const id of ['a', 'b']) {
      expect(leader.annotations.get(id)!.placement.kind).toBe('manual');
    }

    offset = 150;
    leader.update();
    expect(labels(leader, ['a', 'b'])).toEqual(aligned);
    leader.dispose();
  });

  it('is one undo step for all six', () => {
    const leader = withNotes(sixNotes());
    const before = labels(leader, SIX);
    const depth = leader.history.getSnapshot().undoCount;

    leader.annotations.align('left');
    expect(leader.history.getSnapshot().undoCount).toBe(depth + 1);
    expect(leader.history.getSnapshot().undoLabel).toBe('Align annotations');

    leader.history.undo();
    leader.update();
    expect(labels(leader, SIX)).toEqual(before);
    leader.dispose();
  });

  it('is stable: aligning twice changes nothing the second time', () => {
    const leader = withNotes(sixNotes());
    leader.annotations.align('left');
    leader.update();
    const once = labels(leader, SIX);
    const depth = leader.history.getSnapshot().undoCount;

    leader.annotations.align('left');
    leader.update();
    expect(labels(leader, SIX)).toEqual(once);
    // No move means no history entry, so an idle toolbar press cannot fill the undo stack.
    expect(leader.history.getSnapshot().undoCount).toBe(depth);
    leader.dispose();
  });
});

describe('distribute', () => {
  it('leaves the extremes in place and equalises the gaps between the rest', () => {
    const leader = withNotes([
      note('top', { x: 100, y: 100 }),
      note('middle', { x: 100, y: 130 }),
      note('bottom', { x: 100, y: 400 }),
    ]);
    const ids = ['top', 'middle', 'bottom'] as const;
    const before = labels(leader, ids);

    leader.annotations.distribute('y');
    leader.update();
    const after = labels(leader, ids);

    expect(after[0]!.y).toBeCloseTo(before[0]!.y, 6);
    expect(after[2]!.y).toBeCloseTo(before[2]!.y, 6);
    const gaps = [
      after[1]!.y - (after[0]!.y + after[0]!.height),
      after[2]!.y - (after[1]!.y + after[1]!.height),
    ];
    expect(gaps[0]).toBeCloseTo(gaps[1]!, 6);
    leader.dispose();
  });

  it('equalises gaps, not centre distances, when widths differ', () => {
    const leader = withNotes([
      note('a', { x: 100, y: 100 }, 10),
      note('b', { x: 200, y: 100 }, 30),
      // All three widths must differ: with the outer two equal, equal gaps and equal centre
      // spacing are the same thing, so the contrast below would be unprovable.
      note('c', { x: 600, y: 100 }, 20),
    ]);
    leader.annotations.distribute('x');
    leader.update();
    const [a, b, c] = labels(leader, ['a', 'b', 'c']);
    const gaps = [b!.x - (a!.x + a!.width), c!.x - (b!.x + b!.width)];
    expect(gaps[0]).toBeCloseTo(gaps[1]!, 6);
    // Unequal widths mean equal gaps and equal centre spacing cannot both hold.
    const centres = [a!.x + a!.width / 2, b!.x + b!.width / 2, c!.x + c!.width / 2];
    expect(centres[1]! - centres[0]!).not.toBeCloseTo(centres[2]! - centres[1]!, 3);
    leader.dispose();
  });

  it('is one undo step', () => {
    const leader = withNotes(sixNotes());
    const depth = leader.history.getSnapshot().undoCount;
    leader.annotations.distribute('y');
    expect(leader.history.getSnapshot().undoCount).toBe(depth + 1);
    expect(leader.history.getSnapshot().undoLabel).toBe('Distribute annotations');
    // And stable: once distributed there is nothing left to move.
    leader.update();
    leader.annotations.distribute('y');
    expect(leader.history.getSnapshot().undoCount).toBe(depth + 1);
    leader.dispose();
  });
});

describe('arrange: no-ops and edge cases', () => {
  it('does nothing with fewer than two selected, and adds no history entry', () => {
    const leader = withNotes([note('only', { x: 100, y: 100 })]);
    const depth = leader.history.getSnapshot().undoCount;
    const before = labels(leader, ['only']);
    leader.annotations.align('left');
    leader.update();
    expect(labels(leader, ['only'])).toEqual(before);
    expect(leader.history.getSnapshot().undoCount).toBe(depth);
    leader.dispose();
  });

  it('does nothing with nothing selected', () => {
    const leader = makeLeader();
    leader.annotations.create(note('a', { x: 100, y: 100 }));
    leader.update();
    const depth = leader.history.getSnapshot().undoCount;
    expect(() => leader.annotations.align('left')).not.toThrow();
    expect(() => leader.annotations.distribute('x')).not.toThrow();
    expect(leader.history.getSnapshot().undoCount).toBe(depth);
    leader.dispose();
  });

  it('distribute needs three: two selected is a no-op', () => {
    const leader = withNotes([note('a', { x: 100, y: 100 }), note('b', { x: 400, y: 400 })]);
    const before = labels(leader, ['a', 'b']);
    const depth = leader.history.getSnapshot().undoCount;
    leader.annotations.distribute('y');
    leader.update();
    expect(labels(leader, ['a', 'b'])).toEqual(before);
    expect(leader.history.getSnapshot().undoCount).toBe(depth);
    leader.dispose();
  });

  it('skips an off-screen selected annotation rather than throwing', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const hidden = new Set(['ghost']);
    const leader = new ViewLeader({
      boundary: root,
      adapters: {
        projection: {
          getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
          project: (point) => ({
            point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
            depth: point.z,
            // The ghost's anchor projects invisible, so it never reaches the plan.
            visible: point.z !== 99,
          }),
        },
      },
    });
    leader.annotations.create(note('a', { x: 100, y: 100 }));
    leader.annotations.create(note('b', { x: 300, y: 300 }));
    leader.annotations.create({
      id: 'ghost',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 99 } },
      routing: { kind: 'automatic', mode: 'dogleg' },
      content: { kind: 'plain-note', text: 'Ghost' },
      placement: { kind: 'manual', position: { x: 700, y: 500 } },
    });
    leader.annotations.select(['a', 'b', 'ghost']);
    leader.update();
    expect(leader.geometry.of('ghost')).toBeUndefined();

    expect(() => leader.annotations.align('left')).not.toThrow();
    leader.update();
    const [a, b] = labels(leader, ['a', 'b']);
    expect(a!.x).toBeCloseTo(b!.x, 6);
    // Skipped, not moved to a guessed position.
    expect(leader.annotations.get('ghost')!.placement).toEqual({
      kind: 'manual',
      position: { x: 700, y: 500 },
    });
    expect(hidden.size).toBe(1);
    leader.dispose();
  });
});
