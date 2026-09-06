import type { Bounds2 } from './frame.js';
import type { LabelSector } from './labelPlacer.js';
import { DEFAULT_LANDING } from './definitions.js';
import { LandingStability, type LandingProposal } from './landing-stability.js';
import { segmentThroughInterior } from './lint.js';
import { routeLegs, type LandingGeometry, type ScreenBounds } from './routing.js';
import { stabilizeTemporalOrder } from './temporal-order.js';
import type { Vec2 } from './types.js';

export interface OrganizationInput {
  readonly id: string;
  readonly labelSize: Readonly<{ width: number; height: number }>;
  readonly legs: readonly Readonly<{ id: string; anchor: Vec2 }>[];
  readonly landing?: LandingGeometry;
}

export interface OrganizationOptions {
  readonly modelBounds: Bounds2;
  readonly clearance?: number;
  readonly labelGap?: number;
  readonly laneGap?: number;
  readonly obstacles?: readonly ScreenBounds[];
  readonly routes?: readonly (readonly Vec2[])[];
  readonly snap?: (position: Vec2, input: OrganizationInput) => Vec2;
  /** IDs whose last visible geometry continues reserving a slot while temporarily off screen. */
  readonly reserveIds?: ReadonlySet<string>;
  /** Reserved IDs currently represented by fixed preview geometry instead of cached allocation. */
  readonly suspendedIds?: ReadonlySet<string>;
}

export type OrganizationRouteClass = 'direct' | 'bend' | 'escape';
export type OrganizationSide = 'left' | 'right';

export interface OrganizationLegPlan {
  readonly id: string;
  readonly points: readonly Vec2[];
}

export interface OrganizationPlan {
  readonly id: string;
  readonly position: Vec2;
  readonly bounds: Bounds2;
  readonly sector: LabelSector;
  readonly side: OrganizationSide;
  readonly routeClass: OrganizationRouteClass;
  readonly legs: readonly OrganizationLegPlan[];
  /** Conflicts left after the bounded candidate pass. Zero is expected for feasible fixtures. */
  readonly conflicts: number;
}

const DEFAULT_CLEARANCE = 24;
const DEFAULT_LABEL_GAP = 10;
const DEFAULT_LANE_GAP = 12;
const SECTOR_HYSTERESIS = 24;
/** A couple of screen pixels absorbs final OrbitControls damping without masking a real reorder. */
const ORDER_SWITCH_MARGIN = 2;
/** Retain a feasible side slot through the last pixels of camera damping. */
const SLOT_SWITCH_MARGIN = 2;
const EPSILON = 1e-7;

interface Candidate {
  readonly input: OrganizationInput;
  readonly anchor: Vec2;
  readonly sector: LabelSector;
  readonly side: OrganizationSide;
  readonly top: boolean;
  readonly depth: number;
}

function representativeAnchor(input: OrganizationInput): Vec2 {
  if (input.legs.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const leg of input.legs) {
    x += leg.anchor.x;
    y += leg.anchor.y;
  }
  return { x: x / input.legs.length, y: y / input.legs.length };
}

function stickySector(anchor: Vec2, bounds: Bounds2, previous: LabelSector | undefined): LabelSector {
  const dx = anchor.x - (bounds.min.x + bounds.max.x) / 2;
  const dy = anchor.y - (bounds.min.y + bounds.max.y) / 2;
  let left = dx < 0;
  let top = dy < 0;
  if (previous) {
    const wasLeft = previous.endsWith('left');
    const wasTop = previous.startsWith('top');
    left = wasLeft ? dx < SECTOR_HYSTERESIS : dx <= -SECTOR_HYSTERESIS;
    top = wasTop ? dy < SECTOR_HYSTERESIS : dy <= -SECTOR_HYSTERESIS;
  }
  return top ? (left ? 'top-left' : 'top-right') : (left ? 'bottom-left' : 'bottom-right');
}

function box(position: Vec2, size: Readonly<{ width: number; height: number }>): Bounds2 {
  return { min: position, max: { x: position.x + size.width, y: position.y + size.height } };
}

function boxesOverlap(a: Bounds2, b: Bounds2): boolean {
  return !(a.max.x <= b.min.x || a.min.x >= b.max.x || a.max.y <= b.min.y || a.min.y >= b.max.y);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function naturalSlotY(
  candidate: Candidate,
  bounds: Bounds2,
  used: readonly Bounds2[],
  gap: number,
  previousY: number | undefined,
): number | undefined {
  const height = candidate.input.labelSize.height;
  const middle = (bounds.min.y + bounds.max.y) / 2;
  const minimum = candidate.top ? bounds.min.y : middle;
  const maximum = (candidate.top ? middle : bounds.max.y) - height;
  if (maximum < minimum) return undefined;
  const natural = clamp(candidate.anchor.y - height / 2, minimum, maximum);
  const feasible = (y: number): boolean => {
    const probe = { min: { x: 0, y }, max: { x: 1, y: y + height } };
    return y >= minimum - EPSILON && y <= maximum + EPSILON
      && used.every((slot) => !boxesOverlap(probe, { min: { x: 0, y: slot.min.y - gap }, max: { x: 1, y: slot.max.y + gap } }));
  };
  const proposals = [natural];
  for (const slot of used) proposals.push(slot.min.y - gap - height, slot.max.y + gap);
  const best = proposals
    .filter((y) => y >= minimum - EPSILON && y <= maximum + EPSILON)
    .sort((a, b) => Math.abs(a - natural) - Math.abs(b - natural) || a - b)
    .find(feasible);
  // A slot is an allocation identity, not a target coordinate. Compare its current cost with the
  // best current slot: a subpixel change at an exact above/below tie cannot swap a label, while a
  // clearly closer newly-open slot still wins. Current geometry is checked first, so clearance
  // always overrides continuity.
  if (previousY !== undefined && best !== undefined && feasible(previousY)
    && Math.abs(previousY - natural) <= Math.abs(best - natural) + SLOT_SWITCH_MARGIN) return previousY;
  return best;
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return Math.abs(orientation(a, b, p)) <= EPSILON
    && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON
    && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}

/** Includes proper crossings and collinear overlap, but ignores a shared endpoint. */
function segmentsConflict(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const sharedEndpoint = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) <= EPSILON && Math.abs(p.y - q.y) <= EPSILON;
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  const intersects = ((o1 > EPSILON && o2 < -EPSILON) || (o1 < -EPSILON && o2 > EPSILON))
    && ((o3 > EPSILON && o4 < -EPSILON) || (o3 < -EPSILON && o4 > EPSILON));
  if (intersects) return true;
  const touches = onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
  if (!touches) return false;
  if (sharedEndpoint(a, c) || sharedEndpoint(a, d) || sharedEndpoint(b, c) || sharedEndpoint(b, d)) {
    // A shared endpoint is harmless unless the segments continue over the same interval.
    return Math.abs(o1) <= EPSILON && Math.abs(o2) <= EPSILON
      && Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) < Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - EPSILON
      || Math.abs(o1) <= EPSILON && Math.abs(o2) <= EPSILON
      && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) < Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - EPSILON;
  }
  return true;
}

function segmentIntersectsBox(a: Vec2, b: Vec2, bounds: Bounds2): boolean {
  if ((a.x > bounds.min.x + EPSILON && a.x < bounds.max.x - EPSILON
    && a.y > bounds.min.y + EPSILON && a.y < bounds.max.y - EPSILON)
    || (b.x > bounds.min.x + EPSILON && b.x < bounds.max.x - EPSILON
      && b.y > bounds.min.y + EPSILON && b.y < bounds.max.y - EPSILON)) return true;
  const tl = bounds.min;
  const tr = { x: bounds.max.x, y: bounds.min.y };
  const br = bounds.max;
  const bl = { x: bounds.min.x, y: bounds.max.y };
  return segmentsConflict(a, b, tl, tr) || segmentsConflict(a, b, tr, br)
    || segmentsConflict(a, b, br, bl) || segmentsConflict(a, b, bl, tl);
}

function polylineSegments(points: readonly Vec2[]): Array<readonly [Vec2, Vec2]> {
  const result: Array<readonly [Vec2, Vec2]> = [];
  for (let index = 1; index < points.length; index += 1) result.push([points[index - 1]!, points[index]!]);
  return result;
}

function dedupe(points: readonly Vec2[]): readonly Vec2[] {
  return points.filter((point, index) => index === 0 || Math.abs(point.x - points[index - 1]!.x) > EPSILON
    || Math.abs(point.y - points[index - 1]!.y) > EPSILON);
}

function routeReentersModel(points: readonly Vec2[], bounds: Bounds2): boolean {
  let exited = false;
  for (const [from, to] of polylineSegments(points)) {
    const fromInside = from.x >= bounds.min.x - EPSILON && from.x <= bounds.max.x + EPSILON
      && from.y >= bounds.min.y - EPSILON && from.y <= bounds.max.y + EPSILON;
    if (exited && segmentThroughInterior(
      { start: from, end: to },
      { x: bounds.min.x, y: bounds.min.y, width: bounds.max.x - bounds.min.x, height: bounds.max.y - bounds.min.y },
    )) return true;
    const toOutside = to.x < bounds.min.x - EPSILON || to.x > bounds.max.x + EPSILON
      || to.y < bounds.min.y - EPSILON || to.y > bounds.max.y + EPSILON;
    if (!fromInside || toOutside) exited = true;
  }
  return false;
}

export class OrganizationPlanner {
  private readonly previousSectors = new Map<string, LabelSector>();
  private readonly previousClasses = new Map<string, OrganizationRouteClass>();
  private readonly cachedInputs = new Map<string, OrganizationInput>();
  private readonly previousCompactIds = new Set<string>();
  private readonly previousSlotY = new Map<string, number>();
  private readonly landingStability: LandingStability;
  private readonly ownsLandingStability: boolean;
  /** Last accepted allocation order, kept separately for each quadrant. */
  private readonly previousOrderBySector = new Map<LabelSector, readonly string[]>();
  /** Compact fans order by vertical anchor position rather than side depth. */
  private readonly previousCompactOrderBySide = new Map<OrganizationSide, readonly string[]>();

  public constructor(sharedLandingStability?: LandingStability) {
    this.ownsLandingStability = sharedLandingStability === undefined;
    this.landingStability = sharedLandingStability ?? new LandingStability();
  }

  public plan(inputs: readonly OrganizationInput[], options: OrganizationOptions): OrganizationPlan[] {
    const clearance = Math.max(0, options.clearance ?? DEFAULT_CLEARANCE);
    const gap = Math.max(0, options.labelGap ?? DEFAULT_LABEL_GAP);
    const laneGap = Math.max(1, options.laneGap ?? DEFAULT_LANE_GAP);
    const bounds = options.modelBounds;
    const visibleIds = new Set(inputs.map((input) => input.id));
    // `reserveIds` includes temporarily offscreen and route-preview annotations, so their
    // attachment choice returns with them. Without reservations only this frame is live.
    // A shared map is pruned by the runtime's authoritative live-ID set. The planner cannot
    // infer that set from a partial visible frame without dropping fixed/offscreen annotations.
    if (options.reserveIds !== undefined) this.forget(options.reserveIds);
    else if (this.ownsLandingStability) this.landingStability.forget(visibleIds);
    for (const input of inputs) {
      if (input.legs.length === 0 || input.legs.some((leg) => !Number.isFinite(leg.anchor.x) || !Number.isFinite(leg.anchor.y))) continue;
      this.cachedInputs.set(input.id, {
        ...input,
        labelSize: { ...input.labelSize },
        legs: input.legs.map((leg) => ({ id: leg.id, anchor: { ...leg.anchor } })),
        ...(input.landing === undefined ? {} : { landing: { ...input.landing } }),
      });
    }
    const planningInputs = inputs.filter((input) => !options.suspendedIds?.has(input.id));
    if (options.reserveIds !== undefined) {
      for (const id of [...options.reserveIds].sort()) {
        if (visibleIds.has(id)) continue;
        if (options.suspendedIds?.has(id)) continue;
        const cached = this.cachedInputs.get(id);
        if (cached !== undefined) planningInputs.push(cached);
      }
    }
    const candidates = planningInputs.map((input): Candidate => {
      const anchor = representativeAnchor(input);
      const sector = stickySector(anchor, bounds, this.previousSectors.get(input.id));
      const side: OrganizationSide = sector.endsWith('left') ? 'left' : 'right';
      return { input, anchor, sector, side, top: sector.startsWith('top'), depth: side === 'left' ? anchor.x - bounds.min.x : bounds.max.x - anchor.x };
    });

    const plans: OrganizationPlan[] = [];
    const occupied: Bounds2[] = (options.obstacles ?? []).map((obstacle) => ({
      min: { x: obstacle.x, y: obstacle.y },
      max: { x: obstacle.x + obstacle.width, y: obstacle.y + obstacle.height },
    }));
    const routed: Array<readonly Vec2[]> = [...(options.routes ?? [])];
    const groups = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const key = `${candidate.sector}`;
      const group = groups.get(key) ?? [];
      group.push(candidate);
      groups.set(key, group);
    }

    // A side-on view can project every visible anchor into one narrow strip beside the model.
    // Splitting that strip into two independently bounded half-height quadrants wastes the other
    // half's ordering and sends most labels to remote top/bottom escape lanes. When the cluster
    // genuinely spans both halves, prepare one height-aware monotone stack for the whole side.
    const compactSideY = new Map<string, number>();
    const compactOrders = new Map<OrganizationSide, readonly string[]>();
    for (const side of ['left', 'right'] as const) {
      const sideCandidates = stabilizeTemporalOrder(
        candidates.filter((candidate) => candidate.side === side).map((candidate) => ({ ...candidate, id: candidate.input.id, value: candidate.anchor.y })),
        {
          ...(this.previousCompactOrderBySide.get(side) === undefined
            ? {} : { previousIds: this.previousCompactOrderBySide.get(side)! }),
          switchMargin: ORDER_SWITCH_MARGIN,
        },
      );
      const spansBothHalves = sideCandidates.some((candidate) => candidate.top)
        && sideCandidates.some((candidate) => !candidate.top);
      const inwardLanding = side === 'left' ? 'right' : 'left';
      const compatibleLandings = sideCandidates.every(({ input }) => input.landing?.side === undefined
        || input.landing.side === 'auto' || input.landing.side === inwardLanding);
      const packedHeight = sideCandidates.reduce((sum, candidate) => sum + candidate.input.labelSize.height, 0)
        + Math.max(0, sideCandidates.length - 1) * gap;
      const modelWidth = bounds.max.x - bounds.min.x;
      const sideDepths = sideCandidates.map((candidate) => candidate.depth);
      const depthSpread = sideDepths.length === 0 ? 0 : Math.max(...sideDepths) - Math.min(...sideDepths);
      const retained = sideCandidates.length > 0
        && sideCandidates.every((candidate) => this.previousCompactIds.has(candidate.input.id));
      // Separate enter/leave thresholds stop a slowly orbiting face flickering between a compact
      // fan and quadrant escapes at one exact projection ratio.
      const foreshortened = sideDepths.length > 0
        && Math.max(...sideDepths) <= modelWidth * (retained ? 0.24 : 0.2)
        && depthSpread <= modelWidth * (retained ? 0.16 : 0.125);
      if (!spansBothHalves || !compatibleLandings || !foreshortened || packedHeight <= bounds.max.y - bounds.min.y) continue;
      let y = (bounds.min.y + bounds.max.y - packedHeight) / 2;
      for (const candidate of sideCandidates) {
        compactSideY.set(candidate.input.id, y);
        y += candidate.input.labelSize.height + gap;
      }
      compactOrders.set(side, sideCandidates.map((candidate) => candidate.input.id));
    }

    const sectorOrders = new Map<LabelSector, readonly string[]>();
    const acceptedLandings = new Map<string, LandingProposal>();
    for (const sector of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const group = stabilizeTemporalOrder(
        (groups.get(sector) ?? []).map((candidate) => ({ ...candidate, id: candidate.input.id, value: candidate.depth })),
        {
          ...(this.previousOrderBySector.get(sector) === undefined
            ? {} : { previousIds: this.previousOrderBySector.get(sector)! }),
          switchMargin: ORDER_SWITCH_MARGIN,
        },
      );
      sectorOrders.set(sector, group.map((candidate) => candidate.input.id));
      const sideSlots: Bounds2[] = [];
      let escapeExtent = laneGap;
      for (const candidate of group) {
        const { input, side, top } = candidate;
        const landingReach = input.landing?.render === 'none' ? 0
          : (input.landing?.length ?? DEFAULT_LANDING.length) + (input.landing?.gap ?? DEFAULT_LANDING.gap);
        const x = side === 'left'
          ? bounds.min.x - clearance - landingReach - input.labelSize.width
          : bounds.max.x + clearance + landingReach;
        const columnMinX = x;
        const columnMaxX = x + input.labelSize.width;
        const fixedSlots = occupied.filter((slot) => slot.max.x > columnMinX && slot.min.x < columnMaxX
          && (top ? slot.min.y < (bounds.min.y + bounds.max.y) / 2 : slot.max.y > (bounds.min.y + bounds.max.y) / 2));
        const compactY = compactSideY.get(input.id);
        const previousSlotY = this.previousSlotY.get(input.id);
        const slotY = compactY ?? naturalSlotY(
          candidate, bounds, [...sideSlots, ...fixedSlots], gap, previousSlotY,
        );
        const retainedSideSlot = compactY === undefined && slotY !== undefined && previousSlotY !== undefined
          && Math.abs(slotY - previousSlotY) <= EPSILON;
        let position = { x, y: slotY ?? 0 };
        // Retain a feasible escape lane after a small movement. Switching between a short side
        // route and a top/bottom lane is visually much more noticeable than a few extra pixels.
        const previousClass = this.previousClasses.get(input.id);
        const halfHeight = (bounds.max.y - bounds.min.y) / 2;
        const retainEscape = previousClass === 'escape' && slotY !== undefined
          && halfHeight - input.labelSize.height < gap + SECTOR_HYSTERESIS;
        const naturalY = candidate.anchor.y - input.labelSize.height / 2;
        let routeClass: OrganizationRouteClass = compactY !== undefined ? 'bend' : slotY !== undefined && !retainEscape
          ? (Math.abs(slotY - naturalY) <= EPSILON ? 'direct' : 'bend')
          : 'escape';
        if (routeClass === 'escape') {
          position = {
            x,
            y: top
              ? bounds.min.y - clearance - escapeExtent - input.labelSize.height
              : bounds.max.y + clearance + escapeExtent,
          };
          escapeExtent += input.labelSize.height + gap + laneGap;
        }
        const unsnappedPosition = position;
        const snapped = options.snap?.(position, input);
        if (snapped && Number.isFinite(snapped.x) && Number.isFinite(snapped.y)) {
          const snappedBounds = box(snapped, input.labelSize);
          const preservesSide = side === 'left' ? snappedBounds.max.x <= bounds.min.x - clearance : snappedBounds.min.x >= bounds.max.x + clearance;
          const overlapsFixed = occupied.some((other) => boxesOverlap(snappedBounds, other));
          if (preservesSide && !overlapsFixed) position = snapped;
        }

        const routeInputs = input.legs.map((leg) => ({ id: leg.id, anchor: leg.anchor, route: { mode: 'dogleg' as const } }));
        const landingProposal = (at: Vec2): LandingProposal => this.landingStability.preview(
          input.id,
          routeInputs,
          { x: at.x, y: at.y, width: input.labelSize.width, height: input.labelSize.height },
          {
            ...(input.landing ?? {}),
            ...(input.landing?.side === undefined || input.landing.side === 'auto'
              ? { side: side === 'left' ? 'right' as const : 'left' as const } : {}),
          },
        );
        const makeLegPlans = (kind: OrganizationRouteClass): OrganizationLegPlan[] => {
          // Route all legs together first: routeLegs deliberately selects one shared landing for
          // a multileader, which is lost if each leg is routed in isolation.
          const proposal = landingProposal(position);
          const actualRoutes = routeLegs(
            routeInputs,
            { x: position.x, y: position.y, width: input.labelSize.width, height: input.labelSize.height },
            proposal.landing,
          );
          return input.legs.map((leg, index) => {
            const actual = actualRoutes[index]!.points;
            const end = actual.at(-1)!;
            const edgeX = side === 'left' ? bounds.min.x : bounds.max.x;
            if (kind !== 'escape') {
              const edge = { x: edgeX, y: leg.anchor.y };
              if (compactY !== undefined) {
                const suffix = actual.length > 2 ? actual.slice(-2) : [end];
                return { id: leg.id, points: dedupe([leg.anchor, edge, suffix[0]!, ...suffix]) };
              }
              if (Math.abs(end.y - leg.anchor.y) <= input.labelSize.height / 3) return { id: leg.id, points: actual };
              const suffix = actual.length > 2 ? actual.slice(-2) : [end];
              return { id: leg.id, points: dedupe([leg.anchor, edge, { x: suffix[0]!.x, y: edge.y }, ...suffix]) };
            }
            const edgeY = top ? bounds.min.y : bounds.max.y;
            const suffix = actual.length > 2 ? actual.slice(-2) : [end];
            // Escape lanes must meet the landing at the Y chosen by routeLegs. Styled text lands
            // on a text baseline rather than the label midpoint; using the midpoint here inserts
            // a small vertical jog immediately before the otherwise horizontal landing.
            const laneY = suffix[0]!.y;
            return { id: leg.id, points: dedupe([leg.anchor, { x: leg.anchor.x, y: edgeY }, { x: leg.anchor.x, y: laneY }, { x: suffix[0]!.x, y: laneY }, ...suffix]) };
          });
        };

        let legPlans = makeLegPlans(routeClass);
        const conflictsFor = (testBounds: Bounds2, testLegs: readonly OrganizationLegPlan[]): number => {
          let conflicts = occupied.filter((other) => boxesOverlap(testBounds, other)).length;
          for (const route of routed) for (const segment of polylineSegments(route)) if (segmentIntersectsBox(segment[0], segment[1], testBounds)) conflicts += 1;
          for (const leg of testLegs) for (const segment of polylineSegments(leg.points)) {
            conflicts += occupied.filter((other) => segmentIntersectsBox(segment[0], segment[1], other)).length;
            for (const route of routed) for (const other of polylineSegments(route)) if (segmentsConflict(segment[0], segment[1], other[0], other[1])) conflicts += 1;
          }
          conflicts += testLegs.filter((leg) => routeReentersModel(leg.points, bounds)).length;
          return conflicts;
        };
        let labelBounds = box(position, input.labelSize);
        let conflicts = conflictsFor(labelBounds, legPlans);
        if ((position.x !== unsnappedPosition.x || position.y !== unsnappedPosition.y) && conflicts > 0) {
          position = unsnappedPosition;
          legPlans = makeLegPlans(routeClass);
          labelBounds = box(position, input.labelSize);
          conflicts = conflictsFor(labelBounds, legPlans);
        }

        // A remembered slot is only a preference. If its complete route now conflicts, compare
        // the current best side slot before spending an escape lane; this avoids retaining a
        // visually stable allocation at the expense of an avoidable crossing.
        if (retainedSideSlot && routeClass !== 'escape' && conflicts > 0) {
          const freshY = naturalSlotY(candidate, bounds, [...sideSlots, ...fixedSlots], gap, undefined);
          if (freshY !== undefined && Math.abs(freshY - position.y) > EPSILON) {
            const retained = { position, routeClass, legs: legPlans, bounds: labelBounds, conflicts };
            position = { x, y: freshY };
            routeClass = Math.abs(freshY - naturalY) <= EPSILON ? 'direct' : 'bend';
            legPlans = makeLegPlans(routeClass);
            labelBounds = box(position, input.labelSize);
            conflicts = conflictsFor(labelBounds, legPlans);
            if (conflicts >= retained.conflicts) {
              position = retained.position;
              routeClass = retained.routeClass;
              legPlans = retained.legs;
              labelBounds = retained.bounds;
              conflicts = retained.conflicts;
            }
          }
        }

        // Actual geometry, rather than slot capacity alone, decides whether the short side route
        // is retained. One deterministic escape candidate bounds this repair pass.
        if (routeClass !== 'escape' && conflicts > 0) {
          const escapedPosition = {
            x,
            y: top ? bounds.min.y - clearance - escapeExtent - input.labelSize.height
              : bounds.max.y + clearance + escapeExtent,
          };
          const prior = position;
          position = escapedPosition;
          const escaped = makeLegPlans('escape');
          const escapedBounds = box(position, input.labelSize);
          const escapedConflicts = conflictsFor(escapedBounds, escaped);
          if (escapedConflicts <= conflicts) {
            routeClass = 'escape';
            legPlans = escaped;
            labelBounds = escapedBounds;
            conflicts = escapedConflicts;
            escapeExtent += input.labelSize.height + gap + laneGap;
          } else position = prior;
        }

        // Fixed work can occupy the first escape lane. Try a bounded number of successively farther
        // lanes and retain the least-conflicting complete geometry.
        if (routeClass === 'escape' && conflicts > 0) {
          let best = { position, bounds: labelBounds, legs: legPlans, conflicts, extent: escapeExtent };
          let trialExtent = escapeExtent;
          for (let attempt = 0; attempt < 8 && best.conflicts > 0; attempt += 1) {
            position = {
              x,
              y: top ? bounds.min.y - clearance - trialExtent - input.labelSize.height
                : bounds.max.y + clearance + trialExtent,
            };
            const trialLegs = makeLegPlans('escape');
            const trialBounds = box(position, input.labelSize);
            const trialConflicts = conflictsFor(trialBounds, trialLegs);
            const nextExtent = trialExtent + input.labelSize.height + gap + laneGap;
            if (trialConflicts < best.conflicts) best = { position, bounds: trialBounds, legs: trialLegs, conflicts: trialConflicts, extent: nextExtent };
            trialExtent = nextExtent;
          }
          position = best.position;
          labelBounds = best.bounds;
          legPlans = best.legs;
          conflicts = best.conflicts;
          escapeExtent = Math.max(escapeExtent, best.extent);
        }

        const plan = { id: input.id, position, bounds: labelBounds, sector: candidate.sector, side, routeClass, legs: legPlans, conflicts } satisfies OrganizationPlan;
        plans.push(plan);
        // Re-preview from the accepted geometry after every speculative escape/snap candidate.
        // `preview` is pure, so this cannot let a rejected branch change the next frame.
        acceptedLandings.set(input.id, landingProposal(position));
        if (routeClass !== 'escape') sideSlots.push(labelBounds);
        occupied.push(labelBounds);
        for (const leg of legPlans) routed.push(leg.points);
      }
    }
    // Every position and route above is recomputed from current geometry. Only its allocation
    // identity is remembered, and only after the complete plan clears current hard constraints.
    // A stale conflict must never become the next frame's preferred arrangement.
    if (plans.every((plan) => plan.conflicts === 0)) {
      // A fixed preview replaces only part of the planner's geometry. Committing its partial
      // order would discard absent reserved IDs, so a near tie could reorder when it returns.
      // Keep the last complete order and compact membership until every ID participates again.
      const preserveSuspendedAllocation = (options.suspendedIds?.size ?? 0) > 0;
      for (const candidate of candidates) {
        this.previousSectors.set(candidate.input.id, candidate.sector);
        const plan = plans.find((entry) => entry.id === candidate.input.id);
        if (plan !== undefined) this.previousClasses.set(candidate.input.id, plan.routeClass);
        if (plan !== undefined) this.previousSlotY.set(candidate.input.id, plan.position.y);
        if (!preserveSuspendedAllocation) {
          if (compactSideY.has(candidate.input.id)) this.previousCompactIds.add(candidate.input.id);
          else this.previousCompactIds.delete(candidate.input.id);
        }
      }
      if (!preserveSuspendedAllocation) {
        for (const [sector, order] of sectorOrders) {
          if (order.length === 0) this.previousOrderBySector.delete(sector);
          else this.previousOrderBySector.set(sector, order);
        }
        for (const [side, order] of compactOrders) this.previousCompactOrderBySide.set(side, order);
      }
      for (const [id, proposal] of acceptedLandings) this.landingStability.commit(id, proposal);
    }
    return plans.filter((plan) => visibleIds.has(plan.id)).sort((a, b) => a.id.localeCompare(b.id));
  }

  public forget(liveIds: ReadonlySet<string>): void {
    for (const id of this.previousSectors.keys()) if (!liveIds.has(id)) this.previousSectors.delete(id);
    for (const id of this.previousClasses.keys()) if (!liveIds.has(id)) this.previousClasses.delete(id);
    for (const id of this.cachedInputs.keys()) if (!liveIds.has(id)) this.cachedInputs.delete(id);
    for (const id of this.previousCompactIds) if (!liveIds.has(id)) this.previousCompactIds.delete(id);
    for (const id of this.previousSlotY.keys()) if (!liveIds.has(id)) this.previousSlotY.delete(id);
    if (this.ownsLandingStability) this.landingStability.forget(liveIds);
    for (const [sector, order] of this.previousOrderBySector) {
      const retained = order.filter((id) => liveIds.has(id));
      if (retained.length === 0) this.previousOrderBySector.delete(sector);
      else this.previousOrderBySector.set(sector, retained);
    }
    for (const [side, order] of this.previousCompactOrderBySide) {
      const retained = order.filter((id) => liveIds.has(id));
      if (retained.length === 0) this.previousCompactOrderBySide.delete(side);
      else this.previousCompactOrderBySide.set(side, retained);
    }
  }
}
