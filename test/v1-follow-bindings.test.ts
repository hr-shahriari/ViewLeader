// @vitest-environment jsdom
import { createElement, StrictMode, act, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { defineComponent, h, ref as vueRef, shallowRef } from 'vue';
import { createApp } from 'vue';
import { ViewLeader, type AnnotationDraft, type HostAdapterBundle } from '../src/index.js';
import { useFollow as useReactFollow, useViewLeader as useReactViewLeader } from '../src/react/index.js';
import { useFollow as useVueFollow } from '../src/vue/index.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Both bindings wrap the same registry, so these check the wiring — that a real frame reaches the
 * element — rather than re-testing the registry's own behaviour.
 */

let revision = 1;
const adapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
    getRevision: () => revision,
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
  content: { kind: 'plain-note', text: 'hello' },
  placement: { kind: 'manual', position: { x: 120, y: 140 } },
};

describe('React useFollow', () => {
  it('positions a followed element once a frame has been drawn', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let leader: ViewLeader | null = null;

    const Harness = (): ReactElement => {
      const binding = useReactViewLeader({ adapters });
      const follow = useReactFollow(binding.viewLeader);
      leader = binding.viewLeader;
      return createElement('div', { ref: binding.boundaryRef },
        follow === null
          ? null
          : createElement('div', {
            ref: follow.ref({ kind: 'label', id: 'note' }),
            'data-role': 'toolbar',
          }));
    };

    await act(async () => { root.render(createElement(StrictMode, null, createElement(Harness))); });
    // The annotation and the first frame both have to exist before there is anything to follow.
    await act(async () => {
      leader?.annotations.create(note);
      leader?.update();
    });
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Harness))); });
    await act(async () => { revision += 1; leader?.update(); });

    const toolbar = container.querySelector<HTMLElement>('[data-role="toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.style.transform).toMatch(/^translate\(/u);
    expect(toolbar?.style.getPropertyValue('--vl-font-size')).not.toBe('');

    await act(async () => { root.unmount(); });
  });

  it('hands back the same ref callback across re-renders', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const seen: unknown[] = [];
    let bump: (() => void) | undefined;

    const Harness = (): ReactElement => {
      const [, setTick] = useState(0);
      bump = () => setTick((value) => value + 1);
      const binding = useReactViewLeader({ adapters });
      const follow = useReactFollow(binding.viewLeader);
      if (follow !== null) seen.push(follow.ref({ kind: 'label', id: 'note' }));
      return createElement('div', { ref: binding.boundaryRef });
    };

    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { bump?.(); });
    await act(async () => { bump?.(); });

    expect(seen.length).toBeGreaterThan(1);
    // A changing identity would re-fire the ref on every render for no reason.
    expect(new Set(seen).size).toBe(1);
    await act(async () => { root.unmount(); });
  });
});

describe('Vue useFollow', () => {
  it('positions through a callback ref and keeps its identity stable', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const held: { current: ViewLeader | null } = { current: null };
    const seen: unknown[] = [];

    const Harness = defineComponent({
      setup() {
        const boundary = shallowRef<Element | null>(null);
        const instance = shallowRef<ViewLeader | null>(null);
        const tick = vueRef(0);
        const follow = useVueFollow(instance);
        return () => {
          seen.push(follow.ref({ kind: 'label', id: 'note' }));
          void tick.value;
          return h('div', {
            ref: (element: unknown) => {
              const next = (element ?? null) as Element | null;
              if (boundary.value === next) return;
              boundary.value = next;
              if (next !== null && instance.value === null) {
                const built = new ViewLeader({ boundary: next, adapters });
                built.annotations.create(note);
                instance.value = built;
                held.current = built;
              }
            },
          }, [h('div', { ref: follow.ref({ kind: 'label', id: 'note' }), 'data-role': 'toolbar' })]);
        };
      },
    });

    const app = createApp(Harness);
    app.mount(host);
    revision += 1;
    held.current?.update();
    await Promise.resolve();

    const toolbar = host.querySelector<HTMLElement>('[data-role="toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.style.transform).toMatch(/^translate\(/u);
    expect(new Set(seen).size).toBe(1);

    app.unmount();
  });
});
