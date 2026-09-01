// A .bcfzip is a ZIP file, so reading and writing one means reading and writing ZIP entries.
//
// Only what the format actually needs is implemented. Deflate is the platform's
// `DecompressionStream`, because it already has one and a second copy is dead weight.
import {
  DEFAULT_ARCHIVE_LIMITS,
  type ArchiveEntry,
  type ArchiveLimits,
  type ArchiveReadResult,
} from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function write32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function localHeader(name: Uint8Array, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(30 + name.length);
  const view = new DataView(result.buffer);
  write32(view, 0, LOCAL_SIGNATURE);
  write16(view, 4, 20);
  write16(view, 6, 0x0800);
  write16(view, 8, 0);
  write16(view, 10, 0);
  write16(view, 12, 0);
  write32(view, 14, crc32(data));
  write32(view, 18, data.length);
  write32(view, 22, data.length);
  write16(view, 26, name.length);
  write16(view, 28, 0);
  result.set(name, 30);
  return result;
}

function centralHeader(name: Uint8Array, data: Uint8Array, offset: number): Uint8Array {
  const result = new Uint8Array(46 + name.length);
  const view = new DataView(result.buffer);
  write32(view, 0, CENTRAL_SIGNATURE);
  write16(view, 4, 20);
  write16(view, 6, 20);
  write16(view, 8, 0x0800);
  write16(view, 10, 0);
  write16(view, 12, 0);
  write16(view, 14, 0);
  write32(view, 16, crc32(data));
  write32(view, 20, data.length);
  write32(view, 24, data.length);
  write16(view, 28, name.length);
  write16(view, 30, 0);
  write16(view, 32, 0);
  write16(view, 34, 0);
  write16(view, 36, 0);
  write32(view, 38, 0);
  write32(view, 42, offset);
  result.set(name, 46);
  return result;
}

/**
 * Writes a ZIP file. The same input always produces byte-identical output, so exporting the same
 * drawing twice gives two files that compare equal.
 *
 * Entries are stored uncompressed, which needs no compressor and costs only file size — BCF files
 * are small.
 */
export function writeStoredArchive(entries: readonly ArchiveEntry[]): Uint8Array {
  const names = new Set<string>();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    if (!entry.name || entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.includes('..')) {
      throw new TypeError(`Unsafe archive entry name: ${entry.name}`);
    }
    if (names.has(entry.name)) throw new TypeError(`Duplicate archive entry: ${entry.name}`);
    names.add(entry.name);
    const name = encoder.encode(entry.name);
    const header = localHeader(name, entry.data);
    local.push(header, entry.data);
    central.push(centralHeader(name, entry.data, localOffset));
    localOffset += header.length + entry.data.length;
  }
  const centralBytes = concat(central);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  write32(view, 0, END_SIGNATURE);
  write16(view, 4, 0);
  write16(view, 6, 0);
  write16(view, 8, entries.length);
  write16(view, 10, entries.length);
  write32(view, 12, centralBytes.length);
  write32(view, 16, localOffset);
  write16(view, 20, 0);
  return concat([...local, centralBytes, end]);
}

function normalizeLimits(partial?: Partial<ArchiveLimits>): ArchiveLimits {
  const normalize = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) && (value ?? 0) >= 0 ? Math.floor(value ?? fallback) : fallback;
  return {
    maximumEntries: normalize(partial?.maximumEntries, DEFAULT_ARCHIVE_LIMITS.maximumEntries),
    maximumTotalBytes: normalize(partial?.maximumTotalBytes, DEFAULT_ARCHIVE_LIMITS.maximumTotalBytes),
    maximumEntryBytes: normalize(partial?.maximumEntryBytes, DEFAULT_ARCHIVE_LIMITS.maximumEntryBytes),
    maximumExpansionRatio: normalize(
      partial?.maximumExpansionRatio,
      DEFAULT_ARCHIVE_LIMITS.maximumExpansionRatio,
    ),
  };
}

function findEnd(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const minimum = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === END_SIGNATURE) return offset;
  }
  return -1;
}

interface CentralEntry {
  readonly name: string;
  readonly compression: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

/**
 * Inflates one deflate entry, stopping as soon as the output passes `maximumBytes`. The directory
 * record's size was already checked against the limits, so this only ever fires for an entry that
 * lied about it — which is exactly the entry that must not be allowed to keep going.
 */
async function inflateRaw(compressed: Uint8Array<ArrayBuffer>, maximumBytes: number): Promise<Uint8Array> {
  const reader = new Blob([compressed]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concat(chunks);
    size += value.length;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error('Archive entry inflates past the per-entry limit');
    }
    chunks.push(value);
  }
}

/** Reads a ZIP file: stored entries as they are, deflate entries through the platform. */
export async function readArchive(
  input: Uint8Array,
  configuredLimits?: Partial<ArchiveLimits>,
): Promise<ArchiveReadResult> {
  const errors: string[] = [];
  const entries: ArchiveEntry[] = [];
  try {
    const limits = normalizeLimits(configuredLimits);
    const endOffset = findEnd(input);
    if (endOffset < 0) return { valid: false, entries: [], errors: ['Archive end record not found'] };
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const count = view.getUint16(endOffset + 10, true);
    const centralSize = view.getUint32(endOffset + 12, true);
    const centralOffset = view.getUint32(endOffset + 16, true);
    if (count > limits.maximumEntries) {
      return { valid: false, entries: [], errors: ['Archive entry-count limit exceeded'] };
    }
    if (centralOffset + centralSize > input.length) {
      return { valid: false, entries: [], errors: ['Archive central directory is truncated'] };
    }
    const central: CentralEntry[] = [];
    let cursor = centralOffset;
    let advertisedTotal = 0;
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > input.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
        errors.push(`Archive central entry ${index} is malformed`);
        break;
      }
      const compression = view.getUint16(cursor + 10, true);
      const crc = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      if (cursor + 46 + nameLength + extraLength + commentLength > input.length) {
        errors.push(`Archive central entry ${index} is truncated`);
        break;
      }
      const name = decoder.decode(input.subarray(cursor + 46, cursor + 46 + nameLength));
      if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) {
        errors.push(`Archive entry ${index} has an unsafe name`);
      }
      if (uncompressedSize > limits.maximumEntryBytes) {
        errors.push(`Archive entry ${name} exceeds the per-entry limit`);
      }
      const ratio = compressedSize === 0
        ? uncompressedSize === 0 ? 1 : Number.POSITIVE_INFINITY
        : uncompressedSize / compressedSize;
      if (ratio > limits.maximumExpansionRatio) {
        errors.push(`Archive entry ${name} exceeds the expansion-ratio limit`);
      }
      advertisedTotal += uncompressedSize;
      if (advertisedTotal > limits.maximumTotalBytes) errors.push('Archive total-byte limit exceeded');
      central.push({ name, compression, crc, compressedSize, uncompressedSize, localOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (errors.length > 0) return { valid: false, entries: [], errors };
    for (const entry of central) {
      if (entry.localOffset + 30 > input.length || view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
        errors.push(`Archive entry ${entry.name} has no valid local header`);
        continue;
      }
      const nameLength = view.getUint16(entry.localOffset + 26, true);
      const extraLength = view.getUint16(entry.localOffset + 28, true);
      const start = entry.localOffset + 30 + nameLength + extraLength;
      const end = start + entry.compressedSize;
      if (end > input.length) {
        errors.push(`Archive entry ${entry.name} payload is truncated`);
        continue;
      }
      const compressed = input.slice(start, end);
      let data: Uint8Array;
      if (entry.compression === 0) data = compressed;
      else if (entry.compression === 8) data = await inflateRaw(compressed, limits.maximumEntryBytes);
      else {
        errors.push(`Archive entry ${entry.name} uses unsupported compression ${entry.compression}`);
        continue;
      }
      if (data.length !== entry.uncompressedSize) {
        errors.push(`Archive entry ${entry.name} size does not match its directory record`);
      } else if (crc32(data) !== entry.crc) {
        errors.push(`Archive entry ${entry.name} failed CRC validation`);
      } else {
        entries.push({ name: entry.name, data });
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Archive parsing failed');
  }
  return { valid: errors.length === 0, entries: errors.length === 0 ? entries : [], errors };
}
