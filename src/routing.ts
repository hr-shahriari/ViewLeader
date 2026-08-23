import { DEFAULT_LANDING, type LandingRender, type LandingSide } from './definitions.js';
import { segmentThroughInterior } from './lint.js';
import { InvalidInputError } from './errors.js';
import type { AnnotationPlacement, Vec2 } from './types.js';

export interface ScreenBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type LegRoute =
  | { readonly mode: 'straight' }
  | { readonly mode: 'dogleg' }
  | { readonly mode: 'orthogonal' }
  | { readonly mode: 'manual'; readonly vertices: readonly Vec2[] };

export interface PlacementInput {
  readonly id: string;
  readonly projectedAnchors: readonly Vec2[];
  readonly labelSize: Readonly<{ width: number; height: number }>;
  readonly placement: AnnotationPlacement;
  /** The user pinned this annotation. It still follows its anchor, but nothing may push it aside
   *  to make room for something else. */
  readonly locked?: boolean;
}

export interface RoutedLeg {
  readonly id: string;
  readonly points: readonly Vec2[];
}

export interface RouteLegInput {
  readonly id: string;
  readonly anchor: Vec2;
  readonly route: LegRoute;
}

/**
 * How a leader line meets its label: which side it lands on and how long the horizontal tail is.
 * Anything left unset falls back to {@link DEFAULT_LANDING}.
 */
export interface LandingGeometry {
  readonly length?: number;
  readonly side?: LandingSide;
  readonly gap?: number;
  readonly render?: LandingRender;
  /** Where the first and last lines of text sit inside the label, so a leader can land level with
   *  a line rather than floating between two. */
  readonly textLines?: Readonly<{ first: number; last: number }>;
  /**
   * Where the leader should bend for a label that had to be pushed out into a second column.
   *
   * Passed in rather than worked out here, because only the placer knows how wide the column the
   * label came from was. Guessing from the label alone puts the bend too close and the leader cuts
   * back across its own neighbours.
   */
  readonly overflowElbow?: Vec2;
}

/**
 * Routes leader lines to labels in the positions they actually ended up in, not where they were
 * first requested — otherwise lines would point at where a label nearly went.
 */
export function routeLegs(
  legs: readonly RouteLegInput[],
  finalLabelBounds: ScreenBounds,
  landing?: LandingGeometry,
  options: RouteOptions = {},
): readonly RoutedLeg[] {
  validateBounds(finalLabelBounds, 'label bounds');
  const shared = sharedLanding(legs, finalLabelBounds, landing);
  const obstacles = options.obstacles ?? [];
  const ids = new Set<string>();
  return legs.map((leg) => {
    if (ids.has(leg.id)) throw new InvalidInputError(`Duplicate route leg id "${leg.id}"`, { id: leg.id });
    ids.add(leg.id);
    validatePoint(leg.anchor, 'leg anchor');
    validateLegRoute(leg.route);
    const points = routeLeg(leg.anchor, finalLabelBounds, leg.route, shared);
    // Only the approach changes. The shoulder and the landing stay put, so several legs merging
    // into one shared shoulder still merge after a detour.
    return { id: leg.id, points: detourAround(points, obstacles) };
  });
}

export interface RouteOptions {
  /** Other annotations' labels that this one's leader lines must route around rather than through. */
  readonly obstacles?: readonly ScreenBounds[];
}

/**
 * Puts a gap in a leader line where it passes underneath another label — what AutoCAD calls a
 * dimension break.
 *
 * Some crossings cannot be routed away: the leader has nowhere better to go, or several legs of one
 * note sweep a triangle every neighbour has to cross. A break is the drafting convention for
 * exactly that case. The line keeps its route and simply stops being drawn where another label owns
 * the space.
 *
 * Returns the pieces to draw, which is usually just one — the line was never interrupted.
 *
 * A leader whose arrowhead is itself inside the label is left completely alone. Breaking it there
 * would erase the end that points at the thing being annotated, which is worse than the overlap it
 * would tidy up.
 */
export function breakAroundObstacles(
  points: readonly Vec2[],
  obstacles: readonly ScreenBounds[],
  clearance = DIMBREAK_CLEARANCE,
): readonly (readonly Vec2[])[] {
  if (obstacles.length === 0 || points.length < 2) return [points];
  const start = points[0]!;
  const covered = obstacles.some((rect) => start.x > rect.x && start.x < rect.x + rect.width
    && start.y > rect.y && start.y < rect.y + rect.height);
  if (covered) return [points];

  const pieces: Vec2[][] = [];
  let current: Vec2[] = [copyPoint(start)];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    // Where along this line each label starts and stops covering it, as a fraction of its length.
    const gaps = obstacles
      .flatMap((rect) => {
        const span = segmentSpanInside(from, to, rect, clearance);
        return span === undefined ? [] : [span];
      })
      .sort((left, right) => left[0] - right[0]);

    const at = (t: number): Vec2 => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    let cursor = 0;
    for (const [enter, exit] of gaps) {
      if (exit <= cursor) continue;
      const gapStart = Math.max(cursor, enter);
      if (gapStart > cursor) current.push(at(gapStart));
      if (gapStart > 0 || current.length > 1) {
        if (current.length > 1) pieces.push(current);
        current = [];
      }
      cursor = Math.min(1, exit);
      if (cursor < 1) current = [at(cursor)];
    }
    if (cursor < 1) current.push(copyPoint(to));
  }
  if (current.length > 1) pieces.push(current);
  return pieces.length === 0 ? [points] : pieces;
}

/**
 * Which stretch of a line falls inside a rectangle, widened slightly at both ends so the resulting
 * gap reads as intentional rather than as a rendering glitch. Nothing if the line never enters it.
 */
function segmentSpanInside(
  from: Vec2,
  to: Vec2,
  rect: ScreenBounds,
  clearance: number,
): readonly [number, number] | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 1e-9) return undefined;
  let t0 = 0;
  let t1 = 1;
  const tests: readonly (readonly [number, number])[] = [
    [-dx, from.x - rect.x], [dx, rect.x + rect.width - from.x],
    [-dy, from.y - rect.y], [dy, rect.y + rect.height - from.y],
  ];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return undefined;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    if (t0 > t1) return undefined;
  }
  if (t1 <= 0 || t0 >= 1) return undefined;
  const pad = clearance / length;
  return [Math.max(0, t0 - pad), Math.min(1, t1 + pad)];
}

/**
 * How far clear of a label a detour passes. Two pixels: enough to be genuinely outside it, little
 * enough that the leader reads as passing beside the label rather than swerving around it.
 */
const DETOUR_CLEARANCE = 2;

/**
 * How much clear space a break leaves on each side of the label the leader passes under.
 *
 * Three pixels: wide enough to look deliberate at any zoom, narrow enough that the eye still
 * carries the line across the gap — which is the difference between a break and a line that simply
 * stops. It matches AutoCAD's default break size at the scale these leaders are drawn.
 */
const DIMBREAK_CLEARANCE = 6;

/** How many foreign labels this polyline runs through. The lint's own test, so the two agree. */
function obstacleHits(points: readonly Vec2[], obstacles: readonly ScreenBounds[]): number {
  let hits = 0;
  for (let index = 1; index < points.length; index += 1) {
    const segment = { start: points[index - 1]!, end: points[index]! };
    for (const rect of obstacles) if (segmentThroughInterior(segment, rect)) hits += 1;
  }
  return hits;
}

/**
 * Bends a leader line around another label it would otherwise run straight through.
 *
 * A leader crossing someone else's text is one of the faults the lint reports as an error, and it
 * is the one thing placement alone cannot fix — moving the label just moves the crossing.
 *
 * The crossing is almost always on the long diagonal from the arrowhead out to the label, so the
 * two options tried are the two L-shaped paths through that diagonal's corners: across then up, or
 * up then across.
 *
 * A bend is only kept when it genuinely crosses fewer labels. A leader that cannot be helped keeps
 * its straight diagonal, which a drafter would rather see than a detour that achieved nothing.
 *
 * ponytail: one bend, two candidates, and only the blocked segment. Escaping a really crowded field
 * would need proper path-finding; the crowded-scene test records how much is left unfixed, which is
 * the number to look at before building it.
 */
function detourOnce(
  points: readonly Vec2[],
  obstacles: readonly ScreenBounds[],
): readonly Vec2[] {
  if (obstacles.length === 0 || points.length < 2) return points;
  const before = obstacleHits(points, obstacles);
  if (before === 0) return points;

  // Bend whichever segment is actually blocked, not always the first: a label pushed into a
  // second column bends once before it even sets off.
  //
  // The final run into the label is never bent. It is short, it sits alongside the text, and it is
  // the part that makes a leader read as a leader rather than a line that happens to stop near some
  // words. Other code also relies on the last two points being that run.
  let index = -1;
  for (let step = 1; step < points.length - 1 && index < 0; step += 1) {
    const segment = { start: points[step - 1]!, end: points[step]! };
    if (obstacles.some((rect) => segmentThroughInterior(segment, rect))) index = step;
  }
  if (index < 0) return points;

  const from = points[index - 1]!;
  const to = points[index]!;
  const blocking = obstacles.filter((rect) => segmentThroughInterior({ start: from, end: to }, rect));
  const length = (path: readonly Vec2[]): number => path.slice(1).reduce(
    (total, point, position) => total + Math.hypot(point.x - path[position]!.x, point.y - path[position]!.y),
    0,
  );

  // One bend is enough to clear a label the line merely clips at a corner. Getting past a large
  // one means going around a whole side, which takes two. Corners are tried first, then full sides,
  // then a wide sweep as a last resort — the scoring below prefers the smallest detour anyway.
  const inserts: Vec2[][] = [];
  for (const rect of blocking) {
    const left = rect.x - DETOUR_CLEARANCE;
    const right = rect.x + rect.width + DETOUR_CLEARANCE;
    const top = rect.y - DETOUR_CLEARANCE;
    const bottom = rect.y + rect.height + DETOUR_CLEARANCE;
    const topLeft = { x: left, y: top };
    const topRight = { x: right, y: top };
    const bottomLeft = { x: left, y: bottom };
    const bottomRight = { x: right, y: bottom };
    inserts.push([topLeft], [topRight], [bottomLeft], [bottomRight]);
    // Each side of the label, in both directions.
    for (const [a, b] of [
      [topLeft, topRight], [topRight, bottomRight], [bottomRight, bottomLeft], [bottomLeft, topLeft],
    ] as const) inserts.push([a, b], [b, a]);
  }
  inserts.push([{ x: from.x, y: to.y }], [{ x: to.x, y: from.y }]);

  let best = points;
  let bestHits = before;
  let bestLength = length(points);
  for (const insert of inserts) {
    const candidate = dedupePoints([...points.slice(0, index), ...insert, ...points.slice(index)]);
    const hits = obstacleHits(candidate, obstacles);
    const span = length(candidate);
    // Fewest labels crossed wins, and the shorter route breaks a tie. Shorter matters because
    // every extra pixel of leader is another pixel that could cross a neighbouring leader — the
    // other fault being graded, and the one a careless detour makes worse.
    if (hits < bestHits || (hits === bestHits && hits < before && span < bestLength)) {
      best = candidate;
      bestHits = hits;
      bestLength = span;
    }
  }
  return best;
}

/**
 * Keeps bending until bending stops helping.
 *
 * Dodging one label can push a leader into a second one, so a single pass is not always enough.
 * Every pass either crosses strictly fewer labels or changes nothing at all, so this stops by
 * itself — the iteration limit is a safety net, not the thing that ends the loop.
 */
const MAX_DETOUR_PASSES = 3;

function detourAround(
  points: readonly Vec2[],
  obstacles: readonly ScreenBounds[],
): readonly Vec2[] {
  let current = points;
  for (let pass = 0; pass < MAX_DETOUR_PASSES; pass += 1) {
    const next = detourOnce(current, obstacles);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Picks one meeting point for all of an annotation's leader lines, so several legs fan into a single
 * shared tail — the way a multileader is drawn on a real drawing.
 *
 * Decided before any leg is routed. Routed one at a time, a note pointing at three things on
 * opposite sides would sprout leaders from opposite edges of its own label, or from two different
 * lines of its text. Both read as three separate notes, when it is one note pointing three times.
 *
 * The average position of the anchors decides where they meet, so the shared tail sits where the
 * legs actually are. A side written explicitly in the style still wins — a drafter who set it meant
 * it. With fewer than two legs there is nothing to share.
 */
function sharedLanding(
  legs: readonly RouteLegInput[],
  bounds: ScreenBounds,
  landing: LandingGeometry | undefined,
): LandingGeometry | undefined {
  const anchors = legs
    .filter((leg) => leg.route.mode === 'dogleg' && finitePoint(leg.anchor))
    .map((leg) => leg.anchor);
  if (anchors.length < 2) return landing;

  const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const middle = average(anchors);
  const side: LandingSide = landing?.side === undefined || landing.side === 'auto'
    ? (middle.x <= centre.x ? 'left' : 'right')
    : landing.side;
  // Every leg lands at the same height, so the fan meets at one point rather than at two different
  // lines of text. Leaders arriving from above or below do not use text lines at all.
  const lines = side === 'top' || side === 'bottom' ? undefined : landing?.textLines;
  const line = lines === undefined ? undefined
    : middle.y <= centre.y ? lines.first : lines.last;
  return {
    ...landing,
    side,
    ...(line === undefined ? {} : { textLines: { first: line, last: line } }),
  };
}

export function routeLeg(
  anchor: Vec2,
  finalLabelBounds: ScreenBounds,
  route: LegRoute,
  landing?: LandingGeometry,
): readonly Vec2[] {
  validatePoint(anchor, 'anchor');
  validateBounds(finalLabelBounds, 'label bounds');
  validateLegRoute(route);
  const attachment = rectangleAttachment(finalLabelBounds, anchor);
  switch (route.mode) {
    case 'straight':
      return [copyPoint(anchor), attachment];
    case 'dogleg':
      return doglegRoute(anchor, finalLabelBounds, landing ?? {});
    case 'orthogonal': {
      const dx = Math.abs(attachment.x - anchor.x);
      const dy = Math.abs(attachment.y - anchor.y);
      const elbow = dx > dy
        ? { x: attachment.x, y: anchor.y }
        : { x: anchor.x, y: attachment.y };
      return dedupePoints([copyPoint(anchor), elbow, attachment]);
    }
    case 'manual': {
      // Which edge the leader meets is decided by where it arrives from, not by where it started.
      // A drafter who routed a line up and over to the top of a label expects it to arrive at the
      // top; choosing the edge facing the arrowhead instead sends the last segment jumping back
      // across the label it just reached.
      const approach = route.vertices.at(-1) ?? anchor;
      return dedupePoints([
        copyPoint(anchor),
        ...route.vertices.map(copyPoint),
        rectangleAttachment(finalLabelBounds, approach),
      ]);
    }
  }
}

export function setManualPlacement(position: Vec2): AnnotationPlacement {
  validatePoint(position, 'manual placement');
  return { kind: 'manual', position: copyPoint(position) };
}

export function resetPlacement(): AnnotationPlacement {
  return { kind: 'automatic' };
}

export function setRouteMode(mode: Exclude<LegRoute['mode'], 'manual'>): LegRoute {
  if (mode !== 'straight' && mode !== 'dogleg' && mode !== 'orthogonal') {
    throw new InvalidInputError(`Unsupported route mode "${String(mode)}"`, { mode });
  }
  return { mode };
}

export function resetRoute(mode: Exclude<LegRoute['mode'], 'manual'> = 'dogleg'): LegRoute {
  return setRouteMode(mode);
}

export function addRouteVertex(
  route: LegRoute,
  index: number,
  vertex: Vec2,
): LegRoute {
  const vertices = manualVertices(route);
  validateInsertionIndex(index, vertices.length);
  validatePoint(vertex, 'manual route vertex');
  return {
    mode: 'manual',
    vertices: [...vertices.slice(0, index), copyPoint(vertex), ...vertices.slice(index)],
  };
}

export function moveRouteVertex(
  route: LegRoute,
  index: number,
  vertex: Vec2,
): LegRoute {
  const vertices = manualVertices(route);
  validateExistingIndex(index, vertices.length);
  validatePoint(vertex, 'manual route vertex');
  return {
    mode: 'manual',
    vertices: vertices.map((current, currentIndex) =>
      currentIndex === index ? copyPoint(vertex) : copyPoint(current)),
  };
}

export function removeRouteVertex(route: LegRoute, index: number): LegRoute {
  const vertices = manualVertices(route);
  validateExistingIndex(index, vertices.length);
  return {
    mode: 'manual',
    vertices: vertices.filter((_, currentIndex) => currentIndex !== index).map(copyPoint),
  };
}

export function validateLegRoute(route: LegRoute): void {
  if (route === null || typeof route !== 'object') throw new InvalidInputError('Route must be an object');
  if (route.mode === 'straight' || route.mode === 'dogleg' || route.mode === 'orthogonal') return;
  if (route.mode !== 'manual' || !Array.isArray(route.vertices) || route.vertices.length > 64) {
    throw new InvalidInputError('Manual route must contain at most 64 vertices');
  }
  for (const vertex of route.vertices) validatePoint(vertex, 'manual route vertex');
}

/**
 * The same as {@link doglegRoute}, turned ninety degrees, for labels stacked above or below the
 * model rather than beside it.
 *
 * Without it a leader to a label overhead would leave through the label's left or right face and
 * then double back underneath it.
 *
 * Lengths and gaps mean what they do horizontally, measured vertically instead. The rule about
 * meeting a particular line of text does not apply: that is about which line a sideways leader
 * arrives at, and a leader coming from above meets the top edge whatever the text says.
 */
function verticalDoglegRoute(anchor: Vec2, bounds: ScreenBounds, landing: LandingGeometry): readonly Vec2[] {
  const { length, side, gap, render } = { ...DEFAULT_LANDING, ...landing };
  const away = side === 'top' ? -1 : 1;
  const near = away < 0 ? bounds.y : bounds.y + bounds.height;
  const x = Math.min(Math.max(anchor.x, bounds.x), bounds.x + bounds.width);
  const elbow = landing.overflowElbow;
  const bend = elbow !== undefined
    && Number.isFinite(elbow.x) && Number.isFinite(elbow.y)
    && Math.sign(elbow.y - anchor.y) === Math.sign(near - anchor.y)
    && Math.abs(elbow.y - anchor.y) < Math.abs(near - anchor.y)
    ? [{ x: elbow.x, y: elbow.y }]
    : [];
  if (render === 'none') return dedupePoints([copyPoint(anchor), ...bend, { x, y: near }]);
  // An underlined landing runs the full width of the label; turned vertically, its full height.
  const attachment = { x, y: render === 'underline' ? near - away * bounds.height : near + away * gap };
  const shoulder = { x, y: (render === 'underline' ? near : attachment.y) + away * length };
  return dedupePoints([copyPoint(anchor), ...bend, shoulder, attachment]);
}

/**
 * The standard leader shape: a diagonal from the arrowhead to a bend, then a short horizontal run
 * into the label, meeting it level with a line of text rather than at the middle of an edge.
 */
function doglegRoute(anchor: Vec2, bounds: ScreenBounds, landing: LandingGeometry): readonly Vec2[] {
  const { length, side, gap, render } = { ...DEFAULT_LANDING, ...landing };
  const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  if (side === 'top' || side === 'bottom') return verticalDoglegRoute(anchor, bounds, landing);
  // Left to itself, the leader meets whichever side of the label faces it, so it never doubles back.
  const away = (side === 'auto' ? anchor.x <= centre.x : side === 'left') ? -1 : 1;
  const near = away < 0 ? bounds.x : bounds.x + bounds.width;
  // A leader coming from above meets the first line of text; one from below meets the last. That
  // is the drafting rule, and it is what stops a leader pointing at the middle of a paragraph.
  const y = landing.textLines === undefined
    ? centre.y
    : bounds.y + (anchor.y <= centre.y ? landing.textLines.first : landing.textLines.last);
  // A label pushed into a second column bends at the edge of the column it came from. Skipped when
  // the bend would sit on the wrong side of the meeting point, since that makes the leader double
  // back — worse than no bend at all.
  const elbow = landing.overflowElbow;
  const bend = elbow !== undefined
    && Number.isFinite(elbow.x) && Number.isFinite(elbow.y)
    && Math.sign(elbow.x - anchor.x) === Math.sign(near - anchor.x)
    && Math.abs(elbow.x - anchor.x) < Math.abs(near - anchor.x)
    ? [{ x: elbow.x, y: elbow.y }]
    : [];
  if (render === 'none') return dedupePoints([copyPoint(anchor), ...bend, { x: near, y }]);
  // An underlined landing runs right across the label instead of stopping at its edge.
  const attachment = { x: render === 'underline' ? near - away * bounds.width : near + away * gap, y };
  const shoulder = { x: (render === 'underline' ? near : attachment.x) + away * length, y };
  return dedupePoints([copyPoint(anchor), ...bend, shoulder, attachment]);
}

function rectangleAttachment(bounds: ScreenBounds, target: Vec2): Vec2 {
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const xScale = dx === 0 ? Number.POSITIVE_INFINITY : bounds.width / 2 / Math.abs(dx);
  const yScale = dy === 0 ? Number.POSITIVE_INFINITY : bounds.height / 2 / Math.abs(dy);
  const scale = Math.min(xScale, yScale);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function manualVertices(route: LegRoute): readonly Vec2[] {
  validateLegRoute(route);
  if (route.mode !== 'manual') {
    throw new InvalidInputError('Route vertex edits require manual routing', { mode: route.mode });
  }
  return route.vertices;
}

function validateInsertionIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index > length) {
    throw new InvalidInputError('Route vertex insertion index is out of range', { index, length });
  }
}

function validateExistingIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new InvalidInputError('Route vertex index is out of range', { index, length });
  }
}

function validateSize(size: Readonly<{ width: number; height: number }>): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)
    || size.width <= 0 || size.height <= 0) {
    throw new InvalidInputError('Label size must be finite and positive');
  }
}

function validateBounds(bounds: ScreenBounds, label: string): void {
  if (!finiteBounds(bounds) || bounds.width <= 0 || bounds.height <= 0) {
    throw new InvalidInputError(`${label} must be finite and positive`);
  }
}

function finiteBounds(bounds: ScreenBounds): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite);
}

function validatePoint(point: Vec2, label: string): void {
  if (!finitePoint(point)) throw new InvalidInputError(`${label} must be finite`);
}

function finitePoint(point: Vec2): boolean {
  return point !== null && typeof point === 'object'
    && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidInputError(`${label} must be finite and non-negative`);
  }
  return value;
}

function average(points: readonly Vec2[]): Vec2 {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function contains(bounds: ScreenBounds, point: Vec2): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function intersectsViewport(bounds: ScreenBounds, viewport: ScreenBounds): boolean {
  return bounds.x + bounds.width >= viewport.x
    && bounds.x <= viewport.x + viewport.width
    && bounds.y + bounds.height >= viewport.y
    && bounds.y <= viewport.y + viewport.height;
}

function overlaps(left: ScreenBounds, right: ScreenBounds): boolean {
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height;
}

function inflate(bounds: ScreenBounds, amount: number): ScreenBounds {
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    width: bounds.width + amount * 2,
    height: bounds.height + amount * 2,
  };
}

function dedupePoints(points: readonly Vec2[]): readonly Vec2[] {
  const result: Vec2[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous === undefined || previous.x !== point.x || previous.y !== point.y) {
      result.push(copyPoint(point));
    }
  }
  return result;
}

function copyPoint(point: Vec2): Vec2 {
  return { x: point.x, y: point.y };
}
