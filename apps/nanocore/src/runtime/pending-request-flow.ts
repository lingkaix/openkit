import { type Item, isSealedTurnTerminal } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import {
  authorizeWorkspace,
  currentWorkspaceAuthority,
  isCurrentDeploymentAdministrator,
} from '../auth/operation-authorizer.js';
import type { FsStore } from '../lib/store.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION } from '../lib/store.js';
import { readCommandRequestRecordsFromSqlite } from '../storage/command-request-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { TurnStartValidationError } from './orchestrator.js';
import { projectApprovalEffect } from './pending-request-disclosure.js';
import {
  answerPendingRequest,
  applyPendingCloseout,
  claimOrRefuseGrant,
  deletePendingRequest,
  denyPendingRequest,
  executorKindForTurn,
  finishPendingExecution,
  freezeReadyOutcomes,
  grantCommandIntentRequest,
  invalidatePendingRequest,
  isBlockingPendingRequest,
  isCommandIntentApproval,
  isFinalOutcome,
  isReadyOutcome,
  listThreadPendingRequests,
  markFrozenDeliveryUnknown,
  type PendingExecutorKind,
  type PendingRequestActor,
  PendingRequestCommandError,
  type PendingRequestRecord,
  pendingRequestItemId,
  projectApprovalRequest,
  proveFrozenDelivery,
  type RaisePendingRequestInput,
  raisePendingRequest,
  readPendingRequest,
  releaseFrozenOutcomes,
  settleUnfinishedClaims,
  validateCanonicalLoad,
  withdrawPendingRequest,
} from './pending-requests.js';
import { recordTaskTerminalFact } from './task-terminal-fact.js';

/** Opens the Workspace database that owns pending-request rows. */
export interface PendingRequestDatabase {
  /** Opens one Workspace database. The caller closes it. */
  openWorkspace(workspaceId: string): WorkspaceDb;
}

/** Optional native submission for an outcome-initiated worker Turn. */
export interface PendingWorkerDelivery {
  /**
   * Submits one outcome Turn. Resolve means native submission. TurnStartValidationError is a refusal before submission.
   *
   * @param store Store that owns the Turn.
   * @param turnId Outcome Turn.
   */
  startTurn(store: FsStore, turnId: string): Promise<void>;
}

/** Dependencies for admission and boot. */
export interface PendingAdmissionDependencies extends PendingRequestDatabase {
  /** Core authority used while re-evaluating a grant. */
  coreDb?: CoreDb;
  /** Current configured Agent authority, independent of historical Turns. */
  agentAuthority?: (record: PendingRequestRecord) => boolean;
  /** Owning command source may recheck its requester without an AgentSession. */
  requesterAuthority?: (record: PendingRequestRecord) => boolean | undefined;
  /** Effect owner synchronously checks a captured command before a human grant is recorded. */
  checkCommandIntent?: (
    sqlite: import('better-sqlite3').Database,
    record: PendingRequestRecord,
    actor: Actor
  ) => void;
  /** Same-commit source bookkeeping for a captured command decision. */
  requestCommitted?: (
    sqlite: import('better-sqlite3').Database,
    record: PendingRequestRecord
  ) => void;
  /** Worker submission. Absent at boot, where the Turn waits pending. */
  workerDelivery?: PendingWorkerDelivery;
  /** Chat Mode service acceptance; proof belongs to that service. */
  assistantDelivery?: PendingWorkerDelivery;
  /** Goal owner accepts Coordinator outcome input without scheduler capacity. */
  coordinatorDelivery?: PendingWorkerDelivery;
  /** Goal owner considers marker admission after the ordinary terminal barrier. */
  goalTerminal?: (turn: ReturnType<FsStore['getTurnById']>) => void;
}

const refusedOutcomeTurns = new Set<string>();
const outcomeCauses = new Map<string, 'outcome'>();

/**
 * Installs freeze-on-admission and terminal-barrier admission for one store.
 *
 * @param store Product store.
 * @param dependencies Workspace opener and optional worker submission.
 */
export function installPendingRequestAdmission(
  store: FsStore,
  dependencies: PendingAdmissionDependencies
): void {
  store.setTurnAdmissionHooks({
    onTerminalFact: (turn) => {
      const db = dependencies.openWorkspace(turn.workspaceId);
      try {
        recordTaskTerminalFact(db, turn);
      } finally {
        db.sqlite.close();
      }
    },
    onAdmitted(turn) {
      const executor = store.getTurnExecutor(turn.id) ?? executorKindForTurn(turn);
      if (!executor) return;
      const now = new Date().toISOString();
      withWorkspace(dependencies, turn.workspaceId, (sqlite) => {
        const frozen = freezeReadyOutcomes(sqlite, {
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId: turn.id,
          executor,
          agentId: turn.agentId ?? null,
          cause: outcomeCauses.get(turn.id) ?? 'carried',
          usable: (record) => canonicalRecordIsUsable(store, sqlite, record),
          now,
        });
        publishOutcomeItems(store, frozen, turn.id, now);
      });
    },
    onTerminal(turn) {
      if (refusedOutcomeTurns.has(turn.id)) return;
      if (store.getThread(turn.workspaceId, turn.threadId).status === 'archived') return;
      admitNextOutcome(store, dependencies, turn.workspaceId, turn.threadId);
      dependencies.goalTerminal?.(turn);
    },
  });
  if (dependencies.workerDelivery) {
    const pendingTurns = new Set<string>();
    let workspaces: ReturnType<FsStore['listWorkspaces']>;
    try {
      workspaces = store.listWorkspaces();
    } catch {
      return;
    }
    for (const workspace of workspaces) {
      withWorkspace(dependencies, workspace.id, (sqlite) => {
        for (const thread of store.listThreads(workspace.id)) {
          if (thread.status === 'archived') continue;
          for (const record of listThreadPendingRequests(sqlite, workspace.id, thread.id))
            if (
              record.requesterKind === 'worker' &&
              record.delivery === 'frozen' &&
              record.deliveryTurnId &&
              canonicalRecordIsUsable(store, sqlite, record) &&
              store.getTurnById(record.deliveryTurnId).status === 'pending'
            )
              pendingTurns.add(record.deliveryTurnId);
        }
      });
    }
    for (const turnId of pendingTurns) void deliverWorkerOutcome(store, dependencies, turnId);
  }
}

/**
 * Settles unfinished claims, finishes named publications, and admits waiting outcomes after scheduler fencing.
 *
 * @param store Boot store.
 * @param dependencies Workspace opener.
 */
export function recoverPendingRequestsAtBoot(
  store: FsStore,
  dependencies: PendingAdmissionDependencies
): void {
  const now = new Date().toISOString();
  for (const workspace of store.listWorkspaces()) {
    withWorkspace(dependencies, workspace.id, (sqlite) => {
      settleUnfinishedClaims(sqlite, now, (record) =>
        canonicalRecordIsUsable(store, sqlite, record)
      );
      const records = sqlite
        .prepare(
          `SELECT request_id FROM pending_requests WHERE workspace_id = ? AND (publication_turn_id IS NOT NULL OR invalidation_turn_id IS NOT NULL)`
        )
        .all(workspace.id) as Array<{ request_id: string }>;
      const loaded = records
        .flatMap((row) => {
          try {
            const record = readPendingRequest(sqlite, row.request_id);
            return record && canonicalRecordIsUsable(store, sqlite, record) ? [record] : [];
          } catch {
            return [];
          }
        })
        .filter((record): record is PendingRequestRecord => record !== null);
      // Write every missing Item before completing any shared Core-local publication.
      const localPublications = new Set<string>();
      for (const record of loaded) {
        if (record.publicationTurnId) {
          publishOutcomeItems(store, [record], record.publicationTurnId, now, true);
          const publication = store.getTurnById(record.publicationTurnId);
          if (!publication.agentId && !publication.agentSessionId)
            localPublications.add(publication.id);
        }
        if (
          record.delivery === 'frozen' &&
          record.deliveryTurnId &&
          record.requesterKind !== 'person' &&
          store.getTurnById(record.deliveryTurnId).status !== 'pending'
        )
          markFrozenDeliveryUnknown(sqlite, record.deliveryTurnId, now);
        if (record.invalidationTurnId && record.invalidationTurnId !== record.publicationTurnId) {
          publishInvalidationItem(store, record, record.invalidationTurnId, now, true);
          localPublications.add(record.invalidationTurnId);
        }
      }
      for (const turnId of localPublications) {
        const publication = store.getTurnById(turnId);
        if (!isSealedTurnTerminal(publication.status)) {
          store.updateTurn(turnId, { status: 'completed', completedAt: now });
        }
        // A completed Core-local publication is the person's delivery proof, including a restart after completion but before SQLite proof.
        if (store.getTurnById(turnId).status === 'completed')
          proveFrozenDelivery(sqlite, turnId, now);
      }
    });
    for (const thread of store.listThreads(workspace.id)) {
      if (thread.status === 'archived') continue;
      const busy = store
        .listThreadTurns(workspace.id, thread.id)
        .some((turn) => !isSealedTurnTerminal(turn.status));
      if (!busy) admitNextOutcome(store, dependencies, workspace.id, thread.id);
    }
  }
}

/**
 * Raises one approval or user-input request and its request Item. A duplicate returns the existing request.
 *
 * @param store Product store.
 * @param sqlite Workspace database.
 * @param input Raise input without the item id when the caller wants the derived id.
 * @returns Raised record.
 */
export function raiseRecordedPendingRequest(
  store: FsStore,
  sqlite: import('better-sqlite3').Database,
  input: RaisePendingRequestInput
): PendingRequestRecord {
  const raised = raisePendingRequest(sqlite, input);
  if (!raised.created) return raised.record;
  try {
    const approval = projectApprovalRequest(raised.record);
    if (approval) {
      try {
        store.getApproval(approval.id);
      } catch {
        store.createApproval(approval);
      }
    }
  } catch (error) {
    deletePendingRequest(sqlite, raised.record.requestId);
    throw error;
  }
  return raised.record;
}

/** Pending tool fields shared by structured and text content. */
export function pendingToolFields(
  status: 'pending-approval' | 'pending-input',
  requestId: string
): { status: 'pending-approval' | 'pending-input'; requestId: string; nextStep: string } {
  return {
    status,
    requestId,
    nextStep: 'The outcome arrives on a later Turn. Do not call again to claim it.',
  };
}

/**
 * Projects one pending tool result. Approval results are errors because the tool did not execute.
 *
 * @param status Pending status.
 * @param requestId Request id.
 * @returns MCP tool result.
 */
export function pendingToolResult(status: 'pending-approval' | 'pending-input', requestId: string) {
  const fields = pendingToolFields(status, requestId);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(fields) }],
    structuredContent: fields,
    isError: status === 'pending-approval',
  };
}

/**
 * Answers one pending user-input request. Secret questions and conflicts fail before a record write.
 *
 * @param store Product store.
 * @param sqlite Workspace database.
 * @param input Answer command.
 * @param actorId Responsible user.
 * @param coreDb Core authority.
 * @param requestActor Authenticating actor.
 * @returns Updated record.
 */
export function answerRecordedUserInput(
  store: FsStore,
  sqlite: import('better-sqlite3').Database,
  input: {
    readonly requestId: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly answers: Readonly<Record<string, readonly [string]>>;
  },
  actorId: string,
  coreDb: CoreDb | undefined,
  requestActor: Actor | undefined,
  dependencies: PendingAdmissionDependencies
): PendingRequestRecord {
  const current = requireUsableRecord(
    store,
    sqlite,
    input.requestId,
    input.workspaceId,
    input.threadId
  );
  assertAnswerShape(current, input.answers);
  assertResponsibleActor(store, current, actorId, coreDb, requestActor);
  if (current.state !== 'pending') {
    throw conflictOrNotPending(current, input.answers);
  }
  const answered = answerPendingRequest(
    sqlite,
    current.requestId,
    { kind: 'user', id: actorId },
    input.answers,
    new Date().toISOString(),
    requestActor ?? { kind: 'local', userId: actorId }
  );
  if (!answered) {
    const latest = readPendingRequest(sqlite, current.requestId);
    if (!latest) {
      throw new PendingRequestCommandError(
        'recovery_required',
        'The pending request is missing.',
        409
      );
    }
    throw conflictOrNotPending(latest, input.answers);
  }
  admitIfIdle(store, dependencies, input.workspaceId, input.threadId);
  return answered;
}

/** Resolves a captured command through the shared disclosure and current resolver authority. */
export function resolveCommandIntentApproval(input: {
  readonly store: FsStore;
  readonly sqlite: import('better-sqlite3').Database;
  readonly record: PendingRequestRecord;
  readonly decision: 'granted' | 'denied';
  readonly actor: Actor;
  readonly coreDb: CoreDb | undefined;
  readonly checkCommandIntent?: PendingAdmissionDependencies['checkCommandIntent'];
}): PendingRequestRecord {
  const current = requireUsableRecord(
    input.store,
    input.sqlite,
    input.record.requestId,
    input.record.workspaceId,
    input.record.threadId
  );
  if (!isCommandIntentApproval(current))
    throw new PendingRequestCommandError('invalid_request', 'Not a command-intent approval.', 400);
  assertResponsibleActor(input.store, current, input.actor.userId, input.coreDb, input.actor);
  if (current.state !== 'pending')
    throw new PendingRequestCommandError(
      'request_not_pending',
      'The request is no longer pending.',
      409
    );
  if (
    projectApprovalEffect({
      record: current,
      store: input.store,
      coreDb: input.coreDb,
      actor: input.actor,
    }).status !== 'available'
  )
    throw new PendingRequestCommandError(
      'approval_preview_unavailable',
      'Exact effect unavailable; approval disabled',
      409
    );
  if (input.decision === 'granted') input.checkCommandIntent?.(input.sqlite, current, input.actor);
  const actor = { kind: 'user' as const, id: input.actor.userId };
  const now = new Date().toISOString();
  const record =
    input.decision === 'granted'
      ? grantCommandIntentRequest(input.sqlite, current.requestId, actor, now, input.actor)
      : denyPendingRequest(input.sqlite, current.requestId, actor, now, input.actor);
  if (!record)
    throw new PendingRequestCommandError(
      'request_not_pending',
      'The request is no longer pending.',
      409
    );
  syncApproval(input.store, record);
  return record;
}

/**
 * Denies or grants one approval. An agent grant re-evaluates, claims, and executes inside the command.
 *
 * @param input Grant command.
 * @returns Approval projection after the disposition is recorded.
 */
export async function respondRecordedApproval(input: {
  readonly store: FsStore;
  readonly sqlite: import('better-sqlite3').Database;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly approvalRequestId: string;
  readonly decision: 'granted' | 'denied';
  readonly actorId: string;
  readonly coreDb: CoreDb | undefined;
  readonly requestActor: Actor | undefined;
  readonly dependencies: PendingAdmissionDependencies;
  readonly prepare?: () => Promise<void>;
  readonly admitExecution?: () => void;
  readonly execute?: (record: PendingRequestRecord) => Promise<{
    readonly disposition: 'approved-executed' | 'execution-error' | 'outcome-unknown';
    readonly reason: string | null;
    readonly result: unknown;
  }>;
  readonly evaluate?: () => {
    readonly membership?: boolean;
    readonly agentAuthority?: boolean;
    readonly toolInSupply: boolean;
    readonly schemaCurrent: boolean;
    readonly policyAllows: boolean;
    readonly credentialsValid: boolean;
  };
}): Promise<PendingRequestRecord> {
  const current = requireUsableRecord(
    input.store,
    input.sqlite,
    input.approvalRequestId,
    input.workspaceId,
    input.threadId
  );
  if (current.kind !== 'approval') {
    throw new PendingRequestCommandError('invalid_request', 'The request is not an approval.', 400);
  }
  assertResponsibleActor(input.store, current, input.actorId, input.coreDb, input.requestActor);
  if (current.claim === 'claimed' && current.disposition === null) {
    throw new PendingRequestCommandError(
      'recovery_required',
      'The grant was claimed and its execution was not recorded.',
      409
    );
  }
  if (current.state !== 'pending') {
    if (input.decision === 'granted' && current.resolution === 'granted') {
      throw new PendingRequestCommandError(
        'request_not_pending',
        `The request is already ${current.state}.`,
        409
      );
    }
    if (input.decision === 'denied' && current.resolution === 'denied') {
      throw new PendingRequestCommandError(
        'request_not_pending',
        `The request is already ${current.state}.`,
        409
      );
    }
    throw new PendingRequestCommandError(
      current.resolution &&
        ((input.decision === 'granted' && current.resolution !== 'granted') ||
          (input.decision === 'denied' && current.resolution !== 'denied'))
        ? 'idempotency_key_conflict'
        : 'request_not_pending',
      current.resolution
        ? 'The approval already has a different decision.'
        : `The request is already ${current.state}.`,
      409
    );
  }
  const actor: PendingRequestActor = { kind: 'user', id: input.actorId };
  const now = new Date().toISOString();
  if (isCommandIntentApproval(current)) {
    const record = input.sqlite.transaction(() => {
      const resolved = resolveCommandIntentApproval({
        store: input.store,
        sqlite: input.sqlite,
        record: current,
        decision: input.decision,
        actor: input.requestActor ?? { kind: 'local', userId: input.actorId },
        coreDb: input.coreDb,
        ...(input.dependencies.checkCommandIntent
          ? { checkCommandIntent: input.dependencies.checkCommandIntent }
          : {}),
      });
      input.dependencies.requestCommitted?.(input.sqlite, resolved);
      return resolved;
    })();
    admitIfIdle(input.store, input.dependencies, input.workspaceId, input.threadId);
    return record;
  }
  if (input.decision === 'denied') {
    const denied = denyPendingRequest(
      input.sqlite,
      current.requestId,
      actor,
      now,
      input.requestActor ?? { kind: 'local', userId: input.actorId }
    );
    if (!denied) {
      throw new PendingRequestCommandError(
        'request_not_pending',
        'The request is no longer pending.',
        409
      );
    }
    syncApproval(input.store, denied);
    admitIfIdle(input.store, input.dependencies, input.workspaceId, input.threadId);
    return denied;
  }
  const assertDisclosure = () => {
    if (
      projectApprovalEffect({
        record: current,
        store: input.store,
        coreDb: input.coreDb,
        actor: input.requestActor ?? { kind: 'local', userId: input.actorId },
      }).status !== 'available'
    ) {
      throw new PendingRequestCommandError(
        'approval_preview_unavailable',
        'Exact effect unavailable; approval disabled',
        409
      );
    }
  };
  // Refuse unavailable presentation before preparation can resolve credentials or contact an upstream.
  assertDisclosure();
  await input.prepare?.();
  const step = claimOrRefuseGrant(
    input.sqlite,
    current.requestId,
    actor,
    new Date().toISOString(),
    () => {
      const supplied = input.evaluate?.();
      const facts = {
        membership:
          supplied?.membership ??
          authorityAllows(input.coreDb, input.store, current, input.requestActor),
        agentAuthority:
          supplied?.agentAuthority ??
          (current.agentId === null || agentStillKnown(input.store, current)),
        toolInSupply: supplied?.toolInSupply ?? true,
        schemaCurrent: supplied?.schemaCurrent ?? true,
        policyAllows: supplied?.policyAllows ?? true,
        credentialsValid: supplied?.credentialsValid ?? true,
      };
      if (!facts.membership) {
        return { outcome: 'end', event: 'membership-revoked', actor };
      }
      if (!facts.agentAuthority) {
        return { outcome: 'end', event: 'agent-authority-revoked', actor };
      }
      if (input.store.getThread(current.workspaceId, current.threadId).status === 'archived') {
        return { outcome: 'end', event: 'thread-archived', actor };
      }
      assertDisclosure();
      if (!facts.toolInSupply) return { outcome: 'refuse', reason: 'tool-left-supply' };
      if (!facts.schemaCurrent) return { outcome: 'refuse', reason: 'schema-changed' };
      if (!facts.policyAllows) return { outcome: 'refuse', reason: 'policy-changed' };
      if (!facts.credentialsValid) return { outcome: 'refuse', reason: 'credential-changed' };
      input.admitExecution?.();
      return { outcome: 'claim' };
    },
    input.requestActor ?? { kind: 'local', userId: input.actorId }
  );
  let record = step.record;
  if (step.applied === 'claimed') {
    let disposition: 'approved-executed' | 'execution-error' | 'outcome-unknown' =
      'outcome-unknown';
    let reason: string | null = 'executor-unavailable';
    let result: unknown = null;
    if (input.execute) {
      try {
        const executed = await input.execute(record);
        disposition = executed.disposition;
        reason = executed.reason;
        result = executed.result;
      } catch {
        disposition = 'outcome-unknown';
        reason = 'execution-unproven';
      }
    }
    record =
      finishPendingExecution(input.sqlite, record.requestId, disposition, reason, result, now) ??
      record;
  }
  if (step.applied === 'lost' && record.claim === 'claimed' && record.disposition === null) {
    throw new PendingRequestCommandError(
      'recovery_required',
      'The grant was claimed and its execution was not recorded.',
      409
    );
  }
  syncApproval(input.store, record);
  if (step.applied !== 'lost') {
    admitIfIdle(input.store, input.dependencies, input.workspaceId, input.threadId);
  }
  return record;
}

/**
 * Withdraws one pending request.
 *
 * @param store Product store.
 * @param sqlite Workspace database.
 * @param requestId Request id.
 * @param workspaceId Workspace.
 * @param threadId Thread.
 * @param actorId Responsible user.
 * @param dependencies Admission dependencies.
 * @returns Ended record.
 */
export function withdrawRecordedPendingRequest(
  store: FsStore,
  sqlite: import('better-sqlite3').Database,
  requestId: string,
  workspaceId: string,
  threadId: string,
  actorId: string,
  dependencies: PendingAdmissionDependencies,
  requestActor?: Actor
): PendingRequestRecord {
  const current = requireUsableRecord(store, sqlite, requestId, workspaceId, threadId);
  assertResponsibleActor(store, current, actorId, dependencies.coreDb, requestActor);
  if (current.state !== 'pending') {
    throw new PendingRequestCommandError(
      'request_not_pending',
      `The request is already ${current.state}.`,
      409
    );
  }
  const ended = withdrawPendingRequest(
    sqlite,
    requestId,
    { kind: 'user', id: actorId },
    new Date().toISOString()
  );
  if (!ended) {
    throw new PendingRequestCommandError(
      'request_not_pending',
      'The request is no longer pending.',
      409
    );
  }
  syncApproval(store, ended);
  admitIfIdle(store, dependencies, workspaceId, threadId);
  return ended;
}

/**
 * Closes out a Thread inside archive, then archives it. Refusals happen before any write.
 *
 * @param store Product store.
 * @param dependencies Workspace opener.
 * @param workspaceId Workspace.
 * @param threadId Thread.
 * @param actor Ending actor.
 * @returns Archived thread id.
 */
export function archiveThreadWithCloseout(
  store: FsStore,
  dependencies: PendingRequestDatabase,
  workspaceId: string,
  threadId: string,
  actor: PendingRequestActor
): string {
  const now = new Date().toISOString();
  withWorkspace(dependencies, workspaceId, (sqlite) => {
    const records = listThreadPendingRequests(sqlite, workspaceId, threadId).filter((record) =>
      canonicalRecordIsUsable(store, sqlite, record)
    );
    if (records.some((record) => record.claim === 'claimed' && record.disposition === null)) {
      throw new PendingRequestCommandError(
        'request_executing',
        'A pending request execution is still claimed.',
        409
      );
    }
    const busy = store
      .listThreadTurns(workspaceId, threadId)
      .some((turn) => !isSealedTurnTerminal(turn.status));
    if (busy && records.some(archiveSelects)) {
      throw new PendingRequestCommandError(
        'thread_busy',
        'Archive waits until the active Turn ends.',
        409
      );
    }
    const closeoutTurnId = `tu_closeout_${threadId}_${now.replace(/[^0-9]/g, '')}`;
    const needsTurn = records.some(
      (record) =>
        archiveSelects(record) &&
        ((record.delivery === 'undelivered' && record.publicationTurnId === null) ||
          (record.state === 'pending' && record.publicationTurnId === null) ||
          needsInvalidationPublication(record))
    );
    if (needsTurn && !storeHasTurn(store, closeoutTurnId)) {
      store.createTurn(
        workspaceId,
        threadId,
        'Pending request closeout',
        systemActor(actor.id),
        null,
        {
          turnId: closeoutTurnId,
          triggerSource: { kind: 'system-input', summary: 'Archive closeout' },
          status: 'running',
        }
      );
    }
    const published = applyPendingCloseout(sqlite, {
      workspaceId,
      threadId,
      closeoutTurnId,
      actor,
      now,
      usable: (record) => canonicalRecordIsUsable(store, sqlite, record),
    });
    if (needsTurn) {
      publishOutcomeItems(store, published, closeoutTurnId, now);
      store.updateTurn(closeoutTurnId, { status: 'completed', completedAt: now });
    }
  });
  store.archiveThread(workspaceId, threadId);
  return threadId;
}

/**
 * Admits one outcome Turn when the Thread is idle and a matching outcome is ready.
 *
 * @param store Product store.
 * @param dependencies Admission dependencies.
 * @param workspaceId Workspace.
 * @param threadId Thread.
 */
export function admitIfIdle(
  store: FsStore,
  dependencies: PendingAdmissionDependencies,
  workspaceId: string,
  threadId: string
): void {
  const busy = store
    .listThreadTurns(workspaceId, threadId)
    .some((turn) => !isSealedTurnTerminal(turn.status));
  if (!busy) admitNextOutcome(store, dependencies, workspaceId, threadId);
}

/** Closes only canonical, unclaimed requests whose requester lost current authority. */
function closeoutUnavailableRequests(
  store: FsStore,
  dependencies: PendingAdmissionDependencies,
  workspaceId: string,
  threadId: string
): boolean {
  let closed = false;
  withWorkspace(dependencies, workspaceId, (sqlite) => {
    const loss = (record: PendingRequestRecord): string | null =>
      !(
        dependencies.requesterAuthority?.(record) ??
        authorityAllows(dependencies.coreDb, store, record, undefined)
      )
        ? 'membership-revoked'
        : record.requesterKind === 'worker' &&
            dependencies.agentAuthority &&
            !dependencies.agentAuthority(record)
          ? 'agent-authority-revoked'
          : null;
    const usable = (record: PendingRequestRecord) =>
      canonicalRecordIsUsable(store, sqlite, record) &&
      Boolean(loss(record)) &&
      record.claim !== 'claimed' &&
      (record.state === 'pending' ||
        record.delivery === 'undelivered' ||
        needsInvalidationPublication(record));
    if (!listThreadPendingRequests(sqlite, workspaceId, threadId).some(usable)) return;
    const now = new Date().toISOString();
    const turnId = `tu_closeout_${threadId}_${now.replace(/[^0-9]/g, '')}`;
    const records = applyPendingCloseout(sqlite, {
      workspaceId,
      threadId,
      closeoutTurnId: turnId,
      actor: systemActor(null),
      now,
      usable,
      invalidatingEvent: (record) => loss(record)!,
    });
    if (records.length) {
      store.createTurn(
        workspaceId,
        threadId,
        'Unavailable requester closeout',
        systemActor(null),
        null,
        {
          turnId,
          executorKind: 'person',
          status: 'running',
          agentId: null,
          triggerSource: { kind: 'system-input', summary: 'Requester authority was lost.' },
        }
      );
      publishOutcomeItems(store, records, turnId, now);
      store.updateTurn(turnId, { status: 'completed', completedAt: now });
      closed = true;
    }
  });
  return closed;
}

function admitNextOutcome(
  store: FsStore,
  dependencies: PendingAdmissionDependencies,
  workspaceId: string,
  threadId: string
): void {
  if (closeoutUnavailableRequests(store, dependencies, workspaceId, threadId)) return;
  if (admitInvalidations(store, dependencies, workspaceId, threadId)) return;
  let selected: {
    readonly executor: PendingExecutorKind;
    readonly approval: boolean;
    readonly actorId: string;
    readonly agentId: string | null;
  } | null = null;
  withWorkspace(dependencies, workspaceId, (sqlite) => {
    const ready = listThreadPendingRequests(sqlite, workspaceId, threadId).filter(
      (record) => isReadyOutcome(record) && canonicalRecordIsUsable(store, sqlite, record)
    );
    const worker = ready.find((record) => record.requesterKind === 'worker');
    const assistant = ready.find((record) => record.requesterKind === 'assistant');
    const person = ready.find((record) => record.requesterKind === 'person');
    const coordinator = ready.find((record) => record.requesterKind === 'coordinator');
    const first = worker ?? assistant ?? coordinator ?? person;
    if (!first) return;
    selected = {
      executor: first.requesterKind,
      agentId: first.agentId,
      approval: ready.some(
        (record) => record.requesterKind === first.requesterKind && record.kind === 'approval'
      ),
      actorId: first.decidingActor?.id ?? first.responsibleUserId,
    };
  });
  if (!selected) return;
  const choice: {
    readonly executor: PendingExecutorKind;
    readonly approval: boolean;
    readonly actorId: string;
    readonly agentId: string | null;
  } = selected;
  const now = new Date().toISOString();
  const turnId = `tu_outcome_${threadId.slice(-12)}_${now.replace(/[^0-9]/g, '')}`;
  if (storeHasTurn(store, turnId)) return;
  outcomeCauses.set(turnId, 'outcome');
  const triggerKind = choice.approval ? 'approval-resolution' : 'user-input';
  const turn = store.createTurn(
    workspaceId,
    threadId,
    choice.approval ? 'Approval outcomes' : 'User-input outcomes',
    choice.actorId === 'system' ? systemActor(null) : { kind: 'user', id: choice.actorId },
    null,
    {
      turnId,
      status: choice.executor === 'worker' ? 'pending' : 'running',
      executorKind: choice.executor,
      agentId:
        choice.executor === 'worker'
          ? choice.agentId
          : choice.executor === 'coordinator'
            ? choice.agentId
            : choice.executor === 'assistant'
              ? 'quick-chat'
              : null,
      triggerSource: {
        kind: triggerKind,
        summary: choice.approval
          ? 'Approval outcomes are ready.'
          : 'User-input outcomes are ready.',
      },
    }
  );
  if (
    choice.executor === 'worker' ||
    choice.executor === 'assistant' ||
    choice.executor === 'coordinator'
  ) {
    void deliverWorkerOutcome(store, dependencies, turn.id);
    return;
  }
  const provedAt = new Date().toISOString();
  store.updateTurn(turn.id, { status: 'completed', completedAt: provedAt });
  withWorkspace(dependencies, workspaceId, (sqlite) => {
    proveFrozenDelivery(sqlite, turn.id, provedAt);
  });
}

/**
 * Delivers an outcome without allowing submission or recovery failures to reject detached callers.
 *
 * @param store Store that owns the outcome Turn.
 * @param dependencies Workspace storage and executor delivery owners.
 * @param turnId Outcome Turn identity, included in recovery diagnostics.
 */
async function deliverWorkerOutcome(
  store: FsStore,
  dependencies: PendingAdmissionDependencies,
  turnId: string
): Promise<void> {
  let refusal: TurnStartValidationError | undefined;
  let submitted = false;
  try {
    const turn = store.getTurnById(turnId);
    try {
      const executor = store.getTurnExecutor(turnId) ?? executorKindForTurn(turn);
      const delivery =
        executor === 'coordinator'
          ? dependencies.coordinatorDelivery
          : executor === 'assistant'
            ? dependencies.assistantDelivery
            : dependencies.workerDelivery;
      if (!delivery) return;
      submitted = true;
      await delivery.startTurn(store, turnId);
      // The worker execution owner records delivery at native acceptance, before completion.
    } catch (error) {
      const now = new Date().toISOString();
      if (
        error instanceof TurnStartValidationError &&
        error.code === 'scheduler_admission_deferred'
      )
        return;
      if (error instanceof TurnStartValidationError) {
        refusal = error;
        refusedOutcomeTurns.add(turnId);
        withWorkspace(dependencies, turn.workspaceId, (sqlite) => {
          releaseFrozenOutcomes(sqlite, turnId, now);
        });
        if (!isSealedTurnTerminal(store.getTurnById(turnId).status))
          store.updateTurn(turnId, {
            status: 'failed',
            completedAt: now,
            error: { code: error.code, message: error.message },
          });
        closeoutUnavailableRequests(store, dependencies, turn.workspaceId, turn.threadId);
        return;
      }
      withWorkspace(dependencies, turn.workspaceId, (sqlite) => {
        markFrozenDeliveryUnknown(sqlite, turnId, now);
      });
      if (!isSealedTurnTerminal(store.getTurnById(turnId).status))
        store.updateTurn(turnId, {
          status: 'failed',
          completedAt: now,
          error: { code: 'delivery_unknown', message: 'Outcome delivery could not be proved.' },
        });
    }
  } catch (error) {
    if (!submitted && !refusal) {
      console.error(
        `Outcome delivery for Turn ${turnId} failed before submission; leaving it for boot resume.`,
        error
      );
      return;
    }
    // Preserve a proved refusal when its bookkeeping fails; only an uncertain submission is unknown.
    console.error(`Recording the outcome delivery result failed for Turn ${turnId}.`, error);
    const now = new Date().toISOString();
    try {
      const turn = store.getTurnById(turnId);
      withWorkspace(dependencies, turn.workspaceId, (sqlite) => {
        if (refusal) releaseFrozenOutcomes(sqlite, turnId, now);
        else markFrozenDeliveryUnknown(sqlite, turnId, now);
      });
    } catch (storageError) {
      console.error(
        refusal
          ? `Could not release refused outcomes for Turn ${turnId}.`
          : `Could not mark delivery unknown for Turn ${turnId}.`,
        storageError
      );
    }
    try {
      if (!isSealedTurnTerminal(store.getTurnById(turnId).status))
        store.updateTurn(turnId, {
          status: 'failed',
          completedAt: now,
          error: refusal
            ? { code: refusal.code, message: refusal.message }
            : { code: 'delivery_unknown', message: 'Outcome delivery could not be proved.' },
        });
    } catch (storageError) {
      console.error(`Could not fail outcome Turn ${turnId}.`, storageError);
    }
  }
}

function publishOutcomeItems(
  store: FsStore,
  records: readonly PendingRequestRecord[],
  turnId: string,
  now: string,
  restart = false
): void {
  const admission = restart ? ALREADY_DECIDED_PUBLICATION_ADMISSION : undefined;
  for (const record of records) {
    if (record.publicationTurnId && record.publicationTurnId !== turnId) {
      if (record.invalidationTurnId === turnId)
        publishInvalidationItem(store, record, turnId, now, restart);
      continue;
    }
    const base = {
      workspaceId: record.workspaceId,
      threadId: record.threadId,
      turnId,
      status: 'completed' as const,
      createdAt: now,
      completedAt: now,
    };
    if (record.kind === 'approval' && record.resolution && record.decidingActor?.kind === 'user') {
      writeItem(
        store,
        {
          ...base,
          id: pendingRequestItemId(record.requestId, 'decision'),
          type: 'approval-decision',
          actor: { kind: 'user', id: record.decidingActor.id },
          causationId: record.requestItemId,
          approvalRequestId: record.requestId,
          decision: record.resolution === 'denied' ? 'denied' : 'granted',
          decidedAt: record.decidedAt ?? now,
        },
        admission
      );
    }
    if (
      record.resolution === 'answered' &&
      record.answerMap &&
      record.decidingActor?.kind === 'user'
    ) {
      writeItem(
        store,
        {
          ...base,
          id: pendingRequestItemId(record.requestId, 'answer'),
          type: 'user-input-response',
          actor: { kind: 'user', id: record.decidingActor.id },
          causationId: record.requestItemId,
          userInputRequestId: record.requestId,
          answers: Object.fromEntries(
            Object.entries(record.answerMap).map(([key, value]) => [key, [value[0]] as [string]])
          ),
          answeredAt: record.decidedAt ?? now,
        },
        admission
      );
    }
    if (!isCommandIntentApproval(record) && record.disposition === 'denied-not-executed') {
      writeItem(
        store,
        {
          ...base,
          id: pendingRequestItemId(record.requestId, 'disposition-status'),
          type: 'status',
          level: 'warning',
          title: 'Call not executed',
          summary: `denied-not-executed: ${record.dispositionReason ?? 'refused'}`,
          causationId: record.requestItemId,
        },
        admission
      );
    } else if (
      !isCommandIntentApproval(record) &&
      record.disposition &&
      record.serverId &&
      record.toolName
    ) {
      writeItem(
        store,
        {
          ...base,
          id: pendingRequestItemId(record.requestId, 'disposition'),
          type: 'tool-call',
          tool: record.toolName,
          server: record.serverId,
          arguments: null,
          result: record.disposition,
          error: record.disposition === 'approved-executed' ? null : record.dispositionReason,
          durationMs: 0,
          causationId: record.requestItemId,
        },
        admission
      );
    }
    if (record.ending) {
      writeItem(
        store,
        {
          ...base,
          id: pendingRequestItemId(record.requestId, 'ending'),
          type: 'status',
          level: 'info',
          title: record.ending === 'withdrawn' ? 'Request withdrawn' : 'Request ended',
          summary: record.invalidatingEvent ?? record.ending,
          causationId: record.requestItemId,
        },
        admission
      );
    }
    if (record.invalidationTurnId === turnId) {
      publishInvalidationItem(store, record, turnId, now, restart);
    }
  }
}

function publishInvalidationItem(
  store: FsStore,
  record: PendingRequestRecord,
  turnId: string,
  now: string,
  restart: boolean
): void {
  writeItem(
    store,
    {
      id: pendingRequestItemId(record.requestId, 'invalidation'),
      workspaceId: record.workspaceId,
      threadId: record.threadId,
      turnId,
      status: 'completed',
      createdAt: now,
      completedAt: now,
      type: 'status',
      level: 'warning',
      title: 'Grant invalidated',
      summary: `denied-not-executed: ${record.dispositionReason ?? record.invalidatingEvent ?? 'invalidated'}`,
      causationId: record.requestItemId,
    },
    restart ? ALREADY_DECIDED_PUBLICATION_ADMISSION : undefined
  );
}

function writeItem(
  store: FsStore,
  item: Item,
  admission?: typeof ALREADY_DECIDED_PUBLICATION_ADMISSION
): void {
  const existing = store.listAllItems().find((candidate) => candidate.id === item.id);
  if (existing) return;
  store.createItem(item, admission);
}

function syncApproval(store: FsStore, record: PendingRequestRecord): void {
  const projected = projectApprovalRequest(record);
  if (!projected) return;
  try {
    store.updateApproval(record.requestId, projected);
  } catch {
    store.createApproval(projected);
  }
}

export function requireUsableRecord(
  store: FsStore,
  sqlite: import('better-sqlite3').Database,
  requestId: string,
  workspaceId: string,
  threadId: string
): PendingRequestRecord {
  let record: PendingRequestRecord | null;
  try {
    record = readPendingRequest(sqlite, requestId);
  } catch (error) {
    if (error instanceof PendingRequestCommandError) throw error;
    throw new PendingRequestCommandError(
      'recovery_required',
      'The pending request cannot be read.',
      409
    );
  }
  if (!record || record.workspaceId !== workspaceId || record.threadId !== threadId) {
    throw new PendingRequestCommandError(
      'recovery_required',
      'The pending request is missing.',
      409
    );
  }
  const failure = validateCanonicalLoad(
    record,
    store
      .listThreads(workspaceId)
      .flatMap((thread) => store.listThreadTurns(workspaceId, thread.id)),
    readCommandRequestRecordsFromSqlite(sqlite)
  );
  if (failure) {
    throw new PendingRequestCommandError(
      'recovery_required',
      'The pending request is contradictory.',
      409
    );
  }
  return record;
}

function assertResponsibleActor(
  store: FsStore,
  record: PendingRequestRecord,
  actorId: string,
  coreDb: CoreDb | undefined,
  requestActor: Actor | undefined
): void {
  const administrator = Boolean(
    coreDb &&
      requestActor &&
      requestActor.userId === actorId &&
      isCurrentDeploymentAdministrator(coreDb, requestActor)
  );
  if (actorId !== record.responsibleUserId && !administrator) {
    throw new PendingRequestCommandError(
      'workspace_access_denied',
      'Workspace access denied.',
      403
    );
  }
  if (coreDb && !administrator && !authorityAllows(coreDb, store, record, requestActor)) {
    throw new PendingRequestCommandError(
      'workspace_access_denied',
      'Workspace access denied.',
      403
    );
  }
}

function authorityAllows(
  coreDb: CoreDb | undefined,
  _store: FsStore,
  record: PendingRequestRecord,
  requestActor: Actor | undefined
): boolean {
  if (!coreDb) return true;
  if (requestActor)
    return (
      authorizeWorkspace(coreDb, requestActor, record.workspaceId, {
        policyOperation: 'approval.respond',
        mutating: true,
      }) !== null
    );
  return (
    currentWorkspaceAuthority(
      coreDb,
      record.workspaceId,
      { kind: 'user', id: record.responsibleUserId },
      'approval.respond',
      true
    ) !== null
  );
}

function agentStillKnown(store: FsStore, record: PendingRequestRecord): boolean {
  if (!record.agentId) return true;
  try {
    return store
      .listThreadTurns(record.workspaceId, record.threadId)
      .some((turn) => turn.agentId === record.agentId);
  } catch {
    return false;
  }
}

function assertAnswerShape(
  record: PendingRequestRecord,
  answers: Readonly<Record<string, readonly [string]>>
): void {
  const questions = record.questions ?? [];
  if (questions.some((question) => question.isSecret === true)) {
    throw new PendingRequestCommandError(
      'secret_input_not_supported',
      'Secret answers require a future Vault-backed input contract.',
      400
    );
  }
  const ids = questions
    .map((question) => question.id)
    .filter((id): id is string => typeof id === 'string');
  if (new Set(ids).size !== ids.length || ids.length === 0) {
    throw new PendingRequestCommandError(
      'invalid_request',
      'The question ids are not usable.',
      400
    );
  }
  const keys = Object.keys(answers);
  if (
    keys.length !== ids.length ||
    ids.some((id) => !keys.includes(id)) ||
    keys.some((key) => !ids.includes(key))
  ) {
    throw new PendingRequestCommandError(
      'invalid_request',
      'The answer map must match the question ids.',
      400
    );
  }
}

function conflictOrNotPending(
  record: PendingRequestRecord,
  answers: Readonly<Record<string, readonly [string]>>
): PendingRequestCommandError {
  const same =
    record.resolution === 'answered' &&
    record.answerMap !== null &&
    JSON.stringify(record.answerMap) === JSON.stringify(answers);
  if (!same && record.state !== 'pending') {
    return new PendingRequestCommandError(
      record.answerMap ? 'idempotency_key_conflict' : 'request_not_pending',
      record.answerMap
        ? 'The request already has a different answer.'
        : `The request is already ${record.state}.`,
      409
    );
  }
  return new PendingRequestCommandError(
    'request_not_pending',
    `The request is already ${record.state}.`,
    409
  );
}

function archiveSelects(record: PendingRequestRecord): boolean {
  if (record.state === 'pending') return true;
  if (record.delivery === 'frozen') return true;
  if (record.delivery === 'undelivered' && isFinalOutcome(record)) return true;
  return (
    isCommandIntentApproval(record) &&
    record.resolution === 'granted' &&
    record.claim === 'unclaimed' &&
    (record.disposition === null ||
      (record.disposition === 'denied-not-executed' && record.invalidationTurnId === null))
  );
}

/** Identifies a person's separate invalidation fact still waiting for its own publication. */
function needsInvalidationPublication(record: PendingRequestRecord): boolean {
  return (
    isCommandIntentApproval(record) &&
    record.resolution === 'granted' &&
    record.claim === 'unclaimed' &&
    record.invalidationTurnId === null &&
    (record.disposition === null || record.disposition === 'denied-not-executed')
  );
}

/** Publishes durable late invalidations independently of the original decision's delivery. */
function admitInvalidations(
  store: FsStore,
  dependencies: PendingRequestDatabase,
  workspaceId: string,
  threadId: string
): boolean {
  let admitted = false;
  withWorkspace(dependencies, workspaceId, (sqlite) => {
    const waiting = listThreadPendingRequests(sqlite, workspaceId, threadId).filter(
      (record) =>
        canonicalRecordIsUsable(store, sqlite, record) &&
        needsInvalidationPublication(record) &&
        record.disposition === 'denied-not-executed'
    );
    if (!waiting.length) return;
    const now = new Date().toISOString();
    const turnId = `tu_invalidation_${waiting[0]!.requestId}`;
    sqlite.transaction(() => {
      for (const record of waiting)
        sqlite
          .prepare(
            'UPDATE pending_requests SET invalidation_turn_id = ?, updated_at = ? WHERE request_id = ? AND invalidation_turn_id IS NULL'
          )
          .run(turnId, now, record.requestId);
      if (!storeHasTurn(store, turnId))
        store.createTurn(
          workspaceId,
          threadId,
          'Person grant invalidations',
          systemActor(null),
          null,
          {
            turnId,
            status: 'running',
            triggerSource: { kind: 'system-input', summary: 'Person grant invalidations' },
          }
        );
      for (const record of waiting) publishInvalidationItem(store, record, turnId, now, false);
    })();
    admitted = true;
    store.updateTurn(turnId, { status: 'completed', completedAt: now });
  });
  return admitted;
}

function canonicalRecordIsUsable(
  store: FsStore,
  sqlite: import('better-sqlite3').Database,
  record: PendingRequestRecord
): boolean {
  const turns = store
    .listThreads(record.workspaceId)
    .flatMap((thread) => store.listThreadTurns(record.workspaceId, thread.id));
  return validateCanonicalLoad(record, turns, readCommandRequestRecordsFromSqlite(sqlite)) === null;
}

function withWorkspace(
  dependencies: PendingRequestDatabase,
  workspaceId: string,
  use: (sqlite: import('better-sqlite3').Database) => void
): void {
  const db = dependencies.openWorkspace(workspaceId);
  try {
    use(db.sqlite);
  } finally {
    db.sqlite.close();
  }
}

function storeHasTurn(store: FsStore, turnId: string): boolean {
  try {
    store.getTurnById(turnId);
    return true;
  } catch {
    return false;
  }
}

function systemActor(responsibleUserId: string | null): {
  kind: 'system';
  id: string;
  responsibleUserId: string | null;
} {
  return { kind: 'system', id: 'nanocore-pending-request', responsibleUserId };
}

/** Presentation fields for one pending request. */
export function pendingRequestPresentation(
  record: PendingRequestRecord,
  turns: Parameters<typeof isBlockingPendingRequest>[1],
  nowMs = Date.now()
): { ageSeconds: number; turnsSince: number; blocking: boolean } {
  const created = Date.parse(record.createdAt);
  const raisingIndex = turns.findIndex((turn) => turn.id === record.raisingTurnId);
  return {
    ageSeconds: Number.isFinite(created) ? Math.max(0, Math.floor((nowMs - created) / 1000)) : 0,
    turnsSince: raisingIndex < 0 ? 0 : Math.max(0, turns.length - raisingIndex - 1),
    blocking: isBlockingPendingRequest(record, turns),
  };
}

/** Ends one request when membership or agent authority is gone at the next command. */
export function invalidateForAuthorityLoss(
  sqlite: import('better-sqlite3').Database,
  record: PendingRequestRecord,
  event: string,
  actor: PendingRequestActor,
  now: string
): PendingRequestRecord | null {
  return invalidatePendingRequest(sqlite, record.requestId, event, actor, now);
}
