import { expect, test, type Page } from '@playwright/test';
import type { ViewLeader } from 'viewleader';

test.use({ viewport: { width: 1280, height: 720 } });

function watchRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

test('IFC studio organizes real loaded-model annotations through camera and policy changes', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = watchRuntimeErrors(page);
  await page.goto('/ifc-studio/');
  await expect(page.locator('body')).toHaveAttribute('data-vl-ready', '1');

  // Overlay readiness deliberately precedes the worker parse. Wait for the page's model lifecycle
  // signal so missing, failed, or still-loading IFC data cannot pass on the two placeholder notes.
  await page.waitForFunction(() => document.body.dataset['ifcLoaded'] !== undefined);
  expect(await page.locator('body').getAttribute('data-ifc-loaded')).toBe('1');
  await expect(page.locator('.model-tree details')).not.toHaveCount(0);
  await expect(page.getByLabel('Leader placement')).toHaveValue('quadrants');
  await expect(page.getByLabel('Keep labels outside model')).toBeChecked();

  const elementAnchors = await page.evaluate(() => {
    const vl = window.vl as ViewLeader;
    return vl.annotations.getSnapshot().annotations.flatMap(({ anchors }) => anchors)
      .filter(({ anchor }) => anchor.kind === 'element').length;
  });
  expect(elementAnchors).toBe(3);

  for (const view of ['Fit model', 'Side view'] as const) {
    await page.getByRole('button', { name: view, exact: true }).click();
    const readGeometry = () => page.evaluate(() => {
      const vl = window.vl as ViewLeader;
      const hook = window.ifcStudioOrganization!;
      vl.update();
      const frame = hook.bounds();
      const labels = vl.annotations.getSnapshot().annotations.flatMap(({ id }) => {
        const geometry = vl.geometry.of(id);
        return geometry === undefined ? [] : [geometry.label];
      });
      const viewport = document.querySelector('#viewport')!.getBoundingClientRect();
      const tree = document.querySelector('.model-tree')!.getBoundingClientRect();
      const inspector = document.querySelector('.side-panel')!.getBoundingClientRect();
      const renderedLabels = [...document.querySelectorAll<SVGGraphicsElement>('[data-hit-target="label"]')]
        .map((label) => label.getBoundingClientRect())
        .map((label) => ({ left: label.left, right: label.right, top: label.top, bottom: label.bottom }));
      return {
        frame,
        labels,
        renderedLabels,
        available: { left: tree.right, right: inspector.left, top: viewport.top, bottom: viewport.bottom },
      };
    });
    await expect.poll(async () => (await readGeometry()).frame.status).toBe('available');
    const result = await readGeometry();
    expect(result.labels.length).toBeGreaterThan(0);
    expect(result.renderedLabels.length).toBe(result.labels.length);
    for (const label of result.renderedLabels) {
      expect(label.left, `${view} label is under the model tree`).toBeGreaterThanOrEqual(result.available.left);
      expect(label.right, `${view} label is under the inspector`).toBeLessThanOrEqual(result.available.right);
      expect(label.top, `${view} label is above the viewport`).toBeGreaterThanOrEqual(result.available.top);
      expect(label.bottom, `${view} label is below the viewport`).toBeLessThanOrEqual(result.available.bottom);
    }
    if (result.frame.status === 'available') {
      for (const label of result.labels) {
        const overlaps = label.x < result.frame.bounds.max.x && result.frame.bounds.min.x < label.x + label.width
          && label.y < result.frame.bounds.max.y && result.frame.bounds.min.y < label.y + label.height;
        expect(overlaps, `${view} label overlaps the loaded IFC bounds`).toBe(false);
      }
    }
  }

  await page.getByRole('button', { name: 'Rear view', exact: true }).click();
  const hiddenRoutes = page.locator('[data-route-visible][stroke-dasharray]');
  await expect.poll(() => hiddenRoutes.count()).toBeGreaterThan(0);
  await expect.poll(() => hiddenRoutes.evaluateAll((paths) => paths.every((path) =>
    path.getAttribute('stroke-dasharray') === '6 4' && path.getAttribute('stroke-opacity') === '0.55'))).toBe(true);
  await expect.poll(() => page.locator('[data-annotation-id]').evaluateAll((annotations) =>
    annotations.length > 0 && annotations.every((annotation) => annotation.getAttribute('opacity') === '1'))).toBe(true);

  // Organization controls change transient viewer policy. Authored manual placement remains part of
  // the document while those policies are switched off and restored on the same instance.
  await page.evaluate(() => {
    const vl = window.vl as ViewLeader;
    vl.annotations.update('welcome', { placement: { kind: 'manual', position: { x: 42, y: 73 } } });
  });
  await page.getByLabel('Keep labels outside model').uncheck();
  await page.getByLabel('Leader placement').selectOption('auto');
  await page.getByLabel('Leader placement').selectOption('quadrants');
  await page.getByLabel('Keep labels outside model').check();
  await expect.poll(() => page.evaluate(() => {
    const vl = window.vl as ViewLeader;
    return vl.annotations.getSnapshot().annotations.find(({ id }) => id === 'welcome')?.placement;
  })).toEqual({ kind: 'manual', position: { x: 42, y: 73 } });

  expect(errors).toEqual([]);
});
