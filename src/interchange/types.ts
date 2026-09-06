import type { Vec3 } from '../types.js';

export interface ValidationReport {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface ArchiveEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ArchiveLimits {
  readonly maximumEntries: number;
  readonly maximumTotalBytes: number;
  readonly maximumEntryBytes: number;
  readonly maximumExpansionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maximumEntries: 1_024,
  maximumTotalBytes: 64 * 1024 * 1024,
  maximumEntryBytes: 16 * 1024 * 1024,
  maximumExpansionRatio: 100,
});

export interface ArchiveReadResult {
  readonly valid: boolean;
  readonly entries: readonly ArchiveEntry[];
  readonly errors: readonly string[];
}

export type BcfCameraState =
  | {
      readonly type: 'perspective';
      readonly position: Vec3;
      readonly direction: Vec3;
      readonly up: Vec3;
      readonly fieldOfView: number;
      readonly aspect: number;
    }
  | {
      readonly type: 'orthographic';
      readonly position: Vec3;
      readonly direction: Vec3;
      readonly up: Vec3;
      readonly viewToWorldScale: number;
      readonly aspect: number;
    };

export interface BcfComment {
  readonly id: string;
  readonly author: string;
  readonly date: string;
  readonly text: string;
}

export interface BcfTopic {
  readonly id: string;
  readonly title: string;
  readonly camera?: BcfCameraState;
  readonly comments: readonly BcfComment[];
  readonly components: readonly string[];
  readonly snapshotName?: string;
  readonly snapshot?: Uint8Array;
  readonly embeddedDocument?: unknown;
}

export interface ParsedBcf {
  readonly version?: string;
  readonly topics: readonly BcfTopic[];
  readonly warnings: readonly string[];
}

export interface BcfSavedView {
  readonly id: string;
  readonly name: string;
  readonly camera: BcfCameraState;
  readonly annotationIds: readonly string[];
}

export interface BcfAnnotationExport {
  readonly id: string;
  readonly text: string;
  readonly elementIds?: readonly string[];
}

export interface BcfExportDocument {
  readonly views: readonly BcfSavedView[];
  readonly annotations: readonly BcfAnnotationExport[];
  readonly embeddedDocument?: unknown;
}

export interface BcfExportOptions {
  readonly author: string;
  readonly zUpToYUp?: boolean;
  readonly includeDocument?: boolean;
  readonly snapshot?: (viewId: string) => Uint8Array | undefined;
  readonly elementToIfcGuid?: (elementId: string) => string | undefined;
}

export interface BcfParseOptions {
  readonly zUpToYUp?: boolean;
  readonly xmlParser?: XmlParserFactory;
}

export interface XmlDocumentLike {
  readonly documentElement: XmlElementLike | null;
  getElementsByTagName(name: string): ArrayLike<XmlElementLike>;
}

export interface XmlElementLike {
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ArrayLike<XmlElementLike>;
}

export type XmlParserFactory = (xml: string) => XmlDocumentLike;
