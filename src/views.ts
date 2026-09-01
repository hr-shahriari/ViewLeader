// Saved views and tours: named camera positions a user can jump back to, and ordered sequences of
// them to walk through.
//
// A saved view stores more than a camera. It also records which elements were hidden, what was
// recoloured, and how individual annotations were overridden, so returning to a view genuinely
// restores what you were looking at rather than just where you stood.
import { domainError, InvalidDocumentError } from './errors.js';
import type { Diagnostic } from './host.js';
import { DocumentEngine, applyResidue, residueOf } from './document.js';
import type { JsonObject, ViewLeaderDocument } from './types.js';
import type { ViewLeaderRuntime } from './runtime.js';
import { SavedViewCoordinator } from './saved-views/coordinator.js';
import type {
  LinearTourDefinition,
  MutableSavedViewDocument,
  SavedViewDefinition,
  SavedViewDocumentPort,
  ViewerStateAdapter,
} from './saved-views/neutral-types.js';
import {
  normalizeLinearTourDefinition,
  normalizeSavedViewDefinition,
} from './saved-views/neutral-validation.js';

/** The `views` capability is the coordinator itself. Disposal belongs to `ViewLeader`. */
export type ViewsCapability = Omit<SavedViewCoordinator, 'dispose'>;

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
    const savedViews = document.savedViews.map(decodeSavedView).sort(byId);
    const tours = document.tours.map(decodeTour).sort(byId);
    assertUniqueIds(savedViews, 'saved view');
    assertUniqueIds(tours, 'tour');
    const viewIds = new Set(savedViews.map(({ id }) => id));
    for (const tour of tours) {
      const missing = [...new Set(
        tour.steps.map(({ viewId }) => viewId).filter((viewId) => !viewIds.has(viewId)),
      )].sort();
      if (missing.length > 0) {
        throw new TypeError(
          `Tour "${tour.id}" references missing saved views: ${missing.join(', ')}`,
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

/** Wires the saved-view coordinator up to this ViewLeader's document and viewer. */
export function createViewsCapability(options: {
  readonly document: DocumentEngine;
  readonly runtime: ViewLeaderRuntime;
  readonly viewerState?: ViewerStateAdapter;
}) {
  return new SavedViewCoordinator({
    document: new CanonicalViewsDocumentPort(options.document),
    viewerState: options.viewerState ?? unavailableViewerState,
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
      return {
        document: {
          ...document,
          savedViews: draft.savedViews.map((view) => encodeJsonObject(view, viewResidue)),
          tours: draft.tours.map((tour) => encodeJsonObject(tour, tourResidue)),
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
  throw domainError('INVALID_CONFIGURATION', 
    'The host adapter bundle does not provide transactional viewer state',
  );
}

/**
 * The one place a saved view is parsed out of JSON. Anything the normalizer does not rebuild is
 * kept beside it as residue, so a file from a newer version survives a round trip untouched.
 */
function decodeSavedView(value: JsonObject): SavedViewDefinition {
  return normalizeSavedViewDefinition(structuredClone(value) as unknown as SavedViewDefinition);
}

function decodeTour(value: JsonObject): LinearTourDefinition {
  return normalizeLinearTourDefinition(
    structuredClone(value) as unknown as LinearTourDefinition,
    { allowEmpty: true },
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

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}

function assertUniqueIds(definitions: readonly { readonly id: string }[], label: string): void {
  const ids = definitions.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new TypeError(`Duplicate ${label} id`);
}
