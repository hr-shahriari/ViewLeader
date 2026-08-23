import { describe, expect, it } from 'vitest';
import {
  PERFORMANCE_PROTOCOL,
  PERFORMANCE_SCENARIOS,
  runPerformanceHarness,
  validatePerformanceReport,
} from '../scripts/performance-harness.mjs';

describe('realistic-scale performance harness protocol', () => {
  it('warms 60, measures 600, repeats five, and gates the median run p95', async () => {
    let clock = 0;
    let updates = 0;
    let disposals = 0;
    const report = await runPerformanceHarness(
      {
        environment: { engine: 'chromium', version: 'pinned-test' },
        async setup(_scenario: unknown, repeat: number) {
          return {
            update({ phase }: { phase: string }) {
              updates += 1;
              if (phase === 'measure') clock += repeat === 4 ? 9 : repeat + 1;
            },
            dispose() { disposals += 1; },
          };
        },
      },
      {
        scenarios: [{
          id: 'camera-motion-500-visible',
          savedAnnotations: 500,
          visibleAnnotations: 500,
          mutationBurst: 0,
          content: 'notes',
          occlusion: false,
          budgetP95Ms: 8,
        }],
        now: () => clock,
      },
    );

    expect(report.protocol).toEqual(PERFORMANCE_PROTOCOL);
    expect(updates).toBe((60 + 600) * 5);
    expect(disposals).toBe(5);
    expect(report.scenarios[0]?.runs).toHaveLength(5);
    expect(report.scenarios[0]?.medianRun.p95Ms).toBe(3);
    expect(report.passed).toBe(true);
  });

  it('rejects incomplete or non-browser evidence with actionable scenario output', () => {
    const errors = validatePerformanceReport({
      protocol: PERFORMANCE_PROTOCOL,
      environment: { engine: 'node' },
      scenarios: [],
    }, { requireChromium: true });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('missing scenarios'),
      'performance evidence must come from Chromium',
    ]));
  });

  it('recomputes outcomes instead of trusting forged report pass flags', () => {
    const scenarios = PERFORMANCE_SCENARIOS.map((scenario, index) => {
      const p95Ms = index === 0 ? scenario.budgetP95Ms + 1 : scenario.budgetP95Ms;
      const runs = Array.from({ length: 5 }, (_, repeat) => ({
        repeat,
        sampleCount: 600,
        medianMs: p95Ms,
        p95Ms,
        maxMs: p95Ms,
        adapterCounts: {
          imageRequests: scenario.id === 'rich-plugin-content-250' ? 1 : 0,
          occlusionBatches: scenario.id === 'optional-occlusion-500' ? 1 : 0,
        },
      }));
      return { scenario, runs, medianRun: runs[2]!, passed: true };
    });
    const errors = validatePerformanceReport({
      protocol: PERFORMANCE_PROTOCOL,
      environment: { engine: 'chromium' },
      scenarios,
      passed: true,
    }, { requireChromium: true });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('camera-motion-500-visible.passed must be derived'),
      expect.stringContaining('camera-motion-500-visible measured'),
      'report.passed must be derived from all canonical scenario measurements',
    ]));
  });
});
