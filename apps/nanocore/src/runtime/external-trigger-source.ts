import { isDeepStrictEqual } from 'node:util';
import type { TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import type { FsStore } from '../lib/store.js';
import {
  requireSchedulerAdmissionEntry,
  schedulerAdmissionInputHash,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import type { ExternalTriggerAdmission } from '../storage/external-trigger-admissions.js';
import { findAcceptedRecurringOccurrenceForQueue } from '../storage/recurring-records.js';
import { readPublishedTurnFileRecords } from '../storage/workspace-file-records.js';
import { TurnStartValidationError } from './orchestrator.js';

/** Reads the original source occurrence without creating or repairing accepted work. */
export function readExternalTriggerPollSource(coreDb: CoreDb, sourceTurnId: string) {
  const row = coreDb.sqlite
    .prepare(
      'SELECT queue_entry_id AS queueEntryId FROM scheduler_admission_entries WHERE turn_id = ?'
    )
    .get(sourceTurnId) as { queueEntryId: string } | undefined;
  if (!row) throw externalTriggerRecoveryRequired();
  const occurrence = findAcceptedRecurringOccurrenceForQueue(coreDb, row.queueEntryId);
  if (!occurrence || occurrence.turnId !== sourceTurnId) throw externalTriggerRecoveryRequired();
  return { occurrence, entry: requireSchedulerAdmissionEntry(coreDb, row.queueEntryId) };
}

/** Verifies retained event lineage against canonical history, independently of execution outcome or receipts. */
export function inspectExternalTriggerAdmission(
  coreDb: CoreDb,
  store: FsStore,
  admission: ExternalTriggerAdmission
) {
  try {
    const { occurrence, entry: sourceEntry } = readExternalTriggerPollSource(
      coreDb,
      admission.sourceTurnId
    );
    const entry = requireSchedulerAdmissionEntry(coreDb, admission.queueEntryId);
    const thread = store.getThread(entry.workspaceId, entry.threadId);
    const dataRoot = store.getDataRoot();
    const turn: z.infer<typeof TurnSchema> | null = dataRoot
      ? (readPublishedTurnFileRecords(dataRoot, entry.workspaceId, entry.threadId, entry.turnId)
          ?.turn ?? null)
      : null;
    if (!turn) throw externalTriggerRecoveryRequired();
    if (
      occurrence.scheduleId !== admission.scheduleId ||
      sourceEntry.workspaceId !== entry.workspaceId ||
      sourceEntry.threadId === entry.threadId ||
      thread.parentThreadId !== sourceEntry.threadId ||
      thread.visibility !== 'workspace' ||
      thread.threadSource !== 'worker' ||
      !isDeepStrictEqual(sourceEntry.triggerActor, entry.triggerActor) ||
      entry.triggerActor.kind !== 'automation' ||
      entry.triggerActor.id !== admission.scheduleId ||
      schedulerAdmissionInputHash(entry) !== entry.inputHash ||
      turn.id !== entry.turnId ||
      turn.workspaceId !== entry.workspaceId ||
      turn.threadId !== entry.threadId ||
      turn.agentId !== entry.requestedAgentId ||
      !isDeepStrictEqual(turn.triggerActor, entry.triggerActor) ||
      // Ordinary product admission retains only explicit effort; a manifest default remains on the Turn.
      (entry.reasoningEffort !== undefined && turn.reasoningEffort !== entry.reasoningEffort) ||
      (entry.status === 'queued' && (turn.status !== 'pending' || turn.agentSessionId))
    )
      throw externalTriggerRecoveryRequired();
    return { entry, turn };
  } catch {
    throw externalTriggerRecoveryRequired();
  }
}

/** Fences native mutations from a stale cache while duplicate reads retain canonical history. */
export function externalTriggerTurnPublicationComplete(
  coreDb: CoreDb,
  store: FsStore,
  admission: ExternalTriggerAdmission
): boolean {
  try {
    const { entry, turn } = inspectExternalTriggerAdmission(coreDb, store, admission);
    return isDeepStrictEqual(store.getTurn(entry.workspaceId, entry.threadId, entry.turnId), turn);
  } catch {
    return false;
  }
}

/** Fixed refusal for an incomplete or contradictory accepted tuple; never exposes storage details. */
export function externalTriggerRecoveryRequired(): TurnStartValidationError {
  return new TurnStartValidationError(
    'recovery_required',
    'Accepted external event work requires inspection.',
    409
  );
}
