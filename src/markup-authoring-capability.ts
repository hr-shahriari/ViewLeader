// The public way to draw markup: start a tool, move the pointer, finish or cancel.
//
// Everything drawn stays out of the document until the shape is complete, so an abandoned cloud
// leaves nothing behind and a finished one is a single undo step.
import type { DocumentEngine } from './document.js';
import {
  AdapterError,
  DisposedError,
  InvalidInputError,
  InvariantViolationError,
  NotFoundError,
  ViewLeaderError,
} from './errors.js';
import type {
  InteractionAdapter,
  InteractionLease,
  NormalizedPointerInput,
  SurfacePickingAdapter,
} from './host.js';
import {
  MarkupAuthoringSession,
  inkFromJson,
  inkToJson,
  legRouteToCore,
  regionAnchorFromCore,
  regionAnchorToCore,
  worldPointToDrawingPlane,
  type GeometryLimits,
  type InkAnnotation,
  type MarkupAuthoringPreview,
  type MarkupToolKind,
  type RegionAnchor,
} from './markup.js';
import type { LegRoute } from './routing.js';
import type {
  Anchor,
  Annotation,
  AnnotationContent,
  AnnotationDraft,
  AnnotationLeg,
  NamespacedMetadata,
  SnapshotStamp,
  Unsubscribe,
  Vec2,
} from './types.js';

export interface CommitRegionOptions {
  readonly legId?: string;
  readonly route?: LegRoute;
}

export interface CommitInkOptions {
  readonly id: string;
  readonly metadata?: NamespacedMetadata;
  readonly styleId?: string;
}

export type MarkupAnnotationDraft = Omit<AnnotationDraft, 'anchor' | 'anchors' | 'routing'>;

export type MarkupAuthoringCancellationReason =
  | 'host'
  | 'escape'
  | 'preempted'
  | 'pointer-exit'
  | 'document-replaced'
  | 'disposed';

export type MarkupAuthoringOutcome =
  | { readonly status: 'completed'; readonly value: Annotation | InkAnnotation }
  | { readonly status: 'cancelled'; readonly reason: MarkupAuthoringCancellationReason }
  | { readonly status: 'failed'; readonly error: ViewLeaderError };

interface StartMarkupBase {
  readonly limits?: GeometryLimits;
  readonly plane?: import('./markup.js').DrawingPlane;
}

export interface StartRegionMarkupAuthoringOptions extends StartMarkupBase {
  readonly kind: Exclude<MarkupToolKind, 'ink'>;
  readonly draft: MarkupAnnotationDraft;
  readonly commit?: CommitRegionOptions;
}

export interface StartInkMarkupAuthoringOptions extends StartMarkupBase {
  readonly kind: 'ink';
  readonly commit: CommitInkOptions;
}

export type StartMarkupAuthoringOptions =
  | StartRegionMarkupAuthoringOptions
  | StartInkMarkupAuthoringOptions;

export interface ManagedMarkupAuthoringPreview extends MarkupAuthoringPreview {
  readonly pointer: NormalizedPointerInput | null;
  readonly pointerPoints: readonly Vec2[];
}

export interface MarkupAuthoringSnapshot extends SnapshotStamp {
  readonly phase: 'idle' | 'awaiting-plane' | 'pending-pick' | 'drawing' | 'ready';
  readonly sessionId: number | null;
  readonly pendingPick: boolean;
  readonly preview: ManagedMarkupAuthoringPreview | null;
  readonly status: string;
}

/**
 * Hooks a host provides so a drawing tool can do its job: find where the pointer meets the model,
 * and stop the camera moving while the user draws.
 */
export interface MarkupAuthoringIntegration {
  readonly boundary?: Element;
  readonly surfacePicking?: SurfacePickingAdapter;
  readonly interaction?: InteractionAdapter;
  readonly getStamp?: () => SnapshotStamp;
  readonly publishTransientChange?: (render?: boolean) => void;
  readonly preemptOthers?: () => void;
}

interface ActiveMarkupAuthoring {
  readonly id: number;
  readonly options: StartMarkupAuthoringOptions;
  readonly session: MarkupAuthoringSession;
  readonly promise: Promise<MarkupAuthoringOutcome>;
  readonly resolve: (outcome: MarkupAuthoringOutcome) => void;
  readonly lease?: InteractionLease;
  readonly cleanup: (() => void)[];
  pick: AbortController | undefined;
  pointer: NormalizedPointerInput | null;
  gestureStartPointer: NormalizedPointerInput | null;
  pointerPoints: Vec2[];
  drawing: boolean;
  phase: Exclude<MarkupAuthoringSnapshot['phase'], 'idle'>;
  detached: boolean;
  settled: boolean;
}

/**
 * Runs markup tools and commits what they produce.
 *
 * A drawing session lives entirely in memory. Only when the shape is finished does anything reach
 * the document, and then in one transaction — so a cloud is one undo, not one per point.
 */
export class MarkupAuthoringCapability {
  readonly #document: DocumentEngine;
  readonly #assertActive: () => void;
  readonly #prepareContent: (content: AnnotationContent) => AnnotationContent;
  readonly #validateStyleId: (styleId: string | undefined) => void;
  readonly #integration: MarkupAuthoringIntegration;
  readonly #listeners = new Set<() => void>();
  readonly #documentUnsubscribe: Unsubscribe | undefined;
  #active: ActiveMarkupAuthoring | undefined;
  #legacySession: MarkupAuthoringSession | undefined;
  #sequence = 0;
  #status = 'Markup authoring inactive';
  #disposed = false;

  public constructor(
    document: DocumentEngine,
    assertActive: () => void = () => undefined,
    prepareContent: (content: AnnotationContent) => AnnotationContent = (content) => content,
    validateStyleId: (styleId: string | undefined) => void = () => undefined,
    integration: MarkupAuthoringIntegration = {},
  ) {
    this.#document = document;
    this.#assertActive = assertActive;
    this.#prepareContent = prepareContent;
    this.#validateStyleId = validateStyleId;
    this.#integration = integration;
    this.#documentUnsubscribe = integration.boundary === undefined
      ? undefined
      : document.subscribe((commit) => {
        if (commit.kind === 'replacement') this.#cancel('document-replaced', false);
      });
  }

  public begin(kind: MarkupToolKind, limits?: GeometryLimits): MarkupAuthoringSession {
    this.#assertUsable();
    this.cancel('preempted');
    this.#legacySession?.cancel();
    this.#integration.preemptOthers?.();
    const session = limits === undefined
      ? new MarkupAuthoringSession(kind)
      : new MarkupAuthoringSession(kind, limits);
    this.#legacySession = session;
    return session;
  }

  public getSnapshot(): MarkupAuthoringSnapshot {
    this.#assertUsable();
    const stamp = this.#integration.getStamp?.() ?? {
      runtimeRevision: 0,
      documentRevision: this.#document.documentRevision,
    };
    const active = this.#active;
    return Object.freeze({
      ...stamp,
      phase: active?.phase ?? 'idle',
      sessionId: active?.id ?? null,
      pendingPick: active?.phase === 'pending-pick',
      preview: active === undefined
        ? null
        : immutablePreview(active.session.preview, active.pointer, active.pointerPoints),
      status: this.#status,
    });
  }

  public subscribe(listener: () => void): Unsubscribe {
    this.#assertUsable();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Starts a drawing tool — a cloud, a rectangle, an ellipse, a polygon, or freehand ink.
   *
   * Takes over the pointer so the camera stays still while drawing. Nothing is written to the
   * document until `complete()`; cancelling leaves no trace.
   */
  public start(options: StartMarkupAuthoringOptions): Promise<MarkupAuthoringOutcome> {
    this.#assertUsable();
    this.cancel('preempted');
    this.#legacySession?.cancel();
    this.#legacySession = undefined;
    this.#integration.preemptOthers?.();
    const normalizedOptions = structuredClone(options);
    const session = normalizedOptions.limits === undefined
      ? new MarkupAuthoringSession(normalizedOptions.kind)
      : new MarkupAuthoringSession(normalizedOptions.kind, normalizedOptions.limits);
    if (normalizedOptions.plane !== undefined) session.establishPlane(normalizedOptions.plane);
    let resolve!: (outcome: MarkupAuthoringOutcome) => void;
    const promise = new Promise<MarkupAuthoringOutcome>((settle) => { resolve = settle; });
    let lease: InteractionLease | undefined;
    try {
      lease = this.#integration.interaction?.acquire('authoring');
    } catch (cause) {
      const error = new AdapterError('interaction lease acquisition', cause);
      resolve(Object.freeze({ status: 'failed', error }));
      this.#status = error.message;
      this.#publish();
      return promise;
    }
    this.#sequence += 1;
    const active: ActiveMarkupAuthoring = {
      id: this.#sequence,
      options: normalizedOptions,
      session,
      promise,
      resolve,
      ...(lease === undefined ? {} : { lease }),
      cleanup: [],
      pick: undefined,
      pointer: null,
      gestureStartPointer: null,
      pointerPoints: [],
      drawing: false,
      phase: normalizedOptions.plane === undefined ? 'awaiting-plane' : 'drawing',
      detached: false,
      settled: false,
    };
    this.#active = active;
    this.#connectInput(active);
    this.#status = normalizedOptions.plane === undefined
      ? `Choose a drawing plane for ${normalizedOptions.kind}`
      : `${normalizedOptions.kind} authoring active`;
    this.#publish(true);
    return promise;
  }

  public async pointerMove(pointer: NormalizedPointerInput): Promise<void> {
    this.#assertUsable();
    validateNormalizedPointer(pointer);
    const active = this.#active;
    if (active === undefined) return;
    active.pointer = Object.freeze({ ...pointer });
    if (!active.drawing) {
      if (active.phase !== 'pending-pick') this.#publish(true);
      return;
    }
    await this.#samplePointer(active, pointer, 'move');
  }

  public async pointerDown(pointer: NormalizedPointerInput): Promise<void> {
    this.#assertUsable();
    validateNormalizedPointer(pointer);
    const active = this.#active;
    if (active === undefined || active.drawing) return;
    active.gestureStartPointer = Object.freeze({ ...pointer });
    await this.#samplePointer(active, pointer, 'down');
  }

  public async pointerUp(pointer: NormalizedPointerInput): Promise<void> {
    this.#assertUsable();
    validateNormalizedPointer(pointer);
    const active = this.#active;
    if (active === undefined) return;
    if (!active.drawing) {
      const start = active.gestureStartPointer;
      if (start === null) return;
      active.pick?.abort();
      await this.#samplePointer(active, start, 'down');
      if (this.#active !== active || !active.drawing) return;
    }
    await this.#samplePointer(active, pointer, 'up');
  }

  /**
   * Starts a tool on a plane given directly, rather than one worked out from where the user
   * clicked. For keyboard-driven drawing and for scripts, neither of which has a pointer to ask.
   */
  public establishPlane(
    plane: import('./markup.js').DrawingPlane,
    source: 'keyboard' | 'programmatic' = 'programmatic',
  ): MarkupAuthoringSnapshot {
    const active = this.#requireActive();
    active.pick?.abort();
    active.pick = undefined;
    active.session.establishPlane(plane);
    active.phase = 'drawing';
    this.#status = `${active.options.kind} drawing plane supplied by ${source}`;
    this.#publish(true);
    return this.getSnapshot();
  }

  public setRegionGeometry(
    geometry: import('./markup.js').ClosedRegionGeometry,
    source: 'keyboard' | 'programmatic' = 'programmatic',
  ): MarkupAuthoringSnapshot {
    const active = this.#requireActive();
    active.session.setRegionGeometry(geometry);
    active.phase = 'ready';
    this.#status = `${geometry.kind} preview updated by ${source}`;
    this.#publish(true);
    return this.getSnapshot();
  }

  public appendInkPoint(
    point: import('./types.js').Vec2,
    source: 'keyboard' | 'programmatic' = 'programmatic',
  ): MarkupAuthoringSnapshot {
    const active = this.#requireActive();
    const points = active.session.appendInkPoint(point);
    active.phase = points.length >= 2 ? 'ready' : 'drawing';
    this.#status = `Ink preview updated by ${source}`;
    this.#publish(true);
    return this.getSnapshot();
  }

  public complete(): MarkupAuthoringOutcome | null {
    this.#assertUsable();
    const active = this.#active;
    if (active === undefined) return null;
    if (active.phase !== 'ready') {
      const error = new InvalidInputError('Markup authoring is not ready to complete');
      const outcome = Object.freeze({ status: 'failed' as const, error });
      this.#finish(active, outcome, error.message);
      return outcome;
    }
    try {
      const value = this.#document.transaction(`Create ${active.options.kind}`, () => {
        const committed = active.options.kind === 'ink'
          ? this.commitInk(active.session, active.options.commit)
          : this.commitRegion(active.session, active.options.draft, active.options.commit);
        this.#quiesce(active);
        this.#status = `${active.options.kind} created`;
        return committed;
      });
      const outcome = Object.freeze({ status: 'completed' as const, value });
      active.settled = true;
      active.resolve(outcome);
      this.#notifyListeners();
      return outcome;
    } catch (cause) {
      const error = cause instanceof ViewLeaderError
        ? cause
        : new InvalidInputError('Markup completion failed', { cause });
      const outcome = Object.freeze({ status: 'failed' as const, error });
      this.#finish(active, outcome, error.message);
      return outcome;
    }
  }

  public cancel(
    reason: MarkupAuthoringCancellationReason = 'host',
  ): MarkupAuthoringOutcome | null {
    this.#assertUsable();
    return this.#cancel(reason, true);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancel('disposed', false);
    this.#legacySession?.cancel();
    this.#legacySession = undefined;
    this.#documentUnsubscribe?.();
    this.#listeners.clear();
  }

  #cancel(
    reason: MarkupAuthoringCancellationReason,
    publish: boolean,
  ): MarkupAuthoringOutcome | null {
    const active = this.#active;
    if (active === undefined) {
      if (this.#legacySession === undefined) return null;
      this.#legacySession.cancel();
      this.#legacySession = undefined;
      const outcome = Object.freeze({ status: 'cancelled' as const, reason });
      this.#status = markupCancellationStatus(reason);
      if (publish) this.#publish(true);
      return outcome;
    }
    active.session.cancel();
    const outcome = Object.freeze({ status: 'cancelled' as const, reason });
    this.#finish(active, outcome, markupCancellationStatus(reason), publish);
    return outcome;
  }

  public commitRegion(
    session: MarkupAuthoringSession,
    draft: MarkupAnnotationDraft,
    options: CommitRegionOptions = {},
  ): Annotation {
    this.#assertUsable();
    this.#validateStyleId(draft.styleId);
    const anchor = session.completeRegion();
    const result = this.#document.create({
      ...draft,
      content: this.#prepareContent(draft.content),
      anchors: [{
        id: options.legId ?? 'leg-1',
        anchor: regionAnchorToCore(anchor),
        routing: legRouteToCore(options.route ?? { mode: 'dogleg' }),
      }],
    }, `Create ${anchor.geometry.kind} annotation`);
    if (this.#legacySession === session) this.#legacySession = undefined;
    return result;
  }

  public commitInk(
    session: MarkupAuthoringSession,
    options: CommitInkOptions,
  ): InkAnnotation {
    this.#assertUsable();
    this.#validateStyleId(options.styleId);
    const ink = session.completeInk(options.id, options.metadata ?? {}, options.styleId);
    const result = this.#document.edit('Create ink', (document) => {
      const records = document.ink.map((stored) => inkFromJson(stored));
      if (records.some(({ id }) => id === ink.id)) {
        throw new InvalidInputError(`Ink "${ink.id}" already exists`, { id: ink.id });
      }
      return {
        document: { ...document, ink: [...document.ink, inkToJson(ink)] },
        result: ink,
      };
    });
    if (this.#legacySession === session) this.#legacySession = undefined;
    return result;
  }

  public listInk(): readonly InkAnnotation[] {
    this.#assertUsable();
    return this.#document.document.ink.map((stored) => inkFromJson(stored));
  }

  public getInk(id: string): InkAnnotation | undefined {
    this.#assertUsable();
    return this.listInk().find((ink) => ink.id === id);
  }

  public updateInk(
    id: string,
    update: (current: InkAnnotation) => InkAnnotation,
    label = 'Update ink',
  ): InkAnnotation {
    this.#assertUsable();
    return this.#document.edit(label, (document) => {
      const records = document.ink.map((stored) => inkFromJson(stored));
      const index = records.findIndex((ink) => ink.id === id);
      const current = records[index];
      if (current === undefined) throw new NotFoundError('ink', id);
      const next = update(structuredClone(current));
      if (next.id !== id) throw new InvalidInputError('An ink update cannot change its id');
      this.#validateStyleId(next.styleId);
      const ink = [...document.ink];
      ink[index] = inkToJson(next);
      return { document: { ...document, ink }, result: next };
    });
  }

  public removeInk(id: string): InkAnnotation {
    this.#assertUsable();
    return this.#document.edit('Remove ink', (document) => {
      const records = document.ink.map((stored) => inkFromJson(stored));
      const removed = records.find((ink) => ink.id === id);
      if (removed === undefined) throw new NotFoundError('ink', id);
      return {
        document: { ...document, ink: document.ink.filter((_, index) => records[index]?.id !== id) },
        result: removed,
      };
    });
  }

  public updateRegion(
    annotationId: string,
    legId: string,
    update: (current: RegionAnchor) => RegionAnchor,
    label = 'Update region',
  ): Annotation {
    this.#assertUsable();
    const annotation = this.#requireAnnotation(annotationId);
    const leg = requireLeg(annotation, legId);
    if (leg.anchor.kind !== 'region') {
      throw new InvalidInputError(`Anchor leg "${legId}" is not a region`, { annotationId, legId });
    }
    const updated = update(regionAnchorFromCore(leg.anchor));
    const anchors = annotation.anchors.map((candidate) => candidate.id === legId
      ? { ...candidate, anchor: regionAnchorToCore(updated) }
      : candidate);
    return this.#document.update(annotationId, { anchors }, label);
  }

  public addAnchor(
    annotationId: string,
    leg: AnnotationLeg,
    index?: number,
  ): Annotation {
    this.#assertUsable();
    const annotation = this.#requireAnnotation(annotationId);
    if (annotation.anchors.some(({ id }) => id === leg.id)) {
      throw new InvalidInputError(`Duplicate anchor leg "${leg.id}"`, { annotationId, legId: leg.id });
    }
    const target = index ?? annotation.anchors.length;
    assertInsertionIndex(target, annotation.anchors.length);
    const anchors = [
      ...annotation.anchors.slice(0, target),
      structuredClone(leg),
      ...annotation.anchors.slice(target),
    ];
    return this.#document.update(annotationId, { anchors }, 'Add annotation anchor');
  }

  public retargetAnchor(annotationId: string, legId: string, anchor: Anchor): Annotation {
    this.#assertUsable();
    const annotation = this.#requireAnnotation(annotationId);
    requireLeg(annotation, legId);
    const anchors = annotation.anchors.map((leg) => leg.id === legId
      ? { ...leg, anchor: structuredClone(anchor) }
      : leg);
    return this.#document.update(annotationId, { anchors }, 'Retarget annotation anchor');
  }

  public setLegRoute(annotationId: string, legId: string, route: LegRoute): Annotation {
    this.#assertUsable();
    const annotation = this.#requireAnnotation(annotationId);
    requireLeg(annotation, legId);
    const anchors = annotation.anchors.map((leg) => leg.id === legId
      ? { ...leg, routing: legRouteToCore(route) }
      : leg);
    return this.#document.update(annotationId, { anchors }, 'Edit annotation route');
  }

  public removeAnchor(annotationId: string, legId: string): Annotation {
    this.#assertUsable();
    const annotation = this.#requireAnnotation(annotationId);
    requireLeg(annotation, legId);
    if (annotation.anchors.length === 1) {
      throw new InvariantViolationError('Cannot remove the final annotation anchor', {
        annotationId,
        anchorId: legId,
        minimumAnchors: 1,
      });
    }
    return this.#document.update(annotationId, {
      anchors: annotation.anchors.filter(({ id }) => id !== legId),
    }, 'Remove annotation anchor');
  }

  public reorderAnchor(annotationId: string, legId: string, toIndex: number): Annotation {
    this.#assertUsable();
    const annotation = this.#requireAnnotation(annotationId);
    const leg = requireLeg(annotation, legId);
    assertExistingIndex(toIndex, annotation.anchors.length);
    const anchors = annotation.anchors.filter(({ id }) => id !== legId);
    anchors.splice(toIndex, 0, leg);
    return this.#document.update(annotationId, { anchors }, 'Reorder annotation anchor');
  }

  #requireAnnotation(id: string): Annotation {
    const annotation = this.#document.get(id);
    if (annotation === undefined) throw new NotFoundError('annotation', id);
    return annotation;
  }

  #requireActive(): ActiveMarkupAuthoring {
    this.#assertUsable();
    const active = this.#active;
    if (active === undefined) throw new InvalidInputError('No markup authoring tool is active');
    return active;
  }

  #connectInput(active: ActiveMarkupAuthoring): void {
    const boundary = this.#integration.boundary;
    if (boundary === undefined) return;
    const pointerMove = (event: Event): void => {
      if (isPointerEvent(event)) void this.pointerMove(normalizePointer(event, boundary));
    };
    const pointerDown = (event: Event): void => {
      if (isPointerEvent(event)) void this.pointerDown(normalizePointer(event, boundary));
    };
    const pointerLeave = (): void => {
      if (this.#active === active) this.cancel('pointer-exit');
    };
    const pointerUp = (event: Event): void => {
      if (isPointerEvent(event)) void this.pointerUp(normalizePointer(event, boundary));
    };
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && this.#active === active) {
        event.preventDefault();
        this.cancel('escape');
      }
    };
    boundary.addEventListener('pointermove', pointerMove);
    boundary.addEventListener('pointerdown', pointerDown);
    boundary.addEventListener('pointerleave', pointerLeave);
    boundary.addEventListener('pointerup', pointerUp);
    boundary.ownerDocument.addEventListener('keydown', keyDown);
    active.cleanup.push(
      () => boundary.removeEventListener('pointermove', pointerMove),
      () => boundary.removeEventListener('pointerdown', pointerDown),
      () => boundary.removeEventListener('pointerleave', pointerLeave),
      () => boundary.removeEventListener('pointerup', pointerUp),
      () => boundary.ownerDocument.removeEventListener('keydown', keyDown),
    );
  }

  #fail(active: ActiveMarkupAuthoring, error: ViewLeaderError): void {
    this.#finish(active, Object.freeze({ status: 'failed', error }), error.message);
  }

  async #samplePointer(
    active: ActiveMarkupAuthoring,
    pointer: NormalizedPointerInput,
    stage: 'down' | 'move' | 'up',
  ): Promise<void> {
    const picking = this.#integration.surfacePicking;
    if (picking === undefined) {
      this.#fail(active, new InvalidInputError('The host adapter does not provide accurate surface picking'));
      return;
    }
    active.pick?.abort();
    const controller = new AbortController();
    active.pick = controller;
    active.pointer = Object.freeze({ ...pointer });
    active.phase = 'pending-pick';
    this.#status = stage === 'down' && active.session.preview.plane === null
      ? 'Picking a model drawing plane'
      : `Sampling ${active.options.kind} geometry`;
    this.#publish(true);
    try {
      const hit = await picking.pickSurface({ pointer }, controller.signal);
      if (this.#active !== active || active.pick !== controller || controller.signal.aborted) return;
      active.pick = undefined;
      if (hit === null) {
        if (stage === 'down') {
          this.#fail(active, new InvalidInputError('No model surface was found at that point'));
        } else {
          active.phase = 'drawing';
          this.#status = 'No model surface sample was found';
          this.#publish(true);
        }
        return;
      }
      if (active.session.preview.plane === null) active.session.establishPlaneFromPick(hit);
      const establishedPlane = active.session.preview.plane;
      if (establishedPlane === null) throw new InvalidInputError('Drawing plane was not established');
      const local = worldPointToDrawingPlane(establishedPlane, hit.point);
      if (stage === 'down') {
        active.pointerPoints = [local];
        active.drawing = true;
        if (active.options.kind === 'ink') active.session.appendInkPoint(local);
      } else {
        this.#appendPointerSample(active, local);
      }
      const ready = this.#updatePointerPreview(active);
      if (stage === 'up') {
        active.drawing = false;
        active.gestureStartPointer = null;
      }
      active.phase = stage === 'up' && ready ? 'ready' : 'drawing';
      this.#status = active.phase === 'ready'
        ? `${active.options.kind} pointer drawing ready`
        : `Drawing ${active.options.kind}`;
      this.#publish(true);
    } catch (cause) {
      if (this.#active !== active || active.pick !== controller || controller.signal.aborted) return;
      active.pick = undefined;
      this.#fail(active, cause instanceof ViewLeaderError
        ? cause
        : new AdapterError('accurate surface picking', cause));
    }
  }

  #appendPointerSample(active: ActiveMarkupAuthoring, point: Vec2): void {
    const previous = active.pointerPoints.at(-1);
    if (previous !== undefined && samePoint(previous, point)) return;
    active.pointerPoints.push(point);
    if (active.options.kind === 'ink') active.session.appendInkPoint(point);
  }

  #updatePointerPreview(active: ActiveMarkupAuthoring): boolean {
    const points = active.pointerPoints;
    if (active.options.kind === 'ink') return active.session.preview.inkPoints.length >= 2;
    const start = points[0];
    const end = points.at(-1);
    if (start === undefined || end === undefined) return false;
    if (active.options.kind === 'rectangle' || active.options.kind === 'ellipse') {
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);
      if (width <= 1e-9 || height <= 1e-9) return false;
      const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      active.session.setRegionGeometry(active.options.kind === 'rectangle'
        ? { kind: 'rectangle', center, width, height }
        : { kind: 'ellipse', center, radiusX: width / 2, radiusY: height / 2 });
      return true;
    }
    if (points.length < 3) return false;
    active.session.setRegionGeometry(active.options.kind === 'polygon'
      ? { kind: 'polygon', vertices: points }
      : {
          kind: 'revision-cloud',
          vertices: points,
          arcLength: revisionCloudArcLength(points),
        });
    return true;
  }

  #finish(
    active: ActiveMarkupAuthoring,
    outcome: MarkupAuthoringOutcome,
    status: string,
    publish = true,
  ): void {
    if (active.settled || (!active.detached && this.#active !== active)) return;
    this.#quiesce(active);
    active.settled = true;
    active.resolve(outcome);
    if (this.#active !== undefined) return;
    this.#status = status;
    if (publish) this.#publish(true);
  }

  #quiesce(active: ActiveMarkupAuthoring): void {
    if (active.detached) return;
    if (this.#active === active) this.#active = undefined;
    active.detached = true;
    active.pick?.abort();
    active.pick = undefined;
    for (const cleanup of active.cleanup.splice(0)) cleanup();
    try { active.lease?.release(); } catch { /* lease ownership has ended */ }
  }

  #publish(render = false): void {
    this.#integration.publishTransientChange?.(render);
    this.#notifyListeners();
  }

  #notifyListeners(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* authoring observers are isolated */ }
    }
  }

  #assertUsable(): void {
    this.#assertActive();
    if (this.#disposed) throw new DisposedError();
  }
}

function immutablePreview(
  preview: MarkupAuthoringPreview,
  pointer: NormalizedPointerInput | null,
  pointerPoints: readonly Vec2[],
): ManagedMarkupAuthoringPreview {
  const clone = structuredClone({ ...preview, pointer, pointerPoints });
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  freeze(clone);
  return clone;
}

function samePoint(left: Vec2, right: Vec2): boolean {
  return Math.abs(left.x - right.x) <= 1e-9 && Math.abs(left.y - right.y) <= 1e-9;
}

function revisionCloudArcLength(points: readonly Vec2[]): number {
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const diagonal = Math.hypot(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
  return Math.max(0.001, diagonal / 12);
}

function validateNormalizedPointer(pointer: NormalizedPointerInput): void {
  if (
    !Number.isFinite(pointer.x) || pointer.x < 0 || pointer.x > 1
    || !Number.isFinite(pointer.y) || pointer.y < 0 || pointer.y > 1
  ) {
    throw new InvalidInputError('Normalized pointer coordinates must be between 0 and 1');
  }
}

function normalizePointer(event: PointerEvent, boundary: Element): NormalizedPointerInput {
  const bounds = boundary.getBoundingClientRect();
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  return Object.freeze({
    x: bounds.width === 0 ? 0 : clamp((event.clientX - bounds.left) / bounds.width),
    y: bounds.height === 0 ? 0 : clamp((event.clientY - bounds.top) / bounds.height),
    button: event.button,
    buttons: event.buttons,
    pointerType: event.pointerType === 'pen' || event.pointerType === 'touch'
      ? event.pointerType
      : 'mouse',
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });
}

function isPointerEvent(event: Event): event is PointerEvent {
  return 'clientX' in event && 'clientY' in event && 'pointerType' in event;
}

function markupCancellationStatus(reason: MarkupAuthoringCancellationReason): string {
  switch (reason) {
    case 'escape': return 'Markup authoring cancelled';
    case 'preempted': return 'Previous markup tool cancelled';
    case 'pointer-exit': return 'Markup authoring cancelled after pointer exit';
    case 'document-replaced': return 'Markup authoring cancelled because the document changed';
    case 'disposed': return 'Markup authoring disposed';
    case 'host': return 'Markup authoring cancelled';
  }
}

function requireLeg(annotation: Annotation, legId: string): AnnotationLeg {
  const leg = annotation.anchors.find(({ id }) => id === legId);
  if (leg === undefined) throw new NotFoundError('anchor leg', legId);
  return leg;
}

function assertInsertionIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index > length) {
    throw new InvalidInputError('Anchor insertion index is out of range', { index, length });
  }
}

function assertExistingIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new InvalidInputError('Anchor index is out of range', { index, length });
  }
}
