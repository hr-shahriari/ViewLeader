// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import type { ViewLeaderOptions } from 'viewleader';
import { runFrameworkConformance } from './framework-conformance-harness.js';
import {
  runMountedFrameworkConformance,
  type MountedPublicBinding,
} from './framework-mounted-conformance-harness.js';
import {
  BoundaryLifecycle,
  CapabilitySubscription,
  resolveVueSource,
} from '../src/vue/core.js';
import { useViewLeader, type VueViewLeaderBinding } from '../src/vue/index.js';

runFrameworkConformance('Vue', {
  createLifecycle: (factory) => new BoundaryLifecycle(factory),
  createSubscription: () => new CapabilitySubscription(),
});

runMountedFrameworkConformance('Vue', async (options) => {
  const container = document.createElement('div');
  document.body.append(container);
  const generation = ref(1);
  let binding: VueViewLeaderBinding | undefined;
  const app = createApp({
    setup() {
      binding = useViewLeader(options as Omit<ViewLeaderOptions, 'boundary'>);
      return () => h('div', {
        key: generation.value,
        // Vue hands a template ref callback an `Element | ComponentPublicInstance | null`, so
        // `boundaryRef` cannot be passed bare — narrowed here exactly as the demo page does.
        ref: (element: unknown) => binding!.boundaryRef(element instanceof Element ? element : null),
        'data-framework-boundary': String(generation.value),
      });
    },
  });
  app.mount(container);
  await nextTick();
  const mounted: MountedPublicBinding = {
    instance: () => binding?.viewLeader.value ?? null,
    boundary: () => container.querySelector<HTMLElement>('[data-framework-boundary]')!,
    replaceBoundary: async () => { generation.value += 1; await nextTick(); },
    dispose: async () => { app.unmount(); await nextTick(); container.remove(); },
  };
  return mounted;
});

describe('Vue source resolution', () => {
  it('preserves identity for plain values, refs, and getters', () => {
    const value = { host: {} };
    expect(resolveVueSource(value)).toBe(value);
    expect(resolveVueSource(() => value)).toBe(value);
    expect(resolveVueSource({ __v_isRef: true, value })).toBe(value);
  });
});