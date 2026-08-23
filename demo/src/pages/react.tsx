// The React package owns exactly one ViewLeader per mounted boundary element. It constructs nothing on
// the server or at module load — construction happens in a client effect once React supplies the DOM
// node, and the instance is disposed when the element unmounts. Replacing the boundary reconstructs it.
import type { ViewLeader } from 'viewleader';
import { useViewLeader } from 'viewleader/react';
import { createThreeAdapter } from 'viewleader/three';
import { Component, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/example.css';
import { claimChromeEdges } from '../shared/chromeInsets';
import { createControlBar } from '../shared/controls';
import {
  createExampleHarness,
  exposeExampleManager,
  markExampleFailed,
  markExampleReady,
} from '../shared/harness';
import { MOCK_ELEMENTS, SELF_OCCLUSION_EPSILON, createMockBuilding } from '../shared/mockBuilding';

try {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) throw new Error('Missing #viewport element');

  const harness = createExampleHarness(viewport);
  const building = createMockBuilding();
  harness.scene.add(building.root);
  const adapters = createThreeAdapter({
    camera: harness.camera,
    renderer: harness.renderer,
    // Without it there is no layout frame, and labels fall back to a fixed offset from their anchor
    // instead of being railed outside the model — they overlap the building and pop while orbiting.
    modelBounds: () => [building.root],
    occlusion: { objects: () => [building.root], epsilon: SELF_OCCLUSION_EPSILON },
  });

  // The harness render loop drives the live instance; `live` tracks whichever boundary is mounted.
  let live: ViewLeader | null = null;
  harness.onFrame(() => live?.update());

  let bumpGeneration: (() => void) | undefined;

  /**
   * React renders asynchronously, so nothing thrown inside a component reaches the `try` below —
   * without this the page would simply never write `data-vl-ready` and any harness watching it
   * would hang instead of reporting a failure.
   */
  class ReadyBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    public override state = { failed: false };

    public static getDerivedStateFromError(): { failed: boolean } {
      return { failed: true };
    }

    public override componentDidCatch(error: unknown): void {
      markExampleFailed(error);
    }

    public override render(): ReactNode {
      return this.state.failed ? null : this.props.children;
    }
  }

  function MountedViewer({ generation }: { generation: number }): ReactElement {
    // boundaryRef attaches to the actual node; viewLeader is null until React mounts it.
    const { boundaryRef, viewLeader } = useViewLeader({ adapters });
    useEffect(() => {
      live = viewLeader;
      if (!viewLeader) return;
      viewLeader.annotations.create({
        id: `note-${generation}`,
        anchor: { kind: 'world-point', point: MOCK_ELEMENTS.roofSlab.point },
        content: { kind: 'callout', title: `React #${generation}`, text: 'Owned by the mounted hook' },
      });
      // The hook builds a NEW runtime for every mounted boundary, and insets live on the runtime,
      // so the claim has to be made again here or the fresh instance lays labels back under the
      // control dock and the notes panel.
      reclaimChromeEdges();
      viewLeader.update();
      exposeExampleManager(viewLeader);
      markExampleReady();
      return () => {
        if (live === viewLeader) live = null;
      };
    }, [viewLeader, generation]);
    return <div ref={boundaryRef} className="framework-boundary" aria-label={`React viewer ${generation}`} />;
  }

  function App(): ReactElement {
    const [generation, setGeneration] = useState(1);
    // Expose the remount action to the plain-DOM control bar. In an effect, not the render body:
    // assigning during render is the one line here a reader would copy into a StrictMode app.
    useEffect(() => {
      bumpGeneration = () => setGeneration((value) => value + 1);
      return () => {
        bumpGeneration = undefined;
      };
    }, []);
    // A changing key forces React to unmount the old boundary (disposing its ViewLeader) and mount a new one.
    return <MountedViewer key={generation} generation={generation} />;
  }

  createRoot(harness.boundary).render(
    <ReadyBoundary>
      <App />
    </ReadyBoundary>,
  );

  const bar = createControlBar();
  // Declared here because the dock has to exist before it can be measured, and called from the
  // effect above, which React runs long after this module body. The getter is what makes that
  // safe: `live` is null until the hook has mounted a boundary, and a null instance claims nothing.
  const reclaimChromeEdges = claimChromeEdges(() => live);
  bar.button('Replace boundary', async () => {
    bumpGeneration?.();
    // Reconstruction is two passive-effect flushes away; report it once it has actually happened.
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    bar.status('React unmounted the prior instance and reconstructed on a fresh element.');
  });
  bar.status('One ViewLeader owned by the React hook. Replace the boundary to prove reconstruction.');
} catch (error) {
  markExampleFailed(error);
}
