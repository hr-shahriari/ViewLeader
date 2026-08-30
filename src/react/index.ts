// React binding. Two hooks, no components and no context: ViewLeader draws into an SVG layer it
// owns, so there is nothing here for React to render — only a lifetime to manage.
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react';
import {
  ViewLeader,
  type ViewLeaderOptions,
} from '../index.js';
import { BoundaryLifecycle, type BoundaryOptions, type SnapshotSource } from './core.js';
import { subscribeFrame } from '../internal/frame-seam.js';
import { FollowRegistry } from '../internal/follow.js';
import {
  HandlesController,
  type HandleEntry,
  type HandlesTarget,
} from '../internal/handles.js';
import {
  TextEditorController,
  type TextEditorCloseReason,
  type TextEditorSnapshot,
} from '../internal/text-editor.js';
import { EditingKeyboard, type EditingKeyboardOptions } from '../internal/keyboard.js';
import {
  StyleEditor,
  type StyleEditorOptions,
  type StyleEditorSnapshot,
} from '../internal/style-editor.js';
import {
  TemplateDraft,
  type TemplateDraftOptions,
  type TemplateDraftSnapshot,
} from '../internal/template-draft.js';

export type ReactViewLeaderOptions = Omit<ViewLeaderOptions, 'boundary'>;
export type BoundaryRefCallback = (element: HTMLElement | null) => void;

export interface ReactViewLeaderBinding {
  /**
   * Put this on the element the viewer actually draws into. It is a callback ref, not a ref object,
   * because the hook needs to be told when the element appears and when it is swapped out.
   */
  readonly boundaryRef: BoundaryRefCallback;
  readonly viewLeader: ViewLeader | null;
}

/**
 * Creates and owns one ViewLeader for one viewer element.
 *
 * Nothing is built until React hands over the mounted element, so importing this module or
 * rendering it on a server does not try to touch the DOM. When the element changes the old
 * instance is disposed and a new one takes its place; when the component unmounts it is disposed.
 *
 * `viewLeader` is `null` until the element exists — guard on it before calling in.
 */
export function useViewLeader(
  options: ReactViewLeaderOptions,
): ReactViewLeaderBinding {
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const [boundary, setBoundary] = useState<HTMLElement | null>(null);
  const [viewLeader, setViewLeader] = useState<ViewLeader | null>(null);
  const boundaryRef = useCallback<BoundaryRefCallback>((element) => {
    setBoundary((current) => (current === element ? current : element));
  }, []);

  useEffect(() => {
    // `BoundaryLifecycle` owns the identity rule — the element itself decides whether this is still
    // the same viewer — so the effect only has to say *when* to ask, never what the answer is. One
    // lifecycle per mount, because `dispose()` is terminal and a development double-mount must not
    // find a dead one waiting for it.
    const lifecycle = new BoundaryLifecycle<ReactViewLeaderOptions & BoundaryOptions, ViewLeader>(
      (resolved) => new ViewLeader(resolved),
    );
    const instance = lifecycle.update({ ...latestOptions.current, boundary });
    setViewLeader(instance);
    return () => {
      lifecycle.dispose();
      setViewLeader((current) => (current === instance ? null : current));
    };
  }, [boundary]);

  return { boundaryRef, viewLeader };
}

/**
 * Re-renders your component whenever one of ViewLeader's capabilities changes.
 *
 * Works with any of them — `annotations`, `authoring`, `documents`, `history`, `views`. Built on
 * `useSyncExternalStore`, so a render never shows a half-applied change even under concurrent
 * rendering. Returns `null` while the capability is not there yet.
 */
export function useViewLeaderSnapshot<Snapshot>(
  capability: SnapshotSource<Snapshot> | null | undefined,
): Snapshot | null {
  const subscribe = useCallback(
    (listener: () => void) => capability?.subscribe(listener) ?? noop,
    [capability],
  );
  const getSnapshot = useCallback(
    () => capability?.getSnapshot() ?? null,
    [capability],
  );
  return useSyncExternalStore(subscribe, getSnapshot, nullSnapshot);
}

/**
 * Pins your own elements to annotations — a toolbar beside a label, your own drag handles, an editor
 * over the text.
 *
 * The library writes each element's position after every frame, outside React's render cycle. That
 * is not an optimisation: `geometry.of()` is valid for exactly one frame and a camera move fires no
 * DOM event, so positioning from render state would mean `setState` at 60 Hz and rendering from
 * numbers that are already stale.
 *
 * One call per component serves any number of elements, which is what makes a variable number of
 * handles expressible. Returns `null` until the `ViewLeader` exists, the same contract
 * `useViewLeader` uses — render followed elements only once you have one.
 *
 * ```tsx
 * const { boundaryRef, viewLeader } = useViewLeader(options);
 * const follow = useFollow(viewLeader);
 * return (
 *   <div ref={boundaryRef}>
 *     {follow && <div ref={follow.ref({ kind: 'label', id: 'note' })} className="toolbar" />}
 *   </div>
 * );
 * ```
 */
export function useFollow(
  viewLeader: ViewLeader | null | undefined,
): FollowRegistry | null {
  const [registry, setRegistry] = useState<FollowRegistry | null>(null);

  useEffect(() => {
    if (viewLeader === null || viewLeader === undefined) {
      setRegistry(null);
      return undefined;
    }
    const instance = new FollowRegistry({
      geometry: viewLeader.geometry,
      subscribe: (listener) => subscribeFrame(viewLeader, listener),
    });
    setRegistry(instance);
    return () => {
      instance.dispose();
      setRegistry((current) => (current === instance ? null : current));
    };
  }, [viewLeader]);

  return registry;
}

/**
 * Binds the four editing keys — arrows nudge, Shift+arrow nudges further, Delete removes, Escape
 * clears the selection — on the document that owns the viewer.
 *
 * Undo and redo are deliberately not bound: undo scope is application scope, and a library claiming
 * Cmd/Ctrl+Z cannot know whose stack the user meant. A focused input keeps its own keys.
 *
 * Returns nothing — there is no state here a component could render, only a lifetime.
 */
export function useEditingKeyboard(
  viewLeader: ViewLeader | null | undefined,
  options: EditingKeyboardOptions = {},
): void {
  const { enabled } = options;
  useEffect(() => {
    if (viewLeader === null || viewLeader === undefined) return undefined;
    const controller = new EditingKeyboard(
      viewLeader,
      ...(enabled === undefined ? [] : [{ enabled }]),
    );
    return () => controller.dispose();
    // `enabled` rather than `options`, so a caller passing a fresh object literal every render does
    // not tear the listener down and rebuild it on each one.
  }, [viewLeader, enabled]);
}

/**
 * The state behind a "save this as a template" dialog: a scratch buffer that validates as the user
 * types, previews onto the selection, and commits as one undo step.
 *
 * Returns `null` until the `ViewLeader` exists, matching {@link useViewLeader}. Pair it with
 * {@link useTemplateDraftSnapshot} to re-render as the draft changes.
 */
export function useTemplateDraft(
  viewLeader: ViewLeader | null | undefined,
  options: Omit<TemplateDraftOptions, keyof import('../internal/template-draft.js').TemplateDraftPorts> = {},
): TemplateDraft | null {
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const [draft, setDraft] = useState<TemplateDraft | null>(null);

  useEffect(() => {
    if (viewLeader === null || viewLeader === undefined) {
      setDraft(null);
      return undefined;
    }
    const instance = new TemplateDraft({
      definitions: viewLeader.definitions,
      history: viewLeader.history,
      annotations: viewLeader.annotations,
      ...latestOptions.current,
    });
    setDraft(instance);
    return () => {
      // Unmounting the dialog is how a template actually gets cancelled — nobody clicks Discard on
      // the way out — so without this a preview stays applied to the drawing after the thing that
      // applied it has gone.
      instance.dispose();
      setDraft((current) => (current === instance ? null : current));
    };
  }, [viewLeader]);

  return draft;
}

/** Re-renders as a template draft changes. `null` until the draft exists. */
export function useTemplateDraftSnapshot(
  draft: TemplateDraft | null,
): TemplateDraftSnapshot | null {
  return useViewLeaderSnapshot(draft);
}

/**
 * Edits the style of whatever is selected.
 *
 * Reads through `annotations.resolvedStyle`, so a panel shows what is actually being drawn — the
 * active saved view's override included, which a host cannot compute for itself. Fields the
 * selection disagrees on report `mixed`. Every write is read-modify-write and lands as one undo
 * step, because `update({ styleOverride })` replaces an override wholesale.
 *
 * Returns `null` until the `ViewLeader` exists. Pair with {@link useStyleEditorSnapshot}.
 */
export function useStyleEditor(
  viewLeader: ViewLeader | null | undefined,
  options: StyleEditorOptions = {},
): StyleEditor | null {
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const [editor, setEditor] = useState<StyleEditor | null>(null);

  useEffect(() => {
    if (viewLeader === null || viewLeader === undefined) {
      setEditor(null);
      return undefined;
    }
    const instance = new StyleEditor(
      { annotations: viewLeader.annotations, history: viewLeader.history },
      latestOptions.current,
    );
    setEditor(instance);
    return () => { setEditor((current) => (current === instance ? null : current)); };
  }, [viewLeader]);

  return editor;
}

/** Re-renders as the selection or its resolved style changes. `null` until the editor exists. */
export function useStyleEditorSnapshot(
  editor: StyleEditor | null,
): StyleEditorSnapshot | null {
  return useViewLeaderSnapshot(editor);
}

/**
 * An inline editor for a label's text: double-click, type in place, blur or Enter to commit.
 *
 * Pass the registry from {@link useFollow} and the field tracks the label — and keeps its caret if
 * the camera orbits the label off screen, which is why it opts out of the hide behaviour rather
 * than being hidden and blurred mid-sentence.
 *
 * Returns `null` until the `ViewLeader` exists. `<LabelTextEditor>` renders it; use this directly
 * only if you want markup other than a `textarea`.
 */
export function useLabelTextEditor(
  viewLeader: ViewLeader | null | undefined,
  follow?: FollowRegistry | null,
  onClose?: (reason: TextEditorCloseReason) => void,
): TextEditorController | null {
  const latestOnClose = useRef(onClose);
  latestOnClose.current = onClose;
  const [controller, setController] = useState<TextEditorController | null>(null);

  useEffect(() => {
    if (viewLeader === null || viewLeader === undefined) {
      setController(null);
      return undefined;
    }
    const instance = new TextEditorController({
      host: viewLeader,
      ...(follow === null || follow === undefined ? {} : { follow }),
      onClose: (reason) => latestOnClose.current?.(reason),
    });
    setController(instance);
    return () => {
      instance.dispose();
      setController((current) => (current === instance ? null : current));
    };
  }, [viewLeader, follow]);

  return controller;
}

/** Re-renders as the editor opens, closes or its value changes. `null` until it exists. */
export function useLabelTextEditorSnapshot(
  editor: TextEditorController | null,
): TextEditorSnapshot | null {
  return useViewLeaderSnapshot(editor);
}

export interface LabelTextEditorProps {
  readonly editor: TextEditorController | null;
  /** Everything else lands on the `textarea`, so styling stays entirely yours. */
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * The one component this package ships.
 *
 * It earns that exception because the markup carries real knowledge rather than being a `{...props}`
 * wrapper: the field has to sit on the text it replaces without the glyphs jumping, which means the
 * resolved font metrics the follow registry writes as CSS custom properties, and it has to commit
 * and cancel on the right events. Everything else here is a hook returning props you spread on your
 * own element.
 *
 * Renders nothing while no editor is open.
 */
export function LabelTextEditor({ editor, className, style }: LabelTextEditorProps): ReactElement | null {
  const snapshot = useViewLeaderSnapshot(editor);
  if (editor === null || snapshot === null || snapshot.annotationId === null) return null;
  return createElement('textarea', {
    ref: editor.ref,
    ...snapshot.props,
    ...(className === undefined ? {} : { className }),
    style: {
      // The registry writes position, size and the metrics; these three are what make the box sit
      // *on* the text rather than beside it, and they are the host's to override.
      position: 'absolute',
      top: 0,
      left: 0,
      fontFamily: 'var(--vl-font-family)',
      fontSize: 'var(--vl-font-size)',
      lineHeight: 'var(--vl-line-height)',
      color: 'var(--vl-text-color)',
      padding: 'var(--vl-padding)',
      ...style,
    },
  });
}

/**
 * Your own drag handles for one annotation, instead of the built-in ones.
 *
 * Each entry carries a stable key, its kind, a follow target and pointer props already routed to
 * the right drag — the four-way `begin*Drag` switch is hidden, because the value here is pointer
 * normalisation and capture, not the switch. Capture matters: without it a host drawing its own
 * handles gets no capture, no Escape and no cursor.
 *
 * The set freezes for the duration of a drag. Route handles are derived from stored routing crossed
 * with previewed points, so mid-gesture the live set renumbers underneath the handle being dragged;
 * freezing is what keeps the grabbed one under the pointer.
 *
 * Returns `null` until both the `ViewLeader` and a follow registry exist.
 */
export function useHandles(
  viewLeader: ViewLeader | null | undefined,
  follow: FollowRegistry | null | undefined,
  target: HandlesTarget,
): HandlesController | null {
  const [controller, setController] = useState<HandlesController | null>(null);
  const latestTarget = useRef(target);
  latestTarget.current = target;
  // A dependency that compares by value, so `{ ink: 'a' }` rebuilt each render is still the same
  // target. Prefixed so an annotation literally named `ink:a` cannot collide with a stroke.
  const key = typeof target === 'string' ? `annotation:${target}` : `ink:${target.ink}`;

  useEffect(() => {
    if (viewLeader === null || viewLeader === undefined
      || follow === null || follow === undefined) {
      setController(null);
      return undefined;
    }
    const instance = new HandlesController({
      host: viewLeader,
      boundary: viewLeader.boundary,
      follow,
      target: latestTarget.current,
      subscribeFrame: (listener) => subscribeFrame(viewLeader, listener),
    });
    setController(instance);
    return () => {
      instance.dispose();
      setController((current) => (current === instance ? null : current));
    };
    // `key` rather than `target`, so an object literal rebuilt each render does not tear the
    // controller down and rebuild it on every one.
  }, [viewLeader, follow, key]);

  return controller;
}

/** The current handle list. Re-renders when handles appear, vanish or change identity — not when
 *  they merely move, which the follow registry writes straight to the DOM. */
export function useHandleEntries(
  controller: HandlesController | null,
): readonly HandleEntry[] {
  return useViewLeaderSnapshot(controller) ?? EMPTY_HANDLES;
}

const EMPTY_HANDLES: readonly HandleEntry[] = Object.freeze([]);

function noop(): void {}
function nullSnapshot(): null {
  return null;
}

export type { SnapshotSource } from './core.js';
export { EditingKeyboard, type EditingKeyboardOptions } from '../internal/keyboard.js';
export {
  HandlesController,
  type HandleEntry,
  type HandleKind,
  type HandlePointerProps,
  type HandlesTarget,
} from '../internal/handles.js';
export {
  TextEditorController,
  isMultilineField,
  primaryTextField,
  readTextField,
  writeTextField,
  type EditableTextField,
  type OpenTextEditorOptions,
  type TextEditorCloseReason,
  type TextEditorProps,
  type TextEditorSnapshot,
} from '../internal/text-editor.js';
export {
  StyleEditor,
  type SelectionValue,
  type StyleEditorLabels,
  type StyleEditorOptions,
  type StyleEditorSnapshot,
  type StyleField,
  type StyleFieldState,
} from '../internal/style-editor.js';
export {
  TemplateDraft,
  captureTemplateDefaults,
  type TemplateCaptureOptions,
  type TemplateCaptureResult,
  type TemplateCaptureSource,
  type TemplateDraftIssue,
  type TemplateDraftOptions,
  type TemplateDraftPatch,
  type TemplateDraftSnapshot,
} from '../internal/template-draft.js';
export {
  FollowRegistry,
  followTargetKey,
  type FollowMissingBehaviour,
  type FollowOptions,
  type FollowTarget,
} from '../internal/follow.js';
