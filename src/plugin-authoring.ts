import type { DocumentEngine } from './document.js';
import { domainError, DisposedError } from './errors.js';
import {
  type DeclarativePrimitive,
  type ExtensionRuntime,
  type NormalizedToolInput,
  type PluginCommandProposal,
  type PluginToolTransition,
} from './extensions.js';
import type { InteractionAdapter, InteractionLease } from './host.js';
import type { ViewLeaderRuntime } from './runtime.js';
import type {
  AnnotationDraft,
  JsonValue,
  SnapshotStamp,
  Unsubscribe,
} from './types.js';

export type PluginAnnotationDraft = Omit<AnnotationDraft, 'content'>;

export interface StartPluginToolOptions {
  readonly pluginId: string;
  readonly toolId: string;
  /** Needed when the tool wants to create a new annotation rather than change an existing one. */
  readonly draft?: PluginAnnotationDraft;
}

export interface PluginAuthoringSnapshot extends SnapshotStamp {
  readonly phase: 'idle' | 'active';
  readonly pluginId: string | null;
  readonly toolId: string | null;
  readonly state: JsonValue | null;
  readonly preview: readonly DeclarativePrimitive[];
  readonly status: string;
}

export interface PluginAuthoringCapability {
  getSnapshot(): PluginAuthoringSnapshot;
  subscribe(listener: () => void): Unsubscribe;
  start(options: StartPluginToolOptions): PluginAuthoringSnapshot;
  dispatch(input: NormalizedToolInput): PluginAuthoringSnapshot;
  cancel(reason?: 'user' | 'preempted'): PluginAuthoringSnapshot;
}

interface ActivePluginTool {
  readonly pluginId: string;
  readonly toolId: string;
  readonly draft?: PluginAnnotationDraft;
  readonly lease?: InteractionLease;
  state: JsonValue;
  preview: readonly DeclarativePrimitive[];
  status: string;
}

/**
 * Runs a plugin's drawing tool and is the only thing allowed to turn what a plugin proposes into a
 * real change to the document.
 *
 * Plugins never write to the document themselves. They describe what they would like to happen and
 * it is checked here first, so a broken plugin cannot corrupt a drawing.
 */
export class PluginAuthoringController {
  readonly #document: DocumentEngine;
  readonly #extensions: ExtensionRuntime;
  readonly #runtime: ViewLeaderRuntime;
  readonly #interaction: InteractionAdapter | undefined;
  readonly #preemptBuiltIn: () => void;
  readonly #documentUnsubscribe: Unsubscribe;
  #active: ActivePluginTool | undefined;
  #status = 'Plugin authoring inactive';
  #disposed = false;

  public constructor(options: Readonly<{
    document: DocumentEngine;
    extensions: ExtensionRuntime;
    runtime: ViewLeaderRuntime;
    interaction?: InteractionAdapter;
    preemptBuiltIn: () => void;
  }>) {
    this.#document = options.document;
    this.#extensions = options.extensions;
    this.#runtime = options.runtime;
    this.#interaction = options.interaction;
    this.#preemptBuiltIn = options.preemptBuiltIn;
    this.#documentUnsubscribe = this.#document.subscribe((commit) => {
      if (commit.kind !== 'replacement' || this.#active === undefined) return;
      try {
        this.#cancelActive('preempted', 'Plugin authoring cancelled because the document changed', false);
      } catch {
        // If the document has already been replaced underneath us, the proposal is about a
        // drawing that no longer exists. Drop it rather than applying it to the new one.
      }
    });
  }

  public getSnapshot(): PluginAuthoringSnapshot {
    this.#assertActive();
    const stamp = this.#runtime.documentsSnapshot();
    return this.#snapshot(stamp);
  }

  public subscribe(listener: () => void): Unsubscribe {
    this.#assertActive();
    return this.#runtime.subscribe(listener);
  }

  public start(options: StartPluginToolOptions): PluginAuthoringSnapshot {
    this.#assertActive();
    this.cancel('preempted');
    this.#preemptBuiltIn();
    const state = this.#extensions.beginTool(options.pluginId, options.toolId);
    const lease = this.#interaction?.acquire('authoring');
    this.#active = {
      pluginId: options.pluginId,
      toolId: options.toolId,
      ...(options.draft === undefined ? {} : { draft: structuredClone(options.draft) }),
      ...(lease === undefined ? {} : { lease }),
      state,
      preview: Object.freeze([]),
      status: `Plugin tool ${options.toolId} active`,
    };
    this.#runtime.setPluginAuthoringPreview([]);
    this.#status = this.#active.status;
    this.#runtime.publishTransientChange();
    return this.getSnapshot();
  }

  public dispatch(input: NormalizedToolInput): PluginAuthoringSnapshot {
    this.#assertActive();
    const active = this.#active;
    if (active === undefined) {
      throw domainError('INVALID_PLUGIN', 'No plugin authoring tool is active');
    }
    let transition: PluginToolTransition;
    try {
      transition = this.#extensions.runTool(
        active.pluginId,
        active.toolId,
        active.state,
        input,
      );
      if (transition.outcome === 'cancelled' && transition.command !== undefined) {
        throw domainError('INVALID_PLUGIN', 'A cancelled plugin tool cannot propose a command', {
          pluginId: active.pluginId,
          toolId: active.toolId,
        });
      }
      const acceptTransition = (): void => {
        active.state = structuredClone(transition.state);
        active.preview = Object.freeze(structuredClone(transition.preview ?? []));
        this.#runtime.setPluginAuthoringPreview(active.preview);
        active.status = transition.status ?? active.status;
        this.#status = active.status;
        if (transition.outcome !== undefined) {
          const status = transition.outcome === 'completed'
            ? (transition.status ?? `Plugin tool ${active.toolId} completed`)
            : (transition.status ?? `Plugin tool ${active.toolId} cancelled`);
          this.#finish(status, false);
        }
      };
      if (transition.command !== undefined) {
        const revision = this.#document.documentRevision;
        this.#document.transaction('Plugin authoring command', () => {
          this.#applyCommand(active, transition.command!);
          acceptTransition();
        });
        if (this.#document.documentRevision === revision) {
          this.#runtime.publishTransientChange(transition.preview !== undefined);
        }
      } else {
        acceptTransition();
        this.#runtime.publishTransientChange(transition.preview !== undefined);
      }
    } catch (error) {
      this.#finish(`Plugin tool ${active.toolId} failed`);
      throw error;
    }
    return this.getSnapshot();
  }

  public cancel(reason: 'user' | 'preempted' = 'user'): PluginAuthoringSnapshot {
    this.#assertActive();
    this.#cancelActive(
      reason,
      reason === 'preempted' ? 'Plugin authoring preempted' : 'Plugin authoring cancelled',
      true,
    );
    return this.getSnapshot();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#documentUnsubscribe();
    const active = this.#active;
    if (active !== undefined) {
      try {
        this.#extensions.runTool(active.pluginId, active.toolId, active.state, {
          kind: 'cancel',
          reason: 'disposed',
        });
      } finally {
        this.#finish('Plugin authoring disposed', false);
      }
    }
  }

  #cancelActive(
    reason: 'user' | 'preempted',
    status: string,
    publish: boolean,
  ): void {
    const active = this.#active;
    if (active === undefined) return;
    try {
      this.#extensions.runTool(active.pluginId, active.toolId, active.state, {
        kind: 'cancel',
        reason,
      });
    } finally {
      this.#finish(status, publish);
    }
  }

  #applyCommand(active: ActivePluginTool, command: PluginCommandProposal): void {
    if (command.kind === 'remove') {
      this.#document.remove(command.id, 'Plugin remove annotation');
      return;
    }
    if (command.recordType !== 'content') {
      throw domainError('INVALID_PLUGIN', 'Public plugin tools may commit only content records', {
        pluginId: active.pluginId,
        recordType: command.recordType,
      });
    }
    const content = this.#extensions.contentFromTool(
      active.pluginId,
      command.recordType,
      command.data,
    );
    if (command.kind === 'update') {
      this.#document.update(command.id, { content }, 'Plugin update annotation');
      return;
    }
    if (active.draft === undefined) {
      throw domainError('INVALID_PLUGIN', 'Plugin create command requires a start draft', {
        pluginId: active.pluginId,
        toolId: active.toolId,
      });
    }
    this.#document.create({ ...active.draft, content }, 'Plugin create annotation');
  }

  #finish(status: string, publish = true): void {
    const active = this.#active;
    this.#active = undefined;
    this.#runtime.setPluginAuthoringPreview([]);
    try { active?.lease?.release(); } catch { /* the lease is still logically released */ }
    this.#status = status;
    if (publish) this.#runtime.publishTransientChange(true);
  }

  #snapshot(stamp: SnapshotStamp): PluginAuthoringSnapshot {
    const active = this.#active;
    return Object.freeze({
      runtimeRevision: stamp.runtimeRevision,
      documentRevision: stamp.documentRevision,
      phase: active === undefined ? 'idle' : 'active',
      pluginId: active?.pluginId ?? null,
      toolId: active?.toolId ?? null,
      state: active === undefined ? null : immutableClone(active.state),
      preview: active === undefined
        ? Object.freeze([])
        : immutableClone(active.preview),
      status: this.#status,
    });
  }

  #assertActive(): void {
    if (this.#disposed) throw new DisposedError();
  }
}

function immutableClone<Value>(value: Value): Value {
  const clone = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) return;
    Object.freeze(candidate);
    for (const child of Object.values(candidate)) freeze(child);
  };
  freeze(clone);
  return clone;
}
