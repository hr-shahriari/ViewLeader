// The document: the saved state of a drawing, and the only thing here that can be edited.
//
// Everything a user changes goes through a transaction, which is what makes undo work and what
// keeps a half-finished edit from ever being visible. Nothing is written unless the whole change
// validates.
//
// Two ideas run through this file. Files are checked strictly when authored and forgivingly when
// loaded, so a typo fails immediately but a colleague's drawing still opens. And fields written by
// a newer version are kept word-for-word rather than dropped, so an older build cannot quietly
// delete work it does not understand when it saves.
import {
  DocumentTooLargeError,
  DuplicateIdError,
  InvalidDocumentError,
  InvalidInputError,
  InvariantViolationError,
  NotFoundError,
} from './errors.js';
import type { Diagnostic } from './host.js';
import type {
  Anchor,
  Annotation,
  AnnotationContent,
  AnnotationDraft,
  AnnotationLeg,
  AnnotationPatch,
  AnnotationPlacement,
  AnnotationRouting,
  DefinitionCollections,
  HistorySnapshot,
  JsonObject,
  JsonValue,
  NamespacedMetadata,
  OrganizationRect,
  PluginEnvelope,
  TagReference,
  ViewLeaderDocument,
} from './types.js';
import { inkFromJson, multiLeaderFromCore, regionAnchorFromCore } from './markup.js';
import { validateHostImageContent } from './images.js';

export interface DocumentLimits {
  readonly maxBytes: number;
  readonly maxAnnotations: number;
  readonly maxTextLength: number;
  readonly maxMetadataEntries: number;
  readonly maxPluginEnvelopes: number;
  readonly maxJsonDepth: number;
  readonly maxArrayLength: number;
}

export const DEFAULT_DOCUMENT_LIMITS: DocumentLimits = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxAnnotations: 5_000,
  maxTextLength: 65_536,
  maxMetadataEntries: 1_000,
  maxPluginEnvelopes: 1_000,
  maxJsonDepth: 16,
  maxArrayLength: 20_000,
});

/**
 * Where a load reports what it could not use.
 *
 * Supplying one also makes the load forgiving: an annotation this version cannot read is set aside
 * and reported here, rather than bringing down the whole file. Leave it out — as everything that
 * creates or edits does — and the load stays strict.
 *
 * Unknown *fields* are always preserved either way. This is only about whole annotations.
 */
export type DocumentDiagnose = (diagnostic: Diagnostic) => void;

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

export type DocumentCommitKind = 'mutation' | 'undo' | 'redo' | 'replacement';

export interface DocumentCommit {
  readonly kind: DocumentCommitKind;
  readonly document: ViewLeaderDocument;
  readonly documentRevision: number;
}

interface HistoryEntry {
  readonly label: string;
  readonly before: ViewLeaderDocument;
  readonly after: ViewLeaderDocument;
}

export interface DocumentEngineOptions {
  readonly historyCapacity?: number;
  readonly limits?: Partial<DocumentLimits>;
}

export interface DocumentEditResult<Result> {
  readonly document: ViewLeaderDocument;
  readonly result: Result;
}

export function createEmptyDocument(): ViewLeaderDocument {
  return freezeDocument({
    schema: 'viewleader.document',
    version: CURRENT_DOCUMENT_VERSION,
    annotations: [],
    metadata: {},
    pluginEnvelopes: [],
    definitions: emptyDefinitions(),
    savedViews: [],
    tours: [],
    ink: [],
  });
}

export function parseDocument(
  source: string,
  limits: Partial<DocumentLimits> = {},
  diagnose?: DocumentDiagnose,
): ViewLeaderDocument {
  const resolved = resolveLimits(limits);
  assertByteLimit(source, resolved);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (cause) {
    throw new InvalidDocumentError('Document is not valid JSON', {}, { cause });
  }
  return prepareDocument(value, resolved, diagnose);
}

export function prepareDocument(
  value: unknown,
  limits: Partial<DocumentLimits> | DocumentLimits = {},
  diagnose?: DocumentDiagnose,
): ViewLeaderDocument {
  const resolved = isResolvedLimits(limits) ? limits : resolveLimits(limits);
  try {
    const normalized = normalizeDocument(value, resolved, diagnose);
    assertByteLimit(canonicalStringify(expandDocument(normalized)), resolved);
    return freezeDocument(normalized);
  } catch (error) {
    if (error instanceof InvalidDocumentError || error instanceof DocumentTooLargeError) {
      throw error;
    }
    throw new InvalidDocumentError('Document failed validation', {}, { cause: error });
  }
}

export function serializeDocument(
  document: ViewLeaderDocument,
  limits: Partial<DocumentLimits> = {},
): string {
  const prepared = prepareDocument(document, limits);
  const serialized = canonicalStringify(expandDocument(prepared));
  assertByteLimit(serialized, resolveLimits(limits));
  return serialized;
}

/**
 * Owns the document and is the only thing that can change it.
 *
 * Deliberately not exported from the package. Hosts reach it through the public capabilities
 * instead, which is what guarantees every change goes through a transaction and lands in history.
 */
export class DocumentEngine {
  readonly #historyCapacity: number;
  readonly #limits: DocumentLimits;
  readonly #listeners = new Set<(commit: DocumentCommit) => void>();
  #document = createEmptyDocument();
  #documentRevision = 0;
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #transactionDepth = 0;
  #working: ViewLeaderDocument | undefined;
  #transactionLabel: string | undefined;
  #idSequence = 0;

  public constructor(options: DocumentEngineOptions = {}) {
    const capacity = options.historyCapacity ?? 100;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new InvalidInputError('historyCapacity must be a positive integer', {
        historyCapacity: capacity,
      });
    }
    this.#historyCapacity = capacity;
    this.#limits = resolveLimits(options.limits ?? {});
  }

  public get document(): ViewLeaderDocument {
    return this.#document;
  }

  public get documentRevision(): number {
    return this.#documentRevision;
  }

  public parse(source: string, diagnose?: DocumentDiagnose): ViewLeaderDocument {
    return parseDocument(source, this.#limits, diagnose);
  }

  public prepare(value: unknown, diagnose?: DocumentDiagnose): ViewLeaderDocument {
    return prepareDocument(value, this.#limits, diagnose);
  }

  public serialize(): string {
    return serializeDocument(this.#document, this.#limits);
  }

  public subscribe(listener: (commit: DocumentCommit) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public historySnapshot(runtimeRevision: number): HistorySnapshot {
    return Object.freeze({
      runtimeRevision,
      documentRevision: this.#documentRevision,
      undoCount: this.#undo.length,
      redoCount: this.#redo.length,
      undoLabel: this.#undo.at(-1)?.label ?? null,
      redoLabel: this.#redo.at(-1)?.label ?? null,
    });
  }

  public create(draft: AnnotationDraft, label = 'Create annotation'): Annotation {
    const annotation = deepFreeze(normalizeAnnotationDraft(draft, this.#nextId(), this.#limits));
    return this.edit(label, (document) => {
      if (document.annotations.some(({ id }) => id === annotation.id)) {
        throw new DuplicateIdError(annotation.id);
      }
      return {
        document: { ...document, annotations: [...document.annotations, annotation] },
        result: annotation,
      };
    });
  }

  public update(id: string, patch: AnnotationPatch, label = 'Update annotation'): Annotation {
    assertId(id, 'annotation id');
    return this.edit(label, (document) => {
      const index = document.annotations.findIndex((annotation) => annotation.id === id);
      const current = document.annotations[index];
      if (current === undefined) throw new NotFoundError('annotation', id);
      const updated = deepFreeze(applyAnnotationPatch(current, patch, this.#limits));
      if (canonicalStringify(current) === canonicalStringify(updated)) {
        return { document, result: current };
      }
      const annotations = [...document.annotations];
      annotations[index] = updated;
      return { document: { ...document, annotations }, result: updated };
    });
  }

  public remove(id: string, label = 'Remove annotation'): Annotation {
    assertId(id, 'annotation id');
    return this.edit(label, (document) => {
      const current = document.annotations.find((annotation) => annotation.id === id);
      if (current === undefined) throw new NotFoundError('annotation', id);
      return {
        document: {
          ...document,
          annotations: document.annotations.filter((annotation) => annotation.id !== id),
        },
        result: current,
      };
    });
  }

  public get(id: string): Annotation | undefined {
    assertId(id, 'annotation id');
    return this.#activeDocument().annotations.find((annotation) => annotation.id === id);
  }

  public edit<Result>(
    label: string,
    operation: (document: ViewLeaderDocument) => DocumentEditResult<Result>,
  ): Result {
    assertLabel(label);
    if (this.#transactionDepth === 0) {
      return this.transaction(label, () => this.edit(label, operation));
    }
    const current = this.#activeDocument();
    const outcome = operation(current);
    // Nested edits still roll back independently, but only the outermost transaction validates the
    // whole document. Otherwise a change touching fifty annotations would re-check the entire file
    // fifty times.
    this.#working = outcome.document;
    return outcome.result;
  }

  public transaction<Result>(label: string, operation: () => Result): Result {
    assertLabel(label);
    const outer = this.#transactionDepth === 0;
    if (outer) {
      this.#working = this.#document;
      this.#transactionLabel = label;
    }
    const savepoint = this.#activeDocument();
    this.#transactionDepth += 1;
    const rollback = (): void => {
      this.#working = savepoint;
      this.#transactionDepth -= 1;
      if (outer) this.#clearTransaction();
    };
    let result: Result;
    try {
      result = operation();
    } catch (error) {
      rollback();
      throw error;
    }
    // An async callback is a bug, not a preference: everything after its first `await` would land
    // outside this transaction, as its own separate undo steps, with nobody told.
    //
    // Whatever ran before the await has already happened, so it is rolled back. Committing half a
    // change the caller believed was one change is worse than committing none of it.
    if (isThenable(result)) {
      rollback();
      // Nothing is going to await that promise now. Absorb any failure from it, so the developer
      // sees the clear error below instead of an unrelated crash beside it.
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError(
        `Transaction "${label}" received an async callback. Transactions are synchronous: await first, `
        + 'then open the transaction around the mutations.',
      );
    }
    this.#transactionDepth -= 1;
    if (outer) {
      try {
        this.#finishTransaction();
      } catch (error) {
        this.#clearTransaction();
        throw error;
      }
    }
    return result;
  }

  public undo(): boolean {
    this.#assertOutsideTransaction('undo');
    const entry = this.#undo.pop();
    if (entry === undefined) return false;
    this.#redo.push(entry);
    this.#publish(entry.before, 'undo');
    return true;
  }

  public redo(): boolean {
    this.#assertOutsideTransaction('redo');
    const entry = this.#redo.pop();
    if (entry === undefined) return false;
    this.#undo.push(entry);
    this.#publish(entry.after, 'redo');
    return true;
  }

  public replace(
    value: string | ViewLeaderDocument,
    diagnose?: DocumentDiagnose,
  ): ViewLeaderDocument {
    this.#assertOutsideTransaction('replace the document');
    const prepared = typeof value === 'string'
      ? parseDocument(value, this.#limits, diagnose)
      : prepareDocument(value, this.#limits, diagnose);
    this.#undo = [];
    this.#redo = [];
    this.#publish(prepared, 'replacement');
    return this.#document;
  }

  #finishTransaction(): void {
    const before = this.#document;
    const after = prepareDocument(this.#activeDocument(), this.#limits);
    const label = this.#transactionLabel ?? 'Transaction';
    this.#clearTransaction();
    if (canonicalStringify(before) === canonicalStringify(after)) return;
    this.#undo.push({ label, before, after });
    if (this.#undo.length > this.#historyCapacity) this.#undo.shift();
    this.#redo = [];
    this.#publish(after, 'mutation');
  }

  #publish(document: ViewLeaderDocument, kind: DocumentCommitKind): void {
    this.#document = document;
    this.#documentRevision += 1;
    const commit = Object.freeze({
      kind,
      document,
      documentRevision: this.#documentRevision,
    });
    for (const listener of [...this.#listeners]) {
      try {
        listener(commit);
      } catch {
        // The change is already saved. A listener that throws while being notified cannot be
        // allowed to undo it.
      }
    }
  }

  #activeDocument(): ViewLeaderDocument {
    return this.#working ?? this.#document;
  }

  #clearTransaction(): void {
    this.#working = undefined;
    this.#transactionLabel = undefined;
  }

  #assertOutsideTransaction(operation: string): void {
    if (this.#transactionDepth !== 0) {
      throw new InvalidInputError(`Cannot ${operation} during a document transaction`);
    }
  }

  #nextId(): string {
    this.#idSequence += 1;
    const randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    return randomUuid?.() ?? `annotation-${this.#idSequence}`;
  }
}

/**
 * The file format version this build writes.
 *
 * The step to version 2 does no actual work — the field it added means the same thing by its
 * absence. It exists anyway, so that the upgrade machinery is exercised by a real migration. The
 * alternative is that the first upgrade with anything at stake is also the first one ever run.
 */
export const CURRENT_DOCUMENT_VERSION = 2;

/**
 * The upgrade steps, one per old version, each producing the next.
 *
 * Applied one after another, so an old file walks every step up to the present rather than jumping
 * straight to it. A chain that allows jumps is a chain nobody can safely add a step to later.
 */
type RawDocument = Record<string, unknown>;

const DOCUMENT_MIGRATIONS: ReadonlyMap<number, (input: RawDocument) => RawDocument> = new Map([
  // Version 1 to 2: `locked` was added, and its absence already means unlocked. Nothing to do.
  [1, (input: RawDocument): RawDocument => ({ ...input, version: 2 })],
]);

/**
 * Upgrades a document to the current version.
 *
 * Refuses anything it does not recognise in either direction. Below version 1 is not a document at
 * all; above the current version was written by a newer build.
 *
 * That last refusal is deliberate, even though unknown *fields* are preserved elsewhere. A new
 * version number is a statement that the shape itself changed, and opening such a file anyway would
 * mean saving over data this build never understood.
 */
function migrateDocument(input: RawDocument): RawDocument {
  const version = input.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new InvalidDocumentError(
      'Document version must be a positive integer',
      { schema: input.schema, version },
    );
  }
  if (version > CURRENT_DOCUMENT_VERSION) {
    throw new InvalidDocumentError(
      `Document was written by a newer version (${version}); this build reads up to ${CURRENT_DOCUMENT_VERSION}`,
      { schema: input.schema, version, supported: CURRENT_DOCUMENT_VERSION },
    );
  }
  let migrated = input;
  for (let from = version; from < CURRENT_DOCUMENT_VERSION; from += 1) {
    const step = DOCUMENT_MIGRATIONS.get(from);
    if (step === undefined) {
      throw new InvariantViolationError(
        `No migration from document version ${from}`,
        { from, to: CURRENT_DOCUMENT_VERSION },
      );
    }
    migrated = step(migrated);
  }
  return migrated;
}

/** The fields this version knows about. Anything else came from a newer one. */
const DOCUMENT_KEYS: ReadonlySet<string> = new Set([
  'annotations',
  'pluginEnvelopes',
  'quarantined',
  'unknownFields',
]);

function normalizeDocument(
  value: unknown,
  limits: DocumentLimits,
  diagnose?: DocumentDiagnose,
): ViewLeaderDocument {
  const raw = objectValue(value, 'document');
  // This is not a document at all. Nothing further down can recover from that.
  if (raw.schema !== 'viewleader.document') {
    throw new InvalidDocumentError(
      'Only the viewleader.document schema is supported',
      { schema: raw.schema, version: raw.version },
    );
  }
  const input = migrateDocument(raw);
  const annotations = arrayValue(input.annotations, 'annotations');
  if (annotations.length > limits.maxAnnotations) {
    throw new DocumentTooLargeError('Document has too many annotations', {
      count: annotations.length,
      limit: limits.maxAnnotations,
    });
  }
  const normalizedAnnotations: Annotation[] = [];
  const quarantined = [...normalizeJsonObjectArray(
    input.quarantined ?? [],
    limits,
    'quarantined annotations',
  )];
  for (const candidate of annotations) {
    try {
      const annotation = normalizeAnnotation(candidate, limits);
      multiLeaderFromCore(annotation);
      normalizedAnnotations.push(annotation);
    } catch (error) {
      if (diagnose === undefined) throw error;
      quarantineOrSkip(candidate, error, limits, quarantined, diagnose);
    }
  }
  const ids = new Set<string>();
  for (const id of [...normalizedAnnotations.map(({ id: value }) => value),
    ...quarantined.map(annotationKey)]) {
    if (ids.has(id)) throw new DuplicateIdError(id);
    ids.add(id);
  }
  const envelopes = arrayValue(input.pluginEnvelopes, 'pluginEnvelopes');
  if (envelopes.length > limits.maxPluginEnvelopes) {
    throw new DocumentTooLargeError('Document has too many plugin envelopes', {
      count: envelopes.length,
      limit: limits.maxPluginEnvelopes,
    });
  }
  // These get re-ordered, so anything unrecognised is set aside before sorting and matched back
  // up afterwards — otherwise a newer version's field would end up on the wrong record.
  const preparedEnvelopes = envelopes.map((envelope) => {
    const normalized = normalizePluginEnvelope(envelope, limits);
    return { normalized, residue: residueOf(envelope, normalized, limits, 'plugin envelope') };
  }).sort((a, b) => envelopeKey(a.normalized).localeCompare(envelopeKey(b.normalized)));
  const envelopeResidue: Record<string, JsonValue> = {};
  preparedEnvelopes.forEach(({ residue }, index) => {
    if (residue !== undefined) envelopeResidue[String(index)] = residue;
  });
  const normalizedInk = normalizeJsonObjectArray(input.ink, limits, 'ink');
  for (const ink of normalizedInk) inkFromJson(ink);
  const document: Mutable<ViewLeaderDocument> = {
    schema: 'viewleader.document',
    version: CURRENT_DOCUMENT_VERSION,
    annotations: normalizedAnnotations.sort((a, b) => a.id.localeCompare(b.id)),
    metadata: normalizeMetadata(input.metadata, limits, 'document metadata'),
    pluginEnvelopes: preparedEnvelopes.map(({ normalized }) => normalized),
    definitions: normalizeDefinitions(input.definitions, limits),
    savedViews: normalizeJsonObjectArray(input.savedViews, limits, 'savedViews'),
    tours: normalizeJsonObjectArray(input.tours, limits, 'tours'),
    ink: normalizedInk,
  };
  if (input.layoutFrame !== undefined && input.layoutFrame !== null) {
    document.layoutFrame = normalizeOrganizationRect(input.layoutFrame, 'layoutFrame');
  }
  const residue = mergeResidue(
    mergeResidue(
      carriedResidue(input.unknownFields, limits, 'document'),
      residueOf(input, document, limits, 'document', DOCUMENT_KEYS),
    ),
    Object.keys(envelopeResidue).length === 0 ? undefined : { pluginEnvelopes: envelopeResidue },
  );
  if (residue !== undefined) document.unknownFields = residue;
  if (quarantined.length > 0) {
    document.quarantined = quarantined
      .sort((a, b) => annotationKey(a).localeCompare(annotationKey(b)));
  }
  return document;
}

/**
 * Decides what to do with an annotation that cannot be read.
 *
 * One naming a type this version has never heard of came from a newer build, so it is set aside
 * untouched and written back out on save. One that is simply malformed is dropped — keeping
 * corruption only spreads it.
 */
function quarantineOrSkip(
  candidate: unknown,
  error: unknown,
  limits: DocumentLimits,
  quarantined: JsonObject[],
  diagnose: DocumentDiagnose,
): void {
  const id = isPlainObject(candidate) && typeof candidate.id === 'string'
    ? candidate.id
    : undefined;
  const reason = error instanceof Error ? error.message : String(error);
  if (id !== undefined && error instanceof InvalidDocumentError
    && error.details.unrecognized === true) {
    // There is no point preserving something that is itself broken or unbounded. That is corrupt
    // whoever wrote it, so it is skipped rather than carried.
    try {
      quarantined.push(normalizeJsonObject(candidate, limits, `annotation ${id}`));
      diagnose({
        code: 'document.annotation-quarantined',
        severity: 'warning',
        message: `Annotation "${id}" was written by a newer version and is preserved but not rendered: ${reason}`,
        annotationId: id,
      });
      return;
    } catch {
      // fall through
    }
  }
  diagnose({
    code: 'document.annotation-skipped',
    severity: 'warning',
    message: `Annotation ${id === undefined ? 'without a usable id' : `"${id}"`} was dropped: ${reason}`,
    ...(id === undefined ? {} : { annotationId: id }),
  });
}

function normalizeAnnotationDraft(
  draft: AnnotationDraft,
  generatedId: string,
  limits: DocumentLimits,
): Annotation {
  const usesSingle = draft.anchor !== undefined;
  const usesMultiple = draft.anchors !== undefined;
  if (usesSingle === usesMultiple) {
    throw new InvalidInputError('Exactly one of anchor or anchors is required');
  }
  if (usesMultiple && draft.routing !== undefined) {
    throw new InvalidInputError('routing is only valid with the single anchor convenience form');
  }
  const anchors = usesSingle
    ? [{
        id: 'leg-1',
        anchor: draft.anchor as Anchor,
        // A drafting leader is a dogleg: a diagonal running into a level tail. That is what makes
        // it read as a note rather than as another line in the model.
        //
        // Changing this default is safe because the choice is written into the document when an
        // annotation is created. An existing file says what it says and reopens unchanged; only
        // newly created annotations get the new default.
        routing: draft.routing ?? { kind: 'automatic', mode: 'dogleg' },
      }]
    : draft.anchors as readonly AnnotationLeg[];
  const candidate: Record<string, unknown> = {
    id: draft.id ?? generatedId,
    anchors,
    content: draft.content,
    placement: draft.placement ?? { kind: 'automatic' },
    metadata: draft.metadata ?? {},
  };
  if (draft.styleId !== undefined) candidate.styleId = draft.styleId;
  if (draft.styleOverride !== undefined) candidate.styleOverride = draft.styleOverride;
  if (draft.occlusion !== undefined) candidate.occlusion = draft.occlusion;
  if (draft.locked !== undefined) candidate.locked = draft.locked;
  return normalizeAnnotation(candidate, limits);
}

function applyAnnotationPatch(
  annotation: Annotation,
  patch: AnnotationPatch,
  limits: DocumentLimits,
): Annotation {
  if (patch.anchor !== undefined && patch.anchors !== undefined) {
    throw new InvalidInputError('anchor and anchors cannot be updated together');
  }
  let anchors = annotation.anchors;
  if (patch.anchors !== undefined) anchors = patch.anchors;
  if (patch.anchor !== undefined || patch.routing !== undefined) {
    const first = annotation.anchors[0];
    if (first === undefined) throw new InvalidInputError('Annotation has no anchor leg');
    anchors = [
      {
        id: first.id,
        anchor: patch.anchor ?? first.anchor,
        routing: patch.routing ?? first.routing,
      },
      ...annotation.anchors.slice(1),
    ];
  }
  // The user has just replaced this value with one this version understands, so anything a newer
  // version had stored alongside it no longer describes what is there. Drop it.
  let residue = annotation.unknownFields;
  if (patch.anchors !== undefined) residue = dropResidue(residue, ['anchors']);
  if (patch.anchor !== undefined) residue = dropResidue(residue, ['anchors', '0', 'anchor']);
  if (patch.routing !== undefined) residue = dropResidue(residue, ['anchors', '0', 'routing']);
  if (patch.content !== undefined) residue = dropResidue(residue, ['content']);
  if (patch.placement !== undefined) residue = dropResidue(residue, ['placement']);
  const candidate: Record<string, unknown> = {
    ...annotation,
    anchors,
    content: patch.content ?? annotation.content,
    placement: patch.placement ?? annotation.placement,
    metadata: patch.metadata ?? annotation.metadata,
  };
  if (residue === undefined) delete candidate.unknownFields;
  else candidate.unknownFields = residue;
  if (patch.styleId === null) delete candidate.styleId;
  else if (patch.styleId !== undefined) candidate.styleId = patch.styleId;
  if (patch.styleOverride === null) delete candidate.styleOverride;
  else if (patch.styleOverride !== undefined) candidate.styleOverride = patch.styleOverride;
  if (patch.occlusion === null) delete candidate.occlusion;
  else if (patch.occlusion !== undefined) candidate.occlusion = patch.occlusion;
  if (patch.locked === null) delete candidate.locked;
  else if (patch.locked !== undefined) candidate.locked = patch.locked;
  return normalizeAnnotation(candidate, limits);
}

function normalizeAnnotation(value: unknown, limits: DocumentLimits): Annotation {
  const input = objectValue(value, 'annotation');
  const id = stringValue(input.id, 'annotation id', 128);
  assertId(id, 'annotation id');
  const rawAnchors = arrayValue(input.anchors, `annotation ${id} anchors`);
  if (rawAnchors.length === 0 || rawAnchors.length > 32) {
    throw new InvalidDocumentError('Annotations require between 1 and 32 anchor legs', { id });
  }
  const normalizedLegs = rawAnchors.map((leg) => normalizeLeg(leg, limits));
  if (new Set(normalizedLegs.map(({ id: legId }) => legId)).size !== normalizedLegs.length) {
    throw new DuplicateIdError(`${id}/anchor-leg`);
  }
  const annotation: Mutable<Annotation> = {
    id,
    anchors: normalizedLegs,
    content: normalizeContent(input.content, limits),
    placement: normalizePlacement(input.placement),
    metadata: normalizeMetadata(input.metadata, limits, `annotation ${id} metadata`),
  };
  if (input.styleId !== undefined) annotation.styleId = stringValue(input.styleId, 'styleId', 128);
  if (input.styleOverride !== undefined) {
    annotation.styleOverride = normalizeJsonObject(input.styleOverride, limits, 'styleOverride');
  }
  if (input.occlusion !== undefined) {
    if (!['keep', 'fade', 'hide'].includes(String(input.occlusion))) {
      throw new InvalidDocumentError('Invalid occlusion policy', { id });
    }
    annotation.occlusion = input.occlusion as 'keep' | 'fade' | 'hide';
  }
  if (input.locked !== undefined) {
    if (typeof input.locked !== 'boolean') {
      throw new InvalidDocumentError('Annotation locked must be a boolean', { id });
    }
    // Not stored when false, because absent already means unlocked. Keeping both spellings would
    // let two identical drawings save as different files.
    if (input.locked) annotation.locked = true;
  }
  const residue = mergeResidue(
    carriedResidue(input.unknownFields, limits, `annotation ${id}`),
    residueOf(input, annotation, limits, `annotation ${id}`, ANNOTATION_KEYS),
  );
  if (residue !== undefined) annotation.unknownFields = residue;
  return annotation;
}

function normalizeLeg(value: unknown, limits: DocumentLimits): AnnotationLeg {
  const input = objectValue(value, 'annotation leg');
  return {
    id: stringValue(input.id, 'annotation leg id', 128),
    anchor: normalizeAnchor(input.anchor, limits),
    routing: normalizeRouting(input.routing),
  };
}

function normalizeAnchor(value: unknown, limits: DocumentLimits): Anchor {
  const input = objectValue(value, 'anchor');
  switch (input.kind) {
    case 'world-point':
      return { kind: 'world-point', point: vec3(input.point, 'world point') };
    case 'element':
      return {
        kind: 'element',
        modelId: stringValue(input.modelId, 'modelId', 256),
        elementId: stringValue(input.elementId, 'elementId', 256),
        fallbackPoint: vec3(input.fallbackPoint, 'fallback point'),
      };
    case 'region': {
      const plane = objectValue(input.plane, 'region plane');
      const vertices = arrayValue(input.vertices, 'region vertices');
      if (vertices.length < 3 || vertices.length > Math.min(10_000, limits.maxArrayLength)) {
        throw new InvalidDocumentError('Region anchors require between 3 and 10000 vertices');
      }
      const shape = input.shape;
      if (!['rectangle', 'ellipse', 'polygon', 'revision-cloud'].includes(String(shape))) {
        throw new InvalidDocumentError('Invalid region shape');
      }
      const region: Extract<Anchor, { kind: 'region' }> = {
        kind: 'region',
        ...(input.modelId === undefined
          ? {}
          : { modelId: stringValue(input.modelId, 'modelId', 256) }),
        plane: {
          origin: vec3(plane.origin, 'region plane origin'),
          normal: vec3(plane.normal, 'region plane normal'),
          xAxis: vec3(plane.xAxis, 'region plane x axis'),
        },
        vertices: vertices.map((vertex) => vec2(vertex, 'region vertex')),
        shape: shape as Extract<Anchor, { kind: 'region' }>['shape'],
        fallbackPoint: vec3(input.fallbackPoint, 'region fallback point'),
      };
      regionAnchorFromCore(region);
      return region;
    }
    default:
      throw unknownKind('anchor', input.kind);
  }
}

function normalizeContent(value: unknown, limits: DocumentLimits): AnnotationContent {
  const input = objectValue(value, 'content');
  const common = (): { direction?: 'auto' | 'ltr' | 'rtl'; maxWidth?: number } => {
    const result: { direction?: 'auto' | 'ltr' | 'rtl'; maxWidth?: number } = {};
    if (input.direction !== undefined) {
      if (!['auto', 'ltr', 'rtl'].includes(String(input.direction))) {
        throw new InvalidDocumentError('Invalid text direction');
      }
      result.direction = input.direction as 'auto' | 'ltr' | 'rtl';
    }
    if (input.maxWidth !== undefined) result.maxWidth = positiveNumber(input.maxWidth, 'maxWidth');
    return result;
  };
  const text = (key: string): string => stringValue(input[key], key, limits.maxTextLength);
  switch (input.kind) {
    case 'plain-note':
      return { kind: 'plain-note', text: text('text'), ...common() };
    // Always the text the author typed. A value looked up from the model is a cache for this
    // session only and is never written into the document.
    case 'tag':
      return {
        kind: 'tag',
        text: text('text'),
        ...(input.reference === undefined ? {} : { reference: tagReference(input.reference) }),
        ...common(),
      };
    case 'callout': {
      return {
        kind: 'callout',
        ...(input.title === undefined ? {} : { title: text('title') }),
        text: text('text'),
        ...common(),
      };
    }
    case 'split-callout':
      return { kind: 'split-callout', primary: text('primary'), secondary: text('secondary'), ...common() };
    case 'symbolic-block': {
      if (!['circle', 'square', 'diamond', 'hexagon'].includes(String(input.symbol))) {
        throw new InvalidDocumentError('Invalid symbolic block symbol');
      }
      return {
        kind: 'symbolic-block',
        symbol: input.symbol as 'circle' | 'square' | 'diamond' | 'hexagon',
        label: text('label'),
        ...common(),
      };
    }
    case 'host-image': {
      const content = {
        kind: 'host-image',
        reference: stringValue(input.reference, 'image reference', 2048),
        alt: stringValue(input.alt, 'image alt', limits.maxTextLength),
        ...(input.width === undefined ? {} : { width: positiveNumber(input.width, 'image width') }),
        ...(input.height === undefined ? {} : { height: positiveNumber(input.height, 'image height') }),
      } as const;
      validateHostImageContent(content);
      return content;
    }
    default: {
      if (typeof input.kind !== 'string' || !input.kind.startsWith('plugin:')) {
        throw unknownKind('content', input.kind);
      }
      const pluginId = stringValue(input.pluginId, 'pluginId', 128);
      if (input.kind !== `plugin:${pluginId}`) {
        throw new InvalidDocumentError('Plugin content kind and pluginId must match');
      }
      return {
        kind: input.kind as `plugin:${string}`,
        pluginId,
        schemaVersion: positiveInteger(input.schemaVersion, 'plugin schemaVersion'),
        data: normalizeJson(input.data, limits, 'plugin content data'),
      };
    }
  }
}

/**
 * Identifiers that only mean something to the host. Checked for length and for control characters,
 * because the three parts are later joined with one to form a lookup key — a stray one would let a
 * reference split into the wrong pieces.
 */
function tagReference(value: unknown): TagReference {
  const input = objectValue(value, 'tag reference');
  const field = (key: 'modelId' | 'elementId' | 'property'): string => {
    const result = stringValue(input[key], `tag reference ${key}`, 256);
    if (result.length === 0 || /[\u0000-\u001f]/u.test(result)) {
      throw new InvalidDocumentError(`tag reference ${key} must be a non-empty opaque identifier`);
    }
    return result;
  };
  return { modelId: field('modelId'), elementId: field('elementId'), property: field('property') };
}

function normalizePlacement(value: unknown): AnnotationPlacement {
  const input = objectValue(value, 'placement');
  if (input.kind === 'automatic') {
    return { kind: 'automatic' };
  }
  if (input.kind === 'manual') {
    return { kind: 'manual', position: vec2(input.position, 'manual placement position') };
  }
  throw unknownKind('placement', input.kind);
}

function normalizeRouting(value: unknown): AnnotationRouting {
  const input = objectValue(value, 'routing');
  if (input.kind === 'automatic') {
    if (!['straight', 'dogleg', 'orthogonal'].includes(String(input.mode))) {
      throw new InvalidDocumentError('Unknown automatic routing mode', { mode: input.mode });
    }
    return { kind: 'automatic', mode: input.mode as 'straight' | 'dogleg' | 'orthogonal' };
  }
  if (input.kind === 'manual') {
    const vertices = arrayValue(input.vertices, 'manual routing vertices');
    if (vertices.length > 1_000) throw new DocumentTooLargeError('Manual route has too many vertices');
    return { kind: 'manual', vertices: vertices.map((vertex) => vec2(vertex, 'route vertex')) };
  }
  throw unknownKind('routing', input.kind);
}

function normalizeDefinitions(value: unknown, limits: DocumentLimits): DefinitionCollections {
  const input = objectValue(value, 'definitions');
  return {
    styles: normalizeJsonObjectArray(input.styles, limits, 'definition styles'),
    templates: normalizeJsonObjectArray(input.templates, limits, 'definition templates'),
    terminators: normalizeJsonObjectArray(input.terminators, limits, 'definition terminators'),
    enclosures: normalizeJsonObjectArray(input.enclosures, limits, 'definition enclosures'),
  };
}

function normalizePluginEnvelope(value: unknown, limits: DocumentLimits): PluginEnvelope {
  const input = objectValue(value, 'plugin envelope');
  return {
    pluginId: stringValue(input.pluginId, 'pluginId', 128),
    recordType: stringValue(input.recordType, 'plugin recordType', 128),
    schemaVersion: positiveInteger(input.schemaVersion, 'plugin schemaVersion'),
    data: normalizeJson(input.data, limits, 'plugin envelope data'),
  };
}

function normalizeMetadata(value: unknown, limits: DocumentLimits, label: string): NamespacedMetadata {
  const input = objectValue(value, label);
  const entries = Object.entries(input);
  if (entries.length > limits.maxMetadataEntries) {
    throw new DocumentTooLargeError(`${label} has too many entries`, {
      count: entries.length,
      limit: limits.maxMetadataEntries,
    });
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of entries) {
    if (!/^[a-z][a-z0-9.-]*(?::|\/)[A-Za-z0-9._-]+$/u.test(key)) {
      throw new InvalidDocumentError(`${label} key must be namespaced`, { key });
    }
    result[key] = normalizeJson(item, limits, `${label}.${key}`);
  }
  return result;
}

function normalizeJsonObjectArray(
  value: unknown,
  limits: DocumentLimits,
  label: string,
): readonly JsonObject[] {
  const values = arrayValue(value, label);
  if (values.length > limits.maxArrayLength) {
    throw new DocumentTooLargeError(`${label} has too many entries`);
  }
  return values.map((item, index) => normalizeJsonObject(item, limits, `${label}[${index}]`));
}

function normalizeJsonObject(value: unknown, limits: DocumentLimits, label: string): JsonObject {
  const normalized = normalizeJson(value, limits, label);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new InvalidDocumentError(`${label} must be a JSON object`);
  }
  return normalized as JsonObject;
}

function normalizeJson(
  value: unknown,
  limits: DocumentLimits,
  label: string,
  depth = 0,
): JsonValue {
  if (depth > limits.maxJsonDepth) throw new DocumentTooLargeError(`${label} is too deeply nested`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidDocumentError(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) throw new DocumentTooLargeError(`${label} array is too large`);
    return value.map((item) => normalizeJson(item, limits, label, depth + 1));
  }
  const object = objectValue(value, label);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(object).sort()) {
    if (key.length > 256) throw new DocumentTooLargeError(`${label} contains an oversized key`);
    result[key] = normalizeJson(object[key], limits, `${label}.${key}`, depth + 1);
  }
  return result;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidDocumentError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidDocumentError(`${label} must be plain JSON data`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new InvalidDocumentError(`${label} must be an array`);
  return value;
}

function stringValue(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new InvalidDocumentError(`${label} must be a string no longer than ${maxLength} characters`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InvalidDocumentError(`${label} must be finite and positive`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new InvalidDocumentError(`${label} must be a positive integer`);
  }
  return value as number;
}

function vec2(value: unknown, label: string): { readonly x: number; readonly y: number } {
  const input = objectValue(value, label);
  return { x: finiteNumber(input.x, `${label}.x`), y: finiteNumber(input.y, `${label}.y`) };
}

/**
 * The rectangle the user drew to keep labels out of.
 *
 * Checked strictly, like everything else here. A rectangle with a broken edge would be divided by
 * during layout, and quietly discarding one instead would move every label on the drawing without
 * anyone being told why.
 */
function normalizeOrganizationRect(value: unknown, label: string): OrganizationRect {
  const input = objectValue(value, label);
  if (input.unit !== 'pixels' && input.unit !== 'fraction') {
    throw new InvalidDocumentError('Unknown organization rect unit', { unit: input.unit });
  }
  const rect = objectValue(input.rect, `${label}.rect`);
  return {
    unit: input.unit,
    rect: {
      x: finiteNumber(rect.x, `${label}.rect.x`),
      y: finiteNumber(rect.y, `${label}.rect.y`),
      width: finiteNumber(rect.width, `${label}.rect.width`),
      height: finiteNumber(rect.height, `${label}.rect.height`),
    },
  };
}

function vec3(value: unknown, label: string): { readonly x: number; readonly y: number; readonly z: number } {
  const input = objectValue(value, label);
  return {
    x: finiteNumber(input.x, `${label}.x`),
    y: finiteNumber(input.y, `${label}.y`),
    z: finiteNumber(input.z, `${label}.z`),
  };
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidDocumentError(`${label} must be finite`);
  }
  return value;
}

/**
 * An annotation of a type this version has never heard of came from a newer build, so it is set
 * aside and kept. One with no type at all is not from the future — it is simply broken, and stays
 * an ordinary validation failure.
 */
function unknownKind(label: string, kind: unknown): InvalidDocumentError {
  return new InvalidDocumentError(`Unknown ${label} kind`, {
    kind,
    ...(typeof kind === 'string' ? { unrecognized: true } : {}),
  });
}

/** The annotation fields this version knows about. Anything else came from a newer one. */
const ANNOTATION_KEYS: ReadonlySet<string> = new Set(['unknownFields']);

/**
 * Collects everything in a saved file that this version did not recognise, so it can be written
 * back out untouched.
 *
 * The result mirrors the shape of what came in, so a stray field deep inside an annotation is
 * remembered in the same place it was found:
 * `{ anchors: { '0': { anchor: { curvature: 2 } } }, content: { fontWeight: 700 } }`.
 *
 * `applyResidue` puts it all back and is the exact inverse of this.
 */
export function residueOf(
  input: unknown,
  output: unknown,
  limits: DocumentLimits | undefined,
  label: string,
  owned?: ReadonlySet<string>,
): JsonObject | undefined {
  if (Array.isArray(input)) {
    if (!Array.isArray(output) || !alignedArray(input, output)) return undefined;
    const items: Record<string, JsonValue> = {};
    input.forEach((item, index) => {
      const nested = residueOf(item, output[index], limits, `${label}[${index}]`);
      if (nested !== undefined) items[String(index)] = nested;
    });
    return Object.keys(items).length === 0 ? undefined : items;
  }
  if (!isPlainObject(input) || !isPlainObject(output)) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (owned?.has(key) === true) continue;
    if (!Object.hasOwn(output, key)) {
      result[key] = limits === undefined
        ? value as JsonValue
        : normalizeJson(value, limits, `${label}.${key}`);
      continue;
    }
    const nested = residueOf(value, output[key], limits, `${label}.${key}`);
    if (nested !== undefined) result[key] = nested;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * Unrecognised fields are tracked by position, so a list that got re-ordered on the way in would
 * attach one record's data to another. This checks the list is still in the same order and gives up
 * on it if not.
 *
 * ponytail: a re-ordered list loses its unknown fields rather than misplacing them. Losing a field
 * is recoverable; silently moving one onto somebody else's record is not. Match on each entry's id
 * if a re-ordered list ever needs to carry them.
 */
function alignedArray(input: readonly unknown[], output: readonly unknown[]): boolean {
  if (input.length !== output.length) return false;
  return input.every((item, index) => {
    const counterpart = output[index];
    if (!isPlainObject(item) || !isPlainObject(counterpart)) return true;
    return Object.entries(counterpart).every(([key, value]) =>
      value === null || typeof value === 'object' || !Object.hasOwn(item, key)
        ? true
        : item[key] === value);
  });
}

/** Splices preserved fields back into the shape they came from. Known values always win. */
export function applyResidue(value: unknown, residue: unknown): unknown {
  if (!isPlainObject(residue)) return value;
  if (Array.isArray(value)) {
    const items = [...value];
    for (const [key, item] of Object.entries(residue)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < items.length) {
        items[index] = applyResidue(items[index], item);
      }
    }
    return items;
  }
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = { ...value };
  for (const [key, item] of Object.entries(residue)) {
    result[key] = Object.hasOwn(value, key) ? applyResidue(result[key], item) : item;
  }
  return result;
}

/** Residue already extracted by an earlier pass, so re-normalizing in memory does not re-wrap it. */
function carriedResidue(
  value: unknown,
  limits: DocumentLimits,
  label: string,
): JsonObject | undefined {
  return value === undefined
    ? undefined
    : normalizeJsonObject(value, limits, `${label} unknownFields`);
}

function mergeResidue(
  base: JsonObject | undefined,
  extra: JsonObject | undefined,
): JsonObject | undefined {
  if (base === undefined) return extra;
  if (extra === undefined) return base;
  const result: Record<string, JsonValue> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = result[key];
    result[key] = isJsonObject(current) && isJsonObject(value)
      ? mergeResidue(current, value) as JsonValue
      : value;
  }
  return result;
}

/** Forgets what was preserved under a value the caller just replaced, so stale data cannot ride. */
function dropResidue(
  residue: JsonObject | undefined,
  path: readonly string[],
): JsonObject | undefined {
  const [head, ...tail] = path;
  if (residue === undefined || head === undefined || !Object.hasOwn(residue, head)) return residue;
  const child = residue[head];
  const replacement = tail.length === 0 || !isJsonObject(child)
    ? undefined
    : dropResidue(child, tail);
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(residue)) {
    if (key !== head) result[key] = value;
  }
  if (replacement !== undefined) result[head] = replacement;
  return Object.keys(result).length === 0 ? undefined : result;
}

/** The on-disk shape: preserved fields spliced back in, quarantined annotations restored in order. */
function expandDocument(document: ViewLeaderDocument): unknown {
  const { unknownFields, quarantined, ...rest } = document;
  const annotations = [
    ...document.annotations.map(expandAnnotation),
    ...quarantined ?? [],
  ].sort((first, second) => annotationKey(first).localeCompare(annotationKey(second)));
  return applyResidue({ ...rest, annotations }, unknownFields);
}

function expandAnnotation(annotation: Annotation): unknown {
  const { unknownFields, ...rest } = annotation;
  return applyResidue(rest, unknownFields);
}

function annotationKey(value: unknown): string {
  return isPlainObject(value) && typeof value.id === 'string' ? value.id : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Duck-typed rather than `instanceof Promise`: a host may hand back any thenable — a library's own
 * promise, a jQuery deferred — and every one of them splits the transaction the same way.
 */
function isThenable(value: unknown): boolean {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

function assertId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new InvalidDocumentError(`${label} has an invalid format`, { value });
  }
}

function assertLabel(label: string): void {
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > 256) {
    throw new InvalidInputError('Transaction labels must contain 1 to 256 characters');
  }
}

function envelopeKey(envelope: PluginEnvelope): string {
  return `${envelope.pluginId}\u0000${envelope.recordType}\u0000${envelope.schemaVersion}`;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = sortJson(item);
    }
    return result;
  }
  return value;
}

function freezeDocument(document: ViewLeaderDocument): ViewLeaderDocument {
  return deepFreeze(document);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function emptyDefinitions(): DefinitionCollections {
  return { styles: [], templates: [], terminators: [], enclosures: [] };
}

function resolveLimits(overrides: Partial<DocumentLimits>): DocumentLimits {
  const result = { ...DEFAULT_DOCUMENT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new InvalidInputError(`Document limit ${key} must be a positive integer`, { [key]: value });
    }
  }
  if (result.maxAnnotations < 5_000 && overrides.maxAnnotations === undefined) {
    throw new InvalidInputError('The shipped annotation limit must support at least 5000 annotations');
  }
  return Object.freeze(result);
}

function isResolvedLimits(value: Partial<DocumentLimits> | DocumentLimits): value is DocumentLimits {
  return Object.keys(DEFAULT_DOCUMENT_LIMITS).every((key) => key in value);
}

function assertByteLimit(source: string, limits: DocumentLimits): void {
  const bytes = new TextEncoder().encode(source).byteLength;
  if (bytes > limits.maxBytes) {
    throw new DocumentTooLargeError('Document exceeds the configured byte limit', {
      bytes,
      limit: limits.maxBytes,
    });
  }
}
