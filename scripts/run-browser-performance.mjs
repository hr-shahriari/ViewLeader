import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PERFORMANCE_PROTOCOL,
  PERFORMANCE_SCENARIOS,
  formatPerformanceReport,
} from './performance-harness.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='));
const scenarioArgument = process.argv.find((argument) => argument.startsWith('--scenario='));
const output = resolve(outputArgument?.slice('--output='.length) ?? 'artifacts/performance-results.json');
const scenarios = scenarioArgument === undefined
  ? PERFORMANCE_SCENARIOS
  : PERFORMANCE_SCENARIOS.filter(({ id }) => id === scenarioArgument.slice('--scenario='.length));
if (scenarios.length === 0) throw new Error(`Unknown performance scenario: ${scenarioArgument}`);
const port = 4174;
const dist = resolve(root, 'demo/dist');
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
    const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (file !== dist && !file.startsWith(`${dist}${sep}`)) throw new Error('Invalid path');
    response.statusCode = 200;
    response.setHeader('content-type', contentType(file));
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
});
await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(port, '127.0.0.1', resolveListen);
});

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1_280, height: 720 }, deviceScaleFactor: 1 });
  page.on('console', (message) => console.log(message.text()));
  await page.goto(`http://127.0.0.1:${port}/performance.html`, { waitUntil: 'networkidle' });
  await page.getByRole('status').waitFor({ state: 'attached' });
  const browserReport = await page.evaluate(
    async ({ protocol, scenarios }) =>
      window.__VIEWLEADER_PERFORMANCE__.run(protocol, scenarios),
    { protocol: PERFORMANCE_PROTOCOL, scenarios },
  );
  const report = Object.freeze({
    ...browserReport,
    environment: Object.freeze({
      ...browserReport.environment,
      browserVersion: browser.version(),
      hostPlatform: process.platform,
      hostArchitecture: process.arch,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      containerProfile: process.env['VIEWLEADER_PERFORMANCE_CONTAINER'] ?? 'local-host',
    }),
  });
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatPerformanceReport(report));
  console.log(`Performance report: ${output}`);
} catch (error) {
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

function contentType(file) {
  switch (extname(file)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
