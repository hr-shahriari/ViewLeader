# ViewLeader

SVG annotations for 3D model viewers. Add callouts, tags, and markup anchored to
points or elements in a model. ViewLeader places the labels and routes their
leader lines as the camera moves.

Works with your existing viewer through an adapter. Includes a Three.js adapter
and React and Vue bindings.

[Live examples](https://hr-shahriari.github.io/ViewLeader/) ·

## Install

```sh
npm install viewleader
```

Three.js, React, and Vue are optional peer dependencies; install the ones you use.
The package is ESM only.

## Add a callout with Three.js

This assumes an existing `scene`, `camera`, `renderer`, and loaded `model`.
The `viewport` is a sized container with `position: relative`; its canvas fills it.

```js
import { ViewLeader } from "viewleader";
import { createThreeAdapter } from "viewleader/three";

const boundary = document.createElement("div");
boundary.style.cssText = "position: absolute; inset: 0; pointer-events: none;";
viewport.appendChild(boundary);

const leader = new ViewLeader({
  boundary,
  adapters: createThreeAdapter({
    camera,
    renderer,
    modelBounds: () => [model],
  }),
  forwardWheelTo: renderer.domElement,
});

leader.annotations.create({
  anchor: { kind: "world-point", point: { x: 4, y: 3, z: 0 } },
  content: {
    kind: "callout",
    title: "AHU-03",
    text: "Roof-mounted air handling unit",
  },
});

// Add leader.update() to your existing render loop.
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  leader.update();
});
```

Call `leader.dispose()` and remove the boundary when tearing down the viewer.
For dragging labels and changing anchors, see [editing](docs/integration.md#editing).

## Explore

The [example gallery](https://hr-shahriari.github.io/ViewLeader/) covers label layout,
editing, IFC models, saved views, and BCF import/export. Each example includes its source.

| Import                   | Provides                                       |
| ------------------------ | ---------------------------------------------- |
| `viewleader`             | Annotation engine and public types             |
| `viewleader/three`       | Three.js adapter                               |
| `viewleader/react`       | `useViewLeader`, `useViewLeaderSnapshot`       |
| `viewleader/vue`         | `useViewLeader`, `useViewLeaderSnapshot`       |
| `viewleader/markdown`    | Markdown content plugin                        |
| `viewleader/interchange` | BCF 2.1 import/export and SVG/PNG sheet export |

See the [integration guide](docs/integration.md) for viewer setup, keeping labels
outside the model, and exporting sheets.

## Run the examples locally

Requires Node.js 20 or newer.

```sh
git clone https://github.com/hr-shahriari/ViewLeader.git
cd ViewLeader
npm install
npm run build
npm run dev:demo
```

## License

[Apache-2.0](LICENSE)
