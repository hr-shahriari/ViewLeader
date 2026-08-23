// Saved views and tours: named camera positions a user can jump back to, and ordered sequences of
// them to walk through.
//
// A saved view stores more than a camera. It also records which elements were hidden, what was
// recoloured, and how individual annotations were overridden, so returning to a view genuinely
// restores what you were looking at rather than just where you stood.
import { InvalidConfigurationError, InvalidDocumentError } from './errors.js';
import type { Diagnostic } from './host.js';
import { DocumentEngine, applyResidue, residueOf } from './document.js';
import type {
  JsonObject,
  SnapshotCapability,
  ViewLeaderDocument,
} from './types.js';
import type { ViewLeaderRuntime } from './runtime.js';
import {
  SavedViewCoordinator,
  type CaptureNeutralSavedViewInput,
  type UpdateSavedViewInput,
} from './saved-views/coordinator.js';
import type {
  LinearTourDefinition,
  MutableSavedViewDocument,
  SavedViewDefinition,
  SavedViewDocumentPort,
  SavedViewRemovalReferences,
  SavedViewsRuntimeSnapshot,
  TourPlaybackOutcome,
  ViewActivationOutcome,
  ViewerStateAdapter,
} from './saved-views/neutral-types.js';
import {
  normalizeLinearTourDefinition,
  normalizeSavedViewDefinition,
} from './saved-views/neutral-validation.js';

export interface ViewsCapability
  extends SnapshotCapability<SavedViewsRuntimeSnapshot> {
  get(id: string): SavedViewDefinition | undefined;
  list(): readonly SavedViewDefinition[];
  insert(definition: SavedViewDefinition): SavedViewDefinition;
  save(input: CaptureNeutralSavedViewInput): Promise<SavedViewDefinition>;
  update(
    id: string,
    input?: UpdateSavedViewInput,
  ): Promise<SavedViewDefinition>;
  inspectRemoval(id: string): SavedViewRemovalReferences;
  remove(
    id: string,
    options?: { readonly cascade?: boolean },
  ): Promise<SavedViewDefinition>;
  createTour(definition: LinearTourDefinition): LinearTourDefinition;
  updateTour(definition: LinearTourDefinition): LinearTourDefinition;
  removeTour(id: string): LinearTourDefinition;
  activate(
    id: string,
    options?: { readonly transitionDurationMs?: number },
  ): Promise<ViewActivationOutcome>;
  cancelActivation(reason?: string): void;
  playTour(
    id: string,
    options?: { readonly startIndex?: number },
  ): Promise<TourPlaybackOutcome>;
  pauseTour(): void;
  seekTour(id: string, stepIndex: number): Promise<ViewActivationOutcome>;
  cancelTour(reason?: string): void;
}

export interface CreateViewsCapabilityOptions {
  readonly document: DocumentEngine;
  readonly runtime: ViewLeaderRuntime;
  readonly viewerState?: ViewerStateAdapter;
  readonly assertActive: () => void;
}

export interface CreatedViewsCapability {
  readonly capability: ViewsCapability;
  dispose(): void;
}

/**
 * Checks and tidies the saved views in a document before it is allowed to load.
 *
 * Deliberately done before the document is accepted, not after. A tour pointing at a view that does
 * not exist has to stop the whole load, so the user is told their file is broken rather than
 * finding a tour that silently skips a step.
 */
export function prepareViewsDocument(
  document: ViewLeaderDocument,
): ViewLeaderDocument {
  try {
    const viewResidue = residueByIdOf(document.savedViews, decodeSavedView, 'saved view');
    const tourResidue = residueByIdOf(document.tours, decodeTour, 'tour');
    const savedViews = document.savedViews
      .map(decodeSavedView)
      .sort(compareDefinitions);
    assertUniqueDefinitionIds(savedViews, 'saved view');
    const viewIds = new Set(savedViews.map(({ id }) => id));
    const tours = document.tours
      .map(decodeTour)
      .sort(compareDefinitions);
    assertUniqueDefinitionIds(tours, 'tour');
    for (const tour of tours) {
      const missingViewIds = [
        ...new Set(
          tour.steps
            .map(({ viewId }) => viewId)
            .filter((viewId) => !viewIds.has(viewId)),
        ),
      ].sort();
      if (missingViewIds.length > 0) {
        throw new TypeError(
          `Tour "${tour.id}" references missing saved views: ${missingViewIds.join(', ')}`,
        );
      }
    }
    return {
      ...document,
      savedViews: savedViews.map((view) => encodeJsonObject(view, viewResidue)),
      tours: tours.map((tour) => encodeJsonObject(tour, tourResidue)),
    };
  } catch (cause) {
    throw new InvalidDocumentError(
      'Saved views and tours failed validation',
      {},
      { cause },
    );
  }
}

/**
 * Wires the saved-view machinery up to this ViewLeader's document and viewer, and exposes it as the
 * `views` capability a host uses.
 */
export function createViewsCapability(
  options: CreateViewsCapabilityOptions,
): CreatedViewsCapability {
  const documentPort = new CanonicalViewsDocumentPort(options.document);
  const viewerState = options.viewerState ?? unavailableViewerState;
  const coordinator = new SavedViewCoordinator({
    document: documentPort,
    viewerState,
    annotationViews: {
      capture: () => options.runtime.captureAnnotationView(),
      apply: (viewId, overrides) => {
        // Only announced once everything has succeeded: the viewer state restored, the annotation
        // overrides applied, and no cancellation in between. A half-applied view is never
        // published as the current one.
        options.runtime.applyAnnotationView(viewId, overrides, false);
      },
      rollback: (snapshot) => {
        options.runtime.applyAnnotationView(snapshot.activeViewId, snapshot.overrides, false);
      },
    },
    // Activating a view can change annotation overrides without moving the camera at all. The
    // overlay has to be marked as needing a redraw explicitly, or the "nothing moved, skip this
    // frame" optimisation would skip the frame that was supposed to show the change.
    onChange: () => options.runtime.publishTransientChange(true),
    diagnostic: (event) => {
      const diagnostic: Diagnostic = {
        code: event.code,
        severity: event.severity,
        message: event.message,
      };
      options.runtime.publishExternalDiagnostic(diagnostic);
    },
  });
  const active = <Result>(operation: () => Result): Result => {
    options.assertActive();
    return operation();
  };
  const snapshot = (): SavedViewsRuntimeSnapshot => {
    options.assertActive();
    const current = coordinator.getSnapshot();
    return Object.freeze({
      ...current,
      runtimeRevision: options.runtime.runtimeRevision,
      documentRevision: options.document.documentRevision,
    });
  };
  const capability: ViewsCapability = Object.freeze({
    getSnapshot: snapshot,
    subscribe: (listener: () => void) =>
      active(() => options.runtime.subscribe(listener)),
    get: (id: string) => active(() => coordinator.get(id)),
    list: () => active(() => coordinator.list()),
    insert: (definition: SavedViewDefinition) =>
      active(() => coordinator.insert(definition)),
    save: (input: CaptureNeutralSavedViewInput) =>
      active(() => coordinator.save(input)),
    update: (id: string, input: UpdateSavedViewInput = {}) =>
      active(() => coordinator.update(id, input)),
    inspectRemoval: (id: string) =>
      active(() => coordinator.inspectRemoval(id)),
    remove: (id: string, removeOptions = {}) =>
      active(() => coordinator.remove(id, removeOptions)),
    createTour: (definition: LinearTourDefinition) =>
      active(() => coordinator.createTour(definition)),
    updateTour: (definition: LinearTourDefinition) =>
      active(() => coordinator.updateTour(definition)),
    removeTour: (id: string) => active(() => coordinator.removeTour(id)),
    activate: (id: string, activationOptions = {}) =>
      active(() => coordinator.activate(id, activationOptions)),
    cancelActivation: (reason?: string) =>
      active(() => coordinator.cancelActivation(reason)),
    playTour: (id: string, playOptions = {}) =>
      active(() => coordinator.playTour(id, playOptions)),
    pauseTour: () => active(() => coordinator.pauseTour()),
    seekTour: (id: string, stepIndex: number) =>
      active(() => coordinator.seekTour(id, stepIndex)),
    cancelTour: (reason?: string) => active(() => coordinator.cancelTour(reason)),
  });
  return Object.freeze({
    capability,
    dispose: () => coordinator.dispose(),
  });
}

class CanonicalViewsDocumentPort implements SavedViewDocumentPort {
  readonly #document: DocumentEngine;

  public constructor(document: DocumentEngine) {
    this.#document = document;
  }

  public getSnapshot() {
    return Object.freeze({
      documentRevision: this.#document.documentRevision,
      savedViews: Object.freeze(
        this.#document.document.savedViews.map(decodeSavedView),
      ),
      tours: Object.freeze(this.#document.document.tours.map(decodeTour)),
    });
  }

  public subscribe(listener: () => void): () => void {
    return this.#document.subscribe(() => listener());
  }

  public transact<Result>(
    label: string,
    operation: (draft: MutableSavedViewDocument) => Result,
  ): Result {
    return this.#document.edit(label, (document) => {
      // Fields written by a newer version are set aside before the edit and restored afterwards,
      // matched by view id. Without that, editing one saved view would silently strip newer data
      // from every other saved view in the file.
      const viewResidue = residueByIdOf(document.savedViews, decodeSavedView, 'saved view');
      const tourResidue = residueByIdOf(document.tours, decodeTour, 'tour');
      const draft: MutableSavedViewDocument = {
        savedViews: document.savedViews.map(decodeSavedView),
        tours: document.tours.map(decodeTour),
      };
      const result = operation(draft);
      const savedViews = draft.savedViews.map((view) => normalizeSavedViewDefinition(view));
      const viewIds = new Set(savedViews.map(({ id }) => id));
      const tours = draft.tours.map((tour) =>
        normalizeLinearTourDefinition(tour, { allowEmpty: true }),
      );
      for (const tour of tours) {
        const missing = tour.steps
          .map(({ viewId }) => viewId)
          .filter((viewId) => !viewIds.has(viewId));
        if (missing.length > 0) {
          throw new TypeError(
            `Tour "${tour.id}" references missing views: ${[
              ...new Set(missing),
            ].sort().join(', ')}`,
          );
        }
      }
      return {
        document: {
          ...document,
          savedViews: savedViews.map((view) => encodeJsonObject(view, viewResidue)),
          tours: tours.map((tour) => encodeJsonObject(tour, tourResidue)),
        },
        result,
      };
    });
  }
}

const unavailableViewerState: ViewerStateAdapter<never> = {
  capture: () => unavailable(),
  prepare: () => unavailable(),
  apply: () => unavailable(),
  rollback: () => unavailable(),
};

function unavailable(): never {
  throw new InvalidConfigurationError(
    'The host adapter bundle does not provide transactional viewer state',
  );
}

/**
 * The forgiving path, used when opening a file. A saved view written by a newer version is reported
 * and skipped rather than bringing down the whole document.
 *
 * Creating or editing a view goes through the same checks without this leniency, because there a
 * problem is the user's own input and should be refused immediately.
 */
function decodeSavedView(value: JsonObject): SavedViewDefinition {
  return normalizeSavedViewDefinition(
    structuredClone(value) as unknown as SavedViewDefinition,
    [],
  );
}

function decodeTour(value: JsonObject): LinearTourDefinition {
  return normalizeLinearTourDefinition(
    structuredClone(value) as unknown as LinearTourDefinition,
    { allowEmpty: true },
    [],
  );
}

/**
 * Collects the fields this build does not understand, so they can be written back out unchanged.
 *
 * A saved view is rebuilt field by field rather than copied wholesale, so anything unrecognised
 * would otherwise be dropped. Tracked by view id rather than by position, so adding or deleting a
 * view cannot attach one view's leftover data to another.
 */
function residueByIdOf(
  values: readonly JsonObject[],
  decode: (value: JsonObject) => { readonly id: string },
  label: string,
): ReadonlyMap<string, JsonObject> {
  const residue = new Map<string, JsonObject>();
  for (const value of values) {
    const decoded = decode(value);
    const extra = residueOf(value, decoded, undefined, `${label} ${decoded.id}`);
    if (extra !== undefined) residue.set(decoded.id, extra);
  }
  return residue;
}

function encodeJsonObject(
  value: SavedViewDefinition | LinearTourDefinition,
  residue?: ReadonlyMap<string, JsonObject>,
): JsonObject {
  const encoded = structuredClone(value) as unknown as JsonObject;
  const extra = residue?.get(value.id);
  return extra === undefined ? encoded : applyResidue(encoded, extra) as JsonObject;
}

function compareDefinitions(
  left: SavedViewDefinition | LinearTourDefinition,
  right: SavedViewDefinition | LinearTourDefinition,
): number {
  return left.id.localeCompare(right.id);
}

function assertUniqueDefinitionIds(
  definitions: readonly (SavedViewDefinition | LinearTourDefinition)[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.id)) {
      throw new TypeError(`Duplicate ${label} id: ${definition.id}`);
    }
    seen.add(definition.id);
  }
}
