import { expect, test, type Page } from '@playwright/test';
import type { ViewLeader } from 'viewleader';

interface GeometrySample {
  readonly id: string;
  readonly label: { readonly x: number; readonly y: number };
  readonly legs: readonly (readonly { readonly x: number; readonly y: number }[])[];
}

async function sample(page: Page): Promise<readonly GeometrySample[]> {
  return page.evaluate(() => {
    const leader = window.vl as ViewLeader;
    return leader.annotations.getSnapshot().annotations.flatMap(({ id }) => {
      const geometry = leader.geometry.of(id);
      return geometry === undefined ? [] : [{ id, label: geometry.label, legs: geometry.legs }];
    });
  });
}

async function samplePaints(page: Page, count: number): Promise<readonly (readonly GeometrySample[])[]> {
  return page.evaluate(async (frameCount) => {
    const read = (): readonly GeometrySample[] => {
      const leader = window.vl as ViewLeader;
      return leader.annotations.getSnapshot().annotations.flatMap(({ id }) => {
        const geometry = leader.geometry.of(id);
        return geometry === undefined ? [] : [{ id, label: geometry.label, legs: geometry.legs }];
      });
    };
    const frames: (readonly GeometrySample[])[] = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push(read());
    }
    return frames;
  }, count);
}

for (const mode of ['auto', 'quadrants'] as const) test(
  `IFC leaders do not flip attachments during slow orbit reversal or after stopping in ${mode}`,
  async ({ page }) => {
  test.setTimeout(60_000);
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()); });
  await page.goto('/ifc-studio/');
  await expect(page.locator('body')).toHaveAttribute('data-vl-ready', '1', { timeout: 60_000 });
  // Overlay readiness precedes the worker parse. Placeholder notes are not evidence about leaders
  // attached to the moving IFC model, so wait for the lifecycle marker used by the IFC suite.
  await page.waitForFunction(() => document.body.dataset['ifcLoaded'] !== undefined);
  expect(await page.locator('body').getAttribute('data-ifc-loaded')).toBe('1');
  await page.getByLabel('Leader placement').selectOption(mode);
  if (mode === 'auto') await page.getByLabel('Keep labels outside model').uncheck();
  await expect.poll(async () => (await sample(page)).length, { timeout: 60_000 }).toBeGreaterThan(0);

  const canvas = page.locator('canvas').first();
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const start = { x: bounds!.x + bounds!.width * 0.52, y: bounds!.y + bounds!.height * 0.18 };
  const gestureFrames: (readonly GeometrySample[])[] = [await sample(page)];
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // One rendered sample per move makes this a slow orbit rather than a burst of pointer events the
  // controls consume in one frame.
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(start.x + step * 3, start.y, { steps: 1 });
    gestureFrames.push((await samplePaints(page, 1))[0]!);
  }
  for (let step = 11; step >= 0; step -= 1) {
    await page.mouse.move(start.x + step * 3, start.y, { steps: 1 });
    gestureFrames.push((await samplePaints(page, 1))[0]!);
  }
  await page.mouse.up();

  // OrbitControls damping continues after release. These are the frames where tiny residual camera
  // motion used to alternate a leader between the first and last text baselines.
  const frames = [...gestureFrames, ...await samplePaints(page, 90)];
  const flips: string[] = [];
  let subpixelComparisons = 0;
  for (let index = 1; index < frames.length; index += 1) {
    const before = new Map(frames[index - 1]!.map((entry) => [entry.id, entry]));
    for (const current of frames[index]!) {
      const prior = before.get(current.id);
      if (prior === undefined) continue;
      for (let legIndex = 0; legIndex < current.legs.length; legIndex += 1) {
        const leg = current.legs[legIndex];
        const previousLeg = prior.legs[legIndex];
        if (leg === undefined || previousLeg === undefined) continue;
        const anchor = leg[0];
        const previousAnchor = previousLeg[0];
        const end = leg.at(-1);
        const previousEnd = previousLeg.at(-1);
        if (anchor === undefined || previousAnchor === undefined || end === undefined || previousEnd === undefined) continue;
        const anchorMotion = Math.hypot(anchor.x - previousAnchor.x, anchor.y - previousAnchor.y);
        const labelMotion = Math.hypot(current.label.x - prior.label.x, current.label.y - prior.label.y);
        const relativeLandingJump = Math.abs((end.y - current.label.y) - (previousEnd.y - prior.label.y));
        if (anchorMotion < 0.01 && labelMotion < 0.01) subpixelComparisons += 1;
        if (anchorMotion <= 1.5 && labelMotion <= 1.5 && relativeLandingJump > 4) {
          flips.push(`${current.id}/${legIndex}@${index}: ${relativeLandingJump.toFixed(2)}px`);
        }
      }
    }
  }
  // This proves the trajectory reached the near-stationary regime. The exact frozen-camera
  // guarantee is covered by the 300-update unit test; OrbitControls damping is asymptotic and can
  // keep changing its camera matrix by floating-point crumbs for hundreds of browser frames.
  expect(subpixelComparisons).toBeGreaterThan(0);
  expect(flips).toEqual([]);
  const tail = frames.slice(-10);
  expect(tail[0]!.length).toBeGreaterThan(0);
  let largestTailDelta = 0;
  for (let index = 1; index < tail.length; index += 1) {
    expect(tail[index]!.map(({ id, legs }) => ({ id, lengths: legs.map((leg) => leg.length) })))
      .toEqual(tail[index - 1]!.map(({ id, legs }) => ({ id, lengths: legs.map((leg) => leg.length) })));
    const prior = new Map(tail[index - 1]!.map((entry) => [entry.id, entry]));
    for (const current of tail[index]!) {
      const before = prior.get(current.id);
      if (before === undefined) continue;
      largestTailDelta = Math.max(largestTailDelta,
        Math.abs(current.label.x - before.label.x), Math.abs(current.label.y - before.label.y));
      for (let legIndex = 0; legIndex < current.legs.length; legIndex += 1) {
        const previousLeg = before.legs[legIndex];
        if (previousLeg === undefined) continue;
        for (let pointIndex = 0; pointIndex < current.legs[legIndex]!.length; pointIndex += 1) {
          const point = current.legs[legIndex]![pointIndex];
          const previousPoint = previousLeg[pointIndex];
          if (point !== undefined && previousPoint !== undefined) largestTailDelta = Math.max(largestTailDelta,
            Math.abs(point.x - previousPoint.x), Math.abs(point.y - previousPoint.y));
        }
      }
    }
  }
  expect(largestTailDelta).toBeLessThan(0.01);
  expect(runtimeErrors).toEqual([]);
});
