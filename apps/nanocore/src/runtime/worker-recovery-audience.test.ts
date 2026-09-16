// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import {
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';

const PRIVATE_DIAGNOSTICS = 'Secret private interrupted needle';
const SHARED_DIAGNOSTICS = 'Shared interrupted recovery';

/**
 * Records one released restart-cleanup lease so the interrupted worker list can materialize.
 *
 * @param coreDb Open Core database handle.
 * @param input Exact Workspace, Thread, Turn, and AgentSession lineage.
 */
function recordReleasedRestartLease(
  coreDb: CoreDb,
  input: {
    readonly agentSessionId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  }
): void {
  createSchedulerAdmissionEntry(coreDb, {
    triggerActor: { kind: 'user', id: 'user_local' },
    priorityClass: 'interactive',
    profileRef: 'agent_codex_host',
    queueEntryId: `queue_${input.turnId}`,
    requestId: `request_${input.turnId}`,
    requestedAgentId: 'agent_codex_host',
    requiredPoolConstraints: ['openshell.local'],
    threadId: input.threadId,
    turnId: input.turnId,
    turnInput: 'Run interrupted-worker audience fixture.',
    workspaceId: input.workspaceId,
  });
  createSchedulerPlacementPlan(coreDb, {
    degradedOptionalFeatures: [],
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    planId: `plan_${input.turnId}`,
    plannedLeaseDurationMs: 900_000,
    policyDecisionIds: [],
    queueEntryId: `queue_${input.turnId}`,
    schedulerEpoch: 1,
    selectedPoolId: 'pool_local',
    selectedTargetId: 'target_local',
  });
  createSchedulerSessionLease(coreDb, {
    agentSessionId: input.agentSessionId,
    expiresAt: '2099-01-01T01:00:00.000Z',
    heartbeatDeadline: '2099-01-01T00:10:00.000Z',
    leaseId: `lease_${input.turnId}`,
    packageSnapshotId: `aepsnap_${input.turnId}`,
    planId: `plan_${input.turnId}`,
    sandboxTokenBindingRef: `lease-binding:lease_${input.turnId}`,
    startupDeadline: '2099-01-01T00:05:00.000Z',
  });
  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
       SET status = ?, release_reason = ?, recovery_state = ?, recovery_deadline = ?
       WHERE lease_id = ?`
    )
    .run('released', 'scheduler-restart-backend-cleanup', null, null, `lease_${input.turnId}`);
}

/**
 * Seeds one eligible interrupted worker checkpoint on a Thread.
 *
 * @param input Store, Core, and lineage for one recovery row.
 * @returns Created AgentSession id.
 */
function seedInterruptedWorker(input: {
  readonly coreDb: CoreDb;
  readonly dataRoot: string;
  readonly diagnosticsSummary: string;
  readonly goalId?: string;
  readonly store: FsStore;
  readonly taskId?: string;
  readonly threadId: string;
  readonly workspaceId: string;
}): string {
  const turn = input.store.createTurn(input.workspaceId, input.threadId, input.diagnosticsSummary, {
    kind: 'user',
    id: 'user_local',
  });
  const agentSessionId = `as_${turn.id}`;
  const completedAt = '2026-09-16T00:00:00.000Z';
  input.store.createAgentSession({
    agentId: 'agent_codex_host',
    createdAt: turn.startedAt ?? completedAt,
    id: agentSessionId,
    message: input.diagnosticsSummary,
    status: 'interrupted',
    threadId: input.threadId,
    updatedAt: completedAt,
    workspaceId: input.workspaceId,
  });
  input.store.updateTurn(turn.id, {
    agentSessionId,
    completedAt,
    error: {
      code: 'worker_governance_restart_recovery',
      message: input.diagnosticsSummary,
    },
    status: 'interrupted',
  });
  const workspaceDb = openWorkspaceDb(input.dataRoot, input.workspaceId);
  try {
    applyScopedMigrations(workspaceDb);
    upsertWorkerCheckpoint(workspaceDb, {
      contextDigest: `sha256:${turn.id}`,
      diagnosticsSummary: input.diagnosticsSummary,
      goalId: input.goalId ?? null,
      iteration: 1,
      requestId: `req_${turn.id}`,
      requestInputHash: `sha256:${turn.id}`,
      stage: 'running_worker',
      taskId: input.taskId ?? null,
      threadId: input.threadId,
      turnId: turn.id,
      workerSessionId: agentSessionId,
      workspaceId: input.workspaceId,
    });
  } finally {
    workspaceDb.sqlite.close();
  }
  recordReleasedRestartLease(input.coreDb, {
    agentSessionId,
    threadId: input.threadId,
    turnId: turn.id,
    workspaceId: input.workspaceId,
  });
  return turn.id;
}

describe('interrupted worker list Thread audience', () => {
  it('keeps own and shared recovery rows and hides another member private Thread from members and admins', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-recovery-audience-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Recovery audience team');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at) VALUES ('user_other', 'Other', 'other@example.invalid', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now);
    const stamp = '2026-09-16T00:00:00.000Z';
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES (?, 'user_other', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(workspace.id, stamp, stamp, stamp);

    const ownPrivateThread = store.createThread(
      workspace.id,
      'Own private recovery thread',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_local' }
    );
    const otherPrivateThread = store.createThread(
      workspace.id,
      'Other private recovery thread',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_other' }
    );
    const sharedThread = store.createThread(
      workspace.id,
      'Shared recovery thread',
      undefined,
      'conversation',
      { visibility: 'workspace' }
    );
    const ownPrivateTurnId = seedInterruptedWorker({
      coreDb,
      dataRoot,
      diagnosticsSummary: PRIVATE_DIAGNOSTICS,
      goalId: 'goal_hidden_malformed',
      store,
      taskId: 'task_hidden_malformed',
      threadId: ownPrivateThread.id,
      workspaceId: workspace.id,
    });
    const otherPrivateTurnId = seedInterruptedWorker({
      coreDb,
      dataRoot,
      diagnosticsSummary: PRIVATE_DIAGNOSTICS,
      goalId: 'goal_other_hidden_malformed',
      store,
      taskId: 'task_other_hidden_malformed',
      threadId: otherPrivateThread.id,
      workspaceId: workspace.id,
    });
    const sharedTurnId = seedInterruptedWorker({
      coreDb,
      dataRoot,
      diagnosticsSummary: SHARED_DIAGNOSTICS,
      store,
      threadId: sharedThread.id,
      workspaceId: workspace.id,
    });
    const ownPrivateTurnBefore = store.getTurn(workspace.id, ownPrivateThread.id, ownPrivateTurnId);
    const otherPrivateTurnBefore = store.getTurn(
      workspace.id,
      otherPrivateThread.id,
      otherPrivateTurnId
    );
    const sharedTurnBefore = store.getTurn(workspace.id, sharedThread.id, sharedTurnId);
    const checkpointDb = openWorkspaceDb(dataRoot, workspace.id);
    const ownPrivateCheckpointBefore = getWorkerCheckpoint(
      checkpointDb,
      workspace.id,
      ownPrivateThread.id,
      ownPrivateTurnId
    );
    const otherPrivateCheckpointBefore = getWorkerCheckpoint(
      checkpointDb,
      workspace.id,
      otherPrivateThread.id,
      otherPrivateTurnId
    );
    const sharedCheckpointBefore = getWorkerCheckpoint(
      checkpointDb,
      workspace.id,
      sharedThread.id,
      sharedTurnId
    );
    checkpointDb.sqlite.close();

    const app = createApp({
      auth: {
        api: { getSession: async () => null },
        handler: async () => new Response(null, { status: 404 }),
      },
      coreDb,
      dataRoot,
      mode: 'server',
      store,
    });
    const ownerToken = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const memberToken = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_other',
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const adminToken = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    try {
      const ownerList = await app.request('/api/app/recovery/interrupted-workers', {
        headers: { authorization: `Bearer ${ownerToken.secret}` },
      });
      expect(ownerList.status, await ownerList.clone().text()).toBe(200);
      const ownerBody = (await ownerList.json()) as {
        items: Array<{ threadId: string; turnId: string; diagnosticsSummary: string | null }>;
      };
      expect(ownerBody.items.map((item) => item.threadId).sort()).toEqual(
        [ownPrivateThread.id, sharedThread.id].sort()
      );
      expect(ownerBody.items.map((item) => item.turnId).sort()).toEqual(
        [ownPrivateTurnId, sharedTurnId].sort()
      );
      expect(JSON.stringify(ownerBody)).not.toContain(otherPrivateThread.id);

      const getTurnSpy = vi.spyOn(store, 'getTurn');
      const getAgentSessionSpy = vi.spyOn(store, 'getAgentSession');

      const memberList = await app.request('/api/app/recovery/interrupted-workers', {
        headers: { authorization: `Bearer ${memberToken.secret}` },
      });
      expect(memberList.status, await memberList.clone().text()).toBe(200);
      const memberText = await memberList.text();
      expect(memberText).not.toContain(ownPrivateThread.id);
      expect(memberText).not.toContain(ownPrivateTurnId);
      const memberBody = JSON.parse(memberText) as {
        items: Array<{ threadId: string; turnId: string }>;
      };
      expect(memberBody.items.map((item) => item.threadId).sort()).toEqual(
        [otherPrivateThread.id, sharedThread.id].sort()
      );
      expect(getTurnSpy.mock.calls.some(([, threadId]) => threadId === sharedThread.id)).toBe(true);
      expect(getTurnSpy.mock.calls.some(([, threadId]) => threadId === ownPrivateThread.id)).toBe(
        false
      );
      expect(
        getAgentSessionSpy.mock.calls.some(([sessionId]) => sessionId === `as_${ownPrivateTurnId}`)
      ).toBe(false);

      getTurnSpy.mockClear();
      getAgentSessionSpy.mockClear();

      const adminList = await app.request('/api/app/recovery/interrupted-workers', {
        headers: { authorization: `Bearer ${adminToken.secret}` },
      });
      expect(adminList.status, await adminList.clone().text()).toBe(200);
      const adminText = await adminList.text();
      expect(adminText).not.toContain(otherPrivateThread.id);
      expect(adminText).not.toContain(otherPrivateTurnId);
      const adminBody = JSON.parse(adminText) as {
        items: Array<{ threadId: string; turnId: string }>;
      };
      expect(adminBody.items.map((item) => item.threadId).sort()).toEqual(
        [ownPrivateThread.id, sharedThread.id].sort()
      );
      expect(getTurnSpy.mock.calls.some(([, threadId]) => threadId === sharedThread.id)).toBe(true);
      expect(getTurnSpy.mock.calls.some(([, threadId]) => threadId === otherPrivateThread.id)).toBe(
        false
      );
      expect(
        getAgentSessionSpy.mock.calls.some(
          ([sessionId]) => sessionId === `as_${otherPrivateTurnId}`
        )
      ).toBe(false);

      getTurnSpy.mockRestore();
      getAgentSessionSpy.mockRestore();

      expect(store.getTurn(workspace.id, ownPrivateThread.id, ownPrivateTurnId)).toEqual(
        ownPrivateTurnBefore
      );
      expect(store.getTurn(workspace.id, otherPrivateThread.id, otherPrivateTurnId)).toEqual(
        otherPrivateTurnBefore
      );
      expect(store.getTurn(workspace.id, sharedThread.id, sharedTurnId)).toEqual(sharedTurnBefore);
      const afterDb = openWorkspaceDb(dataRoot, workspace.id);
      try {
        expect(
          getWorkerCheckpoint(afterDb, workspace.id, ownPrivateThread.id, ownPrivateTurnId)
        ).toEqual(ownPrivateCheckpointBefore);
        expect(
          getWorkerCheckpoint(afterDb, workspace.id, otherPrivateThread.id, otherPrivateTurnId)
        ).toEqual(otherPrivateCheckpointBefore);
        expect(getWorkerCheckpoint(afterDb, workspace.id, sharedThread.id, sharedTurnId)).toEqual(
          sharedCheckpointBefore
        );
      } finally {
        afterDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
