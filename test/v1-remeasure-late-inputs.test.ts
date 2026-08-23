/** @vitest-environment jsdom */
// audit-close ticket 03: one re-measure path for inputs that arrive after the first frame, and the
// ruling every later measurement ticket inherits — a manual placement HOLDS its position when its
// label is re-measured, an automatic placement is RE-DERIVED and may move.
//
// jsdom has no canvas and no `FontFaceSet`, so both are faked here at the platform boundary rather
// than by reaching inside the module: a fake 2D context whose advance widths depend on which
// families have "landed", and a fake `document.fonts` that is a real `EventTarget`.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
} from '../src/index.js';
import { invalidateTextMetrics } from '../src/textMetrics.js';

/** Families the fake font server has delivered. A landed face is three times the fallback width. */
const landed = new Set<string>();
/** `family:text` for every measurement that actually reached the canvas — i.e. missed the cache. */
const measured: string[] = [];

const fakeContext = {
  font: '',
  measureText(text: string): { width: number } {
    const stack = /\d+px\s+(.*)$/u.exec(fakeContext.font)?.[1] ?? '';
    const primary = stack.split(',')[0]?.trim() ?? '';
    measured.push(`${primary}:${text}`);
    return { width: text.length * (landed.has(primary) ? 18 : 6) };
  },
};

/** A `FontFaceSet` stand-in that also counts subscriptions, so "no permanent listener" is testable. */
class FakeFontFaceSet extends EventTarget {
  public listeners = 0;

  public override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    this.listeners += 1;
    super.addEventListener(...args);
  }

  public override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    this.listeners -= 1;
    super.removeEventListener(...args);
  }
}

function installFonts(): FakeFontFaceSet {
  const set = new FakeFontFaceSet();
  Object.defineProperty(document, 'fonts', { value: set, configurable: true });
  return set;
}

function fontEvent(type: 'loadingdone' | 'loadingerror', ...families: readonly string[]): Event {
  return Object.assign(new Event(type), { fontfaces: families.map((family) => ({ family })) });
}

const adapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
    project: (point) => ({
      point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
      depth: point.z,
      visible: true,
    }),
  },
};

function makeLeader(): ViewLeader {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new ViewLeader({ boundary: element, adapters });
}

function note(id: string, extra: Partial<AnnotationDraft> = {}): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'plain-note', text: 'Pump P-101' },
    styleOverride: { fontFamily: 'Georgia, serif' },
    ...extra,
  };
}

/** Wraps to more lines as the glyphs get wider, so a font landing changes the label's height too. */
function wrapping(id: string, extra: Partial<AnnotationDraft> = {}): AnnotationDraft {
  return note(id, {
    content: { kind: 'plain-note', text: 'Pump P-101 primary feed', maxWidth: 140 },
    ...extra,
  });
}

beforeAll(() => {
  // `textMetrics` skips canvas entirely when the user agent says jsdom, because jsdom's own
  // `getContext` reports "not implemented" noise. Both halves of that have to go for a fake to run.
  Object.defineProperty(navigator, 'userAgent', { value: 'remeasure-test/1.0', configurable: true });
  HTMLCanvasElement.prototype.getContext = (() => fakeContext) as unknown as
    typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  Reflect.deleteProperty(document, 'fonts');
  landed.clear();
  measured.length = 0;
  invalidateTextMetrics();
});

describe('re-measure when a web font lands', () => {
  it('re-measures a label drawn with the fallback family, and its drawn width changes', () => {
    const fonts = installFonts();
    const leader = makeLeader();
    leader.annotations.create(note('a1'));
    leader.update();
    const before = leader.geometry.of('a1')!.label.width;

    landed.add('Georgia');
    fonts.dispatchEvent(fontEvent('loadingdone', 'Georgia'));
    leader.update();

    expect(leader.geometry.of('a1')!.label.width).toBeGreaterThan(before);
    leader.dispose();
  });

  it('invalidates the family that landed and nothing else', () => {
    const fonts = installFonts();
    const leader = makeLeader();
    leader.annotations.create(note('georgia', {
      placement: { kind: 'manual', position: { x: 40, y: 40 } },
    }));
    leader.annotations.create(note('courier', {
      styleOverride: { fontFamily: 'Courier New, monospace' },
      placement: { kind: 'manual', position: { x: 40, y: 400 } },
    }));
    leader.update();

    measured.length = 0;
    landed.add('Georgia');
    fonts.dispatchEvent(fontEvent('loadingdone', 'Georgia'));
    leader.update();

    // Both labels are laid out again, but only Georgia's strings miss the measurement cache.
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.filter((entry) => !entry.startsWith('Georgia:'))).toEqual([]);
    leader.dispose();
  });

  it('produces exactly one re-layout from one font event, however many labels are affected', async () => {
    const fonts = installFonts();
    const leader = makeLeader();
    for (const [index, id] of ['a1', 'a2', 'a3', 'a4'].entries()) {
      leader.annotations.create(note(id, {
        placement: { kind: 'manual', position: { x: 40, y: 40 + index * 80 } },
      }));
    }
    leader.update();
    const before = leader.geometry.of('a1')!.label.width;

    let notifications = 0;
    const stop = leader.annotations.subscribe(() => { notifications += 1; });
    landed.add('Georgia');
    fonts.dispatchEvent(fontEvent('loadingdone', 'Georgia'));
    expect(notifications).toBe(1);
    // The re-layout itself is a debounced microtask; flushing must not add a second one.
    await Promise.resolve();
    await Promise.resolve();
    expect(notifications).toBe(1);
    expect(leader.geometry.of('a4')!.label.width).toBeGreaterThan(before);
    stop();
    leader.dispose();
  });

  it('subscribes once and releases on dispose, and never re-measures per frame', () => {
    const fonts = installFonts();
    const leader = makeLeader();
    leader.annotations.create(note('a1'));
    leader.update();
    expect(fonts.listeners).toBe(2);

    measured.length = 0;
    for (let frame = 0; frame < 5; frame += 1) leader.update();
    expect(measured).toEqual([]);

    leader.dispose();
    expect(fonts.listeners).toBe(0);
    expect(() => fonts.dispatchEvent(fontEvent('loadingdone', 'Georgia'))).not.toThrow();
  });
});

describe('re-measure when there is nothing to wait for', () => {
  it('an environment with no FontFaceSet behaves exactly as before and reports nothing', () => {
    expect((document as { fonts?: unknown }).fonts).toBeUndefined();
    const leader = makeLeader();
    leader.annotations.create(note('a1'));
    leader.update();
    const first = leader.geometry.of('a1')!.label;
    leader.update();

    expect(leader.geometry.of('a1')!.label).toEqual(first);
    expect(leader.diagnostics.getSnapshot()).toEqual([]);
    expect(() => leader.dispose()).not.toThrow();
  });
});

describe('re-measure when the platform fails', () => {
  it('a font that fails to load keeps the fallback measurements and reports a diagnostic', () => {
    const fonts = installFonts();
    const leader = makeLeader();
    leader.annotations.create(note('a1'));
    leader.update();
    const before = leader.geometry.of('a1')!.label;

    // The fake canvas would now measure Georgia wider. A face that failed must not be believed.
    landed.add('Georgia');
    expect(() => fonts.dispatchEvent(fontEvent('loadingerror', 'Georgia'))).not.toThrow();
    leader.update();

    expect(leader.geometry.of('a1')!.label).toEqual(before);
    expect(leader.diagnostics.getSnapshot()).toContainEqual(expect.objectContaining({
      code: 'FONT_LOAD_FAILED',
      severity: 'warning',
    }));
    leader.dispose();
  });

  it('a malformed font event is ignored rather than thrown from', () => {
    const fonts = installFonts();
    const leader = makeLeader();
    leader.annotations.create(note('a1'));
    leader.update();
    const before = leader.geometry.of('a1')!.label;

    landed.add('Georgia');
    expect(() => fonts.dispatchEvent(new Event('loadingdone'))).not.toThrow();
    expect(() => fonts.dispatchEvent(
      Object.assign(new Event('loadingdone'), { fontfaces: [null, { family: 7 }, {}] }),
    )).not.toThrow();
    leader.update();

    expect(leader.geometry.of('a1')!.label).toEqual(before);
    leader.dispose();
  });
});

// The ruling. A placement kind says who owns the position: the user, or layout. A re-measure never
// overrules the user, and never leaves layout's own derivation standing on a width it now knows to
// be wrong. Tickets 02 (live tag text) and 05 (annotative scale) inherit exactly this.
describe('may a re-measured label move?', () => {
  it('ManualPlacement holds — even when the grown label runs into its neighbour', () => {
    const fonts = installFonts();
    const leader = makeLeader();
    leader.annotations.create(note('left', {
      placement: { kind: 'manual', position: { x: 200, y: 300 } },
    }));
    leader.annotations.create(note('right', {
      placement: { kind: 'manual', position: { x: 260, y: 300 } },
    }));
    leader.update();
    const beforeLeft = leader.geometry.of('left')!.label;

    landed.add('Georgia');
    fonts.dispatchEvent(fontEvent('loadingdone', 'Georgia'));
    leader.update();

    const left = leader.geometry.of('left')!.label;
    const right = leader.geometry.of('right')!.label;
    expect(left.width).toBeGreaterThan(beforeLeft.width);
    expect({ x: left.x, y: left.y }).toEqual({ x: 200, y: 300 });
    expect({ x: right.x, y: right.y }).toEqual({ x: 260, y: 300 });
    // The cost of holding, asserted rather than hidden: the wider label now overlaps its neighbour.
    expect(left.x + left.width).toBeGreaterThan(right.x);
    leader.dispose();
  });

  it('automatic placement is re-derived from the anchor — it moves', () => {
    const fonts = installFonts();
    const leader = makeLeader();
    leader.annotations.create(wrapping('a1'));
    leader.update();
    const before = leader.geometry.of('a1')!.label;

    landed.add('Georgia');
    fonts.dispatchEvent(fontEvent('loadingdone', 'Georgia'));
    leader.update();
    const after = leader.geometry.of('a1')!.label;

    expect(after.height).toBeGreaterThan(before.height);
    expect(after.y).not.toBe(before.y);

    // Re-derived, not merely nudged: it lands where a runtime that never saw the fallback puts it.
    const fresh = makeLeader();
    fresh.annotations.create(wrapping('a1'));
    fresh.update();
    expect(fresh.geometry.of('a1')!.label).toEqual(after);
    fresh.dispose();
    leader.dispose();
  });
});

// A merge check on the ruling, written independently and kept because it reaches it by a different
// route: the cases above change the FONT, this one changes the SIZE. If the rule were accidentally
// coupled to the font-loading path rather than to placement kind, these would still pass above and
// fail here. Tickets 02 and 05 inherit the rule through their own resize causes, not through fonts.
describe('may a re-measured label move? — reached by a different trigger', () => {
  it('holds a manual top-left and re-derives an automatic one when the label simply grows', () => {
    const leader = makeLeader();
    leader.annotations.create(note('pinned', {
      placement: { kind: 'manual', position: { x: 500, y: 380 } },
    }));
    leader.annotations.create(note('auto'));
    leader.update();

    const before = {
      pinned: leader.geometry.of('pinned')!.label,
      auto: leader.geometry.of('auto')!.label,
    };

    for (const id of ['pinned', 'auto']) {
      leader.annotations.update(id, { styleOverride: { fontSize: 28 } });
    }
    leader.update();

    const after = {
      pinned: leader.geometry.of('pinned')!.label,
      auto: leader.geometry.of('auto')!.label,
    };

    // Both really did resize, or this proves nothing about placement.
    expect(after.pinned.width).toBeGreaterThan(before.pinned.width);
    expect(after.auto.width).toBeGreaterThan(before.auto.width);

    // Manual: the top-left is exactly where the user left it, and the label grew right and down.
    expect(after.pinned.x).toBe(before.pinned.x);
    expect(after.pinned.y).toBe(before.pinned.y);

    // Automatic: re-derived from the anchor at the new size. A "hold everything" implementation
    // would pass the manual half and fail this one.
    expect(after.auto.x !== before.auto.x || after.auto.y !== before.auto.y).toBe(true);
    leader.dispose();
  });
});
