import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListHumanAttentionResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';

import { ensureLocalUser } from './auth/identity.js';
import * as goalStore from './runtime/goal-store.js';
import { upsertWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import { createSchedulerAdmissionEntry } from './scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const timestamp = '2026-05-31T00:00:00.000Z';

/**
 * Opens a migrated Core database for Action Center audience tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-action-center-audience-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

describe('action center thread audience', () => {
  it('omits another member private Thread details before projecting Workspace-owned rows', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const shared = store.createThread('ws_demo', 'Shared scheduler work');
    const privateThread = store.createThread(
      'ws_demo',
      'SECRET_PRIVATE_THREAD_TITLE',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_outsider' }
    );
    createSchedulerAdmissionEntry(coreDb, {
      triggerActor: { kind: 'user', id: 'user_local' },
      queueEntryId: 'queue_shared_visible',
      workspaceId: 'ws_demo',
      threadId: shared.id,
      turnId: 'turn_shared_visible',
      turnInput: 'Shared worker turn.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
    createSchedulerAdmissionEntry(coreDb, {
      triggerActor: { kind: 'user', id: 'user_outsider' },
      queueEntryId: 'queue_private_hidden',
      workspaceId: 'ws_demo',
      threadId: privateThread.id,
      turnId: 'turn_private_hidden',
      turnInput: 'SECRET_PRIVATE_TURN_INPUT',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
      priorityClass: 'interactive',
      requiredPoolConstraints: ['openshell.local'],
    });
    const privateTurn = store.createTurn('ws_demo', privateThread.id, 'SECRET_PRIVATE_TURN', {
      kind: 'user',
      id: 'user_outsider',
    });
    store.createItem({
      id: 'it_hidden_malformed_approval',
      workspaceId: 'ws_demo',
      threadId: privateThread.id,
      turnId: privateTurn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: 'ap_hidden_malformed',
      title: 'SECRET_HIDDEN_APPROVAL',
      description: 'Missing approval owner must not fail Action Center.',
      kind: 'permission',
      createdAt: timestamp,
      completedAt: timestamp,
    });
    store.updateTurn(privateTurn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: 'ap_hidden_malformed',
        itemId: 'it_hidden_malformed_approval',
      },
    });
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    try {
      goalStore.createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_private_hidden',
        workspaceId: 'ws_demo',
        threadId: privateThread.id,
        title: 'SECRET_PRIVATE_GOAL_TITLE',
        objective: 'Must not project into Action Center.',
        status: 'awaiting_user',
        now: () => timestamp,
      });
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: privateThread.id,
        turnId: privateTurn.id,
        requestId: `req_${privateTurn.id}`,
        requestInputHash: `sha256:${privateTurn.id}`,
        stage: 'running_worker',
        iteration: 1,
        workerSessionId: 'worker_session_hidden',
        diagnosticsSummary: 'SECRET_HIDDEN_CHECKPOINT',
        now: () => timestamp,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const app = createApp({ coreDb, store });
    const failedHealth = {
      status: 'failed' as const,
      message: 'Shared runtime status remains visible.',
      checkedAt: timestamp,
    };
    const summary = {
      id: 'agent_codex_host',
      name: 'Codex Host Agent',
      kind: null,
      status: 'enabled' as const,
      modelId: null,
      skillIds: [],
      profiles: [],
      defaultProfileId: null,
      capabilities: [],
      sandboxSummary: null,
      health: failedHealth,
    };
    store.setWorkspaceAgentCatalogProjection(() => [summary]);
    const getTurn = vi.spyOn(store, 'getTurn');
    const getApproval = vi.spyOn(store, 'getApproval');
    const listedGoals = vi.spyOn(goalStore, 'listGoalRecordsForThread');

    try {
      const response = await app.request('/api/app/workspaces/ws_demo/action-center');
      const payload = ListHumanAttentionResponseSchema.parse(await response.json());
      const body = JSON.stringify(payload);

      expect(response.status).toBe(200);
      expect(payload.items.map((row) => row.threadId).filter(Boolean)).toEqual([shared.id]);
      expect(payload.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'scheduler-admission:queue_shared_visible',
            threadId: shared.id,
          }),
          expect.objectContaining({
            id: 'agent-readiness:agent_codex_host',
            kind: 'agent_readiness',
          }),
        ])
      );
      expect(body).not.toContain(privateThread.id);
      expect(body).not.toContain('SECRET_PRIVATE_THREAD_TITLE');
      expect(body).not.toContain('queue_private_hidden');
      expect(body).not.toContain('goal_private_hidden');
      expect(body).not.toContain('SECRET_HIDDEN_APPROVAL');
      expect(body).not.toContain('ap_hidden_malformed');
      expect(body).not.toContain('SECRET_HIDDEN_CHECKPOINT');
      expect(getTurn.mock.calls.every(([, threadId]) => threadId !== privateThread.id)).toBe(true);
      expect(
        getApproval.mock.calls.every(([approvalId]) => approvalId !== 'ap_hidden_malformed')
      ).toBe(true);
      expect(listedGoals.mock.calls.every(([, owner]) => owner.threadId !== privateThread.id)).toBe(
        true
      );
    } finally {
      getTurn.mockRestore();
      getApproval.mockRestore();
      listedGoals.mockRestore();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { force: true, recursive: true });
    }
  });
});
