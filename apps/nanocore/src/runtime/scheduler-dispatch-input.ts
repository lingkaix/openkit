import { sha256Hex } from '@openkit/protocol/digest';
import { assertScopeAdmitted } from '../bootstrap/readiness.js';
import type { FsStore } from '../lib/store.js';
import { StoreRecordNotFoundError } from '../lib/store-errors.js';
import { type CoreSchedulerQueueEntry, schedulerAdmissionInputHash } from '../scheduler-records.js';
import type { WorkInputRef } from '../storage/control-kernel-port.js';
import { type CoreDb, openAdmittedWorkspaceReadDb, type WorkspaceDb } from '../storage/db.js';
import {
  findWorkspaceQueueInputRef,
  readWorkspaceQueueInput,
} from '../storage/workspace-queue-inputs.js';
import { readScheduledRecurringQueueInput } from './recurring-queue-input.js';
import { readFrozenSchedulerInput } from './scheduler-dispatch-frozen-input.js';

/** The trigger for an outcome-only Worker Turn in the retained delivery protocol. */
export const PENDING_WORKER_TRIGGER_INPUT = 'Receive pending request outcomes.';

type WorkspaceQueueInputScope = {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
};

/** Reuses the caller's admitted reader only for this synchronous observation. */
function withSchedulerInputReader<Value>(
  dataRoot: string,
  workspaceId: string,
  borrowed: WorkspaceDb | undefined,
  read: (db: WorkspaceDb) => Value
): Value {
  if (borrowed) {
    assertScopeAdmitted(dataRoot, 'workspace', workspaceId);
    if (
      borrowed.dataRoot !== dataRoot ||
      borrowed.workspaceId !== workspaceId ||
      !borrowed.sqlite.open ||
      !borrowed.sqlite.readonly
    )
      throw new Error('Scheduler input requires its admitted Workspace reader.');
    return read(borrowed);
  }
  const db = openAdmittedWorkspaceReadDb(dataRoot, workspaceId);
  try {
    return read(db);
  } finally {
    db.sqlite.close();
  }
}

const pendingDeliveryStatements = new WeakMap<
  WorkspaceDb['sqlite'],
  ReturnType<WorkspaceDb['sqlite']['prepare']>
>();

/** Resolves a carried batch by its original Turn and holds if its retained delivery link needs recovery. */
export function readFrozenSchedulerInputForTurn(
  dataRoot: string,
  scope: WorkspaceQueueInputScope,
  borrowed?: WorkspaceDb
) {
  return withSchedulerInputReader(dataRoot, scope.workspaceId, borrowed, (db) => {
    const manifestRef = findWorkspaceQueueInputRef(
      dataRoot,
      scope,
      { inputId: scope.turnId, originalInvocationId: scope.turnId },
      db
    );
    if (manifestRef) return readFrozenSchedulerInput(dataRoot, scope, manifestRef, db);
    let pending = pendingDeliveryStatements.get(db.sqlite);
    if (!pending) {
      pending = db.sqlite.prepare(
        'SELECT 1 FROM pending_requests WHERE workspace_id = ? AND thread_id = ? AND delivery_turn_id = ? LIMIT 1'
      );
      pendingDeliveryStatements.set(db.sqlite, pending);
    }
    return pending.get(scope.workspaceId, scope.threadId, scope.turnId) ? null : [];
  });
}

/** Resolves the original start text and verifies every batch member before use. */
export function readScheduledAdmissionText(
  coreDb: CoreDb,
  entry: CoreSchedulerQueueEntry,
  borrowed?: WorkspaceDb
): string | null {
  try {
    if (schedulerAdmissionInputHash(entry) !== entry.inputHash) return null;
    return withSchedulerInputReader(coreDb.dataRoot, entry.workspaceId, borrowed, (db) => {
      if (entry.inputRef.inputId === entry.turnId)
        return readFrozenSchedulerInput(coreDb.dataRoot, entry, entry.inputRef, db)
          ? PENDING_WORKER_TRIGGER_INPUT
          : null;
      if (readFrozenSchedulerInputForTurn(coreDb.dataRoot, entry, db) === null) return null;
      const recurring = readScheduledRecurringQueueInput(coreDb, entry);
      if (recurring !== undefined) return recurring;
      const staged = readWorkspaceQueueInput(coreDb.dataRoot, entry, entry.inputRef, db);
      return staged?.originalInvocationId === (entry.requestId ?? entry.queueEntryId)
        ? staged.text
        : null;
    });
  } catch {
    return null;
  }
}

/** Reads exact input from its scoped Item owner. Storage faults propagate to the dispatch hold. */
export function readWorkspaceInputItem(
  store: Pick<FsStore, 'getThreadItem'>,
  scope: WorkspaceQueueInputScope,
  ref: WorkInputRef
) {
  if (ref.owner.kind !== 'workspace' || ref.owner.workspaceId !== scope.workspaceId) return null;
  try {
    const item = store.getThreadItem(scope.workspaceId, scope.threadId, ref.inputId);
    if (
      item.id !== ref.inputId ||
      item.turnId !== scope.turnId ||
      item.type !== 'user-message' ||
      item.status !== 'completed' ||
      sha256Hex(item.text) !== ref.digest
    )
      return null;
    return item;
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError) return null;
    throw error;
  }
}
