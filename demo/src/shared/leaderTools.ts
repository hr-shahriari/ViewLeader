// The host-side toolkit the editing pages share: the raycast core cannot supply, one-shot tool
// arming, the authoring preview, an inline text field over a label, the drawing-tool key bindings
// and a single writer for the status line. Plain DOM over the public surface — `editing.hitTest`,
// `geometry.of`, `annotations.*`, `definitions.get`, `history.transaction` — which is the point:
// every one of these is something a host builds for itself, and core deliberately does not own.
import type {
  AnnotationContent,
  CalloutContent,
  PlainNoteContent,
  StyleDefinition,
  SurfacePickResult,
  TagContent,
  Vec2,
  ViewLeader,
} from 'viewleader';
import * as THREE from 'three';

const SVG_NS = 'http://www.w3.org/2000/svg';

// --- The raycast core cannot supply -------------------------------------------------------------
// Core has no scene and no raycaster by design. `castAt` answers "what is under the cursor";
// `pickSurface` adds the surface normal, which is what a region or ink stroke needs to establish
// the drawing plane it is then stored in. What a page's `pick` makes of a hit — a world point, an
// IFC element — is that page's own contract, so `pick` stays on the page, built over `castAt`. An
// anchor carries no normal, so it can never stand in for `pickSurface`.
export function createSurfacePicker(
  camera: THREE.Camera,
  root: () => THREE.Object3D | undefined,
): {
  castAt(pointer: Vec2): THREE.Intersection | undefined;
  pickSurface(pointer: Vec2): SurfacePickResult | null;
} {
  const raycaster = new THREE.Raycaster();
  const normalMatrix = new THREE.Matrix3();
  const castAt = (pointer: Vec2): THREE.Intersection | undefined => {
    const target = root();
    if (target === undefined) return undefined;
    raycaster.setFromCamera(new THREE.Vector2(pointer.x * 2 - 1, 1 - pointer.y * 2), camera);
    return raycaster.intersectObject(target, true)[0];
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
  return { castAt, pickSurface };
}

// --- One writer for the status line -------------------------------------------------------------
// The live counts change on every document event, and actions want to say what they just did. Two
// writers on one line race: whichever fires last wins, and after an async tool that is the counts.
// So there is one render, and it keeps the last thing an action said.
export function createStatusLine(
  leader: ViewLeader,
  status: (text: string) => void,
  initial = '',
): { render(): void; say(message: string): void } {
  let lastAction = initial;
  const render = (): void => {
    const { selectedIds, annotations } = leader.annotations.getSnapshot();
    const { undoCount, redoCount } = leader.history.getSnapshot();
    const state = `${annotations.length} leaders · ${selectedIds.length} selected · ${undoCount} undo / ${redoCount} redo`;
    status(lastAction === '' ? state : `${lastAction} · ${state}`);
  };
  return {
    render,
    say(message) {
      lastAction = message;
      render();
    },
  };
}

// --- Arming a tool ------------------------------------------------------------------------------
// Every tool is one-shot: core resolves the same promise whether it completed, was cancelled with
// Escape, lost the pointer off the viewport, or failed. So the toolbar disarms in exactly one
// place and there is no mode variable to leak.
export type ToolOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: { readonly message: string } };

export function createToolArmer(
  leader: ViewLeader,
  say: (message: string) => void,
  addButton: (label: string, action: () => Promise<void>) => HTMLButtonElement,
): (label: string, hint: string, run: () => Promise<ToolOutcome>) => HTMLButtonElement {
  let armed: HTMLButtonElement | undefined;
  const arm = (button: HTMLButtonElement | undefined): void => {
    armed?.setAttribute('aria-pressed', 'false');
    armed = button;
    button?.setAttribute('aria-pressed', 'true');
  };
  return (label, hint, run) => {
    const button = addButton(label, async () => {
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
      // Never console.error: a cancelled tool is an ordinary outcome, not a fault. Core's own
      // message is the useful one — "No model surface was found at that point" tells the user to
      // aim at the building, where a bare "failed" would not.
      say(
        outcome.status === 'completed' ? `${label}: created. Ctrl/⌘+Z undoes it.`
        : outcome.status === 'failed' ? `${label}: ${outcome.error.message}`
        : `${label}: cancelled (${outcome.reason})`,
      );
    });
    button.setAttribute('aria-pressed', 'false');
    return button;
  };
}

// --- The live multi-point route -----------------------------------------------------------------
// Core publishes `preview.vertices` and `preview.livePoint` already in screen pixels, but renders
// no authoring preview of its own — a host that wants to see the leader it is drawing draws it.
export function mountAuthoringPreview(leader: ViewLeader, viewport: HTMLElement): void {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'vl-authoring-preview');
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#4b6ef5');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-dasharray', '5 4');
  svg.append(line);
  viewport.append(svg);
  leader.authoring.subscribe(() => {
    const { preview } = leader.authoring.getSnapshot();
    const points = [...(preview?.vertices ?? []), ...(preview?.livePoint ? [preview.livePoint] : [])];
    line.setAttribute('points', points.map(({ x, y }) => `${x},${y}`).join(' '));
  });
}

// --- Legs ---------------------------------------------------------------------------------------
// A new leg lands on the anchor the last one used; the user then drags its arrowhead grip onto
// whatever it should point at, which core already does for free with `gestures: true` + `pick`.
// Returns how many legs the annotation now has, or `undefined` when there was nothing to add to.
export function appendLeg(leader: ViewLeader, id: string): number | undefined {
  const legs = leader.annotations.get(id)?.anchors;
  const last = legs?.at(-1);
  if (legs === undefined || last === undefined) return undefined;
  // The same rewind trap as a page's note ids, one scope down: remove `leg-1` and counting legs
  // would re-mint `leg-2`, which `document.ts` rejects as a duplicate leg id. Count past whatever
  // is already there instead of counting how many there are.
  const taken = new Set(legs.map((leg) => leg.id));
  let ordinal = taken.size + 1;
  while (taken.has(`leg-${ordinal}`)) ordinal += 1;
  leader.authoring.markup.addAnchor(id, {
    id: `leg-${ordinal}`,
    anchor: last.anchor,
    routing: { kind: 'automatic', mode: 'dogleg' },
  });
  return taken.size + 1;
}

// --- Inline text field --------------------------------------------------------------------------
// Core owns the box and the font and publishes both through `geometry.of`. What it cannot own is an
// HTML field over your viewport — spellcheck, IME, autocomplete, mobile keyboards. Colour, text
// alignment and the content padding are not on the geometry surface, so they come off the style
// definition, which is public too.
type TextContent = PlainNoteContent | TagContent | CalloutContent;
const asTextContent = (content: AnnotationContent): TextContent | undefined =>
  content.kind === 'plain-note' || content.kind === 'tag' || content.kind === 'callout'
    ? content
    : undefined;

export interface TextEditor {
  open(id: string): void;
  close(): void;
  /** Re-run every frame: the label moves with the camera, so the field has to move with the label. */
  place(): void;
}

export function createTextEditor(
  leader: ViewLeader,
  viewport: HTMLElement,
  say: (message: string) => void,
): TextEditor {
  const styleOf = (id: string): StyleDefinition | undefined => {
    const styleId = leader.annotations.get(id)?.styleId;
    const definition = styleId === undefined ? undefined : leader.definitions.get(styleId);
    return definition?.kind === 'style' ? definition : undefined;
  };

  let editor: { readonly id: string; readonly field: HTMLTextAreaElement } | undefined;
  const close = (): void => {
    // Forget the field before detaching it: removing a focused element fires `blur` synchronously,
    // and the blur handler below would otherwise commit and detach the same node a second time.
    const open = editor;
    editor = undefined;
    open?.field.remove();
  };

  const place = (): void => {
    if (editor === undefined) return;
    const geometry = leader.geometry.of(editor.id);
    if (geometry === undefined) {
      // Off screen this frame — there is no rect to sit on, and nothing to invent.
      editor.field.style.visibility = 'hidden';
      return;
    }
    const style = styleOf(editor.id);
    const align = style?.content?.align
      ?? (leader.annotations.get(editor.id)?.content.kind === 'tag' ? 'middle' : 'start');
    const { field } = editor;
    field.style.visibility = 'visible';
    field.style.left = `${geometry.label.x}px`;
    field.style.top = `${geometry.label.y}px`;
    field.style.width = `${geometry.label.width}px`;
    field.style.height = `${geometry.label.height}px`;
    field.style.fontFamily = geometry.text.fontFamily;
    field.style.fontSize = `${geometry.text.fontSize}px`;
    field.style.lineHeight = `${geometry.text.lineHeight}px`;
    field.style.padding = `${style?.content?.padding ?? 0}px`;
    field.style.textAlign = align === 'middle' ? 'center' : align === 'end' ? 'right' : 'left';
    if (style !== undefined) field.style.color = style.textColor;
  };

  const commit = (): void => {
    if (editor === undefined) return;
    const { id, field } = editor;
    const value = field.value;
    close();
    const content = leader.annotations.get(id)?.content;
    const text = content === undefined ? undefined : asTextContent(content);
    if (text === undefined || text.text === value) return;
    leader.annotations.update(id, { content: { ...text, text: value } });
    say(`${id} text committed — one undo step`);
  };

  const open = (id: string): void => {
    close();
    const content = leader.annotations.get(id)?.content;
    const text = content === undefined ? undefined : asTextContent(content);
    if (text === undefined) {
      say('That content kind carries no plain text');
      return;
    }
    const field = document.createElement('textarea');
    field.className = 'host-text-field';
    field.value = text.text;
    field.setAttribute('aria-label', `Text of ${id}`);
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      // Enter commits; Shift+Enter is a newline — which is why this is a textarea, not an input.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        commit();
      }
    });
    field.addEventListener('blur', () => commit());
    viewport.append(field);
    editor = { id, field };
    place();
    field.focus();
    field.select();
  };

  return { open, close, place };
}

// --- Keyboard -----------------------------------------------------------------------------------
// Core binds Escape while it holds a gesture, and nothing else. Undo, redo, select-all and Delete
// are the host's to name; these are the bindings every drawing tool uses. Bound on `window`,
// because they are app-global — and the host's own text field wins over its own shortcuts.
export function bindEditingKeys(
  leader: ViewLeader,
  options: {
    readonly say: (message: string) => void;
    /** Escape also closes whatever the page has open — its text field, a menu. */
    readonly onEscape: () => void;
    /** Undo and redo rewrite the document under the page's controls, which re-sync afterwards. */
    readonly afterHistory: () => void;
  },
): void {
  const { say, onEscape, afterHistory } = options;
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    const modifier = event.metaKey || event.ctrlKey;

    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      const moved = event.shiftKey ? leader.history.redo() : leader.history.undo();
      afterHistory();
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
      onEscape();
      leader.annotations.clearSelection();
      return;
    }
    const selected = leader.annotations.getSnapshot().selectedIds;
    if (selected.length > 0 && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      leader.history.transaction('Delete annotations', () => {
        for (const id of selected) leader.annotations.remove(id);
      });
      say(`Deleted ${selected.length} — one undo step`);
    }
  });
}
