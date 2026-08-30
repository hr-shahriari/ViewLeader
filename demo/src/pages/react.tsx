// The React package owns exactly one ViewLeader per mounted boundary element. It constructs nothing on
// the server or at module load — construction happens in a client effect once React supplies the DOM
// node, and the instance is disposed when the element unmounts. Replacing the boundary reconstructs it.
//
// Everything above the lifecycle is headless: the hooks return state and spreadable props, and this
// page owns every element and every pixel of styling. Only the inline text editor ships as a
// component, because its markup carries knowledge — it has to sit *on* the text it replaces without
// the glyphs jumping, which is what the CSS custom properties the follow registry writes are for.
import type { ViewLeader } from 'viewleader';
import {
  LabelTextEditor,
  useEditingKeyboard,
  useFollow,
  useHandleEntries,
  useHandles,
  useLabelTextEditor,
  useStyleEditor,
  useStyleEditorSnapshot,
  useViewLeader,
  useViewLeaderSnapshot,
  type FollowRegistry,
} from 'viewleader/react';
import { createThreeAdapter } from 'viewleader/three';
import { Component, useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
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

  const NOTES = [
    { key: 'roof', element: MOCK_ELEMENTS.roofSlab, title: 'Roof slab', text: 'RC 200 mm' },
    { key: 'door', element: MOCK_ELEMENTS.frontDoor, title: 'Front door', text: 'D-04' },
    { key: 'column', element: MOCK_ELEMENTS.cornerColumn, title: 'Corner column', text: 'C-12' },
  ] as const;

  const SWATCHES = ['#1f2937', '#b91c1c', '#047857'] as const;

  type LabelEditor = NonNullable<ReturnType<typeof useLabelTextEditor>>;

  /** Absolutely positioned against the boundary; the registry writes the transform every frame. */
  const followed: CSSProperties = { position: 'absolute', top: 0, left: 0, pointerEvents: 'auto' };

  /**
   * Handles for one annotation, drawn by this page rather than by core.
   *
   * Its own component so the hook is only alive while something is selected — and so unmounting on
   * deselect releases the registrations rather than leaving them to be swept later. `props` arrive
   * already routed to the right `begin*Drag`, with pointer capture and Escape wired: there are four
   * of those calls in core and picking between them is exactly what the hook exists to absorb.
   */
  function HandleLayer(
    { viewLeader, follow, annotationId }:
    { viewLeader: ViewLeader; follow: FollowRegistry; annotationId: string },
  ): ReactElement {
    const handles = useHandles(viewLeader, follow, annotationId);
    const entries = useHandleEntries(handles);
    return (
      <>
        {entries.map((entry) => (
          <div
            key={entry.key}
            ref={handles?.ref(entry)}
            {...entry.props}
            style={{
              ...followed,
              width: 9,
              height: 9,
              marginLeft: -5,
              marginTop: -5,
              cursor: entry.cursor,
              // Square for the arrow end, round for anything that reshapes the leader — the same
              // distinction core's own grips draw.
              borderRadius: entry.kind === 'handle' ? 2 : 5,
              // A midpoint inserts a bend rather than moving one, and hollow-versus-solid is the
              // only thing on screen that says so.
              background: entry.cursor === 'copy' ? '#fff' : '#2563eb',
              border: '1.5px solid #2563eb',
              boxSizing: 'border-box',
            }}
          />
        ))}
      </>
    );
  }

  /**
   * Everything drawn on top of the model: handles, the toolbar, the inline field.
   *
   * `follow` and `editor` are built by the parent because the parent owns the boundary, and the
   * double-click that opens the editor lands on a label inside core's overlay — a sibling of this
   * layer, so only their shared ancestor can hear it.
   */
  function Editor(
    { viewLeader, follow, editor }:
    { viewLeader: ViewLeader; follow: FollowRegistry | null; editor: LabelEditor | null },
  ): ReactElement {
    const annotations = useViewLeaderSnapshot(viewLeader.annotations);
    const style = useStyleEditor(viewLeader);
    const styleState = useStyleEditorSnapshot(style);
    // Arrows nudge, Shift+arrow nudges further, Delete removes, Escape clears. A held arrow is one
    // undo step, not one per repeat — which is the difference between undo working and undo having
    // been evicted by the time you reach for it.
    useEditingKeyboard(viewLeader);

    const selectedId = annotations?.selectedIds[0] ?? null;
    const lineColor = styleState?.fields.lineColor;

    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          // Transparent to the pointer as a layer; each child re-enables for itself.
          pointerEvents: 'none',
          // Above the overlay, which core appends to the boundary *after* React's children. The
          // overlay root is `pointer-events: none`, but its leader hit-targets are
          // `pointer-events: stroke` — and a midpoint handle sits exactly on the line it belongs to,
          // so without this the leader takes the press meant for the handle drawn on top of it.
          zIndex: 1,
        }}
      >
        {follow !== null && selectedId !== null && (
          <>
            <HandleLayer viewLeader={viewLeader} follow={follow} annotationId={selectedId} />
            {/*
              A label target carries the label's size as well as its position, so this shell is the
              label's own box — and the toolbar can then sit above it with `bottom: 100%` instead of
              guessing an offset. Floating UI recommends the same split for the same reason: the
              positioned node stays the library's, the styled node stays yours.
            */}
            <div ref={follow.ref({ kind: 'label', id: selectedId })} style={followed}>
              <div style={{
                position: 'absolute',
                left: 0,
                bottom: 'calc(100% + 6px)',
                display: 'flex',
                gap: 4,
                padding: 4,
                background: '#fff',
                border: '1px solid #d4d8e0',
                borderRadius: 6,
                boxShadow: '0 2px 8px rgb(16 20 28 / 12%)',
              }}
              >
              {SWATCHES.map((colour) => (
                <button
                  key={colour}
                  type="button"
                  aria-label={`Line colour ${colour}`}
                  data-swatch={colour}
                  onClick={() => style?.set('lineColor', colour)}
                  style={{
                    width: 18,
                    height: 18,
                    padding: 0,
                    borderRadius: 4,
                    background: colour,
                    cursor: 'pointer',
                    // `mixed` is a real state, not an absent one: with several selected and
                    // disagreeing, no swatch is the current one.
                    border: lineColor?.mixed === false && lineColor.value === colour
                      ? '2px solid #111'
                      : '1px solid #d4d8e0',
                  }}
                />
              ))}
              </div>
            </div>
          </>
        )}
        <LabelTextEditor
          editor={editor}
          style={{
            pointerEvents: 'auto',
            resize: 'none',
            border: '1px solid #2563eb',
            borderRadius: 2,
            background: '#fff',
          }}
        />
      </div>
    );
  }

  function MountedViewer({ generation }: { generation: number }): ReactElement {
    // boundaryRef attaches to the actual node; viewLeader is null until React mounts it.
    // `handles: 'none'` turns core's own grips off — every handle on this page is drawn below.
    const { boundaryRef, viewLeader } = useViewLeader({ adapters, editing: { handles: 'none' } });
    const follow = useFollow(viewLeader);
    const editor = useLabelTextEditor(viewLeader, follow);
    useEffect(() => {
      live = viewLeader;
      if (!viewLeader) return;
      for (const note of NOTES) {
        viewLeader.annotations.create({
          id: `${note.key}-${generation}`,
          anchor: {
            kind: 'element',
            modelId: 'building',
            elementId: note.element.id,
            // Where the leader points if the element is not in the model this session — a reload
            // with a changed id lands here rather than dropping the note.
            fallbackPoint: note.element.point,
          },
          content: { kind: 'callout', title: note.title, text: note.text },
        });
      }
      viewLeader.annotations.select([`${NOTES[0].key}-${generation}`]);
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
    return (
      <div
        ref={boundaryRef}
        className="framework-boundary"
        aria-label={`React viewer ${generation}`}
        {...(editor === null ? {} : { onDoubleClick: editor.boundaryProps.onDoubleClick })}
      >
        {viewLeader !== null && (
          <Editor viewLeader={viewLeader} follow={follow} editor={editor} />
        )}
      </div>
    );
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
  bar.status('Click a label to select it. Drag its handles, double-click to retype, recolour from'
    + ' the toolbar, nudge with the arrows. Every element here belongs to the page.');
} catch (error) {
  markExampleFailed(error);
}
