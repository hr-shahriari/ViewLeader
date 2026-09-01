// The Vue package mounts one ViewLeader inside the component's effect scope. `viewLeader` is a ref that
// becomes non-null once the boundary element is in the DOM, and stopping the scope disposes it. A keyed
// boundary element reconstructs the instance. This page commands the live instance and replaces it.
//
// Everything above the lifecycle is headless: the composables return state and spreadable props, and
// this page owns every element and every pixel of styling. Only the inline text editor ships as a
// component, because its markup carries knowledge — it has to sit *on* the text it replaces without
// the glyphs jumping, which is what the CSS custom properties the follow registry writes are for.
import { createThreeAdapter } from 'viewleader/three';
import {
  LabelTextEditor,
  useEditingKeyboard,
  useFollow,
  useHandles,
  useLabelTextEditor,
  useStyleEditor,
  useViewLeader,
  useViewLeaderSnapshot,
} from 'viewleader/vue';
import { computed, createApp, h, nextTick, ref, shallowRef, watch, type VNode } from 'vue';
import '../shared/example.css';
import { claimChromeEdges } from '../shared/chromeInsets';
import { createControlBar } from '../shared/controls';
import { FOLLOWED, HINT, SWATCHES, TOOLBAR, handleStyle, seedNotes, swatchStyle } from '../shared/frameworkDemo';
import {
  createExampleHarness,
  exposeExampleManager,
  markExampleFailed,
  markExampleReady,
} from '../shared/harness';
import { SELF_OCCLUSION_EPSILON, createMockBuilding } from '../shared/mockBuilding';

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
      const live = binding.viewLeader;

      const follow = useFollow(live);
      const annotations = useViewLeaderSnapshot(() => live.value?.annotations ?? null);
      const selectedId = computed(() => annotations.value?.selectedIds[0] ?? null);
      const handles = useHandles(live, follow.registry, () => selectedId.value ?? 'none');
      const editor = useLabelTextEditor(live, follow.registry);
      const style = useStyleEditor(live);
      const styleState = useViewLeaderSnapshot(style);
      // Arrows nudge, Shift+arrow nudges further, Delete removes, Escape clears. A held arrow is one
      // undo step, not one per repeat — the difference between undo working and undo having been
      // evicted by the time you reach for it.
      useEditingKeyboard(live);

      // Vue's second door, and the reason the binding has one: here the framework fills a template
      // ref and the library reads it, rather than the library installing a callback. `follow.ref`
      // below is the React-shaped path; both reach the same registry.
      const toolbar = shallowRef<Element | null>(null);
      follow.track(() => ({ kind: 'label' as const, id: selectedId.value ?? 'none' }), toolbar);

      // When the composable produces a live instance, seed this generation's notes.
      watch(live, (leader) => {
        if (!leader) return;
        seedNotes(leader, generation.value);
        // The composable builds a NEW runtime for every mounted boundary, and insets live on the
        // runtime, so the claim has to be made again here or the fresh instance lays labels back
        // under the control dock.
        reclaimChromeEdges();
        leader.update();
        exposeExampleManager(leader);
        markExampleReady();
      });

      const chrome = (): VNode[] => {
        const id = selectedId.value;
        if (id === null || follow.registry.value === null) return [];
        const current = styleState.value?.fields.lineColor;
        return [
          // Handles, drawn by this page rather than by core. `props` arrive already routed to the
          // right `begin*Drag` — there are four of those in core, and picking between them is what
          // the composable absorbs — with pointer capture and Escape wired.
          ...handles.entries.value.map((entry) => h('div', {
            key: entry.key,
            ref: handles.ref(entry),
            ...entry.props,
            style: handleStyle(entry),
          })),
          // A label target carries the label's size as well as its position, so this shell *is* the
          // label's box and the toolbar sits above it with `bottom: 100%` rather than guessing an
          // offset. The positioned node stays the library's; the styled node stays ours.
          h('div', {
            key: 'toolbar',
            ref: toolbar,
            style: FOLLOWED,
          }, [h('div', { style: TOOLBAR }, SWATCHES.map((colour) => h('button', {
            key: colour,
            type: 'button',
            'aria-label': `Line colour ${colour}`,
            'data-swatch': colour,
            onClick: () => style.value?.set('lineColor', colour),
            style: swatchStyle(colour, current),
          })))]),
        ];
      };

      // A changing key remounts the boundary, disposing the prior instance and reconstructing.
      return () =>
        h('div', {
          key: generation.value,
          ref: (element: unknown) => binding?.boundaryRef(element instanceof Element ? element : null),
          class: 'framework-boundary',
          'aria-label': `Vue viewer ${generation.value}`,
        }, [
          h('div', {
            style: { position: 'absolute', inset: '0', pointerEvents: 'none' },
            ...(editor.value === null ? {} : { onDblclick: editor.value.boundaryProps.onDoubleClick }),
          }, [
            ...chrome(),
            h(LabelTextEditor, { editor: editor.value }),
          ]),
        ]);
    },
  });
  const bar = createControlBar();
  bar.button('Replace boundary', async () => {
    generation.value += 1;
    await nextTick();
    bar.status('Vue disposed the prior instance and reconstructed for the keyed element.');
  });
  bar.status(HINT);
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
