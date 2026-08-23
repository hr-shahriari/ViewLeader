/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { ViewLeader, type AnnotationDraft, type HostAdapterBundle } from '../src/index.js';

const VIEWPORT = { width: 800, height: 600 };

const adapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
    project: (point) => ({
      point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
      depth: point.z,
      visible: true,
    }),
  },
};

function twoLegNote(id: string): AnnotationDraft {
  return {
    id,
    anchors: [
      { id: 'left', anchor: { kind: 'world-point', point: { x: -4, y: 0, z: 0 } }, routing: { kind: 'automatic', mode: 'dogleg' } },
      { id: 'right', anchor: { kind: 'world-point', point: { x: 4, y: 0, z: 0 } }, routing: { kind: 'automatic', mode: 'dogleg' } },
    ],
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position: { x: 600, y: 450 } },
  };
}

function makeLeader(): ViewLeader {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return new ViewLeader({ boundary: root, adapters });
}

describe('hitTestScreen', () => {
  it('agrees with the normalized form, from the space geometry.of already reports', () => {
    const leader = makeLeader();
    leader.annotations.create(twoLegNote('a1'));
    leader.update();
    const { label } = leader.geometry.of('a1')!;
    const at = { x: label.x + label.width / 2, y: label.y + label.height / 2 };

    const viaScreen = leader.editing.hitTestScreen(at);
    const viaPointer = leader.editing.hitTest({
      x: at.x / VIEWPORT.width,
      y: at.y / VIEWPORT.height,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
    expect(viaScreen).toEqual(viaPointer);
    expect(viaScreen).toMatchObject({ id: 'a1', kind: 'label' });
    leader.dispose();
  });

  it('returns undefined over empty space, and rejects a non-finite point', () => {
    const leader = makeLeader();
    leader.annotations.create(twoLegNote('a1'));
    leader.update();
    expect(leader.editing.hitTestScreen({ x: 5, y: 5 })).toBeUndefined();
    expect(() => leader.editing.hitTestScreen({ x: Number.NaN, y: 0 })).toThrow();
    leader.dispose();
  });
});

describe('per-leg reroute and retarget', () => {
  it('rerouteLeg changes one leg and leaves the other byte-identical', () => {
    const leader = makeLeader();
    leader.annotations.create(twoLegNote('a1'));
    const untouched = leader.annotations.get('a1')!.anchors[1]!;

    leader.annotations.rerouteLeg('a1', 'left', { kind: 'manual', vertices: [{ x: 250, y: 250 }] });

    expect(leader.annotations.get('a1')!.anchors[0]!.routing).toEqual({
      kind: 'manual',
      vertices: [{ x: 250, y: 250 }],
    });
    expect(leader.annotations.get('a1')!.anchors[1]).toEqual(untouched);
    leader.dispose();
  });

  it('retargetLeg does the same for the anchor', () => {
    const leader = makeLeader();
    leader.annotations.create(twoLegNote('a1'));
    const untouched = leader.annotations.get('a1')!.anchors[0]!;

    leader.annotations.retargetLeg('a1', 'right', { kind: 'world-point', point: { x: 9, y: 9, z: 9 } });

    expect(leader.annotations.get('a1')!.anchors[1]!.anchor).toEqual({
      kind: 'world-point',
      point: { x: 9, y: 9, z: 9 },
    });
    expect(leader.annotations.get('a1')!.anchors[0]).toEqual(untouched);
    leader.dispose();
  });

  it('the first-leg forms are unchanged, which is why both exist', () => {
    const leader = makeLeader();
    leader.annotations.create(twoLegNote('a1'));
    const untouched = leader.annotations.get('a1')!.anchors[1]!;

    leader.annotations.reroute('a1', { kind: 'manual', vertices: [{ x: 111, y: 111 }] });

    expect(leader.annotations.get('a1')!.anchors[0]!.routing).toMatchObject({ kind: 'manual' });
    expect(leader.annotations.get('a1')!.anchors[1]).toEqual(untouched);
    leader.dispose();
  });

  it('naming a leg that does not exist is an error, not a silent no-op', () => {
    const leader = makeLeader();
    leader.annotations.create(twoLegNote('a1'));
    expect(() => leader.annotations.rerouteLeg('a1', 'nope', { kind: 'automatic', mode: 'straight' }))
      .toThrow();
    expect(() => leader.annotations.retargetLeg('a1', 'nope', { kind: 'world-point', point: { x: 0, y: 0, z: 0 } }))
      .toThrow();
    leader.dispose();
  });

  it('each is one undo step, labelled for the leg', () => {
    const leader = makeLeader();
    leader.annotations.create(twoLegNote('a1'));
    const before = leader.history.getSnapshot().undoCount;
    leader.annotations.rerouteLeg('a1', 'left', { kind: 'manual', vertices: [{ x: 250, y: 250 }] });
    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);
    expect(leader.history.getSnapshot().undoLabel).toBe('Reroute annotation leg');
    leader.history.undo();
    expect(leader.annotations.get('a1')!.anchors[0]!.routing).toEqual({
      kind: 'automatic',
      mode: 'dogleg',
    });
    leader.dispose();
  });
});
