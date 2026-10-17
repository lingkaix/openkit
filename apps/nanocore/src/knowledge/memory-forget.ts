import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isSealedTurnTerminal, responsibleUserIdForActor } from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import {
  authorizeWorkspace,
  isCanonicalUserOperationAuthorized,
  isCurrentDeploymentAdministrator,
} from '../auth/operation-authorizer.js';
import {
  findAssistantTimeline,
  openAssistantTimeline,
} from '../internal-agents/assistant-timeline.js';
import type { FsStore } from '../lib/store.js';
import {
  admitIfIdle,
  raiseRecordedPendingRequest,
  requireUsableRecord,
} from '../runtime/pending-request-flow.js';
import {
  claimCommandIntentGrant,
  finishPendingExecution,
  listThreadPendingRequests,
  PENDING_REQUEST_BOUND,
  PendingRequestCommandError,
  type PendingRequestRecord,
  pendingRequestItemId,
  proveFrozenDelivery,
  readPendingRequest,
  refuseCommandIntentGrant,
} from '../runtime/pending-requests.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { type MemoryWriter, readMemoryPage, recordMemorySuppression } from './memory-lifecycle.js';
import { readMemorySuppressions } from './memory-maintenance.js';
import { NotebookError } from './notebook.js';
import type { NotebookPublication } from './notebook-publication.js';
import { pinScopedNotebook, resolveScopedNotebookOwner } from './scoped-notebook-owner.js';
import { publishScopedNotebook } from './scoped-notebook-publication.js';

/** Current native Memory writer and the existing Workspace owner of its confirmation. */
export type MemoryForgetWriter = MemoryWriter & { readonly workspaceDb: WorkspaceDb };

/** Exact authenticated-self target; the caller supplies no owner or confirmation assertion. */
export interface PrepareMemoryForgetInput {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly pageId: string;
  readonly notebookRevision: string;
  readonly digest: string;
}

/** The person's later command addresses only its exact original confirmation. */
export interface ApplyMemoryForgetInput {
  readonly requestId: string;
  readonly pendingRequestId: string;
  readonly workspaceId: string;
  readonly threadId: string;
}

const RETENTION = {
  suppression:
    'Remove active content and block normal historical retrieval and resurrection of this page identity.',
  git: 'Prior Git objects, including prepared and rejected candidates, remain retained. This is not physical erasure.',
  source:
    'This source-free page has no registered Source lineage. Independently retained Source records are not deleted by forgetting this page.',
  evidence:
    'Confirmation, Proposal, Review and other evidence bytes follow their existing retention rules and cannot supply future model retrieval.',
  backup:
    'Existing backup bytes remain subject to their separate retention rules. Published external copies are not erased.',
} as const;

const IntentSchema = z.object({
  operation: z.literal('memory.forget'),
  requestId: z.uuid(),
  ownerScope: z.object({ kind: z.literal('user'), userId: z.string() }),
  pageId: z.string().min(1),
  notebookRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  content: z.string(),
  disclosure: z.object({
    suppression: z.literal(RETENTION.suppression),
    git: z.literal(RETENTION.git),
    source: z.literal(RETENTION.source),
    evidence: z.literal(RETENTION.evidence),
    backup: z.literal(RETENTION.backup),
  }),
});
/** Validated captured effect retained by the existing Pending Request owner. */
type ForgetIntent = z.infer<typeof IntentSchema>;
/** Exact content-free commit outcome owned by the existing User notebook receipt. */
type Publication = NotebookPublication<{ kind: 'user'; userId: string }>;

/** Uses the shared pending-command error vocabulary without publishing retained text. */
function refuse(code: string, message: string, status = 409): never {
  throw new PendingRequestCommandError(code, message, status);
}

/** Rechecks current resolver authority and the owner's genuine private lineage without creating a Timeline or Turn. */
function admitContext(
  coreDb: CoreDb,
  store: FsStore,
  actor: Actor | undefined,
  input: { workspaceId: string; threadId?: string; turnId?: string },
  ownerUserId?: string,
  policyOperation: 'workspace.write' | 'approval.respond' = 'workspace.write'
) {
  if (!actor || !isCanonicalUserOperationAuthorized(coreDb, actor))
    refuse('workspace_access_denied', 'Current self Memory authority is unavailable.', 403);
  const privateOwner = ownerUserId ?? actor.userId;
  if (actor.userId !== privateOwner && !isCurrentDeploymentAdministrator(coreDb, actor))
    refuse('workspace_access_denied', 'Current Memory confirmation authority is unavailable.', 403);
  if (
    !authorizeWorkspace(coreDb, actor, input.workspaceId, {
      policyOperation,
      mutating: true,
    })
  )
    refuse(
      'workspace_access_denied',
      'Current confirmation Workspace authority is unavailable.',
      403
    );
  if (input.threadId === undefined) return undefined;
  const timeline = findAssistantTimeline(store, input.workspaceId, privateOwner);
  if (!timeline || timeline.id !== input.threadId || timeline.status === 'archived')
    refuse(
      'invalid_request',
      'Memory confirmation requires your current private Assistant Timeline.',
      400
    );
  if (input.turnId) {
    const turn = store.getTurnById(input.turnId);
    if (
      turn.workspaceId !== input.workspaceId ||
      turn.threadId !== input.threadId ||
      responsibleUserIdForActor(turn.triggerActor) !== privateOwner ||
      turn.agentSessionId
    )
      refuse('invalid_request', 'Memory confirmation requires the actual self command Turn.', 400);
    return turn;
  }
  return undefined;
}

/** Validates the retained captured effect before it can become removal authority. */
function intentFor(record: PendingRequestRecord): ForgetIntent {
  const parsed = IntentSchema.safeParse(record.governedIntent);
  if (
    !parsed.success ||
    record.kind !== 'approval' ||
    record.requesterKind !== 'person' ||
    record.serverId !== null ||
    parsed.data.ownerScope.userId !== record.responsibleUserId ||
    parsed.data.requestId !== record.requestId ||
    `sha256:${createHash('sha256').update(parsed.data.content).digest('hex')}` !==
      parsed.data.digest
  )
    refuse('recovery_required', 'The exact Memory confirmation is unavailable.');
  return parsed.data;
}

/** Rechecks the captured bytes through current scoped admission, without opening or creating another database. */
function checkTarget(coreDb: CoreDb, actor: Actor, intent: ForgetIntent) {
  const self = actor.userId === intent.ownerScope.userId;
  if (!self && !isCurrentDeploymentAdministrator(coreDb, actor))
    refuse('workspace_access_denied', 'Current Memory confirmation authority is unavailable.', 403);
  const context = {
    coreDb,
    actor,
    target: self
      ? { kind: 'user' as const }
      : { kind: 'user-inspection' as const, userId: intent.ownerScope.userId },
  };
  const owner = resolveScopedNotebookOwner(context);
  if (
    readMemorySuppressions(owner.notebookRoot, intent.ownerScope.userId).some(
      (row) => row.payload.pageId === intent.pageId
    )
  )
    refuse('grant_conflict', 'The Memory target is already unavailable.');
  const pin = pinScopedNotebook(context);
  if (
    pin.notebookRevision !== intent.notebookRevision ||
    pin.read([`${intent.pageId}.md`]).files[`${intent.pageId}.md`] !== intent.content
  )
    refuse('grant_conflict', 'The exact Memory target changed after confirmation.');
}

/** Binds native database handles to the authenticated owner before any retained request is inspected. */
function admitWriter(
  writer: MemoryForgetWriter,
  input: { workspaceId: string; threadId?: string; turnId?: string }
) {
  if (
    writer.workspaceDb.workspaceId !== input.workspaceId ||
    resolve(writer.workspaceDb.dataRoot) !== resolve(writer.coreDb.dataRoot) ||
    writer.userDb.userId !== writer.actor?.userId ||
    resolve(writer.userDb.dataRoot) !== resolve(writer.coreDb.dataRoot)
  )
    refuse('invalid_request', 'Memory confirmation database ownership does not match.', 400);
  return admitContext(writer.coreDb, writer.store, writer.actor, input);
}

/** Content-free identity projection of the exact confirmation, safe after its page becomes unavailable. */
function prepared(record: PendingRequestRecord, intent: ForgetIntent) {
  return {
    pendingRequestId: record.requestId,
    itemId: record.requestItemId,
    workspaceId: record.workspaceId,
    threadId: record.threadId,
    turnId: record.raisingTurnId,
    ownerScope: intent.ownerScope,
    pageId: intent.pageId,
    notebookRevision: intent.notebookRevision,
    digest: intent.digest,
  };
}

/** Captures only an admitted exact source-free self target under the current protected-page rule. */
function captureIntent(
  writer: MemoryForgetWriter,
  input: Omit<PrepareMemoryForgetInput, 'threadId' | 'turnId'>
): ForgetIntent {
  checkProtectedPage(writer, input.pageId);
  const page = readMemoryPage(writer, input.pageId);
  if (!page || page.notebookRevision !== input.notebookRevision || page.digest !== input.digest)
    refuse('conflict', 'The exact Memory target is unavailable or changed.');
  return IntentSchema.parse({
    operation: 'memory.forget',
    requestId: input.requestId,
    ownerScope: { kind: 'user', userId: writer.actor!.userId },
    pageId: input.pageId,
    notebookRevision: input.notebookRevision,
    digest: input.digest,
    content: page.content,
    disclosure: RETENTION,
  });
}

/** Prepares the actual person's idle command without a provider, Worker or caller-selected historical Turn. */
export function prepareMemoryForgetCommand(
  writer: MemoryForgetWriter,
  input: Omit<PrepareMemoryForgetInput, 'threadId' | 'turnId'>
) {
  admitWriter(writer, { workspaceId: input.workspaceId });
  const previous = readPendingRequest(writer.workspaceDb.sqlite, input.requestId);
  if (previous)
    return prepareMemoryForget(writer, {
      ...input,
      threadId: previous.threadId,
      turnId: previous.raisingTurnId,
    });
  // Target and current policy failures precede creation of either communication record.
  captureIntent(writer, input);
  const existing = findAssistantTimeline(writer.store, input.workspaceId, writer.actor!.userId);
  if (existing?.status === 'archived')
    refuse('invalid_request', 'The private Assistant Timeline is archived.', 400);
  if (
    existing &&
    writer.store
      .listThreadTurns(input.workspaceId, existing.id)
      .some((turn) => !isSealedTurnTerminal(turn.status))
  )
    refuse('thread_busy', 'The private Assistant Timeline has a Turn in flight.');
  if (
    existing &&
    listThreadPendingRequests(writer.workspaceDb.sqlite, input.workspaceId, existing.id).filter(
      (record) => record.state === 'pending'
    ).length >= PENDING_REQUEST_BOUND
  )
    refuse('request_limit_reached', 'The Thread already has 16 pending requests.');
  const timeline =
    existing ??
    openAssistantTimeline(
      writer.store,
      input.workspaceId,
      writer.actor!.userId,
      'Personal Assistant'
    );
  const turn = writer.store.createTurn(
    input.workspaceId,
    timeline.id,
    'Prepare personal Memory forget confirmation',
    { kind: 'user', id: writer.actor!.userId },
    null,
    {
      executorKind: 'person',
      status: 'running',
      triggerSource: {
        kind: 'user-input',
        summary: 'Prepare an exact personal Memory forget confirmation.',
      },
    }
  );
  try {
    const result = prepareMemoryForget(writer, {
      ...input,
      threadId: timeline.id,
      turnId: turn.id,
    });
    const at = new Date().toISOString();
    writer.store.updateTurn(turn.id, { status: 'completed', completedAt: at });
    proveFrozenDelivery(writer.workspaceDb.sqlite, turn.id, at);
    return result;
  } catch (error) {
    if (!isSealedTurnTerminal(writer.store.getTurnById(turn.id).status))
      writer.store.updateTurn(turn.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: {
          code: 'memory_forget_prepare_failed',
          message: 'Memory forget confirmation could not be prepared.',
        },
      });
    throw error;
  }
}

/** Protected content keeps its existing exact Proposal/Review requirement before any suppression effect. */
function checkProtectedPage(writer: MemoryForgetWriter, pageId: string): void {
  const maintenance = writer.runtimeConfigManager
    .current()
    .userConfigs.find(({ userId }) => userId === writer.actor!.userId)?.config.knowledgeMaintenance;
  if (maintenance?.reviewRequiredPageIds?.includes(pageId))
    refuse(
      'review_required',
      'This protected Memory page requires its existing exact human Review.'
    );
}

/** Captures an exact source-free self page and raises one canonical destructive-action Item on the admitted command Turn. */
export function prepareMemoryForget(writer: MemoryForgetWriter, input: PrepareMemoryForgetInput) {
  const turn = admitWriter(writer, input)!;
  const previous = readPendingRequest(writer.workspaceDb.sqlite, input.requestId);
  if (previous) {
    const record = requireUsableRecord(
      writer.store,
      writer.workspaceDb.sqlite,
      input.requestId,
      input.workspaceId,
      input.threadId
    );
    const intent = intentFor(record);
    if (
      record.raisingTurnId !== input.turnId ||
      intent.ownerScope.userId !== writer.actor!.userId ||
      intent.pageId !== input.pageId ||
      intent.notebookRevision !== input.notebookRevision ||
      intent.digest !== input.digest
    )
      refuse(
        'idempotency_key_conflict',
        'The request id already names a different Memory confirmation.'
      );
    return prepared(record, intent);
  }
  if (turn.status !== 'running')
    refuse('invalid_request', 'Memory confirmation requires a running self command Turn.', 400);
  const intent = captureIntent(writer, input);
  const now = new Date().toISOString();
  const title = 'Forget personal Memory';
  const description =
    'Inspect the exact page and retention disclosure. Forgetting blocks reuse and retains Git history and independent evidence and backups.';
  const record = raiseRecordedPendingRequest(writer.store, writer.workspaceDb.sqlite, {
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    raisingTurnId: input.turnId,
    requestItemId: pendingRequestItemId(input.requestId, 'request'),
    kind: 'approval',
    requesterKind: 'person',
    responsibleUserId: writer.actor!.userId,
    governedIntent: intent,
    approval: { kind: 'destructive-action', title, description },
    now,
  });
  writer.store.createItem({
    id: record.requestItemId,
    workspaceId: record.workspaceId,
    threadId: record.threadId,
    turnId: record.raisingTurnId,
    type: 'approval-request',
    approvalRequestId: record.requestId,
    kind: 'destructive-action',
    status: 'completed',
    title,
    description,
    createdAt: now,
    completedAt: now,
  });
  return prepared(record, intent);
}

/** Existing approval-response hook: checks the current resolver and exact self-owned target; it executes no Memory effect. */
export function checkMemoryForgetIntent(
  sqlite: WorkspaceDb['sqlite'],
  record: PendingRequestRecord,
  actor: Actor,
  coreDb: CoreDb,
  store: FsStore
): void {
  const canonical = requireUsableRecord(
    store,
    sqlite,
    record.requestId,
    record.workspaceId,
    record.threadId
  );
  const intent = intentFor(canonical);
  admitContext(coreDb, store, actor, canonical, intent.ownerScope.userId, 'approval.respond');
  checkTarget(coreDb, actor, intent);
}

/** Replays only a complete content-free result that matches this exact original captured effect. */
function publicationResult(value: unknown, intent: ForgetIntent): Publication {
  const parsed = z
    .object({
      outcome: z.literal('published'),
      ownerScope: z.object({
        kind: z.literal('user'),
        userId: z.literal(intent.ownerScope.userId),
      }),
      baseRevision: z.literal(intent.notebookRevision),
      notebookRevision: z.string(),
      changedPageIds: z.array(z.string()),
      receiptRef: z.object({
        operation: z.literal('knowledge.delete'),
        requestId: z.literal(intent.requestId),
        ownerScope: z.object({
          kind: z.literal('user'),
          userId: z.literal(intent.ownerScope.userId),
        }),
      }),
    })
    .safeParse(value);
  if (
    !parsed.success ||
    parsed.data.changedPageIds.length !== 1 ||
    parsed.data.changedPageIds[0] !== intent.pageId
  )
    refuse('recovery_required', 'The completed Memory forget result is unavailable.');
  return parsed.data;
}

/** Consumes one exact human grant, suppresses before Git cleanup, and never retries a claimed or terminal failure. */
export async function applyMemoryForget(
  writer: MemoryForgetWriter,
  input: ApplyMemoryForgetInput
): Promise<Publication> {
  admitWriter(writer, input);
  const record = requireUsableRecord(
    writer.store,
    writer.workspaceDb.sqlite,
    input.pendingRequestId,
    input.workspaceId,
    input.threadId
  );
  const intent = intentFor(record);
  if (input.requestId !== intent.requestId || intent.ownerScope.userId !== writer.actor!.userId)
    refuse(
      'idempotency_key_conflict',
      'The command does not match its original Memory confirmation.'
    );
  const publish = () =>
    publishScopedNotebook(
      {
        ...writer,
        target: { kind: 'user' },
        command: {
          name: 'knowledge.delete',
          input: {
            ...input,
            pageId: intent.pageId,
            notebookRevision: intent.notebookRevision,
            digest: intent.digest,
          },
        },
        confirmedForget: {
          requestId: intent.requestId,
          pageId: intent.pageId,
          baseRevision: intent.notebookRevision,
          digest: intent.digest,
          content: intent.content,
        },
      },
      {
        requestId: intent.requestId,
        baseRevision: intent.notebookRevision,
        changes: [{ path: `${intent.pageId}.md`, content: null }],
        summary: 'Forget personal Memory; Git history retained',
      }
    );
  if (record.claim === 'finished' && record.disposition === 'approved-executed') {
    // Decision delivery can clear heldResult; the publisher's exact immutable receipt remains its outcome owner.
    return publicationResult(record.heldResult ?? (await publish()), intent);
  }
  if (record.claim === 'claimed' || record.disposition === 'outcome-unknown')
    refuse(
      'recovery_required',
      'Memory forget outcome is unknown. Inspect retained suppression and publication evidence; execution will not repeat.'
    );
  if (record.disposition === 'execution-error')
    refuse(
      'memory_forget_failed',
      'Memory forget publication failed. Memory remains unavailable; inspect the retained publication outcome.'
    );
  if (record.state === 'pending')
    refuse('approval_required', 'Confirm the exact Memory request before application.');
  if (
    record.state !== 'resolved' ||
    record.resolution !== 'granted' ||
    record.claim !== 'unclaimed' ||
    record.disposition
  )
    refuse('grant_conflict', 'The Memory grant is no longer available for execution.');
  try {
    checkProtectedPage(writer, intent.pageId);
    checkTarget(writer.coreDb, writer.actor!, intent);
    if (
      !record.decidingActorContext ||
      record.decidingActor?.kind !== 'user' ||
      record.decidingActor.id !== record.decidingActorContext.userId
    )
      refuse('grant_conflict', 'The actual deciding authority is unavailable.');
    checkMemoryForgetIntent(
      writer.workspaceDb.sqlite,
      record,
      record.decidingActorContext,
      writer.coreDb,
      writer.store
    );
  } catch (error) {
    refuseCommandIntentGrant(
      writer.workspaceDb.sqlite,
      record.requestId,
      'Current authority or exact Memory target changed.',
      new Date().toISOString()
    );
    admitIfIdle(
      writer.store,
      {
        coreDb: writer.coreDb,
        openWorkspace: (workspaceId) => openWorkspaceDb(writer.coreDb.dataRoot, workspaceId),
      },
      input.workspaceId,
      input.threadId
    );
    if (error instanceof PendingRequestCommandError && error.code === 'review_required')
      throw error;
    refuse('grant_conflict', 'Current authority or the exact Memory target changed.');
  }
  if (
    !claimCommandIntentGrant(writer.workspaceDb.sqlite, record.requestId, new Date().toISOString())
  )
    refuse('grant_conflict', 'The Memory confirmation was already consumed or invalidated.');
  try {
    recordMemorySuppression(writer, {
      requestId: intent.requestId,
      pageId: intent.pageId,
      notebookRevision: intent.notebookRevision,
      digest: intent.digest,
    });
    const result = publicationResult(await publish(), intent);
    finishPendingExecution(
      writer.workspaceDb.sqlite,
      record.requestId,
      'approved-executed',
      null,
      result,
      new Date().toISOString()
    );
    return result;
  } catch (error) {
    const known =
      error instanceof NotebookError &&
      ['conflict', 'invalid_request', 'review_required'].includes(error.code);
    finishPendingExecution(
      writer.workspaceDb.sqlite,
      record.requestId,
      known ? 'execution-error' : 'outcome-unknown',
      'Memory is unavailable; inspect the retained publication outcome before a new request.',
      null,
      new Date().toISOString()
    );
    refuse(
      known ? 'memory_forget_failed' : 'recovery_required',
      known
        ? 'Memory forget publication failed. Memory remains unavailable; inspect the retained publication outcome.'
        : 'Memory forget outcome is unknown. Inspect retained suppression and publication evidence; execution will not repeat.'
    );
  }
}
