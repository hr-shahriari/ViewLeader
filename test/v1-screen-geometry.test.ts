/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type StyleDefinition,
} from '../src/index.js';
import type { Vec2 } from '../src/types.js';

/** Anchors every note on the world origin, so projection is the only thing that moves it. */
function note(id: string, position: Vec2, styleId?: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    routing: { kind: 'automatic', mode: 'dogleg' },
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position },
    ...(styleId === undefined ? {} : { styleId }),
  };
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

/** The drawn route, parsed straight out of the `d` attribute — same technique as the dogleg test. */
function drawn(root: Element, id: string): readonly Vec2[] {
  const path = root.querySelector(`[data-annotation-id="${id}"] path[data-route-visible]`);
  const numbers = [...(path?.getAttribute('d') ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)]
    .map(([match]) => Number(match));
  return numbers.reduce<Vec2[]>((points, value, index) =>
    index % 2 === 0 ? [...points, { x: value, y: 0 }] : [...points.slice(0, -1), { x: points.at(-1)!.x, y: value }],
    []);
}

/** The label box the renderer drew, read back from the hit rect and the group's translate. */
function drawnLabelRect(root: Element, id: string): { x: number; y: number; width: number; height: number } {
  const group = root.querySelector(`[data-annotation-id="${id}"] g[data-hit-target="label"]`)!;
  const [tx, ty] = [...(group.getAttribute('transform') ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)]
    .map(([match]) => Number(match));
  const rect = group.querySelector('rect')!;
  return {
    x: tx! + Number(rect.getAttribute('x')) + 4,
    y: ty! + Number(rect.getAttribute('y')) + 4,
    width: Number(rect.getAttribute('width')) - 8,
    height: Number(rect.getAttribute('height')) - 8,
  };
}

function makeLeader(adapters: HostAdapterBundle): { leader: ViewLeader; root: Element } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { leader: new ViewLeader({ boundary: root, adapters }), root };
}

const fixedAdapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
    project: (point) => ({
      point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
      depth: point.z,
      visible: true,
    }),
  },
};

describe('screen geometry surface', () => {
  it('returns undefined for an unknown id rather than throwing', () => {
    const { leader } = makeLeader(fixedAdapters);
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    expect(() => leader.geometry.of('does-not-exist')).not.toThrow();
    expect(leader.geometry.of('does-not-exist')).toBeUndefined();
  });

  it('label rect matches what the renderer drew', () => {
    const { leader, root } = makeLeader(fixedAdapters);
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    const geometry = leader.geometry.of('a1')!;
    // The DOM carries rounded attributes, so compare at the renderer's own 3-decimal precision.
    const drawnRect = drawnLabelRect(root, 'a1');
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(geometry.label[key], key).toBeCloseTo(drawnRect[key], 3);
    }
    // Manual placement pins the label's top-left directly, so this is exact, not approximate.
    expect(geometry.label.x).toBe(500);
    expect(geometry.label.y).toBe(380);
  });

  it('leg polylines match the drawn path, including the dogleg landing', () => {
    const { leader, root } = makeLeader(fixedAdapters);
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    const geometry = leader.geometry.of('a1')!;
    expect(geometry.legs).toHaveLength(1);
    const [leg] = geometry.legs;
    const [drawnLeg] = [drawn(root, 'a1')];
    expect(leg).toHaveLength(drawnLeg.length);
    leg!.forEach((point, index) => {
      expect(point.x).toBeCloseTo(drawnLeg[index]!.x, 2);
      expect(point.y).toBeCloseTo(drawnLeg[index]!.y, 2);
    });
    // The dogleg signature: diagonal shoulder, then a horizontal landing into the label.
    expect(leg).toHaveLength(3);
    expect(leg![2]!.y).toBe(leg![1]!.y);
  });

  it('handle position is the true anchor, not the arrowhead-trimmed drawn start', () => {
    const { leader } = makeLeader(fixedAdapters);
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    const geometry = leader.geometry.of('a1')!;
    expect(geometry.handles).toHaveLength(1);
    const [handle] = geometry.handles;
    // Default style has a filled arrowhead, so the drawn line starts short of the real anchor —
    // the handle must still report the anchor itself, since that is what a drag would retarget.
    expect(handle!.index).toBe(0);
    expect(handle!.at).toEqual({ x: 400, y: 300 });
    expect(geometry.legs[0]![0]).not.toEqual(handle!.at);
  });

  it('text metrics scale with the style font size', () => {
    const { leader } = makeLeader(fixedAdapters);
    leader.definitions.create(style('big-text', { fontSize: 28 }));
    leader.annotations.create(note('a1', { x: 500, y: 380 }, 'big-text'));
    leader.update();
    const geometry = leader.geometry.of('a1')!;
    expect(geometry.text.fontFamily).toBe('sans-serif');
    expect(geometry.text.fontSize).toBe(28);
    // Layout's line height is defined at font size 14; twice the font size is twice the line height.
    expect(geometry.text.lineHeight).toBeCloseTo(36, 6);
  });

  it('orbiting the camera changes the returned coordinates', () => {
    let offset = 0;
    const orbiting: HostAdapterBundle = {
      projection: {
        getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
        project: (point) => ({
          point: { x: 400 + offset + point.x * 10, y: 300 - point.y * 10 },
          depth: point.z,
          visible: true,
        }),
      },
    };
    const { leader } = makeLeader(orbiting);
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    const before = leader.geometry.of('a1')!;

    offset = 50;
    leader.update();
    const after = leader.geometry.of('a1')!;

    expect(after.handles[0]!.at.x - before.handles[0]!.at.x).toBeCloseTo(50, 6);
    expect(after.legs[0]![0]!.x).not.toBeCloseTo(before.legs[0]![0]!.x, 6);
  });

  it('freezes the returned geometry at every level, so a host cannot mutate layout through it', () => {
    const { leader } = makeLeader(fixedAdapters);
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    const geometry = leader.geometry.of('a1')!;
    expect(Object.isFrozen(geometry)).toBe(true);
    expect(Object.isFrozen(geometry.label)).toBe(true);
    expect(Object.isFrozen(geometry.legs)).toBe(true);
    expect(Object.isFrozen(geometry.legs[0])).toBe(true);
    expect(Object.isFrozen(geometry.handles)).toBe(true);
    expect(Object.isFrozen(geometry.handles[0])).toBe(true);
    expect(Object.isFrozen(geometry.text)).toBe(true);
  });
});

describe('screen geometry is a copy', () => {
  // The acceptance bullet is that a host cannot mutate layout through the surface. Freezing the
  // returned objects is not enough on its own — the points inside them were shared with the plan.
  it('hands out frozen point copies, so writing through them cannot move the drawn leader', () => {
    const { leader, root } = makeLeader(fixedAdapters);
    leader.annotations.create(note('copied', { x: 600, y: 120 }));
    leader.update();
    const geometry = leader.geometry.of('copied')!;
    expect(Object.isFrozen(geometry.legs[0]![0])).toBe(true);
    expect(Object.isFrozen(geometry.handles[0]!.at)).toBe(true);

    const before = drawn(root, 'copied');
    expect(() => { (geometry.handles[0]!.at as { x: number }).x = -999; }).toThrow();
    leader.update();
    expect(drawn(root, 'copied')).toEqual(before);
    leader.dispose();
  });
});

// Added after ticket 09's inline-text example found that size alone is not enough to put a text
// field over a label: colour, alignment and padding are all resolved values a host cannot recover
// from `definitions.get(styleId)`.
describe('screen geometry publishes the resolved text style', () => {
  it('reports the colour, alignment and padding actually drawn', () => {
    const { leader } = makeLeader(fixedAdapters);
    leader.definitions.create(style('boxed', {
      textColor: '#0b5394',
      content: { padding: 11, align: 'middle' },
    }));
    leader.annotations.create(note('a1', { x: 500, y: 380 }, 'boxed'));
    leader.update();
    const { text } = leader.geometry.of('a1')!;
    expect(text.textColor).toBe('#0b5394');
    expect(text.align).toBe('middle');
    expect(text.padding).toBe(11);
    leader.dispose();
  });

  it('follows a per-annotation styleOverride, which reading the style definition would miss', () => {
    const { leader } = makeLeader(fixedAdapters);
    leader.definitions.create(style('plain', { textColor: '#111827' }));
    leader.annotations.create({
      ...note('a1', { x: 500, y: 380 }, 'plain'),
      styleOverride: { textColor: '#b91c1c' },
    });
    leader.update();
    // The definition still says #111827; the annotation was drawn in #b91c1c.
    expect(leader.definitions.get('plain')).toMatchObject({ textColor: '#111827' });
    expect(leader.geometry.of('a1')!.text.textColor).toBe('#b91c1c');
    leader.dispose();
  });

  it('resolves an unset padding to the layout default, which is not otherwise reachable', () => {
    const { leader } = makeLeader(fixedAdapters);
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    const { padding } = leader.geometry.of('a1')!.text;
    expect(padding).toBeGreaterThan(0);
    // Consistent with the drawn box: the label is wider than its text by two paddings at minimum.
    expect(leader.geometry.of('a1')!.label.width).toBeGreaterThan(padding * 2);
    leader.dispose();
  });
});
