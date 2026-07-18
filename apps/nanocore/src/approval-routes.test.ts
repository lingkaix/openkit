import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { createPolicyApprovalGate } from './policy/approval-gates.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';

/**
 * Creates one policy-gated approval route fixture.
 *
 * @returns Open database, app, store, turn, and stable gate ids.
 */
function createPolicyApprovalFixture() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-approval-route-')));
  applyMigrations(coreDb);
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Approve repo.push');
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');
  applyScopedMigrations(workspaceDb);
  const gate = createPolicyApprovalGate({
    approvalId: 'ap_repo_push',
    approvalItemId: 'it_repo_push',
    decisionId: 'pd_repo_push_required',
    description: 'Approve repo.push.',
    reasonCode: 'repo_push_approval_required',
    resourceSummary: { action: 'repo.push' },
    store,
    subjectSummary: { kind: 'test' },
    title: 'Approve repo.push',
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
  it('keeps a policy approval in recovery_required when its response receipt is missing', async () => {
    const fixture = createPolicyApprovalFixture();
    const requestId = '00000000-0000-4000-8000-000000000101';

    try {
      vi.spyOn(fixture.store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('Injected approval response receipt failure.');
      });

      const failed = await respondToPolicyApproval(fixture, requestId);
      expect(failed.status).toBe(409);
      await expect(failed.json()).resolves.toMatchObject({ code: 'recovery_required' });

      const retried = await respondToPolicyApproval(fixture, requestId);
      expect(retried.status).toBe(409);
      await expect(retried.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(fixture.store.getApproval(fixture.gate.approvalId).status).toBe('granted');
      expect(
        fixture.store
          .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
          .filter((item) => item.id === `it_approval_decision_${fixture.gate.approvalId}`)
      ).toHaveLength(1);
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
      expect(fixture.store.listCommandRequests()).toEqual([]);

      const workspaceDb = openWorkspaceDb(
        fixture.coreDb.dataRoot,
        fixture.store.getUserId(),
        fixture.turn.workspaceId
      );
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
            decisionId: `pd_repo_push_granted_${fixture.gate.approvalId}`,
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

      const workspaceDb = openWorkspaceDb(
        fixture.coreDb.dataRoot,
        fixture.store.getUserId(),
        fixture.turn.workspaceId
      );
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

  it('rejects runtime approval scope mismatches before calling the executor', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-runtime-approval-scope-')));
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Approve runtime action');
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

  it('replays a resolved runtime approval after approval capability becomes unavailable', async () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Replay resolved runtime approval');
    store.createApproval({
      id: 'ap_runtime_replay',
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      kind: 'permission',
      status: 'granted',
      title: 'Resolved runtime approval',
      description: 'Already resolved before runtime replacement.',
      createdAt: '2026-07-12T00:00:00.000Z',
      resolvedAt: '2026-07-12T00:00:01.000Z',
    });
    const executor = new SimulatedTurnExecutor();
    Object.defineProperty(executor, 'capabilities', {
      value: { ...executor.capabilities, approvals: false },
    });
    const app = createApp({ store, turnExecutor: executor });

    const replayed = await app.request('/api/approvals/ap_runtime_replay/respond', {
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

    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({
      id: 'ap_runtime_replay',
      status: 'granted',
    });
  });
});
