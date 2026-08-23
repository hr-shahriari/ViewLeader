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
import type { SnapshotCapability } from './core.js';

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
    if (boundary === null) {
      setViewLeader(null);
      return undefined;
    }
    const instance = new ViewLeader({
      ...latestOptions.current,
      boundary,
    });
    setViewLeader(instance);
    return () => {
      instance.dispose();
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
  capability: SnapshotCapability<Snapshot> | null | undefined,
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

function noop(): void {}
function nullSnapshot(): null {
  return null;
}

export type { SnapshotCapability } from './core.js';
