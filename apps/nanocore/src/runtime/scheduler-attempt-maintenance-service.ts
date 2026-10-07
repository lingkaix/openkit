import type { SchedulerExecutionAttemptRecord } from './execution-attempt-records.js';

/** The existing maintenance timer runs independent recovery stages in their required order. */
export interface SchedulerAttemptMaintenanceInput {
  readonly intervalMs: number;
  readonly runRecoveryMaintenance: Readonly<
    Record<'scheduler' | 'native' | 'checkpoints', () => Promise<unknown>>
  >;
  readonly onError?: (error: unknown) => void;
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}
/** Existing timer handle; stopping does not fabricate cancellation or release. */
export interface SchedulerAttemptMaintenanceService {
  readonly runOnce: () => Promise<void>;
  readonly stop: () => void;
}
/** Runs every stage in one single-flight pass and reports all failures after checkpoint classification. */
export function startSchedulerAttemptMaintenanceService(
  input: SchedulerAttemptMaintenanceInput
): SchedulerAttemptMaintenanceService {
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0)
    throw new Error('Attempt maintenance interval must be positive.');
  let stopped = false;
  let active: Promise<void> | null = null;
  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    const operation = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      for (const stage of ['scheduler', 'native', 'checkpoints'] as const) {
        const run = input.runRecoveryMaintenance[stage];
        try {
          await run();
        } catch (error) {
          logRecoveryMaintenanceFailure(stage);
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Scheduler recovery maintenance failed.');
    });
    active = operation;
    void operation
      .finally(() => {
        if (active === operation) active = null;
      })
      .catch(() => {});
    return operation;
  };
  const tick = () => {
    void runOnce().catch((error) => {
      if (input.onError) input.onError(error);
      else
        console.warn(
          JSON.stringify({
            severityText: 'WARN',
            body: 'Scheduler attempt maintenance failed.',
            attributes: { 'openkit.error.code': 'scheduler.attempt_maintenance_failed' },
          })
        );
    });
  };
  const timer = (input.setInterval ?? setInterval)(tick, input.intervalMs);
  tick();
  return {
    runOnce,
    stop: () => {
      if (stopped) return;
      stopped = true;
      (
        input.clearInterval ??
        ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
      )(timer);
    },
  };
}

/** Fixed owner checks are the only diagnostic vocabulary accepted by this maintenance boundary. */
const MAINTENANCE_FAILURE_DIAGNOSTICS = {
  scheduler: ['scheduler.recovery_stage_failed', 'Scheduler recovery stage failed.'],
  native: ['scheduler.native_recovery_stage_failed', 'Native recovery stage failed.'],
  checkpoints: [
    'scheduler.checkpoint_classification_stage_failed',
    'Worker checkpoint classification stage failed.',
  ],
  'attempt-recovery': [
    'scheduler.attempt_recovery_failed',
    'Scheduler attempt recovery check failed.',
  ],
  'failed-publication': [
    'scheduler.failed_attempt_publication_failed',
    'Scheduler failed-attempt product publication check failed.',
  ],
} as const;

/** Emits only an allowlisted maintenance check and known product correlation, keeping exceptions private. */
export function logRecoveryMaintenanceFailure(
  check: keyof typeof MAINTENANCE_FAILURE_DIAGNOSTICS,
  subject?: Pick<
    SchedulerExecutionAttemptRecord,
    'attemptId' | 'workspaceId' | 'threadId' | 'turnId' | 'agentSessionId'
  >
): void {
  const [errorCode, summary] = MAINTENANCE_FAILURE_DIAGNOSTICS[check];
  console.warn(
    JSON.stringify({
      severityText: 'WARN',
      body: summary,
      attributes: {
        'openkit.error.code': errorCode,
        ...(subject
          ? {
              'openkit.attempt.id': subject.attemptId,
              'openkit.workspace.id': subject.workspaceId,
              'openkit.thread.id': subject.threadId,
              'openkit.turn.id': subject.turnId,
              ...(subject.agentSessionId
                ? { 'openkit.agent.session.id': subject.agentSessionId }
                : {}),
            }
          : {}),
      },
    })
  );
}
