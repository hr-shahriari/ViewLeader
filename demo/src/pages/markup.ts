// Markup annotations are regions drawn on a model plane (rectangles, ellipses, revision clouds, ink),
// and any label can fan out to several anchors at once — one note pointing at three things. This page
// commits a revision cloud on the front wall and a three-leg callout, both through the public markup API.
import { ViewLeader } from 'viewleader';
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
import { createMockBuilding, SELF_OCCLUSION_EPSILON } from '../shared/mockBuilding';

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);

  const adapters = createThreeAdapter({
    camera: harness.camera,
    renderer: harness.renderer,
    // Labels rail OUTSIDE the model's projected bounding box (the layout frame).
    modelBounds: () => [building.root],
    occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
  });
  const leader = new ViewLeader({ boundary: harness.boundary, adapters });

  // A drawing plane lives in world space; region geometry is expressed in that plane's local 2D frame.
  // Here the plane is the front wall (normal points at +z), so local x/y map to world x/y.
  const frontWall = {
    origin: { x: 0, y: 0, z: 3.1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  };

  const cloud = leader.authoring.markup.start({
    kind: 'revision-cloud',
    plane: frontWall,
    draft: { id: 'revision', content: { kind: 'tag', text: 'Rev 3' } },
  });
  // Keyboard/programmatic geometry needs no pointer or surface picking.
  leader.authoring.markup.setRegionGeometry(
    {
      kind: 'revision-cloud',
      vertices: [{ x: -1.4, y: 1.1 }, { x: 1.4, y: 1.1 }, { x: 1.4, y: 3.2 }, { x: -1.4, y: 3.2 }],
      arcLength: 0.35,
    },
    'keyboard',
  );
  leader.authoring.markup.complete();
  await cloud;

  // A multi-leader: one label, three model anchors added as extra legs.
  leader.annotations.create({
    id: 'openings',
    anchor: { kind: 'world-point', point: { x: 0, y: 4.4, z: 3.2 } },
    content: { kind: 'callout', title: 'Openings', text: 'Coordinate three penetrations' },
  });
  const leg = (id: string, x: number, y: number) => ({
    id,
    anchor: { kind: 'world-point' as const, point: { x, y, z: 3.15 } },
    routing: { kind: 'automatic' as const, mode: 'orthogonal' as const },
  });
  leader.authoring.markup.addAnchor('openings', leg('leg-left', -2.4, 1.2));
  leader.authoring.markup.addAnchor('openings', leg('leg-right', 2.4, 1.2));

  harness.onFrame(() => leader.update());
  leader.update();

  const bar = createControlBar();
  bar.button('Undo last leg', () => {
    leader.history.undo();
    bar.status('Undid the last markup edit.');
  });
  bar.status('A revision cloud and a three-leg callout, both committed to the canonical document.');

  // The control dock is painted over the viewport, and a label laid out underneath it is
  // invisible. Core never sees the host's DOM, so the page measures its own chrome and claims
  // that edge.
  claimChromeEdges(() => leader);

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
