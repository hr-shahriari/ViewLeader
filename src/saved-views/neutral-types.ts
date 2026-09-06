// What a saved view is made of, described without reference to any particular 3D engine.
//
// Nothing engine-specific is allowed through here: no Three.js camera, no viewer control, no loader
// type. That is what lets a drawing saved against one viewer open against another.
//
// A saved view records more than a camera. It also captures which elements were hidden, what was
// recoloured, which section planes were cutting, and how individual annotations were overridden —
// so returning to a view restores what you were looking at rather than just where you stood.

import type { StyleOverride } from '../definitions.js';
import type { Vec2, Vec3 } from '../types.js';

export interface NeutralColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

interface NeutralCameraStateBase {
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly up: Vec3;
}

export interface NeutralPerspectiveCameraState
  extends NeutralCameraStateBase {
  readonly projection: 'perspective';
  readonly verticalFieldOfView: number;
  readonly near: number;
  readonly far: number;
}

export interface NeutralOrthographicCameraState
  extends NeutralCameraStateBase {
  readonly projection: 'orthographic';
  readonly height: number;
  readonly near: number;
  readonly far: number;
}

export type NeutralCameraState =
  | NeutralPerspectiveCameraState
  | NeutralOrthographicCameraState;

export interface NeutralModelVisibility {
  readonly modelId: string;
  readonly visible: boolean;
}

export interface NeutralElementVisibility {
  readonly modelId: string;
  readonly elementId: string;
  readonly visible: boolean;
}

export interface NeutralElementReference {
  readonly modelId: string;
  readonly elementId: string;
}

export interface NeutralColorOverride {
  readonly id: string;
  readonly modelId: string;
  readonly elementIds: readonly string[];
  readonly color: NeutralColor;
}

export interface NeutralClippingPlane {
  readonly id: string;
  readonly normal: Vec3;
  readonly constant: number;
  readonly enabled: boolean;
}

/**
 * Everything about the viewer worth restoring, recorded against stable model ids rather than
 * against objects in memory — so a view still finds the right walls after the model is closed and
 * reopened.
 */
export interface NeutralViewerState {
  readonly camera: NeutralCameraState;
  readonly modelVisibility: readonly NeutralModelVisibility[];
  readonly elementVisibility: readonly NeutralElementVisibility[];
  readonly selection: readonly NeutralElementReference[];
  readonly colorOverrides: readonly NeutralColorOverride[];
  readonly clippingPlanes: readonly NeutralClippingPlane[];
}

interface SavedViewAnnotationPlacement {
  readonly mode: 'automatic' | 'manual';
  readonly position?: Vec2;
}

/**
 * Style changes a saved view applies to particular annotations — recolouring one note for a
 * presentation without changing it everywhere else.
 *
 * The same shape as an annotation's own style override, and applied on top of it.
 */
export interface SavedViewAnnotationOverride {
  readonly visible?: boolean;
  readonly placement?: SavedViewAnnotationPlacement;
  readonly style?: StyleOverride;
}

export type SavedViewAnnotationOverrides = Readonly<
  Record<string, SavedViewAnnotationOverride>
>;

export interface SavedViewDefinition {
  readonly id: string;
  readonly name: string;
  readonly viewerState: NeutralViewerState;
  readonly annotationOverrides: SavedViewAnnotationOverrides;
}

export interface LinearTourStep {
  readonly viewId: string;
  readonly transitionDurationMs: number;
  readonly dwellDurationMs: number;
}

export interface LinearTourDefinition {
  readonly id: string;
  readonly name: string;
  readonly steps: readonly LinearTourStep[];
}

export interface SavedViewDocumentSnapshot {
  readonly documentRevision: number;
  readonly savedViews: readonly SavedViewDefinition[];
  readonly tours: readonly LinearTourDefinition[];
}

export interface MutableSavedViewDocument {
  savedViews: SavedViewDefinition[];
  tours: LinearTourDefinition[];
}

/**
 * How saved views reach the document.
 *
 * Two requirements on an implementation: a successful change is exactly one undo step, and a change
 * that throws partway leaves the document exactly as it was.
 */
export interface SavedViewDocumentPort {
  getSnapshot(): SavedViewDocumentSnapshot;
  subscribe?(listener: () => void): () => void;
  transact<Result>(
    label: string,
    operation: (draft: MutableSavedViewDocument) => Result,
  ): Result;
}

export interface ViewerStateOperationContext {
  readonly signal: AbortSignal;
  readonly transitionDurationMs: number;
}

/**
 * Restoring a view happens in two steps, prepare then apply.
 *
 * Preparing checks that everything the view needs is actually there, and records enough of the
 * current state to undo the change. Only then does anything move. A view that cannot be fully
 * restored is abandoned before the model changes, rather than leaving it half-applied.
 */
export interface ViewerStateAdapter<Prepared = unknown> {
  capture(context: { readonly signal: AbortSignal }):
    | NeutralViewerState
    | Promise<NeutralViewerState>;
  prepare(
    state: NeutralViewerState,
    context: ViewerStateOperationContext,
  ): Prepared | Promise<Prepared>;
  apply(
    prepared: Prepared,
    context: ViewerStateOperationContext,
  ): void | Promise<void>;
  rollback(
    prepared: Prepared,
    context: ViewerStateOperationContext,
  ): void | Promise<void>;
  /** Discards the recorded undo state once it is no longer needed. */
  release?(prepared: Prepared): void;
}

/** Applying a view's annotation overrides is its own reversible step, so it can be undone
 *  independently if a later stage fails. */
export interface AnnotationViewAdapter<Snapshot = unknown> {
  capture(): Snapshot;
  apply(
    viewId: string,
    overrides: SavedViewAnnotationOverrides,
    context: { readonly signal: AbortSignal },
  ): void | Promise<void>;
  rollback(
    snapshot: Snapshot,
    context: { readonly signal: AbortSignal },
  ): void | Promise<void>;
}

export type SavedViewErrorCode =
  | 'saved_view/invalid_definition'
  | 'saved_view/not_found'
  | 'saved_view/already_exists'
  | 'saved_view/referenced'
  | 'saved_view/activation_failed'
  | 'saved_view/rollback_failed'
  | 'saved_view/coordinator_faulted'
  | 'saved_view/disposed'
  | 'tour/not_found'
  | 'tour/invalid_definition';

export class SavedViewError extends Error {
  public readonly code: SavedViewErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: SavedViewErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'SavedViewError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface SavedViewDiagnostic {
  readonly severity: 'error' | 'fatal';
  readonly code: SavedViewErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export interface SavedViewRemovalReferences {
  readonly viewId: string;
  readonly active: boolean;
  readonly annotationOverrideIds: readonly string[];
  readonly tourSteps: readonly {
    readonly tourId: string;
    readonly stepIndex: number;
  }[];
}

export type ViewActivationOutcome =
  | { readonly status: 'activated'; readonly viewId: string }
  | {
      readonly status: 'cancelled';
      readonly viewId: string;
      readonly reason: string;
    };

export type TourPlaybackOutcome =
  | { readonly status: 'completed'; readonly tourId: string }
  | {
      readonly status: 'cancelled' | 'paused';
      readonly tourId: string;
      readonly stepIndex: number;
      readonly reason: string;
    };

export interface SavedViewsRuntimeSnapshot {
  readonly runtimeRevision: number;
  readonly documentRevision: number;
  readonly savedViews: readonly SavedViewDefinition[];
  readonly tours: readonly LinearTourDefinition[];
  readonly activeViewId: string | null;
  readonly activation:
    | { readonly status: 'idle' }
    | { readonly status: 'activating'; readonly viewId: string };
  readonly playback:
    | { readonly status: 'idle' }
    | {
        readonly status: 'playing' | 'paused';
        readonly tourId: string;
        readonly stepIndex: number;
      };
  readonly consistent: boolean;
}

export interface SavedViewScheduler {
  delay(milliseconds: number, signal: AbortSignal): Promise<void>;
}
