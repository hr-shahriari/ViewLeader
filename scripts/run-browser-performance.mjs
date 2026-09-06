import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PROTOCOL = Object.freeze({
  warmupUpdates: 60,
  measuredUpdates: 600,
  repeats: 5,
});

const SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'camera-motion-500-visible',
    savedAnnotations: 500,
    visibleAnnotations: 500,
    mutationBurst: 0,
    content: 'notes',
    occlusion: false,
    budgetP95Ms: 8,
  }),
  Object.freeze({
    id: 'saved-5000-visible-250',
    savedAnnotations: 5_000,
    visibleAnnotations: 250,
    mutationBurst: 0,
    content: 'notes',
    occlusion: false,
    budgetP95Ms: 8,
  }),
  Object.freeze({
    id: 'idle-500-visible',
    savedAnnotations: 500,
    visibleAnnotations: 500,
    mutationBurst: 0,
    content: 'idle',
    occlusion: false,
    budgetP95Ms: 1,
  }),
  Object.freeze({
    id: 'mutation-burst-100',
    savedAnnotations: 500,
    visibleAnnotations: 500,
    mutationBurst: 100,
    content: 'notes',
    occlusion: false,
    budgetP95Ms: 12,
  }),
  Object.freeze({
    id: 'rich-plugin-content-250',
    savedAnnotations: 500,
    visibleAnnotations: 250,
    mutationBurst: 0,
    content: 'rich-and-plugin',
    occlusion: false,
    budgetP95Ms: 8,
  }),
  Object.freeze({
    id: 'markup-multi-leaders-200',
    savedAnnotations: 500,
    visibleAnnotations: 200,
    mutationBurst: 0,
    content: 'markup-and-multi-leaders',
    occlusion: false,
    budgetP95Ms: 8,
  }),
  // Phase 2.4. The layout pipeline the goal grades — separation, sector hysteresis, slot ordering,
  // the placer — under the camera motion it is graded on. Every other scenario slides the camera
  // sideways, which never makes an anchor leave the frustum and never crosses a centre line, so
  // none of them cost anything the orbit costs. Thirty annotations rather than five hundred because
  // this measures the ALGORITHM's cost per frame, not the renderer's cost at scale.
  Object.freeze({
    id: 'crowded-orbit-30',
    savedAnnotations: 30,
    visibleAnnotations: 30,
    mutationBurst: 0,
    content: 'crowded-orbit',
    occlusion: false,
    // 4 ms, not the 8 the bigger scenarios use. Measured p95 2.3 ms and worst sample 3.6 ms, so
    // this sits just above the worst frame observed rather than at a number nothing could reach:
    // a budget with 4x headroom does not fail on a regression, it only records one after the fact.
    budgetP95Ms: 4,
  }),
  Object.freeze({
    id: 'optional-occlusion-500',
    savedAnnotations: 500,
    visibleAnnotations: 500,
    mutationBurst: 0,
    content: 'notes',
    occlusion: true,
    budgetP95Ms: 8,
  }),
]);

const { values: args } = parseArgs({
  options: {
    output: { type: 'string', default: 'artifacts/performance-results.json' },
    scenario: { type: 'string' },
  },
});
const output = resolve(args.output);
const scenarios = args.scenario === undefined
  ? SCENARIOS
  : SCENARIOS.filter(({ id }) => id === args.scenario);
if (scenarios.length === 0) throw new Error(`Unknown performance scenario: ${args.scenario}`);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = 4174;
const url = `http://127.0.0.1:${port}/performance.html`;
// The demo's own `vite preview`, the same server playwright.config.ts puts under the e2e suite.
// `--silent` so npm does not report the SIGTERM that stops it as a failed lifecycle script.
const preview = spawn(
  'npm',
  ['run', '--silent', 'preview', '--workspace=viewleader-demo', '--', '--port', String(port), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
);

let browser;
try {
  for (let attempt = 0; !(await fetch(url).then((response) => response.ok, () => false)); attempt += 1) {
    if (preview.exitCode !== null || attempt === 150) throw new Error(`vite preview is not serving ${url}`);
    await sleep(200);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 }, deviceScaleFactor: 1 });
  page.on('console', (message) => console.log(message.text()));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('status').waitFor({ state: 'attached' });
  const browserReport = await page.evaluate(
    async ({ protocol, scenarios }) =>
      window.__VIEWLEADER_PERFORMANCE__.run(protocol, scenarios),
    { protocol: PROTOCOL, scenarios },
  );
  const report = {
    ...browserReport,
    environment: {
      ...browserReport.environment,
      browserVersion: browser.version(),
      hostPlatform: process.platform,
      hostArchitecture: process.arch,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
    },
  };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatReport(report));
  console.log(`Performance report: ${output}`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await browser?.close();
  preview.kill();
}

function formatReport(report) {
  const lines = [
    `Environment: ${report.environment.engine ?? 'unknown'} ${report.environment.version ?? ''}`.trim(),
    `Protocol: ${report.protocol.warmupUpdates} warmup + ${report.protocol.measuredUpdates} measured × ${report.protocol.repeats} repeats`,
  ];
  for (const result of report.scenarios) {
    const adapterCounts = result.medianRun.adapterCounts;
    const adapterEvidence = adapterCounts === undefined
      ? ''
      : `; adapters images=${adapterCounts.imageRequests}, occlusion=${adapterCounts.occlusionBatches}`;
    lines.push(
      `${result.passed ? 'PASS' : 'FAIL'} ${result.scenario.id}: median-run p95 ${result.medianRun.p95Ms.toFixed(3)} ms / ${result.scenario.budgetP95Ms.toFixed(3)} ms; median ${result.medianRun.medianMs.toFixed(3)} ms; max ${result.medianRun.maxMs.toFixed(3)} ms${adapterEvidence}`,
    );
  }
  return lines.join('\n');
}
