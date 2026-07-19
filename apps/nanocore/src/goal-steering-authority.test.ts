import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  claimPendingUserTurnRecord,
  completeSteeringTerminalOutcome,
  createPendingUserTurnRecord,
  deleteAppliedPendingUserTurnRecord,
  derivePendingUserTurnIds,
  deriveSteeringTerminalIds,
  getPendingUserTurnRecord,
  getSteeringTerminalOutcome,
  getSteeringTerminalOutcomeByRequestId,
  requireGoalSteeringSendProof,
} from './goal-steering-authority.js';
import { FsStore } from './lib/store.js';
import type { WorkspaceDb } from './storage/db.js';
import { openWorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';

const openDatabases: WorkspaceDb[] = [];

/** Opens one migrated isolated Workspace database. @returns Open database handle. */
function openTestWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-steering-authority-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_1');
  applyScopedMigrations(workspaceDb);
  openDatabases.push(workspaceDb);
  return workspaceDb;
}

/** Creates one message pending owner with stable baseline lineage. @param workspaceDb Open database. @param requestId Send request identity. @returns Created pending owner. */
function createMessagePending(workspaceDb: WorkspaceDb, requestId = 'req_send_1') {
  return createPendingUserTurnRecord(workspaceDb, {
    workspaceId: 'ws_1',
    threadId: 'th_1',
    goalId: 'goal_1',
    activeTurnId: 'tu_active_1',
    requestId,
    input: { kind: 'message' },
    receivedAt: '2026-07-18T01:00:00.000Z',
  });
}

afterEach(() => {
  for (const workspaceDb of openDatabases.splice(0)) {
    workspaceDb.sqlite.close();
  }
});

describe('Goal steering authority', () => {
  it('creates one deterministic pending owner and rejects another owner for the Thread', () => {
    const workspaceDb = openTestWorkspaceDb();
    const expectedIds = derivePendingUserTurnIds({
      workspaceId: 'ws_1',
      threadId: 'th_1',
      requestId: 'req_send_1',
    });
    const pending = createMessagePending(workspaceDb);

    expect(pending).toEqual({
      workspaceId: 'ws_1',
      threadId: 'th_1',
      pendingTurnId: expectedIds.pendingTurnId,
      goalId: 'goal_1',
      activeTurnId: 'tu_active_1',
      requestId: 'req_send_1',
      contentItemId: expectedIds.contentItemId,
      inputKind: 'message',
      materialId: null,
      revisionId: null,
      contentDigest: null,
      queueMode: 'safe_point_steering',
      receivedAt: '2026-07-18T01:00:00.000Z',
      terminalClaimKind: null,
      terminalClaimId: null,
      terminalClaimedAt: null,
    });
    expect(getPendingUserTurnRecord(workspaceDb, 'ws_1', 'th_1')).toEqual(pending);
    expect(() => createMessagePending(workspaceDb, 'req_send_2')).toThrowError(
      expect.objectContaining({ code: 'conflict' })
    );
    expect(() => createMessagePending(workspaceDb)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
  });

  it('requires the send receipt only while its pending owner remains live', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-steering-proof-'));
    const store = new FsStore();
    const workspace = store.createWorkspace('Steering proof');
    const thread = store.createThread(workspace.id, 'Steering proof');
    const receivedAt = '2000-01-01T00:00:00.000Z';
    const activeTurn = store.createTurn(
      workspace.id,
      thread.id,
      'Active Goal',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'tu_active_proof',
        startedAt: receivedAt,
      }
    );
    const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(workspaceDb);
    openDatabases.push(workspaceDb);
    const pending = createPendingUserTurnRecord(workspaceDb, {
      workspaceId: workspace.id,
      threadId: thread.id,
      goalId: 'goal_proof',
      activeTurnId: activeTurn.id,
      requestId: 'req_send_proof',
      input: { kind: 'message' },
      receivedAt,
    });
    store.createItem({
      id: pending.contentItemId,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: activeTurn.id,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'user_local' },
      text: 'Steer this Goal.',
      parentItemId: null,
      causationId: pending.requestId,
      createdAt: receivedAt,
      completedAt: receivedAt,
    });

    expect(() => requireGoalSteeringSendProof(workspaceDb, store, pending)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    store.recordCommandRequest(
      {
        command: 'goal.steering.send',
        requestId: pending.requestId,
        scope: { workspaceId: workspace.id, threadId: thread.id },
        inputHash: `sha256:${'a'.repeat(64)}`,
        response: { kind: 'pending_user_turn', id: pending.pendingTurnId },
        createdAt: receivedAt,
        expiresAt: '2000-01-02T00:00:00.000Z',
      },
      workspaceDb
    );
    expect(requireGoalSteeringSendProof(workspaceDb, store, pending)).toEqual(
      expect.objectContaining({ id: pending.contentItemId })
    );

    const terminalRequestId = 'req_cancel_proof';
    const outcome = workspaceDb.sqlite.transaction(() => {
      claimPendingUserTurnRecord(workspaceDb, {
        workspaceId: workspace.id,
        threadId: thread.id,
        pendingTurnId: pending.pendingTurnId,
        terminalClaimKind: 'cancelled',
        terminalClaimId: terminalRequestId,
        terminalClaimedAt: '2000-01-01T00:01:00.000Z',
      });
      return completeSteeringTerminalOutcome(workspaceDb, {
        workspaceId: workspace.id,
        threadId: thread.id,
        pendingTurnId: pending.pendingTurnId,
        state: 'cancelled',
        terminalRequestId,
      });
    })();

    expect(
      store.getCommandRequest(
        'goal.steering.send',
        pending.requestId,
        { workspaceId: workspace.id, threadId: thread.id },
        workspaceDb
      )
    ).toBeNull();
    expect(requireGoalSteeringSendProof(workspaceDb, store, outcome)).toEqual(
      expect.objectContaining({ id: pending.contentItemId })
    );
  });

  it('lets only the first exact terminal claimant resume its fence', () => {
    const workspaceDb = openTestWorkspaceDb();
    const pending = createMessagePending(workspaceDb);
    expect(() =>
      workspaceDb.sqlite
        .prepare(
          `UPDATE pending_user_turn_records
           SET terminal_claim_id = ?, terminal_claimed_at = ?
           WHERE workspace_id = ? AND thread_id = ?`
        )
        .run('partial_claim', '2026-07-18T01:00:30.000Z', 'ws_1', 'th_1')
    ).toThrow(/CHECK constraint failed/);
    const first = claimPendingUserTurnRecord(workspaceDb, {
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      pendingTurnId: pending.pendingTurnId,
      terminalClaimKind: 'applied',
      terminalClaimId: 'context_package_1',
      terminalClaimedAt: '2026-07-18T01:01:00.000Z',
    });
    const replay = claimPendingUserTurnRecord(workspaceDb, {
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      pendingTurnId: pending.pendingTurnId,
      terminalClaimKind: 'applied',
      terminalClaimId: 'context_package_1',
      terminalClaimedAt: '2026-07-18T02:00:00.000Z',
    });

    expect(replay).toEqual(first);
    expect(replay.terminalClaimedAt).toBe('2026-07-18T01:01:00.000Z');
    expect(() =>
      claimPendingUserTurnRecord(workspaceDb, {
        workspaceId: pending.workspaceId,
        threadId: pending.threadId,
        pendingTurnId: pending.pendingTurnId,
        terminalClaimKind: 'cancelled',
        terminalClaimId: 'req_cancel_1',
        terminalClaimedAt: '2026-07-18T01:02:00.000Z',
      })
    ).toThrowError(expect.objectContaining({ code: 'conflict' }));
  });

  it('deletes an applied winner only inside the caller final transaction', () => {
    const workspaceDb = openTestWorkspaceDb();
    const pending = createMessagePending(workspaceDb);
    claimPendingUserTurnRecord(workspaceDb, {
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      pendingTurnId: pending.pendingTurnId,
      terminalClaimKind: 'applied',
      terminalClaimId: 'context_package_1',
      terminalClaimedAt: '2026-07-18T01:01:00.000Z',
    });
    const deleteInput = {
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      pendingTurnId: pending.pendingTurnId,
      contextPackageId: 'context_package_1',
    } as const;

    expect(() => deleteAppliedPendingUserTurnRecord(workspaceDb, deleteInput)).toThrow(
      /caller Workspace transaction/
    );
    const rollback = new Error('rollback caller transaction');
    expect(() =>
      workspaceDb.sqlite.transaction(() => {
        deleteAppliedPendingUserTurnRecord(workspaceDb, deleteInput);
        expect(getPendingUserTurnRecord(workspaceDb, 'ws_1', 'th_1')).toBeNull();
        throw rollback;
      })()
    ).toThrow(rollback);
    expect(getPendingUserTurnRecord(workspaceDb, 'ws_1', 'th_1')).toEqual(
      expect.objectContaining({ terminalClaimId: 'context_package_1' })
    );
  });

  it('rejects terminal reuse of the send identity as an idempotency conflict', () => {
    const workspaceDb = openTestWorkspaceDb();
    const pending = createMessagePending(workspaceDb);

    expect(() =>
      workspaceDb.sqlite.transaction(() => {
        claimPendingUserTurnRecord(workspaceDb, {
          workspaceId: pending.workspaceId,
          threadId: pending.threadId,
          pendingTurnId: pending.pendingTurnId,
          terminalClaimKind: 'cancelled',
          terminalClaimId: pending.requestId,
          terminalClaimedAt: '2026-07-18T01:05:00.000Z',
        });
        return completeSteeringTerminalOutcome(workspaceDb, {
          workspaceId: pending.workspaceId,
          threadId: pending.threadId,
          pendingTurnId: pending.pendingTurnId,
          state: 'cancelled',
          terminalRequestId: pending.requestId,
        });
      })()
    ).toThrowError(expect.objectContaining({ code: 'idempotency_key_conflict' }));
  });

  it('rejects one terminal request identity across sequential pending owners', () => {
    const workspaceDb = openTestWorkspaceDb();
    const terminalRequestId = 'req_cancel_shared';
    const firstPending = createMessagePending(workspaceDb, 'req_send_1');
    const firstOutcome = workspaceDb.sqlite.transaction(() => {
      claimPendingUserTurnRecord(workspaceDb, {
        workspaceId: firstPending.workspaceId,
        threadId: firstPending.threadId,
        pendingTurnId: firstPending.pendingTurnId,
        terminalClaimKind: 'cancelled',
        terminalClaimId: terminalRequestId,
        terminalClaimedAt: '2026-07-18T01:05:00.000Z',
      });
      return completeSteeringTerminalOutcome(workspaceDb, {
        workspaceId: firstPending.workspaceId,
        threadId: firstPending.threadId,
        pendingTurnId: firstPending.pendingTurnId,
        state: 'cancelled',
        terminalRequestId,
      });
    })();
    const secondPending = createMessagePending(workspaceDb, 'req_send_2');

    expect(
      getSteeringTerminalOutcomeByRequestId(
        workspaceDb,
        firstPending.workspaceId,
        firstPending.threadId,
        terminalRequestId
      )
    ).toEqual(firstOutcome);

    expect(() =>
      workspaceDb.sqlite.transaction(() => {
        claimPendingUserTurnRecord(workspaceDb, {
          workspaceId: secondPending.workspaceId,
          threadId: secondPending.threadId,
          pendingTurnId: secondPending.pendingTurnId,
          terminalClaimKind: 'cancelled',
          terminalClaimId: terminalRequestId,
          terminalClaimedAt: '2026-07-18T02:05:00.000Z',
        });
        return completeSteeringTerminalOutcome(workspaceDb, {
          workspaceId: secondPending.workspaceId,
          threadId: secondPending.threadId,
          pendingTurnId: secondPending.pendingTurnId,
          state: 'cancelled',
          terminalRequestId,
        });
      })()
    ).toThrowError(expect.objectContaining({ code: 'idempotency_key_conflict' }));
    expect(
      getSteeringTerminalOutcome(
        workspaceDb,
        firstPending.workspaceId,
        firstPending.threadId,
        firstPending.pendingTurnId
      )
    ).toEqual(firstOutcome);
    expect(getPendingUserTurnRecord(workspaceDb, 'ws_1', 'th_1')).toEqual(secondPending);
  });

  it.each([
    'cancelled',
    'follow-up',
  ] as const)('prepares one immutable %s outcome inside the caller final transaction', (state) => {
    const workspaceDb = openTestWorkspaceDb();
    const pending = createPendingUserTurnRecord(workspaceDb, {
      workspaceId: 'ws_1',
      threadId: 'th_1',
      goalId: 'goal_1',
      activeTurnId: 'tu_active_1',
      requestId: 'req_send_1',
      input: {
        kind: 'material',
        materialId: 'mat_1',
        revisionId: 'mrev_1',
        contentDigest: `sha256:${'a'.repeat(64)}`,
      },
      receivedAt: '2026-07-18T01:00:00.000Z',
    });
    const terminalRequestId = `req_${state}`;
    const terminalIds = deriveSteeringTerminalIds({
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      pendingTurnId: pending.pendingTurnId,
      terminalRequestId,
    });
    const claim = {
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      pendingTurnId: pending.pendingTurnId,
      terminalClaimKind: state,
      terminalClaimId: state === 'cancelled' ? terminalRequestId : terminalIds.followUpTurnId,
      terminalClaimedAt: '2026-07-18T01:05:00.000Z',
    } as const;
    if (state === 'follow-up') {
      claimPendingUserTurnRecord(workspaceDb, claim);
    }

    let outcome: ReturnType<typeof completeSteeringTerminalOutcome> | undefined;
    const rollback = new Error('rollback caller transaction');
    expect(() =>
      workspaceDb.sqlite.transaction(() => {
        if (state === 'cancelled') {
          claimPendingUserTurnRecord(workspaceDb, claim);
        }
        outcome = completeSteeringTerminalOutcome(workspaceDb, {
          workspaceId: pending.workspaceId,
          threadId: pending.threadId,
          pendingTurnId: pending.pendingTurnId,
          state,
          terminalRequestId,
        });
        expect(getPendingUserTurnRecord(workspaceDb, 'ws_1', 'th_1')).toBeNull();
        expect(
          getSteeringTerminalOutcome(workspaceDb, 'ws_1', 'th_1', pending.pendingTurnId)
        ).toEqual(outcome);
        expect(() =>
          completeSteeringTerminalOutcome(workspaceDb, {
            workspaceId: pending.workspaceId,
            threadId: pending.threadId,
            pendingTurnId: pending.pendingTurnId,
            state,
            terminalRequestId,
          })
        ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
        throw rollback;
      })()
    ).toThrow(rollback);

    expect(outcome).toEqual({
      workspaceId: 'ws_1',
      threadId: 'th_1',
      pendingTurnId: pending.pendingTurnId,
      outcomeId: terminalIds.outcomeId,
      state,
      sendRequestId: 'req_send_1',
      terminalRequestId,
      contentItemId: pending.contentItemId,
      goalId: 'goal_1',
      activeTurnId: 'tu_active_1',
      inputKind: 'material',
      materialId: 'mat_1',
      revisionId: 'mrev_1',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      followUpTurnId: state === 'follow-up' ? terminalIds.followUpTurnId : null,
      followUpItemId: state === 'follow-up' ? terminalIds.followUpItemId : null,
      acceptedAt: '2026-07-18T01:05:00.000Z',
    });
    expect(
      getSteeringTerminalOutcome(workspaceDb, 'ws_1', 'th_1', pending.pendingTurnId)
    ).toBeNull();
    expect(getPendingUserTurnRecord(workspaceDb, 'ws_1', 'th_1')).toEqual(
      expect.objectContaining({
        terminalClaimKind: state === 'follow-up' ? 'follow-up' : null,
      })
    );
  });

  it('reports a pending and terminal outcome half-state as recovery_required', () => {
    const workspaceDb = openTestWorkspaceDb();
    const pending = createMessagePending(workspaceDb);
    claimPendingUserTurnRecord(workspaceDb, {
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      pendingTurnId: pending.pendingTurnId,
      terminalClaimKind: 'cancelled',
      terminalClaimId: 'req_cancel_1',
      terminalClaimedAt: '2026-07-18T01:05:00.000Z',
    });
    workspaceDb.sqlite
      .prepare(
        `INSERT INTO steering_terminal_outcomes (
          workspace_id, thread_id, pending_turn_id, outcome_id, state,
          send_request_id, terminal_request_id, content_item_id, goal_id, active_turn_id,
          input_kind, material_id, revision_id, content_digest,
          follow_up_turn_id, follow_up_item_id, accepted_at
        ) SELECT
          workspace_id, thread_id, pending_turn_id, 'sto_partial', 'cancelled',
          request_id, terminal_claim_id, content_item_id, goal_id, active_turn_id,
          input_kind, material_id, revision_id, content_digest,
          NULL, NULL, terminal_claimed_at
        FROM pending_user_turn_records WHERE workspace_id = ? AND thread_id = ?`
      )
      .run('ws_1', 'th_1');

    expect(() => getPendingUserTurnRecord(workspaceDb, 'ws_1', 'th_1')).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(() =>
      getSteeringTerminalOutcome(workspaceDb, 'ws_1', 'th_1', pending.pendingTurnId)
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
  });
});
