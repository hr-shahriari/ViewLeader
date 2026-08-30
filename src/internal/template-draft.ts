// Turning "save this leader as a template" into a definition, and holding the form's state while
// the user fills it in.
//
// Two halves that stay separate on purpose. `captureTemplateDefaults` is pure — no document, no
// instance, testable on a literal — and holds the whole *policy* of what a template may carry.
// `TemplateDraft` is the buffer a dialog edits, and holds nothing but state plus the live checks a
// person can fail. `definitions.create()` remains the commit-time authority for both.
import type {
  TemplateApplicable,
  TemplateDefaults,
  TemplateDefinition,
  TypedDefinition,
} from '../definitions.js';
import type { ViewLeaderErrorCode } from '../errors.js';
import type {
  AnnotationContent,
  AnnotationPatch,
  AnnotationPlacement,
  AnnotationRouting,
} from '../types.js';
import type { SnapshotSource } from './lifecycle.js';
import { revisionCache } from './snapshot-cache.js';

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

/**
 * What capture reads. Both an `Annotation` and a bare {@link TemplateApplicable} satisfy it.
 *
 * An annotation has many legs, each with its own route, while `TemplateDefaults.routing` is
 * singular — so the **first** leg's route is the one captured, the same rule `AnnotationPatch`
 * already documents for its own `routing` shorthand. `styleOverride` is here only so it can be
 * warned about; it is never captured.
 */
export interface TemplateCaptureSource extends TemplateApplicable {
  readonly anchors?: readonly { readonly routing: AnnotationRouting }[];
  readonly styleOverride?: unknown;
}

export interface TemplateCaptureOptions {
  /**
   * `'shape'` (the default) keeps the content's *kind* and blanks what belongs to one annotation —
   * the text, and the model reference a tag points at. `'verbatim'` copies it whole, which is right
   * for a fixed symbol and wrong for anything a person typed.
   */
  readonly content?: 'shape' | 'verbatim';
}

export interface TemplateCaptureResult {
  readonly defaults: TemplateDefaults;
  /**
   * What capture refused to carry, in words a dialog can show. Empty in the ordinary case.
   *
   * Dropping is the smallest thing that is not *silently* wrong; the warning is what turns the
   * surprise into a sentence the user reads before they save.
   */
  readonly warnings: readonly string[];
}

/** The arm captured when the source has no automatic route of its own. Matches `builtin.template.note`. */
const FALLBACK_ROUTING: AnnotationRouting = { kind: 'automatic', mode: 'dogleg' };

/**
 * Reads a template's defaults off something that already exists.
 *
 * **The axis is the union arm, not the field.** `AnnotationPlacement` and `AnnotationRouting` are
 * both `automatic | manual`; the automatic arms are the entire point of a template, and the manual
 * arms are screen pixels measured at one zoom, one viewport and one annotation scale. Worse, a
 * captured `ManualPlacement` opts every label made from the template out of the placer for good —
 * no railing, no separation, no anti-swim — so ten annotations off one template land at ten
 * identical offsets that the separation pass is not allowed to push apart. Placement and routing
 * are therefore always the automatic arm, and that is not configurable. Both built-in templates
 * already settled it.
 */
export function captureTemplateDefaults(
  source: TemplateCaptureSource,
  options: TemplateCaptureOptions = {},
): TemplateCaptureResult {
  const warnings: string[] = [];
  if (source.styleOverride !== undefined) {
    warnings.push('Local style overrides are not saved into a template. Only the named style is.');
  }
  const content = source.content === undefined
    ? undefined
    : options.content === 'verbatim' ? source.content : captureContentShape(source.content);
  const routing = source.routing ?? source.anchors?.[0]?.routing;
  return {
    defaults: {
      ...(content === undefined ? {} : { content }),
      ...(source.styleId === undefined ? {} : { styleId: source.styleId }),
      placement: { kind: 'automatic' },
      routing: routing?.kind === 'automatic' ? routing : FALLBACK_ROUTING,
    },
    warnings,
  };
}

/**
 * Keeps the shape, drops the instance.
 *
 * `kind`, `symbol`, `direction` and `maxWidth` describe the *sort* of label this is and cross.
 * Everything a person typed is blanked, and `TagContent.reference` — one property of one element of
 * one model — is dropped outright, since a template carrying it would show every annotation the
 * same door's number. `HostImageContent.reference` is kept: a fixed symbol is the one reference a
 * template genuinely wants, and the field is required besides.
 *
 * Fields are rebuilt rather than assigned `undefined`: `assertJson` rejects an own property whose
 * value is `undefined` at commit, so the conditional-spread idiom is load-bearing here.
 *
 * ponytail: a switch on content kind. Ceiling — a seventh built-in kind added without a case here
 * crosses verbatim, references and all. Upgrade path: the `OverrideReaders<Shape>` idiom in
 * `definitions.ts` makes the compiler demand an entry per member; mirror it with a
 * `Record<BuiltInContent['kind'], …>` when that seventh kind appears.
 */
function captureContentShape(content: AnnotationContent): AnnotationContent {
  switch (content.kind) {
    case 'plain-note':
      return { ...content, text: '' };
    case 'tag': {
      const { reference: _reference, ...rest } = content;
      return { ...rest, text: '' };
    }
    case 'callout': {
      const { title: _title, ...rest } = content;
      return { ...rest, text: '' };
    }
    case 'split-callout':
      return { ...content, primary: '', secondary: '' };
    case 'symbolic-block':
      return { ...content, label: '' };
    case 'host-image':
      return { ...content, alt: '' };
    default:
      // Plugin content is opaque — core is forbidden to read inside `data`, so it crosses whole or
      // not at all, and whole is the only one of those that can round-trip.
      return content;
  }
}

// ---------------------------------------------------------------------------------------------
// The draft buffer
// ---------------------------------------------------------------------------------------------

/** The three fields the live checker reports on. The rest of a template cannot be typed wrong. */
export type TemplateDraftField = 'id' | 'name' | 'defaults.styleId';

/**
 * One thing wrong with the draft, reported rather than thrown.
 *
 * Shaped like `Diagnostic` and `LintFinding`, the repo's two other non-throwing reports, so *match
 * on `code`, never on the message text* stays true here too.
 */
export interface TemplateDraftIssue {
  readonly field: TemplateDraftField;
  readonly code: ViewLeaderErrorCode;
  readonly message: string;
}

export interface TemplateDraftSnapshot {
  readonly id: string;
  readonly name: string;
  readonly defaults: TemplateDefaults;
  readonly issues: readonly TemplateDraftIssue[];
  /** Something already goes by this id. Also reported as an issue; here as a boolean a form can bind. */
  readonly idTaken: boolean;
  /** A preview is currently sitting on the document, waiting to be committed over or undone. */
  readonly previewApplied: boolean;
}

/**
 * A one-level patch. Absent leaves a field alone; `null` clears it.
 *
 * One level, not two: `placement` and `routing` are discriminated unions, and merging
 * `{ mode: 'dogleg' }` into `{ kind: 'manual', vertices: [] }` yields an object that cannot exist.
 * `null` is how every other patch in this codebase clears an optional field.
 */
export interface TemplateDraftPatch {
  readonly id?: string;
  readonly name?: string;
  readonly defaults?: {
    readonly content?: AnnotationContent | null;
    readonly styleId?: string | null;
    readonly placement?: AnnotationPlacement | null;
    readonly routing?: AnnotationRouting | null;
  };
}

/** The reads and writes the draft needs, narrowed from the capabilities so a test can fake them. */
export interface TemplateDraftPorts {
  readonly definitions: {
    get(id: string): TypedDefinition | undefined;
    create<Definition extends TypedDefinition>(definition: Definition): Definition;
    getSnapshot(): { readonly documentRevision: number };
    subscribe(listener: () => void): () => void;
  };
  readonly history: {
    transaction<Result>(label: string, operation: () => Result): Result;
    getSnapshot(): { readonly undoLabel: string | null };
    undo(): boolean;
  };
  readonly annotations: {
    getSnapshot(): { readonly selectedIds: readonly string[] };
    update(id: string, patch: AnnotationPatch): unknown;
  };
}

export interface TemplateDraftOptions extends TemplateDraftPorts {
  /**
   * Leave it out and one is generated. The `template.` prefix is not decoration: `validateId`
   * demands a leading letter, and a UUID starts with a hex character, so a bare
   * `crypto.randomUUID()` is an illegal definition id about 62% of the time.
   */
  readonly id?: string;
  /** Required by the time it commits; empty by default so the form starts with the honest error. */
  readonly name?: string;
  readonly defaults?: TemplateDefaults;
}

const PREVIEW_LABEL = 'Preview template';
const COMMIT_LABEL = 'Save template';

/**
 * The state behind a "save as template" dialog.
 *
 * A `SnapshotSource`, so a binding can hand it straight to `useSyncExternalStore` or a Vue getter:
 * `getSnapshot()` returns the same object until something actually moves.
 */
export class TemplateDraft implements SnapshotSource<TemplateDraftSnapshot> {
  readonly #ports: TemplateDraftPorts;
  readonly #listeners = new Set<() => void>();
  readonly #cache = revisionCache<TemplateDraftSnapshot>();
  #id: string;
  #name: string;
  #defaults: TemplateDefaults;
  #previewApplied = false;
  #disposed = false;
  readonly #unsubscribes = new Set<() => void>();
  #revision = 0;
  #documentRevision = -1;

  public constructor(options: TemplateDraftOptions) {
    this.#ports = options;
    this.#id = options.id ?? `template.${crypto.randomUUID()}`;
    this.#name = options.name ?? '';
    this.#defaults = options.defaults ?? {};
  }

  public getSnapshot(): TemplateDraftSnapshot {
    // Definitions change under an open dialog — another actor can take the chosen id or delete the
    // chosen style — so the document revision is part of the key, not just the draft's own edits.
    const documentRevision = this.#ports.definitions.getSnapshot().documentRevision;
    if (documentRevision !== this.#documentRevision) {
      this.#documentRevision = documentRevision;
      this.#revision += 1;
    }
    return this.#cache(this.#revision, () => this.#build());
  }

  public subscribe(listener: () => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    const unsubscribe = this.#ports.definitions.subscribe(listener);
    // Held so `dispose()` can release them: each caller gets its own closure, and a host that drops
    // the draft without calling every one of them would otherwise leave listeners on `definitions`.
    this.#unsubscribes.add(unsubscribe);
    return () => {
      this.#listeners.delete(listener);
      this.#unsubscribes.delete(unsubscribe);
      unsubscribe();
    };
  }

  /** Merges one level. `null` clears a field; an absent field is left alone. */
  public set(patch: TemplateDraftPatch): void {
    if (patch.id !== undefined) this.#id = patch.id;
    if (patch.name !== undefined) this.#name = patch.name;
    if (patch.defaults !== undefined) this.#defaults = mergeDefaults(this.#defaults, patch.defaults);
    this.#publish();
  }

  /**
   * Writes the draft onto the current selection as one ordinary undoable commit, so the user can
   * see a real frame — real placement, real routing — rather than a swatch.
   *
   * Applying twice undoes the first, so at most one preview is ever outstanding. Returns the ids
   * written, empty when nothing is selected.
   *
   * ponytail: a swatch plus a one-shot apply. Ceiling — no live per-keystroke preview on the model,
   * and each apply clears the redo stack the way any commit does. Upgrade path: a `#templatePreview`
   * field on the runtime beside the five drag previews, read in the frame where style and routing
   * resolve and cleared alongside them on dispose.
   */
  public applyPreview(): readonly string[] {
    this.#revertPreview();
    const ids = [...this.#ports.annotations.getSnapshot().selectedIds];
    if (ids.length > 0) {
      const patch = templatePatch(this.#defaults);
      this.#ports.history.transaction(PREVIEW_LABEL, () => {
        for (const id of ids) this.#ports.annotations.update(id, patch);
      });
      // A transaction that changed nothing is elided and pushes no entry, so ask the history what
      // actually happened rather than assuming — the alternative is a discard that eats an
      // unrelated edit of the user's.
      this.#previewApplied = this.#ports.history.getSnapshot().undoLabel === PREVIEW_LABEL;
    }
    this.#publish();
    return ids;
  }

  /**
   * Creates the template.
   *
   * The transaction is one line and buys two things: an undo entry a person recognises instead of
   * `Create template template.9f3c…`, and one that *stays* single when commit grows a second write.
   * No dirty check is needed — a transaction whose before and after match is elided, so committing
   * an unchanged draft already costs nothing.
   */
  public commit(): TemplateDefinition {
    const definition = this.#definition();
    const created = this.#ports.history.transaction(
      COMMIT_LABEL,
      () => this.#ports.definitions.create(definition),
    );
    // The preview is the user's to keep now; discarding afterwards must not swallow it.
    this.#previewApplied = false;
    this.#publish();
    return created;
  }

  /** Throws away the draft, undoing the preview if — and only if — it is the one still on top. */
  public discard(): void {
    this.#revertPreview();
    this.#publish();
  }

  /**
   * Ends the draft, taking any preview with it.
   *
   * Unmounting the dialog *is* the ordinary way a template gets cancelled — nobody presses a
   * Discard button on their way out — so without this a preview stays applied to the drawing after
   * the thing that applied it has gone. Reverting goes through the same guard as {@link discard}:
   * a commit the user made after the preview is theirs and is never undone.
   */
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // A framework tears its own hooks down in whatever order it registered them, and the one owning
    // the ViewLeader may well go first — React's cleanups run in effect order, not reverse. Reverting
    // into a disposed instance is then not a failure, it is moot: the document went with it. Dispose
    // must not throw either way.
    try {
      this.#revertPreview();
    } catch {
      this.#previewApplied = false;
    }
    this.#publish();
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes.clear();
    this.#listeners.clear();
  }

  #revertPreview(): void {
    if (!this.#previewApplied) return;
    this.#previewApplied = false;
    // Anything committed since the preview belongs to the user. Undoing blind would take theirs.
    if (this.#ports.history.getSnapshot().undoLabel === PREVIEW_LABEL) this.#ports.history.undo();
  }

  #definition(): TemplateDefinition {
    return { kind: 'template', id: this.#id, name: this.#name, defaults: this.#defaults };
  }

  #build(): TemplateDraftSnapshot {
    const get = (id: string): TypedDefinition | undefined => this.#ports.definitions.get(id);
    return Object.freeze({
      id: this.#id,
      name: this.#name,
      defaults: this.#defaults,
      issues: Object.freeze(checkTemplateDraft(this.#id, this.#name, this.#defaults, get)),
      idTaken: get(this.#id) !== undefined,
      previewApplied: this.#previewApplied,
    });
  }

  #publish(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }
}

function mergeDefaults(
  base: TemplateDefaults,
  patch: NonNullable<TemplateDraftPatch['defaults']>,
): TemplateDefaults {
  const content = patch.content === undefined ? base.content : patch.content ?? undefined;
  const styleId = patch.styleId === undefined ? base.styleId : patch.styleId ?? undefined;
  const placement = patch.placement === undefined ? base.placement : patch.placement ?? undefined;
  const routing = patch.routing === undefined ? base.routing : patch.routing ?? undefined;
  return {
    ...(content === undefined ? {} : { content }),
    ...(styleId === undefined ? {} : { styleId }),
    ...(placement === undefined ? {} : { placement }),
    ...(routing === undefined ? {} : { routing }),
  };
}

/** The same four fields `applyTemplateToAnnotation` writes, as a patch. */
function templatePatch(defaults: TemplateDefaults): AnnotationPatch {
  return {
    ...(defaults.content === undefined ? {} : { content: defaults.content }),
    ...(defaults.styleId === undefined ? {} : { styleId: defaults.styleId }),
    ...(defaults.placement === undefined ? {} : { placement: defaults.placement }),
    ...(defaults.routing === undefined ? {} : { routing: defaults.routing }),
  };
}

/**
 * `validateId`'s rule, restated.
 *
 * ponytail: this and the 256-character name bound are copies of two module-private predicates in
 * `definitions.ts`. Ceiling — they can drift. Upgrade path: export those two and have both callers
 * use them; not worth it until a third caller exists.
 */
const DEFINITION_ID = /^[a-zA-Z][a-zA-Z0-9._:-]*$/u;

/**
 * Everything a person can get wrong, reported instead of thrown, and recomputed whenever the
 * definitions move underneath the form.
 *
 * `validateDefinition` never looks inside `defaults` beyond its key names, so this checks exactly
 * what `create()` would reject *and a human could cause*: the id, the name and the referenced
 * style. It deliberately does not restate `assertJson` — malformed content still throws at commit,
 * which is what "create() is the authority" means.
 */
function checkTemplateDraft(
  id: string,
  name: string,
  defaults: TemplateDefaults,
  get: (id: string) => TypedDefinition | undefined,
): TemplateDraftIssue[] {
  const issues: TemplateDraftIssue[] = [];
  if (id.length === 0 || id.length > 128 || !DEFINITION_ID.test(id)) {
    issues.push({
      field: 'id',
      code: 'INVALID_INPUT',
      message: 'A template id must start with a letter, then use only letters, digits, . _ : and -',
    });
  } else if (id.startsWith('builtin.')) {
    issues.push({
      field: 'id',
      code: 'IMMUTABLE_DEFINITION',
      message: `Built-in definition "${id}" is immutable`,
    });
  } else if (get(id) !== undefined) {
    issues.push({
      field: 'id',
      code: 'INVALID_INPUT',
      message: `Definition "${id}" already exists`,
    });
  }
  if (name.length === 0 || name.length > 256) {
    issues.push({
      field: 'name',
      code: 'INVALID_INPUT',
      message: 'A template name must contain 1–256 characters',
    });
  }
  const styleId = defaults.styleId;
  if (styleId !== undefined && get(styleId)?.kind !== 'style') {
    issues.push({
      field: 'defaults.styleId',
      code: 'NOT_FOUND',
      message: `Unknown style: ${styleId}`,
    });
  }
  return issues;
}
