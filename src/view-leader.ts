// `ViewLeader` itself: the object a host creates, and the capabilities hanging off it.
//
// Everything public is grouped by what it is for — `annotations`, `authoring`, `editing`, `views`,
// `history`, `documents`, `geometry`, `diagnostics` — rather than flattened into one large surface,
// so a host discovers what it needs by reading one group instead of a hundred methods.
//
// A ViewLeader owns an SVG layer over the host's viewer. It never touches the camera, the scene or
// the model; disposing it leaves the viewer exactly as it was found.
import {
  AuthoringController,
  type AuthoringOutcome,
  type AuthoringSnapshot,
  type StartAuthoringOptions,
} from './authoring.js';
import {
  alignMoves,
  distributeMoves,
  type AlignEdge,
  type ArrangeTarget,
} from './arrange.js';
import {
  DocumentEngine,
  type TransactionOptions,
} from './document.js';
import {
  EditingController,
  type EditingCancellationReason,
  type EditingOptions,
  type EditingSnapshot,
} from './editing.js';
import {
  DefinitionsCapability,
  BUILT_IN_DEFINITIONS,
  countDefinitionReferences,
  definitionsFromCollections,
  definitionsToCollections,
  type DefinitionKind,
  type DefinitionsSnapshot,
  type ResolvedStyle,
  type TemplateApplicable,
  type TypedDefinition,
} from './definitions.js';
import {
  DisposedError,
  InvalidConfigurationError,
  InvalidDocumentError,
  NotFoundError,
} from './errors.js';
import { ExtensionRuntime, type PluginDescriptor } from './extensions.js';
import { keynotesOf, type KeynoteEntry } from './keynotes.js';
import { MarkupAuthoringCapability } from './markup-authoring-capability.js';
import {
  PluginAuthoringController,
  type PluginAuthoringCapability,
} from './plugin-authoring.js';
import type { AnnotationScreenGeometry, InkScreenGeometry, ScreenHit } from './render.js';
import type { Diagnostic, HostAdapterBundle, NormalizedPointerInput } from './host.js';
import { ViewLeaderRuntime, type FrameLintOptions, type LayoutStrategies } from './runtime.js';
import type { PlacementMode, ViewportInsets } from './labelPlacer.js';
import type { LintFinding } from './lint.js';
import type { Theme } from './theme.js';
import {
  createViewsCapability,
  prepareViewsDocument,
  type CreatedViewsCapability,
  type ViewsCapability,
} from './views.js';
import type {
  Anchor,
  Annotation,
  AnnotationDraft,
  AnnotationLeg,
  AnnotationPatch,
  AnnotationRouting,
  AnnotationsSnapshot,
  DocumentsSnapshot,
  HistorySnapshot,
  OrganizationRect,
  SnapshotCapability,
  Unsubscribe,
  Vec2,
  ViewLeaderDocument,
} from './types.js';
import { linkFrameSeam, unlinkFrameSeam } from './internal/frame-seam.js';

export interface ViewLeaderOptions {
  /**
   * The element the overlay is appended to, and the frame every pointer position is measured
   * against.
   *
   * It has to cover the same rectangle your projection adapter reports as the viewport. The overlay
   * mounts as `position: absolute; inset: 0`, so the boundary needs to establish a positioning
   * context, and a pointer is normalized against its bounding rect — a boundary offset from the
   * canvas offsets every annotation by exactly that much.
   *
   * *Which* element depends on whether core listens for pointer events itself:
   *
   * - Read-only overlay (the default, `editing.gestures` off) — a sibling `div` over the canvas with
   *   `pointer-events: none`, so the overlay never swallows an orbit drag. Annotations that need
   *   clicking re-enable events on themselves.
   * - `editing.gestures: true` — the viewport element itself, the one that already receives pointer
   *   events. Core attaches its listeners to the boundary, and a `pointer-events: none` boundary
   *   receives nothing except what bubbles up from an annotation's own hit target: a press on empty
   *   space would never arrive, and a drag would end the moment the pointer left the label.
   */
  readonly boundary: Element;
  readonly adapters: HostAdapterBundle;
  readonly initialDocument?: string | ViewLeaderDocument;
  readonly historyCapacity?: number;
  readonly plugins?: readonly PluginDescriptor[];
  readonly selfDrive?: boolean;
  readonly editing?: EditingOptions;
  /**
   * An element that wheel events over the overlay are re-dispatched to — the viewer's canvas, so
   * scrolling to zoom keeps working while the pointer is over a label.
   *
   * Needed whenever something inside the overlay takes pointer events: a label's hit target
   * swallows the wheel, and the canvas underneath never hears it. An event that already passed
   * through this element on its own way up is left alone, so nothing is delivered twice when the
   * canvas is a child of the boundary.
   */
  readonly forwardWheelTo?: Element;
  /** A hook for adjusting where a dragged label lands — snapping it to a grid or a guide. */
  readonly strategies?: LayoutStrategies;
  /**
   * The colour scheme the built-in styles are drawn in: light paper by default, or dark.
   *
   * Style ids are the same in both, so nothing a document refers to changes. Like the camera, this
   * belongs to the viewer rather than to the drawing — it is never saved, so a file authored on a
   * dark viewport opens in whatever scheme the next host is using.
   */
  readonly theme?: Theme;
}

export interface AnnotationsCapability extends SnapshotCapability<AnnotationsSnapshot> {
  get(id: string): Annotation | undefined;
  create(draft: AnnotationDraft): Annotation;
  update(id: string, patch: AnnotationPatch): Annotation;
  remove(id: string): Annotation;
  move(id: string, position: Vec2): Annotation;
  retarget(id: string, anchor: Anchor): Annotation;
  reroute(id: string, routing: AnnotationRouting): Annotation;
  /**
   * Changes the shape of one leader line, leaving the others untouched.
   *
   * The plain `reroute` writes the first leader, which is what you want when there is only one. Use
   * this as soon as an annotation has several, since a handle belongs to a leader rather than to
   * the annotation as a whole.
   */
  rerouteLeg(id: string, legId: string, routing: AnnotationRouting): Annotation;
  /** Points one leader at something new, leaving the others untouched. */
  retargetLeg(id: string, legId: string, anchor: Anchor): Annotation;
  resetPlacement(id: string): Annotation;
  resetRouting(id: string, mode?: 'straight' | 'dogleg' | 'orthogonal'): Annotation;
  /**
   * Lines the selected annotations up on one edge, as a single undo step.
   *
   * Aligns to the group's own extent, so they come together where they are rather than jumping to
   * the middle of the screen. Does nothing with fewer than two selected.
   */
  align(edge: AlignEdge): void;
  /** Evens out the spacing between the selected annotations, leaving the outermost two where they
   *  are. Does nothing with fewer than three selected. */
  distribute(axis: 'x' | 'y'): void;
  select(ids: readonly string[]): void;
  toggle(id: string): void;
  deselect(id: string): void;
  clearSelection(): void;
  /**
   * Every keynote code used in the drawing, in the order a drafter reads them, along with which
   * annotations carry each one. Use it to build a legend.
   *
   * Setting a keynote is an ordinary metadata write; there is no special method for it.
   */
  keynotes(): readonly KeynoteEntry[];
  /**
   * The style this annotation is actually drawing with, and which layer supplied each field.
   *
   * Reads through all three layers — the active saved view's override, the annotation's own, then
   * the style definition — so a panel can show the current value, badge what is overridden and
   * offer "revert to style" without re-implementing the merge.
   *
   * Sizes are pixels and **unscaled**. Unlike `geometry.of()` this is stable and safe to hold:
   * nothing changes it without publishing.
   */
  resolvedStyle(id: string): ResolvedStyle | undefined;
}

export interface DocumentsCapability extends SnapshotCapability<DocumentsSnapshot> {
  parse(source: string): ViewLeaderDocument;
  serialize(): string;
  replace(document: string | ViewLeaderDocument): ViewLeaderDocument;
}

export interface HistoryCapability extends SnapshotCapability<HistorySnapshot> {
  /**
   * Runs `operation` as one undo step.
   *
   * Pass `{ coalesce: true }` to merge into the previous entry when the labels match, which is how
   * a run of key repeats stays a single undo step. See {@link TransactionOptions}.
   */
  transaction<Result>(label: string, operation: () => Result, options?: TransactionOptions): Result;
  undo(): boolean;
  redo(): boolean;
}

export interface AuthoringCapability extends SnapshotCapability<AuthoringSnapshot> {
  readonly markup: MarkupAuthoringCapability;
  readonly plugins: PluginAuthoringCapability;
  start(options: StartAuthoringOptions): Promise<AuthoringOutcome>;
  pointerMove(pointer: NormalizedPointerInput): void;
  pointerDown(pointer: NormalizedPointerInput): Promise<void>;
  complete(anchor: Anchor): AuthoringOutcome | null;
  /** Adds one bend to a leader being drawn by hand. */
  addVertex(point: Vec2): AuthoringSnapshot;
  /** Finishes a hand-drawn leader. Enter and double-click do this for you. */
  finish(): AuthoringOutcome | null;
  cancel(): AuthoringOutcome | null;
}

export interface DefinitionsPublicCapability extends SnapshotCapability<DefinitionsSnapshot> {
  list(kind?: DefinitionKind): readonly TypedDefinition[];
  get(id: string): TypedDefinition | undefined;
  create<Definition extends TypedDefinition>(definition: Definition): Definition;
  update<Definition extends TypedDefinition>(id: string, replacement: Definition): Definition;
  remove(id: string): TypedDefinition;
  applyTemplate<Target extends TemplateApplicable>(target: Target, templateId: string): Target;
}

export interface DiagnosticsCapability {
  getSnapshot(): readonly Diagnostic[];
  subscribe(listener: (diagnostic: Diagnostic) => void): Unsubscribe;
  /**
   * Grades what is currently on screen against drafting standards: crossing leaders, non-standard
   * angles, text too small to print, leaders running through other text.
   *
   * Something you ask for rather than subscribe to. The findings describe one camera position and
   * one frame, so publishing them continuously would cost every host something most do not want.
   */
  lintFrame(options: FrameLintOptions): readonly LintFinding[];
}

/**
 * Where things currently are on screen — label boxes, leader lines, handles.
 *
 * Ask for this inside your own render loop and use it immediately. Never store it: these are screen
 * positions for one camera at one moment, and they are wrong as soon as anything moves.
 */
export interface GeometryCapability {
  of(id: string): AnnotationScreenGeometry | undefined;
  /** The same for a freehand stroke, where every point is a handle. Stroke ids are separate from
   *  annotation ids. */
  ofInk(id: string): InkScreenGeometry | undefined;
}

/**
 * Dragging annotations that already exist: moving labels, repointing arrows, bending leaders,
 * resizing regions.
 *
 * Shaped like `authoring`, so a host that drives one can drive the other. Positions are given as
 * fractions of the viewport rather than as events, so everything here can be driven from a script
 * or a keyboard as well as from a mouse.
 */
export interface EditingCapability extends SnapshotCapability<EditingSnapshot> {
  /** What is under the pointer, or nothing for empty space. */
  hitTest(pointer: NormalizedPointerInput): ScreenHit | undefined;
  /** The same question asked with a plain screen position, which is usually what a host has to
   *  hand — subtract the element's origin from a click and ask. */
  hitTestScreen(at: Vec2): ScreenHit | undefined;
  pointerDown(pointer: NormalizedPointerInput): void;
  /** Starts dragging an arrow handle. Needed when the host draws the handles itself. */
  beginHandleDrag(id: string, index: number, pointer: NormalizedPointerInput): void;
  /** The same, for a bend in a leader — or the middle of a segment, which creates a new bend. */
  beginRouteHandleDrag(id: string, index: number, pointer: NormalizedPointerInput): void;
  /** The same, for a region: a corner or edge that resizes it, or a point on a polygon. */
  beginRegionHandleDrag(id: string, index: number, pointer: NormalizedPointerInput): void;
  /** The same, for one point of a freehand stroke. */
  beginInkPointDrag(id: string, index: number, pointer: NormalizedPointerInput): void;
  pointerMove(pointer: NormalizedPointerInput): void;
  pointerUp(pointer: NormalizedPointerInput): void;
  /** Abandons the gesture. Costs no undo step, because nothing was written. */
  cancel(reason?: EditingCancellationReason): void;
}

interface PreparedReplacement {
  readonly document: ViewLeaderDocument;
  readonly diagnostics: readonly Diagnostic[];
}

export class ViewLeader {
  public readonly annotations: AnnotationsCapability;
  public readonly authoring: AuthoringCapability;
  public readonly documents: DocumentsCapability;
  public readonly history: HistoryCapability;
  public readonly definitions: DefinitionsPublicCapability;
  public readonly views: ViewsCapability;
  public readonly diagnostics: DiagnosticsCapability;
  public readonly geometry: GeometryCapability;
  public readonly editing: EditingCapability;

  readonly #document: DocumentEngine;
  readonly #runtime: ViewLeaderRuntime;
  readonly #authoring: AuthoringController;
  readonly #editing: EditingController;
  readonly #boundary: Element;
  readonly #markup: MarkupAuthoringCapability;
  readonly #pluginAuthoring: PluginAuthoringController;
  readonly #extensions: ExtensionRuntime;
  readonly #views: CreatedViewsCapability;
  #disposed = false;

  public constructor(options: ViewLeaderOptions) {
    if (options === null || typeof options !== 'object') {
      throw new InvalidConfigurationError('ViewLeader options are required');
    }
    if (!isElement(options.boundary)) {
      throw new InvalidConfigurationError('boundary must be a DOM Element');
    }
    this.#boundary = options.boundary;
    this.#document = new DocumentEngine({
      ...(options.historyCapacity === undefined ? {} : { historyCapacity: options.historyCapacity }),
    });
    const loadDiagnostics: Diagnostic[] = [];
    const initialDocument = options.initialDocument === undefined
      ? undefined
      : this.#load(options.initialDocument, loadDiagnostics);
    let invalidateRuntime = (): void => undefined;
    this.#extensions = new ExtensionRuntime(options.plugins ?? [], {
      invalidate: () => invalidateRuntime(),
    });
    let initialDiagnostics: readonly Diagnostic[] = [];
    try {
      if (initialDocument !== undefined) {
        const prepared = this.#prepareReplacement(initialDocument);
        this.#document.replace(prepared.document);
        initialDiagnostics = [...loadDiagnostics, ...prepared.diagnostics];
      }
    } catch (error) {
      this.#extensions.dispose();
      throw error;
    }
    try {
      this.#runtime = new ViewLeaderRuntime({
        boundary: options.boundary,
        adapters: options.adapters,
        document: this.#document,
        extensions: this.#extensions,
        ...(options.editing?.handles === undefined ? {} : { handles: options.editing.handles }),
        ...(options.forwardWheelTo === undefined ? {} : { forwardWheelTo: options.forwardWheelTo }),
        ...(options.strategies === undefined ? {} : { strategies: options.strategies }),
        ...(options.theme === undefined ? {} : { theme: options.theme }),
      });
    } catch (error) {
      this.#extensions.dispose();
      throw error;
    }
    invalidateRuntime = () => this.#runtime.invalidate();
    let views: CreatedViewsCapability | undefined;
    let authoring: AuthoringController | undefined;
    let editing: EditingController | undefined;
    let pluginAuthoring: PluginAuthoringController | undefined;
    let markup: MarkupAuthoringCapability | undefined;
    try {
      views = createViewsCapability({
        document: this.#document,
        runtime: this.#runtime,
        ...(options.adapters.viewerState === undefined
          ? {}
          : { viewerState: options.adapters.viewerState }),
        assertActive: () => this.#assertActive(),
      });
      this.#views = views;
      authoring = new AuthoringController(options.boundary, this.#document, this.#runtime);
      this.#authoring = authoring;
      editing = new EditingController({
        boundary: options.boundary,
        document: this.#document,
        runtime: this.#runtime,
        // Fetched on demand: markup is built a few lines further down, and a drag cannot possibly
        // need it until long after that.
        markup: () => this.#markup,
        ...(options.editing === undefined ? {} : { editing: options.editing }),
        toolActive: () => this.#toolActive(),
      });
      this.#editing = editing;
      pluginAuthoring = new PluginAuthoringController({
        document: this.#document,
        extensions: this.#extensions,
        runtime: this.#runtime,
        ...(options.adapters.interaction === undefined
          ? {}
          : { interaction: options.adapters.interaction }),
        preemptBuiltIn: () => {
          authoring?.cancel('preempted');
          markup?.cancel('preempted');
        },
      });
      this.#pluginAuthoring = pluginAuthoring;
      markup = new MarkupAuthoringCapability(
        this.#document,
        () => this.#assertActive(),
        (content) => this.#preparePluginContent(content),
        (styleId) => this.#requireStyleId(styleId),
        {
          boundary: options.boundary,
          ...(options.adapters.surfacePicking === undefined
            ? {}
            : { surfacePicking: options.adapters.surfacePicking }),
          ...(options.adapters.interaction === undefined
            ? {}
            : { interaction: options.adapters.interaction }),
          getStamp: () => ({
            runtimeRevision: this.#runtime.runtimeRevision,
            documentRevision: this.#document.documentRevision,
          }),
          publishTransientChange: (render) => this.#runtime.publishTransientChange(render),
          preemptOthers: () => {
            authoring?.cancel('preempted');
            pluginAuthoring?.cancel('preempted');
          },
        },
      );
      this.#markup = markup;
      // Everything holding in-progress state has to react to a change before subscribers are told
      // about it, or a host would read a snapshot while half the engine still described the old
      // document.
      this.#runtime.connectDocument();

      const definitions = new DefinitionsCapability({
        readDefinitions: () => definitionsFromCollections(this.#document.document.definitions),
        referenceCounts: (id) => countDefinitionReferences(
          id,
          definitionsFromCollections(this.#document.document.definitions),
          this.#document.document.annotations,
        ),
        transact: (label, operation) => this.#document.edit(label, (document) => {
          const mutation = operation(definitionsFromCollections(document.definitions));
          return {
            document: { ...document, definitions: definitionsToCollections(mutation.definitions) },
            result: mutation.value,
          };
        }),
        snapshotStamp: () => ({
          runtimeRevision: this.#runtime.runtimeRevision,
          documentRevision: this.#document.documentRevision,
        }),
        subscribe: (listener) => this.#runtime.subscribe(listener),
      }, options.theme);

      this.annotations = this.#createAnnotationsCapability();
      this.authoring = this.#createAuthoringCapability();
      this.documents = this.#createDocumentsCapability();
      this.history = this.#createHistoryCapability();
      this.definitions = this.#guardDefinitions(definitions);
      this.views = this.#views.capability;
      this.diagnostics = Object.freeze({
        getSnapshot: () => {
          this.#assertActive();
          return this.#runtime.diagnosticsSnapshot();
        },
        subscribe: (listener: (diagnostic: Diagnostic) => void) => {
          this.#assertActive();
          return this.#runtime.subscribeDiagnostics(listener);
        },
        lintFrame: (options: FrameLintOptions) => {
          this.#assertActive();
          return this.#runtime.lintFrame(options);
        },
      });
      this.geometry = Object.freeze({
        of: (id: string) => { this.#assertActive(); return this.#runtime.geometryOf(id); },
        ofInk: (id: string) => { this.#assertActive(); return this.#runtime.geometryOfInk(id); },
      });
      this.editing = this.#createEditingCapability();
      // The runtime is the thing that draws frames, but callers only ever hold a `ViewLeader`.
      // Linking them here keeps the seam reachable from `src/internal/` without putting a method on
      // this class, which is exported and would therefore make it public API.
      linkFrameSeam(this, this.#runtime);

      this.#publishDiagnostics(initialDiagnostics);
      if (options.selfDrive === true) this.start();
    } catch (error) {
      this.#disposed = true;
      const cleanupErrors = runCleanupSteps([
        () => pluginAuthoring?.dispose(),
        () => editing?.dispose(),
        () => authoring?.dispose(),
        () => markup?.dispose(),
        () => views?.dispose(),
        () => this.#runtime.dispose(),
        () => this.#extensions.dispose(),
      ]);
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'ViewLeader construction failed during cleanup');
      }
      throw error;
    }
  }

  public update(): void {
    this.#assertActive();
    this.#runtime.update();
  }

  public start(): void {
    this.#assertActive();
    this.#runtime.start();
  }

  public stop(): void {
    this.#assertActive();
    this.#runtime.stop();
  }

  /**
   * Sets the rectangle labels are kept outside of, or clears it with `null` to go back to using the
   * model's own outline. Fractions keep their place when the window is resized; pixels do not.
   */
  public setLayoutFrame(frame: OrganizationRect | null): void {
    this.#assertActive();
    this.#runtime.setLayoutFrame(frame);
  }

  /** The drawn frame, if there is one. Part of the document, so it undoes, saves and comes back on
   *  reload — it is authored work, like the notes themselves. */
  public get layoutFrame(): OrganizationRect | null {
    this.#assertActive();
    return this.#runtime.layoutFrame;
  }

  /**
   * How labels are arranged around the model: `'sides'` in columns left and right, `'rows'` across
   * the top and bottom, or `'auto'` — the default — which chooses by the model's shape.
   *
   * Automatic is deliberately reluctant to change its mind, so orbiting past the threshold cannot
   * flip the entire drawing back and forth.
   *
   * Override it only when the shape of the model and the shape of the window disagree — a tall
   * model in a wide window, or the reverse.
   *
   * A viewer setting rather than part of the document: it depends on the window being read in.
   */
  public setPlacementMode(mode: PlacementMode): void {
    this.#assertActive();
    this.#runtime.setPlacementMode(mode);
  }

  /**
   * How leader lines are shaped. By default each annotation is drawn exactly as authored. Set to
   * `'auto'` and busy drawings — twenty annotations or more — switch to right-angled leaders.
   *
   * This is a genuine trade, not a free improvement. Right-angled leaders roughly halve the number
   * of crossings, because crossings scale with how much line is drawn and the level tail of a
   * standard leader is line. What is given up is that tail, which is exactly what makes a leader
   * read as a note rather than as a schematic connection.
   *
   * Turn it on when a drawing is too dense for the tails to survive. Leave it alone when there is
   * room.
   */
  public setRoutingMode(mode: 'as-authored' | 'auto'): void {
    this.#assertActive();
    this.#runtime.setRoutingMode(mode);
  }

  /** The leader shaping currently in force. */
  public get routingMode(): 'as-authored' | 'auto' {
    this.#assertActive();
    return this.#runtime.routingMode;
  }

  /** The label arrangement currently in force. */
  public get placementMode(): PlacementMode {
    this.#assertActive();
    return this.#runtime.placementMode;
  }

  /**
   * Areas of the screen the host's own interface occupies — a toolbar across the top, a panel down
   * the side. Labels are kept out of them, so a note cannot end up underneath the toolbar where
   * nobody can click it. Pass `null` to release them.
   *
   * Given in pixels from each edge. A nonsensical value rejects the whole call rather than applying
   * some edges and not others, since a half-applied claim is impossible to reason about.
   */
  public setViewportInsets(insets: ViewportInsets | null): void {
    this.#assertActive();
    this.#runtime.setViewportInsets(insets);
  }

  /** The reserved edges currently in force, if any. */
  public get viewportInsets(): ViewportInsets | undefined {
    this.#assertActive();
    return this.#runtime.viewportInsets;
  }

  /**
   * Scales every annotation together — text, pen weights, arrowheads, tails, padding and boxes.
   * Passing 2 makes everything twice the size.
   *
   * **This is about printing, not about readability.** Annotations already hold their size on
   * screen however far you zoom, so nothing here is needed to keep small text legible. Set it when
   * the same drawing is plotted at a different scale.
   *
   * A viewer setting rather than part of the document, so two people printing one file at different
   * scales do not overwrite each other. It is never saved, and opening a document never changes
   * it.
   */
  public setAnnotationScale(scale: number): void {
    this.#assertActive();
    this.#runtime.setAnnotationScale(scale);
  }

  /** The scale currently in force. */
  public get annotationScale(): number {
    this.#assertActive();
    return this.#runtime.annotationScale;
  }

  /**
   * The `<svg>` the overlay draws into. It exists from construction, so it is never `undefined` —
   * but it holds nothing until the first {@link update}.
   *
   * This is what `exportVectorSheet` wants: `exportVectorSheet(vl.overlayElement, { paper: '#fff' })`.
   * Read it, do not write it — the frame loop owns every child, and anything added here is gone by
   * the next render.
   */
  /**
   * The element this instance was built for — the one the viewer draws into.
   *
   * Anything mounting host chrome inside the viewer needs it: to normalize a pointer against its
   * bounding rect, or to reach `ownerDocument` for a listener. Deriving it from
   * {@link overlayElement} happens to work, since the overlay is a child, but that is a coincidence
   * of the render tree rather than a promise — so it is published.
   *
   * Read it, do not reparent it.
   */
  public get boundary(): Element {
    this.#assertActive();
    return this.#boundary;
  }

  public get overlayElement(): SVGSVGElement {
    this.#assertActive();
    return this.#runtime.overlay;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Before the steps below: a subscribe racing disposal should find nothing rather than a
    // plausible-looking subscription to an emitter that will never fire again.
    unlinkFrameSeam(this);
    const cleanupErrors = runCleanupSteps([
      () => this.#views.dispose(),
      () => this.#pluginAuthoring.dispose(),
      () => this.#editing.dispose(),
      () => this.#authoring.dispose(),
      () => this.#markup.dispose(),
      () => this.#extensions.dispose(),
      () => this.#runtime.dispose(),
    ]);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'ViewLeader disposal failed');
    }
  }

  #createAnnotationsCapability(): AnnotationsCapability {
    return Object.freeze({
      getSnapshot: () => { this.#assertActive(); return this.#runtime.annotationsSnapshot(); },
      subscribe: (listener: () => void) => { this.#assertActive(); return this.#runtime.subscribe(listener); },
      get: (id: string) => { this.#assertActive(); return this.#document.get(id); },
      create: (draft: AnnotationDraft) => {
        this.#assertActive();
        this.#requireStyleId(draft.styleId);
        return this.#document.create({ ...draft, content: this.#preparePluginContent(draft.content) });
      },
      update: (id: string, patch: AnnotationPatch) => {
        this.#assertActive();
        this.#requireStyleId(typeof patch.styleId === 'string' ? patch.styleId : undefined);
        return this.#document.update(id, patch.content === undefined
          ? patch
          : { ...patch, content: this.#preparePluginContent(patch.content) });
      },
      remove: (id: string) => { this.#assertActive(); return this.#document.remove(id); },
      move: (id: string, position: Vec2) => {
        this.#assertActive();
        // Kind-preserving. An absolute point goes in either way, but a label that already follows
        // its anchor keeps following it — otherwise a single arrow-key nudge silently undoes the
        // drag that placed it (the gallery's own host-chrome page nudges exactly this way). One
        // guard in the shared method beats one in every caller. Anything else — an automatic
        // label, or a plain pin — still gets the plain pin this has always written.
        const current = this.#document.get(id)?.placement;
        const placement = current?.kind === 'manual' && current.anchor !== undefined
          ? this.#runtime.placementAt(id, position)
          : { kind: 'manual' as const, position };
        return this.#document.update(id, { placement }, 'Move annotation');
      },
      retarget: (id: string, anchor: Anchor) => {
        this.#assertActive();
        return this.#document.update(id, { anchor }, 'Retarget annotation');
      },
      reroute: (id: string, routing: AnnotationRouting) => {
        this.#assertActive();
        return this.#document.update(id, { routing }, 'Reroute annotation');
      },
      rerouteLeg: (id: string, legId: string, routing: AnnotationRouting) => {
        this.#assertActive();
        return this.#document.update(
          id,
          { anchors: this.#withLeg(id, legId, (leg) => ({ ...leg, routing })) },
          'Reroute annotation leg',
        );
      },
      retargetLeg: (id: string, legId: string, anchor: Anchor) => {
        this.#assertActive();
        return this.#document.update(
          id,
          { anchors: this.#withLeg(id, legId, (leg) => ({ ...leg, anchor })) },
          'Retarget annotation leg',
        );
      },
      resetPlacement: (id: string) => {
        this.#assertActive();
        return this.#document.update(id, { placement: { kind: 'automatic' } }, 'Reset annotation placement');
      },
      resetRouting: (id: string, mode: 'straight' | 'dogleg' | 'orthogonal' = 'straight') => {
        this.#assertActive();
        return this.#document.update(id, { routing: { kind: 'automatic', mode } }, 'Reset annotation routing');
      },
      align: (edge: AlignEdge) => {
        this.#assertActive();
        this.#arrange(alignMoves(this.#selectedTargets(), edge), 'Align annotations');
      },
      distribute: (axis: 'x' | 'y') => {
        this.#assertActive();
        this.#arrange(distributeMoves(this.#selectedTargets(), axis), 'Distribute annotations');
      },
      select: (ids: readonly string[]) => {
        this.#assertActive();
        for (const id of ids) this.#requireAnnotation(id);
        this.#runtime.select(ids);
      },
      toggle: (id: string) => { this.#assertActive(); this.#requireAnnotation(id); this.#runtime.toggleSelection(id); },
      deselect: (id: string) => { this.#assertActive(); this.#requireAnnotation(id); this.#runtime.deselect(id); },
      clearSelection: () => { this.#assertActive(); this.#runtime.clearSelection(); },
      keynotes: () => { this.#assertActive(); return keynotesOf(this.#document.document.annotations); },
      resolvedStyle: (id: string) => {
        this.#assertActive();
        return this.#runtime.resolvedStyleOf(id);
      },
    });
  }

  /**
   * The label boxes of the selected annotations, as actually drawn. Anything off screen has no box
   * this frame and is skipped rather than aligned to a guess at where it might be.
   */
  #selectedTargets(): readonly ArrangeTarget[] {
    return this.#runtime.annotationsSnapshot().selectedIds.flatMap((id): ArrangeTarget[] => {
      const geometry = this.#runtime.geometryOf(id);
      return geometry === undefined ? [] : [{ id, label: geometry.label }];
    });
  }

  /** Everything moves in one transaction, so aligning twenty labels is one undo step — and moving
   *  none of them costs no undo step at all. */
  #arrange(moves: readonly { id: string; position: Vec2 }[], label: string): void {
    if (moves.length === 0) return;
    this.#document.transaction(label, () => {
      for (const move of moves) {
        this.#document.update(move.id, { placement: { kind: 'manual', position: move.position } });
      }
    });
  }

  /** All the leaders with one replaced. Naming a leader that does not exist is an error rather than
   *  a silent no-op, because it always means the caller is confused about something. */
  #withLeg(
    id: string,
    legId: string,
    replace: (leg: AnnotationLeg) => AnnotationLeg,
  ): readonly AnnotationLeg[] {
    const current = this.#requireAnnotation(id);
    if (!current.anchors.some((leg) => leg.id === legId)) throw new NotFoundError('annotation leg', legId);
    return current.anchors.map((leg) => leg.id === legId ? replace(leg) : leg);
  }

  #createAuthoringCapability(): AuthoringCapability {
    return Object.freeze({
      markup: this.#markup,
      plugins: this.#pluginAuthoring,
      getSnapshot: () => { this.#assertActive(); return this.#authoring.getSnapshot(); },
      subscribe: (listener: () => void) => { this.#assertActive(); return this.#authoring.subscribe(listener); },
      start: (options: StartAuthoringOptions) => {
        this.#assertActive();
        this.#pluginAuthoring.cancel('preempted');
        this.#markup.cancel('preempted');
        return this.#authoring.start({
          ...options,
          draft: {
            ...options.draft,
            content: this.#preparePluginContent(options.draft.content),
          },
        });
      },
      pointerMove: (pointer: NormalizedPointerInput) => { this.#assertActive(); this.#authoring.pointerMove(pointer); },
      pointerDown: (pointer: NormalizedPointerInput) => { this.#assertActive(); return this.#authoring.pointerDown(pointer); },
      complete: (anchor: Anchor) => { this.#assertActive(); return this.#authoring.complete(anchor); },
      addVertex: (point: Vec2) => { this.#assertActive(); return this.#authoring.addVertex(point); },
      finish: () => { this.#assertActive(); return this.#authoring.finish(); },
      cancel: () => { this.#assertActive(); return this.#authoring.cancel(); },
    });
  }

  /** True while a drawing tool is active, which is when editing gestures get out of the way. */
  #toolActive(): boolean {
    return this.#authoring.getSnapshot().phase !== 'idle'
      || this.#markup.getSnapshot().phase !== 'idle'
      || this.#pluginAuthoring.getSnapshot().phase !== 'idle';
  }

  #createEditingCapability(): EditingCapability {
    return Object.freeze({
      getSnapshot: () => { this.#assertActive(); return this.#editing.getSnapshot(); },
      subscribe: (listener: () => void) => { this.#assertActive(); return this.#editing.subscribe(listener); },
      hitTest: (pointer: NormalizedPointerInput) => { this.#assertActive(); return this.#editing.hitTest(pointer); },
      hitTestScreen: (at: Vec2) => { this.#assertActive(); return this.#editing.hitTestScreen(at); },
      pointerDown: (pointer: NormalizedPointerInput) => { this.#assertActive(); this.#editing.pointerDown(pointer); },
      beginHandleDrag: (id: string, index: number, pointer: NormalizedPointerInput) => {
        this.#assertActive();
        this.#requireAnnotation(id);
        this.#editing.beginHandleDrag(id, index, pointer);
      },
      beginRouteHandleDrag: (id: string, index: number, pointer: NormalizedPointerInput) => {
        this.#assertActive();
        this.#requireAnnotation(id);
        this.#editing.beginRouteHandleDrag(id, index, pointer);
      },
      beginRegionHandleDrag: (id: string, index: number, pointer: NormalizedPointerInput) => {
        this.#assertActive();
        this.#requireAnnotation(id);
        this.#editing.beginRegionHandleDrag(id, index, pointer);
      },
      beginInkPointDrag: (id: string, index: number, pointer: NormalizedPointerInput) => {
        this.#assertActive();
        if (this.#markup.getInk(id) === undefined) throw new NotFoundError('ink', id);
        this.#editing.beginInkPointDrag(id, index, pointer);
      },
      pointerMove: (pointer: NormalizedPointerInput) => { this.#assertActive(); this.#editing.pointerMove(pointer); },
      pointerUp: (pointer: NormalizedPointerInput) => { this.#assertActive(); this.#editing.pointerUp(pointer); },
      cancel: (reason?: EditingCancellationReason) => {
        this.#assertActive();
        this.#editing.cancel(reason);
      },
    });
  }

  #createDocumentsCapability(): DocumentsCapability {
    return Object.freeze({
      getSnapshot: () => { this.#assertActive(); return this.#runtime.documentsSnapshot(); },
      subscribe: (listener: () => void) => { this.#assertActive(); return this.#runtime.subscribe(listener); },
      parse: (source: string) => {
        this.#assertActive();
        const loadDiagnostics: Diagnostic[] = [];
        const prepared = this.#prepareReplacement(this.#load(source, loadDiagnostics));
        this.#publishDiagnostics([...loadDiagnostics, ...prepared.diagnostics]);
        return prepared.document;
      },
      serialize: () => { this.#assertActive(); return this.#document.serialize(); },
      replace: (value: string | ViewLeaderDocument) => {
        this.#assertActive();
        const loadDiagnostics: Diagnostic[] = [];
        const prepared = this.#prepareReplacement(this.#load(value, loadDiagnostics));
        const replaced = this.#document.replace(prepared.document);
        this.#publishDiagnostics([...loadDiagnostics, ...prepared.diagnostics]);
        return replaced;
      },
    });
  }

  #createHistoryCapability(): HistoryCapability {
    return Object.freeze({
      getSnapshot: () => { this.#assertActive(); return this.#runtime.historySnapshot(); },
      subscribe: (listener: () => void) => { this.#assertActive(); return this.#runtime.subscribe(listener); },
      transaction: <Result>(label: string, operation: () => Result, options?: TransactionOptions) => {
        this.#assertActive();
        return this.#document.transaction(label, operation, options);
      },
      undo: () => { this.#assertActive(); return this.#document.undo(); },
      redo: () => { this.#assertActive(); return this.#document.redo(); },
    });
  }

  #guardDefinitions(capability: DefinitionsCapability): DefinitionsPublicCapability {
    return Object.freeze({
      getSnapshot: () => { this.#assertActive(); return capability.getSnapshot(); },
      subscribe: (listener: () => void) => { this.#assertActive(); return capability.subscribe(listener); },
      list: (kind?: DefinitionKind) => { this.#assertActive(); return capability.list(kind); },
      get: (id: string) => { this.#assertActive(); return capability.get(id); },
      create: <Definition extends TypedDefinition>(definition: Definition) => {
        this.#assertActive(); return capability.create(definition);
      },
      update: <Definition extends TypedDefinition>(id: string, replacement: Definition) => {
        this.#assertActive(); return capability.update(id, replacement);
      },
      remove: (id: string) => { this.#assertActive(); return capability.remove(id); },
      applyTemplate: <Target extends TemplateApplicable>(target: Target, templateId: string) => {
        this.#assertActive(); return capability.applyTemplate(target, templateId);
      },
    });
  }

  #preparePluginContent(content: Annotation['content']): Annotation['content'] {
    if (!content.kind.startsWith('plugin:')) return content;
    const plugin = content as Extract<Annotation['content'], { kind: `plugin:${string}` }>;
    const envelope = this.#extensions.validateForCommit({
      pluginId: plugin.pluginId,
      recordType: 'content',
      schemaVersion: plugin.schemaVersion,
      data: plugin.data,
    });
    const record = this.#extensions.prepare([envelope]).resolved[0];
    if (record !== undefined) this.#extensions.render(record);
    return {
      kind: `plugin:${envelope.pluginId}`,
      pluginId: envelope.pluginId,
      schemaVersion: envelope.schemaVersion,
      data: envelope.data,
    };
  }

  /**
   * The one forgiving way in.
   *
   * What arrives here was written somewhere else, possibly by a newer version, so an annotation this
   * build cannot read is reported and set aside rather than allowed to refuse the whole file.
   * Everything else stays strict, because everything else is this session's own input.
   */
  #load(value: string | ViewLeaderDocument, into: Diagnostic[]): ViewLeaderDocument {
    const diagnose = (diagnostic: Diagnostic): void => { into.push(diagnostic); };
    return typeof value === 'string'
      ? this.#document.parse(value, diagnose)
      : this.#document.prepare(value, diagnose);
  }

  #prepareReplacement(prepared: ViewLeaderDocument): PreparedReplacement {
    const diagnostics: Diagnostic[] = [];
    const customDefinitions = definitionsFromCollections(prepared.definitions);
    const styleIds = new Set([...BUILT_IN_DEFINITIONS, ...customDefinitions]
      .filter((definition) => definition.kind === 'style')
      .map(({ id }) => id));
    for (const annotation of prepared.annotations) {
      if (annotation.styleId !== undefined && !styleIds.has(annotation.styleId)) {
        throw new InvalidDocumentError('Annotation references an unknown style definition', {
          annotationId: annotation.id,
          styleId: annotation.styleId,
        });
      }
    }
    for (const value of prepared.ink) {
      const styleId = typeof value.styleId === 'string' ? value.styleId : undefined;
      if (styleId !== undefined && !styleIds.has(styleId)) {
        throw new InvalidDocumentError('Ink references an unknown style definition', { styleId });
      }
    }
    const resolution = this.#extensions.prepare(prepared.pluginEnvelopes);
    for (const diagnostic of resolution.diagnostics) {
      diagnostics.push({
        code: diagnostic.code,
        severity: 'warning',
        message: diagnostic.message,
      });
    }
    const pluginEnvelopes = [
      ...resolution.resolved.map(({ envelope, data, descriptor }) => ({
        pluginId: envelope.pluginId,
        recordType: envelope.recordType,
        schemaVersion: descriptor.schemaVersion,
        data,
      })),
      ...resolution.unresolved,
    ];
    const annotations = prepared.annotations.map((annotation) => {
      if (!annotation.content.kind.startsWith('plugin:')) return annotation;
      const plugin = annotation.content as Extract<Annotation['content'], { kind: `plugin:${string}` }>;
      const contentResolution = this.#extensions.prepare([{
        pluginId: plugin.pluginId,
        recordType: 'content',
        schemaVersion: plugin.schemaVersion,
        data: plugin.data,
      }]);
      for (const diagnostic of contentResolution.diagnostics) {
        diagnostics.push({
          code: diagnostic.code,
          severity: 'warning',
          message: diagnostic.message,
          annotationId: annotation.id,
        });
      }
      const record = contentResolution.resolved[0];
      if (record === undefined) return annotation;
      try {
        this.#extensions.render(record);
      } catch (cause) {
        // Plugin content that was accepted rather than rejected may still fail to draw — a shape
        // no upgrade step produces, for instance. Opening the file must not fail for that either,
        // so the content is kept exactly as saved and simply is not drawn.
        diagnostics.push({
          code: 'CONTENT_RENDER_FAILED',
          severity: 'warning',
          message: cause instanceof Error ? cause.message : 'Annotation content could not be rendered',
          annotationId: annotation.id,
        });
        return annotation;
      }
      return {
        ...annotation,
        content: {
          kind: `plugin:${record.descriptor.id}` as const,
          pluginId: record.descriptor.id,
          schemaVersion: record.descriptor.schemaVersion,
          data: record.data,
        },
      };
    });
    return Object.freeze({
      document: this.#document.prepare(
        prepareViewsDocument({ ...prepared, annotations, pluginEnvelopes }),
      ),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  #publishDiagnostics(diagnostics: readonly Diagnostic[]): void {
    for (const diagnostic of diagnostics) {
      this.#runtime.publishExternalDiagnostic(diagnostic);
    }
  }

  #requireAnnotation(id: string): Annotation {
    const annotation = this.#document.get(id);
    if (annotation === undefined) throw new NotFoundError('annotation', id);
    return annotation;
  }

  #requireStyleId(styleId: string | undefined): void {
    if (styleId === undefined) return;
    const definitions = [
      ...BUILT_IN_DEFINITIONS,
      ...definitionsFromCollections(this.#document.document.definitions),
    ];
    if (!definitions.some((definition) => definition.kind === 'style' && definition.id === styleId)) {
      throw new NotFoundError('style definition', styleId);
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new DisposedError();
  }
}

function isElement(value: unknown): value is Element {
  return value !== null && typeof value === 'object' &&
    'ownerDocument' in value && 'appendChild' in value && 'getBoundingClientRect' in value;
}

function runCleanupSteps(steps: readonly (() => void)[]): unknown[] {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { step(); } catch (error) { errors.push(error); }
  }
  return errors;
}
