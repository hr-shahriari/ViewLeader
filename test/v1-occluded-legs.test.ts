/**
 * Ticket `issues/occlusion/01` — a leg whose anchor is behind geometry must not draw exactly like
 * one that is not, and a leader break must survive the frame after the one that drew it.
 *
 * Both are DOM assertions on purpose. `runtime.lintFrame` grades the plan, so neither the dash nor
 * the DIMBREAK gap is visible to it: the plan said "broken" and "occluded" on every frame while the
 * renderer drew a solid unbroken line.
 */
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import {
  ViewLeader,
  type HostAdapterBundle,
  type OcclusionResult,
  type OcclusionSample,
} from '../src/index.js';

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

/** `scale` is the camera: bumping it moves every route, which is what invalidates a batch. */
function adapters(scale: { value: number }, overrides: Partial<HostAdapterBundle> = {}): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
      project: (point) => ({
        point: { x: 400 + point.x * scale.value, y: 300 - point.y * scale.value },
        depth: point.z,
        visible: Math.abs(point.x) < 100 && Math.abs(point.y) < 100,
      }),
    },
    ...overrides,
  };
}

function routePaths(root: HTMLElement, id: string): SVGPathElement[] {
  return [...root.querySelectorAll<SVGPathElement>(
    `[data-annotation-id="${id}"] path[data-route-visible]`,
  )];
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('a leader break survives the frame after the one that drew it', () => {
  it('keeps the DIMBREAK gaps on the second update', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters({ value: 10 }) });
    leader.annotations.create({
      id: 'crossed',
      anchor: { kind: 'world-point', point: { x: -30, y: 0, z: 0 } },
      content: { kind: 'tag', text: 'A' },
      placement: { kind: 'manual', position: { x: 620, y: 300 } },
      // Manual, so the obstacle-aware router cannot dodge the blocker and leave nothing to break.
      routing: { kind: 'manual', vertices: [{ x: 360, y: 300 }] },
    });
    leader.annotations.create({
      id: 'blocker',
      anchor: { kind: 'world-point', point: { x: 0, y: -20, z: 0 } },
      content: { kind: 'tag', text: 'B' },
      placement: { kind: 'manual', position: { x: 340, y: 288 } },
    });
    leader.update();
    const first = routePaths(root, 'crossed')[0]!.getAttribute('d')!;
    // Two subpaths is the break: one polyline would start with a single `M`.
    expect(first.match(/M/gu)).toHaveLength(2);
    leader.update();
    expect(routePaths(root, 'crossed')[0]!.getAttribute('d')).toBe(first);
    leader.dispose();
  });
});

function occludedScene(occludedLegIds: () => readonly string[], occlusion?: 'keep' | 'fade' | 'hide') {
  const scale = { value: 10 };
  const root = boundary();
  const test = vi.fn(async (samples: readonly OcclusionSample[]): Promise<readonly OcclusionResult[]> => {
    const buried = new Set(occludedLegIds());
    return samples.map((sample) => ({ ...sample, occluded: buried.has(sample.legId) }));
  });
  const leader = new ViewLeader({ boundary: root, adapters: adapters(scale, { occlusion: { test } }) });
  leader.annotations.create({
    id: 'keynote',
    anchors: [
      {
        id: 'buried',
        anchor: { kind: 'world-point', point: { x: -20, y: 0, z: 0 } },
        routing: { kind: 'automatic', mode: 'straight' },
      },
      {
        id: 'open',
        anchor: { kind: 'world-point', point: { x: -20, y: -10, z: 0 } },
        routing: { kind: 'automatic', mode: 'straight' },
      },
    ],
    content: { kind: 'tag', text: 'K' },
    placement: { kind: 'manual', position: { x: 600, y: 200 } },
    ...(occlusion === undefined ? {} : { occlusion }),
  });
  return { root, leader, scale };
}

/** The leg id each matching element belongs to, in paint order. */
function legIdsOf(root: HTMLElement, selector: string): (string | undefined)[] {
  return [...root.querySelectorAll<SVGElement>(`[data-annotation-id="keynote"] ${selector}`)]
    .map((element) => element.dataset.legId);
}

function opacities(root: HTMLElement): (string | null)[] {
  return routePaths(root, 'keynote').map((path) => path.getAttribute('stroke-opacity'));
}

function dashes(root: HTMLElement): (string | null)[] {
  return routePaths(root, 'keynote').map((path) => path.getAttribute('stroke-dasharray'));
}

describe('an occluded leg is dashed and its siblings are not', () => {
  it('dashes one leg, leaves the other solid, and keeps the label at full opacity under keep', async () => {
    const { root, leader } = occludedScene(() => ['buried']);
    leader.update();
    await settle();
    leader.update();
    expect(dashes(root)).toEqual(['6 4', null]);
    // Dashed AND dimmed. A dash on its own is a style choice — plenty of drafting styles dash by
    // convention — so the dim is what makes it read as "behind something".
    expect(opacities(root)).toEqual(['0.55', null]);
    // `keep` is the default and stays the default: the label is not faded, only the leg is dashed.
    expect(root.querySelector('[data-annotation-id="keynote"]')?.getAttribute('opacity')).toBe('1');
    // The hit path never carries the dash, or the leader would be hardest to click where it is
    // hardest to see.
    expect([...root.querySelectorAll('[data-annotation-id="keynote"] path[data-hit-target="leader"]')]
      .map((path) => path.getAttribute('stroke-dasharray'))).toEqual([null, null]);
    leader.dispose();
  });

  it('goes back to solid without recreating the group', async () => {
    let buried: readonly string[] = ['buried'];
    const { root, leader, scale } = occludedScene(() => buried);
    leader.update();
    await settle();
    leader.update();
    const group = root.querySelector('[data-annotation-id="keynote"]');
    expect(dashes(root)).toEqual(['6 4', null]);

    buried = [];
    // The routes have to move, or the signature still matches and no fresh batch is requested.
    scale.value = 12;
    leader.update();
    await settle();
    leader.update();
    expect(dashes(root)).toEqual([null, null]);
    expect(root.querySelector('[data-annotation-id="keynote"]')).toBe(group);
    leader.dispose();
  });

  it('still applies a completed verdict after the camera has moved on', async () => {
    const { root, leader, scale } = occludedScene(() => ['buried']);
    leader.update();
    await settle();
    // The camera moves on AFTER the verdict lands, and synchronously — an `await` here would let
    // the runtime's own post-batch update run first and re-request at the new signature, which is
    // exactly the frame this test must not be allowed to see.
    scale.value = 12;
    leader.update();
    // `batchSignature` hashes the screen routes, so the verdict is now stale. Stale is served.
    expect(dashes(root)).toEqual(['6 4', null]);
    leader.dispose();
  });
});

/**
 * Ticket `issues/occlusion/04` — `hide` already meant "not drawn while behind something"; per-leg
 * is the sentence it could not say about one leg. Implemented by dropping the leg from the plan, so
 * every one of these absences is free. Under a flag the leg would still be in `PlannedAnnotation.legs`
 * and every assertion naming `'buried'` below would find it.
 */
describe('hide drops the buried leg and keeps the rest of the annotation', () => {
  async function settled(leader: ViewLeader): Promise<void> {
    leader.update();
    await settle();
    leader.update();
  }

  it('draws one leg and one label, with nothing of the buried leg left behind', async () => {
    const { root, leader } = occludedScene(() => ['buried'], 'hide');
    await settled(leader);

    expect(legIdsOf(root, 'path[data-route-visible]')).toEqual(['open']);
    expect(legIdsOf(root, 'path[data-hit-target="leader"]')).toEqual(['open']);
    expect(legIdsOf(root, 'path[data-terminator]')).toEqual(['open']);
    // The grips are the ones a flag would have got wrong: they are created whether or not the
    // annotation is selected, so an invisible leg would still have a square you could grab.
    expect(legIdsOf(root, 'rect[data-handle="anchor"]')).toEqual(['open']);
    expect(legIdsOf(root, 'g[data-route-handles] rect[data-route-handle]')).toEqual(['open']);
    // The label is the point of per-leg: it stays exactly where it was.
    expect(root.querySelector('[data-annotation-id="keynote"] g[data-hit-target="label"]')).not.toBeNull();
    expect(root.querySelector('[data-annotation-id="keynote"]')?.getAttribute('opacity')).toBe('1');
    leader.dispose();
  });

  it('takes the buried leg out of the published geometry and out of the hit test', async () => {
    const { root, leader } = occludedScene(() => ['buried']);
    await settled(leader);
    // Under the default `keep` both legs are there, and the buried one is clickable along its route.
    const graded = (): boolean => leader.diagnostics.lintFrame({ pixelsPerMillimetre: 4 })
      .some(({ legIds }) => legIds?.includes('buried') === true);
    expect(leader.geometry.of('keynote')?.legs).toHaveLength(2);
    expect(graded()).toBe(true);
    const buried = leader.geometry.of('keynote')!.legs[0]!;
    const at = { x: (buried[0]!.x + buried[1]!.x) / 2, y: (buried[0]!.y + buried[1]!.y) / 2 };
    expect(leader.editing.hitTestScreen(at)).toMatchObject({ kind: 'leader', legId: 'buried' });

    leader.annotations.update('keynote', { occlusion: 'hide' });
    await settled(leader);
    expect(leader.geometry.of('keynote')?.legs).toHaveLength(1);
    // `lintFrame` grades `entry.legs` too, so a leg nobody can see is also a leg nobody is graded on.
    expect(graded()).toBe(false);
    expect(leader.editing.hitTestScreen(at)?.legId).not.toBe('buried');
    expect(routePaths(root, 'keynote')).toHaveLength(1);
    leader.dispose();
  });

  it('brings the leg back at full strength when it stops being buried', async () => {
    let buried: readonly string[] = ['buried'];
    const { root, leader, scale } = occludedScene(() => buried);
    await settled(leader);
    expect(opacities(root)).toEqual(['0.55', null]);

    buried = [];
    // The routes have to move, or the signature still matches and no fresh batch is requested.
    scale.value = 12;
    await settled(leader);
    // Both attributes cleared, not just the dash: a dimmed solid line is its own wrong answer.
    expect(opacities(root)).toEqual([null, null]);
    expect(dashes(root)).toEqual([null, null]);
    leader.dispose();
  });
});
