// Every built-in drafting style, on one building, so the shapes are comparable side by side. The
// styles are data: each entry below is a `styleId` plus content, and the arrowhead, enclosure,
// landing and text alignment all come from the style's definition rather than from this page.
import {
  BUILT_IN_DEFINITIONS,
  CAD_DARK,
  CAD_PAPER,
  ViewLeader,
  mm,
  type AnnotationDraft,
  type Theme,
} from 'viewleader';
import { createThreeAdapter } from 'viewleader/three';
import * as THREE from 'three';
import '../shared/example.css';
import { claimChromeEdges } from '../shared/chromeInsets';
import { createControlBar } from '../shared/controls';
import {
  createExampleHarness,
  exposeExampleManager,
  markExampleFailed,
  markExampleReady,
} from '../shared/harness';
import { createMockBuilding } from '../shared/mockBuilding';

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
    // No occlusion adapter here, deliberately. The eleven anchors ring the building at radius 3.4
    // and its walls stand at ±3, so the anchors on the diagonals sit inside the shell and the far
    // half of the ring is behind it from any camera — about seven of the eleven would draw dashed
    // and dimmed, permanently. This page exists to compare arrowheads, enclosures and landings side
    // by side; a second visual variable running through that comparison ruins it. A wider ring does
    // not help: the far half of a ring around an opaque object is hidden at every radius. The
    // Occlusion example is where the dashed leg belongs.
  });
  let leader = new ViewLeader({ boundary: harness.boundary, adapters });

  // One anchor per style, spread around the model so no two labels collide. Tag and grid styles
  // centre their text, so they carry short symbols; notes and callouts carry sentences.
  const gallery = [
    { style: 'standard', content: { kind: 'callout', title: 'Standard', text: 'Boxed note' } },
    { style: 'note', content: { kind: 'plain-note', text: 'Unframed note' } },
    { style: 'dimension', content: { kind: 'plain-note', text: '3600' } },
    { style: 'detail-bubble', content: { kind: 'split-callout', primary: '3', secondary: 'A-501' } },
    { style: 'section-head', content: { kind: 'split-callout', primary: 'B', secondary: 'A-301' } },
    { style: 'grid-bubble', content: { kind: 'symbolic-block', symbol: 'circle', label: 'C' } },
    { style: 'level-head', content: { kind: 'plain-note', text: 'L02  +3.600' } },
    { style: 'spot-elevation', content: { kind: 'plain-note', text: '+5.900' } },
    { style: 'tag-circle', content: { kind: 'tag', text: 'W-12' } },
    { style: 'tag-hexagon', content: { kind: 'tag', text: 'D-04' } },
    { style: 'tag-chevron', content: { kind: 'tag', text: 'P-21' } },
  ] as const satisfies readonly { style: string; content: AnnotationDraft['content'] }[];

  // Anchors ring the building at two heights, so every leader has clear air to route through.
  const anchor = (index: number, total: number): { x: number; y: number; z: number } => {
    const angle = (index / total) * Math.PI * 2;
    return {
      x: Math.cos(angle) * 3.4,
      y: index % 2 === 0 ? 4.6 : 1.4,
      z: Math.sin(angle) * 3.4,
    };
  };

  const drafts = gallery.map((entry, index): AnnotationDraft => ({
    id: entry.style,
    anchor: { kind: 'world-point', point: anchor(index, gallery.length) },
    content: entry.content,
    // Styles are referenced by id. Nothing here describes a circle or an arrowhead.
    styleId: `builtin.style.${entry.style}`,
    routing: { kind: 'automatic', mode: entry.style === 'grid-bubble' ? 'orthogonal' : 'dogleg' },
  }));
  for (const draft of drafts) leader.annotations.create(draft);

  const controls = createControlBar();

  // A theme is a rendering choice made at construction, like a camera — not document data. The
  // serialized bytes below carry `styleId`s and no colour at all, so swapping palettes is: save,
  // rebuild the instance on the other theme, reopen the same file. Nothing in it is edited, and the
  // eleven ids stay put, which is why every `styleId` above keeps resolving.
  const themes: Readonly<Record<string, Theme>> = { paper: CAD_PAPER, dark: CAD_DARK };
  // The box opens on `paper` and the instance above really is on `paper` — no `theme` option means
  // `CAD_PAPER`. The scene was the part that disagreed: the harness paints its own neutral
  // `#e9e7df`, so picking the theme the page was already in visibly changed the background and the
  // box was reporting a state the viewport was not in. Paint it here instead, from the same palette
  // the handler below uses, so the opening state and the first pick agree.
  harness.scene.background = new THREE.Color(CAD_PAPER.paper);
  controls.select('Theme', Object.keys(themes), (name) => {
    const theme = themes[name] ?? CAD_PAPER;
    const saved = leader.documents.serialize();
    leader.dispose();
    leader = new ViewLeader({
      boundary: harness.boundary, adapters, theme, initialDocument: saved,
    });
    exposeExampleManager(leader);
    reclaimChromeEdges();
    // The viewport is the host's, so recolouring it is too — core paints annotations, not the scene.
    harness.scene.background = new THREE.Color(theme.paper);
    leader.update();
    controls.status(`Theme: ${name} — same document, same ids, repainted`);
  });

  // Routing is per annotation, not per style, so a host can re-route the whole drawing at once.
  // `dogleg` is the drafting MLEADER: a diagonal into a fixed-length horizontal landing.
  controls.select('Routing', ['dogleg', 'straight', 'orthogonal'], (mode) => {
    for (const entry of gallery) {
      leader.annotations.update(entry.style, {
        routing: { kind: 'automatic', mode: mode as 'dogleg' | 'straight' | 'orthogonal' },
      });
    }
    leader.update();
    controls.status(`Routing: ${mode}`);
  });

  // Overrides are typed partials of the style, deep-merged, so this reaches only the landing's
  // length and leaves its side, gap and render form alone.
  let long = false;
  controls.button('Toggle long landings', () => {
    long = !long;
    for (const entry of gallery) {
      leader.annotations.update(entry.style, {
        styleOverride: long ? { landing: { length: mm(14) } } : {},
      });
    }
    leader.update();
    controls.status(long ? 'Landing: 14 mm override' : 'Landing: style default');
  });

  // The screen-geometry surface is pulled during your own frame, never stored — it is screen
  // coordinates for the current camera. Here it just reports what the renderer actually drew.
  controls.button('Measure a label', () => {
    const geometry = leader.geometry.of('standard');
    if (geometry === undefined) {
      controls.status('Standard label is off screen');
      return;
    }
    const { width, height } = geometry.label;
    controls.status(`Standard label: ${width.toFixed(1)} × ${height.toFixed(1)} px, ${geometry.legs.length} leg`);
  });

  // `BUILT_IN_DEFINITIONS` is the id list, and ids are the same in both palettes — which is exactly
  // why it is safe to count from here. For the colours a themed instance is drawing with, read
  // `leader.definitions.list('style')`, which reports that instance's palette rather than the default.
  const styleCount = BUILT_IN_DEFINITIONS.filter((definition) => definition.kind === 'style').length;
  controls.status(`${styleCount} built-in styles, every size in drafting units`);

  harness.onFrame(() => leader.update());
  leader.update();

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
