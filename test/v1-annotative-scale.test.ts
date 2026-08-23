/** @vitest-environment jsdom */
// audit-close ticket 05: annotative scale — one global factor, AutoCAD's DIMSCALE.
//
// Every check here is arithmetic on rendered path data and rendered attributes, never a look at the
// picture: at scale 2 the lettering, the arrowhead, the landing reach, the content padding and every
// line width are each exactly twice their scale-1 value. That "each" is the whole point of the
// ticket — an arrowhead that scales while its leader does not is worse than neither scaling — so the
// factor is asserted against every one of them, not sampled.
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type StyleDefinition,
} from '../src/index.js';
import { CAP_RATIO } from '../src/theme.js';
import { DEFAULT_LANDING } from '../src/definitions.js';

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

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

/**
 * Every size distinct and a whole number, so a doubled value can only have come from the factor.
 * `fontSize` is deliberately `DEFAULT_FONT_SIZE`, which makes the label group's scale exactly the
 * annotative factor and every layout-unit coordinate directly comparable between the two runs.
 */
function plotStyle(id: string, extra: Partial<StyleDefinition> = {}): StyleDefinition {
  return {
    kind: 'style',
    id,
    name: id,
    lineColor: '#1f2937',
    lineWidth: 1.5,
    textColor: '#111827',
    fontFamily: 'sans-serif',
    fontSize: 14,
    terminatorId: 'builtin.terminator.arrow',
    enclosureId: 'builtin.enclosure.rectangle',
    landing: { length: 20, gap: 5 },
    content: { borderWidth: 3, padding: 6, backgroundColor: '#ffffff' },
    ...extra,
  };
}

/** Anchor well to the left of the label, so the dogleg lands on the label's left edge every time. */
function note(id: string, extra: Partial<AnnotationDraft> = {}): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: -5, y: 0, z: 0 } },
    content: { kind: 'plain-note', text: 'AHU-1' },
    styleId: 'plot',
    placement: { kind: 'manual', position: { x: 500, y: 200 } },
    routing: { kind: 'automatic', mode: 'dogleg' },
    ...extra,
  };
}

interface Fixture {
  readonly root: HTMLDivElement;
  readonly leader: ViewLeader;
}

function fixture(
  drafts: readonly AnnotationDraft[] = [note('a1')],
  styles: readonly StyleDefinition[] = [plotStyle('plot')],
): Fixture {
  const root = boundary();
  const leader = new ViewLeader({ boundary: root, adapters });
  for (const style of styles) leader.definitions.create(style);
  for (const draft of drafts) leader.annotations.create(draft);
  leader.update();
  return { root, leader };
}

function group(root: Element, id = 'a1'): Element {
  return root.querySelector(`[data-annotation-id="${id}"]`)!;
}

function numbers(value: string | null | undefined): readonly number[] {
  return [...(value ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)].map(([match]) => Number(match));
}

/** The factor the label group is drawn at. Absent below a scale of 1 — content layout skips the group. */
function labelScale(annotation: Element): number {
  const inner = annotation.querySelector('g[data-hit-target="label"] > g[transform]');
  const found = /scale\((-?[\d.]+)\)/u.exec(inner?.getAttribute('transform') ?? '');
  return found === null ? 1 : Number(found[1]);
}

/**
 * Every drawn size of one annotation, in screen pixels, read off the DOM the renderer produced.
 *
 * A dogleg route is `[anchor, shoulder, attachment]`, and with the anchor to the label's left the
 * landing runs leftwards off the box's left edge — so the reach is `attachment.x - shoulder.x` and
 * the gap is `label.x - attachment.x`, both independent of how big the label itself got.
 */
function measured(root: Element, leader: ViewLeader, id = 'a1'): Record<string, number> {
  const annotation = group(root, id);
  const scale = labelScale(annotation);
  const route = numbers(annotation.querySelector('path[data-route-visible]')?.getAttribute('d'));
  const [, , shoulderX, , attachmentX] = route as [number, number, number, number, number];
  const label = leader.geometry.of(id)!.label;
  const text = annotation.querySelector('text')!;
  const head = annotation.querySelector('path[data-terminator="anchor"]')!;
  return {
    // Glyph size as drawn: the primitive's own font-size through the group's scale.
    textSize: Number(text.getAttribute('font-size')) * scale,
    // ASME Y14.2 §5: the head reaches back `length` from its tip, the second number in `M 0 0 L -l ∓w`.
    arrowLength: Math.abs(numbers(head.getAttribute('d'))[2]!),
    landingLength: attachmentX! - shoulderX!,
    landingGap: label.x - attachmentX!,
    // The text's own inset from the box edge, likewise carried through the group's scale.
    padding: Number(text.getAttribute('x')) * scale,
    leaderWidth: Number(annotation.querySelector('path[data-route-visible]')?.getAttribute('stroke-width')),
    borderWidth: Number(
      annotation.querySelector('g[data-hit-target="label"] path')?.getAttribute('stroke-width'),
    ),
    labelWidth: label.width,
    labelHeight: label.height,
  };
}

describe('annotative scale doubles every drafting-unit size together', () => {
  it('at scale 2, text, arrowhead, landing, padding and line widths are each exactly twice', () => {
    const one = fixture();
    const before = measured(one.root, one.leader);

    one.leader.setAnnotationScale(2);
    one.leader.update();
    const after = measured(one.root, one.leader);

    for (const key of Object.keys(before)) {
      expect(after[key], `${key}: ${before[key]} → ${after[key]}`).toBeCloseTo(before[key]! * 2, 6);
    }

    // Spot the absolutes too, so a uniformly wrong pair of numbers cannot satisfy the ratio above.
    expect(before.textSize).toBe(14);
    expect(after.textSize).toBe(28);
    expect(before.arrowLength).toBeCloseTo(14 * CAP_RATIO, 6);
    expect(after.arrowLength).toBeCloseTo(28 * CAP_RATIO, 6);
    expect(before.landingLength).toBeCloseTo(20, 6);
    expect(after.landingLength).toBeCloseTo(40, 6);
    expect(before.landingGap).toBeCloseTo(5, 6);
    expect(after.landingGap).toBeCloseTo(10, 6);
    expect(before.padding).toBe(6);
    expect(after.padding).toBe(12);
    expect(before.leaderWidth).toBe(1.5);
    expect(after.leaderWidth).toBe(3);
    expect(before.borderWidth).toBe(3);
    expect(after.borderWidth).toBe(6);
    one.leader.dispose();
  });

  it('padding scales once, not twice — the trap in scaling a size that already rides the group', () => {
    // Padding is authored in label-layout units and drawn inside a group scaled by
    // `fontSize / DEFAULT_FONT_SIZE`. Multiplying it at resolve time as well would square the factor
    // and give a label four times the inset. Asserted against the box the renderer actually drew.
    const { root, leader } = fixture();
    leader.setAnnotationScale(3);
    leader.update();
    const annotation = group(root);
    const box = numbers(annotation.querySelector('g[data-hit-target="label"] path')?.getAttribute('d'));
    const inset = Number(annotation.querySelector('text')!.getAttribute('x'));
    // The box path is still authored in layout units; only the group's scale changed.
    expect(labelScale(annotation)).toBe(3);
    expect(inset).toBe(6);
    expect(box[2]).toBeGreaterThan(2 * inset);
    // Drawn: the text sits 18 px in from a box the same 3× bigger, not 54 px in.
    expect(inset * labelScale(annotation)).toBe(18);
    leader.dispose();
  });

  it('scales a landing the style never declared, so a shoulder cannot lag its arrowhead', () => {
    // A style with no `landing` group still lands: routing resolves it against DEFAULT_LANDING.
    const bare = plotStyle('plot');
    const { landing: _drop, ...withoutLanding } = bare;
    const { root, leader } = fixture([note('a1')], [withoutLanding as StyleDefinition]);
    expect(measured(root, leader).landingLength).toBeCloseTo(DEFAULT_LANDING.length, 6);
    expect(measured(root, leader).landingGap).toBeCloseTo(DEFAULT_LANDING.gap, 6);

    leader.setAnnotationScale(2);
    leader.update();
    expect(measured(root, leader).landingLength).toBeCloseTo(DEFAULT_LANDING.length * 2, 6);
    expect(measured(root, leader).landingGap).toBeCloseTo(DEFAULT_LANDING.gap * 2, 6);
    leader.dispose();
  });

  it('misses the layout memo on a style the factor leaves textually unchanged', () => {
    // Nothing is cleared when the scale changes: the memo's signature carries the resolved font size
    // and line width, both of which the factor multiplies, so it misses by construction. That claim
    // needs a style whose *content box* the factor does not touch — a zero border and a padding that
    // stays in layout units — or a memo keyed only on the box would look correct while going stale.
    const { enclosureId: _shape, ...flat } = plotStyle('plot', {
      content: { borderWidth: 0, padding: 6 },
    });
    const { root, leader } = fixture([note('a1')], [flat as StyleDefinition]);
    const before = measured(root, leader);

    leader.setAnnotationScale(2);
    leader.update();
    const after = measured(root, leader);
    for (const key of ['labelWidth', 'labelHeight', 'padding']) {
      expect(after[key], key).toBeCloseTo(before[key]! * 2, 6);
    }
    leader.dispose();
  });

  it('takes ink strokes with it: an ink pen is a pen weight like any other', () => {
    const { root, leader } = fixture();
    const session = leader.authoring.markup.begin('ink');
    session.establishPlane({
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
    });
    for (const point of [{ x: -2, y: -2 }, { x: 2, y: 2 }]) session.appendInkPoint(point);
    leader.authoring.markup.commitInk(session, { id: 'ink-1', styleId: 'plot' });
    leader.update();
    const stroke = (): number => Number(
      root.querySelector('path[data-ink-stroke]')?.getAttribute('stroke-width'),
    );
    expect(stroke()).toBe(1.5);
    leader.setAnnotationScale(2);
    leader.update();
    expect(stroke()).toBe(3);
    leader.dispose();
  });

  it('scales the built-in styles, whose sizes are the drafting units the theme defines', () => {
    // No custom style at all: the point of `mleader-core/02` was that every size comes from one
    // place, and this is the claim that a single factor over that one place is enough.
    const { styleId: _named, ...defaulted } = note('a1');
    const { root, leader } = fixture([defaulted], []);
    const before = measured(root, leader);
    leader.setAnnotationScale(2.5);
    leader.update();
    const after = measured(root, leader);
    for (const key of Object.keys(before)) {
      // As a ratio, to 0.2%, rather than to six decimals: the theme's ISO 2.5 mm cap height is not a
      // whole number of pixels, so the label group's scale reaches the DOM through the renderer's
      // three-decimal rounding at both factors. Every size still moves by 2.5, none by 1 or 6.25.
      expect(after[key]! / before[key]!, `${key}`).toBeCloseTo(2.5, 2);
    }
    leader.dispose();
  });
});

describe('scale 1 changes nothing', () => {
  it('renders byte-identical markup after a round trip through another scale', () => {
    const { root, leader } = fixture([
      note('a1'),
      note('a2', {
        content: { kind: 'symbolic-block', symbol: 'circle', label: '3' },
        styleId: 'builtin.style.grid-bubble',
        placement: { kind: 'manual', position: { x: 120, y: 400 } },
      }),
      note('a3', { styleId: 'builtin.style.note', placement: { kind: 'automatic' } }),
    ]);
    const overlay = root.querySelector('[data-viewleader-overlay]')!;
    const original = overlay.outerHTML;

    leader.setAnnotationScale(4);
    leader.update();
    expect(overlay.outerHTML).not.toBe(original);

    leader.setAnnotationScale(1);
    leader.update();
    // Whole rendered markup, not sampled attributes: every path, every stroke width, every transform.
    expect(overlay.outerHTML).toBe(original);
    leader.dispose();
  });

  it('setting the scale it already has does not even publish a change', () => {
    const { leader } = fixture();
    let notifications = 0;
    const stop = leader.annotations.subscribe(() => { notifications += 1; });
    leader.setAnnotationScale(1);
    expect(notifications).toBe(0);
    expect(leader.annotationScale).toBe(1);
    stop();
    leader.dispose();
  });
});

describe('one scale change is one re-layout', () => {
  it('publishes once and re-lays-out once, however many annotations are affected', async () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const { root, leader } = fixture(ids.map((id, index) =>
      note(id, { placement: { kind: 'manual', position: { x: 500, y: 40 + index * 90 } } })));
    const before = ids.map((id) => leader.geometry.of(id)!.label.width);

    let notifications = 0;
    const stop = leader.annotations.subscribe(() => { notifications += 1; });
    leader.setAnnotationScale(2);
    expect(notifications).toBe(1);
    // The re-layout is a debounced microtask; flushing it must not add a second notification.
    await Promise.resolve();
    await Promise.resolve();
    expect(notifications).toBe(1);

    // And every label really did come back resized, so "once" is not "not at all".
    ids.forEach((id, index) => {
      expect(measured(root, leader, id).labelWidth).toBeCloseTo(before[index]! * 2, 6);
    });
    stop();
    leader.dispose();
  });
});

describe('a bad scale is refused at the entrance', () => {
  it('rejects non-finite and non-positive factors, and draws nothing differently', () => {
    const { root, leader } = fixture();
    const overlay = root.querySelector('[data-viewleader-overlay]')!;
    const original = overlay.outerHTML;

    for (const bad of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => leader.setAnnotationScale(bad), `${bad}`).toThrow(/finite positive/u);
    }
    for (const bad of ['2', null, undefined, {}]) {
      expect(() => leader.setAnnotationScale(bad as unknown as number)).toThrow(/finite positive/u);
    }

    leader.update();
    expect(leader.annotationScale).toBe(1);
    expect(overlay.outerHTML).toBe(original);
    leader.dispose();
  });
});

describe('the scale is a runtime setting, not a document field', () => {
  it('never reaches the serialized document, and reloading one does not reset it', () => {
    const { leader } = fixture();
    const before = leader.documents.serialize();
    leader.setAnnotationScale(2);
    leader.update();
    expect(leader.documents.serialize()).toBe(before);
    expect(JSON.parse(before)).not.toHaveProperty('annotationScale');

    // A file written by someone plotting at another scale cannot carry theirs into this session.
    leader.documents.replace(before);
    leader.update();
    expect(leader.annotationScale).toBe(2);
    leader.dispose();
  });
});

// The ruling this ticket inherits from audit-close/03, reached through its own cause. A scale change
// resizes every label, which is exactly the condition 03 decided: placement kind says who owns the
// position, and nothing else does.
describe('may a label move when the scale changes?', () => {
  it('a manual placement HOLDS its top-left; an automatic one is RE-DERIVED', () => {
    const { root, leader } = fixture([
      note('pinned', { placement: { kind: 'manual', position: { x: 500, y: 380 } } }),
      note('auto', { placement: { kind: 'automatic' } }),
    ]);
    const before = {
      pinned: leader.geometry.of('pinned')!.label,
      auto: leader.geometry.of('auto')!.label,
    };

    leader.setAnnotationScale(2);
    leader.update();
    const after = {
      pinned: leader.geometry.of('pinned')!.label,
      auto: leader.geometry.of('auto')!.label,
    };

    // Both really resized, or this proves nothing about placement.
    expect(after.pinned.width).toBeCloseTo(before.pinned.width * 2, 6);
    expect(after.auto.width).toBeCloseTo(before.auto.width * 2, 6);

    // Manual: exactly where the drafter left it. It grows right and down.
    expect({ x: after.pinned.x, y: after.pinned.y }).toEqual({ x: 500, y: 380 });

    // Automatic: re-derived from the anchor at the new size — and re-derived, not merely nudged, so
    // it lands where a runtime started at this scale puts it.
    expect(after.auto.x !== before.auto.x || after.auto.y !== before.auto.y).toBe(true);
    const fresh = fixture([note('auto', { placement: { kind: 'automatic' } })]);
    fresh.leader.setAnnotationScale(2);
    fresh.leader.update();
    expect(fresh.leader.geometry.of('auto')!.label).toEqual(after.auto);
    fresh.leader.dispose();
    expect(group(root, 'pinned')).not.toBeNull();
    leader.dispose();
  });
});
