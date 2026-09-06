import { expect, test, type Page } from '@playwright/test';
import type { ViewLeader } from 'viewleader';

function watchRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

test('editor and workbench expose accessible organization controls', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await page.goto('/leader-editor/');
  await expect(page.locator('body')).toHaveAttribute('data-vl-ready', '1');
  const placement = page.getByLabel('Leader placement');
  await expect(placement).toHaveText(/Quadrant routing/);
  await placement.selectOption('quadrants');
  const outside = page.getByLabel('Keep labels outside model');
  await outside.check();
  await expect.poll(() => page.evaluate(() => {
    const vl = window.vl as ViewLeader;
    return [vl.placementMode, vl.keepLabelsOutsideModel];
  })).toEqual(['quadrants', true]);
  // The viewer policy is transient, while authored placement survives the document round trip.
  // Exercise both on the same instance: switching organization must not overwrite manual work.
  await page.evaluate(() => {
    const vl = window.vl as ViewLeader;
    vl.annotations.update('roof', { placement: { kind: 'manual', position: { x: 42, y: 73 } } });
  });
  await page.getByRole('button', { name: 'Save' }).click();
  await page.evaluate(() => {
    const vl = window.vl as ViewLeader;
    vl.annotations.update('roof', { placement: { kind: 'automatic' } });
  });
  await page.getByRole('button', { name: 'Load' }).click();
  await expect.poll(() => page.evaluate(() => {
    const vl = window.vl as ViewLeader;
    return vl.annotations.getSnapshot().annotations.find((annotation) => annotation.id === 'roof')?.placement;
  })).toEqual({ kind: 'manual', position: { x: 42, y: 73 } });
  await outside.uncheck();
  await placement.selectOption('auto');

  await page.goto('/workbench/');
  await expect(page.locator('body')).toHaveAttribute('data-vl-ready', '1');
  await page.getByRole('button', { name: 'Dispose' }).click();
  await expect(page.getByLabel('Leader placement')).toBeDisabled();
  await expect(page.getByLabel('Keep labels outside model')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('strict quadrant example keeps rendered labels outside the raw model rectangle at close zoom', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await page.goto('/organized-leaders/');
  await expect(page.locator('body')).toHaveAttribute('data-vl-ready', '1');
  await expect(page.getByLabel('Leader placement')).toHaveValue('quadrants');
  await expect(page.getByLabel('Keep labels outside model')).toBeChecked();
  const fitted = await page.evaluate(() => {
    (window.vl as ViewLeader).update();
    const viewport = document.querySelector('#viewport')!.getBoundingClientRect();
    const dock = document.querySelector('.control-dock')!.getBoundingClientRect();
    const labels = [...document.querySelectorAll('[data-hit-target="label"]')].map((label) => label.getBoundingClientRect());
    return { count: labels.length, allVisible: labels.every((box) => box.left >= viewport.left
      && box.right <= viewport.right && box.top >= viewport.top && box.bottom <= dock.top) };
  });
  expect(fitted).toEqual({ count: 16, allVisible: true });
  await page.getByRole('button', { name: 'Zoom in' }).click();

  const result = await page.evaluate(() => {
    // The click updates the camera synchronously; WebKit can evaluate before the host's next
    // animation frame. Compare bounds and rendered labels from the same camera revision.
    (window.vl as ViewLeader).update();
    const viewport = document.querySelector('#viewport')!.getBoundingClientRect();
    const projected = window.organizationDemo!.bounds();
    if (projected.status !== 'available') return { status: projected.status, labels: [] };
    const labels = [...document.querySelectorAll<HTMLElement>('[data-hit-target="label"]')].map((label) => {
      const box = label.getBoundingClientRect();
      return { x: box.x - viewport.x, y: box.y - viewport.y, width: box.width, height: box.height };
    });
    return { status: projected.status, bounds: projected.bounds, labels };
  });
  expect(result.status).toBe('available');
  if (result.status === 'available') {
    expect(result.labels.length).toBeGreaterThan(0);
    for (const label of result.labels) {
      const overlaps = label.x < result.bounds.max.x && result.bounds.min.x < label.x + label.width
        && label.y < result.bounds.max.y && result.bounds.min.y < label.y + label.height;
      expect(overlaps).toBe(false);
    }
  }
  expect(errors).toEqual([]);
});

test('organized leaders fade and dash occluded anchors after orbit without fading labels', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await page.goto('/organized-leaders/');
  await expect(page.locator('body')).toHaveAttribute('data-vl-ready', '1');
  const routes = page.locator('[data-route-visible]');
  const hiddenRoutes = page.locator('[data-route-visible][stroke-dasharray]');
  await expect(routes).toHaveCount(16);
  await expect(hiddenRoutes).toHaveCount(0);

  // Both views use the same anchors and actual building raycasts. The rear view hides every
  // front-face anchor; returning to the front must clear the cached occlusion verdicts.
  await page.getByRole('button', { name: 'Orbit', exact: true }).click();
  await expect(hiddenRoutes).toHaveCount(16);
  await expect.poll(() => hiddenRoutes.evaluateAll((paths) =>
    paths.every((path) => path.getAttribute('stroke-dasharray') === '6 4'
      && path.getAttribute('stroke-opacity') === '0.55'))).toBe(true);
  await expect.poll(() => page.locator('[data-annotation-id]').evaluateAll((annotations) =>
    annotations.length === 16 && annotations.every((annotation) => annotation.getAttribute('opacity') === '1'))).toBe(true);

  await page.getByRole('button', { name: 'Fit model' }).click();
  await expect(routes).toHaveCount(16);
  await expect(hiddenRoutes).toHaveCount(0);
  await expect.poll(() => routes.evaluateAll((paths) =>
    paths.every((path) => !path.hasAttribute('stroke-opacity')))).toBe(true);
  expect(errors).toEqual([]);
});

test('the side view routes clustered anchors out of the full model before spreading to labels', async ({ page }) => {
  const errors = watchRuntimeErrors(page);
  await page.goto('/organized-leaders/');
  await expect(page.locator('body')).toHaveAttribute('data-vl-ready', '1');
  await page.getByRole('button', { name: 'Side view' }).click();
  const result = await page.evaluate(() => {
    const vl = window.vl as ViewLeader;
    vl.update();
    return {
      frame: window.organizationDemo!.bounds(),
      geometry: vl.annotations.getSnapshot().annotations.flatMap(({ id }) => {
        const geometry = vl.geometry.of(id);
        return geometry ? [geometry] : [];
      }),
    };
  });
  expect(result.frame.status).toBe('available');
  expect(result.geometry).toHaveLength(16);
  if (result.frame.status === 'available') {
    for (const { label, legs } of result.geometry) {
      expect(label.x).toBeGreaterThan(result.frame.bounds.max.x);
      for (const [anchor, exit] of legs) {
        expect(exit!.x).toBeCloseTo(result.frame.bounds.max.x, 3);
        expect(exit!.y).toBeCloseTo(anchor!.y, 3);
      }
    }
    const sorted = result.geometry.map(({ label }) => label).sort((a, b) => a.y - b.y);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]!.y).toBeGreaterThan(sorted[index - 1]!.y + sorted[index - 1]!.height);
    }
  }
  expect(errors).toEqual([]);
});
