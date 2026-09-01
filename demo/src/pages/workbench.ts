// The workbench is host composition over independent public capabilities — annotations, plugin content,
// markup, saved views, selection, and history — in one runtime. There is no ViewLeader "UI"; the host
// wires the capabilities it wants. This page composes a review and then disposes everything cleanly.
import { ViewLeader } from 'viewleader';
import { markdownPlugin } from 'viewleader/markdown';
import { createThreeAdapter } from 'viewleader/three';
import { exportVectorSheet } from 'viewleader/interchange';
import '../shared/example.css';
import { claimChromeEdges } from '../shared/chromeInsets';
import { createControlBar } from '../shared/controls';
import {
  createExampleHarness,
  createViewerStateAdapter,
  exposeExampleManager,
  markExampleFailed,
  markExampleReady,
} from '../shared/harness';
import { MOCK_ELEMENTS, SELF_OCCLUSION_EPSILON, createMockBuilding } from '../shared/mockBuilding';
import { crowdedDrafts } from '../shared/crowdedDrafts';

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);

  const adapters = {
    ...createThreeAdapter({
      camera: harness.camera,
      renderer: harness.renderer,
      modelBounds: () => [building.root],
      occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
    }),
    viewerState: createViewerStateAdapter(harness),
  };
  const leader = new ViewLeader({ boundary: harness.boundary, adapters, plugins: [markdownPlugin] });
  // Kept, because `Dispose` below has to stop them. A frame callback that outlives the instance it
  // reads throws from `#assertActive()` on every frame thereafter.
  const stopFrameWork: Array<() => void> = [harness.onFrame(() => leader.update())];
  leader.update();

  const bar = createControlBar();
  // What each policy does to a leg that is behind the building. `fade` is keyed to the WHOLE
  // annotation being buried, so its wording says "every leg" rather than promising a dimming a note
  // with a leg still in view will not show — nearly every note here has exactly one leg, which is
  // the only reason `fade` has anything to say on this page at all.
  const OCCLUSION_SAYS: Record<string, string> = {
    keep: 'keep — every leg is drawn, and the ones behind the building go dashed and dimmed'
      + ' (ISO 128: dashed means hidden). The default, and what the other two are measured against.',
    fade: 'fade — the same dashing, and a note whose every leg is buried drops to a quarter opacity.'
      + ' Almost every note here has one leg, so for those "every leg" is simply that leg.',
    hide: 'hide — a buried leg is not drawn at all: no stroke, no arrowhead, no grips, no click'
      + ' target. A note keeps its label and any leg still in view; a note with nothing left in view'
      + ' goes with them. Crowd the drawing first — this is where the buried leaders stop competing'
      + ' for attention and the review gets readable again.',
  };
  // Read by the two create buttons as well as the select, so a policy chosen before there is
  // anything on screen still applies to what lands there — otherwise picking `hide` and then
  // crowding draws thirty-two notes the status line has already described as hidden.
  let policy: 'keep' | 'fade' | 'hide' = 'keep';

  const compose = bar.button('Compose review', async () => {
    // Annotation + plugin content.
    leader.annotations.create({
      id: 'note',
      anchor: { kind: 'world-point', point: MOCK_ELEMENTS.roofSlab.point },
      occlusion: policy,
      content: { kind: 'plugin:viewleader.markdown', pluginId: 'viewleader.markdown', schemaVersion: 2, data: { source: '**Integrated** review' } },
    });
    // Ink markup on a drawing plane.
    void leader.authoring.markup.start({
      kind: 'ink',
      commit: { id: 'ink' },
      plane: { origin: { x: 0, y: 0, z: 3.1 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
    });
    leader.authoring.markup.appendInkPoint({ x: -1.5, y: 1.5 });
    leader.authoring.markup.appendInkPoint({ x: 1.5, y: 2.5 });
    leader.authoring.markup.complete();
    // Saved view + selection.
    await leader.views.save({ id: 'review', name: 'Review' });
    await leader.views.activate('review');
    leader.annotations.select(['note']);
    leader.update();
    compose.disabled = true;
    sheet.disabled = false;
    bar.status(
      `Composed: ${leader.annotations.getSnapshot().annotations.length} annotations, ` +
        `${leader.authoring.markup.listInk().length} ink, ${leader.views.getSnapshot().savedViews.length} saved view, ` +
        `${leader.history.getSnapshot().undoCount} undo steps.`,
    );
  });
  // Scene A of the goal's pinned oracle: twenty-four seeded notes on the building shell plus a
  // three-leg keynote, two region anchors, two manual placements and a markdown label. Deterministic
  // and built from `crowdedDrafts`, so the vitest overlap assertions, the committed plan snapshot
  // and the Playwright orbit all grade the same drawing this button draws.
  const crowd = bar.button('Crowd (30 notes)', () => {
    const box = viewport.getBoundingClientRect();
    for (const draft of crowdedDrafts({ width: box.width, height: box.height })) {
      leader.annotations.create({ ...draft, occlusion: policy });
    }
    leader.update();
    crowd.disabled = true;
    sheet.disabled = false;
  });

  // `occlusion` is a per-annotation field, so a page-wide policy means touching every annotation.
  // One transaction, because one choice by the user is one undo step — thirty-two would make Ctrl-Z
  // useless for the rest of the review. The commit is also what drops core's cached occlusion
  // verdict, so the new policy is graded against a fresh raycast rather than the old answer.
  bar.select('Occlusion', Object.keys(OCCLUSION_SAYS), (chosen) => {
    policy = chosen as typeof policy;
    leader.history.transaction(`Occlusion ${policy}`, () => {
      for (const { id } of leader.annotations.getSnapshot().annotations) {
        leader.annotations.update(id, { occlusion: policy });
      }
    });
    bar.status(OCCLUSION_SAYS[policy]!);
  });

  // Live standards lint. A CSS-pixel is 1/96 in, so 96/25.4 mm is the plot scale a browser implies;
  // a real host would use its sheet's. Clicking selects the offending annotations, which is how a
  // host highlights them — `annotationIds` come back ready to hand to `annotations.select`.
  const CSS_PIXELS_PER_MM = 96 / 25.4;
  const badge = bar.button('Standards: —', () => {
    const offenders = [...new Set(findings.flatMap((finding) => finding.annotationIds))];
    leader.annotations.select(offenders);
    leader.update();
    bar.status(
      offenders.length === 0
        ? 'No standards findings in this frame.'
        : `Selected ${offenders.length} annotation(s): ${[...new Set(findings.map((f) => f.ruleId))].join(', ')}.`,
    );
  });
  let findings = leader.diagnostics.lintFrame({ pixelsPerMillimetre: CSS_PIXELS_PER_MM });
  let lastLabel = '';
  stopFrameWork.push(harness.onFrame(() => {
    // Re-linted every frame because findings are true for one camera only — orbit and they change.
    // The DOM write is guarded on the label, not the count: writing text every frame is what makes
    // a "live" badge cost more than the lint itself.
    findings = leader.diagnostics.lintFrame({ pixelsPerMillimetre: CSS_PIXELS_PER_MM });
    const errors = findings.filter((finding) => finding.severity === 'error').length;
    const label = `Standards: ${findings.length}${errors > 0 ? ` (${errors} err)` : ''}`;
    if (label !== lastLabel) {
      badge.textContent = label;
      badge.dataset['findings'] = String(findings.length);
      lastLabel = label;
    }
  }));

  // One host-side call, which is why the library ships no `exportSheet()` method. The chrome is
  // already gone: `render.ts` marks grips, hit pads and handle groups `data-non-printing` where it
  // creates them, and `removeConstructionGeometry` strips that on the way out.
  const sheet = bar.button('Export sheet', () => {
    const { svg, width, height } = exportVectorSheet(leader.overlayElement, {
      paper: '#ffffff',
      titleBlock: { drawingNumber: 'A-101', scale: 'NTS', date: new Date().toISOString().slice(0, 10) },
    });
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'workbench.svg';
    link.click();
    // Revoked on the next tick, not inline: the download reads the blob after `click()` returns.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    bar.status(`Exported ${width}×${height} — drawing only: no grips, no hit geometry.`);
  });
  // Off until one of the create buttons has drawn a frame: `exportVectorSheet` reads the overlay's
  // rendered SVG, and there is nothing in it — so nothing to export — until an annotation exists.
  sheet.disabled = true;

  bar.button('Dispose', () => {
    // Stop the frame work FIRST. `dispose()` makes every capability throw, and these two callbacks
    // run from the harness render loop — one throw there and the renderer never paints again.
    for (const stop of stopFrameWork.splice(0)) stop();
    leader.dispose();
    compose.disabled = true;
    crowd.disabled = true;
    badge.disabled = true;
    sheet.disabled = true;
    bar.status('Disposed — no ViewLeader-owned resources remain in the boundary.');
  });
  bar.status('One runtime, many capabilities. Compose a review, then dispose it.');

  // The control dock is painted over the viewport, and a label laid out underneath it is
  // invisible. Core never sees the host's DOM, so the page measures its own chrome and claims
  // that edge.
  claimChromeEdges(() => leader);

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
