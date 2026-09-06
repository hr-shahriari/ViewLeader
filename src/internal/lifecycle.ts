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
