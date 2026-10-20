import type { WorkOwner } from '@openkit/protocol';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type {
  EndedExecutionStep,
  ExecutionInvocation,
  ExecutionJournalIntent,
  ExecutionJournalSettlement,
  ExecutionStepJournalReader,
} from './execution-step-journal.js';

/** Release-authored interpretation for the first existing administrative image-acquisition invocation. */
export const CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION = 'core-image-acquire/v1';

/**
 * Creates the declaration checkpoint's reader without SQL, effects, admission or timers.
 *
 * This temporary checkpoint lets the independent author bind exact types before implementation.
 * Its methods fail closed and are not behavioral RED or proof of persisted journal support.
 * Replace the placeholder when the schema and real regression are available, as tracked in
 * docs/changes/202610201240000000-core_execution_journal/plan.md.
 *
 * @param db Existing owning database; construction never opens or migrates a connection.
 * @param owner Existing authority selected by the caller, not inferred from a path or correlation id.
 * @returns The exact reader surface; no method currently reads or returns journal authority.
 * @throws When the first Core-only cut receives an unsupported scope.
 */
export function createExecutionStepJournalReader(
  db: CoreDb | WorkspaceDb,
  owner: WorkOwner
): ExecutionStepJournalReader {
  if (db.scope !== 'core' || owner.kind !== 'server') {
    throw new Error('Execution journal construction supports only Core Server scope.');
  }
  const unavailable = async (): Promise<never> => unavailableJournal();
  return {
    readExecution: unavailable,
    readInvocation: unavailable,
    readEndedSteps: unavailable,
    readLinkedInspections: unavailable,
  };
}

/**
 * Declares the intent primitive for an already-open owning control-store transaction.
 * The construction checkpoint writes nothing; replace it with the tested persisted transition.
 * @param _db Existing Core connection owned by the caller's synchronous transaction.
 * @param _input Exact initial root and intent, selected before any queue or external wait.
 * @returns The stored invocation with its original clock anchor and narrowed allowance.
 * @throws Always at the declaration checkpoint; never treat this error as behavioral RED.
 */
export function writeExecutionJournalIntent(
  _db: CoreDb,
  _input: ExecutionJournalIntent
): ExecutionInvocation {
  return unavailableJournal();
}

/**
 * Declares the conditional end primitive; its receipt belongs in the same owning transaction.
 * The construction checkpoint writes nothing; replace it with the tested persisted transition.
 * @param _db Existing Core connection owned by the caller's synchronous transaction.
 * @param _input Exact end and next local transition, conditional on the owning execution revision.
 * @returns The immutable ended step without emitting telemetry or changing physical fences.
 * @throws Always at the declaration checkpoint; never treat this error as behavioral RED.
 */
export function settleExecutionJournalStep(
  _db: CoreDb,
  _input: ExecutionJournalSettlement
): EndedExecutionStep {
  return unavailableJournal();
}

/** Refuses use of this temporary construction seam until the tracked persistence implementation replaces it. */
function unavailableJournal(): never {
  throw new Error('Execution journal persistence is not implemented.');
}
