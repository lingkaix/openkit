import type { RECOVERY_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import {
  ListInterruptedWorkerStatesResponseSchema,
  type RetryInterruptedWorkerCheckpointResponse,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import { z } from 'zod';
import { publishedErrorMessage } from '../api-errors.js';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import { StoreRecordNotFoundError } from '../lib/store.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import type { OperationImplementations } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { runInterruptedWorkerRetryWorkspaceCommand } from '../storage/control-store-checkpoints.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { AgentEnvironmentSnapshotReadError } from './aep-snapshot-ledger.js';
import { IdempotencyKeyConflictError } from './idempotent-command.js';
import { TurnStartValidationError } from './orchestrator.js';
import {
  clearWorkerCheckpointAfterTerminalState,
  materializeInterruptedWorkerStates,
  resolveInterruptedWorkerRetryDecision,
} from './worker-recovery.js';
/** Joins recovery listing and release to the unchanged checkpoint, receipt and cleanup owners. */
export function createRecoveryOperationImplementations(
  dependencies: Pick<OperationInvocationDependencies, 'coreDb' | 'store' | 'repositoryWorkspaceDb'>
) {
  const { repositoryWorkspaceDb } = dependencies;
  // Native invocation admits Core storage before entering this family.
  const coreDb = dependencies.coreDb!;
  const store = dependencies.store!;
  return {
    'recovery.worker-list': (_input, context) => {
      const actor = context.actorRef;
      const workspaceIds =
        context.scope.kind === 'authorized-workspace-set' ? context.scope.workspaceIds : [];
      try {
        return ListInterruptedWorkerStatesResponseSchema.parse({
          items: workspaceIds.flatMap((workspaceId) => {
            const workspaceDb = repositoryWorkspaceDb!(workspaceId);
            try {
              return materializeInterruptedWorkerStates(coreDb, store, workspaceDb, (checkpoint) =>
                isThreadIdVisible(
                  store,
                  checkpoint.workspaceId,
                  checkpoint.threadId,
                  actor.id,
                  context.kind === 'public' &&
                    isCurrentDeploymentAdministrator(coreDb, context.actor)
                )
              );
            } finally {
              workspaceDb.sqlite.close();
            }
          }),
        });
      } catch (error) {
        if (
          error instanceof StoreRecordNotFoundError ||
          error instanceof SyntaxError ||
          error instanceof z.ZodError
        )
          throw new OperationError('recovery_list_failed', publishedErrorMessage(error), 400, {
            cause: error,
          });
        throw error;
      }
    },
    'recovery.checkpoint-retry': async (input) => {
      try {
        const turn = store.getTurnById(input.turnId);
        store.getWorkspace(input.workspaceId);
        store.getThread(input.workspaceId, input.threadId);
        const workspaceDb = repositoryWorkspaceDb!(input.workspaceId);
        try {
          const response = runInterruptedWorkerRetryCommand({
            ...input,
            authorityActor: turn.triggerActor,
            coreDb,
            store,
            workspaceDb,
          });
          await clearWorkerCheckpointAfterTerminalState(workspaceDb, input);
          return response;
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        if (
          error instanceof TurnStartValidationError ||
          error instanceof IdempotencyKeyConflictError
        )
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        if (
          error instanceof StoreRecordNotFoundError ||
          error instanceof AgentEnvironmentSnapshotReadError ||
          error instanceof SyntaxError ||
          error instanceof z.ZodError
        )
          throw new OperationError('recovery_retry_failed', publishedErrorMessage(error), 400, {
            cause: error,
          });
        throw error;
      }
    },
  } satisfies Pick<OperationImplementations, keyof typeof RECOVERY_OPERATION_DEFINITIONS>;
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
  return runInterruptedWorkerRetryWorkspaceCommand({
    ...input,
    resolveDecision: () =>
      resolveInterruptedWorkerRetryDecision(input.coreDb, input.store, input.workspaceDb, input),
  });
}

/** Recovery owns its original Turn lineage and missing-checkpoint refusal, independent of operation spelling. */
export function readRecoveryOperationLineage(
  store: import('../lib/store.js').FsStore,
  turnId: string
) {
  try {
    const lineage = store.getTurnLineage(turnId);
    if (!lineage) throw new StoreRecordNotFoundError(`Turn not found: ${turnId}`);
    return lineage;
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError)
      throw new OperationError('recovery_retry_failed', error.message, 400, { cause: error });
    throw error;
  }
}
