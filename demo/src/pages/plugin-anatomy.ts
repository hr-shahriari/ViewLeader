// Plugin content is stored as canonical bytes ViewLeader itself never interprets. Without the plugin
// installed the record is preserved losslessly but nothing draws it; reinstall the plugin
// and the exact same bytes become renderable again. This page rebuilds the runtime both ways.
import { ViewLeader } from 'viewleader';
import { markdownPlugin } from 'viewleader/markdown';
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
  const adapters = createThreeAdapter({
    camera: harness.camera,
    renderer: harness.renderer,
    modelBounds: () => [building.root],
    occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
  });

  // Rebuild the runtime on the same boundary, with or without the Markdown plugin, from a document.
  let leader = new ViewLeader({ boundary: harness.boundary, adapters, plugins: [markdownPlugin] });
  const rebuild = (withPlugin: boolean, document: string): void => {
    leader.dispose();
    leader = new ViewLeader({
      boundary: harness.boundary,
      adapters,
      initialDocument: document,
      ...(withPlugin ? { plugins: [markdownPlugin] } : {}),
    });
    leader.update();
    exposeExampleManager(leader);
    reclaimChromeEdges();
  };

  leader.annotations.create({
    id: 'note',
    anchor: { kind: 'world-point', point: MOCK_ELEMENTS.roofSlab.point },
    content: {
      kind: 'plugin:viewleader.markdown',
      pluginId: 'viewleader.markdown',
      schemaVersion: 2,
      data: { source: '**Slab RC-30** — see `spec §4.2`' },
    },
  });
  // Serialize once; the same bytes drive every rebuild below.
  const documentBytes = leader.documents.serialize();

  harness.onFrame(() => leader.update());
  leader.update();

  const bar = createControlBar();
  bar.button('Remove plugin', () => {
    rebuild(false, documentBytes);
    bar.status('Plugin removed — the record is preserved byte-for-byte in the document, but nothing draws it: with no renderer installed the annotation is skipped for the frame and the viewport is empty.');
  });
  bar.button('Restore plugin', () => {
    rebuild(true, documentBytes);
    bar.status('Plugin restored — the same bytes render as Markdown again.');
  });
  bar.status('Markdown rendered by its plugin. Remove the plugin to see lossless preservation.');

  // The control dock and the header's notes panel are both painted over the viewport, and a
  // label laid out underneath either one is invisible. Core never sees the host's DOM, so the
  // page measures its own chrome and claims those edges. The sync is kept because insets live
  // on the runtime: the rebuild above hands back a fresh one, which has claimed nothing.
  const reclaimChromeEdges = claimChromeEdges(() => leader);

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
