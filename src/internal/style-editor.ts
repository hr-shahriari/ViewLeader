// A styling panel over the current selection, with no framework in it.
//
// Three things make this more than a `for` loop over `annotations.update`, and all three are the
// reason it lives here once rather than twice in `src/react/` and `src/vue/`:
//
// 1. `update({ styleOverride })` **replaces** the whole override and never merges, `null` clears
//    all of it, and `{ lineColor: undefined }` throws. So "set one field" is a read-modify-write,
//    and "revert one field" is the same read-modify-write with a key left out.
// 2. Unwrapped, every `update()` opens its own transaction, so restyling five selected annotations
//    would be five undo steps. One `history.transaction` around the loop makes it one — and makes
//    a throw part-way through roll the whole thing back rather than leave half a selection red.
// 3. A selection disagrees. Every value is reported as `{ value, mixed }` so an `<input>` always
//    has something real to bind to and the panel still knows to badge it.
import {
  mergeStyleOverride,
  readStyleOverride,
  type ResolvedStyle,
  type StyleFieldSource,
  type StyleOverride,
} from '../definitions.js';
import { ViewLeaderError } from '../errors.js';
import type { AnnotationPatch } from '../types.js';
import type { AnnotationsCapability, HistoryCapability } from '../view-leader.js';
import { revisionCache } from './snapshot-cache.js';

/** Every field an override can carry — the style's visual fields, never its identity. */
export type StyleField = keyof StyleOverride;

/**
 * One value read across the selection.
 *
 * `value` is always a real value, never a sentinel: when the selection disagrees it is the first
 * selected annotation's, so `<input type="color" :value="…">` binds directly in both frameworks and
 * `exactOptionalPropertyTypes` never forces a `?? fallback` on the host. That is only honest if the
 * host renders something for `mixed` — the panel is showing one annotation's value for all of them.
 */
export interface SelectionValue<Value> {
  readonly value: Value;
  readonly mixed: boolean;
}

export interface StyleFieldState<Value> extends SelectionValue<Value> {
  /**
   * Which layer supplied the value, or `'mixed'` when the selection disagrees about the layer even
   * though it agrees about the value. `'annotation-override'` is the only source `clear()` has
   * anything to revert.
   */
  readonly source: StyleFieldSource | 'mixed';
}

/** Absent for a field neither the style nor any override sets — there is nothing to show. */
export type StyleFieldStates = {
  readonly [Key in keyof StyleOverride]: StyleFieldState<NonNullable<StyleOverride[Key]>>;
};

export interface StyleEditorSnapshot {
  /**
   * The selection this describes, and exactly what a write will touch. A selected id whose
   * annotation has since gone is dropped rather than carried, so no write can reach a stale id.
   */
  readonly ids: readonly string[];
  /** The style being resolved against. `undefined` when nothing is selected. */
  readonly styleId: SelectionValue<string> | undefined;
  /** Sizes are **pixels and unscaled**, matching `resolvedStyle`. Empty when nothing is selected. */
  readonly fields: StyleFieldStates;
}

/** Undo labels. They surface in `HistorySnapshot.undoLabel`, so the host gets to name them. */
export interface StyleEditorLabels {
  readonly set?: string;
  readonly clear?: string;
  readonly assign?: string;
}

export interface StyleEditorOptions {
  readonly labels?: StyleEditorLabels;
}

/** Narrower than the capabilities themselves, so a test can fake it without a viewer. */
export interface StyleEditorHost {
  readonly annotations: Pick<
    AnnotationsCapability,
    'getSnapshot' | 'subscribe' | 'get' | 'update' | 'resolvedStyle'
  >;
  readonly history: Pick<HistoryCapability, 'transaction'>;
}

const DEFAULT_LABELS = {
  set: 'Change annotation style',
  clear: 'Revert annotation style',
  assign: 'Assign annotation style',
} as const;

const EMPTY_SNAPSHOT: StyleEditorSnapshot = Object.freeze({
  ids: Object.freeze([]),
  styleId: undefined,
  fields: Object.freeze({}),
});

/** Mutable so a field can be deleted; `delete` is how a revert is spelled, since `undefined` throws. */
type MutableStyleOverride = { -readonly [Key in keyof StyleOverride]: StyleOverride[Key] };

/**
 * Edits the style of whatever is selected.
 *
 * Follows `annotations.selectedIds` implicitly, the way `align` and `distribute` already do, and
 * reads through `annotations.resolvedStyle` so the panel shows what is actually being drawn —
 * including the active saved view's override, which a host cannot compute for itself.
 *
 * `getSnapshot`/`subscribe` are the `SnapshotSource` shape, and `getSnapshot()` is `Object.is`
 * stable: a drag publishes a runtime change on every pointermove, and a panel that re-rendered on
 * each of those would be the very cost the ref-based following elsewhere exists to avoid.
 */
export class StyleEditor {
  readonly #host: StyleEditorHost;
  readonly #labels: Required<StyleEditorLabels>;
  readonly #cache = revisionCache<StyleEditorSnapshot>();
  #last: StyleEditorSnapshot | undefined;

  public constructor(host: StyleEditorHost, options: StyleEditorOptions = {}) {
    this.#host = host;
    this.#labels = { ...DEFAULT_LABELS, ...options.labels };
  }

  public getSnapshot(): StyleEditorSnapshot {
    const source = this.#host.annotations.getSnapshot();
    return this.#cache(source.runtimeRevision, () => {
      const built = this.#build();
      const previous = this.#last;
      // The revision moves for every transient publish — hover, marquee, every pointermove of a
      // drag — none of which change a style. Keying on the revision alone would hand back a new
      // object 60 times a second during a drag, so an equality gate sits behind it.
      //
      // ponytail: compared by `JSON.stringify`, which is exact here because one builder writes both
      // sides in one key order. Swap for a field-wise compare if a profile ever names it.
      const next = previous !== undefined && JSON.stringify(previous) === JSON.stringify(built)
        ? previous
        : built;
      this.#last = next;
      return next;
    });
  }

  /** Every change that can move a style publishes here, view activation included. */
  public subscribe(listener: () => void): () => void {
    return this.#host.annotations.subscribe(listener);
  }

  /**
   * Sets one field on every selected annotation, as one undo step.
   *
   * Sizes are **pixels**, matching the getter — a drafting panel writes `set('lineWidth', mm(0.25))`
   * rather than the millimetres. Neighbouring fields survive: the current override is read, merged
   * one level down so `landing`/`content` compose instead of clobbering, and written back whole.
   */
  public set<Key extends StyleField>(field: Key, value: NonNullable<StyleOverride[Key]>): void {
    this.#write(this.#labels.set, (id) => ({
      styleOverride: mergeStyleOverride(this.#own(id), { [field]: value } as StyleOverride),
    }));
  }

  /**
   * Reverts one field to the style, on every selected annotation, as one undo step.
   *
   * Spelled as an omission rather than an `undefined`, which the document rejects. A field the
   * *active saved view* overrides will not appear to change, because the view outranks the
   * annotation — `fields[field].source` is what tells a panel that before the user clicks.
   */
  public clear(field: StyleField): void {
    this.#write(this.#labels.clear, (id) => {
      const rest: MutableStyleOverride = { ...this.#own(id) };
      delete rest[field];
      // Folding an emptied override back to `null` keeps the document canonical, so reverting the
      // last field twice is genuinely a no-op rather than a second undo step.
      return { styleOverride: Object.keys(rest).length === 0 ? null : rest };
    });
  }

  /**
   * Points the selection at a style — "use the House style" — and drops the per-annotation
   * overrides with it, in one undo step.
   *
   * Both halves are one patch on purpose. The override outranks the style during resolution, so
   * assigning a style while leaving an override in place looks to the user like nothing happened.
   *
   * ponytail: all-or-nothing. "Clear only the fields the incoming style actually sets" needs that
   * style's own key set, and is a follow-on if a panel ever asks for it.
   */
  public assignStyle(styleId: string | null): void {
    this.#write(this.#labels.assign, () => ({ styleId, styleOverride: null }));
  }

  /** The annotation's own stored override, typed. */
  #own(id: string): StyleOverride {
    // ponytail: fields written by a newer version are dropped by `readStyleOverride` and so are lost
    // on write-back, since the patch replaces the whole override. Upgrade path is a core
    // `patchStyleOverride` that merges before storage and never has to round-trip through a reader.
    return readStyleOverride(this.#host.annotations.get(id)?.styleOverride);
  }

  #write(label: string, patch: (id: string) => AnnotationPatch): void {
    const { ids } = this.getSnapshot();
    if (ids.length === 0) return;
    this.#host.history.transaction(label, () => {
      for (const id of ids) {
        try {
          this.#host.annotations.update(id, patch(id));
        } catch (error) {
          // The transaction rolls back on the way out, so nothing is half-applied. Which annotation
          // failed is the one thing the raw error cannot say; the `code` is carried through
          // untouched, because that is what a host matches on.
          throw error instanceof ViewLeaderError
            ? new ViewLeaderError(
              error.code,
              `Style write failed on annotation "${id}": ${error.message}`,
              { ...error.details, annotationId: id },
              { cause: error },
            )
            : error;
        }
      }
    });
  }

  #build(): StyleEditorSnapshot {
    const ids: string[] = [];
    const styles: ResolvedStyle[] = [];
    for (const id of this.#host.annotations.getSnapshot().selectedIds) {
      const style = this.#host.annotations.resolvedStyle(id);
      if (style === undefined) continue;
      ids.push(id);
      styles.push(style);
    }
    const first = styles[0];
    if (first === undefined) return EMPTY_SNAPSHOT;
    const rest = styles.slice(1);

    const fields: Record<string, StyleFieldState<unknown>> = {};
    // `from` carries an entry for exactly the fields the resolved style has a value for, so it is
    // the field list as well as the provenance.
    for (const key of Object.keys(first.from) as StyleField[]) {
      const value = first[key];
      const source = first.from[key];
      if (value === undefined || source === undefined) continue;
      fields[key] = Object.freeze({
        value,
        mixed: rest.some((other) => !sameValue(other[key], value)),
        source: rest.some((other) => other.from[key] !== source) ? 'mixed' : source,
      });
    }
    return Object.freeze({
      ids: Object.freeze(ids),
      styleId: Object.freeze({
        value: first.styleId,
        mixed: rest.some((other) => other.styleId !== first.styleId),
      }),
      // One cast, here: the loop is keyed by a union so the compiler cannot pair each key with its
      // own value type, which the exported mapped type then restores for every reader.
      fields: Object.freeze(fields) as unknown as StyleFieldStates,
    });
  }
}

/**
 * Do two annotations agree on a field?
 *
 * Scalars compare by identity; `landing` and `content` are groups exactly one level deep, so a
 * shallow compare over the union of their keys is exact rather than a guess at how deep to go.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  const group = left as Record<string, unknown>;
  const other = right as Record<string, unknown>;
  return [...new Set([...Object.keys(group), ...Object.keys(other)])]
    .every((key) => Object.is(group[key], other[key]));
}
