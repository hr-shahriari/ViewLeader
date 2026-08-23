/**
 * Measures how wide text will be, which is what decides how big every label is.
 *
 * Uses the browser's canvas to measure real font metrics, and caches the results because the same
 * strings are measured on every frame. Where there is no canvas — a server, a test environment —
 * it falls back to an estimate based on which characters are in the string. The estimate is not
 * exact, but it is consistent, so layout still produces sensible, repeatable numbers.
 *
 * Text width scales evenly with font size, so a caller may measure once and scale the result rather
 * than measuring again at every size.
 */

export interface FontSpec {
  readonly family: string;
  readonly size: number;
  readonly bold: boolean;
}

/** How much wider bold text runs than regular. Only used by the estimate. */
const FALLBACK_BOLD_RATIO = 1.083;
const CACHE_LIMIT = 2000;

const cache = new Map<string, number>();

let context: CanvasRenderingContext2D | null | undefined;

/**
 * Detects test environments that have a canvas element but cannot actually measure with it.
 *
 * Asking anyway does not fail cleanly — it prints an error to the console and then returns nothing.
 * Every project running these tests would see that noise on the first label they measured, so the
 * question is skipped entirely and the estimate is used instead.
 */
function canvasIsUnavailable(): boolean {
  if (typeof document === 'undefined') return true;
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom');
}

/** Gets a canvas to measure with, once, on first use. Nothing means "use the estimate instead". */
function measurementContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  try {
    context = canvasIsUnavailable() ? null : document.createElement('canvas').getContext('2d');
  } catch {
    context = null;
  }
  return context;
}

export function measureText(text: string, font: FontSpec): number {
  if (text === '') return 0;
  const key = `${font.bold ? 'b' : 'n'}|${font.size}|${font.family}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const target = measurementContext();
  let width: number;
  if (target === null) {
    width = estimateTextWidth(text, font.size) * (font.bold ? FALLBACK_BOLD_RATIO : 1);
  } else {
    target.font = `${font.bold ? 'bold ' : ''}${font.size}px ${font.family}`;
    width = target.measureText(text).width;
    // A canvas that reports zero width for real text is not measuring anything. Fall back.
    if (!Number.isFinite(width) || width <= 0) {
      width = estimateTextWidth(text, font.size) * (font.bold ? FALLBACK_BOLD_RATIO : 1);
    }
  }

  // ponytail: when the cache fills it is emptied wholesale rather than evicting least-recently
  // used. Swap in a proper policy if profiling ever shows this thrashing.
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, width);
  return width;
}

/**
 * Throws away cached measurements, so text is measured again.
 *
 * Needed when a web font finishes downloading: everything measured before it arrived was measured
 * against a substitute font and is now wrong.
 *
 * Naming a family drops only the measurements that could have changed. A font that just arrived
 * cannot have affected text that never asked for it, so re-measuring the rest is work that cannot
 * produce a different answer.
 */
export function invalidateTextMetrics(family?: string): void {
  if (family === undefined) {
    cache.clear();
    return;
  }
  const target = normalizeFamily(family);
  if (target === '') return;
  for (const key of cache.keys()) {
    // Cache keys are `weight|size|family|text`, so the font is the third field. Deleting while
    // looping is safe here — a removed entry is simply not visited again.
    const stack = key.split('|', 3)[2] ?? '';
    if (stack.split(',').some((entry) => normalizeFamily(entry) === target)) cache.delete(key);
  }
}

/** Font names ignore case, and quoting one does not make it a different font. */
function normalizeFamily(value: string): string {
  return value.trim().replace(/^["']|["']$/gu, '').toLowerCase();
}

/**
 * Watches for web fonts finishing their download, so labels can be re-measured against the real
 * font instead of the substitute.
 *
 * Uses the browser's own font-loading event — no polling and no timers. Because the event names
 * which fonts arrived, only those measurements need dropping. Fonts that failed to load keep the
 * substitute measurements they already have, which are the ones that will be drawn.
 *
 * Somewhere without web fonts at all — a server, a test — simply has nothing to wait for. That is
 * normal, not an error, and unsubscribing does nothing.
 */
export function watchFontLoading(
  source: Document | undefined,
  hooks: Readonly<{
    loaded: (families: readonly string[]) => void;
    failed: (families: readonly string[]) => void;
  }>,
): () => void {
  const fonts = (source as { fonts?: FontFaceSet } | undefined)?.fonts;
  if (fonts === undefined || fonts === null || typeof fonts.addEventListener !== 'function') {
    return () => {};
  }
  const onDone = (event: Event): void => hooks.loaded(loadedFamilies(event));
  const onError = (event: Event): void => hooks.failed(loadedFamilies(event));
  fonts.addEventListener('loadingdone', onDone);
  fonts.addEventListener('loadingerror', onError);
  return () => {
    fonts.removeEventListener('loadingdone', onDone);
    fonts.removeEventListener('loadingerror', onError);
  };
}

/**
 * Reads the font names out of a browser font event, defensively: this is data from outside, and
 * older or unusual browsers do not all shape it the same way.
 */
function loadedFamilies(event: Event): readonly string[] {
  const faces: unknown = (event as { fontfaces?: unknown }).fontfaces;
  if (!Array.isArray(faces)) return [];
  return [...new Set(
    faces
      .map((face: unknown) => (face as { family?: unknown } | null)?.family)
      .filter((family): family is string => typeof family === 'string' && family !== ''),
  )];
}

/**
 * Estimates text width from the characters themselves, used when there is no canvas to measure
 * with. It cannot know the actual font, so it will not be exact — but it is always the same for the
 * same input, which is what keeps layout stable.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(character)) continue;
    if (/\s/u.test(character)) units += 0.35;
    else if (isWideCodePoint(codePoint)) units += 1;
    else if (/[ilI1.,'`|]/u.test(character)) units += 0.35;
    else if (/[MW@#%]/u.test(character)) units += 0.9;
    else units += 0.62;
  }
  return units * fontSize;
}

function isWideCodePoint(value: number): boolean {
  return (
    (value >= 0x1100 && value <= 0x115f) ||
    (value >= 0x2e80 && value <= 0xa4cf) ||
    (value >= 0xac00 && value <= 0xd7a3) ||
    (value >= 0xf900 && value <= 0xfaff) ||
    (value >= 0x1f300 && value <= 0x1faff)
  );
}
