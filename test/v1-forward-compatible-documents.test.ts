/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  CURRENT_DOCUMENT_VERSION,
  InvalidDocumentError,
  ViewLeader,
  type HostAdapterBundle,
} from '../src/index.js';

function leader(): ViewLeader {
  const boundary = document.createElement('div');
  document.body.appendChild(boundary);
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
  return new ViewLeader({ boundary, adapters });
}

/** A leg this version fully understands, with one field per level that it does not. */
function futureLeg(): Record<string, unknown> {
  return {
    id: 'leg-1',
    anchor: {
      kind: 'world-point',
      point: { x: 1, y: 2, z: 3, w: 4 },
      snapTo: 'centroid',
    },
    routing: { kind: 'automatic', mode: 'straight', smoothing: 0.5 },
    locked: true,
  };
}

function futureAnnotation(id: string): Record<string, unknown> {
  return {
    id,
    anchors: [futureLeg()],
    content: { kind: 'plain-note', text: id, fontWeight: 700 },
    placement: { kind: 'automatic' },
    metadata: {},
    layerId: 'layer-1',
  };
}

/** What a colleague on a newer version sends: valid everywhere this version can see. */
function futureDocument(): Record<string, unknown> {
  return {
    schema: 'viewleader.document',
    version: 1,
    annotations: [futureAnnotation('alpha'), futureAnnotation('beta')],
    metadata: {},
    pluginEnvelopes: [
      { pluginId: 'acme', recordType: 'notes', schemaVersion: 1, data: {}, signature: 'sig-1' },
    ],
    definitions: {
      styles: [],
      templates: [],
      terminators: [],
      enclosures: [],
      hatchPatterns: [{ id: 'crosshatch' }],
    },
    savedViews: [],
    tours: [],
    ink: [],
    layers: [{ id: 'layer-1', name: 'Future layer' }],
  };
}

function plainAnnotation(id: string): Record<string, unknown> {
  return {
    id,
    anchors: [{
      id: 'leg-1',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      routing: { kind: 'automatic', mode: 'straight' },
    }],
    content: { kind: 'plain-note', text: id },
    placement: { kind: 'automatic' },
    metadata: {},
  };
}

function plainDocument(annotations: readonly unknown[]): Record<string, unknown> {
  return {
    schema: 'viewleader.document',
    version: 1,
    annotations,
    metadata: {},
    pluginEnvelopes: [],
    definitions: { styles: [], templates: [], terminators: [], enclosures: [] },
    savedViews: [],
    tours: [],
    ink: [],
  };
}

describe('a newer version wrote this file', () => {
  it('opens a document carrying fields this version does not know, at every level', () => {
    const view = leader();
    const loaded = view.documents.replace(futureDocument() as never);

    expect(loaded.annotations.map(({ id }) => id)).toEqual(['alpha', 'beta']);
    expect(loaded.unknownFields).toMatchObject({ layers: [{ id: 'layer-1', name: 'Future layer' }] });
    expect(loaded.annotations[0]?.unknownFields).toEqual({
      layerId: 'layer-1',
      anchors: { 0: { locked: true, anchor: { snapTo: 'centroid', point: { w: 4 } }, routing: { smoothing: 0.5 } } },
      content: { fontWeight: 700 },
    });
    view.dispose();
  });

  it('leaves every unknown field byte-identical after loading, editing one annotation, and saving', () => {
    const view = leader();
    view.documents.replace(futureDocument() as never);
    const original = view.documents.serialize();

    // A pure round trip changes nothing at all.
    view.documents.replace(original);
    expect(view.documents.serialize()).toBe(original);

    // The scenario the whole ticket is about: they move one label and save.
    view.annotations.move('alpha', { x: 12, y: 34 });
    const saved = view.documents.serialize();
    expect(saved).not.toBe(original);

    const before = JSON.parse(original) as { annotations: unknown[] };
    const after = JSON.parse(saved) as { annotations: unknown[] };
    // The annotation nobody touched is byte-for-byte what arrived.
    expect(JSON.stringify(after.annotations[1])).toBe(JSON.stringify(before.annotations[1]));
    // So is everything outside the annotations array.
    expect(JSON.stringify({ ...after, annotations: [] }))
      .toBe(JSON.stringify({ ...before, annotations: [] }));
    // And the edited one kept everything except the value the edit replaced.
    expect(after.annotations[0]).toMatchObject({
      layerId: 'layer-1',
      content: { fontWeight: 700 },
      anchors: [{ locked: true, anchor: { snapTo: 'centroid' }, routing: { smoothing: 0.5 } }],
      placement: { kind: 'manual', position: { x: 12, y: 34 } },
    });
    view.dispose();
  });

  it('does not carry preserved data forward onto a value the author just replaced', () => {
    const view = leader();
    view.documents.replace(futureDocument() as never);
    view.annotations.update('alpha', { content: { kind: 'plain-note', text: 'rewritten' } });

    const alpha = view.annotations.get('alpha');
    expect(alpha?.content).toEqual({ kind: 'plain-note', text: 'rewritten' });
    expect(alpha?.unknownFields).not.toHaveProperty('content');
    // Only what the patch replaced is forgotten; the rest still rides along.
    expect(alpha?.unknownFields).toMatchObject({ layerId: 'layer-1' });
    view.dispose();
  });

  it('quarantines an annotation whose kind it has never heard of, and does not render it', () => {
    const view = leader();
    const future = {
      ...plainAnnotation('zeta'),
      content: { kind: 'holographic-note', hologram: { source: 'scan-7' } },
    };
    view.documents.replace(plainDocument([plainAnnotation('alpha'), future]) as never);

    expect(view.annotations.getSnapshot().annotations.map(({ id }) => id)).toEqual(['alpha']);
    expect(view.annotations.get('zeta')).toBeUndefined();
    view.update();
    expect(view.geometry.of('zeta')).toBeUndefined();
    expect(view.diagnostics.getSnapshot()).toContainEqual(expect.objectContaining({
      code: 'document.annotation-quarantined',
      annotationId: 'zeta',
    }));

    const saved = view.documents.serialize();
    const annotations = (JSON.parse(saved) as { annotations: Array<{ id: string }> }).annotations;
    expect(annotations.map(({ id }) => id)).toEqual(['alpha', 'zeta']);
    expect(annotations[1]).toMatchObject({
      content: { kind: 'holographic-note', hologram: { source: 'scan-7' } },
    });
    // And a second trip through the loader leaves it exactly where it was.
    view.documents.replace(saved);
    expect(view.documents.serialize()).toBe(saved);
    view.dispose();
  });
});

describe('unrecognised means future, invalid means broken', () => {
  it('skips one invalid annotation, loads the rest, and reports the id and the reason', () => {
    const view = leader();
    const broken = plainAnnotation('broken');
    broken.content = { kind: 'plain-note', text: 'broken', maxWidth: -5 };
    view.documents.replace(plainDocument([plainAnnotation('alpha'), broken]) as never);

    expect(view.annotations.getSnapshot().annotations.map(({ id }) => id)).toEqual(['alpha']);
    const skipped = view.diagnostics.getSnapshot()
      .find(({ code }) => code === 'document.annotation-skipped');
    expect(skipped).toMatchObject({ severity: 'warning', annotationId: 'broken' });
    expect(skipped?.message).toMatch(/maxWidth/u);
    view.dispose();
  });

  it('drops the invalid one for good where it preserves the unrecognised one', () => {
    const view = leader();
    const broken = plainAnnotation('broken');
    broken.content = { kind: 'plain-note', text: 'broken', maxWidth: -5 };
    const future = {
      ...plainAnnotation('future'),
      content: { kind: 'holographic-note', hologram: 'scan-7' },
    };
    view.documents.replace(plainDocument([broken, future]) as never);

    const saved = JSON.parse(view.documents.serialize()) as { annotations: Array<{ id: string }> };
    expect(saved.annotations.map(({ id }) => id)).toEqual(['future']);
    expect(view.diagnostics.getSnapshot().map(({ code }) => code)).toEqual(expect.arrayContaining([
      'document.annotation-skipped',
      'document.annotation-quarantined',
    ]));
    view.dispose();
  });

  it('still refuses a negative width from an author, where a saved one is only skipped', () => {
    const view = leader();
    expect(() => view.annotations.create({
      id: 'authored',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      content: { kind: 'plain-note', text: 'authored', maxWidth: -5 },
    })).toThrow(InvalidDocumentError);
    // The same rule for a kind: lenient on load, still a hard failure where a developer writes it.
    expect(() => view.annotations.create({
      id: 'authored',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      content: { kind: 'holographic-note', text: 'authored' } as never,
    })).toThrow(InvalidDocumentError);
    expect(view.annotations.getSnapshot().annotations).toEqual([]);
    view.dispose();
  });

  // The id rule is the persisted-format contract, so both ends have to agree: what an author is
  // refused is exactly what the saved file could not have held, and what the file holds is what an
  // author could have written. `'9lives...'` pins the leading digit on purpose -- `definitions.ts`
  // uses a stricter rule that demands a leading letter, so a future "unify the id validators"
  // refactor fails here instead of silently breaking hosts whose ids start with a digit.
  it('refuses an id the saved format cannot hold, and keeps every character it can', () => {
    const view = leader();
    for (const id of ['AHU #3', '_internal', 'chiller/primary', 'pompe-à-eau', 'x'.repeat(129)]) {
      expect(() => view.annotations.create({
        id,
        anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
        content: { kind: 'plain-note', text: 'authored' },
      })).toThrow(InvalidDocumentError);
    }
    expect(view.annotations.getSnapshot().annotations).toEqual([]);

    view.documents.replace(plainDocument([plainAnnotation('9lives.a_b:c-d')]) as never);
    const saved = JSON.parse(view.documents.serialize()) as { annotations: Array<{ id: string }> };
    expect(saved.annotations.map(({ id }) => id)).toEqual(['9lives.a_b:c-d']);
    view.dispose();
  });
});

describe('tier one is unchanged', () => {
  it('still refuses anything that is not this document', () => {
    const view = leader();
    for (const broken of [
      '{ not json',
      JSON.stringify({ ...plainDocument([]), schema: 'other.document' }),
      // Was `version: 2`, which is now the version this build writes. The assertion's intent is
      // unchanged -- a schema version this build has never heard of is refused, because the shape
      // itself changed and guessing at it is how a save drops what it did not read. Only the number
      // moved, and it now tracks CURRENT_DOCUMENT_VERSION so it cannot go stale again.
      JSON.stringify({ ...plainDocument([]), version: CURRENT_DOCUMENT_VERSION + 1 }),
      JSON.stringify({ ...plainDocument([]), version: 0 }),
      JSON.stringify({ ...plainDocument([]), annotations: 'none' }),
    ]) {
      expect(() => view.documents.replace(broken)).toThrow(InvalidDocumentError);
    }
    expect(view.documents.getSnapshot().document.annotations).toEqual([]);
    view.dispose();
  });

  it('round-trips a document with nothing unknown in it exactly as before', () => {
    const view = leader();
    view.documents.replace(plainDocument([plainAnnotation('alpha'), plainAnnotation('beta')]) as never);
    const saved = view.documents.serialize();

    expect(JSON.parse(saved)).not.toHaveProperty('unknownFields');
    expect(JSON.parse(saved)).not.toHaveProperty('quarantined');
    expect(view.documents.getSnapshot().document.annotations[0]).not.toHaveProperty('unknownFields');
    view.documents.replace(saved);
    expect(view.documents.serialize()).toBe(saved);
    expect(view.diagnostics.getSnapshot()).toEqual([]);
    view.dispose();
  });
});
