// Dragging annotations that already exist: move a label, drag an arrow onto a different element,
// bend a leader, resize a region.
//
// The mirror image of `authoring.ts` — same shape, same rules, same escape-to-cancel. Authoring
// creates a new annotation; editing changes one that is already there.
//
// While a drag is running nothing is written. The document is only touched on release, so one drag
// is one undo step, and letting go outside the window or pressing escape leaves no trace.
import type { DocumentEngine } from './document.js';
import { AdapterError, InvalidInputError } from './errors.js';
import type {
  AccuratePickingAdapter,
  InteractionLease,
  NormalizedPointerInput,
  SurfacePickingAdapter,
} from './host.js';
import { isPointerEvent, normalizePointer, validatePointer } from './pointer.js';
import {
  addRegionVertex,
  drawingPlaneFromSurfacePick,
  editInkPoint,
  legRouteToCore,
  moveInk,
  moveRegion,
  moveRegionVertex,
  regionAnchorFromCore,
  regionLocalExtent,
  resizeRegion,
  retargetRegion,
  screenDeltaToDrawingPlane,
  type InkAnnotation,
  type RegionAnchor,
} from './markup.js';
import type { MarkupAuthoringCapability } from './markup-authoring-capability.js';
import { addRouteVertex, moveRouteVertex, type LegRoute } from './routing.js';
import type { RegionHandle, ScreenHit } from './render.js';
import type { ViewLeaderRuntime } from './runtime.js';
import type {
  Anchor,
  AnnotationLeg,
  AnnotationPatch,
  Rect,
  SnapshotStamp,
  Unsubscribe,
  Vec2,
} from './types.js';

/**
 * How far the pointer must move before a press counts as a drag rather than a click.
 *
 * Without it, an unsteady hand selecting a label would pin it in place — and a pinned label stops
 * being arranged automatically from then on, which is a lasting change nobody asked for.
 */
export const DRAG_THRESHOLD_PX = 3;

/** How near the pointer has to be to a leader line to grab it. About a comfortable line width. */
export const LEADER_HIT_TOLERANCE_PX = 6;

export type EditingCancellationReason =
  | 'host'
  | 'escape'
  | 'preempted'
  | 'pointer-exit'
  | 'document-replaced'
  | 'disposed';

/**
 * What a drag is moving.
 *
 * Dragging an existing bend moves it; dragging the middle of a segment creates a new bend and then
 * behaves identically. The new bend appears on the first movement, so the rest of the gesture has
 * no special case in it.
 *
 * Region and ink drags work in the shape's own plane rather than in screen pixels. The pointer's
 * movement is converted onto that plane first, so a rectangle stays a rectangle no matter how
 * steeply the camera is looking at it.
 */
export type EditingDragKind =
  | 'label'
  | 'handle'
  | 'vertex'
  | 'midpoint'
  | 'region'
  | 'region-extent'
  | 'region-vertex'
  | 'region-midpoint'
  | 'ink'
  | 'ink-point';

export interface EditingSnapshot extends SnapshotStamp {
  /**
   * Where the gesture is up to: pressed but not yet moved far enough to count as a drag; actively
   * dragging; waiting for the host to say what was under the drop point; or dragging a selection
   * box across empty space.
   */
  readonly phase: 'idle' | 'pressed' | 'dragging' | 'picking' | 'marquee';
  readonly target: string | null;
  readonly kind: EditingDragKind | null;
  /** Which leader line's arrow is being dragged. Nothing when the label itself is being moved. */
  readonly leg: string | null;
}

export interface EditingOptions {
  /**
   * Who draws the little handles on a selected annotation.
   *
   * By default ViewLeader draws them and responds to them. Set to `'none'`, it draws nothing and a
   * host reads their positions from `geometry.of(id).handles` and drives the drags itself.
   *
   * That option exists because handles sometimes have to do things an SVG overlay cannot: be hidden
   * behind geometry in the 3D scene, match a design system, be big enough for a finger, or take
   * part in the host's own keyboard focus order.
   */
  readonly handles?: 'core' | 'none';
  /**
   * Whether ViewLeader listens for pointer events itself.
   *
   * Off by default, so upgrading never makes labels suddenly draggable in an application that did
   * not ask for it. The editing methods can always be called directly whichever way this is set.
   */
  readonly gestures?: boolean;
  /**
   * When a press on empty space starts a rubber-band selection. `'empty-space'` is every plain
   * left-press; `'modifier'` is a shift- or alt-press only — the same two modifiers the marquee
   * already reads to add to or remove from the selection — so a plain drag falls through and does
   * nothing; `'none'` never marquees.
   *
   * The default is `'empty-space'`, except when the host supplied an interaction adapter, where it
   * is `'none'`. Starting a marquee takes the interaction lease, and the motivating case for that
   * adapter is camera controls: a host that wires the lease to its controls loses left-drag orbit
   * on every press that misses an annotation. With no way to decline, such a host has to unbind its
   * own left button instead — which is how both editing examples ended up with no left-drag orbit
   * and, after reassigning the right button to get it back, no pan either.
   *
   * The test is whether the adapter exists, not what the host does with the lease — core also
   * acquires it for authoring. A host that supplies `interaction` purely so its own input stands
   * down during a pick therefore loses the rubber band too, and gets it back by asking for
   * `'empty-space'` explicitly.
   */
  readonly marquee?: 'empty-space' | 'modifier' | 'none';
}

export interface EditingControllerOptions {
  readonly boundary: Element;
  readonly document: DocumentEngine;
  readonly runtime: ViewLeaderRuntime;
  /**
   * Fetched on demand, because the markup capability is built after this one.
   *
   * Region and ink edits are committed through it rather than written here directly — it already
   * owns the "one gesture, one commit" logic, and a drag has no business writing to the document
   * itself.
   */
  readonly markup: () => MarkupAuthoringCapability;
  readonly editing?: EditingOptions;
  /**
   * True while a drawing tool is active.
   *
   * Editing gets out of the way rather than competing. A host that started a placement tool means
   * the next click to place something, not to drag whatever happens to be under the cursor.
   */
  readonly toolActive: () => boolean;
}

interface ActiveDrag {
  readonly id: string;
  readonly kind: EditingDragKind;
  /** Which leader line's arrow is moving, when dragging an arrow rather than a label. */
  readonly legId: string | undefined;
  /** Where the pointer was when the press started. */
  readonly origin: Vec2;
  /** Where the thing being dragged was when the press started, so every move is measured from
   *  there rather than from the last one — a long drag cannot accumulate rounding errors. */
  readonly start: Vec2;
  readonly lease: InteractionLease | undefined;
  /** Where it would land if released now. Nothing until the drag has passed the threshold. */
  preview: Vec2 | undefined;
  /** Set while waiting for the host to say what was under the drop point, so an answer arriving
   *  after the next gesture has begun can be ignored. */
  pick: AbortController | undefined;
  /** Which bend is being moved. Not known until a new one has been inserted, for a midpoint drag. */
  vertexIndex: number | undefined;
  /** Where a newly created bend belongs in the line. */
  readonly insertAt: number | undefined;
  /**
   * The leader as it was when the drag began. Every movement is recalculated from this, so a long
   * drag cannot accumulate rounding errors.
   *
   * Rewritten once when a midpoint drag inserts a new bend, so that subsequent movement moves the
   * bend that was just created rather than the one it was inserted before.
   */
  baseRoute: LegRoute | undefined;
  /** The region as it was when the drag began, for the same reason. */
  baseRegion: RegionAnchor | undefined;
  /** The stroke as it was when the drag began, for the same reason. */
  readonly baseInk: InkAnnotation | undefined;
  /** Which corner or edge of a region is being dragged, and therefore which way it resizes. */
  readonly grab: Vec2 | undefined;
}

/**
 * A selection box being dragged across the screen.
 *
 * Deliberately not folded into a normal drag: it has no annotation, no leader and nothing it moves.
 * It is a question about what lies inside a rectangle, not a thing being dragged.
 */
interface ActiveMarquee {
  /** Where the pointer was when the press started. */
  readonly origin: Vec2;
  /** Where the pointer is now. Nothing until the drag has passed the threshold. */
  current: Vec2 | undefined;
  readonly lease: InteractionLease | undefined;
  /** Fixed at the moment of pressing: a plain drag replaces the selection, shift adds to it, alt
   *  removes from it. Decided once so releasing a key mid-drag cannot change what happens. */
  readonly mode: 'replace' | 'add' | 'remove';
  /** What was selected before the box was drawn, so shift and alt have something to combine with. */
  readonly baseline: ReadonlySet<string>;
}

export class EditingController {
  readonly #boundary: Element;
  readonly #document: DocumentEngine;
  readonly #runtime: ViewLeaderRuntime;
  readonly #markup: () => MarkupAuthoringCapability;
  readonly #listeners = new Set<() => void>();
  readonly #cleanup: (() => void)[] = [];
  readonly #documentUnsubscribe: Unsubscribe;
  readonly #toolActive: () => boolean;
  readonly #gestures: boolean;
  readonly #marqueeMode: NonNullable<EditingOptions['marquee']>;
  #active: ActiveDrag | undefined;
  #marquee: ActiveMarquee | undefined;
  /** True while the pointer is captured. Capturing fires a spurious "pointer left" event, and this
   *  is how a real exit is told apart from that one. */
  #capturedPointer: number | undefined;
  #disposed = false;

  public constructor(options: EditingControllerOptions) {
    this.#boundary = options.boundary;
    this.#document = options.document;
    this.#runtime = options.runtime;
    this.#markup = options.markup;
    this.#toolActive = options.toolActive;
    this.#gestures = options.editing?.gestures === true;
    // Default off when the host supplied an interaction adapter: a marquee takes the lease, and
    // the adapter's motivating case is camera controls. See `EditingOptions.marquee`.
    this.#marqueeMode = options.editing?.marquee
      ?? (options.runtime.adapters.interaction === undefined ? 'empty-space' : 'none');
    this.#documentUnsubscribe = options.document.subscribe((commit) => {
      // The document has been replaced underneath the drag, and the annotation being dragged may
      // not exist any more. There is nowhere for it to land, so the gesture is abandoned.
      if (commit.kind === 'replacement') {
        this.#finish('document-replaced');
        this.#cancelMarquee('document-replaced');
      }
    });
    if (this.#gestures) this.#connectInput();
  }

  public getSnapshot(): EditingSnapshot {
    const stamp = this.#runtime.documentsSnapshot();
    const active = this.#active;
    const marquee = this.#marquee;
    return Object.freeze({
      runtimeRevision: stamp.runtimeRevision,
      documentRevision: stamp.documentRevision,
      phase: marquee !== undefined
        ? (marquee.current === undefined ? 'pressed' : 'marquee')
        : active === undefined
          ? 'idle'
          : active.pick !== undefined
            ? 'picking'
            : active.preview === undefined ? 'pressed' : 'dragging',
      target: active?.id ?? null,
      kind: active?.kind ?? null,
      leg: active?.legId ?? null,
    });
  }

  public subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** What is under the pointer, or nothing for empty space. Exactly the test a drag would use. */
  public hitTest(pointer: NormalizedPointerInput): ScreenHit | undefined {
    validatePointer(pointer);
    return this.hitTestScreen(this.#screen(pointer));
  }

  /**
   * The same test, asked with a plain screen position.
   *
   * A host wiring up a context menu can subtract the element's origin from a click and ask directly,
   * rather than converting to fractions of the viewport and inventing pointer fields it has no
   * opinion about. Screen coordinates because everything else reported is in screen coordinates.
   */
  public hitTestScreen(at: Vec2): ScreenHit | undefined {
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) {
      throw new InvalidInputError('Screen hit-test coordinates must be finite');
    }
    return this.#runtime.hitTest({ x: at.x, y: at.y }, LEADER_HIT_TOLERANCE_PX);
  }

  public pointerDown(pointer: NormalizedPointerInput): void {
    validatePointer(pointer);
    if (this.#disposed || this.#toolActive()) return;
    // Left button only. A right-click belongs to the host's context menu, and taking over the
    // pointer before its own handler has even run would mean quietly stealing a gesture.
    if (pointer.button !== 0) return;
    if (this.#active !== undefined) this.#finish('preempted');
    if (this.#marquee !== undefined) this.#cancelMarquee('preempted');
    const at = this.#screen(pointer);
    const hit = this.#runtime.hitTest(at, LEADER_HIT_TOLERANCE_PX);
    // A press on empty space draws a selection box. Refusing has to happen before the pointer is
    // taken over, because taking it over is what makes a host disable its camera controls — doing
    // that for a selection box the host asked us not to draw would kill the orbit its own handler,
    // which ran first on the canvas below, has already started.
    if (hit === undefined) {
      if (this.#marqueeMode !== 'none' &&
        (this.#marqueeMode !== 'modifier' || pointer.shiftKey || pointer.altKey)) {
        this.#beginMarquee(at, pointer);
      }
      return;
    }
    if (hit.kind === 'handle') {
      this.beginHandleDrag(hit.id, hit.index ?? -1, pointer);
      return;
    }
    if (hit.kind === 'route-handle') {
      this.beginRouteHandleDrag(hit.id, hit.index ?? -1, pointer);
      return;
    }
    if (hit.kind === 'region-handle') {
      this.beginRegionHandleDrag(hit.id, hit.index ?? -1, pointer);
      return;
    }
    // Grabbing a region's outline moves the region, just as grabbing a leader moves its label.
    if (hit.kind === 'region') {
      this.#beginRegionDrag(hit.id, hit.legId ?? '', 'region', pointer);
      return;
    }
    if (hit.kind === 'ink') {
      this.#beginInkDrag(hit.id, 'ink', pointer);
      return;
    }
    if (hit.kind === 'ink-point') {
      this.beginInkPointDrag(hit.id, hit.index ?? -1, pointer);
      return;
    }
    const geometry = this.#runtime.geometryOf(hit.id);
    if (geometry === undefined) return;
    const lease = this.#acquire();
    if (lease === null) return;
    // Dragging a leader line moves the whole annotation. The line has no position of its own — it
    // is drawn between two things — so the only thing it can move is the label at its end.
    this.#start({
      id: hit.id,
      kind: 'label',
      origin: at,
      start: { x: geometry.label.x, y: geometry.label.y },
      lease,
    });
  }

  /**
   * Starts dragging one of a region's handles: a corner or edge that resizes it, or a vertex on a
   * polygon. This is the entry point a host needs when drawing the handles itself.
   */
  public beginRegionHandleDrag(id: string, index: number, pointer: NormalizedPointerInput): void {
    validatePointer(pointer);
    const handle = this.#runtime.geometryOf(id)?.regionHandles[index];
    if (handle === undefined) return;
    this.#beginRegionDrag(id, handle.target, regionDragKind(handle), pointer, handle);
  }

  /** Starts dragging one point of a freehand stroke. */
  public beginInkPointDrag(id: string, index: number, pointer: NormalizedPointerInput): void {
    validatePointer(pointer);
    const at = this.#runtime.geometryOfInk(id)?.points[index];
    if (at === undefined) return;
    this.#beginInkDrag(id, 'ink-point', pointer, index);
  }

  /**
   * Region drags all share a shape: resolve the stored anchor once, keep it as the base every move
   * recomputes from, and let the handle say which part of it moves.
   */
  #beginRegionDrag(
    id: string,
    legId: string,
    kind: EditingDragKind,
    pointer: NormalizedPointerInput,
    handle?: RegionHandle,
  ): void {
    if (this.#disposed || this.#toolActive()) return;
    if (this.#active !== undefined) this.#finish('preempted');
    const leg = this.#document.get(id)?.anchors.find((candidate) => candidate.id === legId);
    if (leg?.anchor.kind !== 'region') return;
    const lease = this.#acquire();
    if (lease === null) return;
    const at = this.#screen(pointer);
    this.#start({
      id,
      kind,
      legId,
      origin: at,
      start: handle === undefined ? at : { ...handle.at },
      lease,
      baseRegion: regionAnchorFromCore(leg.anchor),
      ...(handle?.kind === 'extent' ? { grab: handle.grab } : {}),
      ...(handle?.kind === 'vertex' ? { vertexIndex: handle.index } : {}),
      ...(handle?.kind === 'midpoint' ? { insertAt: handle.index } : {}),
    });
  }

  #beginInkDrag(
    id: string,
    kind: EditingDragKind,
    pointer: NormalizedPointerInput,
    index?: number,
  ): void {
    if (this.#disposed || this.#toolActive()) return;
    if (this.#active !== undefined) this.#finish('preempted');
    const ink = this.#markup().getInk(id);
    if (ink === undefined) return;
    const lease = this.#acquire();
    if (lease === null) return;
    const at = this.#screen(pointer);
    this.#start({
      id,
      kind,
      origin: at,
      start: at,
      lease,
      baseInk: ink,
      ...(index === undefined ? {} : { vertexIndex: index }),
    });
  }

  #start(drag: Pick<ActiveDrag, 'id' | 'kind' | 'origin' | 'start' | 'lease'> & Partial<ActiveDrag>): void {
    this.#active = {
      legId: undefined,
      preview: undefined,
      pick: undefined,
      vertexIndex: undefined,
      insertAt: undefined,
      baseRoute: undefined,
      baseRegion: undefined,
      baseInk: undefined,
      grab: undefined,
      ...drag,
    };
    this.#publish(false);
  }

  /**
   * Starts dragging one of an annotation's arrow handles, after which the usual move and release
   * calls apply.
   *
   * Needed when the host draws the handles itself: ViewLeader is then not looking for them, so a
   * press cannot find one and the host has to start the gesture. Behaves the same either way.
   */
  public beginHandleDrag(id: string, index: number, pointer: NormalizedPointerInput): void {
    validatePointer(pointer);
    if (this.#disposed || this.#toolActive()) return;
    if (this.#active !== undefined) this.#finish('preempted');
    const handle = this.#runtime.geometryOf(id)?.handles[index];
    if (handle === undefined) return;
    const lease = this.#acquire();
    if (lease === null) return;
    this.#start({
      id,
      kind: 'handle',
      legId: handle.target,
      origin: this.#screen(pointer),
      // Measured from where the handle is, not from where the pointer grabbed it. Otherwise
      // catching a handle slightly off-centre would jerk it by that much on the first movement.
      start: { x: handle.at.x, y: handle.at.y },
      lease,
    });
  }

  /**
   * Starts dragging a bend in a leader line, or the middle of a segment, which creates a new bend.
   * The entry point a host needs when drawing the handles itself.
   */
  public beginRouteHandleDrag(id: string, index: number, pointer: NormalizedPointerInput): void {
    validatePointer(pointer);
    if (this.#disposed || this.#toolActive()) return;
    if (this.#active !== undefined) this.#finish('preempted');
    const handle = this.#runtime.geometryOf(id)?.routeHandles[index];
    if (handle === undefined) return;
    const annotation = this.#document.get(id);
    const routing = annotation?.anchors.find((leg) => leg.id === handle.target)?.routing;
    if (routing === undefined) return;
    const lease = this.#acquire();
    if (lease === null) return;
    this.#start({
      id,
      kind: handle.kind,
      legId: handle.target,
      origin: this.#screen(pointer),
      start: { x: handle.at.x, y: handle.at.y },
      lease,
      // There is no bend here yet. The first movement creates one and fills this in.
      ...(handle.kind === 'vertex' ? { vertexIndex: handle.index } : { insertAt: handle.index }),
      baseRoute: routing.kind === 'manual'
        ? { mode: 'manual', vertices: routing.vertices.map((vertex) => ({ ...vertex })) }
        // A leader that was routing itself has no bends to keep, so the first one dragged in is
        // the only one. That does change the line's shape on that first drag — it stops routing
        // itself and becomes hand-drawn. `resetRouting` puts it back.
        : { mode: 'manual', vertices: [] },
    });
  }

  /**
   * Starts dragging a selection box.
   *
   * Whether it replaces, adds to or removes from the selection is decided from the modifier keys at
   * the moment of pressing — the same convention every CAD tool uses: plain replaces, shift adds,
   * alt removes.
   */
  #beginMarquee(at: Vec2, pointer: NormalizedPointerInput): void {
    const lease = this.#acquire();
    if (lease === null) return;
    this.#marquee = {
      origin: at,
      current: undefined,
      lease,
      mode: pointer.altKey ? 'remove' : pointer.shiftKey ? 'add' : 'replace',
      baseline: new Set(this.#runtime.annotationsSnapshot().selectedIds),
    };
    this.#publish(false);
  }

  /** Nothing when the host declined. That is not an error — it is the host saying its own tool
   *  owns this gesture. */
  #acquire(): InteractionLease | undefined | null {
    try {
      return this.#runtime.adapters.interaction?.acquire('editing');
    } catch {
      return null;
    }
  }

  public pointerMove(pointer: NormalizedPointerInput): void {
    validatePointer(pointer);
    if (this.#marquee !== undefined) {
      this.#moveMarquee(this.#screen(pointer));
      return;
    }
    const active = this.#active;
    if (active === undefined) {
      this.#hover(this.#screen(pointer));
      return;
    }
    // The pointer is already up and we are waiting to hear what was under it. Anything moving now
    // belongs to whatever happens next, not to the gesture that just ended.
    if (active.pick !== undefined) return;
    const at = this.#screen(pointer);
    const position = {
      x: active.start.x + (at.x - active.origin.x),
      y: active.start.y + (at.y - active.origin.y),
    };
    if (
      active.preview === undefined &&
      Math.hypot(at.x - active.origin.x, at.y - active.origin.y) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    active.preview = position;
    const screenDelta = { x: at.x - active.origin.x, y: at.y - active.origin.y };
    switch (active.kind) {
      case 'handle':
        this.#runtime.setAnchorPreview({ id: active.id, legId: active.legId!, at: position });
        break;
      case 'vertex':
      case 'midpoint':
        this.#runtime.setRoutePreview({
          id: active.id,
          legId: active.legId!,
          route: this.#routeFor(active, position),
        });
        break;
      case 'region':
      case 'region-extent':
      case 'region-vertex':
      case 'region-midpoint': {
        // A drag can pass through shapes that are momentarily impossible — a rectangle with no
        // width, a polygon folded onto itself. Keep showing the last good one rather than letting
        // a passing error escape into a pointer handler. Releasing there still reports honestly.
        const anchor = this.#regionFor(active, screenDelta);
        if (anchor !== undefined) {
          this.#runtime.setRegionPreview({ id: active.id, legId: active.legId!, anchor });
        }
        break;
      }
      case 'ink':
      case 'ink-point': {
        const ink = this.#inkFor(active, screenDelta);
        if (ink !== undefined) this.#runtime.setInkPreview({ id: active.id, ink });
        break;
      }
      default: {
        // What is shown and what is eventually saved must be the same snapped position, so the
        // snapped value is stored here rather than only handed to the renderer.
        const snapped = this.#snapLabelPosition(active.id, position);
        active.preview = snapped;
        this.#runtime.setPlacementPreview({ id: active.id, position: snapped });
      }
    }
    this.#publish(false);
  }

  /**
   * Sets the mouse cursor as the pointer moves over things.
   *
   * The one place ViewLeader touches the cursor, and it earns it: a draggable label, a grabbable
   * handle and an insertable bend would otherwise all sit under a plain arrow, so every gesture in
   * this file would work and none of them would be discoverable.
   *
   * Stays quiet when the host handles its own pointer events, and while a drawing tool is active —
   * showing a move cursor there would promise a drag that is about to be refused.
   *
   * ponytail: one hit test per pointer move. The test reads an already-built plan, with no layout
   * or projection involved. Batch it per animation frame only if a profile ever shows it mattering.
   */
  #hover(at: Vec2): void {
    if (!this.#gestures) return;
    this.#setCursor(this.#disposed || this.#toolActive() ? '' : this.#cursorFor(at));
  }

  /**
   * Picks the cursor for whatever is under the pointer.
   *
   * Almost everything here is draggable, so almost everything is the move cursor. The exception is
   * the middle of a leader segment, which creates a new bend rather than moving one — that gets the
   * copy cursor, which people already read as "this adds something rather than relocating it".
   *
   * Empty space clears the cursor rather than setting it to the default arrow. Clearing hands the
   * element back to the host's own stylesheet; setting an arrow would override it permanently.
   */
  #cursorFor(at: Vec2): string {
    const hit = this.#runtime.hitTest(at, LEADER_HIT_TOLERANCE_PX);
    if (hit === undefined) return '';
    if (hit.kind !== 'route-handle' && hit.kind !== 'region-handle') return 'move';
    const geometry = this.#runtime.geometryOf(hit.id);
    const handle = hit.kind === 'route-handle'
      ? geometry?.routeHandles[hit.index ?? -1]
      : geometry?.regionHandles[hit.index ?? -1];
    return handle?.kind === 'midpoint' ? 'copy' : 'move';
  }

  /**
   * Sets the cursor, and only when it actually changes. Writing it on every pointer movement would
   * make the browser recalculate styles for the whole overlay as fast as the mouse can move.
   */
  #setCursor(cursor: string): void {
    const boundary = this.#boundary;
    if (!hasStyle(boundary) || boundary.style.cursor === cursor) return;
    boundary.style.cursor = cursor;
  }

  /** Offers a dragged label's position to the host's snapping rule, if it supplied one. */
  #snapLabelPosition(id: string, proposed: Vec2): Vec2 {
    const geometry = this.#runtime.geometryOf(id);
    if (geometry === undefined) return proposed;
    const anchors = geometry.handles.map((handle) => handle.at);
    const anchor = anchors.length === 0
      ? proposed
      : {
          x: anchors.reduce((sum, point) => sum + point.x, 0) / anchors.length,
          y: anchors.reduce((sum, point) => sum + point.y, 0) / anchors.length,
        };
    return this.#runtime.applySnap(proposed, {
      id,
      labelSize: { width: geometry.label.width, height: geometry.label.height },
      anchor,
    });
  }

  public pointerUp(pointer: NormalizedPointerInput): void {
    validatePointer(pointer);
    if (this.#marquee !== undefined) {
      this.#moveMarquee(this.#screen(pointer));
      this.#commitMarquee();
      return;
    }
    const active = this.#active;
    if (active === undefined || active.pick !== undefined) return;
    this.pointerMove(pointer);
    const position = active.preview;
    // Too small to be a drag, so it was a click. The renderer already handles selection on click,
    // and doing it here as well would toggle a shift-click twice and cancel itself out.
    if (position === undefined) {
      this.#finish('host');
      return;
    }
    if (active.kind === 'handle') {
      void this.#retarget(active, pointer);
      return;
    }
    if (active.kind === 'vertex' || active.kind === 'midpoint') {
      try {
        // Named leg by leg, so bending one leader leaves the others exactly as they were rather
        // than rewriting them all with identical values.
        this.#document.update(
          active.id,
          { anchors: this.#reroutedLegs(active, position) },
          'Reroute annotation',
        );
      } finally {
        this.#finish('host');
      }
      return;
    }
    const screenDelta = { x: position.x - active.start.x, y: position.y - active.start.y };
    if (active.baseRegion !== undefined) {
      // Committed from where the drag started, not from the last preview: that keeps it one undo
      // step, and means it cannot inherit a preview shape that was already found to be invalid.
      this.#commit(active, () => {
        const anchor = this.#regionFor(active, screenDelta);
        if (anchor === undefined) throw new InvalidInputError('The region drag has no valid result');
        this.#markup().updateRegion(active.id, active.legId!, () => anchor, 'Edit region');
      });
      return;
    }
    if (active.baseInk !== undefined) {
      this.#commit(active, () => {
        const ink = this.#inkFor(active, screenDelta);
        if (ink === undefined) throw new InvalidInputError('The ink drag has no valid result');
        this.#markup().updateInk(active.id, () => ink, 'Edit ink');
      });
      return;
    }
    try {
      // A single update is a single history entry, so a whole drag undoes in one go.
      //
      // Stored against the anchor it was dropped beside, not as a bare screen point: the durable
      // half of "put this callout here" is its distance from the thing it points at, and a raw
      // screen pin leaves it beside a different pipe the moment the camera turns. The live
      // preview stays absolute — during a drag the pointer *is* a screen point.
      this.#document.update(
        active.id,
        { placement: this.#runtime.placementAt(active.id, position) },
        'Move annotation',
      );
    } finally {
      this.#finish('host');
    }
  }

  /**
   * Points a leader at whatever the host finds under the drop point.
   *
   * Necessarily asynchronous: ViewLeader can work out where a world point lands on screen, but not
   * the reverse — that needs the host's scene. This is why dragging an arrow requires a picking
   * adapter and quietly does nothing without one.
   */
  async #retarget(active: ActiveDrag, pointer: NormalizedPointerInput): Promise<void> {
    const leg = this.#document.get(active.id)?.anchors.find(({ id }) => id === active.legId);
    if (leg?.anchor.kind === 'region') {
      await this.#retargetRegion(active, pointer);
      return;
    }
    const picking: AccuratePickingAdapter | undefined = this.#runtime.adapters.picking;
    if (picking === undefined) {
      this.#report(active, new InvalidInputError('The host adapter does not provide accurate picking'));
      return;
    }
    const controller = new AbortController();
    active.pick = controller;
    this.#publish(false);
    let anchor: Anchor | null;
    // Only the host call is guarded. Widening this to cover the change below would report a
    // validation problem as a host failure, and send someone debugging the wrong thing.
    try {
      anchor = await picking.pick({ pointer }, controller.signal);
    } catch (cause) {
      if (this.#active !== active || controller.signal.aborted) return;
      this.#report(active, new AdapterError('accurate picking', cause));
      return;
    }
    if (this.#active !== active || controller.signal.aborted) return;
    if (anchor === null) {
      // Dropped on empty space. Putting it back is the honest answer — there is no position to
      // move it to, and inventing one would attach the note to nothing.
      this.#finish('host');
      return;
    }
    try {
      this.#document.update(active.id, this.#retargetPatch(active, anchor), 'Retarget annotation');
      this.#finish('host');
    } catch (cause) {
      this.#report(active, cause instanceof Error ? cause : new InvalidInputError('Retarget failed'));
    }
  }

  /**
   * Moves a whole region onto a different surface, keeping its shape.
   *
   * Uses a different host call from every other kind of retarget, and has to: a region lives on a
   * flat plane, and working out that plane needs the direction the surface faces, not just a point
   * on it.
   *
   * Without this, dragging a region's handle would replace the region with an ordinary leader and
   * quietly turn a marked-up area into a plain note.
   */
  async #retargetRegion(active: ActiveDrag, pointer: NormalizedPointerInput): Promise<void> {
    const picking: SurfacePickingAdapter | undefined = this.#runtime.adapters.surfacePicking;
    if (picking === undefined) {
      this.#report(active, new InvalidInputError('The host adapter does not provide accurate surface picking'));
      return;
    }
    const controller = new AbortController();
    active.pick = controller;
    this.#publish(false);
    let surface: Awaited<ReturnType<SurfacePickingAdapter['pickSurface']>>;
    try {
      surface = await picking.pickSurface({ pointer }, controller.signal);
    } catch (cause) {
      if (this.#active !== active || controller.signal.aborted) return;
      this.#report(active, new AdapterError('accurate surface picking', cause));
      return;
    }
    if (this.#active !== active || controller.signal.aborted) return;
    if (surface === null) {
      this.#finish('host');
      return;
    }
    this.#commit(active, () => {
      const plane = drawingPlaneFromSurfacePick(surface!);
      this.#markup().updateRegion(
        active.id,
        active.legId!,
        (current) => retargetRegion(current, plane),
        'Retarget region',
      );
    });
  }

  /**
   * Points one leader somewhere new. The common single-leader case uses the shorthand field; only a
   * genuine multi-leader has to rewrite the whole list.
   */
  #retargetPatch(active: ActiveDrag, anchor: Anchor): AnnotationPatch {
    const current = this.#document.get(active.id);
    if (current === undefined) throw new InvalidInputError(`Annotation ${active.id} no longer exists`);
    if (current.anchors.length <= 1) return { anchor };
    return {
      anchors: current.anchors.map((leg) => leg.id === active.legId ? { ...leg, anchor } : leg),
    };
  }

  /**
   * What the leader would look like if the pointer stopped here.
   *
   * Dragging the middle of a segment creates a bend on the first movement and then behaves exactly
   * like dragging that bend, so there is one gesture rather than two. Every movement is measured
   * from where the drag started, so nothing accumulates rounding errors.
   */
  #routeFor(active: ActiveDrag, position: Vec2): LegRoute {
    const base = active.baseRoute ?? { mode: 'manual' as const, vertices: [] };
    if (active.vertexIndex === undefined) {
      const index = Math.min(active.insertAt ?? 0, manualLength(base));
      const inserted = addRouteVertex(base, index, position);
      active.vertexIndex = index;
      active.baseRoute = inserted;
      return inserted;
    }
    return moveRouteVertex(active.baseRoute ?? base, active.vertexIndex, position);
  }

  /** All the leaders, with only the dragged one changed. */
  #reroutedLegs(active: ActiveDrag, position: Vec2): readonly AnnotationLeg[] {
    const current = this.#document.get(active.id);
    if (current === undefined) throw new InvalidInputError(`Annotation ${active.id} no longer exists`);
    const routing = legRouteToCore(this.#routeFor(active, position));
    return current.anchors.map((leg) => leg.id === active.legId ? { ...leg, routing } : leg);
  }

  /**
   * Saves the result and ends the gesture, whatever happens.
   *
   * A shape that turns out to be invalid — a rectangle with no width, a folded polygon — is reported
   * and the document left alone. Throwing instead would escape into the host's own pointer handler
   * and take that down with it.
   */
  #commit(active: ActiveDrag, operation: () => void): void {
    try {
      operation();
      this.#finish('host');
    } catch (cause) {
      this.#report(active, cause instanceof Error ? cause : new InvalidInputError('The edit was refused'));
    }
  }

  /**
   * The region a region drag would produce, at a pointer that has moved `screenDelta` pixels.
   *
   * Everything here is composition of `markup.ts`'s existing edit functions in plane coordinates —
   * which is what keeps the region coplanar and keeps a rectangle rectangular for free, because no
   * screen coordinate is ever written into the geometry. A corner drag is `resizeRegion` (which
   * resizes about the centre) followed by `moveRegion` to put the opposite corner back where it was,
   * so the grip follows the pointer and the far side stays pinned.
   *
   * `undefined` when the plane cannot be inverted, or when the result is not a region — a caller
   * previewing holds the last good one, a caller committing reports it.
   */
  #regionFor(active: ActiveDrag, screenDelta: Vec2): RegionAnchor | undefined {
    const base = active.baseRegion;
    if (base === undefined) return undefined;
    const extent = regionLocalExtent(base.geometry);
    const delta = screenDeltaToDrawingPlane(
      base.plane,
      extent.center,
      screenDelta,
      (point) => this.#runtime.projectWorld(point),
      // Measure at roughly the region's own size, so the approximation is accurate over the
      // distances actually being dragged rather than somewhere else entirely.
      Math.max(extent.halfWidth, extent.halfHeight, 1e-6),
    );
    if (delta === undefined) return undefined;
    try {
      if (active.kind === 'region') return moveRegion(base, delta);
      if (active.kind === 'region-extent') return resizeAbout(base, extent, active.grab!, delta);
      if (active.vertexIndex === undefined) {
        // A new vertex is created once, on the first movement, and dragged normally thereafter.
        // It starts life exactly where the midpoint was, so every later movement is still measured
        // from the drag's origin rather than piling onto the previous one.
        const index = active.insertAt ?? 0;
        const vertices = regionVertices(base);
        const from = vertices[index - 1];
        const to = vertices[index % vertices.length];
        if (from === undefined || to === undefined) return undefined;
        active.baseRegion = addRegionVertex(base, index, {
          x: (from.x + to.x) / 2,
          y: (from.y + to.y) / 2,
        });
        active.vertexIndex = index;
      }
      const moving = active.baseRegion!;
      const current = regionVertices(moving)[active.vertexIndex];
      return current === undefined
        ? undefined
        : moveRegionVertex(moving, active.vertexIndex, {
          x: current.x + delta.x,
          y: current.y + delta.y,
        });
    } catch {
      return undefined;
    }
  }

  /** What a stroke would look like if the pointer stopped here — moving all of it, or one point. */
  #inkFor(active: ActiveDrag, screenDelta: Vec2): InkAnnotation | undefined {
    const base = active.baseInk;
    if (base === undefined) return undefined;
    const xs = base.points.map(({ x }) => x);
    const ys = base.points.map(({ y }) => y);
    const delta = screenDeltaToDrawingPlane(
      base.plane,
      { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
      screenDelta,
      (point) => this.#runtime.projectWorld(point),
      Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1e-6),
    );
    if (delta === undefined) return undefined;
    try {
      if (active.kind === 'ink') return moveInk(base, delta);
      const current = base.points[active.vertexIndex ?? -1];
      return current === undefined
        ? undefined
        : editInkPoint(base, active.vertexIndex!, { x: current.x + delta.x, y: current.y + delta.y });
    } catch {
      return undefined;
    }
  }

  /** Ends the gesture and reports what went wrong, rather than throwing into the host's own
   *  pointer handler and taking it down. */
  #report(active: ActiveDrag, error: Error): void {
    this.#finish('host');
    this.#runtime.publishExternalDiagnostic({
      // A resize refused for being an impossible shape is not a host failure, and reporting it as
      // one would send someone debugging their picking adapter over a geometry problem.
      code: active.kind === 'handle' ? 'EDITING_RETARGET_FAILED' : 'EDITING_EDIT_FAILED',
      severity: 'warning',
      message: error.message,
      annotationId: active.id,
    });
  }

  public cancel(reason: EditingCancellationReason = 'host'): void {
    this.#finish(reason);
    this.#cancelMarquee(reason);
    this.#releaseCapture();
  }

  /** Gives the pointer back. The browser does this itself on release; this covers cancelling. */
  #releaseCapture(): void {
    const pointerId = this.#capturedPointer;
    if (pointerId === undefined) return;
    this.#capturedPointer = undefined;
    try { this.#boundary.releasePointerCapture(pointerId); } catch { /* already released */ }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#finish('disposed');
    this.#cancelMarquee('disposed');
    this.#documentUnsubscribe();
    for (const cleanup of this.#cleanup.splice(0)) cleanup();
    // The element outlives this object, so the cursor has to be cleared along with the listeners
    // that set it. Otherwise disposing while the pointer rests on a label leaves the host stuck
    // with a move cursor forever.
    this.#setCursor('');
    this.#listeners.clear();
  }

  /** Abandons the gesture. The document was never touched, so there is nothing to put back — which
   *  is why cancelling costs no undo step. */
  #finish(reason: EditingCancellationReason): void {
    const active = this.#active;
    if (active === undefined) return;
    this.#active = undefined;
    active.pick?.abort();
    this.#runtime.setPlacementPreview(null);
    this.#runtime.setAnchorPreview(null);
    this.#runtime.setRoutePreview(null);
    this.#runtime.setRegionPreview(null);
    this.#runtime.setInkPreview(null);
    try { active.lease?.release(); } catch { /* lease ownership has still ended */ }
    this.#publish(reason !== 'disposed');
  }

  /** Grows the selection box, subject to the same threshold a drag uses — a twitch on empty space
   *  stays a click instead of flashing a one-pixel rectangle. */
  #moveMarquee(at: Vec2): void {
    const marquee = this.#marquee;
    if (marquee === undefined) return;
    if (
      marquee.current === undefined &&
      Math.hypot(at.x - marquee.origin.x, at.y - marquee.origin.y) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    marquee.current = at;
    this.#runtime.setMarqueePreview(rectFromPoints(marquee.origin, at));
    this.#publish(false);
  }

  /** Abandons the selection box and leaves the selection exactly as it was — escape, interruption
   *  and a replaced document all behave like an interrupted drag. */
  #cancelMarquee(reason: EditingCancellationReason): void {
    const marquee = this.#marquee;
    if (marquee === undefined) return;
    this.#marquee = undefined;
    this.#runtime.setMarqueePreview(null);
    try { marquee.lease?.release(); } catch { /* lease ownership has still ended */ }
    this.#publish(reason !== 'disposed');
  }

  /**
   * Ends the marquee on release. Under the threshold it was a click on empty space, not a marquee,
   * so selection is untouched — exactly the "a drag is not a click" rule a label drag follows.
   * Selection is core state, not document state, so this never calls `document.update`.
   */
  #commitMarquee(): void {
    const marquee = this.#marquee;
    if (marquee === undefined) return;
    this.#marquee = undefined;
    this.#runtime.setMarqueePreview(null);
    try { marquee.lease?.release(); } catch { /* lease ownership has still ended */ }
    if (marquee.current !== undefined) {
      const hits = this.#labelHits(rectFromPoints(marquee.origin, marquee.current));
      this.#runtime.select([...applyMarqueeMode(marquee.mode, marquee.baseline, hits)]);
    }
    this.#publish(false);
  }

  /**
   * Annotations whose published label rect (`geometry.of(id).label`) intersects `rect` — not the
   * leader, not the arrowhead. Off-screen annotations (`geometryOf` returns `undefined`) are
   * skipped, not thrown over.
   */
  #labelHits(rect: Rect): ReadonlySet<string> {
    const hits = new Set<string>();
    for (const annotation of this.#document.document.annotations) {
      const label = this.#runtime.geometryOf(annotation.id)?.label;
      if (label !== undefined && rectsOverlap(rect, label)) hits.add(annotation.id);
    }
    return hits;
  }

  /** Normalized 0..1 → screen pixels, the space `geometry.of` and the hit test both speak. */
  #screen(pointer: NormalizedPointerInput): Vec2 {
    const viewport = this.#runtime.viewport;
    return { x: pointer.x * viewport.width, y: pointer.y * viewport.height };
  }

  #connectInput(): void {
    const down = (event: Event): void => {
      if (!isPointerEvent(event)) return;
      this.pointerDown(normalizePointer(event, this.#boundary));
      if (this.#active === undefined && this.#marquee === undefined) return;
      // Capture routes every later move and the release here regardless of hit testing.
      //
      // Without it a drag freezes the moment the pointer leaves the label. The near-universal way to
      // mount an overlay on a 3D viewport is a `pointer-events: none` boundary — otherwise the
      // overlay swallows orbit drags — and such a boundary receives nothing except what bubbles up
      // from the annotation hit targets that re-enable events. So `pointermove` outside the label
      // never arrives, and neither does `pointerup`. Capture bypasses hit testing entirely, which is
      // exactly what it exists for.
      try {
        this.#boundary.setPointerCapture(event.pointerId);
        this.#capturedPointer = event.pointerId;
      } catch {
        // Not capturable (a detached boundary, or a jsdom-like environment). The gesture still works
        // wherever events do reach us; `leave` below stays meaningful precisely for this case.
      }
    };
    const move = (event: Event): void => {
      if (isPointerEvent(event)) this.pointerMove(normalizePointer(event, this.#boundary));
    };
    const up = (event: Event): void => {
      if (isPointerEvent(event)) this.pointerUp(normalizePointer(event, this.#boundary));
    };
    // While captured the pointer cannot escape us, so leaving the boundary is a normal part of a
    // drag rather than the end of one — dragging a label past the viewport edge and back should
    // work. Uncaptured, an exit really does mean the gesture is gone, and cancelling is right.
    const leave = (): void => {
      if (this.#capturedPointer !== undefined) return;
      this.cancel('pointer-exit');
      // No `pointermove` follows the pointer out of the boundary, so nothing else re-evaluates the
      // hover cursor — without this, leaving while over a label strands the host with `move` until
      // `dispose`. Only the uncaptured branch: mid-drag the pointer leaves and returns as a matter
      // of course, and `#hover` is skipped while a drag is live, so clearing there would drop the
      // gesture's own `move` for the rest of it. When a captured gesture really is over, the
      // browser fires `lostpointercapture` and then this handler again, uncaptured.
      this.#setCursor('');
    };
    const lost = (): void => {
      this.#capturedPointer = undefined;
      this.cancel('pointer-exit');
    };
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || (this.#active === undefined && this.#marquee === undefined)) return;
      event.preventDefault();
      this.cancel('escape');
    };
    this.#boundary.addEventListener('pointerdown', down);
    this.#boundary.addEventListener('pointermove', move);
    this.#boundary.addEventListener('pointerup', up);
    this.#boundary.addEventListener('pointerleave', leave);
    this.#boundary.addEventListener('lostpointercapture', lost);
    this.#boundary.ownerDocument.addEventListener('keydown', keyDown);
    this.#cleanup.push(
      () => this.#boundary.removeEventListener('pointerdown', down),
      () => this.#boundary.removeEventListener('pointermove', move),
      () => this.#boundary.removeEventListener('pointerup', up),
      () => this.#boundary.removeEventListener('pointerleave', leave),
      () => this.#boundary.removeEventListener('lostpointercapture', lost),
      () => this.#boundary.ownerDocument.removeEventListener('keydown', keyDown),
    );
  }

  #publish(render: boolean): void {
    this.#runtime.publishTransientChange(render);
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* editing observers are isolated */ }
    }
  }
}

/**
 * Duck-typed rather than `instanceof HTMLElement`, the same reason `isPointerEvent` is: `boundary` is
 * declared `Element` and core must not assume a DOM global exists just to test one. A boundary with
 * no `style` keeps the host's cursor instead of throwing inside a pointer handler.
 */
function hasStyle(element: Element): element is Element & ElementCSSInlineStyle {
  return 'style' in element;
}

function manualLength(route: LegRoute): number {
  return route.mode === 'manual' ? route.vertices.length : 0;
}

/** The axis-aligned rectangle between two screen points, whichever corner each was. */
function rectFromPoints(a: Vec2, b: Vec2): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Standard AABB overlap: touching edges do not count, matching `pointSegmentDistance`'s neighbours. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Combines the marquee's hits with the pre-drag selection per the drafting convention. */
function applyMarqueeMode(
  mode: 'replace' | 'add' | 'remove',
  baseline: ReadonlySet<string>,
  hits: ReadonlySet<string>,
): ReadonlySet<string> {
  if (mode === 'replace') return hits;
  const next = new Set(baseline);
  for (const id of hits) if (mode === 'add') next.add(id); else next.delete(id);
  return next;
}

function regionDragKind(handle: RegionHandle): EditingDragKind {
  return handle.kind === 'extent' ? 'region-extent' : `region-${handle.kind}`;
}

/** Empty for a rectangle or an ellipse, which `markup.ts` refuses to edit vertex by vertex. */
function regionVertices(anchor: RegionAnchor): readonly Vec2[] {
  const geometry = anchor.geometry;
  return geometry.kind === 'polygon' || geometry.kind === 'revision-cloud' ? geometry.vertices : [];
}

/**
 * Resizes a rectangle or ellipse so the grabbed corner or side follows the pointer and the opposite
 * one stays pinned. `resizeRegion` resizes about the centre, so the centre is put back afterwards —
 * two existing functions composed, rather than a third one written.
 *
 * `grab` is zero on the axis a side grip does not move, so that axis passes through untouched. The
 * absolute value lets the pointer cross the pinned side and flip the shape instead of collapsing it,
 * and a genuinely zero extent falls to `validateExtent`, which refuses it.
 */
function resizeAbout(
  anchor: RegionAnchor,
  extent: ReturnType<typeof regionLocalExtent>,
  grab: Vec2,
  delta: Vec2,
): RegionAnchor {
  const axis = (
    sign: number,
    centre: number,
    half: number,
    shift: number,
  ): Readonly<{ half: number; centre: number }> => {
    if (sign === 0) return { half, centre };
    const pinned = centre - sign * half;
    const moved = centre + sign * half + shift;
    return { half: Math.abs(moved - pinned) / 2, centre: (pinned + moved) / 2 };
  };
  const x = axis(grab.x, extent.center.x, extent.halfWidth, delta.x);
  const y = axis(grab.y, extent.center.y, extent.halfHeight, delta.y);
  const resized = resizeRegion(anchor, { width: x.half * 2, height: y.half * 2 });
  return moveRegion(resized, { x: x.centre - extent.center.x, y: y.centre - extent.center.y });}
