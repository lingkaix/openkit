import { describe, expect, it } from 'vitest';

import { formatBootFailureMessage, runBootPhases } from './phases.js';

describe('boot phase runner', () => {
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

  it('continues after a non-critical degraded phase', async () => {
    const order: string[] = [];
    const result = await runBootPhases({
      bootId: 'boot_test',
      phases: [
        {
          name: 'vault',
          subsystem: 'vault',
          critical: false,
          run: () => {
            order.push('vault');
            return {
              status: 'degraded',
              reason: {
                code: 'vault.locked',
                message: 'Vault is locked.',
                blocks: ['vault.read'],
              },
            };
          },
        },
        {
          name: 'scheduler',
          subsystem: 'scheduler',
          critical: false,
          run: () => {
            order.push('scheduler');
            return { status: 'ok' };
          },
        },
      ],
    });

    expect(order).toEqual(['vault', 'scheduler']);
    expect(result.readiness).toMatchObject({
      acceptingProductWork: true,
      overall: 'degraded',
      subsystems: { vault: { state: 'degraded' }, scheduler: { state: 'ready' } },
    });
  });
});
