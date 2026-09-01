import { AdapterError } from './errors.js';
import {
  compositeKey,
  splitCompositeKey,
  type Diagnostic,
  type TagTextAdapter,
  type TagTextInvalidation,
} from './host.js';
import type { BuiltInContent, TagReference, Unsubscribe } from './types.js';

/**
 * What a tag shows while its value is still being looked up, or could not be found.
 *
 * A drafter reads a question mark as "unknown" and moves on. A blank tag reads as a broken drawing.
 */
export const UNRESOLVED_TAG_TEXT = '?';

/**
 * A tag shows a mark, a rating, a door number. Anything longer than this is not a tag value, and
 * drawing it would push a label across the whole screen.
 */
const MAX_RESOLVED_LENGTH = 2_048;

interface PendingTag {
  readonly controller: AbortController;
  readonly owners: Set<string>;
}

interface TagTextHooks {
  readonly invalidate: () => void;
  readonly diagnostic: (diagnostic: Diagnostic) => void;
}

/**
 * Looks up the live text behind referenced tags — a door number, a fire rating — by asking the host
 * about the model element the tag points at.
 *
 * Lookups are asynchronous, but drawing a frame is not, so a frame never waits: it draws whatever
 * is known right now, and asks for a redraw when an answer arrives.
 *
 * Nothing here is ever saved. A resolved value is a cache that dies with the session, so opening a
 * drawing always shows what the model says today rather than what it said when the note was
 * written — and resolving a tag never lands in the undo history.
 */
export class TagTextResolutionManager {
  readonly #adapter: TagTextAdapter | undefined;
  readonly #hooks: TagTextHooks;
  readonly #resolved = new Map<string, string>();
  /** References the host had no answer for. Remembered so the same dead lookup is not retried on
   *  every single frame. */
  readonly #unresolvable = new Set<string>();
  /** References the host says have changed. The old value keeps drawing until the new one arrives,
   *  so the drawing does not flash. */
  readonly #stale = new Set<string>();
  readonly #pending = new Map<string, PendingTag>();
  readonly #ownerKeys = new Map<string, string>();
  #unsubscribe: Unsubscribe | undefined;
  #disposed = false;

  public constructor(adapter: TagTextAdapter | undefined, hooks: TagTextHooks) {
    this.#adapter = adapter;
    this.#hooks = hooks;
    // If subscribing throws, construction fails and the error reaches the host. An adapter that
    // cannot even connect is a setup mistake, and hiding it would leave every tag silently stuck.
    if (adapter?.subscribe !== undefined) {
      this.#unsubscribe = adapter.subscribe((invalidation) => this.#invalidate(invalidation));
    }
  }

  /**
   * Swaps the looked-up text into a tag, giving the frame the content it should actually draw.
   *
   * Anything else passes straight through unchanged — a tag with no reference, a host that does not
   * do lookups, any other kind of content — so nothing has to know whether this feature is in use.
   */
  public apply(ownerId: string, content: BuiltInContent): BuiltInContent {
    if (this.#disposed || this.#adapter === undefined) return content;
    if (content.kind !== 'tag' || content.reference === undefined) return content;
    return { ...content, text: this.#read(ownerId, content.reference) };
  }

  /** Cancels lookups for annotations that have been deleted or are no longer referenced tags. */
  public retainOwners(ownerIds: ReadonlySet<string>): void {
    for (const ownerId of [...this.#ownerKeys.keys()]) {
      if (!ownerIds.has(ownerId)) this.#release(ownerId);
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    for (const pending of this.#pending.values()) pending.controller.abort();
    this.#pending.clear();
    this.#ownerKeys.clear();
    this.#resolved.clear();
    this.#unresolvable.clear();
    this.#stale.clear();
    try { unsubscribe?.(); } catch { /* borrowed adapter cleanup is best-effort */ }
  }

  #read(ownerId: string, reference: TagReference): string {
    const key = referenceKey(reference);
    this.#connectOwner(ownerId, key);
    const resolved = this.#resolved.get(key);
    if (resolved !== undefined && !this.#stale.has(key)) return resolved;
    if (!this.#unresolvable.has(key)) this.#request(key, reference, ownerId);
    // Keep showing the old value while fetching the new one. A host that reports a change on every
    // model edit would otherwise make every tag on the drawing blink to "?" and back.
    return resolved ?? UNRESOLVED_TAG_TEXT;
  }

  #connectOwner(ownerId: string, key: string): void {
    const before = this.#ownerKeys.get(ownerId);
    if (before === key) return;
    if (before !== undefined) this.#release(ownerId);
    this.#ownerKeys.set(ownerId, key);
    this.#pending.get(key)?.owners.add(ownerId);
  }

  #release(ownerId: string): void {
    const key = this.#ownerKeys.get(ownerId);
    if (key === undefined) return;
    this.#ownerKeys.delete(ownerId);
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    pending.owners.delete(ownerId);
    if (pending.owners.size === 0) {
      pending.controller.abort();
      this.#pending.delete(key);
    }
  }

  /** One lookup per distinct reference, no matter how many annotations point at it — twenty tags
   *  on the same door ask the host once. */
  #request(key: string, reference: TagReference, ownerId: string): void {
    const adapter = this.#adapter;
    const existing = this.#pending.get(key);
    if (adapter === undefined || existing !== undefined) {
      existing?.owners.add(ownerId);
      return;
    }
    const controller = new AbortController();
    const pending: PendingTag = { controller, owners: new Set([ownerId]) };
    this.#pending.set(key, pending);
    let promise: Promise<string | null>;
    try {
      promise = adapter.resolve(
        Object.freeze({
          modelId: reference.modelId,
          elementId: reference.elementId,
          property: reference.property,
        }),
        controller.signal,
      );
    } catch (cause) {
      promise = Promise.reject(cause);
    }
    void Promise.resolve(promise).then(
      (text) => {
        if (!this.#isCurrent(key, pending)) return;
        if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_RESOLVED_LENGTH) {
          this.#giveUp(key, {
            code: 'TAG_TEXT_UNRESOLVED',
            severity: 'warning',
            message: `Tag text is unresolved: the host returned no usable value for ${describe(reference)}`,
          });
          return;
        }
        this.#pending.delete(key);
        this.#stale.delete(key);
        this.#resolved.set(key, text);
        this.#hooks.invalidate();
      },
      (cause: unknown) => {
        if (!this.#isCurrent(key, pending)) return;
        const error = new AdapterError('tag text resolution', cause, { ...reference });
        this.#giveUp(key, {
          code: 'TAG_TEXT_RESOLUTION_FAILED',
          severity: 'warning',
          message: error.message,
          error,
        });
      },
    );
  }

  /** Nothing usable came back. The tag reads unknown, any previous value is dropped, and this
   *  reference is not asked about again until the host says it has changed. */
  #giveUp(key: string, diagnostic: Diagnostic): void {
    this.#pending.delete(key);
    this.#resolved.delete(key);
    this.#stale.delete(key);
    this.#unresolvable.add(key);
    this.#hooks.diagnostic(diagnostic);
    this.#hooks.invalidate();
  }

  #isCurrent(key: string, pending: PendingTag): boolean {
    return !this.#disposed
      && this.#pending.get(key) === pending
      && pending.owners.size > 0
      && !pending.controller.signal.aborted;
  }

  #invalidate(invalidation: TagTextInvalidation): void {
    if (this.#disposed) return;
    for (const key of [...this.#resolved.keys()]) {
      if (matches(key, invalidation)) this.#stale.add(key);
    }
    for (const key of [...this.#unresolvable]) {
      if (matches(key, invalidation)) this.#unresolvable.delete(key);
    }
    for (const [key, pending] of [...this.#pending]) {
      if (!matches(key, invalidation)) continue;
      pending.controller.abort();
      this.#pending.delete(key);
    }
    this.#hooks.invalidate();
  }
}

function referenceKey(reference: TagReference): string {
  return compositeKey(reference.modelId, reference.elementId, reference.property);
}

function matches(key: string, invalidation: TagTextInvalidation): boolean {
  const [modelId, elementId, property] = splitCompositeKey(key);
  return (invalidation.modelId === undefined || invalidation.modelId === modelId)
    && (invalidation.elementId === undefined || invalidation.elementId === elementId)
    && (invalidation.property === undefined || invalidation.property === property);
}

function describe(reference: TagReference): string {
  return `${reference.modelId}/${reference.elementId}.${reference.property}`;
}
