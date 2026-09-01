import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_DEFINITIONS,
  DefinitionsCapability,
  applyTemplateDefaults,
  validateDefinition,
  type DefinitionDocumentPort,
  type DefinitionMutation,
  type DefinitionReferenceCounts,
  type TemplateDefinition,
  type TypedDefinition,
} from '../src/definitions.js';
import {
  addRouteVertex,
  moveRouteVertex,
  removeRouteVertex,
  resetPlacement,
  resetRoute,
  routeLegs,
  setManualPlacement,
} from '../src/routing.js';
import {
  ImageResolutionManager,
  validateHostImageContent,
  type HostImagePort,
} from '../src/images.js';
import {
  OcclusionManager,
  type HostOcclusionPort,
} from '../src/occlusion.js';
import {
  ExtensionRuntime,
  type PluginDescriptor,
} from '../src/extensions.js';
import {
  MARKDOWN_PLUGIN_ID,
  markdownPlugin,
  parseMarkdownPluginContent,
  parseMarkdownPluginContentLoose,
} from 'viewleader/markdown';
import {
  addRegionVertex,
  createInk,
  createRegionAnchor,
  drawingPlaneFromSurfacePick,
  editInkPoint,
  generateRevisionCloudArcs,
  moveInk,
  moveRegion,
  moveRegionVertex,
  projectInk,
  projectRegion,
  regionAnchorFromCore,
  regionAnchorToCore,
  removeRegionVertex,
  replaceInkPoints,
  resizeRegion,
  simplifyInk,
} from '../src/markup.js';
import type { PluginEnvelope } from '../src/types.js';
import { DocumentEngine } from '../src/document.js';
import { MarkupAuthoringCapability } from '../src/markup-authoring-capability.js';

class DefinitionPortFake implements DefinitionDocumentPort {
  public definitions: readonly TypedDefinition[] = [];
  public references: DefinitionReferenceCounts = {
    annotations: 0,
    styles: 0,
    templates: 0,
    total: 0,
  };
  public commits = 0;
  public undo: readonly (readonly TypedDefinition[])[] = [];

  public readDefinitions(): readonly TypedDefinition[] {
    return structuredClone(this.definitions);
  }

  public referenceCounts(): DefinitionReferenceCounts {
    return this.references;
  }

  public transact<Value>(
    _label: string,
    operation: (current: readonly TypedDefinition[]) => DefinitionMutation<Value>,
  ): Value {
    const before = structuredClone(this.definitions);
    const result = operation(before);
    if (JSON.stringify(before) !== JSON.stringify(result.definitions)) {
      this.undo = [...this.undo, before];
      this.definitions = structuredClone(result.definitions);
      this.commits += 1;
    }
    return result.value;
  }
}

const customStyle: TypedDefinition = {
  kind: 'style',
  id: 'project.style.red',
  name: 'Red review',
  lineColor: '#ff0000',
  lineWidth: 2,
  textColor: '#111111',
  fontFamily: 'Noto Sans, sans-serif',
  fontSize: 14,
  terminatorId: 'builtin.terminator.arrow',
};

describe('v1 typed definitions and templates', () => {
  it('keeps built-ins immutable and custom CRUD transaction-shaped', () => {
    const port = new DefinitionPortFake();
    const definitions = new DefinitionsCapability(port);
    expect(definitions.list()).toHaveLength(BUILT_IN_DEFINITIONS.length);
    expect(() => definitions.create({ ...customStyle, id: 'builtin.style.standard' }))
      .toThrowError(expect.objectContaining({ code: 'IMMUTABLE_DEFINITION' }));
    expect(port.commits).toBe(0);

    const created = definitions.create(customStyle);
    expect(created).toEqual(customStyle);
    expect(port.commits).toBe(1);
    const updated = definitions.update(customStyle.id, { ...customStyle, lineWidth: 3 });
    expect(updated).toMatchObject({ lineWidth: 3 });
    expect(port.commits).toBe(2);

    port.references = { annotations: 2, styles: 0, templates: 1, total: 3 };
    expect(() => definitions.remove(customStyle.id)).toThrowError(expect.objectContaining({
      code: 'DEFINITION_IN_USE',
      details: { id: customStyle.id, referenceCounts: port.references },
    }));
    expect(port.commits).toBe(2);
    port.references = { annotations: 0, styles: 0, templates: 0, total: 0 };
    expect(definitions.remove(customStyle.id)).toMatchObject({ id: customStyle.id });
    expect(port.commits).toBe(3);
  });

  it('validates declarative geometry and copies template defaults', () => {
    expect(() => validateDefinition({
      ...customStyle,
      lineColor: 'url(https://attacker.invalid/a)',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_DEFINITION' }));
    expect(() => validateDefinition({
      kind: 'terminator',
      id: 'project.terminator.bad',
      name: 'Bad',
      bounds: { x: 0, y: 0, width: 4, height: 4 },
      attachment: { point: { x: 0, y: 0 }, direction: { x: 1, y: 0 } },
      commands: [{ command: 'move', to: { x: 0, y: 0 } }, { command: 'close' }],
      fill: 'filled',
      rawSvg: '<script />',
    } as never)).toThrowError(expect.objectContaining({ code: 'INVALID_DEFINITION' }));

    const template: TemplateDefinition = {
      kind: 'template',
      id: 'project.template.callout',
      name: 'Callout',
      defaults: {
        content: { kind: 'callout', title: 'Review', text: 'Coordinate' },
        placement: { kind: 'manual', position: { x: 10, y: 20 } },
        routing: { kind: 'automatic', mode: 'orthogonal' },
        styleId: 'project.style.red',
      },
    };
    const seeded = applyTemplateDefaults({}, template);
    (template.defaults.placement as { readonly kind: 'manual'; readonly position: { x: number; y: number } })
      .position.x = 999;
    expect(seeded).toMatchObject({ placement: { position: { x: 10, y: 20 } } });
  });
});

describe('v1 placement, routes, and independent legs', () => {
  it('routes distinct anchors to distinct polylines', () => {
    // This used to also grade `placeLabels`, deleted in phase 2.3 for the one-placement-path
    // criterion. Placement determinism moved to `v1-plan-snapshot.test.ts`, which grades it on the
    // live path against a committed snapshot rather than on a function nothing called.
    const legs = routeLegs([
      { id: 'left', anchor: { x: 20, y: 80 }, route: { mode: 'straight' } },
      { id: 'right', anchor: { x: 350, y: 200 }, route: { mode: 'orthogonal' } },
    ], { x: 100, y: 100, width: 80, height: 30 });
    expect(legs).toHaveLength(2);
    expect(legs[0]!.points).not.toEqual(legs[1]!.points);
    expect(legs.every(({ points }) => points.length >= 2)).toBe(true);
  });

  it('edits manual vertices and resets placement and routes without stale data', () => {
    let route = addRouteVertex({ mode: 'manual', vertices: [] }, 0, { x: 2, y: 3 });
    route = addRouteVertex(route, 1, { x: 4, y: 5 });
    route = moveRouteVertex(route, 0, { x: 3, y: 4 });
    route = removeRouteVertex(route, 1);
    expect(route).toEqual({ mode: 'manual', vertices: [{ x: 3, y: 4 }] });
    expect(resetRoute()).toEqual({ mode: 'dogleg' });
    expect(setManualPlacement({ x: 1, y: 2 })).toEqual({
      kind: 'manual', position: { x: 1, y: 2 },
    });
    expect(resetPlacement()).toEqual({ kind: 'automatic' });
  });

});

describe('v1 host images', () => {
  it('uses a stable placeholder, caches success, and never awaits frame reads', async () => {
    let complete!: (value: { source: string; width: number; height: number }) => void;
    const resolve = vi.fn(() => new Promise<{ source: string; width: number; height: number }>((done) => {
      complete = done;
    }));
    const invalidate = vi.fn();
    const manager = new ImageResolutionManager({ resolve } satisfies HostImagePort, {
      invalidate,
      diagnostic: vi.fn(),
    });
    const content = { kind: 'host-image' as const, reference: 'asset.logo', alt: 'Company logo' };
    expect(manager.read('annotation-a', content)).toEqual({
      status: 'pending', bounds: { width: 160, height: 90 }, alt: 'Company logo', placeholder: true,
    });
    complete({ source: '/host-owned/logo.png', width: 800, height: 450 });
    await flush();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(manager.read('annotation-a', content)).toMatchObject({
      status: 'ready', intrinsic: { width: 800, height: 450 }, placeholder: false,
    });
    expect(manager.read('annotation-b', content)).toMatchObject({ status: 'ready' });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('rejects network instructions, diagnoses failure, and ignores cancelled late work', async () => {
    expect(() => validateHostImageContent({
      kind: 'host-image', reference: 'https://attacker.invalid/image.png', alt: 'unsafe',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_IMAGE' }));

    let reject!: (cause: unknown) => void;
    let signal!: AbortSignal;
    const diagnostic = vi.fn();
    const invalidate = vi.fn();
    const manager = new ImageResolutionManager({
      resolve: ({ signal: requestSignal }) => {
        signal = requestSignal;
        return new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
      },
    }, { diagnostic, invalidate });
    const content = { kind: 'host-image' as const, reference: 'asset.bad', alt: 'Unavailable diagram' };
    manager.read('annotation', content);
    manager.release('annotation');
    expect(signal.aborted).toBe(true);
    reject(new Error('late'));
    await flush();
    expect(diagnostic).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();

    const failing = new ImageResolutionManager({ resolve: async () => { throw new Error('decode'); } }, {
      diagnostic,
      invalidate,
    });
    failing.read('annotation', content);
    await flush();
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'ADAPTER_ERROR' }));
    expect(failing.read('annotation', content)).toMatchObject({ status: 'failed', alt: content.alt });
    failing.dispose();
    failing.dispose();
  });
});

describe('v1 optional batched occlusion', () => {
  const candidates = [{
    id: 'annotation',
    routes: [[{ x: 0, y: 0 }, { x: 10, y: 10 }]],
  }];

  it('defaults to visible and applies completed current policy results', async () => {
    let complete!: (result: readonly { id: string; occluded: boolean }[]) => void;
    const resolveBatch = vi.fn(() => new Promise<readonly { id: string; occluded: boolean }[]>((done) => {
      complete = done;
    }));
    const manager = new OcclusionManager({ resolveBatch } satisfies HostOcclusionPort, {
      invalidate: vi.fn(),
      diagnostic: vi.fn(),
    });
    const policies = new Map([['annotation', 'fade' as const]]);
    expect(manager.present(candidates, policies)).toEqual([
      { id: 'annotation', visible: true, opacity: 1 },
    ]);
    complete([{ id: 'annotation', occluded: true }]);
    await flush();
    expect(manager.present(candidates, policies)).toEqual([
      { id: 'annotation', visible: true, opacity: 0.25 },
    ]);
    expect(resolveBatch).toHaveBeenCalledOnce();
  });

  it('uses keep fallback for a missing port and cancels stale batches', () => {
    const missing = new OcclusionManager(undefined, { invalidate: vi.fn(), diagnostic: vi.fn() });
    expect(missing.present(candidates, new Map([['annotation', 'hide']]))).toEqual([
      { id: 'annotation', visible: true, opacity: 1 },
    ]);

    const signals: AbortSignal[] = [];
    const port: HostOcclusionPort = {
      resolveBatch: ({ signal }) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
    };
    const manager = new OcclusionManager(port, { invalidate: vi.fn(), diagnostic: vi.fn() });
    manager.present(candidates, new Map());
    manager.present([{ ...candidates[0]!, routes: [[{ x: 1, y: 0 }, { x: 10, y: 10 }]] }], new Map());
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    manager.dispose();
    expect(signals[1]!.aborted).toBe(true);
  });
});

describe('v1 frozen extensions and Markdown proof', () => {
  it('rejects invalid registration and preserves missing or migration-gap records', () => {
    expect(() => new ExtensionRuntime([markdownPlugin, markdownPlugin]))
      .toThrowError(expect.objectContaining({ code: 'INVALID_PLUGIN' }));
    expect(() => new ExtensionRuntime([{ ...markdownPlugin, id: 'bad.plugin', coreApiRange: '^2.0.0' }]))
      .toThrowError(expect.objectContaining({ code: 'INVALID_PLUGIN' }));

    const runtime = new ExtensionRuntime([markdownPlugin]);
    const missing: PluginEnvelope = {
      pluginId: 'missing.plugin', recordType: 'content', schemaVersion: 1, data: { value: true },
    };
    const gap: PluginEnvelope = {
      pluginId: MARKDOWN_PLUGIN_ID, recordType: 'content', schemaVersion: 3, data: { source: 'future' },
    };
    const resolution = runtime.prepare([missing, gap]);
    expect(resolution.unresolved).toEqual([missing, gap]);
    expect(resolution.diagnostics.map(({ code }) => code)).toEqual([
      'PLUGIN_MISSING', 'PLUGIN_MIGRATION_MISSING',
    ]);
  });

  it('migrates, validates, renders declaratively, and runs a normalized tool', () => {
    const runtime = new ExtensionRuntime([markdownPlugin]);
    const legacy: PluginEnvelope = {
      pluginId: MARKDOWN_PLUGIN_ID,
      recordType: 'content',
      schemaVersion: 1,
      data: { markdown: '**Bold** and `code`\n\n1. First\n2. Second' },
    };
    const prepared = runtime.prepare([legacy]);
    expect(prepared.resolved[0]!.data).toEqual({
      source: '**Bold** and `code`\n\n1. First\n2. Second',
    });
    const primitives = runtime.render(prepared.resolved[0]!);
    expect(primitives.some((primitive) => primitive.kind === 'text' && primitive.bold)).toBe(true);
    expect(primitives.some((primitive) => primitive.kind === 'text' && primitive.code)).toBe(true);

    const edited = runtime.runTool(MARKDOWN_PLUGIN_ID, 'author', undefined, {
      kind: 'programmatic', action: 'set-source', data: { source: '*edited*' },
    });
    const completed = runtime.runTool(MARKDOWN_PLUGIN_ID, 'author', edited.state, {
      kind: 'programmatic', action: 'complete',
    });
    expect(completed).toMatchObject({
      outcome: 'completed',
      command: { kind: 'create', data: { source: '*edited*' } },
    });
  });

  it('accepts the intentional subset and rejects unsupported Markdown atomically', () => {
    const ast = parseMarkdownPluginContent(
      'Paragraph  \nhard\nsoft **bold** *italic* `code`\n\n- item\n  2. nested',
    );
    expect(ast.blocks).toHaveLength(2);
    for (const source of [
      '<strong>html</strong>',
      '[link](https://example.com)',
      '| table |\n| --- |',
      '# Heading',
      '```ts\ncode\n```',
    ]) {
      expect(() => parseMarkdownPluginContent(source)).toThrowError(
        expect.objectContaining({ code: 'INVALID_PLUGIN' }),
      );
    }
  });

  it('degrades unsupported Markdown to its literal text instead of throwing when loaded', () => {
    for (const [source, literal] of [
      ['# Heading', '# Heading'],
      ['<strong>html</strong>', '<strong>html</strong>'],
      ['[link](https://example.com)', '[link](https://example.com)'],
      ['| a | b |\n| - | - |', '| a | b |'],
      ['```ts\ncode\n```', '```ts'],
    ] as const) {
      const ast = parseMarkdownPluginContentLoose(source);
      const literalRun = ast.blocks
        .flatMap((block) => (block.kind === 'paragraph' ? block.runs : block.items.flatMap((item) => item.runs)))
        .find((run) => run.kind === 'text' && run.text === literal);
      expect(literalRun, `expected a literal run for ${JSON.stringify(source)}`).toBeDefined();
    }
    // Supported syntax next to unsupported syntax still parses normally.
    const mixed = parseMarkdownPluginContentLoose('# Heading\n\nStill **bold** here');
    const runs = mixed.blocks.flatMap((block) => (block.kind === 'paragraph' ? block.runs : []));
    expect(runs.some((run) => run.kind === 'text' && run.text === '# Heading')).toBe(true);
    expect(runs.some((run) => run.kind === 'text' && run.bold && run.text === 'bold')).toBe(true);
  });

  it('resolves and renders loaded Markdown with unsupported syntax through the extension runtime, ' +
    'with one diagnostic naming every distinct construct', () => {
    const runtime = new ExtensionRuntime([markdownPlugin]);
    const source = '# Heading\n\n## Another heading\n\n| a | b |\n| - | - |\n\nStill **bold** here';
    const envelope: PluginEnvelope = {
      pluginId: MARKDOWN_PLUGIN_ID, recordType: 'content', schemaVersion: 2, data: { source },
    };
    const resolution = runtime.prepare([envelope]);
    expect(resolution.unresolved).toEqual([]);
    expect(resolution.resolved).toHaveLength(1);
    // One repeated construct (two headings) and one different construct (a table)
    // still produce exactly one diagnostic for the whole annotation, not one per line.
    expect(resolution.diagnostics).toHaveLength(1);
    expect(resolution.diagnostics[0]).toMatchObject({ code: 'PLUGIN_CONTENT_DEGRADED' });
    expect(resolution.diagnostics[0]!.message).toContain('headings');
    expect(resolution.diagnostics[0]!.message).toContain('tables');
    // The source that reached the record is untouched, so it still round-trips byte-identically.
    expect(resolution.resolved[0]!.data).toEqual({ source });

    const primitives = runtime.render(resolution.resolved[0]!);
    expect(primitives.every((primitive) => primitive.kind === 'text')).toBe(true);
    expect(primitives.some((primitive) => primitive.kind === 'text' && primitive.text === '# Heading')).toBe(true);
    expect(primitives.some((primitive) => primitive.kind === 'text' && primitive.text === 'bold' && primitive.bold))
      .toBe(true);
  });

  it('keeps the trust boundary shut when degrading: no link becomes clickable, no HTML is interpreted', () => {
    const runtime = new ExtensionRuntime([markdownPlugin]);
    const source = '<img src=x onerror=alert(1)>\n\n[click me](javascript:alert(1))';
    const envelope: PluginEnvelope = {
      pluginId: MARKDOWN_PLUGIN_ID, recordType: 'content', schemaVersion: 2, data: { source },
    };
    const record = runtime.prepare([envelope]).resolved[0]!;
    const primitives = runtime.render(record);
    // Every primitive this plugin can ever emit is `text`; there is no primitive kind
    // that a host would treat as a link or as markup, so degrading cannot open one up.
    expect(primitives.every((primitive) => primitive.kind === 'text')).toBe(true);
    const text = primitives.map((primitive) => (primitive.kind === 'text' ? primitive.text : '')).join('\n');
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(text).toContain('[click me](javascript:alert(1))');
  });

  it('still throws for the same unsupported syntax when authored, through the tool and the commit gate', () => {
    const runtime = new ExtensionRuntime([markdownPlugin]);
    expect(() => runtime.validateForCommit({
      pluginId: MARKDOWN_PLUGIN_ID, recordType: 'content', schemaVersion: 2, data: { source: '# Heading' },
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_PLUGIN',
      message: 'Unsupported Markdown syntax: headings',
    }));

    expect(() => runtime.runTool(MARKDOWN_PLUGIN_ID, 'author', undefined, {
      kind: 'programmatic', action: 'set-source', data: { source: '| a | b |\n| - | - |' },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PLUGIN' }));
  });

  it('rejects arbitrary image URLs from plugin primitives', () => {
    const plugin: PluginDescriptor = {
      id: 'fixture.image',
      coreApiRange: '^1.0.0',
      schemaVersion: 1,
      validate: () => undefined,
      render: () => [{
        kind: 'image',
        reference: 'https://attacker.invalid/a.png',
        alt: 'bad',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        zIndex: 0,
        accessibility: { role: 'img', label: 'bad' },
      }],
    };
    const runtime = new ExtensionRuntime([plugin]);
    const record = runtime.prepare([{
      pluginId: plugin.id, recordType: 'image', schemaVersion: 1, data: {},
    }]).resolved[0]!;
    expect(() => runtime.render(record)).toThrowError(expect.objectContaining({ code: 'INVALID_PLUGIN' }));
  });
});

describe('v1 region, cloud, ink, and multi-leader geometry', () => {
  const plane = drawingPlaneFromSurfacePick({
    point: { x: 0, y: 0, z: 5 },
    normal: { x: 0, y: 0, z: 1 },
  });

  it('creates, moves, resizes, edits, and projects every closed region', () => {
    const rectangle = createRegionAnchor(plane, {
      kind: 'rectangle', center: { x: 0, y: 0 }, width: 4, height: 2,
    });
    expect(resizeRegion(moveRegion(rectangle, { x: 1, y: 2 }), { width: 8, height: 6 }))
      .toMatchObject({ geometry: { center: { x: 1, y: 2 }, width: 8, height: 6 } });

    const ellipse = createRegionAnchor(plane, {
      kind: 'ellipse', center: { x: 0, y: 0 }, radiusX: 2, radiusY: 1,
    });
    expect(projectRegion(ellipse, ({ x, y }) => ({ x, y }))?.points).toHaveLength(48);

    let polygon = createRegionAnchor(plane, {
      kind: 'polygon', vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }],
    });
    polygon = addRegionVertex(polygon, 2, { x: 4, y: 4 });
    polygon = moveRegionVertex(polygon, 2, { x: 3, y: 4 });
    polygon = removeRegionVertex(polygon, 2);
    expect(polygon.geometry).toMatchObject({ kind: 'polygon', vertices: expect.any(Array) });
    expect(() => removeRegionVertex(polygon, 0)).toThrowError(
      expect.objectContaining({ code: 'INVARIANT_VIOLATION' }),
    );

    const cloud = createRegionAnchor(plane, {
      kind: 'revision-cloud',
      vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
      arcLength: 1,
    });
    expect(generateRevisionCloudArcs(
      (cloud.geometry as { vertices: readonly { x: number; y: number }[] }).vertices,
      1,
    ).length).toBeGreaterThan(4);
    expect(projectRegion(cloud, () => undefined)).toBeUndefined();
  });

  it('simplifies deterministic open ink and supports its editing lifecycle', () => {
    const raw = Array.from({ length: 101 }, (_, index) => ({
      x: index / 10,
      y: Math.sin(index / 10) * 0.01,
    }));
    const simplified = simplifyInk(raw, 0.05);
    expect(simplified.length).toBeLessThan(raw.length);
    expect(simplifyInk(raw, 0.05)).toEqual(simplified);
    let ink = createInk({ id: 'ink-a', plane, points: raw, metadata: {} });
    ink = moveInk(ink, { x: 1, y: 2 });
    ink = editInkPoint(ink, 0, { x: 2, y: 2 });
    ink = replaceInkPoints(ink, [{ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 4, y: 4 }]);
    expect(projectInk(ink, ({ x, y }) => ({ x, y }))).toMatchObject({ kind: 'ink', closed: false });
    expect(() => createInk({
      id: 'closed', plane, metadata: {}, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('v1 transactional markup capability', () => {
  const plane = drawingPlaneFromSurfacePick({
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  });

  /** The capability on a bare document: no boundary, no host hooks. */
  function capability(document: DocumentEngine): MarkupAuthoringCapability {
    return new MarkupAuthoringCapability({
      document,
      assertActive: () => undefined,
      prepareContent: (content) => content,
      validateStyleId: () => undefined,
    });
  }

  it('commits a completed region once and restores exact geometry through undo/redo', () => {
    const document = new DocumentEngine();
    const markup = capability(document);
    void markup.start({
      kind: 'rectangle',
      draft: { id: 'region-annotation', content: { kind: 'plain-note', text: 'Region' } },
      plane,
    });
    markup.setRegionGeometry({ kind: 'rectangle', center: { x: 1, y: 2 }, width: 4, height: 3 });
    expect(markup.complete()).toMatchObject({
      status: 'completed',
      value: { anchors: [{ id: 'leg-1', anchor: { kind: 'region' } }] },
    });
    const created = document.get('region-annotation')!;
    expect(document.historySnapshot(0).undoCount).toBe(1);
    const moved = markup.updateRegion(created.id, 'leg-1', (region) => moveRegion(region, { x: 5, y: 0 }));
    expect(regionAnchorFromCoreForTest(moved)).toMatchObject({
      geometry: { center: { x: 6, y: 2 } },
    });
    expect(document.historySnapshot(0).undoCount).toBe(2);
    document.undo();
    expect(regionAnchorFromCoreForTest(document.get(created.id)!)).toMatchObject({
      geometry: { center: { x: 1, y: 2 } },
    });
    document.redo();
    expect(regionAnchorFromCoreForTest(document.get(created.id)!)).toMatchObject({
      geometry: { center: { x: 6, y: 2 } },
    });
  });

  it('keeps cancelled previews transient and supports ink create/edit/delete history', () => {
    const document = new DocumentEngine();
    const markup = capability(document);
    void markup.start({ kind: 'ink', commit: { id: 'ink-1' }, plane });
    markup.appendInkPoint({ x: 0, y: 0 });
    expect(markup.cancel()).toEqual({ status: 'cancelled', reason: 'host' });
    expect(document.document.ink).toEqual([]);

    void markup.start({ kind: 'ink', commit: { id: 'ink-1' }, plane });
    for (const point of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }]) markup.appendInkPoint(point);
    expect(markup.complete()).toMatchObject({ status: 'completed', value: { kind: 'ink', id: 'ink-1' } });
    const ink = markup.getInk('ink-1')!;
    markup.updateInk(ink.id, (current) => moveInk(current, { x: 1, y: 0 }));
    markup.removeInk(ink.id);
    expect(markup.listInk()).toEqual([]);
    document.undo();
    expect(markup.getInk(ink.id)).toBeDefined();
    document.undo();
    expect(markup.getInk(ink.id)?.points[0]).toEqual({ x: 0, y: 0 });
  });

  it('adds, reorders, reroutes, retargets and removes anchor legs, refusing the last one', () => {
    const document = new DocumentEngine();
    const markup = capability(document);
    document.create({
      id: 'multi',
      anchors: [{
        id: 'point',
        anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
        routing: { kind: 'automatic', mode: 'straight' },
      }],
      content: { kind: 'plain-note', text: 'Mixed anchors' },
    });
    markup.addAnchor('multi', {
      id: 'element',
      anchor: {
        kind: 'element', modelId: 'model', elementId: 'wall', fallbackPoint: { x: 1, y: 2, z: 3 },
      },
      routing: { kind: 'automatic', mode: 'orthogonal' },
    });
    markup.addAnchor('multi', {
      id: 'region',
      anchor: regionAnchorToCore(createRegionAnchor(plane, {
        kind: 'rectangle', center: { x: 0, y: 0 }, width: 2, height: 2,
      })),
      routing: { kind: 'manual', vertices: [{ x: 4, y: 5 }] },
    });
    markup.reorderAnchor('multi', 'region', 0);
    markup.setLegRoute('multi', 'element', { mode: 'manual', vertices: [{ x: 9, y: 9 }] });
    const annotation = markup.retargetAnchor('multi', 'point', {
      kind: 'world-point', point: { x: 10, y: 10, z: 10 },
    });
    expect(annotation.anchors.map(({ id }) => id)).toEqual(['region', 'point', 'element']);
    expect(annotation.anchors.map(({ routing }) => routing)).toEqual([
      { kind: 'manual', vertices: [{ x: 4, y: 5 }] },
      { kind: 'automatic', mode: 'straight' },
      { kind: 'manual', vertices: [{ x: 9, y: 9 }] },
    ]);
    expect(annotation.anchors[1]?.anchor).toEqual({ kind: 'world-point', point: { x: 10, y: 10, z: 10 } });
    expect(() => markup.reorderAnchor('multi', 'region', 3)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    markup.removeAnchor('multi', 'region');
    markup.removeAnchor('multi', 'element');
    expect(() => markup.removeAnchor('multi', 'point')).toThrowError(expect.objectContaining({
      code: 'INVARIANT_VIOLATION',
      details: expect.objectContaining({ annotationId: 'multi', anchorId: 'point' }),
    }));
  });
});

function regionAnchorFromCoreForTest(
  annotation: NonNullable<ReturnType<DocumentEngine['get']>>,
): ReturnType<typeof createRegionAnchor> {
  const anchor = annotation.anchors[0]?.anchor;
  if (anchor?.kind !== 'region') throw new Error('Expected a region anchor');
  return regionAnchorFromCore(anchor);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
