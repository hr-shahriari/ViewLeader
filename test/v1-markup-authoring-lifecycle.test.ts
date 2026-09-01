/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { markdownPlugin } from 'viewleader/markdown';
import {
  ViewLeader,
  type ClosedRegionGeometry,
  type HostAdapterBundle,
  type NormalizedPointerInput,
  type SurfacePickResult,
} from '../src/index.js';

const plane = {
  origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
} as const;

const pointer: NormalizedPointerInput = {
  x: 0.25,
  y: 0.75,
  button: 0,
  buttons: 1,
  pointerType: 'mouse',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

function pointerAt(x: number, y: number): NormalizedPointerInput {
  return { ...pointer, x, y };
}

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function adapters(overrides: Partial<HostAdapterBundle> = {}): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
      project: (point) => ({ point: { x: point.x, y: point.y }, depth: point.z, visible: true }),
    },
    ...overrides,
  };
}

const geometries: readonly ClosedRegionGeometry[] = [
  { kind: 'rectangle', center: { x: 0, y: 0 }, width: 4, height: 2 },
  { kind: 'ellipse', center: { x: 1, y: 1 }, radiusX: 3, radiusY: 2 },
  { kind: 'polygon', vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 1, y: 3 }] },
  {
    kind: 'revision-cloud',
    vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
    arcLength: 1,
  },
];

describe('public normalized markup authoring lifecycle', () => {
  it('samples real pointer drawings for every closed shape and open ink', async () => {
    const leader = new ViewLeader({
      boundary: boundary(),
      adapters: adapters({
        surfacePicking: {
          pickSurface: ({ pointer: sample }) => Promise.resolve({
            point: { x: sample.x * 10, y: sample.y * 10, z: 0 },
            normal: { x: 0, y: 0, z: 1 },
            modelId: 'sampled-model',
          }),
        },
      }),
    });

    for (const kind of ['rectangle', 'ellipse', 'polygon', 'revision-cloud'] as const) {
      const result = leader.authoring.markup.start({
        kind,
        draft: { id: `pointer-${kind}`, content: { kind: 'plain-note', text: kind } },
      });
      const revision = leader.documents.getSnapshot().documentRevision;
      await leader.authoring.markup.pointerDown(pointerAt(0.1, 0.1));
      await leader.authoring.markup.pointerMove(pointerAt(0.5, 0.1));
      if (kind === 'polygon' || kind === 'revision-cloud') {
        await leader.authoring.markup.pointerMove(pointerAt(0.5, 0.4));
      }
      await leader.authoring.markup.pointerUp(pointerAt(
        kind === 'polygon' || kind === 'revision-cloud' ? 0.1 : 0.5,
        0.4,
      ));
      const snapshot = leader.authoring.markup.getSnapshot();
      expect(snapshot).toMatchObject({
        phase: 'ready',
        preview: { kind, plane: { origin: { x: 1, y: 1, z: 0 } } },
      });
      expect(snapshot.preview?.pointerPoints.length).toBeGreaterThanOrEqual(
        kind === 'polygon' || kind === 'revision-cloud' ? 4 : 3,
      );
      expect(leader.documents.getSnapshot().documentRevision).toBe(revision);
      expect(leader.authoring.markup.complete()).toMatchObject({ status: 'completed' });
      await expect(result).resolves.toMatchObject({ status: 'completed' });
      expect(leader.annotations.get(`pointer-${kind}`)?.anchors[0]?.anchor).toMatchObject({
        kind: 'region', modelId: 'sampled-model', shape: kind,
      });
      expect(leader.documents.getSnapshot().documentRevision).toBe(revision + 1);
    }

    const inkResult = leader.authoring.markup.start({ kind: 'ink', commit: { id: 'pointer-ink' } });
    const revision = leader.documents.getSnapshot().documentRevision;
    await leader.authoring.markup.pointerDown(pointerAt(0.2, 0.2));
    await leader.authoring.markup.pointerMove(pointerAt(0.3, 0.4));
    await leader.authoring.markup.pointerMove(pointerAt(0.5, 0.3));
    await leader.authoring.markup.pointerUp(pointerAt(0.7, 0.5));
    expect(leader.authoring.markup.getSnapshot()).toMatchObject({
      phase: 'ready', preview: { kind: 'ink' },
    });
    expect(leader.documents.getSnapshot().documentRevision).toBe(revision);
    leader.authoring.markup.complete();
    await inkResult;
    expect(leader.authoring.markup.getInk('pointer-ink')?.points.length).toBeGreaterThanOrEqual(2);
    expect(leader.documents.getSnapshot().documentRevision).toBe(revision + 1);
    leader.dispose();
  });

  it('aborts and ignores stale pointer samples before finalizing the current geometry', async () => {
    const stale = deferred<SurfacePickResult | null>();
    const current = deferred<SurfacePickResult | null>();
    const signals: AbortSignal[] = [];
    let call = 0;
    const leader = new ViewLeader({
      boundary: boundary(),
      adapters: adapters({
        surfacePicking: {
          pickSurface: (_request, signal) => {
            signals.push(signal);
            call += 1;
            if (call === 1) return Promise.resolve({ point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } });
            if (call === 2) return stale.promise;
            if (call === 3) return current.promise;
            return Promise.resolve({ point: { x: 4, y: 3, z: 0 }, normal: { x: 0, y: 0, z: 1 } });
          },
        },
      }),
    });
    const result = leader.authoring.markup.start({
      kind: 'rectangle',
      draft: { id: 'latest-rectangle', content: { kind: 'plain-note', text: 'Latest' } },
    });
    await leader.authoring.markup.pointerDown(pointerAt(0, 0));
    const staleMove = leader.authoring.markup.pointerMove(pointerAt(0.2, 0.2));
    const currentMove = leader.authoring.markup.pointerMove(pointerAt(0.4, 0.3));
    expect(signals[1]?.aborted).toBe(true);
    stale.resolve({ point: { x: 99, y: 99, z: 0 }, normal: { x: 0, y: 0, z: 1 } });
    current.resolve({ point: { x: 4, y: 3, z: 0 }, normal: { x: 0, y: 0, z: 1 } });
    await Promise.all([staleMove, currentMove]);
    await leader.authoring.markup.pointerUp(pointerAt(0.4, 0.3));
    expect(leader.authoring.markup.getSnapshot()).toMatchObject({
      phase: 'ready',
      preview: {
        geometry: { kind: 'rectangle', center: { x: 2, y: 1.5 }, width: 4, height: 3 },
      },
    });
    leader.authoring.markup.complete();
    await result;
    leader.dispose();
  });

  it('replays a quick pointer release that arrives before the first accurate pick', async () => {
    const initial = deferred<SurfacePickResult | null>();
    const signals: AbortSignal[] = [];
    let call = 0;
    const leader = new ViewLeader({
      boundary: boundary(),
      adapters: adapters({
        surfacePicking: {
          pickSurface: ({ pointer: sample }, signal) => {
            signals.push(signal);
            call += 1;
            if (call === 1) return initial.promise;
            return Promise.resolve({
              point: { x: sample.x * 10, y: sample.y * 10, z: 0 },
              normal: { x: 0, y: 0, z: 1 },
            });
          },
        },
      }),
    });
    const result = leader.authoring.markup.start({
      kind: 'ellipse',
      draft: { id: 'quick-ellipse', content: { kind: 'plain-note', text: 'Quick' } },
    });
    const down = leader.authoring.markup.pointerDown(pointerAt(0.1, 0.1));
    const up = leader.authoring.markup.pointerUp(pointerAt(0.5, 0.4));
    await up;
    expect(signals[0]?.aborted).toBe(true);
    expect(leader.authoring.markup.getSnapshot()).toMatchObject({
      phase: 'ready',
      preview: { geometry: { kind: 'ellipse', center: { x: 2, y: 1.5 }, radiusX: 2, radiusY: 1.5 } },
    });
    initial.resolve({ point: { x: 99, y: 99, z: 0 }, normal: { x: 0, y: 0, z: 1 } });
    await down;
    leader.authoring.markup.complete();
    await result;
    leader.dispose();
  });

  it('cancels a pending built-in pick on pointer exit and releases its lease', async () => {
    const picked = deferred<null>();
    const release = vi.fn();
    let signal: AbortSignal | undefined;
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({
        picking: {
          pick: (_request, nextSignal) => {
            signal = nextSignal;
            return picked.promise;
          },
        },
        interaction: { acquire: () => ({ release }) },
      }),
    });
    const outcome = leader.authoring.start({
      draft: { id: 'cancelled-note', content: { kind: 'plain-note', text: 'cancel' } },
    });
    const pending = leader.authoring.pointerDown(pointer);
    expect(leader.authoring.getSnapshot()).toMatchObject({ phase: 'pending-pick' });

    root.dispatchEvent(new Event('pointerleave'));
    await expect(outcome).resolves.toEqual({ status: 'cancelled', reason: 'pointer-exit' });
    expect(signal?.aborted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(leader.documents.getSnapshot()).toMatchObject({ documentRevision: 0 });
    expect(leader.history.getSnapshot()).toMatchObject({ undoCount: 0 });

    picked.resolve(null);
    await pending;
    leader.dispose();
  });

  it('uses one direct-input lifecycle and one atomic completion for every closed shape and ink', async () => {
    const release = vi.fn();
    const leader = new ViewLeader({
      boundary: boundary(),
      adapters: adapters({ interaction: { acquire: () => ({ release }) } }),
    });

    for (const geometry of geometries) {
      const before = leader.documents.serialize();
      const revision = leader.documents.getSnapshot().documentRevision;
      const history = leader.history.getSnapshot().undoCount;
      const result = leader.authoring.markup.start({
        kind: geometry.kind,
        draft: {
          id: `shape-${geometry.kind}`,
          content: { kind: 'plain-note', text: geometry.kind },
        },
        plane,
      });
      const preview = leader.authoring.markup.setRegionGeometry(geometry);
      expect(preview).toMatchObject({
        phase: 'ready',
        preview: { kind: geometry.kind, geometry },
      });
      expect(leader.documents.serialize()).toBe(before);
      expect(leader.authoring.markup.complete()).toMatchObject({ status: 'completed' });
      await expect(result).resolves.toMatchObject({ status: 'completed' });
      expect(leader.documents.getSnapshot().documentRevision).toBe(revision + 1);
      expect(leader.history.getSnapshot().undoCount).toBe(history + 1);
    }

    const inkResult = leader.authoring.markup.start({
      kind: 'ink',
      commit: { id: 'managed-ink' },
    });
    leader.authoring.markup.establishPlane(plane);
    leader.authoring.markup.appendInkPoint({ x: 0, y: 0 });
    const inkPreview = leader.authoring.markup.appendInkPoint({ x: 2, y: 1 });
    expect(inkPreview).toMatchObject({
      phase: 'ready',
      preview: { kind: 'ink', inkPoints: [{ x: 0, y: 0 }, { x: 2, y: 1 }] },
    });
    const revision = leader.documents.getSnapshot().documentRevision;
    const history = leader.history.getSnapshot().undoCount;
    expect(leader.authoring.markup.complete()).toMatchObject({
      status: 'completed',
      value: { kind: 'ink', id: 'managed-ink' },
    });
    await expect(inkResult).resolves.toMatchObject({ status: 'completed' });
    expect(leader.documents.getSnapshot().documentRevision).toBe(revision + 1);
    expect(leader.history.getSnapshot().undoCount).toBe(history + 1);
    expect(release).toHaveBeenCalledTimes(geometries.length + 1);
    leader.dispose();
  });

  it('is already idle when the completed document revision becomes observable', async () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    const durablePhases: string[] = [];
    const unsubscribe = leader.documents.subscribe(() => {
      if (leader.documents.getSnapshot().documentRevision > 0) {
        durablePhases.push(leader.authoring.markup.getSnapshot().phase);
      }
    });
    const result = leader.authoring.markup.start({
      kind: 'rectangle',
      draft: { id: 'coherent', content: { kind: 'plain-note', text: 'Coherent' } },
      plane,
    });
    leader.authoring.markup.setRegionGeometry(geometries[0]!);
    leader.authoring.markup.complete();
    await result;
    expect(durablePhases).toEqual(['idle']);
    unsubscribe();
    leader.dispose();
  });

  it('settles invalid completion as a typed failure with no partial revision or history', async () => {
    const release = vi.fn();
    const leader = new ViewLeader({
      boundary: boundary(),
      adapters: adapters({ interaction: { acquire: () => ({ release }) } }),
    });
    const result = leader.authoring.markup.start({
      kind: 'ellipse',
      draft: { id: 'invalid-ellipse', content: { kind: 'plain-note', text: 'Invalid' } },
      plane,
    });
    expect(leader.authoring.markup.complete()).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_INPUT' },
    });
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_INPUT' },
    });
    expect(leader.authoring.markup.getSnapshot().phase).toBe('idle');
    expect(leader.documents.getSnapshot().documentRevision).toBe(0);
    expect(leader.history.getSnapshot().undoCount).toBe(0);
    expect(release).toHaveBeenCalledOnce();
    leader.dispose();
  });

  it('derives a drawing plane from one accurate async surface hit and cancels without history', async () => {
    const pick = deferred<SurfacePickResult | null>();
    const release = vi.fn();
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({
        surfacePicking: { pickSurface: () => pick.promise },
        interaction: { acquire: () => ({ release }) },
      }),
    });
    const result = leader.authoring.markup.start({
      kind: 'rectangle',
      draft: { id: 'picked-region', content: { kind: 'plain-note', text: 'Picked' } },
    });
    const pending = leader.authoring.markup.pointerDown(pointer);
    expect(leader.authoring.markup.getSnapshot()).toMatchObject({ phase: 'pending-pick' });
    pick.resolve({
      point: { x: 4, y: 5, z: 6 },
      normal: { x: 0, y: 0, z: 1 },
      modelId: 'model-a',
    });
    await pending;
    expect(leader.authoring.markup.getSnapshot()).toMatchObject({
      phase: 'drawing',
      preview: { plane: { origin: { x: 4, y: 5, z: 6 } } },
    });
    leader.authoring.markup.setRegionGeometry(geometries[0]!);
    leader.authoring.markup.complete();
    await result;
    expect(leader.annotations.get('picked-region')?.anchors[0]?.anchor).toMatchObject({
      kind: 'region', modelId: 'model-a', plane: { origin: { x: 4, y: 5, z: 6 } },
    });
    expect(release).toHaveBeenCalledOnce();

    const cancelled = leader.authoring.markup.start({
      kind: 'ellipse',
      draft: { id: 'cancelled-region', content: { kind: 'plain-note', text: 'No commit' } },
      plane,
    });
    const revision = leader.documents.getSnapshot().documentRevision;
    const history = leader.history.getSnapshot().undoCount;
    root.dispatchEvent(new Event('pointerleave'));
    await expect(cancelled).resolves.toEqual({ status: 'cancelled', reason: 'pointer-exit' });
    expect(leader.documents.getSnapshot().documentRevision).toBe(revision);
    expect(leader.history.getSnapshot().undoCount).toBe(history);
    expect(release).toHaveBeenCalledTimes(2);
    leader.dispose();
  });

  it('coordinates one active built-in, markup, or plugin tool and treats Escape as cancellation', async () => {
    const release = vi.fn();
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({ interaction: { acquire: () => ({ release }) } }),
      plugins: [markdownPlugin],
    });
    const builtIn = leader.authoring.start({
      draft: { id: 'preempted-note', content: { kind: 'plain-note', text: 'Note' } },
    });
    const markup = leader.authoring.markup.start({
      kind: 'rectangle',
      draft: { id: 'preempted-markup', content: { kind: 'plain-note', text: 'Markup' } },
      plane,
    });
    await expect(builtIn).resolves.toEqual({ status: 'cancelled', reason: 'preempted' });
    expect(leader.authoring.getSnapshot().phase).toBe('idle');

    leader.authoring.plugins.start({
      pluginId: 'viewleader.markdown',
      toolId: 'author',
      draft: {
        id: 'plugin',
        anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      },
    });
    await expect(markup).resolves.toEqual({ status: 'cancelled', reason: 'preempted' });
    expect(leader.authoring.markup.getSnapshot().phase).toBe('idle');

    const escaped = leader.authoring.markup.start({
      kind: 'ink',
      commit: { id: 'escaped-ink' },
      plane,
    });
    expect(leader.authoring.plugins.getSnapshot().phase).toBe('idle');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(escaped).resolves.toEqual({ status: 'cancelled', reason: 'escape' });
    expect(leader.documents.getSnapshot().documentRevision).toBe(0);
    expect(leader.history.getSnapshot().undoCount).toBe(0);
    expect(release).toHaveBeenCalledTimes(4);
    leader.dispose();
  });

  it('aborts pending surface work and releases the lease during disposal', async () => {
    const picked = deferred<SurfacePickResult | null>();
    const release = vi.fn();
    let signal: AbortSignal | undefined;
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({
        surfacePicking: {
          pickSurface: (_request, nextSignal) => {
            signal = nextSignal;
            return picked.promise;
          },
        },
        interaction: { acquire: () => ({ release }) },
      }),
    });
    const result = leader.authoring.markup.start({
      kind: 'polygon',
      draft: { id: 'disposed-polygon', content: { kind: 'plain-note', text: 'Disposed' } },
    });
    const pending = leader.authoring.markup.pointerDown(pointer);
    leader.dispose();
    await expect(result).resolves.toEqual({ status: 'cancelled', reason: 'disposed' });
    expect(signal?.aborted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(root.querySelector('[data-viewleader-overlay]')).toBeNull();

    picked.resolve(null);
    await expect(pending).resolves.toBeUndefined();
  });

  it('renders a Markdown tool preview through the core-owned declarative SVG path', () => {
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters(),
      plugins: [markdownPlugin],
    });
    leader.authoring.plugins.start({
      pluginId: 'viewleader.markdown',
      toolId: 'author',
      draft: {
        id: 'markdown-preview',
        anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      },
    });
    const snapshot = leader.authoring.plugins.dispatch({
      kind: 'programmatic',
      action: 'set-source',
      data: { source: '**Preview** and `code`' },
    });
    expect(snapshot.preview).not.toHaveLength(0);
    leader.update();
    const preview = root.querySelector('[data-viewleader-plugin-preview]');
    expect(preview?.textContent).toContain('Preview');
    expect(preview?.querySelector('[font-weight="bold"]')).not.toBeNull();
    expect(preview?.querySelector('[font-family="monospace"]')).not.toBeNull();
    expect(leader.documents.getSnapshot()).toMatchObject({ documentRevision: 0 });
    leader.authoring.plugins.cancel();
    leader.update();
    expect(root.querySelector('[data-viewleader-plugin-preview]')).toBeNull();
    leader.dispose();
  });
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}
