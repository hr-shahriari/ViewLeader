// The engine that turns a document into a drawable frame.
//
// Once per frame it asks the host where everything is, measures each label, decides where the
// labels go, pushes overlapping ones apart, routes the leader lines, and hands the finished plan to
// the renderer. Nothing here draws anything.
//
// Most of the complexity is about doing that fast enough to run on every frame of a camera orbit,
// and about the results being steady: the same document seen from the same angle must produce the
// same drawing, or the annotations appear to crawl about while the user is simply looking around.
import {
  DEFAULT_FONT_SIZE,
  layoutBuiltInContent,
  type BuiltInContentLayout,
  type ContentBounds,
} from './content.js';
import {
  DEFAULT_LANDING,
  builtInDefinitions,
  definitionsFromCollections,
  mergeStyleOverride,
  readStyleOverride,
  type EnclosureDefinition,
  type StyleContentBox,
  type StyleDefinition,
  type StyleLanding,
  type StyleOverride,
  type TypedDefinition,
} from './definitions.js';
import { type DocumentCommit, DocumentEngine } from './document.js';
import { AdapterError, InvalidInputError } from './errors.js';
import {
  type DeclarativePrimitive,
  type ExtensionRuntime,
} from './extensions.js';
import type { Diagnostic, HostAdapterBundle, ViewportSnapshot } from './host.js';
import { HostIntegration } from './host.js';
import {
  ImageResolutionManager,
  imagePortFromAdapter,
  type ImageFrameState,
} from './images.js';
import {
  generateRevisionCloudArcs,
  inkFromJson,
  legRouteFromCore,
  projectInk,
  projectRegion,
  regionAnchorFromCore,
  regionAttachment,
  type InkAnnotation,
  type ProjectedRegion,
  type RegionAnchor as MarkupRegionAnchor,
} from './markup.js';
import {
  OcclusionManager,
  occlusionPortFromAdapter,
  type OcclusionCandidate,
  type OcclusionPolicy,
  type OcclusionPresentation,
} from './occlusion.js';
import {
  defaultRenderStyle,
  SvgOverlay,
  annotationScreenGeometry,
  hitTestInkPlan,
  hitTestPlan,
  inkScreenGeometry,
  fitEnclosurePath,
  resolveTerminator,
  textLineOffsets,
  type AnnotationScreenGeometry,
  type InkScreenGeometry,
  type PlannedAnnotation,
  type PlannedInk,
  type RenderGroupPrimitive,
  type RenderPathPrimitive,
  type RenderPrimitive,
  type RenderStyle,
  type RenderTerminator,
  type RenderableContentLayout,
  type ScreenHit,
} from './render.js';
import { TagTextResolutionManager } from './tagText.js';
import { invalidateTextMetrics, watchFontLoading } from './textMetrics.js';
import {
  breakAroundObstacles,
  routeLegs,
  type PlacementInput,
  type LegRoute,
  type RouteLegInput,
  type ScreenBounds,
} from './routing.js';
import {
  LabelPlacer,
  SECTOR_HYSTERESIS,
  uncrossLeaderSlots,
  type ConnectionEdge,
  type LabelSector,
  type PlacementMode,
  type RoutingHint,
  type ViewportInsets,
} from './labelPlacer.js';
import { separateLabels } from './separation.js';
import {
  BoundaryMemory,
  resolveLayoutFrame,
  type Bounds2,
} from './frame.js';
import { CAP_RATIO, type Theme } from './theme.js';
import {
  lintFrame,
  type LintFinding,
  type LintOptions,
  type LintPolyline,
} from './lint.js';

/** The smallest lettering height drawing standards allow on a printed sheet. */
const ISO_3098_MINIMUM_TEXT_HEIGHT_MM = 2.5;
/**
 * How close to a standard angle a leader has to be to count as drawn at it. Tight enough to catch a
 * genuinely wrong angle, loose enough that nudging a label by one pixel does not raise a complaint.
 */
const DEFAULT_ANGLE_TOLERANCE_DEGREES = 2;

/**
 * What a host must supply to grade its own drawing.
 *
 * Only the pixels-per-millimetre is required, because it is the one thing that cannot be worked out
 * from the screen: it says what size this viewport stands in for when printed, which is what makes
 * "is this text too small" answerable at all.
 */
export interface FrameLintOptions extends Partial<Omit<LintOptions, 'pixelsPerMillimetre'>> {
  readonly pixelsPerMillimetre: number;
}
import type {
  Annotation,
  AnnotationPlacement,
  AnnotationRuntimeSnapshot,
  AnnotationsSnapshot,
  BuiltInContent,
  DocumentsSnapshot,
  HistorySnapshot,
  JsonObject,
  PluginContent,
  Unsubscribe,
  OrganizationRect,
  Rect,
  Vec2,
  Vec3,
} from './types.js';
import type { SavedViewAnnotationOverrides } from './saved-views/neutral-types.js';

export interface AnnotationViewRuntimeState {
  readonly activeViewId?: string;
  readonly overrides: SavedViewAnnotationOverrides;
}

/**
 * What a snapping hook is told about a label it is being asked to position.
 *
 * Deliberately just enough to make the decision. Handing over the layout's own working — the frame,
 * the candidate positions — would make all of it public and impossible to change later.
 */
export interface SnapContext {
  readonly id: string;
  readonly labelSize: Readonly<{ width: number; height: number }>;
  readonly anchor: Vec2;
}

export interface LayoutStrategies {
  /**
   * Adjusts where a label is about to be placed — to snap it to the host's own grid lines, say.
   *
   * Consulted both when layout picks a position and while a label is being dragged, so what the user
   * sees during the drag is exactly where it lands on release.
   *
   * A hook that throws or returns nonsense is reported as a diagnostic and ignored. One bug in a
   * host's snapping rule must not blank the whole overlay.
   */
  readonly snap?: (proposed: Vec2, ctx: SnapContext) => Vec2;
}

export interface RuntimeOptions {
  readonly boundary: Element;
  readonly adapters: HostAdapterBundle;
  readonly document: DocumentEngine;
  readonly extensions: ExtensionRuntime;
  /** Set to `'none'` when the host draws its own drag handles. */
  readonly handles?: 'core' | 'none';
  readonly strategies?: LayoutStrategies;
  /** The colour scheme the built-in styles are drawn in. */
  readonly theme?: Theme;
  /** Where wheel events over the overlay are re-dispatched to, usually the viewer's canvas. */
  readonly forwardWheelTo?: Element;
}

interface ProjectedLeg {
  readonly id: string;
  readonly anchor: Vec2;
  readonly worldPoint: Vec3;
  readonly route: ReturnType<typeof legRouteFromCore>;
  readonly region?: ProjectedRegion;
}

interface LayoutCandidate {
  readonly annotation: Annotation;
  readonly layout: RenderableContentLayout;
  readonly style: RenderStyle;
  readonly legs: readonly ProjectedLeg[];
}

/**
 * Makes up a frame when there is nothing to frame: the box spanned by whatever the annotations
 * themselves point at.
 *
 * This keeps everything on one arrangement algorithm. With a second one for the no-frame case,
 * gaining or losing the model's outline midway through an orbit would swap algorithms and move
 * every label at once. For arranging labels, "the model" is really just whatever the notes point
 * at, which is what the model's outline approximates anyway.
 *
 * Given a minimum size, because the arrangement divides by the frame's height and reads which side
 * of its centre things fall on. A single annotation, or several stacked on one pixel, would
 * otherwise produce a frame with no area and put every label on the same edge.
 */
const MINIMUM_SYNTHETIC_FRAME = 2 * SECTOR_HYSTERESIS;

function anchorCloudFrame(inputs: readonly PlacementInput[]): Bounds2 {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const input of inputs) {
    for (const anchor of input.projectedAnchors) {
      if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) continue;
      minX = Math.min(minX, anchor.x);
      minY = Math.min(minY, anchor.y);
      maxX = Math.max(maxX, anchor.x);
      maxY = Math.max(maxY, anchor.y);
    }
  }
  // Nothing is on screen, so any box will do — there is nothing to arrange around it.
  if (!Number.isFinite(minX)) return { min: { x: 0, y: 0 }, max: { x: MINIMUM_SYNTHETIC_FRAME, y: MINIMUM_SYNTHETIC_FRAME } };
  const padX = Math.max(0, MINIMUM_SYNTHETIC_FRAME - (maxX - minX)) / 2;
  const padY = Math.max(0, MINIMUM_SYNTHETIC_FRAME - (maxY - minY)) / 2;
  return { min: { x: minX - padX, y: minY - padY }, max: { x: maxX + padX, y: maxY + padY } };
}

const PLACEMENT_MODES: readonly PlacementMode[] = ['sides', 'rows', 'auto', 'perimeter'];

/**
 * How many annotations count as a crowded drawing, for automatic leader shaping.
 *
 * Below this a drawing has room for the level tails on its leaders; above it, those tails are the
 * main thing the leaders are crossing.
 */
const CROWDED_ANNOTATION_COUNT = 20;

const MAX_RETAINED_DIAGNOSTICS = 1_000;

export class ViewLeaderRuntime {
  readonly #document: DocumentEngine;
  readonly #extensions: ExtensionRuntime;
  readonly #host: HostIntegration;
  readonly #images: ImageResolutionManager;
  readonly #tagText: TagTextResolutionManager;
  readonly #occlusion: OcclusionManager;
  readonly #hasOcclusion: boolean;
  readonly #overlay: SvgOverlay;
  readonly #listeners = new Set<() => void>();
  readonly #diagnosticListeners = new Set<(diagnostic: Diagnostic) => void>();
  readonly #diagnostics: Diagnostic[] = [];
  readonly #selected = new Set<string>();
  readonly #cleanup: Unsubscribe[] = [];
  readonly #window: Window | null;
  readonly #previousPlacement = new Map<string, ScreenBounds>();
  readonly #labelPlacer = new LabelPlacer();
  readonly #boundaryMemory = new BoundaryMemory();
  readonly #previousSectors = new Map<string, LabelSector>();
  /** Where each annotation's anchors averaged out on screen this frame — the quantity an
   *  anchor-relative placement is measured against. Rebuilt from scratch every arrangement, so an
   *  annotation that was not placed this frame is simply absent. */
  readonly #anchorOrigins = new Map<string, Vec2>();
  readonly #layoutCache = new Map<string, Readonly<{
    signature: string;
    layout: RenderableContentLayout;
  }>>();
  #pluginAuthoringPreview: readonly DeclarativePrimitive[] = Object.freeze([]);
  #imageOwners = new Set<string>();
  #hoveredId: string | null = null;
  #runtimeRevision = 0;
  #renderInvalidated = true;
  #lastProjectionRevision: string | number | undefined;
  #selfDriven = false;
  #animationFrame: number | undefined;
  #immediatePending = false;
  #documentConnected = false;
  #disposed = false;
  #activeViewId: string | undefined;
  #activeViewOverrides: SavedViewAnnotationOverrides = Object.freeze({});
  /** What was drawn last frame, so a host asking where something is gets an answer without the
   *  whole frame being worked out again. */
  #lastPlan: readonly PlannedAnnotation[] = Object.freeze([]);
  /** The same for freehand ink, which is stored separately and hit-tested separately. */
  #lastInk: readonly PlannedInk[] = Object.freeze([]);
  /** Which strokes are selected. Ink is not an annotation, so it keeps its own selection. */
  readonly #selectedInk = new Set<string>();
  /**
   * Areas of the screen the host's own interface occupies, which labels are kept out of.
   *
   * Nothing at all is different from zero on every edge: it lets the arrangement skip the
   * arithmetic entirely rather than doing it and finding it changes nothing.
   */
  #viewportInsets: ViewportInsets | undefined;
  /**
   * Columns down the sides, rows above and below, or automatic — which chooses by the model's shape
   * and is deliberately reluctant to change its mind mid-orbit.
   *
   * Automatic by default, because the right answer depends on the shape of what is on screen. A
   * drawing that always uses columns crams them full on a wide, shallow view while the whole top
   * and bottom of the screen sits empty.
   */
  #placementMode: PlacementMode = 'auto';
  /**
   * How leader lines are shaped. By default each annotation is drawn exactly as authored.
   *
   * Set to automatic, crowded drawings switch to right-angled leaders. That is the one change that
   * materially reduces crossings — dozens of attempts at cleverer placement and routing barely moved
   * the number, and this roughly halved it in one step.
   *
   * The reason is not subtle: crossings scale with how much line is on screen, and the level tail of
   * a standard leader is line. So it is a real trade. A crowded drawing gives up the tail that makes
   * a leader read as a note, in exchange for half the crossings — a drafting decision, which is why
   * it is opt-in.
   */
  #routingMode: 'as-authored' | 'auto' = 'as-authored';
  /** Which version of the document the remembered layout was last tidied against, so deleted
   *  annotations do not leave their positions behind forever. */
  #layoutMemoryRevision: number | undefined;
  /**
   * Things the arrangement worked out that the router needs and cannot recover on its own: which
   * edge of each label faces the model, whether it was pushed out of its column, and where its
   * leader should bend if so.
   *
   * Rebuilt from scratch every frame.
   */
  readonly #placerHints = new Map<string, {
    readonly connectionEdge: ConnectionEdge;
    readonly routingHint: RoutingHint;
    readonly overflowElbow?: Vec2;
  }>();
  /** Where a label is being dragged to. Held here rather than in the document, so a drag costs one
   *  undo step on release rather than one per pixel. */
  #placementPreview: { readonly id: string; readonly position: Vec2 } | undefined;
  /** An arrow being dragged, in screen coordinates — where it points in the model is not known
   *  until the host is asked on release. */
  #anchorPreview: { readonly id: string; readonly legId: string; readonly at: Vec2 } | undefined;
  /** A leader being reshaped, as the drag would leave it. */
  #routePreview: { readonly id: string; readonly legId: string; readonly route: LegRoute } | undefined;
  /** A region being edited, already converted onto its own plane — a region drag never leaves the
   *  surface it is drawn on. */
  #regionPreview: {
    readonly id: string;
    readonly legId: string;
    readonly anchor: MarkupRegionAnchor;
  } | undefined;
  /** A stroke being edited, likewise already on its own plane. */
  #inkPreview: { readonly id: string; readonly ink: InkAnnotation } | undefined;
  /** False when the host draws its own handles, which also stops ViewLeader hit-testing them —
   *  otherwise the opt-out would only be cosmetic. */
  readonly #handlesEnabled: boolean;
  /** Which unreadable style fields have already been reported per annotation, so the same warning
   *  is not repeated on every frame. */
  #reportedStyleDrops = new Map<string, string>();
  /** The host's snapping rule, if it supplied one. */
  readonly #snap: ((proposed: Vec2, ctx: SnapContext) => Vec2) | undefined;
  /** The built-in definitions in this instance's colour scheme. Same ids, different colours. */
  readonly #fallbackStyle: RenderStyle;
  readonly #builtIns: readonly TypedDefinition[];
  /** The global size factor applied to every annotation. */
  #annotationScale = 1;

  public constructor(options: RuntimeOptions) {
    this.#handlesEnabled = options.handles !== 'none';
    this.#fallbackStyle = defaultRenderStyle(options.theme);
    this.#snap = options.strategies?.snap;
    this.#builtIns = builtInDefinitions(options.theme);
    this.#document = options.document;
    this.#extensions = options.extensions;
    this.#window = options.boundary.ownerDocument.defaultView;
    let host: HostIntegration | undefined;
    let images: ImageResolutionManager | undefined;
    let tagText: TagTextResolutionManager | undefined;
    let occlusion: OcclusionManager | undefined;
    let overlay: SvgOverlay | undefined;
    const existingOverlays = new Set(
      options.boundary.querySelectorAll('[data-viewleader-overlay]'),
    );
    try {
      host = new HostIntegration(
        options.adapters,
        () => this.invalidate(),
        (diagnostic) => this.#publishDiagnostic(diagnostic),
      );
      images = new ImageResolutionManager(
        options.adapters.images === undefined ? undefined : imagePortFromAdapter(options.adapters.images),
        {
          invalidate: () => this.invalidate(),
          diagnostic: (error) => this.#publishDiagnostic({
            code: 'IMAGE_RESOLUTION_FAILED',
            severity: 'warning',
            message: error.message,
            error,
          }),
        },
      );
      tagText = new TagTextResolutionManager(options.adapters.tagText, {
        invalidate: () => this.invalidate(),
        diagnostic: (diagnostic) => this.#publishDiagnostic(diagnostic),
      });
      occlusion = new OcclusionManager(
        options.adapters.occlusion === undefined
          ? undefined
          : occlusionPortFromAdapter(options.adapters.occlusion),
        {
          invalidate: () => this.invalidate(),
          diagnostic: (error) => this.#publishDiagnostic({
            code: 'OCCLUSION_FAILED',
            severity: 'warning',
            message: error.message,
            error,
          }),
        },
      );
      overlay = new SvgOverlay({
        boundary: options.boundary,
        // A plain click clears everything else, ink included. Annotations and ink are stored
        // separately but there is only one selection as far as the person clicking is concerned.
        select: (id, toggle) => {
          if (!toggle) this.clearInkSelection();
          if (toggle) this.toggleSelection(id); else this.select([id]);
        },
        selectInk: (id, toggle) => {
          if (!toggle) this.clearSelection();
          this.selectInk(id, toggle);
        },
        hover: (id) => this.setHovered(id),
        handles: this.#handlesEnabled,
        ...(options.theme === undefined ? {} : { theme: options.theme }),
      });
    } catch (error) {
      const cleanupErrors = runCleanupSteps([
        () => overlay?.dispose(),
        () => {
          for (const element of options.boundary.querySelectorAll('[data-viewleader-overlay]')) {
            if (!existingOverlays.has(element)) element.remove();
          }
        },
        () => occlusion?.dispose(),
        () => tagText?.dispose(),
        () => images?.dispose(),
        () => host?.dispose(),
      ]);
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'ViewLeader runtime construction failed during cleanup');
      }
      throw error;
    }
    this.#host = host;
    this.#images = images;
    this.#tagText = tagText;
    this.#hasOcclusion = options.adapters.occlusion !== undefined;
    this.#occlusion = occlusion;
    this.#overlay = overlay;
    try {
      this.#host.sync(this.#document.document);
      const onResize = (): void => this.invalidate();
      this.#window?.addEventListener('resize', onResize);
      if (this.#window !== null) {
        this.#cleanup.push(() => this.#window?.removeEventListener('resize', onResize));
      }
      // Wheel forwarding. Anything in the overlay that takes pointer events — a label's hit pad —
      // swallows the wheel, and the canvas below never hears it, so zoom dies over every label.
      // Duck-typed like `isPointerEvent` (src/pointer.ts): synthesised events from another realm
      // are something this codebase already produces. The boundary's own `defaultView` is read
      // here because `Window` has no `WheelEvent` member, so `this.#window.WheelEvent` will not
      // compile.
      const forwardTo = options.forwardWheelTo;
      const view = options.boundary.ownerDocument.defaultView;
      if (forwardTo !== undefined && view !== null) {
        const onWheel = (event: Event): void => {
          if (!('deltaY' in event)) return;
          // Already delivered on its own way up — the canvas is inside the boundary.
          if (event.composedPath().includes(forwardTo)) return;
          event.preventDefault();
          event.stopPropagation();
          forwardTo.dispatchEvent(new view.WheelEvent(event.type, event as WheelEvent));
        };
        options.boundary.addEventListener('wheel', onWheel, { passive: false });
        this.#cleanup.push(() => options.boundary.removeEventListener('wheel', onWheel));
      }
      const ResizeObserverConstructor = globalThis.ResizeObserver;
      if (ResizeObserverConstructor !== undefined) {
        const observer = new ResizeObserverConstructor(onResize);
        observer.observe(options.boundary);
        this.#cleanup.push(() => observer.disconnect());
      }
      this.#cleanup.push(watchFontLoading(options.boundary.ownerDocument, {
        loaded: (families) => this.#onFontsLoaded(families),
        // A font that failed to load leaves behind measurements taken against the substitute — and
        // the substitute is what will be drawn, so those measurements are correct. Reporting it is
        // the whole response; there is nothing to recalculate.
        failed: (families) => this.#publishDiagnostic({
          code: 'FONT_LOAD_FAILED',
          severity: 'warning',
          message: `Web font families failed to load; their fallback measurements were kept: ${families.join(', ')}`,
        }),
      }));
      this.update();
    } catch (error) {
      try {
        this.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'ViewLeader runtime initialization failed during cleanup');
      }
      throw error;
    }
  }

  public get overlay(): SVGSVGElement { return this.#overlay.element; }
  public get adapters(): HostAdapterBundle { return this.#host.adapters; }
  public get runtimeRevision(): number { return this.#runtimeRevision; }

  /**
   * Starts publishing document changes, once everything else has subscribed.
   *
   * Order matters: a host told about a change must find every capability already describing the new
   * document, not half of them still describing the old one.
   */
  public connectDocument(): void {
    if (this.#disposed || this.#documentConnected) return;
    this.#documentConnected = true;
    this.#cleanup.push(
      this.#document.subscribe((commit) => this.#onDocumentCommit(commit)),
    );
  }

  public annotationsSnapshot(): AnnotationsSnapshot {
    const annotations: AnnotationRuntimeSnapshot[] = this.#document.document.annotations.map((annotation) => {
      const resolved = annotation.anchors.map((leg) => this.#host.resolved(annotation.id, leg));
      return Object.freeze({
        ...annotation,
        anchorStatuses: Object.freeze(resolved.map(({ status }) => status)),
        resolvedWorldPoints: Object.freeze(resolved.map(({ worldPoint }) => worldPoint)),
      });
    });
    return Object.freeze({
      runtimeRevision: this.#runtimeRevision,
      documentRevision: this.#document.documentRevision,
      annotations: Object.freeze(annotations),
      selectedIds: Object.freeze([...this.#selected].sort()),
      hoveredId: this.#hoveredId,
    });
  }

  public documentsSnapshot(): DocumentsSnapshot {
    return Object.freeze({
      runtimeRevision: this.#runtimeRevision,
      documentRevision: this.#document.documentRevision,
      document: this.#document.document,
    });
  }

  public historySnapshot(): HistorySnapshot {
    return this.#document.historySnapshot(this.#runtimeRevision);
  }

  public subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public subscribeDiagnostics(listener: (diagnostic: Diagnostic) => void): Unsubscribe {
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  }

  public diagnosticsSnapshot(): readonly Diagnostic[] {
    return Object.freeze([...this.#diagnostics]);
  }

  /** Where an annotation is on screen, as of the last frame. Nothing if it is off screen. */
  public geometryOf(id: string): AnnotationScreenGeometry | undefined {
    return annotationScreenGeometry(this.#lastPlan, id);
  }

  /** Where a stroke is on screen, as of the last frame. Every point is a handle. */
  public geometryOfInk(id: string): InkScreenGeometry | undefined {
    return inkScreenGeometry(this.#lastInk, id);
  }

  /**
   * Grades the last drawn frame against the four drafting rules.
   *
   * Done here rather than left to the host because two of the three things it needs are only known
   * here: the size factor in force, and the exact text proportions used to draw. A host doing this
   * itself would be grading against a guess.
   *
   * Measured per leader rather than per annotation, since crossings are a property of individual
   * lines — a note with two leaders both crossing the same neighbour is two faults, not one.
   */
  public lintFrame(options: FrameLintOptions): readonly LintFinding[] {
    const polylines: LintPolyline[] = [];
    for (const entry of this.#lastPlan) {
      const geometry = annotationScreenGeometry(this.#lastPlan, entry.annotation.id);
      if (geometry === undefined) continue;
      for (const [index, leg] of entry.legs.entries()) {
        const points = geometry.legs[index];
        if (points === undefined || points.length < 2) continue;
        // One entry per piece actually drawn. A leader with a gap in it genuinely does not pass
        // through the label it is gapped under, and grading the unbroken line would report a fault
        // nobody can see.
        const pieces = breakAroundObstacles(points, leg.obstacles ?? []);
        for (const [pieceIndex, piece] of pieces.entries()) {
        if (piece.length < 2) continue;
        polylines.push({
          annotationId: entry.annotation.id,
          legId: leg.id,
          points: piece,
          ...(pieceIndex === 0 ? {} : { continuation: true }),
          label: geometry.label,
          fontSize: geometry.text.fontSize,
          capHeightRatio: CAP_RATIO,
          // The size given here is the size as drawn, which already includes the global scale
          // factor. Applying the factor a second time would double it and let text half the legal
          // minimum pass the check.
          annotationScale: 1,
        });
        }
      }
    }
    return lintFrame(polylines, {
      pixelsPerMillimetre: options.pixelsPerMillimetre,
      minimumTextHeightMm: options.minimumTextHeightMm ?? ISO_3098_MINIMUM_TEXT_HEIGHT_MM,
      angleToleranceDegrees: options.angleToleranceDegrees ?? DEFAULT_ANGLE_TOLERANCE_DEGREES,
      ...(options.skip === undefined ? {} : { skip: options.skip }),
    });
  }

  public hitTest(at: Vec2, tolerance: number): ScreenHit | undefined {
    // When the host draws its own handles, a press where a handle would have been has to reach
    // whatever is underneath — otherwise the opt-out is cosmetic and the invisible handles still
    // swallow clicks. Ink is asked second because it is drawn first, underneath annotations.
    return this.#handlesEnabled
      ? hitTestPlan(this.#lastPlan, at, tolerance, this.#selected)
        ?? hitTestInkPlan(this.#lastInk, at, tolerance, this.#selectedInk)
      : hitTestPlan(this.#lastPlan, at, tolerance) ?? hitTestInkPlan(this.#lastInk, at, tolerance);
  }

  /**
   * Where a world point lands on screen, whether or not it is actually in view.
   *
   * Visibility decides what gets drawn; this is asking about the mapping itself. A point just off
   * screen still says something true about the surface its on-screen neighbours sit on.
   */
  public projectWorld(point: Vec3): Vec2 | undefined {
    return this.#host.project(point, this.#host.viewport)?.point;
  }

  /** The viewport this frame's coordinates are measured against. */
  public get viewport(): ViewportSnapshot { return this.#host.viewport; }

  /**
   * Draws an annotation somewhere without writing it there.
   *
   * This is what makes a drag smooth and cancelling free: the document is never touched, so there
   * is nothing to restore and no undo step to remove.
   */
  /**
   * Draws a leader pointing at a screen position without writing it there.
   *
   * A screen position rather than a place in the model, because the pointer has no place in the
   * model until the host is asked on release.
   */
  public setAnchorPreview(
    preview: { readonly id: string; readonly legId: string; readonly at: Vec2 } | null,
  ): void {
    const next = preview === null
      ? undefined
      : { id: preview.id, legId: preview.legId, at: { ...preview.at } };
    if (next === undefined && this.#anchorPreview === undefined) return;
    this.#anchorPreview = next;
    this.#publishRuntimeChange(true);
  }

  /** Draws a leader as a drag would leave it, without writing it. */
  public setRoutePreview(
    preview: { readonly id: string; readonly legId: string; readonly route: LegRoute } | null,
  ): void {
    const next = preview === null ? undefined : { ...preview };
    if (next === undefined && this.#routePreview === undefined) return;
    this.#routePreview = next;
    this.#publishRuntimeChange(true);
  }

  /**
   * Draws a region as a drag would leave it, without writing it.
   *
   * Given in the region's own plane rather than in screen coordinates, because a region lies flat on
   * a surface — a screen-space preview would skew the moment the camera moved.
   */
  public setRegionPreview(
    preview: { readonly id: string; readonly legId: string; readonly anchor: MarkupRegionAnchor } | null,
  ): void {
    const next = preview === null ? undefined : { ...preview };
    if (next === undefined && this.#regionPreview === undefined) return;
    this.#regionPreview = next;
    this.#publishRuntimeChange(true);
  }

  /** Draws a stroke as a drag would leave it, likewise on its own plane. */
  public setInkPreview(preview: { readonly id: string; readonly ink: InkAnnotation } | null): void {
    const next = preview === null ? undefined : { ...preview };
    if (next === undefined && this.#inkPreview === undefined) return;
    this.#inkPreview = next;
    this.#publishRuntimeChange(true);
  }

  public setPlacementPreview(preview: { readonly id: string; readonly position: Vec2 } | null): void {
    const next = preview === null ? undefined : { id: preview.id, position: { ...preview.position } };
    if (next === undefined && this.#placementPreview === undefined) return;
    this.#placementPreview = next;
    this.#publishRuntimeChange(true);
  }

  /**
   * Draws the selection rectangle, or clears it with `null`. Part of the interface rather than the
   * drawing, and already in screen coordinates, so it needs no layout pass.
   */
  public setMarqueePreview(rect: Rect | null): void {
    this.#overlay.setMarquee(rect);
  }

  /**
   * Asks the host's snapping rule where a label should go, safely.
   *
   * Everything handed to it is a frozen copy, so writing to it cannot move the layout. A rule that
   * throws, or answers with nonsense, is ignored and the original position used. One bug in a host's
   * snapping rule must not blank the overlay.
   */
  public applySnap(proposed: Vec2, ctx: SnapContext): Vec2 {
    const snap = this.#snap;
    if (snap === undefined) return proposed;
    const safeCtx: SnapContext = Object.freeze({
      id: ctx.id,
      labelSize: Object.freeze({ width: ctx.labelSize.width, height: ctx.labelSize.height }),
      anchor: Object.freeze({ x: ctx.anchor.x, y: ctx.anchor.y }),
    });
    let result: Vec2;
    try {
      result = snap(Object.freeze({ x: proposed.x, y: proposed.y }), safeCtx);
    } catch (cause) {
      this.#publishDiagnostic({
        code: 'SNAP_STRATEGY_FAILED',
        severity: 'warning',
        message: new AdapterError('snap strategy', cause).message,
        annotationId: ctx.id,
      });
      return proposed;
    }
    if (!isFiniteVec2(result)) {
      this.#publishDiagnostic({
        code: 'SNAP_STRATEGY_FAILED',
        severity: 'warning',
        message: 'Snap strategy returned a non-finite point; the unsnapped position was used instead',
        annotationId: ctx.id,
      });
      return proposed;
    }
    // Copied out. The host's own object is never kept, so it cannot change the layout later by
    // modifying what it handed back.
    return { x: result.x, y: result.y };
  }

  public select(ids: readonly string[]): void {
    const next = new Set(ids);
    if (sameSet(this.#selected, next)) return;
    this.#selected.clear();
    for (const id of next) this.#selected.add(id);
    this.#overlay.setSelection(this.#selected);
    this.#publishRuntimeChange(false);
  }

  /** Selects a stroke, which is what makes its points visible and draggable. */
  public selectInk(id: string, toggle = false): void {
    if (toggle && this.#selectedInk.has(id)) this.#selectedInk.delete(id);
    else {
      if (!toggle) this.#selectedInk.clear();
      this.#selectedInk.add(id);
    }
    this.#overlay.setInkSelection(this.#selectedInk);
    this.#publishRuntimeChange(false);
  }

  public clearInkSelection(): void {
    if (this.#selectedInk.size === 0) return;
    this.#selectedInk.clear();
    this.#overlay.setInkSelection(this.#selectedInk);
    this.#publishRuntimeChange(false);
  }

  public toggleSelection(id: string): void {
    if (this.#selected.has(id)) this.#selected.delete(id);
    else this.#selected.add(id);
    this.#overlay.setSelection(this.#selected);
    this.#publishRuntimeChange(false);
  }

  public deselect(id: string): void {
    if (!this.#selected.delete(id)) return;
    this.#overlay.setSelection(this.#selected);
    this.#publishRuntimeChange(false);
  }

  public clearSelection(): void {
    if (this.#selected.size === 0) return;
    this.#selected.clear();
    this.#overlay.setSelection(this.#selected);
    this.#publishRuntimeChange(false);
  }

  public captureAnnotationView(): AnnotationViewRuntimeState {
    return Object.freeze({
      ...(this.#activeViewId === undefined ? {} : { activeViewId: this.#activeViewId }),
      overrides: freezeOverrides(this.#activeViewOverrides),
    });
  }

  public applyAnnotationView(
    activeViewId: string | undefined,
    overrides: SavedViewAnnotationOverrides,
    publish = true,
  ): void {
    if (this.#disposed) return;
    this.#activeViewId = activeViewId;
    this.#activeViewOverrides = freezeOverrides(overrides);
    if (publish) this.#publishRuntimeChange(true);
  }

  public setHovered(id: string | null): void {
    if (this.#hoveredId === id) return;
    this.#hoveredId = id;
    this.#publishRuntimeChange(false);
  }

  public invalidate(): void {
    if (this.#disposed) return;
    this.#publishRuntimeChange(true);
  }

  /** The drawn framing rectangle, if any. Saved with the document, because someone drew it. */
  public get layoutFrame(): OrganizationRect | null {
    return this.#document.document.layoutFrame ?? null;
  }

  /**
   * Sets the framing rectangle labels are kept outside of, or clears it with `null` to fall back to
   * the model's own outline.
   *
   * An edit to the document rather than a viewer setting, because someone drew it: it undoes, it
   * saves, and it comes back on reload. Treating it as a setting would lose authored work and
   * silently rearrange every label on the drawing.
   */
  public setLayoutFrame(frame: OrganizationRect | null): void {
    if (this.#disposed) return;
    this.#document.edit(frame === null ? 'Clear layout frame' : 'Set layout frame', (document) => {
      if (frame === null) {
        const { layoutFrame: _dropped, ...rest } = document;
        return { document: rest, result: undefined };
      }
      return { document: { ...document, layoutFrame: frame }, result: undefined };
    });
  }

  public get routingMode(): 'as-authored' | 'auto' { return this.#routingMode; }

  /** Sets how leader lines are shaped. Nonsense is ignored rather than thrown — it only affects looks. */
  public setRoutingMode(mode: 'as-authored' | 'auto'): void {
    if (this.#disposed || (mode !== 'as-authored' && mode !== 'auto')) return;
    if (this.#routingMode === mode) return;
    this.#routingMode = mode;
    this.invalidate();
  }

  /**
   * Switches crowded drawings to right-angled leaders.
   *
   * Only leaders that route themselves are affected. A hand-drawn one is the drafter's own line, and
   * the other automatic shapes already say exactly what they want.
   */
  #resolveRouteMode<Route extends { mode: string }>(route: Route, annotationCount: number): Route {
    if (this.#routingMode !== 'auto' || route.mode !== 'dogleg') return route;
    if (annotationCount < CROWDED_ANNOTATION_COUNT) return route;
    return { ...route, mode: 'orthogonal' } as Route;
  }

  public get placementMode(): PlacementMode { return this.#placementMode; }

  /** Sets how labels are arranged. Nonsense is ignored rather than thrown — it only affects looks. */
  public setPlacementMode(mode: PlacementMode): void {
    if (this.#disposed || !PLACEMENT_MODES.includes(mode)) return;
    if (this.#placementMode === mode) return;
    this.#placementMode = mode;
    this.invalidate();
  }

  public get viewportInsets(): ViewportInsets | undefined { return this.#viewportInsets; }

  /**
   * Reserves areas of the screen for the host's own interface. Labels are arranged inside what is
   * left, and kept there when they are pushed apart.
   *
   * A nonsensical value rejects the whole call rather than applying some edges and not others, since
   * a partly applied claim is impossible to reason about from the outside.
   */
  public setViewportInsets(insets: ViewportInsets | null): void {
    if (this.#disposed) return;
    if (insets !== null && !([insets.top, insets.right, insets.bottom, insets.left]
      .every((edge) => Number.isFinite(edge) && edge >= 0))) return;
    this.#viewportInsets = insets === null ? undefined : { ...insets };
    this.invalidate();
  }

  /** The size factor currently in force. */
  public get annotationScale(): number { return this.#annotationScale; }

  /**
   * Scales every annotation together — text, pen weights, tails, padding, arrowheads and boxes.
   *
   * **This is about printing, not about readability, and the two get confused.** Annotations already
   * hold their size on screen: they are drawn in screen pixels, so pulling the camera back never
   * shrinks them. Reach for this when the same drawing is plotted at a different scale and every
   * annotation has to come out physically larger on the sheet.
   *
   * Deliberately not done by scaling the label in SVG. That would grow the text and its box while
   * leaving every line width and every arrowhead behind, because those are drawn outside the label
   * entirely. An arrowhead that scales while its leader does not is worse than neither scaling.
   *
   * A viewer setting, never part of the document: two drafters plotting one file at different
   * scales must not overwrite each other.
   */
  public setAnnotationScale(scale: number): void {
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
      throw new InvalidInputError('Annotation scale must be a finite positive number', { scale });
    }
    if (this.#disposed || scale === this.#annotationScale) return;
    this.#annotationScale = scale;
    // Nothing to clear. The layout cache is keyed on the final sizes, which this factor changes,
    // so a scale change misses it automatically; and text is always measured at one fixed size the
    // factor never touches. Asking for a redraw is the whole response, and it collapses into a
    // single re-layout however many annotations there are.
    this.invalidate();
  }

  /**
   * The placement a label drag should store: the drop point plus the anchor it was measured
   * against, so the label follows the camera. Degrades to a bare pin if the annotation was not
   * placed this frame.
   */
  public placementAt(id: string, position: Vec2): AnnotationPlacement {
    const anchor = this.#anchorOrigins.get(id);
    return { kind: 'manual', position, ...(anchor === undefined ? {} : { anchor }) };
  }

  /**
   * Arranges the automatically placed labels around the frame. Labels the user positioned by hand,
   * or a saved view pinned, keep exactly where they are — a hand-placed label that recorded its
   * anchor keeps its distance from that anchor rather than its screen coordinates.
   */
  #placeAroundFrame(
    inputs: readonly PlacementInput[],
    frame: Bounds2,
    viewport: ScreenBounds,
  ): Map<string, ScreenBounds> {
    const byPlacement = new Map<string, ScreenBounds>();
    const automatic: Array<{ id: string; screenPos: Vec2 }> = [];
    const labelDims = new Map<string, { width: number; height: number }>();
    const anchorsById = new Map<string, Vec2>();
    this.#anchorOrigins.clear();

    for (const input of inputs) {
      const { width, height } = input.labelSize;
      const anchors = input.projectedAnchors.filter(
        (anchor) => Number.isFinite(anchor.x) && Number.isFinite(anchor.y),
      );
      // Computed for every placement kind, not just the automatic ones, and from the same anchors
      // the automatic path rails from — so a label switching between the two does not jump.
      //
      // The centroid, not the first leg: it is the only reference point that already exists, and
      // "first leg" would move the whole label the moment leg 1 left the frustum.
      //
      // ponytail: on a multi-leg annotation the origin still steps when one of its *own* legs
      // leaves the frustum. That is not a no-swim violation — the invariant is about unrelated
      // annotations, and the automatic path has behaved this way since day one. Upgrade path, if
      // it ever bites: remember the last full-anchor-set centroid per annotation the way
      // `#previousSectors` remembers sides.
      const origin = anchors.length === 0 ? undefined : centroid(anchors);
      if (origin !== undefined) this.#anchorOrigins.set(input.id, origin);
      if (input.placement.kind === 'manual') {
        const stored = input.placement;
        // An anchor recorded at drop time turns the stored point into an offset from what the
        // label points at. With no anchor stored, or nothing on screen to measure against, the
        // stored point is used as written — which is both the old behaviour and the right
        // fallback, since it is where the user actually dropped it.
        const base = stored.anchor === undefined || origin === undefined
          ? stored.position
          : {
            x: stored.position.x + origin.x - stored.anchor.x,
            y: stored.position.y + origin.y - stored.anchor.y,
          };
        byPlacement.set(input.id, { x: base.x, y: base.y, width, height });
        continue;
      }
      if (origin === undefined) continue;
      automatic.push({ id: input.id, screenPos: origin });
      labelDims.set(input.id, { width, height });
      anchorsById.set(input.id, origin);
    }

    if (automatic.length === 0) {
      this.#previousSectors.clear();
      return byPlacement;
    }

    const results = this.#labelPlacer.computePlacements(
      automatic,
      frame,
      { x: viewport.width, y: viewport.height },
      labelDims,
      this.#viewportInsets,
      this.#previousSectors,
      this.#placementMode,
    );
    uncrossLeaderSlots(results, anchorsById, labelDims);
    // Deliberately kept rather than cleared each frame.
    //
    // An annotation that goes off screen never reaches the arrangement, so wiping this would throw
    // away the memory of which side it was on. Coming back into view it would have nothing to be
    // reluctant about and would pick a side afresh — landing on the far side of the drawing while
    // its target had barely crossed the middle. That is exactly the swimming this prevents.
    for (const result of results) {
      this.#previousSectors.set(result.annotationId, result.sector);
      const dims = labelDims.get(result.annotationId)!;
      byPlacement.set(result.annotationId, {
        x: result.position.x,
        y: result.position.y,
        width: dims.width,
        height: dims.height,
      });
      // The arrangement knows which edge of each label faces the model and whether it was pushed
      // out of its column. Keeping that beats working it out again later from the label alone,
      // which knows nothing about columns and gets it wrong the moment a label is nudged past its
      // own target.
      this.#placerHints.set(result.annotationId, {
        connectionEdge: result.connectionEdge,
        routingHint: result.routingHint,
        ...(result.overflowElbow === undefined ? {} : { overflowElbow: result.overflowElbow }),
      });
    }
    return byPlacement;
  }

  /**
   * The one automatic-placement call site for `strategies.snap`, run after `byPlacement` is chosen
   * and after separation, so a host's snap is the last word on where a label sits. Only
   * automatically-placed labels are offered: a manual
   * placement is what the user (or a prior, already-snapped drag) asked for, not layout's proposal.
   *
   * Which means a snapped drag lands on the host's grid and then drifts off it as the camera
   * moves, because the drop is stored relative to its anchor. Deliberate: re-snapping every frame
   * would let the label jump between grid cells while the user is only orbiting. Revisit if a host
   * with a real grid asks for it.
   * Mutates `placement` in place and also returns it, so the snapped bounds are what `update()` both
   * routes legs from and remembers in `#previousPlacement` — hysteresis must remember the snapped
   * point, or a snapping host would see the label swim between the raw and the snapped position.
   */
  #applyLayoutSnap(
    placement: Map<string, ScreenBounds>,
    inputs: readonly PlacementInput[],
  ): Map<string, ScreenBounds> {
    if (this.#snap === undefined) return placement;
    const inputsById = new Map(inputs.map((input) => [input.id, input] as const));
    for (const [id, bounds] of placement) {
      const input = inputsById.get(id);
      if (input === undefined || input.placement.kind !== 'automatic') continue;
      const anchors = input.projectedAnchors.filter(
        (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
      );
      if (anchors.length === 0) continue;
      const snapped = this.applySnap(
        { x: bounds.x, y: bounds.y },
        { id, labelSize: { width: bounds.width, height: bounds.height }, anchor: centroid(anchors) },
      );
      placement.set(id, { x: snapped.x, y: snapped.y, width: bounds.width, height: bounds.height });
    }
    return placement;
  }

  /**
   * Pushes overlapping labels apart. One stage, whichever way the labels were arranged, so there is
   * a single answer to "do these overlap?".
   *
   * Runs *before* the host's snapping rule, not after. The other order was tried first, reasoning
   * that not overlapping is a correctness property and ought to win. It should not: the hook exists
   * so a host can overrule the layout, and a stage that then overrules the host makes that promise
   * meaningless. A host that snaps every label onto one point gets overlapping labels, and that is
   * its decision to make.
   *
   * Two different things make a label immovable. A manual placement is a *position* the user chose.
   * Locking is *permission* the user withdrew — such a label still follows its target, but nothing
   * may nudge it aside. Either way, neighbours move out of the way instead.
   */
  #separate(
    placement: Map<string, ScreenBounds>,
    inputs: readonly PlacementInput[],
    viewport: ScreenBounds,
  ): void {
    if (placement.size < 2) return;
    const immovable = new Set(
      inputs
        .filter((input) => input.placement.kind !== 'automatic' || input.locked)
        .map((input) => input.id),
    );
    const separated = separateLabels(
      [...placement].map(([id, bounds]) => ({
        id,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        ...(immovable.has(id) ? { immovable: true } : {}),
      })),
      {
        viewport: { width: viewport.width, height: viewport.height },
        ...(this.#viewportInsets === undefined ? {} : { insets: this.#viewportInsets }),
      },
    );
    for (const label of separated) {
      placement.set(label.id, { x: label.x, y: label.y, width: label.width, height: label.height });
    }
  }

  /**
   * Forgets remembered positions for annotations that have been deleted.
   *
   * That memory deliberately survives frames where an annotation was off screen, so a note that dips
   * behind the camera returns where it left. Which means it cannot simply be rebuilt each frame, and
   * without this it would grow for the whole session.
   *
   * Only run when the document actually changes, since that is the only way an annotation can stop
   * existing.
   */
  #forgetDeletedAnnotations(): void {
    const revision = this.#document.documentRevision;
    if (revision === this.#layoutMemoryRevision) return;
    this.#layoutMemoryRevision = revision;
    const live = new Set(this.#document.document.annotations.map((annotation) => annotation.id));
    for (const id of this.#previousSectors.keys()) if (!live.has(id)) this.#previousSectors.delete(id);
    for (const id of this.#previousPlacement.keys()) if (!live.has(id)) this.#previousPlacement.delete(id);
  }

  public publishTransientChange(render = false): void { this.#publishRuntimeChange(render); }
  public publishExternalDiagnostic(diagnostic: Diagnostic): void { this.#publishDiagnostic(diagnostic); }
  public setPluginAuthoringPreview(preview: readonly DeclarativePrimitive[]): void {
    if (this.#disposed) return;
    this.#pluginAuthoringPreview = Object.freeze(structuredClone(preview));
  }

  public update(): void {
    if (this.#disposed) return;
    const projectionRevision = this.#host.projectionRevision;
    if (!this.#renderInvalidated
      && projectionRevision !== undefined
      && Object.is(projectionRevision, this.#lastProjectionRevision)) return;
    const viewport = this.#host.viewport;
    const viewportBounds = { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const candidates: LayoutCandidate[] = [];
    const nextImageOwners = new Set<string>();
    const document = this.#document.document;
    // Counted from the document rather than from what happens to be on screen, so leaders do not
    // change shape as annotations drift in and out of view during an orbit. That would be the worst
    // kind of swimming: the drawing convention itself flickering.
    const candidateCount = document.annotations.length;
    const customDefinitions = definitionsFromCollections(document.definitions);

    for (const annotation of document.annotations) {
      const viewOverride = this.#activeViewOverrides[annotation.id];
      if (viewOverride?.visible === false) continue;
      // Two layers of overrides, either of which may set part of a nested group, so they are
      // merged one level deep. A plain top-level merge would let a saved view setting one field
      // wipe out the annotation's own settings beside it.
      const dropped: string[] = [];
      const styleOverride = mergeStyleOverride(
        readStyleOverride(annotation.styleOverride, dropped),
        viewOverride?.style ?? {},
      );
      this.#reportDroppedStyleFields(annotation.id, dropped);
      let plannedAnnotation = annotation;
      if (viewOverride?.style !== undefined) {
        deepFreeze(styleOverride);
        plannedAnnotation = Object.freeze({
          ...annotation,
          styleOverride: styleOverride as unknown as JsonObject,
        });
      }
      const style = resolveStyleById(
        plannedAnnotation.styleId, customDefinitions, this.#builtIns, this.#fallbackStyle,
        styleOverride, this.#annotationScale,
      );
      let layout: RenderableContentLayout | undefined;
      try {
        layout = plannedAnnotation.content.kind.startsWith('plugin:')
          ? this.#layoutPlugin(plannedAnnotation.id, plannedAnnotation.content as PluginContent, nextImageOwners)
          : this.#layoutBuiltInCached(
              plannedAnnotation.id,
              // A tag is measured from the text looked up from the model, not from the fallback
              // stored in the document. That is all the re-measuring takes: the layout cache is
              // keyed on the content, so a value arriving late simply misses the cache and is laid
              // out again at its true width.
              this.#tagText.apply(plannedAnnotation.id, plannedAnnotation.content as BuiltInContent),
              style,
              nextImageOwners,
            );
      } catch (cause) {
        this.#publishDiagnostic({
          code: 'CONTENT_RENDER_FAILED',
          severity: 'warning',
          message: cause instanceof Error ? cause.message : 'Annotation content could not be rendered',
          annotationId: annotation.id,
        });
      }
      if (layout === undefined) continue;
      const anchorPreview = this.#anchorPreview?.id === annotation.id ? this.#anchorPreview : undefined;
      const routePreview = this.#routePreview?.id === annotation.id ? this.#routePreview : undefined;
      const regionPreview = this.#regionPreview?.id === annotation.id ? this.#regionPreview : undefined;
      const legs = plannedAnnotation.anchors.flatMap((leg): ProjectedLeg[] => {
        const resolved = this.#host.resolved(annotation.id, leg);
        const route = routePreview?.legId === leg.id
          ? routePreview.route
          : this.#resolveRouteMode(legRouteFromCore(leg.routing), candidateCount);
        if (leg.anchor.kind === 'region') {
          // A drag in progress wins over what is stored, exactly as a label preview does.
          const anchor = regionPreview?.legId === leg.id
            ? regionPreview.anchor
            : regionAnchorFromCore(leg.anchor);
          // Whether any of the outline is actually on screen, collected as it was projected. The
          // projection itself is deliberately not told about visibility, so that being off screen
          // and being un-drawable stay separate questions.
          const anyVisible = { value: false };
          const region = projectRegion(anchor, (worldPoint) =>
            outlineProjection(this.#host, worldPoint, viewport, anyVisible));
          if (region === undefined || !regionWorthDrawing(region.points, viewport, anyVisible.value)) return [];
          return [{
            id: leg.id,
            anchor: centroid(region.points),
            worldPoint: resolved.worldPoint,
            route,
            region,
          }];
        }
        // A handle being dragged overrides where the leader would otherwise point. Regions are
        // excluded, because their attachment point is worked out from the outline after the label
        // is placed, so an override here would be thrown away regardless.
        if (anchorPreview?.legId === leg.id) {
          return [{
            id: leg.id,
            anchor: anchorPreview.at,
            worldPoint: resolved.worldPoint,
            route,
          }];
        }
        const projected = this.#host.project(resolved.worldPoint, viewport);
        return projected === null || !projected.visible
          ? []
          : [{
              id: leg.id,
              anchor: projected.point,
              worldPoint: resolved.worldPoint,
              route,
            }];
      });
      if (legs.length > 0) candidates.push({ annotation: plannedAnnotation, layout, style, legs });
    }
    const pluginPreview = this.#pluginAuthoringPreview.map((primitive, index) =>
      this.#normalizePluginPrimitive(primitive, `plugin-preview:${index}`, nextImageOwners));

    for (const owner of this.#imageOwners) if (!nextImageOwners.has(owner)) this.#images.release(owner);
    this.#imageOwners = nextImageOwners;

    const placementInputs: PlacementInput[] = candidates.map((candidate) => {
      const override = this.#activeViewOverrides[candidate.annotation.id]?.placement;
      const preview = this.#placementPreview?.id === candidate.annotation.id
        ? this.#placementPreview
        : undefined;
      // A drag in progress beats both the saved position and any saved view's override. It is
      // where the user is pointing right now, and it only becomes one of the others on release.
      const placement = preview !== undefined
        ? { kind: 'manual' as const, position: preview.position }
        : override?.mode === 'manual'
          ? { kind: 'manual' as const, position: override.position! }
          : override?.mode === 'automatic'
            ? { kind: 'automatic' as const }
            : candidate.annotation.placement;
      return {
        id: candidate.annotation.id,
        projectedAnchors: candidate.legs.map(({ anchor }) => anchor),
        labelSize: candidate.layout.bounds,
        placement,
        ...(candidate.annotation.locked === true ? { locked: true } : {}),
      };
    });

    // These are true for exactly one frame. A stale one would land a leader on whichever edge the
    // label faced the last time the camera was somewhere else entirely.
    this.#placerHints.clear();
    // Keep labels outside the frame — a drawn rectangle if there is one, otherwise the model's
    // outline, otherwise the last outline that worked.
    const frame = resolveLayoutFrame({
      layoutFrame: this.#document.document.layoutFrame ?? null,
      worldBounds: this.#host.modelBounds() ?? null,
      project: (point) => this.#host.project(point, viewport)?.point ?? null,
      viewport: { width: viewport.width, height: viewport.height },
      memory: this.#boundaryMemory,
    });
    // One arrangement algorithm, always. With no rectangle drawn and no model outline available,
    // the annotations' own targets supply the frame rather than a second algorithm taking over.
    //
    // A second algorithm would mean that gaining or losing the model outline midway through an
    // orbit swapped algorithms and moved every label at once.
    const byPlacement = this.#placeAroundFrame(
      placementInputs,
      frame ?? anchorCloudFrame(placementInputs),
      viewportBounds,
    );
    this.#separate(byPlacement, placementInputs, viewportBounds);
    this.#applyLayoutSnap(byPlacement, placementInputs);
    for (const [id, bounds] of byPlacement) this.#previousPlacement.set(id, bounds);
    this.#forgetDeletedAnnotations();

    // Every other label is something the leaders must route around. Built once for the whole frame
    // and sliced per annotation, rather than rebuilt for each one.
    const placedBoxes = [...byPlacement].map(([id, box]) => ({ id, box }));
    const obstaclesFor = (id: string): readonly ScreenBounds[] => placedBoxes
      .filter((entry) => entry.id !== id)
      .map((entry) => entry.box);

    const routed: PlannedAnnotation[] = [];
    const candidatesForOcclusion: OcclusionCandidate[] = [];
    const policies = new Map<string, OcclusionPolicy>();
    for (const candidate of candidates) {
      const bounds = byPlacement.get(candidate.annotation.id);
      if (bounds === undefined) continue;
      const inputs: RouteLegInput[] = candidate.legs.map((leg) => ({
        id: leg.id,
        // Where a leader meets a region depends on where its label ended up, so it is worked out
        // here rather than earlier. Only the point is needed — the arrowhead takes its direction
        // from the line itself.
        anchor: leg.region === undefined ? leg.anchor : regionAttachment(leg.region, bounds).point,
        route: leg.route,
      }));
      const textLines = textLineOffsets(candidate.layout);
      const hint = this.#placerHints.get(candidate.annotation.id);
      const obstacles = obstaclesFor(candidate.annotation.id);
      const routes = routeLegs(inputs, bounds, {
        ...candidate.style.landing,
        ...(textLines === undefined ? {} : { textLines }),
        // Which edge the leader meets is taken from the arrangement, which knows what column or
        // row the label ended up in and therefore which of its faces looks at the model.
        //
        // Only ever replaces an automatic choice. A drafter who wrote `side: 'left'` meant it, and
        // the layout does not get to overrule them.
        ...(hint !== undefined && (candidate.style.landing?.side ?? 'auto') === 'auto'
          ? { side: hint.connectionEdge }
          : {}),
        ...(hint?.overflowElbow === undefined ? {} : { overflowElbow: hint.overflowElbow }),
      }, { obstacles });
      const routeById = new Map(routes.map((route) => [route.id, route.points]));
      const legs = candidate.legs.flatMap((leg) => {
        const points = routeById.get(leg.id);
        if (points === undefined) return [];
        return [{
          id: leg.id,
          points,
          ...(obstacles.length === 0 ? {} : { obstacles }),
          ...(leg.region === undefined ? {} : {
            region: leg.region,
            ...(leg.region.kind === 'revision-cloud'
              ? { cloudArcs: generateRevisionCloudArcs(leg.region.points, 12) }
              : {}),
          }),
        }];
      });
      const labelPosition = {
        x: bounds.x - candidate.layout.bounds.x,
        y: bounds.y - candidate.layout.bounds.y,
      };
      routed.push({
        annotation: candidate.annotation,
        labelPosition,
        layout: candidate.layout,
        legs,
        style: candidate.style,
        opacity: 1,
      });
      if (this.#hasOcclusion) {
        candidatesForOcclusion.push({
          id: candidate.annotation.id,
          routes: routes.map(({ points }) => points),
          samples: candidate.legs.map(({ id, worldPoint }) => ({ legId: id, worldPoint })),
        });
        policies.set(candidate.annotation.id, candidate.annotation.occlusion ?? 'keep');
      }
    }

    const visiblePlan = this.#hasOcclusion && candidatesForOcclusion.length > 0
      ? applyOcclusionPresentation(routed, this.#occlusion.present(candidatesForOcclusion, policies))
      : routed;
    this.#lastPlan = Object.freeze(visiblePlan);
    this.#lastInk = this.#planInk(viewport);
    this.#overlay.render(this.#lastPlan, this.#lastInk, viewport);
    this.#overlay.renderPluginPreview(pluginPreview);
    this.#lastProjectionRevision = projectionRevision;
    this.#renderInvalidated = false;
  }

  public start(): void {
    if (this.#selfDriven) return;
    this.#selfDriven = true;
    this.#scheduleFrame();
  }

  public stop(): void {
    if (!this.#selfDriven) return;
    this.#selfDriven = false;
    if (this.#animationFrame !== undefined && this.#window !== null) {
      this.#window.cancelAnimationFrame(this.#animationFrame);
      this.#animationFrame = undefined;
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const cleanupErrors = runCleanupSteps([
      () => this.stop(),
      ...this.#cleanup.splice(0).map((cleanup) => () => cleanup()),
      () => this.#tagText.dispose(),
      () => this.#images.dispose(),
      () => this.#occlusion.dispose(),
      () => this.#host.dispose(),
      () => this.#overlay.dispose(),
    ]);
    this.#listeners.clear();
    this.#diagnosticListeners.clear();
    this.#diagnostics.length = 0;
    this.#selected.clear();
    this.#placementPreview = undefined;
    this.#anchorPreview = undefined;
    this.#routePreview = undefined;
    this.#regionPreview = undefined;
    this.#inkPreview = undefined;
    this.#selectedInk.clear();
    this.#lastInk = Object.freeze([]);
    this.#previousPlacement.clear();
    this.#anchorOrigins.clear();
    this.#layoutCache.clear();
    this.#imageOwners.clear();
    this.#hoveredId = null;
    this.#activeViewId = undefined;
    this.#activeViewOverrides = Object.freeze({});
    this.#pluginAuthoringPreview = Object.freeze([]);
    this.#documentConnected = false;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'ViewLeader runtime disposal failed');
    }
  }

  #layoutBuiltIn(
    annotationId: string,
    content: BuiltInContent,
    style: RenderStyle,
    imageOwners: Set<string>,
  ): RenderableContentLayout {
    const box = style.contentBox;
    // An image with no size given by the author is laid out at its true size, so that has to be
    // read first. Image layouts are deliberately never cached, so the frame after one finishes
    // loading lays out again and picks up the real dimensions.
    const image = content.kind === 'host-image'
      ? this.#images.read(imageOwnerId(annotationId), content)
      : undefined;
    if (image !== undefined) imageOwners.add(imageOwnerId(annotationId));
    const layout = layoutBuiltInContent(content, {
      fontFamily: style.fontFamily,
      ...(box?.padding === undefined ? {} : { padding: box.padding }),
      ...(style.enclosure?.aspect === undefined ? {} : { aspect: style.enclosure.aspect }),
      ...(box?.align === undefined ? {} : { align: box.align }),
      ...(box?.weight === undefined ? {} : { weight: box.weight }),
      ...(image?.status === 'ready' ? { intrinsic: image.intrinsic } : {}),
    });
    const scale = content.kind === 'host-image' ? 1 : style.fontSize / DEFAULT_FONT_SIZE;
    const children = layout.primitives.map((primitive, index): RenderPrimitive => {
      if (primitive.kind === 'text') return {
        kind: 'text', bounds: primitive.bounds, zIndex: index,
        position: { x: primitive.x, y: primitive.baseline }, text: primitive.text,
        direction: primitive.direction, fontSize: DEFAULT_FONT_SIZE,
        bold: primitive.weight === 'bold', italic: false, code: false, align: primitive.align,
      };
      if (primitive.kind === 'path') {
        // The style's own shape replaces the plain box around a label. Everything else — a
        // callout's divider, for instance — keeps the stroke it was drawn with.
        //
        // A symbolic block is the exception: it looks like a box but is never replaced, because the
        // author asked for that particular shape by name.
        const enclosed = primitive.role === 'enclosure' && style.enclosure !== undefined;
        return {
          kind: 'path', bounds: primitive.bounds, zIndex: index,
          path: enclosed
            ? fitEnclosurePath(style.enclosure!, primitive.bounds, box?.borderRadius ?? 0)
            : primitive.path,
          fill: primitive.filled ? 'solid' : 'none',
          ...(primitive.role !== undefined && box !== undefined
            ? { paint: enclosurePaint(box, style) }
            : {}),
        };
      }
      // There is at most one image per label, and it was already looked up above.
      return {
        kind: 'image', bounds: primitive.bounds, zIndex: index,
        reference: primitive.reference, alt: primitive.alt,
        state: { ...image!, bounds: primitive.bounds },
      };
    });
    const bounds = scaleBounds(layout.bounds, scale);
    const primitives: readonly RenderPrimitive[] = scale === 1 ? children : [{
      kind: 'group', bounds, zIndex: 0, children, scale,
    } satisfies RenderGroupPrimitive];
    return { bounds, primitives, accessibleText: layout.accessibleText, direction: layout.direction };
  }

  #layoutBuiltInCached(
    annotationId: string,
    content: BuiltInContent,
    style: RenderStyle,
    imageOwners: Set<string>,
  ): RenderableContentLayout {
    if (content.kind === 'host-image') {
      return this.#layoutBuiltIn(annotationId, content, style, imageOwners);
    }
    const signature = `${JSON.stringify(content)};${style.lineColor};${style.lineWidth};${style.textColor};${style.fontFamily};${style.fontSize};${style.enclosure?.id ?? ''};${JSON.stringify(style.contentBox ?? null)}`;
    const cached = this.#layoutCache.get(annotationId);
    if (cached?.signature === signature) return cached.layout;
    const layout = this.#layoutBuiltIn(annotationId, content, style, imageOwners);
    this.#layoutCache.set(annotationId, { signature, layout });
    return layout;
  }

  /**
   * A web font has finished loading, so every label measured against the substitute font is now the
   * wrong size.
   *
   * One font costs one re-measure and one re-layout however many labels use it, because the redraw
   * that follows collapses into a single pass.
   *
   * The layout cache has to be cleared explicitly here. It is keyed on content and style, neither of
   * which changes when a font arrives, so without this every label would redraw at its old width —
   * which is precisely the bug this exists to fix.
   *
   * Whether a re-measured label then *moves* is decided elsewhere: one the user positioned stays
   * put, one placed automatically is worked out afresh at its new size.
   */
  #onFontsLoaded(families: readonly string[]): void {
    if (this.#disposed || families.length === 0) return;
    for (const family of families) invalidateTextMetrics(family);
    // ponytail: clears the whole layout cache rather than only the labels using this font. The
    // measurement cache underneath is still warm for every other font, so unaffected labels come
    // back identical and cannot move. Narrow it if a profile ever asks for it.
    this.#layoutCache.clear();
    this.invalidate();
  }

  #layoutPlugin(
    annotationId: string,
    content: PluginContent,
    imageOwners: Set<string>,
  ): RenderableContentLayout | undefined {
    const resolution = this.#extensions.prepare([{
      pluginId: content.pluginId,
      recordType: 'content',
      schemaVersion: content.schemaVersion,
      data: content.data,
    }]);
    const record = resolution.resolved[0];
    if (record === undefined) return undefined;
    const source = this.#extensions.render(record);
    const primitives = source.map((primitive, index) =>
      this.#normalizePluginPrimitive(primitive, `${annotationId}:plugin:${index}`, imageOwners));
    const bounds = unionBounds(source.map(({ bounds }) => bounds));
    return {
      bounds: bounds ?? { x: 0, y: 0, width: 24, height: 24 },
      primitives,
      accessibleText: primitiveLabels(source).join(' ') || content.pluginId,
      direction: 'auto',
    };
  }

  #normalizePluginPrimitive(
    primitive: DeclarativePrimitive,
    ownerId: string,
    imageOwners: Set<string>,
  ): RenderPrimitive {
    const base = {
      bounds: primitive.bounds,
      zIndex: primitive.zIndex,
      accessibility: primitive.accessibility,
    };
    if (primitive.kind === 'text') return {
      ...base, kind: 'text', position: primitive.position, text: primitive.text,
      direction: 'auto', fontSize: primitive.fontSize, bold: primitive.bold ?? false,
      italic: primitive.italic ?? false, code: primitive.code ?? false, align: 'start',
    };
    if (primitive.kind === 'path') return {
      ...base, kind: 'path', commands: primitive.commands, fill: primitive.fill,
    };
    if (primitive.kind === 'image') {
      imageOwners.add(ownerId);
      const state = this.#images.read(ownerId, {
        kind: 'host-image', reference: primitive.reference, alt: primitive.alt,
        width: primitive.bounds.width, height: primitive.bounds.height,
      });
      return { ...base, kind: 'image', reference: primitive.reference, alt: primitive.alt, state };
    }
    if (primitive.kind === 'group') return {
      ...base,
      kind: 'group',
      children: primitive.children.map((child, index) =>
        this.#normalizePluginPrimitive(child, `${ownerId}:${index}`, imageOwners)),
    };
    return {
      ...base,
      kind: 'hit-region',
      interactionId: primitive.interactionId,
      ...(primitive.cursor === undefined ? {} : { cursor: primitive.cursor }),
    };
  }

  #planInk(viewport: ViewportSnapshot): readonly PlannedInk[] {
    const customDefinitions = definitionsFromCollections(this.#document.document.definitions);
    return this.#document.document.ink.flatMap((value): PlannedInk[] => {
      try {
        const stored = inkFromJson(value);
        const ink = this.#inkPreview?.id === stored.id ? this.#inkPreview.ink : stored;
        const projected = projectInk(ink, (worldPoint) => visibleProjection(this.#host, worldPoint, viewport));
        if (projected === undefined || projected.points.length < 2) return [];
        return [{
          id: ink.id,
          points: projected.points,
          // Ink is scaled too — its line is a pen weight like any other.
          style: resolveStyleById(
            ink.styleId, customDefinitions, this.#builtIns, this.#fallbackStyle, {}, this.#annotationScale,
          ),
          accessibleText: `Freehand ink ${ink.id}`,
        }];
      } catch {
        return [];
      }
    });
  }

  #onDocumentCommit(commit: DocumentCommit): void {
    const ids = new Set(commit.document.annotations.map(({ id }) => id));
    for (const id of this.#layoutCache.keys()) if (!ids.has(id)) this.#layoutCache.delete(id);
    for (const id of this.#selected) if (!ids.has(id)) this.#selected.delete(id);
    const inkIds = new Set(commit.document.ink.map((value) => String(value.id)));
    for (const id of this.#selectedInk) if (!inkIds.has(id)) this.#selectedInk.delete(id);
    this.#overlay.setInkSelection(this.#selectedInk);
    if (this.#hoveredId !== null && !ids.has(this.#hoveredId)) this.#hoveredId = null;
    this.#images.releaseAllOwners();
    this.#imageOwners.clear();
    // Deleting an annotation cancels its pending tag lookup right here, as the change commits,
    // rather than on the next frame. An answer arriving for something the document no longer
    // contains must never be applied, whatever order things happen to complete in.
    this.#tagText.retainOwners(new Set(
      commit.document.annotations
        .filter(({ content }) => content.kind === 'tag' && content.reference !== undefined)
        .map(({ id }) => id),
    ));
    this.#occlusion.reset();
    this.#host.sync(commit.document, commit.kind === 'replacement');
    this.#overlay.setSelection(this.#selected);
    this.#publishRuntimeChange(true);
  }

  #publishRuntimeChange(render: boolean): void {
    if (this.#disposed) return;
    if (render) this.#renderInvalidated = true;
    this.#runtimeRevision += 1;
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* state observers cannot break the publisher */ }
    }
    if (render) this.#requestImmediateUpdate();
  }

  /**
   * Reports style fields that could not be read, once rather than once per frame.
   *
   * Redraws happen whenever the camera moves, so an unreadable style would otherwise report on every
   * single frame. Remembered per annotation, and forgotten again when the style becomes readable.
   */
  #reportDroppedStyleFields(annotationId: string, dropped: readonly string[]): void {
    const signature = dropped.join(', ');
    if (this.#reportedStyleDrops.get(annotationId) === signature) return;
    if (signature === '') {
      this.#reportedStyleDrops.delete(annotationId);
      return;
    }
    this.#reportedStyleDrops.set(annotationId, signature);
    this.#publishDiagnostic({
      code: 'STYLE_OVERRIDE_FIELD_IGNORED',
      severity: 'warning',
      message: `Style override fields this version does not understand were ignored: ${signature}`,
      annotationId,
    });
  }

  #publishDiagnostic(diagnostic: Diagnostic): void {
    if (this.#disposed) return;
    const immutable = Object.freeze({ ...diagnostic });
    this.#diagnostics.push(immutable);
    if (this.#diagnostics.length > MAX_RETAINED_DIAGNOSTICS) this.#diagnostics.shift();
    for (const listener of [...this.#diagnosticListeners]) {
      try { listener(immutable); } catch { /* diagnostics are isolated */ }
    }
    this.#publishRuntimeChange(false);
  }

  #requestImmediateUpdate(): void {
    if (this.#immediatePending) return;
    this.#immediatePending = true;
    queueMicrotask(() => {
      this.#immediatePending = false;
      if (!this.#disposed) this.update();
    });
  }

  #scheduleFrame(): void {
    if (!this.#selfDriven || this.#animationFrame !== undefined || this.#window === null) return;
    this.#animationFrame = this.#window.requestAnimationFrame(() => {
      this.#animationFrame = undefined;
      if (!this.#selfDriven || this.#disposed) return;
      this.update();
      this.#scheduleFrame();
    });
  }
}

function runCleanupSteps(steps: readonly (() => void)[]): unknown[] {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { step(); } catch (error) { errors.push(error); }
  }
  return errors;
}

function visibleProjection(host: HostIntegration, point: Vec3, viewport: ViewportSnapshot): Vec2 | undefined {
  const projected = host.project(point, viewport);
  return projected === null || !projected.visible ? undefined : projected.point;
}

/**
 * Projects one point of a region's outline, judged differently from everything else on purpose: the
 * point is kept whenever it can be projected at all, rather than dropped for being off screen.
 *
 * A corner leaving the window must clip the shape, not delete it. Whether any point was genuinely
 * on screen is still recorded, because that is a different question and it does get asked.
 */
function outlineProjection(
  host: HostIntegration,
  point: Vec3,
  viewport: ViewportSnapshot,
  sawVisible: { value: boolean },
): Vec2 | undefined {
  const projected = host.project(point, viewport);
  if (projected === null) return undefined;
  if (projected.visible) sawVisible.value = true;
  return projected.point;
}

/**
 * Decides whether a region should be drawn at all. Three cases:
 *
 * 1. Part of it is on screen. Draw it, clipped, however many corners have left the view.
 *
 * 2. None of it is on screen, but it completely surrounds the window. The user has zoomed in until
 *    the region is bigger than their screen — every corner is outside while the shape covers
 *    everything they can see. Dropping it here would erase the very markup they zoomed in to read.
 *
 * 3. None of it is on screen and it does not surround the window: it is somewhere else, or behind
 *    the camera. This is the case that must be dropped. A point behind the camera still projects to
 *    perfectly finite numbers — mirrored ones — so sensible-looking coordinates prove nothing.
 *
 * Surrounding rather than merely overlapping is what separates case 2 from case 3: a shape that
 * only overlaps the window, with no visible point, is sliding out of view rather than being zoomed
 * into.
 */
function regionWorthDrawing(
  points: readonly Vec2[],
  viewport: ViewportSnapshot,
  anyVisible: boolean,
): boolean {
  if (points.length === 0) return false;
  if (anyVisible) return true;
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  return Math.min(...xs) <= 0 && Math.max(...xs) >= viewport.width
    && Math.min(...ys) <= 0 && Math.max(...ys) >= viewport.height;
}

function applyOcclusionPresentation(
  routed: readonly PlannedAnnotation[],
  presentation: readonly OcclusionPresentation[],
): readonly PlannedAnnotation[] {
  const presentationById = new Map(presentation.map((entry) => [entry.id, entry]));
  return routed.flatMap((entry) => {
    const state = presentationById.get(entry.annotation.id);
    if (state?.visible === false) return [];
    // Rebuilt from scratch every frame, so a leader that stops being hidden simply does not get
    // the flag again. There is nothing stale to clear.
    const occludedLegs = new Set(state?.occludedLegIds ?? []);
    return [{
      ...entry,
      opacity: state?.opacity ?? 1,
      ...(occludedLegs.size === 0 ? {} : {
        // `hide` already means "not drawn while behind something"; the only thing it could not say
        // was "this leg", because `visible` is keyed by annotation. Dropped from the plan rather
        // than flagged: the stroke, the hit path, the head, the grips, `hitTestPlan` and
        // `lintFrame` all read `entry.legs`, so they agree without any of them learning a new word.
        // A flag is one of them forgetting, and that one leaves a leader you cannot see but can
        // still click and drag. Read off the annotation, which is the same expression the policies
        // map above is built from.
        legs: entry.annotation.occlusion === 'hide'
          ? entry.legs.filter((leg) => !occludedLegs.has(leg.id))
          : entry.legs.map((leg) => (occludedLegs.has(leg.id) ? { ...leg, occluded: true } : leg)),
      }),
    }];
  });
}

/**
 * Turns a style's drafting units into the sizes actually drawn, and the one place the global scale
 * factor is applied.
 *
 * The subtlety is that only half the fields need multiplying. Line widths, the leader's tail and
 * the label's border are in screen pixels and are scaled here. Padding, corner radius and the
 * label's outline are laid out at a fixed size and drawn inside a group that is already scaled by
 * the text size — so scaling the text scales those too, and doing it here as well would apply the
 * factor twice.
 *
 * The text size also determines the arrowhead, and the line width the surface dot, because drafting
 * standards tie them to each other. That way a head always stays in proportion with the leader it
 * finishes.
 */
function resolveStyleById(
  id: string | undefined,
  customDefinitions: readonly ReturnType<typeof definitionsFromCollections>[number][],
  builtIns: readonly TypedDefinition[],
  /** Used when an annotation names no style, or names one that no longer exists. */
  fallback: RenderStyle,
  override: StyleOverride = {},
  scale = 1,
): RenderStyle {
  const definitions = [...builtIns, ...customDefinitions];
  const candidate = definitions.find((entry) => entry.kind === 'style' && entry.id === (id ?? 'builtin.style.standard'));
  const style = (candidate?.kind === 'style' ? candidate : undefined) as StyleDefinition | undefined;
  const base = style ?? fallback;
  // Arrowheads and label shapes are sized from the final values, not the style's originals. An
  // override that changes the text size has to take the arrowhead with it, or the head stops
  // matching the note it belongs to.
  const resolved = {
    lineColor: override.lineColor ?? base.lineColor,
    lineWidth: (override.lineWidth ?? base.lineWidth) * scale,
    textColor: override.textColor ?? base.textColor,
    fontFamily: override.fontFamily ?? base.fontFamily,
    fontSize: (override.fontSize ?? base.fontSize) * scale,
  };
  if (style === undefined) return Object.freeze(resolved);
  const merged = mergeStyleOverride(style, override);
  const anchorHead = terminatorFor(definitions, merged.terminatorId, resolved);
  const labelHead = terminatorFor(definitions, merged.labelTerminatorId, resolved);
  const enclosure = enclosureFor(definitions, merged.enclosureId);
  const landing = scaledLanding(merged.landing, scale);
  return Object.freeze({
    ...resolved,
    ...(anchorHead === undefined ? {} : { terminator: anchorHead }),
    ...(labelHead === undefined ? {} : { labelTerminator: labelHead }),
    ...(enclosure === undefined ? {} : { enclosure }),
    ...(merged.content === undefined ? {} : { contentBox: scaledContentBox(merged.content, scale) }),
    ...(landing === undefined ? {} : { landing }),
  });
}

/**
 * A style that says nothing about its leader's tail still gets one, from the defaults — and those
 * defaults are drafting sizes like any other.
 *
 * So when a scale factor is in force they have to be written out and multiplied too. Otherwise a
 * style that simply stayed silent would end up with a full-size tail beside a double-size arrowhead.
 */
function scaledLanding(landing: StyleLanding | undefined, scale: number): StyleLanding | undefined {
  const source = landing ?? (scale === 1 ? undefined : DEFAULT_LANDING);
  if (source === undefined) return undefined;
  return {
    ...source,
    ...(source.length === undefined ? {} : { length: source.length * scale }),
    ...(source.gap === undefined ? {} : { gap: source.gap * scale }),
  };
}

/** Border width only. Padding and corner radius are already scaled with the text — see above. */
/**
 * Identifies a label's image. A label carries at most one, so this stays the same across layouts —
 * which is what lets the image's size be looked up before laying out rather than during it.
 */
function imageOwnerId(annotationId: string): string {
  return `${annotationId}:content:image`;
}

function scaledContentBox(box: StyleContentBox, scale: number): StyleContentBox {
  return box.borderWidth === undefined ? box : { ...box, borderWidth: box.borderWidth * scale };
}

function enclosureFor(
  definitions: readonly TypedDefinition[],
  id: string | undefined,
): EnclosureDefinition | undefined {
  if (id === undefined) return undefined;
  // A style naming a shape that does not exist is already refused when it is created. Falling back
  // to the plain box means drawing still cannot fail if one arrives by some other route.
  const found = definitions.find((entry) => entry.kind === 'enclosure' && entry.id === id);
  return found?.kind === 'enclosure' ? found : undefined;
}

function enclosurePaint(
  box: StyleContentBox,
  style: Pick<RenderStyle, 'lineColor' | 'lineWidth'>,
): NonNullable<RenderPathPrimitive['paint']> {
  return {
    ...(box.backgroundColor === undefined ? {} : { fill: box.backgroundColor }),
    ...(box.backgroundOpacity === undefined ? {} : { fillOpacity: box.backgroundOpacity }),
    stroke: box.borderColor ?? style.lineColor,
    strokeWidth: box.borderWidth ?? style.lineWidth,
  };
}

function terminatorFor(
  definitions: readonly TypedDefinition[],
  id: string | undefined,
  style: Pick<RenderStyle, 'lineWidth' | 'fontSize'>,
): RenderTerminator | undefined {
  if (id === undefined) return undefined;
  // Likewise for arrowheads: already refused at creation, so this only softens a case that arrived
  // some other way. Drawing never fails over decoration.
  const found = definitions.find((entry) => entry.kind === 'terminator' && entry.id === id);
  return found?.kind === 'terminator' ? resolveTerminator(found, style) : undefined;
}

function scaleBounds(bounds: ContentBounds, scale: number): ContentBounds {
  return {
    x: bounds.x * scale,
    y: bounds.y * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
}

function unionBounds(bounds: readonly ContentBounds[]): ContentBounds | undefined {
  if (bounds.length === 0) return undefined;
  const left = Math.min(...bounds.map(({ x }) => x));
  const top = Math.min(...bounds.map(({ y }) => y));
  const right = Math.max(...bounds.map(({ x, width }) => x + width));
  const bottom = Math.max(...bounds.map(({ y, height }) => y + height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function primitiveLabels(primitives: readonly DeclarativePrimitive[]): readonly string[] {
  return primitives.flatMap((primitive): string[] => [
    primitive.accessibility.label,
    ...(primitive.kind === 'group' ? primitiveLabels(primitive.children) : []),
  ]);
}

function isFiniteVec2(value: unknown): value is Vec2 {
  return value !== null && typeof value === 'object'
    && Number.isFinite((value as Vec2).x) && Number.isFinite((value as Vec2).y);
}

function centroid(points: readonly Vec2[]): Vec2 {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function freezeOverrides(overrides: SavedViewAnnotationOverrides): SavedViewAnnotationOverrides {
  const clone = structuredClone(overrides);
  for (const override of Object.values(clone)) {
    if (override.placement?.position !== undefined) Object.freeze(override.placement.position);
    if (override.placement !== undefined) Object.freeze(override.placement);
    if (override.style !== undefined) deepFreeze(override.style);
    Object.freeze(override);
  }
  return Object.freeze(clone);
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}
