import { DEFAULT_IMAGE_HEIGHT, DEFAULT_IMAGE_WIDTH } from './content.js';
import { AdapterError, domainError, InvalidInputError } from './errors.js';
import type { HostImageAdapter, ResolvedHostImage } from './host.js';
import type { HostImageContent } from './types.js';

// Loads the images that annotations point at, without ever making a frame wait for one.
//
// Annotations reference images by name — a photo, a detail drawing — and the host turns that name
// into something drawable. That takes time, so drawing a frame never blocks on it: a label shows a
// placeholder box at the right size, and the frame is redrawn once the picture arrives.
export type ImageDiagnostic = AdapterError;

export interface ImageRuntimeHooks {
  readonly invalidate: () => void;
  readonly diagnostic: (diagnostic: ImageDiagnostic) => void;
}

export type ImageFrameState =
  | {
      readonly status: 'pending';
      readonly bounds: Readonly<{ width: number; height: number }>;
      readonly alt: string;
      readonly placeholder: true;
    }
  | {
      readonly status: 'failed';
      readonly bounds: Readonly<{ width: number; height: number }>;
      readonly alt: string;
      readonly placeholder: true;
    }
  | {
      readonly status: 'ready';
      readonly bounds: Readonly<{ width: number; height: number }>;
      readonly intrinsic: Readonly<{ width: number; height: number }>;
      readonly alt: string;
      readonly source: string;
      readonly placeholder: false;
    };

interface PendingImage {
  readonly controller: AbortController;
  readonly owners: Set<string>;
  readonly generation: number;
}

/**
 * Keeps track of which images are loading, loaded, or failed.
 *
 * Asking for an image always answers immediately with whatever is known right now, so drawing never
 * stalls. Requests are made once per image no matter how many annotations use it, and a redraw is
 * asked for when one finishes.
 */
export class ImageResolutionManager {
  readonly #adapter: HostImageAdapter | undefined;
  readonly #hooks: ImageRuntimeHooks;
  readonly #resolved = new Map<string, ResolvedHostImage>();
  readonly #failed = new Set<string>();
  readonly #pending = new Map<string, PendingImage>();
  readonly #ownerReferences = new Map<string, string>();
  #generation = 0;
  #disposed = false;

  public constructor(adapter: HostImageAdapter | undefined, hooks: ImageRuntimeHooks) {
    this.#adapter = adapter;
    this.#hooks = hooks;
  }

  /** Answers straight away from what has already loaded, starting a load in the background if this
   *  image has not been asked for yet. */
  public read(ownerId: string, content: HostImageContent): ImageFrameState {
    this.#assertActive();
    validateHostImageContent(content);
    this.#connectOwner(ownerId, content.reference);
    const resolved = this.#resolved.get(content.reference);
    if (resolved !== undefined) {
      return {
        status: 'ready',
        bounds: imageBounds(content, resolved),
        intrinsic: { width: resolved.width, height: resolved.height },
        alt: content.alt,
        source: resolved.source,
        placeholder: false,
      };
    }
    if (this.#failed.has(content.reference)) {
      return placeholder('failed', content);
    }
    this.#request(content.reference, ownerId);
    return placeholder('pending', content);
  }

  /** Stops caring about an annotation's image, cancelling the download if nothing else wants it.
   *  Called when an annotation is deleted or changed to point somewhere else. */
  public release(ownerId: string): void {
    const reference = this.#ownerReferences.get(ownerId);
    if (reference === undefined) return;
    this.#ownerReferences.delete(ownerId);
    const pending = this.#pending.get(reference);
    if (pending === undefined) return;
    pending.owners.delete(ownerId);
    if (pending.owners.size === 0) {
      pending.controller.abort();
      this.#pending.delete(reference);
    }
  }

  /** Drops every annotation's claim on an image, for when the whole document is replaced. Already
   *  loaded images are kept, so reopening the same drawing does not download them all again. */
  public releaseAllOwners(): void {
    for (const pending of this.#pending.values()) pending.controller.abort();
    this.#pending.clear();
    this.#ownerReferences.clear();
    this.#generation += 1;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.releaseAllOwners();
    this.#resolved.clear();
    this.#failed.clear();
  }

  #connectOwner(ownerId: string, reference: string): void {
    const before = this.#ownerReferences.get(ownerId);
    if (before === reference) return;
    if (before !== undefined) this.release(ownerId);
    this.#ownerReferences.set(ownerId, reference);
    this.#pending.get(reference)?.owners.add(ownerId);
  }

  #request(reference: string, ownerId: string): void {
    const adapter = this.#adapter;
    if (adapter === undefined || this.#pending.has(reference)) {
      this.#pending.get(reference)?.owners.add(ownerId);
      return;
    }
    const controller = new AbortController();
    const generation = this.#generation;
    const pending: PendingImage = { controller, generation, owners: new Set([ownerId]) };
    this.#pending.set(reference, pending);
    // Wrapped so a host that throws synchronously fails this image, not the frame being drawn.
    void new Promise<ResolvedHostImage>((resolve) => {
      resolve(adapter.resolve(reference, controller.signal));
    }).then(
      (image) => {
        if (!this.#isCurrent(reference, pending) || controller.signal.aborted) return;
        try {
          validateResolvedImage(image);
        } catch (cause) {
          this.#fail(reference, pending, cause);
          return;
        }
        this.#pending.delete(reference);
        this.#failed.delete(reference);
        this.#resolved.set(reference, { ...image });
        this.#hooks.invalidate();
      },
      (cause: unknown) => {
        this.#fail(reference, pending, cause);
      },
    );
  }

  #isCurrent(reference: string, pending: PendingImage): boolean {
    return !this.#disposed
      && pending.generation === this.#generation
      && this.#pending.get(reference) === pending
      && pending.owners.size > 0;
  }

  #fail(reference: string, pending: PendingImage, cause: unknown): void {
    if (!this.#isCurrent(reference, pending) || pending.controller.signal.aborted) return;
    this.#pending.delete(reference);
    this.#failed.add(reference);
    this.#hooks.diagnostic(new AdapterError('image resolution', cause, { reference }));
    this.#hooks.invalidate();
  }

  #assertActive(): void {
    if (this.#disposed) throw new InvalidInputError('Image resolution manager is disposed');
  }
}

export function validateHostImageContent(content: HostImageContent): void {
  if (content === null || typeof content !== 'object' || content.kind !== 'host-image') {
    throw domainError('INVALID_IMAGE', 'Image content must be a host-image record');
  }
  if (typeof content.reference !== 'string' || content.reference.length === 0
    || content.reference.length > 512) {
    throw domainError('INVALID_IMAGE', 'Image reference must contain 1–512 characters');
  }
  if (/^(?:https?:|data:|blob:|file:|\/\/)/iu.test(content.reference)
    || /[\u0000-\u001f]/u.test(content.reference)) {
    throw domainError('INVALID_IMAGE', 'Image references must be opaque host identifiers', {
      reference: content.reference,
    });
  }
  if (typeof content.alt !== 'string' || content.alt.length === 0 || content.alt.length > 2_048) {
    throw domainError('INVALID_IMAGE', 'Image alternative text must contain 1–2048 characters');
  }
  if ((content.width !== undefined && (!Number.isFinite(content.width)
      || content.width <= 0 || content.width > 16_384))
    || (content.height !== undefined && (!Number.isFinite(content.height)
      || content.height <= 0 || content.height > 16_384))) {
    throw domainError('INVALID_IMAGE', 'Image layout bounds must be finite, positive, and bounded');
  }
}

function validateResolvedImage(image: ResolvedHostImage): void {
  if (image === null || typeof image !== 'object'
    || typeof image.source !== 'string' || image.source.length === 0
    || !Number.isFinite(image.width) || !Number.isFinite(image.height)
    || image.width <= 0 || image.height <= 0
    || image.width > 65_536 || image.height > 65_536) {
    throw domainError('INVALID_IMAGE', 'Host image adapter returned an invalid decoded image');
  }
}

function placeholder(
  status: 'pending' | 'failed',
  content: HostImageContent,
): ImageFrameState {
  return {
    status,
    bounds: imageBounds(content),
    alt: content.alt,
    placeholder: true,
  };
}

/**
 * Picks the size to draw an image at: the size the author asked for, or failing that the image's
 * own size, or failing that a placeholder box.
 */
function imageBounds(
  content: HostImageContent,
  intrinsic?: Readonly<{ width: number; height: number }>,
): Readonly<{ width: number; height: number }> {
  return {
    width: content.width ?? intrinsic?.width ?? DEFAULT_IMAGE_WIDTH,
    height: content.height ?? intrinsic?.height ?? DEFAULT_IMAGE_HEIGHT,
  };
}

export type { HostImageContent };
