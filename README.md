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
import { ViewLeader } from 'viewleader';
import { createThreeAdapter } from 'viewleader/three';

const adapters = createThreeAdapter({
  camera,
  renderer,
  // Labels are arranged outside this, so notes sit clear of the building.
  modelBounds: () => [model],
});

const leader = new ViewLeader({ boundary: viewport, adapters });

leader.annotations.create({
  anchor: { kind: 'world-point', point: { x: 4, y: 3, z: 0 } },
  content: { kind: 'callout', title: 'AHU-03', text: 'Roof-mounted air handling unit' },
});

// Re-project each frame so the annotations track the camera.
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  leader.update();
});
```

### Examples

Sixteen of them — element anchoring, markup, saved views and tours, BCF round-trip, occlusion,
drafting styles, direct editing, React and Vue.

```sh
git clone https://github.com/hr-shahriari/ViewLeader.git
cd ViewLeader
npm install
npm run build
npm run dev:demo
```

### Entry points

| | |
| --- | --- |
| `viewleader` | The engine. |
| `viewleader/three` | Three.js adapter. |
| `viewleader/react` | React binding — `useViewLeader`, `useViewLeaderSnapshot`. |
| `viewleader/vue` | Vue binding — the same two, same names. |
| `viewleader/markdown` | Markdown content plugin, and the worked example of writing one. |

Three, React and Vue are optional peer dependencies. Install only what you import.

### License

[Apache-2.0](LICENSE)
