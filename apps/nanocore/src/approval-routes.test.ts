import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { ensureLocalUser } from './auth/identity.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { createPolicyApprovalGate } from './policy/approval-gates.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Creates one policy-gated approval route fixture.
 *
 * @returns Open database, app, store, turn, and stable gate ids.
 */
function createPolicyApprovalFixture(action: 'repo.push' | 'tool.use' = 'repo.push') {
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
  const gate = createPolicyApprovalGate({
    action,
    approvalId: `ap_${actionSlug}`,
    approvalItemId: `it_${actionSlug}`,
    decisionId: `pd_${actionSlug}_required`,
    description: `Approve ${action}.`,
    reasonCode: `${actionSlug}_approval_required`,
    resourceSummary: { action },
    store,
    subjectSummary: { kind: 'test' },
    title: `Approve ${action}`,
    turnId: turn.id,
    workspaceDb,
    workspaceId: 'ws_demo',
  });
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
 * Posts one approval response to a policy fixture.
 *
 * @param fixture Policy approval fixture.
 * @param requestId Stable idempotency key.
 * @param decision Requested approval decision.
 * @returns Route response.
 */
function respondToPolicyApproval(
  fixture: ReturnType<typeof createPolicyApprovalFixture>,
  requestId: string,
  decision: 'denied' | 'granted' = 'granted'
): Promise<Response> {
  return fixture.app.request(`/api/approvals/${fixture.gate.approvalId}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      decision,
      requestId,
      threadId: fixture.turn.threadId,
      turnId: fixture.turn.id,
      workspaceId: fixture.turn.workspaceId,
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approval response routes', () => {
  it('rejects tool.use without the exact worker owner tuple', async () => {
    const fixture = createPolicyApprovalFixture('tool.use');

    try {
      const response = await respondToPolicyApproval(
        fixture,
        '00000000-0000-4000-8000-000000000114'
      );
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

  it('finishes deterministic policy approval projections when the winning receipt is missing', async () => {
    const fixture = createPolicyApprovalFixture();
    const requestId = '00000000-0000-4000-8000-000000000101';

    try {
      vi.spyOn(fixture.store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('Injected approval response receipt failure.');
      });

      const failed = await respondToPolicyApproval(fixture, requestId);
      expect(failed.status).toBe(409);
      await expect(failed.json()).resolves.toMatchObject({ code: 'recovery_required' });

      const changed = await respondToPolicyApproval(fixture, requestId, 'denied');
      expect(changed.status).toBe(409);
      await expect(changed.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });

      const corruptedWorkspaceDb = openWorkspaceDb(
        fixture.coreDb.dataRoot,
        fixture.turn.workspaceId
      );
      try {
        corruptedWorkspaceDb.sqlite
          .prepare(
            `UPDATE audit_events
             SET turn_id = 'turn_wrong'
             WHERE permission_decision_id = ?`
          )
          .run(`pd_repo_push_granted_${fixture.gate.approvalId}`);
      } finally {
        corruptedWorkspaceDb.sqlite.close();
      }
      const mismatchedAudit = await respondToPolicyApproval(fixture, requestId);
      expect(mismatchedAudit.status).toBe(409);
      await expect(mismatchedAudit.json()).resolves.toMatchObject({ code: 'recovery_required' });

      const repairedWorkspaceDb = openWorkspaceDb(
        fixture.coreDb.dataRoot,
        fixture.turn.workspaceId
      );
      try {
        repairedWorkspaceDb.sqlite
          .prepare(
            `UPDATE audit_events
             SET turn_id = ?
             WHERE permission_decision_id = ?`
          )
          .run(fixture.turn.id, `pd_repo_push_granted_${fixture.gate.approvalId}`);
      } finally {
        repairedWorkspaceDb.sqlite.close();
      }
      const retried = await respondToPolicyApproval(fixture, requestId);
      expect(retried.status).toBe(200);
      await expect(retried.json()).resolves.toMatchObject({ status: 'granted' });
      expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('granted');
      expect(
        fixture.store
          .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
          .filter((item) => item.id === `it_approval_decision_${fixture.gate.approvalId}`)
      ).toHaveLength(1);
      expect(
        fixture.store
          .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
          .find((item) => item.id === `it_approval_decision_${fixture.gate.approvalId}`)
      ).toMatchObject({
        actor: { id: 'user_local', kind: 'user' },
        causationId: requestId,
      });
      expect(
        fixture.store.getTurn(fixture.turn.workspaceId, fixture.turn.threadId, fixture.turn.id)
      ).toMatchObject({ status: 'completed', humanGate: null, completedAt: expect.any(String) });
      expect(
        fixture.store
          .getTurnEvents(fixture.turn.id)
          .filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'completed' }),
        }),
      ]);
      expect(fixture.store.listCommandRequests()).toHaveLength(1);

      const workspaceDb = openWorkspaceDb(fixture.coreDb.dataRoot, fixture.turn.workspaceId);
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT
                 decision.decision_id AS decisionId,
                 decision.result,
                 audit.actor_json AS actorJson,
                 audit.request_id AS requestId
               FROM permission_decisions AS decision
               JOIN audit_events AS audit
                 ON audit.audit_event_id = decision.audit_event_id
                AND audit.permission_decision_id = decision.decision_id
               WHERE decision.approval_id = ?
                 AND decision.result IN ('allow', 'deny')`
            )
            .all(fixture.gate.approvalId)
        ).toEqual([
          {
            actorJson: JSON.stringify({ kind: 'user', id: 'user_local' }),
            decisionId: `pd_repo_push_granted_${fixture.gate.approvalId}`,
            requestId,
            result: 'allow',
          },
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it.each([
    ['granted', 'completed', 'completed', 'allow', '00000000-0000-4000-8000-000000000104'],
    ['denied', 'cancelled', 'aborted', 'deny', '00000000-0000-4000-8000-000000000107'],
  ] as const)('closes and replays one receipt-backed %s policy approval response', async (decision, turnStatus, stopReason, policyResult, requestId) => {
    const fixture = createPolicyApprovalFixture();

    try {
      const resolved = await respondToPolicyApproval(fixture, requestId, decision);
      expect(resolved.status).toBe(200);

      const replayed = await respondToPolicyApproval(fixture, requestId, decision);
      expect(replayed.status).toBe(200);
      await expect(replayed.json()).resolves.toMatchObject({ status: decision });
      expect(
        fixture.store.getTurn(fixture.turn.workspaceId, fixture.turn.threadId, fixture.turn.id)
      ).toMatchObject({ status: turnStatus, humanGate: null, completedAt: expect.any(String) });
      expect(
        fixture.store
          .getTurnEvents(fixture.turn.id)
          .filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason }),
        }),
      ]);

      const workspaceDb = openWorkspaceDb(fixture.coreDb.dataRoot, fixture.turn.workspaceId);
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT decision_id AS decisionId, result
               FROM permission_decisions
               WHERE approval_id = ? AND result IN ('allow', 'deny')`
            )
            .all(fixture.gate.approvalId)
        ).toEqual([
          {
            decisionId: `pd_repo_push_${decision}_${fixture.gate.approvalId}`,
            result: policyResult,
          },
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('joins concurrent duplicate policy approval responses before receipt publication', async () => {
    const fixture = createPolicyApprovalFixture();
    const requestId = '00000000-0000-4000-8000-000000000105';

    try {
      const responses = await Promise.all([
        respondToPolicyApproval(fixture, requestId),
        respondToPolicyApproval(fixture, requestId),
      ]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      await expect(responses[0]?.json()).resolves.toMatchObject({ status: 'granted' });
      await expect(responses[1]?.json()).resolves.toMatchObject({ status: 'granted' });
      expect(
        fixture.store
          .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
          .filter((item) => item.id === `it_approval_decision_${fixture.gate.approvalId}`)
      ).toHaveLength(1);
      expect(fixture.store.listCommandRequests()).toHaveLength(1);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('lets one contrary policy approval request win and reports the other as stale', async () => {
    const fixture = createPolicyApprovalFixture();
    const grantedRequestId = '00000000-0000-4000-8000-000000000111';
    const deniedRequestId = '00000000-0000-4000-8000-000000000112';

    try {
      const responses = await Promise.all([
        respondToPolicyApproval(fixture, grantedRequestId, 'granted'),
        respondToPolicyApproval(fixture, deniedRequestId, 'denied'),
      ]);
      const payloads = await Promise.all(responses.map((response) => response.json()));

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(payloads).toContainEqual(expect.objectContaining({ code: 'stale' }));

      const workspaceDb = openWorkspaceDb(fixture.coreDb.dataRoot, fixture.turn.workspaceId);
      try {
        const winners = workspaceDb.sqlite
          .prepare(
            `SELECT
               decision.result,
               audit.actor_json AS actorJson,
               audit.request_id AS requestId
             FROM permission_decisions AS decision
             JOIN audit_events AS audit
               ON audit.audit_event_id = decision.audit_event_id
              AND audit.permission_decision_id = decision.decision_id
             WHERE decision.approval_id = ?
               AND decision.result IN ('allow', 'deny')`
          )
          .all(fixture.gate.approvalId);
        expect(winners).toHaveLength(1);
        expect(winners[0]).toMatchObject({
          actorJson: JSON.stringify({ kind: 'user', id: 'user_local' }),
          requestId: expect.stringMatching(/^00000000-0000-4000-8000-00000000011[12]$/),
        });
      } finally {
        workspaceDb.sqlite.close();
      }
      expect(
        fixture.store
          .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
          .filter((item) => item.type === 'approval-decision')
      ).toHaveLength(1);
      expect(
        fixture.store
          .getTurnEvents(fixture.turn.id)
          .filter((event) => event.event === 'turn.completed')
      ).toHaveLength(1);
      expect(fixture.store.listCommandRequests()).toHaveLength(1);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('fails closed when the originating policy approval tuple is contradictory', async () => {
    const fixture = createPolicyApprovalFixture();
    const workspaceDb = openWorkspaceDb(fixture.coreDb.dataRoot, fixture.turn.workspaceId);

    try {
      workspaceDb.sqlite
        .prepare(
          `UPDATE permission_decisions
           SET context_summary_json = ?
           WHERE decision_id = ?`
        )
        .run(
          JSON.stringify({
            threadId: fixture.turn.threadId,
            turnId: 'turn_wrong',
            workspaceId: fixture.turn.workspaceId,
          }),
          fixture.gate.decisionId
        );
      workspaceDb.sqlite.close();

      const response = await respondToPolicyApproval(
        fixture,
        '00000000-0000-4000-8000-000000000113'
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('pending');
      expect(
        fixture.store
          .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
          .filter((item) => item.type === 'approval-decision')
      ).toEqual([]);
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
      const response = await app.request('/api/approvals/ap_runtime_scope/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'granted',
          requestId: '00000000-0000-4000-8000-000000000106',
          threadId: 'th_wrong',
          turnId: turn.id,
          workspaceId: turn.workspaceId,
        }),
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        code: 'approval_response_failed',
        message: expect.stringContaining('scope mismatch'),
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

    const response = await app.request('/api/approvals/ap_runtime_unsupported/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'granted',
        requestId: '00000000-0000-4000-8000-000000000109',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceId: turn.workspaceId,
      }),
    });

    try {
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({ code: 'approvals_not_supported' });
      expect(respondApproval).not.toHaveBeenCalled();
      expect(store.getApproval('ap_runtime_unsupported').status).toBe('pending');
      expect(store.listCommandRequests()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
