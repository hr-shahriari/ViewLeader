import type { Vec3 } from '../types.js';
import type { DocumentLoadMode, DocumentLoadReport, ValidationReport } from './types.js';

export interface IdentifiedDocument<RecordType extends { readonly id: string }> {
  readonly annotations: readonly RecordType[];
  readonly [key: string]: unknown;
}

export interface ElementLikeAnchor {
  readonly kind: string;
  readonly elementId?: string;
  readonly modelId?: string;
  readonly fallbackPoint?: Vec3;
  readonly [key: string]: unknown;
}

export interface RefreshableRecord {
  readonly id: string;
  readonly anchor: ElementLikeAnchor;
  readonly legs?: readonly {
    readonly id: string;
    readonly anchor: ElementLikeAnchor;
    readonly [key: string]: unknown;
  }[];
  readonly [key: string]: unknown;
}

export type FallbackLookup = (
  request: { readonly elementId: string; readonly modelId?: string },
) => Vec3 | undefined;

function refreshAnchor(anchor: ElementLikeAnchor, lookup: FallbackLookup): ElementLikeAnchor {
  if (anchor.kind !== 'element' || !anchor.elementId) return anchor;
  const point = lookup({
    elementId: anchor.elementId,
    ...(anchor.modelId ? { modelId: anchor.modelId } : {}),
  });
  return point ? { ...anchor, fallbackPoint: { ...point } } : anchor;
}

/** Works on a copy. Whatever was passed in is never modified. */
export function refreshElementFallbacksOnSave<T extends IdentifiedDocument<RefreshableRecord>>(
  document: T,
  lookup: FallbackLookup,
): T {
  return structuredClone({
    ...document,
    annotations: document.annotations.map((record) => ({
      ...record,
      anchor: refreshAnchor(record.anchor, lookup),
      ...(record.legs
        ? { legs: record.legs.map((leg) => ({ ...leg, anchor: refreshAnchor(leg.anchor, lookup) })) }
        : {}),
    })),
  }) as T;
}

export function mergeIdentifiedDocuments<T extends IdentifiedDocument<{ readonly id: string }>>(
  current: T,
  incoming: T,
): { readonly document: T; readonly report: DocumentLoadReport } {
  const existing = new Set(current.annotations.map((record) => record.id));
  const skippedIds: string[] = [];
  const additions = incoming.annotations.filter((record) => {
    if (existing.has(record.id)) {
      skippedIds.push(record.id);
      return false;
    }
    existing.add(record.id);
    return true;
  });
  return {
    document: structuredClone({ ...current, annotations: [...current.annotations, ...additions] }) as T,
    report: { mode: 'merge', created: additions.length, skippedIds },
  };
}

export interface TransactionalDocumentTarget<T> {
  read(): T;
  reset(): void;
  populate(document: T): void;
}

export function transactionalLoad<T>(
  target: TransactionalDocumentTarget<T>,
  incoming: T,
  mode: DocumentLoadMode,
  validate: (value: unknown) => ValidationReport,
  merge?: (current: T, incoming: T) => { readonly document: T; readonly report: DocumentLoadReport },
): DocumentLoadReport {
  const validation = validate(incoming);
  if (!validation.valid) throw new TypeError(`Invalid document: ${validation.errors.join('; ')}`);
  const snapshot = structuredClone(target.read());
  const prepared = mode === 'merge' && merge ? merge(snapshot, incoming) : undefined;
  const next = prepared?.document ?? incoming;
  const report = prepared?.report ?? { mode, created: 0, skippedIds: [] };
  try {
    target.reset();
    target.populate(structuredClone(next));
    return report;
  } catch (error) {
    target.reset();
    target.populate(snapshot);
    throw error;
  }
}
