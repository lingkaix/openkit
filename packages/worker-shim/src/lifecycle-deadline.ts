import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

/** Shared lifecycle defaults; adapter-specific limits stay in their owners until adoption. */
export const LIFECYCLE_DEFAULTS = {
  harnessPollMinimumMs: 250,
  harnessRequestMs: 1_000,
  /** Experience default: loaded-host startup missed the former 8s listen ceiling, and the controlled slow-listen regression takes 8.25s. The former listen/session/MCP windows total 24s plus 4s cleanup; 60s leaves loading and preparation margin. */
  nativeOpenMs: 60_000,
  /** Experience default: at most two cold starts, reduced by Sandbox CPU quota and affinity (#245). */
  nativeStartupConcurrency: nativeStartupConcurrency(),
  /** Preserves the existing eight-second native control exchange ceiling. */
  nativeRequestMs: 8_000,
  nativeStopMs: 10_000,
  /** Two existing two-second dedicated-process signal windows belong to cleanup. */
  nativeStopCleanupTailMs: 4_000,
  workerControlRequestMs: 10_000,
  workerControlRetryMs: 250,
  workerControlReadinessMs: 10_000,
  workerHeartbeatIntervalMs: 1_000,
} as const;

/** Caps startup by whole CPUs in the Sandbox's mounted cgroup v2 quota and scheduler affinity. */
function nativeStartupConcurrency(): number {
  let quotaCpus = Number.POSITIVE_INFINITY;
  try {
    const fields = /^(max|[1-9]\d*)\s+([1-9]\d*)$/.exec(
      readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim()
    );
    if (!fields) return 1;
    const period = Number(fields[2]);
    if (!Number.isFinite(period)) return 1;
    if (fields[1] !== 'max') quotaCpus = Number(fields[1]) / period;
  } catch (error) {
    // A missing controller has no quota. An unreadable quota must not allow an extra cold start.
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return 1;
  }
  return Math.max(1, Math.min(2, availableParallelism(), Math.floor(quotaCpus)));
}

/** One local monotonic budget, independent of Core lease authority and native progress. */
export class LifecycleDeadline {
  private readonly endsAt: number;
  private readonly cleanupTailMs: number;

  /** Starts one operation budget, reserving its final portion for cleanup and escalation. */
  public constructor(budgetMs: number, cleanupTailMs = 0) {
    this.endsAt = performance.now() + budgetMs;
    this.cleanupTailMs = Math.min(budgetMs, cleanupTailMs);
  }

  /** Remaining total time, optionally capped by a local exchange ceiling; never a new budget. */
  public remainingMs(maximumMs = Number.POSITIVE_INFINITY): number {
    return Math.max(0, Math.min(maximumMs, this.endsAt - performance.now()));
  }

  /** Remaining ordinary-work time; the reserved tail is available only through remainingMs. */
  public workRemainingMs(maximumMs = Number.POSITIVE_INFINITY): number {
    return Math.max(0, Math.min(maximumMs, this.remainingMs() - this.cleanupTailMs));
  }
}
