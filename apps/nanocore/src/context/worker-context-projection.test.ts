import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  claimPendingUserTurnRecord,
  createPendingUserTurnRecord,
  type SteeringTerminalClaimKind,
} from '../goal-steering-authority.js';
import { createGoalRecord } from '../runtime/goal-store.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import type { WorkerContextPackageTrace } from './worker-context-package.js';
import {
  projectThreadMaterialContext,
  projectVerifiedThreadMaterialTraces,
  readPendingGoalSteeringProjection,
  selectVerifiedGoalSteeringTrace,
  type VerifiedWorkerContextTrace,
} from './worker-context-projection.js';

/** Builds the trace fields consumed by the pure read projector. */
function trace(
  turnId: string,
  selections: readonly [materialId: string, revisionId: string][]
): WorkerContextPackageTrace {
  return {
    turnId,
    materialSelections: selections.map(([materialId, revisionId]) => ({
      materialId,
      revisionId,
    })),
  } as WorkerContextPackageTrace;
}

/** Pairs one minimal trace with its verification branch and ordering timestamp. */
function verifiedTrace(
  turnId: string,
  selections: readonly [materialId: string, revisionId: string][],
  verification: VerifiedWorkerContextTrace['verification'] = 'strict',
  startedAt = '2026-07-18T00:00:00.000Z'
): VerifiedWorkerContextTrace {
  return { startedAt, trace: trace(turnId, selections), verification };
}

describe('worker Context Package read projection', () => {
  it.each([
    {
      name: 'orders last-seen traces by startedAt and then Turn id descending',
      traces: [
        verifiedTrace('tu_a', [['mat_1', 'mrev_1']]),
        verifiedTrace('tu_b', [['mat_1', 'mrev_2']]),
      ],
      currentTurnId: 'tu_a',
      expected: { lastWorkerSeenRevisionId: 'mrev_2', currentTurnRevisionId: 'mrev_1' },
    },
    {
      name: 'returns null when no verified trace selected the Material',
      traces: [verifiedTrace('tu_a', [['mat_2', 'mrev_2']])],
      currentTurnId: 'tu_a',
      expected: { lastWorkerSeenRevisionId: null, currentTurnRevisionId: null },
    },
    {
      name: 'does not substitute a historical trace for the current Turn',
      traces: [verifiedTrace('tu_a', [['mat_1', 'mrev_1']])],
      currentTurnId: 'tu_b',
      expected: { lastWorkerSeenRevisionId: 'mrev_1', currentTurnRevisionId: null },
    },
    {
      name: 'uses imported history only for last-seen revision',
      traces: [
        verifiedTrace(
          'tu_history',
          [['mat_1', 'mrev_history']],
          'imported-history',
          '2026-07-18T01:00:00.000Z'
        ),
      ],
      currentTurnId: 'tu_history',
      expected: { lastWorkerSeenRevisionId: 'mrev_history', currentTurnRevisionId: null },
    },
  ])('$name', ({ traces, currentTurnId, expected }) => {
    expect(
      projectVerifiedThreadMaterialTraces({
        currentTurnId,
        materialId: 'mat_1',
        traces,
      })
    ).toEqual(expected);
  });

  it('selects only one exact Goal steering delivery trace', () => {
    const matching = {
      ...trace('tu_delivery', []),
      contextPackageId: 'ctxpkg_tu_delivery',
      goalId: 'goal_1',
      includedItemIds: ['it_request', 'it_steering'],
    } as WorkerContextPackageTrace;
    const other = {
      ...trace('tu_other', []),
      contextPackageId: 'ctxpkg_tu_other',
      goalId: 'goal_2',
      includedItemIds: ['it_other'],
    } as WorkerContextPackageTrace;

    expect(
      selectVerifiedGoalSteeringTrace([matching, other], {
        contentItemId: 'it_steering',
        goalId: 'goal_1',
        inputKind: 'message',
        materialId: null,
        revisionId: null,
        contentDigest: null,
      })
    ).toBe(matching);
    expect(() =>
      selectVerifiedGoalSteeringTrace([matching, { ...matching }], {
        contentItemId: 'it_steering',
        goalId: 'goal_1',
        inputKind: 'message',
        materialId: null,
        revisionId: null,
        contentDigest: null,
      })
    ).toThrow('Goal steering delivery proof is ambiguous.');
    expect(
      selectVerifiedGoalSteeringTrace(
        [
          {
            ...matching,
            requestId: `import-lineage:sha256:${'a'.repeat(64)}`,
          },
        ],
        {
          contentItemId: 'it_steering',
          goalId: 'goal_1',
          inputKind: 'message',
          materialId: null,
          revisionId: null,
          contentDigest: null,
        }
      )
    ).toBeNull();

    const bindingBackedMaterial = {
      ...matching,
      materialSelections: [
        {
          materialId: 'mat_1',
          revisionId: 'mrev_1',
          contentDigest: `sha256:${'b'.repeat(64)}`,
          inclusionReason: 'goal_steering',
          bindingMutationRequestId: 'material-bind-1',
        },
      ],
    } as WorkerContextPackageTrace;
    expect(
      selectVerifiedGoalSteeringTrace([bindingBackedMaterial], {
        contentItemId: 'it_steering',
        goalId: 'goal_1',
        inputKind: 'material',
        materialId: 'mat_1',
        revisionId: 'mrev_1',
        contentDigest: `sha256:${'b'.repeat(64)}`,
      })
    ).toBe(bindingBackedMaterial);
    expect(() =>
      selectVerifiedGoalSteeringTrace([bindingBackedMaterial], {
        contentItemId: 'it_steering',
        goalId: 'goal_1',
        inputKind: 'material',
        materialId: 'mat_1',
        revisionId: 'mrev_other',
        contentDigest: `sha256:${'b'.repeat(64)}`,
      })
    ).toThrow('Goal steering Material delivery proof is inconsistent.');
  });

  it.each([
    'accepted-turn',
    'admission',
  ] as const)('fails closed when %s authority lacks its canonical trace', (authority) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-context-missing-trace-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const thread = store.createThread('ws_demo', 'Missing accepted context trace');
    const turn = store.createTurn('ws_demo', thread.id, 'Run accepted worker turn.', {
      kind: 'user',
      id: 'user_local',
    });

    try {
      if (authority === 'accepted-turn') {
        store.updateTurn(turn.id, { agentSessionId: 'as_missing_context_trace' });
      } else {
        createSchedulerAdmissionEntry(coreDb, {
          queueEntryId: 'queue_missing_context_trace',
          requestId: 'request_missing_context_trace',
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceId: 'ws_demo',
          threadId: thread.id,
          turnId: turn.id,
          turnInput: 'Run accepted worker turn.',
          requestedAgentId: 'agent_codex_host',
          profileRef: 'agent_codex_host',
          priorityClass: 'interactive',
          requiredPoolConstraints: [],
        });
        coreDb.sqlite
          .prepare(
            "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ?"
          )
          .run('queue_missing_context_trace');
      }

      expect(() =>
        projectThreadMaterialContext({
          coreDb,
          store,
          workspaceDb,
          threadId: thread.id,
          materialId: 'mat_1',
        })
      ).toThrow(
        'An accepted worker Turn or admitted scheduler entry lacks its Context Package trace.'
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects downstream follow-up effects under every pending claim kind', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-context-pending-effect-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const receivedAt = '2026-07-19T00:00:00.000Z';

    try {
      for (const terminalClaimKind of [
        null,
        'applied',
        'follow-up',
        'cancelled',
      ] as const satisfies readonly (SteeringTerminalClaimKind | null)[]) {
        const suffix = terminalClaimKind ?? 'none';
        const thread = store.createThread('ws_demo', `Pending effect ${suffix}`);
        const activeTurnId = `tu_pending_source_${suffix}`;
        const goalId = `goal_pending_effect_${suffix}`;
        const requestId = `request_pending_effect_${suffix}`;
        const effectTurnId = `tu_partial_follow_up_${suffix}`;
        createGoalRecord(workspaceDb, {
          workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
          goalId,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          title: 'Reject partial follow-up effects',
          objective: 'Keep the pending delivery authoritative.',
          status: 'running',
          now: () => receivedAt,
        });
        store.createTurn(
          'ws_demo',
          thread.id,
          'Original Goal worker.',
          { kind: 'user', id: 'user_local' },
          null,
          {
            turnId: activeTurnId,
            startedAt: receivedAt,
          }
        );
        const pending = createPendingUserTurnRecord(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId,
          activeTurnId,
          requestId,
          input: { kind: 'message' },
          receivedAt,
        });
        store.createItem({
          id: pending.contentItemId,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          turnId: activeTurnId,
          type: 'user-message',
          status: 'completed',
          actor: { kind: 'user', id: 'user_local' },
          text: 'Preserve this pending input.',
          parentItemId: null,
          causationId: requestId,
          createdAt: receivedAt,
          completedAt: receivedAt,
        });
        store.updateTurn(activeTurnId, {
          status: 'completed',
          completedAt: receivedAt,
          durationMs: 0,
        });
        store.recordCommandRequest(
          {
            command: 'goal.steering.send',
            requestId,
            scope: { workspaceId: 'ws_demo', threadId: thread.id },
            inputHash: `sha256:${'a'.repeat(64)}`,
            response: { kind: 'pending_user_turn', id: pending.pendingTurnId },
            createdAt: receivedAt,
          },
          workspaceDb
        );
        if (terminalClaimKind !== null) {
          claimPendingUserTurnRecord(workspaceDb, {
            workspaceId: 'ws_demo',
            threadId: thread.id,
            pendingTurnId: pending.pendingTurnId,
            terminalClaimKind,
            terminalClaimId:
              terminalClaimKind === 'follow-up' ? effectTurnId : `claim_${terminalClaimKind}`,
            terminalClaimedAt: receivedAt,
          });
        }
        const effectTurn = store.createTurn(
          'ws_demo',
          thread.id,
          'Partial follow-up.',
          { kind: 'user', id: 'user_local' },
          null,
          {
            turnId: effectTurnId,
            startedAt: receivedAt,
          }
        );
        store.createItem({
          id: `it_partial_follow_up_${suffix}`,
          workspaceId: 'ws_demo',
          threadId: thread.id,
          turnId: effectTurn.id,
          type: 'user-message',
          status: 'completed',
          actor: { kind: 'user', id: 'user_local' },
          text: 'Partial copied input.',
          parentItemId: pending.contentItemId,
          causationId: `terminal_${suffix}`,
          createdAt: receivedAt,
          completedAt: receivedAt,
        });

        expect(() =>
          readPendingGoalSteeringProjection({
            coreDb,
            store,
            workspaceDb,
            threadId: thread.id,
          })
        ).toThrow('Goal steering follow-up effect coexists with pending delivery.');
      }
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
