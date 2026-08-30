// A saved view captures neutral host camera state; activating it restores that state transactionally
// (with rollback on failure) and never edits the annotation document. A tour is an ordered playback of
// saved views. This adapter reads and writes the real Three.js camera, so activation visibly moves it.
import { ViewLeader, type NeutralViewerState, type ViewerStateAdapter } from 'viewleader';
import { createThreeAdapter } from 'viewleader/three';
import '../shared/example.css';
import { claimChromeEdges } from '../shared/chromeInsets';
import { createControlBar } from '../shared/controls';
import {
  createExampleHarness,
  exposeExampleManager,
  markExampleFailed,
  markExampleReady,
} from '../shared/harness';
import { MOCK_ELEMENTS, SELF_OCCLUSION_EPSILON, createMockBuilding } from '../shared/mockBuilding';

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);
  const { camera, controls } = harness;

  // `direction` stores the full vector from camera to orbit target, so apply() restores distance exactly.
  const capture = (): NeutralViewerState => ({
    camera: {
      projection: 'perspective',
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      direction: { x: controls.target.x - camera.position.x, y: controls.target.y - camera.position.y, z: controls.target.z - camera.position.z },
      up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
      verticalFieldOfView: camera.fov,
      near: camera.near,
      far: camera.far,
    },
    modelVisibility: [],
    elementVisibility: [],
    selection: [],
    colorOverrides: [],
    clippingPlanes: [],
  });
  const applyState = (state: NeutralViewerState): void => {
    const c = state.camera;
    camera.position.set(c.position.x, c.position.y, c.position.z);
    controls.target.set(c.position.x + c.direction.x, c.position.y + c.direction.y, c.position.z + c.direction.z);
    camera.up.set(c.up.x, c.up.y, c.up.z);
    if (c.projection === 'perspective') camera.fov = c.verticalFieldOfView;
    camera.updateProjectionMatrix();
    controls.update();
  };
  const viewerState: ViewerStateAdapter<{ prior: NeutralViewerState; next: NeutralViewerState }> = {
    capture,
    prepare: (next) => ({ prior: capture(), next }),
    apply: ({ next }) => applyState(next),
    rollback: ({ prior }) => applyState(prior),
  };

  const adapters = {
    ...createThreeAdapter({
      camera,
      renderer: harness.renderer,
      modelBounds: () => [building.root],
      occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
    }),
    viewerState,
  };
  const leader = new ViewLeader({ boundary: harness.boundary, adapters });
  leader.annotations.create({
    id: 'note',
    anchor: { kind: 'world-point', point: MOCK_ELEMENTS.roofSlab.point },
    content: { kind: 'callout', title: 'Level 2', text: 'Roof plan review' },
  });
  harness.onFrame(() => leader.update());

  // Save two framings: the default overview, then a low corner angle.
  await leader.views.save({ id: 'overview', name: 'Overview' });
  camera.position.set(6, 2, 9);
  controls.target.set(0, 1.5, 0);
  controls.update();
  await leader.views.save({ id: 'corner', name: 'Corner' });
  leader.views.createTour({
    id: 'review',
    name: 'Review',
    steps: [
      { viewId: 'overview', transitionDurationMs: 700, dwellDurationMs: 400 },
      { viewId: 'corner', transitionDurationMs: 700, dwellDurationMs: 400 },
    ],
  });
  // Leave the camera on the overview so the page opens on a sensible framing.
  await leader.views.activate('overview');

  const bar = createControlBar();
  bar.button('Overview', () => leader.views.activate('overview').then(() => bar.status('Restored: Overview')));
  bar.button('Corner', () => leader.views.activate('corner').then(() => bar.status('Restored: Corner')));
  bar.button('Play tour', async () => {
    bar.status('Playing tour…');
    const result = await leader.views.playTour('review');
    bar.status(`Tour ${result.status}.`);
  });
  bar.status('Two saved views and a tour. Orbit freely, then restore a framing.');

  // The control dock is painted over the viewport, and a label laid out underneath it is
  // invisible. Core never sees the host's DOM, so the page measures its own chrome and claims
  // that edge.
  claimChromeEdges(() => leader);

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
