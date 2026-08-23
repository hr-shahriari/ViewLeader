// Element anchoring is what makes an annotation survive a model reload: instead of freezing a world
// point, the document stores a stable element id and a fallback point. ViewLeader renders the fallback
// immediately, then asks the host to resolve the id and converges — no document edit involved.
import { ViewLeader } from 'viewleader';
import { createStableElementResolver, createThreeAdapter } from 'viewleader/three';
import '../shared/example.css';
import { claimChromeEdges } from '../shared/chromeInsets';
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

  // The host owns element lookup. This resolver maps a stable id to a world point from the model,
  // with a short delay so you can see the fallback render first and then snap to the resolved point.
  const resolveElement = createStableElementResolver(() => [
    {
      modelId: 'building',
      async resolveStableElement(elementId, signal) {
        await new Promise((r) => setTimeout(r, 600));
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const point = building.resolveElementPoint(elementId);
        if (!point) throw new Error(`Unknown element ${elementId}`);
        return point;
      },
    },
  ]);

  const adapters = createThreeAdapter({
    camera: harness.camera,
    renderer: harness.renderer,
    resolveElement,
    // The model's world bounding box becomes the layout frame: labels are railed OUTSIDE its
    // screen projection and re-side smoothly as the camera orbits.
    modelBounds: () => [building.root],
    occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
  });

  const leader = new ViewLeader({ boundary: harness.boundary, adapters });

  // The fallback point is intentionally wrong (ground level) so the resolve is visible: the tag starts
  // low, then jumps to the real door once the host resolves the id.
  leader.annotations.create({
    id: 'door-tag',
    anchor: {
      kind: 'element',
      modelId: 'building',
      elementId: MOCK_ELEMENTS.frontDoor.id,
      fallbackPoint: { x: 0, y: 0.1, z: 3.05 },
    },
    content: { kind: 'tag', text: 'Front door' },
  });

  harness.onFrame(() => leader.update());
  leader.update();

  // The header's notes panel hangs over the top-right of the viewport, and a label laid out
  // underneath it is invisible. Core never sees the host's DOM, so the page measures the panel
  // and claims that edge — including when the reader opens or shuts it.
  claimChromeEdges(() => leader);

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
