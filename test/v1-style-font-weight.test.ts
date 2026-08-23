/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationContent,
  type AnnotationDraft,
  type HostAdapterBundle,
  type StyleDefinition,
} from '../src/index.js';

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

function makeLeader(): { leader: ViewLeader; root: HTMLDivElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { leader: new ViewLeader({ boundary: root, adapters }), root };
}

function style(id: string, weight?: 'normal' | 'bold'): StyleDefinition {
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
    ...(weight === undefined ? {} : { content: { weight } }),
  };
}

function note(id: string, styleId: string, content: AnnotationContent): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content,
    styleId,
    placement: { kind: 'manual', position: { x: 200, y: 200 } },
  };
}

/** The `font-weight` the renderer actually emitted for a label's first text run. */
function drawnWeight(root: Element, id: string): string | null {
  return root.querySelector(`[data-annotation-id="${id}"] text`)!.getAttribute('font-weight');
}

describe('a style may set its own font weight', () => {
  it('renders a plain note bold when the style asks, which it could not before', () => {
    const { leader, root } = makeLeader();
    leader.definitions.create(style('bold-note', 'bold'));
    leader.definitions.create(style('plain-note-style'));
    leader.annotations.create(note('bold', 'bold-note', { kind: 'plain-note', text: 'Note' }));
    leader.annotations.create(note('plain', 'plain-note-style', { kind: 'plain-note', text: 'Note' }));
    leader.update();

    expect(drawnWeight(root, 'bold')).toBe('bold');
    expect(drawnWeight(root, 'plain')).not.toBe('bold');
    leader.dispose();
  });

  it('measures bold as bold — the box is wider for the same text', () => {
    const { leader } = makeLeader();
    leader.definitions.create(style('w-bold', 'bold'));
    leader.definitions.create(style('w-normal', 'normal'));
    const text = 'Mechanical equipment schedule';
    leader.annotations.create(note('b', 'w-bold', { kind: 'plain-note', text }));
    leader.annotations.create(note('n', 'w-normal', { kind: 'plain-note', text }));
    leader.update();

    // This is the defect mleader-core/01 existed to fix, applied to the new field: a weight that
    // reaches the renderer but not the measurement produces a box that clips its own text.
    expect(leader.geometry.of('b')!.label.width)
      .toBeGreaterThan(leader.geometry.of('n')!.label.width);
    leader.dispose();
  });

  it('can turn a normally-bold content kind down to regular', () => {
    const { leader, root } = makeLeader();
    leader.definitions.create(style('quiet-tag', 'normal'));
    leader.annotations.create(note('t', 'quiet-tag', { kind: 'tag', text: 'W-12' }));
    leader.update();
    expect(drawnWeight(root, 't')).not.toBe('bold');
    leader.dispose();
  });

  it('leaves a callout body alone — only the primary run follows the style', () => {
    const { leader, root } = makeLeader();
    leader.definitions.create(style('quiet-callout', 'normal'));
    leader.annotations.create(note('c', 'quiet-callout', {
      kind: 'callout',
      title: 'Title',
      text: 'Body copy',
    }));
    leader.update();

    const runs = [...root.querySelectorAll('[data-annotation-id="c"] text')];
    expect(runs.length).toBeGreaterThan(1);
    // The title took the style's weight; the body keeps its own, because the contrast between them
    // is the point of a callout.
    expect(runs[0]!.getAttribute('font-weight')).not.toBe('bold');
    leader.dispose();
  });
});

describe('font weight: the six built-in styles now say so themselves', () => {
  it('a grid bubble renders bold even paired with a plain note', () => {
    const { leader, root } = makeLeader();
    // The exact pairing the loose end named: before, this silently rendered in regular type.
    leader.annotations.create(note('g', 'builtin.style.grid-bubble', {
      kind: 'plain-note',
      text: 'C',
    }));
    leader.update();
    expect(drawnWeight(root, 'g')).toBe('bold');
    leader.dispose();
  });

  it('declares weight on every style that renders bold', () => {
    const { leader } = makeLeader();
    const bold = ['detail-bubble', 'section-head', 'grid-bubble', 'tag-circle', 'tag-hexagon', 'tag-chevron'];
    for (const name of bold) {
      const definition = leader.definitions.get(`builtin.style.${name}`) as StyleDefinition;
      expect(definition.content?.weight, name).toBe('bold');
    }
    // And the note styles stay silent, so they follow their content kind as before.
    for (const name of ['standard', 'note', 'dimension']) {
      const definition = leader.definitions.get(`builtin.style.${name}`) as StyleDefinition;
      expect(definition.content?.weight, name).toBeUndefined();
    }
    leader.dispose();
  });
});

describe('font weight: schema plumbing', () => {
  it('survives a styleOverride like every other style field', () => {
    const { leader, root } = makeLeader();
    leader.definitions.create(style('base'));
    leader.annotations.create({
      ...note('o', 'base', { kind: 'plain-note', text: 'Note' }),
      styleOverride: { content: { weight: 'bold' } },
    });
    leader.update();
    expect(drawnWeight(root, 'o')).toBe('bold');
    leader.dispose();
  });

  it('is published on the screen-geometry surface, resolved as drawn', () => {
    const { leader } = makeLeader();
    leader.definitions.create(style('published', 'bold'));
    leader.annotations.create(note('p', 'published', { kind: 'plain-note', text: 'Note' }));
    leader.update();
    expect(leader.geometry.of('p')!.text.weight).toBe('bold');
    leader.dispose();
  });

  it('rejects a weight that is not normal or bold', () => {
    const { leader } = makeLeader();
    expect(() => leader.definitions.create({
      ...style('bad'),
      content: { weight: 'heavy' as 'bold' },
    })).toThrow();
    leader.dispose();
  });

  it('drops an unreadable weight from a persisted override rather than failing the load', () => {
    const { leader } = makeLeader();
    leader.definitions.create(style('lenient'));
    leader.annotations.create(note('l', 'lenient', { kind: 'plain-note', text: 'Note' }));
    const saved = JSON.parse(leader.documents.serialize()) as {
      annotations: Record<string, unknown>[];
    };
    saved.annotations[0]!.styleOverride = { content: { weight: 'heavy' } };

    expect(() => leader.documents.replace(saved as never)).not.toThrow();
    leader.update();
    // Strict to author, lenient to load: the bad value is ignored, the document still opens.
    expect(leader.annotations.get('l')).toBeDefined();
    leader.dispose();
  });
});
