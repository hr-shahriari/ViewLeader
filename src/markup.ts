// Markup: freehand ink and drawn regions — clouds, rectangles, ellipses, polygons.
//
// The thing that makes markup different from a note is that it has a shape, and that shape has to
// stay stuck to the model. So a region is stored on a flat plane lying against the surface it was
// drawn on, in that plane's own coordinates. Orbit the camera and the cloud stays on the wall,
// foreshortening with it, instead of floating in front of the screen.
import {
  InvalidInputError,
  InvariantViolationError,
  NotFoundError,
} from './errors.js';
import type {
  Annotation as CoreAnnotation,
  AnnotationContent,
  AnnotationLeg as CoreAnnotationLeg,
  AnnotationPlacement,
  AnnotationRouting,
  ElementAnchor,
  JsonObject,
  NamespacedMetadata,
  RegionAnchor as CoreRegionAnchor,
  Vec2,
  Vec3,
  WorldPointAnchor,
} from './types.js';
import type { OcclusionPolicy } from './occlusion.js';
import type { LegRoute, ScreenBounds } from './routing.js';

export interface DrawingPlane {
  readonly origin: Vec3;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  readonly normal: Vec3;
}

export interface RectangleRegionGeometry {
  readonly kind: 'rectangle';
  readonly center: Vec2;
  readonly width: number;
  readonly height: number;
}

export interface EllipseRegionGeometry {
  readonly kind: 'ellipse';
  readonly center: Vec2;
  readonly radiusX: number;
  readonly radiusY: number;
}

export interface PolygonRegionGeometry {
  readonly kind: 'polygon';
  readonly vertices: readonly Vec2[];
}

export interface RevisionCloudGeometry {
  readonly kind: 'revision-cloud';
  readonly vertices: readonly Vec2[];
  readonly arcLength: number;
}

export type ClosedRegionGeometry =
  | RectangleRegionGeometry
  | EllipseRegionGeometry
  | PolygonRegionGeometry
  | RevisionCloudGeometry;

export interface RegionAnchor {
  readonly kind: 'region';
  readonly modelId?: string;
  readonly plane: DrawingPlane;
  readonly geometry: ClosedRegionGeometry;
}

export type MultiAnchor = WorldPointAnchor | ElementAnchor | RegionAnchor;

export interface AnnotationLeg {
  readonly id: string;
  readonly anchor: MultiAnchor;
  readonly route: LegRoute;
}

export interface MultiLeaderAnnotation {
  readonly kind: 'annotation';
  readonly id: string;
  readonly anchors: readonly AnnotationLeg[];
  readonly content: AnnotationContent;
  readonly placement: AnnotationPlacement;
  readonly styleId?: string;
  readonly styleOverride?: NamespacedMetadata;
  readonly occlusion: OcclusionPolicy;
  readonly metadata: NamespacedMetadata;
}

export interface InkAnnotation {
  readonly kind: 'ink';
  readonly id: string;
  readonly plane: DrawingPlane;
  readonly points: readonly Vec2[];
  readonly styleId?: string;
  readonly metadata: NamespacedMetadata;
}

export interface GeometryLimits {
  readonly maximumCoordinate: number;
  readonly maximumVertices: number;
  readonly maximumAnchors: number;
  readonly inkSimplificationTolerance: number;
}

export const DEFAULT_GEOMETRY_LIMITS: GeometryLimits = Object.freeze({
  maximumCoordinate: 1_000_000,
  maximumVertices: 4_096,
  maximumAnchors: 64,
  inkSimplificationTolerance: 0.002,
});

export interface SurfacePlanePick {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly modelId?: string;
}

export interface ProjectedRegion {
  readonly kind: ClosedRegionGeometry['kind'];
  readonly points: readonly Vec2[];
  readonly closed: true;
}

export interface ProjectedInk {
  readonly kind: 'ink';
  readonly points: readonly Vec2[];
  readonly closed: false;
}

/** Roughly where a label sits relative to its region — above, below, to one side, or on top of it.
 *  Used to decide which part of the outline its leader should point at. */
export type RegionAttachmentZone =
  | 'top-left' | 'top' | 'top-right'
  | 'left' | 'inside' | 'right'
  | 'bottom-left' | 'bottom' | 'bottom-right';

export interface RegionAttachment {
  readonly point: Vec2;
  readonly zone: RegionAttachmentZone;
}

/** Looked up by which third of the region the label falls into, vertically then horizontally. */
const REGION_ZONES: readonly (readonly RegionAttachmentZone[])[] = Object.freeze([
  Object.freeze(['top-left', 'top', 'top-right'] as const),
  Object.freeze(['left', 'inside', 'right'] as const),
  Object.freeze(['bottom-left', 'bottom', 'bottom-right'] as const),
]);

export interface RevisionCloudArc {
  readonly start: Vec2;
  readonly control: Vec2;
  readonly end: Vec2;
}

export type MarkupToolKind = ClosedRegionGeometry['kind'] | 'ink';

export interface MarkupAuthoringPreview {
  readonly kind: MarkupToolKind;
  readonly plane: DrawingPlane | null;
  readonly geometry: ClosedRegionGeometry | null;
  readonly inkPoints: readonly Vec2[];
}

/**
 * Holds a shape while it is being drawn.
 *
 * Deliberately has no access to the document. A half-drawn cloud is not something anyone should be
 * able to undo to, so nothing is written until the shape is finished and committed in one go.
 */
export class MarkupAuthoringSession {
  readonly #kind: MarkupToolKind;
  readonly #limits: GeometryLimits;
  #plane: DrawingPlane | undefined;
  #modelId: string | undefined;
  #geometry: ClosedRegionGeometry | undefined;
  #inkPoints: Vec2[] = [];
  #ended = false;

  public constructor(kind: MarkupToolKind, limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS) {
    this.#kind = kind;
    this.#limits = limits;
    validateLimits(limits);
  }

  public get preview(): MarkupAuthoringPreview {
    return {
      kind: this.#kind,
      plane: this.#plane === undefined ? null : clone(this.#plane),
      geometry: this.#geometry === undefined ? null : clone(this.#geometry),
      inkPoints: this.#inkPoints.map(copyVec2),
    };
  }

  public establishPlaneFromPick(pick: SurfacePlanePick): DrawingPlane {
    if (pick.modelId !== undefined) validateId(pick.modelId, 'region model id');
    const plane = this.establishPlane(drawingPlaneFromSurfacePick(pick));
    this.#modelId = pick.modelId;
    return plane;
  }

  public establishPlane(plane: DrawingPlane): DrawingPlane {
    this.#assertActive();
    validateDrawingPlane(plane);
    if (this.#plane !== undefined) {
      throw new InvariantViolationError('The markup drawing plane is already established');
    }
    this.#plane = clone(plane);
    return clone(plane);
  }

  public setRegionGeometry(geometry: ClosedRegionGeometry): RegionAnchor {
    this.#assertActive();
    if (this.#kind === 'ink' || geometry.kind !== this.#kind) {
      throw new InvalidInputError('Region geometry does not match the active markup tool', {
        tool: this.#kind,
        geometry: geometry.kind,
      });
    }
    const plane = this.#requirePlane();
    const anchor = createRegionAnchor(plane, geometry, this.#limits);
    this.#geometry = clone(anchor.geometry);
    return anchor;
  }

  public appendInkPoint(point: Vec2): readonly Vec2[] {
    this.#assertActive();
    if (this.#kind !== 'ink') throw new InvalidInputError('Only the ink tool accepts stroke points');
    this.#requirePlane();
    validateLocalPoint(point, this.#limits.maximumCoordinate, 'ink preview point');
    if (this.#inkPoints.length >= this.#limits.maximumVertices * 8) {
      throw new InvalidInputError('Raw ink preview exceeds its point bound');
    }
    this.#inkPoints.push(copyVec2(point));
    return this.#inkPoints.map(copyVec2);
  }

  public completeRegion(): RegionAnchor {
    this.#assertActive();
    if (this.#kind === 'ink' || this.#geometry === undefined) {
      throw new InvalidInputError('Region authoring has no valid completed geometry');
    }
    const result = createRegionAnchor(
      this.#requirePlane(),
      this.#geometry,
      this.#limits,
      this.#modelId,
    );
    this.#ended = true;
    return result;
  }

  public completeInk(
    id: string,
    metadata: NamespacedMetadata = {},
    styleId?: string,
  ): InkAnnotation {
    this.#assertActive();
    if (this.#kind !== 'ink') throw new InvalidInputError('The active tool does not create ink');
    const result = createInk({
      id,
      plane: this.#requirePlane(),
      points: this.#inkPoints,
      metadata,
      ...(styleId === undefined ? {} : { styleId }),
    }, this.#limits);
    this.#ended = true;
    return result;
  }

  public cancel(): Readonly<{ status: 'cancelled' }> {
    if (!this.#ended) {
      this.#ended = true;
      this.#plane = undefined;
      this.#modelId = undefined;
      this.#geometry = undefined;
      this.#inkPoints = [];
    }
    return { status: 'cancelled' };
  }

  #requirePlane(): DrawingPlane {
    if (this.#plane === undefined) throw new InvalidInputError('Markup authoring requires a drawing plane');
    return this.#plane;
  }

  #assertActive(): void {
    if (this.#ended) throw new InvariantViolationError('Markup authoring session has ended');
  }
}

export function drawingPlaneFromSurfacePick(pick: SurfacePlanePick): DrawingPlane {
  validateVec3(pick.point, 'surface pick point');
  validateVec3(pick.normal, 'surface pick normal');
  const normal = normalize(pick.normal);
  if (magnitude(normal) < 1e-9) throw new InvalidInputError('Surface normal must not be zero');
  const helper = Math.abs(normal.z) < 0.9
    ? { x: 0, y: 0, z: 1 }
    : { x: 0, y: 1, z: 0 };
  const xAxis = normalize(cross(helper, normal));
  const yAxis = normalize(cross(normal, xAxis));
  const plane = { origin: copyVec3(pick.point), xAxis, yAxis, normal };
  validateDrawingPlane(plane);
  return plane;
}

/**
 * Converts a point on the model into coordinates on the drawing plane.
 *
 * A point slightly off the plane is flattened onto it, so a hand that wandered off a wall while
 * drawing still produces a shape that lies flat against it.
 */
export function worldPointToDrawingPlane(plane: DrawingPlane, point: Vec3): Vec2 {
  validateDrawingPlane(plane);
  validateVec3(point, 'drawing-plane sample point');
  const delta = {
    x: point.x - plane.origin.x,
    y: point.y - plane.origin.y,
    z: point.z - plane.origin.z,
  };
  return Object.freeze({
    x: dot(delta, plane.xAxis),
    y: dot(delta, plane.yAxis),
  });
}

/**
 * Turns a drag across the screen into a movement along the region's own plane, so dragging a cloud
 * slides it along the wall it is drawn on rather than skewing it across the view.
 *
 * ViewLeader cannot turn a screen position back into a world position on its own — that needs the
 * host's scene. But it does not need to here, because the region is not free in space: it is stuck
 * to a plane already known.
 *
 * So the answer is measured rather than calculated. Take the drag's starting point and two more a
 * short step along each direction of the plane, ask the host where all three land on screen, and
 * the differences say how screen movement maps to plane movement right there. Reversing that gives
 * the plane movement matching the drag.
 *
 * Exact under an orthographic camera. Under a perspective one it is a very good local
 * approximation, so a long drag across steep foreshortening lands slightly short — but the region
 * stays flat on its plane and keeps its shape, because only plane coordinates are ever stored.
 *
 * Returns nothing when the plane is edge-on to the camera and has collapsed to a line on screen.
 * There is no single right answer then, and refusing beats guessing.
 */
export function screenDeltaToDrawingPlane(
  plane: DrawingPlane,
  from: Vec2,
  screenDelta: Vec2,
  project: (point: Vec3) => Vec2 | undefined,
  step = 1,
): Vec2 | undefined {
  validateDrawingPlane(plane);
  if (!finiteVec2(from) || !finiteVec2(screenDelta) || !Number.isFinite(step) || step <= 0) {
    throw new InvalidInputError('Screen-delta projection requires finite inputs and a positive probe step');
  }
  const origin = project(localToWorld(plane, from));
  const alongX = project(localToWorld(plane, { x: from.x + step, y: from.y }));
  const alongY = project(localToWorld(plane, { x: from.x, y: from.y + step }));
  if (!finiteVec2(origin) || !finiteVec2(alongX) || !finiteVec2(alongY)) return undefined;
  const xAxis = { x: (alongX.x - origin.x) / step, y: (alongX.y - origin.y) / step };
  const yAxis = { x: (alongY.x - origin.x) / step, y: (alongY.y - origin.y) / step };
  const determinant = xAxis.x * yAxis.y - xAxis.y * yAxis.x;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined;
  return Object.freeze({
    x: (screenDelta.x * yAxis.y - screenDelta.y * yAxis.x) / determinant,
    y: (screenDelta.y * xAxis.x - screenDelta.x * xAxis.y) / determinant,
  });
}

/**
 * How big a region is and where its middle is, in its own plane's units.
 *
 * Answered the same way for all four shapes — an ellipse's radii and a polygon's bounding box are
 * asking the same question — so resizing and projecting each have one place to ask.
 */
export function regionLocalExtent(geometry: ClosedRegionGeometry): Readonly<{
  center: Vec2;
  halfWidth: number;
  halfHeight: number;
}> {
  if (geometry.kind === 'rectangle') {
    return Object.freeze({
      center: copyVec2(geometry.center),
      halfWidth: geometry.width / 2,
      halfHeight: geometry.height / 2,
    });
  }
  if (geometry.kind === 'ellipse') {
    return Object.freeze({
      center: copyVec2(geometry.center),
      halfWidth: geometry.radiusX,
      halfHeight: geometry.radiusY,
    });
  }
  const bounds = localBounds(geometry.vertices);
  return Object.freeze({
    center: bounds.center,
    halfWidth: bounds.width / 2,
    halfHeight: bounds.height / 2,
  });
}

export function validateDrawingPlane(plane: DrawingPlane, unrecognized?: string[]): void {
  assertExactKeys(plane, ['origin', 'xAxis', 'yAxis', 'normal'], 'drawing plane', unrecognized);
  validateVec3(plane.origin, 'plane origin');
  validateVec3(plane.xAxis, 'plane x-axis');
  validateVec3(plane.yAxis, 'plane y-axis');
  validateVec3(plane.normal, 'plane normal');
  const vectors = [plane.xAxis, plane.yAxis, plane.normal];
  if (vectors.some((vector) => Math.abs(magnitude(vector) - 1) > 1e-6)
    || Math.abs(dot(plane.xAxis, plane.yAxis)) > 1e-6
    || Math.abs(dot(plane.xAxis, plane.normal)) > 1e-6
    || Math.abs(dot(plane.yAxis, plane.normal)) > 1e-6
    || dot(cross(plane.xAxis, plane.yAxis), plane.normal) < 1 - 1e-6) {
    throw new InvalidInputError('Drawing plane axes must form a right-handed orthonormal basis');
  }
}

export function validateRegionAnchor(
  anchor: RegionAnchor,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): void {
  if (anchor === null || typeof anchor !== 'object' || anchor.kind !== 'region') {
    throw new InvalidInputError('Closed-region anchor is invalid');
  }
  assertExactKeys(anchor, ['kind', 'modelId', 'plane', 'geometry'], 'region anchor');
  validateLimits(limits);
  if (anchor.modelId !== undefined) validateId(anchor.modelId, 'region model id');
  validateDrawingPlane(anchor.plane);
  const maximum = limits.maximumCoordinate;
  const geometry = anchor.geometry;
  switch (geometry.kind) {
    case 'rectangle':
      assertExactKeys(geometry, ['kind', 'center', 'width', 'height'], 'rectangle geometry');
      validateLocalPoint(geometry.center, maximum, 'rectangle center');
      validateExtent(geometry.width, maximum, 'rectangle width');
      validateExtent(geometry.height, maximum, 'rectangle height');
      return;
    case 'ellipse':
      assertExactKeys(geometry, ['kind', 'center', 'radiusX', 'radiusY'], 'ellipse geometry');
      validateLocalPoint(geometry.center, maximum, 'ellipse center');
      validateExtent(geometry.radiusX, maximum, 'ellipse radiusX');
      validateExtent(geometry.radiusY, maximum, 'ellipse radiusY');
      return;
    case 'polygon':
      assertExactKeys(geometry, ['kind', 'vertices'], 'polygon geometry');
      validateClosedVertices(geometry.vertices, limits, 'polygon');
      return;
    case 'revision-cloud':
      assertExactKeys(geometry, ['kind', 'vertices', 'arcLength'], 'revision-cloud geometry');
      validateClosedVertices(geometry.vertices, limits, 'revision cloud');
      validateExtent(geometry.arcLength, maximum, 'revision-cloud arc length');
      return;
    default:
      throw new InvalidInputError('Unsupported closed-region geometry');
  }
}

export function createRegionAnchor(
  plane: DrawingPlane,
  geometry: ClosedRegionGeometry,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
  modelId?: string,
): RegionAnchor {
  const anchor: RegionAnchor = {
    kind: 'region',
    ...(modelId === undefined ? {} : { modelId }),
    plane: clone(plane),
    geometry: clone(geometry),
  };
  validateRegionAnchor(anchor, limits);
  return anchor;
}

export function moveRegion(
  anchor: RegionAnchor,
  delta: Vec2,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): RegionAnchor {
  validateRegionAnchor(anchor, limits);
  validateLocalPoint(delta, limits.maximumCoordinate, 'region move delta');
  const geometry = anchor.geometry;
  const moved: ClosedRegionGeometry = geometry.kind === 'rectangle' || geometry.kind === 'ellipse'
    ? { ...geometry, center: add2(geometry.center, delta) }
    : { ...geometry, vertices: geometry.vertices.map((point) => add2(point, delta)) };
  return createRegionAnchor(anchor.plane, moved, limits, anchor.modelId);
}

export function resizeRegion(
  anchor: RegionAnchor,
  extent: Readonly<{ width: number; height: number }>,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): RegionAnchor {
  validateRegionAnchor(anchor, limits);
  validateExtent(extent.width, limits.maximumCoordinate, 'region width');
  validateExtent(extent.height, limits.maximumCoordinate, 'region height');
  if (anchor.geometry.kind === 'rectangle') {
    return createRegionAnchor(anchor.plane, {
      ...anchor.geometry,
      width: extent.width,
      height: extent.height,
    }, limits, anchor.modelId);
  }
  if (anchor.geometry.kind === 'ellipse') {
    return createRegionAnchor(anchor.plane, {
      ...anchor.geometry,
      radiusX: extent.width / 2,
      radiusY: extent.height / 2,
    }, limits, anchor.modelId);
  }
  throw new InvalidInputError('Only rectangle and ellipse regions can be resized by extent', {
    kind: anchor.geometry.kind,
  });
}

export function retargetRegion(
  anchor: RegionAnchor,
  plane: DrawingPlane,
  geometry: ClosedRegionGeometry = anchor.geometry,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): RegionAnchor {
  validateRegionAnchor(anchor, limits);
  return createRegionAnchor(plane, geometry, limits, anchor.modelId);
}

export function addRegionVertex(
  anchor: RegionAnchor,
  index: number,
  point: Vec2,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): RegionAnchor {
  const vertices = editableVertices(anchor, limits);
  validateInsertIndex(index, vertices.length);
  validateLocalPoint(point, limits.maximumCoordinate, 'region vertex');
  return withVertices(anchor, [
    ...vertices.slice(0, index),
    copyVec2(point),
    ...vertices.slice(index),
  ], limits);
}

export function moveRegionVertex(
  anchor: RegionAnchor,
  index: number,
  point: Vec2,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): RegionAnchor {
  const vertices = editableVertices(anchor, limits);
  validateIndex(index, vertices.length);
  validateLocalPoint(point, limits.maximumCoordinate, 'region vertex');
  return withVertices(anchor, vertices.map((current, currentIndex) =>
    currentIndex === index ? copyVec2(point) : copyVec2(current)), limits);
}

export function removeRegionVertex(
  anchor: RegionAnchor,
  index: number,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): RegionAnchor {
  const vertices = editableVertices(anchor, limits);
  validateIndex(index, vertices.length);
  if (vertices.length <= 3) {
    throw new InvariantViolationError('A closed region must retain at least three vertices', {
      kind: anchor.geometry.kind,
      vertexCount: vertices.length,
    });
  }
  return withVertices(anchor, vertices.filter((_, currentIndex) => currentIndex !== index), limits);
}

export function createInk(
  input: Omit<InkAnnotation, 'kind' | 'points'> & { readonly points: readonly Vec2[] },
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): InkAnnotation {
  validateDrawingPlane(input.plane);
  const points = simplifyInk(input.points, limits.inkSimplificationTolerance, limits);
  const ink: InkAnnotation = { ...clone(input), kind: 'ink', points };
  validateInk(ink, limits);
  return ink;
}

export function validateInk(
  ink: InkAnnotation,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
  unrecognized?: string[],
): void {
  if (ink === null || typeof ink !== 'object' || ink.kind !== 'ink') {
    throw new InvalidInputError('Ink annotation is invalid');
  }
  assertExactKeys(
    ink,
    ['kind', 'id', 'plane', 'points', 'styleId', 'metadata'],
    'ink annotation',
    unrecognized,
  );
  validateId(ink.id, 'ink id');
  validateDrawingPlane(ink.plane, unrecognized);
  if (!Array.isArray(ink.points) || ink.points.length < 2 || ink.points.length > limits.maximumVertices) {
    throw new InvalidInputError(`Ink must contain 2–${limits.maximumVertices} ordered points`);
  }
  for (const point of ink.points) validateLocalPoint(point, limits.maximumCoordinate, 'ink point');
  if (samePoint(ink.points[0]!, ink.points.at(-1)!)) {
    throw new InvalidInputError('Ink is an open stroke and must not be closed');
  }
  if (polylineLength(ink.points) <= 1e-9) throw new InvalidInputError('Ink stroke is degenerate');
}

/**
 * Thins out a freehand stroke, dropping points that sit close to the line between their neighbours.
 * A drawn line arrives with far more points than its shape needs.
 *
 * Ties are broken consistently, so the same stroke always simplifies to the same points.
 */
export function simplifyInk(
  points: readonly Vec2[],
  tolerance = DEFAULT_GEOMETRY_LIMITS.inkSimplificationTolerance,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): readonly Vec2[] {
  if (!Array.isArray(points) || points.length < 2 || points.length > limits.maximumVertices * 8) {
    throw new InvalidInputError('Raw ink input is outside supported point bounds');
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new InvalidInputError('Ink simplification tolerance must be finite and non-negative');
  }
  for (const point of points) validateLocalPoint(point, limits.maximumCoordinate, 'ink point');
  if (samePoint(points[0]!, points.at(-1)!)) {
    throw new InvalidInputError('Ink input must describe an open stroke');
  }
  const kept = new Set<number>([0, points.length - 1]);
  const visit = (start: number, end: number): void => {
    let furthestIndex = -1;
    let furthestDistance = tolerance;
    for (let index = start + 1; index < end; index += 1) {
      const distance = pointSegmentDistance(points[index]!, points[start]!, points[end]!);
      if (distance > furthestDistance) {
        furthestDistance = distance;
        furthestIndex = index;
      }
    }
    if (furthestIndex >= 0) {
      kept.add(furthestIndex);
      visit(start, furthestIndex);
      visit(furthestIndex, end);
    }
  };
  visit(0, points.length - 1);
  const simplified = [...kept].sort((left, right) => left - right).map((index) => copyVec2(points[index]!));
  if (simplified.length > limits.maximumVertices) {
    throw new InvalidInputError('Simplified ink still exceeds the configured vertex bound', {
      pointCount: simplified.length,
      maximum: limits.maximumVertices,
    });
  }
  return simplified;
}

export function moveInk(
  ink: InkAnnotation,
  delta: Vec2,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): InkAnnotation {
  validateInk(ink, limits);
  validateLocalPoint(delta, limits.maximumCoordinate, 'ink move delta');
  return createInk({ ...ink, points: ink.points.map((point) => add2(point, delta)) }, limits);
}

export function replaceInkPoints(
  ink: InkAnnotation,
  points: readonly Vec2[],
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): InkAnnotation {
  validateInk(ink, limits);
  return createInk({ ...ink, points }, limits);
}

export function editInkPoint(
  ink: InkAnnotation,
  index: number,
  point: Vec2,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): InkAnnotation {
  validateInk(ink, limits);
  validateIndex(index, ink.points.length);
  const points = ink.points.map((current, currentIndex) =>
    currentIndex === index ? copyVec2(point) : copyVec2(current));
  return createInk({ ...ink, points }, limits);
}

export function validateMultiLeader(
  annotation: MultiLeaderAnnotation,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): void {
  validateId(annotation.id, 'annotation id');
  if (!Array.isArray(annotation.anchors) || annotation.anchors.length < 1
    || annotation.anchors.length > limits.maximumAnchors) {
    throw new InvalidInputError(`Annotation requires 1–${limits.maximumAnchors} anchors`);
  }
  const ids = new Set<string>();
  for (const leg of annotation.anchors) {
    validateId(leg.id, 'anchor id');
    if (ids.has(leg.id)) throw new InvalidInputError(`Duplicate anchor id "${leg.id}"`, { id: leg.id });
    ids.add(leg.id);
    validateMultiAnchor(leg.anchor, limits);
    validateRouteShape(leg.route);
  }
  if (annotation.occlusion !== 'keep' && annotation.occlusion !== 'fade' && annotation.occlusion !== 'hide') {
    throw new InvalidInputError('Annotation occlusion policy is invalid');
  }
}

export function addAnnotationAnchor(
  annotation: MultiLeaderAnnotation,
  leg: AnnotationLeg,
  index = annotation.anchors.length,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): MultiLeaderAnnotation {
  validateMultiLeader(annotation, limits);
  validateInsertIndex(index, annotation.anchors.length);
  if (annotation.anchors.some(({ id }) => id === leg.id)) {
    throw new InvalidInputError(`Duplicate anchor id "${leg.id}"`, { id: leg.id });
  }
  const next = clone({
    ...annotation,
    anchors: [...annotation.anchors.slice(0, index), leg, ...annotation.anchors.slice(index)],
  });
  validateMultiLeader(next, limits);
  return next;
}

export function retargetAnnotationAnchor(
  annotation: MultiLeaderAnnotation,
  legId: string,
  anchor: MultiAnchor,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): MultiLeaderAnnotation {
  return updateLeg(annotation, legId, (leg) => ({ ...leg, anchor: clone(anchor) }), limits);
}

export function setAnnotationLegRoute(
  annotation: MultiLeaderAnnotation,
  legId: string,
  route: LegRoute,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): MultiLeaderAnnotation {
  return updateLeg(annotation, legId, (leg) => ({ ...leg, route: clone(route) }), limits);
}

export function removeAnnotationAnchor(
  annotation: MultiLeaderAnnotation,
  legId: string,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): MultiLeaderAnnotation {
  validateMultiLeader(annotation, limits);
  if (!annotation.anchors.some(({ id }) => id === legId)) throw new NotFoundError('anchor', legId);
  if (annotation.anchors.length === 1) {
    throw new InvariantViolationError('Cannot remove the final annotation anchor', {
      annotationId: annotation.id,
      anchorId: legId,
      minimumAnchors: 1,
    });
  }
  return clone({ ...annotation, anchors: annotation.anchors.filter(({ id }) => id !== legId) });
}

export function reorderAnnotationAnchor(
  annotation: MultiLeaderAnnotation,
  legId: string,
  toIndex: number,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): MultiLeaderAnnotation {
  validateMultiLeader(annotation, limits);
  validateIndex(toIndex, annotation.anchors.length);
  const fromIndex = annotation.anchors.findIndex(({ id }) => id === legId);
  if (fromIndex < 0) throw new NotFoundError('anchor', legId);
  if (fromIndex === toIndex) return clone(annotation);
  const anchors = [...annotation.anchors];
  const [leg] = anchors.splice(fromIndex, 1);
  anchors.splice(toIndex, 0, leg!);
  return clone({ ...annotation, anchors });
}

/**
 * Works out where a region's outline falls on screen.
 *
 * Being off screen and being un-drawable are not the same thing, and treating them as the same made
 * regions disappear. A point past the edge of the window still has a perfectly good position, and
 * the SVG clips it for free — so it is kept. Dropping the region instead meant that zooming in on a
 * revision cloud to read it, which is exactly what a reviewer does, made the cloud and its note
 * vanish rather than simply run off the edge.
 *
 * What genuinely cannot be drawn is a point behind the camera, which has no screen position at all.
 * One of those is fatal to the whole outline, because there is no honest place to put it and a
 * made-up coordinate would drag the rest of the shape with it.
 *
 * Whether the result is worth drawing is the CALLER's decision, because it needs the viewport this
 * function is not given: see `regionOnScreen` in `runtime.ts`. Deciding it here from the points
 * alone is what produced the second half of this bug — a region zoomed in on until it is bigger
 * than the screen has no visible corner at all, and dropping it then deletes the very markup the
 * user zoomed in to read.
 */
export function projectRegion(
  anchor: RegionAnchor,
  project: (point: Vec3) => Vec2 | undefined,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): ProjectedRegion | undefined {
  validateRegionAnchor(anchor, limits);
  const local = regionOutline(anchor.geometry);
  const projected = local.map((point) => project(localToWorld(anchor.plane, point)));
  if (projected.some((point) => point === undefined || !finiteVec2(point))) return undefined;
  return { kind: anchor.geometry.kind, points: projected as readonly Vec2[], closed: true };
}

/**
 * Finds where a leader line should meet a region: the nearest point on its outline to the label.
 *
 * Using the outline itself is what makes the arrow follow the label — slide a note sideways above a
 * cloud and the arrowhead slides along the cloud's top edge with it. It also keeps the arrow on the
 * shape that is actually drawn, which matters for an ellipse, or for a rectangle the camera has
 * turned so it is no longer square to the screen.
 *
 * Recalculated every frame, because the outline is on screen and moves with the camera.
 */
export function regionAttachment(region: ProjectedRegion, label: ScreenBounds): RegionAttachment {
  const centre = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
  const xs = region.points.map(({ x }) => x);
  const ys = region.points.map(({ y }) => y);
  const column = centre.x < Math.min(...xs) ? 0 : centre.x > Math.max(...xs) ? 2 : 1;
  const row = centre.y < Math.min(...ys) ? 0 : centre.y > Math.max(...ys) ? 2 : 1;
  let point = centre;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < region.points.length; index += 1) {
    const start = region.points[index]!;
    const end = region.points[(index + 1) % region.points.length]!;
    const candidate = closestOnSegment(centre, start, end);
    const distance = distance2(centre, candidate);
    if (distance < best) {
      best = distance;
      point = candidate;
    }
  }
  return Object.freeze({ point: Object.freeze(point), zone: REGION_ZONES[row]![column]! });
}

export function projectInk(
  ink: InkAnnotation,
  project: (point: Vec3) => Vec2 | undefined,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
): ProjectedInk | undefined {
  validateInk(ink, limits);
  const points = ink.points.map((point) => project(localToWorld(ink.plane, point)));
  if (points.some((point) => point === undefined || !finiteVec2(point))) return undefined;
  return { kind: 'ink', points: points as readonly Vec2[], closed: false };
}

export function generateRevisionCloudArcs(
  outline: readonly Vec2[],
  requestedArcLength: number,
): readonly RevisionCloudArc[] {
  if (outline.length < 3 || !Number.isFinite(requestedArcLength) || requestedArcLength <= 0) return [];
  const segments = outline.map((start, index) => {
    const end = outline[(index + 1) % outline.length]!;
    return { start, end, length: distance2(start, end) };
  }).filter(({ length }) => length > 1e-9);
  const perimeter = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (perimeter <= 1e-9) return [];
  const count = Math.max(3, Math.round(perimeter / requestedArcLength));
  const step = perimeter / count;
  const ccw = signedArea(outline) > 0;
  const points = Array.from({ length: count + 1 }, (_, index) =>
    pointAtPerimeter(segments, Math.min(index * step, perimeter), perimeter));
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const normal = ccw ? { x: dy / length, y: -dx / length } : { x: -dy / length, y: dx / length };
    return {
      start,
      control: {
        x: (start.x + end.x) / 2 + normal.x * step * 0.28,
        y: (start.y + end.y) / 2 + normal.y * step * 0.28,
      },
      end,
    };
  });
}

/** Converts a precise shape into the plane-and-points form the document stores. */
export function regionAnchorToCore(
  anchor: RegionAnchor,
  modelId: string | undefined = anchor.modelId,
): CoreRegionAnchor {
  validateRegionAnchor(anchor);
  return {
    kind: 'region',
    ...(modelId === undefined ? {} : { modelId }),
    plane: {
      origin: copyVec3(anchor.plane.origin),
      normal: copyVec3(anchor.plane.normal),
      xAxis: copyVec3(anchor.plane.xAxis),
    },
    vertices: regionOutline(anchor.geometry).map(copyVec2),
    shape: anchor.geometry.kind,
    fallbackPoint: copyVec3(anchor.plane.origin),
  };
}

export function regionAnchorFromCore(anchor: CoreRegionAnchor): RegionAnchor {
  const normal = normalize(anchor.plane.normal);
  const xAxis = normalize(anchor.plane.xAxis);
  const yAxis = normalize(cross(normal, xAxis));
  const plane: DrawingPlane = {
    origin: copyVec3(anchor.plane.origin),
    xAxis,
    yAxis,
    normal,
  };
  const vertices = anchor.vertices.map(copyVec2);
  if (vertices.length < 3) throw new InvalidInputError('Core region requires at least three vertices');
  let geometry: ClosedRegionGeometry;
  if (anchor.shape === 'rectangle') {
    const bounds = localBounds(vertices);
    geometry = {
      kind: 'rectangle',
      center: bounds.center,
      width: bounds.width,
      height: bounds.height,
    };
  } else if (anchor.shape === 'ellipse') {
    const bounds = localBounds(vertices);
    geometry = {
      kind: 'ellipse',
      center: bounds.center,
      radiusX: bounds.width / 2,
      radiusY: bounds.height / 2,
    };
  } else if (anchor.shape === 'revision-cloud') {
    geometry = { kind: 'revision-cloud', vertices, arcLength: defaultCloudArcLength(vertices) };
  } else {
    geometry = { kind: 'polygon', vertices };
  }
  return createRegionAnchor(plane, geometry, DEFAULT_GEOMETRY_LIMITS, anchor.modelId);
}

export function legRouteToCore(route: LegRoute): AnnotationRouting {
  validateRouteShape(route);
  return route.mode === 'manual'
    ? { kind: 'manual', vertices: route.vertices.map(copyVec2) }
    : { kind: 'automatic', mode: route.mode };
}

export function legRouteFromCore(route: AnnotationRouting): LegRoute {
  return route.kind === 'manual'
    ? { mode: 'manual', vertices: route.vertices.map(copyVec2) }
    : { mode: route.mode };
}

export function multiLeaderToCore(annotation: MultiLeaderAnnotation): CoreAnnotation {
  validateMultiLeader(annotation);
  const anchors: CoreAnnotationLeg[] = annotation.anchors.map((leg) => ({
    id: leg.id,
    anchor: leg.anchor.kind === 'region' ? regionAnchorToCore(leg.anchor) : clone(leg.anchor),
    routing: legRouteToCore(leg.route),
  }));
  return {
    id: annotation.id,
    anchors,
    content: clone(annotation.content),
    placement: clone(annotation.placement),
    ...(annotation.styleId === undefined ? {} : { styleId: annotation.styleId }),
    ...(annotation.styleOverride === undefined
      ? {}
      : { styleOverride: clone(annotation.styleOverride) as JsonObject }),
    occlusion: annotation.occlusion,
    metadata: clone(annotation.metadata),
  };
}

export function multiLeaderFromCore(annotation: CoreAnnotation): MultiLeaderAnnotation {
  const converted: MultiLeaderAnnotation = {
    kind: 'annotation',
    id: annotation.id,
    anchors: annotation.anchors.map((leg) => ({
      id: leg.id,
      anchor: leg.anchor.kind === 'region' ? regionAnchorFromCore(leg.anchor) : clone(leg.anchor),
      route: legRouteFromCore(leg.routing),
    })),
    content: clone(annotation.content),
    placement: clone(annotation.placement),
    ...(annotation.styleId === undefined ? {} : { styleId: annotation.styleId }),
    ...(annotation.styleOverride === undefined ? {} : { styleOverride: clone(annotation.styleOverride) }),
    occlusion: annotation.occlusion ?? 'keep',
    metadata: clone(annotation.metadata),
  };
  validateMultiLeader(converted);
  return converted;
}

/**
 * Reads ink strokes out of a saved document and writes them back.
 *
 * Forgiving in both directions: a field written by a newer version rides along untouched rather
 * than causing the file to be rejected. Creating or editing a stroke is checked strictly instead.
 */
export function inkToJson(ink: InkAnnotation, unrecognized: string[] = []): JsonObject {
  validateInk(ink, DEFAULT_GEOMETRY_LIMITS, unrecognized);
  return clone(ink) as unknown as JsonObject;
}

export function inkFromJson(value: JsonObject, unrecognized: string[] = []): InkAnnotation {
  const ink = clone(value) as unknown as InkAnnotation;
  validateInk(ink, DEFAULT_GEOMETRY_LIMITS, unrecognized);
  return ink;
}

function updateLeg(
  annotation: MultiLeaderAnnotation,
  legId: string,
  update: (leg: AnnotationLeg) => AnnotationLeg,
  limits: GeometryLimits,
): MultiLeaderAnnotation {
  validateMultiLeader(annotation, limits);
  let found = false;
  const anchors = annotation.anchors.map((leg) => {
    if (leg.id !== legId) return leg;
    found = true;
    const next = update(clone(leg));
    if (next.id !== legId) throw new InvalidInputError('Anchor update cannot change its id');
    return next;
  });
  if (!found) throw new NotFoundError('anchor', legId);
  const next = clone({ ...annotation, anchors });
  validateMultiLeader(next, limits);
  return next;
}

function validateMultiAnchor(anchor: MultiAnchor, limits: GeometryLimits): void {
  if (anchor.kind === 'region') {
    validateRegionAnchor(anchor, limits);
    return;
  }
  if (anchor.kind === 'world-point') {
    validateVec3(anchor.point, 'world point');
    return;
  }
  if (anchor.kind === 'element') {
    validateId(anchor.modelId, 'model id');
    validateId(anchor.elementId, 'element id');
    validateVec3(anchor.fallbackPoint, 'element fallback point');
    return;
  }
  throw new InvalidInputError('Unsupported annotation anchor kind');
}

function validateRouteShape(route: LegRoute): void {
  if (route.mode === 'straight' || route.mode === 'dogleg' || route.mode === 'orthogonal') return;
  if (route.mode !== 'manual' || route.vertices.length > 64) throw new InvalidInputError('Invalid leg route');
  for (const point of route.vertices) {
    if (!finiteVec2(point)) throw new InvalidInputError('Manual route vertex must be finite');
  }
}

function editableVertices(anchor: RegionAnchor, limits: GeometryLimits): readonly Vec2[] {
  validateRegionAnchor(anchor, limits);
  if (anchor.geometry.kind !== 'polygon' && anchor.geometry.kind !== 'revision-cloud') {
    throw new InvalidInputError('Only polygon and revision-cloud vertices are editable', {
      kind: anchor.geometry.kind,
    });
  }
  return anchor.geometry.vertices;
}

function withVertices(
  anchor: RegionAnchor,
  vertices: readonly Vec2[],
  limits: GeometryLimits,
): RegionAnchor {
  const geometry = anchor.geometry;
  if (geometry.kind !== 'polygon' && geometry.kind !== 'revision-cloud') {
    throw new InvalidInputError('Region has no editable vertices');
  }
  return createRegionAnchor(
    anchor.plane,
    { ...geometry, vertices: vertices.map(copyVec2) },
    limits,
    anchor.modelId,
  );
}

function validateClosedVertices(
  vertices: readonly Vec2[],
  limits: GeometryLimits,
  label: string,
): void {
  if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > limits.maximumVertices) {
    throw new InvalidInputError(`${label} must contain 3–${limits.maximumVertices} vertices`);
  }
  for (const point of vertices) validateLocalPoint(point, limits.maximumCoordinate, `${label} vertex`);
  for (let index = 0; index < vertices.length; index += 1) {
    if (samePoint(vertices[index]!, vertices[(index + 1) % vertices.length]!)) {
      throw new InvalidInputError(`${label} contains a degenerate edge`, { index });
    }
  }
  if (Math.abs(signedArea(vertices)) <= 1e-9) throw new InvalidInputError(`${label} area is degenerate`);
}

function regionOutline(geometry: ClosedRegionGeometry): readonly Vec2[] {
  if (geometry.kind === 'polygon' || geometry.kind === 'revision-cloud') {
    return geometry.vertices.map(copyVec2);
  }
  if (geometry.kind === 'rectangle') {
    const halfWidth = geometry.width / 2;
    const halfHeight = geometry.height / 2;
    return [
      { x: geometry.center.x - halfWidth, y: geometry.center.y - halfHeight },
      { x: geometry.center.x + halfWidth, y: geometry.center.y - halfHeight },
      { x: geometry.center.x + halfWidth, y: geometry.center.y + halfHeight },
      { x: geometry.center.x - halfWidth, y: geometry.center.y + halfHeight },
    ];
  }
  const segments = 48;
  return Array.from({ length: segments }, (_, index) => {
    const angle = index / segments * Math.PI * 2;
    return {
      x: geometry.center.x + Math.cos(angle) * geometry.radiusX,
      y: geometry.center.y + Math.sin(angle) * geometry.radiusY,
    };
  });
}

function localToWorld(plane: DrawingPlane, point: Vec2): Vec3 {
  return {
    x: plane.origin.x + plane.xAxis.x * point.x + plane.yAxis.x * point.y,
    y: plane.origin.y + plane.xAxis.y * point.x + plane.yAxis.y * point.y,
    z: plane.origin.z + plane.xAxis.z * point.x + plane.yAxis.z * point.y,
  };
}

function pointAtPerimeter(
  segments: readonly Readonly<{ start: Vec2; end: Vec2; length: number }>[],
  distance: number,
  perimeter: number,
): Vec2 {
  let remaining = distance === perimeter ? perimeter : ((distance % perimeter) + perimeter) % perimeter;
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const ratio = segment.length === 0 ? 0 : remaining / segment.length;
      return {
        x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        y: segment.start.y + (segment.end.y - segment.start.y) * ratio,
      };
    }
    remaining -= segment.length;
  }
  return copyVec2(segments.at(-1)!.end);
}

function localBounds(vertices: readonly Vec2[]): Readonly<{
  center: Vec2;
  width: number;
  height: number;
}> {
  const minimumX = Math.min(...vertices.map(({ x }) => x));
  const maximumX = Math.max(...vertices.map(({ x }) => x));
  const minimumY = Math.min(...vertices.map(({ y }) => y));
  const maximumY = Math.max(...vertices.map(({ y }) => y));
  return {
    center: { x: (minimumX + maximumX) / 2, y: (minimumY + maximumY) / 2 },
    width: maximumX - minimumX,
    height: maximumY - minimumY,
  };
}

function defaultCloudArcLength(vertices: readonly Vec2[]): number {
  const perimeter = vertices.reduce((sum, point, index) =>
    sum + distance2(point, vertices[(index + 1) % vertices.length]!), 0);
  return Math.max(perimeter / 16, 1e-6);
}

/** How far a point is from a line segment. */
export function pointSegmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  return distance2(point, closestOnSegment(point, start, end));
}

function closestOnSegment(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return copyVec2(start);
  const ratio = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return { x: start.x + ratio * dx, y: start.y + ratio * dy };
}

function polylineLength(points: readonly Vec2[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) length += distance2(points[index - 1]!, points[index]!);
  return length;
}

function signedArea(points: readonly Vec2[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twice += current.x * next.y - next.x * current.y;
  }
  return twice / 2;
}

function validateLimits(limits: GeometryLimits): void {
  if (!Number.isFinite(limits.maximumCoordinate) || limits.maximumCoordinate <= 0
    || !Number.isInteger(limits.maximumVertices) || limits.maximumVertices < 3
    || !Number.isInteger(limits.maximumAnchors) || limits.maximumAnchors < 1
    || !Number.isFinite(limits.inkSimplificationTolerance)
    || limits.inkSimplificationTolerance < 0) {
    throw new InvalidInputError('Geometry limits are invalid');
  }
}

function validateExtent(value: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value <= 1e-9 || value > maximum) {
    throw new InvalidInputError(`${label} must be finite, positive, and bounded`, { value, maximum });
  }
}

function validateLocalPoint(point: Vec2, maximum: number, label: string): void {
  if (!finiteVec2(point) || Math.abs(point.x) > maximum || Math.abs(point.y) > maximum) {
    throw new InvalidInputError(`${label} must be finite and bounded`);
  }
}

function validateVec3(point: Vec3, label: string): void {
  if (point === null || typeof point !== 'object'
    || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
    throw new InvalidInputError(`${label} must be finite`);
  }
}

function validateId(id: string, label: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256 || /[\u0000-\u001f]/u.test(id)) {
    throw new InvalidInputError(`${label} is invalid`);
  }
}

/**
 * Strict when authoring, forgiving when loading — the same rule used throughout.
 *
 * Loading, an unrecognised field belongs to a newer version and is carried through. Authoring, it
 * is a typo, and the author hears about it where they made it.
 */
function assertExactKeys(
  value: object,
  allowed: readonly string[],
  label: string,
  unrecognized?: string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length === 0) return;
  if (unrecognized === undefined) {
    throw new InvalidInputError(`${label} contains unsupported fields`, { unknown });
  }
  for (const key of unknown) unrecognized.push(`${label}.${key}`);
}

function validateInsertIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index > length) {
    throw new InvalidInputError('Insertion index is out of range', { index, length });
  }
}

function validateIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new InvalidInputError('Index is out of range', { index, length });
  }
}

function finiteVec2(point: Vec2 | undefined): point is Vec2 {
  return point !== undefined && point !== null && typeof point === 'object'
    && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function samePoint(left: Vec2, right: Vec2): boolean {
  return left.x === right.x && left.y === right.y;
}

function add2(left: Vec2, right: Vec2): Vec2 {
  return { x: left.x + right.x, y: left.y + right.y };
}

function distance2(left: Vec2, right: Vec2): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function magnitude(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector: Vec3): Vec3 {
  const length = magnitude(vector);
  return length === 0 ? { x: 0, y: 0, z: 0 } : {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function copyVec2(point: Vec2): Vec2 {
  return { x: point.x, y: point.y };
}

function copyVec3(point: Vec3): Vec3 {
  return { x: point.x, y: point.y, z: point.z };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
