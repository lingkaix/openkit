import { describe, expect, it } from 'vitest';
import { startOpenShellRefreshStatusPollingService } from './openshell-refresh-status-polling-service';
import type { WorkerGovernanceEvidenceRecord } from './worker-governance-backend';

describe('OpenShell refresh status polling service', () => {
  it('starts immediately, schedules future polls, and stops cleanly', async () => {
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];
    const calls: string[] = [];
    const evidence: WorkerGovernanceEvidenceRecord = {
      data: { providerInstanceId: 'provider_github_read' },
      kind: 'openshell.provider.refresh_status',
      timestamp: '2026-07-07T00:00:00.000Z',
    };
    const service = startOpenShellRefreshStatusPollingService({
      collector: {
        collectProviderRefreshStatuses: async () => {
          calls.push('poll');
          return [evidence];
        },
      },
      intervalMs: 60_000,
      clearInterval: (handle) => {
        cleared.push(handle);
      },
      setInterval: (callback, intervalMs) => {
        callbacks.push(callback);
        return { intervalMs };
      },
    });

    await service.runOnce();
    callbacks[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.stop();
    await expect(service.runOnce()).resolves.toBeNull();

    expect(calls).toEqual(['poll', 'poll', 'poll']);
    expect(callbacks).toHaveLength(1);
    expect(cleared).toEqual([{ intervalMs: 60_000 }]);
  });

  it('reports polling errors without stopping the service', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const service = startOpenShellRefreshStatusPollingService({
      collector: {
        collectProviderRefreshStatuses: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('refresh status unavailable');
          }
          return [];
        },
      },
      intervalMs: 60_000,
      onError: (error) => {
        errors.push(error);
      },
      setInterval: () => 'timer',
      clearInterval: () => undefined,
    });

    await service.runOnce();
    await expect(service.runOnce()).resolves.toEqual([]);
    service.stop();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });
});
