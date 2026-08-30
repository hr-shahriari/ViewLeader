/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type TemplateDefinition,
} from '../src/index.js';
import {
  TemplateDraft,
  captureTemplateDefaults,
  type TemplateDraftPorts,
} from '../src/internal/template-draft.js';

/**
 * The draft is framework-agnostic on purpose, so none of this imports React or Vue. It does build a
 * real `ViewLeader`, because the one promise worth testing is that the draft's live checker and
 * `definitions.create()` never disagree — and only the real capability can prove that.
 */

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

const adapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
    project: (point) => ({
      point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
      depth: point.z,
      visible: true,
    }),
  },
};

function note(id: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
    content: { kind: 'plain-note', text: id },
  };
}

function build(): { leader: ViewLeader; ports: TemplateDraftPorts } {
  const leader = new ViewLeader({ boundary: boundary(), adapters });
  leader.annotations.create(note('a'));
  leader.annotations.create(note('b'));
  return {
    leader,
    ports: {
      definitions: leader.definitions,
      history: leader.history,
      annotations: leader.annotations,
    },
  };
}

/** A draft whose only remaining question is what the test is about. */
function draftOf(ports: TemplateDraftPorts, overrides: Partial<{ id: string; name: string }> = {}) {
  return new TemplateDraft({
    ...ports,
    name: 'Fire rating tag',
    defaults: { styleId: 'builtin.style.tag-circle', routing: { kind: 'automatic', mode: 'orthogonal' } },
    ...overrides,
  });
}

describe('captureTemplateDefaults', () => {
  it('blanks the text and keeps the content kind', () => {
    const { defaults } = captureTemplateDefaults({
      content: { kind: 'symbolic-block', symbol: 'circle', label: 'A-101', maxWidth: 120 },
    });
    expect(defaults.content).toEqual({ kind: 'symbolic-block', symbol: 'circle', label: '', maxWidth: 120 });
  });

  it('drops the model reference a tag points at', () => {
    const { defaults } = captureTemplateDefaults({
      content: {
        kind: 'tag',
        text: 'FD60',
        reference: { modelId: 'm', elementId: 'door-12', property: 'FireRating' },
      },
    });
    expect(defaults.content).toEqual({ kind: 'tag', text: '' });
  });

  it('copies content whole when asked for verbatim', () => {
    const content = { kind: 'host-image', reference: 'north-arrow', alt: 'North' } as const;
    expect(captureTemplateDefaults({ content }, { content: 'verbatim' }).defaults.content).toEqual(content);
  });

  /**
   * The axis is the union arm, not the field. A captured manual placement opts every label made
   * from the template out of the placer for good, so it can never cross however it was authored.
   */
  it('forces the automatic arm even from a manually placed, hand-routed source', () => {
    const { defaults } = captureTemplateDefaults({
      content: { kind: 'plain-note', text: 'moved by hand' },
      placement: { kind: 'manual', position: { x: 420, y: 96 }, anchor: { x: 400, y: 280 } },
      anchors: [{ routing: { kind: 'manual', vertices: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } }],
    });
    expect(defaults.placement).toEqual({ kind: 'automatic' });
    expect(defaults.routing).toEqual({ kind: 'automatic', mode: 'dogleg' });
  });

  it('captures the first leg\'s route when it is automatic', () => {
    const { defaults } = captureTemplateDefaults({
      anchors: [
        { routing: { kind: 'automatic', mode: 'orthogonal' } },
        { routing: { kind: 'automatic', mode: 'straight' } },
      ],
    });
    expect(defaults.routing).toEqual({ kind: 'automatic', mode: 'orthogonal' });
  });

  it('drops a style override and says so', () => {
    const { defaults, warnings } = captureTemplateDefaults({
      styleId: 'builtin.style.note',
      styleOverride: { lineColor: '#ff0000' },
    });
    expect(defaults).not.toHaveProperty('styleOverride');
    expect(defaults.styleId).toBe('builtin.style.note');
    expect(warnings).toHaveLength(1);
    expect(captureTemplateDefaults({ styleId: 'builtin.style.note' }).warnings).toEqual([]);
  });

  /** The built-in templates are the worked examples of this policy, so capture must be a fixpoint. */
  it('round-trips both built-in templates unchanged', () => {
    const { leader } = build();
    for (const definition of leader.definitions.list('template')) {
      const template = definition as TemplateDefinition;
      expect(captureTemplateDefaults(template.defaults).defaults).toEqual(template.defaults);
    }
  });
});

describe('TemplateDraft ids', () => {
  it('generates a legal definition id, which a bare UUID would not be', () => {
    const { ports } = build();
    const id = draftOf(ports).getSnapshot().id;
    expect(id).toMatch(/^template\./u);
    expect(id).toMatch(/^[a-zA-Z][a-zA-Z0-9._:-]*$/u);
    expect(id.length).toBeLessThanOrEqual(128);
    // `validateId` demands a leading letter and a UUID starts with a hex character, so ten of the
    // sixteen possible first characters — about 62% of UUIDs — are illegal unprefixed.
    expect(/^[a-zA-Z][a-zA-Z0-9._:-]*$/u.test('9f3c1e2a-5b6d-4f7e-8a9b-0c1d2e3f4a5b')).toBe(false);
  });

  it('reports a taken id rather than relying on the create() throw', () => {
    const { leader, ports } = build();
    leader.definitions.create({ kind: 'template', id: 'project.template.callout', name: 'Callout', defaults: {} });
    const draft = draftOf(ports, { id: 'project.template.callout' });
    const snapshot = draft.getSnapshot();
    expect(snapshot.idTaken).toBe(true);
    expect(snapshot.issues).toEqual([
      { field: 'id', code: 'INVALID_INPUT', message: expect.stringContaining('already exists') },
    ]);
    // The throw is still there behind it.
    expect(() => draft.commit()).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('TemplateDraft validation', () => {
  it('reports the id, the name and the style per field', () => {
    const { ports } = build();
    const draft = new TemplateDraft({ ...ports, id: '9f3c-not-a-legal-id', name: '' });
    draft.set({ defaults: { styleId: 'builtin.style.nope' } });
    expect(draft.getSnapshot().issues.map(({ field, code }) => ({ field, code }))).toEqual([
      { field: 'id', code: 'INVALID_INPUT' },
      { field: 'name', code: 'INVALID_INPUT' },
      { field: 'defaults.styleId', code: 'NOT_FOUND' },
    ]);
  });

  it('reports a built-in id as immutable', () => {
    const { ports } = build();
    const draft = draftOf(ports, { id: 'builtin.template.note' });
    expect(draft.getSnapshot().issues[0]?.code).toBe('IMMUTABLE_DEFINITION');
  });

  it('reports an over-long name', () => {
    const { ports } = build();
    const draft = draftOf(ports, { name: 'x'.repeat(257) });
    expect(draft.getSnapshot().issues.map(({ field }) => field)).toEqual(['name']);
  });

  /**
   * The one test that keeps the live checker and the commit-time authority in step. If the checker
   * ever passes something `create()` rejects, the form promises a save it cannot deliver.
   */
  it('never passes a draft that create() would throw on', () => {
    const { leader, ports } = build();
    // A whole `Annotation` is a valid capture source, legs and all.
    const { defaults } = captureTemplateDefaults(leader.annotations.get('a')!);
    const draft = new TemplateDraft({ ...ports, name: 'Standard note', defaults });
    expect(draft.getSnapshot().issues).toEqual([]);
    expect(() => draft.commit()).not.toThrow();
    expect(leader.definitions.get(draft.getSnapshot().id)?.kind).toBe('template');
  });

  it('recomputes when the definitions move underneath the form', () => {
    const { leader, ports } = build();
    const draft = draftOf(ports, { id: 'project.template.callout' });
    expect(draft.getSnapshot().issues).toEqual([]);
    leader.definitions.create({ kind: 'template', id: 'project.template.callout', name: 'Taken', defaults: {} });
    expect(draft.getSnapshot().idTaken).toBe(true);
  });
});

describe('TemplateDraft set', () => {
  it('merges one level and clears with null', () => {
    const { ports } = build();
    const draft = draftOf(ports);
    draft.set({ name: 'Renamed', defaults: { content: { kind: 'plain-note', text: '' } } });
    expect(draft.getSnapshot()).toMatchObject({
      name: 'Renamed',
      defaults: {
        styleId: 'builtin.style.tag-circle',
        routing: { kind: 'automatic', mode: 'orthogonal' },
        content: { kind: 'plain-note', text: '' },
      },
    });
    draft.set({ defaults: { styleId: null } });
    expect(draft.getSnapshot().defaults).not.toHaveProperty('styleId');
    // A cleared field is absent, not `undefined` — `assertJson` rejects the latter at commit.
    expect(Object.keys(draft.getSnapshot().defaults).sort()).toEqual(['content', 'routing']);
  });
});

describe('TemplateDraft commit, preview and discard', () => {
  it('commits as exactly one undo entry, labelled for a person', () => {
    const { leader, ports } = build();
    const before = leader.history.getSnapshot().undoCount;
    draftOf(ports).commit();
    const after = leader.history.getSnapshot();
    expect(after.undoCount).toBe(before + 1);
    expect(after.undoLabel).toBe('Save template');
  });

  it('applies a preview to the selection and undoes exactly that entry on discard', () => {
    const { leader, ports } = build();
    leader.annotations.select(['a', 'b']);
    const draft = draftOf(ports);
    const before = leader.history.getSnapshot().undoCount;

    expect(draft.applyPreview()).toEqual(['a', 'b']);
    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);
    expect(leader.annotations.get('a')?.styleId).toBe('builtin.style.tag-circle');
    expect(leader.annotations.get('b')?.styleId).toBe('builtin.style.tag-circle');
    expect(draft.getSnapshot().previewApplied).toBe(true);

    draft.discard();
    expect(leader.history.getSnapshot().undoCount).toBe(before);
    expect(leader.annotations.get('a')?.styleId).toBeUndefined();
    expect(draft.getSnapshot().previewApplied).toBe(false);
  });

  it('keeps at most one preview outstanding', () => {
    const { leader, ports } = build();
    leader.annotations.select(['a']);
    const draft = draftOf(ports);
    const before = leader.history.getSnapshot().undoCount;
    draft.applyPreview();
    draft.set({ defaults: { styleId: 'builtin.style.tag-hexagon' } });
    draft.applyPreview();
    expect(leader.history.getSnapshot().undoCount).toBe(before + 1);
    expect(leader.annotations.get('a')?.styleId).toBe('builtin.style.tag-hexagon');
  });

  it('does not undo anything when it applied no preview', () => {
    const { leader, ports } = build();
    leader.annotations.clearSelection();
    const draft = draftOf(ports);
    leader.annotations.update('a', { content: { kind: 'plain-note', text: 'the user typed this' } });
    const before = leader.history.getSnapshot();

    expect(draft.applyPreview()).toEqual([]);
    draft.discard();

    expect(leader.history.getSnapshot().undoCount).toBe(before.undoCount);
    expect(leader.annotations.get('a')?.content).toEqual({ kind: 'plain-note', text: 'the user typed this' });
  });

  it('leaves a committed preview alone when the draft is discarded afterwards', () => {
    const { leader, ports } = build();
    leader.annotations.select(['a']);
    const draft = draftOf(ports);
    draft.applyPreview();
    draft.commit();
    const after = leader.history.getSnapshot().undoCount;

    draft.discard();

    expect(leader.history.getSnapshot().undoCount).toBe(after);
    expect(leader.annotations.get('a')?.styleId).toBe('builtin.style.tag-circle');
  });
});

describe('TemplateDraft snapshot identity', () => {
  it('hands back the same object until something moves', () => {
    const { ports } = build();
    const draft = draftOf(ports);
    const first = draft.getSnapshot();
    expect(draft.getSnapshot()).toBe(first);
    expect(draft.getSnapshot()).toBe(first);

    draft.set({ name: 'Renamed' });
    const second = draft.getSnapshot();
    expect(second).not.toBe(first);
    expect(draft.getSnapshot()).toBe(second);
  });

  it('notifies subscribers and stops when they unsubscribe', () => {
    const { ports } = build();
    const draft = draftOf(ports);
    let calls = 0;
    const unsubscribe = draft.subscribe(() => { calls += 1; });
    draft.set({ name: 'Renamed' });
    expect(calls).toBeGreaterThan(0);
    const seen = calls;
    unsubscribe();
    draft.set({ name: 'Renamed again' });
    expect(calls).toBe(seen);
  });
});
