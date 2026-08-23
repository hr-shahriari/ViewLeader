import { describe, expect, it, vi } from 'vitest';
import type {
  HostAdapterBundle,
  ViewLeader,
  ViewLeaderOptions,
} from 'viewleader';

export interface MountedPublicBinding {
  instance(): ViewLeader | null;
  boundary(): HTMLElement;
  replaceBoundary(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PublicBindingMount {
  (options: Omit<ViewLeaderOptions, 'boundary'>): Promise<MountedPublicBinding>;
}

export function runMountedFrameworkConformance(
  label: string,
  mount: PublicBindingMount,
): void {
  describe(`${label} mounted public binding`, () => {
    it('owns one real instance, preserves transient selection, and reconstructs on boundary identity', async () => {
      const mounted = await mount({ adapters: adapters() });
      const first = required(mounted.instance());
      expect(mounted.boundary().querySelectorAll('[data-viewleader-overlay]')).toHaveLength(1);
      first.annotations.create({
        id: 'framework-note',
        anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
        content: { kind: 'plain-note', text: `${label} note` },
      });
      const revision = first.documents.getSnapshot().documentRevision;
      first.annotations.select(['framework-note']);
      expect(first.annotations.getSnapshot().selectedIds).toEqual(['framework-note']);
      expect(first.documents.getSnapshot().documentRevision).toBe(revision);

      await mounted.replaceBoundary();
      const second = required(mounted.instance());
      expect(second).not.toBe(first);
      expect(() => first.update()).toThrowError(expect.objectContaining({ code: 'DISPOSED' }));
      expect(mounted.boundary().querySelectorAll('[data-viewleader-overlay]')).toHaveLength(1);
      await mounted.dispose();
      expect(() => second.update()).toThrowError(expect.objectContaining({ code: 'DISPOSED' }));
    });

    it('cancels pending work, releases its lease, and removes all owned DOM on unmount', async () => {
      let pickSignal: AbortSignal | undefined;
      let imageSignal: AbortSignal | undefined;
      let elementSignal: AbortSignal | undefined;
      let viewSignal: AbortSignal | undefined;
      const release = vi.fn();
      const mounted = await mount({
        adapters: adapters({
          picking: {
            pick: (_request, signal) => {
              pickSignal = signal;
              return new Promise(() => undefined);
            },
          },
          images: {
            resolve: (_reference, signal) => {
              imageSignal = signal;
              return new Promise(() => undefined);
            },
          },
          elements: {
            resolve: (_request, signal) => {
              elementSignal = signal;
              return new Promise(() => undefined);
            },
          },
          viewerState: {
            capture: () => neutralState(),
            prepare: (_state, context) => {
              viewSignal = context.signal;
              return new Promise((_, reject) => context.signal.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              ));
            },
            apply: () => undefined,
            rollback: () => undefined,
          },
          interaction: { acquire: () => ({ release }) },
        }),
      });
      const instance = required(mounted.instance());
      instance.annotations.create({
        id: 'pending-image',
        anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
        content: { kind: 'host-image', reference: 'asset:pending', alt: 'Pending host image' },
      });
      instance.update();
      instance.annotations.create({
        id: 'pending-element',
        anchor: {
          kind: 'element',
          modelId: 'model',
          elementId: 'stable-element',
          fallbackPoint: { x: 0, y: 0, z: 0 },
        },
        content: { kind: 'plain-note', text: 'Pending stable element' },
      });
      instance.views.insert({
        id: 'pending-view',
        name: 'Pending view',
        viewerState: neutralState(),
        annotationOverrides: {},
      });
      const activation = instance.views.activate('pending-view');
      const outcome = instance.authoring.start({
        draft: { id: 'pending', content: { kind: 'plain-note', text: 'Pending' } },
      });
      void instance.authoring.pointerDown(pointer());
      await Promise.resolve();
      expect(instance.authoring.getSnapshot().pendingPick).toBe(true);
      await vi.waitFor(() => expect(viewSignal).toBeDefined());
      const boundary = mounted.boundary();
      await mounted.dispose();
      await expect(outcome).resolves.toEqual({ status: 'cancelled', reason: 'disposed' });
      expect(pickSignal?.aborted).toBe(true);
      expect(imageSignal?.aborted).toBe(true);
      expect(elementSignal?.aborted).toBe(true);
      expect(viewSignal?.aborted).toBe(true);
      await expect(activation).resolves.toMatchObject({ status: 'cancelled' });
      expect(release).toHaveBeenCalledOnce();
      expect(boundary.querySelector('[data-viewleader-overlay]')).toBeNull();
      expect(boundary.querySelector('[data-viewleader-status]')).toBeNull();
    });

    it('realigns the public overlay after viewport/DPR changes and survives repeated boundary cycles', async () => {
      let viewport = { width: 640, height: 360, devicePixelRatio: 1 };
      const mounted = await mount({
        adapters: {
          projection: {
            getViewport: () => viewport,
            project: (point, current) => ({
              point: { x: current.width / 2 + point.x, y: current.height / 2 - point.y },
              depth: point.z,
              visible: true,
            }),
          },
        },
      });
      required(mounted.instance()).annotations.create({
        id: 'alignment',
        anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
        content: { kind: 'plain-note', text: 'Alignment' },
      });
      required(mounted.instance()).update();
      expect(overlay(mounted.boundary()).getAttribute('width')).toBe('640');
      expect(overlay(mounted.boundary()).getAttribute('data-device-pixel-ratio')).toBe('1');

      viewport = { width: 480, height: 240, devicePixelRatio: 2 };
      const view = mounted.boundary().ownerDocument.defaultView!;
      view.dispatchEvent(new view.Event('resize'));
      required(mounted.instance()).update();
      expect(overlay(mounted.boundary()).getAttribute('width')).toBe('480');
      expect(overlay(mounted.boundary()).getAttribute('height')).toBe('240');
      expect(overlay(mounted.boundary()).getAttribute('data-device-pixel-ratio')).toBe('2');

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const previous = required(mounted.instance());
        await mounted.replaceBoundary();
        expect(() => previous.update()).toThrowError(expect.objectContaining({ code: 'DISPOSED' }));
        expect(mounted.boundary().querySelectorAll('[data-viewleader-overlay]')).toHaveLength(1);
      }
      const finalBoundary = mounted.boundary();
      await mounted.dispose();
      expect(finalBoundary.querySelector('[data-viewleader-overlay]')).toBeNull();
    });
  });
}

function neutralState() {
  return {
    camera: {
      projection: 'perspective' as const,
      position: { x: 0, y: 0, z: 5 },
      direction: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      verticalFieldOfView: 60,
      near: 0.1,
      far: 100,
    },
    modelVisibility: [],
    elementVisibility: [],
    selection: [],
    colorOverrides: [],
    clippingPlanes: [],
  };
}

function overlay(boundary: HTMLElement): SVGElement {
  const value = boundary.querySelector<SVGElement>('[data-viewleader-overlay]');
  if (value === null) throw new Error('Framework binding did not mount an overlay');
  return value;
}

function adapters(overrides: Partial<HostAdapterBundle> = {}): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ width: 640, height: 360, devicePixelRatio: 1 }),
      project: ({ x, y, z }) => ({
        point: { x: 320 + x, y: 180 - y },
        depth: z,
        visible: true,
      }),
    },
    ...overrides,
  };
}

function pointer() {
  return {
    x: 0.5,
    y: 0.5,
    button: 0,
    buttons: 1,
    pointerType: 'mouse' as const,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error('Framework binding did not expose a ViewLeader instance');
  return value;
}
