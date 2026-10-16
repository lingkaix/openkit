import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listServerAuditEvents,
  listWorkspaceAuditEvents,
  recordServerAuditEvent,
  recordWorkspaceAuditEvent,
} from './audit-events.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';

/**
 * Creates an isolated data root for audit event tests.
 *
 * @returns Absolute temporary data-root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-audit-events-'));
}

describe('workspace audit events', () => {
  it('normalizes retained Audit actor and subject additions without changing attribution', () => {
    const workspaceDb = openWorkspaceDb(
      createDataRoot(),
      'ws_00000000-0000-7000-8000-000000000001'
    );
    try {
      applyScopedMigrations(workspaceDb);
      const event = recordWorkspaceAuditEvent({
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        auditEventId: 'aud_00000000-0000-74dc-86ba-c2ad82533248',
        actor: { kind: 'system', id: 'openkit-operator', responsibleUserId: null },
        subject: { kind: 'user', id: 'usr_00000000-0000-7609-aed5-db4b5c95e76c' },
        action: 'workspace.inspect',
        outcome: 'succeeded',
        summary: 'Workspace inspected.',
      });
      expect(
        listWorkspaceAuditEvents(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([event]);
      const actorJson = JSON.stringify({ ...event.actor, futureNote: 'Retained Actor' });
      const subjectJson = JSON.stringify({ ...event.subject, futureNote: 'Retained subject' });
      workspaceDb.sqlite
        .prepare(
          'UPDATE audit_events SET actor_json = ?, subject_json = ? WHERE audit_event_id = ?'
        )
        .run(actorJson, subjectJson, event.id);
      expect(
        listWorkspaceAuditEvents(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([event]);
      expect(
        workspaceDb.sqlite
          .prepare('SELECT actor_json, subject_json FROM audit_events WHERE audit_event_id = ?')
          .get(event.id)
      ).toEqual({ actor_json: actorJson, subject_json: subjectJson });

      // Descriptive normalization cannot hide a changed known attribution value.
      const changedActor = {
        kind: 'agent',
        id: 'agent_distinct',
        responsibleUserId: 'usr_00000000-0000-7413-b9d4-3afc15383d03',
        futureNote: 'Retained Actor',
      };
      workspaceDb.sqlite
        .prepare('UPDATE audit_events SET actor_json = ? WHERE audit_event_id = ?')
        .run(JSON.stringify(changedActor), event.id);
      expect(
        listWorkspaceAuditEvents(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')[0]?.actor
      ).toEqual({
        kind: 'agent',
        id: 'agent_distinct',
        responsibleUserId: 'usr_00000000-0000-7413-b9d4-3afc15383d03',
      });
      workspaceDb.sqlite
        .prepare('UPDATE audit_events SET actor_json = ? WHERE audit_event_id = ?')
        .run(JSON.stringify({ ...changedActor, kind: 'unknown' }), event.id);
      expect(() =>
        listWorkspaceAuditEvents(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toThrow();
      expect(() =>
        recordWorkspaceAuditEvent({
          workspaceDb,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          action: 'workspace.inspect',
          outcome: 'succeeded',
          summary: 'Workspace inspected.',
          actor: { ...changedActor } as typeof event.actor,
        })
      ).toThrow();
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records protocol-valid redacted audit events in the server database', () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);

      const event = recordServerAuditEvent({
        action: 'vault.resolve',
        actor: { id: 'usr_00000000-0000-768a-8658-44c33d82c1f5', kind: 'user' },
        auditEventId: 'aud_00000000-0000-726b-8ee2-162b4bf37c24',
        category: 'system',
        coreDb,
        now: new Date('2026-07-05T00:00:00.000Z'),
        outcome: 'succeeded',
        resource: 'vault:vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        resourceRevision: 2,
        subject: { id: 'usr_00000000-0000-7e63-b85a-c188de8ee1c3', kind: 'user' },
        summary: 'Server vault reference resolved.',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      const row = coreDb.sqlite.prepare('SELECT * FROM audit_events').get() as Record<
        string,
        unknown
      >;

      expect(event).toMatchObject({
        action: 'vault.resolve',
        actor: { id: 'usr_00000000-0000-768a-8658-44c33d82c1f5', kind: 'user' },
        category: 'system',
        id: 'aud_00000000-0000-726b-8ee2-162b4bf37c24',
        outcome: 'succeeded',
        resource: 'vault:vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        resourceRevision: 2,
        subject: { id: 'usr_00000000-0000-7e63-b85a-c188de8ee1c3', kind: 'user' },
        summary: 'Server vault reference resolved.',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      expect(row).toMatchObject({
        action: 'vault.resolve',
        actor_json: JSON.stringify({
          kind: 'user',
          id: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
        }),
        audit_event_id: 'aud_00000000-0000-726b-8ee2-162b4bf37c24',
        outcome: 'succeeded',
        resource: 'vault:vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        resource_revision: 2,
        subject_json: JSON.stringify({
          kind: 'user',
          id: 'usr_00000000-0000-7e63-b85a-c188de8ee1c3',
        }),
        workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
      });
      expect(listServerAuditEvents(coreDb)).toEqual([event]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records protocol-valid redacted audit events in the workspace database', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      const event = recordWorkspaceAuditEvent({
        action: 'worker.capability.finish',
        actor: { kind: 'user', id: 'usr_00000000-0000-7609-aed5-db4b5c95e76c' },
        auditEventId: 'aud_00000000-0000-72f4-8dcc-8c92fd4028d3',
        capabilityCallId: 'cap_00000000-0000-7d4f-884e-ab4fdf8dc968',
        category: 'capability',
        now: new Date('2026-07-05T00:00:00.000Z'),
        outcome: 'succeeded',
        permissionDecisionId: 'pd_00000000-0000-7a55-84b6-910265042f6b',
        requestId: '00000000-0000-4000-8000-000000000014',
        resource: 'capability:knowledge.search',
        resourceRevision: 3,
        subject: {
          kind: 'agent',
          id: 'agent_worker',
          responsibleUserId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
        },
        summary: 'Worker capability call completed.',
        vaultGrantId: 'grant_00000000-0000-7919-a9bd-25953b88f539',
        workspaceDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });

      const row = workspaceDb.sqlite.prepare('SELECT * FROM audit_events').get() as Record<
        string,
        unknown
      >;

      expect(event).toMatchObject({
        action: 'worker.capability.finish',
        actor: { kind: 'user', id: 'usr_00000000-0000-7609-aed5-db4b5c95e76c' },
        capabilityCallId: 'cap_00000000-0000-7d4f-884e-ab4fdf8dc968',
        category: 'capability',
        createdAt: '2026-07-05T00:00:00.000Z',
        errorCode: null,
        id: 'aud_00000000-0000-72f4-8dcc-8c92fd4028d3',
        outcome: 'succeeded',
        occurredAt: '2026-07-05T00:00:00.000Z',
        permissionDecisionId: 'pd_00000000-0000-7a55-84b6-910265042f6b',
        requestId: '00000000-0000-4000-8000-000000000014',
        resource: 'capability:knowledge.search',
        resourceRevision: 3,
        severity: 'info',
        summary: 'Worker capability call completed.',
        subject: {
          kind: 'agent',
          id: 'agent_worker',
          responsibleUserId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
        },
        vaultGrantId: 'grant_00000000-0000-7919-a9bd-25953b88f539',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      expect(row).toMatchObject({
        action: 'worker.capability.finish',
        actor_json: JSON.stringify({
          kind: 'user',
          id: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
        }),
        audit_event_id: 'aud_00000000-0000-72f4-8dcc-8c92fd4028d3',
        capability_call_id: 'cap_00000000-0000-7d4f-884e-ab4fdf8dc968',
        category: 'capability',
        created_at: '2026-07-05T00:00:00.000Z',
        error_code: null,
        occurred_at: '2026-07-05T00:00:00.000Z',
        outcome: 'succeeded',
        permission_decision_id: 'pd_00000000-0000-7a55-84b6-910265042f6b',
        request_id: '00000000-0000-4000-8000-000000000014',
        resource: 'capability:knowledge.search',
        resource_revision: 3,
        severity: 'info',
        summary: 'Worker capability call completed.',
        subject_json: JSON.stringify({
          kind: 'agent',
          id: 'agent_worker',
          responsibleUserId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
        }),
        vault_grant_id: 'grant_00000000-0000-7919-a9bd-25953b88f539',
        workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
      });
      expect(
        listWorkspaceAuditEvents(workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([event]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects unsafe raw payload fields before storage', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);

      expect(() =>
        recordWorkspaceAuditEvent({
          action: 'worker.prompt',
          auditEventId: 'aud_00000000-0000-7d98-9d76-907a3d807022',
          category: 'system',
          outcome: 'failed',
          promptText: 'raw prompt',
          summary: 'Unsafe event.',
          workspaceDb,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        } as Parameters<typeof recordWorkspaceAuditEvent>[0] & { promptText: string })
      ).toThrow(/redacted/);
      expect(
        workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get()
      ).toEqual({ count: 0 });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
