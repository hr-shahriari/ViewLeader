// Shared by the React and Vue bindings. Both frameworks have to answer the same question — "is
// this still the same viewer element?" — and both get it wrong in the same way if left to their
// own idioms, so the answer lives here once rather than twice.
export interface DisposableViewLeader {
  dispose(): void;
}

export interface BoundaryOptions {
  readonly boundary: Element | null | undefined;
}

export type ViewLeaderFactory<
  Options extends BoundaryOptions,
  Instance extends DisposableViewLeader,
> = (options: Options & { readonly boundary: Element }) => Instance;

/**
 * Owns one ViewLeader for one viewer element.
 *
 * The element itself is the identity. Give it the same element again and you keep the same
 * instance; give it a different one and the old instance is disposed and a new one built. That is
 * what keeps a re-render from silently leaking a second overlay on top of the first.
 */
export class BoundaryLifecycle<
  Options extends BoundaryOptions,
  Instance extends DisposableViewLeader,
> {
  readonly #factory: ViewLeaderFactory<Options, Instance>;
  #boundary: Element | undefined;
  #instance: Instance | null = null;
  #disposed = false;

  public constructor(factory: ViewLeaderFactory<Options, Instance>) {
    this.#factory = factory;
  }

  public get current(): Instance | null {
    return this.#instance;
  }

  public update(options: Options): Instance | null {
    if (this.#disposed) return null;
    const boundary = options.boundary ?? undefined;
    if (boundary === this.#boundary) return this.#instance;
    this.#disposeCurrent();
    if (boundary === undefined) return null;
    this.#boundary = boundary;
    this.#instance = this.#factory({ ...options, boundary });
    return this.#instance;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeCurrent();
  }

  #disposeCurrent(): void {
    this.#instance?.dispose();
    this.#instance = null;
    this.#boundary = undefined;
  }
}

/**
 * The shape a binding needs to observe a capability: read now, and tell me when it changes.
 *
 * Deliberately *not* named `SnapshotCapability` — that name belongs to the constrained public type
 * in `types.ts`, which requires a `SnapshotStamp`. This one is unconstrained because a binding does
 * not care what is inside the snapshot, only that it can be read and subscribed to.
 */
export interface SnapshotSource<Snapshot> {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
}

/**
 * Keeps a subscription alive across re-renders.
 *
 * Frameworks hand over a fresh callback function on every render even when nothing has changed.
 * Resubscribing each time would tear down and rebuild the subscription constantly, so this tracks
 * the capability instead and just swaps in the newest callback.
 */
export class CapabilitySubscription<Snapshot> {
  #capability: SnapshotSource<Snapshot> | null = null;
  #listener: ((snapshot: Snapshot | null) => void) | undefined;
  #unsubscribe: (() => void) | undefined;

  public update(
    capability: SnapshotSource<Snapshot> | null,
    listener: (snapshot: Snapshot | null) => void,
  ): void {
    this.#listener = listener;
    if (this.#capability === capability) {
      listener(capability?.getSnapshot() ?? null);
      return;
    }
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#capability = capability;
    if (capability === null) {
      listener(null);
      return;
    }
    const publish = () => this.#listener?.(capability.getSnapshot());
    this.#unsubscribe = capability.subscribe(publish);
    publish();
  }

  public dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#capability = null;
    this.#listener = undefined;
  }
}
