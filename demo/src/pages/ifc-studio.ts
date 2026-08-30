// ViewLeader inside a viewer that looks like a viewer: a real IFC on screen, a model tree down the
// left, and an inspector down the right that edits every field of a leader's style live.
//
// The other pages each isolate one idea on an eight-box mock. This one is the integration picture —
// what an adopter's product actually looks like — and it is the only page where three things are
// true at once:
//
//   1. THE MODEL IS REAL. `shared/ifcModel.ts` parses `Duplex_A_20110907.ifc` in a worker. Nothing
//      about IFC crosses into ViewLeader: the seam is still `{ modelId, elementId }` and a world
//      point, exactly as `src/host.ts` defines it.
//   2. ANCHORS ARE IFC GlobalIds. `pick` below resolves the clicked mesh to its GlobalId and returns
//      an ELEMENT anchor, not a world point — so a leader survives the model being hidden, reloaded
//      or re-exported, and the saved document is meaningful outside this page.
//   3. CHROME OWNS THREE EDGES. Two docked panels, handed to `setViewportInsets`, so no label is
//      ever laid out underneath them.
//
// The boundary is #viewport, not the harness overlay div: the overlay is `pointer-events: none`, so
// listeners on it would only ever fire over an annotation. Same reasoning as `/leader-editor/`.
import {
  ViewLeader,
  mergeStyleOverride,
  readStyleOverride,
  type Anchor,
  type AnnotationContent,
  type AnnotationDraft,
  type AnnotationRouting,
  type CalloutContent,
  type PlainNoteContent,
  type StyleOverride,
  type SurfacePickResult,
  type TagContent,
  type Vec2,
} from 'viewleader';
import {
  createStableElementResolver,
  createThreeAdapter,
  createThreeElementInvalidationChannel,
} from 'viewleader/three';
import * as THREE from 'three';
import '../shared/example.css';
import { createSidePanel, type SelectOption } from '../shared/controls';
import {
  createExampleHarness,
  exposeExampleManager,
  markExampleFailed,
  markExampleReady,
} from '../shared/harness';
import { loadIfcModel, type IfcModel } from '../shared/ifcModel';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MODEL_ID = 'duplex';
const MODEL_URL = '/models/Duplex_A_20110907.ifc';
const ROUTING_MODES = ['dogleg', 'straight', 'orthogonal'] as const;
// A hand-bent leg is `{ kind: 'manual', vertices }` and carries no `mode`, so the routing box needs a
// fourth word to stay honest about a leg a dragged route grip bent by hand. Not a real mode: it is
// offered only when it is already true.
const MANUAL_ROUTING = 'manual';

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  let model: IfcModel | undefined;

  // --- The seam ------------------------------------------------------------------------------
  // Core has no scene and no raycaster by design. `pick` answers "what is under the cursor", and
  // here it answers with an IFC element rather than a coordinate — the whole reason this page loads
  // a real file. `pickSurface` adds the surface normal, which is what a region or ink stroke needs
  // to establish the plane it is stored in; an anchor carries no normal, so `pick` cannot stand in.
  const raycaster = new THREE.Raycaster();
  const normalMatrix = new THREE.Matrix3();
  const castAt = (pointer: Vec2): THREE.Intersection | undefined => {
    if (model === undefined) return undefined;
    raycaster.setFromCamera(new THREE.Vector2(pointer.x * 2 - 1, 1 - pointer.y * 2), harness.camera);
    return raycaster.intersectObject(model.root, true)[0];
  };

  const pick = (pointer: Vec2): Anchor | null => {
    const hit = castAt(pointer);
    if (hit === undefined) return null;
    const point = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    const elementId = model?.elementIdOf(hit.object);
    // The fallback point is not a formality: it is what the leader draws against while the model is
    // unloaded or the id no longer resolves, so it has to be the real point that was clicked.
    return elementId === undefined
      ? { kind: 'world-point', point }
      : { kind: 'element', modelId: MODEL_ID, elementId, fallbackPoint: point };
  };

  const pickSurface = (pointer: Vec2): SurfacePickResult | null => {
    const hit = castAt(pointer);
    const face = hit?.face;
    if (hit === undefined || face === undefined || face === null) return null;
    // Face normals are object-local; the plane has to be world-space or the geometry drawn on it
    // lands somewhere else entirely.
    const normal = face.normal.clone()
      .applyNormalMatrix(normalMatrix.getNormalMatrix(hit.object.matrixWorld))
      .normalize();
    return {
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      normal: { x: normal.x, y: normal.y, z: normal.z },
    };
  };

  // Element anchors are resolved through the host, and the host is this page. While `model` is
  // undefined the resolver reports no sources and every element anchor falls back to its stored
  // point — which is exactly the state the page is in for the first second, before the parse lands.
  const invalidations = createThreeElementInvalidationChannel();
  const resolveElement = createStableElementResolver(
    () => model === undefined ? [] : [{
      modelId: MODEL_ID,
      resolveStableElement: (elementId: string) => model?.elementAnchorPoint(elementId) ?? null,
    }],
    invalidations,
  );

  const leader = new ViewLeader({
    boundary: viewport,
    adapters: createThreeAdapter({
      camera: harness.camera,
      renderer: harness.renderer,
      resolveElement,
      elementInvalidations: invalidations,
      modelBounds: () => model === undefined ? [] : [model.root],
      // 0.25 m, in model units — Duplex is metric. An element anchor resolves to the CENTRE of the
      // element's bounds, so the ray reaches that element's own near face before the point it is
      // aiming at: half a 300 mm wall is 150 mm, half a 400 mm floor slab is 200 mm. On the
      // adapter's 0.1 mm default every one of those reads as "occluded by the thing it points at"
      // and the leaders draw permanently dashed. A real verdict here — an anchor on the far side of
      // the building — misses by metres, so an allowance this wide has nothing left to swallow.
      occlusion: { objects: () => model === undefined ? [] : [model.root], epsilon: 0.25 },
      pick,
      pickSurface,
      // Core takes an interaction lease for the length of a gesture and this adapter disables
      // OrbitControls while it is held, so an edit and an orbit can never run at once.
      controls: harness.controls,
    }),
    // `marquee: 'modifier'` asks for the rubber band on a shift- or alt-drag only. A marquee on
    // every plain left-press would take the interaction lease, which the adapter turns into
    // `controls.enabled = false`, killing left-drag orbit on a page whose subject is direct
    // manipulation.
    editing: { gestures: true, marquee: 'modifier' },
  });

  // --- Chrome ----------------------------------------------------------------------------------
  const panel = createSidePanel({ title: 'Inspector' });

  const tree = document.createElement('nav');
  tree.className = 'model-tree';
  tree.setAttribute('aria-label', 'Model tree');
  const treeHeading = document.createElement('h1');
  treeHeading.textContent = 'Model';
  const treeActions = document.createElement('div');
  treeActions.className = 'tree-actions';
  const treeBody = document.createElement('div');
  const treeEmpty = document.createElement('p');
  treeEmpty.className = 'tree-empty';
  treeEmpty.textContent = 'Loading Duplex_A…';
  treeBody.append(treeEmpty);
  tree.append(treeHeading, treeActions, treeBody);
  document.body.append(tree);

  // Core never sees the host's DOM, so it cannot know two panels are painted over the viewport. Both
  // edges are claimed from a measurement rather than a constant, because the panels are sized in
  // `ch`-ish units the reader's font can change.
  //
  // ponytail: local rather than in `shared/chromeInsets.ts`, which measures `.control-dock` and
  // claims the bottom edge for thirteen pages. Generalise that helper to take a set of elements and
  // derive all four edges when a second page needs a side panel.
  const BREATHING_ROOM = 8;
  const claimEdges = (): void => {
    const frame = viewport.getBoundingClientRect();
    const left = Math.max(0, Math.round(tree.getBoundingClientRect().right - frame.left + BREATHING_ROOM));
    const right = Math.max(0, Math.round(frame.right - panel.element.getBoundingClientRect().left + BREATHING_ROOM));
    leader.setViewportInsets({ top: 0, right, bottom: 0, left });
  };
  const insetObserver = new ResizeObserver(claimEdges);
  insetObserver.observe(tree);
  insetObserver.observe(panel.element);
  window.addEventListener('resize', claimEdges);

  // --- The status line -------------------------------------------------------------------------
  // One writer. The live counts change on every document event and actions want to say what they
  // just did; two writers on one line race, and after an async tool the counts always win.
  let lastAction = 'Loading the IFC…';
  const render = (): void => {
    const { selectedIds, annotations } = leader.annotations.getSnapshot();
    const { undoCount, redoCount } = leader.history.getSnapshot();
    panel.status(`${lastAction} · ${annotations.length} leaders · ${selectedIds.length} selected · ${undoCount} undo / ${redoCount} redo`);
  };
  const say = (message: string): void => {
    lastAction = message;
    render();
  };
  // `createSidePanel` reports a thrown button action through this event rather than the console —
  // the e2e suite fails a page on any console error, and a pick that missed the model is an
  // ordinary outcome, not a fault.
  panel.element.addEventListener('panel-error', (event) => {
    say((event as CustomEvent<string>).detail);
  });

  const selectedIds = (): readonly string[] => leader.annotations.getSnapshot().selectedIds;
  const selectedId = (): string | undefined => selectedIds()[0];

  const localPoint = (event: MouseEvent): Vec2 => {
    const bounds = viewport.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  // --- Two notes so the page is never empty ------------------------------------------------------
  // World points, not element anchors: nothing has been parsed yet, so there is no GlobalId to name.
  // These prove the overlay is live within one frame, which is also what lets `markExampleReady()`
  // fire before the multi-megabyte parse finishes. The element-anchored notes arrive with the model.
  for (const draft of [
    {
      id: 'welcome',
      anchor: { kind: 'world-point', point: { x: 0, y: 3.2, z: 0 } },
      content: { kind: 'callout', title: 'IFC studio', text: 'Pick a tool, click the model' },
    },
    {
      id: 'scale-note',
      anchor: { kind: 'world-point', point: { x: 0, y: 0.1, z: 0 } },
      content: { kind: 'plain-note', text: 'Project origin' },
      styleId: 'builtin.style.spot-elevation',
    },
  ] satisfies readonly AnnotationDraft[]) {
    leader.annotations.create(draft);
  }

  // --- Arming a tool ---------------------------------------------------------------------------
  // Every tool is one-shot: core resolves the same promise whether it completed, was cancelled with
  // Escape, lost the pointer off the viewport, or failed. So the toolbar disarms in exactly one
  // place and there is no mode variable to leak.
  const createSection = panel.section('Create');
  let armed: HTMLButtonElement | undefined;
  const arm = (button: HTMLButtonElement | undefined): void => {
    armed?.setAttribute('aria-pressed', 'false');
    armed = button;
    button?.setAttribute('aria-pressed', 'true');
  };

  type ToolOutcome =
    | { readonly status: 'completed' }
    | { readonly status: 'cancelled'; readonly reason: string }
    | { readonly status: 'failed'; readonly error: { readonly message: string } };

  const tool = (label: string, hint: string, run: () => Promise<ToolOutcome>): HTMLButtonElement => {
    const button = createSection.button(label, async () => {
      if (armed === button) {
        // A second press on the armed tool is "never mind" — the same exit Escape takes.
        leader.authoring.cancel();
        leader.authoring.markup.cancel();
        return;
      }
      arm(button);
      say(hint);
      const outcome = await run();
      arm(undefined);
      // Never console.error: a cancelled tool is an ordinary outcome. Core's own message is the
      // useful one — "No model surface was found at that point" tells the user to aim at the
      // building, where a bare "failed" would not.
      say(
        outcome.status === 'completed' ? `${label}: created. Ctrl/⌘+Z undoes it.`
        : outcome.status === 'failed' ? `${label}: ${outcome.error.message}`
        : `${label}: cancelled (${outcome.reason})`,
      );
    });
    button.setAttribute('aria-pressed', 'false');
    return button;
  };

  // Ids come off a monotonic counter, never off `annotations.length` and never off `Date.now()`.
  // Length rewinds when you delete something, so the next create collides and `annotations.create`
  // throws `DuplicateIdError`. A clock is worse: two markups committed in the same millisecond
  // collide, and the document stops being reproducible.
  let nextId = 0;
  const freshId = (prefix: string): string => `${prefix}-${(nextId += 1)}`;

  // The content kinds, which is the first sense of "kinds of leader". `host-image` is the one
  // built-in kind missing here: it needs an `images` adapter to resolve the reference, and this page
  // has no image library to resolve against.
  const CONTENT_KINDS: readonly { readonly label: string; readonly content: AnnotationContent }[] = [
    { label: 'Note', content: { kind: 'plain-note', text: 'New note' } },
    { label: 'Tag', content: { kind: 'tag', text: 'A-101' } },
    { label: 'Callout', content: { kind: 'callout', title: 'Callout', text: 'Describe the element' } },
    { label: 'Split', content: { kind: 'split-callout', primary: '3', secondary: 'A-501' } },
    { label: 'Symbol', content: { kind: 'symbolic-block', symbol: 'circle', label: 'C' } },
  ];
  for (const kind of CONTENT_KINDS) {
    tool(kind.label, `Click an element to place the ${kind.label.toLowerCase()}. Escape cancels.`, () =>
      leader.authoring.start({ draft: { id: freshId(kind.label.toLowerCase()), content: kind.content } }));
  }

  // The second sense: the geometry of the leader itself. The first click picks the world anchor AND
  // seeds the first route point; later clicks add route points in screen space with no pick; Enter
  // or double-click commits `{ kind: 'manual', vertices }`. Core binds all three itself.
  tool('Multi-point', 'Click the arrow point, then each bend. Enter or double-click finishes.', () =>
    leader.authoring.start({
      draft: { id: freshId('multi'), content: { kind: 'plain-note', text: 'Routed by hand' } },
      multiPoint: true,
    }));

  tool('Rectangle', 'Drag a rectangle across a surface.', () =>
    leader.authoring.markup.start({
      kind: 'rectangle',
      draft: { id: freshId('region'), content: { kind: 'plain-note', text: 'Area' } },
    }));
  tool('Revision cloud', 'Drag a loop across a surface.', () =>
    leader.authoring.markup.start({
      kind: 'revision-cloud',
      draft: { id: freshId('cloud'), content: { kind: 'plain-note', text: 'Revision 1' } },
    }));
  tool('Ink', 'Drag to draw a freehand stroke on a surface.', () =>
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

  // --- The live multi-point route ----------------------------------------------------------------
  // Core publishes `preview.vertices` and `preview.livePoint` already in screen pixels, but renders
  // no authoring preview of its own — a host that wants to see the leader it is drawing draws it.
  const previewSvg = document.createElementNS(SVG_NS, 'svg');
  previewSvg.setAttribute('class', 'vl-authoring-preview');
  const previewLine = document.createElementNS(SVG_NS, 'polyline');
  previewLine.setAttribute('fill', 'none');
  previewLine.setAttribute('stroke', '#4b6ef5');
  previewLine.setAttribute('stroke-width', '1.5');
  previewLine.setAttribute('stroke-dasharray', '5 4');
  previewSvg.append(previewLine);
  viewport.append(previewSvg);
  leader.authoring.subscribe(() => {
    const { preview } = leader.authoring.getSnapshot();
    const points = [...(preview?.vertices ?? []), ...(preview?.livePoint ? [preview.livePoint] : [])];
    previewLine.setAttribute('points', points.map(({ x, y }) => `${x},${y}`).join(' '));
  });

  // --- Leader section ----------------------------------------------------------------------------
  const leaderSection = panel.section('Leader');

  // Read off the instance, not hard-coded: every definition already carries a drafter's name for
  // itself, the id is what the API takes rather than what a person reads, and `list` reports the
  // palette THIS instance is drawing with, so a themed page would be right too.
  // The object form, not a bare string: the value is the id the API takes and the label is the
  // drafter's name for it, and the e2e suite asserts no raw `builtin.` id ever reaches option text.
  const definitionOptions = (
    kind: 'style' | 'enclosure' | 'terminator',
  ): readonly { readonly value: string; readonly label: string }[] =>
    leader.definitions.list(kind).map(({ id, name }) => ({ value: id, label: name }));
  const styleOptions = definitionOptions('style');

  const styleSelect = leaderSection.select('Style', styleOptions, (styleId) => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    leader.history.transaction('Assign style', () => {
      for (const id of ids) leader.annotations.update(id, { styleId });
    });
    say(`Restyled ${leader.definitions.get(styleId)?.name ?? styleId}`);
  });

  const legSelect = leaderSection.select('Leg', ['leg-1'], () => {
    // The leg drives which routing the box below reports, so changing it re-reads the document.
    syncPanel();
    say(`Editing ${legSelect.element.value}. Routing below applies to it alone.`);
  });

  // Per leg, not per annotation: `reroute` writes the first leg, which is right for a single-leader
  // note and wrong the moment there are two.
  const routingSelect = leaderSection.select('Routing', [...ROUTING_MODES], (mode) => {
    if (mode === MANUAL_ROUTING) return;
    const id = selectedId();
    if (id === undefined) return;
    const routing: AnnotationRouting = { kind: 'automatic', mode: mode as (typeof ROUTING_MODES)[number] };
    leader.annotations.rerouteLeg(id, legSelect.element.value, routing);
    say(`${id} · ${legSelect.element.value} routed ${mode}`);
  });

  // A new leg lands on the anchor the last one used; the user then drags its arrowhead grip onto
  // whatever it should point at, which core does for free with `gestures: true` + `pick`.
  const addLeg = leaderSection.button('Add leg', () => {
    const id = selectedId();
    const last = id === undefined ? undefined : leader.annotations.get(id)?.anchors.at(-1);
    if (id === undefined || last === undefined) return;
    // Same rewind trap as the note ids, one scope down: remove `leg-1` and the next add would
    // re-mint `leg-2`, which `document.ts` rejects as a duplicate leg id.
    const taken = new Set(leader.annotations.get(id)?.anchors.map((leg) => leg.id) ?? []);
    let ordinal = taken.size + 1;
    while (taken.has(`leg-${ordinal}`)) ordinal += 1;
    leader.authoring.markup.addAnchor(id, {
      id: `leg-${ordinal}`,
      anchor: last.anchor,
      routing: { kind: 'automatic', mode: 'dogleg' },
    });
    syncPanel();
    say(`${id} now has ${taken.size + 1} legs — drag the new arrowhead onto something`);
  });

  // No "a leader needs at least one leg" message: the button is disabled while the selection has one.
  const removeLeg = leaderSection.button('Remove leg', () => {
    const id = selectedId();
    if (id === undefined) return;
    const legId = legSelect.element.value;
    leader.authoring.markup.removeAnchor(id, legId);
    syncPanel();
    say(`Removed ${legId} from ${id}`);
  });

  // --- Appearance: one form over `StyleOverride` ---------------------------------------------------
  // `StyleOverride` is a typed partial of the style definition, deep-merged one level, so every
  // control below reaches exactly one field and leaves its neighbours alone. `patch` is the smallest
  // override that changes that field; `read` pulls the field back out.
  //
  // `read` takes the PARTIAL shape rather than `ResolvedStyle` so it serves both jobs from one
  // accessor: pass the resolved style to get the value being drawn, or pass the annotation's own
  // override to ask whether it sets this exact field. `ResolvedStyle` is structurally assignable to
  // the partial, so nothing is lost by widening it.
  //
  // That second job is why `ResolvedStyle.from` is not what lights the dot. `from` is keyed at the
  // top level, so `content` and `landing` each report ONE source for the whole group — setting a
  // fill colour marked Padding, Border and Corner radius as overridden too, which is a control
  // lying about the document. The annotation's own override answers exactly.
  interface AppearanceField<Value> {
    readonly label: string;
    read(style: StyleOverride): Value | undefined;
    patch(value: Value): StyleOverride;
  }
  type ColorField = AppearanceField<string>;
  type RangeField = AppearanceField<number> & {
    readonly bounds: { readonly min: number; readonly max: number; readonly step: number };
  };
  type ChoiceField = AppearanceField<string> & { options(): readonly SelectOption[] };

  const COLORS: readonly ColorField[] = [
    { label: 'Text', read: (s) => s.textColor, patch: (v) => ({ textColor: v }) },
    { label: 'Fill', read: (s) => s.content?.backgroundColor, patch: (v) => ({ content: { backgroundColor: v } }) },
    { label: 'Border', read: (s) => s.content?.borderColor, patch: (v) => ({ content: { borderColor: v } }) },
    { label: 'Leader', read: (s) => s.lineColor, patch: (v) => ({ lineColor: v }) },
  ];

  const RANGES: readonly RangeField[] = [
    { label: 'Fill opacity', bounds: { min: 0, max: 1, step: 0.05 }, read: (s) => s.content?.backgroundOpacity, patch: (v) => ({ content: { backgroundOpacity: v } }) },
    { label: 'Border width', bounds: { min: 0, max: 4, step: 0.1 }, read: (s) => s.content?.borderWidth, patch: (v) => ({ content: { borderWidth: v } }) },
    { label: 'Corner radius', bounds: { min: 0, max: 16, step: 1 }, read: (s) => s.content?.borderRadius, patch: (v) => ({ content: { borderRadius: v } }) },
    { label: 'Padding', bounds: { min: 0, max: 24, step: 1 }, read: (s) => s.content?.padding, patch: (v) => ({ content: { padding: v } }) },
    { label: 'Text size', bounds: { min: 6, max: 32, step: 0.5 }, read: (s) => s.fontSize, patch: (v) => ({ fontSize: v }) },
    { label: 'Leader width', bounds: { min: 0.1, max: 3, step: 0.05 }, read: (s) => s.lineWidth, patch: (v) => ({ lineWidth: v }) },
    { label: 'Landing length', bounds: { min: 0, max: 60, step: 1 }, read: (s) => s.landing?.length, patch: (v) => ({ landing: { length: v } }) },
    { label: 'Landing gap', bounds: { min: 0, max: 20, step: 1 }, read: (s) => s.landing?.gap, patch: (v) => ({ landing: { gap: v } }) },
  ];

  const CHOICES: readonly ChoiceField[] = [
    // Shape is the container the label is drawn in. There is no "none" option: an override is a
    // partial, so it can add a shape but cannot unset one — a style with no `enclosureId` draws a
    // plain box. "Reset overrides" is how you get back to the style's own answer.
    { label: 'Shape', options: () => definitionOptions('enclosure'), read: (s) => s.enclosureId, patch: (v) => ({ enclosureId: v }) },
    { label: 'Arrowhead', options: () => definitionOptions('terminator'), read: (s) => s.terminatorId, patch: (v) => ({ terminatorId: v }) },
    { label: 'Label end', options: () => definitionOptions('terminator'), read: (s) => s.labelTerminatorId, patch: (v) => ({ labelTerminatorId: v }) },
    { label: 'Text align', options: () => ['start', 'middle', 'end'], read: (s) => s.content?.align, patch: (v) => ({ content: { align: v as 'start' | 'middle' | 'end' } }) },
    { label: 'Text weight', options: () => ['normal', 'bold'], read: (s) => s.content?.weight, patch: (v) => ({ content: { weight: v as 'normal' | 'bold' } }) },
    { label: 'Landing side', options: () => ['auto', 'left', 'right', 'top', 'bottom'], read: (s) => s.landing?.side, patch: (v) => ({ landing: { side: v as 'auto' | 'left' | 'right' | 'top' | 'bottom' } }) },
    { label: 'Landing form', options: () => ['shoulder', 'underline', 'none'], read: (s) => s.landing?.render, patch: (v) => ({ landing: { render: v as 'shoulder' | 'underline' | 'none' } }) },
  ];

  /**
   * The read-modify-write `annotations.update` does NOT do for you.
   *
   * A patch REPLACES `styleOverride` wholesale rather than merging into it, so writing one field
   * without folding it into what is already there silently drops every other override on the
   * annotation. `mergeStyleOverride` and `readStyleOverride` are both public for exactly this.
   *
   * One transaction for the whole selection is one undo step; `coalesce` collapses a slider or
   * colour-picker drag — which fires on every step — into that same step rather than fifty of them.
   */
  const applyOverride = (patch: StyleOverride, continuing: boolean): void => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    leader.history.transaction('Restyle', () => {
      for (const id of ids) {
        const current = readStyleOverride(leader.annotations.get(id)?.styleOverride);
        leader.annotations.update(id, { styleOverride: mergeStyleOverride(current, patch) });
      }
    }, { coalesce: continuing });
  };

  const appearance = panel.section('Appearance');
  // `<input type="color">` accepts `#rrggbb` and nothing else; anything it cannot parse silently
  // becomes black, which would report a colour the drawing does not use.
  const HEX = /^#[0-9a-f]{6}$/iu;
  const colorControls = COLORS.map((field) => ({
    field,
    control: appearance.color(field.label, (value, continuing) => {
      applyOverride(field.patch(value), continuing);
      if (!continuing) say(`${field.label} colour set on ${selectedIds().length} leader(s)`);
    }),
  }));
  const rangeControls = RANGES.map((field) => ({
    field,
    control: appearance.range(field.label, field.bounds, (value, continuing) => {
      applyOverride(field.patch(value), continuing);
    }),
  }));
  const choiceControls = CHOICES.map((field) => ({
    field,
    control: appearance.select(field.label, field.options(), (value) => {
      applyOverride(field.patch(value), false);
      say(`${field.label} set on ${selectedIds().length} leader(s)`);
    }),
  }));

  const resetStyle = appearance.button('Reset overrides', () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    // `null` is the documented clear; `undefined` would be rejected as a malformed patch.
    leader.history.transaction('Clear style overrides', () => {
      for (const id of ids) leader.annotations.update(id, { styleOverride: null });
    });
    syncPanel();
    say(`Cleared overrides on ${ids.length} leader(s) — back to the style`);
  });

  const deleteSelection = appearance.button('Delete', () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    leader.history.transaction('Delete annotations', () => {
      for (const id of ids) leader.annotations.remove(id);
    });
    say(`Deleted ${ids.length} — one undo step`);
  });

  // --- One pass that pushes document state back into the controls --------------------------------
  // Every control reports the SELECTION, not the last value the user picked in it. Without this,
  // clicking a second leader leaves Fill showing the first leader's colour — and a control that lies
  // is worse than no control. `set` deliberately does not fire the change handler, so re-syncing
  // after a mutation cannot re-enter the handler that caused it.
  function syncPanel(): void {
    const ids = selectedIds();
    const id = ids[0];
    const annotation = id === undefined ? undefined : leader.annotations.get(id);
    const style = id === undefined ? undefined : leader.annotations.resolvedStyle(id);
    // The annotation's own layer, not the resolved one: this is what "overridden" means.
    const own = readStyleOverride(annotation?.styleOverride);
    const empty = annotation === undefined;

    const legIds = annotation?.anchors.map((leg) => leg.id) ?? [];
    legSelect.options(legIds.length > 0 ? legIds : ['leg-1']);
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

    for (const { field, control } of colorControls) {
      const value = style === undefined ? undefined : field.read(style);
      control.set(value !== undefined && HEX.test(value) ? value : undefined);
      control.disabled(empty);
      control.overridden(!empty && field.read(own) !== undefined);
    }
    for (const { field, control } of rangeControls) {
      control.set(style === undefined ? undefined : field.read(style));
      control.disabled(empty);
      control.overridden(!empty && field.read(own) !== undefined);
    }
    for (const { field, control } of choiceControls) {
      const value = style === undefined ? undefined : field.read(style);
      if (value !== undefined) control.set(value);
      control.element.disabled = empty;
      control.element.parentElement?.classList.toggle(
        'is-overridden',
        !empty && field.read(own) !== undefined,
      );
    }

    styleSelect.element.disabled = empty;
    legSelect.element.disabled = empty;
    routingSelect.element.disabled = empty;
    addLeg.disabled = empty;
    // The real precondition: a leader must keep at least one leg.
    removeLeg.disabled = legIds.length < 2;
    resetStyle.disabled = empty;
    deleteSelection.disabled = ids.length === 0;
  }

  // --- Inline text field --------------------------------------------------------------------------
  // The minimum that works. `/host-chrome/` has the thorough version: IME, blur-reentrancy, per-style
  // padding and alignment copied off the definition. This one only needs a box, a font and Enter.
  type TextContent = PlainNoteContent | TagContent | CalloutContent;
  const asTextContent = (content: AnnotationContent): TextContent | undefined =>
    content.kind === 'plain-note' || content.kind === 'tag' || content.kind === 'callout'
      ? content
      : undefined;

  let editor: { readonly id: string; readonly field: HTMLTextAreaElement } | undefined;
  const closeEditor = (): void => {
    const open = editor;
    editor = undefined;
    open?.field.remove();
  };

  /** Re-run every frame: the label moves with the camera, so the field moves with the label. */
  const placeEditor = (): void => {
    if (editor === undefined) return;
    const geometry = leader.geometry.of(editor.id);
    if (geometry === undefined) {
      editor.field.style.visibility = 'hidden';
      return;
    }
    const { field } = editor;
    field.style.visibility = 'visible';
    field.style.left = `${geometry.label.x}px`;
    field.style.top = `${geometry.label.y}px`;
    field.style.width = `${geometry.label.width}px`;
    field.style.height = `${geometry.label.height}px`;
    field.style.fontFamily = geometry.text.fontFamily;
    field.style.fontSize = `${geometry.text.fontSize}px`;
    field.style.lineHeight = `${geometry.text.lineHeight}px`;
  };

  const commitEditor = (): void => {
    if (editor === undefined) return;
    const { id, field } = editor;
    const value = field.value;
    closeEditor();
    const content = leader.annotations.get(id)?.content;
    const text = content === undefined ? undefined : asTextContent(content);
    if (text === undefined || text.text === value) return;
    leader.annotations.update(id, { content: { ...text, text: value } });
    say(`${id} text committed — one undo step`);
  };

  const openEditor = (id: string): void => {
    closeEditor();
    const content = leader.annotations.get(id)?.content;
    if (content === undefined || asTextContent(content) === undefined) {
      say('That content kind carries no plain text');
      return;
    }
    const field = document.createElement('textarea');
    field.className = 'host-text-field';
    field.value = asTextContent(content)!.text;
    field.setAttribute('aria-label', `Text of ${id}`);
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeEditor();
      // Enter commits, Shift+Enter is a newline — which is why this is a textarea.
      else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        commitEditor();
      }
    });
    field.addEventListener('blur', () => commitEditor());
    viewport.append(field);
    editor = { id, field };
    placeEditor();
    field.focus();
    field.select();
  };

  // The right button pans, and `contextmenu` fires on mouse-DOWN on macOS and mouse-UP elsewhere —
  // so without this a pan pops the browser menu either the instant it starts or the instant it ends.
  // OrbitControls suppresses it over the canvas already; this covers the SVG overlay on top of it.
  viewport.addEventListener('contextmenu', (event) => event.preventDefault());

  viewport.addEventListener('dblclick', (event) => {
    // A live multi-point session owns the double-click: core binds `dblclick` on this same boundary
    // to finish the route, and its listener is added after this one.
    if (leader.authoring.getSnapshot().phase !== 'idle') return;
    const hit = leader.editing.hitTestScreen(localPoint(event));
    if (hit?.kind === 'label') openEditor(hit.id);
  });

  // Core binds Escape while it holds a gesture, and nothing else. Undo, redo and Delete are the
  // host's to name; this page uses the bindings every drawing tool uses.
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    const modifier = event.metaKey || event.ctrlKey;

    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      const moved = event.shiftKey ? leader.history.redo() : leader.history.undo();
      syncPanel();
      say(moved ? (event.shiftKey ? 'Redone' : 'Undone') : `Nothing to ${event.shiftKey ? 'redo' : 'undo'}`);
      return;
    }
    if (modifier && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      // Selection is runtime state, so select-all costs no history entry.
      leader.annotations.select(leader.annotations.getSnapshot().annotations.map(({ id }) => id));
      say('Selected all');
      return;
    }
    if (event.key === 'Escape') {
      closeEditor();
      leader.annotations.clearSelection();
      return;
    }
    if (selectedIds().length > 0 && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      const ids = selectedIds();
      leader.history.transaction('Delete annotations', () => {
        for (const id of ids) leader.annotations.remove(id);
      });
      say(`Deleted ${ids.length} — one undo step`);
    }
  });

  leader.annotations.subscribe(() => {
    syncPanel();
    render();
  });

  syncPanel();
  claimEdges();
  render();

  harness.onFrame(() => {
    leader.update();
    placeEditor();
  });
  leader.update();

  exposeExampleManager(leader);
  // Ready before the parse, deliberately. Two notes are already on screen and the overlay is live;
  // waiting on a multi-megabyte IFC would make readiness mean "the host finished loading", which is
  // not what this attribute is for and would put a several-second parse inside every e2e timeout.
  requestAnimationFrame(() => markExampleReady());

  // --- The model ---------------------------------------------------------------------------------
  const frame = (box: THREE.Box3): void => {
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);
    const distance = radius / Math.sin((harness.camera.fov * Math.PI) / 360);
    harness.camera.position.copy(centre).add(
      new THREE.Vector3(0.72, 0.52, 0.9).normalize().multiplyScalar(distance),
    );
    harness.camera.near = Math.max(distance / 1000, 0.01);
    harness.camera.far = distance * 10;
    harness.camera.updateProjectionMatrix();
    harness.controls.target.copy(centre);
    harness.controls.update();
  };

  const NAME_LIMIT = 30;
  const shortName = (name: string): string =>
    name.length <= NAME_LIMIT ? name : `${name.slice(0, NAME_LIMIT - 1).trimEnd()}…`;

  const buildTree = (loaded: IfcModel): void => {
    treeBody.replaceChildren();
    const rows: { readonly element: HTMLElement; readonly object: THREE.Object3D }[] = [];

    const setVisible = (object: THREE.Object3D, row: HTMLElement, visible: boolean): void => {
      object.visible = visible;
      row.classList.toggle('is-hidden', !visible);
      row.querySelector('.tree-eye')?.setAttribute('aria-pressed', String(visible));
    };

    for (const group of loaded.groups) {
      // `<details>` is the disclosure widget: keyboard, focus and screen-reader semantics included,
      // and closed by default because Duplex has a few hundred elements.
      const details = document.createElement('details');
      details.className = 'tree-group';
      const summary = document.createElement('summary');
      summary.append(group.type);
      const count = document.createElement('span');
      count.className = 'tree-count';
      count.textContent = String(group.elements.length);
      summary.append(count);
      details.append(summary);

      for (const element of group.elements) {
        const row = document.createElement('div');
        row.className = 'tree-row';

        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'tree-name';
        name.textContent = shortName(element.name);
        name.title = `${element.name} · ${element.globalId}`;
        name.addEventListener('click', () => {
          frame(new THREE.Box3().setFromObject(element.object));
          say(`${element.name} · ${element.globalId}`);
        });

        const eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'tree-eye';
        eye.textContent = '👁';
        eye.setAttribute('aria-pressed', 'true');
        eye.setAttribute('aria-label', `Toggle ${element.name}`);
        eye.addEventListener('click', () => {
          setVisible(element.object, row, !element.object.visible);
          // A leader anchored to a hidden element keeps drawing, on purpose: the anchor is an id,
          // not a mesh, and losing the note when you hide its host is how review comments get lost.
          leader.update();
        });

        row.append(name, eye);
        details.append(row);
        rows.push({ element: row, object: element.object });
      }
      treeBody.append(details);
    }

    treeActions.replaceChildren();
    for (const [label, visible] of [['Show all', true], ['Hide all', false]] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        for (const row of rows) setVisible(row.object, row.element, visible);
        leader.update();
      });
      treeActions.append(button);
    }
  };

  loadIfcModel(MODEL_URL, {
    onProgress: (elements) => say(`Parsing the IFC — ${elements} elements`),
  })
    .then((loaded) => {
      model = loaded;
      harness.scene.add(loaded.root);
      frame(new THREE.Box3().setFromObject(loaded.root));
      buildTree(loaded);
      // Element anchors were reporting `unresolved` while the model was absent. Telling the adapter
      // the model arrived is what makes them resolve — the same call `/ifc-lifecycle/` makes to
      // recover from an unload.
      invalidations.invalidate({ modelId: MODEL_ID });

      // Three notes on real IFC elements, so the page opens on something worth inspecting. These are
      // ELEMENT anchors: their ids are GlobalIds out of the file, and they mean the same thing in a
      // BCF issue or in another tool.
      // Ranked, not looked up by name: `GetNameFromTypeCode` reports `IfcDoor`, not `IFCDOOR`, and a
      // hard-coded list that misses is a silent no-op — this page opened with nothing to inspect
      // until that casing was checked against a real file. Sorting means an IFC carrying none of
      // these still seeds from whatever classes it does have.
      const PREFERRED = ['IfcWallStandardCase', 'IfcDoor', 'IfcWindow', 'IfcSlab', 'IfcRoof'];
      const rank = (type: string): number => {
        const index = PREFERRED.indexOf(type);
        return index === -1 ? PREFERRED.length : index;
      };
      const seeded = [...loaded.groups]
        .sort((a, b) => rank(a.type) - rank(b.type))
        .map((group) => group.elements[0])
        .filter((element) => element !== undefined)
        .slice(0, 3);

      leader.history.transaction('Seed element notes', () => {
        for (const element of seeded) {
          const centre = new THREE.Box3().setFromObject(element.object).getCenter(new THREE.Vector3());
          leader.annotations.create({
            id: freshId('element'),
            anchor: {
              kind: 'element',
              modelId: MODEL_ID,
              elementId: element.globalId,
              fallbackPoint: { x: centre.x, y: centre.y, z: centre.z },
            },
            // Trimmed: real IFC names are type designators, not captions —
            // `M_Casement:819mm x 759mm:819mm x 759mm:148607` is one element's actual `Name`, and
            // seeding it whole gives a label wider than the building it points at. The full string
            // is still on the tree row's tooltip, which is where a long identifier belongs.
            content: { kind: 'callout', title: element.type, text: shortName(element.name) },
          });
        }
      });

      leader.update();
      say(`Duplex loaded — ${loaded.groups.length} IFC classes. Pick a tool, then click an element.`);
    })
    .catch((error: unknown) => {
      // The page is still usable: the two world-point notes are on screen and every tool still works
      // against an empty scene. Say what happened in the panel, never on the console — the e2e suite
      // fails a page on a console error, and a missing fixture is a host problem, not a core one.
      treeEmpty.textContent = 'The model could not be loaded.';
      say(`IFC load failed: ${error instanceof Error ? error.message : String(error)}`);
    });
} catch (error) {
  markExampleFailed(error);
}
