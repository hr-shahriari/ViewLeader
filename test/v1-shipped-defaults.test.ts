/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  CAD_DARK,
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type StyleDefinition,
  type Theme,
} from '../src/index.js';

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

function makeLeader(theme?: Theme): { leader: ViewLeader; root: HTMLDivElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return {
    leader: new ViewLeader({
      boundary: root,
      adapters,
      ...(theme === undefined ? {} : { theme }),
    }),
    root,
  };
}

/** An annotation naming no style at all, so it falls back. */
function unstyled(id: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position: { x: 200, y: 200 } },
  };
}

describe('the create routing default is a dogleg', () => {
  it('gives a new annotation a diagonal into a landing, not a straight line', () => {
    const { leader } = makeLeader();
    leader.annotations.create(unstyled('a1'));
    expect(leader.annotations.get('a1')!.anchors[0]!.routing)
      .toEqual({ kind: 'automatic', mode: 'dogleg' });
    leader.update();

    // The dogleg signature: three points, with the last segment horizontal into the label.
    const [leg] = leader.geometry.of('a1')!.legs;
    expect(leg).toHaveLength(3);
    expect(leg![2]!.y).toBeCloseTo(leg![1]!.y, 6);
    leader.dispose();
  });

  it('states the routing in the saved file, so the change is visible rather than implied', () => {
    const { leader } = makeLeader();
    leader.annotations.create(unstyled('a1'));
    const saved = JSON.parse(leader.documents.serialize()) as {
      annotations: { anchors: { routing: unknown }[] }[];
    };
    expect(saved.annotations[0]!.anchors[0]!.routing).toEqual({ kind: 'automatic', mode: 'dogleg' });
    leader.dispose();
  });

  it('leaves an existing document that states `straight` completely alone', () => {
    // This is why the change is safe: `create` has always written the routing INTO the document,
    // so a file authored before this change carries `straight` and reopens exactly as it was.
    const { leader } = makeLeader();
    leader.annotations.create(unstyled('a1'));
    const saved = JSON.parse(leader.documents.serialize()) as {
      annotations: { anchors: { routing: unknown }[] }[];
    };
    saved.annotations[0]!.anchors[0]!.routing = { kind: 'automatic', mode: 'straight' };

    leader.documents.replace(saved as never);
    expect(leader.annotations.get('a1')!.anchors[0]!.routing)
      .toEqual({ kind: 'automatic', mode: 'straight' });
    leader.update();
    expect(leader.geometry.of('a1')!.legs[0]).toHaveLength(2);
    leader.dispose();
  });

  it('an explicit routing on the draft still wins', () => {
    const { leader } = makeLeader();
    leader.annotations.create({
      ...unstyled('a1'),
      routing: { kind: 'automatic', mode: 'orthogonal' },
    });
    expect(leader.annotations.get('a1')!.anchors[0]!.routing)
      .toEqual({ kind: 'automatic', mode: 'orthogonal' });
    leader.dispose();
  });
});

describe('the fallback style follows the theme', () => {
  it('matches builtin.style.standard palette rather than a separate grey', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(unstyled('a1'));
    leader.update();

    const standard = leader.definitions.get('builtin.style.standard') as StyleDefinition;
    const drawn = root.querySelector('[data-annotation-id="a1"] path[data-route-visible]')!;
    expect(drawn.getAttribute('stroke')).toBe(standard.lineColor);
    leader.dispose();
  });

  it('follows a dark instance, so an unstyled annotation is legible on a dark viewport', () => {
    const light = makeLeader();
    light.leader.annotations.create(unstyled('a1'));
    light.leader.update();
    const lightStroke = light.root
      .querySelector('[data-annotation-id="a1"] path[data-route-visible]')!.getAttribute('stroke');
    light.leader.dispose();

    const dark = makeLeader(CAD_DARK);
    dark.leader.annotations.create(unstyled('a1'));
    dark.leader.update();
    const darkStroke = dark.root
      .querySelector('[data-annotation-id="a1"] path[data-route-visible]')!.getAttribute('stroke');

    expect(darkStroke).toBe(CAD_DARK.ink);
    expect(darkStroke).not.toBe(lightStroke);
    dark.leader.dispose();
  });

  it('carries the theme into the marquee, which is chrome a user sees', () => {
    const { leader, root } = makeLeader(CAD_DARK);
    leader.annotations.create(unstyled('a1'));
    leader.update();

    // A marquee starts on empty space; jsdom's zero-sized boundary puts every pointer at the
    // origin, which is empty here.
    const at = (x: number, y: number): Parameters<typeof leader.editing.pointerDown>[0] => ({
      x, y, button: 0, buttons: 1, pointerType: 'mouse',
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    });
    leader.editing.pointerDown(at(0.01, 0.01));
    leader.editing.pointerMove(at(0.6, 0.6));

    const marquee = root.querySelector('svg[data-viewleader-overlay] rect[data-marquee]')
      ?? root.querySelector('svg[data-viewleader-overlay] > rect');
    expect(marquee?.getAttribute('stroke')).toBe(CAD_DARK.ink);
    leader.dispose();
  });
});
