// The wire format between `src/ifc-worker.ts` and `shared/ifcModel.ts`.
//
// Its own module so both ends compile against one declaration: a worker boundary is structural
// typing with no compiler checking it, and the two sides drifting is the classic way a worker
// starts posting a field the reader never looks at. Nothing here imports `web-ifc` or `three` —
// it is plain data, which is also what makes every array transferable.

export interface IfcGeometryRecord {
  readonly id: number;
  /** Interleaved position + normal, six floats per vertex, exactly as web-ifc lays it out. */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

export interface IfcPlacement {
  readonly geometryId: number;
  /** Column-major 4×4, ready for `THREE.Matrix4.fromArray`. */
  readonly matrix: readonly number[];
  readonly color: readonly [r: number, g: number, b: number, a: number];
}

export interface IfcElementRecord {
  readonly expressId: number;
  /** IFC GlobalId — the id annotations are anchored against. */
  readonly globalId: string;
  readonly name: string;
  /** IFC class name as web-ifc reports it, e.g. `IFCWALLSTANDARDCASE`. */
  readonly type: string;
  readonly placements: readonly IfcPlacement[];
}

export interface IfcChunk {
  readonly geometries: readonly IfcGeometryRecord[];
  readonly elements: readonly IfcElementRecord[];
}

export interface IfcWorkerRequest {
  readonly url: string;
}

export type IfcWorkerResponse =
  | { readonly kind: 'chunk'; readonly chunk: IfcChunk }
  | { readonly kind: 'done'; readonly elements: number }
  | { readonly kind: 'error'; readonly message: string };
