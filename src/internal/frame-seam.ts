/**
 * A post-frame notification, reachable from `src/internal/` and from nowhere else.
 *
 * Screen geometry is only valid for the frame that produced it, and a camera move fires no DOM
 * event — so anything positioning host chrome against an annotation needs to run immediately after
 * `ViewLeaderRuntime.update()` has laid the frame out. Nothing on the public surface offers that:
 * `subscribe` fires on *state* changes, and an orbit with nothing selected changes no state while
 * moving every label.
 *
 * The seam lives in a module-level `WeakMap` rather than on `ViewLeader` because `ViewLeader` is an
 * exported class — any public method on it would become public API, and this is deliberately not.
 * A `WeakMap` keyed on instances adds nothing to the declaration output at all.
 *
 * Note the package-boundary test would not have caught the alternatives: it walks `dist/index.d.ts`
 * only for Three and IFC types. "Internal" here is a discipline the code has to keep, not one the
 * test suite enforces.
 */

type FrameListener = () => void;

/** Emitter → its listeners. Keyed on the runtime, which is what actually produces frames. */
const listenersByEmitter = new WeakMap<object, Set<FrameListener>>();

/** Public-facing owner → the emitter it was built with, so a caller holding a `ViewLeader` can subscribe. */
const emitterByOwner = new WeakMap<object, object>();

/** Called once while a `ViewLeader` is being constructed, so its runtime can be found again later. */
export function linkFrameSeam(owner: object, emitter: object): void {
  emitterByOwner.set(owner, emitter);
}

/**
 * Runs `listener` after every frame the runtime actually produced.
 *
 * Frames that skipped — no projection change, nothing invalidated — do not notify, because nothing
 * moved and re-reading geometry would return what the caller already wrote.
 */
export function subscribeFrame(owner: object, listener: FrameListener): () => void {
  const emitter = emitterByOwner.get(owner);
  // A disposed or unlinked owner has no frames coming; an inert unsubscribe keeps callers from
  // having to special-case it.
  if (emitter === undefined) return () => undefined;
  const listeners = listenersByEmitter.get(emitter) ?? new Set<FrameListener>();
  listenersByEmitter.set(emitter, listeners);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called by the runtime at the end of a frame it drew. */
export function emitFrame(emitter: object): void {
  const listeners = listenersByEmitter.get(emitter);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* one writer's failure must not stop the frame or its siblings */ }
  }
}

/** Drops every listener for an emitter, so disposing a `ViewLeader` cannot leave writers attached. */
export function clearFrameSeam(emitter: object): void {
  listenersByEmitter.delete(emitter);
}

/**
 * Forgets an owner, so a subscribe after disposal is honestly inert.
 *
 * Without this the owner still resolves to its dead emitter, and `subscribeFrame` hands back a
 * real-looking unsubscribe for a listener no frame will ever reach — a silent no-op that reads like
 * a working subscription.
 */
export function unlinkFrameSeam(owner: object): void {
  emitterByOwner.delete(owner);
}
