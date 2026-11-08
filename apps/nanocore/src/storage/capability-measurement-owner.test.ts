import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  finishMcpToolCall,
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  openTestNativeWorkspace,
} from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';

it.each(['later-measurement', 'terminal-audit'] as const)(
  'rolls back unacknowledged Workspace measurements after a %s refusal',
  async (fault) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'workspace-measurement-owner-'));
    const workspaceDb = openWorkspaceDb(dataRoot, allocateEntityId('ws'));
    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      const coreDb = createTestCoreDb(dataRoot);
      let actor: { kind: 'user'; id: string };
      try {
        const userId = ensureLocalUser(coreDb);
        recordWorkspaceOwnerMembership({
          coreDb,
          ownerUserId: userId,
          workspaceId: workspaceDb.workspaceId,
        });
        actor = { kind: 'user', id: userId };
      } finally {
        closeTestCoreDb(coreDb);
      }
      // These faults create no product rows. The native writer must reach real SQL to refuse.
      workspaceDb.sqlite.exec(
        fault === 'later-measurement'
          ? `CREATE TRIGGER refuse_workspace_measurement BEFORE INSERT ON usage_records
             WHEN NEW.source = 'later-refused'
             BEGIN SELECT RAISE(ABORT, 'injected later Workspace measurement refusal'); END`
          : `CREATE TRIGGER refuse_workspace_finish_audit BEFORE INSERT ON audit_events
             WHEN NEW.action = 'capability.finish'
             BEGIN SELECT RAISE(ABORT, 'injected Workspace terminal Audit refusal'); END`
      );
      await openTestNativeWorkspace(workspaceDb);
      workspaceDb.sqlite.pragma('query_only = ON');
      const auditLineage = { commandRequestId: '00000000-0000-4000-8000-000000000921' };
      const call = await startCapabilityCall({
        workspaceDb,
        workspaceId: workspaceDb.workspaceId,
        authorityActor: actor,
        capabilityId: 'mcp.call-tool',
        family: 'mcp',
        operation: 'mcp.call-tool',
        redactionClass: 'metadata-only',
        requestId: null,
        auditLineage,
      });
      const acknowledgedIds = await recordUsage({
        workspaceDb,
        call,
        records: [{ category: 'tool', unit: 'tool_calls', quantity: 3, source: 'acknowledged' }],
      });
      const acknowledged = listWorkspaceUsageRecords(workspaceDb, workspaceDb.workspaceId);
      const beforeCalls = listWorkspaceCapabilityCalls(workspaceDb, workspaceDb.workspaceId);
      const beforeAudit = listWorkspaceAuditEvents(workspaceDb, workspaceDb.workspaceId);
      expect(acknowledged.map((row) => row.id)).toEqual(acknowledgedIds);
      expect(acknowledged).toHaveLength(1);

      if (fault === 'later-measurement') {
        // CapabilityCall lifecycle: a refused command returns no partial ID list. Its savepoint
        // removes the earlier insert in this command, but not an earlier acknowledged command.
        await expect(
          recordUsage({
            workspaceDb,
            call,
            auditLineage,
            records: [
              { category: 'tool', unit: 'tool_calls', quantity: 5, source: 'first-in-command' },
              { category: 'tool', unit: 'tool_calls', quantity: 9, source: 'later-refused' },
            ],
          })
        ).rejects.toMatchObject({ code: 'usage_record_failed' });
        expect(listWorkspaceCapabilityCalls(workspaceDb, workspaceDb.workspaceId)).toEqual([
          expect.objectContaining({
            id: call.id,
            status: 'failed',
            errorCode: 'usage_record_failed',
          }),
        ]);
        // The public owner records the separate failure diagnosis only after tuple rollback.
        const afterAudit = listWorkspaceAuditEvents(workspaceDb, workspaceDb.workspaceId);
        expect(afterAudit.filter((row) => row.action === 'capability.admit')).toEqual(beforeAudit);
        expect(afterAudit.filter((row) => row.action === 'capability.finish')).toEqual([
          expect.objectContaining({
            capabilityCallId: call.id,
            actor,
            requestId: auditLineage.commandRequestId,
            outcome: 'failed',
            errorCode: 'usage_record_failed',
          }),
        ]);
      } else {
        // The contacted measurement and terminal Call/Audit share the original Workspace tuple.
        // A late Audit refusal cannot acknowledge or retain only the measurement or Call update.
        await expect(
          finishMcpToolCall(call, workspaceDb, { status: 'succeeded' }, true)
        ).rejects.toMatchObject({ commit: 'not-committed' });
        expect(listWorkspaceCapabilityCalls(workspaceDb, workspaceDb.workspaceId)).toEqual(
          beforeCalls
        );
        expect(listWorkspaceAuditEvents(workspaceDb, workspaceDb.workspaceId)).toEqual(beforeAudit);
      }
      expect(listWorkspaceUsageRecords(workspaceDb, workspaceDb.workspaceId)).toEqual(acknowledged);

      await shutdownControlStoreWorkerClient();
      const reopened = openWorkspaceDb(dataRoot, workspaceDb.workspaceId);
      try {
        expect(listWorkspaceUsageRecords(reopened, reopened.workspaceId)).toEqual(acknowledged);
      } finally {
        closeTestCoreDb(reopened);
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      closeTestCoreDb(workspaceDb);
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }
);
