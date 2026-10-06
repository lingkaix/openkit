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
    const workspaceDb = openWorkspaceDb(createDataRoot(), 'ws_demo');
    try {
      applyScopedMigrations(workspaceDb);
      const event = recordWorkspaceAuditEvent({
        workspaceDb,
        workspaceId: 'ws_demo',
        auditEventId: 'aud_annotated',
        actor: { kind: 'system', id: 'openkit-operator', responsibleUserId: null },
        subject: { kind: 'user', id: 'user_editor' },
        action: 'workspace.inspect',
        outcome: 'succeeded',
        summary: 'Workspace inspected.',
      });
      expect(listWorkspaceAuditEvents(workspaceDb, 'ws_demo')).toEqual([event]);
      const actorJson = JSON.stringify({ ...event.actor, futureNote: 'Retained Actor' });
      const subjectJson = JSON.stringify({ ...event.subject, futureNote: 'Retained subject' });
      workspaceDb.sqlite
        .prepare(
          'UPDATE audit_events SET actor_json = ?, subject_json = ? WHERE audit_event_id = ?'
        )
        .run(actorJson, subjectJson, event.id);
      expect(listWorkspaceAuditEvents(workspaceDb, 'ws_demo')).toEqual([event]);
      expect(
        workspaceDb.sqlite
          .prepare('SELECT actor_json, subject_json FROM audit_events WHERE audit_event_id = ?')
          .get(event.id)
      ).toEqual({ actor_json: actorJson, subject_json: subjectJson });

      // Descriptive normalization cannot hide a changed known attribution value.
      const changedActor = {
        kind: 'agent',
        id: 'agent_distinct',
        responsibleUserId: 'user_distinct',
        futureNote: 'Retained Actor',
      };
      workspaceDb.sqlite
        .prepare('UPDATE audit_events SET actor_json = ? WHERE audit_event_id = ?')
        .run(JSON.stringify(changedActor), event.id);
      expect(listWorkspaceAuditEvents(workspaceDb, 'ws_demo')[0]?.actor).toEqual({
        kind: 'agent',
        id: 'agent_distinct',
        responsibleUserId: 'user_distinct',
      });
      workspaceDb.sqlite
        .prepare('UPDATE audit_events SET actor_json = ? WHERE audit_event_id = ?')
        .run(JSON.stringify({ ...changedActor, kind: 'unknown' }), event.id);
      expect(() => listWorkspaceAuditEvents(workspaceDb, 'ws_demo')).toThrow();
      expect(() =>
        recordWorkspaceAuditEvent({
          workspaceDb,
          workspaceId: 'ws_demo',
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
        actor: { id: 'user_admin', kind: 'user' },
        auditEventId: 'aud_server_1',
        category: 'system',
        coreDb,
        now: new Date('2026-07-05T00:00:00.000Z'),
        outcome: 'succeeded',
        resource: 'vault:vault_github',
        resourceRevision: 2,
        subject: { id: 'user_disabled', kind: 'user' },
        summary: 'Server vault reference resolved.',
        workspaceId: 'ws_demo',
      });
      const row = coreDb.sqlite.prepare('SELECT * FROM audit_events').get() as Record<
        string,
        unknown
      >;

      expect(event).toMatchObject({
        action: 'vault.resolve',
        actor: { id: 'user_admin', kind: 'user' },
        category: 'system',
        id: 'aud_server_1',
        outcome: 'succeeded',
        resource: 'vault:vault_github',
        resourceRevision: 2,
        subject: { id: 'user_disabled', kind: 'user' },
        summary: 'Server vault reference resolved.',
        workspaceId: 'ws_demo',
      });
      expect(row).toMatchObject({
        action: 'vault.resolve',
        actor_json: JSON.stringify({ kind: 'user', id: 'user_admin' }),
        audit_event_id: 'aud_server_1',
        outcome: 'succeeded',
        resource: 'vault:vault_github',
        resource_revision: 2,
        subject_json: JSON.stringify({ kind: 'user', id: 'user_disabled' }),
        workspace_id: 'ws_demo',
      });
      expect(listServerAuditEvents(coreDb)).toEqual([event]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records protocol-valid redacted audit events in the workspace database', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const event = recordWorkspaceAuditEvent({
        action: 'worker.capability.finish',
        actor: { kind: 'user', id: 'user_editor' },
        auditEventId: 'aud_1',
        capabilityCallId: 'cap_1',
        category: 'capability',
        now: new Date('2026-07-05T00:00:00.000Z'),
        outcome: 'succeeded',
        permissionDecisionId: 'pd_1',
        requestId: '00000000-0000-4000-8000-000000000014',
        resource: 'capability:knowledge.search',
        resourceRevision: 3,
        subject: { kind: 'agent', id: 'agent_worker', responsibleUserId: 'user_editor' },
        summary: 'Worker capability call completed.',
        vaultGrantId: 'grant_1',
        workspaceDb,
        workspaceId: 'ws_demo',
      });

      const row = workspaceDb.sqlite.prepare('SELECT * FROM audit_events').get() as Record<
        string,
        unknown
      >;

      expect(event).toMatchObject({
        action: 'worker.capability.finish',
        actor: { kind: 'user', id: 'user_editor' },
        capabilityCallId: 'cap_1',
        category: 'capability',
        createdAt: '2026-07-05T00:00:00.000Z',
        errorCode: null,
        id: 'aud_1',
        outcome: 'succeeded',
        occurredAt: '2026-07-05T00:00:00.000Z',
        permissionDecisionId: 'pd_1',
        requestId: '00000000-0000-4000-8000-000000000014',
        resource: 'capability:knowledge.search',
        resourceRevision: 3,
        severity: 'info',
        summary: 'Worker capability call completed.',
        subject: { kind: 'agent', id: 'agent_worker', responsibleUserId: 'user_editor' },
        vaultGrantId: 'grant_1',
        workspaceId: 'ws_demo',
      });
      expect(row).toMatchObject({
        action: 'worker.capability.finish',
        actor_json: JSON.stringify({ kind: 'user', id: 'user_editor' }),
        audit_event_id: 'aud_1',
        capability_call_id: 'cap_1',
        category: 'capability',
        created_at: '2026-07-05T00:00:00.000Z',
        error_code: null,
        occurred_at: '2026-07-05T00:00:00.000Z',
        outcome: 'succeeded',
        permission_decision_id: 'pd_1',
        request_id: '00000000-0000-4000-8000-000000000014',
        resource: 'capability:knowledge.search',
        resource_revision: 3,
        severity: 'info',
        summary: 'Worker capability call completed.',
        subject_json: JSON.stringify({
          kind: 'agent',
          id: 'agent_worker',
          responsibleUserId: 'user_editor',
        }),
        vault_grant_id: 'grant_1',
        workspace_id: 'ws_demo',
      });
      expect(listWorkspaceAuditEvents(workspaceDb, 'ws_demo')).toEqual([event]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects unsafe raw payload fields before storage', () => {
    const dataRoot = createDataRoot();
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      expect(() =>
        recordWorkspaceAuditEvent({
          action: 'worker.prompt',
          auditEventId: 'aud_unsafe',
          category: 'system',
          outcome: 'failed',
          promptText: 'raw prompt',
          summary: 'Unsafe event.',
          workspaceDb,
          workspaceId: 'ws_demo',
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
