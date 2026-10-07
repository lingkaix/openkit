import { describe, expect, it } from 'vitest';
import { startSchedulerAttemptMaintenanceService } from './scheduler-attempt-maintenance-service.js';

describe('scheduler attempt maintenance service', () => {
  it('starts immediately, schedules future maintenance, and stops cleanly', () => {
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];

    {
      const service = startSchedulerAttemptMaintenanceService({
        runRecoveryMaintenance: async () => {},
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
        runRecoveryMaintenance: async () => {
          attempts += 1;
          if (attempts === 1) {
            await firstAttempt;
          }
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
      expect(errors).toEqual([expect.objectContaining({ message: 'NanoHost is not ready' })]);

      callbacks[0]?.();
      await Promise.resolve();
      expect(attempts).toBe(2);

      service.stop();
    }
  });
});
