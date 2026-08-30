// A note anchored to a stable element id outlives the model it points at. When the host unloads its
// model the anchor falls back to the point stored in the document; when the model reloads, ViewLeader
// re-resolves the id and the note snaps back — with no edit to the canonical document.
import { ViewLeader } from 'viewleader';
import {
  createStableElementResolver,
  createThreeAdapter,
  createThreeElementInvalidationChannel,
} from 'viewleader/three';
import '../shared/example.css';
import { claimChromeEdges } from '../shared/chromeInsets';
import { createControlBar } from '../shared/controls';
import {
  createExampleHarness,
  exposeExampleManager,
  markExampleFailed,
  markExampleReady,
} from '../shared/harness';
import { createMockBuilding, MOCK_ELEMENTS, SELF_OCCLUSION_EPSILON } from '../shared/mockBuilding';

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);

  // The host owns model lifecycle. When `loaded` is false the resolver reports no sources, so every
  // element anchor reverts to its fallback point — exactly what happens after a real model unload.
  let loaded = true;
  const invalidations = createThreeElementInvalidationChannel();
  const resolveElement = createStableElementResolver(
    () =>
      loaded
        ? [
            {
              modelId: 'building',
              resolveStableElement(elementId) {
                const point = building.resolveElementPoint(elementId);
                if (!point) throw new Error(`Unknown element ${elementId}`);
                return point;
              },
            },
          ]
        : [],
    invalidations,
  );

  const adapters = createThreeAdapter({
    camera: harness.camera,
    renderer: harness.renderer,
    resolveElement,
    modelBounds: () => [building.root],
    occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
  });
  const leader = new ViewLeader({ boundary: harness.boundary, adapters });

  leader.annotations.create({
    id: 'column-note',
    anchor: {
      kind: 'element',
      modelId: 'building',
      elementId: MOCK_ELEMENTS.cornerColumn.id,
      fallbackPoint: { x: -2.9, y: 0.1, z: -2.9 },
    },
    content: { kind: 'callout', title: 'Corner column', text: 'Anchored to a stable id' },
  });

  harness.onFrame(() => leader.update());
  leader.update();

  const bar = createControlBar();
  const setModel = (next: boolean): void => {
    loaded = next;
    invalidations.invalidate({ modelId: 'building' }); // ask ViewLeader to re-resolve element anchors
    building.root.visible = next;
    bar.status(next ? 'Model loaded — anchor resolved to the column.' : 'Model unloaded — anchor showing its fallback point.');
  };
  bar.button('Unload model', () => setModel(false));
  bar.button('Reload model', () => setModel(true));
  bar.status('Model loaded — anchor resolved to the column.');

  // The control dock is painted over the viewport, and a label laid out underneath it is
  // invisible. Core never sees the host's DOM, so the page measures its own chrome and claims
  // that edge.
  claimChromeEdges(() => leader);

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
