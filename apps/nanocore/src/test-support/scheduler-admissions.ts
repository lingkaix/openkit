import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { deriveEntityId } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import {
  bindSchedulerExecutionAttemptSession,
  createSchedulerExecutionAttempt,
} from '../runtime/execution-attempts.js';
import { stageSchedulerStartInput } from '../runtime/scheduler-input-staging.js';
import {
  type CoreSchedulerQueueEntry,
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

/**
 * Acquires and binds one successor's pre-submit attempt through the production Core attempt owner,
 * as dispatch does before it commits the prepared AgentSession. The returned package carries the
 * fresh AgentSession and Turn that production continuity passes into a replacement close.
 * @param coreDb Core owner of the successor's already-published admission.
 * @param entry Successor admission on the predecessor's Workspace and Thread.
 * @param predecessor Idle predecessor package whose environment the successor keeps.
 * @param ids Successor attempt and its fresh AgentSession.
 * @param options Optional attempt clock; it fixes the attempt's absolute startup allowance.
 */
export async function admitTestReplacementAttempt(
  coreDb: CoreDb,
  entry: CoreSchedulerQueueEntry,
  predecessor: AgentEnvironmentPackage,
  ids: { readonly attemptId: string; readonly agentSessionId: string },
  options: { readonly now?: () => string } = {}
) {
  if (
    entry.workspaceId !== predecessor.scope.workspaceId ||
    entry.threadId !== predecessor.scope.threadId
  )
    throw new Error('A replacement request names only its own Workspace and Thread.');
  await createSchedulerExecutionAttempt(coreDb, {
    entry,
    attemptId: ids.attemptId,
    preparationInput: { admission: entry },
    ...(options.now ? { now: options.now } : {}),
  });
  await bindSchedulerExecutionAttemptSession(coreDb, ids);
  return {
    ...ids,
    environmentPackage: {
      ...predecessor,
      snapshotId: `aepsnap_${entry.turnId}_${ids.agentSessionId}`,
      scope: {
        ...predecessor.scope,
        agentSessionId: ids.agentSessionId,
        turnId: entry.turnId,
        requestId: entry.requestId,
      },
    } as AgentEnvironmentPackage,
  };
}
