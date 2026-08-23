/**
 * Scene A, built once, so every test that claims to grade "the crowded scene" grades the same
 * drawing. It was inlined in `v1-crowded-scene.test.ts` until the geometric regression snapshot
 * needed it too, and two copies of a fixture that is supposed to be an oracle is exactly how an
 * oracle stops being one.
 *
 * Pinned by `issues/GOAL-maturity.md`: ≥20 annotations, deterministic seed, a three-leg keynote,
 * two region anchors, two manual placements, a markdown label, anchors that leave the frustum
 * during the orbit, and a wide-short viewport variant.
 */
import { markdownPlugin } from 'viewleader/markdown';
import { ViewLeader, type HostAdapterBundle, type LayoutStrategies } from 'viewleader';
import { crowdedDrafts } from '../demo/src/shared/crowdedDrafts.js';

export const VIEWPORT = { width: 900, height: 640 };
/**
 * Pixels per world metre. 42 puts the ~6.6 m building in a 277 px box — a realistic working
 * distance, and the middle of the range where the baseline showed the defect. Zoomed far in the old
 * code was already nearly clean, so grading there would have proved nothing.
 */
export const SCALE = 42;
export const ORBIT_STEPS = 36;

export interface Box { x: number; y: number; width: number; height: number }

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function overlappingPairs(boxes: readonly (Box & { id: string })[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < boxes.length; i += 1)
    for (let j = i + 1; j < boxes.length; j += 1)
      if (overlaps(boxes[i]!, boxes[j]!)) pairs.push(`${boxes[i]!.id}×${boxes[j]!.id}`);
  return pairs;
}

/**
 * A yaw-rotating projection: orbiting the camera is the same thing as spinning the world here.
 *
 * `visible` follows the depth sign, so an anchor on the far side of the building genuinely leaves
 * the view and comes back over a full orbit. The oracle spec requires that — a scene where every
 * anchor is visible in every frame never exercises the appear/disappear path at all.
 */
function projectionAt(yaw: number, viewport: { width: number; height: number }): HostAdapterBundle['projection'] {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    getViewport: () => ({ ...viewport, devicePixelRatio: 1 }),
    project: (p) => {
      const depth = p.x * sin + p.z * cos;
      return {
        point: { x: viewport.width / 2 + (p.x * cos - p.z * sin) * SCALE, y: viewport.height - 100 - p.y * SCALE },
        depth,
        visible: depth > -3.2,
      };
    },
    getRevision: () => yaw,
  };
}

export interface CrowdedSceneHandle {
  readonly leader: ViewLeader;
  readonly root: HTMLElement;
  readonly ids: readonly string[];
  orbitTo(yaw: number): void;
  boxes(): (Box & { id: string })[];
}

/**
 * Scene A, to the pinned spec: 24 seeded plain notes plus a three-leg keynote, two region anchors,
 * two manual placements and a markdown label — 30 annotations in all.
 *
 * `strategies` is the seam the geometric regression test perturbs through: it is the only public
 * way to move one label by a known number of pixels without editing layout.
 */
export function scene(
  viewport: { width: number; height: number } = VIEWPORT,
  strategies?: LayoutStrategies,
): CrowdedSceneHandle {
  const root = document.createElement('div');
  document.body.appendChild(root);
  let yaw = 0;
  const leader = new ViewLeader({
    boundary: root,
    plugins: [markdownPlugin],
    ...(strategies === undefined ? {} : { strategies }),
    adapters: {
      projection: {
        getViewport: () => ({ ...viewport, devicePixelRatio: 1 }),
        project: (point, port) => projectionAt(yaw, viewport).project(point, port),
        getRevision: () => yaw,
      },
      modelBounds: { get: () => ({ min: { x: -3.3, y: 0, z: -3.3 }, max: { x: 3.3, y: 5.2, z: 3.3 } }) },
    },
  });
  const ids: string[] = [];
  for (const draft of crowdedDrafts(viewport)) {
    leader.annotations.create(draft);
    ids.push(draft.id!);
  }
  leader.update();
  return {
    leader,
    root,
    ids,
    orbitTo(next) { yaw = next; leader.update(); },
    boxes() {
      const found: (Box & { id: string })[] = [];
      for (const id of ids) {
        const geometry = leader.geometry.of(id);
        if (geometry !== undefined) found.push({ id, ...geometry.label });
      }
      return found;
    },
  };
}
