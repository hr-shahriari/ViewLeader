// The seam between ViewLeader and whatever 3D viewer it is drawing over.
//
// ViewLeader has no idea what Three.js, Cesium or an IFC viewer are. It asks plain questions
// through the interfaces below — where does this world point land on screen, what did the user
// click, is this hidden — and a host answers them. `viewleader/three` is one such answer; a host
// with its own engine writes another.
//
// Only `projection` is required. Everything else is optional, and leaving one out simply turns off
// the feature that depends on it rather than breaking anything.
import { AdapterError, domainError } from './errors.js';
import type { ViewerStateAdapter } from './saved-views/neutral-types.js';
import type {
  Anchor,
  Annotation,
  AnnotationLeg,
  TagReference,
  Unsubscribe,
  Vec2,
  Vec3,
  ViewLeaderDocument,
} from './types.js';

export interface ViewportSnapshot {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export interface ProjectedPoint {
  readonly point: Vec2;
  readonly depth: number;
  readonly visible: boolean;
}

export interface ProjectionAdapter {
  getViewport(): ViewportSnapshot;
  project(point: Vec3, viewport: ViewportSnapshot): ProjectedPoint | null;
  /**
   * A cheap value that changes whenever the camera or viewport does.
   *
   * Supplying it lets ViewLeader skip redrawing entirely while nothing is moving, which is most of
   * the time. It must change whenever projection could produce a different answer — a value that
   * lags behind leaves the overlay showing the previous camera position.
   */
  getRevision?(): string | number;
  connect?(invalidate: () => void): Unsubscribe;
}

export interface ElementResolveRequest {
  readonly modelId: string;
  readonly elementId: string;
}

export interface ElementResolution {
  readonly worldPoint: Vec3;
}

export interface ElementInvalidation {
  readonly modelId?: string;
  readonly elementId?: string;
}

export interface ElementResolutionAdapter {
  resolve(request: ElementResolveRequest, signal: AbortSignal): Promise<ElementResolution | null>;
  subscribe?(listener: (invalidation: ElementInvalidation) => void): Unsubscribe;
}

export interface TagTextInvalidation {
  readonly modelId?: string;
  readonly elementId?: string;
  readonly property?: string;
}

/**
 * Looks up the text behind a tag — a door number, a fire rating — from the model.
 *
 * The companion to {@link ElementResolutionAdapter}: that one answers *where* a tag points, this
 * one answers *what it says*. Same shape on purpose, so a host that has written one already knows
 * how to write the other.
 *
 * Asked once per distinct reference rather than once per frame. Answering with nothing is fine and
 * shows the tag as unresolved rather than blank. Use `subscribe` to say the model has changed and
 * values should be looked up again.
 */
export interface TagTextAdapter {
  resolve(request: TagReference, signal: AbortSignal): Promise<string | null>;
  subscribe?(listener: (invalidation: TagTextInvalidation) => void): Unsubscribe;
}

export interface NormalizedPointerInput {
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly buttons: number;
  readonly pointerType: 'mouse' | 'pen' | 'touch' | 'keyboard' | 'programmatic';
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export interface AccuratePickRequest {
  readonly pointer: NormalizedPointerInput;
}

export interface AccuratePickingAdapter {
  pick(request: AccuratePickRequest, signal: AbortSignal): Promise<Anchor | null>;
}

/**
 * Where the pointer meets the model, and which way that surface faces.
 *
 * The direction is what lets markup be drawn on a flat plane lying against the surface, so a shape
 * drawn on a wall stays on that wall as the camera moves. Only the host can work this out — it is
 * the one with the scene.
 */
export interface SurfacePickResult {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly modelId?: string;
}

export interface SurfacePickingAdapter {
  pickSurface(request: AccuratePickRequest, signal: AbortSignal): Promise<SurfacePickResult | null>;
}

export interface InteractionLease {
  release(): void;
}

export interface InteractionAdapter {
  acquire(reason: 'authoring' | 'editing'): InteractionLease;
}

export interface ResolvedHostImage {
  /** Something the browser can draw: a URL, a blob, or a data URI. ViewLeader never downloads,
   *  decodes or releases it — the host decides what is allowed to load and when to free it. */
  readonly source: string;
  readonly width: number;
  readonly height: number;
}

export interface HostImageAdapter {
  resolve(reference: string, signal: AbortSignal): Promise<ResolvedHostImage>;
}

export interface OcclusionSample {
  readonly annotationId: string;
  readonly legId: string;
  readonly worldPoint: Vec3;
}

export interface OcclusionResult {
  readonly annotationId: string;
  readonly legId: string;
  readonly occluded: boolean;
}

export interface OcclusionAdapter {
  test(samples: readonly OcclusionSample[], signal: AbortSignal): Promise<readonly OcclusionResult[]>;
}

export interface ModelBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * Reports where the model is in the world, so labels can be arranged around it rather than on top
 * of it.
 *
 * Asked on every frame. Answer with nothing when no model is loaded yet, and labels will be placed
 * around their anchors instead. A rectangle drawn by the user overrides this.
 */
export interface ModelBoundsAdapter {
  get(): ModelBounds | null;
}

export interface HostAdapterBundle {
  readonly projection: ProjectionAdapter;
  readonly elements?: ElementResolutionAdapter;
  readonly tagText?: TagTextAdapter;
  readonly picking?: AccuratePickingAdapter;
  readonly surfacePicking?: SurfacePickingAdapter;
  readonly interaction?: InteractionAdapter;
  readonly images?: HostImageAdapter;
  readonly occlusion?: OcclusionAdapter;
  readonly modelBounds?: ModelBoundsAdapter;
  readonly viewerState?: ViewerStateAdapter;
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error' | 'fatal';

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly error?: AdapterError;
  readonly annotationId?: string;
  readonly legId?: string;
}

interface ResolutionRequest {
  readonly key: string;
  readonly token: object;
  readonly controller: AbortController;
}

interface ResolvedLeg {
  readonly status: 'resolved' | 'unresolved';
  readonly worldPoint: Vec3;
}

/**
 * Holds one ViewLeader's connection to its host: the adapters, the in-flight requests, and the
 * answers that have come back.
 *
 * Also the thing that makes disposal safe. Late answers to requests made before disposal are
 * discarded rather than written into an object that is already gone.
 */
export class HostIntegration {
  readonly #adapters: HostAdapterBundle;
  readonly #invalidate: () => void;
  readonly #diagnose: (diagnostic: Diagnostic) => void;
  readonly #cache = new Map<string, ElementResolution>();
  readonly #requests = new Map<string, ResolutionRequest>();
  readonly #cleanups: Unsubscribe[] = [];
  #document: ViewLeaderDocument | undefined;
  #disposed = false;

  public constructor(
    adapters: HostAdapterBundle,
    invalidate: () => void,
    diagnose: (diagnostic: Diagnostic) => void,
  ) {
    if (adapters === null || typeof adapters !== 'object' || adapters.projection === undefined) {
      throw domainError('INVALID_CONFIGURATION', 'A coherent host adapter bundle with projection is required');
    }
    this.#adapters = adapters;
    this.#invalidate = invalidate;
    this.#diagnose = diagnose;
    try {
      if (adapters.projection.connect !== undefined) {
        this.#cleanups.push(adapters.projection.connect(invalidate));
      }
      if (adapters.elements?.subscribe !== undefined) {
        this.#cleanups.push(adapters.elements.subscribe((event) => this.#invalidateElements(event)));
      }
    } catch (error) {
      for (const cleanup of this.#cleanups.splice(0).reverse()) {
        try { cleanup(); } catch { /* continue unwinding staged connections */ }
      }
      throw error;
    }
  }

  public get adapters(): HostAdapterBundle {
    return this.#adapters;
  }

  public get viewport(): ViewportSnapshot {
    const viewport = this.#adapters.projection.getViewport();
    if (
      !Number.isFinite(viewport.width) || viewport.width < 0 ||
      !Number.isFinite(viewport.height) || viewport.height < 0 ||
      !Number.isFinite(viewport.devicePixelRatio) || viewport.devicePixelRatio <= 0
    ) {
      throw new AdapterError('viewport snapshot');
    }
    return Object.freeze({ ...viewport });
  }

  public get projectionRevision(): string | number | undefined {
    const revision = this.#adapters.projection.getRevision?.();
    if (revision === undefined) return undefined;
    if ((typeof revision !== 'string' && typeof revision !== 'number')
      || (typeof revision === 'number' && !Number.isFinite(revision))) {
      throw new AdapterError('projection revision');
    }
    return revision;
  }

  /** Where the model is, or nothing if there is no model yet or the host gave an unusable box. */
  public modelBounds(): ModelBounds | null {
    const bounds = this.#adapters.modelBounds?.get() ?? null;
    if (bounds === null) return null;
    // Framing is a nicety, not a requirement. A host returning a broken box should cost the frame
  // its layout rectangle, never bring down the drawing loop.
    return isFiniteVec3(bounds.min) && isFiniteVec3(bounds.max) ? bounds : null;
  }

  public project(point: Vec3, viewport: ViewportSnapshot): ProjectedPoint | null {
    const projected = this.#adapters.projection.project(point, viewport);
    if (projected === null) return null;
    if (![projected.point.x, projected.point.y, projected.depth].every(Number.isFinite)) {
      throw new AdapterError('world projection');
    }
    return Object.freeze({
      point: Object.freeze({ ...projected.point }),
      depth: projected.depth,
      visible: projected.visible,
    });
  }

  public sync(document: ViewLeaderDocument, resetEpoch = false): void {
    if (this.#disposed) return;
    this.#document = document;
    if (resetEpoch) this.#abortRequests();
    const expected = new Map<string, { annotation: Annotation; leg: AnnotationLeg }>();
    for (const annotation of document.annotations) {
      for (const leg of annotation.anchors) {
        if (leg.anchor.kind !== 'element') continue;
        expected.set(compositeKey(annotation.id, leg.id), { annotation, leg });
      }
    }
    for (const [id, request] of this.#requests) {
      const target = expected.get(id);
      if (
        target === undefined ||
        target.leg.anchor.kind !== 'element' ||
        request.key !== elementKey(target.leg.anchor)
      ) {
        request.controller.abort();
        this.#requests.delete(id);
      }
    }
    for (const [id, target] of expected) this.#ensureResolution(id, target.annotation, target.leg);
  }

  public resolved(annotationId: string, leg: AnnotationLeg): ResolvedLeg {
    const { anchor } = leg;
    if (anchor.kind === 'world-point') {
      return Object.freeze({ status: 'resolved', worldPoint: anchor.point });
    }
    if (anchor.kind === 'region') {
      return Object.freeze({ status: 'resolved', worldPoint: anchor.fallbackPoint });
    }
    const cached = this.#cache.get(elementKey(anchor));
    return cached === undefined
      ? Object.freeze({ status: 'unresolved', worldPoint: anchor.fallbackPoint })
      : Object.freeze({ status: 'resolved', worldPoint: cached.worldPoint });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abortRequests();
    for (const cleanup of this.#cleanups.splice(0)) {
      try { cleanup(); } catch { /* borrowed adapter cleanup is best-effort */ }
    }
    this.#document = undefined;
    this.#cache.clear();
  }

  #ensureResolution(id: string, annotation: Annotation, leg: AnnotationLeg): void {
    const adapter = this.#adapters.elements;
    if (adapter === undefined || leg.anchor.kind !== 'element') return;
    const key = elementKey(leg.anchor);
    if (this.#cache.has(key)) return;
    const current = this.#requests.get(id);
    if (current?.key === key) return;
    current?.controller.abort();
    const controller = new AbortController();
    const token = {};
    this.#requests.set(id, { key, token, controller });
    let promise: Promise<ElementResolution | null>;
    try {
      promise = adapter.resolve(
        { modelId: leg.anchor.modelId, elementId: leg.anchor.elementId },
        controller.signal,
      );
    } catch (cause) {
      promise = Promise.reject(cause);
    }
    void promise.then((resolution) => {
      if (!this.#isCurrent(id, key, token) || resolution === null) return;
      if (!isFiniteVec3(resolution.worldPoint)) {
        throw new AdapterError('element resolution', undefined, {
          annotationId: annotation.id,
          legId: leg.id,
        });
      }
      this.#requests.delete(id);
      this.#cache.set(key, Object.freeze({ worldPoint: Object.freeze({ ...resolution.worldPoint }) }));
      this.#invalidate();
    }).catch((cause: unknown) => {
      if (!this.#isCurrent(id, key, token) || isAbortError(cause)) return;
      this.#requests.delete(id);
      const error = cause instanceof AdapterError
        ? cause
        : new AdapterError('element resolution', cause, {
            annotationId: annotation.id,
            legId: leg.id,
          });
      this.#diagnose({
        code: 'ELEMENT_RESOLUTION_FAILED',
        severity: 'warning',
        message: error.message,
        error,
        annotationId: annotation.id,
        legId: leg.id,
      });
      this.#invalidate();
    });
  }

  #isCurrent(id: string, key: string, token: object): boolean {
    if (this.#disposed) return false;
    const current = this.#requests.get(id);
    if (current?.key !== key || current.token !== token || current.controller.signal.aborted) return false;
    const [annotationId, legId] = splitCompositeKey(id);
    const annotation = this.#document?.annotations.find(({ id: candidate }) => candidate === annotationId);
    const leg = annotation?.anchors.find(({ id: candidate }) => candidate === legId);
    return leg?.anchor.kind === 'element' && elementKey(leg.anchor) === key;
  }

  #invalidateElements(invalidation: ElementInvalidation): void {
    if (this.#disposed) return;
    for (const key of [...this.#cache.keys()]) {
      const [modelId, elementId] = splitCompositeKey(key);
      if (
        (invalidation.modelId === undefined || invalidation.modelId === modelId) &&
        (invalidation.elementId === undefined || invalidation.elementId === elementId)
      ) this.#cache.delete(key);
    }
    for (const [id, request] of this.#requests) {
      const [modelId, elementId] = splitCompositeKey(request.key);
      if (
        (invalidation.modelId === undefined || invalidation.modelId === modelId) &&
        (invalidation.elementId === undefined || invalidation.elementId === elementId)
      ) {
        request.controller.abort();
        this.#requests.delete(id);
      }
    }
    if (this.#document !== undefined) this.sync(this.#document);
    this.#invalidate();
  }

  #abortRequests(): void {
    for (const request of this.#requests.values()) request.controller.abort();
    this.#requests.clear();
  }
}

/**
 * Joins id parts into one lookup key with a null character, which documents are not allowed to
 * contain, so the key always splits back into exactly the parts it was built from — an id with a
 * slash or a colon in it cannot be mistaken for a separator.
 */
export function compositeKey(...parts: readonly string[]): string {
  return parts.join('\u0000');
}

export function splitCompositeKey(key: string): readonly string[] {
  return key.split('\u0000');
}

function elementKey(anchor: Extract<Anchor, { kind: 'element' }>): string {
  return compositeKey(anchor.modelId, anchor.elementId);
}

function isFiniteVec3(value: Vec3): boolean {
  return [value.x, value.y, value.z].every(Number.isFinite);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}
