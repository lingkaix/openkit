import { randomUUID } from 'node:crypto';

import {
  CancelRecoveryPendingUserTurnResponseSchema,
  ClearInterruptedWorkerCheckpointRequestSchema,
  ClearInterruptedWorkerCheckpointResponseSchema,
  ConvertRecoveryPendingUserTurnToFollowUpResponseSchema,
  CreateInterruptedRecoveryStateResponseSchema,
  EditRecoveryPendingUserTurnRequestSchema,
  EditRecoveryPendingUserTurnResponseSchema,
  ListInterruptedWorkerStatesResponseSchema,
  ListRecoveryPendingUserTurnsResponseSchema,
  PromoteRecoveryPendingUserTurnToInterruptResponseSchema,
  RetryInterruptedWorkerCheckpointResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError, asInvalidRequestError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import { completeSchedulerLeaseForTerminalTurn } from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { getGoalRecord, listGoalTasks, updateGoalStatus, updateGoalTask } from './goal-store.js';
import {
  cancelPendingUserTurn,
  convertPendingUserTurnToFollowUp,
  enqueuePendingUserTurn,
  listPendingUserTurns,
  promotePendingUserTurnToInterrupt,
  recordPendingUserTurnEditedAuditEvent,
} from './pending-user-turns.js';
import type { TurnExecutor } from './types.js';
import {
  getWorkerCheckpoint,
  updateWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './worker-checkpoints.js';
import {
  clearWorkerCheckpointAfterTerminalState,
  materializeInterruptedWorkerStates,
} from './worker-recovery.js';

/**
 * Registers the complete interrupted-worker recovery App API feature path.
 *
 * @param dependencies Hono app and concrete recovery dependencies.
 */
export function registerWorkerRecoveryRoutes({
  app,
  coreDb,
  repositoryWorkspaceDb,
  requestStore,
  turnExecutor,
  visibleWorkspacesForActor,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly turnExecutor: TurnExecutor;
  readonly visibleWorkspacesForActor: (
    actor: AuthVariables['actor'] | undefined,
    workspaces: ReturnType<FsStore['listWorkspaces']>
  ) => ReturnType<FsStore['listWorkspaces']>;
}): void {
  registerAppApiRoute(app, 'createInterruptedRecoveryState', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const turn = store.createTurn(workspaceId, threadId, 'Deterministic interrupted worker');
      const timestamp = turn.startedAt ?? new Date().toISOString();
      const pendingItem = store.createItem({
        id: `it_recovery_pending_${turn.id}`,
        workspaceId,
        threadId,
        turnId: turn.id,
        type: 'user-message',
        status: 'completed',
        text: 'Pending input preserved across restart.',
        createdAt: timestamp,
        completedAt: timestamp,
      });
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      let checkpoint: ReturnType<typeof upsertWorkerCheckpoint>;
      let pendingUserTurn: ReturnType<typeof enqueuePendingUserTurn>;
      try {
        checkpoint = upsertWorkerCheckpoint(workspaceDb, {
          workspaceId,
          threadId,
          turnId: turn.id,
          stage: 'running_worker',
          iteration: 1,
          workerSessionId: 'deterministic-worker',
          contextDigest: `deterministic:${turn.id}`,
          diagnosticsSummary: 'Deterministic worker interrupted before terminal save.',
          now: () => timestamp,
        });
        pendingUserTurn = enqueuePendingUserTurn(workspaceDb, {
          workspaceId,
          threadId,
          requestId: `req_${turn.id}`,
          contentItemId: pendingItem.id,
          queueMode: 'safe_point_steering',
          receivedAt: timestamp,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      return c.json(
        CreateInterruptedRecoveryStateResponseSchema.parse({
          checkpoint: {
            checkpointId: checkpoint.checkpointId,
            turnId: checkpoint.turnId,
            stage: checkpoint.stage,
          },
          pendingUserTurn,
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'recovery_seed_failed', 400);
    }
  });

  registerAppApiRoute(app, 'listInterruptedWorkers', (c) => {
    try {
      if (!coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const store = requestStore(c);

      return c.json(
        ListInterruptedWorkerStatesResponseSchema.parse({
          items: visibleWorkspacesForActor(c.get('actor'), store.listWorkspaces()).flatMap(
            (workspace) => {
              const workspaceDb = repositoryWorkspaceDb(store, workspace.id);
              try {
                return materializeInterruptedWorkerStates(workspaceDb);
              } finally {
                workspaceDb.sqlite.close();
              }
            }
          ),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'recovery_list_failed', 400);
    }
  });

  registerAppApiRoute(app, 'listRecoveryPendingUserTurns', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        return c.json(
          ListRecoveryPendingUserTurnsResponseSchema.parse({
            items: listPendingUserTurns(workspaceDb, { workspaceId, threadId }),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'recovery_pending_user_turns_failed', 400);
    }
  });

  registerAppApiRoute(app, 'editRecoveryPendingUserTurn', async (c) => {
    const parsed = EditRecoveryPendingUserTurnRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const requestId = c.req.param('requestId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const pendingTurn =
          listPendingUserTurns(workspaceDb, { workspaceId, threadId }).find(
            (turn) => turn.requestId === requestId
          ) ?? null;

        if (!pendingTurn) {
          return c.json(
            EditRecoveryPendingUserTurnResponseSchema.parse({ edited: false, item: null })
          );
        }

        if (!pendingTurn.contentItemId) {
          return asApiError(
            'Pending user turn does not reference an editable item.',
            'recovery_pending_user_turn_edit_unsupported',
            409
          );
        }

        const item = store
          .listThreadItems(workspaceId, threadId)
          .find((candidate) => candidate.id === pendingTurn.contentItemId);

        if (!item || item.type !== 'user-message') {
          return asApiError(
            'Pending user turn does not reference an editable user message.',
            'recovery_pending_user_turn_edit_unsupported',
            409
          );
        }

        const updated = store.updateItem(item.id, {
          text: parsed.data.text,
        });
        recordPendingUserTurnEditedAuditEvent(workspaceDb, pendingTurn);

        return c.json(
          EditRecoveryPendingUserTurnResponseSchema.parse({ edited: true, item: updated })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'recovery_pending_user_turn_edit_failed', 400);
    }
  });

  registerAppApiRoute(app, 'convertRecoveryPendingUserTurnToFollowUp', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const requestId = c.req.param('requestId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const pendingUserTurn = convertPendingUserTurnToFollowUp(workspaceDb, {
          requestId,
          threadId,
          workspaceId,
        });

        return c.json(
          ConvertRecoveryPendingUserTurnToFollowUpResponseSchema.parse({
            converted: Boolean(pendingUserTurn),
            pendingUserTurn,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError(
        (error as Error).message,
        'recovery_pending_user_turn_follow_up_failed',
        400
      );
    }
  });

  registerAppApiRoute(app, 'promoteRecoveryPendingUserTurnToInterrupt', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const requestId = c.req.param('requestId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const pendingTurn =
          listPendingUserTurns(workspaceDb, { workspaceId, threadId }).find(
            (turn) => turn.requestId === requestId
          ) ?? null;

        if (!pendingTurn) {
          return c.json(
            PromoteRecoveryPendingUserTurnToInterruptResponseSchema.parse({
              promoted: false,
              turn: null,
            })
          );
        }

        const activeTurn =
          [...store.listThreadTurns(workspaceId, threadId)]
            .reverse()
            .find((turn) => turn.status === 'pending' || turn.status === 'running') ?? null;

        if (!activeTurn) {
          return asApiError(
            'Thread has no active turn to interrupt.',
            'recovery_pending_user_turn_interrupt_unavailable',
            409
          );
        }

        if (!turnExecutor.capabilities.interrupts) {
          return asApiError(
            'The active turn executor does not support interruption.',
            'interrupts_not_supported',
            501
          );
        }

        await turnExecutor.interruptTurn(store, activeTurn.id, { requestId: randomUUID() });
        const interruptedTurn = store.getTurn(workspaceId, threadId, activeTurn.id);
        completeSchedulerLeaseForTerminalTurn(coreDb, interruptedTurn);
        const promoted = promotePendingUserTurnToInterrupt(workspaceDb, {
          requestId,
          threadId,
          workspaceId,
        });

        return c.json(
          PromoteRecoveryPendingUserTurnToInterruptResponseSchema.parse({
            promoted: Boolean(promoted),
            turn: interruptedTurn,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError(
        (error as Error).message,
        'recovery_pending_user_turn_interrupt_failed',
        400
      );
    }
  });

  registerAppApiRoute(app, 'cancelRecoveryPendingUserTurn', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const requestId = c.req.param('requestId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        return c.json(
          CancelRecoveryPendingUserTurnResponseSchema.parse({
            cancelled: Boolean(
              cancelPendingUserTurn(workspaceDb, { requestId, threadId, workspaceId })
            ),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'recovery_pending_user_turn_cancel_failed', 400);
    }
  });

  registerAppApiRoute(app, 'retryInterruptedWorkerCheckpoint', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const turnId = c.req.param('turnId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const checkpoint = getWorkerCheckpoint(workspaceDb, workspaceId, threadId, turnId);

        if (!checkpoint) {
          return c.json(
            RetryInterruptedWorkerCheckpointResponseSchema.parse({
              retried: false,
              turn: null,
            })
          );
        }

        if (
          checkpoint.goalId &&
          checkpoint.taskId &&
          (!getGoalRecord(workspaceDb, workspaceId, threadId, checkpoint.goalId) ||
            !listGoalTasks(workspaceDb, {
              goalId: checkpoint.goalId,
              threadId,
              workspaceId,
            }).some((task) => task.taskId === checkpoint.taskId))
        ) {
          return asApiError(
            'Interrupted worker checkpoint has missing goal task lineage.',
            'recovery_retry_lineage_unavailable',
            409
          );
        }

        const now = new Date().toISOString();
        const turn = store.updateTurn(turnId, {
          completedAt: now,
          error: {
            code: 'worker_checkpoint_retry',
            message: 'Interrupted worker checkpoint was queued for retry.',
          },
          status: 'interrupted',
        });

        updateWorkerCheckpoint(workspaceDb, {
          diagnosticsSummary: 'Interrupted worker checkpoint queued for retry.',
          stage: 'aborted',
          stopReason: 'aborted',
          threadId,
          turnId,
          workspaceId,
        });

        if (checkpoint.goalId && checkpoint.taskId) {
          updateGoalTask(workspaceDb, {
            goalId: checkpoint.goalId,
            status: 'ready',
            taskId: checkpoint.taskId,
            threadId,
            workspaceId,
          });
          updateGoalStatus(workspaceDb, {
            currentTaskId: checkpoint.taskId,
            goalId: checkpoint.goalId,
            status: 'running',
            threadId,
            workspaceId,
          });
        }

        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          terminalStage: 'aborted',
          threadId,
          turnId,
          workspaceId,
        });

        return c.json(
          RetryInterruptedWorkerCheckpointResponseSchema.parse({
            retried: true,
            turn,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'recovery_retry_failed', 400);
    }
  });

  registerAppApiRoute(app, 'clearInterruptedWorkerCheckpoint', async (c) => {
    const parsed = ClearInterruptedWorkerCheckpointRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const turnId = c.req.param('turnId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        return c.json(
          ClearInterruptedWorkerCheckpointResponseSchema.parse({
            cleared: await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
              workspaceId,
              threadId,
              turnId,
              terminalStage: parsed.data.terminalStage,
            }),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'recovery_clear_failed', 400);
    }
  });
}
