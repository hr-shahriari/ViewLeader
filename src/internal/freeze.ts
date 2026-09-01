/**
 * Freezes a value and everything reachable from it. An object that is already frozen is taken to
 * be frozen all the way down and skipped, which is what every caller guarantees and what keeps a
 * shared built-in from being walked again on every edit that touches it.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
  return value;
}
