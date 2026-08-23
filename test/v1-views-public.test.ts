import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  InvalidDocumentError,
  ViewLeader,
  type NeutralViewerState,
  type ViewerStateAdapter,
} from '../src/index.js';

function state(seed: number): NeutralViewerState {
  return {
    camera: {
      projection: 'perspective',
      position: { x: seed, y: 2, z: 4 },
      direction: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      verticalFieldOfView: 45,
      near: 0.1,
      far: 1_000,
    },
    modelVisibility: [{ modelId: 'building', visible: true }],
    elementVisibility: [
      { modelId: 'building', elementId: 'wall', visible: true },
    ],
    selection: [{ modelId: 'building', elementId: 'wall' }],
    colorOverrides: [],
    clippingPlanes: [],
  };
}

interface Prepared {
  readonly prior: NeutralViewerState;
  readonly next: NeutralViewerState;
}

describe('public ViewLeader views capability', () => {
  it('uses the canonical document/history and keeps activation transient', async () => {
    const dom = new JSDOM('<!doctype html><div id="viewer"></div>');
    const boundary = dom.window.document.querySelector('#viewer');
    if (boundary === null) throw new Error('missing boundary');
    let hostState = state(0);
    const viewerState: ViewerStateAdapter<Prepared> = {
      capture: () => structuredClone(hostState),
      prepare: (next) => ({
        prior: structuredClone(hostState),
        next: structuredClone(next),
      }),
      apply: (prepared) => {
        hostState = structuredClone(prepared.next);
      },
      rollback: (prepared) => {
        hostState = structuredClone(prepared.prior);
      },
    };
    const viewLeader = new ViewLeader({
      boundary,
      adapters: {
        projection: {
          getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
          getRevision: () => 0,
          project: (point) => ({
            point: { x: 400 + point.x, y: 300 - point.y },
            depth: point.z,
            visible: true,
          }),
        },
        viewerState,
      },
    });
    viewLeader.annotations.create({
      id: 'note',
      anchors: [
        {
          id: 'leg',
          anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
          routing: { kind: 'automatic', mode: 'straight' },
        },
      ],
      content: { kind: 'plain-note', text: 'Coordination note' },
      placement: { kind: 'automatic' },
    });
    const commitSnapshots: Array<{
      readonly documentRevision: number;
      readonly capabilityViews: number;
      readonly documentViews: number;
    }> = [];
    const unsubscribe = viewLeader.views.subscribe(() => {
      const views = viewLeader.views.getSnapshot();
      commitSnapshots.push({
        documentRevision: views.documentRevision,
        capabilityViews: views.savedViews.length,
        documentViews: viewLeader.documents.getSnapshot().document.savedViews.length,
      });
    });
    const created = viewLeader.views.insert({
      id: 'coordination',
      name: 'Coordination',
      viewerState: state(10),
      annotationOverrides: {
        note: {
          visible: false,
          placement: { mode: 'manual', position: { x: 120, y: 140 } },
          style: { lineColor: '#ff0000' },
        },
      },
    });

    expect(created.id).toBe('coordination');
    expect(viewLeader.views.getSnapshot()).toMatchObject({
      documentRevision: 2,
      savedViews: [{ id: 'coordination' }],
      activeViewId: null,
    });
    expect(viewLeader.history.getSnapshot().undoCount).toBe(2);
    expect(commitSnapshots).toEqual([{
      documentRevision: 2,
      capabilityViews: 1,
      documentViews: 1,
    }]);
    unsubscribe();
    viewLeader.update();
    expect(boundary.querySelector('[data-annotation-id="note"]')).not.toBeNull();
    const documentRevision = viewLeader.documents.getSnapshot().documentRevision;
    await expect(viewLeader.views.activate('coordination')).resolves.toEqual({
      status: 'activated',
      viewId: 'coordination',
    });
    expect(hostState.camera.position.x).toBe(10);
    expect(viewLeader.views.getSnapshot().activeViewId).toBe('coordination');
    expect(viewLeader.documents.getSnapshot().documentRevision).toBe(documentRevision);
    expect(viewLeader.history.getSnapshot().undoCount).toBe(2);
    expect(viewLeader.documents.serialize()).not.toContain('activeViewId');
    viewLeader.update();
    expect(boundary.querySelector('[data-annotation-id="note"]')).toBeNull();

    const activeIdsAtPublication: Array<string | null> = [];
    const unsubscribeRemoval = viewLeader.documents.subscribe(() => {
      activeIdsAtPublication.push(viewLeader.views.getSnapshot().activeViewId);
    });
    viewLeader.history.undo();
    expect(activeIdsAtPublication[0]).toBeNull();
    expect(activeIdsAtPublication).not.toContain('coordination');
    expect(viewLeader.views.get('coordination')).toBeUndefined();
    await expect.poll(() => viewLeader.views.getSnapshot().activeViewId).toBeNull();
    expect(hostState.camera.position.x).toBe(0);
    unsubscribeRemoval();
    viewLeader.history.redo();
    expect(viewLeader.views.get('coordination')).toBeDefined();
    viewLeader.dispose();
    dom.window.close();
  });

  it('persists tours and cascades references in one undoable edit', async () => {
    const dom = new JSDOM('<!doctype html><div id="viewer"></div>');
    const boundary = dom.window.document.querySelector('#viewer');
    if (boundary === null) throw new Error('missing boundary');
    const viewerState: ViewerStateAdapter<{ prior: NeutralViewerState }> = {
      capture: () => state(0),
      prepare: () => ({ prior: state(0) }),
      apply: () => undefined,
      rollback: () => undefined,
    };
    const viewLeader = new ViewLeader({
      boundary,
      adapters: {
        projection: {
          getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
          project: () => null,
        },
        viewerState,
      },
    });
    for (const id of ['a', 'b']) {
      viewLeader.views.insert({
        id,
        name: id.toUpperCase(),
        viewerState: state(id === 'a' ? 1 : 2),
        annotationOverrides: {},
      });
    }
    viewLeader.views.createTour({
      id: 'review',
      name: 'Review',
      steps: [
        { viewId: 'a', transitionDurationMs: 0, dwellDurationMs: 0 },
        { viewId: 'b', transitionDurationMs: 0, dwellDurationMs: 0 },
      ],
    });
    const undoBefore = viewLeader.history.getSnapshot().undoCount;

    await viewLeader.views.remove('a', { cascade: true });
    expect(viewLeader.views.getSnapshot().tours[0]?.steps).toEqual([
      { viewId: 'b', transitionDurationMs: 0, dwellDurationMs: 0 },
    ]);
    expect(viewLeader.history.getSnapshot().undoCount).toBe(undoBefore + 1);
    viewLeader.history.undo();
    expect(viewLeader.views.get('a')).toBeDefined();
    expect(viewLeader.views.getSnapshot().tours[0]?.steps).toHaveLength(2);
    viewLeader.dispose();
    dom.window.close();
  });

  it('rejects malformed view sections before document replacement mutates state', () => {
    const dom = new JSDOM('<!doctype html><div id="viewer"></div>');
    const boundary = dom.window.document.querySelector('#viewer');
    if (boundary === null) throw new Error('missing boundary');
    const viewLeader = new ViewLeader({
      boundary,
      adapters: {
        projection: {
          getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
          project: () => null,
        },
      },
    });
    const before = viewLeader.documents.serialize();
    const beforeHistory = viewLeader.history.getSnapshot();
    const diagnostics: unknown[] = [];
    let runtimeNotifications = 0;
    const unsubscribeDiagnostics = viewLeader.diagnostics.subscribe((diagnostic) => {
      diagnostics.push(diagnostic);
    });
    const unsubscribeDocuments = viewLeader.documents.subscribe(() => {
      runtimeNotifications += 1;
    });
    const replacement = JSON.parse(before) as {
      pluginEnvelopes: unknown[];
      savedViews: unknown[];
      tours: unknown[];
    };
    replacement.pluginEnvelopes.push({
      pluginId: 'missing.plugin',
      recordType: 'content',
      schemaVersion: 1,
      data: { preserved: true },
    });
    replacement.tours.push({
      id: 'dangling',
      name: 'Dangling',
      steps: [
        {
          viewId: 'missing',
          transitionDurationMs: 0,
          dwellDurationMs: 0,
        },
      ],
    });

    expect(() => viewLeader.documents.replace(replacement as never)).toThrow(
      InvalidDocumentError,
    );
    expect(viewLeader.documents.serialize()).toBe(before);
    expect(viewLeader.history.getSnapshot()).toMatchObject({
      documentRevision: beforeHistory.documentRevision,
      undoCount: beforeHistory.undoCount,
      redoCount: beforeHistory.redoCount,
    });
    expect(diagnostics).toEqual([]);
    expect(runtimeNotifications).toBe(0);

    unsubscribeDiagnostics();
    unsubscribeDocuments();
    viewLeader.dispose();
    dom.window.close();
  });
});
