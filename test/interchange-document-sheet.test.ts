/** @vitest-environment jsdom */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { DocumentEngine } from '../src/document.js';
import { ViewLeader, type HostAdapterBundle } from '../src/index.js';
import {
  exportVectorSheet,
  mergeIdentifiedDocuments,
  planBcfApply,
  rasterizeVectorSheet,
  refreshElementFallbacksOnSave,
  transactionalLoad,
} from '../src/interchange/index.js';

describe('M9 save hygiene and transactional loads', () => {
  it('refreshes primary and leg fallback points only in the output copy', () => {
    const source = {
      version: 1,
      annotations: [
        {
          id: 'a',
          anchor: {
            kind: 'element',
            elementId: 'primary',
            fallbackPoint: { x: 0, y: 0, z: 0 },
          },
          legs: [
            {
              id: 'leg',
              anchor: {
                kind: 'element',
                elementId: 'extra',
                fallbackPoint: { x: 1, y: 1, z: 1 },
              },
            },
          ],
        },
      ],
    };
    const before = structuredClone(source);
    const saved = refreshElementFallbacksOnSave(source, ({ elementId }) =>
      elementId === 'primary' ? { x: 2, y: 3, z: 4 } : undefined,
    );
    expect(source).toEqual(before);
    expect(saved.annotations[0]?.anchor.fallbackPoint).toEqual({ x: 2, y: 3, z: 4 });
    expect(saved.annotations[0]?.legs?.[0]?.anchor.fallbackPoint).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('merges only missing ids and reports every duplicate', () => {
    const current = { annotations: [{ id: 'a', value: 1 }] };
    const incoming = { annotations: [{ id: 'a', value: 2 }, { id: 'b', value: 3 }, { id: 'b', value: 4 }] };
    const result = mergeIdentifiedDocuments(current, incoming);
    expect(result.document.annotations).toEqual([{ id: 'a', value: 1 }, { id: 'b', value: 3 }]);
    expect(result.report).toEqual({ mode: 'merge', created: 1, skippedIds: ['a', 'b'] });
  });

  it('rolls replace back byte-equivalently when population fails after reset', () => {
    let state = { annotations: [{ id: 'known' }], marker: 'good' };
    let failOnce = true;
    const target = {
      read: () => structuredClone(state),
      reset: () => { state = { annotations: [], marker: '' }; },
      populate: (document: typeof state) => {
        if (document.marker === 'bad' && failOnce) {
          failOnce = false;
          throw new Error('population failed');
        }
        state = structuredClone(document);
      },
    };
    expect(() => transactionalLoad(
      target,
      { annotations: [{ id: 'incoming' }], marker: 'bad' },
      'replace',
      () => ({ valid: true, errors: [] }),
    )).toThrow('population failed');
    expect(state).toEqual({ annotations: [{ id: 'known' }], marker: 'good' });
  });

  it('plans embedded or lossy foreign topics idempotently without manager mutation', () => {
    const embedded = { version: 1, annotations: [] };
    const topics = [
      {
        id: 'embedded',
        title: 'Exact',
        comments: [],
        components: [],
        embeddedDocument: embedded,
      },
      {
        id: 'foreign',
        title: 'Foreign issue',
        comments: [],
        components: ['IFC-A', 'IFC-A', 'IFC-MISS'],
        camera: {
          type: 'perspective' as const,
          position: { x: 0, y: 0, z: 5 },
          direction: { x: 0, y: 0, z: -1 },
          up: { x: 0, y: 1, z: 0 },
          fieldOfView: 60,
          aspect: 1,
        },
      },
    ];
    const first = planBcfApply(topics, {
      validateEmbeddedDocument: () => ({ valid: true, errors: [] }),
      componentToAnchor: (component) => component === 'IFC-A'
        ? { kind: 'element', elementId: 'element-a', fallbackPoint: { x: 1, y: 2, z: 3 } }
        : undefined,
    });
    expect(first).toMatchObject({ created: 3, errors: [] });
    expect(first.embeddedDocuments).toEqual([{ topicId: 'embedded', document: embedded }]);
    expect(first.views).toHaveLength(1);
    expect(first.annotations).toHaveLength(1);

    const second = planBcfApply(topics, {
      appliedTopicIds: new Set(['embedded', 'foreign']),
      validateEmbeddedDocument: () => ({ valid: true, errors: [] }),
    });
    expect(second.created).toBe(0);
    expect(second.skippedIds).toEqual(['embedded', 'foreign']);
  });

  // The planner's ids are only worth anything if core accepts them, and that is precisely where this
  // stopped being true: `safeIdentity` percent-encoded, and `%` is not in core's id class either, so
  // escaping an illegal character minted another illegal one. An IFC GlobalId's alphabet is
  // `0-9A-Za-z_$`, so a single `$` — roughly one component in three — took down the happy path of two
  // public APIs documented as composing. Graded through the real `DocumentEngine`, not against a
  // copy of the id regex, so it stays honest if core's rule ever moves.
  it('mints component ids the document engine accepts', () => {
    const components = [
      '3O7J7yqQf3IReY$roof', // an ordinary IFC GlobalId: `$` is in its alphabet, not in core's
      '3O7J7yqQf3IReY_roof', // the same id one character apart, so a lossy escape would collide them
      '2xY$$Aq0X1kv7QwHmT9$b', // several offenders in one value
      'nörth wall / level 2', // foreign files put free text in `IfcGuid`; nothing forbids it
      'x'.repeat(200), // legal characters, but past core's 128-character id cap once prefixed
      'plain-legal.id', // already legal, and must survive verbatim
    ];
    const topic = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Components core would reject',
      comments: [],
      components,
      camera: {
        type: 'perspective' as const,
        position: { x: 0, y: 0, z: 5 },
        direction: { x: 0, y: 0, z: -1 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfView: 60,
        aspect: 1,
      },
    };
    const options = {
      componentToAnchor: (component: string) => ({
        kind: 'element' as const,
        elementId: component,
        fallbackPoint: { x: 0, y: 0, z: 0 },
      }),
    };
    const plan = planBcfApply([topic], options);
    expect(plan.annotations).toHaveLength(components.length);

    const engine = new DocumentEngine();
    for (const planned of plan.annotations) {
      expect(() => engine.create({
        id: planned.id,
        anchor: { kind: 'element', modelId: 'model', elementId: planned.anchor.elementId, fallbackPoint: planned.anchor.fallbackPoint },
        content: { kind: 'callout', text: planned.text },
      })).not.toThrow();
    }
    // One id per component: an escape that folded `$` and `_` onto the same character would drop the
    // second note as an already-planned duplicate instead of failing loudly.
    expect(new Set(plan.annotations.map(({ id }) => id)).size).toBe(components.length);
    // Deterministic, because `existingAnnotationIds` idempotency is nothing but string equality
    // between one import and the next.
    expect(planBcfApply([topic], options).annotations.map(({ id }) => id))
      .toEqual(plan.annotations.map(({ id }) => id));
    // The legal component keeps its readable id, so nothing that already worked moved.
    expect(plan.annotations.at(-1)?.id).toBe(`bcf-annotation:${topic.id}:plain-legal.id`);
  });

  it('rejects invalid embedded documents before producing any apply work', () => {
    const plan = planBcfApply([
      {
        id: 'bad',
        title: 'Bad',
        comments: [],
        components: [],
        embeddedDocument: { version: 99 },
      },
    ], {
      validateEmbeddedDocument: () => ({ valid: false, errors: ['version must be 1', 'annotations missing'] }),
    });
    expect(plan.created).toBe(0);
    expect(plan.errors).toEqual([
      'bad: version must be 1',
      'bad: annotations missing',
    ]);
  });
});

describe('M9 standalone sheet export', () => {
  function fixture(): { readonly dom: JSDOM; readonly overlay: SVGSVGElement } {
    const dom = new JSDOM('<!doctype html><body></body>');
    const document = dom.window.document;
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('width', '800');
    overlay.setAttribute('height', '500');
    overlay.innerHTML = [
      '<g data-annotation-id="a" data-selected="true">',
      '<path class="viewleader-route" d="M0 0 L20 20" data-dash-animation="1" style="animation: dash 1s"/>',
      '<path data-occluded-dash="true" d="M2 2 L4 4" stroke-dasharray="2 2"/>',
      '<g data-occlusion-faded="true" opacity="0.2"><text>Visible ink</text></g>',
      '<foreignObject data-embedded-html x="10" y="10"></foreignObject>',
      '<image data-markdown-image data-export-safe="true" data-export-source="data:image/png;base64,AA==" x="0" y="0" width="20" height="20"/>',
      '<image data-markdown-image data-export-safe="false" data-alt="screen" x="30" y="0" width="20" height="20"/>',
      '</g>',
      '<g hidden><text>Hidden</text></g>',
    ].join('');
    document.body.append(overlay);
    return { dom, overlay };
  }

  it('deep-clones, sanitizes, inlines/placeholders images, and preserves live DOM', () => {
    const { overlay } = fixture();
    const before = overlay.outerHTML;
    const sheet = exportVectorSheet(overlay, {
      paper: '#fff',
      underlayDataUrl: 'data:image/png;base64,AA==',
      titleBlock: { drawingNumber: 'A-101', scale: '1:100', date: '2026-07-19' },
    });
    expect(overlay.outerHTML).toBe(before);
    expect(sheet).toMatchObject({ width: 800, height: 500 });
    expect(sheet.svg).not.toContain('data-selected');
    expect(sheet.svg).not.toContain('data-dash-animation');
    expect(sheet.svg).not.toContain('Hidden');
    expect(sheet.svg).toContain('data-occluded-dash="true"');
    expect(sheet.svg).toContain('opacity="1"');
    expect(sheet.svg).toContain('[Embedded HTML omitted from sheet]');
    expect(sheet.svg).toContain('data:image/png;base64,AA==');
    expect(sheet.svg).toContain('data-export-placeholder="markdown-image"');
    expect(sheet.svg).toContain('data-title-block');
    // Paper first, then the drawing on top of it. Indexed on `<image>` rather than on
    // `preserveAspectRatio`, which now also appears on the root's content frame — and root
    // attributes serialize before any child.
    expect(sheet.svg.indexOf('fill="#fff"')).toBeLessThan(sheet.svg.indexOf('<image'));
  });

  // Graded through the real renderer rather than a hand-written fixture, because the bug was
  // precisely that the strip list in sheet.ts and the attributes render.ts emits had drifted apart.
  // A fixture written from the strip list can only ever agree with itself.
  it('strips the interface the renderer actually draws, and keeps the drawing', () => {
    const boundary = document.createElement('div');
    document.body.append(boundary);
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
    const leader = new ViewLeader({ boundary, adapters });
    leader.annotations.create({
      id: 'a',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      content: { kind: 'callout', text: 'Note' },
      placement: { kind: 'manual', position: { x: 380, y: 100 } },
    });
    leader.update();
    // Select, then render again. `runtime.select()` calls `overlay.setSelection` before
    // `#annotationGroups` holds the new annotation, so create-select-render leaves `aria-pressed`
    // set but never adds `viewleader-selected` — and the selected state would go ungraded.
    leader.annotations.select(['a']);
    leader.update();

    const overlay = leader.overlayElement;
    // The fixture is only worth anything if the live overlay has the chrome to begin with.
    expect(overlay.querySelector('[data-handle], [data-route-handles]')).not.toBeNull();
    expect(overlay.querySelector('.viewleader-selected')).not.toBeNull();

    const sheet = exportVectorSheet(overlay);
    const parsed = new DOMParser().parseFromString(sheet.svg, 'image/svg+xml');
    expect(parsed.querySelector(
      '[data-non-printing], [data-handle], [data-route-handles], [data-region-handles], .viewleader-selected',
    )).toBeNull();
    // The other half, and the trap: the label group *is* `data-hit-target="label"` and carries the
    // text. Widening any selector to a bare `[data-hit-target]` empties the drawing.
    expect(parsed.querySelector('text')?.textContent).toBe('Note');
    leader.dispose();
    boundary.remove();
  });

  it('fits the drawing into a differently-proportioned sheet without re-labelling its coordinates', () => {
    const { overlay } = fixture();
    const sheet = exportVectorSheet(overlay, {
      width: 1191,
      height: 842,
      paper: '#fff',
      underlayDataUrl: 'data:image/png;base64,AA==',
      titleBlock: { drawingNumber: 'A-101', scale: '1:100', date: '2026-07-19' },
    });
    expect(sheet).toMatchObject({ width: 1191, height: 842 });
    const parsed = new DOMParser().parseFromString(sheet.svg, 'image/svg+xml');
    // A sheet no XML parser will open is not an export. Spelling `xmlns` out by hand *and* letting
    // `XMLSerializer` write its own is a duplicate attribute, which is a hard error, not a warning.
    expect(parsed.querySelector('parsererror')).toBeNull();
    const frame = parsed.documentElement.querySelector('svg')!;
    // Content space: the children were laid out in the overlay's 800×500 and keep those numbers.
    expect(frame.getAttribute('viewBox')).toBe('0 0 800 500');
    expect(frame.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(frame.getAttribute('width')).toBe('1191');
    const underlay = frame.firstElementChild!;
    expect(underlay.tagName).toBe('image');
    expect(underlay.getAttribute('width')).toBe('800');
    expect(underlay.getAttribute('height')).toBe('500');
    expect(underlay.getAttribute('preserveAspectRatio')).toBe('none');
    // Sheet space, and the assertion that fails the moment the two spaces are collapsed into one:
    // the paper fills the paper, and the title block keeps its authored 12px at a sheet-space y.
    expect(sheet.svg).toMatch(/<rect[^>]*width="1191"[^>]*height="842"[^>]*fill="#fff"/u);
    expect(sheet.svg).toMatch(/y="774"[^>]*font-size="12"/u);
  });

  it('fails clearly before a frame and directs unsupported raster users to vector export', async () => {
    const { dom } = fixture();
    const empty = dom.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    expect(() => exportVectorSheet(empty)).toThrow('before ViewLeader has rendered');
    await expect(
      rasterizeVectorSheet({ svg: '<svg/>', width: 100, height: 50 }),
    ).rejects.toThrow('use vector sheet export instead');
  });
});
