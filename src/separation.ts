/**
 * Pushes overlapping labels apart until none of them touch.
 *
 * Labels are positioned one at a time, each against the model, so two can easily be placed on the
 * same spot. This is the one step that guarantees they are not: every label ends up with a clear
 * gap around it and sits inside the viewport.
 *
 * It works by repeatedly finding pairs that overlap and nudging both apart by the amount they
 * overlap. Each nudge is applied immediately, so later pairs in the same pass already see it. That
 * settles a cluster far faster than moving everything at once — but it means the order labels are
 * visited in changes the answer, which is why they are sorted here from their own geometry and the
 * caller's ordering is never trusted.
 *
 * The tuned numbers below keep the notes explaining why they hold the value they do. A tuned
 * number without its reason is indistinguishable from a guess.
 */
import type { ViewportInsets } from './labelPlacer.js';

interface SeparableLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * When true this rect is a fixed obstacle: it is never moved or clamped, but still pushes
   * movable rects away. Used for pinned/dragged/locked/view-overridden labels — the full
   * separation lands on the movable neighbour instead of being split and then discarded.
   */
  readonly immovable?: boolean;
}

interface SeparationOptions {
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly insets?: ViewportInsets;
}

/** How much clear space to keep between two labels, in screen pixels. */
const PADDING = 12;

/**
 * A hard limit on passes, so this always finishes even if it cannot fully separate everything.
 *
 * Each pass moves a pair apart by exactly the amount they overlap, which means a *stack* of labels
 * passes its correction down roughly one label per pass. A column of fourteen therefore needs
 * around fourteen passes to settle. At 30 a full turn around the model left an overlap standing at
 * a couple of angles; 64 clears it with room to spare.
 *
 * This is not the usual cost: the early exits below mean a frame that is already settled finishes
 * after a single pass.
 *
 * ponytail: cost grows with stack height. The real fix is upstream — placing labels in rows rather
 * than stacking fourteen in one column when the frame is wide enough for both.
 */
const MAX_ITERATIONS = 64;

const NO_INSETS: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Smallest allowed pairing cell. A scene of tiny labels would otherwise produce a very fine grid,
 * where each label spans many cells and the grid costs more to maintain than it saves.
 */
const MIN_CELL_SIZE = 64;

/** A small margin so a label pushed against the edge of the screen is not flush against it. */
const EDGE_GAP = 4;

interface MutableRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  immovable: boolean;
}

const centerX = (r: MutableRect): number => r.x + r.width / 2;
const centerY = (r: MutableRect): number => r.y + r.height / 2;

function getOverlap(a: MutableRect, b: MutableRect, gap: number): { dx: number; dy: number } | null {
  // Grow each label by half the gap on every side, so two labels count as overlapping while they
  // are still `gap` pixels apart. That is what produces the clear space rather than edges touching.
  const half = gap / 2;
  const dx = Math.min(a.x + a.width + half, b.x + b.width + half) - Math.max(a.x - half, b.x - half);
  const dy = Math.min(a.y + a.height + half, b.y + b.height + half) - Math.max(a.y - half, b.y - half);
  if (dx > 0 && dy > 0) return { dx, dy };
  return null;
}

function clampToViewport(
  r: MutableRect,
  viewport: Readonly<{ width: number; height: number }>,
  insets: ViewportInsets,
): void {
  r.x = Math.max(insets.left + EDGE_GAP, Math.min(viewport.width - insets.right - r.width - EDGE_GAP, r.x));
  r.y = Math.max(insets.top + EDGE_GAP, Math.min(viewport.height - insets.bottom - r.height - EDGE_GAP, r.y));
}

/**
 * Moves labels apart until none are closer than `PADDING`, keeping them all on screen.
 *
 * The same labels always come out the same way, and the input is never modified — results come back
 * as new objects in the order they were passed in.
 */
export function separateLabels(
  labels: readonly SeparableLabel[],
  options: SeparationOptions,
): readonly SeparableLabel[] {
  if (labels.length === 0) return labels;

  const viewport = options.viewport;
  const insets = options.insets ?? NO_INSETS;

  // Each nudge is visible to the pairs checked after it, so the order labels are visited in
  // changes where they end up. That makes ordering a correctness question, twice over.
  //
  // First, it must not depend on the caller. The order is derived from the labels' own positions
  // and ids, never from the array they arrived in — reordering a document, or iterating a map,
  // must not shift a single label on screen. Labels with broken coordinates sort last and break
  // ties on id, so even those land somewhere fixed.
  //
  // Second, it must be spatial. Sorting by id scatters a vertical stack into random order, and each
  // correction then travels one arbitrary hop at a time: a column of thirteen labels that fits
  // easily still had an overlap left after thirty passes. Read top-to-bottom and left-to-right,
  // the same column settles in two.
  const sortKey = (value: number): number => (Number.isFinite(value) ? value : Number.MAX_VALUE);
  const order = labels.map((_, index) => index).sort((left, right) => {
    const a = labels[left]!;
    const b = labels[right]!;
    return (sortKey(a.y) - sortKey(b.y)) || (sortKey(a.x) - sortKey(b.x)) || a.id.localeCompare(b.id);
  });
  const rects: MutableRect[] = order.map((index) => {
    const label = labels[index]!;
    return {
      id: label.id,
      x: label.x,
      y: label.y,
      width: label.width,
      height: label.height,
      immovable: label.immovable === true,
    };
  });

  const n = rects.length;
  const emit = (): readonly SeparableLabel[] => {
    const result: SeparableLabel[] = new Array<SeparableLabel>(n);
    for (let position = 0; position < n; position += 1) {
      const rect = rects[position]!;
      result[order[position]!] = {
        id: rect.id,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        ...(rect.immovable ? { immovable: true } : {}),
      };
    }
    return result;
  };

  if (n === 1) {
    const rect = rects[0]!;
    if (!rect.immovable) clampToViewport(rect, viewport, insets);
    return emit();
  }

  // Which pairs a pass is allowed to resolve is decided from where labels were when the pass began:
  // the screen is cut into cells sized to the largest label, and only two labels sharing a cell at
  // that moment are compared. Cells that size guarantee two overlapping labels always share one, so
  // nothing is missed. Two that are pushed into each other partway through a pass are caught on the
  // next pass rather than this one — the move that created the overlap counts as movement, so the
  // early exit below cannot declare the frame settled while such a pair is still outstanding.
  //
  // Sizes never change while separating, so the cell size is measured once. Labels with broken
  // dimensions are skipped here, or one of them would stretch every cell in the scene.
  let maxDim = 0;
  for (const rect of rects) {
    if (Number.isFinite(rect.width) && rect.width > maxDim) maxDim = rect.width;
    if (Number.isFinite(rect.height) && rect.height > maxDim) maxDim = rect.height;
  }
  const cellSize = Math.max(MIN_CELL_SIZE, maxDim + PADDING);
  const half = PADDING / 2;
  const cellX0 = new Array<number>(n).fill(0);
  const cellX1 = new Array<number>(n).fill(0);
  const cellY0 = new Array<number>(n).fill(0);
  const cellY1 = new Array<number>(n).fill(0);
  /** Labels whose position or size is not a usable number. They are in no cell, so they are
   *  compared against everything: an infinitely wide label really can overlap something. */
  const unbounded = new Array<boolean>(n).fill(false);
  const prevX = new Array<number>(n).fill(0);
  const prevY = new Array<number>(n).fill(0);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    for (let i = 0; i < n; i += 1) {
      const r = rects[i]!;
      prevX[i] = r.x;
      prevY[i] = r.y;
      const x0 = Math.floor((r.x - half) / cellSize);
      const x1 = Math.floor((r.x + r.width + half) / cellSize);
      const y0 = Math.floor((r.y - half) / cellSize);
      const y1 = Math.floor((r.y + r.height + half) / cellSize);
      cellX0[i] = x0;
      cellX1[i] = x1;
      cellY0[i] = y0;
      cellY1[i] = y1;
      unbounded[i] = !Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(y0)
        || !Number.isFinite(y1) || x1 < x0 || y1 < y0;
    }
    let hadCollision = false;

    // ponytail: every pair, every pass. A drawing holds a couple of dozen labels, for which this
    // is cheaper than the hashed grid it replaced; bring a real broad phase back if a scene ever
    // runs to hundreds.
    for (let i = 0; i < n - 1; i += 1) {
      const a = rects[i]!;
      for (let j = i + 1; j < n; j += 1) {
        const b = rects[j]!;
        // Two pinned labels cannot move, so there is nothing to resolve between them.
        if (a.immovable && b.immovable) continue;
        if (!unbounded[i] && !unbounded[j] && (
          cellX0[i]! > cellX1[j]! || cellX0[j]! > cellX1[i]!
          || cellY0[i]! > cellY1[j]! || cellY0[j]! > cellY1[i]!
        )) continue;

        // Re-test against where the labels are right now. The cells only suggest which pairs are
        // worth checking; they never decide whether two labels actually overlap.
        const overlap = getOverlap(a, b, PADDING);
        if (overlap === null) continue;

        hadCollision = true;

        // Normally both labels move half the distance each. When one is pinned it takes no share
        // and the other moves the whole way — otherwise the free label would move only halfway and
        // still overlap the pinned one, since the pinned one's half is thrown away.
        const aShare = a.immovable ? 0 : b.immovable ? 1 : 0.5;
        const bShare = 1 - aShare;

        if (overlap.dx < overlap.dy) {
          const dir = centerX(a) < centerX(b) ? 1 : -1;
          a.x -= dir * overlap.dx * aShare;
          b.x += dir * overlap.dx * bShare;
        } else {
          const dir = centerY(a) < centerY(b) ? 1 : -1;
          a.y -= dir * overlap.dy * aShare;
          b.y += dir * overlap.dy * bShare;
        }
      }
    }

    // Pull labels back on screen every pass, not once at the end. Doing it inside the loop is what
    // lets a cluster in a corner come apart: the screen edge holds one label still, so the next
    // pass moves only the other. Clamping at the end instead would push both onto the same corner
    // and leave them stacked.
    for (const r of rects) {
      if (r.immovable) continue;
      if (!Number.isFinite(r.x)) r.x = 0;
      if (!Number.isFinite(r.y)) r.y = 0;
      clampToViewport(r, viewport, insets);
    }

    if (!hadCollision) break;
    // Stop as soon as a pass changes nothing. Some layouts cannot be resolved — a label pushed off
    // a pinned one and then pulled straight back by the screen edge — and without this they would
    // burn every remaining pass, every frame, achieving nothing.
    let moved = 0;
    for (let k = 0; k < n; k += 1) {
      moved += Math.abs(rects[k]!.x - prevX[k]!) + Math.abs(rects[k]!.y - prevY[k]!);
    }
    if (moved < 0.5) break;
  }

  return emit();
}
