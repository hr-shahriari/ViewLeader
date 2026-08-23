/** @vitest-environment jsdom */
/**
 * Phase 1.1 — the geometric regression test.
 *
 * Every other placement suite in this repo is self-consistency only: `v1-screen-geometry.test.ts`
 * asserts the geometry API agrees with the DOM it just drew, which passes identically after every
 * label on screen has moved. A refactor of `labelPlacer.ts` or `routing.ts` could rearrange the
 * whole drawing and the suite would stay green.
 *
 * This one records *where things actually are*. The snapshot is checked in as readable text —
 * `snapshots/scene-a-plan.txt` — so the review is by eye once and every later diff is a line-level
 * report of which annotation moved and by how much.
 *
 * Rounded to 0.01 px. `Math.sin`/`Math.cos` are not bit-identical across libm implementations, so a
 * raw float dump would be a cross-platform false alarm; 0.01 px is four orders of magnitude above
 * that noise and still small enough that no real layout change hides under it.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VIEWPORT, scene } from './crowded-scene-harness.js';

// From the repo root, not `import.meta.url`: under jsdom that is an http URL, not a file one.
const SCENE_A_SNAPSHOT = resolve(process.cwd(), 'test/snapshots/scene-a-plan.txt');

/** The perturbation size phase 1.1 names. Small enough to be a plausible accident, and it must fail. */
const PERTURBATION_PX = 5;
/** An automatic label in the crowd, so the shift travels through separation and routing too. */
const PERTURBED_ID = 'crowd-07';

const px = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : String(value));

/**
 * The emitted plan as text: one line per annotation, label box then routed polyline. Legs are
 * included deliberately — placement and routing regress independently, and a snapshot of boxes
 * alone would miss every leader defect phases 2.2 and 3 are about.
 */
function planText(handle: ReturnType<typeof scene>, title: string): string {
  const lines = [title, ''];
  for (const id of handle.ids) {
    const geometry = handle.leader.geometry.of(id);
    if (geometry === undefined) {
      lines.push(`${id.padEnd(18)} —`);
      continue;
    }
    const box = geometry.label;
    const legs = geometry.legs
      .map((leg) => leg.map((point) => `(${px(point.x)},${px(point.y)})`).join('→'))
      .join('  |  ');
    lines.push(`${id.padEnd(18)} ${px(box.x)},${px(box.y)} ${px(box.width)}×${px(box.height)}  ${legs}`);
  }
  return `${lines.join('\n')}\n`;
}

const TITLE = `scene A — 900×640, yaw 0, scale 42 px/m`;

describe('the emitted plan is graded against a committed snapshot', () => {
  it('matches scene A at the fixed camera', async () => {
    const handle = scene();
    await expect(planText(handle, TITLE)).toMatchFileSnapshot(SCENE_A_SNAPSHOT);
    handle.leader.dispose();
  });

  /**
   * Proves the snapshot grades rather than merely exists. A snapshot test that nobody has ever seen
   * fail is indistinguishable from one that records nothing, and this repo already shipped a
   * placement suite with exactly that property.
   *
   * The 5 px goes in through `strategies.snap` — the public seam a host uses to overrule layout —
   * so no internal is reached into and the perturbed run is a legal ViewLeader configuration.
   */
  it('fails on a deliberate 5 px placement perturbation', async () => {
    const committed = await readFile(SCENE_A_SNAPSHOT, 'utf8');
    const handle = scene(VIEWPORT, {
      snap: (proposed, ctx) =>
        ctx.id === PERTURBED_ID ? { x: proposed.x + PERTURBATION_PX, y: proposed.y } : proposed,
    });
    const perturbed = planText(handle, TITLE);
    expect(perturbed).not.toBe(committed);

    // ...and it is *this* annotation's line that changed, not an unrelated one — a snapshot that
    // trips on some incidental difference would pass this test while grading the wrong thing.
    const lineFor = (text: string): string =>
      text.split('\n').find((line) => line.startsWith(PERTURBED_ID)) ?? '';
    expect(lineFor(perturbed)).not.toBe(lineFor(committed));
    handle.leader.dispose();
  });

  /**
   * The snapshot is only a regression test if the same input produces the same plan. Layout reads
   * the previous frame for hysteresis, so "identical twice" is a claim about the whole pipeline,
   * not just about the placer being a pure function.
   */
  it('is deterministic: two fresh runs emit the same plan', () => {
    const first = scene();
    const firstText = planText(first, TITLE);
    first.leader.dispose();
    const second = scene();
    const secondText = planText(second, TITLE);
    second.leader.dispose();
    expect(secondText).toBe(firstText);
  });
});
