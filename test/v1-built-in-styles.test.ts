/** @vitest-environment jsdom */
/**
 * ⚠ THIS FILE LOST UNCOMMITTED WORK AND IS BACK AT ITS COMMITTED STATE.
 *
 * An over-broad `git checkout test/` discarded the working copy. The SOURCE changes it was written
 * against survived (`content.ts` now tags a symbolic block's own shape `role: 'symbol'` so a style's
 * enclosure cannot replace it — a requested hexagon stays a hexagon), so two tests here now fail
 * against behaviour that is deliberate and current:
 *
 *   'renders a grid bubble …'   expects `d` to contain 'C'. The circle is now two arcs, `A`, drawn
 *                               by the symbol itself instead of by the style's bezier enclosure.
 *                               `extent()` also mis-measures an arc path, since it reads every
 *                               number as a coordinate and an arc carries radii and flags.
 *   'renders a hexagon …'       counts `L` commands and finds none. The symbol path is
 *                               `M 9 0 H 27 L 36 18 L 27 36 H 9 L 0 18 Z` — six sides, but two of
 *                               them spelled `H`, and `outline()` may no longer be selecting it.
 *
 * Both were then rewritten to assert what each test's NAME says it checks — "a circle", "a hexagon,
 * not a rounded rectangle" — against what the current code demonstrably produces. That is a
 * reconstruction, not a recovery: the intent is taken from the test names and the surviving source,
 * so review it rather than trust it. `examples-routes.test.ts` was restored outright, because
 * `leader-editor` is registered in `index.html` and `vite.config.ts` and the omission was
 * unambiguous.
 */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  buildDefaultStyles,
  type AnnotationDraft,
  type HostAdapterBundle,
} from '../src/index.js';
import {
  BUILT_IN_DEFINITIONS,
  definitionFromJson,
  definitionToJson,
  validateDefinition,
  type TemplateApplicable,
} from '../src/definitions.js';
import { CAD_DARK, CAD_PAPER, PEN } from '../src/theme.js';

const adapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
    project: (point) => ({
      point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
      depth: point.z,
      visible: true,
    }),
  },
};

const PAPER_STYLES = buildDefaultStyles(CAD_PAPER);

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

/** Anchored on the world origin, so the projected anchor is always (400, 300). */
function draft(id: string, styleId: string, extra: Partial<AnnotationDraft> = {}): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'symbolic-block', symbol: 'circle', label: 'A' },
    placement: { kind: 'manual', position: { x: 380, y: 100 } },
    styleId,
    ...extra,
  };
}

function render(annotation: AnnotationDraft): Element {
  const root = boundary();
  const leader = new ViewLeader({ boundary: root, adapters });
  leader.annotations.create(annotation);
  leader.update();
  return root.querySelector(`[data-annotation-id="${annotation.id}"]`)!;
}

function numbers(value: string | null | undefined): readonly number[] {
  return [...(value ?? '').matchAll(/-?\d+(?:\.\d+)?/gu)].map(([match]) => Number(match));
}

type Point = Readonly<{ x: number; y: number }>;

/** The drawn route, as x/y pairs. */
function route(group: Element): readonly Point[] {
  const values = numbers(group.querySelector('path[data-route-visible]')?.getAttribute('d'));
  return values.filter((_, index) => index % 2 === 0)
    .map((x, index) => ({ x, y: values[index * 2 + 1]! }));
}

function outline(group: Element): SVGPathElement {
  return group.querySelector('[data-hit-target="label"] path')!;
}

/** Axis-aligned extent of a path's coordinates — the box the shape occupies. */
function extent(path: SVGPathElement): Readonly<{ width: number; height: number }> {
  const values = numbers(path.getAttribute('d'));
  const xs = values.filter((_, index) => index % 2 === 0);
  const ys = values.filter((_, index) => index % 2 === 1);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

describe('the eleven built-in styles', () => {
  it('renders a grid bubble: circle, bold centred letter, dot on a vertical drop', () => {
    const group = render(draft('grid', 'builtin.style.grid-bubble', {
      routing: { kind: 'automatic', mode: 'orthogonal' },
    }));

    const shape = outline(group);
    // RECONSTRUCTED — see the header. A circle, drawn as two arcs by the symbolic block itself.
    // It used to be a bezier because the style's enclosure replaced the symbol's shape; `content.ts`
    // now tags that shape `role: 'symbol'` so a style cannot turn a requested circle into its own
    // outline. Roundness is asserted from the arc's radii, because `extent()` reads every number in
    // a path as a coordinate and an arc carries radii and flags as well.
    const path = shape.getAttribute('d') ?? '';
    expect(path).toContain('A');
    const [radiusX, radiusY] = path.split('A')[1]!.trim().split(/\s+/u).map(Number);
    expect(radiusX).toBeCloseTo(radiusY!, 6);
    expect(shape.getAttribute('stroke')).toBe(CAD_PAPER.ink);
    expect(shape.getAttribute('stroke-width')).toBe(String(PEN.medium));

    const text = group.querySelector('text')!;
    expect(text.getAttribute('font-weight')).toBe('bold');
    expect(text.getAttribute('text-anchor')).toBe('middle');

    const dot = group.querySelector('path[data-terminator="anchor"]')!;
    expect(dot.getAttribute('fill')).toBe(CAD_PAPER.ink);
    // ISO 128-22 sizes the surface dot at 5 × line width, so 2.5 of radius.
    expect(Math.max(...numbers(dot.getAttribute('d')).map(Math.abs)))
      .toBeCloseTo(2.5 * PEN.thin, 2);

    const points = route(group);
    expect(points).toHaveLength(3);
    const [start, elbow, attachment] = points as [Point, Point, Point];
    expect(elbow.x).toBeCloseTo(start.x, 6);
    expect(elbow.y).toBeCloseTo(attachment.y, 6);
    expect(start.y).toBeGreaterThan(elbow.y);
  });

  it('reaches that grid bubble from one template, route included', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters });
    const applied = leader.definitions.applyTemplate<TemplateApplicable>(
      { placement: { kind: 'manual', position: { x: 380, y: 100 } } },
      'builtin.template.grid-bubble',
    );
    expect(applied.styleId).toBe('builtin.style.grid-bubble');
    expect(applied.routing).toEqual({ kind: 'automatic', mode: 'orthogonal' });
    // Bold and centred come from the content kind, so the template names one that is both.
    expect(applied.content).toEqual({ kind: 'symbolic-block', symbol: 'circle', label: '' });
  });

  // RECONSTRUCTED — see the header. The draft asks for a HEXAGON now. It used to ask for a circle
  // and rely on the tag-hexagon style's enclosure to reshape it, which `content.ts`'s `role:
  // 'symbol'` deliberately no longer allows: the shape is the content, so a style cannot turn a
  // requested circle into a hexagon any more than it could turn a hexagon into a rectangle.
  it('renders a hexagon for tag-hexagon, not a rounded rectangle', () => {
    const shape = outline(render(draft('hex', 'builtin.style.tag-hexagon', {
      content: { kind: 'symbolic-block', symbol: 'hexagon', label: 'A' },
    })));
    const path = shape.getAttribute('d') ?? '';
    expect(path).not.toContain('Q');
    expect(path).not.toContain('C');
    expect(path).not.toContain('A');
    // Six sides, so five commands between the opening `M` and the closing `Z`. Two of them are `H`:
    // the path spells its horizontal edges that way rather than as `L`.
    expect([...path.matchAll(/[LH]/gu)]).toHaveLength(5);
    expect(shape.getAttribute('fill')).toBe(CAD_PAPER.accent);
  });

  it('switches palette without switching ids', () => {
    const dark = buildDefaultStyles(CAD_DARK);
    expect(dark.map(({ id }) => id)).toEqual(PAPER_STYLES.map(({ id }) => id));
    for (const [index, style] of PAPER_STYLES.entries()) {
      expect(JSON.stringify(dark[index])).not.toBe(JSON.stringify(style));
    }
    // Every id a host can reference is a built-in, so nothing on the host side moves.
    const builtInStyleIds = BUILT_IN_DEFINITIONS.filter(({ kind }) => kind === 'style').map(({ id }) => id);
    expect(builtInStyleIds).toEqual(PAPER_STYLES.map(({ id }) => id));
  });

  it('resolves every line weight to an NCS pen tier', () => {
    const tiers = new Set<number>(Object.values(PEN));
    for (const style of PAPER_STYLES) {
      expect(tiers.has(style.lineWidth)).toBe(true);
      const border = style.content?.borderWidth;
      // Zero is the unframed form, which is a deliberate absence rather than an off-tier weight.
      if (border !== undefined && border !== 0) expect(tiers.has(border)).toBe(true);
    }
  });

  it('ships eleven styles, all valid and all listed', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters });
    expect(PAPER_STYLES).toHaveLength(11);
    const listed = leader.definitions.list('style');
    expect(listed.map(({ id }) => id)).toEqual(PAPER_STYLES.map(({ id }) => id));
    for (const style of PAPER_STYLES) {
      expect(() => validateDefinition(style)).not.toThrow();
      expect(definitionFromJson(definitionToJson(style))).toEqual(style);
    }
  });

  it('keeps every style renderable and every reference alive across a document round-trip', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters });
    for (const [index, style] of PAPER_STYLES.entries()) {
      leader.annotations.create(draft(`a${index}`, style.id, {
        placement: { kind: 'manual', position: { x: 60 + index * 60, y: 80 } },
      }));
    }
    const serialized = leader.documents.serialize();

    const reopened = new ViewLeader({
      boundary: boundary(), adapters, initialDocument: serialized,
    });
    reopened.update();
    for (const [index, style] of PAPER_STYLES.entries()) {
      expect(reopened.annotations.get(`a${index}`)?.styleId).toBe(style.id);
      const group = document.querySelector(`[data-annotation-id="a${index}"]`)!;
      expect(group.querySelector('text')).not.toBeNull();
      expect(outline(group).getAttribute('d')).not.toBe('');
    }
  });

  it('draws each style with the shape and pen its definition asked for', () => {
    // Curved, straight, or a plain unenclosed rectangle — enough to catch a style that silently
    // fell back to content layout's own box instead of the enclosure it named.
    const expected: Readonly<Record<string, 'curved' | 'straight' | 'plain'>> = {
      'builtin.style.standard': 'curved',
      'builtin.style.note': 'plain',
      'builtin.style.dimension': 'plain',
      'builtin.style.detail-bubble': 'curved',
      'builtin.style.section-head': 'curved',
      'builtin.style.grid-bubble': 'curved',
      'builtin.style.level-head': 'plain',
      'builtin.style.spot-elevation': 'plain',
      'builtin.style.tag-circle': 'curved',
      'builtin.style.tag-hexagon': 'straight',
      'builtin.style.tag-chevron': 'straight',
    };
    // Plain-note content draws a bare rectangle, so any other shape came from the style.
    const plain = { content: { kind: 'plain-note', text: 'A1' } } as const;
    for (const [index, style] of PAPER_STYLES.entries()) {
      const group = render(draft(`s${index}`, style.id, plain));
      const shape = outline(group);
      const path = shape.getAttribute('d') ?? '';
      const form = /[CQ]/u.test(path) ? 'curved' : /^M 0 0 H /u.test(path) ? 'plain' : 'straight';
      expect([style.id, form]).toEqual([style.id, expected[style.id]]);
      expect(shape.getAttribute('stroke')).toBe(style.content?.borderColor ?? style.lineColor);
      expect(group.querySelector('path[data-terminator="anchor"]')).not.toBeNull();
    }
    // The split circle carries a diameter across it, which a plain circle does not.
    const withDiameter = (id: string): boolean =>
      [...(outline(render(draft(id, id, plain))).getAttribute('d') ?? '').matchAll(/M/gu)].length > 1;
    expect(withDiameter('builtin.style.detail-bubble')).toBe(true);
    expect(withDiameter('builtin.style.grid-bubble')).toBe(false);
  });
});
