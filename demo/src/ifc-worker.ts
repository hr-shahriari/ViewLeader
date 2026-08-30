// Parses the Duplex IFC off the main thread and posts back plain typed arrays.
//
// This is host code, not library code: ViewLeader never parses IFC, never sees `web-ifc`, and never
// learns what a GlobalId is. All it eventually receives is `{ modelId, elementId }` and a world
// point, through the element adapter the page builds in `shared/ifcModel.ts`.
//
// It runs in a worker because the fixture is 2.4 MB and the parse blocks for seconds. On the main
// thread that freezes the gallery page — including the annotation overlay, whose whole subject is
// staying glued to a camera the user is still driving.
import { IfcAPI, LogLevel, type FlatMesh } from 'web-ifc';
// Vite rewrites this to the emitted, content-hashed asset URL and copies the file into the build.
// `demo/src/env.d.ts` already declares the `*?url` module shape.
import wasmUrl from 'web-ifc/web-ifc.wasm?url';

import type {
  IfcChunk,
  IfcElementRecord,
  IfcGeometryRecord,
  IfcPlacement,
  IfcWorkerRequest,
  IfcWorkerResponse,
} from './shared/ifcMessages.js';

// `self` is typed as a Window here: `demo/tsconfig.json` ships the DOM lib, and adding `WebWorker`
// to it collides on half a dozen globals. A two-method view of the scope is cheaper than reworking
// the lib set for one file.
interface WorkerScope {
  postMessage(message: IfcWorkerResponse, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<IfcWorkerRequest>) => void): void;
}
const scope = self as unknown as WorkerScope;

/** Elements per posted chunk. Small enough that the tree appears progressively, large enough that
 *  a few hundred elements do not become a few hundred structured clones. */
const CHUNK_ELEMENTS = 120;

const post = (message: IfcWorkerResponse, transfer: Transferable[] = []): void =>
  scope.postMessage(message, transfer);

async function run(request: IfcWorkerRequest): Promise<void> {
  const api = new IfcAPI();
  // `Init`'s locate hook rather than `SetWasmPath`: that setter treats its argument as a DIRECTORY
  // and returns `wasmPath + fileName`, so handing it Vite's content-hashed asset URL asks for
  // `/assets/web-ifc-<hash>.wasmweb-ifc.wasm`. That 404s, the dev and preview servers answer a 404
  // with index.html, and the failure surfaces as `expected magic word, found 3c 21 64 6f` — the
  // first four bytes of `<!doctype`. Returning the URL outright is the only form that survives
  // content hashing.
  //
  // Single-threaded on purpose. The threaded build pulls a second asset, `web-ifc-mt.worker.js`,
  // that nothing here emits, and it needs SharedArrayBuffer — which is cross-origin-isolated only,
  // and the gallery is served without those headers.
  await api.Init((path) => (path.endsWith('.wasm') ? wasmUrl : path), true);
  // After `Init`, never before: `SetLogLevel` forwards straight to `this.wasmModule`, which does not
  // exist until the wasm is instantiated, so an earlier call throws on undefined and takes the whole
  // load with it. `Init` sets its own default of LOG_LEVEL_ERROR, which is what this overrides.
  //
  // Off, deliberately, and load-bearing for the e2e suite: it fails a page on any console error, and
  // web-ifc logs about entities this fixture uses that it does not implement. Genuine failures still
  // arrive — they come back as an `error` message and the page shows them in its status line.
  api.SetLogLevel(LogLevel.LOG_LEVEL_OFF);

  const response = await fetch(request.url);
  if (!response.ok) throw new Error(`Could not fetch ${request.url} (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  // Duplex is authored on survey coordinates, which puts the building hundreds of metres from the
  // origin. Left there, the camera frames a speck and float precision degrades across the model.
  const modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });

  try {
    // Geometry is instanced in IFC — every window in the model is the same mesh under a different
    // transform. Extracting each one per placement would re-copy the same vertices dozens of times
    // and post them all; keyed by `geometryExpressID`, each is extracted, transferred and uploaded
    // to the GPU once.
    const sentGeometries = new Set<number>();
    let geometries: IfcGeometryRecord[] = [];
    let elements: IfcElementRecord[] = [];
    let transfer: Transferable[] = [];
    let total = 0;

    const flush = (): void => {
      if (elements.length === 0 && geometries.length === 0) return;
      const chunk: IfcChunk = { geometries, elements };
      post({ kind: 'chunk', chunk }, transfer);
      geometries = [];
      elements = [];
      transfer = [];
    };

    api.StreamAllMeshes(modelId, (mesh: FlatMesh) => {
      const placements: IfcPlacement[] = [];

      for (let index = 0; index < mesh.geometries.size(); index += 1) {
        const placed = mesh.geometries.get(index);
        const geometryId = placed.geometryExpressID;

        if (!sentGeometries.has(geometryId)) {
          sentGeometries.add(geometryId);
          const geometry = api.GetGeometry(modelId, geometryId);
          // These are views straight into the wasm heap. They must be copied before they cross the
          // postMessage boundary — the heap is reused for the next geometry, and `delete()` below
          // releases it outright, so a transferred view would arrive as garbage or a detached page.
          const vertices = api
            .GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize())
            .slice();
          const indices = api
            .GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize())
            .slice();
          geometry.delete();

          geometries.push({ id: geometryId, vertices, indices });
          transfer.push(vertices.buffer, indices.buffer);
        }

        placements.push({
          geometryId,
          // Copied out of the wasm-backed array for the same reason as the vertices above.
          matrix: [...placed.flatTransformation],
          color: [placed.color.x, placed.color.y, placed.color.z, placed.color.w],
        });
      }

      const typeCode: number = api.GetLineType(modelId, mesh.expressID);
      // `GetLine` is a full entity parse, so it happens once per element and never per placement.
      // A malformed or partial entity is an ordinary condition in a real file, not a failure of the
      // load — the element keeps its express id and shows up in the tree unnamed.
      let globalId = '';
      let name = '';
      try {
        const line = api.GetLine(modelId, mesh.expressID) as
          { GlobalId?: { value?: string }; Name?: { value?: string } } | null;
        globalId = line?.GlobalId?.value ?? '';
        name = line?.Name?.value ?? '';
      } catch {
        // Falls through to the express-id label below.
      }

      elements.push({
        expressId: mesh.expressID,
        // The stable id ViewLeader anchors against. A handful of entities in real files carry no
        // GlobalId; an express-id-derived stand-in keeps them addressable and still stable across a
        // reload of the same file, which is the property the anchor actually needs.
        globalId: globalId === '' ? `express:${mesh.expressID}` : globalId,
        name: name === '' ? `#${mesh.expressID}` : name,
        type: api.GetNameFromTypeCode(typeCode),
        placements,
      });

      // No `mesh.delete()`. The `FlatMesh` type carries one because `LoadAllGeometry` hands back a
      // `Vector<FlatMesh>` the caller owns — but a streamed mesh is a wasm-owned temporary that is
      // freed when this callback returns, and calling `delete` on it throws `is not a function`.
      // The geometry above is different: `GetGeometry` really does hand over ownership.
      total += 1;
      if (elements.length >= CHUNK_ELEMENTS) flush();
    });

    flush();
    post({ kind: 'done', elements: total });
  } finally {
    api.CloseModel(modelId);
  }
}

scope.addEventListener('message', (event) => {
  void run(event.data).catch((error: unknown) => {
    post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  });
});
