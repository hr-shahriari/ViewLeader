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
   * Asked for fresh every frame, so a host can add and remove objects freely.
   */
  readonly modelBounds?: () => Iterable<Object3D>;
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
    : createThreeModelBoundsAdapter(options.modelBounds);
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
  });
}

/**
 * A small notifier for telling ViewLeader that model elements have changed.
 *
 * Hosts that reload models need a way to say "these ids mean something different now" so anchors
 * can be re-resolved instead of pointing at whatever happens to hold that id today.
 */
export function createThreeElementInvalidationChannel(): ThreeElementInvalidationChannel {
  const listeners = new Set<(invalidation: ElementInvalidation) => void>();
  let disposed = false;
  return Object.freeze({
    subscribe(listener: (invalidation: ElementInvalidation) => void): Unsubscribe {
      if (disposed) return () => undefined;
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    invalidate(invalidation: ElementInvalidation = {}): void {
      if (disposed) return;
      const event = Object.freeze({ ...invalidation });
      for (const listener of [...listeners]) listener(event);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
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
  const worldSnapshot = new Float64Array(16);
  const projectionSnapshot = new Float64Array(16);
  let viewportWidth = Number.NaN;
  let viewportHeight = Number.NaN;
  let viewportDevicePixelRatio = Number.NaN;
  let revision = 0;
  let initialized = false;
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
      const viewport = getViewport();
      const world = options.camera.matrixWorld.elements;
      const projection = options.camera.projectionMatrix.elements;
      let changed = !initialized
        || viewport.width !== viewportWidth
        || viewport.height !== viewportHeight
        || viewport.devicePixelRatio !== viewportDevicePixelRatio;
      for (let index = 0; index < 16 && !changed; index += 1) {
        changed = world[index] !== worldSnapshot[index]
          || projection[index] !== projectionSnapshot[index];
      }
      if (changed) {
        worldSnapshot.set(world);
        projectionSnapshot.set(projection);
        viewportWidth = viewport.width;
        viewportHeight = viewport.height;
        viewportDevicePixelRatio = viewport.devicePixelRatio;
        initialized = true;
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
      throwIfAborted(signal);
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
        throwIfAborted(signal);
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
      throwIfAborted(context.signal);
      const captured = await host.capture(context);
      throwIfAborted(context.signal);
      return cloneViewerState({
        camera: captureCameraState(options.camera),
        ...captured,
      });
    },
    async prepare(
      state: NeutralViewerState,
      context: ThreeViewerStateOperationContext,
    ): Promise<PreparedThreeViewerState> {
      throwIfAborted(context.signal);
      assertCameraCompatible(options.camera, state);
      const target = cloneViewerState(state);
      await host.validate?.(hostState(target), context);
      throwIfAborted(context.signal);
      const previousHost = await host.capture({ signal: context.signal });
      throwIfAborted(context.signal);
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
      throwIfAborted(context.signal);
      applyCameraState(options.camera, prepared.target);
      await host.apply(hostState(prepared.target), context);
      throwIfAborted(context.signal);
    },
    async rollback(
      prepared: PreparedThreeViewerState,
      context: ThreeViewerStateOperationContext,
    ): Promise<void> {
      throwIfAborted(context.signal);
      applyCameraState(options.camera, prepared.rollback);
      await host.apply(hostState(prepared.rollback), context);
      throwIfAborted(context.signal);
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

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Operation cancelled',
  );
  error.name = 'AbortError';
  throw error;
}
