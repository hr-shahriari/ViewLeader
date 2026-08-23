// Turns browser pointer events into plain 0..1 coordinates.
//
// Authoring and editing both work in these coordinates rather than in DOM events, so they can be
// driven from a script with no browser at all — which is how the test suite exercises them, and
// what lets a host wire up its own input devices.
import { InvalidInputError } from './errors.js';
import type { NormalizedPointerInput } from './host.js';

/** Rejects coordinates outside the viewport. Catches a host passing raw pixels by mistake. */
export function validatePointer(pointer: NormalizedPointerInput): void {
  if (
    !Number.isFinite(pointer.x) || pointer.x < 0 || pointer.x > 1 ||
    !Number.isFinite(pointer.y) || pointer.y < 0 || pointer.y > 1
  ) {
    throw new InvalidInputError('Normalized pointer coordinates must be between 0 and 1');
  }
}

/**
 * Converts a browser pointer event into a position relative to the viewer element, where 0,0 is its
 * top-left corner and 1,1 its bottom-right. Independent of size and zoom, so a recorded gesture
 * replays the same way in a different window.
 */
export function normalizePointer(event: PointerEvent, boundary: Element): NormalizedPointerInput {
  const bounds = boundary.getBoundingClientRect();
  return Object.freeze({
    x: bounds.width === 0 ? 0 : clamp((event.clientX - bounds.left) / bounds.width),
    y: bounds.height === 0 ? 0 : clamp((event.clientY - bounds.top) / bounds.height),
    button: event.button,
    buttons: event.buttons,
    pointerType: normalizePointerType(event.pointerType),
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });
}

export function isPointerEvent(event: Event): event is PointerEvent {
  return 'clientX' in event && 'clientY' in event && 'pointerType' in event;
}

function normalizePointerType(value: string): NormalizedPointerInput['pointerType'] {
  return value === 'pen' || value === 'touch' ? value : 'mouse';
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
