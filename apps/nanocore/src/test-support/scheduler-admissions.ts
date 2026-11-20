import { deriveEntityId } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { stageSchedulerStartInput } from '../runtime/scheduler-input-staging.js';
import {
  type CreateSchedulerAdmissionEntryInput,
  createSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import type { WorkInputRef } from '../storage/control-kernel-port.js';
import type { CoreDb } from '../storage/db.js';

/** Names an expected input in Core-only queue metadata tests. */
export function schedulerFixtureInput(
  workspaceId: string,
  turnId: string,
  text: string
): WorkInputRef {
  return {
    owner: { kind: 'workspace', workspaceId },
    inputId: deriveEntityId('it', ['task-user', turnId]),
    digest: sha256Hex(text),
  };
}

/** Commits the exact bytes through the Workspace owner before inserting the fixture queue row. */
export async function createTestQueueEntry(
  coreDb: CoreDb,
  { text, ...draft }: Omit<CreateSchedulerAdmissionEntryInput, 'inputRef'> & { text: string }
) {
  const inputRef = await stageSchedulerStartInput(
    coreDb.dataRoot,
    draft,
    draft.requestId ?? draft.queueEntryId,
    text
  );
  return createSchedulerAdmissionEntry(coreDb, { ...draft, inputRef });
}
