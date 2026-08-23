/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type StyleDefinition,
} from '../src/index.js';

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

function note(id: string, text: string, styleId?: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
    content: { kind: 'plain-note', text },
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
    // Layout runs at 14, so keeping styles here means no scale group wraps the primitives.
    fontSize: 14,
    terminatorId: 'builtin.terminator.arrow',
    ...extra,
  };
}

interface Rendered {
  readonly outline: SVGPathElement;
  readonly firstText: SVGTextElement;
}

function render(annotation: AnnotationDraft, styles: readonly StyleDefinition[] = []): Rendered {
  const root = boundary();
  const leader = new ViewLeader({ boundary: root, adapters });
  for (const definition of styles) leader.definitions.create(definition);
  leader.annotations.create(annotation);
  leader.update();
  const label = root.querySelector(`[data-annotation-id="${annotation.id}"] [data-hit-target="label"]`)!;
  return {
    outline: label.querySelector('path')!,
    firstText: label.querySelector('text')!,
  };
}

/** Axis-aligned extent of every coordinate pair in a path, which is the box the shape occupies. */
function extent(path: SVGPathElement): Readonly<{ width: number; height: number }> {
  const values = [...(path.getAttribute('d') ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)].map(([m]) => Number(m));
  const xs = values.filter((_, index) => index % 2 === 0);
  const ys = values.filter((_, index) => index % 2 === 1);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

describe('enclosure rendering', () => {
  it('renders a circle when the style asks for one, not a rectangle', () => {
    const { outline } = render(note('bubble', 'A1', 'grid'), [
      style('grid', { enclosureId: 'builtin.enclosure.circle' }),
    ]);
    expect(outline.getAttribute('d')).toContain('C');
    const box = extent(outline);
    // aspect: 'square' forces the content box square, so the circle stays a circle.
    expect(box.width).toBeCloseTo(box.height, 6);
  });

  it('lets a free-aspect shape stretch to wide text', () => {
    const { outline } = render(note('wide', 'A rather wide chevron label', 'flow'), [
      style('flow', { enclosureId: 'builtin.enclosure.chevron' }),
    ]);
    const box = extent(outline);
    expect(box.width).toBeGreaterThan(box.height * 2);
  });

  it('grows the enclosure with its text', () => {
    const single = extent(render(note('one-line', 'Level 1', 'grow'), [
      style('grow', { enclosureId: 'builtin.enclosure.hexagon' }),
    ]).outline);
    const double = extent(render(note('two-line', 'Level 1\nSlab edge', 'grow2'), [
      style('grow2', { enclosureId: 'builtin.enclosure.hexagon' }),
    ]).outline);
    expect(double.height).toBeGreaterThan(single.height);
    expect(double.width).toBeGreaterThan(single.width);
  });

  it('puts the style padding between text and outline, measured', () => {
    const padded = render(note('padded', 'Note', 'pad'), [
      style('pad', { content: { padding: 5 } }),
    ]);
    const loose = render(note('loose', 'Note', 'pad-wide'), [
      style('pad-wide', { content: { padding: 20 } }),
    ]);
    expect(Number(padded.firstText.getAttribute('x'))).toBeCloseTo(5, 6);
    expect(Number(loose.firstText.getAttribute('x'))).toBeCloseTo(20, 6);
    // The box grows by twice the extra padding, on both axes.
    expect(extent(loose.outline).width - extent(padded.outline).width).toBeCloseTo(30, 6);
    expect(extent(loose.outline).height - extent(padded.outline).height).toBeCloseTo(30, 6);
  });

  it('masks the model at opacity 1 and leaves it visible at 0', () => {
    const opaque = render(note('opaque', 'Note', 'mask'), [
      style('mask', { content: { backgroundColor: '#FFFFFF', backgroundOpacity: 1 } }),
    ]);
    const clear = render(note('clear', 'Note', 'no-mask'), [
      style('no-mask', { content: { backgroundColor: '#FFFFFF', backgroundOpacity: 0 } }),
    ]);
    expect(opaque.outline.getAttribute('fill')).toBe('#FFFFFF');
    expect(opaque.outline.getAttribute('fill-opacity')).toBe('1');
    expect(clear.outline.getAttribute('fill-opacity')).toBe('0');
  });

  it('takes border colour and width from the content box, not the leader line', () => {
    const { outline } = render(note('framed', 'Note', 'frame'), [
      style('frame', { content: { borderColor: '#B91C1C', borderWidth: 3 } }),
    ]);
    expect(outline.getAttribute('stroke')).toBe('#B91C1C');
    expect(outline.getAttribute('stroke-width')).toBe('3');
  });

  it('rounds a rectangle for a border radius and leaves other shapes alone', () => {
    const rounded = render(note('rounded', 'Note', 'radius'), [
      style('radius', {
        enclosureId: 'builtin.enclosure.rectangle',
        content: { borderRadius: 4 },
      }),
    ]);
    expect(rounded.outline.getAttribute('d')).toContain('Q');

    // The circle declares no radiused corners, so the radius is ignored rather than surprising.
    const circle = render(note('circle-radius', 'A1', 'radius-circle'), [
      style('radius-circle', {
        enclosureId: 'builtin.enclosure.circle',
        content: { borderRadius: 4 },
      }),
    ]);
    const box = extent(circle.outline);
    expect(box.width).toBeCloseTo(box.height, 6);
  });

  it('keeps content layout\'s own box when the style names no enclosure', () => {
    // Omitting enclosureId means "whatever the content draws" — a tag stays a pill, a symbolic
    // block stays its symbol. The consequence is that borderRadius needs an enclosure to act on.
    const { outline } = render(note('bare', 'Note', 'bare-style'), [style('bare-style')]);
    expect(outline.getAttribute('d')).toMatch(/^M 0 0 H /u);
  });

  it('leaves a callout divider on the plain stroke, painting only the enclosure', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters });
    leader.definitions.create(style('tinted', {
      content: { backgroundColor: '#FEF3C7', borderColor: '#B45309' },
    }));
    leader.annotations.create({
      id: 'callout',
      anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
      content: { kind: 'callout', title: 'Title', text: 'Body' },
      placement: { kind: 'manual', position: { x: 600, y: 120 } },
      styleId: 'tinted',
    });
    leader.update();
    const paths = [...root.querySelectorAll('[data-hit-target="label"] path')];
    expect(paths[0]?.getAttribute('fill')).toBe('#FEF3C7');
    expect(paths[1]?.getAttribute('fill')).toBe('none');
    expect(paths[1]?.getAttribute('stroke')).toBe('#1f2937');
  });

  it('refuses a style whose enclosure id does not resolve, so render never sees a dangling id', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters });
    expect(() => leader.definitions.create(style('broken', { enclosureId: 'nope' }))).toThrow();
  });
});
