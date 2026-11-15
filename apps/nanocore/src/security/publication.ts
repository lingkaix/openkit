import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FsStore } from '../lib/store.js';
import { StoreRecordNotFoundError } from '../lib/store-errors.js';
import { notifyPendingRequestAttention } from '../runtime/pending-request-flow.js';
import { validateCanonicalLoad } from '../runtime/pending-requests.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { SecurityTriggerRefusal } from '../storage/security-trigger-codecs.js';
import {
  type SecurityItemKey,
  securityPublicationIds,
  securityReportArtifactId,
} from './identifiers.js';
import { prepareSecurityThread, selectSecurityThread } from './threads.js';

type Owners = { coreDb: CoreDb; store: FsStore };
/** Original source and complete publication identities; this projection grants no effect authority. */
export interface SecurityAlarmPublication {
  requestId: string;
  recipientUserId: string;
  generation: number;
  workspaceId: string;
  threadId: string;
  rule: 'R1' | 'R8' | 'E12';
  key: SecurityItemKey;
  occurrence: { kind: 'initial' | 'reopen' | 'reminder' | 'renotice' | 'conflict'; n: number };
  artifactId: string;
  artifactVersion: 1;
  raiseTurnId: string;
  reportItemId: string;
  requestItemId: string;
}
function unavailable(): never {
  throw new SecurityTriggerRefusal('recovery_required');
}
function absent<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError) return null;
    throw error;
  }
}
async function original(input: Owners & { requestId: string }) {
  const result = await getControlStoreWorkerClient().securityTrigger(input.coreDb, {
    action: 'alarm-read',
    requestId: input.requestId,
  });
  if (result.kind !== 'alarm') throw new TypeError('Unexpected original alarm result.');
  return result.row;
}

/** Joins original source, destination, Pending, terminal and file/version authority without repairing a gap. */
export async function readSecurityAlarmPublication(
  input: Owners & { workspaceId: string; threadId: string; requestId: string }
): Promise<SecurityAlarmPublication | null> {
  const destination = await selectSecurityThread(input);
  if (!destination) unavailable();
  const source = await original(input);
  if (source.recipientUserId !== destination.recipientUserId) unavailable();
  const { workspaceId, threadId, requestId, store } = input;
  const ids = securityPublicationIds(requestId);
  const artifactId = securityReportArtifactId(requestId);
  const artifact = await store.readSecurityAlarmReport(workspaceId, artifactId);
  const turn = absent(() => store.getTurnById(ids.raiseTurnId));
  const cut = store.readThreadTimelineSnapshot(workspaceId, threadId, (snapshot) => ({
    request: snapshot.pendingRequest(requestId),
    reference: snapshot.item(ids.reportItemId) ?? null,
    question: snapshot.item(ids.requestItemId) ?? null,
  }));
  if (!artifact && !turn && !cut.request && !cut.reference && !cut.question) {
    if (source.raised) unavailable();
    return null;
  }
  if (!artifact || !turn || !cut.request || !cut.reference || !cut.question) unavailable();
  const { request, reference, question } = cut;
  if (
    turn.owner.kind !== 'workspace' ||
    turn.owner.workspaceId !== workspaceId ||
    turn.threadId !== threadId ||
    turn.status !== 'completed' ||
    turn.agentId ||
    turn.agentSessionId ||
    turn.triggerSource?.kind !== 'automation' ||
    turn.triggerActor.kind !== 'system' ||
    turn.triggerActor.id !== 'nanocore-pending-request' ||
    turn.triggerActor.responsibleUserId !== source.recipientUserId
  )
    unavailable();
  if (
    artifact.kind !== 'report' ||
    artifact.status !== 'ready' ||
    artifact.version !== 1 ||
    artifact.threadId !== threadId ||
    artifact.turnId !== turn.id ||
    artifact.lastMutationRequestId !== requestId ||
    artifact.content.format !== 'markdown' ||
    !isDeepStrictEqual(artifact.origin, {
      kind: 'turn-output',
      threadId,
      turnId: turn.id,
      requestId,
    }) ||
    artifact.contentDigest !==
      `sha256:${createHash('sha256').update(artifact.content.body, 'utf8').digest('hex')}`
  )
    unavailable();
  const version = store.getArtifactVersion(workspaceId, artifactId, 1);
  if (
    !isDeepStrictEqual(version.artifact, artifact) ||
    !isDeepStrictEqual(version.version.actor, turn.triggerActor) ||
    version.version.threadId !== threadId ||
    version.version.turnId !== turn.id ||
    version.version.artifactId !== artifactId ||
    version.version.workspaceId !== workspaceId ||
    version.version.artifactVersion !== 1 ||
    version.version.parentVersion !== null ||
    version.version.requestId !== requestId ||
    version.version.contentDigest !== artifact.contentDigest
  )
    unavailable();
  if (
    reference.type !== 'artifact-reference' ||
    reference.artifactId !== artifactId ||
    reference.artifactVersion !== 1 ||
    reference.turnId !== turn.id ||
    reference.lastMutationRequestId !== requestId ||
    reference.title !== artifact.title ||
    reference.summary !== artifact.summary ||
    !isDeepStrictEqual(
      turn.items.find((item) => item.id === reference.id),
      reference
    )
  )
    unavailable();
  if (
    question.type !== 'user-input-request' ||
    question.turnId !== turn.id ||
    question.responsibleUserId !== source.recipientUserId ||
    question.userInputRequestId !== request.requestId ||
    !isDeepStrictEqual(
      turn.items.find((item) => item.id === question.id),
      question
    ) ||
    !isDeepStrictEqual(
      question.questions.flatMap((q) => (q.options ?? []).map((option) => option.label)),
      source.rule === 'R1' ? ['Expected', 'Not expected'] : ['Reviewed', 'Start a response']
    )
  )
    unavailable();
  // Existing Pending lifecycle owners can close this historical request after its Raise.
  // Join only their exact finite native Turn references; do not scan or invent closeout history.
  const pendingTurns = [turn];
  for (const id of new Set([
    request.publicationTurnId,
    request.invalidationTurnId,
    request.deliveryTurnId,
  ])) {
    if (id && id !== turn.id) pendingTurns.push(store.getTurn(workspaceId, threadId, id));
  }
  if (
    request.kind !== 'user-input' ||
    request.requesterKind !== 'automation' ||
    request.responsibleUserId !== source.recipientUserId ||
    request.agentId !== null ||
    request.agentSessionId !== null ||
    request.raisingTurnId !== turn.id ||
    request.requestItemId !== ids.requestItemId ||
    validateCanonicalLoad(request, pendingTurns)
  )
    unavailable();
  return {
    requestId,
    recipientUserId: source.recipientUserId,
    generation: destination.generation,
    workspaceId,
    threadId,
    rule: source.rule,
    key: source.key,
    occurrence: source.occurrence,
    artifactId,
    artifactVersion: 1,
    raiseTurnId: ids.raiseTurnId,
    reportItemId: ids.reportItemId,
    requestItemId: ids.requestItemId,
  };
}

/** Publishes and queues an actual initial R1/R8/E12 through original owners and their separate FULL ACKs. */
export async function publishSecurityAlarm(
  input: Owners & { requestId: string }
): Promise<{ status: 'published'; publication: SecurityAlarmPublication } | { status: 'busy' }> {
  // The original native reservation repeats current recipient authority, including on exact replay.
  const destination = await prepareSecurityThread(input);
  const address = {
    ...input,
    workspaceId: destination.workspaceId,
    threadId: destination.threadId,
  };
  let publication = await readSecurityAlarmPublication(address);
  if (!publication) {
    const source = await original(input);
    if (source.raised) unavailable();
    const result = await input.store.publishSecurityAlarmTurn({
      requestId: input.requestId,
      workspaceId: destination.workspaceId,
      threadId: destination.threadId,
      recipientUserId: source.recipientUserId,
      rule: source.rule,
      ...(source.rule === 'E12' ? { sourceAuditEventId: source.key[1] as string } : {}),
    });
    if (result === 'busy') return { status: 'busy' };
    publication = await readSecurityAlarmPublication(address);
    if (!publication) unavailable();
  }
  // Actual Workspace settlement and the complete original tuple precede this Core-only commit.
  // A refused or unknown mark does not compensate an already acknowledged publication.
  const marked = await getControlStoreWorkerClient().securityTrigger(input.coreDb, {
    action: 'alarm-mark-enqueue',
    requestId: input.requestId,
    threadId: publication.threadId,
  });
  if (marked.kind !== 'alarm-notice' || !marked.notice)
    throw new TypeError('Unexpected alarm mark/enqueue result.');
  const pending = input.store.readThreadTimelineSnapshot(
    publication.workspaceId,
    publication.threadId,
    (snapshot) => snapshot.pendingRequest(input.requestId)
  );
  if (pending) await notifyPendingRequestAttention(input.store, pending);
  return { status: 'published', publication };
}

/** Drains the existing source/destination/publisher set; one busy or unavailable recipient does not block others. */
export async function drainSecurityNotices(input: Owners): Promise<void> {
  const result = await getControlStoreWorkerClient().securityTrigger(input.coreDb, {
    action: 'alarms',
  });
  if (result.kind !== 'alarms') throw new TypeError('Unexpected security source result.');
  const failures: unknown[] = [];
  let published = 0;
  for (const row of result.rows) {
    if (published === 8) break;
    try {
      const outcome = await publishSecurityAlarm({ ...input, requestId: row.requestId });
      if (outcome.status === 'published') published++;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Security notice publication requires inspection.');
}
