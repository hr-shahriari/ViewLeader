// Draws the frame: turns the laid-out plan into actual SVG.
//
// Nothing is decided here. Positions, sizes and routes all arrive already worked out, and this file
// only writes them into the DOM — which is what keeps what is drawn and what is measured in step.
//
// The other job is reuse: SVG elements are kept between frames and updated in place rather than
// rebuilt, because throwing away and recreating a few hundred nodes sixty times a second is what
// makes an overlay stutter during an orbit.
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_PADDING,
  LINE_HEIGHT,
  roundedRectanglePath,
  type ContentBounds,
} from './content.js';
import type {
  DeclarativePathCommand,
  EnclosureDefinition,
  StyleContentBox,
  StyleLanding,
  TerminatorDefinition,
} from './definitions.js';
import { CAD_PAPER, CAP_RATIO, PEN, mm, type Theme } from './theme.js';
import type { ImageFrameState } from './images.js';
import { breakAroundObstacles, type ScreenBounds } from './routing.js';
import { pointSegmentDistance } from './markup.js';
import type { ProjectedRegion, RevisionCloudArc } from './markup.js';
import type { Annotation, Rect, TextAlign, TextDirection, Vec2 } from './types.js';
import type { ViewportSnapshot } from './host.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * How big a drag handle is drawn, matching the usual CAD size.
 *
 * A fixed size on screen, deliberately: a handle is part of the interface, not part of the drawing,
 * so it must not shrink away as the camera pulls back. A host that needs finger-sized targets draws
 * its own.
 */
const GRIP_SIZE = mm(1.5);

/** How close the pointer has to get to grab a handle. Noticeably larger than the handle looks,
 *  because hitting a small square exactly is annoying. */
const GRIP_HIT_RADIUS = GRIP_SIZE;

/**
 * An arrowhead sized for the screen, drawn with its tip at the origin pointing backwards.
 *
 * Kept that way so placing one is only a move and a rotation — the shape itself never has to be
 * recalculated as the leader swings about.
 */
export interface RenderTerminator {
  readonly path: string;
  readonly fill: 'filled' | 'outline';
  /** How far the head extends back from its point, so the line can stop where the head starts. */
  readonly length: number;
}

export interface RenderStyle {
  readonly lineColor: string;
  readonly lineWidth: number;
  readonly textColor: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  /** What is drawn where the leader meets the model — usually an arrowhead. */
  readonly terminator?: RenderTerminator;
  /** What is drawn where the leader meets the label. Usually nothing. */
  readonly labelTerminator?: RenderTerminator;
  /** The shape drawn around the label. Without one the label keeps its own plain box. */
  readonly enclosure?: EnclosureDefinition;
  /** How that shape is painted: fill, border, padding. */
  readonly contentBox?: StyleContentBox;
  /** How the leader's tail meets the label. Anything unset falls back to the default. */
  readonly landing?: StyleLanding;
}

/**
 * Stretches a label's outline shape to fit the text inside it.
 *
 * A shape with rounded corners is rebuilt rather than stretched, because a corner radius is
 * measured in pixels and stretching one unevenly would turn a round corner into an oval one.
 */
export function fitEnclosurePath(
  definition: EnclosureDefinition,
  bounds: ContentBounds,
  borderRadius = 0,
): string {
  if (definition.corners === 'radiused' && borderRadius > 0) {
    return roundedRectanglePath(bounds, Math.min(borderRadius, bounds.width / 2, bounds.height / 2));
  }
  const scaleX = bounds.width / definition.bounds.width;
  const scaleY = bounds.height / definition.bounds.height;
  return commandPath(definition.commands.map((command) => mapCommand(command, {
    scaleX,
    scaleY,
    offsetX: bounds.x - definition.bounds.x * scaleX,
    offsetY: bounds.y - definition.bounds.y * scaleY,
  })));
}

/**
 * Sizes an arrowhead from the text it belongs to, which is what drafting standards specify — an
 * arrowhead is as long as the lettering is tall. So the size comes from the style, not from the
 * arrowhead's own definition.
 */
export function resolveTerminator(
  definition: TerminatorDefinition,
  style: Pick<RenderStyle, 'lineWidth' | 'fontSize'>,
): RenderTerminator {
  const scale = definition.sizing === 'line-width'
    ? style.lineWidth
    : style.fontSize * CAP_RATIO;
  return {
    path: commandPath(definition.commands.map((command) =>
      mapCommand(command, { scaleX: scale, scaleY: scale, offsetX: 0, offsetY: 0 }))),
    fill: definition.fill,
    length: Math.max(0, -definition.bounds.x) * scale,
  };
}

/**
 * Where the first and last lines of text sit inside a label.
 *
 * Leaders are meant to arrive level with a line of text rather than wherever a line happens to
 * strike the edge of the box. A label with no text at all — an image, a plugin's own shapes — has
 * no lines to aim at, and the leader meets it halfway up instead.
 */
export function textLineOffsets(
  layout: RenderableContentLayout,
): Readonly<{ first: number; last: number }> | undefined {
  // A scaled label puts its contents inside a group with the scale on it, so the scale has to be
  // read from the group rather than from the label.
  const [only] = layout.primitives;
  const group = only?.kind === 'group' && layout.primitives.length === 1 ? only : undefined;
  const scale = group?.scale ?? 1;
  const centres = (group?.children ?? layout.primitives).flatMap((primitive) =>
    primitive.kind === 'text'
      ? [(primitive.bounds.y + primitive.bounds.height / 2) * scale - layout.bounds.y]
      : []);
  return centres.length === 0
    ? undefined
    : Object.freeze({ first: Math.min(...centres), last: Math.max(...centres) });
}

interface PrimitiveBase {
  readonly bounds: ContentBounds;
  readonly zIndex: number;
  readonly accessibility?: Readonly<{
    role: 'img' | 'text' | 'button' | 'group';
    label: string;
    description?: string;
  }>;
}

export interface RenderTextPrimitive extends PrimitiveBase {
  readonly kind: 'text';
  readonly position: Vec2;
  readonly text: string;
  readonly direction: TextDirection;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly code: boolean;
  readonly align: TextAlign;
}

export interface RenderPathPrimitive extends PrimitiveBase {
  readonly kind: 'path';
  readonly path?: string;
  readonly commands?: readonly DeclarativePathCommand[];
  readonly fill: 'none' | 'solid';
  /** Replaces the style's line and text colours for this one shape. */
  readonly paint?: Readonly<{
    fill?: string;
    fillOpacity?: number;
    stroke?: string;
    strokeWidth?: number;
  }>;
}

export interface RenderImagePrimitive extends PrimitiveBase {
  readonly kind: 'image';
  readonly reference: string;
  readonly alt: string;
  readonly state: ImageFrameState;
}

export interface RenderGroupPrimitive extends PrimitiveBase {
  readonly kind: 'group';
  readonly children: readonly RenderPrimitive[];
  readonly scale?: number;
}

export interface RenderHitRegionPrimitive extends PrimitiveBase {
  readonly kind: 'hit-region';
  readonly interactionId: string;
  readonly cursor?: 'default' | 'pointer' | 'text' | 'move' | 'crosshair';
}

export type RenderPrimitive =
  | RenderTextPrimitive
  | RenderPathPrimitive
  | RenderImagePrimitive
  | RenderGroupPrimitive
  | RenderHitRegionPrimitive;

export interface RenderableContentLayout {
  readonly bounds: ContentBounds;
  readonly primitives: readonly RenderPrimitive[];
  readonly accessibleText: string;
  readonly direction: TextDirection;
}

export interface PlannedLeg {
  readonly id: string;
  /** The leader line's final path on screen, once labels have been placed. */
  readonly points: readonly Vec2[];
  /**
   * Other labels this leader passes underneath, so a gap can be left where it crosses them.
   *
   * Worked out once and carried here rather than recalculated when drawing, because the standards
   * check has to grade exactly the pieces that get drawn. Two separate answers to "which labels are
   * in the way" is how the drawing and its grade come to disagree.
   */
  readonly obstacles?: readonly ScreenBounds[];
  /**
   * This leader points at something hidden, so it is drawn dashed.
   *
   * Recorded per leader rather than per annotation, because that is the only place the distinction
   * exists: a note with two leaders disappearing into a floor and one in open air has a single
   * label but needs two different answers.
   */
  readonly occluded?: boolean;
  readonly region?: ProjectedRegion;
  readonly cloudArcs?: readonly RevisionCloudArc[];
}

export interface PlannedAnnotation {
  readonly annotation: Annotation;
  readonly labelPosition: Vec2;
  readonly layout: RenderableContentLayout;
  readonly legs: readonly PlannedLeg[];
  readonly style: RenderStyle;
  readonly opacity: number;
}

export interface PlannedInk {
  readonly id: string;
  readonly points: readonly Vec2[];
  readonly style: RenderStyle;
  readonly accessibleText: string;
}

/** Copied rather than shared, so a host cannot move the layout by writing into the geometry it was
 *  handed to read. */
function frozenPoint(point: Vec2): Vec2 {
  return Object.freeze({ x: point.x, y: point.y });
}

/** The handle at a leader's arrow end. Its `target` is the leader's id, so it can be passed
 *  straight to `annotations.retarget`. */
export interface AnnotationHandle {
  readonly target: string;
  readonly index: number;
  readonly at: Vec2;
}

/**
 * A handle on the leader line itself, as opposed to on its arrow end. Dragging an arrow points it
 * somewhere new; dragging the line changes its shape.
 *
 * A vertex handle sits on an existing bend and moves it. A midpoint handle sits on a straight run
 * and creates a bend there. A leader that routes itself offers exactly one midpoint — its whole
 * length — because the first drag on it produces one bend and nothing more.
 */
export interface RouteHandle {
  readonly target: string;
  readonly kind: 'vertex' | 'midpoint';
  readonly index: number;
  readonly at: Vec2;
}

/**
 * A handle on a marked-up region — the cloud or rectangle itself, not the leader pointing at it.
 * The third kind: one retargets a leader, one reshapes a leader, and this one reshapes the region.
 *
 * An extent handle resizes a rectangle or ellipse, and records which corner or edge is moving so
 * the opposite side can stay pinned rather than the shape growing about its centre. Vertex and
 * midpoint handles edit a polygon or a revision cloud exactly as they do on a leader.
 *
 * A rectangle has no vertices to edit and a polygon has no extent to resize, so the two kinds never
 * appear on the same region.
 */
export type RegionHandle =
  | {
    readonly target: string;
    readonly kind: 'extent';
    readonly grab: Vec2;
    readonly at: Vec2;
  }
  | {
    readonly target: string;
    readonly kind: 'vertex' | 'midpoint';
    readonly index: number;
    readonly at: Vec2;
  };

/**
 * Works out where a region's drag handles sit, taken straight from the outline just drawn.
 *
 * Nothing is projected again here. The handles are read off the same points the renderer used, so
 * handle and shape cannot drift apart no matter how the camera moves.
 *
 * An ellipse's handles are found from how many points its outline has rather than from a fixed
 * table, so changing how finely it is drawn cannot silently put the handles in the wrong place.
 */
function regionHandlesForLeg(leg: PlannedLeg): RegionHandle[] {
  const region = leg.region;
  if (region === undefined || region.points.length < 3) return [];
  const points = region.points;
  if (region.kind === 'rectangle') {
    const corners: readonly Vec2[] = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
    return points.length === 4
      ? [
        ...points.map((at, index) => extentHandle(leg.id, corners[index]!, at)),
        ...points.map((at, index) => extentHandle(
          leg.id,
          midpointGrab(corners[index]!, corners[(index + 1) % 4]!),
          { x: (at.x + points[(index + 1) % 4]!.x) / 2, y: (at.y + points[(index + 1) % 4]!.y) / 2 },
        )),
      ]
      : [];
  }
  if (region.kind === 'ellipse') {
    const quarter = points.length / 4;
    if (!Number.isInteger(quarter)) return [];
    // The outline starts at the right-hand end and runs anticlockwise around the shape.
    const grabs: readonly Vec2[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
    return grabs.map((grab, index) => extentHandle(leg.id, grab, points[index * quarter]!));
  }
  return [
    ...points.map((at, index) => Object.freeze({
      target: leg.id, kind: 'vertex' as const, index, at: frozenPoint(at),
    })),
    // Each midpoint handle sits between two corners, and creates a new corner in exactly that
    // place. The last one spans the closing edge and adds to the end of the list.
    ...points.map((at, index) => {
      const next = points[(index + 1) % points.length]!;
      return Object.freeze({
        target: leg.id,
        kind: 'midpoint' as const,
        index: index + 1,
        at: frozenPoint({ x: (at.x + next.x) / 2, y: (at.y + next.y) / 2 }),
      });
    }),
  ];
}

function extentHandle(target: string, grab: Vec2, at: Vec2): RegionHandle {
  return Object.freeze({ target, kind: 'extent' as const, grab: frozenPoint(grab), at: frozenPoint(at) });
}

/** Which way an edge handle resizes: the direction its two corners have in common, and free on the
 *  direction they do not. */
function midpointGrab(from: Vec2, to: Vec2): Vec2 {
  return { x: from.x === to.x ? from.x : 0, y: from.y === to.y ? from.y : 0 };
}

/**
 * Works out the handles on a leader line: one on every existing bend, plus one in the middle of each
 * straight run where a drag would create a new bend.
 */
function routeHandlesForLeg(leg: PlannedLeg, routing: Annotation['anchors'][number]['routing'],
  points: readonly Vec2[]): RouteHandle[] {
  if (points.length < 2) return [];
  if (routing.kind !== 'manual') {
    // A leader with no bends yet gets a single handle in its middle: grab it and pull a bend out.
    const middle = midpointOf(points);
    return middle === undefined
      ? []
      : [Object.freeze({ target: leg.id, kind: 'midpoint' as const, index: 0, at: frozenPoint(middle) })];
  }
  const handles: RouteHandle[] = [];
  routing.vertices.forEach((_, index) => {
    const at = points[index + 1];
    if (at !== undefined) {
      handles.push(Object.freeze({ target: leg.id, kind: 'vertex' as const, index, at: frozenPoint(at) }));
    }
  });
  for (let index = 0; index + 1 < points.length; index += 1) {
    handles.push(Object.freeze({
      target: leg.id,
      kind: 'midpoint' as const,
      index,
      at: frozenPoint({
        x: (points[index]!.x + points[index + 1]!.x) / 2,
        y: (points[index]!.y + points[index + 1]!.y) / 2,
      }),
    }));
  }
  return handles;
}

/** The halfway point measured along the line itself, so the handle sits on a bent line rather than
 *  floating beside it. */
function midpointOf(points: readonly Vec2[]): Vec2 | undefined {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return points[0];
  let travelled = 0;
  for (const [index, length] of lengths.entries()) {
    if (travelled + length >= total / 2) {
      const ratio = length === 0 ? 0 : (total / 2 - travelled) / length;
      const from = points[index]!;
      const to = points[index + 1]!;
      return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
    }
    travelled += length;
  }
  return points.at(-1);
}

/**
 * Everything needed to place a text input over a label and have it look identical to the label.
 *
 * These are the values actually drawn with, not the ones the style names. Reading the style instead
 * gets three things wrong: a per-annotation colour override, an alignment that came from the kind
 * of content rather than the style, and a padding that fell back to a default. Each puts a host's
 * edit box visibly out of place.
 */
export interface AnnotationTextMetrics {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly textColor: string;
  /** As drawn, including any default the content kind supplied rather than the style. */
  readonly align: TextAlign;
  /**
   * The gap between the label's edge and its text, in screen pixels like everything else here.
   *
   * The style's own padding is in layout units, which are scaled by the text size before drawing.
   * Reporting the unscaled number puts a host's edit box in the wrong place at every size except
   * one.
   */
  readonly padding: number;
  /** As drawn — needed for the same reason as the colour. */
  readonly weight: 'normal' | 'bold';
}

export interface AnnotationScreenGeometry {
  /** The label box as drawn this frame, in screen pixels. */
  readonly label: Rect;
  /** One line per leader, trimmed exactly as drawn — stopping short where an arrowhead begins,
   *  so the reported line matches the visible one. */
  readonly legs: readonly (readonly Vec2[])[];
  readonly handles: readonly AnnotationHandle[];
  /** Handles on the leader lines: existing bends, plus where a drag would create a new one. */
  readonly routeHandles: readonly RouteHandle[];
  /** Handles on a marked-up region's outline. Empty for anything not anchored to a region. */
  readonly regionHandles: readonly RegionHandle[];
  readonly text: AnnotationTextMetrics;
}

/**
 * Where a freehand stroke is on screen. Every point is a handle, so the list of points is the list
 * of handles and there is no second array to keep in step.
 *
 * A stroke is drawn all or not at all, so position `i` here is always stored point `i` — which is
 * what makes it possible to edit a point from the handle at all.
 */
export interface InkScreenGeometry {
  readonly points: readonly Vec2[];
}

export function inkScreenGeometry(
  plan: readonly PlannedInk[],
  id: string,
): InkScreenGeometry | undefined {
  const entry = plan.find((candidate) => candidate.id === id);
  return entry === undefined
    ? undefined
    : Object.freeze({ points: Object.freeze(entry.points.map(frozenPoint)) });
}

/**
 * Where one annotation is on screen right now.
 *
 * Something you ask for rather than subscribe to — a per-frame subscription firing into a host's own
 * render loop is the performance trap this avoids. Valid only until the next redraw; orbiting or
 * resizing changes every field.
 *
 * Leader lines are trimmed exactly as drawn, so a host drawing over one, or testing a selection box
 * against it, sees the same pixels the user does rather than the full-length line the arrowhead is
 * positioned against.
 */
export function annotationScreenGeometry(
  plan: readonly PlannedAnnotation[],
  id: string,
): AnnotationScreenGeometry | undefined {
  const entry = plan.find((candidate) => candidate.annotation.id === id);
  if (entry === undefined) return undefined;
  const label = Object.freeze({
    x: entry.labelPosition.x + entry.layout.bounds.x,
    y: entry.labelPosition.y + entry.layout.bounds.y,
    width: entry.layout.bounds.width,
    height: entry.layout.bounds.height,
  });
  const legs = Object.freeze(
    entry.legs.map((leg) => Object.freeze(clearAnchorHead(leg.points, entry.style).map(frozenPoint))),
  );
  const handles = Object.freeze(entry.legs.flatMap((leg, index): AnnotationHandle[] => {
    const [at] = leg.points;
    return at === undefined ? [] : [Object.freeze({ target: leg.id, index, at: frozenPoint(at) })];
  }));
  const routingByLeg = new Map(entry.annotation.anchors.map((leg) => [leg.id, leg.routing] as const));
  const routeHandles = Object.freeze(entry.legs.flatMap((leg, index) => {
    const routing = routingByLeg.get(leg.id);
    return routing === undefined ? [] : routeHandlesForLeg(leg, routing, legs[index] ?? []);
  }));
  const regionHandles = Object.freeze(entry.legs.flatMap(regionHandlesForLeg));
  const text = Object.freeze({
    fontFamily: entry.style.fontFamily,
    fontSize: entry.style.fontSize,
    lineHeight: LINE_HEIGHT * (entry.style.fontSize / DEFAULT_FONT_SIZE),
    textColor: entry.style.textColor,
    align: drawnAlign(entry.layout),
    // Scaled by exactly the same factor the label itself is, so this is the padding really drawn.
    padding: (entry.style.contentBox?.padding ?? DEFAULT_PADDING)
      * (entry.style.fontSize / DEFAULT_FONT_SIZE),
    weight: firstRun(entry.layout)?.bold === true ? 'bold' : 'normal',
  });
  return Object.freeze({ label, legs, handles, routeHandles, regionHandles, text });
}

export type ScreenHitKind =
  | 'handle'
  | 'route-handle'
  | 'region-handle'
  | 'label'
  | 'leader'
  | 'region'
  | 'ink'
  | 'ink-point';

/**
 * What the pointer is over.
 *
 * For freehand ink the id is a stroke id rather than an annotation id — ink is not an annotation,
 * and looking it up with `annotations.get` will not find it. The `kind` says which you have.
 */
export interface ScreenHit {
  readonly id: string;
  readonly kind: ScreenHitKind;
  readonly legId?: string;
  /**
   * Which handle was hit, as a position in whichever list `kind` names — `handles`, `routeHandles`,
   * `regionHandles`, or an ink stroke's `points`. Absent when the hit was not on a handle.
   */
  readonly index?: number;
}

/**
 * Finds the topmost thing under a point, measured against the same plan that was drawn.
 *
 * Worked out geometrically rather than by asking the browser, so that a host driving editing from a
 * script — with no pointer events and no page layout at all — gets exactly the same answer. That
 * headless path is the one the tests exercise, which is what keeps the two honest.
 *
 * Labels beat leader lines, because a line crossing a box passes behind it.
 */
export function hitTestPlan(
  plan: readonly PlannedAnnotation[],
  at: Vec2,
  tolerance: number,
  grippable?: ReadonlySet<string>,
): ScreenHit | undefined {
  // Handles beat everything, even handles belonging to other annotations. Someone who can see a
  // handle expects to be able to grab it, and handles sit at the arrow end where labels and other
  // leaders routinely pile up.
  if (grippable !== undefined && grippable.size > 0) {
    for (let index = plan.length - 1; index >= 0; index -= 1) {
      const entry = plan[index]!;
      if (!grippable.has(entry.annotation.id)) continue;
      const published = annotationScreenGeometry(plan, entry.annotation.id);
      // Region handles beat the arrow handle where they overlap, which happens when a leader
      // attaches at a corner. Resizing is the everyday gesture; a resize that silently became
      // "move this onto a different surface" is a much worse surprise than the other way round.
      const regionHandles = published?.regionHandles ?? [];
      const region = regionHandles.findIndex((handle) =>
        Math.hypot(at.x - handle.at.x, at.y - handle.at.y) <= GRIP_HIT_RADIUS);
      if (region !== -1) {
        return Object.freeze({
          id: entry.annotation.id,
          kind: 'region-handle' as const,
          legId: regionHandles[region]!.target,
          index: region,
        });
      }
      for (const [legIndex, leg] of entry.legs.entries()) {
        const grip = leg.points[0];
        if (grip === undefined) continue;
        if (Math.hypot(at.x - grip.x, at.y - grip.y) > GRIP_HIT_RADIUS) continue;
        return Object.freeze({
          id: entry.annotation.id,
          kind: 'handle' as const,
          legId: leg.id,
          index: legIndex,
        });
      }
      // Existing bends beat the midpoints that create new ones. They sit close together on a
      // hand-drawn leader, and moving the bend you can see is more likely intended than adding one
      // you cannot.
      const routeHandles = published?.routeHandles ?? [];
      for (const kind of ['vertex', 'midpoint'] as const) {
        const found = routeHandles.findIndex((handle) =>
          handle.kind === kind && Math.hypot(at.x - handle.at.x, at.y - handle.at.y) <= GRIP_HIT_RADIUS);
        if (found !== -1) {
          return Object.freeze({
            id: entry.annotation.id,
            kind: 'route-handle' as const,
            legId: routeHandles[found]!.target,
            index: found,
          });
        }
      }
    }
  }
  // Things drawn later are on top, so search backwards to find the topmost first.
  for (let index = plan.length - 1; index >= 0; index -= 1) {
    const entry = plan[index]!;
    const x = entry.labelPosition.x + entry.layout.bounds.x;
    const y = entry.labelPosition.y + entry.layout.bounds.y;
    if (
      at.x >= x && at.x <= x + entry.layout.bounds.width &&
      at.y >= y && at.y <= y + entry.layout.bounds.height
    ) {
      return Object.freeze({ id: entry.annotation.id, kind: 'label' as const });
    }
    for (const leg of entry.legs) {
      const points = clearAnchorHead(leg.points, entry.style);
      for (let step = 1; step < points.length; step += 1) {
        if (pointSegmentDistance(at, points[step - 1]!, points[step]!) <= tolerance) {
          return Object.freeze({ id: entry.annotation.id, kind: 'leader' as const, legId: leg.id });
        }
      }
    }
    // Regions come last within an annotation, matching what is drawn: the region goes down first
    // and the leader is drawn over it.
    for (const leg of entry.legs) {
      if (leg.region !== undefined && onOutline(at, leg.region.points, tolerance)) {
        return Object.freeze({ id: entry.annotation.id, kind: 'region' as const, legId: leg.id });
      }
    }
  }
  return undefined;
}

/**
 * Finds the freehand stroke under a point, or one of its handles.
 *
 * Asked after annotations rather than alongside them, because ink is drawn underneath annotations.
 * Annotations winning is simply the drawing order, not a rule anybody chose.
 */
export function hitTestInkPlan(
  plan: readonly PlannedInk[],
  at: Vec2,
  tolerance: number,
  grippable?: ReadonlySet<string>,
): ScreenHit | undefined {
  for (let index = plan.length - 1; index >= 0; index -= 1) {
    const entry = plan[index]!;
    if (grippable?.has(entry.id) === true) {
      const point = entry.points.findIndex((candidate) =>
        Math.hypot(at.x - candidate.x, at.y - candidate.y) <= GRIP_HIT_RADIUS);
      if (point !== -1) {
        return Object.freeze({ id: entry.id, kind: 'ink-point' as const, index: point });
      }
    }
    for (let step = 1; step < entry.points.length; step += 1) {
      if (pointSegmentDistance(at, entry.points[step - 1]!, entry.points[step]!) <= tolerance) {
        return Object.freeze({ id: entry.id, kind: 'ink' as const });
      }
    }
  }
  return undefined;
}

/** The label's first piece of text, which is where the final alignment and weight can be read. */
function firstRun(layout: RenderableContentLayout): RenderTextPrimitive | undefined {
  const [only] = layout.primitives;
  const group = only?.kind === 'group' && layout.primitives.length === 1 ? only : undefined;
  for (const primitive of group?.children ?? layout.primitives) {
    if (primitive.kind === 'text') return primitive;
  }
  return undefined;
}

function drawnAlign(layout: RenderableContentLayout): TextAlign {
  return firstRun(layout)?.align ?? 'start';
}

/** How far a point is from a shape's outline, so grabbing a region means grabbing its edge rather
 *  than anywhere inside it. */
function onOutline(at: Vec2, points: readonly Vec2[], tolerance: number): boolean {
  return points.some((point, index) =>
    pointSegmentDistance(at, point, points[(index + 1) % points.length]!) <= tolerance);
}

interface SvgOverlayOptions {
  readonly boundary: Element;
  readonly select: (id: string, toggle: boolean) => void;
  /** Ink has its own selection. It is not an annotation, so putting its ids in with the
   *  annotations would publish ids that `annotations.get` cannot resolve. */
  readonly selectInk: (id: string, toggle: boolean) => void;
  readonly hover: (id: string | null) => void;
  /** False when the host has taken over drawing the handles itself. */
  readonly handles: boolean;
  /** Colours for the overlay's own interface bits — the selection box, and plugin previews. */
  readonly theme?: Theme;
}

export class SvgOverlay {
  readonly #boundary: Element;
  readonly #select: (id: string, toggle: boolean) => void;
  readonly #selectInk: (id: string, toggle: boolean) => void;
  readonly #hover: (id: string | null) => void;
  readonly #handles: boolean;
  readonly #chrome: RenderStyle;
  readonly #root: SVGSVGElement;
  readonly #annotationGroups = new Map<string, CachedAnnotationGroup>();
  readonly #inkGroups = new Map<string, CachedInkGroup>();
  #pluginPreview: SVGGElement | undefined;
  #marquee: SVGRectElement | undefined;
  #selected = new Set<string>();
  #selectedInk = new Set<string>();
  #disposed = false;

  public constructor(options: SvgOverlayOptions) {
    this.#boundary = options.boundary;
    this.#select = options.select;
    this.#selectInk = options.selectInk;
    this.#hover = options.hover;
    this.#handles = options.handles;
    this.#chrome = defaultRenderStyle(options.theme);
    const document = options.boundary.ownerDocument;
    this.#root = document.createElementNS(SVG_NS, 'svg');
    this.#root.setAttribute('data-viewleader-overlay', '');
    this.#root.setAttribute('role', 'group');
    this.#root.setAttribute('aria-label', 'Annotations');
    this.#root.setAttribute('focusable', 'false');
    Object.assign(this.#root.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'visible',
      pointerEvents: 'none',
      width: '100%',
      height: '100%',
    });
    this.#boundary.appendChild(this.#root);
  }

  public get element(): SVGSVGElement {
    return this.#root;
  }

  public render(
    annotations: readonly PlannedAnnotation[],
    ink: readonly PlannedInk[],
    viewport: ViewportSnapshot,
  ): void {
    if (this.#disposed) return;
    this.#root.setAttribute('viewBox', `0 0 ${format(viewport.width)} ${format(viewport.height)}`);
    this.#root.setAttribute('width', format(viewport.width));
    this.#root.setAttribute('height', format(viewport.height));
    this.#root.setAttribute('data-device-pixel-ratio', format(viewport.devicePixelRatio));
    const desired: SVGElement[] = [];
    const currentInk = new Set(ink.map(({ id }) => id));
    const currentAnnotations = new Set(annotations.map(({ annotation }) => annotation.id));
    for (const [id, cached] of this.#inkGroups) {
      if (!currentInk.has(id)) {
        cached.group.remove();
        this.#inkGroups.delete(id);
      }
    }
    for (const [id, cached] of this.#annotationGroups) {
      if (!currentAnnotations.has(id)) {
        cached.group.remove();
        this.#annotationGroups.delete(id);
      }
    }
    for (const entry of ink) {
      let cached = this.#inkGroups.get(entry.id);
      if (cached === undefined) {
        const group = this.#renderInk(entry);
        cached = {
          group,
          visible: group.querySelector<SVGPathElement>(':scope > path[data-ink-stroke]')!,
          hit: group.querySelector<SVGPathElement>(':scope > path[data-hit-target="ink"]')!,
          grips: group.querySelector<SVGGElement>(':scope > g[data-ink-handles]'),
        };
        this.#inkGroups.set(entry.id, cached);
      } else {
        this.#updateInk(cached, entry);
      }
      desired.push(cached.group);
    }
    for (const entry of annotations) {
      const id = entry.annotation.id;
      const signature = annotationStructureSignature(entry);
      let cached = this.#annotationGroups.get(id);
      if (cached === undefined || cached.signature !== signature) {
        cached?.group.remove();
        const group = this.#renderAnnotation(entry);
        cached = {
          group,
          signature,
          routes: [...group.querySelectorAll<SVGPathElement>(':scope > path[data-route-visible]')],
          routeHits: [...group.querySelectorAll<SVGPathElement>(':scope > path[data-hit-target="leader"]')],
          regions: [...group.querySelectorAll<SVGPathElement>(':scope > path[data-region-kind]')],
          regionHits: [...group.querySelectorAll<SVGPathElement>(':scope > path[data-hit-target="region"]')],
          heads: [...group.querySelectorAll<SVGPathElement>(':scope > path[data-terminator]')].map((element) => ({
            element,
            legIndex: Number(element.dataset.legIndex),
            end: element.dataset.terminator as 'anchor' | 'label',
          })),
          grips: [...group.querySelectorAll<SVGRectElement>(':scope > rect[data-handle]')],
          routeGrips: group.querySelector<SVGGElement>(':scope > g[data-route-handles]'),
          regionGrips: group.querySelector<SVGGElement>(':scope > g[data-region-handles]'),
          label: group.querySelector<SVGGElement>(':scope > g[data-hit-target="label"]')!,
        };
        this.#annotationGroups.set(id, cached);
      } else {
        this.#updateAnnotation(cached, entry);
      }
      desired.push(cached.group);
    }
    this.#reconcileOrder(desired);
  }

  public setSelection(ids: Iterable<string>): void {
    this.#selected = new Set(ids);
    for (const [id, { group, grips }] of this.#annotationGroups) {
      const selected = this.#selected.has(id);
      group.classList.toggle('viewleader-selected', selected);
      group.setAttribute('aria-pressed', String(selected));
      // The handles already exist. Selecting only decides whether they are visible, so this needs
      // no redraw.
      for (const grip of grips) {
        grip.style.display = selected && grip.getAttribute('x') !== null ? '' : 'none';
      }
      for (const grips of [
        this.#annotationGroups.get(id)?.routeGrips,
        this.#annotationGroups.get(id)?.regionGrips,
      ]) {
        if (grips !== null && grips !== undefined) grips.style.display = selected ? '' : 'none';
      }
    }
  }

  /**
   * Selects a freehand stroke, kept separate from selecting annotations.
   *
   * Ink is stored separately, has no leader and no label, and cannot be selected as an annotation —
   * mixing the two would publish ids that nothing can look up. Clicking a stroke sets this, exactly
   * as clicking a label sets the other.
   */
  public setInkSelection(ids: Iterable<string>): void {
    this.#selectedInk = new Set(ids);
    for (const [id, { grips }] of this.#inkGroups) {
      if (grips !== null) grips.style.display = this.#selectedInk.has(id) ? '' : 'none';
    }
  }

  public renderPluginPreview(primitives: readonly RenderPrimitive[]): void {
    this.#pluginPreview?.remove();
    this.#pluginPreview = undefined;
    if (primitives.length === 0 || this.#disposed) return;
    const group = this.#boundary.ownerDocument.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-viewleader-plugin-preview', '');
    group.setAttribute('role', 'img');
    group.setAttribute('aria-label', 'Plugin authoring preview');
    group.setAttribute('transform', 'translate(12 12)');
    group.style.pointerEvents = 'none';
    for (const primitive of sortedPrimitives(primitives)) {
      group.appendChild(this.#renderPrimitive(primitive, this.#chrome, 'plugin-preview'));
    }
    this.#root.appendChild(group);
    this.#pluginPreview = group;
  }

  /**
   * Draws the dashed selection rectangle, or clears it with `null`.
   *
   * Already in screen coordinates, so unlike everything else it needs no projection and no redraw —
   * it is part of the interface rather than part of the drawing.
   */
  public setMarquee(rect: Rect | null): void {
    if (rect === null || this.#disposed) {
      this.#marquee?.remove();
      this.#marquee = undefined;
      return;
    }
    if (this.#marquee === undefined) {
      const marquee = this.#boundary.ownerDocument.createElementNS(SVG_NS, 'rect');
      marquee.setAttribute('data-viewleader-marquee', '');
      marquee.setAttribute('fill', 'none');
      marquee.setAttribute('stroke', this.#chrome.lineColor);
      marquee.setAttribute('stroke-width', format(this.#chrome.lineWidth));
      marquee.setAttribute('stroke-dasharray', '4 3');
      marquee.setAttribute('vector-effect', 'non-scaling-stroke');
      marquee.style.pointerEvents = 'none';
      this.#root.appendChild(marquee);
      this.#marquee = marquee;
    }
    this.#marquee.setAttribute('x', format(rect.x));
    this.#marquee.setAttribute('y', format(rect.y));
    this.#marquee.setAttribute('width', format(rect.width));
    this.#marquee.setAttribute('height', format(rect.height));
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#hover(null);
    this.#annotationGroups.clear();
    this.#inkGroups.clear();
    this.#pluginPreview = undefined;
    this.#marquee = undefined;
    this.#root.remove();
  }

  #renderAnnotation(entry: PlannedAnnotation): SVGGElement {
    const document = this.#boundary.ownerDocument;
    const group = document.createElementNS(SVG_NS, 'g');
    group.dataset.annotationId = entry.annotation.id;
    group.setAttribute('role', 'button');
    group.setAttribute('tabindex', '0');
    group.setAttribute('aria-label', entry.layout.accessibleText || 'Empty annotation');
    group.setAttribute('aria-pressed', String(this.#selected.has(entry.annotation.id)));
    group.setAttribute('opacity', format(entry.opacity));
    group.style.pointerEvents = 'none';

    entry.legs.forEach((leg, index) => {
      if (leg.region !== undefined) {
        this.#appendRegion(group, leg, entry.annotation.id, entry.style);
      }
      const route = pointPath(clearAnchorHead(leg.points, entry.style), false);
      const visible = document.createElementNS(SVG_NS, 'path');
      visible.setAttribute('d', drawnRoutePath(leg, entry.style));
      visible.setAttribute('data-route-visible', '');
      visible.dataset.legId = leg.id;
      setStroke(visible, entry.style);
      setOccludedStroke(visible, leg.occluded === true);
      visible.style.pointerEvents = 'none';
      group.appendChild(visible);

      const hit = document.createElementNS(SVG_NS, 'path');
      hit.setAttribute('d', route);
      hit.setAttribute('fill', 'none');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '12');
      hit.setAttribute('data-hit-target', 'leader');
      hit.dataset.legId = leg.id;
      hit.style.pointerEvents = 'stroke';
      this.#wireHitTarget(hit, entry.annotation.id);
      group.appendChild(hit);

      // Drawn after the line, so a solid arrowhead covers the end of the line it sits on.
      this.#appendTerminator(group, entry.style.terminator, leg, index, 'anchor', entry.style);
      this.#appendTerminator(group, entry.style.labelTerminator, leg, index, 'label', entry.style);
    });

    const label = document.createElementNS(SVG_NS, 'g');
    label.setAttribute(
      'transform',
      `translate(${format(entry.labelPosition.x)} ${format(entry.labelPosition.y)})`,
    );
    label.setAttribute('data-hit-target', 'label');
    label.style.pointerEvents = 'all';
    const hitRect = document.createElementNS(SVG_NS, 'rect');
    hitRect.setAttribute('x', format(entry.layout.bounds.x - 4));
    hitRect.setAttribute('y', format(entry.layout.bounds.y - 4));
    hitRect.setAttribute('width', format(entry.layout.bounds.width + 8));
    hitRect.setAttribute('height', format(entry.layout.bounds.height + 8));
    hitRect.setAttribute('fill', 'transparent');
    hitRect.setAttribute('stroke', 'transparent');
    label.appendChild(hitRect);
    for (const primitive of sortedPrimitives(entry.layout.primitives)) {
      label.appendChild(this.#renderPrimitive(primitive, entry.style, entry.annotation.id));
    }
    this.#wireHitTarget(label, entry.annotation.id);
    group.appendChild(label);

    // Handles last, so they sit on top of the label and leader. Built even when nothing is
    // selected and simply hidden, so selecting something never has to rebuild anything. Not built
    // at all when the host draws its own.
    if (this.#handles) {
      entry.legs.forEach((leg, index) => {
        group.appendChild(this.#renderGrip(entry, leg, index));
      });
      // Route grips are rebuilt rather than cached: their count changes with the vertex count, which
      // `annotationStructureSignature` already tracks through the leg routing.
      group.appendChild(this.#renderRouteGrips(entry));
      group.appendChild(this.#renderRegionGrips(entry));
    }

    group.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.#select(entry.annotation.id, event.metaKey || event.ctrlKey || event.shiftKey);
    });
    return group;
  }

  #renderInk(entry: PlannedInk): SVGGElement {
    const document = this.#boundary.ownerDocument;
    const group = document.createElementNS(SVG_NS, 'g');
    group.dataset.inkId = entry.id;
    group.setAttribute('role', 'img');
    group.setAttribute('aria-label', entry.accessibleText);
    const route = pointPath(entry.points, false);
    const visible = document.createElementNS(SVG_NS, 'path');
    visible.setAttribute('d', route);
    setStroke(visible, entry.style);
    visible.setAttribute('data-ink-stroke', '');
    group.appendChild(visible);
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', route);
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '12');
    hit.setAttribute('data-hit-target', 'ink');
    hit.style.pointerEvents = 'stroke';
    hit.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#selectInk(entry.id, event.metaKey || event.ctrlKey || event.shiftKey);
    });
    group.appendChild(hit);
    if (this.#handles) group.appendChild(this.#renderInkGrips(entry));
    return group;
  }

  #updateAnnotation(cached: CachedAnnotationGroup, entry: PlannedAnnotation): void {
    cached.group.setAttribute('opacity', format(entry.opacity));
    let regionIndex = 0;
    entry.legs.forEach((leg, index) => {
      const route = pointPath(clearAnchorHead(leg.points, entry.style), false);
      const visible = cached.routes[index];
      if (visible !== undefined) {
        visible.setAttribute('d', drawnRoutePath(leg, entry.style));
        setOccludedStroke(visible, leg.occluded === true);
      }
      cached.routeHits[index]?.setAttribute('d', route);
      if (leg.region !== undefined) {
        const regionPath = leg.region.kind === 'revision-cloud' && (leg.cloudArcs?.length ?? 0) > 0
          ? cloudPath(leg.cloudArcs!)
          : pointPath(leg.region.points, true);
        cached.regions[regionIndex]?.setAttribute('d', regionPath);
        cached.regionHits[regionIndex]?.setAttribute('d', regionPath);
        regionIndex += 1;
      }
    });
    for (const head of cached.heads) {
      const points = entry.legs[head.legIndex]?.points;
      if (points !== undefined) head.element.setAttribute('transform', terminatorTransform(points, head.end));
    }
    cached.label.setAttribute(
      'transform',
      `translate(${format(entry.labelPosition.x)} ${format(entry.labelPosition.y)})`,
    );
    cached.grips.forEach((grip, index) => {
      const leg = entry.legs[index];
      if (leg !== undefined) this.#positionGrip(grip, entry, leg);
      else grip.style.display = 'none';
    });
    if (this.#handles) {
      const replacement = this.#renderRouteGrips(entry);
      cached.routeGrips?.replaceWith(replacement);
      if (cached.routeGrips === null) cached.group.appendChild(replacement);
      cached.routeGrips = replacement;
      // Same reason: how many handles a region has depends on how many corners it has, which is
      // not tracked, so the whole group is rebuilt rather than moved.
      const regions = this.#renderRegionGrips(entry);
      cached.regionGrips?.replaceWith(regions);
      if (cached.regionGrips === null) cached.group.appendChild(regions);
      cached.regionGrips = regions;
    }
  }

  /** One handle per leader, on the point it actually attaches to — where a drag would move it. */
  #renderGrip(entry: PlannedAnnotation, leg: PlannedLeg, index: number): SVGRectElement {
    const grip = this.#boundary.ownerDocument.createElementNS(SVG_NS, 'rect');
    grip.setAttribute('data-handle', 'anchor');
    grip.dataset.legId = leg.id;
    grip.dataset.legIndex = String(index);
    grip.setAttribute('width', format(GRIP_SIZE));
    grip.setAttribute('height', format(GRIP_SIZE));
    // Drawn in the style's own ink, so a dark scheme gets dark-scheme handles for free.
    grip.setAttribute('fill', entry.style.lineColor);
    grip.setAttribute('stroke', 'none');
    // Hits are worked out geometrically, so the drawn square never has to catch a pointer itself
    // — which is what lets its grab area be larger than it looks.
    grip.style.pointerEvents = 'none';
    this.#positionGrip(grip, entry, leg);
    return grip;
  }

  /**
   * The handles on the leader lines.
   *
   * Three shapes, so you can tell at a glance what grabbing one will do: a filled square moves the
   * arrow, a hollow diamond moves an existing bend, a hollow square adds a bend. This is the same
   * vocabulary AutoCAD uses, so it needs no learning.
   */
  #renderRouteGrips(entry: PlannedAnnotation): SVGGElement {
    const document = this.#boundary.ownerDocument;
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-route-handles', '');
    group.style.pointerEvents = 'none';
    const handles = annotationScreenGeometry([entry], entry.annotation.id)?.routeHandles ?? [];
    for (const handle of handles) {
      const grip = document.createElementNS(SVG_NS, 'rect');
      grip.setAttribute('data-route-handle', handle.kind);
      grip.dataset.legId = handle.target;
      grip.dataset.handleIndex = String(handle.index);
      grip.setAttribute('x', format(handle.at.x - GRIP_SIZE / 2));
      grip.setAttribute('y', format(handle.at.y - GRIP_SIZE / 2));
      grip.setAttribute('width', format(GRIP_SIZE));
      grip.setAttribute('height', format(GRIP_SIZE));
      grip.setAttribute('fill', 'none');
      grip.setAttribute('stroke', entry.style.lineColor);
      grip.setAttribute('stroke-width', format(entry.style.lineWidth));
      grip.setAttribute('vector-effect', 'non-scaling-stroke');
      if (handle.kind === 'vertex') {
        grip.setAttribute('transform', `rotate(45 ${format(handle.at.x)} ${format(handle.at.y)})`);
      }
      group.appendChild(grip);
    }
    group.style.display = this.#selected.has(entry.annotation.id) ? '' : 'none';
    return group;
  }

  /**
   * The handles on a marked-up region.
   *
   * Only one new shape is introduced: a filled circle for resizing, because resizing has no
   * equivalent on a leader and a circle is the one shape that cannot be mistaken for a square or a
   * diamond at this size.
   *
   * The other two keep the meanings they already have — a hollow diamond moves a point, a hollow
   * square adds one — because on a region they do exactly the same thing they do on a leader.
   */
  #renderRegionGrips(entry: PlannedAnnotation): SVGGElement {
    const document = this.#boundary.ownerDocument;
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-region-handles', '');
    group.style.pointerEvents = 'none';
    const handles = annotationScreenGeometry([entry], entry.annotation.id)?.regionHandles ?? [];
    for (const handle of handles) {
      const grip = handle.kind === 'extent'
        ? document.createElementNS(SVG_NS, 'circle')
        : document.createElementNS(SVG_NS, 'rect');
      grip.setAttribute('data-region-handle', handle.kind);
      grip.dataset.legId = handle.target;
      if (handle.kind === 'extent') {
        grip.setAttribute('cx', format(handle.at.x));
        grip.setAttribute('cy', format(handle.at.y));
        grip.setAttribute('r', format(GRIP_SIZE / 2));
        grip.setAttribute('fill', entry.style.lineColor);
        grip.setAttribute('stroke', 'none');
      } else {
        grip.dataset.handleIndex = String(handle.index);
        grip.setAttribute('x', format(handle.at.x - GRIP_SIZE / 2));
        grip.setAttribute('y', format(handle.at.y - GRIP_SIZE / 2));
        grip.setAttribute('width', format(GRIP_SIZE));
        grip.setAttribute('height', format(GRIP_SIZE));
        grip.setAttribute('fill', 'none');
        grip.setAttribute('stroke', entry.style.lineColor);
        grip.setAttribute('stroke-width', format(entry.style.lineWidth));
        grip.setAttribute('vector-effect', 'non-scaling-stroke');
        if (handle.kind === 'vertex') {
          grip.setAttribute('transform', `rotate(45 ${format(handle.at.x)} ${format(handle.at.y)})`);
        }
      }
      group.appendChild(grip);
    }
    group.style.display = this.#selected.has(entry.annotation.id) ? '' : 'none';
    return group;
  }

  /** Every point of a stroke is a handle, drawn as the same "move this point" diamond a bend uses. */
  #renderInkGrips(entry: PlannedInk): SVGGElement {
    const document = this.#boundary.ownerDocument;
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-ink-handles', '');
    group.style.pointerEvents = 'none';
    entry.points.forEach((point, index) => {
      const grip = document.createElementNS(SVG_NS, 'rect');
      grip.setAttribute('data-ink-handle', String(index));
      grip.setAttribute('x', format(point.x - GRIP_SIZE / 2));
      grip.setAttribute('y', format(point.y - GRIP_SIZE / 2));
      grip.setAttribute('width', format(GRIP_SIZE));
      grip.setAttribute('height', format(GRIP_SIZE));
      grip.setAttribute('fill', 'none');
      grip.setAttribute('stroke', entry.style.lineColor);
      grip.setAttribute('stroke-width', format(entry.style.lineWidth));
      grip.setAttribute('vector-effect', 'non-scaling-stroke');
      grip.setAttribute('transform', `rotate(45 ${format(point.x)} ${format(point.y)})`);
      group.appendChild(grip);
    });
    group.style.display = this.#selectedInk.has(entry.id) ? '' : 'none';
    return group;
  }

  #positionGrip(grip: SVGRectElement, entry: PlannedAnnotation, leg: PlannedLeg): void {
    const at = leg.points[0];
    const shown = at !== undefined && this.#selected.has(entry.annotation.id);
    grip.style.display = shown ? '' : 'none';
    if (at === undefined) return;
    grip.setAttribute('x', format(at.x - GRIP_SIZE / 2));
    grip.setAttribute('y', format(at.y - GRIP_SIZE / 2));
  }

  #updateInk(cached: CachedInkGroup, entry: PlannedInk): void {
    const route = pointPath(entry.points, false);
    cached.visible.setAttribute('d', route);
    setStroke(cached.visible, entry.style);
    cached.hit.setAttribute('d', route);
    cached.group.setAttribute('aria-label', entry.accessibleText);
    if (!this.#handles) return;
    // ponytail: a stroke's handles are rebuilt every frame rather than moved. Reposition them in
    // place if a drawing ever carries enough ink for that to show up in a profile.
    const grips = this.#renderInkGrips(entry);
    cached.grips?.replaceWith(grips);
    if (cached.grips === null) cached.group.appendChild(grips);
    cached.grips = grips;
  }

  #reconcileOrder(desired: readonly SVGElement[]): void {
    desired.forEach((element, index) => {
      const current = this.#root.children.item(index);
      if (current !== element) this.#root.insertBefore(element, current);
    });
  }

  #appendRegion(
    group: SVGGElement,
    leg: PlannedLeg,
    annotationId: string,
    style: RenderStyle,
  ): void {
    const region = leg.region!;
    const document = this.#boundary.ownerDocument;
    const path = region.kind === 'revision-cloud' && (leg.cloudArcs?.length ?? 0) > 0
      ? cloudPath(leg.cloudArcs!)
      : pointPath(region.points, true);
    const visible = document.createElementNS(SVG_NS, 'path');
    visible.setAttribute('d', path);
    visible.setAttribute('data-region-kind', region.kind);
    visible.dataset.legId = leg.id;
    setStroke(visible, style);
    group.appendChild(visible);
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', path);
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '12');
    hit.setAttribute('data-hit-target', 'region');
    hit.dataset.legId = leg.id;
    hit.style.pointerEvents = 'stroke';
    this.#wireHitTarget(hit, annotationId);
    group.appendChild(hit);
  }

  #appendTerminator(
    group: SVGGElement,
    terminator: RenderTerminator | undefined,
    leg: PlannedLeg,
    legIndex: number,
    end: 'anchor' | 'label',
    style: RenderStyle,
  ): void {
    if (terminator === undefined) return;
    const path = this.#boundary.ownerDocument.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', terminator.path);
    path.setAttribute('data-terminator', end);
    path.dataset.legId = leg.id;
    path.dataset.legIndex = String(legIndex);
    path.setAttribute('transform', terminatorTransform(leg.points, end));
    if (terminator.fill === 'filled') {
      path.setAttribute('fill', style.lineColor);
      path.setAttribute('stroke', 'none');
    } else {
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', style.lineColor);
      path.setAttribute('stroke-width', format(style.lineWidth));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
    }
    path.style.pointerEvents = 'none';
    group.appendChild(path);
  }

  #renderPrimitive(
    primitive: RenderPrimitive,
    style: RenderStyle,
    annotationId: string,
  ): SVGElement {
    const document = this.#boundary.ownerDocument;
    if (primitive.kind === 'text') {
      const element = document.createElementNS(SVG_NS, 'text');
      element.setAttribute('x', format(primitive.position.x));
      element.setAttribute('y', format(primitive.position.y));
      element.setAttribute('font-family', primitive.code ? 'monospace' : style.fontFamily);
      element.setAttribute('font-size', format(primitive.fontSize));
      element.setAttribute('font-weight', primitive.bold ? 'bold' : 'normal');
      element.setAttribute('font-style', primitive.italic ? 'italic' : 'normal');
      element.setAttribute('direction', primitive.direction);
      element.setAttribute('unicode-bidi', 'plaintext');
      // Left out when it matches the default, so ordinary left-aligned text stays as clean as it was.
      if (primitive.align !== 'start') element.setAttribute('text-anchor', primitive.align);
      element.setAttribute('fill', style.textColor);
      // The measured width included this run's leading and trailing spaces, but SVG collapses
      // spaces by default and would not draw them — so a piece of styled text would sit flush
      // against the one before it. This turns that off.
      //
      // Set with an explicit namespace, because setting it by its plain name creates a differently
      // named attribute that no renderer reads.
      element.setAttributeNS(XML_NS, 'space', 'preserve');
      applyAccessibility(element, primitive.accessibility);
      element.textContent = primitive.text;
      return element;
    }
    if (primitive.kind === 'image') {
      const group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('role', 'img');
      group.setAttribute('aria-label', primitive.alt);
      group.setAttribute('data-image-reference', primitive.reference);
      group.setAttribute('data-image-status', primitive.state.status);
      if (primitive.state.status === 'ready') {
        const image = document.createElementNS(SVG_NS, 'image');
        image.setAttribute('x', format(primitive.bounds.x));
        image.setAttribute('y', format(primitive.bounds.y));
        image.setAttribute('width', format(primitive.bounds.width));
        image.setAttribute('height', format(primitive.bounds.height));
        image.setAttribute('href', primitive.state.source);
        image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        group.appendChild(image);
      } else {
        const placeholder = document.createElementNS(SVG_NS, 'rect');
        placeholder.setAttribute('x', format(primitive.bounds.x));
        placeholder.setAttribute('y', format(primitive.bounds.y));
        placeholder.setAttribute('width', format(primitive.bounds.width));
        placeholder.setAttribute('height', format(primitive.bounds.height));
        placeholder.setAttribute('fill', '#f3f4f6');
        placeholder.setAttribute('stroke', style.lineColor);
        placeholder.setAttribute('stroke-width', format(style.lineWidth));
        group.appendChild(placeholder);
      }
      return group;
    }
    if (primitive.kind === 'group') {
      const group = document.createElementNS(SVG_NS, 'g');
      if (primitive.scale !== undefined && primitive.scale !== 1) {
        group.setAttribute('transform', `scale(${format(primitive.scale)})`);
      }
      applyAccessibility(group, primitive.accessibility);
      for (const child of sortedPrimitives(primitive.children)) {
        group.appendChild(this.#renderPrimitive(child, style, annotationId));
      }
      return group;
    }
    if (primitive.kind === 'hit-region') {
      const hit = document.createElementNS(SVG_NS, 'rect');
      hit.setAttribute('x', format(primitive.bounds.x));
      hit.setAttribute('y', format(primitive.bounds.y));
      hit.setAttribute('width', format(primitive.bounds.width));
      hit.setAttribute('height', format(primitive.bounds.height));
      hit.setAttribute('fill', 'transparent');
      hit.setAttribute('data-plugin-interaction-id', primitive.interactionId);
      hit.style.pointerEvents = 'all';
      if (primitive.cursor !== undefined) hit.style.cursor = primitive.cursor;
      applyAccessibility(hit, primitive.accessibility);
      this.#wireHitTarget(hit, annotationId);
      return hit;
    }
    const element = document.createElementNS(SVG_NS, 'path');
    const paint = primitive.paint;
    element.setAttribute('d', primitive.path ?? commandPath(primitive.commands ?? []));
    element.setAttribute('stroke', paint?.stroke ?? style.lineColor);
    element.setAttribute('stroke-width', format(paint?.strokeWidth ?? style.lineWidth));
    element.setAttribute('vector-effect', 'non-scaling-stroke');
    element.setAttribute('fill', paint?.fill ?? (primitive.fill === 'solid' ? style.textColor : 'none'));
    if (paint?.fillOpacity !== undefined) element.setAttribute('fill-opacity', format(paint.fillOpacity));
    applyAccessibility(element, primitive.accessibility);
    return element;
  }

  #wireHitTarget(target: SVGElement, id: string): void {
    target.addEventListener('pointerenter', () => this.#hover(id));
    target.addEventListener('pointerleave', () => this.#hover(null));
    target.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#select(id, event.metaKey || event.ctrlKey || event.shiftKey);
    });
  }
}

interface CachedAnnotationGroup {
  readonly group: SVGGElement;
  readonly signature: string;
  readonly routes: readonly SVGPathElement[];
  readonly routeHits: readonly SVGPathElement[];
  readonly regions: readonly SVGPathElement[];
  readonly regionHits: readonly SVGPathElement[];
  readonly heads: readonly {
    readonly element: SVGPathElement;
    readonly legIndex: number;
    readonly end: 'anchor' | 'label';
  }[];
  readonly grips: readonly SVGRectElement[];
  /** Rebuilt each frame, because how many handles there are depends on how many bends there are.
   *  Nothing at all when the host draws its own. */
  routeGrips: SVGGElement | null;
  /** The same, for a region's handles. */
  regionGrips: SVGGElement | null;
  readonly label: SVGGElement;
}

interface CachedInkGroup {
  readonly group: SVGGElement;
  readonly visible: SVGPathElement;
  readonly hit: SVGPathElement;
  grips: SVGGElement | null;
}

function annotationStructureSignature(entry: PlannedAnnotation): string {
  const style = entry.style;
  const bounds = entry.layout.bounds;
  return [
    entry.layout.accessibleText,
    entry.layout.direction,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    style.lineColor,
    style.lineWidth,
    style.textColor,
    style.fontFamily,
    style.fontSize,
    // A different arrowhead shape or fill has to be rebuilt, not merely repositioned.
    `${style.terminator?.path ?? ''}/${style.terminator?.fill ?? ''}`,
    `${style.labelTerminator?.path ?? ''}/${style.labelTerminator?.fill ?? ''}`,
    layoutPrimitiveSignature(entry.layout),
    entry.legs.map((leg) => `${leg.id}:${leg.region?.kind ?? ''}:${leg.cloudArcs?.length ?? 0}`).join('|'),
  ].join(';');
}

const layoutPrimitiveSignatures = new WeakMap<RenderableContentLayout, string>();

function layoutPrimitiveSignature(layout: RenderableContentLayout): string {
  const cached = layoutPrimitiveSignatures.get(layout);
  if (cached !== undefined) return cached;
  const signature = JSON.stringify(layout.primitives.map(primitiveSignature));
  layoutPrimitiveSignatures.set(layout, signature);
  return signature;
}

function primitiveSignature(primitive: RenderPrimitive): unknown {
  const base = [primitive.kind, primitive.bounds, primitive.zIndex, primitive.accessibility];
  switch (primitive.kind) {
    case 'text':
      return [...base, primitive.position, primitive.text, primitive.direction,
        primitive.fontSize, primitive.bold, primitive.italic, primitive.code];
    case 'path':
      return [...base, primitive.path, primitive.commands, primitive.fill, primitive.paint];
    case 'image':
      return [...base, primitive.reference, primitive.alt, primitive.state.status,
        primitive.state.bounds,
        ...(primitive.state.status === 'ready'
          ? [primitive.state.intrinsic, primitive.state.source]
          : [])];
    case 'group':
      return [...base, primitive.scale, primitive.children.map(primitiveSignature)];
    case 'hit-region':
      return [...base, primitive.interactionId, primitive.cursor];
  }
}

function sortedPrimitives(primitives: readonly RenderPrimitive[]): readonly RenderPrimitive[] {
  return primitives.map((primitive, index) => ({ primitive, index }))
    .sort((left, right) => left.primitive.zIndex - right.primitive.zIndex || left.index - right.index)
    .map(({ primitive }) => primitive);
}

function setStroke(element: SVGPathElement, style: RenderStyle): void {
  element.setAttribute('fill', 'none');
  element.setAttribute('stroke', style.lineColor);
  element.setAttribute('stroke-width', format(style.lineWidth));
  element.setAttribute('vector-effect', 'non-scaling-stroke');
}

function applyAccessibility(
  element: SVGElement,
  accessibility: PrimitiveBase['accessibility'],
): void {
  if (accessibility === undefined) return;
  element.setAttribute('role', accessibility.role);
  element.setAttribute('aria-label', accessibility.label);
  if (accessibility.description !== undefined) {
    element.setAttribute('aria-description', accessibility.description);
  }
}

function commandPath(commands: readonly DeclarativePathCommand[]): string {
  return commands.map((entry) => {
    switch (entry.command) {
      case 'move': return `M ${format(entry.to.x)} ${format(entry.to.y)}`;
      case 'line': return `L ${format(entry.to.x)} ${format(entry.to.y)}`;
      case 'quadratic': return `Q ${format(entry.control.x)} ${format(entry.control.y)} ${format(entry.to.x)} ${format(entry.to.y)}`;
      case 'cubic': return `C ${format(entry.control1.x)} ${format(entry.control1.y)} ${format(entry.control2.x)} ${format(entry.control2.y)} ${format(entry.to.x)} ${format(entry.to.y)}`;
      case 'close': return 'Z';
    }
  }).join(' ');
}

interface CommandTransform {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

function mapCommand(command: DeclarativePathCommand, into: CommandTransform): DeclarativePathCommand {
  const at = (point: Vec2): Vec2 => ({
    x: point.x * into.scaleX + into.offsetX,
    y: point.y * into.scaleY + into.offsetY,
  });
  switch (command.command) {
    case 'close': return command;
    case 'move':
    case 'line': return { command: command.command, to: at(command.to) };
    case 'quadratic': return { command: 'quadratic', control: at(command.control), to: at(command.to) };
    case 'cubic': return {
      command: 'cubic',
      control1: at(command.control1),
      control2: at(command.control2),
      to: at(command.to),
    };
  }
}

/**
 * Points an arrowhead along the end of its leader.
 *
 * A leader runs from the model to the label, so an arrowhead sits at one end or the other and aims
 * away from the point next to it. A leader too short to have a direction gets an unrotated head
 * rather than vanishing.
 */
function terminatorTransform(points: readonly Vec2[], end: 'anchor' | 'label'): string {
  const tip = end === 'anchor' ? points[0] : points.at(-1);
  const back = end === 'anchor' ? points[1] : points.at(-2);
  if (tip === undefined) return '';
  const angle = back === undefined ? 0 : Math.atan2(tip.y - back.y, tip.x - back.x) * (180 / Math.PI);
  return `translate(${format(tip.x)} ${format(tip.y)}) rotate(${format(angle)})`;
}

/**
 * Stops the leader line where its arrowhead begins.
 *
 * A solid arrowhead covers the line beneath it, so that stretch of line adds nothing but a thicker
 * tip. The arrowhead itself still uses the full-length points, so its point stays exactly on the
 * thing being annotated.
 */
export function clearAnchorHead(points: readonly Vec2[], style: RenderStyle): readonly Vec2[] {
  const head = style.terminator;
  const [tip, next] = points;
  if (head?.fill !== 'filled' || tip === undefined || next === undefined) return points;
  const span = Math.hypot(next.x - tip.x, next.y - tip.y);
  if (span <= head.length) return points;
  const ratio = head.length / span;
  return [
    { x: tip.x + (next.x - tip.x) * ratio, y: tip.y + (next.y - tip.y) * ratio },
    ...points.slice(1),
  ];
}

/**
 * The leader as drawn, with gaps where it passes under other labels.
 *
 * Applied on every frame rather than only when the leader is first created, because which labels
 * are in the way changes as the camera moves and a gap written once would be wrong immediately
 * after.
 *
 * The invisible clickable line stays unbroken, so a gapped leader is still one thing to click and
 * one thing to grab.
 */
function drawnRoutePath(leg: PlannedLeg, style: RenderStyle): string {
  return breakAroundObstacles(clearAnchorHead(leg.points, style), leg.obstacles ?? [])
    .map((piece) => pointPath(piece, false)).join(' ');
}

/**
 * The dash pattern for a leader pointing at something hidden. Drawing standards dash a hidden edge,
 * and a leader disappearing into a wall is exactly that.
 *
 * Never applied to the invisible clickable line: gaps there would make a leader hardest to select
 * precisely where it is already hardest to see.
 */
const OCCLUDED_LEG_DASH = '6 4';

/**
 * How much a hidden leader is faded, on top of being dashed.
 *
 * Dashing alone is not enough, because plenty of drafting styles dash by convention — dashed *and*
 * dimmed is what reads as "this is behind something".
 *
 * Fading rather than mixing toward the background colour, because ViewLeader never sees that
 * colour: the overlay is transparent over a canvas it does not own, so any blend would be a guess.
 * Fading composites against whatever is really there.
 *
 * The value is a floor rather than a preference. Much below this the line stops reading as
 * deliberately de-emphasised and starts reading as merely faint, and it drops under the accessible
 * contrast minimum for a non-text graphic.
 */
const OCCLUDED_LEG_OPACITY = '0.55';

function setOccludedStroke(path: SVGPathElement, occluded: boolean): void {
  if (occluded) {
    path.setAttribute('stroke-dasharray', OCCLUDED_LEG_DASH);
    path.setAttribute('stroke-opacity', OCCLUDED_LEG_OPACITY);
  } else {
    path.removeAttribute('stroke-dasharray');
    path.removeAttribute('stroke-opacity');
  }
}

function pointPath(points: readonly Vec2[], close: boolean): string {
  return `${points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${format(point.x)} ${format(point.y)}`).join(' ')}${close ? ' Z' : ''}`;
}

function cloudPath(arcs: readonly RevisionCloudArc[]): string {
  const first = arcs[0];
  if (first === undefined) return '';
  return [
    `M ${format(first.start.x)} ${format(first.start.y)}`,
    ...arcs.map(({ control, end }) =>
      `Q ${format(control.x)} ${format(control.y)} ${format(end.x)} ${format(end.y)}`),
    'Z',
  ].join(' ');
}

function format(value: number): string {
  return String(Math.round(value * 1_000) / 1_000);
}

/**
 * What to draw with when no style applies: an annotation naming none, a plugin's preview, the
 * selection rectangle.
 *
 * Follows the instance's colour scheme, because two of those three are things the user sees — a
 * dark viewport with a default-grey selection box looks broken.
 *
 * Built from the same colour-scheme values the standard style uses rather than repeating colours
 * here, which is how the two drifted apart the first time. Sizes stay at the defaults: this is a
 * fallback, not a twelfth built-in style.
 */
export function defaultRenderStyle(theme: Theme = CAD_PAPER): RenderStyle {
  return Object.freeze({
    lineColor: theme.ink,
    lineWidth: PEN.thin,
    textColor: theme.ink,
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
  });
}

/** The same fallback in the default light scheme, for callers with no instance to ask. */
export const DEFAULT_RENDER_STYLE: RenderStyle = defaultRenderStyle();
