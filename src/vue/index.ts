// Vue binding. Mirrors the React one on purpose — same two functions, same names, same rules —
// so the documentation and the examples carry over between the two frameworks.
import {
  onScopeDispose,
  shallowRef,
  watch,
  type ComponentPublicInstance,
  type ShallowRef,
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

export type { SnapshotSource } from './core.js';
export {
  FollowRegistry,
  followTargetKey,
  type FollowMissingBehaviour,
  type FollowOptions,
  type FollowTarget,
} from '../internal/follow.js';
