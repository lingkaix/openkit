import { describe, expect, it } from 'vitest';

import {
  computeBootReadinessSnapshot,
  createBootReadinessSnapshot,
  createShutdownReadinessSnapshot,
} from './readiness.js';

describe('boot readiness computation', () => {
  it('creates a ready snapshot by default', () => {
    expect(createBootReadinessSnapshot()).toMatchObject({
      acceptingProductWork: true,
      overall: 'ready',
      subsystems: {
        config: { state: 'ready', reasons: [] },
        storage: { state: 'ready', reasons: [] },
        policy: { state: 'ready', reasons: [] },
      },
    });
  });

  it('keeps product admission open for non-critical degradation', () => {
    expect(
      computeBootReadinessSnapshot({
        bootId: 'boot_test',
        subsystems: {
          vault: {
            state: 'degraded',
            reasons: [
              {
                code: 'vault.locked',
                message: 'Vault is locked.',
                blocks: ['vault.read'],
              },
            ],
          },
        },
      })
    ).toMatchObject({
      acceptingProductWork: true,
      overall: 'degraded',
      subsystems: {
        vault: { state: 'degraded' },
      },
    });
  });

  it('stops product admission when a critical subsystem fails', () => {
    expect(
      computeBootReadinessSnapshot({
        bootId: 'boot_test',
        subsystems: {
          storage: {
            state: 'failed',
            reasons: [
              {
                code: 'storage.migration_failed',
                message: 'Storage migration failed.',
                blocks: ['product_work'],
              },
            ],
          },
        },
      })
    ).toMatchObject({
      acceptingProductWork: false,
      overall: 'failed',
      subsystems: {
        storage: { state: 'failed' },
      },
    });
  });

  it('closes product admission for orderly shutdown without marking liveness failed', () => {
    expect(
      createShutdownReadinessSnapshot(
        computeBootReadinessSnapshot({
          bootId: 'boot_test',
        })
      )
    ).toMatchObject({
      acceptingProductWork: false,
      overall: 'degraded',
      subsystems: {
        scheduler: {
          state: 'degraded',
          reasons: [
            {
              code: 'shutdown.in_progress',
              blocks: ['product_work'],
            },
          ],
        },
      },
    });
  });
});
