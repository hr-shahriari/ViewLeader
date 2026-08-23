/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type OcclusionResult,
  type OcclusionSample,
  type RegionAnchor,
} from '../src/index.js';
import {
  regionAttachment,
  type ProjectedRegion,
  type RegionAttachmentZone,
} from '../src/markup.js';
import type { ScreenBounds } from '../src/routing.js';
import type { Vec2 } from '../src/types.js';

/** Screen rect x 300..500, y 250..350 — what the world rectangle below projects to. */
const rectangle: ProjectedRegion = {
  kind: 'rectangle',
  closed: true,
  points: [{ x: 300, y: 250 }, { x: 500, y: 250 }, { x: 500, y: 350 }, { x: 300, y: 350 }],
};

/** A label box of a given size centred on a point, which is all the zone test looks at. */
function labelAt(centre: Vec2, width = 40, height = 20): ScreenBounds {
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
}

function attach(centre: Vec2, region: ProjectedRegion = rectangle): { point: Vec2; zone: RegionAttachmentZone } {
  return regionAttachment(region, labelAt(centre));
}

/** A 48-gon inscribed in the same screen rect, as `projectRegion` emits for an ellipse. */
const ellipse: ProjectedRegion = {
  kind: 'ellipse',
  closed: true,
  points: Array.from({ length: 48 }, (_, index) => {
    const angle = (index / 48) * Math.PI * 2;
    return { x: 400 + Math.cos(angle) * 100, y: 300 + Math.sin(angle) * 50 };
  }),
};

/** The same rect turned 45°, so none of its corners sit on its screen bounds. */
const turned: ProjectedRegion = {
  kind: 'rectangle',
  closed: true,
  points: [{ x: 400, y: 200 }, { x: 500, y: 300 }, { x: 400, y: 400 }, { x: 300, y: 300 }],
};

const region: RegionAnchor = {
  kind: 'region',
  plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xAxis: { x: 1, y: 0, z: 0 } },
  vertices: [{ x: -10, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: -10, y: 5 }],
  shape: 'rectangle',
  fallbackPoint: { x: 7, y: 7, z: 7 },
};

/** Scale is mutable so a test can move the camera between frames. */
const camera = { scale: 10 };

const adapters: HostAdapterBundle = {
  projection: {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
    project: (point) => ({
      point: { x: 400 + point.x * camera.scale, y: 300 - point.y * camera.scale },
      depth: point.z,
      visible: true,
    }),
  },
};

function note(position: Vec2): AnnotationDraft {
  return {
    id: 'room',
    anchor: region,
    routing: { kind: 'automatic', mode: 'straight' },
    content: { kind: 'plain-note', text: 'Room' },
    placement: { kind: 'manual', position },
  };
}

function mount(position: Vec2): { leader: ViewLeader; group: () => Element } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const leader = new ViewLeader({ boundary: root, adapters });
  leader.annotations.create(note(position));
  leader.update();
  return { leader, group: () => root.querySelector('[data-annotation-id="room"]')! };
}

/** The drawn route, as points. */
function drawn(group: Element): readonly Vec2[] {
  const numbers = [...(group.querySelector('path[data-route-visible]')?.getAttribute('d') ?? '')
    .matchAll(/-?\d+(?:\.\d+)?/gu)].map(([match]) => Number(match));
  return numbers.reduce<Vec2[]>((points, value, index) =>
    index % 2 === 0 ? [...points, { x: value, y: 0 }] : [...points.slice(0, -1), { x: points.at(-1)!.x, y: value }],
    []);
}

/** The anchor head's `translate(x y) rotate(a)`, in degrees. */
function head(group: Element): { x: number; y: number; angle: number } {
  const transform = group.querySelector('path[data-terminator="anchor"]')?.getAttribute('transform') ?? '';
  const [x, y, angle] = [...transform.matchAll(/-?\d+(?:\.\d+)?/gu)].map(([match]) => Number(match));
  return { x: x!, y: y!, angle: angle! };
}

describe('region attachment zones', () => {
  it('classifies the label centre into all nine zones', () => {
    const zones = ([
      [{ x: 200, y: 150 }, 'top-left'],
      [{ x: 400, y: 150 }, 'top'],
      [{ x: 600, y: 150 }, 'top-right'],
      [{ x: 200, y: 300 }, 'left'],
      [{ x: 400, y: 300 }, 'inside'],
      [{ x: 600, y: 300 }, 'right'],
      [{ x: 200, y: 450 }, 'bottom-left'],
      [{ x: 400, y: 450 }, 'bottom'],
      [{ x: 600, y: 450 }, 'bottom-right'],
    ] as const satisfies readonly (readonly [Vec2, RegionAttachmentZone])[]);
    for (const [centre, zone] of zones) expect(attach(centre).zone).toBe(zone);
  });

  it('terminates on the top edge for a label above, at the label position', () => {
    expect(attach({ x: 380, y: 100 })).toEqual({ point: { x: 380, y: 250 }, zone: 'top' });
    // The terminus follows the label along the edge rather than pinning to the midpoint.
    expect(attach({ x: 460, y: 100 }).point).toEqual({ x: 460, y: 250 });
  });

  it('moves the terminus to the left edge when the label moves left', () => {
    expect(attach({ x: 120, y: 300 })).toEqual({ point: { x: 300, y: 300 }, zone: 'left' });
    expect(attach({ x: 900, y: 320 })).toEqual({ point: { x: 500, y: 320 }, zone: 'right' });
    expect(attach({ x: 400, y: 500 })).toEqual({ point: { x: 400, y: 350 }, zone: 'bottom' });
  });

  it('attaches on the corner for the four diagonal zones', () => {
    expect(attach({ x: 100, y: 100 }).point).toEqual({ x: 300, y: 250 });
    expect(attach({ x: 700, y: 100 }).point).toEqual({ x: 500, y: 250 });
    expect(attach({ x: 100, y: 500 }).point).toEqual({ x: 300, y: 350 });
    expect(attach({ x: 700, y: 500 }).point).toEqual({ x: 500, y: 350 });
  });

  it('never runs the leader through the region it points at', () => {
    // The far-side failure this replaces: the old pick was a polygon vertex, so a label on the
    // right could terminate on the left corner and cross the whole region to get there.
    const centre = { x: 400, y: 300 };
    for (const label of [{ x: 700, y: 300 }, { x: 100, y: 300 }, { x: 400, y: 100 }, { x: 400, y: 500 }]) {
      const { point } = attach(label);
      expect(Math.hypot(point.x - label.x, point.y - label.y))
        .toBeLessThan(Math.hypot(centre.x - label.x, centre.y - label.y));
    }
  });

  it('slides along the nearest edge when the label centre is inside, with a leader that has length', () => {
    // Deep inside a big region the label still gets an outward leader to the closest wall.
    expect(attach({ x: 340, y: 270 })).toEqual({ point: { x: 340, y: 250 }, zone: 'inside' });
    expect(attach({ x: 320, y: 300 })).toEqual({ point: { x: 300, y: 300 }, zone: 'inside' });
    const { point } = attach({ x: 340, y: 270 });
    expect(Math.hypot(point.x - 340, point.y - 270)).toBeGreaterThan(0);
  });

  it('keeps the terminus on the drawn outline, not on the screen bounds', () => {
    // An ellipse's bounds corner is empty space; the rim point below the label is not.
    const onEllipse = attach({ x: 400, y: 100 }, ellipse).point;
    expect(onEllipse).toEqual({ x: 400, y: 250 });
    const diagonal = attach({ x: 100, y: 100 }, ellipse).point;
    expect(diagonal).not.toEqual({ x: 300, y: 250 });
    expect(((diagonal.x - 400) / 100) ** 2 + ((diagonal.y - 300) / 50) ** 2).toBeCloseTo(1, 6);

    // A turned rectangle: its bounds corner (300, 200) is off the shape, its own vertex is on it.
    expect(attach({ x: 100, y: 100 }, turned).point).toEqual({ x: 300, y: 300 });
    expect(attach({ x: 400, y: 100 }, turned).point).toEqual({ x: 400, y: 200 });
  });
});

describe('region attachment in the frame pipeline', () => {
  it('terminates on the facing edge of the rendered region', () => {
    // The head keeps the untrimmed terminus, so its translate is the attachment point itself.
    const above = head(mount({ x: 360, y: 120 }).group());
    expect(above.y).toBeCloseTo(250, 3);
    expect(above.x).toBeGreaterThan(300);
    expect(above.x).toBeLessThan(500);
    expect(head(mount({ x: 60, y: 290 }).group()).x).toBeCloseTo(300, 3);
    expect(head(mount({ x: 360, y: 500 }).group()).y).toBeCloseTo(350, 3);
  });

  it('slides the terminus along the edge as the label slides along above it', () => {
    const near = head(mount({ x: 330, y: 120 }).group());
    const far = head(mount({ x: 430, y: 120 }).group());
    expect(near.y).toBeCloseTo(250, 3);
    expect(far.y).toBeCloseTo(250, 3);
    expect(far.x - near.x).toBeCloseTo(100, 3);
  });

  it('recomputes the terminus per frame as the camera moves, storing nothing', () => {
    const { leader, group } = mount({ x: 360, y: 120 });
    const stored = leader.annotations.get('room')!.anchors[0]!.anchor;
    expect(head(group()).y).toBeCloseTo(250, 3);
    camera.scale = 5;
    try {
      leader.update();
      // The region now projects to y 275..325, so the same label attaches 25px lower.
      expect(head(group()).y).toBeCloseTo(275, 3);
    } finally {
      camera.scale = 10;
    }
    // Nothing was written back: the stored anchor is still its vertices plus one fallback point.
    expect(leader.annotations.get('room')!.anchors[0]!.anchor).toEqual(stored);
    expect(stored).toMatchObject({ kind: 'region', fallbackPoint: { x: 7, y: 7, z: 7 } });
  });

  it('points the arrowhead into the region across the edge it landed on', () => {
    const above = mount({ x: 360, y: 120 }).group();
    const tip = head(above);
    expect(tip.y).toBeCloseTo(250, 3);
    // The head aims down through the top edge — inward — and stays collinear with its own segment,
    // whose far end the trim never moves.
    const attachment = drawn(above).at(-1)!;
    expect(tip.angle).toBeCloseTo(
      Math.atan2(tip.y - attachment.y, tip.x - attachment.x) * (180 / Math.PI),
      2,
    );
    expect(Math.sin((tip.angle * Math.PI) / 180)).toBeGreaterThan(0);

    // From the left the same head aims right, through the left edge.
    expect(Math.cos((head(mount({ x: 60, y: 290 }).group()).angle * Math.PI) / 180))
      .toBeGreaterThan(0);
  });

  it('leaves the document byte-identical across frames, so nothing is cached on the annotation', () => {
    const { leader } = mount({ x: 360, y: 120 });
    const before = leader.documents.serialize();
    camera.scale = 5;
    try {
      leader.update();
    } finally {
      camera.scale = 10;
    }
    expect(leader.documents.serialize()).toBe(before);
  });

  it('still resolves the anchor to its own fallback point, which is what occlusion samples', () => {
    const test = vi.fn((_samples: readonly OcclusionSample[], _signal: AbortSignal) =>
      Promise.resolve<readonly OcclusionResult[]>([]));
    const root = document.createElement('div');
    document.body.appendChild(root);
    const leader = new ViewLeader({ boundary: root, adapters: { ...adapters, occlusion: { test } } });
    leader.annotations.create({ ...note({ x: 360, y: 120 }), occlusion: 'fade' });
    leader.update();
    // The screen terminus never becomes the anchor's world point — sampling still uses the stored one.
    expect(test.mock.calls[0]?.[0])
      .toEqual([{ annotationId: 'room', legId: 'leg-1', worldPoint: { x: 7, y: 7, z: 7 } }]);
  });
});
