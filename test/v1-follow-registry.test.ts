/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  FollowRegistry,
  followTargetKey,
  type FollowGeometrySource,
} from '../src/internal/follow.js';
import type { AnnotationScreenGeometry, InkScreenGeometry } from '../src/render.js';

/**
 * The registry writes to elements outside any render cycle, so these tests drive frames by hand and
 * read the DOM back — which is exactly how a host consumes it.
 */

function geometry(label: { x: number; y: number; width: number; height: number }): AnnotationScreenGeometry {
  return {
    label,
    legs: [],
    handles: [{ target: 'leg-1', index: 0, at: { x: 10, y: 20 } }],
    routeHandles: [
      { target: 'leg-1', kind: 'midpoint', index: 0, at: { x: 30, y: 40 } },
      { target: 'leg-2', kind: 'midpoint', index: 0, at: { x: 50, y: 60 } },
    ],
    regionHandles: [],
    text: {
      fontFamily: 'Helvetica', fontSize: 14, lineHeight: 18, textColor: '#111',
      align: 'start', padding: 4, weight: 'normal',
    },
  };
}

interface Harness {
  readonly registry: FollowRegistry;
  readonly frame: () => void;
  setGeometry(value: AnnotationScreenGeometry | undefined): void;
  setInk(value: InkScreenGeometry | undefined): void;
}

function harness(): Harness {
  let current: AnnotationScreenGeometry | undefined = geometry({ x: 100, y: 200, width: 80, height: 30 });
  let ink: InkScreenGeometry | undefined = { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
  let listener: (() => void) | undefined;
  const source: FollowGeometrySource = {
    of: () => current,
    ofInk: () => ink,
  };
  const registry = new FollowRegistry({
    geometry: source,
    subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
  });
  return {
    registry,
    frame: () => listener?.(),
    setGeometry: (value) => { current = value; },
    setInk: (value) => { ink = value; },
  };
}

function div(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
}

describe('follow target keys', () => {
  it('separates two legs that both publish midpoint 0', () => {
    // `kind + index` alone collides here, which would silently collapse two handles into one.
    const a = followTargetKey({ kind: 'route-handle', id: 'n', leg: 'leg-1', handleKind: 'midpoint', index: 0 });
    const b = followTargetKey({ kind: 'route-handle', id: 'n', leg: 'leg-2', handleKind: 'midpoint', index: 0 });
    expect(a).not.toBe(b);
  });
});

describe('the follow registry', () => {
  it('positions a point target and reuses the same ref callback', () => {
    const { registry, frame } = harness();
    const element = div();
    const ref = registry.ref({ kind: 'handle', id: 'n', leg: 'leg-1' });
    expect(registry.ref({ kind: 'handle', id: 'n', leg: 'leg-1' })).toBe(ref);

    ref(element);
    frame();
    expect(element.style.transform).toBe('translate(10px, 20px)');
    // A point target has no size of its own to impose.
    expect(element.style.width).toBe('');
    registry.dispose();
  });

  it('gives a label target its size and text metrics as custom properties', () => {
    const { registry, frame } = harness();
    const element = div();
    registry.ref({ kind: 'label', id: 'n' })(element);
    frame();

    expect(element.style.transform).toBe('translate(100px, 200px)');
    expect(element.style.width).toBe('80px');
    expect(element.style.height).toBe('30px');
    expect(element.style.getPropertyValue('--vl-font-family')).toBe('Helvetica');
    expect(element.style.getPropertyValue('--vl-font-size')).toBe('14px');
    expect(element.style.getPropertyValue('--vl-line-height')).toBe('18px');
    registry.dispose();
  });

  it('hides a target with no geometry, and says so on the element', () => {
    const { registry, frame, setGeometry } = harness();
    const element = div();
    registry.ref({ kind: 'label', id: 'n' })(element);
    frame();
    expect(element.style.visibility).toBe('');

    setGeometry(undefined);
    frame();
    expect(element.style.visibility).toBe('hidden');
    expect(element.style.pointerEvents).toBe('none');
    expect(element.getAttribute('data-vl-follow')).toBe('offscreen');

    setGeometry(geometry({ x: 5, y: 6, width: 10, height: 10 }));
    frame();
    expect(element.style.visibility).toBe('');
    expect(element.getAttribute('data-vl-follow')).toBeNull();
    registry.dispose();
  });

  it('holds the last position instead, when the caller asked it to', () => {
    // What a focused editor and a frozen handle both need: disappearing mid-sentence or mid-drag is
    // worse than sitting at a stale position for a frame.
    const { registry, frame, setGeometry } = harness();
    const element = div();
    registry.ref({ kind: 'label', id: 'n' }, { onMissing: 'hold' })(element);
    frame();
    const held = element.style.transform;

    setGeometry(undefined);
    frame();
    expect(element.style.visibility).toBe('');
    expect(element.style.transform).toBe(held);
    registry.dispose();
  });

  it('does not touch the DOM when nothing moved', () => {
    const { registry, frame } = harness();
    const element = div();
    let writes = 0;
    const real = element.style.setProperty.bind(element.style);
    element.style.setProperty = (...args: Parameters<CSSStyleDeclaration['setProperty']>) => {
      writes += 1;
      real(...args);
    };
    registry.ref({ kind: 'label', id: 'n' })(element);
    frame();
    const afterFirst = writes;
    expect(afterFirst).toBeGreaterThan(0);

    frame();
    frame();
    expect(writes).toBe(afterFirst);
    registry.dispose();
  });

  it('follows an ink point through its own geometry', () => {
    const { registry, frame } = harness();
    const element = div();
    registry.ref({ kind: 'ink-point', id: 'stroke', index: 1 })(element);
    frame();
    expect(element.style.transform).toBe('translate(3px, 4px)');
    registry.dispose();
  });

  it('releases on a null ref and stops writing', () => {
    const { registry, frame, setGeometry } = harness();
    const element = div();
    const ref = registry.ref({ kind: 'label', id: 'n' });
    ref(element);
    frame();
    const positioned = element.style.transform;

    ref(null);
    setGeometry(geometry({ x: 999, y: 999, width: 1, height: 1 }));
    frame();
    expect(element.style.transform).toBe(positioned);
    registry.dispose();
  });

  it('registers an element directly, for a template ref', () => {
    const { registry, frame } = harness();
    const element = div();
    const stop = registry.register({ kind: 'label', id: 'n' }, element);
    frame();
    expect(element.style.transform).toBe('translate(100px, 200px)');

    stop();
    registry.dispose();
  });

  it('unsubscribes from the frame seam when disposed', () => {
    const { registry, frame, setGeometry } = harness();
    const element = div();
    registry.ref({ kind: 'label', id: 'n' })(element);
    frame();
    const positioned = element.style.transform;

    registry.dispose();
    setGeometry(geometry({ x: 7, y: 7, width: 1, height: 1 }));
    frame();
    expect(element.style.transform).toBe(positioned);
  });
});
