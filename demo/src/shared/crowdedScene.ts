/**
 * The crowded scene: one deterministic set of notes, dense enough that naive placement overlaps.
 *
 * Layout work is graded against this and nothing else — the demo page, the vitest overlap
 * assertions and the Playwright orbit all import from here so "the crowded scene" means exactly
 * one thing. Pure numbers: no three.js, no DOM, no `viewleader`, so a node-environment test
 * can import it without dragging a renderer in.
 */

export interface Vec3Like { readonly x: number; readonly y: number; readonly z: number }

export interface CrowdedNote {
  readonly id: string;
  readonly text: string;
  /** World point, in the mock building's coordinates (see `mockBuilding.ts`). */
  readonly point: Vec3Like;
}

/**
 * The awkward cases the plain notes above cannot express, pinned by the goal's oracle spec: a
 * three-leg keynote, region anchors, manual placements, and a markdown label. Kept as plain data
 * with a `kind` discriminator so this module stays free of `viewleader` — a node-environment
 * test has to be able to import it without dragging a runtime in — and each consumer maps them to
 * whatever draft shape it needs.
 *
 * A scene of twenty-four identical single-leg plain notes is an easy scene. Every one of these
 * exercises a different part of layout: shared shoulders, an anchor that is an outline rather than
 * a point, an immovable obstacle, and a label whose height is decided by wrapping.
 */
export type CrowdedExtra =
  | {
      readonly kind: 'multi-leg';
      readonly id: string;
      readonly text: string;
      /** Three legs into one label: the fan-in case. */
      readonly points: readonly [Vec3Like, Vec3Like, Vec3Like];
    }
  | {
      readonly kind: 'region';
      readonly id: string;
      readonly text: string;
      readonly shape: 'rectangle' | 'revision-cloud';
      readonly plane: { readonly origin: Vec3Like; readonly normal: Vec3Like; readonly xAxis: Vec3Like };
      /** Outline in plane coordinates. */
      readonly vertices: readonly { readonly x: number; readonly y: number }[];
      readonly fallbackPoint: Vec3Like;
    }
  | {
      readonly kind: 'manual';
      readonly id: string;
      readonly text: string;
      readonly point: Vec3Like;
      /** Screen position the user dragged it to, as a fraction of the viewport. */
      readonly at: { readonly x: number; readonly y: number };
    }
  | {
      readonly kind: 'markdown';
      readonly id: string;
      readonly source: string;
      readonly point: Vec3Like;
    };

/**
 * Mulberry32. Chosen over `Math.random()` because the whole point is reproducibility, and over an
 * LCG because a bad LCG's low bits are visibly periodic — which would cluster anchors into stripes
 * and make the scene easier than it looks.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Changing this changes every recorded overlap/creep number. Treat it as part of the fixture. */
export const CROWDED_SCENE_SEED = 0x5eed1eaf;

/** Twenty is the goal's floor; twenty-four leaves headroom without making the scene unreadable. */
export const CROWDED_SCENE_COUNT = 24;

/**
 * Real note text, not `Note 1..24`: label width drives packing, and uniform-width labels hide the
 * exact failure this scene exists to catch.
 */
const PHRASES = [
  'SUPPLY AIR — VERIFY IN FIELD',
  'FD-2 FIRE DAMPER',
  'SEE DETAIL 4/A501',
  'TYP. OF 6',
  'CONFIRM CLR 2400 MIN',
  'EXIST. TO REMAIN',
  'GWB TYPE X BOTH SIDES',
  'RE: STRUCT.',
  'SLOPE 1:100 TO DRAIN',
  'COORD. W/ ELEC.',
  'ACOUSTIC SEAL — CONTINUOUS',
  'NOT IN CONTRACT',
] as const;

/**
 * Anchors ride the building shell — four walls, roof, and the floor line — so the notes read as
 * annotations on geometry rather than points in space. The shell is ~6.6 m across and the labels
 * are ~90 px wide, so at any normal camera distance the naive placement overlaps.
 */
export function crowdedScene(
  count: number = CROWDED_SCENE_COUNT,
  seed: number = CROWDED_SCENE_SEED,
): readonly CrowdedNote[] {
  const random = mulberry32(seed);
  const notes: CrowdedNote[] = [];
  for (let index = 0; index < count; index += 1) {
    const face = index % 6;
    const u = random() * 2 - 1; // −1..1 along the face
    const v = random(); // 0..1 up the face
    const point =
      face === 0 ? { x: u * 2.8, y: 0.4 + v * 4.2, z: 3.05 }
      : face === 1 ? { x: u * 2.8, y: 0.4 + v * 4.2, z: -3.05 }
      : face === 2 ? { x: 3.05, y: 0.4 + v * 4.2, z: u * 2.8 }
      : face === 3 ? { x: -3.05, y: 0.4 + v * 4.2, z: u * 2.8 }
      : face === 4 ? { x: u * 3, y: 5.2, z: (v * 2 - 1) * 3 }
      : { x: u * 3, y: 0.05, z: (v * 2 - 1) * 3 };
    notes.push({
      id: `crowd-${String(index).padStart(2, '0')}`,
      text: PHRASES[index % PHRASES.length] ?? 'NOTE',
      point,
    });
  }
  return notes;
}

/** Front wall plane, used by both regions so their outlines sit on drawable geometry. */
const FRONT_WALL = {
  origin: { x: 0, y: 0, z: 3.05 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
} as const;

/**
 * The pinned oracle's awkward cases. Fixed rather than seeded: each one exists to hit a specific
 * code path, and a seed that happened to place them somewhere easy would quietly stop testing it.
 *
 * The two anchors at |z| ≈ 3 on opposite faces are the frustum-exit pair — under a projection that
 * reports `visible: false` behind the camera, each leaves the view for roughly half of a 360° orbit,
 * so the scene loses and regains labels mid-orbit rather than only being crowded.
 */
export function crowdedExtras(): readonly CrowdedExtra[] {
  return [
    {
      kind: 'multi-leg',
      id: 'crowd-keynote',
      text: 'K-12 TYP. ALL THREE BAYS',
      points: [
        { x: -2.4, y: 3.6, z: 3.05 },
        { x: 0, y: 3.6, z: 3.05 },
        { x: 2.4, y: 3.6, z: 3.05 },
      ],
    },
    {
      kind: 'region',
      id: 'crowd-region-rect',
      text: 'REWORK THIS PANEL',
      shape: 'rectangle',
      plane: FRONT_WALL,
      vertices: [{ x: -2.2, y: 1.2 }, { x: -0.6, y: 1.2 }, { x: -0.6, y: 2.4 }, { x: -2.2, y: 2.4 }],
      fallbackPoint: { x: -1.4, y: 1.8, z: 3.05 },
    },
    {
      kind: 'region',
      id: 'crowd-region-cloud',
      text: 'RFI 041 — CLARIFY',
      shape: 'revision-cloud',
      plane: FRONT_WALL,
      vertices: [{ x: 0.6, y: 1.2 }, { x: 2.2, y: 1.2 }, { x: 2.2, y: 2.6 }, { x: 0.6, y: 2.6 }],
      fallbackPoint: { x: 1.4, y: 1.9, z: 3.05 },
    },
    {
      kind: 'manual',
      id: 'crowd-manual-a',
      text: 'HOLD FOR OWNER DECISION',
      point: { x: -3.05, y: 2.2, z: 0 },
      at: { x: 0.07, y: 0.12 },
    },
    {
      kind: 'manual',
      id: 'crowd-manual-b',
      text: 'SEE SHEET A-402',
      point: { x: 3.05, y: 2.2, z: 0 },
      at: { x: 0.72, y: 0.12 },
    },
    {
      kind: 'markdown',
      id: 'crowd-markdown',
      source:
        'Duct penetration requires a **fire-rated** sleeve.\n\n'
        + 'Confirm the rating with the fire engineer before the wall is closed, and record the '
        + 'result on the coordination sheet.',
      point: { x: 0, y: 0.9, z: -3.05 },
    },
  ];
}
