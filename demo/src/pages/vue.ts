// The Vue package mounts one ViewLeader inside the component's effect scope. `viewLeader` is a ref that
// becomes non-null once the boundary element is in the DOM, and stopping the scope disposes it. A keyed
// boundary element reconstructs the instance. This page commands the live instance and replaces it.
import { createThreeAdapter } from 'viewleader/three';
import { useViewLeader } from 'viewleader/vue';
import { createApp, h, nextTick, ref, watch } from 'vue';
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
    // Without it there is no layout frame, and labels fall back to a fixed offset from their anchor
    // instead of being railed outside the model — they overlap the building and pop while orbiting.
    modelBounds: () => [building.root],
    occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
  });

  const generation = ref(1);
  let binding: ReturnType<typeof useViewLeader> | undefined;
  harness.onFrame(() => binding?.viewLeader.value?.update());

  const app = createApp({
    setup() {
      binding = useViewLeader({ adapters });
      // When the composable produces a live instance, seed one note for the current generation.
      watch(binding.viewLeader, (leader) => {
        if (!leader) return;
        leader.annotations.create({
          id: `note-${generation.value}`,
          anchor: { kind: 'world-point', point: MOCK_ELEMENTS.roofSlab.point },
          content: { kind: 'callout', title: `Vue #${generation.value}`, text: 'Owned by the composable' },
        });
        // The composable builds a NEW runtime for every mounted boundary, and insets live on the
        // runtime, so the claim has to be made again here or the fresh instance lays labels back
        // under the control dock and the notes panel.
        reclaimChromeEdges();
        leader.update();
        exposeExampleManager(leader);
        markExampleReady();
      });
      // A changing key remounts the boundary, disposing the prior instance and reconstructing.
      return () =>
        h('div', {
          key: generation.value,
          ref: (element: unknown) => binding?.boundaryRef(element instanceof Element ? element : null),
          class: 'framework-boundary',
          'aria-label': `Vue viewer ${generation.value}`,
        });
    },
  });
  const bar = createControlBar();
  bar.button('Replace boundary', async () => {
    generation.value += 1;
    await nextTick();
    bar.status('Vue disposed the prior instance and reconstructed for the keyed element.');
  });
  bar.status('One ViewLeader owned by the Vue composable. Replace the boundary to prove reconstruction.');
  // Both of these have to exist BEFORE `app.mount()`, and the order is not a style choice. The
  // composable sets `viewLeader` from a `flush: 'sync'` watcher on the boundary ref, and the ref is
  // set while the component's render effect is still running, so the watcher above — plain `watch`,
  // which is `flush: 'pre'` and rides that same render effect — runs inside the synchronous
  // `mount()` call, not after this module body. Declared below the mount, `reclaimChromeEdges` was
  // still in its temporal dead zone when the watcher reached it: a `ReferenceError` straight into
  // `errorHandler` and `data-vl-ready="error"`. The dock has to be built first for the same reason —
  // that is the element the helper measures. The getter is what keeps this safe in the other
  // direction: `viewLeader` is null until the composable has mounted a boundary, and null claims
  // nothing, so calling it here before the mount is a no-op rather than a second hazard.
  const reclaimChromeEdges = claimChromeEdges(() => binding?.viewLeader.value);
  // The `try/catch` wrapping this file only covers what throws synchronously, and the initial mount
  // IS synchronous — but Vue routes a throw inside a component to `errorHandler` instead of letting
  // it out of `mount()`, and a later remount lands in a scheduled flush the `catch` cannot see
  // either way. Without this the readiness flag would go unwritten and the e2e would sit on a 10 s
  // timeout with no diagnostic. React's page gets the same coverage from `ReadyBoundary`.
  app.config.errorHandler = (error) => markExampleFailed(error);
  app.mount(harness.boundary);
} catch (error) {
  markExampleFailed(error);
}
