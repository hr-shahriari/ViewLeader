// ViewLeader ships several built-in content kinds, renders Markdown through a plugin, and asks the
// host to resolve opaque image references (documents never choose network URLs). This page anchors one
// of each around the building and lets you switch the selected note's leader routing.
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

  // The host owns image resolution: it maps an opaque reference to real bytes. Here we return an inline
  // SVG so the page stays self-contained; a real host would decode from its own asset store.
  const adapters = {
    ...createThreeAdapter({
      camera: harness.camera,
      renderer: harness.renderer,
      modelBounds: () => [building.root],
      occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
    }),
    images: {
      resolve: () =>
        Promise.resolve({
          // The viewBox matters: an SVG without one gives `preserveAspectRatio` nothing to scale
          // against, so a browser stretches it to whatever box it is given instead of letterboxing.
          source:
            'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"%3E%3Crect width="40" height="40" fill="%230e6570"/%3E%3Ccircle cx="20" cy="20" r="11" fill="%23f4f2ec"/%3E%3C/svg%3E',
          width: 40,
          height: 40,
        }),
    },
  };
  const leader = new ViewLeader({ boundary: harness.boundary, adapters, plugins: [markdownPlugin] });

  const at = (x: number, y: number, z: number) => ({ kind: 'world-point' as const, point: { x, y, z } });

  leader.annotations.create({
    id: 'markdown',
    anchor: { kind: 'world-point', point: MOCK_ELEMENTS.roofSlab.point },
    content: {
      kind: 'plugin:viewleader.markdown',
      pluginId: 'viewleader.markdown',
      schemaVersion: 2,
      data: { source: '**Level 2** slab · `RC-30`' },
    },
  });
  leader.annotations.create({ id: 'tag', anchor: at(0, 1.05, 3.2), content: { kind: 'tag', text: 'A-101' } });
  leader.annotations.create({ id: 'callout', anchor: at(-2.9, 3, -2.9), content: { kind: 'callout', title: 'Column', text: 'Corner C1' } });
  leader.annotations.create({ id: 'split', anchor: at(3.2, 3, 0), content: { kind: 'split-callout', primary: '150 mm', secondary: 'CLEAR' } });
  leader.annotations.create({ id: 'symbol', anchor: at(0, 3, -3.2), content: { kind: 'symbolic-block', symbol: 'diamond', label: 'R1' } });
  leader.annotations.create({ id: 'rtl', anchor: at(-3.2, 1.5, 0), content: { kind: 'plain-note', text: 'مراجعة', direction: 'rtl' } });
  leader.annotations.create({ id: 'image', anchor: at(3.2, 1.2, 3), content: { kind: 'host-image', reference: 'asset:detail', alt: 'Host-resolved detail' } });

  harness.onFrame(() => leader.update());
  leader.update();

  const bar = createControlBar();
  // `dogleg` first because it is what every annotation is already routed with — a template default
  // (`builtin.template.note`), not a coincidence. A select that opened on `orthogonal` would be
  // reporting a mode nothing on screen is using.
  bar.select('Leader routing', ['dogleg', 'straight', 'orthogonal'], (mode) => {
    // Applied to every annotation, not just one: a single label the placer rails to its own anchor's
    // height draws nearly the same line in all three modes, which reads as "routing does nothing".
    leader.history.transaction(`Route ${mode}`, () => {
      for (const { id } of leader.annotations.getSnapshot().annotations) {
        leader.annotations.reroute(id, {
          kind: 'automatic',
          mode: mode as 'orthogonal' | 'straight' | 'dogleg',
        });
      }
    });
    bar.status(`Routing: ${mode} — the dogleg lands on a text line, the elbow turns once.`);
  });

  // Beside the routing select on purpose: occlusion runs AFTER routing, not instead of it. The mode
  // above decides the path; this decides what happens to a path that turns out to be behind the
  // building. Each of these seven notes has one leg, so "every leg is buried" is just "its leg is
  // buried" — which is the only reason `fade` has anything to show here; with a leg still in view it
  // would render exactly like `keep`.
  const OCCLUSION_SAYS: Record<string, string> = {
    keep: 'keep — routing picks the path, occlusion then grades it: a leg behind the building is'
      + ' drawn dashed and dimmed (ISO 128) on the very route the mode above gave it. The default.',
    fade: 'fade — the same dashing, plus a note whose every leg is buried drops to a quarter'
      + ' opacity. These notes have one leg each, so a buried leg fades its whole note.',
    hide: 'hide — a buried leg is dropped from the drawing: stroke, arrowhead, grips and click'
      + ' target with it. One leg each here, so a buried note goes altogether — and comes back on'
      + ' whatever path the routing mode gives it once the camera lets it be seen again.',
  };
  bar.select('Occlusion', Object.keys(OCCLUSION_SAYS), (policy) => {
    leader.history.transaction(`Occlusion ${policy}`, () => {
      for (const { id } of leader.annotations.getSnapshot().annotations) {
        leader.annotations.update(id, { occlusion: policy as 'keep' | 'fade' | 'hide' });
      }
    });
    bar.status(OCCLUSION_SAYS[policy]!);
  });
  bar.status('Seven content kinds anchored to the model. Change the leader routing above.');

  // The control dock is painted over the viewport, and a label laid out underneath it is
  // invisible. Core never sees the host's DOM, so the page measures its own chrome and claims
  // that edge.
  claimChromeEdges(() => leader);

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
