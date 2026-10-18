import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type ActorRef, allocateEntityId, SubmitTurnInputRequestSchema } from '@openkit/protocol';
import { z } from 'zod';
import { currentWorkerLineageWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { canDiscloseThreadToAudience, isThreadIdVisible } from '../auth/thread-visibility.js';
import type { AutomationStore } from '../lib/automation-store.js';
import type { SchedulerExecutionLineage } from '../scheduler-records.js';
import {
  type ExternalTriggerAdmission,
  findExternalTriggerAdmission,
  insertExternalTriggerAdmission,
} from '../storage/external-trigger-admissions.js';
import { readPublishedTurnFileRecords } from '../storage/workspace-file-records.js';
import {
  externalTriggerRecoveryRequired,
  inspectExternalTriggerAdmission,
  readExternalTriggerPollSource,
} from './external-trigger-source.js';
import { TurnStartValidationError } from './orchestrator.js';
import { startProductTurn } from './product-turn-start.js';
import { recurringCanonicalTurnPublicationIssue } from './recurring-turn-publication.js';

/** Authenticated package lineage; none of these fields may come from model arguments. */
export interface ExternalTriggerPollContext extends SchedulerExecutionLineage {
  readonly triggerActor: ActorRef;
}

/** Existing product admission dependencies plus the immutable authenticated poll context. */
export interface ExternalTriggerServiceInput
  extends Pick<
    Parameters<typeof startProductTurn>[0],
    | 'store'
    | 'snapshot'
    | 'turnExecutor'
    | 'providerCredentialResolver'
    | 'providerCredentialConfigured'
    | 'subscriptionAccounts'
    | 'workerPlacement'
  > {
  readonly schedules: AutomationStore;
  readonly source: ExternalTriggerPollContext;
  readonly eventKey: string;
  readonly input: string;
}

/** One retained event result. A duplicate retains its original input, source and execution outcome. */
export interface ExternalTriggerAdmissionResult
  extends ReturnType<typeof inspectExternalTriggerAdmission> {
  readonly admission: ExternalTriggerAdmission;
  readonly duplicate: boolean;
}

/** Admits one isolated Worker case from a live scheduled poll, without an event retry or repair lifecycle. */
export async function admitExternalTriggerEvent(
  input: ExternalTriggerServiceInput
): Promise<ExternalTriggerAdmissionResult> {
  const coreDb = input.schedules.coreDb;
  const release = input.schedules.mutationAdmission.enter(input.source.workspaceId);
  if (!release) throw denied();
  try {
    const eventKey = z.string().min(1).max(1024).safeParse(input.eventKey);
    const brief = SubmitTurnInputRequestSchema.shape.input.safeParse(input.input);
    if (!eventKey.success || !brief.success)
      throw new TurnStartValidationError('invalid_request', 'Invalid external event input.', 400);
    const schedule = validateSource();
    const duplicate = readAdmission(schedule.id, eventKey.data);
    if (duplicate) return result(duplicate, true);

    const threadId = allocateEntityId('th');
    const reservedTurnId = allocateEntityId('tu');
    input.store.createThread(
      schedule.workspaceId,
      brief.data.trim().split(/\r?\n/, 1)[0] || 'External event',
      threadId,
      'conversation',
      {
        visibility: 'workspace',
        threadSource: 'worker',
        parentThreadId: input.source.threadId,
      }
    );
    return await new Promise<ExternalTriggerAdmissionResult>((resolve, reject) => {
      let admission: ExternalTriggerAdmission | undefined;
      let signalled = false;
      void startProductTurn({
        coreDb,
        store: input.store,
        snapshot: input.snapshot,
        turnExecutor: input.turnExecutor,
        providerCredentialResolver: input.providerCredentialResolver,
        providerCredentialConfigured: input.providerCredentialConfigured,
        subscriptionAccounts: input.subscriptionAccounts,
        workerPlacement: input.workerPlacement,
        triggerActor: schedule.actor,
        reservedTurnId,
        workerStorageChoice: { kind: 'fresh', goalId: null, taskId: null },
        input: {
          workspaceId: schedule.workspaceId,
          threadId,
          requestId: randomUUID(),
          input: brief.data,
          ...(schedule.agentId ? { agentId: schedule.agentId } : {}),
          ...(schedule.profileId ? { profileId: schedule.profileId } : {}),
          ...(schedule.modelId ? { modelId: schedule.modelId } : {}),
        },
        onAdmissionCommitted: (entry) => {
          validateSource();
          admission = insertExternalTriggerAdmission(coreDb, {
            scheduleId: schedule.id,
            eventKey: eventKey.data,
            sourceTurnId: input.source.turnId,
            queueEntryId: entry.queueEntryId,
          });
          // A concurrent winner owns this key. Roll back the losing queue insertion.
          if (admission.queueEntryId !== entry.queueEntryId)
            throw externalTriggerRecoveryRequired();
        },
        onTurnCreated: () => {
          if (!admission) throw externalTriggerRecoveryRequired();
          const accepted = result(admission, false);
          signalled = true;
          resolve(accepted);
        },
      }).catch((error: unknown) => {
        if (signalled) return;
        // A committed join fences every publication failure. Only inspection may follow.
        try {
          const accepted = readAdmission(schedule.id, eventKey.data);
          if (accepted) resolve(result(accepted, true));
          else reject(error);
        } catch {
          reject(externalTriggerRecoveryRequired());
        }
      });
    });
  } finally {
    release();
  }

  /** Rechecks exact accepted poll lineage and current authority immediately before Core acceptance. */
  function validateSource() {
    try {
      const source = input.source;
      if (source.triggerActor.kind !== 'automation') throw denied();
      const schedule = input.schedules.getAutomation(source.triggerActor.id);
      const { occurrence, entry } = readExternalTriggerPollSource(coreDb, source.turnId);
      const dataRoot = input.store.getDataRoot();
      const turn = dataRoot
        ? (readPublishedTurnFileRecords(
            dataRoot,
            source.workspaceId,
            source.threadId,
            source.turnId
          )?.turn ?? null)
        : null;
      const session = input.store.getAgentSession(source.agentSessionId);
      if (
        schedule.status !== 'active' ||
        schedule.workspaceId !== source.workspaceId ||
        occurrence.scheduleId !== schedule.id ||
        occurrence.snapshot.threadId !== source.threadId ||
        !isDeepStrictEqual(schedule.actor, source.triggerActor) ||
        !isDeepStrictEqual(occurrence.snapshot.actor, source.triggerActor) ||
        recurringCanonicalTurnPublicationIssue(entry, turn) ||
        turn?.status !== 'running' ||
        turn.agentSessionId !== source.agentSessionId ||
        session.workspaceId !== source.workspaceId ||
        session.threadId !== source.threadId ||
        session.agentId !== turn.agentId ||
        session.status !== 'busy' ||
        input.store.getThread(source.workspaceId, source.threadId).visibility !== 'workspace' ||
        !canDiscloseThreadToAudience(
          input.store,
          input.store.getThread(source.workspaceId, source.threadId),
          null
        ) ||
        !isThreadIdVisible(
          input.store,
          source.workspaceId,
          source.threadId,
          schedule.responsibleUserId
        ) ||
        !currentWorkerLineageWorkspaceAuthority(coreDb, source, 'turn.run', true) ||
        !currentWorkerLineageWorkspaceAuthority(coreDb, source, 'runtime.launch', true)
      )
        throw denied();
      return schedule;
    } catch {
      throw denied();
    }
  }

  /** A malformed retained join is accepted-history damage, never permission to admit replacement work. */
  function readAdmission(scheduleId: string, eventKey: string) {
    try {
      return findExternalTriggerAdmission(coreDb, scheduleId, eventKey);
    } catch {
      throw externalTriggerRecoveryRequired();
    }
  }

  /** Returns only the retained tuple and canonical target history, with no publication or launch. */
  function result(
    admission: ExternalTriggerAdmission,
    duplicate: boolean
  ): ExternalTriggerAdmissionResult {
    return {
      admission,
      duplicate,
      ...inspectExternalTriggerAdmission(coreDb, input.store, admission),
    };
  }
}

/** Fixed authority refusal before any accepted event effect. */
function denied(): TurnStartValidationError {
  return new TurnStartValidationError(
    'external_event_denied',
    'Scheduled poll admission was denied.',
    403
  );
}
