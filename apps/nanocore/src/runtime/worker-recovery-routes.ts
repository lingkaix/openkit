import {
  ListInterruptedWorkerStatesResponseSchema,
  RetryInterruptedWorkerCheckpointRequestSchema,
  type RetryInterruptedWorkerCheckpointResponse,
  RetryInterruptedWorkerCheckpointResponseSchema,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import type { Context, Hono } from 'hono';

import { asApiError, asCommandError, asInvalidRequestError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from '../auth/operation-authorizer.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { updateGoalStatus, updateGoalTask } from './goal-store.js';
import { commandInputHash, IdempotencyKeyConflictError } from './idempotent-command.js';
import { TurnStartValidationError } from './orchestrator.js';
import { updateWorkerCheckpoint } from './worker-checkpoints.js';
import {
  clearWorkerCheckpointAfterTerminalState,
  materializeInterruptedWorkerStates,
  resolveInterruptedWorkerRetryDecision,
} from './worker-recovery.js';

/**
 * Registers the complete interrupted-worker recovery App API feature path.
 *
 * @param dependencies Hono app and concrete recovery dependencies.
 */
export function registerWorkerRecoveryRoutes({
  app,
  authorizedWorkspaceIds,
  coreDb,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly authorizedWorkspaceIds: (
    context: Context<{ Variables: AuthVariables }>
  ) => readonly string[];
  readonly coreDb: CoreDb | undefined;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
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
          items: authorizedWorkspaceIds(c).flatMap((workspaceId) => {
            const workspaceDb = repositoryWorkspaceDb(workspaceId);
            try {
              return materializeInterruptedWorkerStates(coreDb, store, workspaceDb);
            } finally {
              workspaceDb.sqlite.close();
            }
          }),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'recovery_list_failed', 400);
    }
  });

  registerAppApiRoute(app, 'retryInterruptedWorkerCheckpoint', async (c) => {
    const parsed = RetryInterruptedWorkerCheckpointRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const workspaceId = c.req.param('workspaceId');
    const threadId = c.req.param('threadId');
    const turnId = c.req.param('turnId');
    const store = requestStore(c);
    let turn: ReturnType<FsStore['getTurnById']>;

    try {
      turn = store.getTurnById(turnId);
    } catch (error) {
      return asCommandError(error, 'recovery_retry_failed', 400);
    }
    assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), turn.workspaceId);

    try {
      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        const response = runInterruptedWorkerRetryCommand({
          authorityActor: turn.triggerActor,
          coreDb,
          requestId: parsed.data.requestId,
          store,
          threadId,
          turnId,
          workspaceDb,
          workspaceId,
        });

        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          threadId,
          turnId,
          workspaceId,
        });

        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asCommandError(error, 'recovery_retry_failed', 400);
    }
  });
}

/**
 * Atomically releases one authoritatively interrupted attempt for a later fresh start.
 *
 * @param input Existing authority stores, exact lineage, and caller request identity.
 * @returns Stable release result for fresh execution and exact replay.
 * @throws IdempotencyKeyConflictError when the request identity conflicts.
 * @throws TurnStartValidationError when reconnect or recovery authority forbids retry.
 */
function runInterruptedWorkerRetryCommand(input: {
  readonly authorityActor: ActorRef;
  readonly coreDb: CoreDb;
  readonly requestId: string;
  readonly store: FsStore;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
}): RetryInterruptedWorkerCheckpointResponse {
  const command = 'worker.recovery.retry' as const;
  const scope = {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
  };
  const inputHash = commandInputHash({});

  return input.workspaceDb.sqlite.transaction(() => {
    const receipt = input.store.getCommandRequest(
      command,
      input.requestId,
      scope,
      input.workspaceDb
    );
    if (receipt) {
      if (receipt.inputHash !== inputHash) {
        throw new IdempotencyKeyConflictError();
      }
      if (
        receipt.command !== command ||
        receipt.requestId !== input.requestId ||
        receipt.scope.workspaceId !== input.workspaceId ||
        receipt.scope.threadId !== input.threadId ||
        receipt.scope.turnId !== input.turnId ||
        Object.keys(receipt.scope).length !== 3 ||
        receipt.response.kind !== 'turn' ||
        receipt.response.id !== input.turnId
      ) {
        throw retryRecoveryRequired('Interrupted-worker retry receipt has invalid lineage.');
      }
      assertInterruptedTurn(input.store, input.workspaceId, input.threadId, input.turnId);
      return RetryInterruptedWorkerCheckpointResponseSchema.parse({
        outcome: 'released_for_retry',
        turnId: input.turnId,
      });
    }

    const decision = resolveInterruptedWorkerRetryDecision(
      input.coreDb,
      input.store,
      input.workspaceDb,
      {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: input.turnId,
      }
    );
    if (decision.status === 'reconnect-pending') {
      throw new TurnStartValidationError(
        'worker_reconnect_pending',
        'The original worker still owns an active reconnect window.',
        409
      );
    }
    if (decision.status === 'stale') {
      throw new TurnStartValidationError(
        'worker_recovery_stale',
        'The original worker attempt is no longer eligible for retry.',
        409
      );
    }
    if (decision.status !== 'eligible' || !decision.checkpoint) {
      throw retryRecoveryRequired(
        'Interrupted-worker cleanup or continuation authority is incomplete.'
      );
    }

    const checkpoint = decision.checkpoint;
    updateWorkerCheckpoint(input.workspaceDb, {
      authorityActor: input.authorityActor,
      diagnosticsSummary: 'Interrupted worker attempt released for a later fresh start.',
      stage: 'aborted',
      stopReason: 'aborted',
      threadId: input.threadId,
      turnId: input.turnId,
      workspaceId: input.workspaceId,
    });

    if (checkpoint.goalId && checkpoint.taskId) {
      updateGoalTask(input.workspaceDb, {
        goalId: checkpoint.goalId,
        status: 'ready',
        taskId: checkpoint.taskId,
        threadId: input.threadId,
        workspaceId: input.workspaceId,
      });
      updateGoalStatus(input.workspaceDb, {
        currentTaskId: null,
        goalId: checkpoint.goalId,
        status: 'running',
        threadId: input.threadId,
        workspaceId: input.workspaceId,
      });
    }

    input.store.recordCommandRequest(
      {
        command,
        inputHash,
        requestId: input.requestId,
        response: { id: input.turnId, kind: 'turn' },
        scope,
      },
      input.workspaceDb
    );
    return RetryInterruptedWorkerCheckpointResponseSchema.parse({
      outcome: 'released_for_retry',
      turnId: input.turnId,
    });
  })();
}

/** Confirms that the command receipt still names the original interrupted Turn. */
function assertInterruptedTurn(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  turnId: string
): void {
  try {
    if (store.getTurn(workspaceId, threadId, turnId).status !== 'interrupted') {
      throw retryRecoveryRequired('Interrupted-worker retry Turn is no longer interrupted.');
    }
  } catch (error) {
    if (error instanceof TurnStartValidationError) {
      throw error;
    }
    throw retryRecoveryRequired('Interrupted-worker retry Turn is unavailable.');
  }
}

/** Creates the stable fail-closed error for incomplete retry authority. */
function retryRecoveryRequired(message: string): TurnStartValidationError {
  return new TurnStartValidationError('recovery_required', message, 409);
}
