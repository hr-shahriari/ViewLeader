import type { StyleOverride } from './definitions';

/** Plain numbers, no engine types. Every adapter converts to and from these. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type OrganizationRectUnit = 'pixels' | 'fraction';

/**
 * A rectangle the user draws to say "keep the notes off this area". Labels are pushed outside it
 * instead of around the model's own outline.
 *
 * `'fraction'` units are measured against the viewport, so the frame stays in the same relative
 * place when the window is resized. `'pixels'` are fixed screen coordinates.
 */
export interface OrganizationRect {
  readonly rect: Rect;
  readonly unit: OrganizationRectUnit;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type NamespacedMetadata = Readonly<Record<string, JsonValue>>;

export interface WorldPointAnchor {
  readonly kind: 'world-point';
  readonly point: Vec3;
}

export interface ElementAnchor {
  readonly kind: 'element';
  readonly modelId: string;
  readonly elementId: string;
  readonly fallbackPoint: Vec3;
}

export interface RegionPlane {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly xAxis: Vec3;
}

export interface RegionAnchor {
  readonly kind: 'region';
  readonly modelId?: string;
  readonly plane: RegionPlane;
  readonly vertices: readonly Vec2[];
  readonly shape: 'rectangle' | 'ellipse' | 'polygon' | 'revision-cloud';
  readonly fallbackPoint: Vec3;
}

export type Anchor = WorldPointAnchor | ElementAnchor | RegionAnchor;

export type TextDirection = 'auto' | 'ltr' | 'rtl';

/** How text lines up inside its label box. */
export type TextAlign = 'start' | 'middle' | 'end';

interface TextContentBase {
  readonly direction?: TextDirection;
  readonly maxWidth?: number;
}

export interface PlainNoteContent extends TextContentBase {
  readonly kind: 'plain-note';
  readonly text: string;
}

/**
 * Points a tag at a property of a real model element — an equipment mark, a door number, a fire
 * rating.
 *
 * Only this reference is saved. The text the host looks up for it is treated as a cache and is
 * never written back, so the document keeps following the model instead of freezing a stale value
 * from whenever it was last opened.
 */
export interface TagReference {
  readonly modelId: string;
  readonly elementId: string;
  /** Which property to display, named in whatever vocabulary the host understands. */
  readonly property: string;
}

export interface TagContent extends TextContentBase {
  readonly kind: 'tag';
  /**
   * The text the author typed, and the only text ever saved.
   *
   * With no `reference` this is the whole tag. With one it is the fallback shown when the host
   * cannot look the property up. A resolved value never overwrites it.
   */
  readonly text: string;
  readonly reference?: TagReference;
}

export interface CalloutContent extends TextContentBase {
  readonly kind: 'callout';
  readonly title?: string;
  readonly text: string;
}

export interface SplitCalloutContent extends TextContentBase {
  readonly kind: 'split-callout';
  readonly primary: string;
  readonly secondary: string;
}

export interface SymbolicBlockContent extends TextContentBase {
  readonly kind: 'symbolic-block';
  readonly symbol: 'circle' | 'square' | 'diamond' | 'hexagon';
  readonly label: string;
}

export interface HostImageContent {
  readonly kind: 'host-image';
  readonly reference: string;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
}

export type BuiltInContent =
  | PlainNoteContent
  | TagContent
  | CalloutContent
  | SplitCalloutContent
  | SymbolicBlockContent
  | HostImageContent;

/** Content owned by a plugin. Stored and round-tripped as-is; ViewLeader never reads inside it. */
export interface PluginContent {
  readonly kind: `plugin:${string}`;
  readonly pluginId: string;
  readonly schemaVersion: number;
  readonly data: JsonValue;
}

export type AnnotationContent = BuiltInContent | PluginContent;

export interface AutomaticPlacement {
  readonly kind: 'automatic';
}

export interface ManualPlacement {
  readonly kind: 'manual';
  readonly position: Vec2;
}

export type AnnotationPlacement = AutomaticPlacement | ManualPlacement;

export interface AutomaticRouting {
  readonly kind: 'automatic';
  readonly mode: 'straight' | 'dogleg' | 'orthogonal';
}

/**
 * A leader line whose bends the user placed by hand, rather than one ViewLeader routes itself.
 *
 * An empty `vertices` list is legal and draws a straight line. But note that it still counts as
 * hand-drawn, so the line stays frozen even as the camera moves. If you got there by deleting the
 * last bend and wanted automatic routing back, call `annotations.resetRouting(id)` instead.
 */
export interface ManualRouting {
  readonly kind: 'manual';
  readonly vertices: readonly Vec2[];
}

export type AnnotationRouting = AutomaticRouting | ManualRouting;

export interface AnnotationLeg {
  readonly id: string;
  readonly anchor: Anchor;
  readonly routing: AnnotationRouting;
}

export interface Annotation {
  readonly id: string;
  readonly anchors: readonly AnnotationLeg[];
  readonly content: AnnotationContent;
  readonly placement: AnnotationPlacement;
  readonly styleId?: string;
  /**
   * Per-annotation style tweaks, held as loose JSON on purpose: a file saved by a newer version may
   * carry style fields this build has never heard of, and loose JSON keeps them instead of dropping
   * them. Set them through the typed `StyleOverride` on a draft or patch.
   */
  readonly styleOverride?: JsonObject;
  readonly occlusion?: 'keep' | 'fade' | 'hide';
  /**
   * The user froze this annotation in place.
   *
   * It still tracks its anchor — locking is not the same as detaching — but nothing is allowed to
   * nudge it aside any more. Other labels move out of its way instead.
   *
   * Different from a manual placement: a manual placement is a *position* the user picked, while
   * `locked` is *permission* the user took away.
   */
  readonly locked?: boolean;
  readonly metadata: NamespacedMetadata;
  /**
   * Fields written by a newer version of ViewLeader that this build does not understand, kept
   * word-for-word and written back out on save. This is what stops an old build from quietly
   * deleting a colleague's work when it opens and re-saves their file.
   *
   * Shaped like the annotation itself — `{ content: { fontWeight: 700 } }` — and never interpreted.
   * You cannot set it from a draft or a patch; only loading a file produces it.
   */
  readonly unknownFields?: JsonObject;
}

export interface AnnotationDraft {
  readonly id?: string;
  /** Shorthand for an annotation with a single leader line. Give either this or `anchors`. */
  readonly anchor?: Anchor;
  readonly anchors?: readonly AnnotationLeg[];
  readonly content: AnnotationContent;
  readonly placement?: AnnotationPlacement;
  /** The route for that single leader line. */
  readonly routing?: AnnotationRouting;
  readonly styleId?: string;
  readonly styleOverride?: StyleOverride;
  readonly occlusion?: 'keep' | 'fade' | 'hide';
  readonly locked?: boolean;
  readonly metadata?: NamespacedMetadata;
}

export interface AnnotationPatch {
  /** Moves the first leader line to a new target. Shorthand for the usual single-leg case. */
  readonly anchor?: Anchor;
  readonly anchors?: readonly AnnotationLeg[];
  readonly content?: AnnotationContent;
  readonly placement?: AnnotationPlacement;
  /** Replaces the first leader line's route. Shorthand for the usual single-leg case. */
  readonly routing?: AnnotationRouting;
  readonly styleId?: string | null;
  readonly styleOverride?: StyleOverride | null;
  readonly occlusion?: 'keep' | 'fade' | 'hide' | null;
  /** `null` unlocks it, the same way `null` clears every other optional field in a patch. */
  readonly locked?: boolean | null;
  readonly metadata?: NamespacedMetadata;
}

export interface PluginEnvelope {
  readonly pluginId: string;
  readonly recordType: string;
  readonly schemaVersion: number;
  readonly data: JsonValue;
}

/**
 * Styles and saved views are stored as plain JSON with a size limit. The module that owns each one
 * checks its exact shape before the document accepts it.
 */
export interface DefinitionCollections {
  readonly styles: readonly JsonObject[];
  readonly templates: readonly JsonObject[];
  readonly terminators: readonly JsonObject[];
  readonly enclosures: readonly JsonObject[];
}

/**
 * File format versions this build can open. Adding one means adding a matching upgrade step in
 * `document.ts` — a test fails if you add one without the other.
 */
export type DocumentVersion = 1 | 2;

export interface ViewLeaderDocument {
  readonly schema: 'viewleader.document';
  /**
   * Anything from version 1 up to {@link CURRENT_DOCUMENT_VERSION} opens; older files are upgraded
   * as they load and saved back at the current version.
   *
   * A file from a *newer* version is refused rather than opened. This build cannot know what a
   * field it has never seen is for, and opening it anyway would mean saving over data it did not
   * understand.
   */
  readonly version: DocumentVersion;
  readonly annotations: readonly Annotation[];
  readonly metadata: NamespacedMetadata;
  readonly pluginEnvelopes: readonly PluginEnvelope[];
  readonly definitions: DefinitionCollections;
  readonly savedViews: readonly JsonObject[];
  readonly tours: readonly JsonObject[];
  readonly ink: readonly JsonObject[];
  /**
   * The framing rectangle labels are kept outside of, if the user drew one.
   *
   * Saved with the document rather than kept as a setting, because someone *drew* it — it is
   * authored work, like the notes themselves. Dropping it on reload would both lose that work and
   * silently rearrange every label, since without a frame the layout falls back to the model's
   * outline instead.
   */
  readonly layoutFrame?: OrganizationRect;
  /** Document-wide fields from a newer version, kept as-is. See {@link Annotation.unknownFields}. */
  readonly unknownFields?: JsonObject;
  /**
   * Annotations of a type this build does not recognise. Parked here so nothing tries to draw them,
   * kept exactly as they arrived, and written back into the file on save.
   */
  readonly quarantined?: readonly JsonObject[];
}

export interface SnapshotStamp {
  readonly runtimeRevision: number;
  readonly documentRevision: number;
}

export type AnchorResolutionStatus = 'resolved' | 'unresolved';

export interface AnnotationRuntimeSnapshot extends Annotation {
  readonly anchorStatuses: readonly AnchorResolutionStatus[];
  readonly resolvedWorldPoints: readonly Vec3[];
}

export interface AnnotationsSnapshot extends SnapshotStamp {
  readonly annotations: readonly AnnotationRuntimeSnapshot[];
  readonly selectedIds: readonly string[];
  readonly hoveredId: string | null;
}

export interface DocumentsSnapshot extends SnapshotStamp {
  readonly document: ViewLeaderDocument;
}

export interface HistorySnapshot extends SnapshotStamp {
  readonly undoCount: number;
  readonly redoCount: number;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
}

export type Unsubscribe = () => void;

export interface SnapshotCapability<Snapshot extends SnapshotStamp> {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): Unsubscribe;
}
