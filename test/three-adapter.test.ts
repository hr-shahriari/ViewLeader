import { JSDOM } from 'jsdom';
import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ViewLeader, type NeutralViewerState } from 'viewleader';
import { describe, expect, it, vi } from 'vitest';
import {
  createStableElementResolver,
  createThreeAdapter,
  createThreeElementInvalidationChannel,
  type ThreeHostViewerState,
} from '../src/three/index.js';

describe('viewleader/three', () => {
  it('projects with full clip-volume culling and does not own borrowed camera or controls', () => {
    const camera = cameraAt({ x: 0, y: 0, z: 5 });
    const controls = { enabled: true };
    const adapter = createThreeAdapter({
      camera,
      viewport: () => ({ width: 800, height: 400, devicePixelRatio: 2 }),
      controls,
    });
    const viewport = adapter.projection.getViewport();
    const initialProjectionRevision = adapter.projection.getRevision?.();
    expect(adapter.projection.getRevision?.()).toBe(initialProjectionRevision);
    expect(adapter.projection.project({ x: 0, y: 0, z: 0 }, viewport)).toMatchObject({
      point: { x: 400, y: 200 },
      visible: true,
    });
    expect(adapter.projection.project({ x: 100, y: 0, z: 0 }, viewport)?.visible).toBe(false);
    expect(adapter.projection.project({ x: 0, y: 100, z: 0 }, viewport)?.visible).toBe(false);
    expect(adapter.projection.project({ x: 0, y: 0, z: 10 }, viewport)?.visible).toBe(false);
    camera.position.x = 1;
    expect(adapter.projection.getRevision?.()).not.toBe(initialProjectionRevision);
    camera.position.x = 0;

    const first = adapter.interaction?.acquire('authoring');
    const second = adapter.interaction?.acquire('authoring');
    expect(controls.enabled).toBe(false);
    first?.release();
    expect(controls.enabled).toBe(false);
    first?.release();
    second?.release();
    expect(controls.enabled).toBe(true);
    expect(camera.position.z).toBe(5);
  });

  it('invalidates stable element caches after a host source reload through public core behavior', async () => {
    const oldObject = new Object3D();
    oldObject.position.set(1, 2, 3);
    const reloadedObject = new Object3D();
    reloadedObject.position.set(9, 8, 7);
    let current = oldObject;
    const invalidations = createThreeElementInvalidationChannel();
    const resolver = createStableElementResolver(() => [{
      modelId: 'duplex',
      resolveStableElement: (globalId) => globalId === 'ifc-global-id' ? current : null,
    }], invalidations);
    const adapter = createThreeAdapter({
      camera: cameraAt({ x: 0, y: 0, z: 5 }),
      viewport: () => ({ width: 800, height: 400, devicePixelRatio: 1 }),
      resolveElement: resolver,
    });
    const dom = new JSDOM('<!doctype html><div id="viewer"></div>');
    const boundary = dom.window.document.querySelector('#viewer')!;
    const viewLeader = new ViewLeader({ boundary, adapters: adapter });
    viewLeader.annotations.create({
      id: 'stable-note',
      anchor: {
        kind: 'element',
        modelId: 'duplex',
        elementId: 'ifc-global-id',
        fallbackPoint: { x: 0, y: 0, z: 0 },
      },
      content: { kind: 'plain-note', text: 'Stable element' },
    });

    await eventually(() => {
      expect(viewLeader.annotations.getSnapshot().annotations[0]).toMatchObject({
        anchorStatuses: ['resolved'],
        resolvedWorldPoints: [{ x: 1, y: 2, z: 3 }],
      });
    });

    current = reloadedObject;
    invalidations.invalidate({ modelId: 'duplex' });
    await eventually(() => {
      expect(viewLeader.annotations.getSnapshot().annotations[0]?.resolvedWorldPoints).toEqual([
        { x: 9, y: 8, z: 7 },
      ]);
    });

    viewLeader.dispose();
    invalidations.dispose();
    dom.window.close();
  });

  it('performs one optional batched Three raycast occlusion query', async () => {
    const camera = cameraAt({ x: 0, y: 0, z: 5 });
    const geometry = new PlaneGeometry(2, 2);
    const material = new MeshBasicMaterial({ side: DoubleSide });
    const blocker = new Mesh(geometry, material);
    blocker.position.z = 2;
    const objects = vi.fn(() => [blocker]);
    const adapter = createThreeAdapter({
      camera,
      viewport: () => ({ width: 800, height: 400, devicePixelRatio: 1 }),
      occlusion: { objects },
    });

    await expect(adapter.occlusion?.test([
      { annotationId: 'blocked', legId: 'leg', worldPoint: { x: 0, y: 0, z: 0 } },
      { annotationId: 'clear', legId: 'leg', worldPoint: { x: 3, y: 0, z: 0 } },
    ], new AbortController().signal)).resolves.toEqual([
      { annotationId: 'blocked', legId: 'leg', occluded: true },
      { annotationId: 'clear', legId: 'leg', occluded: false },
    ]);
    expect(objects).toHaveBeenCalledOnce();

    geometry.dispose();
    material.dispose();
  });

  it('applies and rolls back complete neutral viewer state through saved-view activation', async () => {
    const camera = cameraAt({ x: 0, y: 0, z: 5 });
    let hostState = hostStateWithModelVisibility(true);
    let failNextApply = false;
    const validate = vi.fn();
    const adapter = createThreeAdapter({
      camera,
      viewport: () => ({ width: 800, height: 400, devicePixelRatio: 1 }),
      viewerState: {
        host: {
          capture: () => structuredClone(hostState),
          validate,
          apply: (state) => {
            hostState = structuredClone(state);
            if (failNextApply) {
              failNextApply = false;
              throw new Error('host apply failed after mutation');
            }
          },
        },
      },
    });
    const dom = new JSDOM('<!doctype html><div id="viewer"></div>');
    const boundary = dom.window.document.querySelector('#viewer')!;
    const viewLeader = new ViewLeader({ boundary, adapters: adapter });

    const firstState = viewerStateAt(10, false);
    viewLeader.views.insert({
      id: 'first',
      name: 'First',
      viewerState: firstState,
      annotationOverrides: {},
    });
    await expect(viewLeader.views.activate('first')).resolves.toEqual({
      status: 'activated',
      viewId: 'first',
    });
    expect(camera.position.z).toBeCloseTo(10);
    expect(hostState.modelVisibility).toEqual([{ modelId: 'duplex', visible: false }]);

    viewLeader.views.insert({
      id: 'failing',
      name: 'Failing',
      viewerState: viewerStateAt(20, true),
      annotationOverrides: {},
    });
    failNextApply = true;
    await expect(viewLeader.views.activate('failing')).rejects.toMatchObject({
      code: 'saved_view/activation_failed',
    });
    expect(camera.position.z).toBeCloseTo(10);
    expect(hostState.modelVisibility).toEqual([{ modelId: 'duplex', visible: false }]);
    expect(validate).toHaveBeenCalledTimes(2);

    viewLeader.dispose();
    dom.window.close();
  });

  it('round-trips neutral camera state beneath a transformed parent rig', async () => {
    const rig = new Object3D();
    rig.position.set(4, -2, 3);
    rig.rotation.set(0.2, 0.5, -0.1);
    const camera = cameraAt({ x: 1, y: 2, z: 8 });
    rig.add(camera);
    rig.updateMatrixWorld(true);
    const adapter = createThreeAdapter({
      camera,
      viewport: () => ({ width: 800, height: 400, devicePixelRatio: 1 }),
      viewerState: { host: {
        capture: () => hostStateWithModelVisibility(true),
        apply: () => undefined,
      } },
    });
    const dom = new JSDOM('<!doctype html><div id="viewer"></div>');
    const viewLeader = new ViewLeader({
      boundary: dom.window.document.querySelector('#viewer')!,
      adapters: adapter,
    });
    const expectedPosition = camera.getWorldPosition(new Object3D().position).clone();
    const expectedDirection = camera.getWorldDirection(new Object3D().position).clone();
    await viewLeader.views.save({ id: 'rigged', name: 'Rigged camera' });
    camera.position.set(20, 30, 40);
    camera.rotation.set(1, 1, 1);
    camera.updateMatrixWorld(true);

    await viewLeader.views.activate('rigged');

    expect(camera.getWorldPosition(new Object3D().position).distanceTo(expectedPosition)).toBeLessThan(1e-9);
    expect(camera.getWorldDirection(new Object3D().position).distanceTo(expectedDirection)).toBeLessThan(1e-9);
    viewLeader.dispose();
    dom.window.close();
  });

  /**
   * A grip is `pointer-events: none` — core hit-tests grips geometrically — so a press on one lands
   * on the canvas first and Three's controls start tracking that pointer id. Core takes this lease
   * on the way up and then captures the pointer to its own overlay boundary, so the canvas never
   * sees the release. The real OrbitControls is exercised rather than a stand-in because the whole
   * failure lives in its private pointer bookkeeping; a stand-in could only prove the stand-in.
   */
  it('hands the pointer back to Three controls when core takes a lease mid-press', () => {
    const camera = cameraAt({ x: 0, y: 0, z: 5 });
    const canvas = new StubCanvas();
    const controls = new OrbitControls(camera, canvas as unknown as HTMLElement);
    const adapter = createThreeAdapter({
      camera,
      viewport: () => ({ width: 800, height: 400, devicePixelRatio: 1 }),
      controls,
    });

    canvas.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    const lease = adapter.interaction!.acquire('editing');
    // Core stole pointer capture here: every later move and the release go to its boundary, leaving
    // the canvas mid-gesture with a pointer id it will never see the end of.
    lease.release();
    expect(controls.enabled).toBe(true);

    // The abandoned gesture must not still be live: a plain hover over the canvas orbits otherwise.
    const idle = camera.position.clone();
    canvas.dispatchEvent(pointerEvent('pointermove', 160, 120));
    expect(camera.position.distanceTo(idle)).toBe(0);

    // And the next press must orbit again. A mouse reuses its pointer id, so a stale one makes
    // OrbitControls treat this press as a pointer it is already tracking and ignore it forever.
    let started = 0;
    controls.addEventListener('start', () => { started += 1; });
    canvas.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    canvas.dispatchEvent(pointerEvent('pointermove', 160, 120));
    expect(started).toBe(1);
    expect(camera.position.distanceTo(idle)).toBeGreaterThan(0.1);

    controls.dispose();
  });
});

/** The handful of DOM members Three's controls touch on the element they are connected to. */
class StubCanvas extends EventTarget {
  public readonly style: Record<string, string> = {};
  public readonly clientWidth = 800;
  public readonly clientHeight = 400;
  public captured: number | undefined;
  public getRootNode(): EventTarget { return this; }
  public setPointerCapture(pointerId: number): void { this.captured = pointerId; }
  public releasePointerCapture(pointerId: number): void {
    if (this.captured === pointerId) this.captured = undefined;
  }
}

/** Node and jsdom both ship no `PointerEvent`; Three reads only these fields off one. */
function pointerEvent(type: string, clientX: number, clientY: number): Event {
  return Object.assign(new Event(type), {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    clientX,
    clientY,
  });
}

function cameraAt(position: { readonly x: number; readonly y: number; readonly z: number }): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 2, 0.1, 100);
  camera.position.set(position.x, position.y, position.z);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

function hostStateWithModelVisibility(visible: boolean): ThreeHostViewerState {
  return {
    modelVisibility: [{ modelId: 'duplex', visible }],
    elementVisibility: [],
    selection: [],
    colorOverrides: [],
    clippingPlanes: [],
  };
}

function viewerStateAt(z: number, visible: boolean): NeutralViewerState {
  return {
    camera: {
      projection: 'perspective',
      position: { x: 0, y: 0, z },
      direction: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      verticalFieldOfView: 60,
      near: 0.1,
      far: 100,
    },
    ...hostStateWithModelVisibility(visible),
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}
