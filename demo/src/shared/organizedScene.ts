import type { AnnotationDraft } from 'viewleader';

/** The mirrored pattern on the wall's front surface, shared by the demo and orbit regression. */
export function createOrganizedAnnotations(): AnnotationDraft[] {
  const drafts: AnnotationDraft[] = [];
  const clusters = [
    { x: -2.9, y: 3.9, z: 3.1, name: 'North-west' },
    { x: 2.9, y: 3.9, z: 3.1, name: 'North-east' },
    { x: -2.9, y: 1.1, z: 3.1, name: 'South-west' },
    { x: 2.9, y: 1.1, z: 3.1, name: 'South-east' },
  ];
  for (const cluster of clusters) {
    // One edge-near anchor, one beside it, then two deeper anchors. Reflect both axes so the
    // geometry itself, as well as the label names, mirrors the four-quadrant sketch.
    const inwardX = cluster.x < 0 ? 1 : -1;
    const inwardY = cluster.y > 2.5 ? -1 : 1;
    const offsets = [[0, 0], [0.28 * inwardX, 0.18 * inwardY], [0.72 * inwardX, 0.48 * inwardY], [1.08 * inwardX, 0.78 * inwardY]] as const;
    for (const [index, offset] of offsets.entries()) {
      drafts.push({
        id: `${cluster.name.toLowerCase().replaceAll('-', '')}-${index + 1}`,
        anchor: { kind: 'world-point', point: { x: cluster.x + offset[0], y: cluster.y + offset[1], z: cluster.z } },
        content: { kind: 'callout', title: `${cluster.name} detail ${index + 1}`, text: 'Model reference' },
      });
    }
  }
  return drafts;
}
