import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  formatPerformanceReport,
  validatePerformanceReport,
} from './performance-harness.mjs';

const resultArgument = process.argv.find((argument) => argument.startsWith('--results='));
const requireContainer = process.argv.includes('--require-container');
if (resultArgument === undefined) {
  console.error([
    'Browser performance evidence is required.',
    'Run the production harness in pinned Chromium, save its JSON report, then call:',
    '  npm run perf:gate -- --results=/absolute/path/to/performance-results.json',
  ].join('\n'));
  process.exitCode = 1;
} else {
  const report = JSON.parse(
    await readFile(resolve(resultArgument.slice('--results='.length)), 'utf8'),
  );
  console.log(formatPerformanceReport(report));
  const errors = validatePerformanceReport(report, { requireChromium: true, requireContainer });
  if (errors.length > 0) {
    console.error(`Performance gate failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('Pinned Chromium performance evidence passed.');
  }
}
