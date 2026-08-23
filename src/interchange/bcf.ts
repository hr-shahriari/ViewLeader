// Reading and writing the BCF format itself: topics, comments, viewpoints and their cameras.
import type { Vec3 } from '../types.js';
import { readArchive, writeStoredArchive } from './archive.js';
import type {
  ArchiveEntry,
  BcfAnnotationExport,
  BcfCameraState,
  BcfExportDocument,
  BcfExportOptions,
  BcfParseOptions,
  BcfTopic,
  ParsedBcf,
  XmlDocumentLike,
  XmlElementLike,
} from './types.js';
import { escapeXml, parseXmlGuarded } from './xml.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Turns any id into a standard-shaped GUID, which BCF requires.
 *
 * The same input always gives the same output, so re-exporting a drawing produces the same ids and
 * a receiving tool recognises the topics as the ones it already has rather than as new ones.
 */
export function stableBcfGuid(value: string): string {
  if (GUID.test(value)) return value.toLowerCase();
  const bytes = new Uint8Array(16);
  for (let group = 0; group < 4; group += 1) {
    const hash = fnv1a(`${group}:${value}`, 0x811c9dc5 ^ group);
    bytes[group * 4] = hash >>> 24;
    bytes[group * 4 + 1] = hash >>> 16;
    bytes[group * 4 + 2] = hash >>> 8;
    bytes[group * 4 + 3] = hash;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Converts a camera position from this library's convention, where Y points up, to the file
 * format's, where Z points up.
 *
 * **Test this against a known direction, never by exporting and re-importing.** The two conversions
 * are exact opposites of each other, so a round trip comes out right even if both are wrong — and
 * they were both wrong for a while. Nothing inside this repository could tell. The only symptom was
 * that exported files opened upside down in Solibri, Navisworks and Revit.
 *
 * The check that pins it down: straight up, `(0, 1, 0)`, must leave here as `(0, 0, 1)`, because
 * that is what up means in the file format.
 */
export function exportAxis(point: Vec3, remap = false): Vec3 {
  return remap ? { x: point.x, y: cleanZero(-point.z), z: point.y } : { ...point };
}

/**
 * The reverse: from the file's convention back to this library's. The check is the mirror of the one
 * above — the file's up, `(0, 0, 1)`, must arrive as `(0, 1, 0)`.
 */
export function importAxis(point: Vec3, remap = false): Vec3 {
  return remap ? { x: point.x, y: point.z, z: cleanZero(-point.y) } : { ...point };
}

function cleanZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function vectorXml(name: string, vector: Vec3): string {
  return `<${name}><X>${vector.x}</X><Y>${vector.y}</Y><Z>${vector.z}</Z></${name}>`;
}

function viewpointXml(
  topicId: string,
  camera: BcfCameraState,
  components: readonly string[],
  remap: boolean,
): string {
  const position = exportAxis(camera.position, remap);
  const direction = exportAxis(camera.direction, remap);
  const up = exportAxis(camera.up, remap);
  const cameraBody = [
    vectorXml('CameraViewPoint', position),
    vectorXml('CameraDirection', direction),
    vectorXml('CameraUpVector', up),
    camera.type === 'perspective'
      ? `<FieldOfView>${camera.fieldOfView}</FieldOfView><AspectRatio>${camera.aspect}</AspectRatio>`
      : `<ViewToWorldScale>${camera.viewToWorldScale}</ViewToWorldScale><AspectRatio>${camera.aspect}</AspectRatio>`,
  ].join('');
  const componentBody = components.length === 0
    ? ''
    : `<Components><Visibility DefaultVisibility="true"/><Selection>${components
        .map((guid) => `<Component IfcGuid="${escapeXml(guid)}"/>`)
        .join('')}</Selection></Components>`;
  return `<?xml version="1.0" encoding="UTF-8"?><VisualizationInfo Guid="${topicId}">${componentBody}<${
    camera.type === 'perspective' ? 'PerspectiveCamera' : 'OrthogonalCamera'
  }>${cameraBody}</${camera.type === 'perspective' ? 'PerspectiveCamera' : 'OrthogonalCamera'}></VisualizationInfo>`;
}

function annotationsForView(
  document: BcfExportDocument,
  ids: readonly string[],
): readonly BcfAnnotationExport[] {
  const wanted = new Set(ids);
  return document.annotations.filter((annotation) => wanted.has(annotation.id));
}

/** Comments are plain text, and this is about as long as receiving applications will accept. */
const MAXIMUM_COMMENT_LENGTH = 4_000;

/**
 * Removes the few formatting marks that turn up in engineering notes, so an exported comment does
 * not arrive in someone else's software reading `**Move** duct`.
 *
 * Deliberately not a Markdown parser — that is what `viewleader/markdown` is for, and a second
 * parser here would be exactly the duplication keeping them separate avoids. Anything this does not
 * recognise is left as its literal text: imperfect, but never wrong. A host wanting full fidelity
 * flattens the text with the plugin before exporting.
 */
function flattenToCommentText(source: string): string {
  return source
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // ATX headings
    .replace(/^\s{0,3}>\s?/gm, '') // block quotes
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // strong
    .replace(/(\*|_)(?!\s)(.*?)(?<!\s)\1/g, '$2') // emphasis
    .replace(/`+([^`]*)`+/g, '$1') // code spans
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images keep their text
    .replace(/\n{2,}/g, '\n') // blank lines are paragraph breaks, not blank lines
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, MAXIMUM_COMMENT_LENGTH);
}

function commentsXml(
  annotations: readonly BcfAnnotationExport[],
  author: string,
  date: string,
  topicId: string,
): string {
  return annotations.flatMap((annotation, index) => {
    const text = flattenToCommentText(annotation.text);
    if (!text) return [];
    const id = stableBcfGuid(`${topicId}:comment:${annotation.id}:${index}`);
    return [`<Comment Guid="${id}"><Date>${escapeXml(date)}</Date><Author>${escapeXml(author)}</Author><Comment>${escapeXml(text)}</Comment><Viewpoint Guid="${topicId}"/></Comment>`];
  }).join('');
}

function markupXml(
  topicId: string,
  title: string,
  author: string,
  date: string,
  comments: string,
  snapshotName: string | undefined,
  embeddedName: string | undefined,
): string {
  const headerFiles = [
    snapshotName ? `<File IsExternal="false"><Filename>${escapeXml(snapshotName)}</Filename></File>` : '',
    embeddedName ? `<File IsExternal="false"><Filename>${escapeXml(embeddedName)}</Filename></File>` : '',
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Markup><Header>${headerFiles}</Header><Topic Guid="${topicId}" TopicType="Issue" TopicStatus="Open"><Title>${escapeXml(title)}</Title><CreationDate>${escapeXml(date)}</CreationDate><CreationAuthor>${escapeXml(author)}</CreationAuthor></Topic>${comments}<Viewpoints><ViewPoint Guid="${topicId}"><Viewpoint>viewpoint.bcfv</Viewpoint>${snapshotName ? `<Snapshot>${escapeXml(snapshotName)}</Snapshot>` : ''}</ViewPoint></Viewpoints></Markup>`;
}

export function exportBcf(
  document: BcfExportDocument,
  options: BcfExportOptions,
): Uint8Array {
  const now = (options.now?.() ?? new Date()).toISOString();
  const entries: ArchiveEntry[] = [
    { name: 'bcf.version', data: encoder.encode('<?xml version="1.0" encoding="UTF-8"?><Version VersionId="2.1"/>') },
  ];
  for (const view of document.views) {
    const topicId = stableBcfGuid(view.id);
    const prefix = topicId;
    const annotations = annotationsForView(document, view.annotationIds);
    const components = [...new Set(
      annotations.flatMap((annotation) => annotation.elementIds ?? [])
        .map((elementId) => options.elementToIfcGuid?.(elementId))
        .filter((guid): guid is string => Boolean(guid)),
    )].sort();
    const snapshot = options.snapshot?.(view.id);
    const snapshotName = snapshot ? 'snapshot.png' : undefined;
    const embeddedName = options.includeDocument && document.embeddedDocument ? 'viewleader.json' : undefined;
    entries.push({
      name: `${prefix}/markup.bcf`,
      data: encoder.encode(markupXml(
        topicId,
        view.name,
        options.author,
        now,
        commentsXml(annotations, options.author, now, topicId),
        snapshotName,
        embeddedName,
      )),
    });
    entries.push({
      name: `${prefix}/viewpoint.bcfv`,
      data: encoder.encode(viewpointXml(topicId, view.camera, components, options.zUpToYUp === true)),
    });
    if (snapshot && snapshotName) entries.push({ name: `${prefix}/${snapshotName}`, data: snapshot });
    if (embeddedName && document.embeddedDocument) {
      entries.push({
        name: `${prefix}/${embeddedName}`,
        data: encoder.encode(JSON.stringify({ viewId: view.id, document: document.embeddedDocument })),
      });
    }
  }
  return writeStoredArchive(entries);
}

function first(document: XmlDocumentLike, ...names: string[]): XmlElementLike | undefined {
  for (const name of names) {
    const element = document.getElementsByTagName(name)[0];
    if (element) return element;
  }
  return undefined;
}

function text(element: XmlElementLike | undefined, name: string): string | undefined {
  const value = element?.getElementsByTagName(name)[0]?.textContent?.trim();
  return value || undefined;
}

function numberText(element: XmlElementLike | undefined, name: string): number | undefined {
  const value = Number(text(element, name));
  return Number.isFinite(value) ? value : undefined;
}

function vector(element: XmlElementLike | undefined, name: string): Vec3 | undefined {
  const target = element?.getElementsByTagName(name)[0];
  const x = numberText(target, 'X');
  const y = numberText(target, 'Y');
  const z = numberText(target, 'Z');
  return x !== undefined && y !== undefined && z !== undefined ? { x, y, z } : undefined;
}

function parseCamera(document: XmlDocumentLike, remap: boolean): BcfCameraState | undefined {
  const perspective = first(document, 'PerspectiveCamera', 'PerspectiveCameraViewPoint');
  const orthographic = first(document, 'OrthogonalCamera', 'OrthographicCamera');
  const camera = perspective ?? orthographic;
  if (!camera) return undefined;
  const position = vector(camera, 'CameraViewPoint');
  const direction = vector(camera, 'CameraDirection');
  const up = vector(camera, 'CameraUpVector');
  const aspect = numberText(camera, 'AspectRatio') ?? 1;
  if (!position || !direction || !up || aspect <= 0) return undefined;
  if (perspective) {
    const fieldOfView = numberText(camera, 'FieldOfView');
    if (!fieldOfView || fieldOfView <= 0 || fieldOfView >= 180) return undefined;
    return {
      type: 'perspective',
      position: importAxis(position, remap),
      direction: importAxis(direction, remap),
      up: importAxis(up, remap),
      fieldOfView,
      aspect,
    };
  }
  const viewToWorldScale = numberText(camera, 'ViewToWorldScale');
  if (!viewToWorldScale || viewToWorldScale <= 0) return undefined;
  return {
    type: 'orthographic',
    position: importAxis(position, remap),
    direction: importAxis(direction, remap),
    up: importAxis(up, remap),
    viewToWorldScale,
    aspect,
  };
}

function all<T>(value: ArrayLike<T>): T[] {
  return Array.from({ length: value.length }, (_, index) => value[index]).filter(
    (entry): entry is T => entry !== undefined,
  );
}

export async function parseBcf(
  archive: Uint8Array,
  options: BcfParseOptions = {},
): Promise<ParsedBcf> {
  const read = await readArchive(archive, options.archiveLimits, options.inflateRaw);
  if (!read.valid) return { topics: [], warnings: read.errors };
  const byName = new Map(read.entries.map((entry) => [entry.name, entry.data]));
  const versionEntry = byName.get('bcf.version');
  let version: string | undefined;
  const warnings: string[] = [];
  if (versionEntry) {
    const parsed = parseXmlGuarded(decoder.decode(versionEntry), options.xmlParser);
    version = parsed.document?.documentElement?.getAttribute('VersionId') ?? undefined;
    if (!parsed.valid) warnings.push(...parsed.errors);
  }
  const topics: BcfTopic[] = [];
  for (const [name, data] of byName) {
    if (!name.endsWith('/markup.bcf')) continue;
    const prefix = name.slice(0, -'/markup.bcf'.length);
    const markup = parseXmlGuarded(decoder.decode(data), options.xmlParser);
    if (!markup.valid || !markup.document) {
      warnings.push(...markup.errors.map((error) => `${name}: ${error}`));
      continue;
    }
    const topicElement = first(markup.document, 'Topic');
    const id = topicElement?.getAttribute('Guid') || prefix;
    const title = text(topicElement, 'Title') ?? 'Untitled BCF topic';
    const viewpointName = text(first(markup.document, 'ViewPoint', 'Viewpoint'), 'Viewpoint')
      ?? 'viewpoint.bcfv';
    const snapshotName = text(first(markup.document, 'ViewPoint', 'Viewpoint'), 'Snapshot');
    const viewpointData = byName.get(`${prefix}/${viewpointName}`);
    let camera: BcfCameraState | undefined;
    let components: string[] = [];
    if (viewpointData) {
      const viewpoint = parseXmlGuarded(decoder.decode(viewpointData), options.xmlParser);
      if (viewpoint.valid && viewpoint.document) {
        camera = parseCamera(viewpoint.document, options.zUpToYUp === true);
        components = [...new Set(
          all(viewpoint.document.getElementsByTagName('Component'))
            .map((component) => component.getAttribute('IfcGuid') ?? component.getAttribute('IFCGuid'))
            .filter((guid): guid is string => Boolean(guid)),
        )].sort();
      } else warnings.push(...viewpoint.errors.map((error) => `${prefix}: ${error}`));
    }
    const comments = all(markup.document.getElementsByTagName('Comment'))
      .filter((comment) => comment.getAttribute('Guid') !== null || text(comment, 'Author') !== undefined)
      .map((comment, index) => ({
        id: comment.getAttribute('Guid') ?? stableBcfGuid(`${id}:parsed-comment:${index}`),
        author: text(comment, 'Author') ?? '',
        date: text(comment, 'Date') ?? '',
        text: text(comment, 'Comment') ?? '',
      }));
    const embeddedData = byName.get(`${prefix}/viewleader.json`);
    let embeddedDocument: unknown;
    if (embeddedData) {
      try {
        const parsed: unknown = JSON.parse(decoder.decode(embeddedData));
        embeddedDocument = typeof parsed === 'object' && parsed !== null && 'document' in parsed
          ? (parsed as { document: unknown }).document
          : parsed;
      } catch {
        warnings.push(`${prefix}/viewleader.json is malformed`);
      }
    }
    const snapshot = snapshotName ? byName.get(`${prefix}/${snapshotName}`) : undefined;
    topics.push({
      id,
      title,
      ...(camera ? { camera } : {}),
      comments,
      components,
      ...(snapshotName ? { snapshotName } : {}),
      ...(snapshot ? { snapshot } : {}),
      ...(embeddedDocument !== undefined ? { embeddedDocument } : {}),
    });
  }
  topics.sort((left, right) => left.id.localeCompare(right.id));
  return {
    ...(version ? { version } : {}),
    topics,
    warnings,
  };
}
