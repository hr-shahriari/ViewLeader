/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  buildDefaultStyles,
  type AnnotationDraft,
  type HostAdapterBundle,
  type StyleDefinition,
  type Theme,
} from '../src/index.js';
import {
  BUILT_IN_DEFINITIONS,
  builtInDefinitions,
} from '../src/definitions.js';
import { CAD_DARK, CAD_PAPER } from '../src/theme.js';

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

const STYLE_IDS = buildDefaultStyles(CAD_PAPER).map(({ id }) => id);

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

/** Anchored on the world origin, so the projected anchor is always (400, 300). */
function draft(id: string, styleId: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'symbolic-block', symbol: 'circle', label: 'A' },
    placement: { kind: 'manual', position: { x: 380, y: 100 } },
    styleId,
  };
}

interface Instance {
  readonly leader: ViewLeader;
  readonly root: HTMLDivElement;
}

/** One instance carrying every built-in style, so a palette leak shows up on whichever style leaks. */
function gallery(theme?: Theme, initialDocument?: string): Instance {
  const root = boundary();
  const leader = new ViewLeader({
    boundary: root,
    adapters,
    ...(theme === undefined ? {} : { theme }),
    ...(initialDocument === undefined ? {} : { initialDocument }),
  });
  if (initialDocument === undefined) {
    for (const [index, id] of STYLE_IDS.entries()) leader.annotations.create(draft(`a${index}`, id));
  }
  leader.update();
  return { leader, root };
}

/** What was actually painted for one annotation — the only thing a theme is allowed to change. */
function paint({ root }: Instance, index: number): Readonly<Record<string, string | null>> {
  const group = root.querySelector(`[data-annotation-id="a${index}"]`)!;
  const outline = group.querySelector('[data-hit-target="label"] path')!;
  return {
    stroke: outline.getAttribute('stroke'),
    fill: outline.getAttribute('fill'),
    text: group.querySelector('text')!.getAttribute('fill'),
    route: group.querySelector('path[data-route-visible]')!.getAttribute('stroke'),
  };
}

const inkOf = (definition: unknown): string => (definition as StyleDefinition).lineColor;

describe('the theme option', () => {
  it('renders the dark palette under the same style ids', () => {
    const dark = gallery(CAD_DARK);
    const light = gallery();

    expect(dark.leader.definitions.list('style').map(({ id }) => id)).toEqual(STYLE_IDS);
    for (const index of STYLE_IDS.keys()) {
      expect([STYLE_IDS[index], paint(dark, index)])
        .not.toEqual([STYLE_IDS[index], paint(light, index)]);
    }
    // The standard style is the theme's ink on both sides, so it names the palette outright.
    expect(paint(dark, 0).text).toBe(CAD_DARK.ink);
    expect(paint(light, 0).text).toBe(CAD_PAPER.ink);
  });

  it('reports through list() and get() exactly what it drew', () => {
    const dark = gallery(CAD_DARK);
    for (const [index, id] of STYLE_IDS.entries()) {
      const reported = dark.leader.definitions.get(id)!;
      expect(inkOf(reported)).toBe(paint(dark, index).route);
    }
    const listed = dark.leader.definitions.list('style');
    expect(listed).toEqual([...buildDefaultStyles(CAD_DARK)]);
    // Everything that is not a style is palette-free, so a themed instance ships it unchanged.
    expect(dark.leader.definitions.list('enclosure'))
      .toEqual(BUILT_IN_DEFINITIONS.filter(({ kind }) => kind === 'enclosure'));
    expect(dark.leader.definitions.get('builtin.template.grid-bubble'))
      .toEqual(BUILT_IN_DEFINITIONS.find(({ id }) => id === 'builtin.template.grid-bubble'));
  });

  it('keeps two themed instances on one page out of each other', () => {
    const dark = gallery(CAD_DARK);
    const light = gallery(CAD_PAPER);
    const second = gallery(CAD_DARK);

    for (const index of STYLE_IDS.keys()) {
      expect(paint(dark, index)).toEqual(paint(second, index));
      expect(paint(light, index)).not.toEqual(paint(dark, index));
    }
    expect(light.leader.definitions.list('style')).toEqual([...buildDefaultStyles(CAD_PAPER)]);
    expect(dark.leader.definitions.list('style')).toEqual([...buildDefaultStyles(CAD_DARK)]);
  });

  it('leaves the default path untouched when theme is omitted', () => {
    // Not merely equal: the default builds no array at all, so nothing downstream can diverge.
    expect(builtInDefinitions()).toBe(BUILT_IN_DEFINITIONS);
    expect(builtInDefinitions(CAD_PAPER)).toBe(BUILT_IN_DEFINITIONS);

    const omitted = gallery();
    const stated = gallery(CAD_PAPER);
    expect(stated.root.innerHTML).toBe(omitted.root.innerHTML);
    expect(stated.leader.definitions.list()).toEqual(omitted.leader.definitions.list());
  });

  it('does not write the theme into the document, so a saved file takes the host palette', () => {
    const authored = gallery(CAD_DARK);
    const serialized = authored.leader.documents.serialize();
    expect(serialized).not.toContain(CAD_DARK.ink);
    expect(serialized).not.toContain('theme');

    // Same bytes, two hosts: each draws in its own palette off the same untouched styleIds.
    const onLight = gallery(undefined, serialized);
    const onDark = gallery(CAD_DARK, serialized);
    for (const [index, id] of STYLE_IDS.entries()) {
      expect(onLight.leader.annotations.get(`a${index}`)?.styleId).toBe(id);
      expect(onDark.leader.annotations.get(`a${index}`)?.styleId).toBe(id);
      expect(paint(onLight, index)).toEqual(paint(gallery(), index));
      expect(paint(onDark, index)).toEqual(paint(authored, index));
    }
    expect(onLight.leader.documents.serialize()).toBe(serialized);
  });

  it('swaps palette in place on one boundary, which is all the demo does', () => {
    const before = gallery();
    const saved = before.leader.documents.serialize();
    before.leader.dispose();
    const after = { root: before.root, leader: new ViewLeader({
      boundary: before.root, adapters, theme: CAD_DARK, initialDocument: saved,
    }) };
    after.leader.update();

    // The disposed instance took its overlay with it, so the boundary holds exactly one drawing.
    expect(before.root.querySelectorAll('[data-annotation-id="a0"]')).toHaveLength(1);
    expect(paint(after, 0).text).toBe(CAD_DARK.ink);
    expect(after.leader.documents.serialize()).toBe(saved);
  });

  it('still refuses a builtin. id from a custom definition on a themed instance', () => {
    const { leader } = gallery(CAD_DARK);
    const shadow: StyleDefinition = {
      ...buildDefaultStyles(CAD_DARK)[0]!,
      lineColor: '#ff0000',
    };
    expect(() => leader.definitions.create(shadow)).toThrow(/immutable/iu);
    expect(() => leader.definitions.create({ ...shadow, id: 'builtin.style.invented' }))
      .toThrow(/immutable/iu);
    expect(() => leader.definitions.remove('builtin.style.standard')).toThrow(/immutable/iu);
  });
});

// Written independently of the cases above, before reading them, as a merge check on the two
// claims the ticket rests on. Kept because both assert something the others do not: whole-markup
// equality rather than sampled attributes, and whole-document equality rather than a substring scan.
describe('the theme option: independent merge checks', () => {
  /** The whole drawn overlay plus the whole saved document, for one annotation under one theme. */
  function render(theme?: Theme): { markup: string; document: string } {
    // `gallery` already populates one annotation per built-in style, so this adds a distinct id
    // rather than colliding with them — the comparison is over the whole overlay either way.
    const instance = gallery(theme);
    instance.leader.annotations.create({
      id: 'merge-check',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      content: { kind: 'symbolic-block', symbol: 'circle', label: 'C' },
      styleId: 'builtin.style.grid-bubble',
      placement: { kind: 'manual', position: { x: 500, y: 380 } },
    });
    instance.leader.update();
    const result = {
      markup: instance.root.querySelector('svg[data-viewleader-overlay]')!.outerHTML,
      document: instance.leader.documents.serialize(),
    };
    instance.leader.dispose();
    return result;
  }

  it('omitting theme draws byte-identically to passing the default explicitly', () => {
    // Stronger than "unchanged from before": the two code paths must converge, not merely agree
    // with a snapshot. A defaulted `theme` that took a subtly different route would pass that and
    // fail this.
    expect(render().markup).toBe(render(CAD_PAPER).markup);
  });

  it('the palette reaches the ink and never reaches the document', () => {
    const light = render(CAD_PAPER);
    const dark = render(CAD_DARK);

    expect(dark.markup).not.toBe(light.markup);
    expect(dark.markup).toContain(CAD_DARK.ink);
    expect(light.markup).not.toContain(CAD_DARK.ink);

    // The same bytes on disk either way, so a file cannot arrive carrying someone else's palette.
    expect(dark.document).toBe(light.document);
    expect(dark.document.toLowerCase()).not.toContain('theme');
  });
});
