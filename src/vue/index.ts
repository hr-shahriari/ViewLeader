// Vue binding. Mirrors the React one on purpose — same two functions, same names, same rules —
// so the documentation and the examples carry over between the two frameworks.
import {
  onScopeDispose,
  shallowRef,
  watch,
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

export type { SnapshotSource } from './core.js';
