import type {
  LinearTourDefinition,
  LinearTourStep,
  NeutralCameraState,
  NeutralClippingPlane,
  NeutralColor,
  NeutralColorOverride,
  NeutralElementReference,
  NeutralElementVisibility,
  NeutralModelVisibility,
  NeutralVec2,
  NeutralVec3,
  NeutralViewerState,
  SavedViewAnnotationOverride,
  SavedViewAnnotationOverrides,
  SavedViewDefinition,
} from './neutral-types.js';
import { SavedViewError } from './neutral-types.js';

export function normalizeSavedViewDefinition(
  value: SavedViewDefinition,
  unrecognized?: string[],
): SavedViewDefinition {
  assertExactKeys(
    value,
    ['id', 'name', 'viewerState', 'annotationOverrides'],
    'saved view',
    unrecognized,
  );
  assertId(value.id, 'saved view id');
  assertName(value.name, 'saved view name');
  return {
    id: value.id,
    name: value.name,
    viewerState: normalizeViewerState(value.viewerState, unrecognized),
    annotationOverrides: normalizeAnnotationOverrides(
      value.annotationOverrides,
      unrecognized,
    ),
  };
}

export function normalizeViewerState(
  value: NeutralViewerState,
  unrecognized?: string[],
): NeutralViewerState {
  assertExactKeys(value, [
    'camera',
    'modelVisibility',
    'elementVisibility',
    'selection',
    'colorOverrides',
    'clippingPlanes',
  ], 'viewer state', unrecognized);
  const normalized = {
    camera: normalizeCamera(value.camera, unrecognized),
    modelVisibility: [...value.modelVisibility]
      .map((entry) => normalizeModelVisibility(entry, unrecognized))
      .sort((left, right) => left.modelId.localeCompare(right.modelId)),
    elementVisibility: [...value.elementVisibility]
      .map((entry) => normalizeElementVisibility(entry, unrecognized))
      .sort(compareElement),
    selection: [...value.selection]
      .map((entry) => normalizeElementReference(entry, false, unrecognized))
      .sort(compareElement),
    colorOverrides: [...value.colorOverrides]
      .map((entry) => normalizeColorOverride(entry, unrecognized))
      .sort((left, right) => left.id.localeCompare(right.id)),
    // The order of section planes is kept as given. Some viewers treat them as an ordered list,
    // and reordering them would change what the view shows.
    clippingPlanes: value.clippingPlanes
      .map((entry) => normalizeClippingPlane(entry, unrecognized)),
  };
  assertUnique(normalized.modelVisibility, (entry) => entry.modelId, 'model visibility');
  assertUnique(
    normalized.elementVisibility,
    (entry) => `${entry.modelId}\u0000${entry.elementId}`,
    'element visibility',
  );
  assertUnique(
    normalized.selection,
    (entry) => `${entry.modelId}\u0000${entry.elementId}`,
    'viewer selection',
  );
  assertUnique(normalized.colorOverrides, (entry) => entry.id, 'color override');
  assertUnique(normalized.clippingPlanes, (entry) => entry.id, 'clipping plane');
  return normalized;
}

export function normalizeLinearTourDefinition(
  value: LinearTourDefinition,
  options: { readonly allowEmpty?: boolean } = {},
  unrecognized?: string[],
): LinearTourDefinition {
  assertExactKeys(value, ['id', 'name', 'steps'], 'tour', unrecognized);
  assertId(value.id, 'tour id', 'tour/invalid_definition');
  assertName(value.name, 'tour name', 'tour/invalid_definition');
  if (value.steps.length === 0 && options.allowEmpty !== true) {
    throw new SavedViewError(
      'tour/invalid_definition',
      'A linear tour must contain at least one step',
      { tourId: value.id },
    );
  }
  return {
    id: value.id,
    name: value.name,
    steps: value.steps
      .map((step, index) => normalizeTourStep(step, index, unrecognized)),
  };
}

export function freezeSavedView<Value>(value: Value): Readonly<Value> {
  return deepFreeze(structuredClone(value));
}

function normalizeCamera(
  value: NeutralCameraState,
  unrecognized?: string[],
): NeutralCameraState {
  assertExactKeys(
    value,
    value.projection === 'perspective'
      ? ['projection', 'position', 'direction', 'up', 'verticalFieldOfView', 'near', 'far']
      : ['projection', 'position', 'direction', 'up', 'height', 'near', 'far'],
    'camera',
    unrecognized,
  );
  const common = {
    position: normalizeVec3(value.position, 'camera.position'),
    direction: normalizeDirection(value.direction, 'camera.direction'),
    up: normalizeDirection(value.up, 'camera.up'),
    near: positive(value.near, 'camera.near'),
    far: positive(value.far, 'camera.far'),
  };
  if (common.far <= common.near) {
    invalid('camera.far must be greater than camera.near');
  }
  if (value.projection === 'perspective') {
    const verticalFieldOfView = positive(
      value.verticalFieldOfView,
      'camera.verticalFieldOfView',
    );
    if (verticalFieldOfView >= 180) {
      invalid('camera.verticalFieldOfView must be less than 180 degrees');
    }
    return { ...common, projection: 'perspective', verticalFieldOfView };
  }
  return {
    ...common,
    projection: 'orthographic',
    height: positive(value.height, 'camera.height'),
  };
}

function normalizeModelVisibility(
  value: NeutralModelVisibility,
  unrecognized?: string[],
): NeutralModelVisibility {
  assertExactKeys(value, ['modelId', 'visible'], 'model visibility', unrecognized);
  assertId(value.modelId, 'model visibility modelId');
  return { modelId: value.modelId, visible: boolean(value.visible, 'visible') };
}

function normalizeElementVisibility(
  value: NeutralElementVisibility,
  unrecognized?: string[],
): NeutralElementVisibility {
  assertExactKeys(
    value,
    ['modelId', 'elementId', 'visible'],
    'element visibility',
    unrecognized,
  );
  return {
    ...normalizeElementReference(value, true),
    visible: boolean(value.visible, 'visible'),
  };
}

function normalizeElementReference(
  value: NeutralElementReference,
  embeddedVisibility = false,
  unrecognized?: string[],
): NeutralElementReference {
  if (!embeddedVisibility) {
    assertExactKeys(value, ['modelId', 'elementId'], 'element reference', unrecognized);
  }
  assertId(value.modelId, 'element reference modelId');
  assertId(value.elementId, 'element reference elementId');
  return { modelId: value.modelId, elementId: value.elementId };
}

function normalizeColorOverride(
  value: NeutralColorOverride,
  unrecognized?: string[],
): NeutralColorOverride {
  assertExactKeys(
    value,
    ['id', 'modelId', 'elementIds', 'color'],
    'color override',
    unrecognized,
  );
  assertId(value.id, 'color override id');
  assertId(value.modelId, 'color override modelId');
  const elementIds = [...new Set(value.elementIds)].sort();
  for (const elementId of elementIds) {
    assertId(elementId, 'color override elementId');
  }
  return {
    id: value.id,
    modelId: value.modelId,
    elementIds,
    color: normalizeColor(value.color, unrecognized),
  };
}

function normalizeColor(value: NeutralColor, unrecognized?: string[]): NeutralColor {
  assertExactKeys(value, ['red', 'green', 'blue', 'alpha'], 'color', unrecognized);
  return {
    red: unit(value.red, 'color.red'),
    green: unit(value.green, 'color.green'),
    blue: unit(value.blue, 'color.blue'),
    alpha: unit(value.alpha, 'color.alpha'),
  };
}

function normalizeClippingPlane(
  value: NeutralClippingPlane,
  unrecognized?: string[],
): NeutralClippingPlane {
  assertExactKeys(
    value,
    ['id', 'normal', 'constant', 'enabled'],
    'clipping plane',
    unrecognized,
  );
  assertId(value.id, 'clipping plane id');
  return {
    id: value.id,
    normal: normalizeDirection(value.normal, 'clipping plane normal'),
    constant: finite(value.constant, 'clipping plane constant'),
    enabled: boolean(value.enabled, 'clipping plane enabled'),
  };
}

function normalizeAnnotationOverrides(
  value: SavedViewAnnotationOverrides,
  unrecognized?: string[],
): SavedViewAnnotationOverrides {
  const result: Record<string, SavedViewAnnotationOverride> = {};
  for (const annotationId of Object.keys(value).sort()) {
    assertId(annotationId, 'annotation override id');
    const override = value[annotationId];
    if (override === undefined) continue;
    assertExactKeys(
      override,
      ['visible', 'placement', 'style'],
      'annotation override',
      unrecognized,
    );
    const normalized: SavedViewAnnotationOverride = {
      ...(override.visible === undefined
        ? {}
        : { visible: boolean(override.visible, 'annotation visibility') }),
      ...(override.placement === undefined
        ? {}
        : { placement: normalizePlacement(override.placement, unrecognized) }),
      ...(override.style === undefined
        ? {}
        : { style: normalizeJsonObject(override.style, 'annotation style') }),
    };
    result[annotationId] = normalized;
  }
  return result;
}

function normalizePlacement(
  value: NonNullable<SavedViewAnnotationOverride['placement']>,
  unrecognized?: string[],
): NonNullable<SavedViewAnnotationOverride['placement']> {
  assertExactKeys(value, ['mode', 'position'], 'annotation placement', unrecognized);
  if (value.mode === 'automatic') {
    if (value.position !== undefined) {
      invalid('automatic annotation placement cannot contain a position');
    }
    return { mode: 'automatic' };
  }
  if (value.mode !== 'manual' || value.position === undefined) {
    invalid('manual annotation placement requires a finite position');
  }
  return { mode: 'manual', position: normalizeVec2(value.position, 'position') };
}

function normalizeTourStep(
  step: LinearTourStep,
  index: number,
  unrecognized?: string[],
): LinearTourStep {
  assertExactKeys(
    step,
    ['viewId', 'transitionDurationMs', 'dwellDurationMs'],
    `tour step ${index}`,
    unrecognized,
  );
  assertId(step.viewId, `tour step ${index} viewId`, 'tour/invalid_definition');
  return {
    viewId: step.viewId,
    transitionDurationMs: duration(
      step.transitionDurationMs,
      `tour step ${index} transitionDurationMs`,
    ),
    dwellDurationMs: duration(
      step.dwellDurationMs,
      `tour step ${index} dwellDurationMs`,
    ),
  };
}

function compareElement(
  left: NeutralElementReference,
  right: NeutralElementReference,
): number {
  return (
    left.modelId.localeCompare(right.modelId) ||
    left.elementId.localeCompare(right.elementId)
  );
}

function normalizeVec2(value: NeutralVec2, path: string): NeutralVec2 {
  return { x: finite(value.x, `${path}.x`), y: finite(value.y, `${path}.y`) };
}

function normalizeVec3(value: NeutralVec3, path: string): NeutralVec3 {
  return {
    x: finite(value.x, `${path}.x`),
    y: finite(value.y, `${path}.y`),
    z: finite(value.z, `${path}.z`),
  };
}

function normalizeDirection(value: NeutralVec3, path: string): NeutralVec3 {
  const normalized = normalizeVec3(value, path);
  const magnitude = Math.hypot(normalized.x, normalized.y, normalized.z);
  if (magnitude <= Number.EPSILON) invalid(`${path} must not be zero length`);
  return normalized;
}

function normalizeJsonObject(
  value: Readonly<Record<string, unknown>>,
  path: string,
): Readonly<Record<string, unknown>> {
  const normalized = normalizeJsonValue(value, path, new WeakSet<object>());
  if (!isRecord(normalized)) invalid(`${path} must be a JSON object`);
  return normalized;
}

function normalizeJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>> {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return finite(value, path);
  if (typeof value !== 'object') invalid(`${path} must contain only JSON values`);
  if (ancestors.has(value)) invalid(`${path} must not contain cycles`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        normalizeJsonValue(entry, `${path}[${index}]`, ancestors),
      );
    }
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      invalid(`${path} must contain only plain JSON objects`);
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeJsonValue(value[key], `${path}.${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function assertUnique<Value>(
  entries: readonly Value[],
  key: (value: Value) => string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const identity = key(entry);
    if (seen.has(identity)) invalid(`${label} contains duplicate identity "${identity}"`);
    seen.add(identity);
  }
}

/**
 * Strict when authoring, forgiving when loading — the same rule used throughout.
 *
 * Loading, an unrecognised field belongs to a newer version and is kept. Authoring, it is a typo,
 * and the author is told where they made it.
 */
function assertExactKeys(
  value: object,
  allowed: readonly string[],
  path: string,
  unrecognized?: string[],
): void {
  const supported = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !supported.has(key)).sort();
  if (unexpected.length === 0) return;
  if (unrecognized === undefined) {
    invalid(`${path} contains unsupported fields: ${unexpected.join(', ')}`);
  }
  for (const key of unexpected) unrecognized.push(`${path}.${key}`);
}

function finite(value: number, path: string): number {
  if (!Number.isFinite(value)) invalid(`${path} must be finite`);
  return value;
}

function positive(value: number, path: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    invalid(`${path} must be a finite positive number`);
  }
  return value;
}

function duration(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 3_600_000) {
    throw new SavedViewError(
      'tour/invalid_definition',
      `${path} must be between 0 and 3,600,000`,
      { path, value },
    );
  }
  return value;
}

function unit(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${path} must be between 0 and 1`);
  }
  return value;
}

function boolean(value: boolean, path: string): boolean {
  if (typeof value !== 'boolean') invalid(`${path} must be boolean`);
  return value;
}

function assertId(
  value: string,
  path: string,
  code: 'saved_view/invalid_definition' | 'tour/invalid_definition' =
    'saved_view/invalid_definition',
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SavedViewError(code, `${path} must not be empty`, { path });
  }
}

function assertName(
  value: string,
  path: string,
  code: 'saved_view/invalid_definition' | 'tour/invalid_definition' =
    'saved_view/invalid_definition',
): void {
  assertId(value, path, code);
}

function invalid(message: string): never {
  throw new SavedViewError('saved_view/invalid_definition', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
