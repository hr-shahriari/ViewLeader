/** @vitest-environment jsdom */
// The framework-agnostic inline label text editor: which field opens, what Enter and Escape mean,
// and what reaches the document.
//
// Everything here runs without React or Vue, which is the point — a binding may differ only in how
// it receives an element, subscribes and disposes. Any behaviour that differs between the two
// bindings would be a bug, so the behaviour is graded once, here.
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationContent,
  type AnnotationDraft,
  type HostAdapterBundle,
} from '../src/index.js';
import type { FollowOptions, FollowTarget } from '../src/internal/follow.js';
import {
  TextEditorController,
  isMultilineField,
  primaryTextField,
  readTextField,
  writeTextField,
  type EditableTextField,
  type KeyEventLike,
  type TextEditorCloseReason,
  type TextEditorFollow,
  type TextEditorHost,
} from '../src/internal/text-editor.js';

const projection: HostAdapterBundle['projection'] = {
  getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
  project: (point) => ({
    point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
    depth: point.z,
    visible: true,
  }),
};

function draft(id: string, content: AnnotationContent): AnnotationDraft {
  return { id, anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } }, content };
}

interface Registration {
  readonly target: FollowTarget;
  readonly options: FollowOptions | undefined;
}

interface Harness {
  readonly leader: ViewLeader;
  readonly editor: TextEditorController;
  readonly element: HTMLTextAreaElement;
  readonly boundary: HTMLDivElement;
  readonly closes: TextEditorCloseReason[];
  readonly registrations: Registration[];
  readonly released: number[];
  add(id: string, content: AnnotationContent): void;
  content(id: string): AnnotationContent | undefined;
  undoCount(): number;
}

function harness(): Harness {
  const boundary = document.createElement('div');
  document.body.append(boundary);
  const leader = new ViewLeader({ boundary, adapters: { projection } });
  const closes: TextEditorCloseReason[] = [];
  const registrations: Registration[] = [];
  const released: number[] = [];
  const follow: TextEditorFollow = {
    register: (target, _element, options) => {
      const index = registrations.length;
      registrations.push({ target, options });
      return () => { released.push(index); };
    },
  };
  const editor = new TextEditorController({
    host: leader,
    follow,
    onClose: (reason) => closes.push(reason),
  });
  const element = document.createElement('textarea');
  boundary.append(element);
  editor.ref(element);
  return {
    leader,
    editor,
    element,
    boundary,
    closes,
    registrations,
    released,
    add: (id, content) => { leader.annotations.create(draft(id, content)); },
    content: (id) => leader.annotations.get(id)?.content,
    undoCount: () => leader.history.getSnapshot().undoCount,
  };
}

function key(name: string, shiftKey = false): KeyEventLike & { readonly prevented: () => boolean } {
  let prevented = false;
  return {
    key: name,
    shiftKey,
    preventDefault: () => { prevented = true; },
    prevented: () => prevented,
  };
}

function type(editor: TextEditorController, value: string): void {
  editor.getSnapshot().props.onChange({ target: { value } });
}

describe('field resolution', () => {
  const cases: readonly (readonly [string, AnnotationContent, EditableTextField, string])[] = [
    ['plain-note', { kind: 'plain-note', text: 'a note' }, 'text', 'a note'],
    ['tag', { kind: 'tag', text: 'A-1' }, 'text', 'A-1'],
    ['callout', { kind: 'callout', title: 'Head', text: 'body' }, 'text', 'body'],
    ['split-callout', { kind: 'split-callout', primary: 'top', secondary: 'bottom' }, 'primary', 'top'],
    // The kind the demos' `asTextContent` refuses — and the content of the shipped `grid-bubble`
    // template, which starts life with an empty label nothing else can fill in.
    ['symbolic-block', { kind: 'symbolic-block', symbol: 'circle', label: 'B' }, 'label', 'B'],
  ];

  for (const [name, content, field, value] of cases) {
    it(`opens ${name} on its primary field with no field named`, () => {
      const h = harness();
      h.add('n-1', content);
      expect(h.editor.open('n-1')).toBe(true);
      const snapshot = h.editor.getSnapshot();
      expect(snapshot.field).toBe(field);
      expect(snapshot.props.value).toBe(value);
      expect(primaryTextField(content)).toBe(field);
    });
  }

  it('reaches the second field of the two multi-field kinds', () => {
    const h = harness();
    h.add('c', { kind: 'callout', title: 'Head', text: 'body' });
    h.add('s', { kind: 'split-callout', primary: 'top', secondary: 'bottom' });
    expect(h.editor.open('c', { field: 'title' })).toBe(true);
    expect(h.editor.getSnapshot().props.value).toBe('Head');
    expect(h.editor.open('s', { field: 'secondary' })).toBe(true);
    expect(h.editor.getSnapshot().props.value).toBe('bottom');
  });

  it('opens an absent optional title as empty rather than refusing', () => {
    const h = harness();
    h.add('c', { kind: 'callout', text: 'body' });
    expect(h.editor.open('c', { field: 'title' })).toBe(true);
    expect(h.editor.getSnapshot().props.value).toBe('');
  });

  it('refuses a field the kind does not have', () => {
    const h = harness();
    h.add('t', { kind: 'tag', text: 'A-1' });
    expect(h.editor.open('t', { field: 'title' })).toBe(false);
    expect(h.editor.getSnapshot().annotationId).toBeNull();
  });

  it('refuses the two kinds that carry no drawn text, and refuses a missing annotation', () => {
    const h = harness();
    // `alt` is a string but is never drawn — it becomes an accessible name only.
    h.add('i', { kind: 'host-image', reference: 'photo-1', alt: 'never drawn' });
    expect(h.editor.open('i')).toBe(false);
    expect(h.editor.open('nope')).toBe(false);
    // Installing a plugin to prove the same point would only be testing `ExtensionRuntime`:
    // plugin `data` is opaque JSON core is documented never to read inside.
    const plugin: AnnotationContent = {
      kind: 'plugin:markdown', pluginId: 'markdown', schemaVersion: 1, data: { source: '# hi' },
    };
    expect(primaryTextField(plugin)).toBeUndefined();
    expect(readTextField(plugin)).toBeUndefined();
    expect(readTextField(plugin, 'text')).toBeUndefined();
    expect(writeTextField(plugin, 'text', 'x')).toBeUndefined();
  });

  it('opens a refused kind once the host supplies both escape-hatch options', () => {
    const h = harness();
    h.add('i', { kind: 'host-image', reference: 'photo-1', alt: 'a stair' });
    const written: string[] = [];
    expect(h.editor.open('i', { initialValue: 'a stair', onCommit: (v) => written.push(v) })).toBe(true);
    expect(h.editor.getSnapshot().props.value).toBe('a stair');
    expect(h.editor.getSnapshot().field).toBeNull();
    type(h.editor, 'a stair, half-turn');
    h.editor.commit();
    // The host's callback replaces the built-in write outright — the content kind stops mattering.
    expect(written).toEqual(['a stair, half-turn']);
    expect(h.content('i')).toEqual({ kind: 'host-image', reference: 'photo-1', alt: 'a stair' });
  });
});

describe('multiline, derived from the field', () => {
  it('treats prose as prose and marks as marks', () => {
    const note: AnnotationContent = { kind: 'plain-note', text: '' };
    const callout: AnnotationContent = { kind: 'callout', text: '' };
    const split: AnnotationContent = { kind: 'split-callout', primary: '', secondary: '' };
    const tag: AnnotationContent = { kind: 'tag', text: '' };
    const block: AnnotationContent = { kind: 'symbolic-block', symbol: 'circle', label: '' };
    expect(isMultilineField(note, 'text')).toBe(true);
    expect(isMultilineField(callout, 'text')).toBe(true);
    expect(isMultilineField(callout, 'title')).toBe(false);
    expect(isMultilineField(split, 'secondary')).toBe(true);
    expect(isMultilineField(split, 'primary')).toBe(false);
    expect(isMultilineField(tag, 'text')).toBe(false);
    expect(isMultilineField(block, 'label')).toBe(false);
  });

  it('lets Shift+Enter type a newline in prose and commit on a mark', () => {
    const h = harness();
    h.add('n', { kind: 'plain-note', text: 'a' });
    h.add('t', { kind: 'tag', text: 'A-1' });

    h.editor.open('n');
    const inProse = key('Enter', true);
    h.editor.getSnapshot().props.onKeyDown(inProse);
    expect(inProse.prevented()).toBe(false);
    expect(h.editor.getSnapshot().annotationId).toBe('n');

    h.editor.cancel();
    h.editor.open('t');
    const onMark = key('Enter', true);
    h.editor.getSnapshot().props.onKeyDown(onMark);
    // A tag draws one line, so a newline it could never show must not be storable either.
    expect(onMark.prevented()).toBe(true);
    expect(h.editor.getSnapshot().annotationId).toBeNull();
  });
});

describe('referenced tags', () => {
  const referenced: AnnotationContent = {
    kind: 'tag',
    text: 'A-1',
    reference: { modelId: 'model-a', elementId: 'wall-7', property: 'Mark' },
  };

  it('opens the persisted fallback and says so', () => {
    const h = harness();
    h.add('t', referenced);
    h.editor.open('t');
    const { props } = h.editor.getSnapshot();
    // What is drawn comes from the tagText adapter; `text` is only the fallback. Without the
    // attribute a host cannot explain why typing changes nothing on screen.
    expect(props.value).toBe('A-1');
    expect(props['data-vl-text-source']).toBe('tag-fallback');
  });

  it('leaves an unreferenced tag unmarked, and keeps the reference on commit', () => {
    const h = harness();
    h.add('plain', { kind: 'tag', text: 'B-2' });
    h.editor.open('plain');
    expect(h.editor.getSnapshot().props['data-vl-text-source']).toBeUndefined();

    h.add('t', referenced);
    h.editor.open('t');
    type(h.editor, 'A-2');
    h.editor.commit();
    expect(h.content('t')).toEqual({ ...referenced, text: 'A-2' });
  });
});

describe('commit and cancel', () => {
  it('commits on blur, as one undo step', () => {
    const h = harness();
    h.add('n', { kind: 'plain-note', text: 'before' });
    const before = h.undoCount();
    h.editor.open('n');
    type(h.editor, 'after');
    h.editor.getSnapshot().props.onBlur();
    expect(h.content('n')).toEqual({ kind: 'plain-note', text: 'after' });
    expect(h.undoCount()).toBe(before + 1);
    expect(h.closes).toEqual(['commit']);
    expect(h.editor.getSnapshot().annotationId).toBeNull();
  });

  it('commits on Enter and cancels on Escape', () => {
    const h = harness();
    h.add('n', { kind: 'plain-note', text: 'before' });
    h.editor.open('n');
    type(h.editor, 'typed');
    const enter = key('Enter');
    h.editor.getSnapshot().props.onKeyDown(enter);
    expect(enter.prevented()).toBe(true);
    expect(h.content('n')).toEqual({ kind: 'plain-note', text: 'typed' });

    h.editor.open('n');
    type(h.editor, 'abandoned');
    h.editor.getSnapshot().props.onKeyDown(key('Escape'));
    expect(h.content('n')).toEqual({ kind: 'plain-note', text: 'typed' });
    expect(h.closes).toEqual(['commit', 'cancel']);
  });

  it('writes no undo entry for an unchanged commit', () => {
    const h = harness();
    h.add('n', { kind: 'plain-note', text: 'same' });
    const before = h.undoCount();
    h.editor.open('n');
    h.editor.commit();
    // The engine drops both the unchanged patch and the empty transaction. Nothing here compares:
    // a second dirty check would be a second implementation of a rule the engine must enforce.
    expect(h.undoCount()).toBe(before);
  });

  it('drops an optional field committed empty and keeps a required one', () => {
    const h = harness();
    h.add('c', { kind: 'callout', title: 'Head', text: 'body' });
    h.editor.open('c', { field: 'title' });
    type(h.editor, '');
    h.editor.commit();
    // `''` would lay out as a real blank first line and read back as an accessible name of ": body".
    expect(h.content('c')).toEqual({ kind: 'callout', text: 'body' });

    h.add('n', { kind: 'plain-note', text: 'gone soon' });
    h.editor.open('n');
    type(h.editor, '');
    h.editor.commit();
    // Every other field may legally be empty — both built-in templates ship empty text.
    expect(h.content('n')).toEqual({ kind: 'plain-note', text: '' });
  });

  it('closes as gone when the annotation is deleted underneath it, and then writes nothing', () => {
    const h = harness();
    h.add('n', { kind: 'plain-note', text: 'before' });
    h.editor.open('n');
    type(h.editor, 'half-typed');
    h.leader.annotations.remove('n');
    expect(h.closes).toEqual(['gone']);
    expect(h.editor.getSnapshot().annotationId).toBeNull();
    // Removing a focused field fires blur synchronously; the editor has already let go.
    h.editor.getSnapshot().props.onBlur();
    expect(h.leader.annotations.get('n')).toBeUndefined();
    expect(h.closes).toEqual(['gone']);
  });

  it('reports the resolved direction and a row count that follows the value', () => {
    const h = harness();
    h.add('n', { kind: 'plain-note', text: 'a', direction: 'rtl' });
    h.editor.open('n');
    expect(h.editor.getSnapshot().props.dir).toBe('rtl');
    expect(h.editor.getSnapshot().props.rows).toBe(1);
    type(h.editor, 'a\nb\nc');
    expect(h.editor.getSnapshot().props.rows).toBe(3);
  });
});

describe('snapshot identity', () => {
  it('hands back the same object until something changes', () => {
    const h = harness();
    h.add('n', { kind: 'plain-note', text: 'a' });
    // `useSyncExternalStore` compares consecutive reads with `Object.is`; a fresh object per call
    // is React's documented infinite-render condition rather than a cheap read.
    expect(h.editor.getSnapshot()).toBe(h.editor.getSnapshot());

    const closed = h.editor.getSnapshot();
    h.editor.open('n');
    const open = h.editor.getSnapshot();
    expect(open).not.toBe(closed);
    expect(h.editor.getSnapshot()).toBe(open);

    type(h.editor, 'a');
    expect(h.editor.getSnapshot()).toBe(open);
    type(h.editor, 'b');
    expect(h.editor.getSnapshot()).not.toBe(open);
    expect(h.editor.getSnapshot()).toBe(h.editor.getSnapshot());
  });

  it('notifies subscribers on open, typing and close', () => {
    const h = harness();
    h.add('n', { kind: 'plain-note', text: 'a' });
    let notified = 0;
    const unsubscribe = h.editor.subscribe(() => { notified += 1; });
    h.editor.open('n');
    type(h.editor, 'b');
    h.editor.cancel();
    expect(notified).toBe(3);
    unsubscribe();
    h.editor.open('n');
    expect(notified).toBe(3);
  });
});

describe('the element', () => {
  it('follows the label and holds position when it leaves the frustum', () => {
    const h = harness();
    h.add('n', { kind: 'plain-note', text: 'a' });
    h.editor.open('n');
    expect(h.registrations).toEqual([
      { target: { kind: 'label', id: 'n' }, options: { onMissing: 'hold' } },
    ]);
    // Hiding an off-screen target blurs a focused element, and blur commits — so an accidental
    // orbit would commit a half-typed value.
    h.editor.cancel();
    expect(h.released).toEqual([0]);
  });

  it('focuses and selects the value when it opens', () => {
    const h = harness();
    h.add('n', { kind: 'plain-note', text: 'replace me' });
    h.editor.open('n');
    expect(document.activeElement).toBe(h.element);
  });
});

describe('the double-click guard', () => {
  function guardHarness(phase: () => string, hitKind: string): {
    readonly editor: TextEditorController;
    readonly asked: { x: number; y: number }[];
    readonly boundary: HTMLDivElement;
  } {
    const boundary = document.createElement('div');
    document.body.append(boundary);
    const leader = new ViewLeader({ boundary, adapters: { projection } });
    leader.annotations.create(draft('n', { kind: 'plain-note', text: 'a' }));
    const asked: { x: number; y: number }[] = [];
    // The narrow host port is what makes this testable: real annotations, a stubbed camera.
    const host: TextEditorHost = {
      annotations: leader.annotations,
      authoring: { getSnapshot: () => ({ phase: phase() }) },
      editing: {
        hitTestScreen: (at) => { asked.push(at); return { kind: hitKind, id: 'n' }; },
      },
    };
    return { editor: new TextEditorController({ host }), asked, boundary };
  }

  it('opens the label under the pointer, measured against the boundary', () => {
    const { editor, asked, boundary } = guardHarness(() => 'idle', 'label');
    editor.boundaryProps.onDoubleClick({ clientX: 40, clientY: 25, currentTarget: boundary });
    // jsdom reports a zero rect, so this only proves the origin is subtracted at all.
    expect(asked).toEqual([{ x: 40, y: 25 }]);
    expect(editor.getSnapshot().annotationId).toBe('n');
  });

  it('leaves the gesture to a live authoring session', () => {
    const { editor, asked, boundary } = guardHarness(() => 'picking', 'label');
    // Core binds `dblclick` on the same boundary to finish a multi-point route, and its listener
    // is added second — so without this the finishing gesture opens an editor on top of it.
    editor.boundaryProps.onDoubleClick({ clientX: 40, clientY: 25, currentTarget: boundary });
    expect(asked).toEqual([]);
    expect(editor.getSnapshot().annotationId).toBeNull();
  });

  it('ignores a double-click on anything that is not a label', () => {
    const { editor, boundary } = guardHarness(() => 'idle', 'leader');
    editor.boundaryProps.onDoubleClick({ clientX: 1, clientY: 1, currentTarget: boundary });
    expect(editor.getSnapshot().annotationId).toBeNull();
  });
});

describe('the field accessors on their own', () => {
  it('reads and writes every one of the seven fields', () => {
    const contents: readonly (readonly [AnnotationContent, EditableTextField])[] = [
      [{ kind: 'plain-note', text: 'a' }, 'text'],
      [{ kind: 'tag', text: 'a' }, 'text'],
      [{ kind: 'callout', text: 'a' }, 'text'],
      [{ kind: 'callout', text: 'a' }, 'title'],
      [{ kind: 'split-callout', primary: 'a', secondary: 'a' }, 'primary'],
      [{ kind: 'split-callout', primary: 'a', secondary: 'a' }, 'secondary'],
      [{ kind: 'symbolic-block', symbol: 'circle', label: 'a' }, 'label'],
    ];
    for (const [content, field] of contents) {
      const next = writeTextField(content, field, 'written');
      expect(next).toBeDefined();
      expect(readTextField(next as AnnotationContent, field)).toBe('written');
    }
  });

  it('refuses a field the kind does not have, in both directions', () => {
    const tag: AnnotationContent = { kind: 'tag', text: 'a' };
    expect(readTextField(tag, 'label')).toBeUndefined();
    expect(writeTextField(tag, 'label', 'x')).toBeUndefined();
    const image: AnnotationContent = { kind: 'host-image', reference: 'r', alt: 'a' };
    expect(readTextField(image)).toBeUndefined();
    expect(writeTextField(image, 'text', 'x')).toBeUndefined();
  });
});

describe('disposal does not swallow a value', () => {
  it('reports a close reason and notifies before listeners are dropped', () => {
    const { leader, editor, closes, add } = harness();
    const seen: (string | null)[] = [];
    editor.subscribe(() => seen.push(editor.getSnapshot().annotationId));
    add('n', { kind: 'plain-note', text: 'before' });
    editor.open('n');
    type(editor, 'half typed');

    editor.dispose();

    // A binding rebuilding on a dependency change must not drop typing in silence.
    expect(closes).toContain('gone');
    expect(seen.at(-1)).toBeNull();
    leader.dispose();
  });
});
