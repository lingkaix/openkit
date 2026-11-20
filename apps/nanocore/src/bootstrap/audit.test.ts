import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listServerAuditEvents } from '../audit-events.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  recordBootAuditEvent,
  recordBootStartAuditEvent,
  recordShutdownAuditEvent,
} from './audit.js';
import { runBootPhases } from './phases.js';

describe('boot audit recorder', () => {
  it('records the boot start and known migration ids in the server database', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-start-audit-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      await recordBootStartAuditEvent({
        bootId: 'boot_start_test',
        coreDb,
        layoutVersion: 1,
        lockAcquisition: {
          lockPath: '/tmp/openkit/server/runtime/nanocore.lock',
          staleHolder: {
            bootId: 'boot_dead',
            pid: 999_999_999,
            discarded: 'synthetic-stale-metadata',
          },
          status: 'stale_broken',
        },
        migrationIds: ['core_0000_baseline'],
        indexRebuildEvents: [
          {
            indexPath: 'workspaces/ws_00000000-0000-7000-8000-000000000001/indexes/search.json',
            itemCount: 2,
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          },
        ],
        storageRecoveryEvents: [
          {
            contentDigest: 'abc123',
            originalPath: '/tmp/openkit/server/db/core.sqlite',
            quarantinePath: '/tmp/openkit/server/quarantine/1-core.sqlite',
            reason: 'database_integrity_check_failed',
            scope: 'server',
          },
        ],
        now: new Date('2026-07-05T00:00:00.000Z'),
      });

      expect(listServerAuditEvents(coreDb)).toEqual([
        expect.objectContaining({
          createdAt: '2026-07-05T00:00:00.000Z',
          kernelEvidence: {
            kind: 'boot.start',
            bootId: 'boot_start_test',
            layoutVersion: 1,
            lock: {
              staleHolder: { bootId: 'boot_dead', pid: 999_999_999 },
              status: 'stale_broken',
            },
            migrationIds: ['core_0000_baseline'],
            indexRebuilds: [
              { itemCount: 2, workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
            ],
            storageRecovery: [{ reason: 'database_integrity_check_failed', scope: 'server' }],
          },
          action: 'boot.start',
          category: 'system',
          id: 'aud_d4426a3f-e83e-5c97-9471-b87b74bd0e72',
          outcome: 'succeeded',
          resource: 'server:boot:boot_start_test',
          severity: 'info',
          summary: 'NanoCore boot started.',
          workspaceId: null,
        }),
      ]);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('records the boot outcome and phase outcomes in the server database', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-audit-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      const result = await runBootPhases({
        bootId: 'boot_audit_test',
        phases: [
          {
            name: 'policy-kernel',
            subsystem: 'policy',
            critical: true,
            run: () => ({ status: 'ok' }),
          },
          {
            name: 'vault',
            subsystem: 'vault',
            critical: false,
            run: () => ({
              status: 'degraded',
              reason: {
                code: 'vault.locked',
                message: 'Vault is locked.',
                blocks: ['vault.use'],
              },
            }),
          },
        ],
      });

      await recordBootAuditEvent({
        coreDb,
        result,
        now: new Date('2026-07-05T00:00:00.000Z'),
      });

      expect(listServerAuditEvents(coreDb)).toEqual([
        expect.objectContaining({
          createdAt: '2026-07-05T00:00:00.000Z',
          kernelEvidence: expect.objectContaining({
            kind: 'boot.outcome',
            bootId: 'boot_audit_test',
            overall: 'degraded',
            acceptingProductWork: true,
            subsystems: expect.objectContaining({
              vault: {
                state: 'degraded',
                reasons: [{ code: 'vault.locked', blocks: ['vault.use'] }],
              },
            }),
            phases: [
              {
                name: 'policy-kernel',
                critical: true,
                subsystem: 'policy',
                status: 'ok',
                reasons: [],
              },
              {
                name: 'vault',
                critical: false,
                subsystem: 'vault',
                status: 'degraded',
                reasons: [{ code: 'vault.locked', blocks: ['vault.use'] }],
              },
            ],
          }),
          action: 'boot.outcome',
          category: 'system',
          errorCode: 'boot_degraded',
          id: 'aud_16ab7e83-eb41-5091-a878-d798a5cca4d1',
          outcome: 'succeeded',
          resource: 'server:boot:boot_audit_test',
          severity: 'warning',
          summary: 'NanoCore boot completed with degraded readiness.',
          workspaceId: null,
        }),
      ]);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('records an orderly shutdown audit event in the server database', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-shutdown-audit-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      await recordShutdownAuditEvent({
        bootId: 'boot_shutdown_test',
        coreDb,
        deadlineForcedExit: false,
        reason: 'SIGTERM',
        stepsCompleted: ['http-server.close', 'data-root-lock.release'],
        now: new Date('2026-07-05T00:00:01.000Z'),
      });

      expect(listServerAuditEvents(coreDb)).toEqual([
        expect.objectContaining({
          createdAt: '2026-07-05T00:00:01.000Z',
          kernelEvidence: {
            kind: 'boot.shutdown',
            bootId: 'boot_shutdown_test',
            deadlineForcedExit: false,
            reason: 'SIGTERM',
            stepsCompleted: ['http-server.close', 'data-root-lock.release'],
          },
          action: 'boot.shutdown',
          category: 'system',
          id: 'aud_4c53f7f6-e79d-580a-b6f0-fb1cf968b333',
          outcome: 'succeeded',
          resource: 'server:boot:boot_shutdown_test',
          severity: 'info',
          summary: 'NanoCore shutdown completed.',
          workspaceId: null,
        }),
      ]);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });
});
