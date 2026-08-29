// @vitest-environment jsdom
import { createElement, act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { defineComponent, h, createApp, shallowRef } from 'vue';
import { ViewLeader, type AnnotationDraft, type HostAdapterBundle } from '../src/index.js';
import {
  LabelTextEditor,
  useEditingKeyboard,
  useFollow,
  useHandles,
  useLabelTextEditor,
  useStyleEditor,
  useStyleEditorSnapshot,
  useTemplateDraft,
  useViewLeader,
} from '../src/react/index.js';
import {
  useFollow as useVueFollow,
  useHandles as useVueHandles,
  useLabelTextEditor as useVueLabelTextEditor,
  useStyleEditor as useVueStyleEditor,
  useTemplateDraft as useVueTemplateDraft,
} from '../src/vue/index.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The modules each have their own suite. This covers the binding layer on top of them — the part
 * that is hand-written per framework and therefore the part a module's own tests cannot reach.
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

const note: AnnotationDraft = {
  id: 'note',
  anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
  content: { kind: 'callout', title: 'Wall', text: '200mm' },
  placement: { kind: 'manual', position: { x: 120, y: 140 } },
};

describe('React hook wiring', () => {
  it('builds every hook, exposes them once mounted, and tears them all down', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const seen: Record<string, unknown> = {};
    let leader: ViewLeader | null = null;

    const Harness = (): ReactElement => {
      const binding = useViewLeader({ adapters });
      const follow = useFollow(binding.viewLeader);
      const handles = useHandles(binding.viewLeader, follow, 'note');
      const editor = useLabelTextEditor(binding.viewLeader, follow);
      const style = useStyleEditor(binding.viewLeader);
      const draft = useTemplateDraft(binding.viewLeader);
      useEditingKeyboard(binding.viewLeader);
      const styleSnapshot = useStyleEditorSnapshot(style);

      leader = binding.viewLeader;
      Object.assign(seen, { follow, handles, editor, style, draft, styleSnapshot });

      return createElement('div', { ref: binding.boundaryRef },
        createElement(LabelTextEditor, { editor }));
    };

    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { leader?.annotations.create(note); leader?.update(); });
    await act(async () => { root.render(createElement(Harness)); });

    expect(seen.follow).not.toBeNull();
    expect(seen.handles).not.toBeNull();
    expect(seen.editor).not.toBeNull();
    expect(seen.style).not.toBeNull();
    expect(seen.draft).not.toBeNull();
    // No editor is open, so the one component this package ships renders nothing.
    expect(container.querySelector('textarea')).toBeNull();

    await act(async () => { root.unmount(); });
  });

  it('renders the text editor over the label once it is opened, and commits', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let leader: ViewLeader | null = null;
    let editor: { open(id: string): unknown } | null = null;

    const Harness = (): ReactElement => {
      const binding = useViewLeader({ adapters });
      const follow = useFollow(binding.viewLeader);
      const controller = useLabelTextEditor(binding.viewLeader, follow);
      leader = binding.viewLeader;
      editor = controller;
      return createElement('div', { ref: binding.boundaryRef },
        createElement(LabelTextEditor, { editor: controller }));
    };

    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { leader?.annotations.create(note); leader?.update(); });
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { editor?.open('note'); });

    const field = container.querySelector('textarea');
    expect(field).not.toBeNull();
    // The callout's primary field, not its title.
    expect(field?.value).toBe('200mm');
    // The metrics the follow registry writes are what stop the glyphs jumping.
    expect(field?.style.fontSize).toBe('var(--vl-font-size)');

    await act(async () => { root.unmount(); });
  });

  it('drives a style edit through the hook as one undo step', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let leader: ViewLeader | null = null;
    let style: { set(field: 'lineColor', value: string): unknown } | null = null;

    const Harness = (): ReactElement => {
      const binding = useViewLeader({ adapters });
      const editor = useStyleEditor(binding.viewLeader);
      leader = binding.viewLeader;
      style = editor as typeof style;
      return createElement('div', { ref: binding.boundaryRef });
    };

    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => {
      leader?.annotations.create(note);
      leader?.annotations.create({ ...note, id: 'other' });
      leader?.annotations.select(['note', 'other']);
    });
    await act(async () => { root.render(createElement(Harness)); });

    const before = leader!.history.getSnapshot().undoCount;
    await act(async () => { style?.set('lineColor', '#ff0000'); });

    expect(leader!.history.getSnapshot().undoCount).toBe(before + 1);
    expect(leader!.annotations.resolvedStyle('note')?.lineColor).toBe('#ff0000');
    expect(leader!.annotations.resolvedStyle('other')?.lineColor).toBe('#ff0000');

    await act(async () => { root.unmount(); });
  });
});

describe('template preview does not outlive its dialog', () => {
  it('reverts an applied preview when the dialog closes but the viewer lives on', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let leader: ViewLeader | null = null;
    let draft: {
      set(patch: { readonly name?: string; readonly defaults?: unknown }): unknown;
      applyPreview(): readonly string[];
    } | null = null;

    // The dialog is its own component, so it can unmount while the viewer stays up — which is what
    // closing a dialog actually is. Unmounting the whole tree would take the ViewLeader with it and
    // prove nothing.
    const Dialog = ({ viewLeader }: { viewLeader: ViewLeader | null }): ReactElement | null => {
      draft = useTemplateDraft(viewLeader) as typeof draft;
      return null;
    };

    const Harness = ({ open }: { open: boolean }): ReactElement => {
      const binding = useViewLeader({ adapters });
      leader = binding.viewLeader;
      return createElement('div', { ref: binding.boundaryRef },
        open ? createElement(Dialog, { viewLeader: binding.viewLeader }) : null);
    };

    await act(async () => { root.render(createElement(Harness, { open: true })); });
    await act(async () => {
      leader?.annotations.create(note);
      leader?.annotations.select(['note']);
    });
    await act(async () => { root.render(createElement(Harness, { open: true })); });

    const before = leader!.annotations.get('note')?.styleId;
    await act(async () => {
      draft?.set({ name: 'Door tag', defaults: { styleId: 'builtin.style.note' } });
      draft?.applyPreview();
    });
    expect(leader!.annotations.get('note')?.styleId).toBe('builtin.style.note');

    await act(async () => { root.render(createElement(Harness, { open: false })); });
    expect(leader!.annotations.get('note')?.styleId).toBe(before);

    await act(async () => { root.unmount(); });
  });
});

describe('Vue hook wiring', () => {
  it('builds every composable and tears them down with the scope', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const held: { current: ViewLeader | null } = { current: null };
    const seen: Record<string, unknown> = {};

    const Harness = defineComponent({
      setup() {
        const instance = shallowRef<ViewLeader | null>(null);
        const follow = useVueFollow(instance);
        const handles = useVueHandles(instance, follow.registry, 'note');
        const editor = useVueLabelTextEditor(instance, follow.registry);
        const style = useVueStyleEditor(instance);
        const draft = useVueTemplateDraft(instance);
        // Read after mount, not during render: the `ref` callback that builds the ViewLeader has not
        // run yet while the first render is still producing its vnodes.
        Object.assign(seen, {
          read: () => ({
            follow: follow.registry.value,
            handles: handles.value,
            editor: editor.value,
            style: style.value,
            draft: draft.value,
          }),
        });
        return () => {
          return h('div', {
            ref: (element: unknown) => {
              const next = (element ?? null) as Element | null;
              if (next !== null && instance.value === null) {
                const built = new ViewLeader({ boundary: next, adapters });
                built.annotations.create(note);
                instance.value = built;
                held.current = built;
              }
            },
          });
        };
      },
    });

    const app = createApp(Harness);
    app.mount(host);
    held.current?.update();

    const read = seen.read as () => Record<string, unknown>;
    const built = read();
    expect(built.follow).not.toBeNull();
    expect(built.handles).not.toBeNull();
    expect(built.editor).not.toBeNull();
    expect(built.style).not.toBeNull();
    expect(built.draft).not.toBeNull();

    expect(() => app.unmount()).not.toThrow();
  });
});
