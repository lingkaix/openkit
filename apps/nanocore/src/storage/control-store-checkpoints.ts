import { isDeepStrictEqual } from 'node:util';
import {
  type RetryInterruptedWorkerCheckpointResponse,
  RetryInterruptedWorkerCheckpointResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type ActorRef,
  ActorRefSchema,
  AgentSessionIdSchema,
  StopReasonSchema,
  ThreadIdSchema,
  ThreadSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import { z } from 'zod';
import { IdempotencyKeyConflictError, TurnStartValidationError } from '../operation-error.js';
import { recordWorkerTurnLaunchDecision } from '../policy/permission-decisions.js';
import {
  StoredGoalCardV1Schema,
  StoredGoalPlanVersionV1Schema,
  StoredGoalV1Schema,
} from '../runtime/goal-retained-v1.js';
import { reserveGoalTask } from '../runtime/goal-task-admission.js';
import {
  clearWorkerCheckpoint,
  getWorkerCheckpoint,
  updateWorkerCheckpoint,
  upsertWorkerCheckpoint,
  type WorkerCheckpointRecord,
} from '../runtime/worker-checkpoints.js';
import { isTerminalWorkerTurnStage, WORKER_TURN_STAGES } from '../runtime/worker-stage.js';
import {
  commandRequestExpiresAt,
  commandRequestKey,
  getCommandRequestRecordFromDb,
  recordCommandRequestRecordInDb,
} from './command-request-records.js';
import { commandInputHash, presentControlFacts } from './control-store-input.js';
import { ControlProductPreconditionError, readProduct } from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import { StoredTurnV1Schema } from './retained-work-metadata-v1.js';
import {
  AgentSessionRecordSchema,
  listExportableAgentEnvironmentPackageSnapshots,
} from './workspace-file-records.js';

const scope = { workspaceId: WorkspaceIdSchema, threadId: ThreadIdSchema, turnId: TurnIdSchema };
const stage = z.enum(WORKER_TURN_STAGES);
const iteration = z.number().int().nonnegative().safe();
const optionalText = z.string().nullable().optional();
const mutable = {
  workerSessionId: optionalText,
  contextDigest: optionalText,
  stopReason: StopReasonSchema.nullable().optional(),
  diagnosticsSummary: optionalText,
};
const admission = {
  goalId: optionalText,
  taskId: optionalText,
  requestId: z.string().min(1),
  requestInputHash: z.string(),
};
const goalTaskAdmission = z
  .object({
    goalId: StoredGoalV1Schema.shape.goalId,
    cardId: StoredGoalCardV1Schema.shape.cardId,
    planVersionId: StoredGoalPlanVersionV1Schema.shape.planVersionId,
    cardRevision: StoredGoalCardV1Schema.shape.revision,
    intentRevision: StoredGoalV1Schema.shape.intentRevision,
    withinCurrentIntent: z.boolean(),
    withinPermittedAdjustments: z.boolean(),
    rationale: z.string(),
  })
  .strict();

const checkpoint = z.object({ ...scope, ...admission, ...mutable, stage, iteration }).strict();
const checkpointRecord = checkpoint.required().extend({
  checkpointId: z.string().min(1),
  replayInstruction: z.literal(false),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/** Dormant checkpoint facts; timestamp strings replace caller-owned clock callbacks. */
export const ControlCheckpointCommandInputSchema = z.discriminatedUnion('kind', [
  checkpoint.extend({ kind: z.literal('upsert'), now: TimestampSchema }),
  z
    .object({
      kind: z.literal('update'),
      ...scope,
      ...mutable,
      authorityActor: ActorRefSchema,
      stage: stage.optional(),
      iteration: iteration.optional(),
      now: TimestampSchema,
    })
    .strict(),
  checkpointRecord.extend({ kind: z.literal('clear-terminal') }),
  checkpointRecord.extend({ kind: z.literal('clear-cancelled') }),
  z
    .object({
      kind: z.literal('bind'),
      ...scope,
      requestId: z.string().nullable(),
      agentSessionId: AgentSessionIdSchema,
      now: TimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('retry'),
      ...scope,
      requestId: z.string().min(1),
      now: TimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('retry-replay'),
      ...scope,
      requestId: z.string().min(1),
      now: TimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('reserve'),
      ...scope,
      ...admission,
      contextDigest: optionalText,
      diagnosticsSummary: optionalText,
      now: TimestampSchema,
      goalTaskAdmission: goalTaskAdmission.optional(),
    })
    .strict(),
]);
/** Closed checkpoint mutation on an already-admitted Workspace handle. */
export type ControlCheckpointCommandInput = z.infer<typeof ControlCheckpointCommandInputSchema>;

/** Exact checkpoint readback or the existing clear result, visible only after durable ACK. */
export const ControlCheckpointCommandResultSchema = z.union([
  checkpointRecord,
  z.object({ outcome: z.literal('released_for_retry'), turnId: TurnIdSchema }).strict(),
  z.boolean(),
]);
/** Existing checkpoint record or clear's deletion flag. */
export type ControlCheckpointCommandResult = z.infer<typeof ControlCheckpointCommandResultSchema>;

/** Applies the existing checkpoint owners inside the native command's active savepoint. */
export function applyControlCheckpointCommand(
  db: WorkspaceDb,
  input: ControlCheckpointCommandInput
): ControlCheckpointCommandResult {
  if (db.scope !== 'workspace' || db.workspaceId !== input.workspaceId || !db.sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  if (input.kind === 'clear-terminal' || input.kind === 'clear-cancelled') {
    const { kind, ...expected } = input;
    if (kind === 'clear-terminal') return clearWorkerCheckpointIfUnchanged(db, expected);
    if (
      readProduct(
        db.sqlite,
        { kind: 'workspace', workspaceId: db.workspaceId },
        'turn',
        input.turnId
      )
    )
      return false;
    return clearCancelledWorkerPreparation(db, expected);
  }
  if (input.kind === 'bind' || input.kind === 'retry' || input.kind === 'retry-replay') {
    const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
    const getTurn = (workspaceId: string, threadId: string, turnId: string) => {
      const row = readProduct(db.sqlite, owner, 'turn', turnId);
      if (!row)
        throw new TurnStartValidationError('recovery_required', 'Worker Turn is unavailable.', 409);
      const turn = StoredTurnV1Schema.parse(row.record);
      if (
        workspaceId !== db.workspaceId ||
        workspaceIdForOwner(turn.owner) !== workspaceId ||
        turn.threadId !== threadId
      )
        throw new TurnStartValidationError(
          'recovery_required',
          'Worker Turn lineage is contradictory.',
          409
        );
      return turn;
    };
    if (input.kind === 'bind') {
      if (!getWorkerCheckpoint(db, input.workspaceId, input.threadId, input.turnId)) return false;
      return bindWorkerCheckpointSession(db, {
        ...input,
        authorityActor: getTurn(input.workspaceId, input.threadId, input.turnId).triggerActor,
        now: () => input.now,
      });
    }
    const products = {
      getTurn,
      getAgentSession: (id: string) => {
        const row = readProduct(db.sqlite, owner, 'agent-session', id);
        if (!row) throw new ControlProductPreconditionError();
        return AgentSessionRecordSchema.parse(row.record);
      },
    };
    return runInterruptedWorkerRetryWorkspaceCommand({
      ...input,
      workspaceDb: db,
      authorityActor: getTurn(input.workspaceId, input.threadId, input.turnId).triggerActor,
      replayOnly: input.kind === 'retry-replay',
      now: () => input.now,
      resolveDecision: () => resolveInterruptedWorkerRetryWorkspaceDecision(products, db, input),
      store: {
        getTurn,
        getCommandRequest: (command, requestId, scope) =>
          getCommandRequestRecordFromDb(
            db,
            commandRequestKey(command, requestId, scope),
            new Date().toISOString()
          ),
        recordCommandRequest: (record) => {
          const receipt = {
            ...record,
            key: commandRequestKey(record.command, record.requestId, record.scope),
            createdAt: input.now,
            expiresAt: commandRequestExpiresAt(input.now),
          };
          recordCommandRequestRecordInDb(db, receipt);
          return receipt;
        },
      },
    });
  }
  if (input.kind === 'update')
    return updateWorkerCheckpoint(db, presentControlFacts({ ...input, now: () => input.now }));
  if (input.kind === 'upsert')
    return upsertWorkerCheckpoint(db, presentControlFacts({ ...input, now: () => input.now }));
  if (getWorkerCheckpoint(db, input.workspaceId, input.threadId, input.turnId))
    throw new ControlProductPreconditionError();
  if (input.goalTaskAdmission) {
    const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
    const getThread = (workspaceId: string, threadId: string) => {
      if (workspaceId !== db.workspaceId) throw new ControlProductPreconditionError();
      const row = readProduct(db.sqlite, owner, 'thread', threadId);
      if (!row) throw new ControlProductPreconditionError();
      return ThreadSchema.parse(row.record);
    };
    reserveGoalTask(
      {
        getThread,
        listThreads: (workspaceId: string) => {
          if (workspaceId !== db.workspaceId) throw new ControlProductPreconditionError();
          const ids = db.sqlite.prepare('SELECT id FROM control_threads ORDER BY id').all() as {
            id: string;
          }[];
          return ids.map(({ id }) => getThread(workspaceId, id));
        },
      },
      db,
      input.goalTaskAdmission,
      input.threadId
    );
  }
  recordWorkerTurnLaunchDecision(
    presentControlFacts({
      workspaceDb: db,
      ...input,
      now: new Date(input.now),
    })
  );
  return upsertWorkerCheckpoint(
    db,
    presentControlFacts({
      ...input,
      stage: 'preparing',
      iteration: 0,
      now: () => input.now,
    })
  );
}

/**
 * Derived authority decision for one interrupted-worker retry request.
 */
export interface InterruptedWorkerRetryDecision {
  /** Whether the exact existing owners permit retry, inspection, or no recovery action. */
  readonly status:
    | 'eligible'
    | 'inspect-only'
    | 'reconnect-pending'
    | 'stale'
    | 'recovery-required';
  /** Exact source checkpoint, or null when no checkpoint exists. */
  readonly checkpoint: WorkerCheckpointRecord | null;
}

/** Workspace product readers require no Items, file history or additional connection. */
export type WorkerRetryProductReader = {
  getTurn(
    workspaceId: string,
    threadId: string,
    turnId: string
  ): { readonly status: string; readonly agentSessionId?: string | null | undefined };
  getAgentSession(agentSessionId: string): {
    readonly workspaceId: string;
    readonly threadId: string | null;
    readonly status: string;
  };
};

/** Shares the original Workspace predicates; omitted Core checking never grants Main authority. */
export function resolveInterruptedWorkerRetryWorkspaceDecision(
  store: WorkerRetryProductReader,
  workspaceDb: WorkspaceDb,
  input: { readonly workspaceId: string; readonly threadId: string; readonly turnId: string },
  checkAttempt?: (
    agentSessionId: string
  ) => Exclude<InterruptedWorkerRetryDecision['status'], 'eligible' | 'inspect-only'> | null
): InterruptedWorkerRetryDecision {
  const checkpoint = getWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  if (!checkpoint) {
    return { status: 'recovery-required', checkpoint: null };
  }

  let turn: ReturnType<WorkerRetryProductReader['getTurn']>;
  try {
    turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
  } catch {
    return { status: 'recovery-required', checkpoint };
  }

  const agentSessionId = checkpoint.workerSessionId;
  if (!agentSessionId || turn.agentSessionId !== agentSessionId) {
    return { status: 'recovery-required', checkpoint };
  }

  let agentSession: ReturnType<WorkerRetryProductReader['getAgentSession']>;
  try {
    agentSession = store.getAgentSession(agentSessionId);
  } catch {
    return { status: 'recovery-required', checkpoint };
  }
  if (agentSession.workspaceId !== input.workspaceId || agentSession.threadId !== input.threadId) {
    return { status: 'recovery-required', checkpoint };
  }

  const coreStatus = checkAttempt?.(agentSessionId);
  if (coreStatus) return { status: coreStatus, checkpoint };

  if (
    (checkpoint.stage !== 'preparing' && checkpoint.stage !== 'running_worker') ||
    checkpoint.stopReason !== null ||
    turn.status !== 'interrupted' ||
    agentSession.status !== 'interrupted'
  ) {
    return { status: 'recovery-required', checkpoint };
  }

  return checkpoint.goalId === null && checkpoint.taskId === null
    ? { status: 'eligible', checkpoint }
    : { status: 'inspect-only', checkpoint };
}

/** Deletes only the same terminal record after the original asynchronous closeout checks complete. */
export function clearWorkerCheckpointIfUnchanged(
  db: WorkspaceDb,
  expected: WorkerCheckpointRecord
): boolean {
  return db.sqlite
    .transaction(() => {
      const current = getWorkerCheckpoint(
        db,
        expected.workspaceId,
        expected.threadId,
        expected.turnId
      );
      if (
        !current ||
        !isTerminalWorkerTurnStage(current.stage) ||
        !isDeepStrictEqual(current, expected)
      )
        return false;
      return clearWorkerCheckpoint(db, expected.workspaceId, expected.threadId, expected.turnId);
    })
    .immediate();
}

/** Original receipt-first Workspace body; Core eligibility remains a current Main preflight. */
export function runInterruptedWorkerRetryWorkspaceCommand(input: {
  readonly authorityActor: ActorRef;
  readonly requestId: string;
  readonly store: {
    getTurn(workspaceId: string, threadId: string, turnId: string): { readonly status: string };
    getCommandRequest(
      command: Parameters<typeof commandRequestKey>[0],
      requestId: string,
      scope: Parameters<typeof commandRequestKey>[2],
      db: WorkspaceDb
    ): ReturnType<typeof getCommandRequestRecordFromDb>;
    recordCommandRequest(
      record: Omit<
        Parameters<typeof recordCommandRequestRecordInDb>[1],
        'key' | 'createdAt' | 'expiresAt'
      >,
      db: WorkspaceDb
    ): unknown;
  };
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
  readonly resolveDecision: () => InterruptedWorkerRetryDecision;
  readonly replayOnly?: boolean;
  readonly now?: () => string;
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

    if (input.replayOnly)
      throw retryRecoveryRequired('Interrupted-worker retry receipt is unavailable.');
    const decision = input.resolveDecision();
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

    updateWorkerCheckpoint(input.workspaceDb, {
      authorityActor: input.authorityActor,
      diagnosticsSummary: 'Interrupted worker attempt released for a later fresh start.',
      stage: 'aborted',
      stopReason: 'aborted',
      ...(input.now ? { now: input.now } : {}),
      threadId: input.threadId,
      turnId: input.turnId,
      workspaceId: input.workspaceId,
    });

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
  store: {
    getTurn(workspaceId: string, threadId: string, turnId: string): { readonly status: string };
  },
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

/** Rechecks Workspace no-execution facts before the original final Main publication check and deletion. */
export function clearCancelledWorkerPreparation(
  db: WorkspaceDb,
  expected: WorkerCheckpointRecord,
  beforeClear?: () => boolean
): boolean {
  const checkpoint = getWorkerCheckpoint(
    db,
    expected.workspaceId,
    expected.threadId,
    expected.turnId
  );
  if (
    !checkpoint ||
    !isDeepStrictEqual(checkpoint, expected) ||
    checkpoint.stage !== 'preparing' ||
    checkpoint.workerSessionId !== null ||
    checkpoint.stopReason !== null
  )
    return false;
  const workspaceEffects = db.sqlite
    .prepare(`
      SELECT 1 FROM runtime_evidence WHERE turn_id = @turn
      UNION ALL SELECT 1 FROM evidence_bundles WHERE turn_id = @turn
      UNION ALL SELECT 1 FROM idempotency_requests WHERE response_id = @turn OR json_extract(response_json, '$.downstream.turnId') = @turn
      LIMIT 1`)
    .get({
      turn: checkpoint.turnId,
    });
  if (
    workspaceEffects ||
    listExportableAgentEnvironmentPackageSnapshots(db, expected.workspaceId).some(
      (snapshot) => snapshot.turnId === checkpoint.turnId
    )
  )
    return false;
  if (beforeClear && !beforeClear()) return false;
  return clearWorkerCheckpoint(db, expected.workspaceId, expected.threadId, expected.turnId);
}

/** Rechecks only mutable Workspace binding facts; Main retains exact current Core attempt authority. */
export function bindWorkerCheckpointSession(
  db: WorkspaceDb,
  input: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly requestId: string | null;
    readonly agentSessionId: string;
    readonly authorityActor: ActorRef;
    readonly now?: () => string;
  }
): boolean {
  const checkpoint = getWorkerCheckpoint(db, input.workspaceId, input.threadId, input.turnId);
  if (!checkpoint) return false;
  if (
    checkpoint.requestId !== input.requestId ||
    checkpoint.stopReason !== null ||
    !['preparing', 'running_worker'].includes(checkpoint.stage) ||
    (checkpoint.workerSessionId !== null && checkpoint.workerSessionId !== input.agentSessionId)
  )
    throw new TurnStartValidationError(
      'recovery_required',
      'Prepared session contradicts its exact checkpoint.',
      409
    );
  if (checkpoint.workerSessionId === input.agentSessionId && checkpoint.stage === 'running_worker')
    return true;
  updateWorkerCheckpoint(db, {
    authorityActor: input.authorityActor,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    stage: 'running_worker',
    workerSessionId: input.agentSessionId,
    ...(input.now ? { now: input.now } : {}),
  });
  return true;
}
