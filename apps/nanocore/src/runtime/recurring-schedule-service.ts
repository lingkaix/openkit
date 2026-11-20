import { resolve } from 'node:path';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import type { AutomationStore } from '../lib/automation-store.js';
import { type FsStore, StoreRecordNotFoundError } from '../lib/store.js';
import {
  type CoreSchedulerQueueEntry,
  listQueuedSchedulerAdmissionEntries,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { admitCoreScheduler } from '../storage/control-store-admission.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import {
  findAcceptedRecurringOccurrenceForQueue,
  RecurringAdmissionPayloadSchema,
  type RecurringOccurrence,
  type RecurringPreparation,
} from '../storage/recurring-records.js';
import { PendingRequestCommandError } from './pending-request-error.js';
import {
  enterRecurringTurnPublication,
  recurringTurnPublicationIssue,
} from './recurring-turn-publication.js';

/** Dependencies restricted to bounded Core-local preparation and durable queue acceptance. */
export interface RecurringScheduleServiceInput {
  /** Current persistent containment is read before scanning and again before native admission. */
  readonly agentWorkPaused?: () => boolean;
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
    if (input.agentWorkPaused?.()) return;
    await publishDeferredTurns();
    if (stopped || input.agentWorkPaused?.()) return;
    const candidates = await input.schedules.collectScanCandidates(now(), input.onError);
    for (const occurrence of candidates) {
      if (stopped || input.agentWorkPaused?.()) return;
      const release = getControlStoreWorkerClient().enterWorkspaceMutation(
        input.schedules.coreDb.dataRoot,
        occurrence.workspaceId
      );
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
        if (stopped || input.agentWorkPaused?.()) return;
        // Existing queue acceptance alone cannot authorize another initial publication attempt.
        const queueAlreadyAccepted = db.sqlite
          .prepare('SELECT 1 FROM scheduler_admission_entries WHERE request_id = ? LIMIT 1')
          .get(occurrence.requestId);
        const accepted = await input.schedules.commitAttempt(
          occurrence.id,
          occurrence.definitionRevision,
          preparation,
          () => (input.agentWorkPaused?.() ? undefined : validateCurrent(occurrence))
        );
        if (
          !queueAlreadyAccepted &&
          accepted?.state === 'admission-accepted' &&
          accepted.queueEntryId
        ) {
          await publishAcceptedTurn(requireSchedulerAdmissionEntry(db, accepted.queueEntryId));
        }
      } catch (error) {
        // Only committed outcomes count. An unexpected Core/preparation result is inspected
        // by its owner and is never converted to a claim that an external effect did not happen.
        input.onError?.(error);
      } finally {
        release();
      }
    }
    if (!stopped && !input.agentWorkPaused?.()) await input.prepareKnowledgeMaintenance?.(now());
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

  /** Selects at most the existing bounded queue's proved deferrals on each scan. */
  async function publishDeferredTurns(): Promise<void> {
    for (const entry of listQueuedSchedulerAdmissionEntries(db)) {
      if (stopped || input.agentWorkPaused?.()) return;
      try {
        const occurrence = findAcceptedRecurringOccurrenceForQueue(db, entry.queueEntryId);
        if (!occurrence?.publicationDeferred) continue;
        const release = getControlStoreWorkerClient().enterWorkspaceMutation(
          db.dataRoot,
          entry.workspaceId
        );
        if (!release) continue;
        try {
          await publishAcceptedTurn(entry, occurrence);
        } finally {
          release();
        }
      } catch (error) {
        input.onError?.(error);
      }
    }
  }

  /** Publishes only the accepted queue's reserved Turn. A definite busy refusal can defer it. */
  async function publishAcceptedTurn(
    entry: CoreSchedulerQueueEntry,
    deferred?: RecurringOccurrence
  ): Promise<void> {
    const release = enterRecurringTurnPublication(db.dataRoot, entry.queueEntryId);
    if (!release) return;
    try {
      if (requireSchedulerAdmissionEntry(db, entry.queueEntryId).status !== 'queued') return;
      if (!deferred) return await publishWorkspaceTurn(entry);
      if (deferredPublicationState(entry, deferred) !== 'ready') return;
      const consumed = await admitCoreScheduler(db, {
        mode: 'recurring-publication',
        queueEntryId: entry.queueEntryId,
        action: 'consume-busy',
      });
      if (consumed.kind !== 'occurrence' || !consumed.occurrence) return;
      const occurrence = consumed.occurrence;
      await input.schedules.withSchedulePublication(occurrence.scheduleId, async () => {
        const state = deferredPublicationState(entry, occurrence);
        if (state === 'busy') await deferAcceptedTurn(entry);
        if (state === 'ready') await publishWorkspaceTurn(entry);
      });
    } finally {
      release();
    }
  }

  /** Only a definite native rollback can grant or restore deferred publication proof. */
  async function publishWorkspaceTurn(entry: CoreSchedulerQueueEntry): Promise<void> {
    try {
      await input.store.createTurn(
        entry.workspaceId,
        entry.threadId,
        entry.turnInput,
        entry.triggerActor,
        null,
        {
          turnId: entry.turnId,
          status: 'pending',
          agentId: entry.requestedAgentId,
          admitThreadInNativeWriter: true,
          executorKind: 'worker',
          triggerSource: { kind: 'automation', summary: 'Recurring schedule admission.' },
          ...(entry.reasoningEffort !== undefined
            ? { reasoningEffort: entry.reasoningEffort }
            : {}),
        }
      );
    } catch (error) {
      if (
        !(error instanceof PendingRequestCommandError) ||
        error.code !== 'thread_busy' ||
        !(error.cause instanceof ControlStoreWorkerError) ||
        error.cause.commit !== 'not-committed' ||
        error.cause.domain?.operation !== 'products' ||
        error.cause.domain.code !== 'thread_busy'
      )
        throw error;
      await deferAcceptedTurn(entry);
    }
  }

  function deferAcceptedTurn(entry: CoreSchedulerQueueEntry) {
    return admitCoreScheduler(db, {
      mode: 'recurring-publication',
      queueEntryId: entry.queueEntryId,
      action: 'defer-busy',
    });
  }

  /** Rechecks the original schedule, authority and target before a deferred publication. */
  function deferredPublicationState(
    entry: CoreSchedulerQueueEntry,
    occurrence: RecurringOccurrence
  ): 'blocked' | 'busy' | 'ready' {
    if (stopped || input.agentWorkPaused?.() || validateCurrent(occurrence)) return 'blocked';
    const thread = input.store.getThreadSegmentHead(entry.workspaceId, entry.threadId);
    if (
      thread.status !== 'active' ||
      recurringTurnPublicationIssue(input.store, entry) !== 'turn_missing' ||
      requireSchedulerAdmissionEntry(db, entry.queueEntryId).status !== 'queued'
    )
      return 'blocked';
    return input.store.readThreadNavigationFacts(entry.workspaceId, thread.id).activeTurn
      ? 'busy'
      : 'ready';
  }

  /** Fresh exact actor, membership and target checks precede preparation and the Core commit. */
  function validateCurrent(occurrence: RecurringOccurrence): RecurringPreparation | undefined {
    const schedule = input.schedules.getAutomation(occurrence.scheduleId);
    if (
      schedule.status !== 'active' ||
      schedule.workspaceId !== occurrence.workspaceId ||
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
