/**
 * Scene A as ViewLeader drafts — the one mapping, used by the workbench page and by the tests.
 *
 * Split from `crowdedScene.ts` because that file must stay free of the `viewleader` runtime so a
 * node-environment test can import it without dragging one in. This one is allowed the
 * dependency, and having it in one place is what stops the demo's "crowded scene" and the test
 * suite's from quietly drifting into two different drawings — which is exactly what happened when
 * the button built twenty-four plain notes and vitest graded thirty.
 */
import type { AnnotationDraft } from 'viewleader';
import { crowdedExtras, crowdedScene, type CrowdedExtra } from './crowdedScene';

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
            // `at` is a viewport fraction, so the pinned label lands in the same relative place
            // whatever size the window is — a pixel constant would put it somewhere else on a laptop.
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

/** The full pinned scene: 24 seeded plain notes plus the six awkward cases the oracle requires. */
export function crowdedDrafts(viewport: { width: number; height: number }): readonly AnnotationDraft[] {
  return [
    ...crowdedScene().map((note): AnnotationDraft => ({
      id: note.id,
      anchor: { kind: 'world-point', point: note.point },
      content: { kind: 'plain-note', text: note.text },
    })),
    ...crowdedExtras().map((extra) => draftFor(extra, viewport)),
  ];
}
