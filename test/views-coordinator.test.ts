import { describe, expect, it, vi } from 'vitest';
import {
  SavedViewCoordinator,
  SavedViewError,
  type AnnotationViewAdapter,
  type LinearTourDefinition,
  type MutableSavedViewDocument,
  type NeutralViewerState,
  type SavedViewAnnotationOverrides,
  type SavedViewDefinition,
  type SavedViewDocumentPort,
  type SavedViewDocumentSnapshot,
  type ViewerStateAdapter,
} from '../src/saved-views/index.js';

function viewerState(seed = 0): NeutralViewerState {
  return {
    camera: {
      projection: 'perspective',
      position: { x: seed, y: 2, z: 3 },
      direction: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      verticalFieldOfView: 50,
      near: 0.1,
      far: 1_000,
    },
    modelVisibility: [
      { modelId: 'z-model', visible: false },
      { modelId: 'a-model', visible: true },
    ],
    elementVisibility: [
      { modelId: 'z-model', elementId: 'b', visible: false },
      { modelId: 'a-model', elementId: 'a', visible: true },
    ],
    selection: [{ modelId: 'a-model', elementId: 'selected' }],
    colorOverrides: [
      {
        id: 'warning',
        modelId: 'a-model',
        elementIds: ['z', 'a'],
        color: { red: 1, green: 0.25, blue: 0, alpha: 0.8 },
      },
    ],
    clippingPlanes: [
      {
        id: 'section',
        normal: { x: 1, y: 0, z: 0 },
        constant: -seed,
        enabled: true,
      },
    ],
  };
}

function definition(
  id: string,
  seed = 0,
  annotationOverrides: SavedViewAnnotationOverrides = {},
): SavedViewDefinition {
  return {
    id,
    name: `View ${id}`,
    viewerState: viewerState(seed),
    annotationOverrides,
  };
}

class TestDocument implements SavedViewDocumentPort {
  #snapshot: SavedViewDocumentSnapshot = {
    documentRevision: 0,
    savedViews: [],
    tours: [],
  };
  readonly labels: string[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #undo: MutableSavedViewDocument[] = [];
  readonly #redo: MutableSavedViewDocument[] = [];

  public getSnapshot(): SavedViewDocumentSnapshot {
    return structuredClone(this.#snapshot);
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public transact<Result>(
    label: string,
    operation: (draft: MutableSavedViewDocument) => Result,
  ): Result {
    const before = this.value();
    const draft = this.value();
    const result = operation(draft);
    this.#undo.push(before);
    this.#redo.length = 0;
    this.labels.push(label);
    this.commit(draft);
    return result;
  }

  public undo(): void {
    const previous = this.#undo.pop();
    if (previous === undefined) return;
    this.#redo.push(this.value());
    this.commit(previous);
  }

  public redo(): void {
    const next = this.#redo.pop();
    if (next === undefined) return;
    this.#undo.push(this.value());
    this.commit(next);
  }

  private value(): MutableSavedViewDocument {
    return {
      savedViews: structuredClone(this.#snapshot.savedViews) as SavedViewDefinition[],
      tours: structuredClone(this.#snapshot.tours) as LinearTourDefinition[],
    };
  }

  private commit(value: MutableSavedViewDocument): void {
    this.#snapshot = {
      documentRevision: this.#snapshot.documentRevision + 1,
      savedViews: structuredClone(value.savedViews),
      tours: structuredClone(value.tours),
    };
    for (const listener of [...this.#listeners]) listener();
  }
}

interface PreparedState {
  readonly prior: NeutralViewerState;
  readonly next: NeutralViewerState;
}

class TestViewer implements ViewerStateAdapter<PreparedState> {
  public state = viewerState(-1);
  public captureState = viewerState(1);
  public prepareFailure: unknown;
  public applyFailure: unknown;
  public rollbackFailure: unknown;
  public releaseFailure: unknown;
  public pendingPrepare: Promise<void> | undefined;
  public pendingApply: Promise<void> | undefined;
  readonly events: string[] = [];
  readonly released: PreparedState[] = [];

  public capture(): NeutralViewerState {
    this.events.push('host:capture');
    return structuredClone(this.captureState);
  }

  public async prepare(state: NeutralViewerState): Promise<PreparedState> {
    this.events.push('host:prepare');
    if (this.pendingPrepare !== undefined) await this.pendingPrepare;
    if (this.prepareFailure !== undefined) throw this.prepareFailure;
    return { prior: structuredClone(this.state), next: structuredClone(state) };
  }

  public async apply(prepared: PreparedState): Promise<void> {
    this.events.push('host:apply');
    this.state = structuredClone(prepared.next);
    if (this.pendingApply !== undefined) await this.pendingApply;
    if (this.applyFailure !== undefined) throw this.applyFailure;
  }

  public rollback(prepared: PreparedState): void {
    this.events.push('host:rollback');
    if (this.rollbackFailure !== undefined) throw this.rollbackFailure;
    this.state = structuredClone(prepared.prior);
  }

  public release(prepared: PreparedState): void {
    this.released.push(prepared);
    if (this.releaseFailure !== undefined) throw this.releaseFailure;
  }
}

class TestAnnotations implements AnnotationViewAdapter<SavedViewAnnotationOverrides> {
  public state: SavedViewAnnotationOverrides = {};
  public applyFailure: unknown;
  public rollbackFailure: unknown;
  readonly events: string[] = [];

  public capture(): SavedViewAnnotationOverrides {
    this.events.push('annotations:capture');
    return structuredClone(this.state);
  }

  public apply(
    _viewId: string,
    overrides: SavedViewAnnotationOverrides,
  ): void {
    this.events.push('annotations:apply');
    this.state = structuredClone(overrides);
    if (this.applyFailure !== undefined) throw this.applyFailure;
  }

  public rollback(snapshot: SavedViewAnnotationOverrides): void {
    this.events.push('annotations:rollback');
    if (this.rollbackFailure !== undefined) throw this.rollbackFailure;
    this.state = structuredClone(snapshot);
  }
}

function harness(scheduler?: { delay(milliseconds: number, signal: AbortSignal): Promise<void> }) {
  const document = new TestDocument();
  const viewer = new TestViewer();
  const annotations = new TestAnnotations();
  const diagnostics = vi.fn();
  const coordinator = new SavedViewCoordinator({
    document,
    viewerState: viewer,
    annotationViews: annotations,
    diagnostic: diagnostics,
    scheduler: scheduler ?? { delay: async (_milliseconds, signal) => {
      if (signal.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
    } },
  });
  return { document, viewer, annotations, diagnostics, coordinator };
}

describe('SavedViewCoordinator definitions', () => {
  it('captures the complete neutral state in one immutable undoable transaction', async () => {
    const test = harness();
    const saved = await test.coordinator.save({
      id: 'coordination',
      name: 'Coordination',
      annotationOverrides: {
        'note-b': { visible: false },
        'note-a': {
          placement: { mode: 'manual', position: { x: 10, y: 20 } },
          style: { lineColor: '#ff0000' },
        },
      },
    });

    expect(test.document.labels).toEqual(['Save view coordination']);
    expect(saved.viewerState.modelVisibility.map(({ modelId }) => modelId)).toEqual([
      'a-model',
      'z-model',
    ]);
    expect(saved.viewerState.colorOverrides[0]?.elementIds).toEqual(['a', 'z']);
    expect(Object.keys(saved.annotationOverrides)).toEqual(['note-a', 'note-b']);
    expect(Object.isFrozen(test.coordinator.getSnapshot())).toBe(true);
    expect(() => {
      (saved as { name: string }).name = 'mutated';
    }).toThrow();

    const revisionAfterSave = test.coordinator.getSnapshot().documentRevision;
    test.document.undo();
    expect(test.coordinator.list()).toEqual([]);
    test.document.redo();
    expect(test.coordinator.get('coordination')?.name).toBe('Coordination');
    expect(test.coordinator.getSnapshot().documentRevision).toBeGreaterThan(
      revisionAfterSave,
    );
  });

  it('validates explicit definitions before the document callback runs', () => {
    const test = harness();
    const malformed = definition('invalid');
    (malformed.viewerState.camera as { near: number }).near = Number.NaN;

    expect(() => test.coordinator.insert(malformed)).toThrowError(
      expect.objectContaining({ code: 'saved_view/invalid_definition' }),
    );
    expect(test.document.labels).toEqual([]);
    expect(test.coordinator.list()).toEqual([]);
  });

  it('rejects duplicate stable identities and non-JSON annotation styles', () => {
    const duplicates = definition('duplicates');
    (duplicates.viewerState.modelVisibility as NeutralViewerState['modelVisibility'] &
      Array<NeutralViewerState['modelVisibility'][number]>).push({
      modelId: 'a-model',
      visible: false,
    });
    // Typed authoring cannot express this; a hand-edited document still can.
    const badStyle = definition('bad-style', 0, {
      note: { style: { callback: () => undefined } as never },
    });

    expect(() => harness().coordinator.insert(duplicates)).toThrow(
      'duplicate identity',
    );
    expect(() => harness().coordinator.insert(badStyle)).toThrow(
      'only JSON values',
    );
  });

  it('updates and removes unreferenced definitions symmetrically', async () => {
    const test = harness();
    test.coordinator.insert(definition('a'));
    test.viewer.captureState = viewerState(9);

    const updated = await test.coordinator.update('a', { name: 'Updated' });
    const removed = await test.coordinator.remove('a');

    expect(updated.name).toBe('Updated');
    expect(updated.viewerState.camera.position.x).toBe(9);
    expect(removed.id).toBe('a');
    expect(test.document.labels).toEqual([
      'Save view a',
      'Update view a',
      'Remove view a',
    ]);
    test.document.undo();
    expect(test.coordinator.get('a')?.name).toBe('Updated');
    test.document.redo();
    expect(test.coordinator.get('a')).toBeUndefined();
  });
});

describe('SavedViewCoordinator activation', () => {
  it('applies the host first and publishes active state only after annotations succeed', async () => {
    const test = harness();
    test.coordinator.insert(
      definition('a', 4, { note: { visible: false } }),
    );
    const observed: Array<string | null> = [];
    test.coordinator.subscribe(() => {
      observed.push(test.coordinator.getSnapshot().activeViewId);
    });
    const documentRevision = test.coordinator.getSnapshot().documentRevision;

    await expect(test.coordinator.activate('a')).resolves.toEqual({
      status: 'activated',
      viewId: 'a',
    });

    expect(test.viewer.events).toEqual(['host:prepare', 'host:apply']);
    expect(test.annotations.events).toEqual([
      'annotations:capture',
      'annotations:apply',
    ]);
    expect(observed.slice(0, -1)).not.toContain('a');
    expect(observed.at(-1)).toBe('a');
    expect(test.annotations.state).toEqual({ note: { visible: false } });
    expect(test.coordinator.getSnapshot().documentRevision).toBe(documentRevision);
  });

  it('changes nothing on preparation failure', async () => {
    const test = harness();
    test.coordinator.insert(definition('a', 3));
    const priorHost = structuredClone(test.viewer.state);
    test.viewer.prepareFailure = new Error('missing model');

    await expect(test.coordinator.activate('a')).rejects.toMatchObject({
      code: 'saved_view/activation_failed',
    });
    expect(test.viewer.state).toEqual(priorHost);
    expect(test.annotations.events).toEqual([]);
    expect(test.coordinator.getSnapshot().activeViewId).toBeNull();
  });

  it('rolls back host and annotation state after apply or internal failure', async () => {
    const hostFailure = harness();
    hostFailure.coordinator.insert(definition('a', 3));
    const priorHost = structuredClone(hostFailure.viewer.state);
    hostFailure.viewer.applyFailure = new Error('host failed after mutation');
    await expect(hostFailure.coordinator.activate('a')).rejects.toMatchObject({
      code: 'saved_view/activation_failed',
    });
    expect(hostFailure.viewer.events).toEqual([
      'host:prepare',
      'host:apply',
      'host:rollback',
    ]);
    expect(hostFailure.viewer.state).toEqual(priorHost);

    const internalFailure = harness();
    internalFailure.coordinator.insert(
      definition('a', 3, { note: { visible: false } }),
    );
    internalFailure.annotations.state = { old: { visible: true } };
    internalFailure.annotations.applyFailure = new Error('internal apply failed');
    await expect(internalFailure.coordinator.activate('a')).rejects.toMatchObject({
      code: 'saved_view/activation_failed',
    });
    expect(internalFailure.annotations.state).toEqual({ old: { visible: true } });
    expect(internalFailure.viewer.events.at(-1)).toBe('host:rollback');
    expect(internalFailure.coordinator.getSnapshot().activeViewId).toBeNull();
  });

  it('faults permanently and emits a fatal diagnostic when rollback fails', async () => {
    const test = harness();
    test.coordinator.insert(definition('a'));
    test.viewer.applyFailure = new Error('apply failed');
    test.viewer.rollbackFailure = new Error('rollback failed');

    await expect(test.coordinator.activate('a')).rejects.toMatchObject({
      code: 'saved_view/rollback_failed',
    });
    expect(test.coordinator.getSnapshot().consistent).toBe(false);
    expect(test.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'fatal',
        code: 'saved_view/rollback_failed',
      }),
    );
    await expect(test.coordinator.activate('a')).rejects.toMatchObject({
      code: 'saved_view/coordinator_faulted',
    });
  });

  it('cancels a pending activation without stale publication', async () => {
    const test = harness();
    test.coordinator.insert(definition('a', 12));
    let release!: () => void;
    test.viewer.pendingApply = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activation = test.coordinator.activate('a');
    await vi.waitFor(() => expect(test.viewer.events).toContain('host:apply'));
    test.coordinator.cancelActivation('boundary-replaced');
    release();

    await expect(activation).resolves.toEqual({
      status: 'cancelled',
      viewId: 'a',
      reason: 'boundary-replaced',
    });
    expect(test.viewer.events.at(-1)).toBe('host:rollback');
    expect(test.coordinator.getSnapshot().activeViewId).toBeNull();
  });

  it('preserves cancellation and diagnoses an aggregated prepared-state release failure', async () => {
    const test = harness();
    test.coordinator.insert(definition('a', 12));
    let finishPrepare!: () => void;
    test.viewer.pendingPrepare = new Promise<void>((resolve) => {
      finishPrepare = resolve;
    });
    const releaseFailure = new Error('release failed');
    test.viewer.releaseFailure = releaseFailure;
    const activation = test.coordinator.activate('a');
    await vi.waitFor(() => expect(test.viewer.events).toContain('host:prepare'));
    test.coordinator.cancelActivation('boundary-replaced');
    finishPrepare();

    await expect(activation).resolves.toEqual({
      status: 'cancelled',
      viewId: 'a',
      reason: 'boundary-replaced',
    });
    expect(test.viewer.events).not.toContain('host:apply');
    expect(test.viewer.released).toHaveLength(1);
    expect(test.diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'error',
      code: 'saved_view/activation_failed',
      details: expect.objectContaining({
        viewId: 'a',
        cleanup: 'release',
        outcome: 'cancelled',
      }),
      cause: expect.objectContaining({
        name: 'AggregateError',
        errors: expect.arrayContaining([releaseFailure]),
      }),
    }));
    expect(test.coordinator.getSnapshot()).toMatchObject({
      activeViewId: null,
      activation: { status: 'idle' },
      consistent: true,
    });
  });
});

describe('SavedViewCoordinator tours and reference-safe removal', () => {
  it('persists validated ordered steps and plays without document history', async () => {
    const test = harness();
    test.coordinator.insert(definition('a', 1));
    test.coordinator.insert(definition('b', 2));
    const tour = test.coordinator.createTour({
      id: 'review',
      name: 'Review',
      steps: [
        { viewId: 'a', transitionDurationMs: 100, dwellDurationMs: 20 },
        { viewId: 'b', transitionDurationMs: 200, dwellDurationMs: 30 },
      ],
    });
    const historyEntries = test.document.labels.length;
    const documentRevision = test.coordinator.getSnapshot().documentRevision;

    await expect(test.coordinator.playTour('review')).resolves.toEqual({
      status: 'completed',
      tourId: 'review',
    });

    expect(tour.steps.map(({ viewId }) => viewId)).toEqual(['a', 'b']);
    expect(test.coordinator.getSnapshot().activeViewId).toBe('b');
    expect(test.document.labels).toHaveLength(historyEntries);
    expect(test.coordinator.getSnapshot().documentRevision).toBe(documentRevision);
  });

  it('pauses, seeks, and cancels playback without durable navigation edits', async () => {
    const scheduler = {
      delay: (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          const aborted = () => {
            const error = new Error('paused');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal.aborted) aborted();
          else signal.addEventListener('abort', aborted, { once: true });
        }),
    };
    const test = harness(scheduler);
    test.coordinator.insert(definition('a', 1));
    test.coordinator.insert(definition('b', 2));
    test.coordinator.createTour({
      id: 'review',
      name: 'Review',
      steps: [
        { viewId: 'a', transitionDurationMs: 0, dwellDurationMs: 100 },
        { viewId: 'b', transitionDurationMs: 0, dwellDurationMs: 100 },
      ],
    });
    const historyEntries = test.document.labels.length;
    const playback = test.coordinator.playTour('review');
    await vi.waitFor(() =>
      expect(test.coordinator.getSnapshot().activeViewId).toBe('a'),
    );
    test.coordinator.pauseTour();
    await expect(playback).resolves.toMatchObject({
      status: 'paused',
      tourId: 'review',
    });
    expect(test.coordinator.getSnapshot().playback).toMatchObject({
      status: 'paused',
      stepIndex: 0,
    });

    await expect(test.coordinator.seekTour('review', 1)).resolves.toEqual({
      status: 'activated',
      viewId: 'b',
    });
    expect(test.coordinator.getSnapshot().activeViewId).toBe('b');
    test.coordinator.cancelTour('user');
    expect(test.coordinator.getSnapshot().playback).toEqual({ status: 'idle' });
    expect(test.document.labels).toHaveLength(historyEntries);
  });

  it('reports active, override, and every tour-step reference', async () => {
    const test = harness();
    test.coordinator.insert(
      definition('a', 1, {
        first: { visible: false },
        second: { visible: true },
      }),
    );
    test.coordinator.createTour({
      id: 'review',
      name: 'Review',
      steps: [
        { viewId: 'a', transitionDurationMs: 0, dwellDurationMs: 0 },
        { viewId: 'a', transitionDurationMs: 0, dwellDurationMs: 0 },
      ],
    });
    await test.coordinator.activate('a');

    expect(test.coordinator.inspectRemoval('a')).toEqual({
      viewId: 'a',
      active: true,
      annotationOverrideIds: ['first', 'second'],
      tourSteps: [
        { tourId: 'review', stepIndex: 0 },
        { tourId: 'review', stepIndex: 1 },
      ],
    });
    await expect(test.coordinator.remove('a')).rejects.toMatchObject({
      code: 'saved_view/referenced',
    });
    expect(test.coordinator.get('a')).toBeDefined();
  });

  it('cascades view, overrides, and tour steps in one reversible transaction', async () => {
    const test = harness();
    test.coordinator.insert(definition('a', 1, { note: { visible: false } }));
    test.coordinator.insert(definition('b', 2));
    test.coordinator.createTour({
      id: 'review',
      name: 'Review',
      steps: [
        { viewId: 'a', transitionDurationMs: 0, dwellDurationMs: 0 },
        { viewId: 'b', transitionDurationMs: 0, dwellDurationMs: 0 },
        { viewId: 'a', transitionDurationMs: 0, dwellDurationMs: 0 },
      ],
    });
    const before = test.document.labels.length;

    await test.coordinator.remove('a', { cascade: true });

    expect(test.document.labels.slice(before)).toEqual(['Remove view a']);
    expect(test.coordinator.get('a')).toBeUndefined();
    expect(test.coordinator.getSnapshot().tours[0]?.steps).toEqual([
      { viewId: 'b', transitionDurationMs: 0, dwellDurationMs: 0 },
    ]);
    test.document.undo();
    expect(test.coordinator.get('a')?.annotationOverrides).toEqual({
      note: { visible: false },
    });
    expect(test.coordinator.getSnapshot().tours[0]?.steps).toHaveLength(3);
  });

  it('rolls active cascades back through coherent prior viewpoints', async () => {
    const test = harness();
    test.coordinator.insert(definition('a', 1));
    test.coordinator.insert(definition('b', 2));
    await test.coordinator.activate('a');
    await test.coordinator.activate('b');

    await test.coordinator.remove('b', { cascade: true });
    expect(test.coordinator.getSnapshot().activeViewId).toBe('a');
    expect(test.viewer.state.camera.position.x).toBe(1);

    await test.coordinator.remove('a', { cascade: true });
    expect(test.coordinator.getSnapshot().activeViewId).toBeNull();
    expect(test.viewer.state.camera.position.x).toBe(-1);
  });

  it('rejects missing view references before tour mutation', () => {
    const test = harness();
    expect(() =>
      test.coordinator.createTour({
        id: 'broken',
        name: 'Broken',
        steps: [
          { viewId: 'missing', transitionDurationMs: 0, dwellDurationMs: 0 },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'tour/invalid_definition' }));
    expect(test.document.labels).toEqual([]);
  });

  it('disposes pending view work idempotently and rejects later commands', async () => {
    const test = harness();
    test.coordinator.insert(definition('a'));
    let release!: () => void;
    test.viewer.pendingApply = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activation = test.coordinator.activate('a');
    await vi.waitFor(() => expect(test.viewer.events).toContain('host:apply'));
    test.coordinator.dispose();
    test.coordinator.dispose();
    release();

    await expect(activation).resolves.toMatchObject({ status: 'cancelled' });
    expect(() => test.coordinator.list()).toThrowError(
      expect.objectContaining({ code: 'saved_view/disposed' }),
    );
  });

  it('bounds retained activation rollback resources during repeated tours', async () => {
    const test = harness();
    test.coordinator.insert(definition('a', 1));
    test.coordinator.insert(definition('b', 2));

    for (let index = 0; index < 80; index += 1) {
      await test.coordinator.activate(index % 2 === 0 ? 'a' : 'b');
    }

    expect(test.viewer.released.length).toBeGreaterThan(0);
    const active = test.coordinator.getSnapshot().activeViewId;
    await test.coordinator.remove(active!, { cascade: true });
    expect(test.coordinator.getSnapshot().activeViewId).not.toBe(active);
  });

  it('completes coordinator disposal before aggregating release failures', async () => {
    const test = harness();
    test.coordinator.insert(definition('a', 1));
    await test.coordinator.activate('a');
    test.viewer.releaseFailure = new Error('release failed');

    expect(() => test.coordinator.dispose()).toThrow(AggregateError);
    expect(() => test.coordinator.list()).toThrowError(
      expect.objectContaining({ code: 'saved_view/disposed' }),
    );
    expect(() => test.coordinator.dispose()).not.toThrow();
  });
});
