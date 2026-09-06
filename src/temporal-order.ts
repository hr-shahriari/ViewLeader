/** Input to a stable screen-space ordering decision. */
export interface TemporalOrderItem {
  readonly id: string;
  readonly value: number;
}

export interface TemporalOrderOptions {
  readonly previousIds?: readonly string[];
  readonly switchMargin: number;
  readonly descending?: boolean;
}

/**
 * Orders projected values without putting an epsilon inside a sort comparator.
 *
 * Surviving items begin in the last accepted order. New items enter by their exact value and id.
 * Adjacent incumbents exchange places only after their values cross by the full margin, giving the
 * comparison a memory-backed dead band while keeping every individual comparison transitive.
 */
export function stabilizeTemporalOrder<T extends TemporalOrderItem>(
  items: readonly T[],
  options: TemporalOrderOptions,
): T[] {
  const direction = options.descending === true ? -1 : 1;
  const margin = Math.max(0, options.switchMargin);
  const rank = (item: T): number => Number.isFinite(item.value) ? direction * item.value : Number.POSITIVE_INFINITY;
  const byId = new Map(items.map((item) => [item.id, item]));
  const prior = new Set(options.previousIds ?? []);
  const ordered = (options.previousIds ?? []).flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  const compareExact = (a: T, b: T): number => rank(a) - rank(b) || a.id.localeCompare(b.id);
  for (const item of items.filter(({ id }) => !prior.has(id)).sort(compareExact)) {
    const index = ordered.findIndex((other) => compareExact(item, other) < 0);
    ordered.splice(index < 0 ? ordered.length : index, 0, item);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 1; index < ordered.length; index += 1) {
      const left = ordered[index - 1]!;
      const right = ordered[index]!;
      if (rank(left) - rank(right) <= margin) continue;
      ordered[index - 1] = right;
      ordered[index] = left;
      changed = true;
    }
  }
  return ordered;
}
