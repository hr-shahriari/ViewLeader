// Vue binding. Mirrors the React one on purpose — same two functions, same names, same rules —
// so the documentation and the examples carry over between the two frameworks.
import {
  computed,
  defineComponent,
  h,
  onScopeDispose,
  shallowRef,
  watch,
  type ComponentPublicInstance,
  type PropType,
  type ShallowRef,
  type VNode,
} from 'vue';
import {
  ViewLeader,
  type ViewLeaderOptions,
} from '../index.js';
import {
  BoundaryLifecycle,
  CapabilitySubscription,
  resolveVueSource,
  type BoundaryOptions,
  type MaybeVueSource,
  type SnapshotSource,
} from './core.js';
import { subscribeFrame } from '../internal/frame-seam.js';
import {
  FollowRegistry,
  followTargetKey,
  type FollowOptions,
  type FollowTarget,
} from '../internal/follow.js';
import { EditingKeyboard, type EditingKeyboardOptions } from '../internal/keyboard.js';
import {
  HandlesController,
  type HandlesTarget,
} from '../internal/handles.js';
import {
  TextEditorController,
  type TextEditorCloseReason,
  type TextEditorSnapshot,
} from '../internal/text-editor.js';
import {
  StyleEditor,
  type StyleEditorOptions,
} from '../internal/style-editor.js';
import {
  TemplateDraft,
  type TemplateDraftOptions,
  type TemplateDraftPorts,
} from '../internal/template-draft.js';

export type VueViewLeaderOptions = Omit<ViewLeaderOptions, 'boundary'>;
export type VueViewLeaderOptionsSource = MaybeVueSource<VueViewLeaderOptions>;

export interface VueViewLeaderBinding {
  /** Bind this as the template ref on the element the viewer draws into. */
  readonly boundaryRef: (element: Element | null) => void;
  readonly viewLeader: Readonly<ShallowRef<ViewLeader | null>>;
}

/**
 * Creates and owns one ViewLeader for one viewer element.
 *
 * Nothing is built until the element exists. Point it at a different element and the old instance
 * is disposed and rebuilt; leave the scope and it is disposed. The ref is shallow because a
 * ViewLeader is a live object with its own internal state — making it deeply reactive would have
 * Vue walking the whole engine on every change.
 */
export function useViewLeader(
  optionsSource: VueViewLeaderOptionsSource,
): VueViewLeaderBinding {
  const boundary = shallowRef<Element | null>(null);
  const viewLeader = shallowRef<ViewLeader | null>(null);
  const stop = watch(
    boundary,
    (element, _previous, onCleanup) => {
      // Same rule as the React binding, from the same class: the element is the identity, and
      // `BoundaryLifecycle` decides whether that means keep or rebuild. One per watch run, because
      // `dispose()` is terminal.
      const lifecycle = new BoundaryLifecycle<VueViewLeaderOptions & BoundaryOptions, ViewLeader>(
        (resolved) => new ViewLeader(resolved),
      );
      const instance = lifecycle.update({
        ...resolveVueSource(optionsSource),
        boundary: element,
      });
      viewLeader.value = instance;
      onCleanup(() => {
        lifecycle.dispose();
        if (viewLeader.value === instance) viewLeader.value = null;
      });
    },
    { flush: 'sync' },
  );

  onScopeDispose(() => {
    stop();
    viewLeader.value?.dispose();
    viewLeader.value = null;
  });

  return {
    boundaryRef: (element) => {
      if (boundary.value !== element) boundary.value = element;
    },
    viewLeader: viewLeader as Readonly<ShallowRef<ViewLeader | null>>,
  };
}

/**
 * Tracks one of ViewLeader's capabilities as a ref, so a template re-renders when it changes.
 *
 * The Vue counterpart of the React hook by the same name. Works with `annotations`, `authoring`,
 * `documents`, `history` or `views`, and holds `null` until the capability exists.
 */
export function useViewLeaderSnapshot<Snapshot>(
  capabilitySource: MaybeVueSource<
    SnapshotSource<Snapshot> | null | undefined
  >,
): Readonly<ShallowRef<Snapshot | null>> {
  const snapshot: ShallowRef<Snapshot | null> = shallowRef<Snapshot | null>(null);
  const subscription = new CapabilitySubscription<Snapshot>();
  const stop = watch(
    () => resolveVueSource(capabilitySource) ?? null,
    (capability) => {
      subscription.update(capability, (value) => {
        snapshot.value = value;
      });
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => {
    stop();
    subscription.dispose();
  });
  return snapshot as Readonly<ShallowRef<Snapshot | null>>;
}

/**
 * Pins your own elements to annotations — the Vue counterpart of the React hook by the same name.
 *
 * The library writes each element's position after every frame, outside Vue's reactivity. Holds
 * `null` until the `ViewLeader` exists, matching `useViewLeader`.
 *
 * Two ways in, because Vue has two idioms and both are legitimate here:
 *
 * ```vue
 * <div :ref="follow.ref({ kind: 'label', id: 'note' })" />   <!-- callback, parity with React -->
 * ```
 * ```ts
 * const toolbar = useTemplateRef('toolbar')
 * follow.track({ kind: 'label', id: 'note' }, toolbar)       // Vue fills the ref, we read it
 * ```
 */
export function useFollow(
  viewLeaderSource: MaybeVueSource<ViewLeader | null | undefined>,
): VueFollowBinding {
  const registry = shallowRef<FollowRegistry | null>(null);
  const stop = watch(
    () => resolveVueSource(viewLeaderSource) ?? null,
    (viewLeader, _previous, onCleanup) => {
      if (viewLeader === null) {
        registry.value = null;
        return;
      }
      const instance = new FollowRegistry({
        geometry: viewLeader.geometry,
        subscribe: (listener) => subscribeFrame(viewLeader, listener),
      });
      registry.value = instance;
      onCleanup(() => {
        instance.dispose();
        if (registry.value === instance) registry.value = null;
      });
    },
    { immediate: true, flush: 'sync' },
  );

  onScopeDispose(() => {
    stop();
    registry.value?.dispose();
    registry.value = null;
  });

  // Memoised here as well as inside the registry, because a template re-evaluates `follow.ref({…})`
  // on every render and Vue fires a *function* ref on every update. A fresh identity each time would
  // tear down and rebuild a registration that never changed — and these have to survive the registry
  // itself being replaced when the ViewLeader changes.
  const callbacks = new Map<string, (element: VueRefTarget) => void>();

  return {
    registry: registry as Readonly<ShallowRef<FollowRegistry | null>>,
    ref: (target, options) => {
      const key = followTargetKey(target);
      const existing = callbacks.get(key);
      if (existing !== undefined) return existing;
      const callback = (element: VueRefTarget): void => {
        registry.value?.ref(target, options)(elementOf(element));
      };
      callbacks.set(key, callback);
      return callback;
    },
    track: (target, source, options) => {
      const stopTracking = watch(
        () => [registry.value, resolveVueSource(source) ?? null] as const,
        ([current, element], _previous, onCleanup) => {
          const node = elementOf(element);
          if (current === null || node === null) return;
          onCleanup(current.register(target, node, options));
        },
        { immediate: true, flush: 'sync' },
      );
      onScopeDispose(stopTracking);
      return stopTracking;
    },
  };
}

export interface VueFollowBinding {
  /** `null` until the `ViewLeader` exists. Present for hosts that want the registry itself. */
  readonly registry: Readonly<ShallowRef<FollowRegistry | null>>;
  /**
   * A `:ref` callback, matching the React binding.
   *
   * Accepts what Vue actually passes: an element, or a component instance when the `:ref` sits on a
   * component rather than a plain tag. The instance's root element is used in that case.
   */
  ref(target: FollowTarget, options?: FollowOptions): (element: VueRefTarget) => void;
  /** Watches a template ref and registers whatever it holds. Returns a stop handle. */
  track(
    target: FollowTarget,
    source: MaybeVueSource<VueRefTarget>,
    options?: FollowOptions,
  ): () => void;
}

/** What Vue hands a `:ref`: an element, a component instance, or nothing. */
export type VueRefTarget = Element | ComponentPublicInstance | null | undefined;

/** Unwraps a component instance to its root element, so both `:ref` shapes reach the registry. */
function elementOf(target: VueRefTarget): Element | null {
  if (target === null || target === undefined) return null;
  if (target instanceof Element) return target;
  const root = (target as ComponentPublicInstance).$el as unknown;
  return root instanceof Element ? root : null;
}

/**
 * Binds the four editing keys on the document that owns the viewer — arrows nudge, Shift+arrow
 * nudges further, Delete removes, Escape clears the selection.
 *
 * Undo and redo are deliberately not bound. A focused input keeps its own keys. Returns nothing:
 * there is no state here a template could render, only a lifetime.
 */
export function useEditingKeyboard(
  viewLeaderSource: MaybeVueSource<ViewLeader | null | undefined>,
  options: EditingKeyboardOptions = {},
): void {
  const stop = watch(
    () => resolveVueSource(viewLeaderSource) ?? null,
    (viewLeader, _previous, onCleanup) => {
      if (viewLeader === null) return;
      const controller = new EditingKeyboard(
        viewLeader,
        ...(options.enabled === undefined ? [] : [{ enabled: options.enabled }]),
      );
      onCleanup(() => controller.dispose());
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(stop);
}

/**
 * Edits the style of whatever is selected, reading through `annotations.resolvedStyle` so a panel
 * shows what is actually drawn — the active saved view's override included.
 *
 * Holds `null` until the `ViewLeader` exists. Pass it to {@link useViewLeaderSnapshot} to track it.
 */
export function useStyleEditor(
  viewLeaderSource: MaybeVueSource<ViewLeader | null | undefined>,
  options: StyleEditorOptions = {},
): Readonly<ShallowRef<StyleEditor | null>> {
  const editor = shallowRef<StyleEditor | null>(null);
  const stop = watch(
    () => resolveVueSource(viewLeaderSource) ?? null,
    (viewLeader) => {
      editor.value = viewLeader === null
        ? null
        : new StyleEditor(
          { annotations: viewLeader.annotations, history: viewLeader.history },
          options,
        );
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => {
    stop();
    editor.value = null;
  });
  return editor as Readonly<ShallowRef<StyleEditor | null>>;
}

/**
 * The state behind a "save this as a template" dialog: a scratch buffer that validates as the user
 * types, previews onto the selection, and commits as one undo step.
 *
 * Holds `null` until the `ViewLeader` exists.
 */
export function useTemplateDraft(
  viewLeaderSource: MaybeVueSource<ViewLeader | null | undefined>,
  options: Omit<TemplateDraftOptions, keyof TemplateDraftPorts> = {},
): Readonly<ShallowRef<TemplateDraft | null>> {
  const draft = shallowRef<TemplateDraft | null>(null);
  const stop = watch(
    () => resolveVueSource(viewLeaderSource) ?? null,
    (viewLeader, _previous, onCleanup) => {
      if (viewLeader === null) {
        draft.value = null;
        return;
      }
      const instance = new TemplateDraft({
        definitions: viewLeader.definitions,
        history: viewLeader.history,
        annotations: viewLeader.annotations,
        ...options,
      });
      draft.value = instance;
      // Leaving the scope is how a template dialog is cancelled in practice; a preview left applied
      // after it closes is a change nobody asked to keep.
      onCleanup(() => {
        instance.dispose();
        if (draft.value === instance) draft.value = null;
      });
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => {
    stop();
    draft.value?.dispose();
    draft.value = null;
  });
  return draft as Readonly<ShallowRef<TemplateDraft | null>>;
}

/**
 * An inline editor for a label's text — the Vue counterpart of the React hook by the same name.
 *
 * Pass the registry from {@link useFollow} and the field tracks the label, keeping its caret even if
 * the camera orbits the label off screen.
 */
export function useLabelTextEditor(
  viewLeaderSource: MaybeVueSource<ViewLeader | null | undefined>,
  followSource?: MaybeVueSource<FollowRegistry | null | undefined>,
  onClose?: (reason: TextEditorCloseReason) => void,
): Readonly<ShallowRef<TextEditorController | null>> {
  const controller = shallowRef<TextEditorController | null>(null);
  // Array of getters, for the same reason as `useHandles`: a getter returning a fresh tuple is
  // always unequal to itself, so the editor would be rebuilt on every render — silently dropping a
  // half-typed value each time.
  const stop = watch(
    [
      () => resolveVueSource(viewLeaderSource) ?? null,
      () => (followSource === undefined ? null : resolveVueSource(followSource) ?? null),
    ],
    ([viewLeader, follow], _previous, onCleanup) => {
      if (viewLeader === null) {
        controller.value = null;
        return;
      }
      const instance = new TextEditorController({
        host: viewLeader,
        ...(follow === null ? {} : { follow }),
        ...(onClose === undefined ? {} : { onClose }),
      });
      controller.value = instance;
      onCleanup(() => {
        instance.dispose();
        if (controller.value === instance) controller.value = null;
      });
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => {
    stop();
    controller.value?.dispose();
    controller.value = null;
  });
  return controller as Readonly<ShallowRef<TextEditorController | null>>;
}

/**
 * The one component this package ships, in its Vue form.
 *
 * It earns the exception for the same reason the React one does: the markup carries real knowledge
 * — the box has to sit *on* the text it replaces without the glyphs jumping, which is what the font
 * metrics the follow registry writes as CSS custom properties are for. Renders nothing while no
 * editor is open.
 */
export const LabelTextEditor = defineComponent({
  name: 'LabelTextEditor',
  props: {
    editor: {
      type: Object as PropType<TextEditorController | null>,
      default: null,
    },
  },
  setup(props) {
    const snapshot = shallowRef<TextEditorSnapshot | null>(null);
    const subscription = new CapabilitySubscription<TextEditorSnapshot>();
    const stop = watch(
      () => props.editor,
      (editor) => {
        subscription.update(editor, (value) => { snapshot.value = value; });
      },
      { immediate: true, flush: 'sync' },
    );
    onScopeDispose(() => {
      stop();
      subscription.dispose();
    });

    const open = computed(() => snapshot.value !== null && snapshot.value.annotationId !== null);

    // Built once in `setup`, not per render: Vue fires a *function* ref on every update, so a fresh
    // identity each render would detach and reattach the field on every keystroke. Also unwraps the
    // component instance Vue passes when a `:ref` sits on a component rather than a tag.
    const attach = (element: unknown): void => {
      props.editor?.ref(elementOf(element as VueRefTarget));
    };

    return (): VNode | null => {
      const editor = props.editor;
      const current = snapshot.value;
      if (editor === null || current === null || !open.value) return null;
      const fieldProps = current.props;
      return h('textarea', {
        ref: attach,
        value: fieldProps.value,
        dir: fieldProps.dir,
        rows: fieldProps.rows,
        'aria-label': fieldProps['aria-label'],
        ...(fieldProps['data-vl-text-source'] === undefined
          ? {}
          : { 'data-vl-text-source': fieldProps['data-vl-text-source'] }),
        // Vue's event names, over the framework-neutral handlers the controller publishes.
        onInput: fieldProps.onChange,
        onKeydown: fieldProps.onKeyDown,
        onBlur: fieldProps.onBlur,
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          fontFamily: 'var(--vl-font-family)',
          fontSize: 'var(--vl-font-size)',
          lineHeight: 'var(--vl-line-height)',
          color: 'var(--vl-text-color)',
          padding: 'var(--vl-padding)',
        },
      });
    };
  },
});

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

/**
 * Your own drag handles for one annotation — the Vue counterpart of the React hook.
 *
 * Pointer props arrive pre-routed to the right drag, with capture and Escape wired. The set freezes
 * for the duration of a drag, because the live route-handle set renumbers underneath the handle
 * being dragged.
 *
 * Holds `null` until both the `ViewLeader` and a follow registry exist.
 */
export function useHandles(
  viewLeaderSource: MaybeVueSource<ViewLeader | null | undefined>,
  followSource: MaybeVueSource<FollowRegistry | null | undefined>,
  targetSource: MaybeVueSource<HandlesTarget>,
): Readonly<ShallowRef<HandlesController | null>> {
  const controller = shallowRef<HandlesController | null>(null);
  // An **array of getters**, not one getter returning an array. Vue compares a getter's result with
  // `Object.is`, so a fresh tuple every evaluation is always "changed" and the key would gate
  // nothing — tearing the controller down and rebuilding it mid-gesture, dropping its follow
  // registrations and its Escape binding. Given an array, Vue compares element by element.
  const stop = watch(
    [
      () => resolveVueSource(viewLeaderSource) ?? null,
      () => resolveVueSource(followSource) ?? null,
      () => {
        const target = resolveVueSource(targetSource);
        return typeof target === 'string' ? `annotation:${target}` : `ink:${target.ink}`;
      },
    ],
    ([viewLeader, follow], _previous, onCleanup) => {
      if (viewLeader === null || follow === null) {
        controller.value = null;
        return;
      }
      const instance = new HandlesController({
        host: viewLeader,
        boundary: viewLeader.boundary,
        follow,
        target: resolveVueSource(targetSource),
        subscribeFrame: (listener) => subscribeFrame(viewLeader, listener),
      });
      controller.value = instance;
      onCleanup(() => {
        instance.dispose();
        if (controller.value === instance) controller.value = null;
      });
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => {
    stop();
    controller.value?.dispose();
    controller.value = null;
  });
  return controller as Readonly<ShallowRef<HandlesController | null>>;
}

export {
  HandlesController,
  type HandleEntry,
  type HandleKind,
  type HandlePointerProps,
  type HandlesTarget,
} from '../internal/handles.js';

export { EditingKeyboard, type EditingKeyboardOptions } from '../internal/keyboard.js';
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

export type { SnapshotSource } from './core.js';
export {
  FollowRegistry,
  followTargetKey,
  type FollowMissingBehaviour,
  type FollowOptions,
  type FollowTarget,
} from '../internal/follow.js';
