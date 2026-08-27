import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listServerAuditEvents } from '../audit-events.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  recordNanoHostEpochInvalidationAudit,
  recordNanoHostEpochReadyAudit,
} from './nanohost-epoch-audit.js';

describe('NanoHost epoch audit projection', () => {
  it('records only the two server-scoped redacted epoch boundaries through existing AuditEvent storage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-epoch-audit-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const tablesBefore = coreDb.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all();
      const invalidation = recordNanoHostEpochInvalidationAudit({
        affectedSessionLineage: ['session-redacted-a', 'session-redacted-b'],
        auditEventId: 'aud_epoch_invalidate',
        classification: 'member-exit',
        coreDb,
        epochLifetimeMs: 45_000,
        now: new Date('2026-08-09T04:00:00.000Z'),
        outcome: 'failed',
        reportRef: 'nanohost-report:report-redacted-17',
      });
      const ready = recordNanoHostEpochReadyAudit({
        auditEventId: 'aud_epoch_ready',
        coreDb,
        fenceToReadyMs: 120_000,
        now: new Date('2026-08-09T04:02:00.000Z'),
        outcome: 'succeeded',
      });

      expect(invalidation).toMatchObject({
        action: 'runtime.epoch.invalidate',
        agentSessionId: null,
        category: 'system',
        id: 'aud_epoch_invalidate',
        outcome: 'failed',
        workspaceId: null,
      });
      expect(ready).toMatchObject({
        action: 'runtime.epoch.ready',
        agentSessionId: null,
        category: 'system',
        id: 'aud_epoch_ready',
        outcome: 'succeeded',
        workspaceId: null,
      });
      expect(invalidation.action).not.toBe('member-exit');
      const invalidationProjection = `${invalidation.resource ?? ''} ${invalidation.summary}`;
      for (const required of [
        'member-exit',
        '45000',
        'session-redacted-a',
        'session-redacted-b',
        'nanohost-report:report-redacted-17',
      ]) {
        expect(invalidationProjection).toContain(required);
      }
      expect(`${ready.resource ?? ''} ${ready.summary}`).toContain('120000');

      const events = listServerAuditEvents(coreDb);
      expect(events).toEqual([invalidation, ready]);
      expect(
        coreDb.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
      ).toEqual(tablesBefore);
      for (const event of events) {
        const serialized = JSON.stringify(event);
        for (const prohibited of [
          'privateEpochId',
          'processId',
          'socketPath',
          'backendHandle',
          '/var/lib/openkit',
          '/run/openkit',
        ]) {
          expect(serialized).not.toContain(prohibited);
        }
      }

      expect(() =>
        recordNanoHostEpochInvalidationAudit({
          affectedSessionLineage: ['session-redacted-c'],
          auditEventId: 'aud_epoch_unsafe',
          classification: 'member-exit',
          coreDb,
          epochLifetimeMs: 1,
          now: new Date('2026-08-09T04:03:00.000Z'),
          outcome: 'failed',
          privateEpochId: 'epoch-private-raw',
          reportRef: 'nanohost-report:report-redacted-18',
          socketPath: '/run/openkit/private.sock',
          token: 'okt_forbidden_raw_token',
        } as Parameters<typeof recordNanoHostEpochInvalidationAudit>[0] & {
          privateEpochId: string;
          socketPath: string;
          token: string;
        })
      ).toThrow(/private|redact|unsafe/i);
      for (const secretProjection of [
        {
          affectedSessionLineage: ['okt_FAKE_REVIEW_MARKER_1234567890'],
          reportRef: 'nanohost-report:report-redacted-19',
        },
        {
          affectedSessionLineage: ['session-redacted-d'],
          reportRef: 'nanohost-report:okt_FAKE_REVIEW_MARKER_1234567890',
        },
        {
          affectedSessionLineage: ['AKIAFAKEREVIEW123456'],
          reportRef: 'nanohost-report:report-redacted-20',
        },
        {
          affectedSessionLineage: ['session-redacted-e'],
          reportRef: 'nanohost-report:xoxb-FAKE-REVIEW-MARKER-1234567890',
        },
      ]) {
        expect(() =>
          recordNanoHostEpochInvalidationAudit({
            ...secretProjection,
            auditEventId: 'aud_epoch_secret_projection',
            classification: 'member-exit',
            coreDb,
            epochLifetimeMs: 1,
            outcome: 'failed',
          })
        ).toThrow(/redact|secret|unsafe/i);
      }
      expect(() =>
        recordNanoHostEpochInvalidationAudit({
          affectedSessionLineage: [],
          auditEventId: 'aud_epoch_unknown_trigger',
          classification: 'member-exit-other',
          coreDb,
          epochLifetimeMs: 1,
          outcome: 'failed',
          reportRef: null,
        } as unknown as Parameters<typeof recordNanoHostEpochInvalidationAudit>[0])
      ).toThrow(/classification|trigger/i);
      expect(coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({
        count: 2,
      });
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});
