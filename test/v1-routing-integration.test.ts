/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewLeader, type HostAdapterBundle } from 'viewleader';
import { LandingStability } from '../src/landing-stability.js';
import { segmentThroughInterior } from '../src/lint.js';
import { OrganizationPlanner } from '../src/organization.js';
import type { RouteLegInput } from '../src/routing.js';

const active: ViewLeader[] = [];
afterEach(() => {
  for (const leader of active.splice(0)) leader.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const model = { min: { x: 300, y: 200, z: 0 }, max: { x: 500, y: 400, z: 0 } };

function runtime(): { leader: ViewLeader; bump(): void } {
  let revision = 1;
  const boundary = document.createElement('div');
  document.body.append(boundary);
  const adapters: HostAdapterBundle = {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
      getRevision: () => revision,
      project: (point) => ({ point: { x: point.x, y: point.y }, depth: 0.5, visible: true }),
      projectBounds: (bounds) => ({
        status: 'available',
        bounds: { min: { x: bounds.min.x, y: bounds.min.y }, max: { x: bounds.max.x, y: bounds.max.y } },
      }),
    },
    modelBounds: { get: () => model },
  };
  const leader = new ViewLeader({ boundary, adapters });
  active.push(leader);
  return { leader, bump: () => { revision += 1; } };
}

describe('routing continuity across organization boundaries', () => {
  it('renders one measured fixed route unchanged while quadrant candidates plan around it', () => {
    let obstacleRoutes: readonly (readonly { x: number; y: number }[])[] | undefined;
    const plan = OrganizationPlanner.prototype.plan;
    vi.spyOn(OrganizationPlanner.prototype, 'plan').mockImplementation(function (this: OrganizationPlanner, inputs, options) {
      obstacleRoutes = options.routes;
      return plan.call(this, inputs, options);
    });
    const { leader, bump } = runtime();
    leader.annotations.create({
      id: 'fixed',
      anchor: { kind: 'world-point', point: { x: 304, y: 238, z: 0 } },
      content: { kind: 'callout', title: 'FIRST BASELINE', text: 'LAST BASELINE' },
      routing: { kind: 'automatic', mode: 'dogleg' },
      locked: true,
    });
    leader.annotations.create({
      id: 'free',
      anchor: { kind: 'world-point', point: { x: 312, y: 250, z: 0 } },
      content: { kind: 'plain-note', text: 'Plans around fixed geometry' },
      routing: { kind: 'automatic', mode: 'dogleg' },
    });
    leader.setPlacementMode('quadrants');
    bump();
    leader.update();
    const fixed = leader.geometry.of('fixed')!;
    const firstRoute = fixed.legs[0]!;
    // The renderer trims only the anchor tip for its terminator. The remaining polyline must be
    // the exact fixed obstacle presented to the organization planner, including its measured
    // text baseline. Otherwise movable routes avoid a midpoint surrogate that is never drawn.
    expect(obstacleRoutes).toHaveLength(1);
    expect(obstacleRoutes![0]!.slice(1)).toEqual(firstRoute.slice(1));
    const endpoint = firstRoute.at(-1)!;
    expect(endpoint.y).not.toBeCloseTo(fixed.label.y + fixed.label.height / 2, 5);
    const free = leader.geometry.of('free')!;
    const freeRect = { x: free.label.x, y: free.label.y, width: free.label.width, height: free.label.height };
    expect(firstRoute.slice(1).some((point, index) => segmentThroughInterior({
      start: firstRoute[index]!, end: point,
    }, freeRect))).toBe(false);

    bump();
    leader.update();
    expect(leader.geometry.of('fixed')!.legs[0]).toEqual(firstRoute);
  });

  it('hands one accepted baseline between automatic routing and the quadrant planner', () => {
    const stability = new LandingStability();
    const planner = new OrganizationPlanner(stability);
    const legs: RouteLegInput[] = [{ id: 'leg', anchor: { x: 304, y: 238 }, route: { mode: 'dogleg' } }];
    const landing = { side: 'right' as const, textLines: { first: 12, last: 28 } };
    const expectedBounds = { x: 154, y: 218, width: 96, height: 40 };
    const prior = stability.preview('note', [{ ...legs[0]!, anchor: { x: 304, y: 241 } }], expectedBounds, landing);
    stability.commit('note', prior);

    const plan = planner.plan([{
      id: 'note',
      labelSize: { width: 96, height: 40 },
      legs: [{ id: 'leg', anchor: { x: 304, y: 238 } }],
      landing,
    }], { modelBounds: { min: model.min, max: model.max }, clearance: 24 })[0]!;
    const returned = stability.preview('note', legs, {
      x: plan.position.x, y: plan.position.y, width: 96, height: 40,
    }, landing);
    expect(returned.landing.textLines).toEqual({ first: 28, last: 28 });
    expect(plan.legs[0]!.points.at(-1)!.y).toBe(plan.position.y + 28);
  });
});
