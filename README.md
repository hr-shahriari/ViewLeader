# ViewLeader

An SVG annotation layer for 3D model viewers. Callouts, tags, markup and leader lines that stay
attached to the model as the camera moves — laid out so they never overlap, never cross each other,
and never swim about while you orbit.

ViewLeader owns the annotations and nothing else. It never touches your camera, your scene or your
model, and it works with any viewer that can answer one question: where does this world point land
on screen. A Three.js adapter ships with it.

### Install

```sh
npm install viewleader
```

### Usage

```js
import { ViewLeader } from "viewleader";
import { createThreeAdapter } from "viewleader/three";

const adapters = createThreeAdapter({
  camera,
  renderer,
  // Labels are arranged outside this, so notes sit clear of the building.
  modelBounds: () => [model],
});

const leader = new ViewLeader({ boundary: viewport, adapters });

leader.annotations.create({
  anchor: { kind: "world-point", point: { x: 4, y: 3, z: 0 } },
  content: {
    kind: "callout",
    title: "AHU-03",
    text: "Roof-mounted air handling unit",
  },
});

// Re-project each frame so the annotations track the camera.
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  leader.update();
});
```

### Integration checklist (Three.js)

1. **Pick the right `boundary`.** This one is conditional, and getting it wrong is the most common
   integration bug.
   - **Read-only overlay** — a `pointer-events: none` sibling `div` covering the canvas, so orbit
     drags fall straight through to the viewer. See `demo/src/shared/harness.ts` and the
     `.vl-boundary` rule in `demo/src/shared/example.css`.
   - **With `editing.gestures: true`** — pass the viewport element itself, the element that
     actually receives pointer events. Core binds its gesture listeners to the boundary, so a
     `pointer-events: none` boundary only ever sees what bubbles out of an annotation's own hit
     target: the drag freezes the moment the pointer leaves the label. See
     `demo/src/pages/direct-editing.ts`, which is written around this.

   Core's own SVG is `pointer-events: none` either way, so it never swallows anything the host
   wanted.

2. **Build the adapter.** `createThreeAdapter` needs a `camera` and a `renderer` (or a `viewport`
   snapshot). `modelBounds` is asked for fresh every frame, so add and remove objects freely.
   Pass `controls` and ViewLeader can lease your OrbitControls — it disables them for the length
   of a gesture, so an edit and an orbit can never run at once.

3. **Drive it.** Call `update()` after `renderer.render()` from your own loop, as above. A frame
   that changed nothing costs nothing.

4. **Claim the edges your chrome owns.** `setViewportInsets({ top, right, bottom, left })` keeps
   labels out from behind a toolbar or a side panel. Chrome does not move when the camera does, so
   measure it from a `ResizeObserver` rather than per frame — `demo/src/shared/chromeInsets.ts` is
   the worked example.

5. **Opt into editing** with `editing: { gestures: true, marquee: 'modifier' }`. `gestures` is the
   whole opt-in: core then runs label drags, anchor re-targeting, route bends and marquee select,
   one undo step each, Escape to cancel. `marquee` defaults to `'none'` when you passed `controls`,
   because a rubber band on every plain left-press would take the interaction lease and kill
   left-drag orbit; `'modifier'` asks for the band back on a shift- or alt-drag only.

6. **`forwardWheelTo: canvas`** if the overlay is eating your zoom. Once anything in the overlay
   takes pointer events, a wheel over a label never reaches the canvas underneath; this re-dispatches
   it there.

7. **`dispose()` on unmount.** It removes the overlay and every listener. Nothing you passed in is
   touched — no renderer disposed, no camera moved, no scene changed.

### Organizing leaders around a model

```js
// The Three adapter's modelBounds callback chooses one model or group to organize around.
leader.setPlacementMode("quadrants");
leader.setKeepLabelsOutsideModel(true);
```

Quadrant routing gives anchors near the left/right edges short side exits. When side slots or
routes conflict, deeper anchors escape above or below the model and turn outward through ordered
lanes. When rotation compresses anchors into a narrow strip near one side, crowded labels form a
compact column: their leaders leave that side horizontally and spread toward the labels outside
the model. Label sizes, other labels, and already planned routes influence the choice.

During rotation, leaders remember their text-line attachment and the relative allocation of
near-equal anchors. Small camera movements keep those choices stable; larger movements or changed
space can still rearrange labels. Anchors continue following the model every frame, including
camera damping after a drag. This continuity also applies to automatic side and row placement.
The memory is temporary and is cleared when annotations are deleted or a document is replaced.

`setKeepLabelsOutsideModel(true)` also works with `sides`, `rows`, and `auto`. It keeps the whole
label outside the current model rectangle even at close zoom: labels can leave the viewport and
are clipped instead of being pushed back over the model. An anchor's line still starts inside the
rectangle when its target is inside. A drawn layout frame cannot shrink this protected area.

Both controls are viewer settings. They do not rewrite the document or add undo steps. Manual
and locked label positions are temporarily constrained for display when strict placement is on;
their stored positions return when it is off. Manual leader bends and region attachments retain
their existing routing. Host snaps that break an organized route's clearance or cause conflicts
are ignored. `ORGANIZATION_CONFLICT` diagnostics report unresolved constraints; coincident
anchors and authored obstacles can prevent a completely crossing-free layout.

Strict placement requires `modelBounds` and `projection.projectBounds`. The Three adapter supplies
both when given a `modelBounds` callback, including safe projection across the camera near plane.
The rectangle encloses the entire supplied 3D model or group at every camera angle, including its
depth; it is not calculated from the annotated face or anchor points.
Other hosts implement `projectBounds` with an unclipped, finite rectangle and an `available`,
`empty`, or `unavailable` status. If current safe bounds are unavailable, strict mode withholds
labels and reports `MODEL_BOUNDS_UNAVAILABLE`; it never substitutes stale bounds. Without strict
placement, quadrant routing can fall back to a drawn frame or the anchors' bounds.

Bounds are polled during `update()` in these modes so a moving model refreshes even with a
stationary camera. Large scenes can supply `modelBoundsRevision: () => sceneRevision` to the Three
adapter (or `modelBounds.getRevision()` in another host) to cache bounds until that revision changes.
Increment it whenever the target objects, geometry, or transforms change.

Try `/organized-leaders/` for the four-quadrant example, side/rear views, and close-zoom controls.
That example also enables the Three adapter's `occlusion: { objects: () => [model] }` option:
hidden anchors get faded, dashed leader lines while the default `keep` policy leaves labels readable.
Leader Editor and Workbench also expose both settings. Use `setPlacementMode("auto")` and
`setKeepLabelsOutsideModel(false)` to return to the default behavior.

`/ifc-studio/` enables quadrant routing and outside-only placement for the loaded IFC. Its
Organization inspector provides the same controls plus fit, side, and rear views. Hidden leaders
fade and dash while labels remain readable; close zoom can put labels offscreen.
In either example, orbit slowly, reverse direction, and release to inspect the final damping frames.
Switch between Automatic and Quadrant routing to compare both arrangements.

### Exporting a sheet

The overlay's current frame, as a standalone SVG with paper, a title block and an optional picture
of the model behind it. Interface geometry — hit pads, handles, the marquee, selection highlights —
is stripped; the drawing is not.

```js
import {
  exportVectorSheet,
  rasterizeVectorSheet,
} from "viewleader/interchange";

const sheet = exportVectorSheet(leader.overlayElement, {
  width: 1191,
  height: 842, // A3 at 72dpi (points). Defaults to the overlay's own size.
  paper: "#fff",
  underlayDataUrl: canvas.toDataURL("image/png"),
  titleBlock: { drawingNumber: "A-101", scale: "NTS", date: "2026-08-28" },
});

// sheet.svg is a string. For a PNG instead:
const { blob } = await rasterizeVectorSheet(sheet, devicePixelRatio);
```

The sheet is two coordinate spaces: the root is the paper, and the annotations keep their own
pixels inside a nested frame that is fitted to it. When the two have different proportions,
`preserveAspectRatio` decides — `'xMidYMid meet'` (the default) fits the whole drawing centred,
`'xMidYMid slice'` fills and crops, `'none'` stretches.

`underlayDataUrl` must be a `data:` URI. The sheet is a standalone file, so an `http(s):` reference
would be a broken link everywhere it is opened — and would taint the canvas on the raster path.

### Examples

Eighteen of them — model-aware organization, element anchoring, markup, saved views and tours, BCF round-trip, occlusion,
drafting styles, direct editing, React and Vue.

Can be viewed here [Example page](https://hr-shahriari.github.io/ViewLeader/)

or

```sh
git clone https://github.com/hr-shahriari/ViewLeader.git
cd ViewLeader
npm install
npm run build
npm run dev:demo
```

### Entry points

|                          |                                                                 |
| ------------------------ | --------------------------------------------------------------- |
| `viewleader`             | The engine.                                                     |
| `viewleader/three`       | Three.js adapter.                                               |
| `viewleader/react`       | React binding — `useViewLeader`, `useViewLeaderSnapshot`.       |
| `viewleader/vue`         | Vue binding — the same two, same names.                         |
| `viewleader/markdown`    | Markdown content plugin, and the worked example of writing one. |
| `viewleader/interchange` | BCF 2.1 read/write, and the SVG sheet exporter.                 |

Three, React and Vue are optional peer dependencies. Install only what you import.

### Value vs type imports

Most of what ViewLeader exports is types. Only `ViewLeader` itself, the error classes, the
constants (`mm`, `lineweight`, `PEN`, `CAD_PAPER`, …), the geometry and lint helpers and the
interchange functions exist at run time — 50 names in `dist/index.js`. Everything else the entry
point declares is a type, and importing one of those without `type` leaves a bundler looking for a
run-time binding that was never emitted.

Turn on `verbatimModuleSyntax` in your `tsconfig.json` and the compiler tells you which is which,
at the import site, rather than leaving it to a build error later.

### Stability

Everything the entry points export is what a host application is allowed to use. Anything not
exported from them is internal and can change between releases — including in a patch.

### License

[Apache-2.0](LICENSE)
