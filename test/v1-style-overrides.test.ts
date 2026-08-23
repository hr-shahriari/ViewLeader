/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type NeutralViewerState,
  type SavedViewAnnotationOverride,
  type StyleDefinition,
  type StyleOverride,
  type ViewerStateAdapter,
} from '../src/index.js';
import { mergeStyleOverride, readStyleOverride } from '../src/definitions.js';
import { CAD_PAPER, PEN } from '../src/theme.js';

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

/** Same scalars as `builtin.style.standard`, so a head resolved either way is comparable. */
function style(id: string, extra: Partial<StyleDefinition> = {}): StyleDefinition {
  return {
    kind: 'style',
    id,
    name: id,
    lineColor: CAD_PAPER.ink,
    lineWidth: PEN.thin,
    textColor: CAD_PAPER.ink,
    fontFamily: CAD_PAPER.fontStack,
    fontSize: CAD_PAPER.fontSize,
    terminatorId: 'builtin.terminator.arrow',
    ...extra,
  };
}

function render(annotation: AnnotationDraft, styles: readonly StyleDefinition[] = []): Element {
  const root = boundary();
  const leader = new ViewLeader({ boundary: root, adapters });
  for (const definition of styles) leader.definitions.create(definition);
  leader.annotations.create(annotation);
  leader.update();
  return root.querySelector(`[data-annotation-id="${annotation.id}"]`)!;
}

function headPath(group: Element): string | null {
  return group.querySelector('path[data-terminator="anchor"]')?.getAttribute('d') ?? null;
}

function outline(group: Element): SVGPathElement {
  return group.querySelector('[data-hit-target="label"] path')!;
}

const captured: NeutralViewerState = {
  camera: {
    projection: 'orthographic',
    position: { x: 0, y: 0, z: 10 },
    direction: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
    height: 20,
    near: 0.1,
    far: 100,
  },
  modelVisibility: [],
  elementVisibility: [],
  selection: [],
  colorOverrides: [],
  clippingPlanes: [],
};

describe('typed style overrides', () => {
  it('deep-merges a group, so { landing: { gap: 8 } } keeps length, side and render', () => {
    const base = style('deep', {
      landing: { length: 20, side: 'left', gap: 2, render: 'underline' },
    });

    expect(mergeStyleOverride(base, { landing: { gap: 8 } }).landing).toEqual({
      length: 20,
      side: 'left',
      gap: 8,
      render: 'underline',
    });
  });

  it('leaves a group absent when neither side declares it', () => {
    expect(mergeStyleOverride(style('bare'), { fontSize: 20 })).not.toHaveProperty('landing');
  });

  it('makes a mistyped key a compile error where it is written', () => {
    // @ts-expect-error - `linecolor` is not a style field.
    const loose: StyleOverride = { linecolor: 'red' };
    const draft: AnnotationDraft = {
      ...note('typed'),
      // @ts-expect-error - the same typo, on the authoring draft.
      styleOverride: { linecolor: 'red' },
    };
    const view: SavedViewAnnotationOverride = {
      // @ts-expect-error - and on the saved-view layer, which is the same typed partial.
      style: { linecolor: 'red' },
    };

    expect([loose, draft, view]).toHaveLength(3);
  });

  it('changes the terminator when the override carries terminatorId', () => {
    const viaStyle = headPath(render(note('by-style', 'dotted'), [
      style('dotted', { terminatorId: 'builtin.terminator.dot' }),
    ]));
    const viaOverride = headPath(render({
      ...note('by-override'),
      styleOverride: { terminatorId: 'builtin.terminator.dot' },
    }));

    expect(viaOverride).toBe(viaStyle);
    expect(viaOverride).not.toBe(headPath(render(note('plain'))));
  });

  it('changes the enclosure and repaints its box from the override', () => {
    const painted = outline(render(
      { ...note('boxed', 'card'), styleOverride: { content: { borderWidth: 5 } } },
      [style('card', {
        enclosureId: 'builtin.enclosure.circle',
        content: { backgroundColor: '#00ff00', borderWidth: 1 },
      })],
    ));

    // Only borderWidth was overridden, so the style's background survives the merge.
    expect(painted.getAttribute('stroke-width')).toBe('5');
    expect(painted.getAttribute('fill')).toBe('#00ff00');
    expect(painted.getAttribute('d')).toContain('C');
  });

  it('keeps understood fields and reports the rest, nested keys included', () => {
    const dropped: string[] = [];
    const parsed = readStyleOverride(
      { fontSize: 22, glow: true, landing: { gap: 8, sparkle: 'yes' } },
      dropped,
    );

    expect(parsed).toEqual({ fontSize: 22, landing: { gap: 8 } });
    expect(dropped).toEqual(['glow', 'landing.sparkle']);
  });

  it('drops a value the field cannot hold without calling the field unknown', () => {
    const dropped: string[] = [];

    expect(readStyleOverride({ fontSize: -3, landing: { side: 'sideways' } }, dropped))
      .toEqual({ landing: {} });
    expect(dropped).toEqual([]);
  });

  it('loads a document with an unrecognised override key and reports it exactly once', () => {
    const root = boundary();
    const seed = new ViewLeader({ boundary: root, adapters });
    seed.annotations.create(note('legacy'));
    const parsed = JSON.parse(seed.documents.serialize()) as {
      annotations: { styleOverride?: unknown }[];
    };
    seed.dispose();
    parsed.annotations[0]!.styleOverride = { lineColor: '#ff0000', glow: true };

    const leader = new ViewLeader({
      boundary: root,
      adapters,
      initialDocument: parsed as never,
    });
    leader.update();
    leader.update();

    expect(leader.diagnostics.getSnapshot()).toEqual([
      expect.objectContaining({
        code: 'STYLE_OVERRIDE_FIELD_IGNORED',
        severity: 'warning',
        annotationId: 'legacy',
      }),
    ]);
    // The understood field still applies, and the document keeps what it could not read.
    const route = root.querySelector('[data-annotation-id="legacy"] path[data-route-visible]');
    expect(route?.getAttribute('stroke')).toBe('#ff0000');
    expect(JSON.parse(leader.documents.serialize()).annotations[0].styleOverride).toEqual({
      lineColor: '#ff0000',
      glow: true,
    });
    leader.dispose();
  });

  it('deep-merges the annotation and saved-view layers against each other', async () => {
    const root = boundary();
    const viewerState: ViewerStateAdapter<NeutralViewerState> = {
      capture: () => captured,
      prepare: (next) => next,
      apply: () => undefined,
      rollback: () => undefined,
    };
    const leader = new ViewLeader({ boundary: root, adapters: { ...adapters, viewerState } });
    leader.definitions.create(style('card', {
      content: { backgroundColor: '#00ff00', borderWidth: 1 },
    }));
    leader.annotations.create({
      ...note('layered', 'card'),
      styleOverride: { content: { borderColor: '#0000ff' } },
    });
    leader.views.insert({
      id: 'review',
      name: 'Review',
      viewerState: captured,
      annotationOverrides: { layered: { style: { content: { borderWidth: 7 } } } },
    });
    await leader.views.activate('review');
    leader.update();

    // Three sources, one box: the style's fill, the annotation's border colour, the view's width.
    const painted = outline(root.querySelector('[data-annotation-id="layered"]')!);
    expect(painted.getAttribute('fill')).toBe('#00ff00');
    expect(painted.getAttribute('stroke')).toBe('#0000ff');
    expect(painted.getAttribute('stroke-width')).toBe('7');
    leader.dispose();
  });
});

describe('override reaches routing', () => {
  // Ticket 04 shipped before ticket 08 existed, so its `landing` bullet had no end-to-end proof.
  // Now routing consumes the merged landing, this pins the two together.
  it('routes with a landing length the override changed', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const leader = new ViewLeader({
      boundary: root,
      adapters: {
        projection: {
          getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
          project: (point) => ({
            point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
            depth: point.z,
            visible: true,
          }),
        },
      },
    });
    const landings = [12, 60].map((length) => {
      const id = `landing-${length}`;
      leader.annotations.create({
        id,
        anchor: { kind: 'world-point', point: { x: -8, y: 4, z: 0 } },
        content: { kind: 'plain-note', text: 'Note' },
        placement: { kind: 'manual', position: { x: 600, y: 120 } },
        routing: { kind: 'automatic', mode: 'dogleg' },
        styleOverride: { landing: { length } },
      });
      leader.update();
      const path = root.querySelector(`[data-annotation-id="${id}"] path[data-route-visible]`);
      const points = [...(path?.getAttribute('d') ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)].map(([m]) => Number(m));
      // Last two segments are the landing: shoulder → label attachment.
      return Math.abs(points.at(-2)! - points.at(-4)!);
    });
    expect(landings[0]).toBeCloseTo(12, 3);
    expect(landings[1]).toBeCloseTo(60, 3);
    leader.dispose();
  });
});
