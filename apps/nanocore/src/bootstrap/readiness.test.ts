import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  computeBootReadinessSnapshot,
  computeCurrentReadiness,
  createBootReadinessSnapshot,
  createShutdownReadinessSnapshot,
  refuseScope,
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

// The new existing-owner seam takes observations from their current owners; it
// does not own a health probe or replace independent boot/shutdown diagnoses.
describe('current subsystem readiness', () => {
  it('replaces the boot Vault diagnosis as its current health changes', () => {
    const snapshot = computeBootReadinessSnapshot({
      bootId: 'boot_live_vault',
      subsystems: {
        vault: {
          state: 'degraded',
          reasons: [{ code: 'vault.locked', message: 'Vault is locked.', blocks: ['vault.use'] }],
        },
      },
    });
    const input = {
      snapshot,
      dataRoot: `/tmp/openkit-readiness-${randomUUID()}`,
      llmGatewayAvailable: true,
    };

    const locked = computeCurrentReadiness({ ...input, vaultHealth: 'locked' });
    expect(locked.subsystems.vault.state).toBe('degraded');
    expect(locked.subsystems.vault.reasons).toContainEqual(
      expect.objectContaining({ code: 'vault.locked' })
    );
    const unlocked = computeCurrentReadiness({ ...input, vaultHealth: 'available' });
    expect(unlocked.subsystems.vault).toEqual({ state: 'ready', reasons: [] });
    expect(unlocked.overall).toBe('ready');
    const relocked = computeCurrentReadiness({ ...input, vaultHealth: 'locked' });
    expect(relocked.subsystems.vault.state).toBe('degraded');
    expect(relocked.acceptingProductWork).toBe(true);
    expect(relocked.subsystems.vault.reasons).toContainEqual(
      expect.objectContaining({ code: 'vault.locked' })
    );
    // Computing a view must not rewrite the original boot observations.
    expect(snapshot.subsystems.vault.state).toBe('degraded');
  });

  it('reports current unavailable Gateway supply and clears it when a route returns', () => {
    const snapshot = computeBootReadinessSnapshot({ bootId: 'boot_live_gateway' });
    const input = {
      snapshot,
      dataRoot: `/tmp/openkit-readiness-${randomUUID()}`,
      vaultHealth: 'available' as const,
    };

    const unavailable = computeCurrentReadiness({ ...input, llmGatewayAvailable: false });
    expect(unavailable.overall).toBe('degraded');
    expect(unavailable.acceptingProductWork).toBe(true);
    expect(unavailable.subsystems.llmGateway.state).toBe('degraded');
    expect(unavailable.subsystems.llmGateway.reasons.length).toBeGreaterThan(0);
    for (const reason of unavailable.subsystems.llmGateway.reasons) {
      expect(reason.code.length).toBeGreaterThan(0);
      expect(reason.blocks.length).toBeGreaterThan(0);
    }
    const restored = computeCurrentReadiness({
      ...input,
      snapshot: unavailable,
      llmGatewayAvailable: true,
    });
    expect(restored.subsystems.llmGateway).toEqual({ state: 'ready', reasons: [] });
    expect(restored.overall).toBe('ready');
  });

  it('projects current scoped index facts without closing healthy sibling admission', () => {
    const dataRoot = `/tmp/openkit-readiness-${randomUUID()}`;
    const input = {
      snapshot: computeBootReadinessSnapshot({ bootId: 'boot_live_index' }),
      dataRoot,
      vaultHealth: 'available' as const,
      llmGatewayAvailable: true,
    };
    expect(computeCurrentReadiness(input).subsystems.knowledgeIndex.state).toBe('ready');
    refuseScope(dataRoot, { scope: 'workspace', id: 'affected-workspace', check: 'index' });
    const unavailable = computeCurrentReadiness(input);
    expect(unavailable.overall).toBe('degraded');
    expect(unavailable.acceptingProductWork).toBe(true);
    expect(unavailable.subsystems.storage.state).toBe('ready');
    expect(unavailable.subsystems.knowledgeIndex).toMatchObject({
      state: 'degraded',
      reasons: [
        {
          code: 'storage.index-unavailable',
          blocks: ['workspace:affected-workspace:index'],
        },
      ],
    });
  });

  it('preserves critical failure, scheduler diagnosis and shutdown admission closure', () => {
    const snapshot = computeBootReadinessSnapshot({
      bootId: 'boot_live_preservation',
      subsystems: {
        policy: {
          state: 'failed',
          reasons: [{ code: 'policy.failed', message: 'Policy failed.', blocks: ['product_work'] }],
        },
        scheduler: {
          state: 'degraded',
          reasons: [{ code: 'scheduler.pending', message: 'An attempt is pending.', blocks: [] }],
        },
      },
    });
    const dataRoot = `/tmp/openkit-readiness-${randomUUID()}`;
    const current = computeCurrentReadiness({
      snapshot,
      dataRoot,
      vaultHealth: 'available',
      llmGatewayAvailable: true,
    });
    expect(current.acceptingProductWork).toBe(false);
    expect(current.overall).toBe('failed');
    expect(current.subsystems.policy).toEqual(snapshot.subsystems.policy);
    expect(current.subsystems.scheduler).toEqual(snapshot.subsystems.scheduler);

    const shutdown = createShutdownReadinessSnapshot(
      computeBootReadinessSnapshot({ bootId: 'boot_live_shutdown' })
    );
    const duringShutdown = computeCurrentReadiness({
      snapshot: shutdown,
      dataRoot,
      vaultHealth: 'available',
      llmGatewayAvailable: true,
    });
    expect(duringShutdown.acceptingProductWork).toBe(false);
    expect(duringShutdown.subsystems.scheduler.reasons).toEqual(
      shutdown.subsystems.scheduler.reasons
    );
  });
});
