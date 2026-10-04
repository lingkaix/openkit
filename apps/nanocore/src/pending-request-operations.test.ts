import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { ensureLocalUser } from './auth/identity.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { KnowledgePageValidationError } from './knowledge/okf.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { recordProductPermissionDecision } from './policy/permission-decisions.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { raiseRecordedPendingRequest } from './runtime/pending-request-flow.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Creates one person approval or incomplete runtime approval route fixture.
 *
 * @returns Open database, app, store, turn, and stable gate ids.
 */
function createApprovalFixture(action: 'review.apply' | 'tool.use' = 'review.apply') {
  const actionSlug = action.replace('.', '_');
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-approval-route-')));
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore();
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: 'ws_demo',
  });
  const turn = store.createTurn('ws_demo', 'th_demo', `Approve ${action}`, {
    kind: 'user',
    id: 'user_local',
  });
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  const gate = {
    approvalId: `ap_${actionSlug}`,
    approvalItemId: `it_${actionSlug}`,
  };
  const timestamp = '2026-09-30T00:00:00.000Z';
  store.createApproval({
    id: gate.approvalId,
    workspaceId: 'ws_demo',
    threadId: turn.threadId,
    turnId: turn.id,
    kind: 'permission',
    status: 'pending',
    title: `Approve ${action}`,
    description: `Approve ${action}.`,
    createdAt: timestamp,
    resolvedAt: null,
  });
  store.createItem({
    id: gate.approvalItemId,
    workspaceId: 'ws_demo',
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'approval-request',
    status: 'completed',
    approvalRequestId: gate.approvalId,
    title: `Approve ${action}`,
    description: `Approve ${action}.`,
    kind: 'permission',
    createdAt: timestamp,
    completedAt: timestamp,
  });
  if (action === 'tool.use') {
    recordProductPermissionDecision({
      workspaceDb,
      decisionId: `pd_${actionSlug}_required`,
      ownerScope: 'workspace',
      workspaceId: 'ws_demo',
      policyEngineVersion: 'test-runtime-approval:v1',
      policySnapshotId: 'test-runtime-approval',
      subjectSummary: { kind: 'test' },
      action,
      resourceSummary: { action },
      contextSummary: { threadId: turn.threadId, turnId: turn.id, workspaceId: 'ws_demo' },
      result: 'require_approval',
      reasonCode: `${actionSlug}_approval_required`,
      enforcementPoint: 'test.incomplete_runtime_approval',
      requiredApprovalKind: 'permission',
      approvalId: gate.approvalId,
      now: new Date(timestamp),
    });
  }
  if (action === 'review.apply') {
    raiseRecordedPendingRequest(store, workspaceDb.sqlite, {
      requestId: gate.approvalId,
      workspaceId: 'ws_demo',
      threadId: turn.threadId,
      raisingTurnId: turn.id,
      requestItemId: gate.approvalItemId,
      kind: 'approval',
      requesterKind: 'person',
      responsibleUserId: 'user_local',
      governedIntent: { action },
      approval: {
        kind: 'permission',
        title: store.getApproval(gate.approvalId).title,
        description: store.getApproval(gate.approvalId).description,
      },
      now: '2026-09-30T00:00:00.000Z',
    });
  }
  workspaceDb.sqlite.close();

  return {
    app: createApp({ coreDb, store, turnExecutor: new SimulatedTurnExecutor() }),
    coreDb,
    gate,
    store,
    turn,
  };
}

/**
 * Posts one approval response to its person or incomplete runtime fixture.
 *
 * @param fixture Approval route fixture.
 * @param requestId Stable idempotency key.
 * @param decision Requested approval decision.
 * @returns Route response.
 */
function respondToApproval(
  fixture: ReturnType<typeof createApprovalFixture>,
  requestId: string,
  decision: 'denied' | 'granted' = 'granted'
): Promise<Response> {
  return fixture.app.request(
    ...operationRequest(
      'approval.respond',
      { approvalRequestId: fixture.gate.approvalId },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision,
          requestId,
          threadId: fixture.turn.threadId,
          turnId: fixture.turn.id,
          workspaceId: fixture.turn.workspaceId,
        }),
      }
    )
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Pending Request operations', () => {
  it.each([
    new KernelCommandError('unavailable', 'Kernel receipt owner unavailable.'),
    new TurnStartValidationError('recovery_required', 'Turn receipt owner needs recovery.', 409),
    new KnowledgePageValidationError(),
  ])('preserves the command error $code and status $status from a receipt dependency', async (error) => {
    const f = createApprovalFixture();
    try {
      vi.spyOn(f.store, 'getCommandRequest').mockImplementation(() => {
        throw error;
      });
      const response = await respondToApproval(f, '00000000-0000-4000-8000-000000000201');
      expect(response.status).toBe(error.status);
      expect(await response.json()).toMatchObject({ code: error.code, message: error.message });
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('rejects tool.use without the exact worker owner tuple', async () => {
    const fixture = createApprovalFixture('tool.use');

    try {
      const response = await respondToApproval(fixture, '00000000-0000-4000-8000-000000000114');
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('pending');

      const workspaceDb = openWorkspaceDb(fixture.coreDb.dataRoot, 'ws_demo');
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT action, result
               FROM permission_decisions
               WHERE approval_id = ?
               ORDER BY created_at, decision_id`
            )
            .all(fixture.gate.approvalId)
        ).toEqual([{ action: 'tool.use', result: 'require_approval' }]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('resolves a person approval on a leased Turn without deleting the scheduler lease', async () => {
    const fixture = createApprovalFixture('review.apply');
    const now = '2026-09-15T00:00:00.000Z';

    try {
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_session_leases (
             lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
             heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
             sandbox_binding_ref, backend_anchor_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?, ?, ?, 0, 1, ?, 'unanchored')`
        )
        .run(
          `lease_${fixture.turn.id}`,
          `plan_${fixture.turn.id}`,
          fixture.turn.workspaceId,
          fixture.turn.threadId,
          fixture.turn.id,
          `as_${fixture.turn.id}`,
          `pkg_${fixture.turn.id}`,
          `pool_${fixture.turn.id}`,
          `target_${fixture.turn.id}`,
          now,
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          `binding_${fixture.turn.id}`
        );

      const response = await respondToApproval(fixture, '00000000-0000-4000-8000-000000000171');
      expect(response.status, await response.clone().text()).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: fixture.gate.approvalId,
        status: 'granted',
      });
      expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('granted');
      expect(fixture.store.getTurnById(fixture.turn.id).status).toBe('running');
      expect(
        fixture.coreDb.sqlite
          .prepare(
            `SELECT status, release_reason AS releaseReason
             FROM scheduler_session_leases
             WHERE turn_id = ?`
          )
          .get(fixture.turn.id)
      ).toEqual({ status: 'acquired', releaseReason: null });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('keeps tool.use fail-closed when a lease exists without a worker checkpoint', async () => {
    const fixture = createApprovalFixture('tool.use');
    const now = '2026-09-15T00:00:00.000Z';

    try {
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_session_leases (
             lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
             heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
             sandbox_binding_ref, backend_anchor_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?, ?, ?, 0, 1, ?, 'unanchored')`
        )
        .run(
          `lease_${fixture.turn.id}`,
          `plan_${fixture.turn.id}`,
          fixture.turn.workspaceId,
          fixture.turn.threadId,
          fixture.turn.id,
          `as_${fixture.turn.id}`,
          `pkg_${fixture.turn.id}`,
          `pool_${fixture.turn.id}`,
          `target_${fixture.turn.id}`,
          now,
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          `binding_${fixture.turn.id}`
        );

      const response = await respondToApproval(fixture, '00000000-0000-4000-8000-000000000172');
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('pending');
      expect(
        fixture.coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE turn_id = ?')
          .get(fixture.turn.id)
      ).toEqual({ status: 'acquired' });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('keeps a committed person grant when the command receipt write fails', async () => {
    const fixture = createApprovalFixture();
    const requestId = '00000000-0000-4000-8000-000000000101';
    const otherRequestId = '00000000-0000-4000-8000-000000000102';

    try {
      vi.spyOn(fixture.store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('Injected approval response receipt failure.');
      });

      const failed = await respondToApproval(fixture, requestId);
      expect(failed.status).toBe(500);
      expect(await failed.text()).toBe('Internal Server Error');
      expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('granted');
      expect(fixture.store.listCommandRequests()).toEqual([]);

      const changed = await respondToApproval(fixture, otherRequestId, 'denied');
      expect(changed.status).toBe(409);
      await expect(changed.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });

      const retried = await respondToApproval(fixture, requestId);
      expect(retried.status).toBe(409);
      await expect(retried.json()).resolves.toMatchObject({ code: 'request_not_pending' });
      expect(fixture.store.getTurnById(fixture.turn.id).status).toBe('running');
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it.each([
    ['granted', '00000000-0000-4000-8000-000000000104'],
    ['denied', '00000000-0000-4000-8000-000000000107'],
  ] as const)('replays one receipt-backed %s approval without closing the raising Turn', async (decision, requestId) => {
    const fixture = createApprovalFixture();

    try {
      const resolved = await respondToApproval(fixture, requestId, decision);
      expect(resolved.status).toBe(200);

      const replayed = await respondToApproval(fixture, requestId, decision);
      expect(replayed.status).toBe(200);
      await expect(replayed.json()).resolves.toMatchObject({ status: decision });
      expect(fixture.store.getTurnById(fixture.turn.id).status).toBe('running');
      expect(
        fixture.store
          .getTurnEvents(fixture.turn.id)
          .filter((event) => event.event === 'turn.completed')
      ).toEqual([]);
      const workspaceDb = openWorkspaceDb(fixture.coreDb.dataRoot, fixture.turn.workspaceId);
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT result FROM permission_decisions
               WHERE approval_id = ? AND result IN ('allow', 'deny')`
            )
            .all(fixture.gate.approvalId)
        ).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('joins concurrent duplicate person approval responses before receipt publication', async () => {
    const fixture = createApprovalFixture();
    const requestId = '00000000-0000-4000-8000-000000000105';

    try {
      const responses = await Promise.all([
        respondToApproval(fixture, requestId),
        respondToApproval(fixture, requestId),
      ]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      await expect(responses[0]?.json()).resolves.toMatchObject({ status: 'granted' });
      await expect(responses[1]?.json()).resolves.toMatchObject({ status: 'granted' });
      expect(
        fixture.store
          .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
          .filter((item) => item.type === 'approval-decision')
      ).toHaveLength(0);
      expect(fixture.store.getTurnById(fixture.turn.id).status).toBe('running');
      expect(fixture.store.listCommandRequests()).toHaveLength(1);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('lets one contrary person approval request win and reports the other as stale', async () => {
    const fixture = createApprovalFixture();
    const grantedRequestId = '00000000-0000-4000-8000-000000000111';
    const deniedRequestId = '00000000-0000-4000-8000-000000000112';

    try {
      const responses = await Promise.all([
        respondToApproval(fixture, grantedRequestId, 'granted'),
        respondToApproval(fixture, deniedRequestId, 'denied'),
      ]);
      const payloads = await Promise.all(responses.map((response) => response.json()));

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(payloads).toContainEqual(
        expect.objectContaining({ code: 'idempotency_key_conflict' })
      );
      expect(
        fixture.store
          .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
          .filter((item) => item.type === 'approval-decision')
      ).toHaveLength(0);
      expect(
        fixture.store
          .getTurnEvents(fixture.turn.id)
          .filter((event) => event.event === 'turn.completed')
      ).toHaveLength(0);
      expect(fixture.store.listCommandRequests()).toHaveLength(1);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('fails closed when the originating approval tuple is contradictory', async () => {
    const fixture = createApprovalFixture();
    const workspaceDb = openWorkspaceDb(fixture.coreDb.dataRoot, fixture.turn.workspaceId);

    try {
      fixture.store.createItem({
        id: 'it_ahead_decision',
        workspaceId: fixture.turn.workspaceId,
        threadId: fixture.turn.threadId,
        turnId: fixture.turn.id,
        type: 'approval-decision',
        status: 'completed',
        actor: { kind: 'user', id: 'user_local' },
        causationId: 'req_ahead',
        approvalRequestId: fixture.gate.approvalId,
        decision: 'granted',
        decidedAt: '2026-09-30T00:00:01.000Z',
        createdAt: '2026-09-30T00:00:01.000Z',
        completedAt: '2026-09-30T00:00:01.000Z',
      });
      workspaceDb.sqlite.close();

      const response = await respondToApproval(fixture, '00000000-0000-4000-8000-000000000113');

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('pending');
      expect(
        fixture.store
          .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
          .filter((item) => item.type === 'approval-decision')
          .map((item) => item.id)
      ).toEqual(['it_ahead_decision']);
      expect(fixture.store.listCommandRequests()).toEqual([]);
    } finally {
      if (workspaceDb.sqlite.open) {
        workspaceDb.sqlite.close();
      }
      fixture.coreDb.sqlite.close();
    }
  });

  it('rejects runtime approval scope mismatches before calling the executor', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-runtime-approval-scope-')));
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore();
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Approve runtime action', {
      kind: 'user',
      id: 'user_local',
    });
    store.createApproval({
      id: 'ap_runtime_scope',
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve runtime action',
      description: 'Approve once.',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    const executor = new SimulatedTurnExecutor();
    const respondApproval = vi
      .spyOn(executor, 'respondApproval')
      .mockImplementation(async (requestStore, approvalRequestId, decision) =>
        requestStore.updateApproval(approvalRequestId, {
          status: decision,
          resolvedAt: new Date().toISOString(),
        })
      );
    const app = createApp({ coreDb, store, turnExecutor: executor });

    try {
      const response = await app.request(
        ...operationRequest(
          'approval.respond',
          { approvalRequestId: 'ap_runtime_scope' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              decision: 'granted',
              requestId: '00000000-0000-4000-8000-000000000106',
              threadId: 'th_wrong',
              turnId: turn.id,
              workspaceId: turn.workspaceId,
            }),
          }
        )
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      expect(respondApproval).not.toHaveBeenCalled();
      expect(store.getApproval('ap_runtime_scope').status).toBe('pending');
      expect(store.listCommandRequests()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails closed for a non-policy runtime approval without calling the executor', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-runtime-approval-unsupported-')));
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore();
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Reject non-policy runtime approval', {
      kind: 'user',
      id: 'user_local',
    });
    store.createApproval({
      id: 'ap_runtime_unsupported',
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Unsupported runtime approval',
      description: 'No durable policy claim owns this approval.',
      createdAt: '2026-07-12T00:00:00.000Z',
      resolvedAt: null,
    });
    const executor = new SimulatedTurnExecutor();
    const respondApproval = vi.spyOn(executor, 'respondApproval');
    const app = createApp({ coreDb, store, turnExecutor: executor });

    const response = await app.request(
      ...operationRequest(
        'approval.respond',
        { approvalRequestId: 'ap_runtime_unsupported' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision: 'granted',
            requestId: '00000000-0000-4000-8000-000000000109',
            threadId: turn.threadId,
            turnId: turn.id,
            workspaceId: turn.workspaceId,
          }),
        }
      )
    );

    try {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(respondApproval).not.toHaveBeenCalled();
      expect(store.getApproval('ap_runtime_unsupported').status).toBe('pending');
      expect(store.listCommandRequests()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
