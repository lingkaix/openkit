import { isDeepStrictEqual } from 'node:util';
import {
  currentSchedulerAdmissionWorkspaceAuthority,
  currentWorkerLineageWorkspaceAuthority,
  currentWorkspaceAuthority,
  isWorkspaceOperationAuthorized,
} from '../auth/operation-authorizer.js';
import { OperationError } from '../operation-error.js';
import { readExternalTriggerPollSource } from '../runtime/external-trigger-source.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
  retryDeniedSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { accessDenied } from '../workspace-sharing-operations.js';
import { presentControlFacts } from './control-store-input.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import { insertExternalTriggerAdmission } from './external-trigger-admissions.js';
import {
  applyNativeRecurringAttempt,
  findRecurringAutomationFromDb,
} from './recurring-attempt-native.js';
import {
  type ControlSchedulerAdmission,
  type ControlSchedulerAdmissionResult,
  ControlSchedulerAdmissionSchema,
} from './scheduler-admission-codecs.js';
/** Executes only the original Core admission tuple inside its covering native savepoint. */
export function applyControlSchedulerAdmission(
  db: CoreDb,
  raw: ControlSchedulerAdmission
): ControlSchedulerAdmissionResult {
  assertControlProductWriter(db.sqlite);
  const input = ControlSchedulerAdmissionSchema.parse(raw);
  if (input.mode === 'recurring-attempt')
    return { kind: 'occurrence', occurrence: applyNativeRecurringAttempt(db, input) };
  if (input.mode === 'create') {
    if (input.external) {
      const { source, scheduleId } = input.external;
      const schedule = findRecurringAutomationFromDb(db, scheduleId);
      const { occurrence } = readExternalTriggerPollSource(db, source.turnId);
      if (
        !schedule ||
        schedule.status !== 'active' ||
        schedule.workspaceId !== source.workspaceId ||
        occurrence.scheduleId !== scheduleId ||
        occurrence.snapshot.threadId !== source.threadId ||
        !isDeepStrictEqual(schedule.actor, source.triggerActor) ||
        !isDeepStrictEqual(occurrence.snapshot.actor, source.triggerActor) ||
        !isDeepStrictEqual(input.entry.triggerActor, source.triggerActor) ||
        input.entry.workspaceId !== source.workspaceId ||
        !currentWorkerLineageWorkspaceAuthority(db, source, 'turn.run', true) ||
        !currentWorkerLineageWorkspaceAuthority(db, source, 'runtime.launch', true)
      )
        throw new OperationError(
          'external_event_denied',
          'Scheduled poll admission was denied.',
          403
        );
    } else if (
      !currentSchedulerAdmissionWorkspaceAuthority(
        db,
        { ...input.entry, serverAdminTokenId: input.entry.serverAdminTokenId ?? null },
        'runtime.launch',
        true
      )
    )
      throw accessDenied();
    if (
      db.sqlite
        .prepare(
          "SELECT 1 FROM scheduler_admission_entries WHERE workspace_id = ? AND thread_id = ? AND turn_id <> ? AND status = 'queued' LIMIT 1"
        )
        .get(input.entry.workspaceId, input.entry.threadId, input.entry.turnId)
    )
      throw new OperationError('thread_busy', 'Thread already has a nonterminal Turn.', 409);
    const entry = createSchedulerAdmissionEntry(
      db,
      presentControlFacts({
        ...input.entry,
        ...(input.entry.timestamp ? { now: () => input.entry.timestamp! } : {}),
      })
    );
    if (!input.external) return { kind: 'queue', entry };
    const external = insertExternalTriggerAdmission(db, {
      scheduleId: input.external.scheduleId,
      eventKey: input.external.eventKey,
      sourceTurnId: input.external.source.turnId,
      queueEntryId: entry.queueEntryId,
    });
    if (external.queueEntryId !== entry.queueEntryId)
      throw new OperationError(
        'recovery_required',
        'Accepted external event work requires inspection.',
        409
      );
    return { kind: 'queue', entry, external };
  }
  if (
    (input.mode === 'retry' || input.mode === 'cancel') &&
    input.actor &&
    !('userId' in input.actor
      ? isWorkspaceOperationAuthorized(db, presentControlFacts(input.actor), input.workspaceId, {
          mutating: true,
          policyOperation: 'turn.run',
        })
      : input.lineage &&
        input.lineage.workspaceId === input.workspaceId &&
        currentWorkerLineageWorkspaceAuthority(
          db,
          { ...input.lineage, triggerActor: input.actor },
          'turn.run',
          true
        ) &&
        currentWorkspaceAuthority(db, input.workspaceId, input.actor, 'turn.run', true))
  )
    throw accessDenied();
  // Denial may come from the live policy owner; it grants no execution authority.
  const entry =
    input.mode === 'deny'
      ? denySchedulerAdmissionEntry(db, input)
      : input.mode === 'retry'
        ? retryDeniedSchedulerAdmissionEntry(db, input)
        : cancelSchedulerAdmissionEntry(db, input);
  return { kind: 'queue', entry };
}
