// Turning an imported BCF file into changes to make to the document.
//
// Nothing here writes anything. It works out what would need to be created or updated and hands
// that back as a plan, which the host applies as one transaction — so importing a file is one undo
// step, and importing the same file twice changes nothing the second time.
import type { Vec3 } from '../types.js';
import { stableBcfGuid } from './bcf.js';
import type { BcfCameraState, BcfTopic, ValidationReport } from './types.js';

export interface BcfResolvedComponentAnchor {
  readonly kind: 'element';
  readonly elementId: string;
  readonly modelId?: string;
  readonly fallbackPoint: Vec3;
}

export interface PlannedBcfView {
  readonly id: string;
  readonly topicId: string;
  readonly name: string;
  readonly camera: BcfCameraState;
}

export interface PlannedBcfAnnotation {
  readonly id: string;
  readonly topicId: string;
  readonly viewId: string;
  readonly text: string;
  readonly anchor: BcfResolvedComponentAnchor;
}

export interface PlannedEmbeddedBcfDocument {
  readonly topicId: string;
  readonly document: unknown;
}

export interface BcfApplyPlan {
  readonly embeddedDocuments: readonly PlannedEmbeddedBcfDocument[];
  readonly views: readonly PlannedBcfView[];
  readonly annotations: readonly PlannedBcfAnnotation[];
  readonly skippedIds: readonly string[];
  readonly errors: readonly string[];
  readonly created: number;
}

export interface BcfApplyPlanOptions {
  readonly existingAnnotationIds?: ReadonlySet<string>;
  readonly appliedTopicIds?: ReadonlySet<string>;
  readonly validateEmbeddedDocument?: (document: unknown) => ValidationReport;
  readonly componentToAnchor?: (
    component: string,
    topic: BcfTopic,
  ) => BcfResolvedComponentAnchor | undefined;
}

/**
 * What the document accepts as an id: 1 to 128 characters, starting with a letter or digit.
 *
 * Restated here rather than imported, because this module deliberately depends on core for types
 * only. Every id built below is checked against it, so an id from an imported file can never reach
 * the document in a shape it refuses.
 */
const CORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Builds an id the document will accept out of identifiers from someone else's file.
 *
 * Those identifiers follow their own rules, not ours. An IFC GlobalId may contain a `$`, and a
 * component id from a foreign file is free text of any length — neither is guaranteed to be legal
 * here.
 *
 * So each part is kept as it is while it is legal and hashed when it is not. The result stays
 * readable in the common case, and the topic's own id usually survives intact even when something
 * beside it had to be hashed.
 *
 * The hash has to be the stable one: re-importing a file must produce the same ids, or nothing
 * recognises the topics it already has and every import duplicates everything.
 *
 * Escaping was tried first and was the bug — the escape character is itself illegal here, so
 * escaping an illegal character produced another one. Replacing each offender with a dash is no
 * good either: it makes `a$b` and `a-b` the same id.
 */
function safeIdentity(prefix: string, ...values: readonly string[]): string {
  const readable = [prefix, ...values].join(':');
  if (CORE_ID.test(readable)) return readable;
  const hashed = [prefix, ...values.map(stableBcfGuid)].join(':');
  // Checked rather than assumed: the two callers today fit inside the length limit, but a third
  // passing more parts would not, and quietly producing an id the document rejects is the very bug
  // this function exists to fix.
  return CORE_ID.test(hashed) ? hashed : `${prefix}:${stableBcfGuid(readable)}`;
}

/**
 * Works out what an imported file would change, without changing anything.
 *
 * The host applies the result in one transaction, so an import is a single undo step. Importing the
 * same file twice produces no changes the second time.
 */
export function planBcfApply(
  topics: readonly BcfTopic[],
  options: BcfApplyPlanOptions = {},
): BcfApplyPlan {
  const embeddedDocuments: PlannedEmbeddedBcfDocument[] = [];
  const views: PlannedBcfView[] = [];
  const annotations: PlannedBcfAnnotation[] = [];
  const skippedIds: string[] = [];
  const errors: string[] = [];
  const plannedViews = new Set<string>();
  const plannedAnnotations = new Set(options.existingAnnotationIds ?? []);
  const plannedTopics = new Set(options.appliedTopicIds ?? []);
  for (const topic of topics) {
    if (plannedTopics.has(topic.id)) {
      skippedIds.push(topic.id);
      continue;
    }
    if (topic.embeddedDocument !== undefined) {
      const validation = options.validateEmbeddedDocument?.(topic.embeddedDocument);
      if (!validation) {
        errors.push(`${topic.id}: no embedded-document validator was supplied`);
        continue;
      }
      if (!validation.valid) {
        errors.push(...validation.errors.map((error) => `${topic.id}: ${error}`));
        continue;
      }
      embeddedDocuments.push({ topicId: topic.id, document: structuredClone(topic.embeddedDocument) });
      plannedTopics.add(topic.id);
      continue;
    }
    if (!topic.camera) {
      errors.push(`${topic.id}: topic has no viewpoint camera`);
      continue;
    }
    const viewId = safeIdentity('bcf-view', topic.id);
    if (plannedViews.has(viewId)) {
      skippedIds.push(viewId);
    } else {
      plannedViews.add(viewId);
      views.push({ id: viewId, topicId: topic.id, name: topic.title, camera: topic.camera });
    }
    for (const component of topic.components) {
      const anchor = options.componentToAnchor?.(component, topic);
      if (!anchor) continue;
      const annotationId = safeIdentity('bcf-annotation', topic.id, component);
      if (plannedAnnotations.has(annotationId)) {
        skippedIds.push(annotationId);
        continue;
      }
      plannedAnnotations.add(annotationId);
      annotations.push({
        id: annotationId,
        topicId: topic.id,
        viewId,
        text: topic.title,
        anchor,
      });
    }
    plannedTopics.add(topic.id);
  }
  return {
    embeddedDocuments,
    views,
    annotations,
    skippedIds,
    errors,
    created: embeddedDocuments.length + views.length + annotations.length,
  };
}
