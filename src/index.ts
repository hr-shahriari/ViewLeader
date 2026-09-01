/**
 * The public API of ViewLeader.
 *
 * ViewLeader draws annotations — callouts, tags, markup, leader lines — as an SVG layer on top of a
 * 3D model viewer. It owns where the labels sit and how the leader lines reach their targets; the
 * viewer keeps owning the camera and the model.
 *
 * Everything below is what a host application is allowed to use. Anything not exported here is
 * internal and can change between releases.
 */
export {
  ViewLeader,
  type ViewLeaderOptions,
  type AnnotationsCapability,
  type AuthoringCapability,
  type DefinitionsPublicCapability,
  type DiagnosticsCapability,
  type DocumentsCapability,
  type EditingCapability,
  type GeometryCapability,
  type HistoryCapability,
} from './view-leader.js';
export type { ViewsCapability } from './views.js';
export type { AlignEdge } from './arrange.js';
export type {
  AnnotationHandle,
  AnnotationScreenGeometry,
  AnnotationTextMetrics,
  InkScreenGeometry,
  RegionHandle,
  RouteHandle,
  ScreenHit,
  ScreenHitKind,
} from './render.js';
export type {
  EditingDragKind,
  EditingOptions,
  EditingSnapshot,
} from './editing.js';
export type { FrameLintOptions, LayoutStrategies, SnapContext } from './runtime.js';
// Layout knobs taken by `setPlacementMode` and `setViewportInsets`. Public so a host can give a
// name to the type of a value it passes in.
export type { PlacementMode, ViewportInsets } from './labelPlacer.js';
export { KEYNOTE_METADATA_KEY, type KeynoteEntry } from './keynotes.js';
export { UNRESOLVED_TAG_TEXT } from './tagText.js';

export { CURRENT_DOCUMENT_VERSION, type TransactionOptions } from './document.js';
export type {
  Anchor,
  AnchorResolutionStatus,
  Annotation,
  AnnotationContent,
  AnnotationDraft,
  AnnotationLeg,
  AnnotationPatch,
  AnnotationPlacement,
  AnnotationRouting,
  AnnotationRuntimeSnapshot,
  AnnotationsSnapshot,
  BuiltInContent,
  CalloutContent,
  DefinitionCollections,
  DocumentsSnapshot,
  DocumentVersion,
  ElementAnchor,
  HistorySnapshot,
  HostImageContent,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ManualPlacement,
  ManualRouting,
  NamespacedMetadata,
  OrganizationRect,
  OrganizationRectUnit,
  PlainNoteContent,
  PluginContent,
  PluginEnvelope,
  RegionAnchor,
  RegionPlane,
  Rect,
  SnapshotCapability,
  SnapshotStamp,
  SplitCalloutContent,
  SymbolicBlockContent,
  TagContent,
  TagReference,
  TextDirection,
  Unsubscribe,
  Vec2,
  Vec3,
  ViewLeaderDocument,
  WorldPointAnchor,
} from './types.js';

export {
  AdapterError,
  DisposedError,
  DocumentTooLargeError,
  DuplicateIdError,
  InvalidConfigurationError,
  InvalidDocumentError,
  InvalidInputError,
  InvariantViolationError,
  NotFoundError,
  ViewLeaderError,
  domainError,
  type ViewLeaderErrorCode,
} from './errors.js';

export type {
  AccuratePickRequest,
  AccuratePickingAdapter,
  Diagnostic,
  DiagnosticSeverity,
  ElementInvalidation,
  ElementResolution,
  ElementResolutionAdapter,
  ElementResolveRequest,
  HostAdapterBundle,
  HostImageAdapter,
  InteractionAdapter,
  InteractionLease,
  ModelBounds,
  ModelBoundsAdapter,
  NeutralViewerStateAdapter,
  NormalizedPointerInput,
  OcclusionAdapter,
  OcclusionResult,
  OcclusionSample,
  ProjectedPoint,
  ProjectionAdapter,
  ResolvedHostImage,
  SurfacePickResult,
  SurfacePickingAdapter,
  TagTextAdapter,
  TagTextInvalidation,
  ViewportSnapshot,
} from './host.js';

export type {
  AuthoringCancellationReason,
  AuthoringDraft,
  AuthoringOutcome,
  AuthoringPreview,
  AuthoringSnapshot,
  StartAuthoringOptions,
} from './authoring.js';

export type {
  PluginAnnotationDraft,
  PluginAuthoringCapability,
  PluginAuthoringSnapshot,
  StartPluginToolOptions,
} from './plugin-authoring.js';

export {
  MarkupAuthoringCapability,
  type CommitInkOptions,
  type CommitRegionOptions,
  type ManagedMarkupAuthoringPreview,
  type MarkupAnnotationDraft,
  type MarkupAuthoringCancellationReason,
  type MarkupAuthoringIntegration,
  type MarkupAuthoringOptions,
  type MarkupAuthoringOutcome,
  type MarkupAuthoringSnapshot,
  type StartInkMarkupAuthoringOptions,
  type StartMarkupAuthoringOptions,
  type StartRegionMarkupAuthoringOptions,
} from './markup-authoring-capability.js';

export {
  addRegionVertex,
  createInk,
  createRegionAnchor,
  drawingPlaneFromSurfacePick,
  editInkPoint,
  moveInk,
  moveRegion,
  moveRegionVertex,
  regionLocalExtent,
  removeRegionVertex,
  replaceInkPoints,
  resizeRegion,
  retargetRegion,
  screenDeltaToDrawingPlane,
  simplifyInk,
  validateDrawingPlane,
  validateInk,
  validateRegionAnchor,
  worldPointToDrawingPlane,
  type ClosedRegionGeometry,
  type DrawingPlane,
  type EllipseRegionGeometry,
  type InkAnnotation,
  type MarkupAuthoringPreview,
  type MarkupToolKind,
  type PolygonRegionGeometry,
  type RectangleRegionGeometry,
  type RegionAnchor as MarkupRegionAnchor,
  type RevisionCloudGeometry,
  type SurfacePlanePick,
} from './markup.js';

export {
  BUILT_IN_DEFINITIONS,
  applyTemplateDefaults,
  buildDefaultStyles,
  type DeclarativePathCommand,
  type DefinitionAttachment,
  type DefinitionBounds,
  type DefinitionKind,
  type DefinitionReferenceCounts,
  type DefinitionsSnapshot,
  type EnclosureAspect,
  type EnclosureCorners,
  type EnclosureDefinition,
  type StyleDefinition,
  type StyleOverride,
  type ResolvedStyle,
  type StyleFieldSource,
  mergeStyleOverride,
  readStyleOverride,
  type TemplateDefinition,
  type TerminatorDefinition,
  type TerminatorSizing,
  type TypedDefinition,
} from './definitions.js';

export {
  CAD_DARK,
  CAD_PAPER,
  /**
   * How tall a capital letter is, as a fraction of the font size.
   *
   * Public because `LintPolyline.capHeightRatio` asks for it. Without this a host would have to
   * hard-code the number and keep it in sync by hand every time the default font changes.
   */
  CAP_RATIO,
  PEN,
  lineweight,
  mm,
  textPreset,
  type PenTier,
  type TextPresetName,
  type Theme,
} from './theme.js';

/**
 * Measures how wide a piece of text will be on screen.
 *
 * Exported so a plugin can lay out its own text at the same widths ViewLeader will draw it at,
 * rather than guessing from a character count and ending up slightly misaligned. Uses the browser's
 * canvas when one is available, and a stable estimate when it is not, so tests and server rendering
 * still get usable numbers.
 */
export { measureText, type FontSpec } from './textMetrics.js';
/**
 * The font text is measured in. Every built-in style names one already — the theme's `fontStack`,
 * which this is — so it is not a fallback for un-styled text; it is the family {@link measureText}
 * assumes when a caller passes none. Measure against it to match what gets drawn.
 */
export { DEFAULT_FONT_FAMILY } from './content.js';

/**
 * Checks a drawing against drafting conventions: leader angles, text sizes, overlapping labels.
 *
 * Exported so a host can grade its own frame and tell the user what looks wrong, the same way a
 * CAD package flags a drawing that breaks house style.
 */
export {
  MERGE_EPS,
  PREFERRED_LEADER_ANGLES,
  lintFrame,
  type LintFinding,
  type LintOptions,
  type LintPolyline,
  type LintRuleId,
} from './lint.js';

/**
 * Read and write BCF 2.1, the file format BIM tools use to pass issues between each other. Lets
 * annotations made here open as topics in Revit, Navisworks or Solibri, and vice versa.
 */
export * as interchange from './interchange/index.js';
export {
  DEFAULT_ARCHIVE_LIMITS,
  type ArchiveEntry,
  type ArchiveLimits,
  type ArchiveReadResult,
  type BcfAnnotationExport,
  type BcfCameraState,
  type BcfComment,
  type BcfExportDocument,
  type BcfExportOptions,
  type BcfParseOptions,
  type BcfSavedView,
  type BcfTopic,
  type ParsedBcf,
  type ValidationReport,
} from './interchange/types.js';

export {
  CORE_EXTENSION_API_VERSION,
  type AccessibilityMetadata,
  type DeclarativePrimitive,
  type NormalizedToolInput,
  type PluginCommandProposal,
  type PluginDescriptor,
  type PluginMigration,
  type PluginSetupContext,
  type PluginToolDescriptor,
  type PluginToolTransition,
} from './extensions.js';

export type {
  CaptureNeutralSavedViewInput,
  UpdateSavedViewInput,
} from './saved-views/coordinator.js';
export type {
  LinearTourDefinition,
  LinearTourStep,
  NeutralCameraState,
  NeutralClippingPlane,
  NeutralColor,
  NeutralColorOverride,
  NeutralElementReference,
  NeutralElementVisibility,
  NeutralModelVisibility,
  NeutralOrthographicCameraState,
  NeutralPerspectiveCameraState,
  NeutralViewerState,
  SavedViewAnnotationOverride,
  SavedViewAnnotationOverrides,
  SavedViewDefinition,
  SavedViewDiagnostic,
  SavedViewErrorCode,
  SavedViewRemovalReferences,
  SavedViewsRuntimeSnapshot,
  TourPlaybackOutcome,
  ViewActivationOutcome,
  ViewerStateAdapter,
} from './saved-views/neutral-types.js';
export { SavedViewError } from './saved-views/neutral-types.js';
