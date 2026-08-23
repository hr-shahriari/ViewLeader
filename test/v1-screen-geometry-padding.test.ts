/** @vitest-environment jsdom */
import { expect, it } from 'vitest';
import { ViewLeader, type HostAdapterBundle, type StyleDefinition } from '../src/index.js';

const adapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ width: 1600, height: 1200, devicePixelRatio: 1 }),
    project: (p) => ({ point: { x: 800 + p.x * 10, y: 600 - p.y * 10 }, depth: p.z, visible: true }),
  },
};

/**
 * Published padding against the inset the renderer actually drew.
 *
 * `text.padding` is documented as a resolved, as-drawn value, because that is the whole reason it
 * was published: a host putting an inline field over a label needs the real inset. The label group
 * is scaled by `fontSize / DEFAULT_FONT_SIZE`, so a padding read straight off the style is in
 * layout units, not screen pixels.
 */
function compare(fontSize: number, scale = 1): { published: number; drawn: number } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({ boundary: root, adapters });
  const style: StyleDefinition = {
    kind: 'style',
    id: 'padded',
    name: 'padded',
    lineColor: '#1f2937',
    lineWidth: 1.5,
    textColor: '#111827',
    fontFamily: 'sans-serif',
    fontSize,
    terminatorId: 'builtin.terminator.arrow',
    content: { padding: 10 },
  };
  leader.definitions.create(style);
  leader.setAnnotationScale(scale);
  leader.annotations.create({
    id: 'a1',
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'plain-note', text: 'Mechanical' },
    styleId: 'padded',
    placement: { kind: 'manual', position: { x: 900, y: 700 } },
  });
  leader.update();

  const geometry = leader.geometry.of('a1')!;
  // At the layout size the scale is exactly 1 and the renderer emits no scaling group at all.
  const group = root.querySelector('[data-annotation-id="a1"] g[data-hit-target="label"] > g');
  const groupScale = Number(
    (/scale\(([\d.]+)/u.exec(group?.getAttribute('transform') ?? '') ?? [])[1] ?? 1,
  );
  const textX = Number(root.querySelector('[data-annotation-id="a1"] text')!.getAttribute('x'));
  leader.dispose();
  // The drawn inset in screen pixels: the text's own x inside the group, times the group's scale.
  return { published: geometry.text.padding, drawn: textX * groupScale };
}

it('published padding equals the drawn inset at the default size', () => {
  const { published, drawn } = compare(14);
  expect(published).toBeCloseTo(drawn, 3);
});

it('published padding equals the drawn inset at a larger font size', () => {
  const { published, drawn } = compare(28);
  expect(published).toBeCloseTo(drawn, 3);
});

it('published padding equals the drawn inset under annotative scale', () => {
  const { published, drawn } = compare(14, 2);
  expect(published).toBeCloseTo(drawn, 3);
});
