import { describe, expect, it, vi } from 'vitest';
import { startSchedulerAttemptMaintenanceService } from './scheduler-attempt-maintenance-service.js';

describe('scheduler attempt maintenance service', () => {
  it('keeps stage exceptions private in the default timer warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fault = new Error('/private/maintenance-canary secret-maintenance-canary');
    const service = startSchedulerAttemptMaintenanceService({
      intervalMs: 30_000,
      runRecoveryMaintenance: {
        scheduler: async () => {
          throw fault;
        },
        native: async () => {},
        checkpoints: async () => {},
      },
      setInterval: () => 'fixture-timer',
      clearInterval: () => {},
    });
    try {
      const failure = await service.runOnce().catch((error: AggregateError) => error);
      expect(failure).toMatchObject({ errors: [fault] });
      expect(warn.mock.calls).toEqual([
        [
          JSON.stringify({
            severityText: 'WARN',
            body: 'Scheduler recovery stage failed.',
            attributes: { 'openkit.error.code': 'scheduler.recovery_stage_failed' },
          }),
        ],
        [
          JSON.stringify({
            severityText: 'WARN',
            body: 'Scheduler attempt maintenance failed.',
            attributes: { 'openkit.error.code': 'scheduler.attempt_maintenance_failed' },
          }),
        ],
      ]);
      expect(errorLog).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/maintenance-canary');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-maintenance-canary');
    } finally {
      service.stop();
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('runs all stages in order and reports every stage failure in one pass', async () => {
    const order: string[] = [];
    const faults = [
      new Error('scheduler fault'),
      new Error('native fault'),
      new Error('checkpoint fault'),
    ];
    const onError = vi.fn();
    const service = startSchedulerAttemptMaintenanceService({
      intervalMs: 30_000,
      runRecoveryMaintenance: {
        scheduler: async () => {
          order.push('0');
          throw faults[0];
        },
        native: async () => {
          order.push('1');
          throw faults[1];
        },
        checkpoints: async () => {
          order.push('2');
          throw faults[2];
        },
      },
      onError,
      setInterval: () => 'fixture-timer',
      clearInterval: () => {},
    });
    try {
      const failure = await service.runOnce().catch((error: AggregateError) => error);
      expect(order).toEqual(['0', '1', '2']);
      expect(failure).toMatchObject({
        message: 'Scheduler recovery maintenance failed.',
        errors: faults,
      });
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    } finally {
      service.stop();
    }
  });

  it('starts immediately, schedules future maintenance, and stops cleanly', () => {
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];

    {
      const service = startSchedulerAttemptMaintenanceService({
        runRecoveryMaintenance: {
          scheduler: async () => {},
          native: async () => {},
          checkpoints: async () => {},
        },
        intervalMs: 30_000,
        clearInterval: (handle) => {
          cleared.push(handle);
        },
        setInterval: (callback, intervalMs) => {
          callbacks.push(callback);
          return { intervalMs };
        },
      });

      callbacks[0]?.();
      service.stop();

      expect(callbacks).toHaveLength(1);
      expect(cleared).toEqual([{ intervalMs: 30_000 }]);
    }
  });

  it('serializes restart recovery maintenance and retries after an isolated failure', async () => {
    const callbacks: Array<() => void> = [];
    const errors: unknown[] = [];
    let rejectFirstAttempt: ((error: Error) => void) | undefined;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    });
    let attempts = 0;

    {
      const service = startSchedulerAttemptMaintenanceService({
        runRecoveryMaintenance: {
          scheduler: async () => {
            attempts += 1;
            if (attempts === 1) {
              await firstAttempt;
            }
          },
          native: async () => {},
          checkpoints: async () => {},
        },
        intervalMs: 30_000,
        onError: (error) => errors.push(error),
        setInterval: (callback) => {
          callbacks.push(callback);
          return 'timer';
        },
      });

      await Promise.resolve();
      expect(attempts).toBe(1);

      const active = service.runOnce();
      const overlap = service.runOnce();
      expect(overlap).toBe(active);
      const settled = Promise.allSettled([active, overlap]);
      await Promise.resolve();
      expect(attempts).toBe(1);

      rejectFirstAttempt?.(new Error('NanoHost is not ready'));
      await settled;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(errors).toEqual([
        expect.objectContaining({
          message: 'Scheduler recovery maintenance failed.',
          errors: [expect.objectContaining({ message: 'NanoHost is not ready' })],
        }),
      ]);

      callbacks[0]?.();
      await Promise.resolve();
      expect(attempts).toBe(2);

      service.stop();
    }
  });
});
