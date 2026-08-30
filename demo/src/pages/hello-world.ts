// Hello world is deliberately self-contained: every ViewLeader-specific line is in this file so a
// learner can copy it into an existing Three.js viewer. The harness only hides renderer boilerplate.
import { ViewLeader } from 'viewleader';
import { createThreeAdapter } from 'viewleader/three';
import '../shared/example.css';
import {
  createExampleHarness,
  exposeExampleManager,
  markExampleFailed,
  markExampleReady,
} from '../shared/harness';
import { createMockBuilding, MOCK_ELEMENTS } from '../shared/mockBuilding';

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  // Ordinary Three.js setup. Replace the mock building with your own loaded model.
  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);

  // The Three.js adapter is the only wiring ViewLeader needs to turn 3D world points into screen
  // coordinates. Passing `renderer` lets it read the canvas size and re-project on resize for free.
  const adapters = createThreeAdapter({
    camera: harness.camera,
    renderer: harness.renderer,
    // The model's world bounding box becomes the layout frame: labels rail OUTSIDE its projection.
    modelBounds: () => [building.root],
  });

  // A ViewLeader owns one boundary element and draws its SVG annotations into it.
  const leader = new ViewLeader({ boundary: harness.boundary, adapters });

  // An annotation is an anchor plus content. Here the anchor is a plain world point on the roof;
  // the next example introduces stable element anchoring that survives model reloads.
  leader.annotations.create({
    id: 'hello-note',
    anchor: { kind: 'world-point', point: MOCK_ELEMENTS.roofSlab.point },
    content: { kind: 'callout', title: 'Hello, ViewLeader', text: 'A world-anchored note' },
  });

  // Re-project every frame so the leader tracks the model as the camera orbits.
  harness.onFrame(() => leader.update());
  leader.update();

  // Browser checks use one stable handle and wait until the first annotation frame is present.
  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
