import {
  ActorRefSchema,
  StopReasonSchema,
  ThreadIdSchema,
  ThreadSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
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
} from '../runtime/worker-checkpoints.js';
import { WORKER_TURN_STAGES } from '../runtime/worker-stage.js';
import { presentControlFacts } from './control-store-input.js';
import { ControlProductPreconditionError, readProduct } from './control-store-products.js';
import type { WorkspaceDb } from './db.js';

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
  z.object({ kind: z.literal('clear'), ...scope }).strict(),
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
  checkpoint.required().extend({
    checkpointId: z.string().min(1),
    replayInstruction: z.literal(false),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  }),
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
  if (input.kind === 'clear')
    return clearWorkerCheckpoint(db, input.workspaceId, input.threadId, input.turnId);
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
