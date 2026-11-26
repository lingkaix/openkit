import { stat } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { CONTROL_STORE_BUDGET, type ControlStorePressure } from './control-store.js';

const SAMPLE_INTERVAL_MS = 5_000;
const COMMIT_WINDOW = 128;

type Scope =
  | { scope: 'core' | 'server-work' }
  | { scope: 'workspace'; 'openkit.workspace.id': string };

const writers = new WeakMap<Database.Database, ControlStorePressureTelemetry>();

/** Records physical observation body growth only on a sampled native owner. */
export function recordObservationBodyGrowth(sqlite: Database.Database, bytes: number): void {
  writers.get(sqlite)?.recordBodyGrowth(bytes);
}

/** Samples successful native COMMITs and attributes growth to the physical owner. */
export class ControlStorePressureTelemetry {
  private readonly commits: number[] = [];
  private lastSampleAt: number | undefined;
  private samplePending = false;
  private commitIndex = 0;
  private bodyGrowthBytes = 0;
  private cutoffResponses = 0;

  constructor(
    sqlite: Database.Database,
    private readonly path: string,
    private readonly scope: Scope,
    private readonly emit: (sample: Readonly<Record<string, unknown>>) => void = (sample) =>
      console.info(JSON.stringify(sample))
  ) {
    writers.set(sqlite, this);
  }

  recordBodyGrowth(bytes: number): void {
    this.bodyGrowthBytes += bytes;
  }

  /** Samples a successful COMMIT or blocked checkpoint after the deciding write path. */
  observe(
    commitMs: number | undefined,
    cutoffResponses: number,
    now: number,
    live: () => ControlStorePressure & {
      checkpointAgeMs: number | null;
      queued: number;
      open: number;
    }
  ): void {
    if (commitMs !== undefined) this.commits[this.commitIndex++ % COMMIT_WINDOW] = commitMs;
    this.cutoffResponses += cutoffResponses;
    const previousSample = this.lastSampleAt;
    this.lastSampleAt ??= now;
    if (
      this.samplePending ||
      previousSample === undefined ||
      now - previousSample < SAMPLE_INTERVAL_MS
    )
      return;
    this.lastSampleAt = now;
    this.samplePending = true;
    const commits = [...this.commits].sort((left, right) => left - right);
    const p99 = commits[Math.ceil(commits.length * 0.99) - 1] ?? null;
    this.commits.length = 0;
    this.commitIndex = 0;
    const bodyGrowthBytes = this.bodyGrowthBytes;
    const count = this.cutoffResponses;
    this.bodyGrowthBytes = 0;
    this.cutoffResponses = 0;
    void Promise.resolve()
      .then(async () => {
        const pressure = live();
        const databaseBytes = (await stat(this.path)).size;
        const budget = CONTROL_STORE_BUDGET;
        this.emit({
          event: 'openkit.control_store.pressure',
          ...this.scope,
          databaseBytes,
          walBytes: pressure.walBytes,
          walAgeMs: pressure.walAgeMs,
          checkpointAgeMs: pressure.checkpointAgeMs,
          queued: pressure.queued,
          open: pressure.open,
          commitP99Ms: p99,
          commitSamples: commits.length,
          bodyGrowthBytes,
          cutoffResponses: count,
          windowMs: now - previousSample,
          checkpointDue:
            pressure.walBytes >= budget.checkpointBytes ||
            pressure.walAgeMs >= budget.checkpointAgeMs,
          walPressure:
            pressure.walBytes >= budget.maxWalBytes || pressure.walAgeMs >= budget.maxWalAgeMs,
        });
      })
      .catch(() => {}) // Missing samples never refuse or delay an owner write.
      .finally(() => {
        this.samplePending = false;
      });
  }
}
