// Decides where every label goes.
//
// Labels are placed outside the model rather than on top of it, lined up in shared columns down the
// sides or rows above and below — the way notes are arranged on a real drawing sheet, rather than
// scattered wherever each one happens to point.
//
// Two rules shape almost everything here. Labels must stack in the same order as the things they
// point at, or their leader lines cross. And a label must not jump to a different side of the model
// just because the camera moved slightly, or the whole drawing appears to swim about.
import type { Vec2 } from './types.js';

export type LabelSector = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
/**
 * How labels are arranged around the model.
 *
 * `sides` uses the left and right margins, `rows` the top and bottom, and `perimeter` all four at
 * once. The first two therefore only ever have about half the available edge to work with, which is
 * not enough for a busy drawing — on a typical viewport two columns offer barely more space than a
 * crowded scene demands, so labels have nowhere to go and every adjustment simply moves the problem.
 * `perimeter` roughly doubles the room.
 */
export type PlacementMode = 'sides' | 'rows' | 'auto' | 'perimeter';
export interface ViewportInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export type RoutingHint = 'direct' | 'diagonal' | 'overflow';
export type ConnectionEdge = 'left' | 'right' | 'top' | 'bottom';

export interface PlacementResult {
  annotationId: string;
  position: Vec2;
  sector: LabelSector;
  connectionEdge: ConnectionEdge;
  routingHint: RoutingHint;
  overflowElbow?: Vec2;
}

interface InternalAnchor {
  id: string;
  screenPos: Vec2;
  angle: number;
}

/** Whether two lines genuinely cross. Merely touching at their ends does not count. */
function segmentsCross(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const d = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** How far outside the model the label columns sit. Also used to snap a dragged label back. */
export const EDGE_MARGIN = 60;
const GAP = 12;
const VIEWPORT_MARGIN = 4;
const DEFAULT_LABEL_WIDTH = 100;
const DEFAULT_LABEL_HEIGHT = 20;
const NO_INSETS: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };
/**
 * How far a target must move past the middle of the model before its label is allowed to switch
 * sides.
 *
 * Without this margin, a target sitting near the centre would flip its label between the left and
 * right columns on almost every frame of an orbit, and the drawing would appear to swim. Making the
 * decision slightly reluctant costs nothing and stops it completely.
 */
export const SECTOR_HYSTERESIS = 24;
/** In automatic mode, a model at least this much wider than it is tall gets rows instead of columns. */
const AUTO_ROWS_ASPECT = 2;
/**
 * How far the model has to become un-wide again before automatic mode switches back from rows to
 * columns.
 *
 * The same reluctance as {@link SECTOR_HYSTERESIS}, applied to the whole layout instead of one
 * label. Orbiting a model that is almost exactly twice as wide as it is tall would otherwise rebuild
 * the entire arrangement on every frame.
 */
const AUTO_ROWS_EXIT_MARGIN = 0.2;

/**
 * Decides which quarter of the screen a target belongs to, and therefore which edge its label goes
 * to. Keeps last frame's answer unless the target has moved clearly past the middle.
 */
function stickySector(dx: number, dy: number, last: LabelSector | undefined): LabelSector {
  let left = dx < 0;
  let top = dy < 0;
  if (last) {
    const wasLeft = last === 'top-left' || last === 'bottom-left';
    const wasTop = last === 'top-left' || last === 'top-right';
    left = wasLeft ? dx < SECTOR_HYSTERESIS : dx <= -SECTOR_HYSTERESIS;
    top = wasTop ? dy < SECTOR_HYSTERESIS : dy <= -SECTOR_HYSTERESIS;
  }
  return top ? (left ? 'top-left' : 'top-right') : (left ? 'bottom-left' : 'bottom-right');
}

export class LabelPlacer {
  /** What automatic mode chose last frame, so it does not flip back and forth. */
  private lastUseRows = false;

  computePlacements(
    anchors: Array<{ id: string; screenPos: Vec2 }>,
    boundary: { min: Vec2; max: Vec2 },
    viewportSize: Vec2,
    labelDims?: Map<string, { width: number; height: number }>,
    insets: ViewportInsets = NO_INSETS,
    /** Which quarter each label was in last frame, so labels do not swim between edges. */
    prevSectors?: Map<string, LabelSector>,
    mode: PlacementMode = 'sides',
  ): PlacementResult[] {
    if (anchors.length === 0) return [];

    const cx = (boundary.min.x + boundary.max.x) / 2;
    const cy = (boundary.min.y + boundary.max.y) / 2;

    // Rows are simply columns turned on their side, and targets are still sorted into quarters
    // either way, so everything downstream works the same in both. In automatic mode the choice
    // between them is itself made reluctantly, for the same reason individual labels are.
    const aspect = (boundary.max.x - boundary.min.x) / Math.max(1e-6, boundary.max.y - boundary.min.y);
    const autoThreshold = this.lastUseRows ? AUTO_ROWS_ASPECT - AUTO_ROWS_EXIT_MARGIN : AUTO_ROWS_ASPECT;
    const useRows = mode === 'rows' || (mode === 'auto' && aspect >= autoThreshold);
    this.lastUseRows = useRows;

    const buckets = new Map<LabelSector, InternalAnchor[]>();
    for (const s of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as LabelSector[]) {
      buckets.set(s, []);
    }

    const anchorYById = new Map<string, number>();
    for (const a of anchors) {
      anchorYById.set(a.id, a.screenPos.y);
      const dx = a.screenPos.x - cx;
      const dy = a.screenPos.y - cy;
      const angle = Math.atan2(dy, dx);
      // Reluctant switching, so labels near the middle do not flip edges as the camera turns.
      const sector = stickySector(dx, dy, prevSectors?.get(a.id));
      buckets.get(sector)!.push({ id: a.id, screenPos: a.screenPos, angle });
    }

    const dim = (id: string) =>
      labelDims?.get(id) ?? { width: DEFAULT_LABEL_WIDTH, height: DEFAULT_LABEL_HEIGHT };

    const results: PlacementResult[] = [];

    if (useRows) {
      const anchorXById = new Map<string, number>();
      for (const a of anchors) anchorXById.set(a.id, a.screenPos.x);

      for (const band of ['top', 'bottom'] as const) {
        const sectors: LabelSector[] = band === 'top'
          ? ['top-left', 'top-right']
          : ['bottom-left', 'bottom-right'];

        const primary: PlacementResult[] = [];
        const overflowGroups: PlacementResult[][] = [];
        for (const sector of sectors) {
          const items = buckets.get(sector)!;
          if (items.length === 0) continue;
          const placed = placeBandQuadrant(sector, items, boundary, labelDims);
          primary.push(...placed.primary);
          if (placed.overflow.length > 0) overflowGroups.push(placed.overflow);
        }
        if (primary.length === 0 && overflowGroups.length === 0) continue;

        // Same no-crossing rule as the columns, turned sideways: within a row, labels must be
        // ordered left to right the same way the things they point at are.
        reassignSlotsByAnchorOrderX(primary, anchorXById, dim);

        // The two halves of a row fill towards each other, so they can meet in the middle. This
        // has to be sorted out here rather than left to the separation pass, because that pass
        // resolves an overlap along its shortest axis — which for two labels side by side means
        // pushing one of them vertically, straight into the model.
        separateRowOverlaps(primary, dim);

        shiftRowIntoViewport(primary, viewportSize, insets, dim);
        for (const g of overflowGroups) shiftRowIntoViewport(g, viewportSize, insets, dim);

        for (const p of [...primary, ...overflowGroups.flat()]) {
          clampY(p, dim(p.annotationId).height, viewportSize, insets);
          results.push(p);
        }
      }
      return results;
    }

    if (mode === 'perimeter') return placePerimeter(buckets, boundary, viewportSize, insets, dim, anchors);

    for (const side of ['left', 'right'] as const) {
      const sectors: LabelSector[] = side === 'left'
        ? ['top-left', 'bottom-left']
        : ['top-right', 'bottom-right'];
      const sideItems = sectors.flatMap((s) => buckets.get(s)!);
      if (sideItems.length === 0) continue;

      // One column per side rather than one per quarter, so the top and bottom groups line up
      // and their leader lines can be kept from crossing.
      const sideMaxW = Math.max(DEFAULT_LABEL_WIDTH, ...sideItems.map((a) => dim(a.id).width));

      const primary: PlacementResult[] = [];
      const overflowGroups: PlacementResult[][] = [];
      for (const sector of sectors) {
        const items = buckets.get(sector)!;
        if (items.length === 0) continue;
        const placed = placeQuadrant(sector, items, boundary, sideMaxW, labelDims);
        primary.push(...placed.primary);
        if (placed.overflow.length > 0) overflowGroups.push(placed.overflow);
      }

      // Leader lines crossing each other is a genuine drafting fault, not a matter of taste. Order
      // the labels in each column to match the order of the things they point at, and they cannot
      // cross.
      reassignSlotsByAnchorOrder(primary, anchorYById, dim);

      // Move the whole column back on screen together. Pulling each label back individually
      // would pile them all onto the same spot at the edge.
      shiftColumnIntoViewport(primary, viewportSize, insets, dim);
      for (const g of overflowGroups) shiftColumnIntoViewport(g, viewportSize, insets, dim);

      for (const p of [...primary, ...overflowGroups.flat()]) {
        clampX(p, dim(p.annotationId).width, viewportSize, insets);
        results.push(p);
      }
    }
    return results;
  }
}

/**
 * Sends each quarter of the screen to its own edge, so all four margins carry labels instead of two.
 *
 * Using only columns or only rows leaves half the space around the drawing empty while the other
 * half is overloaded, and a busy drawing needs more room than two margins can offer.
 *
 * The quarters are assigned in a pinwheel: top-left to the left edge, bottom-left to the bottom,
 * bottom-right to the right, top-right to the top. Every quarter lands on an edge it already faces,
 * and no label ever has to choose between two edges. That last part matters more than it sounds —
 * a "nearest edge" decision taken fresh each frame is one more thing that can flip during an orbit
 * and set the drawing swimming.
 */
function placePerimeter(
  buckets: Map<LabelSector, InternalAnchor[]>,
  boundary: { min: Vec2; max: Vec2 },
  viewportSize: Vec2,
  insets: ViewportInsets,
  dim: (id: string) => { width: number; height: number },
  anchors: Array<{ id: string; screenPos: Vec2 }>,
): PlacementResult[] {
  const results: PlacementResult[] = [];
  const anchorYById = new Map<string, number>();
  const anchorXById = new Map<string, number>();
  for (const anchor of anchors) {
    anchorYById.set(anchor.id, anchor.screenPos.y);
    anchorXById.set(anchor.id, anchor.screenPos.x);
  }

  for (const sector of ['top-left', 'bottom-right'] as const) {
    const items = buckets.get(sector)!;
    if (items.length === 0) continue;
    const sideMaxW = Math.max(DEFAULT_LABEL_WIDTH, ...items.map((item) => dim(item.id).width));
    const placed = placeQuadrant(sector, items, boundary, sideMaxW, undefined, dim);
    reassignSlotsByAnchorOrder(placed.primary, anchorYById, dim);
    shiftColumnIntoViewport(placed.primary, viewportSize, insets, dim);
    if (placed.overflow.length > 0) shiftColumnIntoViewport(placed.overflow, viewportSize, insets, dim);
    for (const p of [...placed.primary, ...placed.overflow]) {
      clampX(p, dim(p.annotationId).width, viewportSize, insets);
      results.push(p);
    }
  }

  for (const sector of ['top-right', 'bottom-left'] as const) {
    const items = buckets.get(sector)!;
    if (items.length === 0) continue;
    const placed = placeBandQuadrant(sector, items, boundary, undefined, dim);
    reassignSlotsByAnchorOrderX(placed.primary, anchorXById, dim);
    separateRowOverlaps(placed.primary, dim);
    shiftRowIntoViewport(placed.primary, viewportSize, insets, dim);
    if (placed.overflow.length > 0) shiftRowIntoViewport(placed.overflow, viewportSize, insets, dim);
    for (const p of [...placed.primary, ...placed.overflow]) {
      clampY(p, dim(p.annotationId).height, viewportSize, insets);
      results.push(p);
    }
  }
  return results;
}

/**
 * Places one quarter's labels into a column, in two steps.
 *
 * First, work out which labels fit. A column only holds so many, so the targets nearest the edge
 * get the direct positions and the rest overflow — their leaders leave the column first and then
 * cut across, making an L shape.
 *
 * Second, order the ones that fit by height, so their leader lines run parallel instead of crossing.
 *
 * Every label ends up at the same horizontal position either way, which is what makes the column
 * read as a column.
 */
function placeQuadrant(
  sector: LabelSector,
  items: InternalAnchor[],
  boundary: { min: Vec2; max: Vec2 },
  sideMaxW: number,
  labelDims: Map<string, { width: number; height: number }> | undefined,
  resolvedDim?: (id: string) => { width: number; height: number },
): { primary: PlacementResult[]; overflow: PlacementResult[] } {
  const isLeft = sector === 'top-left' || sector === 'bottom-left';
  const isTop = sector === 'top-left' || sector === 'top-right';

  const dim = resolvedDim ?? ((id: string) =>
    labelDims?.get(id) ?? { width: DEFAULT_LABEL_WIDTH, height: DEFAULT_LABEL_HEIGHT });

  // Step 1: decide who fits. Targets closest to the edge get the direct positions, because a short
  // straight leader is better than a long one and they have the least distance to cover.
  const xSorted = [...items].sort((a, b) =>
    isLeft ? (a.screenPos.x - b.screenPos.x) : (b.screenPos.x - a.screenPos.x),
  );

  const halfHeight = (boundary.max.y - boundary.min.y) / 2;
  const primary: InternalAnchor[] = [];
  const overflow: InternalAnchor[] = [];
  let cumulativeSpacing = 0;
  let budgetPrevH = 0;

  for (const item of xSorted) {
    const labelH = dim(item.id).height;
    // Positions are label centres, so the space needed between two of them is half of each plus
    // the gap. Using one label's full height instead crowds a short note up against a tall one.
    const needed = primary.length === 0 ? 0 : Math.max((budgetPrevH + labelH) / 2 + GAP, 28);
    if (cumulativeSpacing + needed <= halfHeight) {
      primary.push(item);
      cumulativeSpacing += needed;
      budgetPrevH = labelH;
    } else {
      overflow.push(item);
    }
  }

  // Step 2: order the labels to match the order of the things they point at, so their leaders
  // cannot cross. Upper quarters stack downwards from the top, lower quarters upwards from the
  // bottom, so both fill away from the middle of the model.
  primary.sort((a, b) =>
    isTop ? (a.screenPos.y - b.screenPos.y) : (b.screenPos.y - a.screenPos.y),
  );

  const labelX = isLeft
    ? boundary.min.x - EDGE_MARGIN - sideMaxW
    : boundary.max.x + EDGE_MARGIN;

  const connectionEdge: ConnectionEdge = isLeft ? 'right' : 'left';
  const step = isTop ? 1 : -1;

  const primaryOut: PlacementResult[] = [];
  let prevSlotY: number | null = null;
  let prevSlotH = 0;

  // The labels that fit: a straight or diagonal leader, no detour needed.
  for (const item of primary) {
    const labelH = dim(item.id).height;
    const spacing = Math.max((prevSlotH + labelH) / 2 + GAP, 28);

    let labelY: number;
    let hint: RoutingHint;

    if (prevSlotY === null) {
      labelY = item.screenPos.y;
      hint = 'direct';
    } else {
      const requiredY = prevSlotY + step * spacing;
      const naturalFits = isTop
        ? item.screenPos.y >= requiredY
        : item.screenPos.y <= requiredY;
      if (naturalFits) {
        labelY = item.screenPos.y;
        hint = 'direct';
      } else {
        labelY = requiredY;
        hint = 'diagonal';
      }
    }

    primaryOut.push({
      annotationId: item.id,
      position: { x: labelX, y: labelY - labelH / 2 },
      sector,
      connectionEdge,
      routingHint: hint,
    });
    prevSlotY = labelY;
    prevSlotH = labelH;
  }

  // The labels that did not fit. They stack outwards, past the ends of the column, and their
  // leaders travel vertically clear of the model before turning in — an L shape rather than a
  // diagonal that would cut back across the labels that did fit.
  const overflowStep = isTop ? -1 : 1;
  let overflowSlotY = isTop ? boundary.min.y : boundary.max.y;
  let prevOverflowH = 0;

  overflow.sort((a, b) =>
    isTop ? (a.screenPos.y - b.screenPos.y) : (b.screenPos.y - a.screenPos.y),
  );

  const overflowOut: PlacementResult[] = [];
  for (const item of overflow) {
    const labelH = dim(item.id).height;
    const spacing = Math.max((prevOverflowH + labelH) / 2 + GAP, 28);

    overflowSlotY += overflowStep * spacing;
    prevOverflowH = labelH;
    const labelY = overflowSlotY;

    const connectionX = isLeft ? labelX + sideMaxW : labelX;

    overflowOut.push({
      annotationId: item.id,
      position: { x: labelX, y: labelY - labelH / 2 },
      sector,
      connectionEdge,
      routingHint: 'overflow',
      overflowElbow: { x: connectionX, y: labelY },
    });
  }

  return { primary: primaryOut, overflow: overflowOut };
}

/**
 * Reorders a column so the labels appear in the same top-to-bottom order as the things they point
 * at. Two leaders can only cross if their labels are in the wrong order, so this removes crossings
 * rather than trying to untangle them.
 */
function reassignSlotsByAnchorOrder(
  placements: PlacementResult[],
  anchorYById: Map<string, number>,
  dim: (id: string) => { width: number; height: number },
): void {
  if (placements.length < 2) return;
  const slotYs = placements.map((p) => p.position.y).sort((a, b) => a - b);
  const byAnchorY = [...placements].sort(
    (a, b) => (anchorYById.get(a.annotationId) ?? 0) - (anchorYById.get(b.annotationId) ?? 0),
  );
  byAnchorY.forEach((p, i) => {
    const slotY = slotYs[i];
    if (slotY === undefined) return;
    p.position = { x: p.position.x, y: slotY };
    const centerY = slotY + dim(p.annotationId).height / 2;
    const anchorY = anchorYById.get(p.annotationId) ?? centerY;
    p.routingHint = Math.abs(centerY - anchorY) < 1 ? 'direct' : 'diagonal';
  });
}

/**
 * Slides a whole column back onto the screen, keeping the spacing between its labels. Moving them
 * individually would stack them all against the edge. A column too tall to fit is aligned to the
 * top, so it is cut off at the bottom where there is at least somewhere to scroll the eye.
 */
function shiftColumnIntoViewport(
  group: PlacementResult[],
  viewport: Vec2,
  insets: ViewportInsets,
  dim: (id: string) => { width: number; height: number },
): void {
  if (group.length === 0) return;
  const minTop = Math.min(...group.map((p) => p.position.y));
  const maxBot = Math.max(...group.map((p) => p.position.y + dim(p.annotationId).height));
  let dy = 0;
  const bottomLimit = viewport.y - insets.bottom - VIEWPORT_MARGIN;
  if (maxBot > bottomLimit) dy = bottomLimit - maxBot;
  const topLimit = insets.top + VIEWPORT_MARGIN;
  if (minTop + dy < topLimit) dy = topLimit - minTop;
  if (dy === 0) return;
  for (const p of group) {
    p.position = { x: p.position.x, y: p.position.y + dy };
    if (p.overflowElbow) p.overflowElbow = { ...p.overflowElbow, y: p.overflowElbow.y + dy };
  }
}

function clampX(
  p: PlacementResult,
  width: number,
  viewport: Vec2,
  insets: ViewportInsets,
): void {
  const min = insets.left + VIEWPORT_MARGIN;
  const max = viewport.x - insets.right - width - VIEWPORT_MARGIN;
  p.position = { x: Math.max(min, Math.min(max, p.position.x)), y: p.position.y };
}

/* ────────────────────────── Top/bottom rows (transpose of the columns) ────────────────────────── */

/**
 * The same as {@link placeQuadrant}, turned ninety degrees: labels sit in a row above or below the
 * model and their leaders come down or up into them.
 *
 * This is the grid-bubble convention drafters use for wide, shallow views — a long section or an
 * elevation, where there is far more room above and below than there is at the sides.
 */
function placeBandQuadrant(
  sector: LabelSector,
  items: InternalAnchor[],
  boundary: { min: Vec2; max: Vec2 },
  labelDims: Map<string, { width: number; height: number }> | undefined,
  resolvedDim?: (id: string) => { width: number; height: number },
): { primary: PlacementResult[]; overflow: PlacementResult[] } {
  const isLeft = sector === 'top-left' || sector === 'bottom-left';
  const isTop = sector === 'top-left' || sector === 'top-right';

  const dim = resolvedDim ?? ((id: string) =>
    labelDims?.get(id) ?? { width: DEFAULT_LABEL_WIDTH, height: DEFAULT_LABEL_HEIGHT });

  // Step 1: decide who fits. Targets closest to the edge get the direct positions, as in a
  // column — only measured vertically rather than horizontally.
  const ySorted = [...items].sort((a, b) =>
    isTop ? (a.screenPos.y - b.screenPos.y) : (b.screenPos.y - a.screenPos.y),
  );

  const halfWidth = (boundary.max.x - boundary.min.x) / 2;
  const primary: InternalAnchor[] = [];
  const overflow: InternalAnchor[] = [];
  let cumulativeSpacing = 0;
  let budgetPrevW = 0;

  for (const item of ySorted) {
    const labelW = dim(item.id).width;
    // Positions are label centres, so the space between two of them is half of each plus the gap.
    // Using one label's full width instead lets a narrow label crowd a wide one.
    const needed = primary.length === 0 ? 0 : (budgetPrevW + labelW) / 2 + GAP;
    if (cumulativeSpacing + needed <= halfWidth) {
      primary.push(item);
      cumulativeSpacing += needed;
      budgetPrevW = labelW;
    } else {
      overflow.push(item);
    }
  }

  // Step 2: order the labels left to right to match the order of the things they point at, so
  // their leaders cannot cross. Each half fills away from the middle of the model.
  primary.sort((a, b) =>
    isLeft ? (a.screenPos.x - b.screenPos.x) : (b.screenPos.x - a.screenPos.x),
  );

  // A row lines up on the edge nearest the model — the top row aligns its labels' bottoms, the
  // bottom row their tops — so the row reads as a straight band and every leader is the same length.
  const labelYOf = (labelH: number) =>
    isTop ? boundary.min.y - EDGE_MARGIN - labelH : boundary.max.y + EDGE_MARGIN;
  const connectionEdge: ConnectionEdge = isTop ? 'bottom' : 'top';
  const step = isLeft ? 1 : -1;

  const primaryOut: PlacementResult[] = [];
  let prevSlotX: number | null = null;
  let prevSlotW = 0;

  for (const item of primary) {
    const labelW = dim(item.id).width;
    // Measured from the previous label's centre, using half of each width plus the gap. One
    // label's width alone would let a narrow label land partly inside a wide one.
    const spacing = (prevSlotW + labelW) / 2 + GAP;

    let labelX: number; // slot CENTRE x
    let hint: RoutingHint;

    if (prevSlotX === null) {
      labelX = item.screenPos.x;
      hint = 'direct';
    } else {
      const requiredX = prevSlotX + step * spacing;
      const naturalFits = isLeft
        ? item.screenPos.x >= requiredX
        : item.screenPos.x <= requiredX;
      if (naturalFits) {
        labelX = item.screenPos.x;
        hint = 'direct';
      } else {
        labelX = requiredX;
        hint = 'diagonal';
      }
    }

    const labelH = dim(item.id).height;
    primaryOut.push({
      annotationId: item.id,
      position: { x: labelX - labelW / 2, y: labelYOf(labelH) },
      sector,
      connectionEdge,
      routingHint: hint,
    });
    prevSlotX = labelX;
    prevSlotW = labelW;
  }

  // Labels that did not fit continue past the ends of the row, still at the row's height.
  //
  // Their leaders bend halfway between the label and the model, so the last stretch comes in
  // square to the label. Bending right at the label instead would leave the leader running flush
  // along the whole row, under everyone else's labels.
  const overflowStep = isLeft ? -1 : 1;
  let overflowSlotX = isLeft ? boundary.min.x : boundary.max.x;
  let prevOverflowW = 0;

  overflow.sort((a, b) =>
    isLeft ? (a.screenPos.x - b.screenPos.x) : (b.screenPos.x - a.screenPos.x),
  );

  const overflowOut: PlacementResult[] = [];
  for (const item of overflow) {
    const { width: labelW, height: labelH } = dim(item.id);
    const spacing = (prevOverflowW + labelW) / 2 + GAP;

    overflowSlotX += overflowStep * spacing;
    prevOverflowW = labelW;
    const labelX = overflowSlotX;
    const labelY = labelYOf(labelH);
    const innerEdgeY = isTop ? labelY + labelH : labelY;

    overflowOut.push({
      annotationId: item.id,
      position: { x: labelX - labelW / 2, y: labelY },
      sector,
      connectionEdge,
      routingHint: 'overflow',
      overflowElbow: { x: labelX, y: isTop ? innerEdgeY + EDGE_MARGIN / 2 : innerEdgeY - EDGE_MARGIN / 2 },
    });
  }

  return { primary: primaryOut, overflow: overflowOut };
}

/**
 * Sweeps along a row pushing any label that overlaps its neighbour further along, until they all
 * clear.
 *
 * Needed because the two halves of a row fill towards each other and can meet in the middle. It has
 * to happen here rather than in the general separation pass, which would resolve a side-by-side
 * overlap by pushing one label vertically — straight out of its row.
 */
function separateRowOverlaps(
  placements: PlacementResult[],
  dim: (id: string) => { width: number; height: number },
): void {
  if (placements.length < 2) return;
  const sorted = [...placements].sort((a, b) => a.position.x - b.position.x);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    const minX = prev.position.x + dim(prev.annotationId).width + GAP;
    if (cur.position.x < minX) {
      cur.position = { x: minX, y: cur.position.y };
      // Pushed off centre, so its leader now has to come in at an angle rather than straight down.
      if (cur.routingHint === 'direct') cur.routingHint = 'diagonal';
    }
  }
}

/** The row version of {@link reassignSlotsByAnchorOrder}: order labels left to right to match the
 *  things they point at. */
function reassignSlotsByAnchorOrderX(
  placements: PlacementResult[],
  anchorXById: Map<string, number>,
  dim: (id: string) => { width: number; height: number },
): void {
  if (placements.length < 2) return;
  const slotXs = placements.map((p) => p.position.x).sort((a, b) => a - b);
  const byAnchorX = [...placements].sort(
    (a, b) => (anchorXById.get(a.annotationId) ?? 0) - (anchorXById.get(b.annotationId) ?? 0),
  );
  byAnchorX.forEach((p, i) => {
    const slotX = slotXs[i];
    if (slotX === undefined) return;
    p.position = { x: slotX, y: p.position.y };
    const centerX = slotX + dim(p.annotationId).width / 2;
    const anchorX = anchorXById.get(p.annotationId) ?? centerX;
    p.routingHint = Math.abs(centerX - anchorX) < 1 ? 'direct' : 'diagonal';
  });
}

/**
 * The row version of {@link shiftColumnIntoViewport}: slide a whole row back on screen, spacing
 * intact. A row too wide to fit is aligned to the left.
 */
function shiftRowIntoViewport(
  group: PlacementResult[],
  viewport: Vec2,
  insets: ViewportInsets,
  dim: (id: string) => { width: number; height: number },
): void {
  if (group.length === 0) return;
  const minLeft = Math.min(...group.map((p) => p.position.x));
  const maxRight = Math.max(...group.map((p) => p.position.x + dim(p.annotationId).width));
  let dx = 0;
  const rightLimit = viewport.x - insets.right - VIEWPORT_MARGIN;
  if (maxRight > rightLimit) dx = rightLimit - maxRight;
  const leftLimit = insets.left + VIEWPORT_MARGIN;
  if (minLeft + dx < leftLimit) dx = leftLimit - minLeft;
  if (dx === 0) return;
  for (const p of group) {
    p.position = { x: p.position.x + dx, y: p.position.y };
    if (p.overflowElbow) p.overflowElbow = { ...p.overflowElbow, x: p.overflowElbow.x + dx };
  }
}

function clampY(
  p: PlacementResult,
  height: number,
  viewport: Vec2,
  insets: ViewportInsets,
): void {
  const min = insets.top + VIEWPORT_MARGIN;
  const max = viewport.y - insets.bottom - height - VIEWPORT_MARGIN;
  p.position = { x: p.position.x, y: Math.max(min, Math.min(max, p.position.y)) };
}

// ============================================================
// Last-resort uncrossing
// ============================================================

/**
 * Finds leader lines that still cross and swaps the two labels over.
 *
 * Ordering each column already prevents crossings in the normal case. This catches the ones that
 * slip through afterwards: a label that stayed on its old side to avoid swimming, one the user
 * dragged and released, one nudged aside to stop it overlapping. Leaders crossing is a real
 * drafting fault, so it is worth a final pass to clear them.
 *
 * Two labels are only swapped when doing so makes the total leader length shorter. That is always
 * true when undoing a crossing, and it guarantees this finishes rather than swapping the same pair
 * back and forth forever.
 *
 * Only labels of similar size are exchanged, so a swap cannot recreate an overlap that was just
 * resolved.
 *
 * Modifies `placements` directly.
 */
export function uncrossLeaderSlots(
  placements: PlacementResult[],
  anchors: ReadonlyMap<string, Vec2>,
  labelDims?: ReadonlyMap<string, { width: number; height: number }>,
  pinnedIds?: ReadonlySet<string>,
  sizeTolerance = 2,
): void {
  const dim = (id: string) =>
    labelDims?.get(id) ?? { width: DEFAULT_LABEL_WIDTH, height: DEFAULT_LABEL_HEIGHT };
  const eligible = placements.filter((p) =>
    p.routingHint !== 'overflow' && !pinnedIds?.has(p.annotationId) && anchors.has(p.annotationId));
  const centre = (p: PlacementResult): Vec2 => {
    const d = dim(p.annotationId);
    return { x: p.position.x + d.width / 2, y: p.position.y + d.height / 2 };
  };
  const len = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);

  for (let pass = 0; pass < 4; pass++) {
    let swapped = false;
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i];
        const b = eligible[j];
        if (!a || !b) continue;
        if (a.connectionEdge !== b.connectionEdge) continue;
        // Only swap labels of similar size along the direction they stack. Dropping a tall label
        // into a short one's place in a column would push it into its new neighbours, undoing the
        // separation pass.
        const da = dim(a.annotationId);
        const db = dim(b.annotationId);
        const vertical = a.connectionEdge === 'top' || a.connectionEdge === 'bottom';
        const sizeDelta = vertical ? Math.abs(da.width - db.width) : Math.abs(da.height - db.height);
        if (sizeDelta > sizeTolerance) continue;
        const pa = anchors.get(a.annotationId);
        const pb = anchors.get(b.annotationId);
        if (!pa || !pb) continue;
        if (!segmentsCross(pa, centre(a), pb, centre(b))) continue;
        // Where a label lands when it takes the other's place. In a column every label shares the
        // same horizontal position, so the position simply transfers. In the top row, labels line
        // up by their bottom edges, so a label of a different height needs its position
        // recalculated from that line — otherwise the swap would break the row's alignment.
        const slotPosFor = (slot: PlacementResult, of: PlacementResult): Vec2 => {
          if (!vertical) return slot.position;
          const y = slot.connectionEdge === 'bottom'
            ? slot.position.y + dim(slot.annotationId).height - dim(of.annotationId).height
            : slot.position.y;
          return { x: slot.position.x, y };
        };
        // Only swap when the two leaders together get shorter, measured at the positions the
        // labels would actually end up in.
        const centreAtSlot = (slot: PlacementResult, of: PlacementResult): Vec2 => {
          const d = dim(of.annotationId);
          const pos = slotPosFor(slot, of);
          return { x: pos.x + d.width / 2, y: pos.y + d.height / 2 };
        };
        const before = len(pa, centre(a)) + len(pb, centre(b));
        const after = len(pa, centreAtSlot(b, a)) + len(pb, centreAtSlot(a, b));
        if (after >= before) continue;
        const na = slotPosFor(b, a);
        const nb = slotPosFor(a, b);
        a.position = na;
        b.position = nb;
        [a.routingHint, b.routingHint] = [b.routingHint, a.routingHint];
        [a.sector, b.sector] = [b.sector, a.sector];
        swapped = true;
      }
    }
    if (!swapped) break;
  }
}
