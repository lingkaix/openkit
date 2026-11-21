import {
  bindSchedulerExecutionAttemptSession,
  createSchedulerExecutionAttempt,
  finalizeSchedulerExecutionAttemptInput,
  recordSchedulerExecutionOperation,
} from '../runtime/execution-attempt-records.js';
import {
  type AdmittedNanoHostHarnessTurnLifecycle,
  acknowledgeNanoHostHarnessResult,
  type PreparedNanoHostHarnessOperation,
  type PrepareNanoHostHarnessOperationInput,
  prepareNanoHostHarnessOperation,
  queueNanoHostHarnessOperation,
} from '../runtime/nanohost-harness.js';
import type { CoreSchedulerQueueEntry } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import { readAdmittedTestNanoHost } from './admitted-nanohost.js';

/**
 * Records the Core-owned preparation tuple for tests below the dispatcher.
 * The caller supplies an already-authorized admission and establishes any Native evidence separately.
 * @param coreDb Database owning the exact admission and attempt.
 * @param input Explicit product correlation and optional already-submitted operation.
 * @returns The prepared or submitted attempt, with no fabricated backend acceptance.
 */
export function recordTestExecutionAttempt(
  coreDb: CoreDb,
  input: {
    readonly entry: CoreSchedulerQueueEntry;
    readonly attemptId: string;
    readonly agentSessionId: string;
    readonly inputRef: string;
    readonly bindingRef: string;
    /** Retained by callers that use the same fixture input to prepare Native placement. */
    readonly sessionCompatibilityKey?: string;
    readonly now: () => string;
    readonly operationId?: string;
  }
) {
  const attempt = createSchedulerExecutionAttempt(coreDb, {
    entry: input.entry,
    attemptId: input.attemptId,
    preparationInput: { admission: input.entry },
    now: input.now,
  });
  bindSchedulerExecutionAttemptSession(coreDb, {
    attemptId: attempt.attemptId,
    agentSessionId: input.agentSessionId,
    now: input.now,
  });
  const prepared = finalizeSchedulerExecutionAttemptInput(coreDb, {
    attemptId: attempt.attemptId,
    inputRef: input.inputRef,
    bindingRef: input.bindingRef,
    now: input.now,
  });
  return input.operationId
    ? recordSchedulerExecutionOperation(coreDb, {
        attemptId: attempt.attemptId,
        operationId: input.operationId,
        submission: true,
        now: input.now,
      })
    : prepared;
}

/**
 * Prepares and queues real Core Harness state for owner-module tests only.
 * This helper supplies no native delivery authority or Workspace consumer acknowledgement.
 * @param coreDb Actual Core owner used by the scenario.
 * @param input Explicit command input and, when inspected separately, its exact prior preparation.
 * @returns The real queue owner's exact sequence.
 */
export async function queueTestPreparedHarnessOperation(
  coreDb: CoreDb,
  input: PrepareNanoHostHarnessOperationInput & {
    readonly prepared?: PreparedNanoHostHarnessOperation;
  },
  admitted?: AdmittedNanoHostHarnessTurnLifecycle
): Promise<number> {
  const prepared = input.prepared ?? prepareNanoHostHarnessOperation(coreDb, input);
  return await queueNanoHostHarnessOperation(coreDb, { ...input, prepared }, admitted);
}

/**
 * Models only an external Workspace consumer in a Core Harness owner-module test.
 * The actual Core owner validates and retains this opaque external acknowledgement.
 * This double proves no Workspace transaction, native clock or physical delivery.
 * @param coreDb Actual Core owner containing the exact receiver result.
 * @param input Explicit fixture namespace, binding, result selector and observation time.
 */
export async function acknowledgeTestExternalWorkspaceConsumer(
  coreDb: CoreDb,
  input: {
    readonly harnessInstanceId: string;
    readonly harnessBindingRef: string;
    readonly workspaceId: string;
    readonly turnId: string;
    readonly timestamp: string;
  },
  admitted?: AdmittedNanoHostHarnessTurnLifecycle
): Promise<void> {
  const inspect = (sqlite: CoreDb['sqlite']) =>
    sqlite
      .prepare(
        'SELECT result_json AS bytes FROM harness_instance_records WHERE harness_instance_id = ?'
      )
      .get(input.harnessInstanceId) as { bytes: string } | undefined;
  const row = admitted ? readAdmittedTestNanoHost(coreDb, inspect) : inspect(coreDb.sqlite);
  if (!row?.bytes)
    throw new Error('External consumer double requires the original retained result.');
  const result = JSON.parse(row.bytes) as Parameters<
    typeof acknowledgeNanoHostHarnessResult
  >[1]['result'];
  await acknowledgeNanoHostHarnessResult(
    coreDb,
    {
      result,
      harnessBindingRef: input.harnessBindingRef,
      timestamp: input.timestamp,
      consumerReceipt: JSON.stringify({
        workspaceId: input.workspaceId,
        turnId: input.turnId,
        executionId: `external-consumer-double:${result.operationId}`,
        stepId: `external-consumer-double:${result.sequence}`,
      }),
    },
    admitted
  );
}
