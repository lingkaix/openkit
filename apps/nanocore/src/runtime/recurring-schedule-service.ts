import { resolve } from 'node:path';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import type { AutomationStore } from '../lib/automation-store.js';
import { type FsStore, StoreRecordNotFoundError } from '../lib/store.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  RecurringAdmissionPayloadSchema,
  type RecurringOccurrence,
  type RecurringPreparation,
} from '../storage/recurring-records.js';

/** Dependencies restricted to bounded Core-local preparation and durable queue acceptance. */
export interface RecurringScheduleServiceInput {
  readonly schedules: AutomationStore;
  readonly store: FsStore;
  /** Resolve or revalidate exact selections; never launch workers, call providers or mutate repositories. */
  readonly prepare: (occurrence: RecurringOccurrence) => Promise<RecurringPreparation>;
  /** Finite local KM admission after Worker candidates; detach Provider execution and retain visible outcomes through its Turn owner. */
  readonly prepareKnowledgeMaintenance?: (instant: string) => void | Promise<void>;
  readonly now?: () => string;
  readonly onError?: (error: unknown) => void;
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}
/** One serialized service; callback loss never changes the nominal cadence. */
export interface RecurringScheduleService {
  readonly runOnce: () => Promise<void>;
  readonly stop: () => void;
}
const owners = new Set<string>();

/** Starts the one five-second scan only after the caller has completed storage and scheduler recovery. */
export function startRecurringScheduleService(
  input: RecurringScheduleServiceInput
): RecurringScheduleService {
  const db = input.schedules.coreDb;
  const ownerKey = resolve(db.dataRoot);
  if (owners.has(ownerKey)) throw new Error('Recurring scanner already owns this Core connection.');
  owners.add(ownerKey);
  const now = input.now ?? (() => new Date().toISOString());
  let stopped = false;
  let running: Promise<void> | undefined;
  const scan = async () => {
    const candidates = input.schedules.collectScanCandidates(now());
    for (const occurrence of candidates) {
      if (stopped) return;
      const release = input.schedules.mutationAdmission.enter(occurrence.workspaceId);
      if (!release) continue;
      try {
        let preparation = validateCurrent(occurrence);
        if (!preparation) {
          try {
            preparation = await input.prepare(occurrence);
          } catch (error) {
            input.onError?.(error);
            preparation = { kind: 'recovery_required' };
          }
          if (
            (preparation.kind === 'ready' || preparation.kind === 'failure') &&
            preparation.payload
          ) {
            const payload = RecurringAdmissionPayloadSchema.safeParse(preparation.payload);
            preparation = payload.success
              ? { ...preparation, payload: payload.data }
              : { kind: 'failure', code: 'invalid_input' };
          }
        }
        if (stopped) return;
        // Existing queue acceptance can be reconciled, but cannot authorize another initial publication attempt.
        // The data-root scanner owner and synchronous Core commit keep this read and insertion in one local invocation.
        const queueAlreadyAccepted = db.sqlite
          .prepare('SELECT 1 FROM scheduler_admission_entries WHERE request_id = ? LIMIT 1')
          .get(occurrence.requestId);
        const accepted = input.schedules.commitAttempt(
          occurrence.id,
          occurrence.definitionRevision,
          preparation,
          () => validateCurrent(occurrence)
        );
        if (
          !queueAlreadyAccepted &&
          accepted?.state === 'admission-accepted' &&
          accepted.queueEntryId
        ) {
          // Attempt initial file publication once while this source admission holds the
          // Workspace fence. Acceptance stays terminal if publication is interrupted.
          const entry = requireSchedulerAdmissionEntry(db, accepted.queueEntryId);
          input.store.createTurn(
            entry.workspaceId,
            entry.threadId,
            entry.turnInput,
            entry.triggerActor,
            null,
            {
              turnId: entry.turnId,
              status: 'pending',
              agentId: entry.requestedAgentId,
              executorKind: 'worker',
              triggerSource: { kind: 'automation', summary: 'Recurring schedule admission.' },
              ...(entry.reasoningEffort !== undefined
                ? { reasoningEffort: entry.reasoningEffort }
                : {}),
            }
          );
        }
      } catch (error) {
        // Only committed outcomes count. An unexpected Core/preparation result is inspected
        // by its owner and is never converted to a claim that an external effect did not happen.
        input.onError?.(error);
      } finally {
        release();
      }
    }
    if (!stopped) await input.prepareKnowledgeMaintenance?.(now());
  };
  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = scan()
      .catch((error) => {
        input.onError?.(error);
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const timer = (input.setInterval ?? setInterval)(() => {
    void runOnce();
  }, 5000);
  void runOnce();
  return {
    runOnce,
    stop: () => {
      if (stopped) return;
      stopped = true;
      (
        input.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
      )(timer);
      // Retain ownership while an old scan is awaiting preparation; it cannot commit after stop.
      if (running) void running.finally(() => owners.delete(ownerKey));
      else owners.delete(ownerKey);
    },
  };

  /** Fresh exact actor, membership and target checks precede preparation and the Core commit. */
  function validateCurrent(occurrence: RecurringOccurrence): RecurringPreparation | undefined {
    const schedule = input.schedules.getAutomation(occurrence.scheduleId);
    if (
      schedule.status !== 'active' ||
      schedule.actor.id !== occurrence.snapshot.actor.id ||
      schedule.actor.responsibleUserId !== occurrence.snapshot.actor.responsibleUserId
    )
      return { kind: 'failure', code: 'identity_inactive' };
    if (
      !currentWorkspaceAuthority(
        db,
        occurrence.workspaceId,
        occurrence.snapshot.actor,
        'turn.run',
        true
      ) ||
      !currentWorkspaceAuthority(
        db,
        occurrence.workspaceId,
        occurrence.snapshot.actor,
        'runtime.launch',
        true
      )
    )
      return { kind: 'failure', code: 'authority_denied' };
    try {
      input.store.getWorkspace(occurrence.workspaceId);
    } catch (error) {
      if (error instanceof StoreRecordNotFoundError)
        return { kind: 'failure', code: 'workspace_missing' };
      throw error;
    }
    try {
      input.store.getThread(occurrence.workspaceId, occurrence.snapshot.threadId);
    } catch (error) {
      if (error instanceof StoreRecordNotFoundError)
        return { kind: 'failure', code: 'thread_missing' };
      throw error;
    }
    if (
      !isThreadIdVisible(
        input.store,
        occurrence.workspaceId,
        occurrence.snapshot.threadId,
        occurrence.snapshot.actor.responsibleUserId
      )
    )
      return { kind: 'failure', code: 'authority_denied' };
    return undefined;
  }
}
