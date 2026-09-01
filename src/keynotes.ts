// Keynotes: the drafting convention where notes carry a code like `09 91 23.A3` and the drawing
// shows a numbered legend instead of repeating the same sentence twenty times.
//
// This is a convention, not a subsystem. A keynote is just a value in an annotation's metadata, and
// setting one is an ordinary metadata write. All this file adds is a query that groups annotations
// by that code, sorted the way a drafter expects to read them.
//
// Drawing the legend itself is left to the host. Everything ViewLeader draws points at something in
// the model; a legend points at nothing and belongs in the page furniture, not the viewport.
import type { Annotation } from './types.js';

/** The metadata key a keynote code is stored under. */
export const KEYNOTE_METADATA_KEY = 'vl:keynote';

export interface KeynoteEntry {
  readonly key: string;
  readonly annotationIds: readonly string[];
}

/**
 * Groups annotations by keynote code, in the order a drafter expects to read them: `09 91 23.A3`
 * comes before `09 91 23.A10`.
 *
 * Ordinary alphabetical sorting gets that wrong — it would put `A10` first, because it compares
 * "1" against "3" as characters rather than 10 against 3. The failure is easy to miss, because the
 * result still looks sorted.
 *
 * Annotations without a keynote are left out rather than returned as empty entries, and the ids
 * within each group keep the order they came in, so the same document always groups the same way.
 */
export function keynotesOf(annotations: readonly Annotation[]): readonly KeynoteEntry[] {
  const byKey = new Map<string, string[]>();
  for (const annotation of annotations) {
    const key = annotation.metadata[KEYNOTE_METADATA_KEY];
    if (typeof key !== 'string' || key.length === 0) continue;
    const ids = byKey.get(key);
    if (ids === undefined) byKey.set(key, [annotation.id]);
    else ids.push(annotation.id);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => compareNaturalKeys(left, right))
    .map(([key, annotationIds]) => ({ key, annotationIds }));
}

/** Numbers by value, everything else alphabetically — the order a drafter reads codes in. */
const collator = new Intl.Collator('en', { numeric: true });

/**
 * `'9'` and `'09'` collate as the same number, so plain string order breaks that tie. Without it
 * the two spellings would land in whatever order they were created, and the same document could
 * group differently from one call to the next.
 */
function compareNaturalKeys(left: string, right: string): number {
  return collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}
