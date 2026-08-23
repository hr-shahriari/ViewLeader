/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type StyleDefinition,
} from '../src/index.js';
import { CAD_PAPER, CAP_RATIO } from '../src/theme.js';

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
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

function note(id: string, styleId?: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position: { x: 600, y: 120 } },
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

/** Renders one annotation and hands back the whole group, so tests can read route and head. */
function render(annotation: AnnotationDraft, styles: readonly StyleDefinition[] = []): Element {
  const root = boundary();
  const leader = new ViewLeader({ boundary: root, adapters });
  for (const definition of styles) leader.definitions.create(definition);
  leader.annotations.create(annotation);
  leader.update();
  return root.querySelector(`[data-annotation-id="${annotation.id}"]`)!;
}

function head(group: Element, end: 'anchor' | 'label' = 'anchor'): SVGPathElement | null {
  return group.querySelector(`path[data-terminator="${end}"]`);
}

function numbers(value: string | null | undefined): readonly number[] {
  return [...(value ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)].map(([match]) => Number(match));
}

describe('terminator rendering', () => {
  it('draws a filled arrowhead at the anchor of every leg', () => {
    const arrow = head(render(note('plain')));
    expect(arrow).not.toBeNull();
    expect(arrow?.getAttribute('fill')).toBe(CAD_PAPER.ink);
    expect(arrow?.getAttribute('stroke')).toBe('none');
    expect(arrow?.getAttribute('d')).toMatch(/Z$/u);
  });

  it('keeps ASME Y14.2 3:1 length to width', () => {
    // A whole-pixel font size, so the ratio is exact rather than limited by path rounding.
    // The path is tip, then the two back corners: M 0 0 L -length ∓half L -length ±half Z.
    const [, , length, half] = numbers(
      head(render(note('ratio', 'ratio'), [style('ratio')]))?.getAttribute('d') ?? '',
    );
    expect(Math.abs(length!) / (Math.abs(half!) * 2)).toBeCloseTo(3, 6);
  });

  it('sizes the head to text height, so a taller style gets a bigger arrow', () => {
    const small = numbers(head(render(note('small', 'iso-2'), [style('iso-2', { fontSize: 10 })]))
      ?.getAttribute('d'))[2]!;
    const large = numbers(head(render(note('large', 'iso-7'), [style('iso-7', { fontSize: 30 })]))
      ?.getAttribute('d'))[2]!;
    expect(Math.abs(small)).toBeCloseTo(10 * CAP_RATIO, 6);
    expect(Math.abs(large)).toBeCloseTo(30 * CAP_RATIO, 6);
  });

  it('follows the style override, not just the definition', () => {
    const group = render({ ...note('overridden'), styleOverride: { fontSize: 28 } });
    expect(Math.abs(numbers(head(group)?.getAttribute('d'))[2]!)).toBeCloseTo(28 * CAP_RATIO, 6);
  });

  it('rotates the head to the direction of the first leg segment', () => {
    const group = render(note('rotated'));
    const route = numbers(group.querySelector('path[data-route-visible]')?.getAttribute('d'));
    const [startX, startY, backX, backY] = route as [number, number, number, number];
    const expected = Math.atan2(startY - backY, startX - backX) * (180 / Math.PI);
    const transform = head(group)?.getAttribute('transform') ?? '';
    const [x, y, angle] = numbers(transform) as [number, number, number];
    // The tip stays on the projected anchor; the line starts further along, at the head's back edge.
    expect(x).toBeCloseTo(410, 2);
    expect(y).toBeCloseTo(280, 2);
    expect(angle).toBeCloseTo(expected, 2);
  });

  it('sizes the ISO 128-22 surface dot from line width, not text height', () => {
    const dot = (lineWidth: number): number => Math.max(...numbers(
      head(render(
        note(`dot-${lineWidth}`, `dot-${lineWidth}`),
        [style(`dot-${lineWidth}`, { terminatorId: 'builtin.terminator.dot', lineWidth, fontSize: 40 })],
      ))?.getAttribute('d'),
    ).map(Math.abs));
    // 5 × line width across, so 2.5 × line width of radius — and font size must not touch it.
    expect(dot(1)).toBeCloseTo(2.5, 6);
    expect(dot(2)).toBeCloseTo(5, 6);
  });

  it('strokes an outline terminator instead of filling it', () => {
    const tick = head(render(
      note('ticked', 'ticky'),
      [style('ticky', { terminatorId: 'builtin.terminator.tick' })],
    ));
    expect(tick?.getAttribute('fill')).toBe('none');
    expect(tick?.getAttribute('stroke')).toBe('#1f2937');
    expect(tick?.getAttribute('d')).not.toContain('Z');
  });

  it('plugs the label end only when the style asks for it', () => {
    expect(head(render(note('anchor-only')), 'label')).toBeNull();
    const both = render(
      note('both-ends', 'both'),
      [style('both', { labelTerminatorId: 'builtin.terminator.dot' })],
    );
    expect(head(both, 'anchor')).not.toBeNull();
    expect(head(both, 'label')).not.toBeNull();
  });

  it('moves the head with the leader without rebuilding the group', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters });
    leader.annotations.create(note('moving'));
    leader.update();
    const group = root.querySelector('[data-annotation-id="moving"]')!;
    const before = head(group)!;
    const transformBefore = before.getAttribute('transform');

    leader.annotations.update('moving', { placement: { kind: 'manual', position: { x: 120, y: 500 } } });
    leader.update();
    expect(head(group)).toBe(before);
    expect(before.getAttribute('transform')).not.toBe(transformBefore);
  });

  it('refuses a style whose terminator id does not resolve, so render never sees a dangling id', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters });
    expect(() => leader.definitions.create(style('broken', { terminatorId: 'nope' }))).toThrow();
    expect(() => leader.definitions.create(style('broken-label', { labelTerminatorId: 'nope' }))).toThrow();
  });
});
