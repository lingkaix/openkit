import { workspaceIdForOwner } from '@openkit/protocol';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { ControlExecutionAttemptCommand } from '../storage/execution-attempt-codecs.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import * as records from './execution-attempt-records.js';

export {
  EXECUTION_ATTEMPT_BUDGET_MS,
  isSchedulerExecutionBusyRefusal,
  listOpenSchedulerExecutionAttempts,
  listSchedulerExecutionAttemptsByTurnId,
  listSchedulerExecutionAttemptsForTurn,
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';

/** Posts an immutable tuple after Core open; explicit caller clocks stay outside the wire. */
async function publishAttempt(
  db: CoreDb,
  input: ControlExecutionAttemptCommand,
  clock?: () => string
) {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  if (clock && snapshot.kind !== 'observe') snapshot.observedAt = clock();
  return client.executionAttempt(database, snapshot);
}
/** Acquires the original admission and complete attempt atomically on the Core writer. */
export async function createSchedulerExecutionAttempt(
  db: CoreDb,
  input: Parameters<typeof records.createSchedulerExecutionAttempt>[1]
) {
  // Preserve the original JSON.stringify semantics before crossing the message boundary.
  return (await publishAttempt(
    db,
    {
      kind: 'create',
      queueEntryId: input.entry.queueEntryId,
      backendId: input.entry.backendId,
      preparationJson: JSON.stringify(input.preparationInput),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    },
    input.now
  ))!;
}

/** Commits the original bind-session tuple before its dependent effect or handoff. */
export async function bindSchedulerExecutionAttemptSession(
  db: CoreDb,
  input: Parameters<typeof records.bindSchedulerExecutionAttemptSession>[1]
) {
  return (await publishAttempt(
    db,
    { kind: 'bind-session', attemptId: input.attemptId, agentSessionId: input.agentSessionId },
    input.now
  ))!;
}

/** Commits the original finalize-input tuple before its dependent effect or handoff. */
export async function finalizeSchedulerExecutionAttemptInput(
  db: CoreDb,
  input: Parameters<typeof records.finalizeSchedulerExecutionAttemptInput>[1]
) {
  return (await publishAttempt(
    db,
    {
      kind: 'finalize-input',
      attemptId: input.attemptId,
      inputRef: input.inputRef,
      bindingRef: input.bindingRef,
    },
    input.now
  ))!;
}

/** Commits the original record-operation tuple before its dependent effect or handoff. */
export async function recordSchedulerExecutionOperation(
  db: CoreDb,
  input: Parameters<typeof records.recordSchedulerExecutionOperation>[1]
) {
  return (await publishAttempt(
    db,
    {
      kind: 'record-operation',
      attemptId: input.attemptId,
      operationId: input.operationId,
      submission: input.submission,
    },
    input.now
  ))!;
}

/** Commits the original closing tuple before its dependent effect or handoff. */
export async function markSchedulerExecutionAttemptClosing(
  db: CoreDb,
  input: Parameters<typeof records.markSchedulerExecutionAttemptClosing>[1]
) {
  return (await publishAttempt(
    db,
    {
      kind: 'closing',
      attemptId: input.attemptId,
      cause: input.cause,
      outcomeRef: input.outcomeRef,
    },
    input.now
  ))!;
}

/** Commits the original close-without-effects tuple before its dependent effect or handoff. */
export async function closeSchedulerExecutionAttemptWithoutEffects(
  db: CoreDb,
  input: Parameters<typeof records.closeSchedulerExecutionAttemptWithoutEffects>[1]
) {
  return (await publishAttempt(
    db,
    {
      kind: 'close-without-effects',
      attemptId: input.attemptId,
      noOutstandingEffects: input.noOutstandingEffects,
      cause: input.cause,
      requeue: input.requeue,
    },
    input.now
  ))!;
}

/** Commits the original close-with-fence tuple before its dependent effect or handoff. */
export async function closeSchedulerExecutionAttemptWithFence(
  db: CoreDb,
  input: Parameters<typeof records.closeSchedulerExecutionAttemptWithFence>[1]
) {
  return (await publishAttempt(
    db,
    {
      kind: 'close-with-fence',
      correlation: input.correlation,
      proof: input.proof,
      fenceRef: input.fenceRef,
    },
    input.now
  ))!;
}

/** Commits an exact backend observation without replacing definite acceptance with uncertainty. */
export async function acceptSchedulerExecutionObservation(
  db: CoreDb,
  input: Parameters<typeof records.acceptSchedulerExecutionObservation>[1]
) {
  // Credential receipts belong to their existing effect owner; this row consumes only correlation/outcome facts.
  const observation =
    input === null
      ? null
      : {
          attemptId: input.attemptId,
          backendId: input.backendId,
          bindingRef: input.bindingRef,
          inputRef: input.inputRef,
          operationId: input.operationId,
          disposition: input.disposition,
          execution: input.execution,
          fenceRef: input.fenceRef,
          outcomeRef: input.outcomeRef,
        };
  return publishAttempt(db, { kind: 'observe', observation });
}
/** Preserves the original per-attempt terminal closeouts and their separate durable acknowledgements. */
export async function markSchedulerAttemptForTerminalTurn(
  db: Parameters<typeof records.markSchedulerAttemptForTerminalTurn>[0],
  turn: Parameters<typeof records.markSchedulerAttemptForTerminalTurn>[1]
): Promise<void> {
  if (!db || !['completed', 'interrupted', 'cancelled', 'failed'].includes(turn.status)) return;
  for (const attempt of records.listSchedulerExecutionAttemptsForTurn(db, {
    workspaceId: workspaceIdForOwner(turn.owner),
    threadId: turn.threadId,
    turnId: turn.id,
  })) {
    if (attempt.phase === 'closed') continue;
    await markSchedulerExecutionAttemptClosing(db, {
      attemptId: attempt.attemptId,
      cause: `turn-${turn.status}`,
      outcomeRef: `turn:${turn.id}:${turn.status}`,
    });
  }
}

/** Acknowledges the deterministic backend's original final receipt before its separate attempt close. */
export async function recordSimulatorFinalStatus(
  db: CoreDb,
  input: Extract<ControlExecutionAttemptCommand, { kind: 'simulator-final' }>
) {
  await publishAttempt(db, input);
}

/** Commits exact native preparation before any dependent backend preparation. */
export async function bindNanoHostAttemptPreparation(
  db: CoreDb,
  input: Parameters<
    typeof import('./nanohost-attempt-records.js').bindNanoHostAttemptPreparation
  >[1]
): Promise<void> {
  const { now, ...facts } = input;
  await publishAttempt(db, { kind: 'native-preparation', ...facts }, now);
}

/** Revalidates the restored attempt on its physical owner before reconnect can be served. */
export async function armNanoHostAttemptReconnect(
  db: CoreDb,
  input: Parameters<typeof import('./nanohost-attempt-records.js').armNanoHostAttemptReconnect>[1]
): Promise<void> {
  const { now, ...facts } = input;
  await publishAttempt(db, { kind: 'native-reconnect-arm', ...facts }, now);
}

/** Preserves the original independent post-close inspection projection. */
export async function markNanoHostAttemptNeedsEvidence(
  db: CoreDb,
  attemptId: string
): Promise<void> {
  await publishAttempt(db, { kind: 'native-needs-evidence', attemptId });
}
