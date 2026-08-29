/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type StyleDefinition,
} from '../src/index.js';
import { StyleEditor } from '../src/internal/style-editor.js';

/**
 * A styling panel over a multi-selection is where the document's write semantics bite: the patch
 * replaces the whole override rather than merging it, `undefined` throws instead of clearing, and
 * an unwrapped loop turns one gesture into one undo step per annotation. These tests are the
 * evidence that the editor absorbs all three so a host never has to know.
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
    styleId: 'house',
    ...extra,
  };
}

function build(): ViewLeader {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const leader = new ViewLeader({ boundary: element, adapters });
  leader.definitions.create(style('house', {
    lineColor: '#0000ff',
    textColor: '#00ff00',
    landing: { length: 10, side: 'left' },
  }));
  return leader;
}

describe('reading a selection', () => {
  it('reports the resolved value and where it came from, for one annotation', () => {
    const leader = build();
    leader.annotations.create(note('a', { styleOverride: { lineColor: '#ff0000' } }));
    leader.annotations.select(['a']);
    const editor = new StyleEditor(leader);

    const { ids, styleId, fields } = editor.getSnapshot();
    expect(ids).toEqual(['a']);
    expect(styleId).toEqual({ value: 'house', mixed: false });
    expect(fields.lineColor).toEqual({ value: '#ff0000', mixed: false, source: 'annotation-override' });
    expect(fields.textColor).toEqual({ value: '#00ff00', mixed: false, source: 'style' });
    leader.dispose();
  });

  it('is empty with nothing selected, so a panel has something to disable on', () => {
    const leader = build();
    leader.annotations.create(note('a'));
    const editor = new StyleEditor(leader);

    const snapshot = editor.getSnapshot();
    expect(snapshot.ids).toEqual([]);
    expect(snapshot.styleId).toBeUndefined();
    expect(snapshot.fields.lineColor).toBeUndefined();
    leader.dispose();
  });

  it('agrees across a selection that agrees, and reports the rest as mixed', () => {
    const leader = build();
    leader.annotations.create(note('a', { styleOverride: { lineColor: '#ff0000' } }));
    leader.annotations.create(note('b', { styleOverride: { lineColor: '#ff0000' } }));
    leader.annotations.create(note('c'));
    leader.annotations.select(['a', 'b']);
    const editor = new StyleEditor(leader);

    // Two annotations that were overridden the same way are not mixed.
    expect(editor.getSnapshot().fields.lineColor)
      .toEqual({ value: '#ff0000', mixed: false, source: 'annotation-override' });

    leader.annotations.select(['a', 'b', 'c']);
    const mixed = editor.getSnapshot().fields.lineColor!;
    expect(mixed.value).toBe('#ff0000');
    expect(mixed.mixed).toBe(true);
    expect(mixed.source).toBe('mixed');

    // `value` is still a real colour — the first selected annotation's — so it binds straight into
    // the input a mixed selection is being shown in. A sentinel would need translating first, and
    // `<input type="color">` silently rewrites anything it cannot parse to `#000000`.
    const input = document.createElement('input');
    input.type = 'color';
    input.value = mixed.value;
    expect(input.value).toBe('#ff0000');

    // A field they still agree on stays unmixed, which is what stops a panel writing back
    // everything just because one field disagreed.
    expect(editor.getSnapshot().fields.textColor?.mixed).toBe(false);
    leader.dispose();
  });
});

describe('writing one field', () => {
  it('leaves the neighbouring override alone', () => {
    const leader = build();
    leader.annotations.create(note('a', { styleOverride: { lineColor: '#ff0000' } }));
    leader.annotations.select(['a']);
    const editor = new StyleEditor(leader);

    editor.set('textColor', '#123456');

    // The whole point of the read-modify-write: the patch replaces the override, so a naive
    // `update({ styleOverride: { textColor } })` would have dropped the colour the user set first.
    const resolved = leader.annotations.resolvedStyle('a')!;
    expect(resolved.textColor).toBe('#123456');
    expect(resolved.lineColor).toBe('#ff0000');
    expect(resolved.from.lineColor).toBe('annotation-override');
    leader.dispose();
  });

  it('merges a group one level down instead of clobbering it', () => {
    const leader = build();
    leader.annotations.create(note('a'));
    leader.annotations.select(['a']);
    const editor = new StyleEditor(leader);

    editor.set('landing', { length: 20 });

    const resolved = leader.annotations.resolvedStyle('a')!;
    expect(resolved.landing?.length).toBe(20);
    expect(resolved.landing?.side).toBe('left');
    leader.dispose();
  });

  it('restyles five annotations as one undo step', () => {
    const leader = build();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids) leader.annotations.create(note(id));
    leader.annotations.select(ids);
    const editor = new StyleEditor(leader, { labels: { set: 'Recolour selection' } });

    const before = leader.history.getSnapshot().undoCount;
    editor.set('lineColor', '#ff0000');

    // Unwrapped, each `update()` opens its own transaction and this would be five.
    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);
    expect(leader.history.getSnapshot().undoLabel).toBe('Recolour selection');
    for (const id of ids) expect(leader.annotations.resolvedStyle(id)!.lineColor).toBe('#ff0000');

    leader.history.undo();
    for (const id of ids) expect(leader.annotations.resolvedStyle(id)!.lineColor).toBe('#0000ff');
    leader.dispose();
  });

  it('names the annotation that failed, keeps the code, and applies nothing', () => {
    const leader = build();
    for (const id of ['a', 'b', 'c']) {
      leader.annotations.create(note(id, { styleOverride: { lineColor: '#ff0000' } }));
    }
    leader.annotations.select(['a', 'b', 'c']);
    const editor = new StyleEditor(leader);
    const before = leader.history.getSnapshot().undoCount;

    // Assigning a style that does not exist is the reachable mid-write failure.
    expect(() => editor.assignStyle('nope')).toThrowError(
      expect.objectContaining({
        code: 'NOT_FOUND',
        details: expect.objectContaining({ annotationId: 'a' }),
      }),
    );

    expect(leader.history.getSnapshot().undoCount).toBe(before);
    for (const id of ['a', 'b', 'c']) {
      expect(leader.annotations.resolvedStyle(id)!.lineColor).toBe('#ff0000');
    }
    leader.dispose();
  });
});

describe('reverting', () => {
  it('drops one field back to the style and leaves the others overridden', () => {
    const leader = build();
    leader.annotations.create(note('a', {
      styleOverride: { lineColor: '#ff0000', textColor: '#123456' },
    }));
    leader.annotations.select(['a']);
    const editor = new StyleEditor(leader);

    editor.clear('lineColor');

    const resolved = leader.annotations.resolvedStyle('a')!;
    expect(resolved.lineColor).toBe('#0000ff');
    expect(resolved.from.lineColor).toBe('style');
    expect(resolved.textColor).toBe('#123456');
    expect(resolved.from.textColor).toBe('annotation-override');

    // Reverting the last field removes the override entirely rather than leaving `{}` behind, so
    // the document stays canonical and a second revert is a genuine no-op.
    editor.clear('textColor');
    expect(leader.annotations.get('a')?.styleOverride).toBeUndefined();
    leader.dispose();
  });

  it('works across a selection, in one undo step', () => {
    const leader = build();
    for (const id of ['a', 'b']) {
      leader.annotations.create(note(id, { styleOverride: { lineColor: '#ff0000' } }));
    }
    leader.annotations.select(['a', 'b']);
    const editor = new StyleEditor(leader);

    const before = leader.history.getSnapshot().undoCount;
    editor.clear('lineColor');

    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);
    for (const id of ['a', 'b']) {
      expect(leader.annotations.resolvedStyle(id)!.from.lineColor).toBe('style');
    }
    leader.dispose();
  });
});

describe('assigning a style', () => {
  it('clears the override with it, in one undo step', () => {
    const leader = build();
    leader.definitions.create(style('site', { lineColor: '#00ffff' }));
    leader.annotations.create(note('a', { styleOverride: { lineColor: '#ff0000' } }));
    leader.annotations.select(['a']);
    const editor = new StyleEditor(leader);

    const before = leader.history.getSnapshot().undoCount;
    editor.assignStyle('site');

    // Without the clear this reads `#ff0000` — the override outranks the style — and "use the Site
    // style" looks to the user like it did nothing.
    const resolved = leader.annotations.resolvedStyle('a')!;
    expect(resolved.styleId).toBe('site');
    expect(resolved.lineColor).toBe('#00ffff');
    expect(leader.annotations.get('a')?.styleOverride).toBeUndefined();
    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);

    leader.history.undo();
    expect(leader.annotations.resolvedStyle('a')!.lineColor).toBe('#ff0000');
    leader.dispose();
  });
});

describe('snapshot identity', () => {
  it('hands back the same object until something it describes changes', () => {
    const leader = build();
    leader.annotations.create(note('a'));
    leader.annotations.select(['a']);
    const editor = new StyleEditor(leader);

    const first = editor.getSnapshot();
    expect(Object.is(first, editor.getSnapshot())).toBe(true);

    editor.set('lineColor', '#ff0000');
    const second = editor.getSnapshot();
    expect(Object.is(first, second)).toBe(false);
    expect(second.fields.lineColor?.value).toBe('#ff0000');
    expect(Object.is(second, editor.getSnapshot())).toBe(true);
    leader.dispose();
  });

  it('survives a revision bump that changes nothing in the panel', () => {
    const leader = build();
    leader.annotations.create(note('a'));
    leader.annotations.select(['a']);
    const editor = new StyleEditor(leader);
    const before = editor.getSnapshot();

    // Every hover, marquee move and drag pointermove bumps the runtime revision the caches key on.
    // An unselected annotation appearing stands in for all of them: the revision moves, the panel's
    // own state does not, and a fresh object here would re-render the host for nothing.
    const revision = leader.annotations.getSnapshot().runtimeRevision;
    leader.annotations.create(note('z'));
    expect(leader.annotations.getSnapshot().runtimeRevision).not.toBe(revision);
    expect(Object.is(before, editor.getSnapshot())).toBe(true);

    leader.annotations.select(['a', 'z']);
    expect(Object.is(before, editor.getSnapshot())).toBe(false);
    leader.dispose();
  });

  it('publishes through the annotations capability', () => {
    const leader = build();
    leader.annotations.create(note('a'));
    const editor = new StyleEditor(leader);
    let published = 0;
    const unsubscribe = editor.subscribe(() => { published += 1; });

    leader.annotations.select(['a']);
    expect(published).toBeGreaterThan(0);

    unsubscribe();
    const settled = published;
    leader.annotations.clearSelection();
    expect(published).toBe(settled);
    leader.dispose();
  });
});
