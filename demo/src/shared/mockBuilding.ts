import * as THREE from 'three';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MockElement {
  /** Stable id a host model would expose (an IFC GlobalId, a Fragments id, …). */
  readonly id: string;
  /** World-space anchor point ViewLeader should resolve this element to. */
  readonly point: Vec3;
}

/** Named elements so example pages can anchor to stable ids instead of raw coordinates. */
export const MOCK_ELEMENTS = {
  // y is the slab's centre: walls top out at 4.8 and the slab is 0.4 thick, so 5.0 seats it on them.
  roofSlab: { id: '3O7J7yqQf3IReY$roof', point: { x: 0, y: 5, z: 0 } },
  frontDoor: { id: '2mF9x1cQ5A0uPqDoor', point: { x: 0, y: 1.05, z: 3.05 } },
  cornerColumn: { id: '1kLp7zwR9BtColumn', point: { x: -2.9, y: 2.4, z: -2.9 } },
} as const satisfies Record<string, MockElement>;

/**
 * Occlusion epsilon for this scene, in metres. Every `MOCK_ELEMENTS` anchor sits at a member's
 * CENTRE, so the ray reaches the door's own face 125 mm before the point inside it and the column's
 * face 250 mm before its axis. On the adapter's 0.1 mm default that reads as "occluded by the thing
 * it points at", and every leader in the gallery would dash. Half a structural member clears it, and
 * a real verdict here — an anchor on the far side of the shell — misses by metres, so an allowance
 * this wide has nothing left to swallow.
 */
export const SELF_OCCLUSION_EPSILON = 0.7;

export interface MockBuilding {
  readonly root: THREE.Group;
  /** Look up an element's world point by its stable id, mirroring a real host model lookup. */
  resolveElementPoint(elementId: string): Vec3 | undefined;
  dispose(): void;
}

/** A tiny, instant-loading stand-in for a loaded BIM model. Replace with your own scene. */
export function createMockBuilding(): MockBuilding {
  const root = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];

  const solid = (
    geometry: THREE.BufferGeometry,
    color: string,
    position: Vec3,
  ): THREE.Mesh => {
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position.x, position.y, position.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    disposables.push(geometry, material);
    return mesh;
  };

  // Walls (a hollow-ish box built from four slabs), a roof, and one corner column.
  const wallHeight = 4.8;
  const wallGeo = new THREE.BoxGeometry(6, wallHeight, 0.2);
  solid(wallGeo.clone(), '#c9c3b4', { x: 0, y: wallHeight / 2, z: 3 });
  solid(wallGeo.clone(), '#c9c3b4', { x: 0, y: wallHeight / 2, z: -3 });
  const sideGeo = new THREE.BoxGeometry(0.2, wallHeight, 6);
  solid(sideGeo.clone(), '#bfb9aa', { x: 3, y: wallHeight / 2, z: 0 });
  solid(sideGeo.clone(), '#bfb9aa', { x: -3, y: wallHeight / 2, z: 0 });
  wallGeo.dispose();
  sideGeo.dispose();

  solid(new THREE.BoxGeometry(6.6, 0.4, 6.6), '#a7a091', MOCK_ELEMENTS.roofSlab.point);
  solid(new THREE.BoxGeometry(0.5, 4.8, 0.5), '#8f887a', {
    x: MOCK_ELEMENTS.cornerColumn.point.x,
    y: 2.4,
    z: MOCK_ELEMENTS.cornerColumn.point.z,
  });
  solid(new THREE.BoxGeometry(1.2, 2.1, 0.25), '#6f6a5f', MOCK_ELEMENTS.frontDoor.point);

  const byId = new Map<string, Vec3>(
    Object.values(MOCK_ELEMENTS).map((element) => [element.id, element.point]),
  );

  return {
    root,
    resolveElementPoint: (elementId) => byId.get(elementId),
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}
