/**
 * Scene B — `adversarial`, the oracle's second scene.
 *
 * The goal pins scene B as "authored by whoever is *not* implementing the phase", because an agent
 * can author a scene its own layout passes. I am implementing the phase, so the composition is not
 * mine to choose: the seed is picked by a search that scores every candidate against the CURRENT
 * implementation and keeps the worst one (`test/adversarial-seed-search.ts`). The distribution below
 * is chosen to be structurally different from scene A rather than to be easy or hard — scene A
 * spreads anchors evenly over six faces, this one clusters them, which is how real markup arrives:
 * a reviewer covers one detail, then another, and leaves the rest of the model bare.
 *
 * That does not fully satisfy the constraint — a human or another agent should still review it — but
 * a scene whose difficulty was selected by search against the implementation is a much weaker thing
 * for the implementation to have gamed than one I tuned by eye. Recorded so the difference is
 * visible rather than glossed over.
 *
 * Pure numbers, no `viewleader`, for the same reason as `crowdedScene.ts`.
 */
import type { CrowdedExtra, CrowdedNote, Vec3Like } from './crowdedScene';

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

/**
 * Chosen by search, not by me. Forty candidate seeds were scored against the CURRENT implementation
 * over a full orbit — `10 × overlapping pairs + 5 × leader-through-label + leader-crossing`, all at
 * their worst frame — and the highest-scoring one is pinned here. It beat the median candidate
 * comfortably and is far harder than scene A: 26 overlapping pairs against 1, 21 through-label
 * findings against 3, 93 crossings against 51.
 *
 * This is the closest I can honestly get to the oracle's "authored by whoever is not implementing
 * the phase". I chose the DISTRIBUTION (clustered, which is how real markup arrives); the search
 * chose the difficulty, using my own layout as the thing to defeat. A reviewer should still look at
 * it, and `test/v1-adversarial-scene.test.ts` says so.
 */
export const ADVERSARIAL_SCENE_SEED = 0x0001eaa5;
export const ADVERSARIAL_SCENE_COUNT = 26;

/** Longer and shorter than scene A's, so label widths vary more and pack worse. */
const PHRASES = [
  'RE: MECH — SEE COORDINATION DRAWING M-501 FOR FULL ROUTING',
  'TYP.',
  'FIRE STOP ALL PENETRATIONS — 2 HR RATED ASSEMBLY THROUGHOUT',
  'NIC',
  'VERIFY DIMENSION IN FIELD PRIOR TO FABRICATION',
  'EQ',
  'PROVIDE ACCESS PANEL 600 x 600 MIN',
  'HOLD',
  'MATCH EXISTING ADJACENT FINISH',
  'SIM',
] as const;

/**
 * Three tight clusters plus a scatter. Clustering is the hard case the even spread of scene A never
 * produces: a dozen anchors inside one screen-space handspan all want the same few label slots, so
 * the placer's overflow columns and the separation pass are both driven far harder.
 */
export function adversarialScene(
  count: number = ADVERSARIAL_SCENE_COUNT,
  seed: number = ADVERSARIAL_SCENE_SEED,
): readonly CrowdedNote[] {
  const random = mulberry32(seed);
  const clusters: readonly Vec3Like[] = [
    { x: -2.2, y: 3.8, z: 3.05 },
    { x: 3.05, y: 1.2, z: -1.4 },
    { x: 1.6, y: 0.3, z: 3.05 },
  ];
  const notes: CrowdedNote[] = [];
  for (let index = 0; index < count; index += 1) {
    // Three quarters cluster tightly; the rest scatter over the shell so the scene is not uniform.
    const clustered = index % 4 !== 3;
    const base = clusters[index % clusters.length]!;
    const spread = clustered ? 0.55 : 3.0;
    const point = {
      x: base.x + (random() * 2 - 1) * spread,
      y: Math.max(0.05, base.y + (random() * 2 - 1) * spread),
      z: base.z + (random() * 2 - 1) * (clustered ? 0.35 : spread),
    };
    notes.push({
      id: `adv-${String(index).padStart(2, '0')}`,
      text: PHRASES[index % PHRASES.length] ?? 'NOTE',
      point,
    });
  }
  return notes;
}

const BACK_WALL = {
  origin: { x: 0, y: 0, z: -3.05 },
  normal: { x: 0, y: 0, z: -1 },
  xAxis: { x: 1, y: 0, z: 0 },
} as const;

/** The oracle's required awkward cases again, placed inside the clusters where they hurt most. */
export function adversarialExtras(): readonly CrowdedExtra[] {
  return [
    {
      kind: 'multi-leg',
      id: 'adv-keynote',
      text: 'K-07 SEE SCHEDULE',
      // All three legs inside one cluster, so the fan-in has to share a shoulder in a crowd.
      points: [
        { x: -2.6, y: 3.4, z: 3.05 },
        { x: -1.9, y: 4.1, z: 3.05 },
        { x: -2.9, y: 4.3, z: 3.05 },
      ],
    },
    {
      kind: 'region',
      id: 'adv-region-rect',
      text: 'DEMO THIS BAY',
      shape: 'rectangle',
      plane: BACK_WALL,
      vertices: [{ x: -2.6, y: 0.6 }, { x: -0.4, y: 0.6 }, { x: -0.4, y: 3.2 }, { x: -2.6, y: 3.2 }],
      fallbackPoint: { x: -1.5, y: 1.9, z: -3.05 },
    },
    {
      kind: 'region',
      id: 'adv-region-cloud',
      // Deliberately overlapping the rectangle's span: two regions competing for one label slot.
      text: 'RFI 112',
      shape: 'revision-cloud',
      plane: BACK_WALL,
      vertices: [{ x: -1.2, y: 1.4 }, { x: 1.8, y: 1.4 }, { x: 1.8, y: 3.6 }, { x: -1.2, y: 3.6 }],
      fallbackPoint: { x: 0.3, y: 2.5, z: -3.05 },
    },
    {
      kind: 'manual',
      id: 'adv-manual-a',
      text: 'PINNED — DO NOT MOVE',
      point: { x: -3.05, y: 4.4, z: 1.2 },
      // Both pins in the SAME corner, so they eat one column rather than one each.
      at: { x: 0.62, y: 0.08 },
    },
    {
      kind: 'manual',
      id: 'adv-manual-b',
      text: 'ALSO PINNED',
      point: { x: 3.05, y: 4.4, z: -1.2 },
      at: { x: 0.66, y: 0.2 },
    },
    {
      kind: 'markdown',
      id: 'adv-markdown',
      // Longer than scene A's, so the tall-label problem is worse rather than merely present.
      source:
        'Coordinate **all** services in this zone before pouring.\n\n'
        + 'The contractor is to confirm every clearance against the latest structural set, record '
        + 'the results on the coordination sheet, and raise an RFI for any dimension that cannot be '
        + 'met without moving a duct.',
      point: { x: 1.4, y: 0.5, z: 3.05 },
    },
  ];
}
