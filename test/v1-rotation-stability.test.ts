/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { OrthographicCamera } from 'three';
import {
  ViewLeader,
  type OcclusionResult,
  type OcclusionSample,
} from 'viewleader';
import { createThreeAdapter } from 'viewleader/three';

const active: ViewLeader[] = [];
afterEach(() => {
  for (const leader of active.splice(0)) leader.dispose();
  document.body.replaceChildren();
});

function cameraFixture(occlusion?: (samples: readonly OcclusionSample[]) => Promise<readonly OcclusionResult[]>) {
  const camera = new OrthographicCamera(-4, 4, 2, -2, 0.1, 100);
  const pointCameraAtOwnHeight = (y: number): void => {
    camera.position.set(0, y, 5);
    camera.lookAt(0, y, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };
  pointCameraAtOwnHeight(0);
  const root = document.createElement('div');
  document.body.append(root);
  const base = createThreeAdapter({
    camera,
    viewport: () => ({ width: 800, height: 400, devicePixelRatio: 1 }),
  });
  const leader = new ViewLeader({
    boundary: root,
    adapters: { ...base, ...(occlusion === undefined ? {} : { occlusion: { test: occlusion } }) },
  });
  active.push(leader);
  const projectedOriginY = (): number => base.projection.project({ x: 0, y: 0, z: 0 }, base.projection.getViewport())!.point.y;
  return { camera, leader, root, pointCameraAtOwnHeight, projectedOriginY };
}

function createFixedDogleg(leader: ViewLeader, id = 'note'): void {
  leader.annotations.create({
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'callout', title: 'FIRST BASELINE', text: 'LAST BASELINE' },
    placement: { kind: 'manual', position: { x: 540, y: 170 } },
    routing: { kind: 'automatic', mode: 'dogleg' },
  });
}

function geometry(leader: ViewLeader, id = 'note') {
  const value = leader.geometry.of(id);
  if (value === undefined) throw new Error(`Missing geometry for ${id}`);
  return value;
}

function endpointY(leader: ViewLeader, id = 'note'): number {
  return geometry(leader, id).legs[0]!.at(-1)!.y;
}

function anchorY(leader: ViewLeader, id = 'note'): number {
  return geometry(leader, id).legs[0]![0]!.y;
}

describe('leader stability under real Three camera motion', () => {
  it('holds one text baseline through epsilon and visible sub-margin camera jitter, then switches once across the margin', () => {
    const { leader, pointCameraAtOwnHeight, projectedOriginY } = cameraFixture();
    createFixedDogleg(leader);
    leader.update();
    const centreY = geometry(leader).label.y + geometry(leader).label.height / 2;
    // This orthographic camera maps one world unit to 100 CSS pixels in the 400 px viewport.
    const tiedCameraY = (centreY - 200) / 100;
    const updateAtPixelsFromCentre = (pixels: number): void => {
      pointCameraAtOwnHeight(tiedCameraY + pixels / 100);
      leader.update();
    };

    updateAtPixelsFromCentre(3);
    const initialEndpoint = endpointY(leader);
    const jitteredAnchors: number[] = [];
    const projectedAnchors: number[] = [];
    for (let frame = 0; frame < 100; frame += 1) {
      // Includes the plan's numerical epsilon repro and a visible 1 px peak-to-peak residual
      // camera motion. A tie-only tolerance cannot pass this sequence.
      const offset = frame < 2 ? (frame === 0 ? -1e-9 : 1e-9) : (frame % 2 === 0 ? -0.5 : 0.5);
      updateAtPixelsFromCentre(offset);
      jitteredAnchors.push(anchorY(leader));
      projectedAnchors.push(projectedOriginY());
      expect(endpointY(leader)).toBe(initialEndpoint);
    }
    // The rendered route starts at the trimmed terminator tip, while the adapter projection is the
    // true anchor. Check both so a stable endpoint cannot be explained by a frozen projection.
    expect(Math.max(...projectedAnchors) - Math.min(...projectedAnchors)).toBeGreaterThanOrEqual(0.99);
    expect(Math.max(...jitteredAnchors) - Math.min(...jitteredAnchors)).toBeGreaterThan(0.8);

    const endpoints = [endpointY(leader)];
    updateAtPixelsFromCentre(-3);
    endpoints.push(endpointY(leader));
    for (let frame = 0; frame < 40; frame += 1) {
      updateAtPixelsFromCentre(-3 + (frame % 2 === 0 ? -0.5 : 0.5));
      endpoints.push(endpointY(leader));
    }
    const switches = endpoints.slice(1).filter((value, index) => value !== endpoints[index]).length;
    expect(switches).toBe(1);
    expect(endpoints.at(-1)).not.toBe(initialEndpoint);
  });

  it('keeps a multileader on one shared tail while its average anchor crosses the tie', () => {
    const { leader, pointCameraAtOwnHeight } = cameraFixture();
    leader.annotations.create({
      id: 'fan',
      anchors: [
        { id: 'upper', anchor: { kind: 'world-point', point: { x: -0.2, y: 0.35, z: 0 } }, routing: { kind: 'automatic', mode: 'dogleg' } },
        { id: 'lower', anchor: { kind: 'world-point', point: { x: 0.2, y: -0.35, z: 0 } }, routing: { kind: 'automatic', mode: 'dogleg' } },
      ],
      content: { kind: 'callout', title: 'SHARED', text: 'TAIL' },
      placement: { kind: 'manual', position: { x: 540, y: 170 } },
    });
    leader.update();
    const centreY = geometry(leader, 'fan').label.y + geometry(leader, 'fan').label.height / 2;
    const tiedCameraY = (centreY - 200) / 100;
    pointCameraAtOwnHeight(tiedCameraY + 3 / 100);
    leader.update();
    const initialEndpoint = geometry(leader, 'fan').legs[0]!.at(-1)!.y;
    const endpoints: number[] = [initialEndpoint];
    for (let frame = 0; frame < 100; frame += 1) {
      pointCameraAtOwnHeight(tiedCameraY + (frame % 2 === 0 ? -0.005 : 0.005));
      leader.update();
      const legs = geometry(leader, 'fan').legs;
      expect(legs[0]!.slice(-2)).toEqual(legs[1]!.slice(-2));
      endpoints.push(legs[0]!.at(-1)!.y);
    }
    expect(new Set(endpoints)).toEqual(new Set([initialEndpoint]));
    pointCameraAtOwnHeight(tiedCameraY - 3 / 100);
    leader.update();
    expect(geometry(leader, 'fan').legs[0]!.at(-1)!.y).not.toBe(initialEndpoint);
  });

  it('clears attachment memory when a document replacement reuses the same annotation id', () => {
    const seeded = cameraFixture();
    createFixedDogleg(seeded.leader);
    seeded.leader.update();
    const centreY = geometry(seeded.leader).label.y + geometry(seeded.leader).label.height / 2;
    const tiedCameraY = (centreY - 200) / 100;
    seeded.pointCameraAtOwnHeight(tiedCameraY + 3 / 100);
    seeded.leader.update();
    const rememberedLast = endpointY(seeded.leader);

    const fresh = cameraFixture();
    createFixedDogleg(fresh.leader);
    fresh.pointCameraAtOwnHeight(tiedCameraY);
    fresh.leader.update();
    const deterministicTie = endpointY(fresh.leader);
    expect(deterministicTie).not.toBe(rememberedLast);

    const replacement = seeded.leader.documents.serialize();
    seeded.leader.documents.replace(replacement);
    seeded.pointCameraAtOwnHeight(tiedCameraY);
    seeded.leader.update();
    expect(endpointY(seeded.leader)).toBe(deterministicTie);
  });

  it('keeps geometry frozen across 300 updates and a delayed occlusion commit', async () => {
    let resolveBatch!: (results: readonly OcclusionResult[]) => void;
    let samples: readonly OcclusionSample[] = [];
    const pending = new Promise<readonly OcclusionResult[]>((resolve) => { resolveBatch = resolve; });
    const { leader } = cameraFixture(async (next) => { samples = next; return pending; });
    createFixedDogleg(leader);
    leader.update();
    const stopped = structuredClone(geometry(leader));
    for (let frame = 0; frame < 300; frame += 1) {
      leader.update();
      expect(geometry(leader)).toEqual(stopped);
    }
    expect(samples).toHaveLength(1);
    resolveBatch(samples.map((sample) => ({ ...sample, occluded: true })));
    await Promise.resolve();
    await Promise.resolve();
    leader.update();
    expect(geometry(leader)).toEqual(stopped);
  });
});
