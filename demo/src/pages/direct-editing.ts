// Editing a leader with the mouse, with no gesture code of your own.
//
// `editing: { gestures: true }` is the whole opt-in. Core then attaches pointer listeners to the
// boundary you gave it and runs the drags: move a label, drag an arrowhead onto a different element,
// bend the route by a grip, rubber-band a selection (shift- or alt-drag here — see `marquee` below).
// Every gesture is one undo step and Escape cancels it. Nothing below is a pointer handler.
//
// Two arrangement details this page exists to show, because they are what a real host must get right:
//
//   1. THE BOUNDARY IS THE VIEWPORT, not an overlay div on top of it. Core's SVG is
//      `pointer-events: none`, so it never swallows anything; but the element you pass has to be one
//      that actually receives pointer events, or core's listeners only ever fire over an annotation
//      and a drag freezes the moment it leaves the label. Every other example passes a
//      `pointer-events: none` overlay div, which is right for them — they take no gestures. The
//      harness still creates that div; this page simply does not use it.
//
//   2. CORE AND ORBIT SHARE THE MOUSE WITHOUT EITHER GIVING UP A BUTTON. Every button keeps the
//      three.js meaning a visitor already expects: left orbits, right pans, middle dollies. Core
//      takes an interaction lease for the duration of a gesture and the `controls` adapter disables
//      OrbitControls while it is held, so a left-drag that began on an annotation edits and can
//      never also orbit. A left-drag that began anywhere else is declined outright — see the
//      `editing:` option below, which is the half that buys the camera back.
import { ViewLeader, mm, type AnnotationDraft, type Vec2 } from 'viewleader';
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
import { MOCK_ELEMENTS, SELF_OCCLUSION_EPSILON, createMockBuilding } from '../shared/mockBuilding';

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);

  // Raycast for the anchor-grip drag. Dropping an arrowhead somewhere core cannot resolve to a world
  // point is not something core can invent an answer for — it has no scene and no raycaster by
  // design — so without this adapter an anchor drag honestly reverts.
  const raycaster = new THREE.Raycaster();
  const pick = (pointer: { x: number; y: number }): { kind: 'world-point'; point: Vec2 & { z: number } } | null => {
    raycaster.setFromCamera(new THREE.Vector2(pointer.x * 2 - 1, 1 - pointer.y * 2), harness.camera);
    const [hit] = raycaster.intersectObject(building.root, true);
    return hit === undefined
      ? null
      : { kind: 'world-point', point: { x: hit.point.x, y: hit.point.y, z: hit.point.z } };
  };

  // A grid the labels can snap to. Toggled at runtime by flipping `snapping`, because `strategies`
  // is fixed at construction — the hook is installed once and decides for itself whether to act.
  const GRID = mm(6);
  let snapping = false;

  // The grid, drawn. Without it "Snap to grid: on" moves labels to lines nobody can see, so the one
  // effect this page exists to show reads as jitter. Two tiled CSS gradients at the same pitch and
  // the same origin as `Math.round(x / GRID) * GRID` above, so a label lands on a line you can point
  // at when you release it — no per-frame work, and nothing to redraw when the camera moves, because
  // the grid is screen space and so is the snap. A drop is stored against its anchor, not as a screen
  // pin, so a snapped label leaves its line as the camera turns: re-snapping every frame would make
  // labels hop between cells during an orbit, so the grid is where a drop LANDS, not where it lives.
  // Align and Distribute still write absolute pins, so aligning a dragged label stops it following.
  // `pointer-events: none` is not optional: this element covers
  // the very viewport core's gesture listeners are bound to. Appended before `new ViewLeader`, so
  // core's SVG stacks above it and the grid can never sit on top of an annotation.
  const gridOverlay = document.createElement('div');
  gridOverlay.className = 'snap-grid';
  gridOverlay.hidden = true;
  gridOverlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
    + 'background-image:linear-gradient(to right,rgba(90,86,78,0.22) 1px,transparent 1px),'
    + 'linear-gradient(to bottom,rgba(90,86,78,0.22) 1px,transparent 1px);'
    + `background-size:${GRID}px ${GRID}px;`;
  viewport.append(gridOverlay);

  const adapters = createThreeAdapter({
    camera: harness.camera,
    renderer: harness.renderer,
    modelBounds: () => [building.root],
    occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
    pick,
    // Held for the length of a gesture. The adapter sets `controls.enabled = false` while core owns
    // the pointer, so an edit and an orbit can never run at once.
    controls: harness.controls,
  });

  const leader = new ViewLeader({
    boundary: viewport,
    adapters,
    // The wheel is the one camera input the overlay can still swallow: a label's hit pad takes
    // pointer events, so a scroll over a label never reaches the canvas and zoom dies over every
    // annotation on the page. Core re-dispatches it; a wheel that already passed through the canvas
    // on its own way up is left alone, so nothing is delivered twice.
    forwardWheelTo: harness.renderer.domElement,
    // `marquee: 'modifier'` asks for the rubber band back, on a shift- or alt-drag only. It is an
    // opt-in here, not a repair: because this page hands core an interaction adapter — `controls`
    // above — the default is already `'none'`, so core never takes the lease on empty space and
    // OrbitControls' own pointerdown, which fired first on the canvas below, runs to completion.
    // A marquee on every plain left-press would take the lease, which the adapter turns into
    // `controls.enabled = false`, and left-drag orbit would die: a first-time visitor drags the
    // model, sees nothing move, and reads the page as broken before touching an annotation. The
    // workaround for that used to be unbinding the left button and moving orbit onto the right,
    // which cost pan as well: no orbit and no pan, on the page whose whole subject is dragging
    // things. Shift and alt are the same two modifiers the marquee already reads to add to and
    // subtract from the selection.
    editing: { gestures: true, marquee: 'modifier' },
    strategies: {
      // Screen-space, called for every automatically placed label AND for the live drag preview, so
      // what you see mid-drag is exactly what is committed on release.
      snap: (proposed) => snapping
        ? { x: Math.round(proposed.x / GRID) * GRID, y: Math.round(proposed.y / GRID) * GRID }
        : proposed,
    },
  });

  const drafts: readonly AnnotationDraft[] = [
    {
      id: 'roof',
      anchor: { kind: 'world-point', point: MOCK_ELEMENTS.roofSlab.point },
      content: { kind: 'plain-note', text: 'Roof slab' },
      styleId: 'builtin.style.standard',
    },
    {
      id: 'door',
      anchor: { kind: 'world-point', point: MOCK_ELEMENTS.frontDoor.point },
      content: { kind: 'plain-note', text: 'Front door' },
      styleId: 'builtin.style.note',
    },
    {
      id: 'window',
      anchor: { kind: 'world-point', point: { x: 3.05, y: 2.6, z: 0 } },
      content: { kind: 'tag', text: 'W-12' },
      styleId: 'builtin.style.tag-circle',
    },
    {
      id: 'column',
      anchor: { kind: 'world-point', point: MOCK_ELEMENTS.cornerColumn.point },
      content: { kind: 'symbolic-block', symbol: 'circle', label: 'C' },
      styleId: 'builtin.style.grid-bubble',
      routing: { kind: 'automatic', mode: 'orthogonal' },
    },
  ];
  for (const draft of drafts) leader.annotations.create(draft);

  const controls = createControlBar();

  // Everything below is a toolbar over the public surface. None of it is a gesture — the gestures
  // are core's, and this page contains no pointer handler at all.
  controls.button('Align left', () => {
    leader.annotations.align('left');
    controls.status(describe());
  });

  controls.button('Distribute vertically', () => {
    leader.annotations.distribute('y');
    controls.status(describe());
  });

  const snapButton = controls.button('Snap to grid: off', () => {
    snapping = !snapping;
    snapButton.textContent = `Snap to grid: ${snapping ? 'on' : 'off'}`;
    gridOverlay.hidden = !snapping;
    leader.update();
    controls.status(describe());
  });

  controls.button('Reset all edits', () => {
    // One transaction, so undoing a reset restores every leader at once.
    leader.history.transaction('Reset edits', () => {
      for (const { id } of drafts) {
        leader.annotations.resetPlacement(id!);
        leader.annotations.resetRouting(id!, id === 'column' ? 'orthogonal' : 'dogleg');
      }
    });
    controls.status(describe());
  });

  controls.button('Undo', () => {
    leader.history.undo();
    controls.status(describe());
  });

  // What a first-time visitor should try. It has to be in the status line, because on load the
  // counts below are three zeros that never once say this is the page you drag things on.
  const OPENING = 'Drag a label to move it · drag its arrowhead onto another part of the model';

  /** Reads the live state back out of the public snapshots, so the status line cannot drift. */
  function describe(): string {
    const { selectedIds } = leader.annotations.getSnapshot();
    const { undoCount } = leader.history.getSnapshot();
    const edited = drafts.filter(({ id }) => {
      const annotation = leader.annotations.get(id!);
      return annotation?.placement.kind === 'manual'
        || annotation?.anchors.some((leg) => leg.routing.kind === 'manual');
    }).length;
    const counts = `${selectedIds.length} selected · ${edited} edited · ${undoCount} undo steps`;
    // The invitation stays up until it is answered, then gets out of the way on its own. Nothing to
    // reset, and nothing to remember: the document itself says whether it is still needed.
    return undoCount === 0 && selectedIds.length === 0 ? `${OPENING} · ${counts}` : counts;
  }

  /** The drag kinds this page can produce, in words a reader wants rather than state-machine tokens. */
  const DRAGGING: Readonly<Record<string, string>> = {
    label: 'Dragging the label — release to place it, Escape to cancel',
    handle: 'Dragging the arrowhead — drop it on another part of the model, Escape to cancel',
    vertex: 'Bending the leader — release to keep the bend, Escape to cancel',
    midpoint: 'Adding a bend — release to keep it, Escape to cancel',
  };

  // Core publishes its gesture phase, so a host can drive a cursor, a status bar or a modal guard
  // without guessing. This is the same snapshot shape `authoring` uses. Phrased rather than printed:
  // `dragging · label` is a debug token, and this line is the only instruction on the page.
  leader.editing.subscribe(() => {
    const { phase, kind } = leader.editing.getSnapshot();
    const live = phase === 'dragging'
      ? DRAGGING[kind ?? ''] ?? 'Dragging — Escape to cancel'
      : phase === 'picking'
        ? 'Working out what the arrowhead was dropped on…'
        : phase === 'marquee'
          ? 'Rubber-band selecting — release to take everything the box covers'
          // `idle`, and `pressed`, which is a press still under the drag threshold: nothing has
          // happened yet, so saying something would be claiming a gesture that may never start.
          : undefined;
    controls.status(live ?? describe());
  });
  leader.annotations.subscribe(() => controls.status(describe()));

  controls.status(describe());

  harness.onFrame(() => leader.update());
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
