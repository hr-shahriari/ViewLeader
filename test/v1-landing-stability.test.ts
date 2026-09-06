import { describe, expect, it } from 'vitest';
import { LandingStability } from '../src/landing-stability.js';
import { routeLegs, type LandingGeometry, type RouteLegInput } from '../src/routing.js';

const bounds = { x: 200, y: 100, width: 100, height: 40 };
const landing: LandingGeometry = { side: 'left', length: 20, gap: 5, textLines: { first: 12, last: 28 } };
const legsAt = (y: number): RouteLegInput[] => [{ id: 'leg', anchor: { x: 50, y }, route: { mode: 'dogleg' } }];

function accept(memory: LandingStability, y: number, style = landing) {
  const proposal = memory.preview('note', legsAt(y), bounds, style);
  const result = routeLegs(legsAt(y), bounds, proposal.landing)[0]!.points;
  memory.commit('note', proposal);
  return result;
}

describe('text landing continuity', () => {
  it('uses a deterministic first baseline for numerical ties without prior memory', () => {
    for (const y of [120 - 1e-9, 120, 120 + 1e-9]) {
      expect(routeLegs(legsAt(y), bounds, landing)[0]!.points.at(-1)!.y).toBe(112);
    }
  });

  it('retains the last accepted line through jitter and switches in both directions beyond the margin', () => {
    const memory = new LandingStability();
    expect(accept(memory, 123).at(-1)!.y).toBe(128);
    for (const y of [120, 119, 121, 118, 122]) expect(accept(memory, y).at(-1)!.y).toBe(128);
    expect(accept(memory, 117.9).at(-1)!.y).toBe(112);
    for (const y of [120, 121, 119, 122]) expect(accept(memory, y).at(-1)!.y).toBe(112);
    expect(accept(memory, 122.1).at(-1)!.y).toBe(128);
  });

  it('does not remember rejected layout candidates', () => {
    const memory = new LandingStability();
    accept(memory, 123);
    const discarded = memory.preview('note', legsAt(100), bounds, landing);
    expect(discarded.landing.textLines!.first).toBe(12);
    expect(accept(memory, 119).at(-1)!.y).toBe(128);
  });

  it('resets incompatible text metrics and attachment sides', () => {
    const memory = new LandingStability();
    accept(memory, 123);
    expect(accept(memory, 119, { ...landing, side: 'right' }).at(-1)!.y).toBe(112);
    accept(memory, 123);
    expect(accept(memory, 119, { ...landing, textLines: { first: 11, last: 27 } }).at(-1)!.y).toBe(111);
  });

  it('retains reserved IDs while pruning deleted IDs and clearing replacements', () => {
    const memory = new LandingStability();
    accept(memory, 123);
    memory.forget(new Set(['note']));
    expect(accept(memory, 119).at(-1)!.y).toBe(128);
    memory.forget(new Set());
    expect(accept(memory, 119).at(-1)!.y).toBe(112);
    accept(memory, 123);
    memory.clear();
    expect(accept(memory, 119).at(-1)!.y).toBe(112);
  });

  it('keeps underline and gap geometry while sharing a stable multileader tail', () => {
    const memory = new LandingStability();
    const makeFan = (y: number): RouteLegInput[] => [
      { id: 'upper', anchor: { x: 50, y: y - 30 }, route: { mode: 'dogleg' } },
      { id: 'lower', anchor: { x: 60, y: y + 30 }, route: { mode: 'dogleg' } },
    ];
    const style: LandingGeometry = { ...landing, render: 'underline' };
    memory.commit('note', memory.preview('note', makeFan(123), bounds, style));
    const proposal = memory.preview('note', makeFan(119), bounds, style);
    const routes = routeLegs(makeFan(119), bounds, proposal.landing);
    expect(routes[0]!.points.slice(-2)).toEqual([{ x: 180, y: 128 }, { x: 300, y: 128 }]);
    expect(routes[1]!.points.slice(-2)).toEqual(routes[0]!.points.slice(-2));
    expect(style.textLines).toEqual({ first: 12, last: 28 });
  });

  it('leaves authored manual and top or bottom routes unchanged', () => {
    const memory = new LandingStability();
    const manual: RouteLegInput[] = [{ id: 'leg', anchor: { x: 50, y: 120 }, route: {
      mode: 'manual', vertices: [{ x: 70, y: 70 }, { x: 180, y: 70 }],
    } }];
    expect(memory.preview('note', manual, bounds, landing).landing).toBe(landing);
    for (const side of ['top', 'bottom'] as const) {
      const style = { ...landing, side };
      expect(memory.preview('note', legsAt(120), bounds, style).landing).toBe(style);
    }
  });
});
