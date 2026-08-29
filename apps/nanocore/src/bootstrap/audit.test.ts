import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listServerAuditEvents } from '../audit-events.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  recordBootAuditEvent,
  recordBootStartAuditEvent,
  recordShutdownAuditEvent,
} from './audit.js';
import { runBootPhases } from './phases.js';

describe('boot audit recorder', () => {
  it('records the boot start and known migration ids in the server database', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-start-audit-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      recordBootStartAuditEvent({
        bootId: 'boot_start_test',
        coreDb,
        layoutVersion: 1,
        lockAcquisition: {
          lockPath: '/tmp/openkit/server/runtime/nanocore.lock',
          staleHolder: { bootId: 'boot_dead', pid: 999_999_999 },
          status: 'stale_broken',
        },
        migrationIds: ['core_0000_setup'],
        indexRebuildEvents: [
          {
            indexPath: 'workspaces/ws_demo/indexes/search.json',
            itemCount: 2,
            workspaceId: 'ws_demo',
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

      const row = coreDb.sqlite
        .prepare('SELECT * FROM boot_audit_events WHERE boot_event_id = ?')
        .get('boot_start_test_start') as {
        accepting_product_work: number;
        boot_id: string;
        created_at: string;
        event_type: string;
        outcome: string;
        phase_outcomes_json: string;
        readiness_json: string;
      };

      expect(row).toMatchObject({
        accepting_product_work: 0,
        boot_id: 'boot_start_test',
        created_at: '2026-07-05T00:00:00.000Z',
        event_type: 'boot.start',
        outcome: 'started',
      });
      expect(JSON.parse(row.phase_outcomes_json)).toEqual([]);
      expect(JSON.parse(row.readiness_json)).toEqual({
        bootId: 'boot_start_test',
        layoutVersion: 1,
        lockAcquisition: {
          lockPath: '/tmp/openkit/server/runtime/nanocore.lock',
          staleHolder: { bootId: 'boot_dead', pid: 999_999_999 },
          status: 'stale_broken',
        },
        migrationIds: ['core_0000_setup'],
        indexRebuildEvents: [
          {
            indexPath: 'workspaces/ws_demo/indexes/search.json',
            itemCount: 2,
            workspaceId: 'ws_demo',
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
      });
      expect(listServerAuditEvents(coreDb)).toEqual([
        expect.objectContaining({
          action: 'boot.start',
          category: 'system',
          id: 'aud_boot_start_test_start',
          outcome: 'succeeded',
          resource: 'server:boot:boot_start_test',
          severity: 'info',
          summary: 'NanoCore boot started.',
          workspaceId: null,
        }),
      ]);
    } finally {
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

      recordBootAuditEvent({
        coreDb,
        result,
        now: new Date('2026-07-05T00:00:00.000Z'),
      });

      const row = coreDb.sqlite
        .prepare('SELECT * FROM boot_audit_events WHERE boot_id = ?')
        .get('boot_audit_test') as {
        accepting_product_work: number;
        boot_event_id: string;
        created_at: string;
        event_type: string;
        outcome: string;
        phase_outcomes_json: string;
        readiness_json: string;
      };

      expect(row).toMatchObject({
        accepting_product_work: 1,
        boot_event_id: 'boot_audit_test_outcome',
        created_at: '2026-07-05T00:00:00.000Z',
        event_type: 'boot.outcome',
        outcome: 'degraded',
      });
      expect(JSON.parse(row.phase_outcomes_json)).toMatchObject([
        { name: 'policy-kernel', outcome: { status: 'ok' } },
        { name: 'vault', outcome: { status: 'degraded' } },
      ]);
      expect(JSON.parse(row.readiness_json)).toMatchObject({
        bootId: 'boot_audit_test',
        overall: 'degraded',
      });
      expect(listServerAuditEvents(coreDb)).toEqual([
        expect.objectContaining({
          action: 'boot.outcome',
          category: 'system',
          errorCode: 'boot_degraded',
          id: 'aud_boot_audit_test_outcome',
          outcome: 'succeeded',
          resource: 'server:boot:boot_audit_test',
          severity: 'warning',
          summary: 'NanoCore boot completed with degraded readiness.',
          workspaceId: null,
        }),
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records an orderly shutdown audit event in the server database', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-shutdown-audit-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      recordShutdownAuditEvent({
        bootId: 'boot_shutdown_test',
        coreDb,
        deadlineForcedExit: false,
        reason: 'SIGTERM',
        stepsCompleted: ['http-server.close', 'data-root-lock.release'],
        now: new Date('2026-07-05T00:00:01.000Z'),
      });

      const row = coreDb.sqlite
        .prepare('SELECT * FROM boot_audit_events WHERE boot_event_id = ?')
        .get('boot_shutdown_test_shutdown') as {
        accepting_product_work: number;
        boot_id: string;
        created_at: string;
        event_type: string;
        outcome: string;
        phase_outcomes_json: string;
        readiness_json: string;
      };

      expect(row).toMatchObject({
        accepting_product_work: 0,
        boot_id: 'boot_shutdown_test',
        created_at: '2026-07-05T00:00:01.000Z',
        event_type: 'boot.shutdown',
        outcome: 'ok',
      });
      expect(JSON.parse(row.phase_outcomes_json)).toEqual([
        'http-server.close',
        'data-root-lock.release',
      ]);
      expect(JSON.parse(row.readiness_json)).toEqual({
        bootId: 'boot_shutdown_test',
        deadlineForcedExit: false,
        shutdownReason: 'SIGTERM',
      });
      expect(listServerAuditEvents(coreDb)).toEqual([
        expect.objectContaining({
          action: 'boot.shutdown',
          category: 'system',
          id: 'aud_boot_shutdown_test_shutdown',
          outcome: 'succeeded',
          resource: 'server:boot:boot_shutdown_test',
          severity: 'info',
          summary: 'NanoCore shutdown completed.',
          workspaceId: null,
        }),
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
