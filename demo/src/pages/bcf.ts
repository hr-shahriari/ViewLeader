// "How do the annotations get out of the browser and into Solibri, Navisworks or Revit Issues?" is the
// first question anyone asks about a markup tool, and BCF 2.1 is the answer the industry settled on.
// The whole trip runs in memory here — notes → .bcfzip bytes → notes again — with no file dialog and no
// download: the archive is read straight back with `readArchive`, so you can see the real ZIP entry
// names and the topic GUIDs, which is more proof that the bytes are a file than a save dialog is.
import {
  ViewLeader,
  interchange,
  type Annotation,
  type BcfCameraState,
  type BcfExportDocument,
  type Vec3,
} from 'viewleader';
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

/** Which loaded model an imported component belongs to. A real host names the federation member. */
const MODEL_ID = 'building';
/**
 * BCF viewpoints are Z-up (IFC); three.js is Y-up. The flag has to be passed on BOTH ends, where the
 * two remaps cancel exactly — export with it and import without it and every note comes back on its
 * side. It is also the knob to reach for if a receiving application opens the file rotated.
 */
const AXES = { zUpToYUp: true } as const;
/** BCF stores a unit `CameraDirection` and no orbit distance, so an importer has to choose one. */
const ORBIT_DISTANCE = 20;

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);
  const { camera, controls } = harness;

  const adapters = createThreeAdapter({
    camera,
    renderer: harness.renderer,
    modelBounds: () => [building.root],
    occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
  });
  const leader = new ViewLeader({ boundary: harness.boundary, adapters });
  harness.onFrame(() => leader.update());

  // Element anchors, not world points, because an element id is all BCF can carry: a topic references
  // an IFC GlobalId and never a coordinate. These render at their fallback point — `three-anchoring`
  // is the example that resolves ids against a live model.
  const NOTES = [
    { id: 'roof', element: MOCK_ELEMENTS.roofSlab, title: 'Roof slab', text: 'Ponding at the north gutter. Confirm the falls.' },
    { id: 'door', element: MOCK_ELEMENTS.frontDoor, title: 'Front door', text: 'Clear width 900 mm required; the leaf shown is 1200.' },
    { id: 'column', element: MOCK_ELEMENTS.cornerColumn, title: 'Corner column', text: 'Fire rating missing from the schedule.' },
  ];
  for (const note of NOTES) {
    leader.annotations.create({
      id: note.id,
      anchor: {
        kind: 'element',
        modelId: MODEL_ID,
        elementId: note.element.id,
        fallbackPoint: note.element.point,
      },
      content: { kind: 'callout', title: note.title, text: note.text },
    });
  }
  leader.update();

  const vector = (source: { x: number; y: number; z: number }): Vec3 =>
    ({ x: source.x, y: source.y, z: source.z });

  /** The camera you are looking through, as a BCF viewpoint. */
  const viewpoint = (): BcfCameraState => {
    const dx = controls.target.x - camera.position.x;
    const dy = controls.target.y - camera.position.y;
    const dz = controls.target.z - camera.position.z;
    // Normalised, because `CameraDirection` is a direction and receivers are free to renormalise it.
    // `|| 1` guards the degenerate frame where the camera sits exactly on its own orbit target, which
    // would otherwise write three NaNs into the XML and take the whole topic down with it.
    const length = Math.hypot(dx, dy, dz) || 1;
    return {
      type: 'perspective',
      position: vector(camera.position),
      direction: { x: dx / length, y: dy / length, z: dz / length },
      up: vector(camera.up),
      fieldOfView: camera.fov,
      aspect: camera.aspect,
    };
  };

  const restore = (state: BcfCameraState): void => {
    camera.position.set(state.position.x, state.position.y, state.position.z);
    camera.up.set(state.up.x, state.up.y, state.up.z);
    if (state.type === 'perspective') camera.fov = state.fieldOfView;
    camera.updateProjectionMatrix();
    // The file gives a direction, not a target, so the orbit pivot is put at an arbitrary distance
    // along it. The framing is exact; only how far OrbitControls thinks the pivot sits is a guess.
    controls.target.set(
      state.position.x + state.direction.x * ORBIT_DISTANCE,
      state.position.y + state.direction.y * ORBIT_DISTANCE,
      state.position.z + state.direction.z * ORBIT_DISTANCE,
    );
    controls.update();
  };

  // A BCF topic wants a one-line title and a comment body. Splitting an annotation into those two is
  // host work: core has many content kinds and BCF has plain text.
  const partsOf = (annotation: Annotation): { title: string; body: string } => {
    const content = annotation.content;
    if (content.kind === 'callout') return { title: content.title ?? annotation.id, body: content.text };
    return { title: 'text' in content ? content.text : annotation.id, body: '' };
  };

  const elementsOf = (annotation: Annotation): string[] =>
    annotation.anchors.flatMap((leg) => (leg.anchor.kind === 'element' ? [leg.anchor.elementId] : []));

  /** Shortens the topic GUID prefixing every entry name so the status line stays readable. */
  const short = (name: string): string => name.replace(/^([0-9a-f]{8})[0-9a-f-]+\//u, '$1…/');

  /** The .bcfzip, held only in memory — this is what a host would hand to `showSaveFilePicker`. */
  let archive: Uint8Array | undefined;
  /**
   * Topics this host has already applied, which is how the import stays idempotent.
   *
   * By topic and not by annotation id on purpose: the topic GUID is the identity the FILE carries,
   * so it is the one thing that survives the archive being opened, edited and re-exported by
   * Solibri or Revit Issues. An annotation id is the planner's own construction, and a host that
   * maps components to anchors differently from this page would mint different ones from the same
   * bytes. Skipping whole topics also matches what a reviewer means by "already imported": the
   * viewpoint and every component hanging off it, not a subset of one issue.
   */
  const appliedTopics = new Set<string>();

  const exportArchive = async (): Promise<string> => {
    const live = leader.annotations.getSnapshot().annotations;
    const payload: BcfExportDocument = {
      // One topic per note, because a BCF topic IS an issue: one title, one viewpoint, one comment
      // thread, one row in Solibri's issue list. A topic carrying three notes exports fine and comes
      // back wrong — `planBcfApply` builds one annotation per component and gives each of them the
      // TOPIC's title, since nothing in the file says which comment belongs to which component.
      views: live.map((annotation) => ({
        id: annotation.id,
        name: partsOf(annotation).title,
        camera: viewpoint(),
        annotationIds: [annotation.id],
      })),
      annotations: live.map((annotation) => ({
        id: annotation.id,
        text: partsOf(annotation).body,
        elementIds: elementsOf(annotation),
      })),
    };
    archive = interchange.exportBcf(payload, {
      author: 'reviewer@example.test',
      ...AXES,
      // The host owns the id mapping: a BCF component is an IFC GlobalId and only the host knows
      // which of its own handles that is. This mock model already names elements with GlobalIds, so
      // it is a lookup and not a translation. Returning undefined DROPS the component, which is the
      // right answer — a guid the receiving application cannot find in its model is worse than none.
      elementToIfcGuid: (elementId) =>
        building.resolveElementPoint(elementId) === undefined ? undefined : elementId,
    });
    // `exportBcf` returns the finished archive; reading it straight back with `readArchive` is the
    // cheapest proof that it is a real ZIP rather than a blob we are calling one, and the entry names
    // are exactly what a reviewer would see after unzipping the file we did not download.
    const read = await interchange.readArchive(archive);
    if (!read.valid) throw new Error(read.errors.join('; '));
    const names = read.entries.map((entry) => short(entry.name));
    return `${(archive.byteLength / 1024).toFixed(1)} kB of BCF 2.1 · ${payload.views.length} topics · `
      + `${names.length} zip entries · ${names.slice(0, 3).join(', ')}, …`;
  };

  const clearDocument = (): string => {
    leader.history.transaction('Clear the document', () => {
      for (const { id } of leader.annotations.getSnapshot().annotations) leader.annotations.remove(id);
    });
    appliedTopics.clear();
    // Orbit away as well, so the viewpoint the import restores is visibly a restore and not luck.
    camera.position.set(-15, 4, -13);
    controls.target.set(0, 2.5, 0);
    controls.update();
    return 'Document empty, camera moved. The notes exist only as bytes now.';
  };

  const importArchive = async (): Promise<string> => {
    if (archive === undefined) throw new Error('Export first — there are no bytes to read back.');
    // Tolerant by contract: a truncated or hostile archive comes back as warnings plus whatever
    // topics survived, never as a throw. Surfacing them is the host's job, so they are thrown here
    // rather than swallowed — a silent zero-topic import is the failure nobody notices.
    const parsed = await interchange.parseBcf(archive, AXES);
    if (parsed.warnings.length > 0) throw new Error(parsed.warnings.join('; '));

    const plan = interchange.planBcfApply(parsed.topics, {
      // Importing the same file twice must not duplicate anything. The planner decides nothing on
      // its own about identity: tell it what has already landed and it skips those topics.
      appliedTopicIds: appliedTopics,
      // Turning an IFC GlobalId into an anchor is host work — only the host knows which model is
      // loaded and where that element sits. A component it cannot place is skipped, never guessed.
      componentToAnchor: (component) => {
        const point = building.resolveElementPoint(component);
        return point === undefined
          ? undefined
          : { kind: 'element', elementId: component, modelId: MODEL_ID, fallbackPoint: point };
      },
    });
    if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));

    // The plan is data and has touched nothing yet, which is what makes applying it in one
    // transaction possible: the whole import is a single undo step.
    const bodies = new Map(parsed.topics.map((topic) => [topic.id, topic.comments[0]?.text ?? '']));
    leader.history.transaction('Import BCF', () => {
      for (const planned of plan.annotations) {
        leader.annotations.create({
          id: planned.id,
          // Restated rather than spread: the planner types `modelId` as optional on its resolved
          // anchor and core's `ElementAnchor` requires it.
          anchor: {
            kind: 'element',
            modelId: MODEL_ID,
            elementId: planned.anchor.elementId,
            fallbackPoint: planned.anchor.fallbackPoint,
          },
          // `planned.text` is the topic title — all the planner can promise. The body is the topic's
          // first comment, paired back up because THIS page wrote one note per topic; BCF itself
          // does not tie a comment to a component, so a host with a different mapping does this
          // differently or leaves the body out.
          content: { kind: 'callout', title: planned.text, text: bodies.get(planned.topicId) ?? '' },
        });
      }
      for (const view of plan.views) appliedTopics.add(view.topicId);
    });

    // The visible half of the trip. Every topic here carries the same camera because all three were
    // written from one framing, so the first one is as good as any.
    const framing = plan.views[0]?.camera;
    if (framing) restore(framing);

    const skipped = plan.skippedIds.length;
    return `${parsed.topics.length} topics → ${plan.views.length} viewpoints, ${plan.annotations.length} notes`
      + `${skipped > 0 ? `, ${skipped} already applied` : ''}.`
      + `${framing ? ' Camera restored from the file.' : ''}`;
  };

  const bar = createControlBar();
  bar.button('Export BCF', async () => bar.status(await exportArchive()));
  bar.button('Clear the document', () => bar.status(clearDocument()));
  bar.button('Import BCF', async () => bar.status(await importArchive()));
  // Exported once on load so the bytes exist before anything is clicked: Import works on its own, and
  // the reader sees the archive before deciding to believe in it.
  bar.status(`${await exportArchive()} — now clear the document and import it back.`);

  // The control dock and the header's notes panel are both painted over the viewport, and a
  // label laid out underneath either one is invisible. Core never sees the host's DOM, so the
  // page measures its own chrome and claims those edges.
  claimChromeEdges(() => leader);

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
