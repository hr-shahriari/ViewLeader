import { describe, expect, it } from 'vitest';
import { OrganizationPlanner, type OrganizationInput, type OrganizationPlan } from '../src/organization.js';
import { segmentThroughInterior } from '../src/lint.js';
import type { Vec2 } from '../src/types.js';

const model = { min: { x: 300, y: 200 }, max: { x: 500, y: 400 } };

function input(id: string, anchor: Vec2, height = 24): OrganizationInput {
  return { id, labelSize: { width: 96, height }, legs: [{ id: `${id}-leg`, anchor }] };
}

function segmentCrosses(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const turn = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = turn(a, b, c);
  const abD = turn(a, b, d);
  const cdA = turn(c, d, a);
  const cdB = turn(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}

function properCrossings(plans: readonly OrganizationPlan[]): number {
  const segments = plans.flatMap((plan) => plan.legs.flatMap((leg) => leg.points.slice(1).map((to, index) => ({
    id: plan.id,
    from: leg.points[index]!,
    to,
  }))));
  let count = 0;
  for (let i = 0; i < segments.length; i += 1) for (let j = i + 1; j < segments.length; j += 1) {
    const a = segments[i]!;
    const b = segments[j]!;
    if (a.id !== b.id && segmentCrosses(a.from, a.to, b.from, b.to)) count += 1;
  }
  return count;
}

function reflect(point: Vec2, horizontal: boolean, vertical: boolean): Vec2 {
  return { x: horizontal ? 800 - point.x : point.x, y: vertical ? 600 - point.y : point.y };
}

describe('v1 quadrant organization planner', () => {
  it.each([
    ['top-left', false, false],
    ['top-right', true, false],
    ['bottom-left', false, true],
    ['bottom-right', true, true],
  ] as const)('builds ordered short and escape routes in the %s mirror', (_name, horizontal, vertical) => {
    const anchors = [
      { x: 302, y: 216 },
      { x: 310, y: 225 },
      { x: 345, y: 238 },
      { x: 390, y: 250 },
    ].map((point) => reflect(point, horizontal, vertical));
    const plans = new OrganizationPlanner().plan(anchors.map((anchor, index) => input(`n${index}`, anchor, 32 + index * 7)), {
      modelBounds: model,
      clearance: 20,
      labelGap: 8,
      laneGap: 14,
    });

    expect(plans).toHaveLength(4);
    expect(plans.some((plan) => plan.routeClass === 'direct' || plan.routeClass === 'bend')).toBe(true);
    expect(plans.some((plan) => plan.routeClass === 'escape')).toBe(true);
    expect(properCrossings(plans)).toBe(0);
    expect(plans.map((plan) => plan.conflicts)).toEqual([0, 0, 0, 0]);
    expect(plans.map((plan) => plan.routeClass)).toEqual(['direct', 'bend', 'escape', 'escape']);
    for (const plan of plans) {
      if (horizontal) expect(plan.bounds.min.x).toBeGreaterThanOrEqual(model.max.x);
      else expect(plan.bounds.max.x).toBeLessThanOrEqual(model.min.x);
      expect(plan.legs[0]!.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    }
  });

  it('is independent of input order with varied label heights', () => {
    const inputs = [input('c', { x: 330, y: 245 }, 47), input('a', { x: 306, y: 215 }, 19), input('b', { x: 318, y: 232 }, 61)];
    const forward = new OrganizationPlanner().plan(inputs, { modelBounds: model });
    const reversed = new OrganizationPlanner().plan([...inputs].reverse(), { modelBounds: model });
    expect(reversed).toEqual(forward);
    for (let i = 0; i < forward.length; i += 1) for (let j = i + 1; j < forward.length; j += 1) {
      const a = forward[i]!.bounds;
      const b = forward[j]!.bounds;
      expect(a.max.x <= b.min.x || a.min.x >= b.max.x || a.max.y <= b.min.y || a.min.y >= b.max.y).toBe(true);
    }
  });

  it('keeps sector and route class stable during minor motion and forgets deleted ids', () => {
    const planner = new OrganizationPlanner();
    const crowded = [input('stable', { x: 395, y: 245 }, 90), input('near', { x: 302, y: 215 }, 90)];
    const first = planner.plan(crowded, { modelBounds: model }).find((plan) => plan.id === 'stable')!;
    const moved = planner.plan([input('stable', { x: 405, y: 247 }, 90), crowded[1]!], { modelBounds: model })
      .find((plan) => plan.id === 'stable')!;
    expect(moved.sector).toBe(first.sector);
    expect(moved.routeClass).toBe(first.routeClass);

    planner.forget(new Set(['near']));
    const fresh = planner.plan([input('stable', { x: 405, y: 247 }, 24)], { modelBounds: model })[0]!;
    expect(fresh.sector.endsWith('right')).toBe(true);
  });

  it('keeps a near-tie allocation until the depth advantage clears the switching margin', () => {
    const planner = new OrganizationPlanner();
    const inputs = (nearX: number, farX: number) => [
      input('near', { x: nearX, y: 222 }, 70),
      input('far', { x: farX, y: 226 }, 70),
    ];
    const first = new Map(planner.plan(inputs(310, 310.02), { modelBounds: model }).map((plan) => [plan.id, plan]));
    const nearTie = new Map(planner.plan(inputs(310.03, 310), { modelBounds: model }).map((plan) => [plan.id, plan]));
    expect(nearTie.get('near')!.position).toEqual(first.get('near')!.position);
    expect(nearTie.get('far')!.position).toEqual(first.get('far')!.position);

    // A real 10 px depth reversal is deliberately outside the 2 px continuity margin. The old
    // slots are recomputed against current geometry rather than retained as stale coordinates.
    const reversed = planner.plan(inputs(320, 310), { modelBounds: model });
    expect(reversed.find((plan) => plan.id === 'near')!.position).not.toEqual(first.get('near')!.position);
    expect(reversed.every((plan) => plan.conflicts === 0)).toBe(true);
  });

  it('keeps a fixed-order label in its feasible slot across a subpixel slot tie', () => {
    const planner = new OrganizationPlanner();
    const inputs = (secondY: number) => [
      { ...input('first', { x: 302, y: 250 }), landing: { render: 'none' as const } },
      { ...input('second', { x: 310, y: secondY }), landing: { render: 'none' as const } },
    ];
    const beforePlans = planner.plan(inputs(249.99), { modelBounds: model });
    expect(beforePlans.every((plan) => plan.conflicts === 0)).toBe(true);
    const before = beforePlans.find((plan) => plan.id === 'second')!;
    expect(before.conflicts).toBe(0);
    const after = planner.plan(inputs(250.01), { modelBounds: model }).find((plan) => plan.id === 'second')!;
    expect(after.position).toEqual(before.position);
    expect(after.routeClass).toBe(before.routeClass);
    expect(after.conflicts).toBe(0);
  });

  it('releases a remembered slot when a current obstacle makes it infeasible', () => {
    const planner = new OrganizationPlanner();
    const inputs = [
      { ...input('first', { x: 302, y: 250 }), landing: { render: 'none' as const } },
      { ...input('second', { x: 310, y: 249.99 }), landing: { render: 'none' as const } },
    ];
    const initial = planner.plan(inputs, { modelBounds: model });
    const second = initial.find((plan) => plan.id === 'second')!;
    expect(second.conflicts).toBe(0);

    const blocked = planner.plan(inputs, {
      modelBounds: model,
      obstacles: [{
        x: second.bounds.min.x,
        y: second.bounds.min.y,
        width: second.bounds.max.x - second.bounds.min.x,
        height: second.bounds.max.y - second.bounds.min.y,
      }],
    }).find((plan) => plan.id === 'second')!;
    expect(blocked.position).not.toEqual(second.position);
    expect(blocked.conflicts).toBe(0);
  });

  it('tries the fresh feasible slot before escaping a remembered route conflict', () => {
    const planner = new OrganizationPlanner();
    const inputs = (secondY: number) => [
      input('first', { x: 302, y: 250 }),
      input('second', { x: 310, y: secondY }),
    ];
    const initial = planner.plan(inputs(249.99), { modelBounds: model });
    const remembered = initial.find((plan) => plan.id === 'second')!;
    const afterTie = planner.plan(inputs(250.01), { modelBounds: model }).find((plan) => plan.id === 'second')!;

    expect(remembered.conflicts).toBe(0);
    expect(afterTie.conflicts).toBe(0);
    expect(afterTie.position).not.toEqual(remembered.position);
    expect(afterTie.routeClass).not.toBe('escape');
  });

  it('recomputes remembered order against resized model bounds instead of retaining stale slots', () => {
    const planner = new OrganizationPlanner();
    const inputs = [input('near', { x: 310, y: 222 }, 70), input('far', { x: 310.02, y: 226 }, 70)];
    const first = planner.plan(inputs, { modelBounds: model });
    const resized = { min: { x: 240, y: 170 }, max: { x: 560, y: 430 } };
    const afterResize = planner.plan(inputs, { modelBounds: resized });
    expect(afterResize.map((plan) => plan.position)).not.toEqual(first.map((plan) => plan.position));
    expect(afterResize.every((plan) => plan.bounds.max.x <= resized.min.x || plan.bounds.min.x >= resized.max.x
      || plan.bounds.max.y <= resized.min.y || plan.bounds.min.y >= resized.max.y)).toBe(true);
    expect(afterResize.every((plan) => plan.conflicts === 0)).toBe(true);
  });

  it('reserves an invisible annotation so a visible survivor keeps its exact plan', () => {
    const planner = new OrganizationPlanner();
    const near = input('near', { x: 304, y: 216 }, 40);
    const survivor = input('survivor', { x: 330, y: 226 }, 44);
    const reserveBoth = new Set(['near', 'survivor']);
    const initial = planner.plan([near, survivor], { modelBounds: model, reserveIds: reserveBoth });
    const survivorInitial = initial.find((plan) => plan.id === 'survivor')!;
    const absent = planner.plan([survivor], { modelBounds: model, reserveIds: reserveBoth });
    expect(absent).toHaveLength(1);
    expect(absent[0]).toEqual(survivorInitial);
    const returned = planner.plan([survivor, near], { modelBounds: model, reserveIds: reserveBoth });
    expect(returned.find((plan) => plan.id === 'survivor')).toEqual(survivorInitial);

    const released = planner.plan([survivor], { modelBounds: model, reserveIds: new Set(['survivor']) })[0]!;
    expect(released.position).not.toEqual(survivorInitial.position);
    expect(released.routeClass).toBe('direct');
  });

  it('retains the accepted allocation while every annotation is temporarily offscreen', () => {
    const planner = new OrganizationPlanner();
    const initialInputs = [input('near', { x: 310, y: 222 }, 70), input('far', { x: 310.02, y: 226 }, 70)];
    const reserve = new Set(['near', 'far']);
    const initial = planner.plan(initialInputs, { modelBounds: model, reserveIds: reserve });
    expect(planner.plan([], { modelBounds: model, reserveIds: reserve })).toEqual([]);
    const returned = planner.plan([
      input('near', { x: 310.03, y: 222 }, 70), input('far', { x: 310, y: 226 }, 70),
    ], { modelBounds: model, reserveIds: reserve });
    expect(returned.map(({ id, position }) => ({ id, position }))).toEqual(initial.map(({ id, position }) => ({ id, position })));
  });

  it('suspends cached allocation during a fixed route preview without losing its state', () => {
    const planner = new OrganizationPlanner();
    const previewed = input('previewed', { x: 304, y: 216 }, 40);
    const survivor = input('survivor', { x: 330, y: 226 }, 44);
    const reserveBoth = new Set(['previewed', 'survivor']);
    const initial = planner.plan([previewed, survivor], { modelBounds: model, reserveIds: reserveBoth });
    const previewPlan = initial.find((plan) => plan.id === 'previewed')!;
    const survivorPlan = initial.find((plan) => plan.id === 'survivor')!;
    const duringPreview = planner.plan([survivor], {
      modelBounds: model,
      reserveIds: reserveBoth,
      suspendedIds: new Set(['previewed']),
      obstacles: [{
        x: previewPlan.bounds.min.x,
        y: previewPlan.bounds.min.y,
        width: previewPlan.bounds.max.x - previewPlan.bounds.min.x,
        height: previewPlan.bounds.max.y - previewPlan.bounds.min.y,
      }],
      routes: previewPlan.legs.map((leg) => leg.points),
    });
    expect(duringPreview).toEqual([survivorPlan]);
    const returned = planner.plan([survivor, previewed], { modelBounds: model, reserveIds: reserveBoth });
    expect(returned).toEqual(initial);
  });

  it('keeps the complete near-tie order while one reserved annotation is suspended', () => {
    const planner = new OrganizationPlanner();
    const reserve = new Set(['a', 'b']);
    const initialInputs = [input('a', { x: 310, y: 222 }, 70), input('b', { x: 310.02, y: 226 }, 70)];
    const initial = new Map(planner.plan(initialInputs, { modelBounds: model, reserveIds: reserve }).map((plan) => [plan.id, plan]));

    planner.plan([initialInputs[1]!], {
      modelBounds: model,
      reserveIds: reserve,
      suspendedIds: new Set(['a']),
    });
    const returned = new Map(planner.plan([
      input('a', { x: 310.03, y: 222 }, 70), input('b', { x: 310, y: 226 }, 70),
    ], { modelBounds: model, reserveIds: reserve }).map((plan) => [plan.id, plan]));

    expect(returned.get('a')!.position).toEqual(initial.get('a')!.position);
    expect(returned.get('b')!.position).toEqual(initial.get('b')!.position);
  });

  it('uses one shared shoulder and landing for every leg of a multileader', () => {
    const plan = new OrganizationPlanner().plan([{
      id: 'multi',
      labelSize: { width: 110, height: 48 },
      legs: [
        { id: 'upper', anchor: { x: 310, y: 215 } },
        { id: 'lower', anchor: { x: 350, y: 275 } },
      ],
      landing: { textLines: { first: 12, last: 36 } },
    }], { modelBounds: model })[0]!;
    expect(plan.legs).toHaveLength(2);
    expect(plan.legs[0]!.points.slice(-2)).toEqual(plan.legs[1]!.points.slice(-2));
    expect(plan.conflicts).toBe(0);
  });

  it('uses valid host snapping and rejects a snap that violates model clearance', () => {
    const valid = new OrganizationPlanner().plan([input('a', { x: 320, y: 230 })], {
      modelBounds: model,
      snap: (position) => ({ x: position.x - 3, y: position.y + 2 }),
    })[0]!;
    expect(valid.position.y).toBe(220);

    const invalid = new OrganizationPlanner().plan([input('a', { x: 320, y: 230 })], {
      modelBounds: model,
      // Still outside the model, but one pixel inside the requested 24 px clearance.
      snap: () => ({ x: 181, y: 218 }),
    })[0]!;
    expect(invalid.bounds.max.x).toBeLessThanOrEqual(model.min.x);
    expect(invalid.position.x).not.toBe(181);
  });

  it('scores fixed manual labels and routes as obstacles', () => {
    const free = new OrganizationPlanner().plan([input('a', { x: 305, y: 220 })], { modelBounds: model })[0]!;
    const blocked = new OrganizationPlanner().plan([input('a', { x: 305, y: 220 })], {
      modelBounds: model,
      obstacles: [{ x: free.position.x, y: free.position.y, width: 96, height: 24 }],
      routes: [[{ x: 180, y: 160 }, { x: 280, y: 260 }]],
    })[0]!;
    expect(blocked.routeClass).toBe('escape');
    expect(blocked.position).not.toEqual(free.position);
  });

  it('detects a fixed route passing through the new candidate label', () => {
    const plan = new OrganizationPlanner().plan([input('a', { x: 304, y: 238 })], {
      modelBounds: model,
      routes: [[{ x: 100, y: 238 }, { x: 260, y: 238 }]],
    })[0]!;
    expect(plan.routeClass).toBe('escape');
    expect(plan.conflicts).toBe(0);
  });

  it('tries farther escape lanes when fixed labels occupy the first candidate', () => {
    const plan = new OrganizationPlanner().plan([input('a', { x: 304, y: 220 })], {
      modelBounds: model,
      obstacles: [
        { x: 140, y: 200, width: 120, height: 100 },
        { x: 140, y: 132, width: 120, height: 40 },
      ],
    })[0]!;
    expect(plan.routeClass).toBe('escape');
    expect(plan.position.y).toBeLessThan(132);
    expect(plan.conflicts).toBe(0);
  });

  it('treats an explicit auto landing as the inward side', () => {
    const plan = new OrganizationPlanner().plan([{
      ...input('auto', { x: 304, y: 238 }),
      landing: { side: 'auto' },
    }], { modelBounds: model })[0]!;
    const end = plan.legs[0]!.points.at(-1)!;
    expect(end.x).toBeLessThan(model.min.x);
    expect(plan.conflicts).toBe(0);
  });

  it('spaces several overflow lanes by cumulative variable label height', () => {
    const plans = new OrganizationPlanner().plan([
      input('a', { x: 302, y: 215 }, 72),
      input('b', { x: 330, y: 225 }, 55),
      input('c', { x: 370, y: 235 }, 91),
      input('d', { x: 390, y: 245 }, 38),
    ], { modelBounds: model, clearance: 18, labelGap: 9, laneGap: 13 });
    const escapes = plans.filter((plan) => plan.routeClass === 'escape').sort((a, b) => b.position.y - a.position.y);
    expect(escapes.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < escapes.length; index += 1) {
      expect(escapes[index]!.bounds.max.y + 9).toBeLessThanOrEqual(escapes[index - 1]!.bounds.min.y);
    }
    expect(escapes.every((plan) => plan.conflicts === 0)).toBe(true);
  });

  it('keeps an escape route horizontal through a styled text-line landing', () => {
    const plan = new OrganizationPlanner().plan([{
      ...input('styled-escape', { x: 304, y: 220 }, 240),
      landing: { length: 18, gap: 7, textLines: { first: 16, last: 210 } },
    }], { modelBounds: model })[0]!;
    expect(plan.routeClass).toBe('escape');
    const finalRun = plan.legs[0]!.points.slice(-3);
    expect(finalRun).toHaveLength(3);
    expect(finalRun.map((point) => point.y)).toEqual([
      finalRun[2]!.y,
      finalRun[2]!.y,
      finalRun[2]!.y,
    ]);
  });

  it('distributes symmetric anchors across both model sides without unnecessary escapes', () => {
    const plans = new OrganizationPlanner().plan([
      input('top-left', { x: 315, y: 230 }),
      input('bottom-left', { x: 325, y: 365 }),
      input('top-right', { x: 485, y: 230 }),
      input('bottom-right', { x: 475, y: 365 }),
    ], { modelBounds: model });
    expect(plans.filter((plan) => plan.side === 'left')).toHaveLength(2);
    expect(plans.filter((plan) => plan.side === 'right')).toHaveLength(2);
    expect(plans.every((plan) => plan.routeClass !== 'escape')).toBe(true);
    expect(plans.every((plan) => plan.conflicts === 0)).toBe(true);
  });

  it('packs a dense edge-near side cluster into a compact monotone fan', () => {
    const plans = new OrganizationPlanner().plan([
      input('a', { x: 314, y: 226 }), input('b', { x: 318, y: 246 }),
      input('c', { x: 322, y: 266 }), input('d', { x: 326, y: 286 }),
      input('e', { x: 330, y: 314 }), input('f', { x: 326, y: 334 }),
      input('g', { x: 322, y: 354 }), input('h', { x: 318, y: 374 }),
    ], { modelBounds: model, clearance: 24, labelGap: 10 });
    expect(plans.every((plan) => plan.side === 'left')).toBe(true);
    expect(plans.every((plan) => plan.routeClass !== 'escape')).toBe(true);
    const ordered = [...plans].sort((a, b) => a.legs[0]!.points[0]!.y - b.legs[0]!.points[0]!.y);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index - 1]!.bounds.max.y + 10).toBeLessThanOrEqual(ordered[index]!.bounds.min.y);
    }
    for (const plan of plans) {
      const [anchor, exit, shoulder] = plan.legs[0]!.points;
      expect(exit!.y).toBe(anchor!.y);
      expect(exit!.x).toBe(model.min.x);
      expect(shoulder!.x).toBeLessThan(model.min.x);
    }
    expect(properCrossings(plans)).toBe(0);
  });

  it('preserves quadrant escapes when anchors span meaningful side depth', () => {
    const plans = new OrganizationPlanner().plan([
      input('a', { x: 304, y: 226 }), input('b', { x: 330, y: 246 }),
      input('c', { x: 360, y: 266 }), input('d', { x: 390, y: 286 }),
      input('e', { x: 390, y: 314 }), input('f', { x: 360, y: 334 }),
      input('g', { x: 330, y: 354 }), input('h', { x: 304, y: 374 }),
    ], { modelBounds: model, clearance: 24, labelGap: 10 });
    expect(plans.some((plan) => plan.routeClass === 'escape')).toBe(true);
  });

  it('retains a compact fan across the wider leave threshold', () => {
    const planner = new OrganizationPlanner();
    const compact = [226, 246, 266, 286, 314, 334, 354, 374]
      .map((y, index) => input(String(index), { x: 312 + index * 2, y }));
    expect(planner.plan(compact, { modelBounds: model }).every((plan) => plan.routeClass === 'bend')).toBe(true);

    // 32 px of depth spread is outside the 12.5% entry threshold (25 px), but still inside the
    // 16% leave threshold (32 px), so an orbit near the boundary keeps the established fan.
    const moved = compact.map((item, index) => ({
      ...item,
      legs: item.legs.map((leg) => ({ ...leg, anchor: { ...leg.anchor, x: 312 + index * (32 / 7) } })),
    }));
    expect(planner.plan(moved, { modelBounds: model }).every((plan) => plan.routeClass === 'bend')).toBe(true);
    expect(new OrganizationPlanner().plan(moved, { modelBounds: model }).some((plan) => plan.routeClass === 'escape')).toBe(true);
  });

  it('keeps an authored outward landing from routing through its own label', () => {
    const clustered = [177, 246, 266, 286, 314, 334, 354, 374]
      .map((y, index) => input(String(index), { x: 312 + index * 2, y }));
    clustered[0] = { ...clustered[0]!, landing: { side: 'left', textLines: { first: 8, last: 18 } } };
    const plans = new OrganizationPlanner().plan(clustered, { modelBounds: model });
    // The outward-side override is incompatible with an exterior diagonal fan, so the whole side
    // retains quadrant routing rather than letting one leader cut across its label.
    expect(plans.some((plan) => plan.routeClass === 'escape')).toBe(true);
    const authored = plans.find((plan) => plan.id === '0')!;
    for (let index = 1; index < authored.legs[0]!.points.length; index += 1) {
      const from = authored.legs[0]!.points[index - 1]!;
      const to = authored.legs[0]!.points[index]!;
      const crossesInterior = segmentThroughInterior({ start: from, end: to }, {
        x: authored.bounds.min.x,
        y: authored.bounds.min.y,
        width: authored.bounds.max.x - authored.bounds.min.x,
        height: authored.bounds.max.y - authored.bounds.min.y,
      });
      expect(crossesInterior).toBe(false);
    }
  });

  it('keeps an edge-near label at its natural landing height with a direct route', () => {
    const plan = new OrganizationPlanner().plan([input('natural', { x: 304, y: 238 }, 24)], { modelBounds: model })[0]!;
    expect(plan.position.y).toBe(226);
    expect(plan.routeClass).toBe('direct');
    expect(plan.legs[0]!.points[0]).toEqual({ x: 304, y: 238 });
    expect(plan.conflicts).toBe(0);
  });
});
