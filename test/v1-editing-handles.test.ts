/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type Anchor,
  type AnnotationDraft,
  type HostAdapterBundle,
  type NormalizedPointerInput,
} from '../src/index.js';
import type { Vec2 } from '../src/types.js';

const VIEWPORT = { width: 800, height: 600 };

/** World (x, y) → screen (400 + 10x, 300 - 10y), so the origin projects to the viewport centre. */
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

function pickingAdapters(anchor: Anchor | null): HostAdapterBundle {
  return { ...fixedAdapters, picking: { pick: async () => anchor } };
}

function note(id: string, position: Vec2): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    routing: { kind: 'automatic', mode: 'dogleg' },
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position },
  };
}

/** Two legs, so handle indexing and per-leg retargeting are actually exercised. */
function twoLegNote(id: string, position: Vec2): AnnotationDraft {
  return {
    id,
    anchors: [
      { id: 'left', anchor: { kind: 'world-point', point: { x: -4, y: 0, z: 0 } }, routing: { kind: 'automatic', mode: 'dogleg' } },
      { id: 'right', anchor: { kind: 'world-point', point: { x: 4, y: 0, z: 0 } }, routing: { kind: 'automatic', mode: 'dogleg' } },
    ],
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position },
  };
}

/** Lets the picking promise and the update that follows it settle. */
async function flushPick(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

function at(x: number, y: number): NormalizedPointerInput {
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
  };
}

function makeLeader(
  options: { adapters?: HostAdapterBundle; handles?: 'core' | 'none' } = {},
): { leader: ViewLeader; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({
    boundary: root,
    adapters: options.adapters ?? fixedAdapters,
    ...(options.handles === undefined ? {} : { editing: { handles: options.handles } }),
  });
  return { leader, root };
}

/** The drawn grips of one annotation: centre point per grip, or [] when none are visible. */
function drawnGrips(root: Element, id: string): { x: number; y: number }[] {
  return [...root.querySelectorAll(`[data-annotation-id="${id}"] rect[data-handle]`)]
    .filter((grip) => (grip as SVGElement).style.display !== 'none')
    .map((grip) => ({
      x: Number(grip.getAttribute('x')) + Number(grip.getAttribute('width')) / 2,
      y: Number(grip.getAttribute('y')) + Number(grip.getAttribute('height')) / 2,
    }));
}

describe('handles: core draws them', () => {
  it('draws a grip at every position the geometry surface publishes', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(twoLegNote('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();

    const published = leader.geometry.of('a1')!.handles;
    expect(published).toHaveLength(2);
    const drawn = drawnGrips(root, 'a1');
    expect(drawn).toHaveLength(2);
    published.forEach((handle, index) => {
      expect(drawn[index]!.x).toBeCloseTo(handle.at.x, 3);
      expect(drawn[index]!.y).toBeCloseTo(handle.at.y, 3);
    });
    leader.dispose();
  });

  it('shows grips only on selected annotations, and hides them on deselect', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.create(note('a2', { x: 200, y: 200 }));
    leader.update();
    expect(drawnGrips(root, 'a1')).toHaveLength(0);

    leader.annotations.select(['a1']);
    expect(drawnGrips(root, 'a1')).toHaveLength(1);
    expect(drawnGrips(root, 'a2')).toHaveLength(0);

    leader.annotations.clearSelection();
    expect(drawnGrips(root, 'a1')).toHaveLength(0);
    leader.dispose();
  });

  it('tracks the anchor through camera orbit without rebuilding the group', () => {
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
    const { leader, root } = makeLeader({ adapters: orbiting });
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    const grip = root.querySelector('[data-annotation-id="a1"] rect[data-handle]')!;
    const before = drawnGrips(root, 'a1')[0]!;

    offset = 90;
    leader.update();
    // Same element, moved — not a rebuilt group.
    expect(root.querySelector('[data-annotation-id="a1"] rect[data-handle]')).toBe(grip);
    expect(drawnGrips(root, 'a1')[0]!.x).toBeCloseTo(before.x + 90, 3);
    leader.dispose();
  });

  it('grips are a fixed screen size, so they do not shrink with the model', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    const grip = root.querySelector('[data-annotation-id="a1"] rect[data-handle]')!;
    expect(Number(grip.getAttribute('width'))).toBeGreaterThan(3);
    expect(Number(grip.getAttribute('width'))).toBe(Number(grip.getAttribute('height')));
    leader.dispose();
  });
});

describe('handles: hit precedence', () => {
  it('a grip beats the label box it sits inside', () => {
    const { leader } = makeLeader();
    // Label placed over the projected anchor (400, 300), so the grip is inside the label box.
    leader.annotations.create(note('a1', { x: 380, y: 285 }));
    leader.annotations.select(['a1']);
    leader.update();
    const handle = leader.geometry.of('a1')!.handles[0]!;
    const label = leader.geometry.of('a1')!.label;
    // Prove the overlap is real before asserting the precedence.
    expect(handle.at.x).toBeGreaterThan(label.x);
    expect(handle.at.x).toBeLessThan(label.x + label.width);

    expect(leader.editing.hitTest(at(handle.at.x, handle.at.y))).toMatchObject({
      kind: 'handle',
      legId: 'leg-1',
      index: 0,
    });
    leader.dispose();
  });

  it('only grips of selected annotations are grabbable', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.update();
    const handle = leader.geometry.of('a1')!.handles[0]!;
    expect(leader.editing.hitTest(at(handle.at.x, handle.at.y))).not.toMatchObject({ kind: 'handle' });

    leader.annotations.select(['a1']);
    leader.update();
    expect(leader.editing.hitTest(at(handle.at.x, handle.at.y))).toMatchObject({ kind: 'handle' });
    leader.dispose();
  });

  it('starts a handle drag, not a label drag, and moves no label', () => {
    const { leader } = makeLeader({ adapters: pickingAdapters(null) });
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    const handle = leader.geometry.of('a1')!.handles[0]!;

    leader.editing.pointerDown(at(handle.at.x, handle.at.y));
    leader.editing.pointerMove(at(handle.at.x + 60, handle.at.y + 20));
    leader.update();

    const snapshot = leader.editing.getSnapshot();
    expect(snapshot.kind).toBe('handle');
    expect(snapshot.leg).toBe('leg-1');
    // The leader now starts at the dragged point; the label has not moved.
    expect(leader.geometry.of('a1')!.label).toMatchObject({ x: 560, y: 420 });
    expect(leader.geometry.of('a1')!.handles[0]!.at.x).toBeCloseTo(handle.at.x + 60, 3);
    leader.dispose();
  });

  it('picks the right leg of a multi-leg annotation', () => {
    const { leader } = makeLeader({ adapters: pickingAdapters(null) });
    leader.annotations.create(twoLegNote('a1', { x: 600, y: 450 }));
    leader.annotations.select(['a1']);
    leader.update();
    const [, second] = leader.geometry.of('a1')!.handles;
    leader.editing.pointerDown(at(second!.at.x, second!.at.y));
    expect(leader.editing.getSnapshot().leg).toBe(second!.target);
    leader.dispose();
  });
});

describe('handles: the host can opt out', () => {
  it('draws nothing and hit-tests nothing under handles: none', () => {
    const { leader, root } = makeLeader({ handles: 'none' });
    leader.annotations.create(note('a1', { x: 380, y: 285 }));
    leader.annotations.select(['a1']);
    leader.update();

    expect(root.querySelectorAll('rect[data-handle]')).toHaveLength(0);
    // The data is still published — that is the whole point of the opt-out.
    const handle = leader.geometry.of('a1')!.handles[0]!;
    // A pointer where the grip would have been reaches the label underneath instead.
    expect(leader.editing.hitTest(at(handle.at.x, handle.at.y))).toMatchObject({ kind: 'label' });
    leader.dispose();
  });

  it('a host that opted out can still drive the identical handle drag', async () => {
    const anchor: Anchor = { kind: 'world-point', point: { x: 9, y: 9, z: 0 } };
    const run = async (handles: 'core' | 'none'): Promise<Anchor> => {
      const { leader } = makeLeader({ adapters: pickingAdapters(anchor), handles });
      leader.annotations.create(note('a1', { x: 560, y: 420 }));
      leader.annotations.select(['a1']);
      leader.update();
      leader.editing.beginHandleDrag('a1', 0, at(400, 300));
      leader.editing.pointerMove(at(460, 320));
      leader.editing.pointerUp(at(460, 320));
      await flushPick();
      const result = leader.annotations.get('a1')!.anchors[0]!.anchor;
      leader.dispose();
      return result;
    };
    expect(await run('none')).toEqual(anchor);
    expect(await run('core')).toEqual(anchor);
  });

  it('an unknown handle index starts nothing', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.update();
    leader.editing.beginHandleDrag('a1', 7, at(400, 300));
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });
});

describe('handles: dropping a grip', () => {
  it('retargets the leg to whatever the host picks', async () => {
    const picked: Anchor = {
      kind: 'element',
      elementId: 'beam-12',
      modelId: 'model-1',
      fallbackPoint: { x: 5, y: 2, z: 0 },
    };
    const { leader } = makeLeader({ adapters: pickingAdapters(picked) });
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    const before = leader.history.getSnapshot().undoCount;
    const handle = leader.geometry.of('a1')!.handles[0]!;

    leader.editing.pointerDown(at(handle.at.x, handle.at.y));
    leader.editing.pointerMove(at(handle.at.x + 50, handle.at.y));
    leader.editing.pointerUp(at(handle.at.x + 50, handle.at.y));
    await flushPick();

    expect(leader.annotations.get('a1')!.anchors[0]!.anchor).toEqual(picked);
    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);
    expect(leader.history.getSnapshot().undoLabel).toBe('Retarget annotation');
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('leaves the other legs of a multi-leg annotation untouched', async () => {
    const picked: Anchor = {
      kind: 'element',
      elementId: 'beam-12',
      modelId: 'model-1',
      fallbackPoint: { x: 5, y: 2, z: 0 },
    };
    const { leader } = makeLeader({ adapters: pickingAdapters(picked) });
    leader.annotations.create(twoLegNote('a1', { x: 600, y: 450 }));
    leader.annotations.select(['a1']);
    leader.update();
    const untouched = leader.annotations.get('a1')!.anchors[1]!;

    leader.editing.beginHandleDrag('a1', 0, at(360, 300));
    leader.editing.pointerMove(at(420, 320));
    leader.editing.pointerUp(at(420, 320));
    await flushPick();

    expect(leader.annotations.get('a1')!.anchors[0]!.anchor).toEqual(picked);
    expect(leader.annotations.get('a1')!.anchors[1]).toEqual(untouched);
    leader.dispose();
  });

  it('reverts when the pick finds nothing, because core cannot invent a world point', async () => {
    const { leader } = makeLeader({ adapters: pickingAdapters(null) });
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    const before = leader.annotations.get('a1')!.anchors[0]!.anchor;
    const depth = leader.history.getSnapshot().undoCount;
    const handle = leader.geometry.of('a1')!.handles[0]!;

    leader.editing.pointerDown(at(handle.at.x, handle.at.y));
    leader.editing.pointerMove(at(handle.at.x + 50, handle.at.y));
    leader.editing.pointerUp(at(handle.at.x + 50, handle.at.y));
    await flushPick();
    leader.update();

    expect(leader.annotations.get('a1')!.anchors[0]!.anchor).toEqual(before);
    expect(leader.history.getSnapshot().undoCount).toBe(depth);
    expect(leader.geometry.of('a1')!.handles[0]!.at).toEqual(handle.at);
    leader.dispose();
  });

  it('reports a diagnostic when the host provides no picking adapter', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    const handle = leader.geometry.of('a1')!.handles[0]!;

    leader.editing.pointerDown(at(handle.at.x, handle.at.y));
    leader.editing.pointerMove(at(handle.at.x + 50, handle.at.y));
    leader.editing.pointerUp(at(handle.at.x + 50, handle.at.y));

    expect(leader.diagnostics.getSnapshot().map(({ code }) => code))
      .toContain('EDITING_RETARGET_FAILED');
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('cancelling mid-drag drops the anchor preview', () => {
    const { leader } = makeLeader({ adapters: pickingAdapters(null) });
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    const handle = leader.geometry.of('a1')!.handles[0]!;

    leader.editing.pointerDown(at(handle.at.x, handle.at.y));
    leader.editing.pointerMove(at(handle.at.x + 80, handle.at.y + 40));
    leader.update();
    expect(leader.geometry.of('a1')!.handles[0]!.at.x).not.toBeCloseTo(handle.at.x, 3);

    leader.editing.cancel();
    leader.update();
    expect(leader.geometry.of('a1')!.handles[0]!.at).toEqual(handle.at);
    leader.dispose();
  });
});
