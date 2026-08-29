// Placing a new annotation: click a point on the model, and a note appears attached to it.
//
// Nothing is written to the document until the gesture finishes, so one placement is one undo step
// and an abandoned one leaves no trace. Every method can be called directly as well as driven by
// pointer events, which is what lets a host build keyboard or scripted placement on the same code.
import { AdapterError, InvalidInputError, ViewLeaderError } from './errors.js';
import type { DocumentEngine } from './document.js';
import type {
  AccuratePickingAdapter,
  InteractionLease,
  NormalizedPointerInput,
} from './host.js';
import { isPointerEvent, normalizePointer, validatePointer } from './pointer.js';
import type { ViewLeaderRuntime } from './runtime.js';
import type {
  Anchor,
  Annotation,
  AnnotationDraft,
  SnapshotStamp,
  Unsubscribe,
  Vec2,
} from './types.js';
import { revisionCache } from './internal/snapshot-cache.js';

/** The most bends a hand-drawn leader may have. Matches the limit the document enforces. */
const MAX_MANUAL_VERTICES = 64;

export type AuthoringCancellationReason =
  | 'host'
  | 'escape'
  | 'preempted'
  | 'pointer-exit'
  | 'document-replaced'
  | 'disposed';

export type AuthoringOutcome =
  | { readonly status: 'completed'; readonly annotation: Annotation }
  | { readonly status: 'cancelled'; readonly reason: AuthoringCancellationReason }
  | { readonly status: 'failed'; readonly error: ViewLeaderError };

export type AuthoringDraft = Omit<AnnotationDraft, 'anchor' | 'anchors'>;

export interface StartAuthoringOptions {
  readonly draft: AuthoringDraft;
  readonly anchor?: Anchor;
  /**
   * Draw the leader by hand instead of letting it route itself.
   *
   * The first click sets the arrow point on the model, each later click adds a bend, and Enter or a
   * double-click finishes. The label lands wherever the last click was, unless the draft says
   * otherwise.
   */
  readonly multiPoint?: boolean;
}

export interface AuthoringPreview {
  readonly pointer?: NormalizedPointerInput;
  readonly anchor?: Anchor;
  /** The bends placed so far, in the order they were clicked. */
  readonly vertices?: readonly Vec2[];
  /** Where the pointer is now — the loose end of the line that follows the cursor. */
  readonly livePoint?: Vec2;
}

export interface AuthoringSnapshot extends SnapshotStamp {
  readonly phase: 'idle' | 'aiming' | 'pending-pick' | 'drawing' | 'ready';
  readonly sessionId: number | null;
  readonly pendingPick: boolean;
  readonly preview: AuthoringPreview | null;
  readonly status: string;
}

interface ActiveSession {
  readonly id: number;
  readonly draft: AuthoringDraft;
  readonly multiPoint: boolean;
  readonly resolve: (outcome: AuthoringOutcome) => void;
  readonly promise: Promise<AuthoringOutcome>;
  readonly lease?: InteractionLease;
  readonly restoreFocus?: HTMLElement;
  readonly cleanup: (() => void)[];
  pick: AbortController | undefined;
  preview: AuthoringPreview | null;
  anchor: Anchor | undefined;
  vertices: Vec2[];
  phase: 'aiming' | 'pending-pick' | 'drawing' | 'ready';
}

export class AuthoringController {
  readonly #boundary: Element;
  readonly #document: DocumentEngine;
  readonly #runtime: ViewLeaderRuntime;
  readonly #picking: AccuratePickingAdapter | undefined;
  readonly #statusElement: HTMLDivElement;
  readonly #listeners = new Set<() => void>();
  readonly #snapshotCache = revisionCache<AuthoringSnapshot>();
  readonly #documentUnsubscribe: Unsubscribe;
  #active: ActiveSession | undefined;
  #sequence = 0;
  #status = 'Authoring inactive';
  #disposed = false;

  public constructor(boundary: Element, document: DocumentEngine, runtime: ViewLeaderRuntime) {
    this.#boundary = boundary;
    this.#document = document;
    this.#runtime = runtime;
    this.#picking = runtime.adapters.picking;
    this.#statusElement = boundary.ownerDocument.createElement('div');
    this.#statusElement.dataset.viewleaderStatus = '';
    this.#statusElement.setAttribute('role', 'status');
    this.#statusElement.setAttribute('aria-live', 'polite');
    Object.assign(this.#statusElement.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0, 0, 0, 0)',
      whiteSpace: 'nowrap',
      border: '0',
    });
    try {
      boundary.appendChild(this.#statusElement);
      this.#announce(this.#status);
      this.#documentUnsubscribe = document.subscribe((commit) => {
        if (commit.kind === 'replacement') this.#cancel('document-replaced', false);
      });
    } catch (error) {
      this.#statusElement.remove();
      throw error;
    }
  }

  public getSnapshot(): AuthoringSnapshot {
    const stamp = this.#runtime.documentsSnapshot();
    return this.#snapshotCache(stamp.runtimeRevision, () => {
    const active = this.#active;
    return Object.freeze({
      runtimeRevision: stamp.runtimeRevision,
      documentRevision: stamp.documentRevision,
      phase: active?.phase ?? 'idle',
      sessionId: active?.id ?? null,
      pendingPick: active?.phase === 'pending-pick',
      preview: active?.preview === null || active?.preview === undefined
        ? null
        : Object.freeze({ ...active.preview }),
      status: this.#status,
    });
    });
  }

  public subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public start(options: StartAuthoringOptions): Promise<AuthoringOutcome> {
    this.cancel('preempted');
    this.#sequence += 1;
    let resolve!: (outcome: AuthoringOutcome) => void;
    const promise = new Promise<AuthoringOutcome>((settle) => { resolve = settle; });
    let lease: InteractionLease | undefined;
    try {
      lease = this.#runtime.adapters.interaction?.acquire('authoring');
    } catch (cause) {
      const error = new AdapterError('interaction lease acquisition', cause);
      const outcome = Object.freeze({ status: 'failed' as const, error });
      this.#announce(error.message);
      resolve(outcome);
      this.#publish();
      return promise;
    }
    const activeElement = this.#boundary.ownerDocument.activeElement;
    const multiPoint = options.multiPoint === true;
    const session: ActiveSession = {
      id: this.#sequence,
      draft: options.draft,
      multiPoint,
      resolve,
      promise,
      ...(lease === undefined ? {} : { lease }),
      ...(isHtmlElement(activeElement) ? { restoreFocus: activeElement } : {}),
      cleanup: [],
      pick: undefined,
      preview: options.anchor === undefined ? null : { anchor: options.anchor },
      anchor: options.anchor,
      vertices: [],
      phase: multiPoint && options.anchor !== undefined ? 'drawing' : 'aiming',
    };
    this.#active = session;
    this.#connectInput(session);
    this.#announce(multiPoint
      ? options.anchor === undefined
        ? 'Click the leader arrow point'
        : 'Click each leader point, then press Enter'
      : options.anchor === undefined
        ? 'Choose an annotation anchor'
        : 'Creating annotation');
    this.#publish();
    if (options.anchor !== undefined && !multiPoint) {
      queueMicrotask(() => {
        if (this.#active === session) this.complete(options.anchor as Anchor);
      });
    }
    return promise;
  }

  public pointerMove(pointer: NormalizedPointerInput): void {
    validatePointer(pointer);
    const active = this.#active;
    if (active === undefined || active.phase === 'pending-pick') return;
    if (!active.multiPoint) {
      active.preview = Object.freeze({ pointer: Object.freeze({ ...pointer }) });
      this.#publish(true);
      return;
    }
    const live = this.#toScreen(active, pointer);
    if (live === null) return;
    active.preview = this.#buildPreview(active, live, pointer);
    this.#publish(true);
  }

  public async pointerDown(pointer: NormalizedPointerInput): Promise<void> {
    validatePointer(pointer);
    const active = this.#active;
    if (active === undefined || active.phase === 'pending-pick') return;
    // Only the first click hits the model. The rest are bends in the leader, which live on screen
  // rather than in the scene — a bend does not point at anything.
    if (active.multiPoint && active.anchor !== undefined) {
      const point = this.#toScreen(active, pointer);
      if (point !== null) this.#appendVertex(active, point, pointer);
      return;
    }
    if (this.#picking === undefined) {
      this.#fail(active, new InvalidInputError('The host adapter does not provide accurate picking'));
      return;
    }
    active.phase = 'pending-pick';
    active.preview = Object.freeze({ pointer: Object.freeze({ ...pointer }) });
    const controller = new AbortController();
    active.pick = controller;
    this.#announce('Picking model anchor');
    this.#publish(true);
    try {
      const anchor = await this.#picking.pick({ pointer }, controller.signal);
      if (this.#active !== active || active.pick !== controller || controller.signal.aborted) return;
      active.pick = undefined;
      if (anchor === null) {
        this.#fail(active, new InvalidInputError('No model anchor was found at that point'));
        return;
      }
      if (active.multiPoint) {
        active.anchor = anchor;
        const point = this.#toScreen(active, pointer);
        if (point !== null) this.#appendVertex(active, point, pointer);
        return;
      }
      active.preview = Object.freeze({ anchor });
      this.complete(anchor);
    } catch (cause) {
      if (this.#active !== active || active.pick !== controller || controller.signal.aborted) return;
      active.pick = undefined;
      this.#fail(active, new AdapterError('accurate picking', cause));
    }
  }

  public complete(anchor: Anchor): AuthoringOutcome | null {
    const active = this.#active;
    if (active === undefined) return null;
    return this.#create(active, { anchor }, 'Create annotation');
  }

  /**
   * Adds one bend to the leader being drawn. Lets a keyboard or a script draw exactly the same route
   * a pointer would, without having to fake pointer positions.
   */
  public addVertex(point: Vec2): AuthoringSnapshot {
    const active = this.#active;
    if (active === undefined || !active.multiPoint) {
      throw new InvalidInputError('No multi-point authoring session is active');
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new InvalidInputError('Manual route vertex must be finite');
    }
    this.#appendVertex(active, { x: point.x, y: point.y });
    return this.getSnapshot();
  }

  /** Finishes the annotation and writes it, as a single undo step for the whole gesture. */
  public finish(): AuthoringOutcome | null {
    const active = this.#active;
    if (active === undefined || !active.multiPoint) return null;
    const landing = active.vertices.at(-1);
    if (active.anchor === undefined || active.phase !== 'ready' || landing === undefined) {
      const error = new InvalidInputError('A manual leader needs an arrow point and at least two route points');
      const outcome = Object.freeze({ status: 'failed' as const, error });
      this.#finish(active, outcome, error.message);
      return outcome;
    }
    return this.#create(active, {
      anchor: active.anchor,
      routing: { kind: 'manual', vertices: active.vertices.map((vertex) => ({ ...vertex })) },
      // Where the drafter stopped clicking is where they wanted the note, so that is where it goes.
      ...(active.draft.placement === undefined
        ? { placement: { kind: 'manual' as const, position: { ...landing } } }
        : {}),
    }, 'Create manual leader');
  }

  public cancel(reason: AuthoringCancellationReason = 'host'): AuthoringOutcome | null {
    return this.#cancel(reason, true);
  }

  #cancel(reason: AuthoringCancellationReason, publish: boolean): AuthoringOutcome | null {
    const active = this.#active;
    if (active === undefined) return null;
    const outcome = Object.freeze({ status: 'cancelled' as const, reason });
    this.#finish(active, outcome, cancellationStatus(reason), publish);
    return outcome;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancel('disposed', false);
    this.#documentUnsubscribe();
    this.#listeners.clear();
    this.#statusElement.remove();
  }

  #create(
    active: ActiveSession,
    parts: Pick<AnnotationDraft, 'anchor' | 'routing' | 'placement'>,
    label: string,
  ): AuthoringOutcome {
    try {
      const annotation = this.#document.create({ ...active.draft, ...parts }, label);
      const outcome = Object.freeze({ status: 'completed' as const, annotation });
      this.#finish(active, outcome, 'Annotation created');
      return outcome;
    } catch (cause) {
      const error = cause instanceof ViewLeaderError
        ? cause
        : new InvalidInputError('Annotation completion failed', { cause });
      const outcome = Object.freeze({ status: 'failed' as const, error });
      this.#finish(active, outcome, error.message);
      return outcome;
    }
  }

  #appendVertex(active: ActiveSession, point: Vec2, pointer?: NormalizedPointerInput): void {
    const previous = active.vertices.at(-1);
    // A double-click sends two presses at the same spot. The first added a bend and the second
  // finishes the leader — it must not add a bend of its own on the way.
    const duplicate = previous !== undefined
      && Math.abs(previous.x - point.x) <= 1e-9 && Math.abs(previous.y - point.y) <= 1e-9;
    const full = active.vertices.length >= MAX_MANUAL_VERTICES;
    if (!duplicate && !full) active.vertices.push(point);
    active.phase = active.vertices.length >= 2 ? 'ready' : 'drawing';
    active.preview = this.#buildPreview(active, point, pointer);
    this.#announce(full
      ? 'Manual route vertex limit reached'
      : active.phase === 'ready'
        ? `Leader route has ${active.vertices.length} points; press Enter to finish`
        : 'Click each leader point, then press Enter');
    this.#publish(true);
  }

  #buildPreview(
    active: ActiveSession,
    livePoint: Vec2,
    pointer: NormalizedPointerInput | undefined,
  ): AuthoringPreview {
    return Object.freeze({
      ...(pointer === undefined ? {} : { pointer: Object.freeze({ ...pointer }) }),
      ...(active.anchor === undefined ? {} : { anchor: active.anchor }),
      vertices: Object.freeze(active.vertices.map((vertex) => Object.freeze({ ...vertex }))),
      livePoint: Object.freeze({ ...livePoint }),
    });
  }

  /** Bends are stored in screen coordinates, so a pointer position is scaled by the viewport size. */
  #toScreen(active: ActiveSession, pointer: NormalizedPointerInput): Vec2 | null {
    try {
      const viewport = this.#runtime.viewport;
      return { x: pointer.x * viewport.width, y: pointer.y * viewport.height };
    } catch (cause) {
      this.#fail(active, new AdapterError('viewport snapshot', cause));
      return null;
    }
  }

  #connectInput(session: ActiveSession): void {
    const pointerMove = (event: Event): void => {
      if (isPointerEvent(event)) this.pointerMove(normalizePointer(event, this.#boundary));
    };
    const pointerDown = (event: Event): void => {
      if (isPointerEvent(event)) void this.pointerDown(normalizePointer(event, this.#boundary));
    };
    const pointerLeave = (): void => {
      if (this.#active !== session) return;
      this.cancel('pointer-exit');
    };
    const keyDown = (event: KeyboardEvent): void => {
      if (this.#active !== session) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.cancel('escape');
        return;
      }
      if (event.key === 'Enter' && session.multiPoint) {
        event.preventDefault();
        this.finish();
      }
    };
    if (session.multiPoint) {
      const doubleClick = (): void => { if (this.#active === session) this.finish(); };
      this.#boundary.addEventListener('dblclick', doubleClick);
      session.cleanup.push(() => this.#boundary.removeEventListener('dblclick', doubleClick));
    }
    this.#boundary.addEventListener('pointermove', pointerMove);
    this.#boundary.addEventListener('pointerdown', pointerDown);
    this.#boundary.addEventListener('pointerleave', pointerLeave);
    this.#boundary.ownerDocument.addEventListener('keydown', keyDown);
    session.cleanup.push(
      () => this.#boundary.removeEventListener('pointermove', pointerMove),
      () => this.#boundary.removeEventListener('pointerdown', pointerDown),
      () => this.#boundary.removeEventListener('pointerleave', pointerLeave),
      () => this.#boundary.ownerDocument.removeEventListener('keydown', keyDown),
    );
  }

  #fail(active: ActiveSession, error: ViewLeaderError): void {
    const outcome = Object.freeze({ status: 'failed' as const, error });
    this.#finish(active, outcome, error.message);
  }

  #finish(
    active: ActiveSession,
    outcome: AuthoringOutcome,
    status: string,
    publish = true,
  ): void {
    if (this.#active !== active) return;
    this.#active = undefined;
    active.pick?.abort();
    active.pick = undefined;
    for (const cleanup of active.cleanup.splice(0)) cleanup();
    try { active.lease?.release(); } catch { /* lease ownership has still ended */ }
    active.resolve(outcome);
    this.#announce(status);
    if (publish) this.#publish(true);
    if (active.restoreFocus?.isConnected) {
      queueMicrotask(() => active.restoreFocus?.focus());
    }
  }

  #announce(status: string): void {
    this.#status = status;
    this.#statusElement.textContent = status;
  }

  #publish(render = false): void {
    this.#runtime.publishTransientChange(render);
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* authoring observers are isolated */ }
    }
  }
}

function cancellationStatus(reason: AuthoringCancellationReason): string {
  switch (reason) {
    case 'escape': return 'Annotation creation cancelled';
    case 'preempted': return 'Previous annotation tool cancelled';
    case 'pointer-exit': return 'Annotation creation cancelled after pointer exit';
    case 'document-replaced': return 'Annotation creation cancelled because the document changed';
    case 'disposed': return 'Annotation authoring disposed';
    case 'host': return 'Annotation creation cancelled';
  }
}

function isHtmlElement(value: Element | null): value is HTMLElement {
  return value !== null && 'focus' in value && typeof (value as { focus?: unknown }).focus === 'function';
}
