import { crc32, deflateRawSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  escapeXml,
  exportBcf,
  parseBcf,
  parseXmlGuarded,
  readArchive,
  stableBcfGuid,
  writeStoredArchive,
  type BcfExportDocument,
  type XmlParserFactory,
} from '../src/interchange/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function xmlParser(): XmlParserFactory {
  const Parser = new JSDOM().window.DOMParser;
  return (xml) => new Parser().parseFromString(xml, 'application/xml') as unknown as ReturnType<XmlParserFactory>;
}

describe('M9 XML and archive micro-layer', () => {
  it('escapes hostile XML text deterministically', () => {
    expect(escapeXml(`<tag a="b">Tom & 'Ada'</tag>`)).toBe(
      '&lt;tag a=&quot;b&quot;&gt;Tom &amp; &apos;Ada&apos;&lt;/tag&gt;',
    );
  });

  it('guards parser absence/malformed input and returns parsed XML through an injected seam', () => {
    const missing = parseXmlGuarded('<root/>', () => { throw new Error('XML parser unavailable'); });
    expect(missing).toEqual({ valid: false, errors: ['XML parser unavailable'] });
    expect(parseXmlGuarded('<root>', xmlParser())).toMatchObject({ valid: false });
    expect(parseXmlGuarded('<root><value>ok</value></root>', xmlParser())).toMatchObject({
      valid: true,
    });
  });

  it('writes deterministic standards-shaped stored archives and reads them back', async () => {
    const entries = [
      { name: 'a.txt', data: encoder.encode('alpha') },
      { name: 'nested/b.txt', data: encoder.encode('beta') },
    ];
    const first = writeStoredArchive(entries);
    const second = writeStoredArchive(entries);
    expect(second).toEqual(first);
    expect(new DataView(first.buffer).getUint32(0, true)).toBe(0x04034b50);
    const result = await readArchive(first);
    expect(result.valid).toBe(true);
    expect(result.entries.map((entry) => [entry.name, decoder.decode(entry.data)])).toEqual([
      ['a.txt', 'alpha'],
      ['nested/b.txt', 'beta'],
    ]);
  });

  it('rejects unsafe names, entry limits, total limits, expansion lies and CRC corruption', async () => {
    expect(() => writeStoredArchive([{ name: '../escape', data: new Uint8Array() }])).toThrow(
      'Unsafe archive entry name',
    );
    const archive = writeStoredArchive([
      { name: 'a', data: encoder.encode('1234') },
      { name: 'b', data: encoder.encode('5678') },
    ]);
    expect(await readArchive(archive, { maximumEntries: 1 })).toMatchObject({
      valid: false,
      errors: ['Archive entry-count limit exceeded'],
    });
    expect(await readArchive(archive, { maximumTotalBytes: 7 })).toMatchObject({ valid: false });

    const corrupt = archive.slice();
    corrupt[31] = (corrupt[31] ?? 0) ^ 0xff;
    expect(await readArchive(corrupt)).toMatchObject({ valid: false });
  });

  it('inflates a deflate entry through the platform decompressor', async () => {
    // The writer only stores, so a deflate entry is a stored one with its headers rewritten to
    // what a compressing writer would have put there: method 8, and the CRC and size of the
    // original bytes rather than the compressed ones.
    const original = encoder.encode(Array.from({ length: 200 }, (_, index) => `entry-${index}`).join('\n'));
    const compressed = deflateRawSync(original);
    const patched = writeStoredArchive([{ name: 'a', data: compressed }]).slice();
    const view = new DataView(patched.buffer);
    let central = 0;
    for (let offset = 0; offset <= patched.length - 4; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        central = offset;
        break;
      }
    }
    for (const [method, crc, size] of [[8, 14, 22], [central + 10, central + 16, central + 24]]) {
      view.setUint16(method!, 8, true);
      view.setUint32(crc!, crc32(original), true);
      view.setUint32(size!, original.length, true);
    }
    const result = await readArchive(patched);
    expect(result).toMatchObject({ valid: true, errors: [] });
    expect(decoder.decode(result.entries[0]?.data)).toBe(decoder.decode(original));
  });
});

describe('M9 BCF writer and tolerant reader', () => {
  const document: BcfExportDocument = {
    views: [
      {
        id: 'review-east',
        name: 'East coordination',
        camera: {
          type: 'perspective',
          position: { x: 1, y: 2, z: 3 },
          direction: { x: 0, y: 0, z: -1 },
          up: { x: 0, y: 1, z: 0 },
          fieldOfView: 55,
          aspect: 1.6,
        },
        annotationIds: ['a', 'empty'],
      },
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Plan',
        camera: {
          type: 'orthographic',
          position: { x: 0, y: 10, z: 0 },
          direction: { x: 0, y: -1, z: 0 },
          up: { x: 0, y: 0, z: -1 },
          viewToWorldScale: 40,
          aspect: 2,
        },
        annotationIds: [],
      },
    ],
    annotations: [
      { id: 'a', text: '# Clash\n\n**Move** duct', elementIds: ['duct-1', 'duct-1'] },
      { id: 'empty', text: '' },
    ],
    embeddedDocument: { version: 1, annotations: [{ id: 'a' }] },
  };

  afterEach(() => vi.useRealTimers());

  it('uses stable valid topic ids', () => {
    expect(stableBcfGuid('review-east')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(stableBcfGuid('review-east')).toBe(stableBcfGuid('review-east'));
    expect(stableBcfGuid('123e4567-e89b-12d3-a456-426614174000')).toBe(
      '123e4567-e89b-12d3-a456-426614174000',
    );
  });

  it('exports deterministic topic/viewpoint/comment/component/snapshot/document entries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    const options = {
      author: 'reviewer@example.test',
      includeDocument: true,
      zUpToYUp: true,
      snapshot: (viewId: string) => viewId === 'review-east' ? encoder.encode('PNG') : undefined,
      elementToIfcGuid: (id: string) => id === 'duct-1' ? 'IFC-DUCT-GUID' : undefined,
    };
    const first = exportBcf(document, options);
    expect(exportBcf(document, options)).toEqual(first);

    const archive = await readArchive(first);
    expect(archive.valid).toBe(true);
    const markup = archive.entries.find((entry) => entry.name.endsWith('/markup.bcf'));
    const viewpoint = archive.entries.find((entry) => entry.name.endsWith('/viewpoint.bcfv'));
    expect(decoder.decode(markup?.data)).toContain('<Comment>Clash\nMove duct</Comment>');
    expect(decoder.decode(markup?.data).match(/<Comment Guid=/g)).toHaveLength(1);
    // The axis convention, not the identity. Export and import are exact inverses, so a round trip
    // passes just as happily with the formulas swapped onto the wrong sides — which is how they
    // shipped, and nothing inside this repo noticed because the reader undid it again. Only the
    // bytes a receiving application opens say which side is which: a BCF file is IFC's Z-up, so
    // this document's Y-up `(0, 1, 0)` has to leave as `(0, 0, 1)`. Written as `-1` on Z, the file
    // opens rotated 180° about X in Solibri or Navisworks. With export pinned here and the parse
    // below equal to the original, import is pinned as its inverse.
    expect(decoder.decode(viewpoint?.data)).toContain(
      '<CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector>',
    );
    // Non-symmetric, because (0, 1, 0) alone cannot see a sign error on x or z.
    expect(decoder.decode(viewpoint?.data)).toContain(
      '<CameraViewPoint><X>1</X><Y>-3</Y><Z>2</Z></CameraViewPoint>',
    );
    expect(decoder.decode(viewpoint?.data)).toContain('<Visibility DefaultVisibility="true"/>');
    expect(decoder.decode(viewpoint?.data)).toContain('IfcGuid="IFC-DUCT-GUID"');
    expect(archive.entries.some((entry) => entry.name.endsWith('/snapshot.png'))).toBe(true);
    expect(archive.entries.some((entry) => entry.name.endsWith('/viewleader.json'))).toBe(true);

    const parsed = await parseBcf(first, { xmlParser: xmlParser(), zUpToYUp: true });
    expect(parsed.version).toBe('2.1');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.topics).toHaveLength(2);
    const east = parsed.topics.find((topic) => topic.title === 'East coordination');
    expect(east?.camera).toEqual(document.views[0]?.camera);
    expect(east?.components).toEqual(['IFC-DUCT-GUID']);
    expect(east?.comments.map((comment) => comment.text)).toEqual(['Clash\nMove duct']);
    expect(decoder.decode(east?.snapshot)).toBe('PNG');
    expect(east?.embeddedDocument).toEqual(document.embeddedDocument);
    const plan = parsed.topics.find((topic) => topic.title === 'Plan');
    expect(plan?.camera).toEqual(document.views[1]?.camera);
  });

  it('returns bounded warnings rather than throwing on malformed archives/XML', async () => {
    await expect(parseBcf(new Uint8Array([1, 2, 3]), { xmlParser: xmlParser() })).resolves.toMatchObject({
      topics: [],
      warnings: [expect.stringContaining('Archive end record')],
    });
    const malformed = writeStoredArchive([
      { name: 'bcf.version', data: encoder.encode('<Version') },
      { name: `${stableBcfGuid('bad')}/markup.bcf`, data: encoder.encode('<Markup') },
    ]);
    const result = await parseBcf(malformed, { xmlParser: xmlParser() });
    expect(result.topics).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
