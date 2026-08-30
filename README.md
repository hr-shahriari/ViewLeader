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

3. **Drive it.** Call `update()` after `renderer.render()` from your own loop, as above, or pass
   `selfDrive: true` and let ViewLeader run its own `requestAnimationFrame`. Either way a frame
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

Sixteen of them — element anchoring, markup, saved views and tours, BCF round-trip, occlusion,
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
interchange functions exist at run time — 56 names in `dist/index.js`. Everything else the entry
point declares is a type, and importing one of those without `type` leaves a bundler looking for a
run-time binding that was never emitted.

Turn on `verbatimModuleSyntax` in your `tsconfig.json` and the compiler tells you which is which,
at the import site, rather than leaving it to a build error later.

### Stability

Everything the entry points export is what a host application is allowed to use. Anything not
exported from them is internal and can change between releases — including in a patch.

### License

[Apache-2.0](LICENSE)
