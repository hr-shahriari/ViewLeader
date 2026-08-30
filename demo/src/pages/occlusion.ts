// "Is that leader pointing at the door, or at a wall six metres in front of it?" Until core started
// dashing the buried leg — ISO 128, dashed means hidden — there was no way to tell but to orbit. This
// is the page that turns occlusion on: one label, two legs, and the building hides exactly one of them.
import { ViewLeader } from 'viewleader';
import { createThreeAdapter, createThreeOcclusionAdapter } from 'viewleader/three';
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

const ANNOTATION_ID = 'clash';
const LEGS = [
  { id: 'door', label: 'front door', point: MOCK_ELEMENTS.frontDoor.point },
  { id: 'column', label: 'corner column', point: MOCK_ELEMENTS.cornerColumn.point },
] as const;

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);

  // Asked on every batch and never captured, which is what makes the toggle below a one-liner: what
  // can block a leader is a live question the host answers, not a fixture baked into the runtime.
  let blockers = true;

  const adapters = {
    ...createThreeAdapter({
      camera: harness.camera,
      renderer: harness.renderer,
      modelBounds: () => [building.root],
    }),
    // Standalone rather than `createThreeAdapter({ occlusion })`, which builds the very same adapter:
    // this is the name to reach for when the blocking set is not simply "the model".
    occlusion: createThreeOcclusionAdapter(harness.camera, {
      objects: () => (blockers ? [building.root] : []),
      epsilon: SELF_OCCLUSION_EPSILON,
    }),
  };

  const leader = new ViewLeader({ boundary: harness.boundary, adapters });
  leader.annotations.create({
    id: ANNOTATION_ID,
    // Two legs under one label, because per-leg is the only place the distinction exists: `occlusion`
    // is a per-annotation policy, so `fade` and `hide` can only ever speak about all the legs at once.
    anchors: LEGS.map(({ id, point }) => ({
      id,
      anchor: { kind: 'world-point' as const, point },
      routing: { kind: 'automatic' as const, mode: 'orthogonal' as const },
    })),
    content: { kind: 'callout', title: 'Clash 14', text: 'Door head fouls the corner column' },
  });

  const bar = createControlBar();
  let reported = '';
  // What each policy does to a leg that is behind the building. `hide` is the one per-leg bought:
  // before it, a policy could only ever speak about every leg at once — which is still all `fade`
  // can speak about, because its dimming is keyed to the whole annotation being buried. So with one
  // leg in view `fade` looks exactly like `keep`, and the status line says so rather than promising
  // a dimming the page cannot show.
  const POLICIES = [
    { value: 'keep', says: 'every leg drawn, the buried ones dashed and dimmed' },
    { value: 'fade', says: 'the same, until every leg is buried — then the whole annotation drops to a quarter opacity' },
    { value: 'hide', says: 'buried legs not drawn at all, the label and any leg still in view stay put — bury every leg and the whole annotation goes' },
  ] as const;
  let policy = 0;
  // Read out of the drawn stroke, not a verdict copy kept on the side: the drawing is the claim.
  const report = (): void => {
    const drawn = (id: string): SVGElement | null => document
      .querySelector(`[data-annotation-id="${ANNOTATION_ID}"] [data-route-visible][data-leg-id="${id}"]`);
    const of = (state: 'gone' | 'dashed' | 'solid'): readonly { readonly label: string }[] =>
      LEGS.filter(({ id }) => {
        const path = drawn(id);
        return state === (path === null ? 'gone' : path.hasAttribute('stroke-dasharray') ? 'dashed' : 'solid');
      });
    const named = (legs: readonly { readonly label: string }[]): string =>
      legs.map(({ label }) => label).join(' and ') || 'nothing';
    const gone = of('gone');
    const text = `${POLICIES[policy]!.value}: ${POLICIES[policy]!.says}.`
      + ` Dashed: ${named(of('dashed'))} · solid: ${named(of('solid'))}`
      + (gone.length === 0 ? '.' : ` · not drawn: ${named(gone)}.`)
      + (blockers ? '' : ' Occlusion is off: the adapter is handed an empty set of blockers, so'
        + ' nothing can block anything — which is what a host with no pickable geometry gets.');
    if (text === reported) return;
    reported = text;
    bar.status(text);
  };

  // Orbiting by hand does this continuously; two fixed framings are the version you can point at.
  let front = true;
  const look = (): void => {
    harness.camera.position.set(front ? 10 : -10, 7, front ? 16 : -16);
    harness.controls.update();
  };
  look();
  leader.update();
  harness.onFrame(() => { leader.update(); report(); });

  bar.button('Flip to the other side', () => {
    front = !front;
    look();
  });
  const toggle = bar.button('Occlusion: on', () => {
    blockers = !blockers;
    toggle.textContent = `Occlusion: ${blockers ? 'on' : 'off'}`;
    // The verdict is cached against the routed SCREEN geometry, and this button moves neither camera
    // nor annotation, so nothing would ask the adapter again until you orbited. A document commit is
    // the only public way to drop that cache, and the flag goes where it is always a real change: a
    // patch restating a value core already holds commits once and then stops.
    leader.annotations.update(ANNOTATION_ID, { metadata: { 'demo:blockers': blockers } });
  });

  const cycle = bar.button('Policy: keep', () => {
    policy = (policy + 1) % POLICIES.length;
    cycle.textContent = `Policy: ${POLICIES[policy]!.value}`;
    // A real document change, unlike the blockers toggle above — `occlusion` is a stored field, so
    // there is no `metadata` workaround to reach for and the commit drops the cached verdict itself.
    leader.annotations.update(ANNOTATION_ID, { occlusion: POLICIES[policy]!.value });
  });

  // The control dock is painted over the viewport, and a label laid out underneath it is invisible.
  // Core never sees the host's DOM, so the page claims that edge itself.
  claimChromeEdges(() => leader);

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
