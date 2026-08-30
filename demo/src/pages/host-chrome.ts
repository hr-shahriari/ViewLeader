// The four widgets core deliberately does not own: a context menu, a grip menu, keyboard bindings
// and an inline text field. Core publishes the geometry and the intent; the chrome is yours.
//
// Why core does not own them:
//   menus  — every AEC app has its own menu look, submenus, icons and i18n. Core rendering HTML into
//            its SVG overlay would be core owning your design system.
//   keys   — bindings are app-global and collide. `Del` means "delete annotation" here and "delete
//            selected element" in your app. You bind, you decide precedence, you call.
//   text   — core owns the box and the font and publishes both, but the field needs your spellcheck,
//            your IME, your equipment-database autocomplete and your mobile keyboard.
//
// Everything below uses only the public surface: `editing.hitTest`, `geometry.of`, `annotations.*`,
// `definitions.get` and `history.transaction`. Nothing is imported from library internals.
import {
  ViewLeader,
  type AnnotationContent,
  type AnnotationDraft,
  type AnnotationRouting,
  type CalloutContent,
  type PlainNoteContent,
  type StyleDefinition,
  type TagContent,
  type Vec2,
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

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);

  const adapters = createThreeAdapter({
    camera: harness.camera,
    renderer: harness.renderer,
    modelBounds: () => [building.root],
    occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
  });
  // No `editing: { gestures: true }`, on purpose: this page's subject is that the four widgets below
  // are buildable out of the published surface alone, and core binding its own pointer listeners
  // would be a second opinion about what a press means. The cost is that core still draws grips on a
  // selected annotation — they are its hit targets for the grip menu — and a small square that looks
  // draggable and is not is a false affordance. Nothing to fix in code: the honest fix is to say so,
  // which the status line below does. `/direct-editing/` is the page where the same grips drag.
  const leader = new ViewLeader({ boundary: harness.boundary, adapters });

  const drafts: readonly AnnotationDraft[] = [
    {
      id: 'roof',
      anchor: { kind: 'world-point', point: MOCK_ELEMENTS.roofSlab.point },
      content: { kind: 'plain-note', text: 'Roof slab — double-click to retitle' },
      styleId: 'builtin.style.standard',
    },
    {
      id: 'door',
      anchor: { kind: 'world-point', point: MOCK_ELEMENTS.frontDoor.point },
      content: { kind: 'callout', title: 'Entrance', text: 'Right-click for the host menu' },
      styleId: 'builtin.style.note',
    },
    {
      id: 'column',
      anchor: { kind: 'world-point', point: MOCK_ELEMENTS.cornerColumn.point },
      content: { kind: 'tag', text: 'C-01' },
      styleId: 'builtin.style.tag-circle',
    },
  ];
  for (const draft of drafts) leader.annotations.create(draft);

  const controls = createControlBar();

  // --- Pointer plumbing -------------------------------------------------------------------------
  // One conversion serves both jobs. `geometry.of` reports screen pixels and `editing.hitTestScreen`
  // takes them, so the point that positions the menu is the same point that finds what is under it.
  //
  // Listeners go on the app's viewport, not on the ViewLeader boundary: the boundary is
  // `pointer-events: none` so orbit drags fall through to the canvas, which means only an
  // annotation's own hit target would ever be an event target inside it.
  const localPoint = (event: MouseEvent): Vec2 => {
    const bounds = viewport.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  // --- The menu widget (both menus are the same widget) -----------------------------------------
  type MenuItem = readonly [label: string, run: () => void];
  let menu: HTMLElement | undefined;
  const closeMenu = (): void => {
    menu?.remove();
    menu = undefined;
  };
  const openMenu = (at: Vec2, items: readonly MenuItem[]): void => {
    closeMenu();
    const element = document.createElement('div');
    element.className = 'host-menu';
    element.setAttribute('role', 'menu');
    element.style.left = `${at.x}px`;
    element.style.top = `${at.y}px`;
    for (const [label, run] of items) {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.textContent = label;
      item.addEventListener('click', () => {
        closeMenu();
        run();
      });
      element.append(item);
    }
    viewport.append(element);
    menu = element;
  };

  // --- Route edits, host-side -------------------------------------------------------------------
  // `annotations.reroute` writes the FIRST leg, which is right for a single-leader note and wrong
  // for a multi-leader. A grip names a leg, so a grip menu wants the per-leg verb.
  const rerouteLeg = (id: string, legId: string, routing: AnnotationRouting): void => {
    leader.annotations.rerouteLeg(id, legId, routing);
  };
  const manualVertices = (id: string, legId: string): readonly Vec2[] => {
    const routing = leader.annotations.get(id)?.anchors.find((leg) => leg.id === legId)?.routing;
    return routing?.kind === 'manual' ? routing.vertices : [];
  };

  // --- Context menu on an annotation, grip menu on a grip ---------------------------------------
  // One hit test serves both. The renderer also writes `data-annotation-id` and `data-hit-target`,
  // so `event.target.closest('[data-annotation-id]')` is a fine host-side hit test for the
  // annotation menu — but grips are drawn `pointer-events: none` (core hit-tests them
  // geometrically), so they can never be a DOM event target and only `hitTest` finds them.
  viewport.addEventListener('contextmenu', (event) => {
    // Core never binds `contextmenu`. Suppressing the browser menu is the host's call, not core's.
    event.preventDefault();
    const hit = leader.editing.hitTestScreen(localPoint(event));
    if (hit === undefined) {
      closeMenu();
      controls.status('Empty space — nothing to act on');
      return;
    }
    const at = localPoint(event);
    if (hit.kind === 'route-handle') {
      const handle = leader.geometry.of(hit.id)?.routeHandles[hit.index ?? -1];
      if (handle === undefined) return;
      const vertices = manualVertices(hit.id, handle.target);
      if (handle.kind === 'vertex') {
        openMenu(at, [
          ['Remove this bend', () => {
            const kept = vertices.filter((_, index) => index !== handle.index);
            // The last bend removed means the leg has nothing manual left to say, so hand routing
            // back to the layout engine rather than persisting an empty vertex list.
            if (kept.length === 0) leader.annotations.resetRouting(hit.id, 'dogleg');
            else rerouteLeg(hit.id, handle.target, { kind: 'manual', vertices: kept });
            controls.status(`Removed bend ${handle.index} of ${hit.id}`);
          }],
        ]);
        return;
      }
      openMenu(at, [
        ['Add a bend here', () => {
          rerouteLeg(hit.id, handle.target, {
            kind: 'manual',
            vertices: [
              ...vertices.slice(0, handle.index),
              handle.at,
              ...vertices.slice(handle.index),
            ],
          });
          controls.status(`Bent ${hit.id} — right-click the diamond to remove it`);
        }],
      ]);
      return;
    }
    openMenu(at, [
      ['Edit text…', () => openEditor(hit.id)],
      ['Reset placement', () => {
        leader.annotations.resetPlacement(hit.id);
        controls.status(`${hit.id} placement is automatic again`);
      }],
      ['Reset routing', () => {
        leader.annotations.resetRouting(hit.id, 'dogleg');
        controls.status(`${hit.id} routing is automatic again`);
      }],
      ['Delete', () => {
        leader.annotations.remove(hit.id);
        controls.status(`Deleted ${hit.id} — Ctrl/⌘+Z restores it`);
      }],
    ]);
  });

  // A press outside the menu dismisses it. Presses on the menu itself must survive, or the click
  // that follows would land on a removed button.
  viewport.addEventListener('pointerdown', (event) => {
    if (menu?.contains(event.target as Node) !== true) closeMenu();
  });

  // --- Inline text field ------------------------------------------------------------------------
  // The close case in the audit: core owns the box and the font, and publishes both. What it cannot
  // own is an HTML field over your viewport — spellcheck, IME, autocomplete, mobile keyboards.
  type TextContent = PlainNoteContent | TagContent | CalloutContent;
  const asTextContent = (content: AnnotationContent): TextContent | undefined =>
    content.kind === 'plain-note' || content.kind === 'tag' || content.kind === 'callout'
      ? content
      : undefined;

  // `geometry.of(id).text` publishes the resolved family, size and line height. Colour, text
  // alignment and the content padding are not on that surface, so they come off the style
  // definition, which is public too.
  const styleOf = (id: string): StyleDefinition | undefined => {
    const styleId = leader.annotations.get(id)?.styleId;
    const definition = styleId === undefined ? undefined : leader.definitions.get(styleId);
    return definition?.kind === 'style' ? definition : undefined;
  };

  let editor: { readonly id: string; readonly field: HTMLTextAreaElement } | undefined;
  const closeEditor = (): void => {
    // Forget the field before detaching it: removing a focused element fires `blur` synchronously,
    // and the blur handler below would otherwise commit and detach the same node a second time.
    const open = editor;
    editor = undefined;
    open?.field.remove();
  };

  /** Re-run every frame: the label moves with the camera, so the field has to move with the label. */
  const placeEditor = (): void => {
    if (editor === undefined) return;
    const geometry = leader.geometry.of(editor.id);
    if (geometry === undefined) {
      // Off screen this frame — there is no rect to sit on, and nothing to invent.
      editor.field.style.visibility = 'hidden';
      return;
    }
    const style = styleOf(editor.id);
    const align = style?.content?.align ?? (leader.annotations.get(editor.id)?.content.kind === 'tag' ? 'middle' : 'start');
    const field = editor.field;
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

  const commitEditor = (): void => {
    if (editor === undefined) return;
    const { id, field } = editor;
    const value = field.value;
    closeEditor();
    const content = leader.annotations.get(id)?.content;
    const text = content === undefined ? undefined : asTextContent(content);
    if (text === undefined || text.text === value) return;
    leader.annotations.update(id, { content: { ...text, text: value } });
    controls.status(`${id} text committed — one undo step`);
  };

  const openEditor = (id: string): void => {
    closeEditor();
    const content = leader.annotations.get(id)?.content;
    const text = content === undefined ? undefined : asTextContent(content);
    if (text === undefined) {
      controls.status('That content kind carries no plain text');
      return;
    }
    const field = document.createElement('textarea');
    field.className = 'host-text-field';
    field.value = text.text;
    field.setAttribute('aria-label', `Text of ${id}`);
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeEditor();
        return;
      }
      // Enter commits; Shift+Enter is a newline — which is why this is a textarea, not an input.
      if (event.key === 'Enter' && !event.shiftKey) {
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

  viewport.addEventListener('dblclick', (event) => {
    const hit = leader.editing.hitTestScreen(localPoint(event));
    if (hit?.kind === 'label') openEditor(hit.id);
  });

  // --- Keyboard ---------------------------------------------------------------------------------
  // Bound by the host on `window`, because these keys are app-global. Core listens for `keydown`
  // only to cancel a gesture it already has in flight (Escape) — it never claims Del, the arrows or
  // ⌘A, so nothing here collides with it.
  const nudge = (delta: Vec2, ids: readonly string[], repeat: boolean): void => {
    // One transaction is one undo step for the whole selection, and `coalesce` makes a *run* of
    // held-down keys one step too. The caller opts in from `KeyboardEvent.repeat`, because only the
    // caller knows a repeat is happening — core has no clock and never guesses from timing.
    //
    // Not optional bookkeeping: each `keydown` arrives in its own task, so without this a held arrow
    // pushes an entry per repeat and evicts the whole 100-entry history in about three seconds.
    leader.history.transaction('Nudge annotations', () => {
      for (const id of ids) {
        const label = leader.geometry.of(id)?.label;
        if (label !== undefined) leader.annotations.move(id, { x: label.x + delta.x, y: label.y + delta.y });
      }
    }, { coalesce: repeat });
  };

  const NUDGE: Readonly<Record<string, Vec2>> = {
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
  };

  window.addEventListener('keydown', (event) => {
    // The host decides precedence, and its own text field wins over its own shortcuts.
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    const selected = leader.annotations.getSnapshot().selectedIds;

    if (event.key === 'Escape') {
      closeMenu();
      closeEditor();
      leader.annotations.clearSelection();
      controls.status('Escape: menu closed, selection cleared');
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      // Selection is runtime state, not document state, so select-all costs no history entry.
      leader.annotations.select(leader.annotations.getSnapshot().annotations.map((entry) => entry.id));
      controls.status('Selected all — grips are now visible. Right-click one for its menu;'
        + ' dragging them is what /direct-editing/ is for');
      return;
    }
    if (selected.length === 0) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      leader.history.transaction('Delete annotations', () => {
        for (const id of selected) leader.annotations.remove(id);
      });
      controls.status(`Deleted ${selected.length} — one undo step`);
      return;
    }
    const delta = NUDGE[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    nudge({ x: delta.x * step, y: delta.y * step }, selected, event.repeat);
    controls.status(event.repeat
      ? `Nudging ${selected.length} — the whole run is still one undo step`
      : `Nudged ${selected.length} by ${step} px — one undo step`);
  });

  controls.button('Undo', () => {
    controls.status(leader.history.undo() ? 'Undone' : 'Nothing to undo');
  });
  controls.button('Redo', () => {
    controls.status(leader.history.redo() ? 'Redone' : 'Nothing to redo');
  });
  controls.status(
    'Click to select · right-click a label or a grip for its menu · double-click a label to retitle '
    + '· arrows, Del, ⌘A, Esc. Grips here are right-click targets only — /direct-editing/ is where '
    + 'they drag.',
  );

  // --- The fifth thing core does not own: which screen edges are yours --------------------------
  // The control dock is real chrome — `position: fixed`, painted over the viewport, and it takes the
  // pointer first. A label underneath it is visible and un-clickable, which is worse than a label
  // that moved. So the page measures its own chrome and tells ViewLeader; core cannot guess it,
  // because core never sees your DOM. The measuring is shared with the other fourteen examples —
  // the notes panel above is chrome too, and used to hide labels on every page in the gallery.
  claimChromeEdges(() => leader);

  harness.onFrame(() => {
    leader.update();
    placeEditor();
  });
  leader.update();

  exposeExampleManager(leader);
  requestAnimationFrame(() => markExampleReady());
} catch (error) {
  markExampleFailed(error);
}
