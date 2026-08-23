import { AdapterError, InvalidInputError } from './errors.js';
import type { OcclusionAdapter } from './host.js';
import type { Vec2, Vec3 } from './types.js';

// Works out which annotations are pointing at something hidden behind other geometry, so a leader
// line into a wall can be faded or dropped instead of looking like it points at the wall itself.
//
// Answers are always given from the last completed check; nothing here makes a frame wait. The host
// does the actual testing, in batches, in the background.
export type OcclusionPolicy = 'keep' | 'fade' | 'hide';

export interface OcclusionCandidate {
  readonly id: string;
  /** The leader line as it will actually be drawn, after labels have been placed and routed —
   *  testing anything earlier would answer for a line that is not on screen. */
  readonly routes: readonly (readonly Vec2[])[];
  readonly samples?: readonly Readonly<{ legId: string; worldPoint: Vec3 }>[];
}

export function occlusionPortFromAdapter(adapter: OcclusionAdapter): HostOcclusionPort {
  return {
    resolveBatch: async ({ candidates, signal }) => {
      const samples = candidates.flatMap((candidate) => (candidate.samples ?? []).map((sample) => ({
        annotationId: candidate.id,
        legId: sample.legId,
        worldPoint: { ...sample.worldPoint },
      })));
      const resolved = await adapter.test(samples, signal);
      return candidates.map((candidate) => {
        const expected = candidate.samples ?? [];
        const byLeg = new Map(resolved
          .filter(({ annotationId }) => annotationId === candidate.id)
          .map((result) => [result.legId, result.occluded]));
        // Listed in the annotation's own leg order rather than the order the host answered in.
        // What gets drawn has to be reproducible from the drawing plan alone, and a host is free
        // to answer in any order it likes.
        const occludedLegIds = expected
          .filter(({ legId }) => byLeg.get(legId) === true)
          .map(({ legId }) => legId);
        return {
          id: candidate.id,
          // An annotation with several legs still earns its place while any one of them is
          // visible — only hide it when every leg is buried.
          occluded: expected.length > 0 && occludedLegIds.length === expected.length,
          // Which legs are hidden is kept as well as whether any are, because the renderer needs
          // to dash the buried ones while leaving the visible ones at full strength.
          ...(occludedLegIds.length === 0 ? {} : { occludedLegIds }),
        };
      });
    },
  };
}

export interface OcclusionResult {
  readonly id: string;
  readonly occluded: boolean;
  /** Left out entirely rather than sent as an empty list, so a host that answers per annotation
   *  instead of per leg does not have to fabricate one. */
  readonly occludedLegIds?: readonly string[];
}

export interface OcclusionBatchRequest {
  readonly candidates: readonly OcclusionCandidate[];
  readonly signal: AbortSignal;
}

export interface HostOcclusionPort {
  resolveBatch(request: OcclusionBatchRequest): Promise<readonly OcclusionResult[]>;
}

export interface OcclusionRuntimeHooks {
  readonly invalidate: () => void;
  readonly diagnostic: (diagnostic: AdapterError) => void;
}

export interface OcclusionPresentation {
  readonly id: string;
  readonly visible: boolean;
  readonly opacity: number;
  /**
   * Which individual legs are hidden, not merely whether the annotation as a whole is.
   *
   * A note with three leader lines, two of them disappearing into a floor slab, should draw those
   * two differently from the one you can see. Opacity and visibility apply to the whole annotation
   * and cannot express that.
   */
  readonly occludedLegIds?: readonly string[];
}

interface CompletedBatch {
  readonly signature: string;
  readonly results: ReadonlyMap<string, OcclusionResult>;
}

interface PendingBatch {
  readonly signature: string;
  readonly controller: AbortController;
  readonly generation: number;
}

/**
 * Remembers what the host last said about which annotations are hidden, and asks it for a fresh
 * answer in the background.
 *
 * Entirely optional: with no host support every annotation simply counts as visible.
 */
export class OcclusionManager {
  readonly #port: HostOcclusionPort | undefined;
  readonly #hooks: OcclusionRuntimeHooks;
  #pending: PendingBatch | undefined;
  #completed: CompletedBatch | undefined;
  #generation = 0;
  #disposed = false;

  public constructor(port: HostOcclusionPort | undefined, hooks: OcclusionRuntimeHooks) {
    this.#port = port;
    this.#hooks = hooks;
  }

  /**
   * Answers from the last completed check and starts at most one new one. Anything unknown, still
   * running or failed counts as visible, so a missing answer never hides an annotation.
   *
   * Slightly out-of-date answers are used rather than thrown away. Every leader line moves as the
   * camera turns, so an answer that had to match the current frame exactly would only ever arrive
   * once the camera stopped. Reusing the previous one is wrong for a frame or two during an orbit;
   * discarding it would leave leader lines running into walls for as long as you keep looking.
   */
  public present(
    candidates: readonly OcclusionCandidate[],
    policies: ReadonlyMap<string, OcclusionPolicy>,
  ): readonly OcclusionPresentation[] {
    this.#assertActive();
    validateCandidates(candidates);
    const signature = batchSignature(candidates);
    if (this.#port !== undefined && this.#completed?.signature !== signature) {
      this.#request(signature, candidates);
    }
    const current = this.#completed?.results;
    return candidates.map(({ id }) => {
      const result = current?.get(id);
      const policy = policies.get(id) ?? 'keep';
      return applyOcclusionPolicy(id, policy, result?.occluded ?? false, result?.occludedLegIds ?? []);
    });
  }

  public reset(): void {
    this.#generation += 1;
    this.#pending?.controller.abort();
    this.#pending = undefined;
    this.#completed = undefined;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.reset();
  }

  #request(signature: string, candidates: readonly OcclusionCandidate[]): void {
    if (this.#pending?.signature === signature || this.#port === undefined) return;
    this.#pending?.controller.abort();
    const controller = new AbortController();
    const pending: PendingBatch = { signature, controller, generation: this.#generation };
    this.#pending = pending;
    const ownedCandidates = candidates.map((candidate) => ({
      id: candidate.id,
      routes: candidate.routes.map((route) => route.map((point) => ({ ...point }))),
      ...(candidate.samples === undefined ? {} : {
        samples: candidate.samples.map((sample) => ({
          legId: sample.legId,
          worldPoint: { ...sample.worldPoint },
        })),
      }),
    }));
    void this.#port.resolveBatch({ candidates: ownedCandidates, signal: controller.signal }).then(
      (results) => {
        if (!this.#isCurrent(pending)) return;
        let normalized: ReadonlyMap<string, OcclusionResult>;
        try {
          normalized = validateResults(results, ownedCandidates);
        } catch (cause) {
          this.#fail(pending, cause);
          return;
        }
        this.#pending = undefined;
        const previous = this.#completed?.results;
        this.#completed = { signature, results: normalized };
        // Only redraw when an answer actually changed.
        //
        // Otherwise there is a loop with no exit: a redraw moves the leader lines slightly, moved
        // lines look like a new question, the new question returns the same answers, and those
        // answers trigger another redraw. Because it all happens without waiting for the next
        // frame, the page stops drawing and stops responding — with the camera completely still.
        if (previous === undefined || !sameResults(previous, normalized)) this.#hooks.invalidate();
      },
      (cause: unknown) => {
        this.#fail(pending, cause);
      },
    );
  }

  #isCurrent(pending: PendingBatch): boolean {
    return !this.#disposed
      && !pending.controller.signal.aborted
      && pending.generation === this.#generation
      && this.#pending === pending;
  }

  #fail(pending: PendingBatch, cause: unknown): void {
    if (!this.#isCurrent(pending)) return;
    this.#pending = undefined;
    const previous = this.#completed?.results;
    this.#completed = { signature: pending.signature, results: new Map() };
    this.#hooks.diagnostic(new AdapterError('batched occlusion', cause));
    // Guarded the same way, for the same reason: a host that fails every request would otherwise
    // spin the same endless loop, one failure at a time.
    if (previous === undefined || previous.size !== 0) this.#hooks.invalidate();
  }

  #assertActive(): void {
    if (this.#disposed) throw new InvalidInputError('Occlusion manager is disposed');
  }
}

export function applyOcclusionPolicy(
  id: string,
  policy: OcclusionPolicy,
  occluded: boolean,
  occludedLegIds: readonly string[] = [],
): OcclusionPresentation {
  if (policy !== 'keep' && policy !== 'fade' && policy !== 'hide') {
    throw new InvalidInputError(`Unsupported occlusion policy "${String(policy)}"`, { policy });
  }
  // Reported for every policy that still draws something. It matters most for `keep`, where the
  // annotation counts as visible overall and the individual buried legs are the only thing left to
  // show differently. `hide` draws nothing at all, so naming its legs would be pointless.
  const legs = occludedLegIds.length === 0 ? {} : { occludedLegIds };
  if (!occluded || policy === 'keep') return { id, visible: true, opacity: 1, ...legs };
  if (policy === 'fade') return { id, visible: true, opacity: 0.25, ...legs };
  return { id, visible: false, opacity: 0 };
}

function validateCandidates(candidates: readonly OcclusionCandidate[]): void {
  if (!Array.isArray(candidates) || candidates.length > 10_000) {
    throw new InvalidInputError('Occlusion batch exceeds the supported size');
  }
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate.id !== 'string' || candidate.id.length === 0 || ids.has(candidate.id)) {
      throw new InvalidInputError('Occlusion candidates require unique non-empty ids', {
        id: candidate.id,
      });
    }
    ids.add(candidate.id);
    if (!Array.isArray(candidate.routes) || candidate.routes.length === 0 || candidate.routes.length > 64) {
      throw new InvalidInputError('Occlusion candidates require 1–64 final routes');
    }
    for (const route of candidate.routes) {
      if (!Array.isArray(route) || route.length < 2 || route.length > 128
        || route.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
        throw new InvalidInputError('Occlusion route geometry is invalid', { id: candidate.id });
      }
    }
    for (const sample of candidate.samples ?? []) {
      if (typeof sample.legId !== 'string' || sample.legId.length === 0
        || ![sample.worldPoint.x, sample.worldPoint.y, sample.worldPoint.z].every(Number.isFinite)) {
        throw new InvalidInputError('Occlusion world sample is invalid', { id: candidate.id });
      }
    }
  }
}

function validateResults(
  results: readonly OcclusionResult[],
  candidates: readonly OcclusionCandidate[],
): ReadonlyMap<string, OcclusionResult> {
  if (!Array.isArray(results)) throw new InvalidInputError('Occlusion adapter result must be an array');
  const allowed = new Set(candidates.map(({ id }) => id));
  const normalized = new Map<string, OcclusionResult>();
  for (const result of results) {
    if (!allowed.has(result.id) || normalized.has(result.id) || typeof result.occluded !== 'boolean'
      || (result.occludedLegIds !== undefined && (!Array.isArray(result.occludedLegIds)
        || result.occludedLegIds.some((legId: unknown) => typeof legId !== 'string')))) {
      throw new InvalidInputError('Occlusion adapter returned an invalid result', { id: result.id });
    }
    // Copied rather than referenced. These answers outlive the request, and a host that held on
    // to its own array could otherwise change an answer the renderer is in the middle of using.
    normalized.set(result.id, {
      id: result.id,
      occluded: result.occluded,
      ...(result.occludedLegIds === undefined ? {} : { occludedLegIds: [...result.occludedLegIds] }),
    });
  }
  return normalized;
}

/** Whether two sets of answers agree, and therefore whether redrawing could change anything. */
function sameResults(
  left: ReadonlyMap<string, OcclusionResult>,
  right: ReadonlyMap<string, OcclusionResult>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, result] of left) {
    const other = right.get(id);
    if (other === undefined || other.occluded !== result.occluded) return false;
    // Order is compared, not just membership. Leg ids are always produced in the annotation's own
    // order, so two identical answers always arrive identically ordered — which makes a difference
    // in order a real difference in the answer.
    const before = result.occludedLegIds ?? [];
    const after = other.occludedLegIds ?? [];
    if (before.length !== after.length) return false;
    if (before.some((legId, index) => legId !== after[index])) return false;
  }
  return true;
}

function batchSignature(candidates: readonly OcclusionCandidate[]): string {
  return JSON.stringify(candidates.map((candidate) => [
    candidate.id,
    candidate.routes.map((route) => route.map(({ x, y }) => [x, y])),
    candidate.samples?.map(({ legId, worldPoint }) => [legId, worldPoint.x, worldPoint.y, worldPoint.z]),
  ]));
}
