/** @vitest-environment jsdom */
/**
 * Phase 1.3. `normalizeDocument` used to hard-reject any `version !== 1`, so there was no way to
 * change the schema without making every saved file unopenable. `locked` is the first field that
 * needed the seam, so the seam and the field land together — and the migration is proven by one
 * that actually runs, rather than by a mechanism nobody has walked through.
 */
import { describe, expect, it } from 'vitest';
import {
  CURRENT_DOCUMENT_VERSION,
  ViewLeader,
  type HostAdapterBundle,
  type ViewLeaderDocument,
} from 'viewleader';

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function adapters(): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
      project: (point) => ({ point: { x: 400 + point.x * 10, y: 300 - point.y * 10 }, depth: point.z, visible: true }),
      getRevision: () => 1,
    },
  };
}

/**
 * A document exactly as a build before the seam would have written it. Held as a plain object and
 * fed in as JSON, which is both what a saved file actually is and the only way to express a shape
 * the current `ViewLeaderDocument` type no longer describes.
 */
const V1_DOCUMENT = {
  schema: 'viewleader.document',
  version: 1,
  annotations: [{
    id: 'legacy-note',
    anchors: [{
      id: 'leg-1',
      anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 3 } },
      routing: { kind: 'automatic', mode: 'dogleg' },
    }],
    content: { kind: 'plain-note', text: 'SUPPLY AIR' },
    placement: { kind: 'automatic' },
    metadata: {},
  }],
  metadata: {},
  pluginEnvelopes: [],
  definitions: { styles: [], enclosures: [], terminators: [], templates: [] },
  savedViews: [],
  tours: [],
  ink: [],
};

describe('the document schema has a migration seam', () => {
  it('loads a v1 document and hands back the current version', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters(), initialDocument: JSON.stringify(V1_DOCUMENT) });
    const loaded = leader.documents.parse(leader.documents.serialize());
    expect(loaded.version).toBe(CURRENT_DOCUMENT_VERSION);
    expect(CURRENT_DOCUMENT_VERSION).toBeGreaterThan(1);
    // The migration is a version stamp, not a rewrite: everything the v1 file said is still true.
    expect(loaded.annotations).toHaveLength(1);
    expect(loaded.annotations[0]).toMatchObject({ id: 'legacy-note', content: { kind: 'plain-note', text: 'SUPPLY AIR' } });
    expect(loaded.annotations[0]!.locked).toBeUndefined();
    leader.dispose();
  });

  it('refuses a document from a newer build rather than guessing at its shape', () => {
    // Unknown *fields* are preserved (see Annotation.unknownFields); an unknown *version* says the
    // shape itself changed, and opening it anyway is how a save quietly drops what it did not read.
    expect(() => new ViewLeader({
      boundary: boundary(),
      adapters: adapters(),
      initialDocument: JSON.stringify({ ...V1_DOCUMENT, version: CURRENT_DOCUMENT_VERSION + 1 }),
    })).toThrow(/newer version/u);
  });

  it('refuses a nonsense version', () => {
    for (const version of [0, -1, 1.5, '2', null]) {
      expect(() => new ViewLeader({
        boundary: boundary(),
        adapters: adapters(),
        initialDocument: JSON.stringify({ ...V1_DOCUMENT, version }),
      })).toThrow();
    }
  });

  it('still refuses a foreign schema', () => {
    expect(() => new ViewLeader({
      boundary: boundary(),
      adapters: adapters(),
      initialDocument: JSON.stringify({ ...V1_DOCUMENT, schema: 'something.else' }),
    })).toThrow(/schema/u);
  });
});

describe('locked is real, persisted annotation state', () => {
  function withNote(locked?: boolean): ViewLeader {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    leader.annotations.create({
      id: 'note',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      content: { kind: 'plain-note', text: 'FD-2' },
      ...(locked === undefined ? {} : { locked }),
    });
    return leader;
  }

  it('is settable at creation and survives a save/reopen round trip', () => {
    const leader = withNote(true);
    const savedJson = leader.documents.serialize();
    const saved: ViewLeaderDocument = leader.documents.parse(savedJson);
    expect(saved.annotations[0]!.locked).toBe(true);
    leader.dispose();

    const reopened = new ViewLeader({ boundary: boundary(), adapters: adapters(), initialDocument: saved });
    expect(reopened.annotations.get('note')!.locked).toBe(true);
    // Identical in, identical out — the round trip is a fixed point, not merely lossless once.
    expect(reopened.documents.parse(reopened.documents.serialize())).toEqual(saved);
    reopened.dispose();
  });

  it('is settable and clearable through a patch', () => {
    const leader = withNote();
    expect(leader.annotations.get('note')!.locked).toBeUndefined();
    leader.annotations.update('note', { locked: true });
    expect(leader.annotations.get('note')!.locked).toBe(true);
    leader.annotations.update('note', { locked: null });
    expect(leader.annotations.get('note')!.locked).toBeUndefined();
    leader.dispose();
  });

  it('does not store `false` — absent already means unlocked', () => {
    const leader = withNote(false);
    // Two documents that mean the same thing must serialize the same way, or every equality
    // check downstream (round-trip tests, dirty tracking, diffing) has to know about both spellings.
    expect(leader.documents.parse(leader.documents.serialize()).annotations[0]!.locked).toBeUndefined();
    leader.dispose();
  });

  const withBadLocked = JSON.stringify({
    ...V1_DOCUMENT,
    annotations: [{ ...V1_DOCUMENT.annotations[0]!, locked: 'yes' }],
  });

  /**
   * Loading is deliberately lenient — `documents.parse` and `initialDocument` share one path, and
   * one bad annotation must not make an otherwise-fine file unopenable. So a non-boolean `locked`
   * is a reported diagnostic, not a throw, and the annotation does not render.
   *
   * It is also, today, deleted by the next `serialize()`. That is the pre-existing silent-data-loss
   * defect the goal schedules as 5.2 — `locked` inherits it rather than introducing it, and this
   * test records the current behaviour so 5.2 has something to change.
   */
  it('reports a non-boolean rather than rendering it, and does not throw', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    expect(() => leader.documents.parse(withBadLocked)).not.toThrow();
    const reported = leader.diagnostics.getSnapshot().map((diagnostic) => diagnostic.message).join(' ');
    expect(reported).toMatch(/legacy-note/u);
    expect(reported).toMatch(/locked/u);
    expect(leader.annotations.get('legacy-note')).toBeUndefined();
    leader.dispose();
  });
});
