// Model-aware organization in one small scene. The four clusters deliberately repeat the same
// edge-near, short-bend and deeper escape pattern in every quadrant, so orbiting makes the chosen
// side and lane easy to inspect instead of hiding it in a dense review drawing.
import { ViewLeader, type ProjectedBoundsResult } from 'viewleader';
import { createThreeAdapter } from 'viewleader/three';
import '../shared/example.css';
import { claimChromeEdges } from '../shared/chromeInsets';
import { createControlBar } from '../shared/controls';
import { createExampleHarness, exposeExampleManager, markExampleFailed, markExampleReady } from '../shared/harness';
import { mountOrganizationControls } from '../shared/organizationControls';
import { createMockBuilding } from '../shared/mockBuilding';
import { createOrganizedAnnotations } from '../shared/organizedScene';

declare global {
  interface Window {
    organizationDemo?: { bounds(): ProjectedBoundsResult };
  }
}

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');
  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);
  // Start square to the front face: the mirrored four-point pattern is legible before the visitor
  // orbits into the model. The Orbit button is deliberately a second view, not the initial pose.
  harness.camera.position.set(0, 2.1, 26);
  harness.controls.target.set(0, 2.1, 0);
  harness.controls.update();
  const adapters = createThreeAdapter({
    camera: harness.camera,
    renderer: harness.renderer,
    modelBounds: () => [building.root],
    occlusion: { objects: () => [building.root] },
    controls: harness.controls,
  });
  const leader = new ViewLeader({ boundary: harness.boundary, adapters });
  // Leave room for two full escape lanes above and below at the gallery's laptop viewport size.
  leader.setAnnotationScale(0.75);
  leader.setPlacementMode('quadrants');
  leader.setKeepLabelsOutsideModel(true);

  for (const draft of createOrganizedAnnotations()) leader.annotations.create(draft);

  const bar = createControlBar();
  mountOrganizationControls(bar, leader, (message) => bar.status(message));
  const fit = (): void => {
    harness.camera.position.set(0, 2.1, 26);
    harness.controls.target.set(0, 2.1, 0);
    harness.controls.update();
    bar.status('Fit view: all four mirrored lane groups are visible.');
  };
  bar.button('Fit model', fit);
  bar.button('Zoom in', () => {
    harness.camera.position.set(0, 2.5, 6);
    harness.controls.target.set(0, 2.5, 0);
    harness.controls.update();
    bar.status('Close zoom preserves model clearance; labels may leave the viewport until you fit the model.');
  });
  bar.button('Orbit', () => {
    harness.camera.position.set(-13, 9, -14);
    harness.controls.target.set(0, 2.5, 0);
    harness.controls.update();
    bar.status('Rear view: hidden anchors have faded, dashed leaders; labels stay readable.');
  });
  bar.button('Side view', () => {
    harness.camera.position.set(-26, 7, 0);
    harness.controls.target.set(0, 2.5, 0);
    harness.controls.update();
    bar.status('Side view: front-face anchors bunch near one edge; leaders organize outside the full model.');
  });
  bar.status('Drag slowly, reverse, and release to inspect stable leaders. Zoom in to check model clearance.');

  harness.onFrame(() => leader.update());
  leader.update();
  claimChromeEdges(() => leader);
  window.organizationDemo = {
    bounds: () => {
      const bounds = adapters.modelBounds?.get() ?? null;
      return bounds === null
        ? { status: 'empty' }
        : adapters.projection.projectBounds!(bounds, adapters.projection.getViewport());
    },
  };
  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
