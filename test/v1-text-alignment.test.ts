/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FONT_SIZE,
  DEFAULT_PADDING,
  layoutBuiltInContent,
  type TextPrimitive,
} from '../src/content.js';
import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type StyleDefinition,
} from '../src/index.js';
import { CAP_RATIO } from '../src/theme.js';

function texts(primitives: ReturnType<typeof layoutBuiltInContent>['primitives']): readonly TextPrimitive[] {
  return primitives.filter((primitive): primitive is TextPrimitive => primitive.kind === 'text');
}

describe('content layout — text alignment', () => {
  it('centres a single tag character in a squared enclosure on both axes', () => {
    const layout = layoutBuiltInContent({ kind: 'tag', text: '1' }, { aspect: 'square' });
    const [line] = texts(layout.primitives);
    expect(line?.align).toBe('middle');
    // Squared: a circle enclosure fits this exactly, never an ellipse.
    expect(layout.bounds.width).toBeCloseTo(layout.bounds.height, 6);
    // Horizontal: text-anchor="middle" makes `x` the centre, not the left edge.
    expect(line?.x).toBeCloseTo(layout.bounds.width / 2, 6);
    // Vertical: the cap-height ink band, not the taller line box, is what sits on the box centre.
    const capTop = line!.baseline - CAP_RATIO * DEFAULT_FONT_SIZE;
    const inkCentre = (capTop + line!.baseline) / 2;
    expect(inkCentre).toBeCloseTo(layout.bounds.height / 2, 5);
  });

  it('centres each line of a multi-line label independently, not against the widest line', () => {
    const layout = layoutBuiltInContent({ kind: 'symbolic-block', symbol: 'circle', label: 'A\nWWWWWWWW' });
    const lines = texts(layout.primitives);
    expect(lines).toHaveLength(2);
    const [narrow, wide] = lines;
    expect(narrow!.bounds.width).toBeLessThan(wide!.bounds.width);
    // Both lines anchor at the same box centre...
    expect(narrow!.x).toBeCloseTo(layout.bounds.width / 2, 6);
    expect(wide!.x).toBeCloseTo(layout.bounds.width / 2, 6);
    // ...but each line's own occupied rectangle is centred on its own width, not the wide line's.
    expect(narrow!.bounds.x).toBeCloseTo((layout.bounds.width - narrow!.bounds.width) / 2, 6);
    expect(wide!.bounds.x).toBeCloseTo((layout.bounds.width - wide!.bounds.width) / 2, 6);
  });

  it('leaves a left-aligned multi-line note exactly as before — start align, x at padding', () => {
    const layout = layoutBuiltInContent({ kind: 'plain-note', text: 'First line\nSecond line' });
    const lines = texts(layout.primitives);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.align).toBe('start');
      expect(line.x).toBeCloseTo(DEFAULT_PADDING, 6);
      expect(line.bounds.x).toBeCloseTo(DEFAULT_PADDING, 6);
    }
  });

  it('recomputes the centred anchor from the current box, so a text change cannot drift it', () => {
    const short = layoutBuiltInContent({ kind: 'tag', text: 'A' }, { aspect: 'square' });
    const long = layoutBuiltInContent({ kind: 'tag', text: 'WWWWWWWWWWWW' }, { aspect: 'square' });
    const [shortLine] = texts(short.primitives);
    const [longLine] = texts(long.primitives);
    // Different text really did resize the box, otherwise this test would prove nothing.
    expect(long.bounds.width).toBeGreaterThan(short.bounds.width);
    // Each still anchors at its own (different) box centre.
    expect(shortLine?.x).toBeCloseTo(short.bounds.width / 2, 6);
    expect(longLine?.x).toBeCloseTo(long.bounds.width / 2, 6);
  });

  it('lets a style override the per-kind default either way', () => {
    const startTag = layoutBuiltInContent({ kind: 'tag', text: 'A' }, { align: 'start' });
    const middleNote = layoutBuiltInContent({ kind: 'plain-note', text: 'A' }, { align: 'middle' });
    expect(texts(startTag.primitives)[0]?.align).toBe('start');
    expect(texts(middleNote.primitives)[0]?.align).toBe('middle');
  });
});

describe('rendered SVG — text alignment', () => {
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

  function render(annotation: AnnotationDraft, styles: readonly StyleDefinition[] = []): readonly SVGTextElement[] {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters });
    for (const definition of styles) leader.definitions.create(definition);
    leader.annotations.create(annotation);
    leader.update();
    return [...root.querySelectorAll<SVGTextElement>(
      `[data-annotation-id="${annotation.id}"] [data-hit-target="label"] text`,
    )];
  }

  it('emits text-anchor="middle" for a tag centred in a circular enclosure', () => {
    const [text] = render(
      { id: 'tag', anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
        content: { kind: 'tag', text: '1' },
        placement: { kind: 'manual', position: { x: 600, y: 120 } },
        styleId: 'bubble' },
      [style('bubble', { enclosureId: 'builtin.enclosure.circle' })],
    );
    expect(text?.getAttribute('text-anchor')).toBe('middle');
  });

  it('omits text-anchor for a left-aligned note — today\'s SVG output, untouched', () => {
    const rendered = render({
      id: 'note',
      anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
      content: { kind: 'plain-note', text: 'First line\nSecond line' },
      placement: { kind: 'manual', position: { x: 600, y: 120 } },
      styleId: 'unpadded',
    }, [style('unpadded')]);
    expect(rendered).toHaveLength(2);
    for (const text of rendered) {
      expect(text.hasAttribute('text-anchor')).toBe(false);
      expect(text.getAttribute('x')).toBe(String(DEFAULT_PADDING));
    }
  });
});
