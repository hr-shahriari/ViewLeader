// React binding. Two hooks, no components and no context: ViewLeader draws into an SVG layer it
// owns, so there is nothing here for React to render — only a lifetime to manage.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ViewLeader,
  type ViewLeaderOptions,
} from '../index.js';
import { BoundaryLifecycle, type BoundaryOptions, type SnapshotSource } from './core.js';
import { subscribeFrame } from '../internal/frame-seam.js';
import { FollowRegistry } from '../internal/follow.js';

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

function noop(): void {}
function nullSnapshot(): null {
  return null;
}

export type { SnapshotSource } from './core.js';
export {
  FollowRegistry,
  followTargetKey,
  type FollowMissingBehaviour,
  type FollowOptions,
  type FollowTarget,
} from '../internal/follow.js';
