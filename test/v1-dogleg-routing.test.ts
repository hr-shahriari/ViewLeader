/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type StyleDefinition,
} from '../src/index.js';
import { DEFAULT_LANDING } from '../src/definitions.js';
import { routeLeg, type LandingGeometry, type ScreenBounds } from '../src/routing.js';
import { CAP_RATIO } from '../src/theme.js';
import type { Vec2 } from '../src/types.js';

const label: ScreenBounds = { x: 200, y: 100, width: 120, height: 40 };
const above: Vec2 = { x: 40, y: 40 };
const below: Vec2 = { x: 40, y: 400 };
const right: Vec2 = { x: 600, y: 40 };

function dogleg(anchor: Vec2, landing?: LandingGeometry): readonly Vec2[] {
  return routeLeg(anchor, label, { mode: 'dogleg' }, landing);
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

/**
 * Anchors every note on the world origin, so every projected anchor is (400, 300). Routing is
 * stated because `annotations.create` still defaults a single-anchor draft to `straight`.
 */
function note(id: string, position: Vec2, text = 'Note', styleId?: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    routing: { kind: 'automatic', mode: 'dogleg' },
    content: { kind: 'plain-note', text },
    placement: { kind: 'manual', position },
    ...(styleId === undefined ? {} : { styleId }),
  };
}

function render(annotation: AnnotationDraft, styles: readonly StyleDefinition[] = []): Element {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({ boundary: root, adapters });
  for (const definition of styles) leader.definitions.create(definition);
  leader.annotations.create(annotation);
  leader.update();
  return root.querySelector(`[data-annotation-id="${annotation.id}"]`)!;
}

/** The drawn route, as points. */
function drawn(group: Element): readonly Vec2[] {
  const numbers = [...(group.querySelector('path[data-route-visible]')?.getAttribute('d') ?? '')
    .matchAll(/-?\d+(?:\.\d+)?/gu)].map(([match]) => Number(match));
  return numbers.reduce<Vec2[]>((points, value, index) =>
    index % 2 === 0 ? [...points, { x: value, y: 0 }] : [...points.slice(0, -1), { x: points.at(-1)!.x, y: value }],
    []);
}

/** Where the label group was translated to — the top-left of its screen bounds. */
function labelTop(group: Element): number {
  const transform = group.querySelector('g[data-hit-target="label"]')?.getAttribute('transform') ?? '';
  return Number([...transform.matchAll(/-?\d+(?:\.\d+)?/gu)].map(([match]) => match)[1]);
}

function style(id: string, extra: Partial<StyleDefinition> = {}): StyleDefinition {
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
    ...extra,
  };
}

describe('dogleg routing', () => {
  it('runs one diagonal into one horizontal landing, not an axis-aligned staircase', () => {
    const [start, shoulder, attachment] = dogleg(above) as [Vec2, Vec2, Vec2];
    expect(dogleg(above)).toHaveLength(3);
    expect(start).toEqual(above);
    // The signature of an MLEADER: the first segment moves on both axes, the second on neither y.
    expect(shoulder.x).not.toBe(start.x);
    expect(shoulder.y).not.toBe(start.y);
    expect(attachment.y).toBe(shoulder.y);
  });

  it('takes the landing length from the style, not from how far away the anchor is', () => {
    const near = dogleg({ x: 190, y: 90 });
    const far = dogleg({ x: -4_000, y: -9_000 });
    const landing = (points: readonly Vec2[]): number =>
      Math.abs(points.at(-1)!.x - points.at(-2)!.x);
    expect(landing(near)).toBeCloseTo(DEFAULT_LANDING.length, 6);
    expect(landing(far)).toBeCloseTo(DEFAULT_LANDING.length, 6);
    expect(landing(dogleg(above, { length: 12 }))).toBeCloseTo(12, 6);
  });

  it('flips the landing to whichever side of the label faces the anchor', () => {
    const fromLeft = dogleg(above);
    expect(fromLeft.at(-1)!.x).toBeCloseTo(label.x - DEFAULT_LANDING.gap, 6);
    expect(fromLeft.at(-2)!.x).toBeCloseTo(label.x - DEFAULT_LANDING.gap - DEFAULT_LANDING.length, 6);

    const fromRight = dogleg(right);
    const edge = label.x + label.width;
    expect(fromRight.at(-1)!.x).toBeCloseTo(edge + DEFAULT_LANDING.gap, 6);
    expect(fromRight.at(-2)!.x).toBeCloseTo(edge + DEFAULT_LANDING.gap + DEFAULT_LANDING.length, 6);
  });

  it('obeys an explicit side even when the anchor is on the other one', () => {
    expect(dogleg(right, { side: 'left' }).at(-1)!.x).toBeCloseTo(label.x - DEFAULT_LANDING.gap, 6);
    expect(dogleg(above, { side: 'right' }).at(-1)!.x)
      .toBeCloseTo(label.x + label.width + DEFAULT_LANDING.gap, 6);
  });

  it('meets the first text line from above and the last from below', () => {
    const textLines = { first: 17, last: 53 };
    expect(dogleg(above, { textLines }).at(-1)!.y).toBeCloseTo(label.y + 17, 6);
    expect(dogleg(below, { textLines }).at(-1)!.y).toBeCloseTo(label.y + 53, 6);
  });

  it('falls back to the label mid-height when there is no text to attach to', () => {
    expect(dogleg(above).at(-1)!.y).toBeCloseTo(label.y + label.height / 2, 6);
  });

  it('drops the landing for render "none" and carries it across the label for "underline"', () => {
    expect(dogleg(above, { render: 'none' }))
      .toEqual([above, { x: label.x, y: label.y + label.height / 2 }]);
    const underlined = dogleg(above, { render: 'underline' });
    expect(underlined.at(-1)!.x).toBeCloseTo(label.x + label.width, 6);
    expect(underlined.at(-2)!.x).toBeCloseTo(label.x - DEFAULT_LANDING.length, 6);
  });

  /**
   * ONE EXPECTED VALUE CHANGED HERE IN PHASE 3.2, named in the commit message: the manual case's
   * landing moved from `{ x: 205, y: 100 }` to `{ x: 200, y: 109.41… }`.
   *
   * What this test is actually for — that `landing` is ignored by all three non-dogleg modes — is
   * unchanged and still asserted both ways round. What changed is where a manual route arrives:
   * it used to be derived from the ANCHOR at (40, 40), up and to the left, which put it on the top
   * edge; it is now derived from the last vertex at (90, 90), which is left of the label, so the
   * leader arrives on the left face it was actually travelling toward.
   */
  it('leaves straight, orthogonal and manual exactly as they were, landing or no landing', () => {
    const landing: LandingGeometry = { length: 99, gap: 99, textLines: { first: 1, last: 2 } };
    const cases = [
      { route: { mode: 'straight' } as const, points: [above, { x: 205, y: 100 }] },
      { route: { mode: 'orthogonal' } as const, points: [above, { x: 205, y: 40 }, { x: 205, y: 100 }] },
      {
        route: { mode: 'manual', vertices: [{ x: 90, y: 90 }] } as const,
        points: [above, { x: 90, y: 90 }, { x: 200, y: 109.41176470588235 }],
      },
    ];
    for (const { route, points } of cases) {
      expect(routeLeg(above, label, route)).toEqual(points);
      expect(routeLeg(above, label, route, landing)).toEqual(points);
    }
  });

  /**
   * Phase 3.2, "manual routes land on the label edge". They always landed on an edge — the defect
   * was WHICH edge: the one facing the arrowhead, chosen before the vertices were even read.
   *
   * A drafter routing a leader up and over to the top of a label is saying where it should arrive.
   * Taking the landing from the anchor instead made the last segment double back across the label
   * the route had just reached, which is the one thing a routed leader is drawn to avoid.
   */
  it('lands a manual route where its last vertex was heading, not where the arrowhead is', () => {
    // Anchor far below-left; the drafter routes up and over so the leader arrives from above.
    const overTheTop = routeLeg(below, label, {
      mode: 'manual',
      vertices: [{ x: 40, y: 60 }, { x: 260, y: 60 }],
    });
    const landed = overTheTop.at(-1)!;
    expect(landed.y).toBeCloseTo(label.y, 6);
    expect(landed.x).toBeGreaterThan(label.x);
    expect(landed.x).toBeLessThan(label.x + label.width);

    // The same route with the old rule would have landed on the bottom edge, under the anchor.
    expect(landed.y).toBeLessThan(label.y + label.height);

    // And with no vertices at all the last point IS the anchor, so nothing about the old
    // single-segment behaviour moves.
    expect(routeLeg(below, label, { mode: 'manual', vertices: [] }))
      .toEqual(routeLeg(below, label, { mode: 'straight' }));
  });
});

describe('dogleg rendering', () => {
  it('draws a visible diagonal for a default-styled annotation', () => {
    const points = drawn(render(note('default', { x: 500, y: 380 })));
    const [start, shoulder] = points as [Vec2, Vec2];
    expect(points).toHaveLength(3);
    expect(Math.abs(shoulder.x - start.x)).toBeGreaterThan(1);
    expect(Math.abs(shoulder.y - start.y)).toBeGreaterThan(1);
  });

  it('meets two labels of equal font size at the same height, whatever their text', () => {
    const short = render(note('short', { x: 500, y: 380 }, 'One', 'lines'), [style('lines')]);
    const tall = render(note('tall', { x: 560, y: 400 }, 'Two\nlines', 'lines2'), [style('lines2')]);
    const attachHeight = (group: Element): number => drawn(group).at(-1)!.y - labelTop(group);
    expect(attachHeight(short)).toBeCloseTo(attachHeight(tall), 6);
    // The centre of the first line: half a line height below the box's padding.
    expect(attachHeight(short)).toBeCloseTo(17, 6);
  });

  it('follows the label scale, so a larger style still meets its first line', () => {
    const group = render(
      note('big', { x: 500, y: 380 }, 'Note', 'big-text'),
      [style('big-text', { fontSize: 28 })],
    );
    // Layout runs at 14 and the group is scaled by 2, so the line centre lands twice as far down.
    expect(drawn(group).at(-1)!.y - labelTop(group)).toBeCloseTo(34, 6);
  });

  it('starts the line at the back of a filled arrowhead, never underneath it', () => {
    const points = drawn(render(note('filled', { x: 500, y: 380 }, 'Note', 'trim'), [style('trim')]));
    const [start, shoulder] = points as [Vec2, Vec2];
    expect(Math.hypot(start.x - 400, start.y - 300)).toBeCloseTo(14 * CAP_RATIO, 3);
    // Trimmed along the diagonal, so the head still covers exactly the gap it left.
    const along = Math.atan2(shoulder.y - 300, shoulder.x - 400);
    expect(Math.atan2(start.y - 300, start.x - 400)).toBeCloseTo(along, 3);
  });

  it('keeps the line on the anchor for an outline head, which hides nothing', () => {
    const group = render(
      note('ticked', { x: 500, y: 380 }, 'Note', 'ticky'),
      [style('ticky', { terminatorId: 'builtin.terminator.tick' })],
    );
    expect(drawn(group)[0]).toEqual({ x: 400, y: 300 });
  });
});
