// The Three.js adapter: the translation layer between ViewLeader and a Three scene.
//
// ViewLeader knows nothing about Three. It asks plain questions — where is this world point on
// screen, what did the user click, is this target hidden behind something — and this file answers
// them using the host's camera, renderer and scene.
//
// Nothing here is owned. The camera, renderer, controls and objects all belong to the host
// application; this only borrows them, reads them, and never disposes them.
import {
  Box3,
  Object3D,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type WebGLRenderer,
} from 'three';
import type {
  AccuratePickingAdapter,
  SurfacePickResult,
  SurfacePickingAdapter,
  Anchor,
  ElementInvalidation,
  ElementResolution,
  ElementResolutionAdapter,
  ElementResolveRequest,
  HostAdapterBundle,
  InteractionAdapter,
  InteractionLease,
  ModelBounds,
  ModelBoundsAdapter,
  NeutralViewerState,
  NormalizedPointerInput,
  OcclusionAdapter,
  OcclusionResult,
  OcclusionSample,
  ProjectionAdapter,
  Unsubscribe,
  Vec2,
  Vec3,
  ViewerStateAdapter,
  ViewportSnapshot,
} from '../index.js';

export interface ThreeInteractionControls {
  enabled: boolean;
}

export type ThreeElementResolution =
  | Vec3
  | Vector3
  | Object3D
  | null;

export interface ThreeElementInvalidationSource {
  subscribe(listener: (invalidation: ElementInvalidation) => void): Unsubscribe;
}

export interface ThreeElementInvalidationChannel
  extends ThreeElementInvalidationSource {
  /**
   * Tell ViewLeader that elements have changed, usually after a model reloads. Anchors pointing at
   * them are re-resolved. Send an empty event to invalidate everything at once.
   */
  invalidate(invalidation?: ElementInvalidation): void;
  dispose(): void;
}

export type ThreeElementResolver = ((
  request: ElementResolveRequest,
  signal: AbortSignal,
) => ThreeElementResolution | Promise<ThreeElementResolution>) &
  Partial<ThreeElementInvalidationSource>;

export interface ThreeOcclusionOptions {
  /** The objects that can hide a target from the camera. Borrowed from the host, never owned. */
  readonly objects: () => Iterable<Object3D>;
  readonly recursive?: boolean;
  /**
   * A small distance to ignore in front of the target. Without it a surface counts as blocking
   * itself and every annotation on a wall reads as hidden.
   */
  readonly epsilon?: number;
  readonly includeIntersection?: (object: Object3D) => boolean;
}

export type ThreeHostViewerState = Omit<NeutralViewerState, 'camera'>;

export interface ThreeViewerStateOperationContext {
  readonly signal: AbortSignal;
  readonly transitionDurationMs: number;
}

/**
 * Hooks for the parts of a saved view only the host can restore: which elements are hidden, what
 * colour they were overridden to, which section planes were active.
 *
 * The adapter handles the camera itself, and drives these callbacks through a prepare/apply/roll
 * back sequence so a view that fails halfway does not leave the model half-changed.
 */
export interface ThreeViewerStateHost {
  capture(context: { readonly signal: AbortSignal }):
    | ThreeHostViewerState
    | Promise<ThreeHostViewerState>;
  validate?(
    state: ThreeHostViewerState,
    context: ThreeViewerStateOperationContext,
  ): void | Promise<void>;
  apply(
    state: ThreeHostViewerState,
    context: ThreeViewerStateOperationContext,
  ): void | Promise<void>;
}

export interface ThreeViewerStateOptions {
  readonly host?: ThreeViewerStateHost;
}

export interface PreparedThreeViewerState {
  readonly target: NeutralViewerState;
  readonly rollback: NeutralViewerState;
}

export interface ThreeAdapterOptions {
  readonly camera: Camera;
  readonly renderer?: WebGLRenderer;
  readonly viewport?: () => ViewportSnapshot;
  readonly resolveElement?: ThreeElementResolver;
  readonly elementInvalidations?: ThreeElementInvalidationSource;
  readonly pick?: (
    pointer: NormalizedPointerInput,
    signal: AbortSignal,
  ) => Anchor | null | Promise<Anchor | null>;
  /**
   * Where the pointer touches the model, and which way that surface faces.
   *
   * Markup tools need the direction as well as the point: the first press decides the flat plane
   * the shape is drawn on, and every later point is stored relative to it. A plain pick gives only
   * a position, so leaving this out stops all the markup tools working.
   */
  readonly pickSurface?: (
    pointer: NormalizedPointerInput,
    signal: AbortSignal,
  ) => SurfacePickResult | null | Promise<SurfacePickResult | null>;
  readonly controls?: ThreeInteractionControls;
  readonly occlusion?: ThreeOcclusionOptions;
  /**
   * The objects that make up "the model". A box around them is projected to the screen and labels
   * are kept outside it, so notes sit clear of the building instead of on top of it.
   *
   * Polled on each requested layout pass unless `modelBoundsRevision` is supplied, so a host can
   * add and remove objects freely without a second invalidation channel.
   */
  readonly modelBounds?: () => Iterable<Object3D>;
  /**
   * Return a cheap revision whenever the model-bounds target changes identity, transform, or
   * geometry. It avoids recomputing every object's Box3 while the scene is stationary.
   */
  readonly modelBoundsRevision?: () => string | number;
  readonly viewerState?: ThreeViewerStateOptions;
}

export interface StableElementSource {
  readonly modelId: string;
  resolveStableElement(
    elementId: string,
    signal: AbortSignal,
  ): ThreeElementResolution | Promise<ThreeElementResolution>;
}

/**
 * Builds the adapter to hand to `new ViewLeader({ adapters })`.
 *
 * Everything passed in stays the host's: nothing here disposes a renderer, moves a camera, or
 * changes a scene. Disposing the ViewLeader leaves the viewer exactly as it was.
 */
export function createThreeAdapter(options: ThreeAdapterOptions): HostAdapterBundle {
  if (options.viewport === undefined && options.renderer === undefined) {
    throw new TypeError('createThreeAdapter requires renderer or viewport');
  }
  const projection = createProjectionAdapter(options);
  const elements = options.resolveElement === undefined
    ? undefined
    : createElementAdapter(
        options.resolveElement,
        options.elementInvalidations ?? subscribedResolver(options.resolveElement),
      );
  const picking: AccuratePickingAdapter | undefined = options.pick === undefined
    ? undefined
    : {
        pick: ({ pointer }, signal) => Promise.resolve(options.pick?.(pointer, signal) ?? null),
      };
  const surfacePicking: SurfacePickingAdapter | undefined = options.pickSurface === undefined
    ? undefined
    : {
        pickSurface: ({ pointer }, signal) =>
          Promise.resolve(options.pickSurface?.(pointer, signal) ?? null),
      };
  const interaction = options.controls === undefined
    ? undefined
    : createControlsInteraction(options.controls);
  const occlusion = options.occlusion === undefined
    ? undefined
    : createThreeOcclusionAdapter(options.camera, options.occlusion);
  const modelBounds = options.modelBounds === undefined
    ? undefined
    : createThreeModelBoundsAdapter(options.modelBounds, options.modelBoundsRevision);
  const viewerState = options.viewerState === undefined
    ? undefined
    : createThreeViewerStateAdapter({
        camera: options.camera,
        ...(options.viewerState.host === undefined
          ? {}
          : { host: options.viewerState.host }),
      });
  return Object.freeze({
    projection,
    ...(elements === undefined ? {} : { elements }),
    ...(picking === undefined ? {} : { picking }),
    ...(surfacePicking === undefined ? {} : { surfacePicking }),
    ...(interaction === undefined ? {} : { interaction }),
    ...(occlusion === undefined ? {} : { occlusion }),
    ...(modelBounds === undefined ? {} : { modelBounds }),
    ...(viewerState === undefined ? {} : { viewerState }),
  });
}

/**
 * Measures the box that contains the given objects, which is how ViewLeader knows where the model
 * is on screen. Returns `null` when there is nothing to measure yet, so an empty scene simply has
 * no frame rather than a broken one at the origin.
 */
export function createThreeModelBoundsAdapter(
  objects: () => Iterable<Object3D>,
  revision?: () => string | number,
): ModelBoundsAdapter {
  return Object.freeze({
    get(): ModelBounds | null {
      const box = new Box3();
      let any = false;
      for (const object of objects()) {
        object.updateWorldMatrix(true, true);
        const objectBox = new Box3().setFromObject(object);
        if (objectBox.isEmpty()) continue;
        box.union(objectBox);
        any = true;
      }
      if (!any || box.isEmpty()) return null;
      return {
        min: { x: box.min.x, y: box.min.y, z: box.min.z },
        max: { x: box.max.x, y: box.max.y, z: box.max.z },
      };
    },
    ...(revision === undefined ? {} : { getRevision: revision }),
  });
}

/**
 * A small notifier for telling ViewLeader that model elements have changed.
 *
 * Hosts that reload models need a way to say "these ids mean something different now" so anchors
 * can be re-resolved instead of pointing at whatever happens to hold that id today.
 */
export function createThreeElementInvalidationChannel(): ThreeElementInvalidationChannel {
  const target = new EventTarget();
  const lifetime = new AbortController();
  return Object.freeze({
    subscribe(listener: (invalidation: ElementInvalidation) => void): Unsubscribe {
      const onInvalidate = (event: Event): void =>
        listener((event as CustomEvent<ElementInvalidation>).detail);
      target.addEventListener('invalidate', onInvalidate, { signal: lifetime.signal });
      return () => target.removeEventListener('invalidate', onInvalidate);
    },
    invalidate(invalidation: ElementInvalidation = {}): void {
      target.dispatchEvent(
        new CustomEvent('invalidate', { detail: Object.freeze({ ...invalidation }) }),
      );
    },
    dispose(): void {
      lifetime.abort();
    },
  });
}

/**
 * Looks up model elements by a stable id — an IFC GlobalId or whatever the host uses.
 *
 * Anchors are saved against these ids rather than against objects in memory, so a document still
 * points at the right door after the model is closed and reopened.
 */
export function createStableElementResolver(
  sources: () => Iterable<StableElementSource>,
  invalidations?: ThreeElementInvalidationSource,
): ThreeElementResolver {
  const resolve: ThreeElementResolver = async (request, signal) => {
    const source = [...sources()].find(({ modelId }) => modelId === request.modelId);
    if (source === undefined) return null;
    return source.resolveStableElement(request.elementId, signal);
  };
  if (invalidations !== undefined) {
    resolve.subscribe = (listener) => invalidations.subscribe(listener);
  }
  return resolve;
}

function createProjectionAdapter(options: ThreeAdapterOptions): ProjectionAdapter {
  const canvas = options.renderer?.domElement;
  const world = new Matrix4();
  const projection = new Matrix4();
  let viewport: ViewportSnapshot | undefined;
  let revision = 0;
  const getViewport = (): ViewportSnapshot => {
    if (options.viewport !== undefined) return options.viewport();
    const bounds = canvas?.getBoundingClientRect();
    return {
      width: bounds?.width ?? 0,
      height: bounds?.height ?? 0,
      devicePixelRatio: canvas?.ownerDocument.defaultView?.devicePixelRatio ?? 1,
    };
  };
  return {
    getViewport,
    getRevision: () => {
      options.camera.updateWorldMatrix(true, false);
      const current = getViewport();
      if (
        viewport === undefined
        || current.width !== viewport.width
        || current.height !== viewport.height
        || current.devicePixelRatio !== viewport.devicePixelRatio
        || !world.equals(options.camera.matrixWorld)
        || !projection.equals(options.camera.projectionMatrix)
      ) {
        world.copy(options.camera.matrixWorld);
        projection.copy(options.camera.projectionMatrix);
        // Copied, not kept by reference: a host may hand back the same mutable object every frame.
        viewport = { ...current };
        revision += 1;
      }
      return revision;
    },
    project: (point, viewport) => {
      // The camera matrices are already current: `getRevision` above runs once per frame, before
      // anything is projected, and refreshes them there. Refreshing again here would repeat that
      // work for every single anchor.
      const projected = new Vector3(point.x, point.y, point.z).project(options.camera);
      if (![projected.x, projected.y, projected.z].every(Number.isFinite)) return null;
      return {
        point: {
          x: (projected.x + 1) * viewport.width / 2,
          y: (1 - projected.y) * viewport.height / 2,
        },
        depth: (projected.z + 1) / 2,
        visible:
          projected.x >= -1 && projected.x <= 1 &&
          projected.y >= -1 && projected.y <= 1 &&
          projected.z >= -1 && projected.z <= 1,
      };
    },
    projectBounds: (bounds, viewport) => projectThreeBounds(bounds, options.camera, viewport),
    ...(canvas === undefined
      ? {}
      : {
          connect: (invalidate: () => void) => {
            const view = canvas.ownerDocument.defaultView;
            const onResize = (): void => invalidate();
            view?.addEventListener('resize', onResize);
            const Observer = globalThis.ResizeObserver;
            const observer = Observer === undefined ? undefined : new Observer(onResize);
            observer?.observe(canvas);
            let connected = true;
            return () => {
              if (!connected) return;
              connected = false;
              view?.removeEventListener('resize', onResize);
              observer?.disconnect();
            };
          },
        }),
  };
}

const AABB_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
];

/**
 * Projects the camera-facing portion of an AABB. A point behind a perspective camera has a
 * mathematically finite screen coordinate, but it is a mirror of the point in front; only points
 * in the camera clip slab and intersections of box edges with its near/far planes are valid here.
 */
function projectThreeBounds(
  bounds: ModelBounds,
  camera: Camera,
  viewport: ViewportSnapshot,
): { readonly status: 'available'; readonly bounds: { readonly min: Vec2; readonly max: Vec2 } } | { readonly status: 'empty' | 'unavailable' } {
  if (!isOrderedModelBounds(bounds)) return { status: 'empty' };
  if (!(camera instanceof PerspectiveCamera) && !(camera instanceof OrthographicCamera)) {
    return { status: 'unavailable' };
  }
  camera.updateWorldMatrix(true, false);
  const points = aabbCorners(bounds).map((point) => point.applyMatrix4(camera.matrixWorldInverse));
  // The near plane is a valid perspective divide when `near > 0`; only the camera origin is
  // singular. Keep exact clip-plane intersections so this rectangle never understates the model.
  const frontZ = -camera.near;
  const backZ = -camera.far;
  const inside = (point: Vector3): boolean => point.z <= frontZ && point.z >= backZ;
  const candidates: Vector3[] = [];
  for (const point of points) if (inside(point)) candidates.push(point);
  for (const [from, to] of AABB_EDGES) {
    const start = points[from]!;
    const end = points[to]!;
    for (const planeZ of [frontZ, backZ]) {
      const startDistance = start.z - planeZ;
      const endDistance = end.z - planeZ;
      if (startDistance === 0 || endDistance === 0 || startDistance * endDistance >= 0) continue;
      const t = -startDistance / (endDistance - startDistance);
      if (t >= 0 && t <= 1) candidates.push(start.clone().lerp(end, t));
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const cameraPoint of candidates) {
    const clip = cameraPoint.clone().applyMatrix4(camera.projectionMatrix);
    // Omitting an unrepresentable extremity would understate the protected area. Report that a
    // strict rectangle is unavailable instead of turning a numeric overflow into a false promise.
    if (!Number.isFinite(clip.x) || !Number.isFinite(clip.y)) return { status: 'unavailable' };
    const x = (clip.x + 1) * viewport.width / 2;
    const y = (1 - clip.y) * viewport.height / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { status: 'unavailable' };
    any = true;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return any ? { status: 'available', bounds: { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } } : { status: 'empty' };
}

function aabbCorners(bounds: ModelBounds): Vector3[] {
  const { min, max } = bounds;
  return [
    new Vector3(min.x, min.y, min.z), new Vector3(max.x, min.y, min.z),
    new Vector3(min.x, max.y, min.z), new Vector3(max.x, max.y, min.z),
    new Vector3(min.x, min.y, max.z), new Vector3(max.x, min.y, max.z),
    new Vector3(min.x, max.y, max.z), new Vector3(max.x, max.y, max.z),
  ];
}

function isOrderedModelBounds(bounds: ModelBounds): boolean {
  return [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z].every(Number.isFinite)
    && bounds.min.x <= bounds.max.x && bounds.min.y <= bounds.max.y && bounds.min.z <= bounds.max.z;
}

function createElementAdapter(
  resolve: ThreeElementResolver,
  invalidations: ThreeElementInvalidationSource | undefined,
): ElementResolutionAdapter {
  return {
    resolve: async (request, signal): Promise<ElementResolution | null> => {
      const value = await resolve(request, signal);
      if (signal.aborted || value === null) return null;
      if (value instanceof Object3D) {
        value.updateWorldMatrix(true, false);
        const point = value.getWorldPosition(new Vector3());
        return { worldPoint: copyVector(point) };
      }
      return { worldPoint: copyVector(value) };
    },
    ...(invalidations === undefined
      ? {}
      : { subscribe: (listener: (event: ElementInvalidation) => void) =>
          invalidations.subscribe(listener) }),
  };
}

/**
 * Works out which annotation targets are hidden behind geometry, so their leader lines can be
 * faded or dropped.
 *
 * The whole batch is tested against one snapshot of the camera and objects. Sampling them per
 * target instead would let the camera move mid-batch and return answers from two different frames.
 */
export function createThreeOcclusionAdapter(
  camera: Camera,
  options: ThreeOcclusionOptions,
): OcclusionAdapter {
  const epsilon = options.epsilon ?? 1e-4;
  if (!Number.isFinite(epsilon) || epsilon < 0) {
    throw new TypeError('Three occlusion epsilon must be finite and non-negative');
  }
  const recursive = options.recursive ?? true;
  return Object.freeze({
    async test(
      samples: readonly OcclusionSample[],
      signal: AbortSignal,
    ): Promise<readonly OcclusionResult[]> {
      signal.throwIfAborted();
      if (!(camera instanceof PerspectiveCamera) && !(camera instanceof OrthographicCamera)) {
        throw new TypeError('Three occlusion requires a perspective or orthographic camera');
      }
      camera.updateMatrixWorld();
      const objects = [...options.objects()];
      for (const object of objects) object.updateWorldMatrix(true, true);
      const raycaster = new Raycaster();
      const projected = new Vector3();
      const target = new Vector3();
      return samples.map((sample) => {
        signal.throwIfAborted();
        target.set(sample.worldPoint.x, sample.worldPoint.y, sample.worldPoint.z);
        projected.copy(target).project(camera);
        if (![projected.x, projected.y, projected.z].every(Number.isFinite)) {
          return { annotationId: sample.annotationId, legId: sample.legId, occluded: false };
        }
        raycaster.setFromCamera(new Vector2(projected.x, projected.y), camera);
        const targetDistance = target.clone().sub(raycaster.ray.origin).dot(raycaster.ray.direction);
        const intersection = raycaster
          .intersectObjects(objects, recursive)
          .find(({ object }) => options.includeIntersection?.(object) ?? true);
        return {
          annotationId: sample.annotationId,
          legId: sample.legId,
          occluded:
            targetDistance > 0 &&
            intersection !== undefined &&
            intersection.distance < targetDistance - epsilon,
        };
      });
    },
  });
}

/**
 * Saves and restores the viewer's state for saved views: camera, and — through the optional host
 * callbacks — element visibility, colour overrides and section planes.
 *
 * Restoring happens in two steps, prepare then apply, so a view that cannot be fully restored is
 * abandoned before anything moves rather than leaving the model in a half-applied state.
 */
export function createThreeViewerStateAdapter(options: {
  readonly camera: Camera;
  readonly host?: ThreeViewerStateHost;
}): ViewerStateAdapter<PreparedThreeViewerState> {
  const host = options.host ?? emptyViewerStateHost;
  return Object.freeze({
    async capture(context: { readonly signal: AbortSignal }): Promise<NeutralViewerState> {
      context.signal.throwIfAborted();
      const captured = await host.capture(context);
      context.signal.throwIfAborted();
      return cloneViewerState({
        camera: captureCameraState(options.camera),
        ...captured,
      });
    },
    async prepare(
      state: NeutralViewerState,
      context: ThreeViewerStateOperationContext,
    ): Promise<PreparedThreeViewerState> {
      context.signal.throwIfAborted();
      assertCameraCompatible(options.camera, state);
      const target = cloneViewerState(state);
      await host.validate?.(hostState(target), context);
      context.signal.throwIfAborted();
      const previousHost = await host.capture({ signal: context.signal });
      context.signal.throwIfAborted();
      return Object.freeze({
        target,
        rollback: cloneViewerState({
          camera: captureCameraState(options.camera),
          ...previousHost,
        }),
      });
    },
    async apply(
      prepared: PreparedThreeViewerState,
      context: ThreeViewerStateOperationContext,
    ): Promise<void> {
      context.signal.throwIfAborted();
      applyCameraState(options.camera, prepared.target);
      await host.apply(hostState(prepared.target), context);
      context.signal.throwIfAborted();
    },
    async rollback(
      prepared: PreparedThreeViewerState,
      context: ThreeViewerStateOperationContext,
    ): Promise<void> {
      context.signal.throwIfAborted();
      applyCameraState(options.camera, prepared.rollback);
      await host.apply(hostState(prepared.rollback), context);
      context.signal.throwIfAborted();
    },
  });
}

/**
 * The bits of Three's controls this file peeks at to clean up a pointer. Both are optional and read
 * defensively, because neither is part of the public contract — `_pointers` is Three's own private
 * field and could be renamed in any release. See `cancelTrackedPointers` for why it is worth it.
 */
interface ThreePointerTrackingControls extends ThreeInteractionControls {
  readonly domElement?: { dispatchEvent?(event: Event): boolean } | null;
  readonly _pointers?: readonly number[];
}

function createControlsInteraction(controls: ThreeInteractionControls): InteractionAdapter {
  let leases = 0;
  let restoreValue = controls.enabled;
  return {
    acquire: (): InteractionLease => {
      if (leases === 0) {
        restoreValue = controls.enabled;
        // Order matters: clean up first, disable second. TrackballControls ignores pointer events
        // while disabled, so a cancel sent after this line would be thrown away and clean up
        // nothing. OrbitControls happens not to have that guard, but relying on that is luck.
        cancelTrackedPointers(controls);
        controls.enabled = false;
      }
      leases += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          leases -= 1;
          if (leases === 0) controls.enabled = restoreValue;
        },
      };
    },
  };
}

/**
 * Tells Three's controls to let go of any pointer they still think is pressed, because they are
 * never going to see it released.
 *
 * The problem: when the user starts dragging an annotation, the press lands on the canvas first, so
 * the controls start tracking it. ViewLeader then captures that pointer to its own overlay, so the
 * matching release goes to the overlay and the controls never hear it. They keep the id on their
 * "still pressed" list forever.
 *
 * That is not a cosmetic leak. A mouse reuses the same pointer id for every click, so the controls
 * see the next press as one they are already tracking and ignore it — no orbit, no pan, no zoom,
 * for the rest of the session. The abandoned gesture also stays in rotate mode with its move
 * listener attached, so simply moving the mouse spins the camera.
 *
 * Sending a synthetic `pointercancel` is the fix because that is the one cleanup path the controls
 * listen on for their whole lifetime.
 */
function cancelTrackedPointers(controls: ThreeInteractionControls): void {
  const source = controls as ThreePointerTrackingControls;
  const target = source.domElement;
  const pointers = source._pointers;
  // Reading Three's own live list beats remembering the last press ourselves: it handles
  // multi-touch, needs no listener of our own to leak, and can never name a pointer that has
  // already been released. If Three renames the field we quietly do nothing rather than throw.
  if (typeof target?.dispatchEvent !== 'function' || !Array.isArray(pointers)) return;
  // Copied first: dispatching removes entries from the very array we would be walking.
  for (const pointerId of [...pointers]) {
    const event = pointerCancelEvent(pointerId);
    if (event === undefined) return;
    // Never let cleanup throw. If the host's element lives in another window or iframe, the event
    // types will not match and dispatch fails — the user's drag should still work.
    try { target.dispatchEvent(event); } catch { /* not dispatchable here */ }
  }
}

function pointerCancelEvent(pointerId: number): Event | undefined {
  // Deliberately not bubbling. Only the controls' own listener should hear this, nothing above it.
  const constructor = (globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent;
  if (constructor !== undefined) return new constructor('pointercancel', { pointerId });
  // Node and jsdom have no `PointerEvent`. Three only ever reads `pointerId`, so a plain `Event`
  // carrying that one field is enough to trigger the cleanup under test.
  if (typeof Event === 'undefined') return undefined;
  return Object.assign(new Event('pointercancel'), { pointerId });
}

function copyVector(value: Vec3 | Vector3): Vec3 {
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function subscribedResolver(
  resolver: ThreeElementResolver,
): ThreeElementInvalidationSource | undefined {
  return resolver.subscribe === undefined
    ? undefined
    : { subscribe: (listener) => resolver.subscribe!(listener) };
}

const emptyHostState: ThreeHostViewerState = Object.freeze({
  modelVisibility: Object.freeze([]),
  elementVisibility: Object.freeze([]),
  selection: Object.freeze([]),
  colorOverrides: Object.freeze([]),
  clippingPlanes: Object.freeze([]),
});

const emptyViewerStateHost: ThreeViewerStateHost = Object.freeze({
  capture: () => emptyHostState,
  apply: () => undefined,
});

function captureCameraState(camera: Camera): NeutralViewerState['camera'] {
  camera.updateMatrixWorld();
  const direction = camera.getWorldDirection(new Vector3());
  const up = new Vector3(0, 1, 0).applyQuaternion(
    camera.getWorldQuaternion(new Quaternion()),
  );
  const common = {
    position: copyVector(camera.getWorldPosition(new Vector3())),
    direction: copyVector(direction),
    up: copyVector(up),
  };
  if (camera instanceof PerspectiveCamera) {
    assertFiniteCameraNumbers(camera.near, camera.far, camera.getEffectiveFOV());
    return {
      ...common,
      projection: 'perspective',
      verticalFieldOfView: camera.getEffectiveFOV(),
      near: camera.near,
      far: camera.far,
    };
  }
  if (camera instanceof OrthographicCamera) {
    const height = (camera.top - camera.bottom) / camera.zoom;
    assertFiniteCameraNumbers(camera.near, camera.far, height);
    return {
      ...common,
      projection: 'orthographic',
      height,
      near: camera.near,
      far: camera.far,
    };
  }
  throw new TypeError('Neutral viewer state requires a perspective or orthographic camera');
}

function applyCameraState(camera: Camera, state: NeutralViewerState): void {
  assertCameraCompatible(camera, state);
  const value = state.camera;
  const worldPosition = new Vector3(value.position.x, value.position.y, value.position.z);
  const worldDirection = new Vector3(value.direction.x, value.direction.y, value.direction.z).normalize();
  const worldUp = new Vector3(value.up.x, value.up.y, value.up.z).normalize();
  const worldRotation = new Quaternion().setFromRotationMatrix(
    new Matrix4().lookAt(worldPosition, worldPosition.clone().add(worldDirection), worldUp),
  );
  camera.up.set(0, 1, 0);
  if (camera.parent === null) {
    camera.position.copy(worldPosition);
    camera.quaternion.copy(worldRotation);
  } else {
    camera.parent.updateWorldMatrix(true, false);
    camera.position.copy(camera.parent.worldToLocal(worldPosition.clone()));
    const parentWorldRotation = camera.parent.getWorldQuaternion(new Quaternion());
    camera.quaternion.copy(parentWorldRotation.invert().multiply(worldRotation));
  }
  if (camera instanceof PerspectiveCamera && value.projection === 'perspective') {
    camera.fov = value.verticalFieldOfView;
    camera.zoom = 1;
    camera.near = value.near;
    camera.far = value.far;
  } else if (camera instanceof OrthographicCamera && value.projection === 'orthographic') {
    const currentHeight = (camera.top - camera.bottom) / camera.zoom;
    const aspect = currentHeight === 0
      ? 1
      : (camera.right - camera.left) / camera.zoom / currentHeight;
    camera.zoom = 1;
    camera.top = value.height / 2;
    camera.bottom = -value.height / 2;
    camera.left = -value.height * aspect / 2;
    camera.right = value.height * aspect / 2;
    camera.near = value.near;
    camera.far = value.far;
  }
  if (camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera) {
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}

function assertCameraCompatible(camera: Camera, state: NeutralViewerState): void {
  const perspective = camera instanceof PerspectiveCamera && state.camera.projection === 'perspective';
  const orthographic = camera instanceof OrthographicCamera && state.camera.projection === 'orthographic';
  if (!perspective && !orthographic) {
    throw new TypeError(`Cannot apply ${state.camera.projection} state to this Three camera`);
  }
  const projectionSize = state.camera.projection === 'perspective'
    ? state.camera.verticalFieldOfView
    : state.camera.height;
  assertFiniteCameraNumbers(state.camera.near, state.camera.far, projectionSize);
  for (const vector of [state.camera.position, state.camera.direction, state.camera.up]) {
    if (![vector.x, vector.y, vector.z].every(Number.isFinite)) {
      throw new TypeError('Neutral camera vectors must be finite');
    }
  }
  if (state.camera.far <= state.camera.near || projectionSize <= 0) {
    throw new TypeError('Neutral camera projection values are invalid');
  }
}

function assertFiniteCameraNumbers(...values: number[]): void {
  if (!values.every(Number.isFinite)) {
    throw new TypeError('Three camera projection values must be finite');
  }
}

function hostState(state: NeutralViewerState): ThreeHostViewerState {
  return {
    modelVisibility: state.modelVisibility,
    elementVisibility: state.elementVisibility,
    selection: state.selection,
    colorOverrides: state.colorOverrides,
    clippingPlanes: state.clippingPlanes,
  };
}

function cloneViewerState(state: NeutralViewerState): NeutralViewerState {
  return structuredClone(state);
}
