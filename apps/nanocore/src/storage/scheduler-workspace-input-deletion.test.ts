import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { readScheduledAdmissionText } from '../runtime/scheduler-dispatch-input.js';
import { stageSchedulerStartInput } from '../runtime/scheduler-input-staging.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { readWorkspaceQueueInput } from './workspace-queue-inputs.js';

it('deletes the original Workspace bytes while retaining a text-free cancelled scheduler row', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'workspace-queue-input-deletion-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Queue input deletion');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const thread = await store.createThread(workspace.id, 'Original queued input');
    const requestId = randomUUID();
    const scope = {
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: allocateEntityId('tu'),
    };
    const text = `Delete the unique Workspace instruction ${randomUUID()}`;
    const inputRef = await stageSchedulerStartInput(dataRoot, scope, requestId, text);
    const original = createSchedulerAdmissionEntry(coreDb, {
      ...scope,
      inputRef,
      requestId,
      queueEntryId: randomUUID(),
      backendId: 'nanohost',
      triggerActor: { kind: 'user', id: userId },
      requestedAgentId: 'test-worker',
    });
    expect(readWorkspaceQueueInput(dataRoot, scope, inputRef)).toEqual({
      text,
      originalInvocationId: requestId,
    });
    cancelSchedulerAdmissionEntry(coreDb, original);
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const app = createAppWithLocalIdentity({
      coreDb,
      dataRoot,
      store,
      mode: 'server',
      releaseIdentity: {
        releaseTag: null,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
    });
    const deletionRequestId = randomUUID();
    const response = await app.request(
      ...operationRequest(
        'workspace.delete',
        { workspaceId: workspace.id },
        {
          headers: { authorization: `Bearer ${token.secret}` },
          body: JSON.stringify({
            confirmation: `permanently-delete-workspace:${workspace.id}:1`,
            expectedRegistryRevision: 1,
            requestId: deletionRequestId,
          }),
        }
      )
    );
    expect(response.status).toBe(200);
    expect(existsSync(join(dataRoot, 'workspaces', workspace.id))).toBe(false);
    const reopened = openCoreDb(dataRoot);
    try {
      const retained = requireSchedulerAdmissionEntry(reopened, original.queueEntryId);
      expect(retained).toMatchObject({
        status: 'cancelled',
        requestId,
        inputRef,
      });
      expect(readScheduledAdmissionText(reopened, retained)).toBeNull();
      const rows = reopened.sqlite
        .prepare('SELECT * FROM scheduler_admission_entries WHERE workspace_id = ?')
        .all(workspace.id);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(text);
      const columns = reopened.sqlite
        .prepare('PRAGMA table_info(scheduler_admission_entries)')
        .all() as { name: string }[];
      const columnNames = columns.map(({ name }) => name);
      expect(columnNames).toEqual(expect.arrayContaining(['input_id', 'input_digest']));
      expect(columnNames).not.toContain('turn_input');
      expect(
        reopened.sqlite
          .prepare('SELECT status FROM workspace_registry WHERE workspace_id = ?')
          .get(workspace.id)
      ).toEqual({ status: 'deleted' });
      expect(
        reopened.sqlite
          .prepare(
            "SELECT request_id FROM audit_events WHERE workspace_id = ? AND action = 'workspace.delete'"
          )
          .all(workspace.id)
      ).toEqual([{ request_id: deletionRequestId }]);
    } finally {
      reopened.sqlite.close();
    }
  } finally {
    coreDb.sqlite.close();
    await disposeTestStore(dataRoot);
  }
});
