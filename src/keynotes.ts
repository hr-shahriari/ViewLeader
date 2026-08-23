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

/**
 * Breaks a code into alternating number and non-number pieces: `'09 91 23.A10'` becomes
 * `['09', ' ', '91', ' ', '23', '.', 'A', '10']`. Numbers can then be compared as numbers and
 * letters as letters.
 */
function runsOf(key: string): readonly string[] {
  return key.match(/\d+|\D+/g) ?? [];
}

/**
 * Compares two codes piece by piece: numbers by value, everything else alphabetically.
 *
 * A number compared against a letter has no meaningful numeric answer, so those fall back to a
 * plain text comparison. Codes of different lengths are fine — the shorter one sorts first for as
 * long as the two agree, which is how a plain text sort would treat a prefix too.
 */
function compareNaturalKeys(left: string, right: string): number {
  const a = runsOf(left);
  const b = runsOf(right);
  const length = Math.min(a.length, b.length);
  // '9' and '09' mean the same number but are not the same string, so they still need a stable
  // order between them. That tie-break is remembered and only used if everything else matches —
  // deciding on it immediately would sort '9 91 23' before '09 91 03', letting a leading zero
  // outrank the segment that genuinely differs.
  let padding = 0;
  for (let index = 0; index < length; index += 1) {
    const runA = a[index]!;
    const runB = b[index]!;
    if (/^\d/.test(runA) && /^\d/.test(runB)) {
      const diff = Number(runA) - Number(runB);
      if (diff !== 0) return diff;
      if (padding === 0) padding = runA.length - runB.length;
    } else if (runA !== runB) {
      return runA < runB ? -1 : 1;
    }
  }
  if (a.length !== b.length) return a.length - b.length;
  return padding;
}
