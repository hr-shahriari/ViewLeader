import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface ExampleHarness {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  /** DOM layer that sits exactly over the canvas; pass it to `new ViewLeader({ boundary })`. */
  boundary: HTMLDivElement;
  onFrame(callback: () => void): () => void;
  dispose(): void;
}

declare global {
  interface Window {
    // The harness intentionally knows nothing about ViewLeader. Pages publish their instance through
    // this stable slot so browser/e2e checks have one handle regardless of which example is running.
    vl?: unknown;
  }
}

/** Neutral Three.js lifecycle shared by every example. No ViewLeader imports or API calls live here. */
export function createExampleHarness(viewport: HTMLElement): ExampleHarness {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9e7df');

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  viewport.appendChild(renderer.domElement);

  // ViewLeader draws its SVG overlay into this element. It covers the same rectangle as the canvas so
  // the adapter's projected screen coordinates line up pixel-for-pixel. pointer-events:none (in CSS)
  // lets orbit drags fall through to the canvas; the overlay re-enables events on its own annotations.
  const boundary = document.createElement('div');
  boundary.className = 'vl-boundary';
  viewport.appendChild(boundary);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  camera.position.set(13, 10, 15);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 2.5, 0);

  scene.add(new THREE.HemisphereLight('#ffffff', '#9ca3af', 1.5));
  const sun = new THREE.DirectionalLight('#fff8e8', 2.2);
  sun.position.set(9, 15, 10);
  sun.castShadow = true;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: '#dedbd1', roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 60, '#aaa69b', '#cac6bc');
  grid.position.y = -0.015;
  scene.add(grid);

  const callbacks = new Set<() => void>();
  const resize = (): void => {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  resize();
  window.addEventListener('resize', resize);

  let frame = 0;
  const render = (): void => {
    frame = requestAnimationFrame(render);
    controls.update();
    // Isolated, because the next frame is already scheduled: a callback that throws would otherwise
    // skip `renderer.render` forever while the loop kept running, freezing the canvas on its last
    // painted frame and hiding the cause. A page whose callback throws drops out of the loop and
    // says so once; everything else keeps drawing.
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        callbacks.delete(callback);
        console.error('[viewleader example] frame callback failed and was removed', error);
      }
    }
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(render);

  return {
    scene,
    camera,
    renderer,
    controls,
    boundary,
    onFrame(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    dispose() {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      controls.dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      boundary.remove();
    },
  };
}

/** Publish a page-owned object through the gallery-wide browser automation handle. */
export function exposeExampleManager(manager: unknown): void {
  window.vl = manager;
}

/** Mark a page ready only after it has finished creating and rendering its visible state. */
export function markExampleReady(): void {
  document.body.dataset.vlReady = '1';
}

export function markExampleFailed(error: unknown): void {
  document.body.dataset.vlReady = 'error';
  console.error('[viewleader example] failed to start', error);
}
