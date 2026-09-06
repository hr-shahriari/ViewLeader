// A leader editor: place one with the mouse, then change every part of it.
//
// The other editing routes each hold one idea — `/direct-editing/` is core's gestures with no
// pointer code, `/host-chrome/` is the four widgets core refuses to own. This one is the whole loop,
// and the part with no prior art anywhere else: CREATING a leader by clicking the model.
//
// Three things are core's, not this page's, and they are why the file is this short:
//
//   1. AUTHORING BINDS ITS OWN POINTER. `authoring.start()` and `authoring.markup.start()` attach
//      pointermove/down/up/leave, Escape and double-click to the boundary for the life of the
//      session, and resolve a promise on every exit. There is no create-mode pointer handler below.
//   2. CORE ARBITRATES THE MODES. While a tool is armed, `editing` declines pointer input and the
//      interaction lease disables the camera. The "tool state machine" here is a pressed button.
//   3. SHIFT SELECTS. The overlay already binds click → select-with-modifier and, with the
//      `marquee` mode set below, shift- or alt-drag → rubber band. A second host-side toggle would
//      double-toggle and cancel itself out, so nothing here touches either.
//
// The host-side widgets — the raycast, tool arming, the authoring preview, the text field and the
// key bindings — are the same ones `/ifc-studio/` and `/host-chrome/` use, out of
// `shared/leaderTools.ts`.
//
// The boundary is #viewport, not the harness overlay div: the overlay is `pointer-events: none`, so
// listeners on it would only ever fire over an annotation. Same reasoning as `/direct-editing/`.
import {
  ViewLeader,
  type AlignEdge,
  type AnnotationDraft,
  type AnnotationRouting,
  type Vec2,
  type Vec3,
} from 'viewleader';
import { createThreeAdapter } from 'viewleader/three';
import '../shared/example.css';
import { claimChromeEdges } from '../shared/chromeInsets';
import { createControlBar } from '../shared/controls';
import { mountOrganizationControls } from '../shared/organizationControls';
import {
  createExampleHarness,
  exposeExampleManager,
  markExampleFailed,
  markExampleReady,
} from '../shared/harness';
import {
  appendLeg,
  bindEditingKeys,
  createStatusLine,
  createSurfacePicker,
  createTextEditor,
  createToolArmer,
  mountAuthoringPreview,
} from '../shared/leaderTools';
import { MOCK_ELEMENTS, SELF_OCCLUSION_EPSILON, createMockBuilding } from '../shared/mockBuilding';

const STORAGE_KEY = 'viewleader:leader-editor';
const ROUTING_MODES = ['dogleg', 'straight', 'orthogonal'] as const;
// A hand-bent leg is `{ kind: 'manual', vertices }` and carries no `mode`, so the routing box needs a
// fourth word to stay honest about a leg a dragged route grip bent by hand. Not a real mode: it is
// offered only when it is already true, and picking a real mode is how you hand the leg back to the
// layout engine.
const MANUAL_ROUTING = 'manual';

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);

  // --- The two raycasters core cannot supply ------------------------------------------------------
  // Core has no scene and no raycaster by design. `pick` answers "what world point is under the
  // cursor" — it resolves a new leader's arrow and a dropped anchor grip. `pickSurface` answers the
  // same plus the surface normal, which is what a region or ink stroke needs to establish the
  // drawing plane it is then stored in. An anchor carries no normal, so `pick` cannot stand in.
  const { castAt, pickSurface } = createSurfacePicker(harness.camera, () => building.root);
  const pick = (pointer: Vec2): { kind: 'world-point'; point: Vec3 } | null => {
    const hit = castAt(pointer);
    return hit === undefined ? null : { kind: 'world-point', point: { ...hit.point } };
  };

  const leader = new ViewLeader({
    boundary: viewport,
    adapters: createThreeAdapter({
      camera: harness.camera,
      renderer: harness.renderer,
      modelBounds: () => [building.root],
      occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
      pick,
      pickSurface,
      // Core takes an interaction lease for the length of a gesture and this adapter disables
      // OrbitControls while it is held, so an edit and an orbit can never run at once.
      controls: harness.controls,
    }),
    // `marquee: 'modifier'` asks for the rubber band back, on a shift- or alt-drag only. The
    // camera is already safe without it: this page hands core an interaction adapter — `controls`
    // above — so the default is `'none'`, core never takes the lease on empty space, and
    // OrbitControls' own pointerdown, which fired first on the canvas below, runs to completion.
    // A marquee on every plain left-press would take the lease, which the adapter turns into
    // `controls.enabled = false`, killing left-drag orbit on a page whose whole subject is direct
    // manipulation. The workaround for that used to be unbinding the left button here and moving
    // orbit onto the right, which cost pan as well and left a visitor dragging a model that never
    // moved. Shift and alt are the same two modifiers the marquee already reads to add to and
    // subtract from the selection.
    editing: { gestures: true, marquee: 'modifier' },
  });

  const controls = createControlBar();
  mountOrganizationControls(controls, leader, (message) => controls.status(message));

  // Seeded, not empty: a page that starts blank has nothing to edit and nothing to look at.
  const seed: readonly AnnotationDraft[] = [
    {
      id: 'roof',
      anchor: { kind: 'world-point', point: MOCK_ELEMENTS.roofSlab.point },
      content: { kind: 'callout', title: 'Roof slab', text: 'RC-30 · 400 mm' },
    },
    {
      id: 'door',
      anchor: { kind: 'world-point', point: MOCK_ELEMENTS.frontDoor.point },
      content: { kind: 'tag', text: 'A-101' },
      styleId: 'builtin.style.tag-circle',
    },
  ];
  for (const draft of seed) leader.annotations.create(draft);

  // One writer for the status line: the live counts, keeping the last thing an action said.
  const { render, say } = createStatusLine(leader, (text) => controls.status(text));

  // No `requireSelection` twin that complains after the fact: every control that needs a selection is
  // disabled without one by `syncControls`, so "select a leader first" is said by the greyed-out
  // button before the click rather than by the status line after it.
  const selectedId = (): string | undefined => leader.annotations.getSnapshot().selectedIds[0];

  const localPoint = (event: MouseEvent): Vec2 => {
    const bounds = viewport.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  // Every tool is one-shot, and the armer disarms in exactly one place whatever the outcome.
  const tool = createToolArmer(leader, say, (label, action) => controls.button(label, action));

  // --- Creating a leader --------------------------------------------------------------------------
  // The draft carries everything except the anchor; the anchor comes from `pick` when the user
  // clicks. That division is the whole contract: core owns the session, the host owns the scene.
  //
  // Ids come off a monotonic counter, never off `annotations.length` and never off `Date.now()`.
  // Length rewinds when you delete something, so the next create collides and `annotations.create`
  // throws `DUPLICATE_ID` — the tool would report "failed" for a document the user broke three
  // actions ago. A clock is worse still: two markups committed in the same millisecond collide, and
  // the document stops being reproducible.
  let nextId = 0;
  const freshId = (prefix: string): string => `${prefix}-${(nextId += 1)}`;

  const newDraft = (prefix: string): AnnotationDraft => ({
    id: freshId(prefix),
    content: { kind: 'plain-note', text: 'New note' },
  });

  tool('New leader', 'Click the model to place the arrow. Escape cancels.', () =>
    leader.authoring.start({ draft: newDraft('note') }));

  // The first click picks the world anchor AND seeds the first route point; later clicks add route
  // points in screen space with no pick; Enter or double-click commits `{kind:'manual', vertices}`.
  // Core binds all three of those keys and clicks itself.
  tool('Multi-point leader', 'Click the arrow point, then each bend. Enter or double-click finishes.', () =>
    leader.authoring.start({ draft: newDraft('note-multi'), multiPoint: true }));

  // --- Regions and ink ----------------------------------------------------------------------------
  // One drag each, and one shared rule below completes all three: `#updatePointerPreview` reaches
  // `phase: 'ready'` on pointer-up for every markup kind.
  tool('Rectangle', 'Drag a rectangle across a wall.', () =>
    leader.authoring.markup.start({
      kind: 'rectangle',
      draft: { id: freshId('region'), content: { kind: 'plain-note', text: 'Area' } },
    }));

  tool('Revision cloud', 'Drag a loop across a wall.', () =>
    leader.authoring.markup.start({
      kind: 'revision-cloud',
      draft: { id: freshId('cloud'), content: { kind: 'plain-note', text: 'Revision 1' } },
    }));

  tool('Ink', 'Drag to draw a freehand stroke on a wall.', () =>
    leader.authoring.markup.start({ kind: 'ink', commit: { id: freshId('ink') } }));

  // Core reports readiness; committing is the host's decision, because a host may want a confirm
  // step. This page has none, so it commits immediately. Deferred one microtask because the
  // notification arrives from inside core's own publish and `complete()` opens a transaction.
  leader.authoring.markup.subscribe(() => {
    if (leader.authoring.markup.getSnapshot().phase !== 'ready') return;
    queueMicrotask(() => {
      if (leader.authoring.markup.getSnapshot().phase === 'ready') leader.authoring.markup.complete();
    });
  });

  // The live multi-point route: core publishes the preview points, the host draws them.
  mountAuthoringPreview(leader, viewport);

  // --- Legs ---------------------------------------------------------------------------------------
  const addLeg = controls.button('Add leg', () => {
    const id = selectedId();
    const count = id === undefined ? undefined : appendLeg(leader, id);
    if (count === undefined) return;
    syncControls();
    say(`${id} now has ${count} legs — drag the new arrowhead onto something`);
  });

  // No "a leader needs at least one leg" message: the button is disabled while the selection has one.
  const removeLeg = controls.button('Remove leg', () => {
    const id = selectedId();
    if (id === undefined) return;
    const legId = legSelect.element.value;
    leader.authoring.markup.removeAnchor(id, legId);
    syncControls();
    say(`Removed ${legId} from ${id}`);
  });

  const legSelect = controls.select('Leg', ['leg-1'], () => {
    // The leg drives which routing the box below reports, so changing it re-reads the document.
    syncControls();
    say(`Editing ${legSelect.element.value}. Routing below applies to it alone.`);
  });

  // Per leg, not per annotation: `reroute` writes the first leg, which is right for a single-leader
  // note and wrong the moment there are two.
  const routingSelect = controls.select('Leg routing', [...ROUTING_MODES], (mode) => {
    if (mode === MANUAL_ROUTING) return;
    const id = selectedId();
    if (id === undefined) return;
    const routing: AnnotationRouting = {
      kind: 'automatic',
      mode: mode as (typeof ROUTING_MODES)[number],
    };
    leader.annotations.rerouteLeg(id, legSelect.element.value, routing);
    say(`${id} · ${legSelect.element.value} routed ${mode}`);
  });

  // Eleven, read off the instance — not the six ids this page used to hard-code, which went stale the
  // moment a style was added and showed `builtin.style.tag-hexagon` to a reader either way. Every
  // definition already carries a drafter's name for itself; the id is what the API takes, not what a
  // person reads. `list` reports the palette this instance is drawing with, so a themed page is right
  // too.
  const styleOptions = leader.definitions.list('style').map(({ id, name }) => ({ value: id, label: name }));
  const styleSelect = controls.select('Style', styleOptions, (styleId) => {
    const id = selectedId();
    if (id === undefined) return;
    leader.annotations.update(id, { styleId });
    say(`${id} restyled ${leader.definitions.get(styleId)?.name ?? styleId}`);
  });

  // --- Arrange ------------------------------------------------------------------------------------
  // Buttons, not selects: these are commands, and a `<select>` fires `change` only when the value
  // CHANGES, so aligning left twice in a row was impossible — the second pick was the same value and
  // nothing fired. It also deletes the `'align…'` placeholder that existed only to give the box a
  // resting value. The labels carry the API's own words because this gallery is their reference.
  // Ordered by axis — the three horizontal edges, then the three vertical — so the pair of triples
  // reads as two groups rather than as six unrelated buttons.
  const ALIGN_EDGES: readonly AlignEdge[] = ['left', 'center-x', 'right', 'top', 'center-y', 'bottom'];
  const alignButtons = ALIGN_EDGES
    .map((edge) => controls.button(`Align ${edge}`, () => {
      leader.annotations.align(edge);
      say(`Aligned the selection ${edge} — marquee or shift-click to select more`);
    }));
  const distributeButtons = (['x', 'y'] as const)
    .map((axis) => controls.button(`Distribute ${axis}`, () => {
      leader.annotations.distribute(axis);
      say(`Distributed the selection along ${axis}`);
    }));

  // --- One pass that pushes document state back into the controls ---------------------------------
  // Every box reports the SELECTION, not the last value the user picked in it. Without this, clicking
  // a second leader left Style naming the first leader's style and Leg routing naming a mode this
  // leader never had — a control that lies is worse than no control. `set` deliberately does not fire
  // the change handler, so re-syncing after a mutation cannot re-enter the handler that caused it.
  //
  // The disabled states are the real preconditions, read out of `arrange.ts`: `alignMoves` needs two
  // boxes to align to each other and `distributeMoves` a third to put between them, and both are
  // deliberate no-ops below that. A live button that silently does nothing teaches the wrong thing.
  const syncControls = (): void => {
    const { selectedIds } = leader.annotations.getSnapshot();
    const id = selectedIds[0];
    const annotation = id === undefined ? undefined : leader.annotations.get(id);

    const available = annotation?.anchors.map((leg) => leg.id) ?? [];
    legSelect.options(available.length > 0 ? available : ['leg-1']);
    const routing = annotation?.anchors.find((leg) => leg.id === legSelect.element.value)?.routing;
    routingSelect.options(routing?.kind === 'manual'
      ? [{ value: MANUAL_ROUTING, label: 'manual (bends)' }, ...ROUTING_MODES]
      : [...ROUTING_MODES]);
    if (routing !== undefined) {
      routingSelect.set(routing.kind === 'automatic' ? routing.mode : MANUAL_ROUTING);
    }
    // An annotation with no `styleId` is drawn with the default style, which is the first one core
    // lists — reading the list beats repeating `builtin.style.standard`, which core does not export.
    if (annotation !== undefined) styleSelect.set(annotation.styleId ?? styleOptions[0]!.value);

    for (const button of alignButtons) button.disabled = selectedIds.length < 2;
    for (const button of distributeButtons) button.disabled = selectedIds.length < 3;
    addLeg.disabled = annotation === undefined;
    removeLeg.disabled = available.length < 2;
    legSelect.element.disabled = annotation === undefined;
    routingSelect.element.disabled = annotation === undefined;
    styleSelect.element.disabled = annotation === undefined;
  };

  // --- Save and load ------------------------------------------------------------------------------
  // `serialize` is the whole document as canonical bytes; `replace` swaps a live instance's document
  // without reconstructing it. Together they are the round trip a host needs for a file or a server.
  controls.button('Save', () => {
    window.localStorage.setItem(STORAGE_KEY, leader.documents.serialize());
    say('Saved to localStorage. Reload the page, then Load.');
  });
  controls.button('Load', () => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === null) {
      say('Nothing saved yet');
      return;
    }
    textEditor.close();
    // `parse` first so a corrupt payload throws before the live document is touched.
    leader.documents.replace(leader.documents.parse(saved));
    syncControls();
    say('Loaded. The instance was never reconstructed.');
  });

  // The inline text field: a box, a font and Enter, sitting on the rect `geometry.of` publishes.
  const textEditor = createTextEditor(leader, viewport, say);

  // --- Two gestures core also wants, on the same boundary ------------------------------------------
  // The right button pans now, and `contextmenu` fires on mouse-DOWN on macOS and mouse-UP
  // elsewhere — so without this a pan pops the browser menu either the instant it starts or the
  // instant it ends. OrbitControls suppresses it over the canvas already; this covers the SVG
  // overlay, which sits on top of the canvas and is where every annotation is.
  //
  // There is no host menu behind it on purpose. `/host-chrome/` builds that widget and the e2e
  // suite grades it there; every verb it offers is reachable here without one — Delete by the
  // Delete key, text by the double-click below, a bend by dragging the midpoint grip core already
  // draws, and reset placement/routing by page 12 and page 13.
  viewport.addEventListener('contextmenu', (event) => event.preventDefault());

  viewport.addEventListener('dblclick', (event) => {
    // A live multi-point session owns the double-click: core binds `dblclick` on this same boundary
    // to finish the route. Its listener is added after this one, so this one runs first and would
    // open the text editor on top of the leader the same gesture just committed — whenever the
    // route happens to finish over an existing label.
    if (leader.authoring.getSnapshot().phase !== 'idle') return;
    const hit = leader.editing.hitTestScreen(localPoint(event));
    if (hit?.kind === 'label') textEditor.open(hit.id);
  });

  // Undo, redo, select-all, Escape and Delete — the bindings every drawing tool uses.
  bindEditingKeys(leader, { say, onEscape: textEditor.close, afterHistory: syncControls });

  // Counts are read back out of the public snapshots on every document event, so the status line
  // cannot drift — and `render` preserves whatever the last action said rather than overwriting it.
  leader.annotations.subscribe(() => {
    syncControls();
    render();
  });

  syncControls();
  render();

  harness.onFrame(() => {
    leader.update();
    textEditor.place();
  });
  leader.update();

  // The control dock is painted over the viewport, and a label laid out underneath it is
  // invisible. Core never sees the host's DOM, so the page measures its own chrome and claims
  // that edge.
  claimChromeEdges(() => leader);

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
