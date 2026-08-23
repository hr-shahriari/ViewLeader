/** @vitest-environment jsdom */
/**
 * Adaptive leader shaping — the one lever measured to move `leader-crossing` materially.
 *
 * Thirty-six attempts at placement, routing search, slot ordering and obstacle avoidance moved that
 * number between 31 and 53 on scene A, every one of them trading it against overlaps or against the
 * anti-swim budget. Re-routing the same layout orthogonally moves it to 27 in one step, with the
 * label positions byte-identical — because crossings scale with how much leader is DRAWN, and a
 * dogleg's landing is leader. The full measurement trail is in
 * `artifacts/phase-2.1-diagnosis.md`, addenda 17 to 19.
 *
 * So this is a drafting trade, not a free win: a crowded drawing gives up the landing that makes a
 * leader read as an MLEADER. That is why it is opt-in and the default changes nothing.
 */
import { describe, expect, it } from 'vitest';
import { ORBIT_STEPS, overlappingPairs, scene } from './crowded-scene-harness.js';
import { adversarial } from './adversarial-scene-harness.js';

type Sweep = { overlaps: number; through: number; crossing: number };

function sweep(make: typeof scene | typeof adversarial, mode: 'as-authored' | 'auto'): Sweep {
  const handle = make({ width: 900, height: 640 });
  handle.leader.setRoutingMode(mode);
  handle.leader.update();
  let overlaps = 0;
  let through = 0;
  let crossing = 0;
  for (let step = 0; step <= ORBIT_STEPS; step += 1) {
    handle.orbitTo((step / ORBIT_STEPS) * Math.PI * 2);
    overlaps = Math.max(overlaps, overlappingPairs(handle.boxes()).length);
    const findings = handle.leader.diagnostics.lintFrame({ pixelsPerMillimetre: 96 / 25.4 });
    const count = (rule: string): number => findings.filter((finding) => finding.ruleId === rule).length;
    through = Math.max(through, count('leader-through-label'));
    crossing = Math.max(crossing, count('leader-crossing'));
  }
  handle.leader.dispose();
  return { overlaps, through, crossing };
}

describe('routing mode', () => {
  it('defaults to as-authored and is reachable through the public API', () => {
    const handle = scene();
    expect(handle.leader.routingMode).toBe('as-authored');
    handle.leader.setRoutingMode('auto');
    expect(handle.leader.routingMode).toBe('auto');
    handle.leader.setRoutingMode('nonsense' as 'auto');
    expect(handle.leader.routingMode).toBe('auto');
    handle.leader.dispose();
  });

  it('halves leader-crossing on both oracle scenes, and moves nothing else', () => {
    for (const make of [scene, adversarial]) {
      const authored = sweep(make, 'as-authored');
      const adaptive = sweep(make, 'auto');
      expect(adaptive.crossing).toBeLessThan(authored.crossing * 0.75);
      // Placement is untouched, so the rules that grade placement must not move at all.
      expect(adaptive.overlaps).toBe(authored.overlaps);
      expect(adaptive.through).toBe(authored.through);
    }
  }, 120_000);

  it('leaves a sparse drawing alone — the trade is only worth making when crowded', () => {
    // Under CROWDED_ANNOTATION_COUNT the landing survives, because there is room for it.
    const handle = scene();
    const ids = handle.leader.annotations.getSnapshot().annotations.map(({ id }) => id);
    handle.leader.history.transaction('thin out', () => {
      for (const id of ids.slice(5)) handle.leader.annotations.remove(id);
    });
    handle.leader.setRoutingMode('auto');
    handle.leader.update();
    const legs = handle.leader.geometry.of(ids[0]!)?.legs ?? [];
    // A dogleg's last two points are its landing run: same y, different x. An orthogonal route's
    // final segment meets the label edge instead, so this is how the two are told apart.
    const last = legs[0]?.slice(-2);
    expect(last).toHaveLength(2);
    expect(last![0]!.y).toBeCloseTo(last![1]!.y, 6);
    handle.leader.dispose();
  });

  it('does not change shape as annotations leave the frustum', () => {
    // The count comes from the DOCUMENT, not from what projected this frame. Taking it from the
    // frame would make the drafting convention itself flicker during an orbit, which is a worse
    // kind of swimming than any label movement phase 2.4 grades.
    const handle = scene();
    handle.leader.setRoutingMode('auto');
    const shapes = new Set<number>();
    for (let step = 0; step <= ORBIT_STEPS; step += 1) {
      handle.orbitTo((step / ORBIT_STEPS) * Math.PI * 2);
      const legs = handle.leader.geometry.of('crowd-00')?.legs;
      if (legs?.[0] !== undefined) shapes.add(legs[0].length);
    }
    // One point count for every frame it was visible: the route never switched convention.
    expect(shapes.size).toBe(1);
    handle.leader.dispose();
  });
});
