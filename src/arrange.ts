// Align and distribute, the way a drawing tool does it: line these notes up on their left edges,
// space these ones evenly.
//
// Works on the label rectangles as they were actually drawn this frame, and returns positions the
// caller then applies as manual placements — so an aligned label stays aligned as the camera moves
// and comes back aligned when the document is reopened.
import type { Rect } from './types';

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y';

export interface ArrangeTarget {
  readonly id: string;
  readonly label: Rect;
}

/**
 * Where one label should move to. Labels already in the right place are left out entirely, so
 * pressing align twice is one undo step and then nothing.
 */
interface ArrangeMove {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number };
}

/**
 * Lines every label up on one edge of the group.
 *
 * The edge is taken from the labels themselves, not from the viewport: aligning three notes brings
 * them together where they already are rather than flinging them to the middle of the screen.
 *
 * Does nothing with fewer than two labels — pressing align with one thing selected should be a
 * no-op, not an error.
 */
export function alignMoves(targets: readonly ArrangeTarget[], edge: AlignEdge): readonly ArrangeMove[] {
  if (targets.length < 2) return [];
  const value = alignedValue(targets, edge);
  return moves(targets, (target) => horizontal(edge)
    ? { x: alignedStart(target.label.width, value, edge), y: target.label.y }
    : { x: target.label.x, y: alignedStart(target.label.height, value, edge) });
}

/**
 * Evens out the gaps between labels, leaving the outermost two where they are.
 *
 * Gaps rather than centres: labels of different heights spaced by equal centre distance still look
 * unevenly spaced, and every drawing tool a drafter has used spaces the edges.
 *
 * Does nothing with fewer than three labels — with two there is nothing in between to distribute.
 */
export function distributeMoves(
  targets: readonly ArrangeTarget[],
  axis: 'x' | 'y',
): readonly ArrangeMove[] {
  if (targets.length < 3) return [];
  const size = (target: ArrangeTarget): number => axis === 'x' ? target.label.width : target.label.height;
  const start = (target: ArrangeTarget): number => axis === 'x' ? target.label.x : target.label.y;
  const ordered = [...targets].sort((left, right) => start(left) - start(right));
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const span = start(last) + size(last) - start(first);
  const occupied = ordered.reduce((total, target) => total + size(target), 0);
  const gap = (span - occupied) / (ordered.length - 1);
  let cursor = start(first);
  const placed = new Map<string, number>();
  for (const target of ordered) {
    placed.set(target.id, cursor);
    cursor += size(target) + gap;
  }
  return moves(targets, (target) => {
    const at = placed.get(target.id)!;
    return axis === 'x' ? { x: at, y: target.label.y } : { x: target.label.x, y: at };
  });
}

function moves(
  targets: readonly ArrangeTarget[],
  positionOf: (target: ArrangeTarget) => { x: number; y: number },
): readonly ArrangeMove[] {
  return targets.flatMap((target) => {
    const position = positionOf(target);
    return position.x === target.label.x && position.y === target.label.y
      ? []
      : [{ id: target.id, position }];
  });
}

function horizontal(edge: AlignEdge): boolean {
  return edge === 'left' || edge === 'right' || edge === 'center-x';
}

function alignedValue(targets: readonly ArrangeTarget[], edge: AlignEdge): number {
  const lefts = targets.map(({ label }) => label.x);
  const rights = targets.map(({ label }) => label.x + label.width);
  const tops = targets.map(({ label }) => label.y);
  const bottoms = targets.map(({ label }) => label.y + label.height);
  switch (edge) {
    case 'left': return Math.min(...lefts);
    case 'right': return Math.max(...rights);
    case 'top': return Math.min(...tops);
    case 'bottom': return Math.max(...bottoms);
    case 'center-x': return (Math.min(...lefts) + Math.max(...rights)) / 2;
    case 'center-y': return (Math.min(...tops) + Math.max(...bottoms)) / 2;
  }
}

/**
 * Positions are stored as the top-left corner of a label, so aligning to a right edge or a centre
 * has to be converted back into where the corner goes.
 */
function alignedStart(size: number, value: number, edge: AlignEdge): number {
  switch (edge) {
    case 'right':
    case 'bottom': return value - size;
    case 'center-x':
    case 'center-y': return value - size / 2;
    default: return value;
  }
}
