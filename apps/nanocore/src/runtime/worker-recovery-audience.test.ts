// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { closeSchedulerExecutionAttemptWithoutEffects } from './execution-attempt-records.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';

const PRIVATE_DIAGNOSTICS = 'Secret private interrupted needle';
const SHARED_DIAGNOSTICS = 'Shared interrupted recovery';

/**
 * Records one closed effect-free restart attempt so the interrupted worker list can materialize.
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
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: { kind: 'user', id: 'user_local' },
    profileRef: 'agent_codex_host',
    queueEntryId: `queue_${input.turnId}`,
    requestId: `request_${input.turnId}`,
    requestedAgentId: 'agent_codex_host',
    threadId: input.threadId,
    turnId: input.turnId,
    turnInput: 'Run interrupted-worker audience fixture.',
    workspaceId: input.workspaceId,
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: `lease_${input.turnId}`,
    agentSessionId: input.agentSessionId,
    inputRef: `aepsnap_${input.turnId}`,
    bindingRef: `lease-binding:lease_${input.turnId}`,
    sessionCompatibilityKey: 'recovery-audience',
    now: () => new Date().toISOString(),
  });
  // This read-model fixture never invokes a backend; restart closes that whole no-effect attempt.
  closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
    attemptId: `lease_${input.turnId}`,
    cause: 'restart-before-effects',
    noOutstandingEffects: true,
  });
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

/** Reads exact Core attempt ownership without interpreting NanoHost liveness or cleanup. */
function observeExecutionAttempts(
  coreDb: ReturnType<typeof openCoreDb>
): Record<string, unknown>[] {
  const exists = coreDb.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
    )
    .get();
  return exists
    ? (coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as Record<string, unknown>[])
    : [];
}

describe('interrupted worker list Thread audience', () => {
  it('keeps member audiences private while current administrators see all recovery rows', async () => {
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
      const ownerList = await app.request(
        ...operationRequest(
          'recovery.worker-list',
          {},
          {
            headers: { authorization: `Bearer ${ownerToken.secret}` },
          }
        )
      );
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

      const memberList = await app.request(
        ...operationRequest(
          'recovery.worker-list',
          {},
          {
            headers: { authorization: `Bearer ${memberToken.secret}` },
          }
        )
      );
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

      const adminList = await app.request(
        ...operationRequest(
          'recovery.worker-list',
          {},
          {
            headers: { authorization: `Bearer ${adminToken.secret}` },
          }
        )
      );
      expect(adminList.status, await adminList.clone().text()).toBe(200);
      const adminText = await adminList.text();
      expect(adminText).toContain(otherPrivateThread.id);
      expect(adminText).toContain(otherPrivateTurnId);
      const adminBody = JSON.parse(adminText) as {
        items: Array<{ threadId: string; turnId: string }>;
      };
      expect(adminBody.items.map((item) => item.threadId).sort()).toEqual(
        [ownPrivateThread.id, otherPrivateThread.id, sharedThread.id].sort()
      );
      expect(getTurnSpy.mock.calls.some(([, threadId]) => threadId === sharedThread.id)).toBe(true);
      expect(getTurnSpy.mock.calls.some(([, threadId]) => threadId === otherPrivateThread.id)).toBe(
        true
      );
      expect(
        getAgentSessionSpy.mock.calls.some(
          ([sessionId]) => sessionId === `as_${otherPrivateTurnId}`
        )
      ).toBe(true);

      const sessionApp = createApp({
        auth: {
          api: { getSession: async () => ({ user: { id: 'user_local' } }) },
          handler: async () => new Response(null, { status: 404 }),
        },
        coreDb,
        dataRoot,
        mode: 'server',
        store,
      });
      const sessionList = await sessionApp.request(...operationRequest('recovery.worker-list', {}));
      expect(sessionList.status).toBe(200);
      expect(
        (await sessionList.json()).items.map((item: { threadId: string }) => item.threadId).sort()
      ).toEqual([ownPrivateThread.id, otherPrivateThread.id, sharedThread.id].sort());

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

  it('releases an eligible checkpoint and replays its exact receipt without rewriting or relaunching the original attempt', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b9-recovery-receipt-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Receipt recovery');
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: workspace.id,
      ownerUserId: 'user_local',
    });
    const thread = store.createThread(workspace.id, 'Original attempt');
    const turnId = seedInterruptedWorker({
      coreDb,
      dataRoot,
      store,
      workspaceId: workspace.id,
      threadId: thread.id,
      diagnosticsSummary: 'Interrupted receipt attempt',
    });
    const turnBefore = { ...store.getTurnById(turnId) };
    const sessionBefore = { ...store.getAgentSession(`as_${turnId}`) };
    const db = openWorkspaceDb(dataRoot, workspace.id);
    const scope = { workspaceId: workspace.id, threadId: thread.id, turnId };
    const requestId = 'req_b9_exact_receipt';
    const app = createApp({ coreDb, dataRoot, store });
    const beforeAttempt = observeExecutionAttempts(coreDb).find(
      (attempt) => attempt.turn_id === turnId
    );
    try {
      expect(beforeAttempt).toBeDefined();
      expect(getWorkerCheckpoint(db, workspace.id, thread.id, turnId)).toMatchObject({
        stage: 'running_worker',
        stopReason: null,
      });
      const release = await app.request('/api/app/operations/recovery.checkpoint-retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
        body: JSON.stringify({ ...scope, requestId }),
      });
      expect(release.status, await release.clone().text()).toBe(200);
      await expect(release.json()).resolves.toEqual({ outcome: 'released_for_retry', turnId });
      const receipt = store.getCommandRequest('worker.recovery.retry', requestId, scope, db);
      expect(receipt).toMatchObject({
        command: 'worker.recovery.retry',
        requestId,
        scope,
        response: { kind: 'turn', id: turnId },
      });
      expect(getWorkerCheckpoint(db, workspace.id, thread.id, turnId)).toBeNull();
      const replay = await app.request('/api/app/operations/recovery.checkpoint-retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
        body: JSON.stringify({ ...scope, requestId }),
      });
      expect(replay.status, await replay.clone().text()).toBe(200);
      await expect(replay.json()).resolves.toEqual({ outcome: 'released_for_retry', turnId });
      expect(store.getCommandRequest('worker.recovery.retry', requestId, scope, db)).toEqual(
        receipt
      );
      expect(store.getTurnById(turnId)).toEqual(turnBefore);
      expect(store.getAgentSession(`as_${turnId}`)).toEqual(sessionBefore);
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.turn_id === turnId)
      ).toEqual(beforeAttempt);
      expect(store.listThreadTurns(workspace.id, thread.id)).toHaveLength(1);
    } finally {
      db.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
