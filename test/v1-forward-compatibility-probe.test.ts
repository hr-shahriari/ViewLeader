/** @vitest-environment jsdom */
import { expect, it } from 'vitest';
import { ViewLeader, type HostAdapterBundle } from '../src/index.js';

const adapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
    project: (p) => ({ point: { x: 400 + p.x * 10, y: 300 - p.y * 10 }, depth: p.z, visible: true }),
  },
};

/**
 * Opens a document carrying one unknown field, edits an unrelated annotation, saves, and reports
 * whether the field came back. `read` pulls the field out of a serialized document, so the check is
 * on the field itself rather than on whole-document text — serialization is canonically ordered and
 * the input is not, which would make a raw string compare fail for the wrong reason.
 */
function probe(
  mutate: (doc: Record<string, unknown>) => void,
  read: (doc: Record<string, unknown>) => unknown,
): string {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const vl = new ViewLeader({ boundary: root, adapters });
  vl.annotations.create({
    id: 'a1',
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'plain-note', text: 'Note' },
  });
  const doc = JSON.parse(vl.documents.serialize()) as Record<string, unknown>;
  mutate(doc);
  const expected = JSON.stringify(read(doc));
  try {
    vl.documents.replace(doc as never);
    vl.annotations.move('a1', { x: 321, y: 123 });
    const after = JSON.parse(vl.documents.serialize()) as Record<string, unknown>;
    return JSON.stringify(read(after)) === expected
      ? 'opens + preserves'
      : `OPENS BUT LOST IT (got ${JSON.stringify(read(after))}, wanted ${expected})`;
  } catch (error) {
    const detail = JSON.stringify((error as { details?: unknown }).details ?? {});
    return `REFUSED: ${(error as Error).message} ${detail}`;
  } finally {
    vl.dispose();
  }
}

it('probe: a newer document keeps what this version does not understand', () => {
  const results = {
    topLevel: probe(
      (doc) => { doc.layers = [{ id: 'l1', name: 'Grid' }]; },
      (doc) => doc.layers,
    ),
    annotation: probe(
      (doc) => { (doc.annotations as Record<string, unknown>[])[0]!.layerId = 'l1'; },
      (doc) => (doc.annotations as Record<string, unknown>[])[0]!.layerId,
    ),
    ink: probe(
      (doc) => {
        doc.ink = [{
          kind: 'ink', id: 'i1',
          plane: {
            origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
          },
          points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], metadata: {}, pressure: 0.5,
        }];
      },
      (doc) => (doc.ink as Record<string, unknown>[])[0]?.pressure,
    ),
    definition: probe(
      (doc) => {
        (doc.definitions as Record<string, unknown[]>).styles = [{
          kind: 'style', id: 'custom.style.x', name: 'X',
          lineColor: '#000000', lineWidth: 1, textColor: '#000000',
          fontFamily: 'sans-serif', fontSize: 14,
          terminatorId: 'builtin.terminator.arrow', glowRadius: 3,
        }];
      },
      (doc) => (doc.definitions as Record<string, Record<string, unknown>[]>).styles?.[0]?.glowRadius,
    ),
  };
  console.log('WALL PROBE:', JSON.stringify(results, null, 2));
  for (const [door, result] of Object.entries(results)) {
    expect(result, door).toBe('opens + preserves');
  }
});
