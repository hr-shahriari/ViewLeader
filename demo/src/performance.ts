import { ViewLeader, type ViewLeaderDocument } from 'viewleader';
import { markdownPlugin } from 'viewleader/markdown';
import { crowdedDrafts } from './shared/crowdedDrafts';

interface PerformanceProtocol {
  readonly warmupUpdates: number;
  readonly measuredUpdates: number;
  readonly repeats: number;
}

interface PerformanceScenario {
  readonly id: string;
  readonly savedAnnotations: number;
  readonly visibleAnnotations: number;
  readonly mutationBurst: number;
  readonly content: string;
  readonly occlusion: boolean;
  readonly budgetP95Ms: number;
}

interface PerformanceRun {
  readonly repeat: number;
  readonly sampleCount: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly adapterCounts: Readonly<{
    imageRequests: number;
    occlusionBatches: number;
  }>;
}

interface PerformanceReport {
  readonly protocol: PerformanceProtocol;
  readonly environment: Readonly<{
    engine: 'chromium';
    version: string;
    viewport: string;
    devicePixelRatio: number;
  }>;
  readonly scenarios: readonly Readonly<{
    scenario: PerformanceScenario;
    runs: readonly PerformanceRun[];
    medianRun: PerformanceRun;
    passed: boolean;
  }>[];
  readonly passed: boolean;
}

declare global {
  interface Window {
    __VIEWLEADER_PERFORMANCE__: {
      run(protocol: PerformanceProtocol, scenarios: readonly PerformanceScenario[]): Promise<PerformanceReport>;
    };
  }
}

const boundary = required<HTMLElement>('#performance-boundary');
const status = required<HTMLOutputElement>('#performance-status');

window.__VIEWLEADER_PERFORMANCE__ = Object.freeze({ run });
status.textContent = 'ready';

async function run(
  protocol: PerformanceProtocol,
  scenarios: readonly PerformanceScenario[],
): Promise<PerformanceReport> {
  const results: Array<PerformanceReport['scenarios'][number]> = [];
  for (const scenario of scenarios) {
    status.textContent = scenario.id;
    const runs: PerformanceRun[] = [];
    for (let repeat = 0; repeat < protocol.repeats; repeat += 1) {
      console.log(`[performance] ${scenario.id} repeat ${repeat + 1}/${protocol.repeats}`);
      const fixture = await setupScenario(scenario);
      try {
        for (let index = 0; index < protocol.warmupUpdates; index += 1) {
          fixture.update(index);
          await fixture.settle();
        }
        const samples: number[] = [];
        for (let index = 0; index < protocol.measuredUpdates; index += 1) {
          const started = performance.now();
          fixture.update(index + protocol.warmupUpdates);
          samples.push(performance.now() - started);
          await fixture.settle();
        }
        runs.push({ ...summarize(samples, repeat), adapterCounts: fixture.adapterCounts() });
      } finally {
        fixture.dispose();
      }
      await nextFrame();
    }
    const medianRun = [...runs].sort((left, right) => left.p95Ms - right.p95Ms)[
      Math.floor(runs.length / 2)
    ];
    if (medianRun === undefined) throw new Error(`No runs measured for ${scenario.id}`);
    results.push(Object.freeze({
      scenario,
      runs: Object.freeze(runs),
      medianRun,
      passed: medianRun.p95Ms <= scenario.budgetP95Ms,
    }));
    console.log(`[performance] ${scenario.id} p95 ${medianRun.p95Ms.toFixed(3)} ms`);
  }
  status.textContent = 'complete';
  return Object.freeze({
    protocol,
    environment: Object.freeze({
      engine: 'chromium',
      version: /(?:Headless)?Chrome\/([^ ]+)/u.exec(navigator.userAgent)?.[1] ?? 'unknown',
      viewport: '1280x720',
      devicePixelRatio: window.devicePixelRatio,
    }),
    scenarios: Object.freeze(results),
    passed: results.every(({ passed }) => passed),
  });
}

async function setupScenario(scenario: PerformanceScenario): Promise<{
  update(index: number): void;
  settle(): Promise<void>;
  adapterCounts(): PerformanceRun['adapterCounts'];
  dispose(): void;
}> {
  boundary.replaceChildren();
  let cameraOffset = 0;
  let mutationVersion = 0;
  let imageRequests = 0;
  let occlusionBatches = 0;
  // Scene A is built from drafts rather than a generated document: it is the same fixture the
  // layout tests grade, and duplicating it here as counts would be a third "crowded scene".
  const orbiting = scenario.content === 'crowded-orbit';
  const document = orbiting ? undefined : createDocument(scenario);
  const viewLeader = new ViewLeader({
    boundary,
    plugins: [markdownPlugin],
    ...(document === undefined ? {} : { initialDocument: document }),
    adapters: {
      projection: {
        getViewport: () => ({ width: 1_280, height: 720, devicePixelRatio: 1 }),
        getRevision: () => cameraOffset,
        // A yaw orbit for the crowded scene: `cameraOffset` is radians, so anchors round the far
        // side genuinely leave and re-enter the frustum. That is the motion the layout hysteresis,
        // the separation pass and the sector memory all exist to survive, and a projection that
        // only slides sideways never exercises any of them.
        project: orbiting
          ? (point) => {
              const cos = Math.cos(cameraOffset);
              const sin = Math.sin(cameraOffset);
              const depth = point.x * sin + point.z * cos;
              return {
                point: { x: 640 + (point.x * cos - point.z * sin) * 42, y: 620 - point.y * 42 },
                depth,
                visible: depth > -3.2,
              };
            }
          : (point) => ({
              point: { x: point.x + cameraOffset, y: point.y },
              depth: point.z,
              visible: point.z >= 0,
            }),
      },
      images: {
        resolve: async (reference) => {
          imageRequests += 1;
          return ({
            source: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><title>${reference}</title><rect width="1" height="1"/></svg>`)}`,
            width: 1,
            height: 1,
          });
        },
      },
      ...(scenario.occlusion
        ? {
            occlusion: {
              test: async (samples: readonly { annotationId: string; legId: string }[]) => {
                occlusionBatches += 1;
                return samples.map(({ annotationId, legId }) => ({ annotationId, legId, occluded: false }));
              },
            },
          }
        : {}),
    },
  });
  if (orbiting) {
    for (const draft of crowdedDrafts({ width: 1_280, height: 720 })) viewLeader.annotations.create(draft);
  }
  await settleAsyncWork();
  viewLeader.update();
  await settleAsyncWork();

  return {
    update(index) {
      if (scenario.content === 'idle') {
        viewLeader.update();
        return;
      }
      if (scenario.mutationBurst > 0 && index % 10 === 0) {
        mutationVersion += 1;
        viewLeader.history.transaction('performance mutation burst', () => {
          for (let mutation = 0; mutation < scenario.mutationBurst; mutation += 1) {
            const id = `annotation-${mutation % scenario.savedAnnotations}`;
            viewLeader.annotations.update(id, {
              content: { kind: 'plain-note', text: `M${mutationVersion}-${mutation}` },
            });
          }
        });
      } else {
        // One degree per measured update for the orbit — the slow deliberate drag anti-swim targets.
        cameraOffset = orbiting ? (index % 360) * (Math.PI / 180) : (index % 24) * 0.125;
      }
      viewLeader.update();
    },
    settle: settleAsyncWork,
    adapterCounts: () => Object.freeze({ imageRequests, occlusionBatches }),
    dispose() {
      viewLeader.dispose();
      boundary.replaceChildren();
    },
  };
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await nextFrame();
  await Promise.resolve();
}

function createDocument(scenario: PerformanceScenario): ViewLeaderDocument {
  const annotations = Array.from({ length: scenario.savedAnnotations }, (_, index) => {
    const visible = index < scenario.visibleAnnotations;
    const x = 24 + (index % 40) * 30;
    const y = 24 + (Math.floor(index / 40) % 22) * 30;
    const anchor = { kind: 'world-point' as const, point: { x, y, z: visible ? 0 : -1 } };
    const content = scenario.content === 'rich-and-plugin'
      ? index % 3 === 0
        ? {
            kind: 'plugin:viewleader.markdown' as const,
            pluginId: 'viewleader.markdown',
            schemaVersion: 2,
            data: { source: `**Mark ${index}**` },
          }
        : index % 3 === 1
          ? { kind: 'host-image' as const, reference: `asset-${index % 8}`, alt: `Asset ${index}`, width: 48, height: 32 }
          : { kind: 'split-callout' as const, primary: `A${index}`, secondary: 'Review' }
      : { kind: 'plain-note' as const, text: `N${index}` };
    const anchors = scenario.content === 'markup-and-multi-leaders' && visible
      ? [
          { id: 'leg-a', anchor, routing: { kind: 'automatic' as const, mode: 'dogleg' as const } },
          {
            id: 'leg-b',
            anchor: { kind: 'world-point' as const, point: { x: x + 8, y: y + 6, z: 0 } },
            routing: { kind: 'automatic' as const, mode: 'orthogonal' as const },
          },
        ]
      : [{ id: 'leg-a', anchor, routing: { kind: 'automatic' as const, mode: 'straight' as const } }];
    return {
      id: `annotation-${index}`,
      anchors,
      content,
      placement: { kind: 'automatic' as const },
      occlusion: scenario.occlusion ? 'fade' as const : 'keep' as const,
      metadata: {},
    };
  });
  const ink = scenario.content === 'markup-and-multi-leaders'
    ? Array.from({ length: 24 }, (_, index) => ({
        kind: 'ink',
        id: `ink-${index}`,
        plane: {
          origin: { x: 20 + index * 10, y: 600, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
        points: [{ x: 0, y: 0 }, { x: 6, y: 4 }, { x: 12, y: 0 }],
        metadata: {},
      }))
    : [];
  return {
    schema: 'viewleader.document',
    version: 1,
    annotations,
    metadata: {},
    pluginEnvelopes: [],
    definitions: { styles: [], templates: [], terminators: [], enclosures: [] },
    savedViews: [],
    tours: [],
    ink,
  } as ViewLeaderDocument;
}

function summarize(
  samples: readonly number[],
  repeat: number,
): Omit<PerformanceRun, 'adapterCounts'> {
  const ordered = [...samples].sort((left, right) => left - right);
  const percentile = (amount: number): number => ordered[Math.min(
    ordered.length - 1,
    Math.ceil(amount * ordered.length) - 1,
  )] ?? 0;
  return Object.freeze({
    repeat,
    sampleCount: samples.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: ordered.at(-1) ?? 0,
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Missing performance element: ${selector}`);
  return element;
}
