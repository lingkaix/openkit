/** Shared lifecycle defaults; adapter-specific limits stay in their owners until adoption. */
export const LIFECYCLE_DEFAULTS = {
  harnessPollMinimumMs: 250,
  harnessRequestMs: 1_000,
  nativeStopMs: 10_000,
  /** Two existing two-second dedicated-process signal windows belong to cleanup. */
  nativeStopCleanupTailMs: 4_000,
  workerControlRequestMs: 10_000,
  workerControlRetryMs: 250,
  workerControlReadinessMs: 10_000,
  workerHeartbeatIntervalMs: 1_000,
} as const;

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
