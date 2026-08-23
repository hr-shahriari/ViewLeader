export interface PerformanceProtocol {
  readonly warmupUpdates: number;
  readonly measuredUpdates: number;
  readonly repeats: number;
}

export interface PerformanceScenario {
  readonly id: string;
  readonly savedAnnotations: number;
  readonly visibleAnnotations: number;
  readonly mutationBurst: number;
  readonly content: string;
  readonly occlusion: boolean;
  readonly budgetP95Ms: number;
}

export interface PerformanceRun {
  readonly repeat: number;
  readonly sampleCount: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly adapterCounts?: Readonly<{
    imageRequests: number;
    occlusionBatches: number;
  }>;
}

export interface PerformanceReport {
  readonly protocol: PerformanceProtocol;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly scenarios: readonly {
    readonly scenario: PerformanceScenario;
    readonly runs: readonly PerformanceRun[];
    readonly medianRun: PerformanceRun;
    readonly passed: boolean;
  }[];
  readonly passed: boolean;
}

export const PERFORMANCE_PROTOCOL: Readonly<PerformanceProtocol>;
export const PERFORMANCE_PROFILE: string;
export const PERFORMANCE_SCENARIOS: readonly Readonly<PerformanceScenario>[];

export function runPerformanceHarness(
  driver: {
    readonly environment: Readonly<Record<string, unknown>>;
    setup(
      scenario: PerformanceScenario,
      repeat: number,
    ): Promise<{
      update(context: {
        readonly phase: 'warmup' | 'measure';
        readonly index: number;
        readonly repeat: number;
      }): void | Promise<void>;
      dispose(): void | Promise<void>;
    }>;
  },
  options?: {
    readonly protocol?: Partial<PerformanceProtocol>;
    readonly scenarios?: readonly PerformanceScenario[];
    readonly now?: () => number;
  },
): Promise<PerformanceReport>;

export function formatPerformanceReport(report: PerformanceReport): string;
export function validatePerformanceReport(
  report: Partial<PerformanceReport> & Record<string, unknown>,
  options?: { readonly requireChromium?: boolean; readonly requireContainer?: boolean },
): readonly string[];
