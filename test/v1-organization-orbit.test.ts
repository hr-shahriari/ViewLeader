/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { ViewLeader, type Rect, type Vec2, type Vec3 } from 'viewleader';
import { createThreeAdapter } from 'viewleader/three';
import { createMockBuilding } from '../demo/src/shared/mockBuilding.js';
import { createOrganizedAnnotations } from '../demo/src/shared/organizedScene.js';
import { segmentThroughInterior } from '../src/lint.js';

const active: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const item of active.splice(0)) item.dispose();
  document.body.replaceChildren();
});

const viewport = { width: 900, height: 640, devicePixelRatio: 1 };

function orbit(camera: PerspectiveCamera, degrees: number): void {
  const radians = degrees * Math.PI / 180;
  camera.position.set(Math.sin(radians) * 26, 7, Math.cos(radians) * 26);
  camera.lookAt(0, 2.5, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

function corners(min: Vec3, max: Vec3): Vec3[] {
  return [
    { x: min.x, y: min.y, z: min.z }, { x: max.x, y: min.y, z: min.z },
    { x: min.x, y: max.y, z: min.z }, { x: max.x, y: max.y, z: min.z },
    { x: min.x, y: min.y, z: max.z }, { x: max.x, y: min.y, z: max.z },
    { x: min.x, y: max.y, z: max.z }, { x: max.x, y: max.y, z: max.z },
  ];
}

/** Independent from ViewLeader's adapter: raw Three projection of all eight model AABB corners. */
function projectAabb(camera: PerspectiveCamera, min: Vec3, max: Vec3): { min: Vec2; max: Vec2 } {
  return bounds(corners(min, max).map((corner) => {
    const point = new Vector3(corner.x, corner.y, corner.z).project(camera);
    return { x: (point.x + 1) * viewport.width / 2, y: (1 - point.y) * viewport.height / 2 };
  }));
}

function bounds(points: readonly Vec2[]): { min: Vec2; max: Vec2 } {
  return {
    min: { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)) },
    max: { x: Math.max(...points.map((point) => point.x)), y: Math.max(...points.map((point) => point.y)) },
  };
}

function clears(label: Rect, frame: { min: Vec2; max: Vec2 }): boolean {
  return label.x + label.width <= frame.min.x || label.x >= frame.max.x
    || label.y + label.height <= frame.min.y || label.y >= frame.max.y;
}

describe('quadrant organization over the organized-leaders demo orbit', () => {
  it.each([[90, 'left'], [270, 'right']] as const)(
    'keeps the foreshortened front-face cluster in a compact %s-side exterior fan', (angle, side) => {
    const building = createMockBuilding();
    const camera = new PerspectiveCamera(38, viewport.width / viewport.height, 0.1, 200);
    const boundary = document.createElement('div');
    document.body.append(boundary);
    const adapter = createThreeAdapter({ camera, viewport: () => viewport, modelBounds: () => [building.root] });
    const leader = new ViewLeader({ boundary, adapters: adapter });
    active.push({ dispose: () => { leader.dispose(); building.dispose(); } });
    leader.setAnnotationScale(0.75);
    leader.setPlacementMode('quadrants');
    leader.setKeepLabelsOutsideModel(true);
    const drafts = createOrganizedAnnotations();
    for (const draft of drafts) leader.annotations.create(draft);

    orbit(camera, angle);
    leader.update();
    const world = adapter.modelBounds!.get()!;
    // The mock building is a 6.6 m square shell from ground to the 5.2 m roof. Pin the adapter's
    // world AABB before independently projecting its corners, so a face/anchor-cloud bounds bug
    // cannot agree with its own projected result.
    expect(world.min.x).toBeCloseTo(-3.3, 5);
    expect(world.min.y).toBeCloseTo(0, 5);
    expect(world.min.z).toBeCloseTo(-3.3, 5);
    expect(world.max.x).toBeCloseTo(3.3, 5);
    expect(world.max.y).toBeCloseTo(5.2, 5);
    expect(world.max.z).toBeCloseTo(3.3, 5);
    const frame = projectAabb(camera, world.min, world.max);
    const geometry = drafts.map((draft) => leader.geometry.of(draft.id!)!);
    const anchorExtent = bounds(geometry.map(({ legs }) => legs[0]![0]!));

    expect(anchorExtent.max.x - anchorExtent.min.x).toBeLessThan((frame.max.x - frame.min.x) / 4);
    expect(geometry.every(({ label }) => clears(label, frame))).toBe(true);
    expect(geometry.flatMap(({ legs }) => legs).some((leg, index, legs) =>
      legs.some((other, otherIndex) => index !== otherIndex && other.slice(1).some((point, segmentIndex) =>
        segmentThroughInterior({ start: other[segmentIndex]!, end: point }, geometry[index]!.label))))).toBe(false);
    for (const { legs } of geometry) {
      const [anchor, first] = legs[0]!;
      expect(first!.y).toBeCloseTo(anchor!.y, 6);
      expect(first!.x).toBeCloseTo(side === 'left' ? frame.min.x : frame.max.x, 6);
    }
  });
});
