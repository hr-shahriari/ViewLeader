// Positions host elements against annotations, every frame, outside the framework's render cycle.
//
// `geometry.of()` is valid for exactly one frame and a camera move fires no DOM event, so a toolbar
// or a drag handle that tracks a label cannot be positioned from render state — storing the numbers
// means `setState` at 60 Hz, and reading them during render means rendering from a value that is
// already stale. The registry writes to the element instead, driven by the post-frame seam.
//
// One registry serves many elements with one frame subscription. That is not a micro-optimisation:
// a hook per element cannot express a variable number of handles, and per-instance registration at
// scale is the failure Radix hit in radix-ui/primitives#3858.
import type { Vec2 } from '../types.js';
import type {
  AnnotationScreenGeometry,
  InkScreenGeometry,
} from '../render.js';

/** What an element can be pinned to. Everything the screen-geometry types already carry. */
export type FollowTarget =
  /** The label box. The only target with a size as well as a position. */
  | { readonly kind: 'label'; readonly id: string }
  /** An arrow end — where one leader meets the model. */
  | { readonly kind: 'handle'; readonly id: string; readonly leg: string }
  /** A bend on a leader, or the midpoint where a drag would create one. */
  | {
    readonly kind: 'route-handle';
    readonly id: string;
    readonly leg: string;
    readonly handleKind: 'vertex' | 'midpoint';
    readonly index: number;
  }
  /** A corner or edge of a marked-up region. */
  | { readonly kind: 'region-handle'; readonly id: string; readonly index: number }
  /** One point of a freehand stroke. Stroke ids are separate from annotation ids. */
  | { readonly kind: 'ink-point'; readonly id: string; readonly index: number };

/**
 * What to do on a frame where the target has no geometry.
 *
 * `geometry.of()` returns nothing for an annotation whose legs left the frustum — but that reads the
 * same as two cases that must *not* disappear: a focused text editor mid-sentence, and a handle
 * frozen for the duration of the drag that is renumbering the live set underneath it. The registry
 * cannot tell those apart from the outside, so the caller declares which it is.
 */
export type FollowMissingBehaviour = 'hide' | 'hold';

export interface FollowOptions {
  /** Default `'hide'`. */
  readonly onMissing?: FollowMissingBehaviour;
}

/** The geometry reads the registry needs. Narrower than `GeometryCapability` so tests can fake it. */
export interface FollowGeometrySource {
  of(id: string): AnnotationScreenGeometry | undefined;
  ofInk(id: string): InkScreenGeometry | undefined;
}

export interface FollowRegistryOptions {
  readonly geometry: FollowGeometrySource;
  /** Runs the callback after each frame the runtime actually drew. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** A resolved position, plus a size and text metrics when the target is a label. */
interface Resolved {
  readonly at: Vec2;
  readonly width?: number;
  readonly height?: number;
  readonly text?: AnnotationScreenGeometry['text'];
}

/** What was last written to an element, so an unchanged frame touches no DOM at all. */
interface LastWrite {
  transform: string;
  width: string | undefined;
  height: string | undefined;
  hidden: boolean;
  /**
   * A signature of every metric written, not just the family.
   *
   * Guarding on the family alone left `--vl-font-size`, `--vl-line-height`, `--vl-text-color` and
   * `--vl-padding` written once and never again — so an annotative-scale change, a font-size write
   * or a theme swap left the inline editor sitting at the old size on a relaid-out label, which is
   * exactly the glyph-jump these variables exist to prevent.
   */
  metrics: string | undefined;
}

/**
 * A stable key for a target.
 *
 * The leg is part of it because `kind + index` is *not* unique: two legs of one annotation both
 * publish `midpoint:0`, so keying without the leg silently collapses two handles into one.
 */
export function followTargetKey(target: FollowTarget): string {
  switch (target.kind) {
    case 'label': return `label:${target.id}`;
    case 'handle': return `handle:${target.id}:${target.leg}`;
    case 'route-handle':
      return `route:${target.id}:${target.leg}:${target.handleKind}:${target.index}`;
    case 'region-handle': return `region:${target.id}:${target.index}`;
    case 'ink-point': return `ink:${target.id}:${target.index}`;
  }
}

export class FollowRegistry {
  readonly #geometry: FollowGeometrySource;
  readonly #entries = new Map<string, {
    readonly target: FollowTarget;
    readonly onMissing: FollowMissingBehaviour;
    element: Element | null;
    last: LastWrite | undefined;
  }>();

  /**
   * Ref callbacks handed out so far, by key.
   *
   * Memoised because a fresh function identity re-fires the ref on every render in Vue and makes
   * React detach and reattach in React — both of which would tear down and rebuild a registration
   * that never changed.
   */
  readonly #refs = new Map<string, (element: Element | null) => void>();
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  public constructor(options: FollowRegistryOptions) {
    this.#geometry = options.geometry;
    this.#unsubscribe = options.subscribe(() => this.write());
  }

  /**
   * A callback ref for one target. Same target, same function — call it as often as you re-render.
   *
   * `options` is read on first use for a given key; changing it later needs a different target or a
   * fresh registry, which is the same rule the rest of the hook family follows.
   */
  public ref(target: FollowTarget, options: FollowOptions = {}): (element: Element | null) => void {
    const key = followTargetKey(target);
    const existing = this.#refs.get(key);
    if (existing !== undefined) return existing;
    const callback = (element: Element | null): void => {
      if (element === null) {
        this.#entries.delete(key);
        return;
      }
      this.#track(key, target, element, options);
    };
    this.#refs.set(key, callback);
    return callback;
  }

  /**
   * Registers an element directly, for callers that already hold one.
   *
   * Vue's idiom fills a template ref itself and hands the library something to read, so its
   * composable watches the ref and calls this rather than installing a callback.
   */
  public register(
    target: FollowTarget,
    element: Element,
    options: FollowOptions = {},
  ): () => void {
    const key = followTargetKey(target);
    this.#track(key, target, element, options);
    return () => { this.#entries.delete(key); };
  }

  /** Releases whatever is registered for a target, without needing the element back. */
  public release(target: FollowTarget): void {
    this.#entries.delete(followTargetKey(target));
  }

  /**
   * Writes every registered element's position. Called after each drawn frame.
   *
   * Public so a host driving `update()` by hand can force a write, and so tests can step frames
   * without a real loop.
   */
  public write(): void {
    if (this.#disposed) return;
    for (const entry of this.#entries.values()) {
      const element = entry.element;
      if (element === null) continue;
      const resolved = this.#resolve(entry.target);
      if (resolved === undefined) {
        if (entry.onMissing === 'hold') continue;
        entry.last = applyHidden(element, entry.last);
        continue;
      }
      entry.last = applyResolved(element, resolved, entry.last);
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#entries.clear();
    this.#refs.clear();
  }

  #track(
    key: string,
    target: FollowTarget,
    element: Element,
    options: FollowOptions,
  ): void {
    if (this.#disposed) return;
    const existing = this.#entries.get(key);
    // Same element for the same target is a no-op, so a re-render that changes nothing does not
    // reset the write cache and force a redundant DOM touch.
    if (existing !== undefined && existing.element === element) return;
    this.#entries.set(key, {
      target,
      onMissing: options.onMissing ?? 'hide',
      element,
      last: undefined,
    });
    // Position it now rather than leaving it wherever the host's CSS put it until the next frame.
    this.write();
  }

  #resolve(target: FollowTarget): Resolved | undefined {
    if (target.kind === 'ink-point') {
      const at = this.#geometry.ofInk(target.id)?.points[target.index];
      return at === undefined ? undefined : { at };
    }
    const geometry = this.#geometry.of(target.id);
    if (geometry === undefined) return undefined;
    switch (target.kind) {
      case 'label':
        return {
          at: { x: geometry.label.x, y: geometry.label.y },
          width: geometry.label.width,
          height: geometry.label.height,
          text: geometry.text,
        };
      case 'handle': {
        const handle = geometry.handles.find((entry) => entry.target === target.leg);
        return handle === undefined ? undefined : { at: handle.at };
      }
      case 'route-handle': {
        const handle = geometry.routeHandles.find((entry) => entry.target === target.leg
          && entry.kind === target.handleKind
          && entry.index === target.index);
        return handle === undefined ? undefined : { at: handle.at };
      }
      case 'region-handle': {
        const handle = geometry.regionHandles[target.index];
        return handle === undefined ? undefined : { at: handle.at };
      }
    }
  }
}

/**
 * `transform` rather than `left`/`top`, which is what Floating UI and TanStack Virtual both default
 * to. The documented cost is that it creates a stacking context and can interfere with
 * `position: fixed` descendants and transform animations.
 *
 * `ponytail:` no `left`/`top` mode. Upgrade path: a per-registration flag, which is what both of
 * those libraries ship for exactly this. Not built until someone hits the stacking-context problem.
 */
function applyResolved(element: Element, resolved: Resolved, last: LastWrite | undefined): LastWrite {
  const style = styleOf(element);
  const transform = `translate(${resolved.at.x}px, ${resolved.at.y}px)`;
  const width = resolved.width === undefined ? undefined : `${resolved.width}px`;
  const height = resolved.height === undefined ? undefined : `${resolved.height}px`;
  const metrics = resolved.text === undefined ? undefined : metricsSignature(resolved.text);
  const next: LastWrite = { transform, width, height, hidden: false, metrics };
  if (style === undefined) return next;

  // Every write is guarded, which is what makes running this unconditionally every frame cheap.
  if (last?.transform !== transform) style.setProperty('transform', transform);
  if (last?.hidden !== false) {
    style.removeProperty('visibility');
    style.removeProperty('pointer-events');
    element.removeAttribute('data-vl-follow');
  }
  if (last?.width !== width) setOrClear(style, 'width', width);
  if (last?.height !== height) setOrClear(style, 'height', height);

  // Text metrics ride as custom properties so a host stylesheet consumes them with `var()` and no
  // JavaScript reads anything back — Radix's pattern for `--radix-popper-available-*`. An inline
  // editor needs these to sit on the text it is replacing without the glyphs jumping.
  if (resolved.text !== undefined && last?.metrics !== metrics) {
    style.setProperty('--vl-font-family', resolved.text.fontFamily);
    style.setProperty('--vl-font-size', `${resolved.text.fontSize}px`);
    style.setProperty('--vl-line-height', `${resolved.text.lineHeight}px`);
    style.setProperty('--vl-text-color', resolved.text.textColor);
    style.setProperty('--vl-padding', `${resolved.text.padding}px`);
  }
  return next;
}

/**
 * `visibility` rather than `display`, so the box keeps its measured size — the same choice the
 * gallery's own editor and Radix's hide handling both make. The attribute is the escape hatch for a
 * host that would rather fade than cut.
 */
function applyHidden(element: Element, last: LastWrite | undefined): LastWrite {
  const style = styleOf(element);
  const next: LastWrite = {
    transform: last?.transform ?? '',
    width: last?.width,
    height: last?.height,
    hidden: true,
    metrics: last?.metrics,
  };
  if (style === undefined || last?.hidden === true) return next;
  style.setProperty('visibility', 'hidden');
  style.setProperty('pointer-events', 'none');
  element.setAttribute('data-vl-follow', 'offscreen');
  return next;
}

/** Every value written as a custom property, so a change to any one of them is noticed. */
function metricsSignature(text: NonNullable<Resolved['text']>): string {
  return `${text.fontFamily}|${text.fontSize}|${text.lineHeight}|${text.textColor}|${text.padding}`;
}

function setOrClear(style: CSSStyleDeclaration, property: string, value: string | undefined): void {
  if (value === undefined) style.removeProperty(property);
  else style.setProperty(property, value);
}

/**
 * Duck-typed for the same reason the editing controller's DOM guards are: core is handed an
 * `Element` and must not assume a DOM global exists just to test one.
 */
function styleOf(element: Element): CSSStyleDeclaration | undefined {
  const candidate = (element as { readonly style?: unknown }).style;
  return typeof candidate === 'object' && candidate !== null
    && typeof (candidate as CSSStyleDeclaration).setProperty === 'function'
    ? candidate as CSSStyleDeclaration
    : undefined;
}
