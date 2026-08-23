import { defineConfig, devices } from '@playwright/test';

const packedDemoDist = process.env['VIEWLEADER_PACKED_DEMO_DIST'];
const serverCommand = packedDemoDist === undefined
  ? 'npm run build && npm run preview --workspace=viewleader-demo -- --strictPort'
  : 'node scripts/serve-demo-dist.mjs';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['line'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  expect: { timeout: 10_000 },
  webServer: {
    command: serverCommand,
    url: 'http://127.0.0.1:4173',
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
