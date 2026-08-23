import { describe, expect, it, vi } from 'vitest';

interface Lifecycle<Instance> {
  readonly current: Instance | null;
  update(options: { readonly boundary: Element | null }): Instance | null;
  dispose(): void;
}

interface Subscription<Snapshot> {
  update(
    capability: Capability<Snapshot> | null,
    listener: (snapshot: Snapshot | null) => void,
  ): void;
  dispose(): void;
}

interface Capability<Snapshot> {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
}

interface RuntimeSnapshot {
  readonly runtimeRevision: number;
  readonly documentRevision: number;
  readonly selectedIds: readonly string[];
  readonly authoring: 'idle' | 'active';
}

interface ResourceCounts {
  overlays: number;
  loops: number;
  subscriptions: number;
  listeners: number;
  tools: number;
}

interface FakeInstance {
  readonly runtime: Capability<RuntimeSnapshot>;
  readonly annotations: {
    select(ids: readonly string[]): void;
    toggle(id: string): void;
    deselect(id: string): void;
    clearSelection(): void;
  };
  readonly authoring: {
    start(): Promise<{ readonly status: 'cancelled'; readonly reason: string }>;
    cancel(reason?: string): void;
  };
  dispose(): void;
}

export interface FrameworkHarnessAdapters {
  createLifecycle(
    factory: (options: { readonly boundary: Element }) => FakeInstance,
  ): Lifecycle<FakeInstance>;
  createSubscription<Snapshot>(): Subscription<Snapshot>;
}

/** The exact same observable suite is instantiated by React and Vue tests. */
export function runFrameworkConformance(
  framework: 'React' | 'Vue',
  adapters: FrameworkHarnessAdapters,
): void {
  describe(`${framework} shared framework conformance`, () => {
    it('constructs only for a real boundary and preserves immutable identity', () => {
      const resources = emptyResources();
      const factory = vi.fn(() => createFakeInstance(resources));
      const lifecycle = adapters.createLifecycle(factory);
      const firstBoundary = {} as Element;
      const replacementBoundary = {} as Element;

      expect(lifecycle.update({ boundary: null })).toBeNull();
      const first = lifecycle.update({ boundary: firstBoundary });
      expect(first).not.toBeNull();
      expect(lifecycle.update({ boundary: firstBoundary })).toBe(first);
      expect(factory).toHaveBeenCalledOnce();
      expect(resources).toEqual(liveResources());

      const replacement = lifecycle.update({ boundary: replacementBoundary });
      expect(replacement).not.toBe(first);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(resources).toEqual(liveResources());
      lifecycle.dispose();
      lifecycle.dispose();
      expect(resources).toEqual(emptyResources());
    });

    it('publishes revision-consistent immutable snapshots with fresh handlers', () => {
      const resources = emptyResources();
      const instance = createFakeInstance(resources);
      const subscription = adapters.createSubscription<RuntimeSnapshot>();
      const first = vi.fn();
      const latest = vi.fn();
      subscription.update(instance.runtime, first);
      subscription.update(instance.runtime, latest);

      instance.annotations.select(['a', 'b']);
      expect(first).toHaveBeenCalledOnce();
      expect(latest).toHaveBeenLastCalledWith({
        runtimeRevision: 1,
        documentRevision: 0,
        selectedIds: ['a', 'b'],
        authoring: 'idle',
      });
      const snapshot = instance.runtime.getSnapshot();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.selectedIds)).toBe(true);
      expect(resources.subscriptions).toBe(1);
      subscription.dispose();
      expect(resources.subscriptions).toBe(0);
      instance.dispose();
    });

    it('forwards selection without history and returns normal authoring cancellation', async () => {
      const resources = emptyResources();
      const instance = createFakeInstance(resources);
      instance.annotations.select(['a']);
      instance.annotations.toggle('b');
      instance.annotations.deselect('a');
      expect(instance.runtime.getSnapshot()).toMatchObject({
        documentRevision: 0,
        selectedIds: ['b'],
      });
      instance.annotations.clearSelection();
      expect(instance.runtime.getSnapshot().selectedIds).toEqual([]);

      const pending = instance.authoring.start();
      expect(resources.tools).toBe(1);
      instance.authoring.cancel('escape');
      await expect(pending).resolves.toEqual({
        status: 'cancelled',
        reason: 'escape',
      });
      expect(resources.tools).toBe(0);
      instance.dispose();
    });

    it('cancels pending work and rejects late publication on teardown', async () => {
      const resources = emptyResources();
      const instance = createFakeInstance(resources);
      const published = vi.fn();
      const unsubscribe = instance.runtime.subscribe(published);
      const pending = instance.authoring.start();
      instance.dispose();
      unsubscribe();

      await expect(pending).resolves.toEqual({
        status: 'cancelled',
        reason: 'disposed',
      });
      expect(published).toHaveBeenCalledOnce();
      expect(resources).toEqual(emptyResources());
    });

    it('survives repeated development lifecycle cycles without duplicates', () => {
      const resources = emptyResources();
      for (let cycle = 0; cycle < 25; cycle += 1) {
        const lifecycle = adapters.createLifecycle(() =>
          createFakeInstance(resources),
        );
        const boundary = {} as Element;
        lifecycle.update({ boundary });
        lifecycle.update({ boundary });
        expect(resources).toEqual(liveResources());
        lifecycle.dispose();
        expect(resources).toEqual(emptyResources());
      }
    });
  });
}

function createFakeInstance(resources: ResourceCounts): FakeInstance {
  resources.overlays += 1;
  resources.loops += 1;
  resources.listeners += 1;
  let disposed = false;
  let runtimeRevision = 0;
  let selectedIds: readonly string[] = [];
  let authoring: RuntimeSnapshot['authoring'] = 'idle';
  let pending:
    | {
        resolve(value: { status: 'cancelled'; reason: string }): void;
      }
    | undefined;
  const listeners = new Set<() => void>();
  const snapshot = (): RuntimeSnapshot =>
    Object.freeze({
      runtimeRevision,
      documentRevision: 0,
      selectedIds: Object.freeze([...selectedIds]),
      authoring,
    });
  const publish = () => {
    runtimeRevision += 1;
    for (const listener of [...listeners]) listener();
  };
  const cancel = (reason: string) => {
    if (pending === undefined) return;
    const current = pending;
    pending = undefined;
    authoring = 'idle';
    resources.tools -= 1;
    publish();
    current.resolve({ status: 'cancelled', reason });
  };
  return {
    runtime: {
      getSnapshot: snapshot,
      subscribe(listener) {
        listeners.add(listener);
        resources.subscriptions += 1;
        let live = true;
        return () => {
          if (!live) return;
          live = false;
          if (listeners.delete(listener)) resources.subscriptions -= 1;
        };
      },
    },
    annotations: {
      select(ids) {
        selectedIds = [...new Set(ids)];
        publish();
      },
      toggle(id) {
        selectedIds = selectedIds.includes(id)
          ? selectedIds.filter((candidate) => candidate !== id)
          : [...selectedIds, id];
        publish();
      },
      deselect(id) {
        selectedIds = selectedIds.filter((candidate) => candidate !== id);
        publish();
      },
      clearSelection() {
        selectedIds = [];
        publish();
      },
    },
    authoring: {
      start() {
        cancel('preempted');
        authoring = 'active';
        resources.tools += 1;
        publish();
        return new Promise((resolve) => {
          pending = { resolve };
        });
      },
      cancel(reason = 'cancelled') {
        cancel(reason);
      },
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resources.subscriptions -= listeners.size;
      listeners.clear();
      cancel('disposed');
      resources.overlays -= 1;
      resources.loops -= 1;
      resources.listeners -= 1;
    },
  };
}

function emptyResources(): ResourceCounts {
  return { overlays: 0, loops: 0, subscriptions: 0, listeners: 0, tools: 0 };
}

function liveResources(): ResourceCounts {
  return { overlays: 1, loops: 1, subscriptions: 0, listeners: 1, tools: 0 };
}
