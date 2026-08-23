/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import {
  ViewLeader,
  type Anchor,
  type HostAdapterBundle,
  type NormalizedPointerInput,
} from '../src/index.js';
import type { Vec2 } from '../src/types.js';

const VIEWPORT = { width: 800, height: 600, devicePixelRatio: 1 } as const;

const worldPoint: Anchor = { kind: 'world-point', point: { x: 0, y: 0, z: 0 } };
const beam: Anchor = {
  kind: 'element',
  modelId: 'model',
  elementId: 'beam-7',
  fallbackPoint: { x: 0, y: 0, z: 0 },
};

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

/**
 * Anchors project to the viewport centre (400, 300), so every asserted route point is either a
 * clicked vertex or the label attachment — never an artefact of the fake projection.
 */
function adapters(overrides: Partial<HostAdapterBundle> = {}): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => VIEWPORT,
      project: (point) => ({
        point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
        depth: point.z,
        visible: true,
      }),
    },
    picking: { pick: () => Promise.resolve(worldPoint) },
    ...overrides,
  };
}

function pointer(x: number, y: number): NormalizedPointerInput {
  return {
    x,
    y,
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };
}

/** The screen point a normalized pointer names, which is the space manual vertices live in. */
function screen(x: number, y: number): Vec2 {
  return { x: x * VIEWPORT.width, y: y * VIEWPORT.height };
}

function session(overrides: Partial<HostAdapterBundle> = {}) {
  const root = boundary();
  const leader = new ViewLeader({ boundary: root, adapters: adapters(overrides) });
  const outcome = leader.authoring.start({
    draft: { id: 'drawn', content: { kind: 'plain-note', text: 'Beam' } },
    multiPoint: true,
  });
  return { root, leader, outcome };
}

/** Every point of the drawn route, read back out of the rendered path. */
function drawn(root: Element, id: string): readonly Vec2[] {
  const path = root.querySelector(`[data-annotation-id="${id}"] path[data-route-visible]`);
  const numbers = [...(path?.getAttribute('d') ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)]
    .map(([match]) => Number(match));
  return numbers.reduce<Vec2[]>((points, value, index) => index % 2 === 0
    ? [...points, { x: value, y: 0 }]
    : [...points.slice(0, -1), { x: points.at(-1)!.x, y: value }], []);
}

describe('drawing a leader by hand', () => {
  it('turns two clicks into a manual route of the clicked points', async () => {
    const { leader, outcome } = session();
    await leader.authoring.pointerDown(pointer(0.25, 0.5));
    await leader.authoring.pointerDown(pointer(0.75, 0.25));
    expect(leader.authoring.getSnapshot().phase).toBe('ready');

    expect(leader.authoring.finish()).toMatchObject({ status: 'completed' });
    expect(await outcome).toMatchObject({ status: 'completed' });
    expect(leader.annotations.get('drawn')?.anchors[0]?.routing).toEqual({
      kind: 'manual',
      vertices: [screen(0.25, 0.5), screen(0.75, 0.25)],
    });
    leader.dispose();
  });

  it('keeps three clicks in click order and draws them', async () => {
    const { root, leader } = session();
    for (const point of [pointer(0.25, 0.5), pointer(0.5, 0.25), pointer(0.75, 0.5)]) {
      await leader.authoring.pointerDown(point);
    }
    leader.authoring.finish();
    const routing = leader.annotations.get('drawn')?.anchors[0]?.routing;
    expect(routing).toEqual({
      kind: 'manual',
      vertices: [screen(0.25, 0.5), screen(0.5, 0.25), screen(0.75, 0.5)],
    });

    // Not just persisted data: the renderer routes through the bends the drafter clicked.
    leader.update();
    const points = drawn(root, 'drawn');
    expect(points).toContainEqual(screen(0.25, 0.5));
    expect(points).toContainEqual(screen(0.5, 0.25));
    leader.dispose();
  });

  it('lands the label on the final click unless the draft placed it', async () => {
    const { leader } = session();
    await leader.authoring.pointerDown(pointer(0.25, 0.5));
    await leader.authoring.pointerDown(pointer(0.75, 0.25));
    leader.authoring.finish();
    expect(leader.annotations.get('drawn')?.placement)
      .toEqual({ kind: 'manual', position: screen(0.75, 0.25) });

    const root = boundary();
    const stated = new ViewLeader({ boundary: root, adapters: adapters() });
    void stated.authoring.start({
      draft: {
        id: 'stated',
        content: { kind: 'plain-note', text: 'Beam' },
        placement: { kind: 'manual', position: { x: 10, y: 20 } },
      },
      multiPoint: true,
    });
    await stated.authoring.pointerDown(pointer(0.25, 0.5));
    await stated.authoring.pointerDown(pointer(0.75, 0.25));
    stated.authoring.finish();
    expect(stated.annotations.get('stated')?.placement)
      .toEqual({ kind: 'manual', position: { x: 10, y: 20 } });
    leader.dispose();
    stated.dispose();
  });

  it('previews the committed points plus a live segment to the pointer', async () => {
    const { leader } = session();
    await leader.authoring.pointerDown(pointer(0.25, 0.5));
    expect(leader.authoring.getSnapshot().preview).toMatchObject({
      vertices: [screen(0.25, 0.5)],
      livePoint: screen(0.25, 0.5),
      anchor: worldPoint,
    });

    leader.authoring.pointerMove(pointer(0.5, 0.25));
    const moved = leader.authoring.getSnapshot();
    expect(moved.phase).toBe('drawing');
    // The committed segments do not grow while the pointer only moves.
    expect(moved.preview?.vertices).toEqual([screen(0.25, 0.5)]);
    expect(moved.preview?.livePoint).toEqual(screen(0.5, 0.25));

    await leader.authoring.pointerDown(pointer(0.5, 0.25));
    leader.authoring.pointerMove(pointer(0.9, 0.9));
    expect(leader.authoring.getSnapshot().preview).toMatchObject({
      vertices: [screen(0.25, 0.5), screen(0.5, 0.25)],
      livePoint: screen(0.9, 0.9),
    });
    leader.dispose();
  });

  it('anchors the arrow to whatever the host picked — an element or a world point', async () => {
    for (const anchor of [beam, worldPoint]) {
      const { leader } = session({ picking: { pick: () => Promise.resolve(anchor) } });
      await leader.authoring.pointerDown(pointer(0.25, 0.5));
      await leader.authoring.pointerDown(pointer(0.75, 0.25));
      leader.authoring.finish();
      expect(leader.annotations.get('drawn')?.anchors[0]?.anchor).toEqual(anchor);
      leader.dispose();
    }
  });

  it('fails the arrow pick when the host finds nothing, creating nothing', async () => {
    const { leader, outcome } = session({ picking: { pick: () => Promise.resolve(null) } });
    await leader.authoring.pointerDown(pointer(0.25, 0.5));
    expect(await outcome).toMatchObject({ status: 'failed' });
    expect(leader.annotations.getSnapshot().annotations).toEqual([]);
    expect(leader.history.getSnapshot().undoCount).toBe(0);
    leader.dispose();
  });

  it('finishes on Enter, on double-click, and collapses the gesture into one undo step', async () => {
    for (const finish of [
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })),
      (root: Element) => root.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    ]) {
      const { root, leader, outcome } = session();
      await leader.authoring.pointerDown(pointer(0.25, 0.5));
      await leader.authoring.pointerDown(pointer(0.5, 0.25));
      await leader.authoring.pointerDown(pointer(0.75, 0.5));
      finish(root);
      expect(await outcome).toMatchObject({ status: 'completed' });
      expect(leader.annotations.get('drawn')?.anchors[0]?.routing).toMatchObject({ kind: 'manual' });

      // Three clicks, one history entry: the vertices stay transient until finish commits once.
      expect(leader.history.getSnapshot().undoCount).toBe(1);
      expect(leader.history.undo()).toBe(true);
      expect(leader.annotations.getSnapshot().annotations).toEqual([]);
      expect(leader.history.getSnapshot().undoCount).toBe(0);
      leader.dispose();
    }
  });

  it('creates nothing and records nothing when Escape cancels mid-route', async () => {
    const { leader, outcome } = session();
    await leader.authoring.pointerDown(pointer(0.25, 0.5));
    await leader.authoring.pointerDown(pointer(0.5, 0.25));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await outcome).toEqual({ status: 'cancelled', reason: 'escape' });
    expect(leader.annotations.getSnapshot().annotations).toEqual([]);
    expect(leader.history.getSnapshot().undoCount).toBe(0);
    expect(leader.authoring.getSnapshot()).toMatchObject({ phase: 'idle', preview: null });
    leader.dispose();
  });

  it('releases the interaction lease and cancels on pointer exit', async () => {
    const release = vi.fn();
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({ interaction: { acquire: () => ({ release }) } }),
    });
    const outcome = leader.authoring.start({
      draft: { id: 'left', content: { kind: 'plain-note', text: 'Beam' } },
      multiPoint: true,
    });
    await leader.authoring.pointerDown(pointer(0.25, 0.5));
    root.dispatchEvent(new Event('pointerleave'));
    expect(await outcome).toEqual({ status: 'cancelled', reason: 'pointer-exit' });
    expect(release).toHaveBeenCalledOnce();
    expect(leader.annotations.getSnapshot().annotations).toEqual([]);
    leader.dispose();
  });

  it('refuses to finish a route that has fewer than two points', async () => {
    const { leader, outcome } = session();
    await leader.authoring.pointerDown(pointer(0.25, 0.5));
    expect(leader.authoring.finish()).toMatchObject({ status: 'failed' });
    expect(await outcome).toMatchObject({ status: 'failed' });
    expect(leader.annotations.getSnapshot().annotations).toEqual([]);
    expect(leader.history.getSnapshot().undoCount).toBe(0);
    leader.dispose();
  });

  it('drives the whole route headlessly, without a pointer', async () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    const outcome = leader.authoring.start({
      draft: { id: 'headless', content: { kind: 'plain-note', text: 'Beam' } },
      anchor: beam,
      multiPoint: true,
    });
    // A supplied anchor means no pick is pending, so the session opens straight into drawing.
    expect(leader.authoring.getSnapshot().phase).toBe('drawing');
    expect(leader.authoring.addVertex({ x: 120, y: 240 }).phase).toBe('drawing');
    expect(leader.authoring.addVertex({ x: 360, y: 90 }).phase).toBe('ready');
    expect(leader.authoring.finish()).toMatchObject({ status: 'completed' });
    expect(await outcome).toMatchObject({ status: 'completed' });
    expect(leader.annotations.get('headless')?.anchors[0]).toEqual({
      id: 'leg-1',
      anchor: beam,
      routing: { kind: 'manual', vertices: [{ x: 120, y: 240 }, { x: 360, y: 90 }] },
    });
    expect(() => leader.authoring.addVertex({ x: 0, y: 0 })).toThrow(/multi-point/u);
    leader.dispose();
  });

  it('ignores the repeated pointerdown a real double-click fires on one spot', async () => {
    const { leader } = session();
    await leader.authoring.pointerDown(pointer(0.25, 0.5));
    await leader.authoring.pointerDown(pointer(0.75, 0.25));
    await leader.authoring.pointerDown(pointer(0.75, 0.25));
    expect(leader.authoring.getSnapshot().preview?.vertices)
      .toEqual([screen(0.25, 0.5), screen(0.75, 0.25)]);
    leader.dispose();
  });

  it('stops accumulating at the ceiling the router will accept, so rendering never throws', async () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    void leader.authoring.start({
      draft: { id: 'long', content: { kind: 'plain-note', text: 'Beam' } },
      anchor: worldPoint,
      multiPoint: true,
    });
    for (let index = 0; index < 80; index += 1) leader.authoring.addVertex({ x: index, y: index });
    leader.authoring.finish();
    const routing = leader.annotations.get('long')?.anchors[0]?.routing;
    expect(routing?.kind === 'manual' && routing.vertices).toHaveLength(64);
    expect(() => leader.update()).not.toThrow();
    leader.dispose();
  });

  it('leaves single-pick authoring exactly as it was', async () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    const started = leader.authoring.start({
      draft: { id: 'single', content: { kind: 'plain-note', text: 'Beam' } },
    });
    expect(leader.authoring.getSnapshot().phase).toBe('aiming');
    leader.authoring.pointerMove(pointer(0.25, 0.5));
    // No multi-point bookkeeping leaks into the single-pick preview.
    expect(leader.authoring.getSnapshot().preview).toEqual({ pointer: pointer(0.25, 0.5) });
    // One click still creates immediately, with automatic routing rather than a drawn one — which
    // is what "unchanged" means here. The mode itself is `create`'s default and audit-close/10
    // changed it from `straight` to `dogleg`, so this asserts the kind and leaves the mode to the
    // test that owns that decision.
    await leader.authoring.pointerDown(pointer(0.25, 0.5));
    expect(await started).toMatchObject({ status: 'completed' });
    expect(leader.annotations.get('single')?.anchors[0]?.routing)
      .toMatchObject({ kind: 'automatic' });
    expect(leader.authoring.finish()).toBeNull();

    // A supplied anchor still completes on its own, without waiting for a finish.
    expect(await leader.authoring.start({
      draft: { id: 'given', content: { kind: 'plain-note', text: 'Beam' } },
      anchor: worldPoint,
    })).toMatchObject({ status: 'completed' });
    leader.dispose();
  });
});
