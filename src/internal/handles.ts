// Enumerates one annotation's drag handles and routes their pointer events.
//
// A host that draws its own handles (`editing: { handles: 'none' }`) has to solve four problems the
// core does not solve for it: work out what handles exist, keep an identity per handle that a
// reconciler can key on, pick the right one of four `begin*Drag` methods, and wire the rest of the
// gesture. Core's own grips dodge the identity problem by having no identities — `render.ts` throws
// the grip group away and rebuilds it every frame. That option is not open to a React host.
//
// Two rules shape everything here:
//
// **The list is not per-frame state.** Positions ride the follow registry, which writes to elements
// outside the render cycle. The *list* publishes only when its shape changes, on `annotations` and
// `editing` — publishing it on the frame tick would re-render the host at 60 Hz, which is the exact
// failure the ref-based design exists to prevent. Nothing on `HandleEntry` is a coordinate, so an
// orbit cannot move it.
//
// `ponytail:` `editing: { handles: 'none' }` is a precondition this cannot verify — `EditingOptions`
// is construction-time and write-only from the public surface, with no getter anywhere. Ceiling: a
// host that forgets it draws two sets of grips and only core's respond. Upgrade path is a one-line
// getter on `EditingCapability` if it bites in practice. Detecting it by hit-testing a known handle
// position would work and is not worth the surface.
//
// `ponytail:` enumeration is O(annotations) per read — `annotationScreenGeometry` finds its entry by
// scanning the plan. Fine at gallery scale; a large multi-select rescans once per id. Upgrade path is
// an id-keyed index on the plan, in core.
//
// **The set freezes for the duration of a gesture.** Route handles are built from *stored* routing
// crossed with *previewed* points (`render.ts:516` vs `:519`), because the route preview never
// reaches `plannedAnnotation`. Measured mid-drag the set goes 5 → 6 → 7: `vertex:0` jumps onto the
// newly created bend and the grabbed `midpoint:0` drifts away from the pointer. Regions follow the
// preview and still renumber 8 → 10. The drags themselves are safe — every `begin*Drag` reads its
// handle exactly once, at press time — so it is only the drawing that goes wrong. Freezing is the
// cheapest correct answer; remapping would re-implement `#routeFor`/`#regionFor` off a snapshot that
// does not publish where the insert happened.
import { regionDragKind, type EditingDragKind, type EditingSnapshot } from '../editing.js';
import type { NormalizedPointerInput } from '../host.js';
import { normalizePointer } from '../pointer.js';
import {
  followTargetKey,
  type FollowGeometrySource,
  type FollowOptions,
  type FollowTarget,
} from './follow.js';

/**
 * What can be grabbed.
 *
 * Deliberately the words `EditingDragKind` already uses, minus the three body drags — a handle's
 * kind and the drag it starts are one fact, and a second vocabulary for it would drift. `Exclude`
 * rather than a fresh union so that a change to the drag kinds breaks this at compile time.
 */
export type HandleKind = Exclude<EditingDragKind, 'label' | 'region' | 'ink'>;

/** An annotation id, or a freehand stroke. Stroke ids are a separate id space from annotation ids,
 *  which is why they are reached through a wrapper rather than a bare string. */
export type HandlesTarget = string | { readonly ink: string };

/**
 * The pointer-event fields the handlers read.
 *
 * Structural rather than `PointerEvent`, because React hands a JSX `onPointerDown` its own synthetic
 * event, which carries the same fields but is not a DOM `PointerEvent`. Vue passes the real one.
 * Both satisfy this.
 */
export interface HandlePointerEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly button: number;
  readonly buttons: number;
  readonly pointerType: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly pointerId: number;
  readonly currentTarget: EventTarget | null;
}

/** Spread onto the host's handle element. The names are React props and lowercase to the right DOM
 *  event names under Vue's `v-bind`, so one object serves both. */
export interface HandlePointerProps {
  onPointerDown(event: HandlePointerEvent): void;
  onPointerMove(event: HandlePointerEvent): void;
  onPointerUp(event: HandlePointerEvent): void;
  onLostPointerCapture(): void;
}

export interface HandleEntry {
  /**
   * Stable across frames and re-renders, and unique within the annotation.
   *
   * The follow registry's target key, which carries the leg — a two-leg note publishes a first
   * midpoint twice, once per leg, so the kind and ordinal alone would not be unique.
   */
  readonly key: string;
  readonly kind: HandleKind;
  /** Hand to the follow registry, or to {@link HandlesController.ref}. */
  readonly target: FollowTarget;
  /**
   * `'copy'` on a midpoint, which adds a bend rather than moving one; `'move'` everywhere else.
   *
   * Derived the same way `EditingController.#cursorFor` derives it. Carried here because `#hover`
   * returns immediately when `gestures: false`, so a custom-handle host gets no cursor at all — and
   * this distinction is the only thing that tells a user a midpoint inserts rather than relocates.
   */
  readonly cursor: 'move' | 'copy';
  /** Already routed to the right `begin*Drag`, with capture and Escape wired. */
  readonly props: HandlePointerProps;
}

/** The editing calls the controller makes. `EditingCapability` satisfies it. */
export interface HandleEditingPort {
  getSnapshot(): EditingSnapshot;
  subscribe(listener: () => void): () => void;
  beginHandleDrag(id: string, index: number, pointer: NormalizedPointerInput): void;
  beginRouteHandleDrag(id: string, index: number, pointer: NormalizedPointerInput): void;
  beginRegionHandleDrag(id: string, index: number, pointer: NormalizedPointerInput): void;
  beginInkPointDrag(id: string, index: number, pointer: NormalizedPointerInput): void;
  pointerMove(pointer: NormalizedPointerInput): void;
  pointerUp(pointer: NormalizedPointerInput): void;
  cancel(): void;
}

/** The two registry calls the controller makes. `FollowRegistry` satisfies it. */
export interface HandleFollowSink {
  register(target: FollowTarget, element: Element, options?: FollowOptions): () => void;
  release(target: FollowTarget): void;
}

/**
 * What the controller needs from a `ViewLeader`.
 *
 * Ports rather than the class, for the same reason `FollowGeometrySource` is narrower than
 * `GeometryCapability`: a test can fake it without a viewer, and the capabilities not named here
 * cannot be reached from this file by accident. A `ViewLeader` satisfies it structurally.
 */
interface HandlesHost {
  readonly geometry: FollowGeometrySource;
  readonly editing: HandleEditingPort;
  /** Only `subscribe` is used — the set changes when the document does, and the snapshot's contents
   *  say nothing about which handles exist. */
  readonly annotations: { subscribe(listener: () => void): () => void };
}

interface HandlesControllerOptions {
  readonly host: HandlesHost;
  /** The viewer element. Pointer events are normalized against its bounding rect, exactly as core
   *  does — a `ViewLeader` does not publish the boundary it was built with, so it is passed in. */
  readonly boundary: Element;
  readonly follow: HandleFollowSink;
  readonly target: HandlesTarget;
  /**
   * Runs the callback after each frame the runtime actually drew — `subscribeFrame(viewLeader, …)`.
   *
   * Taken as an option rather than reached for directly, mirroring `FollowRegistryOptions.subscribe`,
   * so the controller stays constructible with fakes. It is **not** what publishes the list; see
   * {@link HandlesController} for what it is for.
   */
  readonly subscribeFrame: (listener: () => void) => () => void;
}

const EMPTY: readonly HandleEntry[] = Object.freeze([]);

/**
 * `SnapshotSource`-shaped, so `useSyncExternalStore` and Vue's `watch` can both drive it, and
 * framework-free so both can be tested through one implementation.
 *
 * The target is fixed at construction. A binding whose annotation id changes builds a new
 * controller, exactly as it builds a new `ViewLeader` for a new element, and that costs nothing
 * here — the only thing a controller accumulates is registrations for handles that no longer exist.
 *
 * **What publishes, and what does not.** `annotations` and `editing` are the only two things that
 * can change which handles exist, so they are the only two things that arm a check. But the set is
 * read out of the frame the runtime last drew, and neither of them draws one — `update()` publishes
 * nothing — so a document change is one frame ahead of the geometry that would prove it. The check
 * is therefore *armed* by a publish and *run* on the next drawn frame, still behind the structural
 * gate. A frame with nothing armed does no work and notifies nobody, which is what keeps an orbit
 * from re-rendering the host sixty times a second.
 */
export class HandlesController {
  readonly #host: HandlesHost;
  readonly #boundary: Element;
  readonly #follow: HandleFollowSink;
  readonly #target: HandlesTarget;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribes: (() => void)[] = [];
  /** Ref callbacks handed out so far, by key. Memoized for the reason the registry memoizes its
   *  own: a fresh identity makes React detach and reattach and re-fires Vue's ref every update. */
  readonly #refs = new Map<string, (element: Element | null) => void>();
  /** Elements the host has mounted, so `onMissing` can be re-applied when the set freezes. */
  readonly #elements = new Map<string, { readonly target: FollowTarget; readonly element: Element }>();
  #entries: readonly HandleEntry[] = EMPTY;
  #frozen = false;
  /** A publish has arrived whose effect on the set is not visible until the next frame is drawn. */
  #pending = false;
  /** Aborted on release, so nothing global is bound while no gesture is running. */
  #escape: AbortController | undefined;
  #disposed = false;

  public constructor(options: HandlesControllerOptions) {
    this.#host = options.host;
    this.#boundary = options.boundary;
    this.#follow = options.follow;
    this.#target = options.target;
    const republish = (): void => this.#onSourceChange();
    this.#unsubscribes.push(
      options.host.annotations.subscribe(republish),
      options.host.editing.subscribe(republish),
      options.subscribeFrame(() => this.#onFrame()),
    );
    this.#sync();
  }

  /**
   * Every handle for the target, in one flat array.
   *
   * `Object.is`-identical to the previous call whenever nothing structural changed, which is what
   * `useSyncExternalStore` requires of a store and what `test/v1-snapshot-identity.test.ts` holds
   * the core capabilities to.
   */
  public getSnapshot(): readonly HandleEntry[] {
    return this.#sync();
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /**
   * A callback ref for one handle, memoized by key.
   *
   * Wraps the follow registry rather than leaving the host to call it, because `onMissing` has to
   * change when the set freezes: a frozen handle whose live geometry disappeared — measured, the old
   * last vertex loses its handle the moment a bend is inserted — must hold its position rather than
   * hide, or freezing the set bought nothing. `FollowRegistry.ref` reads its options once per key and
   * memoizes the callback, so that flip is not expressible through the ref path; `register` reads
   * them every call, and this is where the re-registration lives.
   */
  public ref(entry: HandleEntry): (element: Element | null) => void {
    const existing = this.#refs.get(entry.key);
    if (existing !== undefined) return existing;
    const { key, target } = entry;
    const callback = (element: Element | null): void => {
      if (element === null) {
        this.#elements.delete(key);
        this.#follow.release(target);
        return;
      }
      this.#elements.set(key, { target, element });
      this.#follow.register(target, element, { onMissing: this.#frozen ? 'hold' : 'hide' });
    };
    this.#refs.set(key, callback);
    return callback;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releaseEscape();
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    for (const { target } of this.#elements.values()) this.#follow.release(target);
    this.#elements.clear();
    this.#refs.clear();
    this.#listeners.clear();
    this.#entries = EMPTY;
  }

  /**
   * Rebuilds the list unless a gesture is running, keeping the previous array when nothing
   * structural moved.
   *
   * Gated on `phase`, not on pointer-up: a `handle` drag goes async into `'picking'` while the host
   * decides what was under the drop point, so the gesture is not over when the pointer is released.
   *
   * `ponytail:` any non-idle phase freezes, not only the two bend-inserting gestures that renumber.
   * Ceiling: the set also holds still through a marquee and through a plain label drag, neither of
   * which needs it. Upgrade path: narrow to `kind === 'midpoint' || kind === 'region-midpoint'` —
   * three more words, once something is measured that a plain drag ought to have moved.
   */
  #sync(): readonly HandleEntry[] {
    if (this.#disposed) return this.#entries;
    if (this.#host.editing.getSnapshot().phase !== 'idle') return this.#entries;
    const next = this.#build();
    if (!sameShape(this.#entries, next)) this.#entries = next;
    return this.#entries;
  }

  /**
   * The freeze flip lives here rather than in `#sync` so that `getSnapshot()` stays free of side
   * effects — React calls it during render, and re-registering elements writes to the DOM. Drag
   * start and drag end both publish on `editing`, so this path always sees the transition.
   */
  #onSourceChange(): void {
    if (this.#disposed) return;
    const frozen = this.#host.editing.getSnapshot().phase !== 'idle';
    if (frozen !== this.#frozen) {
      this.#frozen = frozen;
      const onMissing = frozen ? 'hold' : 'hide';
      for (const { target, element } of this.#elements.values()) {
        // `register` reads its options every call but ignores a re-registration of the same element,
        // so the old registration has to be dropped for the new mode to take.
        this.#follow.release(target);
        this.#follow.register(target, element, { onMissing });
      }
    }
    this.#pending = true;
    this.#recheck();
  }

  /** Runs an armed check against geometry that now exists. Costs one branch when nothing is armed. */
  #onFrame(): void {
    if (this.#disposed || !this.#pending) return;
    this.#pending = false;
    this.#recheck();
  }

  #recheck(): void {
    const before = this.#entries;
    if (this.#sync() === before) return;
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* one observer's failure must not stop its siblings */ }
    }
  }

  #build(): readonly HandleEntry[] {
    const target = this.#target;
    if (typeof target !== 'string') {
      const points = this.#host.geometry.ofInk(target.ink)?.points;
      if (points === undefined || points.length === 0) return EMPTY;
      return Object.freeze(points.map((_point, slot) =>
        this.#entry('ink-point', target.ink, slot, { kind: 'ink-point', id: target.ink, index: slot })));
    }
    const geometry = this.#host.geometry.of(target);
    if (geometry === undefined) return EMPTY;
    const entries: HandleEntry[] = [];
    geometry.handles.forEach((handle, slot) => entries.push(
      this.#entry('handle', target, slot, { kind: 'handle', id: target, leg: handle.target }),
    ));
    geometry.routeHandles.forEach((handle, slot) => entries.push(this.#entry(handle.kind, target, slot, {
      kind: 'route-handle',
      id: target,
      leg: handle.target,
      handleKind: handle.kind,
      index: handle.index,
    })));
    // The registry resolves a region handle by array position, not by ordinal — a rectangle's
    // extent handles have no ordinal at all.
    geometry.regionHandles.forEach((handle, slot) => entries.push(
      this.#entry(regionDragKind(handle), target, slot, { kind: 'region-handle', id: target, index: slot }),
    ));
    return Object.freeze(entries);
  }

  /**
   * `slot` is the position in the geometry array the handle came from — `handles`, `routeHandles`,
   * `regionHandles`, or a stroke's `points` — which is what every `begin*Drag` takes. It is closed
   * over rather than published: the key already identifies the handle, and a host has no use for
   * the number.
   */
  #entry(kind: HandleKind, id: string, slot: number, target: FollowTarget): HandleEntry {
    return Object.freeze({
      key: followTargetKey(target),
      kind,
      target,
      cursor: kind === 'midpoint' || kind === 'region-midpoint' ? 'copy' : 'move',
      props: Object.freeze({
        onPointerDown: (event: HandlePointerEvent): void => this.#down(kind, id, slot, event),
        onPointerMove: (event: HandlePointerEvent): void =>
          this.#host.editing.pointerMove(this.#pointer(event)),
        onPointerUp: (event: HandlePointerEvent): void => {
          this.#releaseEscape();
          this.#host.editing.pointerUp(this.#pointer(event));
        },
        // Mirrors core's own `lostpointercapture` handler. `cancel()` writes nothing and costs no
        // undo step, so an over-eager one is cheap.
        onLostPointerCapture: (): void => {
          this.#releaseEscape();
          this.#host.editing.cancel();
        },
      }),
    });
  }

  /**
   * Starts the gesture and takes ownership of it.
   *
   * Capture, Escape and the cursor exist in core only behind `gestures: true`, which a host drawing
   * its own handles has turned off — so without this a drag freezes the instant the pointer leaves a
   * handle a few pixels wide. Capture goes on the handle element rather than on the boundary: core
   * captures the boundary because that is where its listeners live, and here the handle *is* the
   * event target.
   */
  #down(kind: HandleKind, id: string, slot: number, event: HandlePointerEvent): void {
    const pointer = this.#pointer(event);
    const editing = this.#host.editing;
    switch (kind) {
      case 'handle': editing.beginHandleDrag(id, slot, pointer); break;
      case 'vertex':
      case 'midpoint': editing.beginRouteHandleDrag(id, slot, pointer); break;
      case 'region-extent':
      case 'region-vertex':
      case 'region-midpoint': editing.beginRegionHandleDrag(id, slot, pointer); break;
      case 'ink-point': editing.beginInkPointDrag(id, slot, pointer); break;
    }
    if (editing.getSnapshot().phase === 'idle') return;
    setPointerCapture(event.currentTarget, event.pointerId);
    this.#bindEscape();
  }

  /** `ponytail:` one cast. `normalizePointer` takes a DOM `PointerEvent` and React's synthetic event
   *  is not one, but carries every field it reads. Upgrade path: widen `normalizePointer`'s
   *  parameter in `src/pointer.ts`, which is a one-word change nobody has needed yet. */
  #pointer(event: HandlePointerEvent): NormalizedPointerInput {
    return normalizePointer(event as unknown as PointerEvent, this.#boundary);
  }

  #bindEscape(): void {
    if (this.#escape !== undefined) return;
    this.#escape = new AbortController();
    this.#boundary.ownerDocument.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.#releaseEscape();
      this.#host.editing.cancel();
    }, { signal: this.#escape.signal });
  }

  #releaseEscape(): void {
    this.#escape?.abort();
    this.#escape = undefined;
  }
}

/**
 * The structural-equality gate.
 *
 * Keys, position by position. A key carries the kind, the leg and — for route, region and ink
 * handles — the ordinal, and entries are emitted in geometry order, so two lists whose keys agree
 * at every position also agree on every closed-over slot. No coordinate is compared because no
 * coordinate is on the entry, which is what keeps an orbit from republishing the list.
 */
function sameShape(a: readonly HandleEntry[], b: readonly HandleEntry[]): boolean {
  return a.length === b.length && a.every((entry, position) => entry.key === b[position]!.key);
}

/** Duck-typed and swallowed, exactly as core does at its own capture site: a detached node throws,
 *  and jsdom does not implement it at all. */
function setPointerCapture(target: EventTarget | null, pointerId: number): void {
  const candidate = target as { setPointerCapture?: (id: number) => void } | null;
  try { candidate?.setPointerCapture?.(pointerId); } catch { /* the gesture still works without it */ }
}
