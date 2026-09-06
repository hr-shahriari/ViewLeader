import { defineConfig, devices } from '@playwright/test';

// Allow an isolated test server when the developer already has the demo open on its default port.
const port = Number(process.env['VIEWLEADER_TEST_PORT'] ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VIEWLEADER_TEST_PORT');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['line'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  expect: { timeout: 10_000 },
  webServer: {
    command: `npm run build && npm run preview --workspace=viewleader-demo -- --strictPort --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  // Two engines, because this suite grades geometry. Text measurement, pointer events and SVG focus
  // semantics are exactly where Blink and WebKit diverge, and macOS/iPad field review is a target
  // platform — a layout that is only ever measured in Chromium is only ever correct in Chromium.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
