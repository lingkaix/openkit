import {
  allocateEntityId,
  deriveEntityId,
  type Item,
  isSealedTurnTerminal,
  workspaceIdForOwner,
} from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import {
  authorizeWorkspace,
  currentWorkspaceAuthority,
  isCurrentDeploymentAdministrator,
} from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import type { FsStore } from '../lib/store.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION } from '../lib/store.js';
import { readCommandRequestRecordsFromSqlite } from '../storage/command-request-records.js';
import type { ControlAdmission } from '../storage/control-store-admission.js';
import type { ControlPendingTransition } from '../storage/control-store-pending.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { listSchedulerExecutionAttemptsForTurn } from './execution-attempt-records.js';
import { commandInputHash } from './idempotent-command.js';
import { TurnStartValidationError } from './orchestrator.js';
import { projectApprovalEffect } from './pending-request-disclosure.js';
import type { ControlPendingCommandInput } from './pending-requests.js';
import {
  archiveSelects,
  ControlPendingCommandInputSchema,
  compareReadiness,
  executorKindForTurn,
  isBlockingPendingRequest,
  isCommandIntentApproval,
  isFinalOutcome,
  isReadyOutcome,
  listThreadPendingRequests,
  type PendingExecutorKind,
  type PendingRequestActor,
  PendingRequestCommandError,
  type PendingRequestRecord,
  renderPendingInvalidationItem as pendingInvalidationItem,
  renderPendingOutcomeItems as pendingOutcomeItems,
  pendingRequestSystemActor,
  preflightPendingRequest,
  projectApprovalRequest,
  type RaisePendingRequestInput,
  readPendingRequest,
  validateCanonicalLoad,
} from './pending-requests.js';

/** Prepares the existing closeout communication; native SQL still decides and validates every changed source. */
function closeoutProjection(
  records: readonly PendingRequestRecord[],
  turnId: string,
  actor: PendingRequestActor,
  now: string,
  event: (record: PendingRequestRecord) => string
): PendingRequestRecord[] {
  return records
    .map((record) => {
      let next = record;
      if (next.state === 'pending' && next.claim === 'unclaimed')
        next = {
          ...next,
          state: 'ended',
          ending: 'invalidated',
          invalidatingEvent: event(record),
          endingActor: actor,
          endedAt: now,
          updatedAt: now,
        };
      if (
        isCommandIntentApproval(next) &&
        next.resolution === 'granted' &&
        next.claim === 'unclaimed' &&
        next.disposition === null
      )
        next = {
          ...next,
          disposition: 'denied-not-executed',
          dispositionReason: event(record),
          invalidationTurnId: next.invalidationTurnId ?? turnId,
          updatedAt: now,
        };
      if (
        isCommandIntentApproval(next) &&
        next.resolution === 'granted' &&
        next.disposition === 'denied-not-executed' &&
        next.invalidationTurnId === null
      )
        next = { ...next, invalidationTurnId: turnId, updatedAt: now };
      if (next.delivery === 'undelivered' && isFinalOutcome(next))
        next = {
          ...next,
          delivery: 'closed-out',
          publicationTurnId: next.publicationTurnId ?? turnId,
          updatedAt: now,
        };
      return next;
    })
    .filter(
      (record) => record.publicationTurnId === turnId || record.invalidationTurnId === turnId
    );
}

/** Exact readable Pending sources prepared before native SQL; these facts grant no Main authority. */
function pendingSources(records: readonly PendingRequestRecord[]) {
  return records.map((record) => ({
    requestId: record.requestId,
    sourceHash: commandInputHash(record),
  }));
}

/** Posts only the existing closed owner body; caller reads the original row after FULL acknowledgement. */
async function mutatePending(
  store: FsStore,
  sqlite: import('better-sqlite3').Database,
  input: ControlPendingCommandInput,
  publication: { items?: readonly Item[]; receipt?: ControlPendingTransition['receipt'] } = {}
): Promise<PendingRequestRecord[]> {
  if (sqlite.inTransaction)
    throw new PendingRequestCommandError(
      'invalid_request',
      'Native Pending work must not suspend inside Main SQL.',
      400
    );
  const result = await store.applyPendingRequestCommand(input.workspaceId, input, publication);
  return result.requestIds.map((id) => {
    const record = readPendingRequest(sqlite, id);
    if (!record) throw associationGap();
    return record;
  });
}

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

const attentionObservers = new WeakMap<FsStore, (record: PendingRequestRecord) => void>();

/** Installs the optional external attention projection after Core request ownership is composed. */
export function setPendingRequestAttentionObserver(
  store: FsStore,
  observer: (record: PendingRequestRecord) => void
): void {
  attentionObservers.set(store, observer);
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
    prepareAdmission(turn, declaredExecutor) {
      if (turn.owner.kind !== 'workspace') return { items: [], pending: [] };
      const workspaceId = turn.owner.workspaceId;
      const executor = declaredExecutor ?? executorKindForTurn(turn);
      if (!executor) return { items: [], pending: [] };
      return withWorkspace(dependencies, workspaceId, (sqlite) => {
        const census = listThreadPendingRequests(sqlite, workspaceId, turn.threadId);
        const usable = census.filter((record) => canonicalRecordIsUsable(store, sqlite, record));
        const selected = usable
          .filter(
            (record) =>
              record.requesterKind === executor &&
              (executor !== 'worker' || record.agentId === (turn.agentId ?? null)) &&
              isReadyOutcome(record)
          )
          .sort(compareReadiness)
          .slice(0, 16);
        const now = new Date().toISOString();
        const cause: 'outcome' | 'carried' = outcomeCauses.get(turn.id) ?? 'carried';
        const frozen = selected.map((record) => ({
          ...record,
          delivery: 'frozen' as const,
          deliveryTurnId: turn.id,
          deliveryCause: cause,
          publicationTurnId: record.publicationTurnId ?? turn.id,
          updatedAt: now,
        }));
        return {
          items: pendingOutcomeItems(frozen, turn.id, now),
          pending: [
            {
              action: 'freeze' as const,
              workspaceId,
              threadId: turn.threadId,
              turnId: turn.id,
              executor,
              agentId: turn.agentId ?? null,
              cause,
              now,
              expected: pendingSources(usable),
              expectedSelection: selected.map((record) => record.requestId),
              expectedThreadCensus: census.map((record) => record.requestId),
            },
          ],
        };
      });
    },
    prepareTerminal(turn) {
      if (turn.owner.kind !== 'workspace') return [];
      const attempt = dependencies.coreDb
        ? listSchedulerExecutionAttemptsForTurn(dependencies.coreDb, {
            workspaceId: turn.owner.workspaceId,
            threadId: turn.threadId,
            turnId: turn.id,
          }).at(-1)
        : undefined;
      if (
        attempt?.phase === 'closed' &&
        attempt.disposition === 'not_accepted' &&
        attempt.operationId === null &&
        attempt.terminalCause !== 'backend-busy'
      ) {
        refusedOutcomeTurns.add(turn.id);
        return [
          {
            action: 'delivery-release',
            workspaceId: turn.owner.workspaceId,
            turnId: turn.id,
            now: turn.completedAt ?? new Date().toISOString(),
          },
        ];
      }
      return [];
    },
    async onTerminal(turn) {
      if (refusedOutcomeTurns.has(turn.id)) return;
      if (store.getThread(workspaceIdForOwner(turn.owner), turn.threadId).status === 'archived')
        return;
      await admitNextOutcome(store, dependencies, workspaceIdForOwner(turn.owner), turn.threadId);
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
export async function recoverPendingRequestsAtBoot(
  store: FsStore,
  dependencies: PendingAdmissionDependencies
): Promise<void> {
  const now = new Date().toISOString();
  for (const workspace of store.listWorkspaces()) {
    const db = dependencies.openWorkspace(workspace.id);
    try {
      assertPendingAssociations(store, db.sqlite, workspace.id);
      const readable = db.sqlite
        .prepare('SELECT request_id FROM pending_requests WHERE workspace_id=?')
        .all(workspace.id) as { request_id: string }[];
      const usable = readable.flatMap((row) => {
        try {
          const record = readPendingRequest(db.sqlite, row.request_id);
          return record && canonicalRecordIsUsable(store, db.sqlite, record) ? [record] : [];
        } catch {
          return [];
        }
      });
      await mutatePending(store, db.sqlite, {
        action: 'settle-unfinished',
        workspaceId: workspace.id,
        now,
        expected: pendingSources(usable),
      });
      const loaded = usable.flatMap((source) => {
        const record = readPendingRequest(db.sqlite, source.requestId);
        return record ? [record] : [];
      });
      const localPublications = new Set<string>();
      for (const record of loaded) {
        if (
          record.delivery === 'frozen' &&
          record.deliveryTurnId &&
          record.requesterKind !== 'person' &&
          store.getTurnById(record.deliveryTurnId).status !== 'pending'
        )
          await store.applyPendingRequestCommand(workspace.id, {
            action: 'delivery-unknown',
            workspaceId: workspace.id,
            turnId: record.deliveryTurnId,
            now,
          });
        for (const turnId of [record.publicationTurnId, record.invalidationTurnId]) {
          if (!turnId) continue;
          const publication = store.getTurnById(turnId);
          if (!publication.agentId && !publication.agentSessionId) localPublications.add(turnId);
          else await publishOutcomeItems(store, [record], turnId, now, true);
        }
      }
      for (const turnId of localPublications) {
        const publication = store.getTurnById(turnId);
        const records = loaded.filter(
          (record) => record.publicationTurnId === turnId || record.invalidationTurnId === turnId
        );
        await store.publishPendingRequestServiceTurn(workspace.id, publication.threadId, {
          turnId,
          summary: publication.triggerSource?.summary ?? 'Finish original Pending publication',
          actor: publication.triggerActor,
          now: publication.completedAt ?? now,
          items: pendingOutcomeItems(records, turnId, publication.startedAt ?? now),
          pending: [{ action: 'delivery-prove', workspaceId: workspace.id, turnId, now }],
        });
      }
    } finally {
      db.sqlite.close();
    }
    for (const thread of store.listThreads(workspace.id)) {
      if (thread.status === 'archived') continue;
      if (
        !store
          .listThreadTurns(workspace.id, thread.id)
          .some((turn) => !isSealedTurnTerminal(turn.status))
      )
        await admitNextOutcome(store, dependencies, workspace.id, thread.id);
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
export async function raiseRecordedPendingRequest(
  store: FsStore,
  sqlite: import('better-sqlite3').Database,
  input: RaisePendingRequestInput,
  requestItem?: Item
): Promise<PendingRequestRecord> {
  const existing = preflightPendingRequest(sqlite, input);
  if (existing)
    return requireUsableRecord(
      store,
      sqlite,
      existing.requestId,
      existing.workspaceId,
      existing.threadId
    );
  const item =
    requestItem ??
    (input.kind === 'approval' && input.approval
      ? {
          id: input.requestItemId,
          owner: { kind: 'workspace' as const, workspaceId: input.workspaceId },
          threadId: input.threadId,
          turnId: input.raisingTurnId,
          type: 'approval-request' as const,
          approvalRequestId: input.requestId,
          kind: input.approval.kind,
          status: 'completed' as const,
          title: input.approval.title,
          description: input.approval.description,
          createdAt: input.now,
          completedAt: input.now,
        }
      : undefined);
  if (!item)
    throw new PendingRequestCommandError(
      'invalid_request',
      'The request requires its exact publication Item.',
      400
    );
  const [record] = await mutatePending(
    store,
    sqlite,
    { action: 'raise', workspaceId: input.workspaceId, threadId: input.threadId, input },
    { items: [item] }
  );
  if (!record) throw associationGap();
  syncApproval(store, record);
  try {
    attentionObservers.get(store)?.(record);
  } catch {
    /* Attention is a separate effect. */
  }
  return record;
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
export async function answerRecordedUserInput(
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
  dependencies: PendingAdmissionDependencies,
  receipt?: ControlPendingTransition['receipt']
): Promise<PendingRequestRecord> {
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
  const [answered] = await mutatePending(
    store,
    sqlite,
    {
      action: 'answer',
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      requestId: current.requestId,
      actor: { kind: 'user', id: actorId },
      answers: Object.fromEntries(
        Object.entries(input.answers).map(([key, value]) => [key, [value[0]] as [string]])
      ),
      now: new Date().toISOString(),
      decisionContext: requestActor ?? { kind: 'local', userId: actorId },
      expected: pendingSources([current]),
    },
    { ...(receipt ? { receipt } : {}) }
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
  await admitIfIdle(store, dependencies, input.workspaceId, input.threadId);
  return answered;
}

/** Resolves a captured command through the shared disclosure and current resolver authority. */
export async function resolveCommandIntentApproval(input: {
  readonly store: FsStore;
  readonly sqlite: import('better-sqlite3').Database;
  readonly record: PendingRequestRecord;
  readonly decision: 'granted' | 'denied';
  readonly actor: Actor;
  readonly coreDb: CoreDb | undefined;
  readonly checkCommandIntent?: PendingAdmissionDependencies['checkCommandIntent'];
  readonly receipt?: ControlPendingTransition['receipt'];
}): Promise<PendingRequestRecord> {
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
    input.decision === 'granted' &&
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
  const [record] = await mutatePending(
    input.store,
    input.sqlite,
    {
      action: input.decision === 'granted' ? 'grant-command' : 'deny',
      workspaceId: current.workspaceId,
      threadId: current.threadId,
      requestId: current.requestId,
      actor,
      now,
      decisionContext: input.actor,
      expected: pendingSources([current]),
    },
    { ...(input.receipt ? { receipt: input.receipt } : {}) }
  );
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
  /** Records Main submission and returns any final local refusal for the existing native finish. */
  readonly admitExecution?: (failure?: string) => string | undefined;
  readonly receipt?: ControlPendingTransition['receipt'];
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
    const record = await resolveCommandIntentApproval({
      store: input.store,
      sqlite: input.sqlite,
      record: current,
      decision: input.decision,
      actor: input.requestActor ?? { kind: 'local', userId: input.actorId },
      coreDb: input.coreDb,
      ...(input.dependencies.checkCommandIntent
        ? { checkCommandIntent: input.dependencies.checkCommandIntent }
        : {}),
      ...(input.receipt ? { receipt: input.receipt } : {}),
    });
    await admitIfIdle(input.store, input.dependencies, input.workspaceId, input.threadId);
    return record;
  }
  if (input.decision === 'denied') {
    const [denied] = await mutatePending(
      input.store,
      input.sqlite,
      {
        action: 'deny',
        workspaceId: current.workspaceId,
        threadId: current.threadId,
        requestId: current.requestId,
        actor,
        now,
        decisionContext: input.requestActor ?? { kind: 'local', userId: input.actorId },
        expected: pendingSources([current]),
      },
      { ...(input.receipt ? { receipt: input.receipt } : {}) }
    );
    if (!denied)
      throw new PendingRequestCommandError(
        'request_not_pending',
        'The request is no longer pending.',
        409
      );
    syncApproval(input.store, denied);
    await admitIfIdle(input.store, input.dependencies, input.workspaceId, input.threadId);
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
  // Reservation waits for FULL acknowledgement. No Main authority snapshot enters native SQL.
  const claimSource = readPendingRequest(input.sqlite, current.requestId);
  if (!claimSource) throw associationGap();
  const reserved = await input.store.applyPendingRequestCommand(
    current.workspaceId,
    {
      action: 'claim',
      workspaceId: current.workspaceId,
      threadId: current.threadId,
      requestId: current.requestId,
      actor,
      now: new Date().toISOString(),
      decisionContext: input.requestActor ?? { kind: 'local', userId: input.actorId },
      expected: pendingSources([claimSource]),
    },
    { ...(input.receipt ? { receipt: input.receipt } : {}) }
  );
  let record = readPendingRequest(input.sqlite, current.requestId);
  if (!record) throw associationGap();
  if (reserved.applied !== 'claimed') {
    if (record.claim === 'claimed' && record.disposition === null)
      throw new PendingRequestCommandError(
        'recovery_required',
        'The claim outcome requires inspection.',
        409
      );
    return record;
  }
  let failure: string | undefined;
  // This is the existing Main effect-submission step. Its call/decision/Audit rows precede contact.
  input.sqlite.transaction(() => {
    const currentMembership = authorityAllows(
      input.coreDb,
      input.store,
      current,
      input.requestActor
    );
    const currentAgent = current.agentId === null || agentStillKnown(input.store, current);
    // A revoked principal cannot enter the Policy/credential evaluator; record the local refusal first.
    const supplied = currentMembership && currentAgent ? input.evaluate?.() : undefined;
    const membership = currentMembership && supplied?.membership !== false;
    const agent = currentAgent && supplied?.agentAuthority !== false;
    failure = !membership
      ? 'membership-revoked'
      : !agent
        ? 'agent-authority-revoked'
        : supplied?.toolInSupply === false
          ? 'tool-left-supply'
          : supplied?.schemaCurrent === false
            ? 'schema-changed'
            : supplied?.policyAllows === false
              ? 'policy-changed'
              : supplied?.credentialsValid === false
                ? 'credential-changed'
                : undefined;
    if (!failure) {
      try {
        assertDisclosure();
      } catch {
        failure = 'approval_preview_unavailable';
      }
    }
    const submissionRefusal = input.admitExecution?.(failure);
    if (typeof submissionRefusal === 'string') failure = submissionRefusal;
  })();
  let disposition: 'approved-executed' | 'execution-error' | 'outcome-unknown' = failure
    ? 'execution-error'
    : 'outcome-unknown';
  let reason: string | null = failure ?? 'executor-unavailable';
  let result: unknown = null;
  if (!failure && input.execute) {
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
  const [finished] = await mutatePending(
    input.store,
    input.sqlite,
    ControlPendingCommandInputSchema.parse({
      action: 'finish',
      workspaceId: record.workspaceId,
      threadId: record.threadId,
      requestId: record.requestId,
      disposition,
      reason,
      heldResult: result,
      now: new Date().toISOString(),
      expected: pendingSources([record]),
    }),
    { ...(input.receipt ? { receipt: input.receipt } : {}) }
  );
  if (!finished) throw associationGap();
  record = finished;
  syncApproval(input.store, record);
  await admitIfIdle(input.store, input.dependencies, input.workspaceId, input.threadId);
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
export async function withdrawRecordedPendingRequest(
  store: FsStore,
  sqlite: import('better-sqlite3').Database,
  requestId: string,
  workspaceId: string,
  threadId: string,
  actorId: string,
  dependencies: PendingAdmissionDependencies,
  requestActor?: Actor,
  receipt?: ControlPendingTransition['receipt']
): Promise<PendingRequestRecord> {
  const current = requireUsableRecord(store, sqlite, requestId, workspaceId, threadId);
  assertResponsibleActor(store, current, actorId, dependencies.coreDb, requestActor);
  if (current.state !== 'pending') {
    throw new PendingRequestCommandError(
      'request_not_pending',
      `The request is already ${current.state}.`,
      409
    );
  }
  const [ended] = await mutatePending(
    store,
    sqlite,
    {
      action: 'withdraw',
      workspaceId,
      threadId,
      requestId,
      actor: { kind: 'user', id: actorId },
      now: new Date().toISOString(),
      expected: pendingSources([current]),
    },
    { ...(receipt ? { receipt } : {}) }
  );
  if (!ended) {
    throw new PendingRequestCommandError(
      'request_not_pending',
      'The request is no longer pending.',
      409
    );
  }
  syncApproval(store, ended);
  await admitIfIdle(store, dependencies, workspaceId, threadId);
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
export async function archiveThreadWithCloseout(
  store: FsStore,
  dependencies: PendingRequestDatabase,
  workspaceId: string,
  threadId: string,
  actor: PendingRequestActor,
  admission?: Pick<ControlAdmission, 'receipt' | 'audit'>
): Promise<string> {
  const now = new Date().toISOString();
  const { census, records } = withWorkspace(dependencies, workspaceId, (sqlite) => {
    assertPendingAssociations(store, sqlite, workspaceId, threadId);
    const census = listThreadPendingRequests(sqlite, workspaceId, threadId);
    return {
      census,
      records: census.filter((record) => canonicalRecordIsUsable(store, sqlite, record)),
    };
  });
  if (records.some((record) => record.claim === 'claimed' && record.disposition === null))
    throw new PendingRequestCommandError(
      'request_executing',
      'A pending request execution is still claimed.',
      409
    );
  if (
    store
      .listThreadTurns(workspaceId, threadId)
      .some((turn) => !isSealedTurnTerminal(turn.status)) &&
    records.some(archiveSelects)
  )
    throw new PendingRequestCommandError(
      'thread_busy',
      'Archive waits until the active Turn ends.',
      409
    );
  if (!records.some(archiveSelects)) {
    await store.updateThread(workspaceId, threadId, { status: 'archived' }, admission);
    return threadId;
  }
  const needsTurn = records.some(
    (record) =>
      archiveSelects(record) &&
      ((record.delivery === 'undelivered' && record.publicationTurnId === null) ||
        (record.state === 'pending' && record.publicationTurnId === null) ||
        needsInvalidationPublication(record))
  );
  const turnId = needsTurn
    ? allocateEntityId('tu')
    : records.find((record) => archiveSelects(record) && record.publicationTurnId)
        ?.publicationTurnId;
  if (!turnId) throw associationGap();
  const projected = closeoutProjection(records, turnId, actor, now, () => 'thread-archived');
  const command: ControlPendingCommandInput = {
    action: 'closeout',
    workspaceId,
    threadId,
    closeoutTurnId: turnId,
    actor,
    now,
    expected: pendingSources(records),
    expectedThreadCensus: census.map((record) => record.requestId),
  };
  await store.publishPendingRequestServiceTurn(workspaceId, threadId, {
    turnId,
    summary: 'Archive closeout',
    actor: pendingRequestSystemActor(actor.id),
    now,
    items: pendingOutcomeItems(projected, turnId, now),
    pending: [command],
    archive: true,
    ...(admission
      ? { admission: store.preparePendingArchiveAdmission(workspaceId, threadId, admission) }
      : {}),
  });
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
export async function admitIfIdle(
  store: FsStore,
  dependencies: PendingAdmissionDependencies,
  workspaceId: string,
  threadId: string
): Promise<void> {
  const busy = store
    .listThreadTurns(workspaceId, threadId)
    .some((turn) => !isSealedTurnTerminal(turn.status));
  if (!busy) await admitNextOutcome(store, dependencies, workspaceId, threadId);
}

/** Closes only canonical, unclaimed requests whose requester lost current authority. */
async function closeoutUnavailableRequests(
  store: FsStore,
  dependencies: PendingAdmissionDependencies,
  workspaceId: string,
  threadId: string
): Promise<boolean> {
  const selection = withWorkspace(dependencies, workspaceId, (sqlite) => {
    assertPendingAssociations(store, sqlite, workspaceId, threadId);
    const census = listThreadPendingRequests(sqlite, workspaceId, threadId);
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
    const records = census.filter(
      (record) =>
        canonicalRecordIsUsable(store, sqlite, record) &&
        loss(record) &&
        record.claim !== 'claimed' &&
        (record.state === 'pending' ||
          record.delivery === 'undelivered' ||
          needsInvalidationPublication(record))
    );
    return {
      census,
      records,
      events: records.map((record) => ({ requestId: record.requestId, event: loss(record)! })),
    };
  });
  if (!selection.records.length) return false;
  const now = new Date().toISOString();
  const turnId = allocateEntityId('tu');
  const actor = pendingRequestSystemActor(null);
  const events = new Map(selection.events.map((event) => [event.requestId, event.event]));
  const projected = closeoutProjection(
    selection.records,
    turnId,
    actor,
    now,
    (record) => events.get(record.requestId)!
  );
  await store.publishPendingRequestServiceTurn(workspaceId, threadId, {
    turnId,
    summary: 'Requester authority was lost.',
    actor,
    now,
    items: pendingOutcomeItems(projected, turnId, now),
    pending: [
      {
        action: 'closeout',
        workspaceId,
        threadId,
        closeoutTurnId: turnId,
        actor: { kind: actor.kind, id: actor.id },
        now,
        expected: pendingSources(selection.records),
        expectedThreadCensus: selection.census.map((record) => record.requestId),
        invalidatingEvents: selection.events,
      },
    ],
  });
  return true;
}

async function admitNextOutcome(
  store: FsStore,
  dependencies: PendingAdmissionDependencies,
  workspaceId: string,
  threadId: string
): Promise<void> {
  if (await closeoutUnavailableRequests(store, dependencies, workspaceId, threadId)) return;
  if (await admitInvalidations(store, dependencies, workspaceId, threadId)) return;
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
  const turnId = allocateEntityId('tu');
  if (storeHasTurn(store, turnId)) throw associationGap();
  outcomeCauses.set(turnId, 'outcome');
  const triggerKind = choice.approval ? 'approval-resolution' : 'user-input';
  const turn = await store.createTurn(
    workspaceId,
    threadId,
    choice.approval ? 'Approval outcomes' : 'User-input outcomes',
    choice.actorId === 'system'
      ? pendingRequestSystemActor(null)
      : { kind: 'user', id: choice.actorId },
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
  await store.completeTurn(
    turn.id,
    { status: 'completed', completedAt: provedAt },
    { pending: [{ action: 'delivery-prove', workspaceId, turnId: turn.id, now: provedAt }] }
  );
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
      if (error instanceof TurnStartValidationError) {
        refusal = error;
        refusedOutcomeTurns.add(turnId);
        await store.applyPendingRequestCommand(workspaceIdForOwner(turn.owner), {
          action: 'delivery-release',
          workspaceId: workspaceIdForOwner(turn.owner),
          turnId,
          now,
        });
        if (!isSealedTurnTerminal(store.getTurnById(turnId).status))
          await store.completeTurn(turnId, {
            status: 'failed',
            completedAt: now,
            error: { code: error.code, message: error.message },
          });
        await closeoutUnavailableRequests(
          store,
          dependencies,
          workspaceIdForOwner(turn.owner),
          turn.threadId
        );
        return;
      }
      await store.applyPendingRequestCommand(workspaceIdForOwner(turn.owner), {
        action: 'delivery-unknown',
        workspaceId: workspaceIdForOwner(turn.owner),
        turnId,
        now,
      });
      if (!isSealedTurnTerminal(store.getTurnById(turnId).status))
        await store.completeTurn(turnId, {
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
      await store.applyPendingRequestCommand(workspaceIdForOwner(turn.owner), {
        action: refusal ? 'delivery-release' : 'delivery-unknown',
        workspaceId: workspaceIdForOwner(turn.owner),
        turnId,
        now,
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
        await store.completeTurn(turnId, {
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

/** Publishes only existing outcome projections; native admission uses the pure renderer in its own tuple. */
async function publishOutcomeItems(
  store: FsStore,
  records: readonly PendingRequestRecord[],
  turnId: string,
  now: string,
  restart = false
): Promise<void> {
  for (const item of pendingOutcomeItems(records, turnId, now))
    await writeItem(store, item, restart ? ALREADY_DECIDED_PUBLICATION_ADMISSION : undefined);
}

async function writeItem(
  store: FsStore,
  item: Item,
  admission?: typeof ALREADY_DECIDED_PUBLICATION_ADMISSION
): Promise<void> {
  if (store.listAllItems().some((candidate) => candidate.id === item.id)) return;
  await store.createItem(item, admission);
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
  if (
    !isCanonicalUserActive(coreDb, record.responsibleUserId) ||
    (requestActor && !isCanonicalUserActive(coreDb, requestActor.userId))
  )
    return false;
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
async function admitInvalidations(
  store: FsStore,
  dependencies: PendingRequestDatabase,
  workspaceId: string,
  threadId: string
): Promise<boolean> {
  const waiting = withWorkspace(dependencies, workspaceId, (sqlite) => {
    assertPendingAssociations(store, sqlite, workspaceId, threadId);
    return listThreadPendingRequests(sqlite, workspaceId, threadId).filter(
      (record) =>
        canonicalRecordIsUsable(store, sqlite, record) &&
        needsInvalidationPublication(record) &&
        record.disposition === 'denied-not-executed'
    );
  });
  if (!waiting.length) return false;
  const now = new Date().toISOString();
  const turnId = deriveEntityId('tu', ['invalidation', waiting[0]!.requestId]);
  const projected = waiting.map((record) => ({
    ...record,
    invalidationTurnId: turnId,
    updatedAt: now,
  }));
  await store.publishPendingRequestServiceTurn(workspaceId, threadId, {
    turnId,
    summary: 'Person grant invalidations',
    actor: pendingRequestSystemActor(null),
    now,
    items: projected.map((record) => pendingInvalidationItem(record, turnId, now)),
    pending: [
      {
        action: 'associate-invalidation',
        workspaceId,
        threadId,
        requestIds: waiting.map((record) => record.requestId),
        turnId,
        now,
        expected: pendingSources(waiting),
      },
    ],
  });
  return true;
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

function withWorkspace<T>(
  dependencies: PendingRequestDatabase,
  workspaceId: string,
  use: (sqlite: import('better-sqlite3').Database) => T
): T {
  const db = dependencies.openWorkspace(workspaceId);
  try {
    return use(db.sqlite);
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

/** Uses existing canonical owners to refuse partial publication; it never reconstructs an association. */
function assertPendingAssociations(
  store: FsStore,
  sqlite: import('better-sqlite3').Database,
  workspaceId: string,
  threadId?: string
): void {
  const rows = sqlite
    .prepare('SELECT request_id FROM pending_requests WHERE workspace_id = ?')
    .all(workspaceId) as Array<{ request_id: string }>;
  const records = rows
    .flatMap((row) => {
      try {
        const record = readPendingRequest(sqlite, row.request_id);
        return record ? [record] : [];
      } catch {
        return [];
      } // Malformed rows remain inspect-only under their existing canonical reader.
    })
    .filter((record) => threadId === undefined || record.threadId === threadId);
  for (const record of records) {
    for (const id of [record.publicationTurnId, record.deliveryTurnId, record.invalidationTurnId]) {
      if (!id) continue;
      if (!storeHasTurn(store, id)) throw associationGap();
      const turn = store.getTurnById(id);
      if (
        workspaceIdForOwner(turn.owner) !== record.workspaceId ||
        turn.threadId !== record.threadId
      )
        throw associationGap();
    }
  }
  const threads =
    threadId === undefined
      ? store.listThreads(workspaceId)
      : [store.getThread(workspaceId, threadId)];
  for (const thread of threads) {
    const owned = records.filter((record) => record.threadId === thread.id);
    for (const turn of store.listThreadTurns(workspaceId, thread.id)) {
      if (isSealedTurnTerminal(turn.status)) continue;
      if (
        owned.some(
          (record) =>
            record.raisingTurnId === turn.id ||
            record.publicationTurnId === turn.id ||
            record.deliveryTurnId === turn.id ||
            record.invalidationTurnId === turn.id
        )
      )
        continue;
      const pendingActor =
        turn.triggerActor.kind === 'system' && turn.triggerActor.id === 'nanocore-pending-request';
      const executor =
        store.getTurnExecutor(turn.id) ??
        executorKindForTurn(turn) ??
        (!turn.agentId && !turn.agentSessionId ? 'person' : null);
      const unprovedOutcome =
        (turn.triggerSource?.kind === 'user-input' ||
          turn.triggerSource?.kind === 'approval-resolution') &&
        owned.some((record) => isReadyOutcome(record) && record.requesterKind === executor);
      // These facts only refuse uncertain work. No title, clock, suffix or current-list match creates an owner.
      if (pendingActor || unprovedOutcome) throw associationGap();
    }
  }
}

/** Retains the existing typed refusal for missing cross-store publication proof. */
function associationGap(): PendingRequestCommandError {
  return new PendingRequestCommandError(
    'recovery_required',
    'Pending request Turn association is incomplete.',
    409
  );
}
