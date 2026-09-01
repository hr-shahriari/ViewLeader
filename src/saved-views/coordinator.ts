import type {
  AnnotationViewAdapter,
  LinearTourDefinition,
  SavedViewAnnotationOverrides,
  SavedViewDefinition,
  SavedViewDiagnostic,
  SavedViewDocumentPort,
  SavedViewRemovalReferences,
  SavedViewScheduler,
  SavedViewsRuntimeSnapshot,
  TourPlaybackOutcome,
  ViewActivationOutcome,
  ViewerStateAdapter,
  ViewerStateOperationContext,
} from './neutral-types.js';
import { SavedViewError } from './neutral-types.js';
import { deepFreeze } from '../internal/freeze.js';
import {
  normalizeLinearTourDefinition,
  normalizeSavedViewDefinition,
} from './neutral-validation.js';

interface SavedViewCoordinatorOptions<Prepared, AnnotationSnapshot> {
  readonly document: SavedViewDocumentPort;
  readonly viewerState: ViewerStateAdapter<Prepared>;
  readonly annotationViews: AnnotationViewAdapter<AnnotationSnapshot>;
  readonly scheduler?: SavedViewScheduler;
  readonly diagnostic?: (diagnostic: SavedViewDiagnostic) => void;
  readonly onChange?: () => void;
}

export interface CaptureNeutralSavedViewInput {
  readonly id: string;
  readonly name: string;
  readonly annotationOverrides?: SavedViewAnnotationOverrides;
}

export interface UpdateSavedViewInput {
  readonly name?: string;
  readonly annotationOverrides?: SavedViewAnnotationOverrides;
  readonly captureViewerState?: boolean;
}

interface ActivationOperation {
  readonly controller: AbortController;
  readonly viewId: string;
  readonly definitionFingerprint: string;
}

interface PlaybackOperation {
  readonly controller: AbortController;
  readonly tourId: string;
  readonly tourFingerprint: string;
}

interface ActiveRollback<Prepared, AnnotationSnapshot> {
  readonly prepared: Prepared;
  readonly annotationSnapshot: AnnotationSnapshot;
  readonly previousActiveViewId?: string;
  previous: ActiveRollback<Prepared, AnnotationSnapshot> | undefined;
}

const idleActivation = Object.freeze({ status: 'idle' as const });
const idlePlayback = Object.freeze({ status: 'idle' as const });
const MAX_ACTIVE_ROLLBACK_DEPTH = 64;

/**
 * Runs saved views: creating and editing them, jumping to one, and playing a tour through several.
 *
 * The division that matters here is between what is saved and what is not. Adding or editing a view
 * changes the document, so it undoes and it saves. *Going* to a view does not — where you happen to
 * be looking is not part of the drawing, any more than the camera is.
 *
 * Restoring is reversible throughout: a view that cannot be fully restored puts the model back the
 * way it was rather than leaving it half-changed.
 */
export class SavedViewCoordinator<Prepared = unknown, AnnotationSnapshot = unknown> {
  readonly #document: SavedViewDocumentPort;
  readonly #viewerState: ViewerStateAdapter<Prepared>;
  readonly #annotationViews: AnnotationViewAdapter<AnnotationSnapshot>;
  readonly #scheduler: SavedViewScheduler;
  readonly #diagnostic: ((diagnostic: SavedViewDiagnostic) => void) | undefined;
  readonly #onChange: (() => void) | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Set<AbortController>();
  readonly #unsubscribeDocument: (() => void) | undefined;
  #runtimeRevision = 0;
  #snapshot: SavedViewsRuntimeSnapshot;
  #activeViewId: string | undefined;
  #activation: SavedViewsRuntimeSnapshot['activation'] = idleActivation;
  #playback: SavedViewsRuntimeSnapshot['playback'] = idlePlayback;
  #activationOperation: ActivationOperation | undefined;
  #playbackOperation: PlaybackOperation | undefined;
  #activeRollback: ActiveRollback<Prepared, AnnotationSnapshot> | undefined;
  #activeReconciliation: Promise<void> | undefined;
  #consistent = true;
  #disposed = false;

  public constructor(
    options: SavedViewCoordinatorOptions<Prepared, AnnotationSnapshot>,
  ) {
    this.#document = options.document;
    this.#viewerState = options.viewerState;
    this.#annotationViews = options.annotationViews;
    this.#scheduler = options.scheduler ?? timeoutScheduler;
    this.#diagnostic = options.diagnostic;
    this.#onChange = options.onChange;
    this.#snapshot = this.#createSnapshot();
    this.#unsubscribeDocument = this.#document.subscribe?.(() => {
      this.#documentChanged();
    });
  }

  public getSnapshot(): SavedViewsRuntimeSnapshot {
    return this.#snapshot;
  }

  public subscribe(listener: () => void): () => void {
    this.#assertUsable();
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  }

  public get(viewId: string): SavedViewDefinition | undefined {
    this.#assertUsable();
    const view = this.#findView(viewId);
    return view === undefined
      ? undefined
      : (freezeSavedView(view) as SavedViewDefinition);
  }

  public list(): readonly SavedViewDefinition[] {
    this.#assertUsable();
    return this.#snapshot.savedViews;
  }

  public insert(definition: SavedViewDefinition): SavedViewDefinition {
    this.#assertCoordinated();
    const normalized = normalizeSavedViewDefinition(definition);
    if (this.#findView(normalized.id) !== undefined) {
      throw new SavedViewError(
        'saved_view/already_exists',
        `Saved view "${normalized.id}" already exists`,
        { viewId: normalized.id },
      );
    }
    return this.#commit(`Save view ${normalized.id}`, (draft) => {
      draft.savedViews.push(structuredClone(normalized));
      sortDefinitions(draft.savedViews);
      return freezeSavedView(normalized) as SavedViewDefinition;
    });
  }

  public async save(
    input: CaptureNeutralSavedViewInput,
  ): Promise<SavedViewDefinition> {
    this.#assertCoordinated();
    if (this.#findView(input.id) !== undefined) {
      throw new SavedViewError(
        'saved_view/already_exists',
        `Saved view "${input.id}" already exists`,
        { viewId: input.id },
      );
    }
    const viewerState = await this.#captureViewerState();
    this.#assertCoordinated();
    return this.insert({
      id: input.id,
      name: input.name,
      viewerState,
      annotationOverrides: input.annotationOverrides ?? {},
    });
  }

  public async update(
    viewId: string,
    input: UpdateSavedViewInput = {},
  ): Promise<SavedViewDefinition> {
    this.#assertCoordinated();
    const existing = this.#requireView(viewId);
    const viewerState = input.captureViewerState === false
      ? existing.viewerState
      : await this.#captureViewerState();
    this.#assertCoordinated();
    const normalized = normalizeSavedViewDefinition({
      ...existing,
      ...(input.name === undefined ? {} : { name: input.name }),
      viewerState,
      ...(input.annotationOverrides === undefined
        ? {}
        : { annotationOverrides: input.annotationOverrides }),
    });
    return this.#commit(`Update view ${viewId}`, (draft) => {
      const index = draft.savedViews.findIndex((view) => view.id === viewId);
      if (index < 0) this.#notFound(viewId);
      draft.savedViews[index] = structuredClone(normalized);
      return freezeSavedView(normalized) as SavedViewDefinition;
    });
  }

  public inspectRemoval(viewId: string): SavedViewRemovalReferences {
    this.#assertUsable();
    const view = this.#requireView(viewId);
    const tourSteps = this.#document
      .getSnapshot()
      .tours.flatMap((tour) =>
        tour.steps.flatMap((step, stepIndex) =>
          step.viewId === viewId ? [{ tourId: tour.id, stepIndex }] : [],
        ),
      );
    return freezeSavedView({
      viewId,
      active: this.#activeViewId === viewId,
      annotationOverrideIds: Object.keys(view.annotationOverrides).sort(),
      tourSteps,
    }) as SavedViewRemovalReferences;
  }

  public async remove(
    viewId: string,
    options: { readonly cascade?: boolean } = {},
  ): Promise<SavedViewDefinition> {
    this.#assertCoordinated();
    const definition = this.#requireView(viewId);
    const references = this.inspectRemoval(viewId);
    const referenced =
      references.active ||
      references.annotationOverrideIds.length > 0 ||
      references.tourSteps.length > 0;
    if (referenced && options.cascade !== true) {
      throw new SavedViewError(
        'saved_view/referenced',
        `Saved view "${viewId}" is still referenced`,
        { references },
      );
    }

    this.cancelTour('view-removed');
    this.cancelActivation('view-removed');
    if (references.active) await this.#deactivateActive();
    this.#assertCoordinated();

    return this.#commit(`Remove view ${viewId}`, (draft) => {
      draft.savedViews = draft.savedViews.filter((view) => view.id !== viewId);
      draft.tours = draft.tours.map((tour) => ({
        ...tour,
        steps: tour.steps.filter((step) => step.viewId !== viewId),
      }));
      return freezeSavedView(definition) as SavedViewDefinition;
    });
  }

  public createTour(definition: LinearTourDefinition): LinearTourDefinition {
    this.#assertCoordinated();
    const normalized = normalizeLinearTourDefinition(definition);
    this.#assertTourReferences(normalized);
    if (this.#findTour(normalized.id) !== undefined) {
      throw new SavedViewError(
        'tour/invalid_definition',
        `Tour "${normalized.id}" already exists`,
        { tourId: normalized.id },
      );
    }
    return this.#commit(`Create tour ${normalized.id}`, (draft) => {
      draft.tours.push(structuredClone(normalized));
      sortDefinitions(draft.tours);
      return freezeSavedView(normalized) as LinearTourDefinition;
    });
  }

  public updateTour(definition: LinearTourDefinition): LinearTourDefinition {
    this.#assertCoordinated();
    const normalized = normalizeLinearTourDefinition(definition);
    this.#assertTourReferences(normalized);
    if (this.#findTour(normalized.id) === undefined) this.#tourNotFound(normalized.id);
    this.cancelTour('tour-changed');
    return this.#commit(`Update tour ${normalized.id}`, (draft) => {
      const index = draft.tours.findIndex((tour) => tour.id === normalized.id);
      if (index < 0) this.#tourNotFound(normalized.id);
      draft.tours[index] = structuredClone(normalized);
      return freezeSavedView(normalized) as LinearTourDefinition;
    });
  }

  public removeTour(tourId: string): LinearTourDefinition {
    this.#assertCoordinated();
    const tour = this.#requireTour(tourId);
    if (this.#playbackOperation?.tourId === tourId) this.cancelTour('tour-removed');
    return this.#commit(`Remove tour ${tourId}`, (draft) => {
      draft.tours = draft.tours.filter((candidate) => candidate.id !== tourId);
      return freezeSavedView(tour) as LinearTourDefinition;
    });
  }

  public async activate(
    viewId: string,
    options: { readonly transitionDurationMs?: number } = {},
  ): Promise<ViewActivationOutcome> {
    this.cancelTour('direct-activation');
    return this.#activate(viewId, options.transitionDurationMs ?? 0);
  }

  public cancelActivation(reason = 'cancelled'): void {
    this.#activationOperation?.controller.abort(reason);
  }

  public async playTour(
    tourId: string,
    options: { readonly startIndex?: number } = {},
  ): Promise<TourPlaybackOutcome> {
    this.#assertCoordinated();
    const tour = this.#requireTour(tourId);
    const startIndex = options.startIndex ?? 0;
    this.#assertStepIndex(tour, startIndex);
    this.cancelTour('restarted');

    const operation: PlaybackOperation = {
      controller: new AbortController(),
      tourId,
      tourFingerprint: fingerprint(tour),
    };
    this.#playbackOperation = operation;
    this.#playback = { status: 'playing', tourId, stepIndex: startIndex };
    this.#publish();

    let stepIndex = startIndex;
    try {
      for (; stepIndex < tour.steps.length; stepIndex += 1) {
        if (!this.#isCurrentPlayback(operation)) break;
        const current = this.#requireTour(tourId);
        if (fingerprint(current) !== operation.tourFingerprint) {
          operation.controller.abort('tour-changed');
          break;
        }
        const step = current.steps[stepIndex];
        if (step === undefined) break;
        this.#playback = { status: 'playing', tourId, stepIndex };
        this.#publish();

        const activation = await this.#activate(
          step.viewId,
          step.transitionDurationMs,
          operation.controller.signal,
        );
        if (activation.status === 'cancelled') break;
        await this.#scheduler.delay(
          step.dwellDurationMs,
          operation.controller.signal,
        );
      }
    } catch (error) {
      if (!operation.controller.signal.aborted) throw error;
    }

    const paused =
      this.#playback.status === 'paused' &&
      this.#playback.tourId === tourId;
    const reason = abortReason(operation.controller.signal);
    if (this.#isCurrentPlayback(operation)) {
      this.#playbackOperation = undefined;
      if (!paused) this.#playback = idlePlayback;
      this.#publish();
    }
    if (paused) {
      return { status: 'paused', tourId, stepIndex, reason };
    }
    if (operation.controller.signal.aborted || stepIndex < tour.steps.length) {
      return { status: 'cancelled', tourId, stepIndex, reason };
    }
    return { status: 'completed', tourId };
  }

  public pauseTour(): void {
    this.#assertCoordinated();
    const playback = this.#playback;
    if (playback.status !== 'playing') return;
    this.#playback = {
      status: 'paused',
      tourId: playback.tourId,
      stepIndex: playback.stepIndex,
    };
    this.#playbackOperation?.controller.abort('paused');
    this.#publish();
  }

  public async seekTour(
    tourId: string,
    stepIndex: number,
  ): Promise<ViewActivationOutcome> {
    this.#assertCoordinated();
    const tour = this.#requireTour(tourId);
    this.#assertStepIndex(tour, stepIndex);
    this.cancelTour('seek');
    const step = tour.steps[stepIndex];
    if (step === undefined) this.#tourNotFound(tourId);
    const outcome = await this.#activate(
      step.viewId,
      step.transitionDurationMs,
    );
    if (outcome.status === 'activated') {
      this.#playback = { status: 'paused', tourId, stepIndex };
      this.#publish();
    }
    return outcome;
  }

  public cancelTour(reason = 'cancelled'): void {
    const operation = this.#playbackOperation;
    operation?.controller.abort(reason);
    if (this.#playback.status !== 'idle') {
      this.#playback = idlePlayback;
      this.#publish();
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    try { this.#activationOperation?.controller.abort('disposed'); } catch (error) { errors.push(error); }
    try { this.#playbackOperation?.controller.abort('disposed'); } catch (error) { errors.push(error); }
    for (const controller of this.#pending) {
      try { controller.abort('disposed'); } catch (error) { errors.push(error); }
    }
    this.#pending.clear();
    try { this.#unsubscribeDocument?.(); } catch (error) { errors.push(error); }
    let rollback = this.#activeRollback;
    while (rollback !== undefined) {
      try { this.#viewerState.release?.(rollback.prepared); } catch (error) { errors.push(error); }
      rollback = rollback.previous;
    }
    this.#activeRollback = undefined;
    this.#listeners.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Saved-view coordinator disposal failed');
    }
  }

  async #activate(
    viewId: string,
    transitionDurationMs: number,
    parentSignal?: AbortSignal,
  ): Promise<ViewActivationOutcome> {
    this.#assertCoordinated();
    const view = this.#requireView(viewId);
    if (!Number.isFinite(transitionDurationMs) || transitionDurationMs < 0) {
      throw new SavedViewError(
        'saved_view/invalid_definition',
        'transitionDurationMs must be a finite non-negative number',
        { transitionDurationMs },
      );
    }
    this.cancelActivation('preempted');
    const operation: ActivationOperation = {
      controller: new AbortController(),
      viewId,
      definitionFingerprint: fingerprint(view),
    };
    const unlink = linkAbort(parentSignal, operation.controller);
    this.#activationOperation = operation;
    this.#activation = { status: 'activating', viewId };
    this.#publish();

    const context: ViewerStateOperationContext = {
      signal: operation.controller.signal,
      transitionDurationMs,
    };
    let prepared: Prepared | undefined;
    let annotationSnapshot: AnnotationSnapshot | undefined;
    let hostApplyStarted = false;
    let annotationApplyStarted = false;
    try {
      prepared = await this.#viewerState.prepare(view.viewerState, context);
      context.signal.throwIfAborted();
      hostApplyStarted = true;
      await this.#viewerState.apply(prepared, context);
      context.signal.throwIfAborted();
      annotationSnapshot = this.#annotationViews.capture();
      annotationApplyStarted = true;
      await this.#annotationViews.apply(
        viewId,
        view.annotationOverrides,
        { signal: context.signal },
      );
      context.signal.throwIfAborted();

      const current = this.#findView(viewId);
      if (
        current === undefined ||
        fingerprint(current) !== operation.definitionFingerprint
      ) {
        operation.controller.abort('view-changed');
        context.signal.throwIfAborted();
      }

      const previousRollback = this.#activeRollback;
      this.#activeRollback = {
        prepared,
        annotationSnapshot,
        ...(this.#activeViewId === undefined
          ? {}
          : { previousActiveViewId: this.#activeViewId }),
        previous: previousRollback,
      };
      this.#compactActiveRollback();
      this.#activeViewId = viewId;
      this.#activationOperation = undefined;
      this.#activation = idleActivation;
      this.#publish();
      return { status: 'activated', viewId };
    } catch (error) {
      let failureCause = error;
      let releaseFailure: unknown;
      if (prepared !== undefined && (hostApplyStarted || annotationApplyStarted)) {
        await this.#rollbackActivation(
          prepared,
          annotationSnapshot,
          annotationApplyStarted,
          viewId,
        );
      } else if (prepared !== undefined) {
        try {
          this.#viewerState.release?.(prepared);
        } catch (releaseError) {
          releaseFailure = releaseError;
          failureCause = new AggregateError(
            [error, releaseError],
            `Activation of saved view "${viewId}" stopped and its prepared state could not be released`,
          );
        }
      }
      if (
        operation.controller.signal.aborted
        || (error instanceof Error && error.name === 'AbortError')
      ) {
        if (releaseFailure !== undefined) {
          const cleanupFailure = new SavedViewError(
            'saved_view/activation_failed',
            `Prepared state for cancelled saved view "${viewId}" could not be released`,
            { viewId, cleanup: 'release', outcome: 'cancelled' },
            { cause: failureCause },
          );
          this.#emitDiagnostic('error', cleanupFailure, failureCause);
        }
        return {
          status: 'cancelled',
          viewId,
          reason: abortReason(operation.controller.signal),
        };
      }
      const failure = new SavedViewError(
        'saved_view/activation_failed',
        `Activation of saved view "${viewId}" failed`,
        releaseFailure === undefined
          ? { viewId }
          : { viewId, cleanup: 'release', cleanupFailures: 1 },
        { cause: failureCause },
      );
      this.#emitDiagnostic('error', failure, failureCause);
      throw failure;
    } finally {
      unlink();
      if (this.#activationOperation === operation) {
        this.#activationOperation = undefined;
        this.#activation = idleActivation;
        this.#publish();
      }
    }
  }

  async #rollbackActivation(
    prepared: Prepared,
    annotationSnapshot: AnnotationSnapshot | undefined,
    annotationApplyStarted: boolean,
    viewId: string,
  ): Promise<void> {
    const failures: unknown[] = [];
    const rollbackController = new AbortController();
    if (annotationApplyStarted && annotationSnapshot !== undefined) {
      try {
        await this.#annotationViews.rollback(annotationSnapshot, {
          signal: rollbackController.signal,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.#viewerState.rollback(prepared, {
        signal: rollbackController.signal,
        transitionDurationMs: 0,
      });
    } catch (error) {
      failures.push(error);
    } finally {
      try { this.#viewerState.release?.(prepared); } catch (error) { failures.push(error); }
    }
    if (failures.length === 0) return;

    this.#consistent = false;
    this.#activationOperation = undefined;
    this.#activation = idleActivation;
    this.#publish();
    const failure = new SavedViewError(
      'saved_view/rollback_failed',
      `Rollback after activating saved view "${viewId}" failed`,
      { viewId, failures: failures.length },
      { cause: failures[0] },
    );
    this.#emitDiagnostic('fatal', failure, failures[0]);
    throw failure;
  }

  async #deactivateActive(): Promise<void> {
    do {
      const active = this.#activeRollback;
      if (active === undefined) {
        this.#activeViewId = undefined;
        this.#publish();
        return;
      }
      const failures: unknown[] = [];
      const signal = new AbortController().signal;
      try {
        await this.#annotationViews.rollback(active.annotationSnapshot, { signal });
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#viewerState.rollback(active.prepared, {
          signal,
          transitionDurationMs: 0,
        });
      } catch (error) {
        failures.push(error);
      } finally {
        this.#activeRollback = active.previous;
        try { this.#viewerState.release?.(active.prepared); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) {
        this.#consistent = false;
        this.#publish();
        const error = new SavedViewError(
          'saved_view/rollback_failed',
          'Rollback while removing the active saved view failed',
          { viewId: this.#activeViewId, failures: failures.length },
          { cause: failures[0] },
        );
        this.#emitDiagnostic('fatal', error, failures[0]);
        throw error;
      }
      this.#activeViewId = active.previousActiveViewId;
      if (
        this.#activeViewId === undefined
        || this.#findView(this.#activeViewId) !== undefined
      ) {
        this.#publish();
        return;
      }
    } while (this.#activeViewId !== undefined);
  }

  async #captureViewerState() {
    const controller = new AbortController();
    this.#pending.add(controller);
    try {
      const state = await this.#viewerState.capture({ signal: controller.signal });
      controller.signal.throwIfAborted();
      return state;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SavedViewError(
          this.#disposed ? 'saved_view/disposed' : 'saved_view/activation_failed',
          this.#disposed
            ? 'The saved-view coordinator is disposed'
            : 'Viewer-state capture was cancelled',
          {},
          { cause: error },
        );
      }
      throw error;
    } finally {
      this.#pending.delete(controller);
    }
  }

  #commit<Result>(
    label: string,
    operation: Parameters<SavedViewDocumentPort['transact']>[1] &
      ((draft: Parameters<Parameters<SavedViewDocumentPort['transact']>[1]>[0]) => Result),
  ): Result {
    const previousDocumentRevision = this.#document.getSnapshot().documentRevision;
    const result = this.#document.transact(label, operation);
    if (this.#snapshot.documentRevision === previousDocumentRevision) {
      this.#publish();
    }
    return result;
  }

  #documentChanged(): void {
    if (this.#disposed) return;
    const activation = this.#activationOperation;
    if (activation !== undefined) {
      const view = this.#findView(activation.viewId);
      if (
        view === undefined ||
        fingerprint(view) !== activation.definitionFingerprint
      ) {
        activation.controller.abort('view-changed');
      }
    }
    const playback = this.#playbackOperation;
    if (playback !== undefined) {
      const tour = this.#findTour(playback.tourId);
      if (tour === undefined || fingerprint(tour) !== playback.tourFingerprint) {
        playback.controller.abort('tour-changed');
      }
    }
    if (
      this.#activeViewId !== undefined
      && this.#findView(this.#activeViewId) === undefined
    ) {
      this.#playbackOperation?.controller.abort('active-view-removed');
      this.#activationOperation?.controller.abort('active-view-removed');
      this.#playback = idlePlayback;
      this.#activation = idleActivation;
      // Never report being on a view the document no longer contains. Putting the model back
      // takes a moment, and the nearest view that does still exist is published once it finishes.
      this.#activeViewId = undefined;
      this.#activeReconciliation ??= this.#reconcileRemovedActiveViews()
        .catch(() => {
          // A failure while putting things back is reported as a fatal diagnostic rather than
          // thrown. This runs in response to someone else's undo, and throwing here would surface
          // as an unexplained crash a long way from its cause.
        })
        .finally(() => {
          this.#activeReconciliation = undefined;
        });
    }
    // Subscribers are told about the change afterwards, so that by the time a host looks, this
    // already describes the new document rather than the old one.
    this.#publish(false);
  }

  async #reconcileRemovedActiveViews(): Promise<void> {
    if (!this.#disposed) await this.#deactivateActive();
  }

  #compactActiveRollback(): void {
    let current = this.#activeRollback;
    let depth = 1;
    while (current?.previous !== undefined && depth < MAX_ACTIVE_ROLLBACK_DEPTH) {
      current = current.previous;
      depth += 1;
    }
    if (current?.previous === undefined) return;
    const discarded = current.previous;
    current.previous = undefined;
    const failures: unknown[] = [];
    let rollback: ActiveRollback<Prepared, AnnotationSnapshot> | undefined = discarded;
    while (rollback !== undefined) {
      try { this.#viewerState.release?.(rollback.prepared); } catch (error) { failures.push(error); }
      rollback = rollback.previous;
    }
    if (failures.length > 0) {
      const error = new SavedViewError(
        'saved_view/activation_failed',
        'Retired saved-view rollback resources could not be released',
        { failures: failures.length },
        { cause: failures[0] },
      );
      this.#emitDiagnostic('error', error, failures[0]);
    }
  }

  #createSnapshot(): SavedViewsRuntimeSnapshot {
    const document = this.#document.getSnapshot();
    const value: SavedViewsRuntimeSnapshot = {
      runtimeRevision: this.#runtimeRevision,
      documentRevision: document.documentRevision,
      savedViews: [...document.savedViews]
        .sort((left, right) => left.id.localeCompare(right.id)),
      tours: [...document.tours]
        .sort((left, right) => left.id.localeCompare(right.id)),
      activeViewId: this.#activeViewId ?? null,
      activation: this.#activation,
      playback: this.#playback,
      consistent: this.#consistent,
    };
    return freezeSavedView(value) as SavedViewsRuntimeSnapshot;
  }

  #publish(notifyRuntime = true): void {
    if (this.#disposed) return;
    this.#runtimeRevision += 1;
    this.#snapshot = this.#createSnapshot();
    for (const listener of [...this.#listeners]) listener();
    if (notifyRuntime) this.#onChange?.();
  }

  #findView(viewId: string): SavedViewDefinition | undefined {
    return this.#document
      .getSnapshot()
      .savedViews.find((view) => view.id === viewId);
  }

  #requireView(viewId: string): SavedViewDefinition {
    const view = this.#findView(viewId);
    if (view === undefined) this.#notFound(viewId);
    return view;
  }

  #notFound(viewId: string): never {
    throw new SavedViewError(
      'saved_view/not_found',
      `Saved view "${viewId}" does not exist`,
      { viewId },
    );
  }

  #findTour(tourId: string): LinearTourDefinition | undefined {
    return this.#document.getSnapshot().tours.find((tour) => tour.id === tourId);
  }

  #requireTour(tourId: string): LinearTourDefinition {
    const tour = this.#findTour(tourId);
    if (tour === undefined) this.#tourNotFound(tourId);
    return tour;
  }

  #tourNotFound(tourId: string): never {
    throw new SavedViewError(
      'tour/not_found',
      `Tour "${tourId}" does not exist`,
      { tourId },
    );
  }

  #assertTourReferences(tour: LinearTourDefinition): void {
    const viewIds = new Set(
      this.#document.getSnapshot().savedViews.map((view) => view.id),
    );
    const missing = tour.steps
      .map((step) => step.viewId)
      .filter((viewId) => !viewIds.has(viewId));
    if (missing.length > 0) {
      throw new SavedViewError(
        'tour/invalid_definition',
        `Tour "${tour.id}" references missing saved views`,
        { tourId: tour.id, missingViewIds: [...new Set(missing)].sort() },
      );
    }
  }

  #assertStepIndex(tour: LinearTourDefinition, stepIndex: number): void {
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= tour.steps.length) {
      throw new SavedViewError(
        'tour/invalid_definition',
        `Tour step index ${stepIndex} is out of range`,
        { tourId: tour.id, stepIndex, stepCount: tour.steps.length },
      );
    }
  }

  #isCurrentPlayback(operation: PlaybackOperation): boolean {
    return this.#playbackOperation === operation && !this.#disposed;
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new SavedViewError(
        'saved_view/disposed',
        'The saved-view coordinator is disposed',
      );
    }
  }

  #assertCoordinated(): void {
    this.#assertUsable();
    if (!this.#consistent) {
      throw new SavedViewError(
        'saved_view/coordinator_faulted',
        'Viewer-state coordination is inconsistent; reconstruct ViewLeader',
      );
    }
  }

  #emitDiagnostic(
    severity: SavedViewDiagnostic['severity'],
    error: SavedViewError,
    cause: unknown,
  ): void {
    this.#diagnostic?.({
      severity,
      code: error.code,
      message: error.message,
      details: error.details,
      cause,
    });
  }
}

const timeoutScheduler: SavedViewScheduler = {
  delay(milliseconds, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (milliseconds === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(done, milliseconds);
      signal.addEventListener('abort', aborted, { once: true });
      function cleanup(): void {
        clearTimeout(timeout);
        signal.removeEventListener('abort', aborted);
      }
      function done(): void {
        cleanup();
        resolve();
      }
      function aborted(): void {
        cleanup();
        reject(signal.reason);
      }
    });
  },
};

function sortDefinitions<Value extends { readonly id: string }>(
  values: Value[],
): void {
  values.sort((left, right) => left.id.localeCompare(right.id));
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' ? signal.reason : 'cancelled';
}

function freezeSavedView<Value>(value: Value): Readonly<Value> {
  return deepFreeze(structuredClone(value));
}

function linkAbort(
  parent: AbortSignal | undefined,
  child: AbortController,
): () => void {
  if (parent === undefined) return () => {};
  const abort = () => child.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  return () => parent.removeEventListener('abort', abort);
}
