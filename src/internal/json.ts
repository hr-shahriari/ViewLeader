import type { JsonValue } from '../types.js';

/**
 * How much of a JSON value a caller is prepared to hold. Anything left out is unbounded here,
 * because the caller has a coarser cap — a byte limit, a node count — that already covers it.
 */
export interface JsonBounds {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxStringLength?: number;
  readonly maxArrayLength?: number;
  readonly maxKeyLength?: number;
}

/**
 * Why a value was refused: it is bigger than the bounds allow, or it is not plain JSON at all — a
 * cycle, a function, a non-finite number, a key that would poison a prototype.
 */
export type JsonFailure = 'bounds' | 'shape';

/**
 * Checks that a value is bounded, acyclic, plain JSON, throwing the caller's error at the first
 * thing that is not. The message names the path to the offending node.
 */
export function assertJson(
  value: unknown,
  label: string,
  bounds: JsonBounds,
  fail: (failure: JsonFailure, message: string, details?: Readonly<Record<string, unknown>>) => Error,
): asserts value is JsonValue {
  const {
    maxDepth = Infinity,
    maxNodes = Infinity,
    maxStringLength = Infinity,
    maxArrayLength = Infinity,
    maxKeyLength = Infinity,
  } = bounds;
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (depth > maxDepth) throw fail('bounds', `${path} is too deeply nested`);
    if (nodes > maxNodes) throw fail('bounds', `${path} has too many nodes`);
    if (candidate === null || typeof candidate === 'boolean') return;
    if (typeof candidate === 'string') {
      if (candidate.length > maxStringLength) throw fail('bounds', `${path} contains an oversized string`);
      return;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw fail('shape', `${path} contains a non-finite number`);
      return;
    }
    if (typeof candidate !== 'object') throw fail('shape', `${path} must be declarative JSON`);
    if (seen.has(candidate)) throw fail('shape', `${path} contains a cycle`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      if (candidate.length > maxArrayLength) throw fail('bounds', `${path} array is too large`);
      candidate.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw fail('shape', `${path} must be plain JSON data`);
      }
      for (const [key, child] of Object.entries(candidate)) {
        if (key.length > maxKeyLength) throw fail('bounds', `${path} contains an oversized key`, { key });
        if (key === '__proto__' || key === 'constructor') {
          throw fail('shape', `${path} contains an unsafe key`, { key });
        }
        visit(child, `${path}.${key}`, depth + 1);
      }
    }
    seen.delete(candidate);
  };
  visit(value, label, 0);
}
