/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  ViewLeader,
  mergeStyleOverride,
  readStyleOverride,
  type AnnotationDraft,
  type HostAdapterBundle,
  type NeutralViewerState,
  type StyleDefinition,
  type ViewerStateAdapter,
} from '../src/index.js';

/**
 * A styling panel has to show the value actually being drawn, and know whether it came from the
 * style or from an override — otherwise a colour picker cannot show its own current colour, and
 * "revert to style" cannot exist. Both used to require re-implementing the merge, including the
 * saved-view layer the host cannot see.
 */

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

function note(id: string, extra: Partial<AnnotationDraft> = {}): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
    content: { kind: 'plain-note', text: id },
    ...extra,
  };
}

function build(): ViewLeader {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new ViewLeader({ boundary: element, adapters });
}

describe('resolved style with provenance', () => {
  it('reports the style’s own values when nothing overrides them', () => {
    const leader = build();
    leader.definitions.create(style('house', { lineColor: '#0000ff' }));
    leader.annotations.create(note('a', { styleId: 'house' }));

    const resolved = leader.annotations.resolvedStyle('a')!;
    expect(resolved.lineColor).toBe('#0000ff');
    expect(resolved.styleId).toBe('house');
    expect(resolved.from.lineColor).toBe('style');
    leader.dispose();
  });

  it('reports the annotation’s override, and marks only that field', () => {
    const leader = build();
    leader.definitions.create(style('house', { lineColor: '#0000ff', textColor: '#00ff00' }));
    leader.annotations.create(note('a', {
      styleId: 'house',
      styleOverride: { lineColor: '#ff0000' },
    }));

    const resolved = leader.annotations.resolvedStyle('a')!;
    expect(resolved.lineColor).toBe('#ff0000');
    expect(resolved.from.lineColor).toBe('annotation-override');
    // The neighbouring field is untouched, which is what stops a panel writing back a value the
    // user never edited.
    expect(resolved.textColor).toBe('#00ff00');
    expect(resolved.from.textColor).toBe('style');
    leader.dispose();
  });

  it('merges landing one level deep rather than replacing it', () => {
    const leader = build();
    leader.definitions.create(style('house', { landing: { length: 10, side: 'left' } }));
    leader.annotations.create(note('a', {
      styleId: 'house',
      styleOverride: { landing: { length: 20 } },
    }));

    const resolved = leader.annotations.resolvedStyle('a')!;
    expect(resolved.landing?.length).toBe(20);
    // A one-field override must not wipe out the style's other landing settings beside it.
    expect(resolved.landing?.side).toBe('left');
    leader.dispose();
  });

  it('falls back to the standard style when the annotation names none', () => {
    const leader = build();
    leader.annotations.create(note('a'));
    const resolved = leader.annotations.resolvedStyle('a')!;
    expect(resolved.styleId).toBe('builtin.style.standard');
    expect(resolved.from.lineColor).toBe('style');
    leader.dispose();
  });

  it('returns nothing for an annotation that does not exist', () => {
    const leader = build();
    expect(leader.annotations.resolvedStyle('missing')).toBeUndefined();
    leader.dispose();
  });

  it('is stable between changes, and changes when the override does', () => {
    const leader = build();
    leader.definitions.create(style('house'));
    leader.annotations.create(note('a', { styleId: 'house' }));

    const first = leader.annotations.resolvedStyle('a')!;
    expect(first.lineColor).toBe('#1f2937');

    leader.annotations.update('a', { styleOverride: { lineColor: '#ff0000' } });
    const second = leader.annotations.resolvedStyle('a')!;
    expect(second.lineColor).toBe('#ff0000');
    expect(second.from.lineColor).toBe('annotation-override');
    leader.dispose();
  });

  it('exposes the merge helpers a read-modify-write needs', () => {
    // `update({ styleOverride })` replaces the whole override, so setting one field means reading
    // the current one and merging. Without these exported, every host re-implements the deep merge.
    const current = readStyleOverride({ lineColor: '#ff0000', landing: { length: 10 } });
    const next = mergeStyleOverride(current, { landing: { side: 'right' } });
    expect(next.lineColor).toBe('#ff0000');
    expect(next.landing).toEqual({ length: 10, side: 'right' });
  });
});

/**
 * The saved-view layer is the reason this had to live in core. A host can read an annotation's own
 * `styleOverride` from the document, but the active view's override is transient runtime state it
 * has no access to — so a panel computing the effective style itself is wrong exactly when a view
 * is active, and silently right the rest of the time.
 */
describe('the saved-view layer', () => {
  const neutralState: NeutralViewerState = {
    camera: {
      projection: 'perspective',
      position: { x: 0, y: 2, z: 4 },
      direction: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      verticalFieldOfView: 45,
      near: 0.1,
      far: 1_000,
    },
    modelVisibility: [],
    elementVisibility: [],
    selection: [],
    colorOverrides: [],
    clippingPlanes: [],
  };

  const viewerState: ViewerStateAdapter<{ readonly next: NeutralViewerState }> = {
    capture: () => structuredClone(neutralState),
    prepare: (next) => ({ next }),
    apply: () => undefined,
    rollback: () => undefined,
  };

  it('outranks the annotation\u2019s own override while the view is active', async () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const leader = new ViewLeader({
      boundary: element,
      adapters: { ...adapters, viewerState },
    });
    leader.definitions.create(style('house', { lineColor: '#0000ff' }));
    leader.annotations.create(note('a', {
      styleId: 'house',
      styleOverride: { lineColor: '#00ff00' },
    }));

    const beforeActivation = leader.annotations.resolvedStyle('a')!;
    expect(beforeActivation.lineColor).toBe('#00ff00');
    expect(beforeActivation.from.lineColor).toBe('annotation-override');

    leader.views.insert({
      id: 'review',
      name: 'Review',
      viewerState: structuredClone(neutralState),
      annotationOverrides: { a: { style: { lineColor: '#ff0000' } } },
    });
    await leader.views.activate('review');

    const active = leader.annotations.resolvedStyle('a')!;
    expect(active.lineColor).toBe('#ff0000');
    expect(active.from.lineColor).toBe('view-override');
    leader.dispose();
  });
});
