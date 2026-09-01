/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { markdownPlugin } from 'viewleader/markdown';
import {
  ViewLeader,
  type HostAdapterBundle,
  type OcclusionResult,
  type OcclusionSample,
  type ResolvedHostImage,
} from '../src/index.js';

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function adapters(overrides: Partial<HostAdapterBundle> = {}): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
      project: (point) => ({
        point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
        depth: point.z,
        visible: Math.abs(point.x) < 100 && Math.abs(point.y) < 100,
      }),
    },
    ...overrides,
  };
}

const plane = {
  origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
} as const;

describe('v1 public runtime content and markup integration', () => {
  it('renders one shared label, every ordered independently-routed leg, regions, and open ink', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    const markup = leader.authoring.markup;
    void markup.start({
      kind: 'revision-cloud',
      draft: {
        id: 'mixed',
        content: { kind: 'plain-note', text: 'Shared content' },
        placement: { kind: 'manual', position: { x: 620, y: 120 } },
      },
      commit: { legId: 'region-leg', route: { mode: 'orthogonal' } },
      plane,
    });
    markup.setRegionGeometry({
      kind: 'revision-cloud',
      vertices: [{ x: -4, y: -3 }, { x: 4, y: -3 }, { x: 4, y: 3 }, { x: -4, y: 3 }],
      arcLength: 2,
    });
    markup.complete();
    markup.addAnchor('mixed', {
      id: 'point-leg',
      anchor: { kind: 'world-point', point: { x: -12, y: -8, z: 0 } },
      routing: { kind: 'manual', vertices: [{ x: 330, y: 420 }] },
    }, 0);

    void markup.start({ kind: 'ink', commit: { id: 'stroke-a' }, plane });
    for (const point of [{ x: -10, y: 8 }, { x: -6, y: 10 }, { x: -2, y: 8 }, { x: 2, y: 9 }]) {
      markup.appendInkPoint(point);
    }
    markup.complete();
    leader.update();

    const group = root.querySelector('[data-annotation-id="mixed"]');
    expect(group).not.toBeNull();
    expect(group?.querySelectorAll('[data-hit-target="label"]')).toHaveLength(1);
    expect(group?.querySelectorAll('[data-hit-target="leader"]')).toHaveLength(2);
    expect([...group!.querySelectorAll('[data-hit-target="leader"]')]
      .map((element) => element.getAttribute('data-leg-id'))).toEqual(['point-leg', 'region-leg']);
    expect(group?.querySelector('[data-region-kind="revision-cloud"]')?.getAttribute('d')).toContain('Q');
    const inkPath = root.querySelector('[data-ink-id="stroke-a"] [data-ink-stroke]');
    expect(inkPath?.getAttribute('d')).toMatch(/^M .* L /u);
    expect(inkPath?.getAttribute('d')).not.toContain('Z');

    const first = root.innerHTML;
    leader.update();
    expect(root.innerHTML).toBe(first);
    leader.dispose();
  });

  it('uses non-blocking host image state, converges through invalidation, and cancels stale owners', async () => {
    const requests = new Map<string, ReturnType<typeof deferred<ResolvedHostImage>>>();
    const signals = new Map<string, AbortSignal>();
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({
        images: {
          resolve: (reference, signal) => {
            const request = deferred<ResolvedHostImage>();
            requests.set(reference, request);
            signals.set(reference, signal);
            return request.promise;
          },
        },
      }),
    });
    leader.annotations.create({
      id: 'image',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      content: { kind: 'host-image', reference: 'drawing:a', alt: 'Floor plan', width: 120, height: 80 },
    });
    leader.update();
    expect(root.querySelector('[data-image-reference="drawing:a"]')?.getAttribute('data-image-status')).toBe('pending');

    leader.annotations.update('image', {
      content: { kind: 'host-image', reference: 'drawing:b', alt: 'Updated plan', width: 120, height: 80 },
    });
    leader.update();
    expect(signals.get('drawing:a')?.aborted).toBe(true);
    requests.get('drawing:a')?.resolve({ source: '/ignored.png', width: 1, height: 1 });
    requests.get('drawing:b')?.resolve({ source: '/resolved.png', width: 240, height: 160 });
    await settle();
    expect(root.querySelector('[data-image-reference="drawing:b"]')?.getAttribute('data-image-status')).toBe('ready');
    expect(root.querySelector('[data-image-reference="drawing:b"] image')?.getAttribute('href')).toBe('/resolved.png');
    expect(root.querySelector('[data-image-reference="drawing:a"]')).toBeNull();
    leader.dispose();
  });

  it('batches occlusion only from final routes and applies fade and hide without durable mutation', async () => {
    const batch = deferred<readonly OcclusionResult[]>();
    const test = vi.fn((_samples: readonly OcclusionSample[], _signal: AbortSignal) => batch.promise);
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters({ occlusion: { test } }) });
    for (const [id, occlusion, x] of [
      ['faded', 'fade', -4],
      ['hidden', 'hide', 4],
    ] as const) {
      leader.annotations.create({
        id,
        anchor: { kind: 'world-point', point: { x, y: 0, z: 0 } },
        content: { kind: 'tag', text: id },
        placement: { kind: 'manual', position: { x: 600, y: id === 'faded' ? 100 : 180 } },
        occlusion,
      });
    }
    const bytes = leader.documents.serialize();
    const revision = leader.documents.getSnapshot().documentRevision;
    leader.update();
    expect(test).toHaveBeenCalledTimes(1);
    const samples = test.mock.calls[0]?.[0];
    expect(samples).toHaveLength(2);
    expect(samples?.every((sample) => sample.worldPoint !== undefined)).toBe(true);
    batch.resolve(samples!.map((sample) => ({ ...sample, occluded: true })));
    await settle();
    expect(root.querySelector('[data-annotation-id="faded"]')?.getAttribute('opacity')).toBe('0.25');
    expect(root.querySelector('[data-annotation-id="hidden"]')).toBeNull();
    expect(leader.documents.serialize()).toBe(bytes);
    expect(leader.documents.getSnapshot().documentRevision).toBe(revision);
    leader.dispose();
  });

  it('migrates and renders Markdown through the public plugin contract and rejects invalid visuals atomically', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters(), plugins: [markdownPlugin] });
    const created = leader.annotations.create({
      id: 'markdown',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      content: {
        kind: 'plugin:viewleader.markdown',
        pluginId: 'viewleader.markdown',
        schemaVersion: 1,
        data: { markdown: '**Bold** and `code`\n\n- first' },
      },
    });
    expect(created.content).toMatchObject({ schemaVersion: 2, data: { source: '**Bold** and `code`\n\n- first' } });
    leader.update();
    const group = root.querySelector('[data-annotation-id="markdown"]');
    expect(group?.textContent).toContain('Bold');
    expect(group?.textContent).toContain('code');
    expect(group?.textContent).toContain('•');
    expect(group?.querySelector('[font-weight="bold"]')).not.toBeNull();
    expect(group?.querySelector('[font-family="monospace"]')).not.toBeNull();

    const before = leader.documents.serialize();
    const history = leader.history.getSnapshot();
    expect(() => leader.annotations.update('markdown', {
      content: {
        kind: 'plugin:viewleader.markdown',
        pluginId: 'viewleader.markdown',
        schemaVersion: 2,
        data: { source: '# unsupported heading' },
      },
    })).toThrow();
    expect(leader.documents.serialize()).toBe(before);
    expect(leader.history.getSnapshot()).toEqual(history);
    leader.dispose();
  });

  it('opens a document whose Markdown has unsupported syntax, renders it as literal text once, and ' +
    'round-trips the source byte-identically', () => {
    const root = boundary();
    const seed = new ViewLeader({ boundary: root, adapters: adapters(), plugins: [markdownPlugin] });
    seed.annotations.create({
      id: 'markdown',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      content: {
        kind: 'plugin:viewleader.markdown',
        pluginId: 'viewleader.markdown',
        schemaVersion: 2,
        data: { source: 'Valid **bold** paragraph' },
      },
    });
    const serialized = seed.documents.serialize();
    seed.dispose();

    // A colleague's document with a heading this subset does not draw — not something
    // this build's authoring could have produced, since annotations.update rejects it above.
    const degradedSource = '# Heading\n\n<img src=x onerror=alert(1)>\n\nStill **bold** here';
    const withUnsupportedSyntax = serialized.replace(
      JSON.stringify('Valid **bold** paragraph'),
      JSON.stringify(degradedSource),
    );
    expect(withUnsupportedSyntax).not.toBe(serialized);

    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters(),
      plugins: [markdownPlugin],
      initialDocument: withUnsupportedSyntax,
    });
    expect(leader.diagnostics.getSnapshot()).toEqual([
      expect.objectContaining({ code: 'PLUGIN_CONTENT_DEGRADED', severity: 'warning', annotationId: 'markdown' }),
    ]);

    leader.update();
    const group = root.querySelector('[data-annotation-id="markdown"]');
    expect(group?.textContent).toContain('# Heading');
    expect(group?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(group?.textContent).toContain('bold');
    expect(root.querySelector('a')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    // The raw markup is shown as text, not parsed: it appears only HTML-escaped in the DOM.
    expect(root.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');

    // Rendering is per frame; the diagnostic from opening the document is not.
    const diagnosticCountAfterFirstFrame = leader.diagnostics.getSnapshot().length;
    leader.update();
    leader.update();
    expect(leader.diagnostics.getSnapshot().length).toBe(diagnosticCountAfterFirstFrame);

    const reopened = JSON.parse(leader.documents.serialize()) as {
      annotations: readonly { id: string; content: { data: { source: string } } }[];
    };
    expect(reopened.annotations.find((annotation) => annotation.id === 'markdown')?.content.data.source)
      .toBe(degradedSource);
    leader.dispose();
  });

  it('hosts plugin authoring publicly and lowers one validated command into one durable commit', () => {
    const release = vi.fn();
    const root = boundary();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({ interaction: { acquire: () => ({ release }) } }),
      plugins: [markdownPlugin],
    });
    leader.authoring.plugins.start({
      pluginId: 'viewleader.markdown',
      toolId: 'author',
      draft: {
        id: 'plugin-authored',
        anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      },
    });
    expect(leader.authoring.plugins.dispatch({
      kind: 'programmatic',
      action: 'set-source',
      data: { source: '**Authored** safely' },
    })).toMatchObject({ phase: 'active', state: { source: '**Authored** safely' } });
    const notifications: number[] = [];
    const unsubscribe = leader.documents.subscribe(() => {
      notifications.push(leader.documents.getSnapshot().documentRevision);
    });
    expect(leader.authoring.plugins.dispatch({
      kind: 'programmatic',
      action: 'complete',
    })).toMatchObject({ phase: 'idle', documentRevision: 1 });
    expect(leader.annotations.get('plugin-authored')?.content).toEqual({
      kind: 'plugin:viewleader.markdown',
      pluginId: 'viewleader.markdown',
      schemaVersion: 2,
      data: { source: '**Authored** safely' },
    });
    expect(leader.history.getSnapshot()).toMatchObject({ undoCount: 1 });
    expect(notifications).toEqual([1]);
    expect(release).toHaveBeenCalledOnce();
    leader.update();
    expect(root.querySelector('[data-annotation-id="plugin-authored"]')?.textContent)
      .toContain('Authored');
    unsubscribe();

    leader.authoring.plugins.start({
      pluginId: 'viewleader.markdown',
      toolId: 'author',
      draft: {
        id: 'cancelled-plugin',
        anchor: { kind: 'world-point', point: { x: 1, y: 1, z: 0 } },
      },
    });
    const revision = leader.documents.getSnapshot().documentRevision;
    expect(leader.authoring.plugins.cancel()).toMatchObject({ phase: 'idle' });
    expect(leader.documents.getSnapshot().documentRevision).toBe(revision);
    expect(leader.annotations.get('cancelled-plugin')).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
    leader.dispose();
  });
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
