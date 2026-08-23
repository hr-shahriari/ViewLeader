/**
 * Scene B, built the same way scene A is, so both are graded by identical code.
 *
 * Kept beside `crowded-scene-harness.ts` rather than merged into it: the two scenes must be able to
 * differ in composition without one quietly inheriting the other's fixes.
 */
import { markdownPlugin } from 'viewleader/markdown';
import { ViewLeader, type AnnotationDraft, type HostAdapterBundle } from 'viewleader';
import {
  ADVERSARIAL_SCENE_SEED,
  adversarialExtras,
  adversarialScene,
} from '../demo/src/shared/adversarialScene.js';
import type { CrowdedExtra } from '../demo/src/shared/crowdedScene.js';
import { SCALE, VIEWPORT, type Box } from './crowded-scene-harness.js';

function draftFor(extra: CrowdedExtra, viewport: { width: number; height: number }): AnnotationDraft {
  return extra.kind === 'multi-leg'
    ? {
        id: extra.id,
        anchors: extra.points.map((point, index) => ({
          id: `leg-${index + 1}`,
          anchor: { kind: 'world-point' as const, point },
          routing: { kind: 'automatic' as const, mode: 'dogleg' as const },
        })),
        content: { kind: 'plain-note', text: extra.text },
      }
    : extra.kind === 'region'
      ? {
          id: extra.id,
          anchor: {
            kind: 'region' as const,
            plane: extra.plane,
            vertices: extra.vertices,
            shape: extra.shape,
            fallbackPoint: extra.fallbackPoint,
          },
          content: { kind: 'plain-note', text: extra.text },
        }
      : extra.kind === 'manual'
        ? {
            id: extra.id,
            anchor: { kind: 'world-point' as const, point: extra.point },
            content: { kind: 'plain-note', text: extra.text },
            placement: {
              kind: 'manual' as const,
              position: { x: extra.at.x * viewport.width, y: extra.at.y * viewport.height },
            },
          }
        : {
            id: extra.id,
            anchor: { kind: 'world-point' as const, point: extra.point },
            content: {
              kind: 'plugin:viewleader.markdown' as const,
              pluginId: 'viewleader.markdown',
              schemaVersion: 2,
              data: { source: extra.source },
            },
          };
}

export interface AdversarialSceneHandle {
  readonly leader: ViewLeader;
  readonly ids: readonly string[];
  orbitTo(yaw: number): void;
  boxes(): (Box & { id: string })[];
}

export function adversarial(
  viewport: { width: number; height: number } = VIEWPORT,
  seed: number = ADVERSARIAL_SCENE_SEED,
): AdversarialSceneHandle {
  const root = document.createElement('div');
  document.body.appendChild(root);
  let yaw = 0;
  const project: HostAdapterBundle['projection']['project'] = (p) => {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const depth = p.x * sin + p.z * cos;
    return {
      point: { x: viewport.width / 2 + (p.x * cos - p.z * sin) * SCALE, y: viewport.height - 100 - p.y * SCALE },
      depth,
      visible: depth > -3.2,
    };
  };
  const leader = new ViewLeader({
    boundary: root,
    plugins: [markdownPlugin],
    adapters: {
      projection: {
        getViewport: () => ({ ...viewport, devicePixelRatio: 1 }),
        project,
        getRevision: () => yaw,
      },
      modelBounds: { get: () => ({ min: { x: -3.3, y: 0, z: -3.3 }, max: { x: 3.3, y: 5.2, z: 3.3 } }) },
    },
  });
  const ids: string[] = [];
  for (const note of adversarialScene(undefined, seed)) {
    leader.annotations.create({
      id: note.id,
      anchor: { kind: 'world-point', point: note.point },
      content: { kind: 'plain-note', text: note.text },
    });
    ids.push(note.id);
  }
  for (const extra of adversarialExtras()) {
    leader.annotations.create(draftFor(extra, viewport));
    ids.push(extra.id);
  }
  leader.update();
  return {
    leader,
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
