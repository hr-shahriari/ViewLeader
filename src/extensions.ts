// The plugin system: how content ViewLeader knows nothing about still gets drawn.
//
// A plugin stores its own data in an annotation and describes what to draw as a list of simple
// shapes — text, lines, paths. It never touches the DOM and never reaches into the engine, so a
// badly behaved plugin can produce a wrong-looking label but cannot corrupt a document or break
// the drawing loop.
//
// Plugins are registered once when a ViewLeader is created. There is no way to add one later, which
// is what makes a document's content predictable from its plugin list alone.
//
// `viewleader/markdown` is the worked example, written against exactly this API.
import { domainError } from './errors.js';
import type { DeclarativePathCommand, DefinitionBounds } from './definitions.js';
import type { JsonObject, JsonValue, PluginEnvelope, Vec2 } from './types.js';

export const CORE_EXTENSION_API_VERSION = '1.0.0';

export interface AccessibilityMetadata {
  readonly role: 'img' | 'text' | 'button' | 'group';
  readonly label: string;
  readonly description?: string;
}

interface PrimitiveBase {
  readonly bounds: DefinitionBounds;
  readonly zIndex: number;
  readonly accessibility: AccessibilityMetadata;
}

export interface TextPrimitive extends PrimitiveBase {
  readonly kind: 'text';
  readonly text: string;
  readonly position: Vec2;
  readonly fontSize: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly code?: boolean;
}

export interface PathPrimitive extends PrimitiveBase {
  readonly kind: 'path';
  readonly commands: readonly DeclarativePathCommand[];
  readonly fill: 'none' | 'solid';
}

export interface ImagePrimitive extends PrimitiveBase {
  readonly kind: 'image';
  readonly reference: string;
  readonly alt: string;
}

export type DeclarativePrimitive =
  | TextPrimitive
  | PathPrimitive
  | ImagePrimitive;

export interface PluginMigration {
  readonly from: number;
  readonly to: number;
  readonly migrate: (data: JsonValue) => JsonValue;
}

export type NormalizedToolInput =
  | { readonly kind: 'pointer'; readonly phase: 'down' | 'move' | 'up'; readonly point: Vec2 }
  | { readonly kind: 'keyboard'; readonly key: string; readonly modifiers: readonly string[] }
  | { readonly kind: 'programmatic'; readonly action: string; readonly data?: JsonValue }
  | { readonly kind: 'cancel'; readonly reason: 'user' | 'preempted' | 'disposed' };

export type PluginCommandProposal =
  | { readonly kind: 'create'; readonly recordType: string; readonly data: JsonValue }
  | { readonly kind: 'update'; readonly id: string; readonly recordType: string; readonly data: JsonValue }
  | { readonly kind: 'remove'; readonly id: string };

export interface PluginToolTransition {
  readonly state: JsonValue;
  readonly preview?: readonly DeclarativePrimitive[];
  readonly command?: PluginCommandProposal;
  readonly outcome?: 'completed' | 'cancelled';
  readonly status?: string;
}

export interface PluginToolDescriptor {
  readonly id: string;
  readonly initialState: JsonValue;
  readonly transition: (
    state: JsonValue,
    input: NormalizedToolInput,
  ) => PluginToolTransition;
}

export interface PluginSetupContext {
  readonly invalidate: () => void;
  readonly registerCleanup: (cleanup: () => void) => void;
}

export interface PluginDescriptor {
  readonly id: string;
  readonly coreApiRange: string;
  readonly schemaVersion: number;
  readonly validate: (recordType: string, data: JsonValue) => void;
  readonly migrations?: readonly PluginMigration[];
  readonly render?: (
    recordType: string,
    data: JsonValue,
  ) => readonly DeclarativePrimitive[];
  readonly tools?: readonly PluginToolDescriptor[];
  readonly setup?: (context: PluginSetupContext) => void;
}

export interface ExtensionLimits {
  readonly maximumEnvelopeBytes: number;
  readonly maximumStringLength: number;
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  readonly maximumPrimitives: number;
  readonly maximumPathCommands: number;
}

export const DEFAULT_EXTENSION_LIMITS: ExtensionLimits = Object.freeze({
  maximumEnvelopeBytes: 256_000,
  maximumStringLength: 20_000,
  maximumDepth: 24,
  maximumNodes: 8_192,
  maximumPrimitives: 2_048,
  maximumPathCommands: 1_024,
});

export interface PluginResolutionDiagnostic {
  readonly code: 'PLUGIN_MISSING' | 'PLUGIN_MIGRATION_MISSING' | 'PLUGIN_CONTENT_DEGRADED';
  readonly pluginId: string;
  readonly recordType: string;
  readonly schemaVersion: number;
  readonly message: string;
}

export interface ResolvedPluginRecord {
  readonly envelope: PluginEnvelope;
  readonly data: JsonValue;
  readonly descriptor: PluginDescriptor;
}

export interface ExtensionResolution {
  readonly resolved: readonly ResolvedPluginRecord[];
  readonly unresolved: readonly PluginEnvelope[];
  readonly diagnostics: readonly PluginResolutionDiagnostic[];
}

export interface ExtensionRuntimeOptions {
  readonly coreApiVersion?: string;
  readonly limits?: ExtensionLimits;
  readonly invalidate?: () => void;
}

/**
 * Holds the plugins this ViewLeader was created with, and runs them.
 *
 * The set never changes after construction. That is deliberate: it means whether a document can be
 * drawn depends only on which plugins were supplied, not on the order things happened to load in.
 */
export class ExtensionRuntime {
  readonly #descriptors = new Map<string, PluginDescriptor>();
  readonly #limits: ExtensionLimits;
  readonly #cleanups: (() => void)[] = [];
  #disposed = false;

  public constructor(
    descriptors: readonly PluginDescriptor[],
    options: ExtensionRuntimeOptions = {},
  ) {
    const coreApiVersion = options.coreApiVersion ?? CORE_EXTENSION_API_VERSION;
    this.#limits = options.limits ?? DEFAULT_EXTENSION_LIMITS;
    validateExtensionLimits(this.#limits);
    for (const descriptor of descriptors) {
      validatePluginDescriptor(descriptor, coreApiVersion);
      if (this.#descriptors.has(descriptor.id)) {
        throw domainError('INVALID_PLUGIN', `Duplicate plugin id "${descriptor.id}"`, {
          pluginId: descriptor.id,
        });
      }
      this.#descriptors.set(descriptor.id, descriptor);
    }
    for (const descriptor of this.#descriptors.values()) {
      try {
        descriptor.setup?.({
          invalidate: options.invalidate ?? (() => undefined),
          registerCleanup: (cleanup) => {
            if (typeof cleanup !== 'function') {
              throw domainError('INVALID_PLUGIN', 'Plugin cleanup must be a function', {
                pluginId: descriptor.id,
              });
            }
            this.#cleanups.push(cleanup);
          },
        });
      } catch (cause) {
        this.dispose();
        if (cause instanceof Error && 'code' in cause) throw cause;
        throw domainError('INVALID_PLUGIN', `Plugin "${descriptor.id}" setup failed`, {
          pluginId: descriptor.id,
          cause,
        });
      }
    }
  }

  public get descriptors(): readonly PluginDescriptor[] {
    return [...this.#descriptors.values()];
  }

  public beginTool(pluginId: string, toolId: string): JsonValue {
    this.#assertActive();
    const descriptor = this.#descriptors.get(pluginId);
    if (descriptor === undefined) {
      throw domainError('INVALID_PLUGIN', `Plugin "${pluginId}" is not installed`, { pluginId });
    }
    const tool = descriptor.tools?.find(({ id }) => id === toolId);
    if (tool === undefined) {
      throw domainError('INVALID_PLUGIN', `Unknown plugin tool "${toolId}"`, { pluginId, toolId });
    }
    return clone(tool.initialState);
  }

  public contentFromTool(
    pluginId: string,
    recordType: string,
    data: JsonValue,
  ): Readonly<{
    kind: `plugin:${string}`;
    pluginId: string;
    schemaVersion: number;
    data: JsonValue;
  }> {
    const descriptor = this.#descriptors.get(pluginId);
    if (descriptor === undefined) {
      throw domainError('INVALID_PLUGIN', `Plugin "${pluginId}" is not installed`, { pluginId });
    }
    const envelope = this.validateForCommit({
      pluginId,
      recordType,
      schemaVersion: descriptor.schemaVersion,
      data,
    });
    const record = this.prepare([envelope]).resolved[0];
    if (record === undefined) {
      throw domainError('INVALID_PLUGIN', `Plugin "${pluginId}" did not resolve its own tool output`, {
        pluginId,
        recordType,
      });
    }
    this.render(record);
    return Object.freeze({
      kind: `plugin:${pluginId}`,
      pluginId,
      schemaVersion: descriptor.schemaVersion,
      data: clone(record.data),
    });
  }

  /**
   * Prepares a plugin's stored data for drawing, without ever refusing to open a document.
   *
   * Content whose plugin is missing, or which fails its own checks, is passed through rather than
   * thrown away. Anything created in this session was already checked strictly when it was
   * authored, so a problem here means the file was written by a different build — and refusing to
   * open someone's drawing because one note came from a newer version is the wrong trade.
   *
   * The caller decides what such content looks like on screen.
   */
  public prepare(envelopes: readonly PluginEnvelope[]): ExtensionResolution {
    this.#assertActive();
    const resolved: ResolvedPluginRecord[] = [];
    const unresolved: PluginEnvelope[] = [];
    const diagnostics: PluginResolutionDiagnostic[] = [];
    for (const envelope of envelopes) {
      validatePluginEnvelope(envelope, this.#limits);
      const descriptor = this.#descriptors.get(envelope.pluginId);
      if (descriptor === undefined) {
        unresolved.push(clone(envelope));
        diagnostics.push({
          code: 'PLUGIN_MISSING',
          pluginId: envelope.pluginId,
          recordType: envelope.recordType,
          schemaVersion: envelope.schemaVersion,
          message: `Plugin "${envelope.pluginId}" is not installed`,
        });
        continue;
      }
      const migrated = migrateEnvelope(envelope, descriptor, this.#limits);
      if (migrated === undefined) {
        unresolved.push(clone(envelope));
        diagnostics.push({
          code: 'PLUGIN_MIGRATION_MISSING',
          pluginId: envelope.pluginId,
          recordType: envelope.recordType,
          schemaVersion: envelope.schemaVersion,
          message: `Plugin "${envelope.pluginId}" has no migration path from ${envelope.schemaVersion}`,
        });
        continue;
      }
      try {
        callValidator(descriptor, envelope.recordType, migrated);
      } catch (cause) {
        diagnostics.push({
          code: 'PLUGIN_CONTENT_DEGRADED',
          pluginId: envelope.pluginId,
          recordType: envelope.recordType,
          schemaVersion: envelope.schemaVersion,
          message: cause instanceof Error
            ? cause.message
            : `Plugin "${envelope.pluginId}" content did not fully validate`,
        });
      }
      resolved.push({ envelope: clone(envelope), data: clone(migrated), descriptor });
    }
    return { resolved, unresolved, diagnostics };
  }

  public validateForCommit(envelope: PluginEnvelope): PluginEnvelope {
    this.#assertActive();
    validatePluginEnvelope(envelope, this.#limits);
    const descriptor = this.#descriptors.get(envelope.pluginId);
    if (descriptor === undefined) {
      throw domainError('INVALID_PLUGIN', `Plugin "${envelope.pluginId}" is not installed`, {
        pluginId: envelope.pluginId,
      });
    }
    const migrated = migrateEnvelope(envelope, descriptor, this.#limits);
    if (migrated === undefined) {
      throw domainError('INVALID_PLUGIN', 'Plugin envelope has no supported migration path', {
        pluginId: envelope.pluginId,
        schemaVersion: envelope.schemaVersion,
        targetSchemaVersion: descriptor.schemaVersion,
      });
    }
    callValidator(descriptor, envelope.recordType, migrated);
    return {
      pluginId: descriptor.id,
      recordType: envelope.recordType,
      schemaVersion: descriptor.schemaVersion,
      data: clone(migrated),
    };
  }

  public render(record: ResolvedPluginRecord): readonly DeclarativePrimitive[] {
    this.#assertActive();
    const renderer = record.descriptor.render;
    if (renderer === undefined) return [];
    let primitives: readonly DeclarativePrimitive[];
    try {
      primitives = renderer(record.envelope.recordType, deepFreeze(clone(record.data)));
    } catch (cause) {
      throw domainError('INVALID_PLUGIN', `Plugin "${record.descriptor.id}" renderer failed`, {
        pluginId: record.descriptor.id,
        recordType: record.envelope.recordType,
        cause,
      });
    }
    validatePrimitives(primitives, this.#limits);
    return clone(primitives);
  }

  public runTool(
    pluginId: string,
    toolId: string,
    state: JsonValue | undefined,
    input: NormalizedToolInput,
  ): PluginToolTransition {
    this.#assertActive();
    const descriptor = this.#descriptors.get(pluginId);
    if (descriptor === undefined) {
      throw domainError('INVALID_PLUGIN', `Plugin "${pluginId}" is not installed`, { pluginId });
    }
    const tool = descriptor.tools?.find(({ id }) => id === toolId);
    if (tool === undefined) {
      throw domainError('INVALID_PLUGIN', `Unknown plugin tool "${toolId}"`, { pluginId, toolId });
    }
    validateToolInput(input, this.#limits);
    const current = deepFreeze(clone(state ?? tool.initialState));
    let transition: PluginToolTransition;
    try {
      transition = tool.transition(current, clone(input));
    } catch (cause) {
      throw domainError('INVALID_PLUGIN', `Plugin tool "${toolId}" failed`, {
        pluginId,
        toolId,
        cause,
      });
    }
    assertExactKeys(transition, ['state', 'preview', 'command', 'outcome', 'status'], 'plugin tool transition');
    validateJson(transition.state, this.#limits, 'plugin tool state');
    if (transition.preview !== undefined) validatePrimitives(transition.preview, this.#limits);
    if (transition.command !== undefined) validateCommand(transition.command, this.#limits);
    if (transition.status !== undefined && transition.status.length > 1_024) {
      throw domainError('INVALID_PLUGIN', 'Plugin tool status exceeds the string bound', { pluginId, toolId });
    }
    return clone(transition);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const cleanup of this.#cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        // A plugin that throws while cleaning up must not stop the others from cleaning up, and
        // disposing twice must be harmless.
      }
    }
    this.#cleanups.length = 0;
  }

  #assertActive(): void {
    if (this.#disposed) throw domainError('INVALID_PLUGIN', 'Extension runtime is disposed');
  }
}

export function validatePluginDescriptor(
  descriptor: PluginDescriptor,
  coreApiVersion = CORE_EXTENSION_API_VERSION,
): void {
  if (descriptor === null || typeof descriptor !== 'object') {
    throw domainError('INVALID_PLUGIN', 'Plugin descriptor must be an object');
  }
  assertExactKeys(descriptor, [
    'id', 'coreApiRange', 'schemaVersion', 'validate', 'migrations', 'render', 'tools', 'setup',
  ], 'plugin descriptor');
  validateStableId(descriptor.id, 'plugin id');
  if (typeof descriptor.coreApiRange !== 'string'
    || !apiRangeIncludes(descriptor.coreApiRange, coreApiVersion)) {
    throw domainError('INVALID_PLUGIN', `Plugin "${descriptor.id}" is incompatible with core ${coreApiVersion}`, {
      pluginId: descriptor.id,
      coreApiRange: descriptor.coreApiRange,
      coreApiVersion,
    });
  }
  if (!Number.isInteger(descriptor.schemaVersion) || descriptor.schemaVersion < 1) {
    throw domainError('INVALID_PLUGIN', 'Plugin schema version must be a positive integer', {
      pluginId: descriptor.id,
    });
  }
  if (typeof descriptor.validate !== 'function') {
    throw domainError('INVALID_PLUGIN', 'Plugin descriptor requires a validator', {
      pluginId: descriptor.id,
    });
  }
  const migrations = descriptor.migrations ?? [];
  const sources = new Set<number>();
  for (const migration of migrations) {
    assertExactKeys(migration, ['from', 'to', 'migrate'], 'plugin migration');
    if (!Number.isInteger(migration.from) || !Number.isInteger(migration.to)
      || migration.from < 1 || migration.to <= migration.from
      || migration.to > descriptor.schemaVersion || typeof migration.migrate !== 'function'
      || sources.has(migration.from)) {
      throw domainError('INVALID_PLUGIN', 'Plugin migration descriptor is invalid', {
        pluginId: descriptor.id,
        from: migration.from,
        to: migration.to,
      });
    }
    sources.add(migration.from);
  }
  const toolIds = new Set<string>();
  for (const tool of descriptor.tools ?? []) {
    assertExactKeys(tool, ['id', 'initialState', 'transition'], 'plugin tool descriptor');
    validateStableId(tool.id, 'plugin tool id');
    if (toolIds.has(tool.id) || typeof tool.transition !== 'function') {
      throw domainError('INVALID_PLUGIN', 'Plugin tool descriptor is invalid', {
        pluginId: descriptor.id,
        toolId: tool.id,
      });
    }
    toolIds.add(tool.id);
    validateJson(tool.initialState, DEFAULT_EXTENSION_LIMITS, 'plugin tool initial state');
  }
}

export function validatePluginEnvelope(
  envelope: PluginEnvelope,
  limits: ExtensionLimits = DEFAULT_EXTENSION_LIMITS,
): void {
  if (envelope === null || typeof envelope !== 'object') {
    throw domainError('INVALID_PLUGIN', 'Plugin envelope must be an object');
  }
  assertExactKeys(envelope, ['pluginId', 'recordType', 'schemaVersion', 'data'], 'plugin envelope');
  validateStableId(envelope.pluginId, 'plugin envelope plugin id');
  validateStableId(envelope.recordType, 'plugin record type');
  if (!Number.isInteger(envelope.schemaVersion) || envelope.schemaVersion < 1) {
    throw domainError('INVALID_PLUGIN', 'Plugin envelope schema version must be positive', {
      pluginId: envelope.pluginId,
    });
  }
  validateJson(envelope.data, limits, 'plugin envelope data');
  if (canonicalJson(envelope).length > limits.maximumEnvelopeBytes) {
    throw domainError('INVALID_PLUGIN', 'Plugin envelope exceeds the byte bound', {
      pluginId: envelope.pluginId,
      maximumBytes: limits.maximumEnvelopeBytes,
    });
  }
}

export function validatePrimitives(
  primitives: readonly DeclarativePrimitive[],
  limits: ExtensionLimits = DEFAULT_EXTENSION_LIMITS,
): void {
  if (!Array.isArray(primitives) || primitives.length > limits.maximumPrimitives) {
    throw domainError('INVALID_PLUGIN', 'Plugin primitive list exceeds its bound');
  }
  for (const primitive of primitives) {
    validatePrimitiveBase(primitive);
    switch (primitive.kind) {
      case 'text':
        assertExactKeys(primitive, [
          'kind', 'bounds', 'zIndex', 'accessibility', 'text', 'position', 'fontSize',
          'bold', 'italic', 'code',
        ], 'text primitive');
        if (typeof primitive.text !== 'string' || primitive.text.length > limits.maximumStringLength
          || !finitePoint(primitive.position) || !Number.isFinite(primitive.fontSize)
          || primitive.fontSize <= 0 || primitive.fontSize > 1_000) {
          throw domainError('INVALID_PLUGIN', 'Text primitive is invalid');
        }
        break;
      case 'path':
        assertExactKeys(primitive, [
          'kind', 'bounds', 'zIndex', 'accessibility', 'commands', 'fill',
        ], 'path primitive');
        if (!Array.isArray(primitive.commands)
          || primitive.commands.length === 0
          || primitive.commands.length > limits.maximumPathCommands) {
          throw domainError('INVALID_PLUGIN', 'Path primitive commands exceed their bound');
        }
        for (const command of primitive.commands) validatePathCommand(command);
        if (primitive.fill !== 'none' && primitive.fill !== 'solid') {
          throw domainError('INVALID_PLUGIN', 'Path primitive fill is invalid');
        }
        break;
      case 'image':
        assertExactKeys(primitive, [
          'kind', 'bounds', 'zIndex', 'accessibility', 'reference', 'alt',
        ], 'image primitive');
        if (!opaqueReference(primitive.reference)
          || typeof primitive.alt !== 'string' || primitive.alt.length === 0
          || primitive.alt.length > limits.maximumStringLength) {
          throw domainError('INVALID_PLUGIN', 'Image primitive requires an opaque reference and alt text');
        }
        break;
      default:
        throw domainError('INVALID_PLUGIN', 'Unknown plugin primitive kind');
    }
  }
}

function migrateEnvelope(
  envelope: PluginEnvelope,
  descriptor: PluginDescriptor,
  limits: ExtensionLimits,
): JsonValue | undefined {
  if (envelope.schemaVersion > descriptor.schemaVersion) return undefined;
  let version = envelope.schemaVersion;
  let data = clone(envelope.data);
  while (version < descriptor.schemaVersion) {
    const migration = descriptor.migrations?.find(({ from }) => from === version);
    if (migration === undefined) return undefined;
    const frozen = deepFreeze(clone(data));
    try {
      data = migration.migrate(frozen);
    } catch (cause) {
      throw domainError('INVALID_PLUGIN', `Plugin "${descriptor.id}" migration failed`, {
        pluginId: descriptor.id,
        from: migration.from,
        to: migration.to,
        cause,
      });
    }
    validateJson(data, limits, 'migrated plugin data');
    version = migration.to;
  }
  return data;
}

function callValidator(
  descriptor: PluginDescriptor,
  recordType: string,
  data: JsonValue,
): void {
  try {
    descriptor.validate(recordType, deepFreeze(clone(data)));
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause) throw cause;
    throw domainError('INVALID_PLUGIN', `Plugin "${descriptor.id}" validation failed`, {
      pluginId: descriptor.id,
      recordType,
      cause,
    });
  }
}

function validateToolInput(input: NormalizedToolInput, limits: ExtensionLimits): void {
  validateJson(input as unknown as JsonValue, limits, 'normalized plugin tool input');
  if (input.kind === 'pointer' && !finitePoint(input.point)) {
    throw domainError('INVALID_PLUGIN', 'Plugin pointer input must be finite');
  }
}

function validateCommand(command: PluginCommandProposal, limits: ExtensionLimits): void {
  if (command.kind === 'create' || command.kind === 'update') {
    assertExactKeys(command, command.kind === 'create'
      ? ['kind', 'recordType', 'data']
      : ['kind', 'id', 'recordType', 'data'], 'plugin command');
    validateStableId(command.recordType, 'plugin command record type');
    validateJson(command.data, limits, 'plugin command data');
    if (command.kind === 'update') validateStableId(command.id, 'plugin command id');
    return;
  }
  if (command.kind === 'remove') {
    assertExactKeys(command, ['kind', 'id'], 'plugin command');
    validateStableId(command.id, 'plugin command id');
    return;
  }
  throw domainError('INVALID_PLUGIN', 'Plugin command kind is invalid');
}

function validatePrimitiveBase(primitive: DeclarativePrimitive): void {
  const bounds = primitive.bounds;
  assertExactKeys(bounds, ['x', 'y', 'width', 'height'], 'plugin primitive bounds');
  if (![bounds.x, bounds.y, bounds.width, bounds.height, primitive.zIndex].every(Number.isFinite)
    || bounds.width < 0 || bounds.height < 0
    || [bounds.x, bounds.y, bounds.width, bounds.height, primitive.zIndex]
      .some((value) => Math.abs(value) > 1_000_000)) {
    throw domainError('INVALID_PLUGIN', 'Plugin primitive bounds or stacking is invalid');
  }
  const accessibility = primitive.accessibility;
  if (accessibility !== null && typeof accessibility === 'object') {
    assertExactKeys(accessibility, ['role', 'label', 'description'], 'plugin accessibility metadata');
  }
  if (accessibility === null || typeof accessibility !== 'object'
    || !['img', 'text', 'button', 'group'].includes(accessibility.role)
    || typeof accessibility.label !== 'string' || accessibility.label.length === 0
    || accessibility.label.length > 2_048) {
    throw domainError('INVALID_PLUGIN', 'Plugin primitive accessibility metadata is invalid');
  }
}

function validatePathCommand(command: DeclarativePathCommand): void {
  switch (command.command) {
    case 'move':
    case 'line':
      assertExactKeys(command, ['command', 'to'], 'plugin path command');
      if (!finitePoint(command.to)) throw domainError('INVALID_PLUGIN', 'Path endpoint must be finite');
      return;
    case 'quadratic':
      assertExactKeys(command, ['command', 'control', 'to'], 'plugin path command');
      if (!finitePoint(command.control) || !finitePoint(command.to)) {
        throw domainError('INVALID_PLUGIN', 'Quadratic path points must be finite');
      }
      return;
    case 'cubic':
      assertExactKeys(command, ['command', 'control1', 'control2', 'to'], 'plugin path command');
      if (!finitePoint(command.control1) || !finitePoint(command.control2) || !finitePoint(command.to)) {
        throw domainError('INVALID_PLUGIN', 'Cubic path points must be finite');
      }
      return;
    case 'close':
      assertExactKeys(command, ['command'], 'plugin path command');
      return;
  }
}

function validateJson(value: unknown, limits: ExtensionLimits, label: string): asserts value is JsonValue {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > limits.maximumNodes || depth > limits.maximumDepth) {
      throw domainError('INVALID_PLUGIN', `${label} exceeds nesting or node bounds`);
    }
    if (candidate === null || typeof candidate === 'boolean') return;
    if (typeof candidate === 'string') {
      if (candidate.length > limits.maximumStringLength) {
        throw domainError('INVALID_PLUGIN', `${label} contains an oversized string`);
      }
      return;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw domainError('INVALID_PLUGIN', `${label} contains a non-finite number`);
      return;
    }
    if (typeof candidate !== 'object' || seen.has(candidate)) {
      throw domainError('INVALID_PLUGIN', `${label} must be acyclic declarative JSON`);
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child, depth + 1);
    } else {
      for (const [key, child] of Object.entries(candidate)) {
        if (key.length === 0 || key.length > 256 || key === '__proto__' || key === 'constructor') {
          throw domainError('INVALID_PLUGIN', `${label} contains an unsafe key`, { key });
        }
        visit(child, depth + 1);
      }
    }
    seen.delete(candidate);
  };
  visit(value, 0);
}

function validateExtensionLimits(limits: ExtensionLimits): void {
  if (Object.values(limits).some((value) => !Number.isInteger(value) || value < 1)) {
    throw domainError('INVALID_PLUGIN', 'Extension limits must be positive integers');
  }
}

function validateStableId(id: string, label: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256
    || !/^[a-zA-Z][a-zA-Z0-9._:-]*$/u.test(id)) {
    throw domainError('INVALID_PLUGIN', `${label} is invalid`, { id });
  }
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw domainError('INVALID_PLUGIN', `${label} contains unsupported fields`, { unknown });
  }
}

function apiRangeIncludes(range: string, version: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === undefined) return false;
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === `${parsed.major}.x` || trimmed === `${parsed.major}`) return true;
  if (trimmed.startsWith('^')) {
    const minimum = parseVersion(trimmed.slice(1));
    return minimum !== undefined && compareVersions(parsed, minimum) >= 0 && parsed.major === minimum.major;
  }
  const exact = parseVersion(trimmed);
  if (exact !== undefined) return compareVersions(parsed, exact) === 0;
  const clauses = trimmed.split(/\s+/u);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => {
    const match = /^(>=|>|<=|<)(\d+\.\d+\.\d+)$/u.exec(clause);
    if (match === null) return false;
    const expected = parseVersion(match[2]!);
    if (expected === undefined) return false;
    const comparison = compareVersions(parsed, expected);
    return match[1] === '>=' ? comparison >= 0
      : match[1] === '>' ? comparison > 0
        : match[1] === '<=' ? comparison <= 0
          : comparison < 0;
  });
}

function parseVersion(version: string): Readonly<{ major: number; minor: number; patch: number }> | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  return match === null ? undefined : {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(
  left: Readonly<{ major: number; minor: number; patch: number }>,
  right: Readonly<{ major: number; minor: number; patch: number }>,
): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function canonicalJson(value: unknown): string {
  const order = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(order);
    if (candidate !== null && typeof candidate === 'object') {
      return Object.fromEntries(Object.entries(candidate)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, order(child)]));
    }
    return candidate;
  };
  return JSON.stringify(order(value));
}

function opaqueReference(reference: string): boolean {
  return typeof reference === 'string' && reference.length > 0 && reference.length <= 512
    && !/^(?:https?:|data:|blob:|file:|\/\/)/iu.test(reference)
    && !/[\u0000-\u001f]/u.test(reference);
}

function finitePoint(point: Vec2): boolean {
  return point !== null && typeof point === 'object'
    && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export type { JsonObject };
