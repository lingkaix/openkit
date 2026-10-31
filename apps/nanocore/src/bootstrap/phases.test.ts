import { describe, expect, it, vi } from 'vitest';

import { formatBootFailureMessage, runBootPhases } from './phases.js';

describe('boot phase runner', () => {
  it('runs no boot phase when shutdown was requested before boot', async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    const run = vi.fn(() => ({ status: 'ok' as const }));
    const input = {
      bootId: 'boot_shutdown_before_start',
      signal: shutdown.signal,
      phases: [{ name: 'config', subsystem: 'config' as const, critical: true, run }],
    };
    const result = await runBootPhases(input);

    expect(run).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([]);
    expect(result.readiness.acceptingProductWork).toBe(false);
    expect(result.readiness.subsystems.scheduler.reasons).toContainEqual(
      expect.objectContaining({ code: 'shutdown.in_progress', blocks: ['product_work'] })
    );
  });

  it('joins the entered phase but stops successors after an orderly shutdown request', async () => {
    const shutdown = new AbortController();
    const entered = Promise.withResolvers<void>();
    const settle = Promise.withResolvers<void>();
    const order: string[] = [];
    const input = {
      bootId: 'boot_shutdown_during_phase',
      signal: shutdown.signal,
      phases: [
        {
          name: 'config',
          subsystem: 'config' as const,
          critical: true,
          async run() {
            order.push('entered');
            entered.resolve();
            await settle.promise;
            order.push('settled');
            return { status: 'ok' as const };
          },
        },
        {
          name: 'policy',
          subsystem: 'policy' as const,
          critical: true,
          run() {
            order.push('successor');
            return { status: 'ok' as const };
          },
        },
      ],
    };
    const running = runBootPhases(input);
    await entered.promise;
    shutdown.abort();
    settle.resolve();
    const result = await running;

    expect(order).toEqual(['entered', 'settled']);
    expect(result.outcomes.map((outcome) => outcome.name)).toEqual(['config']);
    expect(result.readiness.acceptingProductWork).toBe(false);
    expect(result.readiness.subsystems.scheduler.reasons).toContainEqual(
      expect.objectContaining({ code: 'shutdown.in_progress', blocks: ['product_work'] })
    );
  });

  it('runs phases in order and returns a ready snapshot when every phase succeeds', async () => {
    const order: string[] = [];
    const result = await runBootPhases({
      bootId: 'boot_test',
      phases: [
        {
          name: 'config',
          subsystem: 'config',
          critical: true,
          run: () => {
            order.push('config');
            return { status: 'ok' };
          },
        },
        {
          name: 'storage',
          subsystem: 'storage',
          critical: true,
          run: () => {
            order.push('storage');
            return { status: 'ok' };
          },
        },
      ],
    });

    expect(order).toEqual(['config', 'storage']);
    expect(result.outcomes).toHaveLength(2);
    expect(result.readiness).toMatchObject({
      acceptingProductWork: true,
      overall: 'ready',
      subsystems: { config: { state: 'ready' }, storage: { state: 'ready' } },
    });
  });

  it('stops before later phases when a critical phase fails', async () => {
    const order: string[] = [];
    const result = await runBootPhases({
      bootId: 'boot_test',
      phases: [
        {
          name: 'storage',
          subsystem: 'storage',
          critical: true,
          run: () => {
            order.push('storage');
            return {
              status: 'failed',
              reason: {
                code: 'storage.failed',
                message: 'Storage failed.',
                blocks: ['product_work'],
              },
            };
          },
        },
        {
          name: 'policy',
          subsystem: 'policy',
          critical: true,
          run: () => {
            order.push('policy');
            return { status: 'ok' };
          },
        },
      ],
    });

    expect(order).toEqual(['storage']);
    expect(result.readiness).toMatchObject({
      acceptingProductWork: false,
      overall: 'failed',
      subsystems: { storage: { state: 'failed' } },
    });
  });

  it('records thrown critical phase errors as failed outcomes', async () => {
    const result = await runBootPhases({
      bootId: 'boot_test',
      phases: [
        {
          name: 'migrations',
          subsystem: 'storage',
          critical: true,
          run: () => {
            throw new Error('Migration failed.');
          },
        },
      ],
    });

    expect(result.outcomes[0]).toMatchObject({
      name: 'migrations',
      outcome: {
        status: 'failed',
        reason: {
          code: 'migrations.failed',
          message: 'Migration failed.',
          blocks: ['product_work'],
        },
      },
    });
    expect(result.readiness.acceptingProductWork).toBe(false);
    expect(formatBootFailureMessage(result)).toBe(
      'NanoCore boot failed during critical phase "migrations": Migration failed.'
    );
  });

  it('continues after a critical phase reports bounded degradation', async () => {
    const order: string[] = [];
    const result = await runBootPhases({
      bootId: 'boot_test',
      phases: [
        {
          name: 'scheduler',
          subsystem: 'scheduler',
          critical: true,
          run: () => {
            order.push('scheduler');
            return {
              status: 'degraded',
              reason: {
                code: 'scheduler.checkpoint_recovery_required',
                message: 'One worker checkpoint requires inspection.',
                blocks: [],
              },
            };
          },
        },
        {
          name: 'vault',
          subsystem: 'vault',
          critical: false,
          run: () => {
            order.push('vault');
            return { status: 'ok' };
          },
        },
      ],
    });

    expect(order).toEqual(['scheduler', 'vault']);
    expect(result.readiness).toMatchObject({
      acceptingProductWork: true,
      overall: 'degraded',
      subsystems: { scheduler: { state: 'degraded' }, vault: { state: 'ready' } },
    });
  });

  it('keeps storage ready when a later ok outcome carries an informational reason', async () => {
    const informational = {
      code: 'storage.index-rebuilt',
      message: 'Rebuilt 1 workspace index set(s).',
      blocks: [],
    };
    const result = await runBootPhases({
      bootId: 'boot_index_rebuilt',
      phases: [
        {
          name: 'data-root-layout',
          subsystem: 'storage',
          critical: true,
          run: () => ({ status: 'ok' }),
        },
        {
          name: 'migrations',
          subsystem: 'storage',
          critical: true,
          run: () => ({ status: 'ok', reasons: [informational] }),
        },
      ],
    });

    expect(result.readiness.overall).toBe('ready');
    expect(result.readiness.acceptingProductWork).toBe(true);
    expect(result.readiness.subsystems.storage).toEqual({
      state: 'ready',
      reasons: [informational],
    });
  });

  it('appends an informational ok reason without clearing an earlier degraded state', async () => {
    const degraded = {
      code: 'storage.maintenance',
      message: 'Storage is reduced.',
      blocks: [],
    };
    const informational = {
      code: 'storage.index-rebuilt',
      message: 'Rebuilt 1 workspace index set(s).',
      blocks: [],
    };
    const result = await runBootPhases({
      bootId: 'boot_index_after_degraded',
      phases: [
        {
          name: 'maintenance',
          subsystem: 'storage',
          critical: true,
          run: () => ({ status: 'degraded', reason: degraded }),
        },
        {
          name: 'migrations',
          subsystem: 'storage',
          critical: true,
          run: () => ({ status: 'ok', reasons: [informational] }),
        },
      ],
    });

    expect(result.readiness.overall).toBe('degraded');
    expect(result.readiness.subsystems.storage).toEqual({
      state: 'degraded',
      reasons: [degraded, informational],
    });
  });
});
