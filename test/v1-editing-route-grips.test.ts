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

function note(id: string, position: Vec2, vertices?: readonly Vec2[]): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    routing: vertices === undefined
      ? { kind: 'automatic', mode: 'dogleg' }
      : { kind: 'manual', vertices },
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position },
  };
}

function twoLegNote(id: string): AnnotationDraft {
  return {
    id,
    anchors: [
      { id: 'left', anchor: { kind: 'world-point', point: { x: -4, y: 0, z: 0 } }, routing: { kind: 'manual', vertices: [{ x: 330, y: 340 }] } },
      { id: 'right', anchor: { kind: 'world-point', point: { x: 4, y: 0, z: 0 } }, routing: { kind: 'manual', vertices: [{ x: 470, y: 340 }] } },
    ],
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position: { x: 600, y: 450 } },
  };
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

function makeLeader(handles?: 'core' | 'none'): { leader: ViewLeader; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({
    boundary: root,
    adapters: fixedAdapters,
    ...(handles === undefined ? {} : { editing: { handles } }),
  });
  return { leader, root };
}

/** Vertices of the annotation's manual routing, or `undefined` when it is still automatic. */
function vertices(leader: ViewLeader, id: string, legIndex = 0): readonly Vec2[] | undefined {
  const routing = leader.annotations.get(id)!.anchors[legIndex]!.routing;
  return routing.kind === 'manual' ? routing.vertices : undefined;
}

/** Drags route handle `index` from its own position to `to`. */
function dragRouteHandle(leader: ViewLeader, id: string, index: number, to: Vec2): void {
  const handle = leader.geometry.of(id)!.routeHandles[index]!;
  leader.editing.beginRouteHandleDrag(id, index, at(handle.at.x, handle.at.y));
  leader.editing.pointerMove(at(to.x, to.y));
  leader.update();
  leader.editing.pointerUp(at(to.x, to.y));
  leader.update();
}

describe('route grips: what is published', () => {
  it('publishes one midpoint for an automatic route, and it sits on the drawn line', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.update();
    const geometry = leader.geometry.of('a1')!;
    expect(geometry.routeHandles).toHaveLength(1);
    const [handle] = geometry.routeHandles;
    expect(handle).toMatchObject({ target: 'leg-1', kind: 'midpoint', index: 0 });

    // The grip must lie on the polyline, not on the straight line between its ends.
    const points = geometry.legs[0]!;
    const onLine = points.slice(1).some((point, index) => {
      const from = points[index]!;
      const cross = (point.x - from.x) * (handle!.at.y - from.y) - (point.y - from.y) * (handle!.at.x - from.x);
      return Math.abs(cross) < 1e-6
        && handle!.at.x >= Math.min(from.x, point.x) - 1e-6 && handle!.at.x <= Math.max(from.x, point.x) + 1e-6
        && handle!.at.y >= Math.min(from.y, point.y) - 1e-6 && handle!.at.y <= Math.max(from.y, point.y) + 1e-6;
    });
    expect(onLine).toBe(true);
    leader.dispose();
  });

  it('publishes a vertex grip per manual vertex plus a midpoint per segment', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }, { x: 500, y: 380 }]));
    leader.update();
    const handles = leader.geometry.of('a1')!.routeHandles;
    // Drawn route is [anchor, v0, v1, attachment] → 2 vertices, 3 segments.
    expect(handles.filter(({ kind }) => kind === 'vertex')).toHaveLength(2);
    expect(handles.filter(({ kind }) => kind === 'midpoint')).toHaveLength(3);
    const [first, second] = handles.filter(({ kind }) => kind === 'vertex');
    expect(first!.at).toMatchObject({ x: 450, y: 340 });
    expect(second!.at).toMatchObject({ x: 500, y: 380 });
    leader.dispose();
  });

  it('draws a hollow diamond for a vertex and a hollow square for a midpoint', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    leader.annotations.select(['a1']);
    leader.update();
    const grips = [...root.querySelectorAll('[data-route-handle]')];
    const vertex = grips.find((grip) => grip.getAttribute('data-route-handle') === 'vertex')!;
    const midpoint = grips.find((grip) => grip.getAttribute('data-route-handle') === 'midpoint')!;
    expect(vertex.getAttribute('fill')).toBe('none');
    expect(vertex.getAttribute('transform')).toMatch(/^rotate\(45 /u);
    expect(midpoint.getAttribute('fill')).toBe('none');
    expect(midpoint.getAttribute('transform')).toBeNull();
    leader.dispose();
  });

  it('hides route grips until selected, and draws none when the host opts out', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    leader.update();
    expect((root.querySelector('[data-route-handles]') as SVGElement).style.display).toBe('none');
    leader.annotations.select(['a1']);
    expect((root.querySelector('[data-route-handles]') as SVGElement).style.display).toBe('');
    leader.dispose();

    const opted = makeLeader('none');
    opted.leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    opted.leader.annotations.select(['a1']);
    opted.leader.update();
    expect(opted.root.querySelectorAll('[data-route-handle]')).toHaveLength(0);
    // The data is still published, so the host can draw its own.
    expect(opted.leader.geometry.of('a1')!.routeHandles.length).toBeGreaterThan(0);
    opted.leader.dispose();
  });
});

describe('route grips: dragging a vertex', () => {
  it('moves the vertex and changes the drawn route', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    leader.annotations.select(['a1']);
    leader.update();
    const before = leader.geometry.of('a1')!.legs[0]!;
    const vertexHandle = leader.geometry.of('a1')!.routeHandles
      .findIndex(({ kind }) => kind === 'vertex');

    dragRouteHandle(leader, 'a1', vertexHandle, { x: 380, y: 250 });

    expect(vertices(leader, 'a1')).toEqual([{ x: 380, y: 250 }]);
    expect(leader.geometry.of('a1')!.legs[0]).not.toEqual(before);
    leader.dispose();
  });

  it('survives camera orbit, because the vertex is stored not previewed', () => {
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
    const root = document.createElement('div');
    document.body.appendChild(root);
    const leader = new ViewLeader({ boundary: root, adapters: orbiting });
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    leader.annotations.select(['a1']);
    leader.update();
    const index = leader.geometry.of('a1')!.routeHandles.findIndex(({ kind }) => kind === 'vertex');
    dragRouteHandle(leader, 'a1', index, { x: 380, y: 250 });

    offset = 100;
    leader.update();
    const moved = leader.geometry.of('a1')!.routeHandles.find(({ kind }) => kind === 'vertex')!;
    expect(moved.at).toMatchObject({ x: 380, y: 250 });
    leader.dispose();
  });

  it('is one undo step, labelled as a reroute', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    leader.annotations.select(['a1']);
    leader.update();
    const before = leader.history.getSnapshot().undoCount;
    const index = leader.geometry.of('a1')!.routeHandles.findIndex(({ kind }) => kind === 'vertex');

    dragRouteHandle(leader, 'a1', index, { x: 380, y: 250 });

    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);
    expect(leader.history.getSnapshot().undoLabel).toBe('Reroute annotation');
    leader.history.undo();
    expect(vertices(leader, 'a1')).toEqual([{ x: 450, y: 340 }]);
    leader.dispose();
  });

  it('previews without touching the document, and cancel restores the drawn route', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    leader.annotations.select(['a1']);
    leader.update();
    const drawnBefore = leader.geometry.of('a1')!.legs[0]!;
    const index = leader.geometry.of('a1')!.routeHandles.findIndex(({ kind }) => kind === 'vertex');
    const handle = leader.geometry.of('a1')!.routeHandles[index]!;

    leader.editing.beginRouteHandleDrag('a1', index, at(handle.at.x, handle.at.y));
    leader.editing.pointerMove(at(300, 200));
    leader.update();
    expect(leader.geometry.of('a1')!.legs[0]).not.toEqual(drawnBefore);
    expect(vertices(leader, 'a1')).toEqual([{ x: 450, y: 340 }]);

    leader.editing.cancel();
    leader.update();
    expect(leader.geometry.of('a1')!.legs[0]).toEqual(drawnBefore);
    leader.dispose();
  });

  it('reopens from a saved document with the same vertices', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    leader.annotations.select(['a1']);
    leader.update();
    const index = leader.geometry.of('a1')!.routeHandles.findIndex(({ kind }) => kind === 'vertex');
    dragRouteHandle(leader, 'a1', index, { x: 380, y: 250 });
    const serialized = leader.documents.serialize();
    leader.dispose();

    const reopened = makeLeader();
    reopened.leader.documents.replace(serialized);
    expect(vertices(reopened.leader, 'a1')).toEqual([{ x: 380, y: 250 }]);
    reopened.leader.dispose();
  });
});

describe('route grips: inserting a bend', () => {
  it('a midpoint drag on an automatic route inserts exactly one vertex at the drop point', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    expect(vertices(leader, 'a1')).toBeUndefined();

    dragRouteHandle(leader, 'a1', 0, { x: 470, y: 250 });

    // The pointer round-trips through normalized 0..1, so the drop lands within a rounding step.
    expect(vertices(leader, 'a1')).toHaveLength(1);
    expect(vertices(leader, 'a1')![0]!.x).toBeCloseTo(470, 6);
    expect(vertices(leader, 'a1')![0]!.y).toBeCloseTo(250, 6);
    leader.dispose();
  });

  it('a midpoint drag on a manual route inserts one vertex in the right place', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }, { x: 500, y: 380 }]));
    leader.annotations.select(['a1']);
    leader.update();
    const handles = leader.geometry.of('a1')!.routeHandles;
    // Segment 1 runs v0 → v1, so a vertex inserted there lands between them.
    const index = handles.findIndex((handle) => handle.kind === 'midpoint' && handle.index === 1);

    dragRouteHandle(leader, 'a1', index, { x: 200, y: 200 });

    const result = vertices(leader, 'a1')!;
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ x: 450, y: 340 });
    expect(result[1]!.x).toBeCloseTo(200, 6);
    expect(result[1]!.y).toBeCloseTo(200, 6);
    expect(result[2]).toEqual({ x: 500, y: 380 });
    leader.dispose();
  });

  it('inserts once, however many pointer moves the drag takes', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    const handle = leader.geometry.of('a1')!.routeHandles[0]!;

    leader.editing.beginRouteHandleDrag('a1', 0, at(handle.at.x, handle.at.y));
    for (const step of [40, 80, 120, 160]) {
      leader.editing.pointerMove(at(handle.at.x + step, handle.at.y - step));
    }
    leader.editing.pointerUp(at(handle.at.x + 160, handle.at.y - 160));

    expect(vertices(leader, 'a1')).toHaveLength(1);
    expect(vertices(leader, 'a1')![0]!.x).toBeCloseTo(handle.at.x + 160, 6);
    expect(vertices(leader, 'a1')![0]!.y).toBeCloseTo(handle.at.y - 160, 6);
    leader.dispose();
  });

  it('an under-threshold press on a midpoint inserts nothing', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    const handle = leader.geometry.of('a1')!.routeHandles[0]!;
    const before = leader.history.getSnapshot().undoCount;

    leader.editing.beginRouteHandleDrag('a1', 0, at(handle.at.x, handle.at.y));
    leader.editing.pointerMove(at(handle.at.x + 2, handle.at.y));
    leader.editing.pointerUp(at(handle.at.x + 2, handle.at.y));

    expect(vertices(leader, 'a1')).toBeUndefined();
    expect(leader.history.getSnapshot().undoCount).toBe(before);
    leader.dispose();
  });
});

describe('route grips: per leg and escape hatches', () => {
  it('rerouting one leg leaves the other byte-identical', () => {
    const { leader } = makeLeader();
    leader.annotations.create(twoLegNote('a1'));
    leader.annotations.select(['a1']);
    leader.update();
    const untouched = leader.annotations.get('a1')!.anchors[1]!;
    const handles = leader.geometry.of('a1')!.routeHandles;
    const index = handles.findIndex((handle) => handle.kind === 'vertex' && handle.target === 'left');

    dragRouteHandle(leader, 'a1', index, { x: 260, y: 260 });

    expect(vertices(leader, 'a1', 0)).toEqual([{ x: 260, y: 260 }]);
    expect(leader.annotations.get('a1')!.anchors[1]).toEqual(untouched);
    leader.dispose();
  });

  it('resetRouting returns to automatic and the manual vertices are gone', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    leader.update();
    leader.annotations.resetRouting('a1', 'dogleg');
    expect(leader.annotations.get('a1')!.anchors[0]!.routing).toEqual({
      kind: 'automatic',
      mode: 'dogleg',
    });
    leader.dispose();
  });

  it('the arrowhead still follows the first segment after a bend', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.annotations.select(['a1']);
    leader.update();
    dragRouteHandle(leader, 'a1', 0, { x: 470, y: 180 });

    const head = root.querySelector('[data-annotation-id="a1"] path[data-terminator="anchor"]')!;
    const [, , angle] = [...(head.getAttribute('transform') ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)]
      .map(([match]) => Number(match)) as [number, number, number];
    const [start, next] = leader.geometry.of('a1')!.legs[0]!;
    // The route is trimmed by the head, so the drawn start already sits along the first segment.
    const expected = Math.atan2(start!.y - next!.y, start!.x - next!.x) * (180 / Math.PI);
    expect(angle).toBeCloseTo(expected, 1);
    leader.dispose();
  });

  it('an unknown route handle index starts nothing', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }));
    leader.update();
    leader.editing.beginRouteHandleDrag('a1', 99, at(400, 300));
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('a vertex grip beats the midpoints either side of it', () => {
    const { leader } = makeLeader();
    leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    leader.annotations.select(['a1']);
    leader.update();
    const vertex = leader.geometry.of('a1')!.routeHandles.find(({ kind }) => kind === 'vertex')!;
    const hit = leader.editing.hitTest(at(vertex.at.x, vertex.at.y))!;
    expect(hit.kind).toBe('route-handle');
    expect(leader.geometry.of('a1')!.routeHandles[hit.index!]!.kind).toBe('vertex');
    leader.dispose();
  });
});
