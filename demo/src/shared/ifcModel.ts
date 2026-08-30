// A loaded IFC model, in the same shape `mockBuilding.ts` hands back a fake one.
//
// The rule `harness.ts` follows applies here too: this file knows nothing about ViewLeader. It owns
// the worker, the GPU resources and the loader-local express ids, and exposes two things across that
// line, both keyed on the IFC GlobalId and neither of them an engine type the annotation layer would
// have to understand: where an element is, and which element an object belongs to.
import * as THREE from 'three';

import type { IfcChunk, IfcWorkerRequest, IfcWorkerResponse } from './ifcMessages.js';

export interface IfcElement {
  readonly globalId: string;
  readonly name: string;
  readonly type: string;
  readonly object: THREE.Object3D;
}

export interface IfcTypeGroup {
  readonly type: string;
  readonly elements: readonly IfcElement[];
}

export interface IfcModel {
  readonly root: THREE.Group;
  /** Elements bucketed by IFC class, each bucket sorted by name. */
  readonly groups: readonly IfcTypeGroup[];
  /**
   * Where an element anchor should point: the centre of the element's bounds, in world space.
   *
   * A point rather than the `Object3D`, deliberately. The Three adapter resolves an object with
   * `getWorldPosition`, and every element group here sits at the origin with its placement baked
   * into each child mesh's matrix — so handing back the object put all three seeded leaders on
   * `(0, 0, 0)` instead of on the wall, door and roof they name.
   */
  elementAnchorPoint(globalId: string): THREE.Vector3 | undefined;
  /** The GlobalId of whatever element owns this object, for turning a raycast hit into an anchor. */
  elementIdOf(object: THREE.Object3D): string | undefined;
  dispose(): void;
}

export interface LoadIfcOptions {
  /** Reports elements built so far. There is no total until the parse ends, so this counts up. */
  readonly onProgress?: (elements: number) => void;
}

/** Marks the group that stands for one IFC element, so a raycast hit can walk up to it. */
const ELEMENT_ID = 'ifcGlobalId';

export function loadIfcModel(url: string, options: LoadIfcOptions = {}): Promise<IfcModel> {
  return new Promise<IfcModel>((resolve, reject) => {
    // `new URL(..., import.meta.url)` is the form Vite understands in both dev and build; a bare
    // string path resolves against the page, which is `/ifc-studio/` and not where the module lives.
    const worker = new Worker(new URL('../ifc-worker.ts', import.meta.url), { type: 'module' });

    const root = new THREE.Group();
    root.name = 'ifc-model';
    const geometries = new Map<number, THREE.BufferGeometry>();
    const materials = new Map<string, THREE.MeshStandardMaterial>();
    const byGlobalId = new Map<string, THREE.Object3D>();
    const byType = new Map<string, IfcElement[]>();
    let built = 0;

    const material = (color: readonly [number, number, number, number]): THREE.MeshStandardMaterial => {
      const [r, g, b, a] = color;
      // Keyed on the rounded colour: IFC repeats the same material on thousands of placements, and
      // one THREE material per placement is thousands of shader programs for a handful of looks.
      const key = `${r.toFixed(3)}:${g.toFixed(3)}:${b.toFixed(3)}:${a.toFixed(3)}`;
      const existing = materials.get(key);
      if (existing !== undefined) return existing;
      const created = new THREE.MeshStandardMaterial({
        color: new THREE.Color(r, g, b),
        roughness: 0.85,
        metalness: 0,
        // Glazing and space volumes come through with alpha. Without `transparent` they draw opaque
        // and the model reads as a solid block.
        ...(a < 1 ? { transparent: true, opacity: a, depthWrite: false } : {}),
        side: THREE.DoubleSide,
      });
      materials.set(key, created);
      return created;
    };

    const consume = (chunk: IfcChunk): void => {
      for (const record of chunk.geometries) {
        // One interleaved buffer, two views into it. web-ifc already hands back position and normal
        // packed six floats to a vertex, so de-interleaving would be a second full copy of the model
        // for no gain — THREE reads the stride directly.
        const buffer = new THREE.InterleavedBuffer(record.vertices, 6);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
        geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(buffer, 3, 3));
        geometry.setIndex(new THREE.BufferAttribute(record.indices, 1));
        geometries.set(record.id, geometry);
      }

      for (const record of chunk.elements) {
        // A group even for a single placement, so the hit-test walk below has one node per element
        // whatever the geometry count, and so hiding an element is one `visible` flag.
        const group = new THREE.Group();
        group.name = record.name;
        group.userData[ELEMENT_ID] = record.globalId;
        group.userData['ifcType'] = record.type;
        group.userData['ifcExpressId'] = record.expressId;

        for (const placement of record.placements) {
          const geometry = geometries.get(placement.geometryId);
          if (geometry === undefined) continue;
          const mesh = new THREE.Mesh(geometry, material(placement.color));
          // web-ifc's transform is column-major, which is `fromArray`'s own layout.
          mesh.matrix.fromArray([...placement.matrix]);
          mesh.matrixAutoUpdate = false;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
        }

        if (group.children.length === 0) continue;
        root.add(group);
        byGlobalId.set(record.globalId, group);
        const bucket = byType.get(record.type);
        const element: IfcElement = {
          globalId: record.globalId,
          name: record.name,
          type: record.type,
          object: group,
        };
        if (bucket === undefined) byType.set(record.type, [element]);
        else bucket.push(element);
        built += 1;
      }

      options.onProgress?.(built);
    };

    const finish = (): IfcModel => {
      const groups: IfcTypeGroup[] = [...byType.entries()]
        .map(([type, elements]) => ({
          type,
          elements: [...elements].sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.type.localeCompare(b.type));

      // Bounds are geometry, and geometry does not change after the load — so each is measured at
      // most once, however often an anchor re-resolves.
      const centres = new Map<string, THREE.Vector3>();

      return {
        root,
        groups,
        elementAnchorPoint(globalId) {
          const cached = centres.get(globalId);
          if (cached !== undefined) return cached;
          const object = byGlobalId.get(globalId);
          if (object === undefined) return undefined;
          const box = new THREE.Box3().setFromObject(object);
          if (box.isEmpty()) return undefined;
          const centre = box.getCenter(new THREE.Vector3());
          centres.set(globalId, centre);
          return centre;
        },
        elementIdOf(object) {
          // Raycasts land on the mesh; the id lives on its element group one level up. Walking
          // rather than reading the parent directly keeps this correct if a future loader nests
          // deeper — and it stops at `root`, so a hit on the ground plane returns nothing.
          let node: THREE.Object3D | null = object;
          while (node !== null && node !== root) {
            const id: unknown = node.userData[ELEMENT_ID];
            if (typeof id === 'string') return id;
            node = node.parent;
          }
          return undefined;
        },
        dispose() {
          for (const geometry of geometries.values()) geometry.dispose();
          for (const value of materials.values()) value.dispose();
          root.removeFromParent();
          root.clear();
          geometries.clear();
          materials.clear();
          byGlobalId.clear();
          byType.clear();
          centres.clear();
        },
      };
    };

    worker.addEventListener('message', (event: MessageEvent<IfcWorkerResponse>) => {
      const message = event.data;
      if (message.kind === 'chunk') {
        consume(message.chunk);
        return;
      }
      // Either terminal message ends the worker: it has done its one job and holds a wasm heap the
      // size of the model until it is gone.
      worker.terminate();
      if (message.kind === 'error') reject(new Error(message.message));
      else if (built === 0) reject(new Error('The IFC parsed but produced no geometry'));
      else resolve(finish());
    });

    worker.addEventListener('error', (event) => {
      worker.terminate();
      reject(new Error(event.message === '' ? 'The IFC worker failed to start' : event.message));
    });

    const request: IfcWorkerRequest = { url };
    worker.postMessage(request);
  });
}
