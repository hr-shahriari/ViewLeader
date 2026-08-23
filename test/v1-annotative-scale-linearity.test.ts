/** @vitest-environment jsdom */
import { expect, it } from 'vitest';
import { ViewLeader, type HostAdapterBundle, type StyleDefinition } from '../src/index.js';

const adapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ width: 1600, height: 1200, devicePixelRatio: 1 }),
    project: (p) => ({ point: { x: 800 + p.x * 10, y: 600 - p.y * 10 }, depth: p.z, visible: true }),
  },
};

const style: StyleDefinition = {
  kind: 'style',
  id: 'scaled',
  name: 'scaled',
  lineColor: '#1f2937',
  lineWidth: 2,
  textColor: '#111827',
  fontFamily: 'sans-serif',
  fontSize: 14,
  terminatorId: 'builtin.terminator.arrow',
  content: { padding: 10, borderWidth: 3, borderColor: '#1f2937' },
};

/** Whole label box and arrowhead reach at one scale, straight off the drawn output. */
function measure(scale: number): { width: number; height: number; head: number } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({ boundary: root, adapters });
  leader.definitions.create(style);
  leader.setAnnotationScale(scale);
  leader.annotations.create({
    id: 'a1',
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'plain-note', text: 'Mechanical' },
    styleId: 'scaled',
    placement: { kind: 'manual', position: { x: 900, y: 700 } },
  });
  leader.update();
  const label = leader.geometry.of('a1')!.label;
  const head = root.querySelector('[data-annotation-id="a1"] path[data-terminator="anchor"]')!;
  const reach = Math.max(...[...(head.getAttribute('d') ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)]
    .map(([m]) => Math.abs(Number(m))));
  leader.dispose();
  return { width: label.width, height: label.height, head: reach };
}

it('doubles the label linearly — a squared factor would be 4x, not 2x', () => {
  const one = measure(1);
  const two = measure(2);

  // The whole box, which contains both the scaled text and the padding around it. If padding were
  // multiplied on top of the group scale that already carries it, this would overshoot 2x.
  expect(two.width / one.width).toBeCloseTo(2, 3);
  expect(two.height / one.height).toBeCloseTo(2, 3);

  // And the arrowhead tracks it, or a head would scale while its leader did not.
  expect(two.head / one.head).toBeCloseTo(2, 3);
});

it('is linear at a non-integer factor too, where a squared error is easiest to see', () => {
  const one = measure(1);
  const half = measure(1.5);
  expect(half.width / one.width).toBeCloseTo(1.5, 3);
  // 1.5 squared is 2.25 — a comfortable margin from 1.5.
  expect(half.height / one.height).toBeCloseTo(1.5, 3);
});
