// @vitest-environment jsdom
import { createElement, StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
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
} from '../src/react/core.js';
import { useViewLeader, type ReactViewLeaderBinding } from '../src/react/index.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

runFrameworkConformance('React', {
  createLifecycle: (factory) => new BoundaryLifecycle(factory),
  createSubscription: () => new CapabilitySubscription(),
});

runMountedFrameworkConformance('React', async (options) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let generation = 1;
  let binding: ReactViewLeaderBinding | undefined;
  const Harness = (props: Readonly<{ generation: number; options: Omit<ViewLeaderOptions, 'boundary'> }>) => {
    binding = useViewLeader(props.options);
    return createElement('div', {
      key: props.generation,
      ref: binding.boundaryRef,
      'data-framework-boundary': String(props.generation),
    });
  };
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(StrictMode, null,
        createElement(Harness, { generation, options })));
    });
  };
  await render();
  const mounted: MountedPublicBinding = {
    instance: () => binding?.viewLeader ?? null,
    boundary: () => container.querySelector<HTMLElement>('[data-framework-boundary]')!,
    replaceBoundary: async () => { generation += 1; await render(); },
    dispose: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  return mounted;
});

describe('React package SSR boundary', () => {
  it('keeps lifecycle utilities free of browser-global reads', () => {
    expect(typeof BoundaryLifecycle).toBe('function');
    expect(typeof CapabilitySubscription).toBe('function');
  });
});