import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type AgentEnvironmentPackageSnapshotRecord as AppApiAgentEnvironmentPackageSnapshotRecord,
  KnowledgeManagerDraftedProposalSchema,
  KnowledgeProposalPageIdSchema,
  KnowledgeProposalReviewSchema,
  KnowledgeSourceSchema,
  validKnowledgeProposalShape,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  RetainedAgentEnvironmentPackageSchema,
  redactAgentEnvironmentPackageSnapshot,
  WorkspaceConfigSchema,
} from '@openkit/config-schema';
import {
  ActorRefSchema,
  AgentSessionIdSchema,
  type ArtifactSchema,
  type ArtifactVersionRecord,
  ArtifactVersionRecordSchema,
  compareCodeUnits,
  deriveEntityId,
  entityIdPattern,
  type ItemSchema,
  isSealedTurnTerminal,
  KnowledgeNotebookPageSchema,
  readRetainedV1,
  responsibleUserIdForActor,
  type ServerTurnEventEnvelope,
  type SseEventEnvelopeSchema,
  ThreadIdSchema,
  ThreadSchema,
  TimestampSchema,
  TurnIdSchema,
  type TurnSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
  WorkspaceRecordSchema,
  workspaceIdForOwner,
  writeRetainedV1,
} from '@openkit/protocol';
import {
  type CaptureCoverageBinding,
  CaptureCoverageBindingSchema,
} from '@openkit/worker-protocol';
import type Database from 'better-sqlite3';
import { applyEdits, modify } from 'jsonc-parser';
import { z } from 'zod';
import { isScopeAdmitted, refuseScope } from '../bootstrap/readiness.js';
import { parseJsoncObject } from '../config/jsonc.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import {
  parseOkfDocument,
  stringFrontmatterField,
  stringListFrontmatterField,
  validateOpenKitKnowledgeProfile,
} from '../knowledge/okf.js';
import { readSourcePointers } from '../knowledge/source-pointers.js';
import type {
  AgentSession,
  KnowledgeProposalRecord,
  KnowledgeProposalReviewRecord,
  KnowledgeSourceRecord,
} from '../lib/store.js';
import {
  readArtifactVersionRecord,
  stageArtifactVersionRecord,
} from './artifacts/artifact-version-records.js';
import { artifactFilePayloadPath } from './artifacts/file-records.js';
import { CanonicalPublicationError } from './canonical-publication-error.js';
import { reserveCanonicalFileWrite } from './canonical-write-capacity.js';
import {
  CONTROL_PRODUCT_LIMITS,
  type ControlProductContentMount,
  type ControlProductKind,
  type ControlProductOwner,
  type ControlProductSnapshot,
  type ControlStoreProductReadHandle,
  getWorkspaceProductReadHandle,
  openControlStoreProductReadHandle,
} from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import {
  assertWorkspaceWorkOwner,
  ensureLayoutDirectories,
  ensureWorkspaceLayoutRoot,
  WorkOwnershipViolationError,
} from './fs-layout.js';
import { readImmutableProductJson } from './immutable-content.js';
import { StoredServerEventV1Schema } from './retained-server-work-v1.js';
import {
  StoredArtifactSnapshotV1Schema,
  StoredEventPayloadV1Schema,
  StoredEventV1Schema,
  StoredThreadSnapshotV1Schema,
  StoredTurnSnapshotV1Schema,
  StoredWorkspaceSnapshotV1Schema,
} from './retained-work-events-v1.js';
import { StoredItemPayloadV1Schema } from './retained-work-items-v1.js';
import {
  StoredAgentSessionV1Schema,
  StoredArtifactV1Schema,
  StoredTurnV1Schema,
  StoredWorkspaceV1Schema,
} from './retained-work-metadata-v1.js';
import { assertServerTurnEventLineage } from './server-thread-records.js';

type WorkspaceRecord = import('zod').infer<typeof WorkspaceRecordSchema>;
type KnowledgeNotebookPage = import('zod').infer<typeof KnowledgeNotebookPageSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;
type Turn = import('zod').infer<typeof TurnSchema>;
type Item = import('zod').infer<typeof ItemSchema>;
type Artifact = import('zod').infer<typeof ArtifactSchema>;
type SseEventEnvelope = import('zod').infer<typeof SseEventEnvelopeSchema>;

/** Admission-time resolved capture pair retained on native Turn metadata. */
export type { CaptureCoverageBinding };
/** Admission-time resolved capture pair retained on native Turn metadata. */
export { CaptureCoverageBindingSchema };

const CanonicalTimestampSchema = z.string().datetime();
const retainedProposal = Symbol('retainedKnowledgeProposal');
/** Retained attribution is descriptive; all actor branches and accountability fields remain closed. */
export const ActorRefReaderSchema = z.union(ActorRefSchema.options.map((schema) => schema.strip()));
/** Canonical history projects fixed retained v1 payloads without their native headers. */
const ItemReaderSchema = StoredItemPayloadV1Schema;
/** Retained Turn snapshots validate attribution and Item relationships independently of wire schemas. */
export const TurnReaderSchema = StoredTurnSnapshotV1Schema;
/** Body-bearing retained projections preserve immutable Artifact lineage. */
export const ArtifactReaderSchema = StoredArtifactSnapshotV1Schema;
/** Historical event meaning is independent of the live protocol version. */
const SseEventReaderSchema = StoredEventPayloadV1Schema;
/** System metadata excludes the editable name and derived counts. */
export const WorkspaceSystemRecordSchema = StoredWorkspaceV1Schema.omit({ schemaVersion: true });
const { status: _proposalStatus, ...knowledgeProposalRecordShape } =
  KnowledgeManagerDraftedProposalSchema.shape;
export const KnowledgeProposalRecordSchema = z
  .object(knowledgeProposalRecordShape)
  .extend({
    id: z.string().regex(/^kp_[a-f0-9]{64}$/),
    producer: ActorRefReaderSchema,
  })
  .strip()
  .refine(
    validKnowledgeProposalShape,
    'Knowledge Proposal must contain exactly one complete candidate shape.'
  );
export const KnowledgeProposalReviewRecordSchema = KnowledgeProposalReviewSchema.safeExtend({
  reviewId: z.string().regex(entityIdPattern('kr')),
  actor: ActorRefReaderSchema,
})
  .strip()
  .superRefine((review, context) => {
    const accepted = review.decision === 'accepted';
    if (
      accepted
        ? !review.changedPageIds && review.targetAbsentAtDecision === null
        : review.targetAbsentAtDecision !== null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only an accepted review may record target absence.',
        path: ['targetAbsentAtDecision'],
      });
    }
  });
/** Retained Review reader validates ordered decision core and identities without descriptive annotations. */
export const KnowledgeProposalReviewFileSchema = z
  .object({
    proposalId: z.string().regex(/^kp_[a-f0-9]{64}$/),
    workspaceId: WorkspaceIdSchema,
    decisions: z.array(KnowledgeProposalReviewRecordSchema).min(1),
  })
  .strip()
  .superRefine((file, context) => {
    const requestIds = new Set<string>();
    const reviewIds = new Set<string>();
    let terminal = false;

    for (const [index, review] of file.decisions.entries()) {
      const expectedReviewId = deriveEntityId('kr', {
        ownerScope: { kind: 'workspace', workspaceId: file.workspaceId },
        proposalId: file.proposalId,
        requestId: review.requestId,
      });
      if (
        review.proposalId !== file.proposalId ||
        review.workspaceId !== file.workspaceId ||
        review.reviewId !== expectedReviewId ||
        requestIds.has(review.requestId) ||
        reviewIds.has(review.reviewId) ||
        terminal
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Knowledge Proposal review history is not append-only canonical history.',
          path: ['decisions', index],
        });
      }
      requestIds.add(review.requestId);
      reviewIds.add(review.reviewId);
      terminal ||= review.decision === 'accepted' || review.decision === 'rejected';
    }
  });
export const KnowledgeSourceRecordSchema = KnowledgeSourceSchema.extend({
  capturedAt: CanonicalTimestampSchema,
  createdAt: CanonicalTimestampSchema,
  updatedAt: CanonicalTimestampSchema,
}).strip();
/** Original attachment provenance; an absent generation remains unknown and grants no authority. */
export const AgentSessionRetainedStorageSchema = z
  .object({
    storageRef: WorkerStorageTargetIdSchema,
    workSlotRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    attachmentGeneration: z.number().int().positive().optional(),
  })
  .strip();

/** Fixed canonical AgentSession payload shared with Workspace portability and current projections. */
export const AgentSessionRecordSchema = StoredAgentSessionV1Schema.omit({ schemaVersion: true });

const TERMINAL_AGENT_SESSION_STATUSES = new Set<AgentSession['status']>([
  'interrupted',
  'failed',
  'closed',
]);

/** Returns whether one AgentSession status remains current for its Thread. */
export function isCurrentAgentSessionStatus(status: AgentSession['status']): boolean {
  return !TERMINAL_AGENT_SESSION_STATUSES.has(status);
}

/** Maximum canonical replay window retained in memory after reload. */
export const TURN_STREAM_EVENT_WINDOW_SIZE = 100;

/**
 * Derives the stable Item identity for one Artifact and communicating Turn.
 *
 * @param artifactId Artifact communicated by the Item.
 * @param turnId Turn that owns the Item.
 * @returns Stable non-secret Item id.
 */
export function artifactReferenceItemId(artifactId: string, turnId: string): string {
  return deriveEntityId('it', [artifactId, turnId]);
}

/**
 * Lists unresolved user-input request Item ids from the latest canonical revisions.
 *
 * @param itemRevisions Full append-order Item revision history.
 * @returns Sorted request Item ids without a completed response in the same Turn lineage.
 */
export function listUnresolvedUserInputRequestItemIds(itemRevisions: readonly Item[]): string[] {
  const currentItems = new Map<string, Item>();

  for (const item of itemRevisions) {
    currentItems.set(item.id, item);
  }

  const completedResponses = new Set(
    [...currentItems.values()]
      .filter(
        (item): item is Extract<Item, { type: 'user-input-response' }> =>
          item.type === 'user-input-response' && item.status === 'completed'
      )
      .map((item) =>
        JSON.stringify([
          workspaceIdForOwner(item.owner),
          item.threadId,
          item.turnId,
          item.userInputRequestId,
          item.actor.id,
        ])
      )
  );

  return [...currentItems.values()]
    .filter(
      (item): item is Extract<Item, { type: 'user-input-request' }> =>
        item.type === 'user-input-request' &&
        !completedResponses.has(
          JSON.stringify([
            workspaceIdForOwner(item.owner),
            item.threadId,
            item.turnId,
            item.userInputRequestId,
            item.responsibleUserId,
          ])
        )
    )
    .map((item) => item.id)
    .sort();
}

/**
 * Rejects a valid revision that rewrites immutable human attribution.
 *
 * @param previousRecord Previous canonical Item revision.
 * @param nextRecord Proposed later revision for the same Item.
 * @throws Error when owner, actor, responsible user, or command causation changes.
 */
export function assertImmutableItemAttribution(previousRecord: Item, nextRecord: Item): void {
  const previous = ItemReaderSchema.parse(previousRecord);
  const next = ItemReaderSchema.parse(nextRecord);
  const actorChanged =
    ((previous.type === 'user-message' && next.type === 'user-message') ||
      (previous.type === 'approval-decision' && next.type === 'approval-decision') ||
      (previous.type === 'user-input-response' && next.type === 'user-input-response')) &&
    JSON.stringify(previous.actor) !== JSON.stringify(next.actor);
  const responsibleUserChanged =
    previous.type === 'user-input-request' &&
    next.type === 'user-input-request' &&
    previous.responsibleUserId !== next.responsibleUserId;
  const causationChanged =
    ((previous.type === 'approval-decision' && next.type === 'approval-decision') ||
      (previous.type === 'user-input-response' && next.type === 'user-input-response')) &&
    previous.causationId !== next.causationId;

  const ownerChanged =
    previous.owner.kind !== next.owner.kind ||
    (previous.owner.kind === 'workspace' &&
      next.owner.kind === 'workspace' &&
      previous.owner.workspaceId !== next.owner.workspaceId);
  if (ownerChanged || actorChanged || responsibleUserChanged || causationChanged) {
    throw new Error(`Item attribution cannot change: ${next.id}.`);
  }
}

/**
 * Parses and validates the canonical record graph shared by persistence and portability.
 *
 * @param input Raw workspace history and optional app-local record families.
 * @returns Parsed records with verified ownership, identity, revision, and event lineage.
 * @throws Error when records collide, disagree, or reference missing workspace state.
 */
export function parseCanonicalWorkspaceHistory(input: {
  workspace: unknown;
  threads: readonly unknown[];
  turns: readonly unknown[];
  itemRevisions: readonly unknown[];
  artifacts: readonly unknown[];
  knowledgeProposals?: readonly unknown[] | undefined;
  knowledgeProposalReviews?: readonly unknown[] | undefined;
  knowledgeSources?: readonly unknown[] | undefined;
  agentSessions: readonly unknown[];
  turnEvents: readonly (readonly [string, readonly unknown[]])[];
}): {
  workspace: WorkspaceRecord;
  threads: Thread[];
  turns: Turn[];
  itemRevisions: Item[];
  artifacts: Artifact[];
  knowledgeProposals: KnowledgeProposalRecord[];
  knowledgeProposalReviews: KnowledgeProposalReviewRecord[];
  knowledgeSources: KnowledgeSourceRecord[];
  agentSessions: AgentSession[];
  turnEvents: Array<[string, SseEventEnvelope[]]>;
} {
  const workspace = StoredWorkspaceSnapshotV1Schema.parse(input.workspace);
  const retained = <T>(record: unknown, known: T): T =>
    preserveDescriptiveRecord(record, known, known) as T;
  const threads = input.threads.map((record) =>
    retained(record, StoredThreadSnapshotV1Schema.parse(record))
  );
  const turns = input.turns.map((record) => retained(record, TurnReaderSchema.parse(record)));
  const itemRevisions = input.itemRevisions.map((record) =>
    retained(record, ItemReaderSchema.parse(record))
  );
  const artifacts = input.artifacts.map((record) => ArtifactReaderSchema.parse(record));
  const knowledgeProposals = (input.knowledgeProposals ?? []).map((record) =>
    parseRetainedKnowledgeProposal(record)
  );
  const knowledgeProposalReviews = (input.knowledgeProposalReviews ?? []).map((record) =>
    KnowledgeProposalReviewRecordSchema.parse(record)
  );
  const knowledgeSources = (input.knowledgeSources ?? []).map((record) =>
    KnowledgeSourceRecordSchema.parse(record)
  );
  const agentSessions = input.agentSessions.map(
    (record) => retained(record, AgentSessionRecordSchema.parse(record)) as AgentSession
  );
  const turnEvents = input.turnEvents.map(
    ([turnId, events]) =>
      [turnId, events.map((event) => retained(event, SseEventReaderSchema.parse(event)))] as [
        string,
        SseEventEnvelope[],
      ]
  );
  const threadIds = new Set<string>();
  const turnIds = new Set<string>();
  const artifactIds = new Set<string>();
  const proposalIds = new Set<string>();
  const proposalReviewIds = new Set<string>();
  const sourceIds = new Set<string>();
  const sessionIds = new Set<string>();
  const threadsById = new Map<string, Thread>();
  const turnsById = new Map<string, Turn>();
  const artifactsById = new Map<string, Artifact>();
  const proposalsById = new Map<string, KnowledgeProposalRecord>();
  const proposalReviewsById = new Map<string, KnowledgeProposalReviewRecord[]>();
  const sessionsById = new Map<string, AgentSession>();
  const currentSessionByThreadId = new Map<string, string>();
  const itemOrder: string[] = [];
  const latestItems = new Map<string, Item>();

  for (const thread of threads) {
    claimGlobalId(threadIds, thread.id, 'thread');
    if (workspaceIdForOwner(thread.owner) !== workspace.id) {
      throw new Error(`Thread ${thread.id} has invalid lineage.`);
    }
    threadsById.set(thread.id, thread);
  }
  for (const turn of turns) {
    claimGlobalId(turnIds, turn.id, 'turn');
    const thread = threadsById.get(turn.threadId);
    if (
      !thread ||
      workspaceIdForOwner(turn.owner) !== workspace.id ||
      workspaceIdForOwner(thread.owner) !== workspace.id
    ) {
      throw new Error(`Turn ${turn.id} has invalid lineage.`);
    }
    turnsById.set(turn.id, turn);
  }
  for (const item of itemRevisions) {
    const turn = turnsById.get(item.turnId);
    const previous = latestItems.get(item.id);
    if (
      !turn ||
      workspaceIdForOwner(item.owner) !== workspace.id ||
      item.threadId !== turn.threadId ||
      (previous &&
        (workspaceIdForOwner(previous.owner) !== workspaceIdForOwner(item.owner) ||
          previous.threadId !== item.threadId ||
          previous.turnId !== item.turnId ||
          previous.type !== item.type ||
          previous.createdAt !== item.createdAt))
    ) {
      throw new Error(`Item revision ${item.id} has invalid lineage.`);
    }
    if (previous) {
      assertImmutableItemAttribution(previous, item);
    }
    if (!previous) {
      itemOrder.push(item.id);
    }
    latestItems.set(item.id, item);
  }
  for (const turn of turns) {
    const expectedItems = itemOrder
      .map((itemId) => latestItems.get(itemId) as Item)
      .filter((item) => item.turnId === turn.id);
    if (
      new Set(turn.items.map((item) => item.id)).size !== turn.items.length ||
      turn.items.length !== expectedItems.length ||
      turn.items.some(
        (item, index) => JSON.stringify(item) !== JSON.stringify(expectedItems[index])
      )
    ) {
      throw new Error('Turn items must equal the latest canonical item revisions.');
    }
  }
  const artifactReferences = new Map<
    string,
    Array<Extract<Item, { type: 'artifact-reference' }>>
  >();
  const artifactReferenceTurns = new Set<string>();
  for (const item of latestItems.values()) {
    if (item.type !== 'artifact-reference') {
      continue;
    }
    const turnKey = JSON.stringify([item.artifactId, item.turnId]);
    if (artifactReferenceTurns.has(turnKey)) {
      throw new Error(
        `Artifact ${item.artifactId} has duplicate artifact-reference Items for Turn ${item.turnId}.`
      );
    }
    artifactReferenceTurns.add(turnKey);
    artifactReferences.set(item.artifactId, [
      ...(artifactReferences.get(item.artifactId) ?? []),
      item,
    ]);
  }
  for (const artifact of artifacts) {
    claimGlobalId(artifactIds, artifact.id, 'artifact');
    const thread = artifact.threadId ? threadsById.get(artifact.threadId) : null;
    const turn = artifact.turnId ? turnsById.get(artifact.turnId) : null;
    const references = artifactReferences.get(artifact.id) ?? [];
    const liveReferences = references.filter((reference) => reference.status !== 'declined');
    const completedReferences = liveReferences.filter(
      (reference) => reference.status === 'completed'
    );
    const producingReferences = completedReferences.filter(
      (reference) =>
        artifact.origin.kind === 'turn-output' &&
        reference.turnId === artifact.origin.turnId &&
        reference.artifactVersion === 1 &&
        reference.lastMutationRequestId === artifact.origin.requestId
    );
    const currentReferences = completedReferences.filter(
      (reference) =>
        reference.artifactVersion === artifact.version &&
        reference.lastMutationRequestId === artifact.lastMutationRequestId &&
        reference.title === artifact.title &&
        reference.summary === artifact.summary
    );
    const requiresCurrentReference = artifact.origin.kind === 'turn-output' || artifact.version > 1;
    // File identity is verified against its version-owned payload when loaded or
    // transferred; this record-only validator has no source filesystem authority.
    const contentDigest =
      artifact.content.format === 'file'
        ? artifact.contentDigest
        : `sha256:${createHash('sha256').update(artifact.content.body, 'utf8').digest('hex')}`;
    if (
      artifact.workspaceId !== workspace.id ||
      artifact.contentDigest !== contentDigest ||
      (artifact.threadId === null) !== (artifact.turnId === null) ||
      (artifact.threadId !== null && !thread) ||
      (artifact.turnId !== null &&
        (!turn ||
          artifact.threadId !== turn.threadId ||
          artifact.workspaceId !== workspaceIdForOwner(turn.owner))) ||
      (artifact.origin.kind === 'turn-output' && producingReferences.length !== 1) ||
      currentReferences.length > 1 ||
      (requiresCurrentReference && currentReferences.length !== 1)
    ) {
      throw new Error(`Artifact ${artifact.id} has invalid artifact-reference lineage.`);
    }
    artifactsById.set(artifact.id, artifact);
  }
  for (const references of artifactReferences.values()) {
    for (const reference of references) {
      if (reference.status === 'declined') {
        continue;
      }
      const artifact = artifactsById.get(reference.artifactId);
      const turn = turnsById.get(reference.turnId);
      if (reference.id !== artifactReferenceItemId(reference.artifactId, reference.turnId)) {
        throw new Error(
          `Artifact reference ${reference.id} does not use its deterministic identity.`
        );
      }
      if (
        !artifact ||
        workspaceIdForOwner(reference.owner) !== artifact.workspaceId ||
        !turn ||
        workspaceIdForOwner(turn.owner) !== artifact.workspaceId ||
        reference.threadId !== turn.threadId ||
        reference.artifactVersion > artifact.version
      ) {
        throw new Error(`Artifact reference ${reference.id} has invalid lineage.`);
      }
    }
  }
  for (const proposal of knowledgeProposals) {
    claimGlobalId(proposalIds, proposal.id, 'knowledge proposal');
    if (proposal.workspaceId !== workspace.id) {
      throw new Error(`Knowledge proposal ${proposal.id} has invalid lineage.`);
    }
    proposalsById.set(proposal.id, proposal);
  }
  for (const review of knowledgeProposalReviews) {
    claimGlobalId(proposalReviewIds, review.reviewId, 'knowledge proposal review');
    const proposal = proposalsById.get(review.proposalId);
    const proposalDigest = proposal
      ? `sha256:${createHash('sha256')
          .update(serializeKnowledgeProposalRecord(proposal), 'utf8')
          .digest('hex')}`
      : null;
    if (
      !proposal ||
      review.workspaceId !== workspace.id ||
      review.knowledgePageId !== proposal.knowledgePageId ||
      review.contentDigest !== proposal.contentDigest ||
      !isDeepStrictEqual(
        review.changedPageIds,
        proposal.changes?.map(({ path }) => path.slice(0, -3))
      ) ||
      review.proposalDigest !== proposalDigest
    ) {
      throw new Error(`Knowledge proposal review ${review.reviewId} has invalid lineage.`);
    }
    proposalReviewsById.set(review.proposalId, [
      ...(proposalReviewsById.get(review.proposalId) ?? []),
      review,
    ]);
  }
  for (const [proposalId, decisions] of proposalReviewsById) {
    KnowledgeProposalReviewFileSchema.parse({ proposalId, workspaceId: workspace.id, decisions });
  }
  for (const source of knowledgeSources) {
    claimGlobalId(sourceIds, source.id, 'knowledge source');
    const thread = source.originatingThreadId ? threadsById.get(source.originatingThreadId) : null;
    const turn = source.originatingTurnId ? turnsById.get(source.originatingTurnId) : null;
    if (
      source.workspaceId !== workspace.id ||
      (source.originatingThreadId !== null && !thread) ||
      (source.originatingTurnId !== null && (!turn || turn.threadId !== source.originatingThreadId))
    ) {
      throw new Error(`Knowledge source ${source.id} has invalid lineage.`);
    }
  }
  for (const session of agentSessions) {
    claimGlobalId(sessionIds, session.id, 'AgentSession');
    if (
      session.workspaceId !== workspace.id ||
      session.threadId === null ||
      !threadsById.has(session.threadId)
    ) {
      throw new Error(`AgentSession ${session.id} has invalid lineage.`);
    }
    if (isCurrentAgentSessionStatus(session.status)) {
      const currentSessionId = currentSessionByThreadId.get(session.threadId);
      if (currentSessionId) {
        throw new Error(
          `Thread ${session.threadId} has duplicate current AgentSessions: ${currentSessionId}, ${session.id}.`
        );
      }
      currentSessionByThreadId.set(session.threadId, session.id);
    }
    sessionsById.set(session.id, session);
  }
  for (const turn of turns) {
    if (turn.agentSessionId == null) continue;
    const session = sessionsById.get(turn.agentSessionId);
    if (!session || session.workspaceId !== workspace.id || session.threadId !== turn.threadId)
      throw new Error(`Turn ${turn.id} has invalid AgentSession lineage.`);
  }
  const eventTurnIds = new Set<string>();
  for (const [turnId, events] of turnEvents) {
    const turn = turnsById.get(turnId);
    if (!turn || eventTurnIds.has(turnId)) {
      throw new Error(`Turn events reference missing or duplicate canonical turn: ${turnId}`);
    }
    eventTurnIds.add(turnId);
    const turnItemIds = new Set(turn.items.map((item) => item.id));
    for (const [index, event] of events.entries()) {
      if (
        event.sequence !== index + 1 ||
        event.workspaceId !== workspace.id ||
        event.threadId !== turn.threadId ||
        event.turnId !== turn.id
      ) {
        throw new Error(`Turn event ${event.event} has invalid lineage for ${turnId}.`);
      }
      assertTurnEventPayloadLineage(event, workspace.id, turn.threadId, turn.id, turnItemIds);
      if (
        (event.data.type === 'agent-session-updated' &&
          !sessionsById.has(event.data.agentSession.id)) ||
        ((event.data.type === 'artifact-created' || event.data.type === 'artifact-updated') &&
          !artifactsById.has(event.data.artifact.id)) ||
        (event.data.type === 'item-delta' &&
          event.data.deltaKind === 'artifact-updated' &&
          !artifactsById.has(event.data.artifactId))
      ) {
        throw new Error(`Turn event ${event.event} references missing canonical state.`);
      }
    }
  }

  return {
    workspace,
    threads,
    turns,
    itemRevisions,
    artifacts,
    knowledgeProposals,
    knowledgeProposalReviews,
    knowledgeSources,
    agentSessions,
    turnEvents,
  };
}

/**
 * Rejects an identifier that cannot be used as one canonical path segment.
 *
 * @param value Candidate path segment.
 * @param label Human-readable identifier label.
 * @throws Error when the value is empty, special, or contains a path separator.
 */
export function assertSafeWorkspacePathSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${label} must be a safe path segment.`);
  }
}

/**
 * Reads exact canonical Knowledge Page bytes from one published immutable notebook revision.
 *
 * @param workspaceRoot Published workspace root.
 * @param knowledgePageId Slash-separated Knowledge Page id.
 * @param notebookRevision Exact published revision, or the revision pinned at this read.
 * @returns Exact UTF-8 page bytes, or null when the page is absent.
 */
export function readWorkspaceKnowledgePage(
  workspaceRoot: string,
  knowledgePageId: string,
  notebookRevision?: string
): string | null {
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  });
  const pinned = notebookRevision ?? notebook.publishedRevision();
  if (notebookRevision !== undefined) notebook.history({ revision: pinned, limit: 1 });
  const path = `${knowledgePageId}.md`;
  if (!Object.hasOwn(notebook.inspectRevision(pinned).entries, path)) return null;
  return notebook.readRevision(pinned, [path]).files[path] ?? null;
}

/**
 * Reads one canonical UTF-8 file without following a symbolic link.
 *
 * @param path Canonical file path.
 * @returns Complete UTF-8 file content.
 * @throws Error when the path is a symbolic link or not a regular file.
 */
export function readCanonicalTextFile(path: string): string {
  return readCanonicalFile(path).toString('utf8');
}

/**
 * Reads one canonical file buffer through a no-follow regular-file descriptor.
 *
 * @param path Canonical file path.
 * @returns Complete file bytes.
 * @throws Error when the path is a symbolic link or not a regular file.
 */
export function readCanonicalFile(path: string): Buffer {
  assertCanonicalRegularFile(path);
  let descriptor: number;

  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throwCanonicalLinkError(path, error);
  }

  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Canonical path must be a regular file: ${path}.`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Complete Workspace history projection joining native products and independently file-owned resources. */
export interface WorkspaceFileRecords {
  /** Workspace metadata. */
  readonly workspace: WorkspaceRecord;
  /** Exact canonical Notebook pages from the published Git revision. */
  readonly knowledge: readonly KnowledgeNotebookPage[];
  /** Workspace threads. */
  readonly threads: readonly Thread[];
  /** Workspace turns with reconstructed current items. */
  readonly turns: readonly Turn[];
  /** Full append-order item revision history. */
  readonly itemRevisions: readonly Item[];
  /** Workspace artifacts with reconstructed content bodies. */
  readonly artifacts: readonly Artifact[];
  /** Knowledge proposals. */
  readonly knowledgeProposals: readonly KnowledgeProposalRecord[];
  /** Knowledge proposal review decisions. */
  readonly knowledgeProposalReviews: readonly KnowledgeProposalReviewRecord[];
  /** Knowledge source registry records. */
  readonly knowledgeSources: readonly KnowledgeSourceRecord[];
  /** Durable AgentSessions. */
  readonly agentSessions: readonly AgentSession[];
  /** Retained turn event windows keyed by turn id. */
  readonly streamEvents: readonly (readonly [string, readonly SseEventEnvelope[]])[];
  /** Admission-time capture pairs keyed by Turn id; omitted Turns were never recorded. */
  readonly turnCaptureCoverage?: ReadonlyMap<string, CaptureCoverageBinding>;
}

/** File-owned resources exclude all activated native product metadata and histories. */
type FileOwnedWorkspaceRecords = Pick<
  WorkspaceFileRecords,
  'workspace' | 'artifacts' | 'knowledgeProposals' | 'knowledgeProposalReviews'
>;

/** One published Turn identity read without repairing canonical files. */
export interface PublishedTurnIdentity {
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceId: string;
}

/** Actual physical product and content binding; the locator never selects another owner. */
export interface NativeProductScope {
  readonly path: string;
  readonly owner: ControlProductOwner;
  readonly contentMount: ControlProductContentMount;
}

/** Resolves only native owner selectors; metadata reads do not require a content grant or byte mount. */
export function nativeProductMetadataScope(
  dataRoot: string,
  owner: ControlProductOwner,
  workspaceRoot?: string
): Pick<NativeProductScope, 'path' | 'owner'> {
  const root =
    owner.kind === 'workspace'
      ? (workspaceRoot ?? join(dataRoot, 'workspaces', owner.workspaceId))
      : join(dataRoot, 'server');
  return {
    path: join(root, 'db', owner.kind === 'workspace' ? 'workspace.sqlite' : 'core.sqlite'),
    owner,
  };
}

/** Resolves the existing native retained-work byte binding; canonical product retention does not depend on capture enablement or Knowledge authority. */
export function nativeProductScope(
  dataRoot: string,
  owner: ControlProductOwner,
  workspaceRoot?: string
): NativeProductScope {
  const root =
    owner.kind === 'workspace'
      ? (workspaceRoot ?? join(dataRoot, 'workspaces', owner.workspaceId))
      : join(dataRoot, 'server');
  return {
    path: join(root, 'db', owner.kind === 'workspace' ? 'workspace.sqlite' : 'core.sqlite'),
    owner,
    contentMount: {
      root: join(root, 'evidence', 'backend'),
      mount: 'backend-evidence',
      knowledgeBaseId: null,
    },
  };
}

const rawProductStatements = new WeakMap<
  ControlStoreProductReadHandle,
  Map<ControlProductKind, Database.Statement>
>();

/** Materializes one validated retained metadata row in a short read-only SQL snapshot. */
export function readNativeProduct(
  scope: Pick<NativeProductScope, 'path' | 'owner'>,
  kind: ControlProductKind,
  id: string,
  existingReader?: ControlStoreProductReadHandle
): ControlProductSnapshot | undefined {
  const reader = existingReader ?? openControlStoreProductReadHandle(scope.path, scope.owner);
  try {
    return reader.sqlite.transaction(() => {
      const known = reader.get(kind, id);
      if (!known) return undefined;
      const table = {
        workspace: 'control_workspaces',
        thread: 'control_threads',
        turn: 'control_turns',
        'agent-session': 'control_agent_sessions',
      }[kind];
      let prepared = rawProductStatements.get(reader);
      if (!prepared) {
        prepared = new Map();
        rawProductStatements.set(reader, prepared);
      }
      let statement = prepared.get(kind);
      if (!statement) {
        statement = reader.sqlite.prepare(`SELECT record_json FROM ${table} WHERE id=?`);
        prepared.set(kind, statement);
      }
      const raw = statement.get(id) as {
        record_json: string;
      };
      return {
        revision: known.revision,
        record: preserveDescriptiveRecord(
          JSON.parse(raw.record_json),
          known.record,
          known.record
        ) as Record<string, unknown>,
      };
    })();
  } finally {
    if (!existingReader) reader.close();
  }
}

/** Reads bounded native metadata pages; no cursor or transaction reaches a downstream consumer. */
export function listNativeProducts(
  scope: Pick<NativeProductScope, 'path' | 'owner'>,
  kind: ControlProductKind
): ControlProductSnapshot[] {
  const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
  const result: ControlProductSnapshot[] = [];
  try {
    let after = '';
    for (;;) {
      const page = reader.sqlite.transaction(() => {
        const known = reader.list(kind, after);
        const table = {
          workspace: 'control_workspaces',
          thread: 'control_threads',
          turn: 'control_turns',
          'agent-session': 'control_agent_sessions',
        }[kind];
        const rows = reader.sqlite
          .prepare(`SELECT id,record_json FROM ${table} WHERE id>? ORDER BY id LIMIT ?`)
          .all(after, CONTROL_PRODUCT_LIMITS.pageRows) as { id: string; record_json: string }[];
        const raw = new Map(rows.map((row) => [row.id, JSON.parse(row.record_json)]));
        return known.map((row) => ({
          revision: row.revision,
          record: preserveDescriptiveRecord(
            raw.get(row.record.id as string),
            row.record,
            row.record
          ) as Record<string, unknown>,
        }));
      })();
      if (!page.length) return result;
      result.push(...page);
      after = page.at(-1)!.record.id as string;
    }
  } finally {
    reader.close();
  }
}

/** Reads a complete native revision or transcript stream, with exact immutable proof on every row. */
export function readNativeProductEntries(
  scope: NativeProductScope,
  turnId: string,
  kind: 'item' | 'event'
) {
  const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
  const entries: Array<{ sequence: number; id: string; revision: number; value: unknown }> = [];
  try {
    const turn = reader.get('turn', turnId);
    if (!turn) return entries;
    let after = 0;
    for (;;) {
      const page = reader.entries(turnId, kind, after);
      if (!page.length) return entries;
      // The page SELECT has ended before any byte reads. Its descriptors remain immutable.
      for (const row of page) {
        if (row.sequence !== after + 1)
          throw new Error('Control product sequence is recovery_required.');
        const value = readImmutableProductJson(scope.contentMount, scope.owner, row.content);
        if (kind === 'item') {
          const item = readRetainedV1(value, StoredItemPayloadV1Schema.parse);
          if (scope.owner.kind === 'workspace')
            assertWorkspaceWorkOwner(item, scope.owner.workspaceId);
          if (
            !isDeepStrictEqual(item.owner, scope.owner) ||
            item.id !== row.id ||
            item.turnId !== turnId ||
            item.threadId !== turn.record.threadId
          )
            throw new Error('Native Item content lineage is recovery_required.');
        } else {
          const event = readRetainedV1<
            z.infer<typeof StoredServerEventV1Schema> | z.infer<typeof StoredEventV1Schema>
          >(value, (record) =>
            scope.owner.kind === 'server'
              ? StoredServerEventV1Schema.parse(record)
              : StoredEventV1Schema.parse(record)
          );
          if (
            event.turnId !== turnId ||
            event.threadId !== turn.record.threadId ||
            event.sequence !== row.sequence ||
            row.id !== `${turnId}:${event.sequence}` ||
            (scope.owner.kind === 'workspace'
              ? !('workspaceId' in event) || event.workspaceId !== scope.owner.workspaceId
              : !('owner' in event) || !isDeepStrictEqual(event.owner, scope.owner))
          )
            throw new Error('Native event content lineage is recovery_required.');
        }
        if (
          value &&
          typeof value === 'object' &&
          'requiredFeatures' in value &&
          (!Array.isArray(value.requiredFeatures) || value.requiredFeatures.length > 0)
        )
          throw new Error('Native product required semantics are unsupported.');
        entries.push({ sequence: row.sequence, id: row.id, revision: row.revision, value });
        after = row.sequence;
      }
    }
  } finally {
    reader.close();
  }
}

const turnWriteHeadStatements = new WeakMap<
  ControlStoreProductReadHandle,
  { tail: Database.Statement; item: Database.Statement }
>();

/** Reads fresh addressed append heads on the retained Workspace reader; Server reads retain their owned lifetime. */
export function readNativeTurnWriteHead(
  scope: NativeProductScope,
  turnId: string,
  itemId?: string
) {
  const reader =
    scope.owner.kind === 'workspace'
      ? getWorkspaceProductReadHandle(scope.path, scope.owner)
      : openControlStoreProductReadHandle(scope.path, scope.owner);
  let snapshot: ControlProductSnapshot | undefined;
  let sequence = 0;
  let eventSequence = 0;
  let entry: ReturnType<ControlStoreProductReadHandle['entries']>[number] | undefined;
  try {
    reader.sqlite.transaction(() => {
      snapshot = readNativeProduct(scope, 'turn', turnId, reader);
      if (!snapshot) return;
      let prepared = turnWriteHeadStatements.get(reader);
      if (!prepared) {
        prepared = {
          tail: reader.sqlite.prepare(
            'SELECT max(sequence) AS sequence FROM control_product_entries WHERE kind=? AND turn_id=?'
          ),
          item: reader.sqlite.prepare(
            "SELECT turn_id,sequence FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
          ),
        };
        turnWriteHeadStatements.set(reader, prepared);
      }
      const { tail } = prepared;
      sequence = (tail.get('item', turnId) as { sequence: number | null }).sequence ?? 0;
      eventSequence = (tail.get('event', turnId) as { sequence: number | null }).sequence ?? 0;
      if (itemId) {
        const row = prepared.item.get(itemId) as { turn_id: string; sequence: number } | undefined;
        if (row) {
          if (row.turn_id !== turnId) throw new Error(`Item already exists: ${itemId}`);
          entry = reader.entries(turnId, 'item', row.sequence - 1, 1)[0];
          if (!entry || entry.id !== itemId || entry.sequence !== row.sequence)
            throw new Error('Native Item head is recovery_required.');
        }
      }
    })();
  } finally {
    if (scope.owner.kind === 'server') reader.close();
  }
  if (!snapshot) return undefined;
  const metadata = StoredTurnV1Schema.parse(snapshot.record);
  // Sealed replay retains full history; a new addressed Item needs only fresh append heads.
  if (isSealedTurnTerminal(metadata.status) && (!itemId || entry !== undefined)) {
    const history = readNativeTurnHistory(scope, turnId);
    return history
      ? {
          ...history,
          itemRevision: history.itemRevisions.filter((item) => item.id === itemId).length,
          itemSequence: history.itemRevisions.length,
          eventSequence,
        }
      : undefined;
  }
  // All SQL snapshots end before immutable bytes are read or preparation can await.
  const items: Item[] = [];
  if (entry) {
    const value = readImmutableProductJson(scope.contentMount, scope.owner, entry.content);
    if (
      value &&
      typeof value === 'object' &&
      'requiredFeatures' in value &&
      (!Array.isArray(value.requiredFeatures) || value.requiredFeatures.length > 0)
    )
      throw new Error('Native product required semantics are unsupported.');
    const parsed = readRetainedV1(value, StoredItemPayloadV1Schema.parse);
    const { schemaVersion: _header, ...payload } = value as Record<string, unknown>;
    const item = preserveDescriptiveRecord(payload, parsed, parsed) as Item;
    if (
      !isDeepStrictEqual(item.owner, scope.owner) ||
      item.id !== itemId ||
      item.turnId !== turnId ||
      item.threadId !== metadata.threadId
    )
      throw new Error('Native Item head lineage is recovery_required.');
    items.push(item);
  }
  const {
    schemaVersion: _header,
    captureCoverage: _coverage,
    requiredFeatures: _features,
    ...payload
  } = snapshot.record;
  const turn = { ...payload, items } as Turn;
  TurnReaderSchema.parse(turn);
  return {
    revision: snapshot.revision,
    metadata: snapshot.record,
    turn,
    itemRevisions: items,
    itemRevision: entry?.revision ?? 0,
    itemSequence: sequence,
    eventSequence,
  };
}

/** Reconstructs current Items in original first-seen order and retains every native revision. */
export function readNativeTurnHistory(scope: NativeProductScope, turnId: string) {
  const snapshot = readNativeProduct(scope, 'turn', turnId);
  if (!snapshot) return undefined;
  const metadata = StoredTurnV1Schema.parse(snapshot.record);
  const items = new Map<string, Item>();
  const revisions: Item[] = [];
  const counts = new Map<string, number>();
  for (const row of readNativeProductEntries(scope, turnId, 'item')) {
    const parsed = readRetainedV1(row.value, StoredItemPayloadV1Schema.parse);
    const { schemaVersion: _header, ...payload } = row.value as Record<string, unknown>;
    const item = preserveDescriptiveRecord(payload, parsed, parsed) as Item;
    const previous = items.get(item.id);
    if (
      !isDeepStrictEqual(item.owner, scope.owner) ||
      item.turnId !== turnId ||
      item.threadId !== metadata.threadId ||
      row.id !== item.id ||
      row.revision !== (counts.get(item.id) ?? 0) + 1 ||
      (previous && (previous.type !== item.type || previous.createdAt !== item.createdAt))
    )
      throw new Error('Native Item revision lineage is recovery_required.');
    if (previous) assertImmutableItemAttribution(previous, item);
    if (
      item.type === 'user-input-request' &&
      item.responsibleUserId !== responsibleUserIdForActor(metadata.triggerActor)
    )
      throw new Error('Native user-input request attribution is recovery_required.');
    if (item.type === 'user-input-response') {
      const request = [...items.values()].find(
        (candidate) =>
          candidate.type === 'user-input-request' &&
          candidate.userInputRequestId === item.userInputRequestId
      );
      if (request?.type === 'user-input-request' && request.responsibleUserId !== item.actor.id)
        throw new Error('Native user-input response attribution is recovery_required.');
    }
    items.set(item.id, item);
    counts.set(item.id, row.revision);
    revisions.push(item);
  }
  const {
    schemaVersion: _header,
    captureCoverage: _coverage,
    requiredFeatures: _features,
    ...payload
  } = snapshot.record;
  const turn = { ...payload, items: [...items.values()] } as Turn;
  TurnReaderSchema.parse(turn);
  return {
    revision: snapshot.revision,
    metadata: snapshot.record,
    turn,
    itemRevisions: revisions,
    captureCoverage: metadata.captureCoverage ?? null,
  };
}

/** Reads complete ordered native transcript history and validates retained lineage. */
export function readNativeTurnEvents(
  scope: NativeProductScope,
  turn: Turn
): Array<SseEventEnvelope | ServerTurnEventEnvelope> {
  const itemIds = new Set(turn.items.map((item) => item.id));
  return readNativeProductEntries(scope, turn.id, 'event').map((row) => {
    const event = readRetainedV1<
      z.infer<typeof StoredServerEventV1Schema> | z.infer<typeof StoredEventV1Schema>
    >(row.value, (value) =>
      scope.owner.kind === 'server'
        ? StoredServerEventV1Schema.parse(value)
        : StoredEventV1Schema.parse(value)
    );
    if (
      row.revision !== 1 ||
      row.id !== `${turn.id}:${row.sequence}` ||
      event.sequence !== row.sequence ||
      event.threadId !== turn.threadId ||
      event.turnId !== turn.id ||
      event.event !== event.data.type.replaceAll('-', '.')
    )
      throw new Error('Native transcript lineage is recovery_required.');
    if (scope.owner.kind === 'workspace') {
      if (!('workspaceId' in event) || event.workspaceId !== scope.owner.workspaceId)
        throw new Error('Native transcript Workspace is recovery_required.');
      assertTurnEventPayloadLineage(
        event as SseEventEnvelope,
        scope.owner.workspaceId,
        turn.threadId,
        turn.id,
        itemIds
      );
    } else {
      if (!('owner' in event) || !isDeepStrictEqual(event.owner, scope.owner))
        throw new Error('Native transcript owner is recovery_required.');
      assertServerTurnEventLineage(
        event as Parameters<typeof assertServerTurnEventLineage>[0],
        turn
      );
    }
    const { schemaVersion: _header, ...payload } = row.value as Record<string, unknown>;
    const { schemaVersion: _knownHeader, ...known } = event;
    return preserveDescriptiveRecord(payload, known, known) as
      | SseEventEnvelope
      | ServerTurnEventEnvelope;
  });
}

/** Read-only result of scanning published Turn files. */
export type PublishedTurnIdentityRead =
  | { readonly status: 'readable'; readonly turns: readonly PublishedTurnIdentity[] }
  | { readonly status: 'unreadable' };

/** Read-only result of scanning published AgentSession ids. */
export type PublishedAgentSessionIdRead =
  | { readonly sessionIds: readonly string[]; readonly status: 'readable' }
  | { readonly status: 'unreadable' };

/** Reads native Turn selectors without body disclosure, file repair or layout creation. */
export function readPublishedTurnIdentities(dataRoot: string): PublishedTurnIdentityRead {
  try {
    const turns: PublishedTurnIdentity[] = [];
    for (const workspaceId of listDirectoryNames(join(dataRoot, 'workspaces'))) {
      if (workspaceId === '.staging') continue;
      const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
      if (!readNativeProduct(scope, 'workspace', workspaceId)) return { status: 'unreadable' };
      for (const row of listNativeProducts(scope, 'turn'))
        turns.push({
          workspaceId,
          threadId: row.record.threadId as string,
          turnId: row.record.id as string,
        });
    }
    return { status: 'readable', turns };
  } catch {
    return { status: 'unreadable' };
  }
}

/** Reads an admitted Turn from native metadata and exact immutable revision history. */
export function readPublishedTurnFileRecords(
  dataRoot: string,
  workspaceId: string,
  threadId: string,
  turnId: string
): {
  readonly turn: Turn;
  readonly itemRevisions: readonly Item[];
  readonly captureCoverage: CaptureCoverageBinding | null;
} | null {
  const history = readNativeTurnHistory(
    nativeProductScope(dataRoot, { kind: 'workspace', workspaceId }),
    turnId
  );
  if (!history || history.turn.threadId !== threadId) return null;
  verifyTurnFileInputs(join(dataRoot, 'workspaces', workspaceId), history.turn);
  return {
    turn: history.turn,
    itemRevisions: history.itemRevisions,
    captureCoverage: history.captureCoverage,
  };
}

/** Reads native AgentSession selectors and their actual Thread dependencies. */
export function readPublishedAgentSessionIds(
  dataRoot: string,
  workspaceId: string
): PublishedAgentSessionIdRead {
  try {
    const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
    const sessionIds = listNativeProducts(scope, 'agent-session').map((row) => {
      const session = AgentSessionRecordSchema.parse(row.record);
      if (!session.threadId || !readNativeProduct(scope, 'thread', session.threadId))
        throw new Error('Native AgentSession lineage is recovery_required.');
      return session.id;
    });
    return { status: 'readable', sessionIds };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * Loads admitted published Workspaces from canonical file records, refusing invalid scopes in place.
 *
 * @param dataRoot Data root that owns the Workspace tree.
 * @returns Valid records in directory order; disputed global identities exclude both owners.
 * @throws When the shared container or a Workspace identity is unsafe rather than an attributable record failure.
 */
export function loadWorkspaceFileRecords(
  dataRoot: string,
  workspaceId?: string
): WorkspaceFileRecords[] {
  // Snapshot validation owns one already-admitted target. Ordinary discovery retains the complete collision census below.
  if (workspaceId !== undefined) {
    assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
    if (!isScopeAdmitted(dataRoot, 'workspace', workspaceId))
      throw new Error('Workspace authority is refused.');
    return [loadWorkspace(join(dataRoot, 'workspaces', workspaceId), workspaceId)];
  }
  const workspacesRoot = join(dataRoot, 'workspaces');
  if (!lstatSync(workspacesRoot, { throwIfNoEntry: false })) return [];
  assertCanonicalDirectory(workspacesRoot);
  const records: WorkspaceFileRecords[] = [];
  for (const workspaceId of listDirectoryNames(workspacesRoot).filter(
    (name) => name !== '.staging'
  )) {
    assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
    if (!isScopeAdmitted(dataRoot, 'workspace', workspaceId)) continue;
    try {
      records.push(loadWorkspace(join(workspacesRoot, workspaceId), workspaceId));
    } catch (error) {
      if (error instanceof WorkOwnershipViolationError) throw error;
      refuseScope(dataRoot, { scope: 'workspace', id: workspaceId, check: 'records' });
    }
  }

  // A collision disputes both owners, not whichever one happened to load second.
  const owners = new Map<string, string>();
  for (const record of records) {
    const workspaceId = record.workspace.id;
    const identities = [
      ...record.threads.map(({ id }) => `thread:${id}`),
      ...record.turns.flatMap((turn) => [
        `turn:${turn.id}`,
        ...turn.items.map(({ id }) => `item:${id}`),
      ]),
      ...record.artifacts.map(({ id }) => `artifact:${id}`),
      ...record.knowledgeProposals.map(({ id }) => `proposal:${id}`),
      ...record.knowledgeSources.map(({ id }) => `source:${id}`),
      ...record.agentSessions.map(({ id }) => `session:${id}`),
    ];
    for (const identity of identities) {
      const previous = owners.get(identity);
      if (previous !== undefined) {
        refuseScope(dataRoot, { scope: 'workspace', id: previous, check: 'records' });
        refuseScope(dataRoot, { scope: 'workspace', id: workspaceId, check: 'records' });
      } else owners.set(identity, workspaceId);
    }
  }
  return records.filter((record) => isScopeAdmitted(dataRoot, 'workspace', record.workspace.id));
}

/** Discards abandoned private staging at Store startup, before any live admission. Read-only canonical inspection must never delete a concurrent capture. */
export function discardAbandonedWorkspaceStaging(dataRoot: string): void {
  const root = ensureLayoutDirectories(dataRoot).workspaces;
  assertCanonicalDirectory(root);
  rmSync(join(root, '.staging'), { recursive: true, force: true });
  const scopes = [
    join(dataRoot, 'server'),
    ...readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          WorkspaceIdSchema.safeParse(entry.name).success &&
          isScopeAdmitted(dataRoot, 'workspace', entry.name)
      )
      .map((entry) => join(root, entry.name)),
  ];
  for (const scope of scopes) {
    let directory = scope;
    // Only exact native roots are cleanup capabilities; links and refused scopes retain their bytes.
    for (const part of ['evidence', 'backend', 'sha256']) {
      const metadata = lstatSync(directory, { throwIfNoEntry: false });
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) break;
      directory = join(directory, part);
      const current = lstatSync(directory, { throwIfNoEntry: false });
      if (!current?.isDirectory() || current.isSymbolicLink()) break;
      if (part === 'backend' || part === 'sha256') {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (
            entry.isFile() &&
            /^\.[0-9a-f]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(
              entry.name
            )
          )
            rmSync(join(directory, entry.name));
        }
      }
    }
  }
}

/**
 * Writes only still-file-owned configuration, Artifacts and Knowledge Proposals under a resolved root.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param records Current workspace records.
 * @param updateWorkspaceConfigName Whether Core may refresh its owned config name.
 * @param initialArtifact Actual admitted v1 record and optional original for one initial directory publication.
 */
export function writeWorkspaceFileRecords(
  workspaceRoot: string,
  records: FileOwnedWorkspaceRecords,
  updateWorkspaceConfigName = false,
  initialArtifact?: { readonly record: ArtifactVersionRecord; readonly payloadPath?: string }
): void {
  assertSafeWorkspaceFileRecordIds(records);
  assertExistingWorkspaceDirectoryParents(workspaceRoot);
  ensureWorkspaceLayoutRoot(workspaceRoot);
  assertExistingWorkspaceDirectoryParents(workspaceRoot);
  writeWorkspaceConfiguration(workspaceRoot, records.workspace, updateWorkspaceConfigName);
  writeKnowledge(workspaceRoot, records);
  writeArtifacts(workspaceRoot, records, initialArtifact);
}

/**
 * Loads one workspace and every owned record family.
 *
 * @param workspaceRoot Published workspace root.
 * @param workspaceId Workspace directory id.
 * @returns Loaded canonical workspace records.
 */
function loadWorkspace(workspaceRoot: string, workspaceId: string): WorkspaceFileRecords {
  assertExistingWorkspaceDirectoryParents(workspaceRoot);
  const retiredWorkspacePath = join(workspaceRoot, 'workspace.json');
  const workspaceConfigPath = join(workspaceRoot, 'config', 'workspace.jsonc');

  if (existsSync(retiredWorkspacePath)) {
    throw new Error(`Unsupported canonical workspace file workspace.json: ${workspaceId}.`);
  }
  if (!existsSync(workspaceConfigPath)) {
    throw new Error(
      `Canonical workspace directory is missing config/workspace.jsonc: ${workspaceId}.`
    );
  }

  const productReader = openControlStoreProductReadHandle(
    join(workspaceRoot, 'db', 'workspace.sqlite'),
    { kind: 'workspace', workspaceId }
  );
  let workspaceRecord: z.infer<typeof WorkspaceSystemRecordSchema>;
  const threads: Thread[] = [];
  try {
    const native = productReader.get('workspace', workspaceId);
    if (!native)
      throw new Error(`Canonical Workspace metadata is missing from SQLite: ${workspaceId}.`);
    workspaceRecord = WorkspaceSystemRecordSchema.parse(native.record);
    let afterId = '';
    for (;;) {
      const page = productReader.list('thread', afterId);
      if (page.length === 0) break;
      for (const nativeThread of page) {
        assertWorkspaceWorkOwner(nativeThread.record, workspaceId);
        const thread = ThreadSchema.parse(nativeThread.record);
        if (workspaceIdForOwner(thread.owner) !== workspaceId) {
          throw new Error(`Thread record ${thread.id} has invalid workspace lineage.`);
        }
        threads.push(thread);
        afterId = thread.id;
      }
    }
  } finally {
    productReader.close();
  }
  const workspaceConfig = readRetainedV1(
    parseJsoncObject(readCanonicalTextFile(workspaceConfigPath), workspaceConfigPath),
    WorkspaceConfigSchema.parse
  );

  if (workspaceRecord.id !== workspaceId) {
    throw new Error(
      `Workspace record ${workspaceRecord.id} does not match its directory ${workspaceId}.`
    );
  }

  const scope = nativeProductScope(
    dirname(dirname(workspaceRoot)),
    { kind: 'workspace', workspaceId },
    workspaceRoot
  );
  const turns: Turn[] = [];
  const itemRevisions: Item[] = [];
  const streamEvents: Array<readonly [string, readonly SseEventEnvelope[]]> = [];
  const turnCaptureCoverage = new Map<string, CaptureCoverageBinding>();
  for (const snapshot of listNativeProducts(scope, 'turn')) {
    const history = readNativeTurnHistory(scope, snapshot.record.id as string)!;
    verifyTurnFileInputs(workspaceRoot, history.turn);
    turns.push(history.turn);
    itemRevisions.push(...history.itemRevisions);
    if (history.captureCoverage) turnCaptureCoverage.set(history.turn.id, history.captureCoverage);
    streamEvents.push([
      history.turn.id,
      readNativeTurnEvents(scope, history.turn) as SseEventEnvelope[],
    ]);
  }

  const threadIds = new Set(threads.map((thread) => thread.id));
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
  const artifacts = loadArtifacts(workspaceRoot, workspaceId, threadIds, turnsById);
  const knowledge = readWorkspaceKnowledgePages(workspaceRoot);
  const knowledgeProposals = loadKnowledgeProposals(workspaceRoot, workspaceId);
  const knowledgeProposalReviews = loadKnowledgeProposalReviews(
    workspaceRoot,
    workspaceId,
    new Map(knowledgeProposals.map((proposal) => [proposal.id, proposal]))
  );
  const knowledgeSources = loadKnowledgeSources(workspaceRoot, workspaceId, threadIds, turnsById);
  const agentSessions = listNativeProducts(scope, 'agent-session').map(
    (row) => AgentSessionRecordSchema.parse(row.record) as AgentSession
  );
  const workspace = WorkspaceRecordSchema.parse({
    ...workspaceRecord,
    name: workspaceConfig.workspace.name,
    counts: {
      threadCount: threads.length,
      artifactCount: artifacts.length,
      knowledgeEntryCount: knowledge.length,
    },
  });
  const history = parseCanonicalWorkspaceHistory({
    workspace,
    threads,
    turns,
    itemRevisions,
    artifacts,
    knowledgeProposals,
    knowledgeProposalReviews,
    knowledgeSources,
    agentSessions,
    turnEvents: streamEvents,
  });

  return {
    workspace: history.workspace,
    knowledge,
    threads: history.threads,
    turns: history.turns.map((turn) => TurnReaderSchema.parse(turn)),
    itemRevisions: history.itemRevisions.map((item) => ItemReaderSchema.parse(item)),
    artifacts: history.artifacts,
    knowledgeProposals: history.knowledgeProposals,
    knowledgeProposalReviews: history.knowledgeProposalReviews,
    knowledgeSources: history.knowledgeSources,
    agentSessions: history.agentSessions,
    streamEvents: history.turnEvents.map(([turnId, events]) => [
      turnId,
      events
        .slice(-TURN_STREAM_EVENT_WINDOW_SIZE)
        .map((event) => SseEventReaderSchema.parse(event)),
    ]),
    turnCaptureCoverage,
  };
}

/** Writes only authored Workspace configuration; native system metadata belongs to its separate SQL owner. */
export function writeWorkspaceConfiguration(
  workspaceRoot: string,
  workspace: WorkspaceRecord,
  updateWorkspaceConfigName: boolean
): void {
  const retiredWorkspacePath = join(workspaceRoot, 'workspace.json');
  const workspaceConfigPath = join(workspaceRoot, 'config', 'workspace.jsonc');

  if (existsSync(retiredWorkspacePath)) {
    throw new Error(`Unsupported canonical workspace file workspace.json: ${workspace.id}.`);
  }

  const configExists = existsSync(workspaceConfigPath);
  if (!configExists) {
    writeJsonAtomic(
      workspaceConfigPath,
      writeRetainedV1({
        workspace: {
          name: workspace.name,
          defaultAgentId: null,
        },
      })
    );
  } else if (updateWorkspaceConfigName) {
    const source = readCanonicalTextFile(workspaceConfigPath);
    const config = readRetainedV1(
      parseJsoncObject(source, workspaceConfigPath),
      WorkspaceConfigSchema.parse
    );
    if (config.workspace.name !== workspace.name) {
      const updated = applyEdits(
        source,
        modify(source, ['workspace', 'name'], workspace.name, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        })
      );
      WorkspaceConfigSchema.parse(parseJsoncObject(updated, workspaceConfigPath));
      writeFileAtomic(workspaceConfigPath, updated);
    }
  }
}

/**
 * Projects one public Workspace read model into its system-owned canonical record.
 *
 * @param workspace Joined public Workspace read model.
 * @returns System-owned Workspace record without editable or derived fields.
 */
export function projectWorkspaceSystemRecord(workspace: WorkspaceRecord) {
  const { name: _name, counts: _counts, ...record } = workspace;
  const known = WorkspaceSystemRecordSchema.parse(record);
  return preserveDescriptiveRecord(record, known, known) as typeof known;
}

/** Reads the complete native transcript, never a mutable event file. */
export function readWorkspaceTurnEvents(workspaceRoot: string, turn: Turn): SseEventEnvelope[] {
  return readNativeTurnEvents(
    nativeProductScope(dirname(dirname(workspaceRoot)), turn.owner, workspaceRoot),
    turn
  ) as SseEventEnvelope[];
}

/**
 * Verifies that identity-bearing event payloads match their owning turn log.
 *
 * @param event Validated event envelope.
 * @param workspaceId Owning workspace id.
 * @param threadId Owning thread id.
 * @param turnId Owning turn id.
 * @param itemIds Item ids owned by the turn.
 * @throws Error when a nested payload crosses canonical lineage.
 */
export function assertTurnEventPayloadLineage(
  event: SseEventEnvelope,
  workspaceId: string,
  threadId: string,
  turnId: string,
  itemIds: ReadonlySet<string>
): void {
  const data = event.data;
  let valid = true;

  switch (data.type) {
    case 'workspace-updated':
      valid = data.workspace.id === workspaceId;
      break;
    case 'thread-created':
    case 'thread-updated':
      valid = workspaceIdForOwner(data.thread.owner) === workspaceId && data.thread.id === threadId;
      break;
    case 'turn-started':
      valid = data.turnId === turnId;
      break;
    case 'turn-updated':
    case 'turn-completed':
      valid =
        workspaceIdForOwner(data.turn.owner) === workspaceId &&
        data.turn.threadId === threadId &&
        data.turn.id === turnId;
      break;
    case 'item-created':
      valid =
        workspaceIdForOwner(data.item.owner) === workspaceId &&
        data.item.threadId === threadId &&
        data.item.turnId === turnId &&
        itemIds.has(data.item.id);
      break;
    case 'item-completed':
      valid =
        workspaceIdForOwner(data.item.owner) === workspaceId &&
        data.item.threadId === threadId &&
        data.item.turnId === turnId &&
        data.itemId === data.item.id &&
        itemIds.has(data.item.id);
      break;
    case 'item-delta':
      valid = itemIds.has(data.itemId);
      break;
    case 'approval-requested':
    case 'approval-resolved':
      valid =
        data.approval.workspaceId === workspaceId &&
        data.approval.threadId === threadId &&
        data.approval.turnId === turnId;
      break;
    case 'agent-session-updated':
      valid =
        data.agentSession.workspaceId === workspaceId && data.agentSession.threadId === threadId;
      break;
    case 'artifact-created':
    case 'artifact-updated':
      valid =
        data.artifact.workspaceId === workspaceId &&
        data.artifact.threadId === threadId &&
        data.artifact.turnId === turnId;
      break;
    case 'error':
      break;
  }

  if (!valid) {
    throw new Error(`Turn event ${event.event} has invalid nested payload lineage for ${turnId}.`);
  }
}

/**
 * Reads one owned Knowledge Page without projecting or changing its canonical Markdown.
 *
 * @param path Bundle-relative page path used for validation diagnostics.
 * @param knowledgePageId Expected bundle-relative page id.
 * @param content Exact page bytes.
 * @returns Canonical page identity, bytes and exact-byte digest.
 * @throws Error when the file is not a valid owned page for the expected id.
 */
export function parseOwnedKnowledgePage(
  path: string,
  knowledgePageId: string,
  content: string
): KnowledgeNotebookPage {
  const parsed = parseOkfDocument({ path, content });
  const id = parsed.document?.frontmatter.openkit_entry_id;

  if (
    !parsed.ok ||
    !KnowledgeProposalPageIdSchema.safeParse(knowledgePageId).success ||
    path !== `${knowledgePageId}.md` ||
    (id !== undefined && id !== knowledgePageId) ||
    parsed.document.conceptId !== knowledgePageId
  ) {
    throw new Error(`Knowledge page ${knowledgePageId} is not a valid owned record.`);
  }

  const profile = validateOpenKitKnowledgeProfile(parsed.document);
  if (profile.conformance !== 'OpenKit-profile-valid' || profile.errors.length > 0) {
    throw new Error(`Knowledge page ${knowledgePageId} violates the OpenKit Knowledge Profile.`);
  }
  const sourceReferences = stringListFrontmatterField(parsed.document, 'source_refs');
  if (!sourceReferences || sourceReferences.some((reference) => reference.length === 0)) {
    throw new Error(`Knowledge page ${knowledgePageId} has invalid source_refs.`);
  }
  return KnowledgeNotebookPageSchema.parse({
    id: knowledgePageId,
    path,
    content,
    contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  });
}

/**
 * Lists bundle-relative Knowledge Page ids without following directory links.
 *
 * @param pagesRoot Current canonical directory to inspect.
 * @param prefix Bundle-relative directory prefix.
 * @returns Sorted page ids below the directory.
 */
export function listKnowledgePageIds(pagesRoot: string, prefix = ''): string[] {
  const direct = listFileNames(pagesRoot)
    .filter((name) => name.endsWith('.md') && name !== 'index.md' && name !== 'log.md')
    .map((name) => `${prefix}${name.slice(0, -'.md'.length)}`);
  const nested = listDirectoryNames(pagesRoot).flatMap((name) =>
    listKnowledgePageIds(join(pagesRoot, name), `${prefix}${name}/`)
  );

  const ids = [...direct, ...nested].sort();
  for (const id of ids) {
    if (!KnowledgeProposalPageIdSchema.safeParse(id).success) {
      throw new Error(`Knowledge Page id is invalid: ${id}.`);
    }
  }
  return ids;
}

/**
 * Reads the exact pages from one current immutable Notebook revision.
 *
 * @param workspaceRoot Published workspace root.
 * @returns Canonical pages in file-name order.
 */
export function readWorkspaceKnowledgePages(workspaceRoot: string): KnowledgeNotebookPage[] {
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  });
  const revision = notebook.publishedRevision();
  return Object.entries(notebook.readRevision(revision).files)
    .filter(([path]) => !['index.md', 'log.md'].includes(path.split('/').at(-1)!))
    .map(([path, content]) => parseOwnedKnowledgePage(path, path.slice(0, -3), content));
}

/**
 * Serializes one immutable Knowledge Proposal owner without review state.
 *
 * @param proposal Proposal tuple to serialize.
 * @returns Exact canonical proposal-file bytes.
 */
export function serializeKnowledgeProposalRecord(
  proposal: KnowledgeProposalRecord | Omit<KnowledgeProposalRecord, 'workspaceId'>
): string {
  const retained = (
    proposal as KnowledgeProposalRecord & {
      [retainedProposal]?: { bytes: string; core: KnowledgeProposalRecord };
    }
  )[retainedProposal];
  if (
    retained &&
    'workspaceId' in proposal &&
    isDeepStrictEqual(retained.core, KnowledgeProposalRecordSchema.parse(proposal))
  )
    return retained.bytes;
  return [
    '---',
    'type: "proposal"',
    'operation: "notebook-change"',
    `owner_scope: ${JSON.stringify(proposal.ownerScope)}`,
    `base_revision: ${JSON.stringify(proposal.baseRevision)}`,
    `candidate_revision: ${JSON.stringify(proposal.candidateRevision)}`,
    ...(proposal.changes
      ? [
          `changes: ${JSON.stringify(proposal.changes.map(({ path, content }) => ({ path, removed: content === null })))}`,
        ]
      : [`knowledge_page_id: ${JSON.stringify(proposal.knowledgePageId)}`]),
    `content_digest: ${JSON.stringify(proposal.contentDigest)}`,
    `source_references: ${JSON.stringify(proposal.sourceReferences)}`,
    `rationale: ${JSON.stringify(proposal.rationale)}`,
    ...(proposal.confidence === undefined
      ? []
      : [`confidence: ${JSON.stringify(proposal.confidence)}`]),
    'review_required: true',
    `producer: ${JSON.stringify(proposal.producer)}`,
    `created_at: ${JSON.stringify(proposal.createdAt)}`,
    '---',
    proposal.rationale,
  ].join('\n');
}

/**
 * Loads knowledge proposal Markdown records.
 *
 * @param workspaceRoot Published workspace root.
 * @param workspaceId Owning workspace id.
 * @returns Knowledge proposals in file-name order.
 */
function loadKnowledgeProposals(
  workspaceRoot: string,
  workspaceId: string
): KnowledgeProposalRecord[] {
  const root = join(workspaceRoot, 'knowledge', 'proposals');

  return listFileNames(root)
    .filter((name) => name.endsWith('.md'))
    .map((fileName) => {
      const path = join(root, fileName);
      const content = readCanonicalTextFile(path);
      const parsed = parseOkfDocument({ path, content });

      if (!parsed.ok) {
        throw new Error(`Knowledge proposal ${fileName} is invalid.`);
      }

      const id = fileName.slice(0, -'.md'.length);
      const sourceReferences = stringListFrontmatterField(parsed.document, 'source_references');
      const producerValue = parsed.document.frontmatter.producer;
      const confidenceValue = parsed.document.frontmatter.confidence;
      if (
        parsed.document.frontmatter.type !== 'proposal' ||
        parsed.document.frontmatter.operation !== 'notebook-change' ||
        parsed.document.frontmatter.review_required !== true ||
        sourceReferences === null ||
        typeof producerValue !== 'object' ||
        producerValue === null ||
        (parsed.document.frontmatter.changes === undefined && typeof confidenceValue !== 'number')
      ) {
        throw new Error(`Knowledge proposal ${id} has invalid immutable metadata.`);
      }

      const notebook = new KnowledgeNotebook({
        repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
      });
      const candidateRevision = requiredFrontmatterString(
        parsed.document,
        'candidate_revision',
        path
      );
      const baseRevision = requiredFrontmatterString(parsed.document, 'base_revision', path);
      const changedMetadata = parsed.document.frontmatter.changes;
      if (
        changedMetadata !== undefined &&
        (Object.hasOwn(parsed.document.frontmatter, 'knowledge_page_id') ||
          confidenceValue !== undefined)
      )
        throw new Error('Knowledge Proposal mixes candidate forms.');
      const knowledgePageId =
        changedMetadata === undefined
          ? requiredFrontmatterString(parsed.document, 'knowledge_page_id', path)
          : undefined;
      const candidate = notebook.retainedCandidate(id);
      if (
        candidate.revision !== candidateRevision ||
        candidate.parentRevision !== baseRevision ||
        candidate.metadata.authority.kind !== 'proposal' ||
        candidate.metadata.authority.proposalId !== id
      )
        throw new Error('Knowledge Proposal retained candidate is unavailable.');
      const candidateFiles = notebook.readRevision(candidateRevision).files;
      const baseFiles = notebook.readContent(baseRevision);
      const candidateContent = notebook.readContent(candidateRevision);
      const changes =
        changedMetadata === undefined
          ? undefined
          : [...new Set([...Object.keys(baseFiles), ...Object.keys(candidateContent)])]
              .sort()
              .filter((path) => baseFiles[path] !== candidateContent[path])
              .map((path) => ({ path, content: candidateContent[path] ?? null }));
      if (
        changes &&
        !isDeepStrictEqual(
          changedMetadata,
          changes.map(({ path, content }) => ({ path, removed: content === null }))
        )
      )
        throw new Error('Knowledge Proposal changed paths contradict its candidate.');
      const canonicalPageBytes = knowledgePageId
        ? candidateFiles[`${knowledgePageId}.md`]
        : undefined;
      const proposal = KnowledgeProposalRecordSchema.parse({
        id,
        workspaceId,
        operation: 'notebook-change',
        ownerScope: parsed.document.frontmatter.owner_scope,
        baseRevision,
        candidateRevision,
        ...(changes ? { changes } : { knowledgePageId, canonicalPageBytes }),
        contentDigest: requiredFrontmatterString(parsed.document, 'content_digest', path),
        sourceReferences,
        rationale: requiredFrontmatterString(parsed.document, 'rationale', path),
        ...(changes ? {} : { confidence: confidenceValue }),
        producer: producerValue,
        createdAt: requiredFrontmatterString(parsed.document, 'created_at', path),
      });
      const candidateDigest = `sha256:${createHash('sha256')
        .update(
          proposal.changes ? JSON.stringify(proposal.changes) : proposal.canonicalPageBytes!,
          'utf8'
        )
        .digest('hex')}`;
      if (
        proposal.contentDigest !== candidateDigest ||
        !isDeepStrictEqual(proposal.ownerScope, { kind: 'workspace', workspaceId }) ||
        !isDeepStrictEqual(candidate.metadata.producer, proposal.producer)
      ) {
        throw new Error(`Knowledge proposal ${id} does not preserve its canonical bytes.`);
      }
      Object.defineProperty(proposal, retainedProposal, {
        value: { bytes: content, core: structuredClone(proposal) },
      });
      return proposal;
    });
}

/**
 * Loads knowledge proposal review JSON records.
 *
 * @param workspaceRoot Published workspace root.
 * @param workspaceId Owning workspace id.
 * @param proposalsById Known proposals by id.
 * @returns Proposal reviews in file-name order.
 */
function loadKnowledgeProposalReviews(
  workspaceRoot: string,
  workspaceId: string,
  proposalsById: ReadonlyMap<string, KnowledgeProposalRecord>
): KnowledgeProposalReviewRecord[] {
  const root = join(workspaceRoot, 'knowledge', 'reviews');

  return listFileNames(root)
    .filter((name) => name.endsWith('.json'))
    .flatMap((fileName) => {
      const reviewFile = KnowledgeProposalReviewFileSchema.parse(readJson(join(root, fileName)));
      const proposal = proposalsById.get(reviewFile.proposalId);

      if (
        fileName !== `${reviewFile.proposalId}.json` ||
        reviewFile.workspaceId !== workspaceId ||
        !proposal
      ) {
        throw new Error(`Knowledge proposal review ${fileName} has invalid lineage.`);
      }

      const proposalDigest = `sha256:${createHash('sha256')
        .update(serializeKnowledgeProposalRecord(proposal), 'utf8')
        .digest('hex')}`;
      for (const review of reviewFile.decisions) {
        if (
          review.proposalDigest !== proposalDigest ||
          review.knowledgePageId !== proposal.knowledgePageId ||
          review.contentDigest !== proposal.contentDigest
        ) {
          throw new Error(`Knowledge proposal review ${review.reviewId} has invalid lineage.`);
        }
      }
      return reviewFile.decisions;
    });
}

/**
 * Loads knowledge source registry JSON records.
 *
 * @param workspaceRoot Published workspace root.
 * @param workspaceId Owning workspace id.
 * @param threadIds Known thread ids.
 * @param turnsById Known turns by id.
 * @returns Knowledge source records in file-name order.
 */
function loadKnowledgeSources(
  workspaceRoot: string,
  workspaceId: string,
  threadIds: ReadonlySet<string>,
  turnsById: ReadonlyMap<string, Turn>
): KnowledgeSourceRecord[] {
  const sources = [
    ...readSourcePointers({
      dataRoot: dirname(dirname(workspaceRoot)),
      ownerScope: { kind: 'workspace', workspaceId },
    }).values(),
  ].map(({ source }) => KnowledgeSourceRecordSchema.parse({ ...source, workspaceId }));
  for (const source of sources)
    if (
      (source.originatingThreadId !== null && !threadIds.has(source.originatingThreadId)) ||
      (source.originatingTurnId !== null &&
        turnsById.get(source.originatingTurnId)?.threadId !== source.originatingThreadId)
    )
      throw new Error(`Knowledge Source ${source.id} has invalid lineage.`);

  return sources;
}

/**
 * Loads artifacts and reconstructs their content bodies.
 *
 * @param workspaceRoot Published workspace root.
 * @param workspaceId Owning workspace id.
 * @param threadIds Known thread ids.
 * @param turnsById Known turns by id.
 * @returns Artifacts in directory-name order.
 */
function loadArtifacts(
  workspaceRoot: string,
  workspaceId: string,
  threadIds: ReadonlySet<string>,
  turnsById: ReadonlyMap<string, Turn>
): Artifact[] {
  const root = join(workspaceRoot, 'artifacts');

  return listDirectoryNames(root).map((artifactId) => {
    const artifactRoot = join(root, artifactId);
    const metadataPath = join(artifactRoot, 'artifact.json');

    if (!existsSync(metadataPath)) {
      throw new Error(`Canonical artifact directory is missing artifact.json: ${artifactId}.`);
    }

    const rawMetadata = readRetainedV1(
      readJson(metadataPath),
      (record) => record as Record<string, unknown>
    );
    const metadataContent = rawMetadata.content as { body?: unknown; format?: unknown } | undefined;
    const format = metadataContent?.format;

    if (metadataContent && Object.hasOwn(metadataContent, 'body')) {
      throw new Error(`Canonical artifact metadata must not embed content body: ${artifactId}.`);
    }

    if (format !== 'markdown' && format !== 'text' && format !== 'json' && format !== 'file') {
      throw new Error(`Artifact ${artifactId} has an invalid content format.`);
    }

    const metadata = StoredArtifactV1Schema.parse(rawMetadata);
    // Disposable projections can be absent, but retained paths must still be canonical.
    if (format !== 'file') {
      const filesRoot = join(artifactRoot, 'files');
      if (lstatSync(filesRoot, { throwIfNoEntry: false })) {
        assertCanonicalDirectory(filesRoot);
        const projectionPath = join(filesRoot, artifactContentFileName(format));
        if (lstatSync(projectionPath, { throwIfNoEntry: false }))
          assertCanonicalRegularFile(projectionPath);
      }
    }
    const selectedVersion = metadata.version;
    if (!Number.isSafeInteger(selectedVersion) || Number(selectedVersion) < 1)
      throw new Error(`Artifact ${artifactId} has an invalid current version.`);
    let artifact: Artifact;
    try {
      const retained = readArtifactVersionRecord(
        workspaceRoot,
        artifactId,
        Number(selectedVersion)
      ).artifact;
      artifact = ArtifactReaderSchema.parse({
        ...metadata,
        content:
          format === 'file'
            ? metadataContent
            : {
                ...metadataContent,
                body: retained.content.format === 'file' ? undefined : retained.content.body,
              },
      });
      if (
        !isDeepStrictEqual(
          { ...retained, status: artifact.status, updatedAt: artifact.updatedAt },
          artifact
        )
      )
        throw new Error(`Artifact ${artifactId} current-head projection is contradictory.`);
    } catch (cause) {
      throw Object.assign(
        new Error('The retained Artifact version history is unavailable or contradictory.', {
          cause,
        }),
        { code: 'recovery_required' }
      );
    }

    if (
      artifact.id !== artifactId ||
      artifact.workspaceId !== workspaceId ||
      (artifact.threadId !== null && !threadIds.has(artifact.threadId)) ||
      (artifact.turnId !== null && turnsById.get(artifact.turnId)?.threadId !== artifact.threadId)
    ) {
      throw new Error(`Artifact ${artifactId} has invalid lineage.`);
    }

    return artifact;
  });
}

/**
 * Validates every record id used to derive a canonical file or directory path.
 *
 * @param records Workspace records about to be published.
 * @throws Error when an id is not a safe canonical owner path.
 */
function assertSafeWorkspaceFileRecordIds(records: FileOwnedWorkspaceRecords): void {
  assertSafeWorkspacePathSegment(records.workspace.id, 'Workspace id');
  for (const proposal of records.knowledgeProposals)
    assertSafeWorkspacePathSegment(proposal.id, 'Knowledge proposal id');
  for (const review of records.knowledgeProposalReviews)
    assertSafeWorkspacePathSegment(review.proposalId, 'Knowledge proposal review id');
  for (const artifact of records.artifacts)
    assertSafeWorkspacePathSegment(artifact.id, 'Artifact id');
}

/**
 * Rejects canonical directory parents that would redirect writes through a link.
 *
 * @param workspaceRoot Resolved workspace root.
 * @throws Error when an existing canonical directory parent is a link or non-directory.
 */
function assertExistingWorkspaceDirectoryParents(workspaceRoot: string): void {
  for (const path of [
    workspaceRoot,
    join(workspaceRoot, 'threads'),
    join(workspaceRoot, 'knowledge'),
    join(workspaceRoot, 'sources'),
    join(workspaceRoot, 'artifacts'),
    join(workspaceRoot, 'reviews'),
    join(workspaceRoot, 'runtime'),
    join(workspaceRoot, 'runtime', 'agent-sessions'),
  ]) {
    if (lstatSync(path, { throwIfNoEntry: false })) {
      assertCanonicalDirectory(path);
    }
  }
}

/**
 * Publishes one absent record directory by renaming a same-filesystem staging directory.
 *
 * A crash before the rename leaves only `workspaces/.staging`, which the next load deletes.
 * Callers update an existing destination in place. This function does not delete a destination.
 *
 * @param workspaceRoot Resolved workspace root. Staging is created beside that root.
 * @param destination Absent canonical directory.
 * @param writeContents Writes the complete directory under the staging path.
 */
export function publishNewRecordDirectory(
  workspaceRoot: string,
  destination: string,
  writeContents: (directory: string) => void
): void {
  const stagingRoot = join(dirname(workspaceRoot), '.staging', `record-${randomUUID()}`);
  const stagingParent = dirname(stagingRoot);

  mkdirSync(stagingParent, { recursive: true });
  assertCanonicalDirectory(stagingParent);
  try {
    mkdirSync(stagingRoot, { mode: 0o700 });
    assertCanonicalDirectory(stagingRoot);
    try {
      writeContents(stagingRoot);
    } catch (error) {
      // A staged leaf is not a published record. Its failure leaves the canonical owner absent.
      if (error instanceof CanonicalPublicationError) throw error.cause;
      throw error;
    }
    publishCanonicalPath(stagingRoot, destination);
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Publishes only original inputs before native Turn admission; metadata and histories never enter files. */
export function publishTurnFileInputs(
  workspaceRoot: string,
  turn: Turn,
  sources?: readonly string[]
): void {
  if (!turn.fileInputs?.length) return;
  if (!sources || sources.length !== turn.fileInputs.length)
    throw new Error('Turn input publication requires its exact private originals.');
  const root = join(workspaceRoot, 'threads', turn.threadId, 'turns', turn.id);
  ensureCanonicalDirectory(dirname(root));
  if (existsSync(root))
    throw new Error('Turn input destination already exists; inspection is required.');
  publishNewRecordDirectory(workspaceRoot, root, (stage) => {
    for (const [ordinal, input] of turn.fileInputs!.entries()) {
      const measured = measureCanonicalFile(sources[ordinal]!);
      if (measured.byteLength !== input.sizeBytes || measured.contentDigest !== input.contentDigest)
        throw new Error('Turn original input is recovery_required.');
      const destination = join(stage, 'inputs', String(ordinal), 'payload');
      ensureCanonicalDirectory(dirname(destination));
      publishCanonicalPath(sources[ordinal]!, destination);
    }
  });
  verifyTurnFileInputs(workspaceRoot, turn);
}

/** Resolves one stable input ordinal under its exact receiving Turn. Names are never path segments. */
export function turnFilePayloadPath(
  workspaceRoot: string,
  threadId: string,
  turnId: string,
  ordinal: number
): string {
  assertSafeWorkspacePathSegment(threadId, 'Input Thread id');
  assertSafeWorkspacePathSegment(turnId, 'Input Turn id');
  if (!Number.isSafeInteger(ordinal) || ordinal < 0)
    throw new Error('Turn input ordinal is invalid.');
  return join(
    workspaceRoot,
    'threads',
    threadId,
    'turns',
    turnId,
    'inputs',
    String(ordinal),
    'payload'
  );
}

/** Proves exactly one addressed canonical original, without rescanning other Turn inputs. */
export function verifyTurnFileInput(workspaceRoot: string, turn: Turn, ordinal: number): void {
  const input =
    Number.isSafeInteger(ordinal) && ordinal >= 0 ? turn.fileInputs?.[ordinal] : undefined;
  if (!input) throw new Error('Turn input original is unavailable.');
  const path = turnFilePayloadPath(workspaceRoot, turn.threadId, turn.id, ordinal);
  let parent = dirname(path);
  for (let level = 0; level < 7; level += 1) {
    assertCanonicalDirectory(parent);
    parent = dirname(parent);
  }
  assertCanonicalRegularFile(path);
  if (lstatSync(path).nlink !== 1)
    throw new Error('Turn input original must have one canonical owner.');
  const measured = measureCanonicalFile(path);
  if (measured.byteLength !== input.sizeBytes || measured.contentDigest !== input.contentDigest)
    throw new Error('Turn original input is recovery_required.');
}

/** Proves retained originals before replay, restart, export, or imported publication can use their inventory. */
export function verifyTurnFileInputs(workspaceRoot: string, turn: Turn): void {
  for (const ordinal of (turn.fileInputs ?? []).keys())
    verifyTurnFileInput(workspaceRoot, turn, ordinal);
}

/** Publishes one complete new file-backed Artifact directory through the existing P01 tree owner. The exact payload and descriptor are staged together, so process loss cannot expose a canonical directory with missing metadata. No reference Item or command receipt is written here. */
export function publishArtifactFileRecord(input: {
  readonly workspaceRoot: string;
  readonly record: ArtifactVersionRecord;
  readonly payloadPath: string;
}): void {
  const record = ArtifactVersionRecordSchema.parse(input.record);
  const artifact = record.artifact;
  if (artifact.version !== 1)
    throw new Error('Initial Artifact publication requires its exact admitted v1 record.');
  if (artifact.content.format !== 'file') throw new Error('A file descriptor is required.');
  const destination = artifactFilePayloadPath(input.workspaceRoot, artifact.id, artifact.version);
  const artifactRoot = join(input.workspaceRoot, 'artifacts', artifact.id);
  ensureCanonicalDirectory(dirname(artifactRoot));
  if (lstatSync(artifactRoot, { throwIfNoEntry: false }))
    throw new Error('The immutable Artifact already exists.');
  publishNewRecordDirectory(input.workspaceRoot, artifactRoot, (stage) => {
    stageArtifactVersionRecord(join(stage, 'versions', '1'), input.record, input.payloadPath);
    writeArtifactDirectory(stage, artifact);
  });
  // Keep the path guard above coupled to the same immutable owner spelling.
  assertCanonicalRegularFile(destination);
}

/**
 * Writes one Artifact directory's metadata and body.
 *
 * @param artifactRoot Existing Artifact directory, either canonical or staged.
 * @param artifact Artifact record to write.
 */
function writeArtifactDirectory(artifactRoot: string, artifact: Artifact): void {
  if (artifact.content.format === 'file') {
    ensureCanonicalDirectory(artifactRoot);
    const payload = join(artifactRoot, 'versions', String(artifact.version), 'payload');
    assertCanonicalRegularFile(payload);
    if (lstatSync(payload).size !== artifact.content.byteLength) {
      throw new Error('The Artifact file payload length is inconsistent.');
    }
    writeRetainedDescriptiveJson(
      join(artifactRoot, 'artifact.json'),
      artifact,
      StoredArtifactV1Schema
    );
    return;
  }
  const filesRoot = join(artifactRoot, 'files');
  const contentFileName = artifactContentFileName(artifact.content.format);

  ensureCanonicalDirectory(artifactRoot);
  ensureCanonicalDirectory(filesRoot);
  for (const staleFileName of ['content.md', 'content.txt', 'content.json']) {
    if (staleFileName !== contentFileName) {
      rmSync(join(filesRoot, staleFileName), { force: true });
    }
  }
  writeRetainedDescriptiveJson(
    join(artifactRoot, 'artifact.json'),
    {
      ...artifact,
      content: { format: artifact.content.format },
    },
    StoredArtifactV1Schema
  );
  writeFileAtomic(join(filesRoot, contentFileName), artifact.content.body);
}

/**
 * Writes separate Knowledge Proposal and Review owners without changing notebook content.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param records Current workspace records.
 */
function writeKnowledge(workspaceRoot: string, records: FileOwnedWorkspaceRecords): void {
  const proposalsRoot = join(workspaceRoot, 'knowledge', 'proposals');
  const reviewsRoot = join(workspaceRoot, 'knowledge', 'reviews');
  const expectedProposals = new Set(records.knowledgeProposals.map((record) => `${record.id}.md`));
  const expectedReviews = new Set(
    records.knowledgeProposalReviews.map((record) => `${record.proposalId}.json`)
  );
  const reviewsByProposal = new Map<string, KnowledgeProposalReviewRecord[]>();
  for (const review of records.knowledgeProposalReviews)
    reviewsByProposal.set(review.proposalId, [
      ...(reviewsByProposal.get(review.proposalId) ?? []),
      review,
    ]);
  ensureCanonicalDirectory(proposalsRoot);
  ensureCanonicalDirectory(reviewsRoot);
  removeStaleFiles(proposalsRoot, expectedProposals, '.md');
  const existingProposals = new Map(
    loadKnowledgeProposals(workspaceRoot, records.workspace.id).map((proposal) => [
      proposal.id,
      proposal,
    ])
  );
  for (const proposal of records.knowledgeProposals) {
    const previous = existingProposals.get(proposal.id);
    if (previous) {
      if (
        !isDeepStrictEqual(
          KnowledgeProposalRecordSchema.parse(previous),
          KnowledgeProposalRecordSchema.parse(proposal)
        )
      )
        throw new Error(`Knowledge proposal ${proposal.id} changed immutable content.`);
      continue;
    }
    writeFileAtomic(
      join(proposalsRoot, `${proposal.id}.md`),
      serializeKnowledgeProposalRecord(proposal)
    );
  }
  removeStaleFiles(reviewsRoot, expectedReviews, '.json');
  for (const [proposalId, decisions] of reviewsByProposal)
    writeOwnedDescriptiveJson(
      join(reviewsRoot, `${proposalId}.json`),
      { proposalId, workspaceId: decisions[0]!.workspaceId, decisions },
      KnowledgeProposalReviewFileSchema
    );
}

/** Normalizes a Proposal without losing its already verified immutable source bytes. */
function parseRetainedKnowledgeProposal(value: unknown): KnowledgeProposalRecord {
  const proposal = KnowledgeProposalRecordSchema.parse(value);
  if (typeof value === 'object' && value !== null) {
    const retained = (value as { [retainedProposal]?: unknown })[retainedProposal];
    if (retained) Object.defineProperty(proposal, retainedProposal, { value: retained });
  }
  return proposal;
}

/**
 * Writes artifact metadata and bodies.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param records Current workspace records.
 * @param initialArtifact Actual admitted v1 record for an absent Artifact directory.
 */
function writeArtifacts(
  workspaceRoot: string,
  records: FileOwnedWorkspaceRecords,
  initialArtifact?: { readonly record: ArtifactVersionRecord; readonly payloadPath?: string }
): void {
  const artifactsRoot = join(workspaceRoot, 'artifacts');
  const expectedArtifactIds = new Set(records.artifacts.map((artifact) => artifact.id));

  ensureCanonicalDirectory(artifactsRoot);
  removeStaleDirectories(artifactsRoot, expectedArtifactIds);

  if (initialArtifact) {
    const record = ArtifactVersionRecordSchema.parse(initialArtifact.record);
    if (
      record.artifact.version !== 1 ||
      record.artifact.workspaceId !== records.workspace.id ||
      !records.artifacts.some((artifact) => isDeepStrictEqual(artifact, record.artifact))
    )
      throw new Error('Initial Artifact publication requires its exact admitted v1 record.');
    if (lstatSync(join(artifactsRoot, record.artifact.id), { throwIfNoEntry: false }))
      throw new Error('The immutable Artifact already exists.');
  }
  for (const artifact of records.artifacts) {
    const artifactRoot = join(artifactsRoot, artifact.id);
    if (lstatSync(artifactRoot, { throwIfNoEntry: false })) {
      const retained = readArtifactVersionRecord(
        workspaceRoot,
        artifact.id,
        artifact.version
      ).artifact;
      if (
        !isDeepStrictEqual(
          { ...retained, status: artifact.status, updatedAt: artifact.updatedAt },
          artifact
        )
      )
        throw new Error('The Artifact current-head projection is contradictory.');
      writeArtifactDirectory(artifactRoot, artifact);
      continue;
    }
    if (!initialArtifact || initialArtifact.record.artifact.id !== artifact.id)
      throw new Error('Initial Artifact publication requires its admitted immutable version.');
    if (artifact.content.format === 'file') {
      if (!initialArtifact.payloadPath)
        throw new Error('Artifact file publication requires its admitted original.');
      publishArtifactFileRecord({
        workspaceRoot,
        record: initialArtifact.record,
        payloadPath: initialArtifact.payloadPath,
      });
      continue;
    }
    publishNewRecordDirectory(workspaceRoot, artifactRoot, (stage) => {
      stageArtifactVersionRecord(
        join(stage, 'versions', '1'),
        initialArtifact.record,
        initialArtifact.payloadPath
      );
      writeArtifactDirectory(stage, artifact);
    });
  }
}

/**
 * Returns the canonical content file for one artifact format.
 *
 * @param format Artifact content format.
 * @returns Artifact content file name.
 */
export function artifactContentFileName(format: Artifact['content']['format']): string {
  return format === 'markdown' ? 'content.md' : format === 'text' ? 'content.txt' : 'content.json';
}

/**
 * Reads one JSON file.
 *
 * @param path JSON file path.
 * @returns Parsed JSON value.
 */
function readJson(path: string): unknown {
  return JSON.parse(readCanonicalTextFile(path)) as unknown;
}

/**
 * Reads non-empty JSONL rows from one optional file.
 *
 * @param path JSONL file path.
 * @param repairFinalFragment Whether to drop one syntactically incomplete final fragment.
 * @returns Parsed row values.
 */
export function readCanonicalJsonLines(path: string, repairFinalFragment = false): unknown[] {
  const metadata = lstatSync(path, { throwIfNoEntry: false });

  if (!metadata) {
    return [];
  }

  const content = readCanonicalFile(path);
  const values: unknown[] = [];
  let rowStart = 0;

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== 0x0a) {
      continue;
    }
    const row = content.subarray(rowStart, index);
    if (row.length > 0) {
      values.push(JSON.parse(row.toString('utf8')) as unknown);
    }
    rowStart = index + 1;
  }

  if (rowStart < content.length) {
    const finalRow = content.subarray(rowStart);
    const finalRowText = finalRow.toString('utf8');
    try {
      values.push(JSON.parse(finalRowText) as unknown);
    } catch (error) {
      if (!repairFinalFragment || !isIncompleteJsonFragment(error, finalRowText)) {
        throw error;
      }
      writeFileAtomic(path, content.subarray(0, rowStart));
      return values;
    }

    if (repairFinalFragment) {
      writeFileAtomic(path, Buffer.concat([content, Buffer.from('\n')]));
    }
  }

  return values;
}

/**
 * Distinguishes an interrupted JSON tail from a complete malformed token.
 *
 * @param error JSON parser error.
 * @param fragment Unterminated final row text.
 * @returns True only when parsing stopped at the physical end of the fragment.
 */
function isIncompleteJsonFragment(error: unknown, fragment: string): boolean {
  if (!(error instanceof SyntaxError)) {
    return false;
  }
  if (/unexpected end|unterminated/i.test(error.message)) {
    return true;
  }
  const position = /position (\d+)/i.exec(error.message)?.[1];
  return position !== undefined && Number(position) >= fragment.length;
}

/**
 * Ensures an existing append log ends at a complete newline-delimited record.
 *
 * @param path Canonical append-log path.
 */
function normalizeAppendBoundary(path: string): void {
  const metadata = lstatSync(path, { throwIfNoEntry: false });

  if (!metadata) {
    return;
  }

  assertCanonicalRegularFile(path);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  let incomplete = false;
  try {
    const current = fstatSync(descriptor);
    if (!current.isFile()) throw new Error(`Canonical path must be a regular file: ${path}.`);
    // Completed logs need only their last byte; full parsing is reserved for tail recovery.
    if (current.size > 0) {
      const tail = Buffer.allocUnsafe(1);
      if (readSync(descriptor, tail, 0, 1, current.size - 1) !== 1)
        throw new Error(`Canonical append boundary could not be read: ${path}.`);
      incomplete = tail[0] !== 0x0a;
    }
  } finally {
    closeSync(descriptor);
  }
  if (incomplete) {
    readCanonicalJsonLines(path, true);
  }
}

/**
 * Appends canonical text without following a symbolic-link target.
 *
 * @param path Target append-log path.
 * @param content Complete text to append.
 */
export function appendCanonicalTextFile(path: string, content: string): void {
  const bytes = Buffer.from(content);
  const reservation = reserveCanonicalFileWrite(bytes.byteLength);
  let descriptor: number | undefined;
  let safeToRelease = true;
  try {
    normalizeAppendBoundary(path);
    const metadata = lstatSync(path, { throwIfNoEntry: false });
    if (metadata) assertCanonicalRegularFile(path);
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600
      );
    } catch (error) {
      throwCanonicalLinkError(path, error);
    }
    safeToRelease = false;
    if (!fstatSync(descriptor).isFile())
      throw new Error(`Canonical path must be a regular file: ${path}.`);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`Canonical append made no progress: ${path}.`);
      reservation?.recordWritten(written);
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncCanonicalDirectory(dirname(path));
    reservation?.assertAvailable();
    safeToRelease = true;
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      if (safeToRelease) reservation?.release();
    }
  }
}

/**
 * Writes complete bytes durably through a same-directory temporary file.
 *
 * @param path Target file path.
 * @param content Complete file content.
 * @param mode Exact replacement mode when supplied; otherwise the private writer default.
 * @param publication Replace by rename, or create by link without clobbering an existing file.
 */
export function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  mode?: number,
  publication: 'replace' | 'create' = 'replace'
): void {
  const byteLength = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
  const reservation = reserveCanonicalFileWrite(byteLength);
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let safeToRelease = false;
  let attemptedOpen = false;
  let temporaryOwned = false;
  try {
    ensureCanonicalDirectory(dirname(path), 0o777);
    if (lstatSync(path, { throwIfNoEntry: false })) assertCanonicalRegularFile(path);
    attemptedOpen = true;
    const descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode ?? 0o600
    );
    temporaryOwned = true;
    try {
      writeFileSync(descriptor, content);
      reservation?.recordWritten(byteLength);
      if (mode !== undefined) fchmodSync(descriptor, mode);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (publication === 'create') {
      linkSync(temporaryPath, path);
      rmSync(temporaryPath);
    } else {
      renameSync(temporaryPath, path);
    }
    try {
      syncCanonicalDirectory(dirname(path));
    } catch (error) {
      throw new CanonicalPublicationError(
        `Directory sync after ${publication === 'create' ? 'link' : 'rename'} failed during publication acknowledgement: ${error instanceof Error ? error.message : 'I/O failure'}`,
        error
      );
    }
    reservation?.assertAvailable();
    safeToRelease = true;
  } catch (error) {
    if (temporaryOwned) {
      rmSync(temporaryPath, { force: true });
      safeToRelease = true;
    } else {
      // A refused path caused no effect.
      // A failed exclusive open has no ownership proof; retain capacity and preserve the unowned file.
      safeToRelease = !attemptedOpen;
    }
    throw error;
  } finally {
    if (safeToRelease) reservation?.release();
  }
}

/** Measures one regular file's exact size and digest without materializing its body. */
export function measureCanonicalFile(path: string): { byteLength: number; contentDigest: string } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return measureCanonicalFileDescriptor(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Measures an open no-follow regular file while preserving its offset for a later stream. */
export function measureCanonicalFileDescriptor(descriptor: number): {
  byteLength: number;
  contentDigest: string;
} {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The canonical file cannot be measured.');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(65_536);
  let byteLength = 0;
  while (byteLength < Number(before.size)) {
    const count = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, Number(before.size) - byteLength),
      byteLength
    );
    if (count === 0) break;
    byteLength += count;
    hash.update(buffer.subarray(0, count));
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (
    BigInt(byteLength) !== before.size ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error('The canonical file changed during integrity verification.');
  }
  return { byteLength, contentDigest: `sha256:${hash.digest('hex')}` };
}

/** Preserves owned annotations while replacing known fields; append-order arrays retain their member annotations. */
export function preserveDescriptiveRecord(raw: unknown, previous: unknown, next: unknown): unknown {
  if (Array.isArray(next)) {
    return next.map((value, index) =>
      preserveDescriptiveRecord(
        Array.isArray(raw) ? raw[index] : undefined,
        Array.isArray(previous) ? previous[index] : undefined,
        value
      )
    );
  }
  if (
    typeof next !== 'object' ||
    next === null ||
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    typeof previous !== 'object' ||
    previous === null ||
    Array.isArray(previous)
  )
    return next;
  const old = previous as Record<string, unknown>;
  const replacement = next as Record<string, unknown>;
  if (['kind', 'type', 'id'].some((key) => old[key] !== undefined && old[key] !== replacement[key]))
    return next;
  const retained = { ...raw } as Record<string, unknown>;
  for (const key of Object.keys(old)) delete retained[key];
  for (const [key, value] of Object.entries(replacement))
    Object.defineProperty(retained, key, {
      value: preserveDescriptiveRecord((raw as Record<string, unknown>)[key], old[key], value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return retained;
}

/** Adds the retained marker and checks existing versions before the ordinary annotation-preserving rewrite. */
function writeRetainedDescriptiveJson(path: string, next: object, schema: z.ZodType): void {
  writeOwnedDescriptiveJson(
    path,
    writeRetainedV1(next),
    z.preprocess((record) => readRetainedV1(record, (value) => value), schema)
  );
}

/** Validates an existing owned record before preserving annotations on its normal rewrite. */
export function writeOwnedDescriptiveJson(path: string, next: unknown, schema: z.ZodType): void {
  const previous = existsSync(path) ? readJson(path) : undefined;
  const core = schema.parse(next);
  const oldCore = previous === undefined ? undefined : schema.parse(previous);
  if (previous !== undefined && isDeepStrictEqual(oldCore, core)) return;
  writeJsonAtomic(path, preserveDescriptiveRecord(previous, oldCore, core));
}

/**
 * Writes formatted JSON through an atomic same-directory rename.
 *
 * @param path Target JSON path.
 * @param value JSON-compatible record.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Lists direct child directory names in stable order.
 *
 * @param path Parent path.
 * @returns Sorted directory names.
 */
export function listDirectoryNames(path: string): string[] {
  const metadata = lstatSync(path, { throwIfNoEntry: false });

  if (!metadata) {
    return [];
  }
  assertCanonicalDirectory(path);

  const names: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Canonical directory must not contain a symbolic link: ${join(path, entry.name)}.`
      );
    }
    if (entry.isDirectory()) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/**
 * Lists direct child file names in stable order.
 *
 * @param path Parent path.
 * @returns Sorted file names.
 */
function listFileNames(path: string): string[] {
  const metadata = lstatSync(path, { throwIfNoEntry: false });

  if (!metadata) {
    return [];
  }
  assertCanonicalDirectory(path);

  const names: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Canonical directory must not contain a symbolic link: ${join(path, entry.name)}.`
      );
    }
    if (entry.isFile()) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/**
 * Verifies that one canonical path is a regular file rather than a link.
 *
 * @param path Canonical file path.
 * @throws Error when the path is a symbolic link or not a regular file.
 */
export function assertCanonicalRegularFile(path: string): void {
  const metadata = lstatSync(path);

  if (metadata.isSymbolicLink()) {
    throw new Error(`Canonical path must not be a symbolic link: ${path}.`);
  }
  if (!metadata.isFile()) {
    throw new Error(`Canonical path must be a regular file: ${path}.`);
  }
}

/**
 * Verifies that one canonical path is a real directory rather than a link.
 *
 * @param path Canonical directory path.
 * @throws Error when the path is a symbolic link or not a directory.
 */
export function assertCanonicalDirectory(path: string): void {
  const metadata = lstatSync(path);

  if (metadata.isSymbolicLink()) {
    throw new Error(`Canonical path must not be a symbolic link: ${path}.`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Canonical path must be a directory: ${path}.`);
  }
}

/**
 * Creates a canonical directory and any missing parents without an existing redirect.
 *
 * @param path Canonical directory path beneath the caller's validated boundary.
 * @param mode Creation permissions, subject to the process umask.
 * @throws Error when the existing or created path is not a real directory.
 */
export function ensureCanonicalDirectory(path: string, mode = 0o700): void {
  const metadata = lstatSync(path, { throwIfNoEntry: false });

  if (metadata) {
    assertCanonicalDirectory(path);
    syncCanonicalDirectory(dirname(path));
    return;
  }

  // A visible parent can remain after its creation was not durably acknowledged.
  ensureCanonicalDirectory(dirname(path), mode);
  assertCanonicalDirectory(dirname(path));
  mkdirSync(path, { mode });
  assertCanonicalDirectory(path);
  syncCanonicalDirectory(dirname(path));
}

/** Synchronizes a verified directory entry before acknowledging publication. */
export function syncCanonicalDirectory(path: string): void {
  assertCanonicalDirectory(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Synchronizes complete staged bytes and child entries before their containing tree is published. */
export function syncCanonicalTree(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(path)) syncCanonicalTree(join(path, entry));
    syncCanonicalDirectory(path);
    return;
  }
  assertCanonicalRegularFile(path);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error(`Canonical path must be a regular file: ${path}.`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Publishes a complete staged file or tree and commits both sides of a cross-parent rename. */
export function publishCanonicalPath(staged: string, destination: string): void {
  syncCanonicalTree(staged);
  renameSync(staged, destination);
  try {
    syncCanonicalDirectory(dirname(destination));
    if (dirname(staged) !== dirname(destination)) syncCanonicalDirectory(dirname(staged));
  } catch (error) {
    throw new CanonicalPublicationError(
      `Directory sync after rename failed during publication acknowledgement: ${error instanceof Error ? error.message : 'I/O failure'}`,
      error
    );
  }
}

/** Synchronizes one directory without blocking asynchronous file collection or following a link. */
export async function syncCanonicalDirectoryAsync(path: string): Promise<void> {
  const descriptor = await fsPromises.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await descriptor.stat()).isDirectory())
      throw new Error(`Canonical path must be a directory: ${path}.`);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

/** Creates missing asynchronous publication parents and commits their entries before use. */
export async function ensureCanonicalDirectoryAsync(path: string): Promise<void> {
  const metadata = await fsPromises.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata) {
    // Commit each parent before creating children so a failed retry has one entry to verify.
    await ensureCanonicalDirectoryAsync(dirname(path));
    try {
      await fsPromises.mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const current = metadata ?? (await fsPromises.lstat(path));
  if (!current.isDirectory() || current.isSymbolicLink())
    throw new Error(`Canonical path must be a directory: ${path}.`);
  await syncCanonicalDirectoryAsync(dirname(path));
}

/** Synchronizes a complete asynchronous staging tree, with child entries committed before their parents. */
export async function syncCanonicalTreeAsync(path: string): Promise<void> {
  const metadata = await fsPromises.lstat(path);
  if (metadata.isDirectory()) {
    for (const entry of await fsPromises.readdir(path))
      await syncCanonicalTreeAsync(join(path, entry));
    await syncCanonicalDirectoryAsync(path);
    return;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`Canonical path must be a regular file: ${path}.`);
  const descriptor = await fsPromises.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!(await descriptor.stat()).isFile())
      throw new Error(`Canonical path must be a regular file: ${path}.`);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

/** Publishes staged asynchronous bytes and commits the destination and any distinct source parent. */
export async function publishCanonicalPathAsync(
  staged: string,
  destination: string
): Promise<void> {
  await syncCanonicalTreeAsync(staged);
  await fsPromises.rename(staged, destination);
  await syncCanonicalDirectoryAsync(dirname(destination));
  if (dirname(staged) !== dirname(destination)) await syncCanonicalDirectoryAsync(dirname(staged));
}

/**
 * Preserves a useful canonical-path error when a no-follow open rejects a link race.
 *
 * @param path Canonical file path.
 * @param error Native open error.
 * @throws The native error, or a canonical symbolic-link error for ELOOP.
 */
function throwCanonicalLinkError(path: string, error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOOP') {
    throw new Error(`Canonical path must not be a symbolic link: ${path}.`, { cause: error });
  }
  throw error;
}

/**
 * Removes unexpected direct child directories.
 *
 * @param root Parent directory.
 * @param expectedNames Directory names to retain.
 */
function removeStaleDirectories(root: string, expectedNames: ReadonlySet<string>): void {
  for (const name of listDirectoryNames(root)) {
    if (!expectedNames.has(name)) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  }
}

/**
 * Removes unexpected owned files with one suffix.
 *
 * @param root Parent directory.
 * @param expectedNames File names to retain.
 * @param suffix Owned file suffix.
 */
function removeStaleFiles(root: string, expectedNames: ReadonlySet<string>, suffix: string): void {
  for (const name of listFileNames(root)) {
    if (name.endsWith(suffix) && !expectedNames.has(name)) {
      rmSync(join(root, name), { force: true });
    }
  }
}

/**
 * Claims one id inside a globally keyed in-memory record family.
 *
 * @param ids Already claimed ids.
 * @param id Candidate id.
 * @param family Human-readable record family.
 * @throws Error when the id already belongs to another canonical record.
 */
function claimGlobalId(ids: Set<string>, id: string, family: string): void {
  if (ids.has(id)) {
    throw new Error(`Duplicate global ${family} id: ${id}.`);
  }
  ids.add(id);
}

/**
 * Reads one required string frontmatter field.
 *
 * @param document Parsed OKF document.
 * @param field Required field name.
 * @param path Source Markdown path.
 * @returns Non-empty string field.
 */
function requiredFrontmatterString(
  document: Parameters<typeof stringFrontmatterField>[0],
  field: string,
  path: string
): string {
  const value = stringFrontmatterField(document, field);

  if (!value) {
    throw new Error(`Canonical Markdown record ${path} is missing ${field}.`);
  }

  return value;
}

/** Fixed outer v1 metadata; the embedded versioned AEP retains its own safety and digest checks. */
const StoredAgentEnvironmentSnapshotV1Schema = z
  .object({
    snapshotId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    turnId: TurnIdSchema,
    threadId: ThreadIdSchema,
    agentSessionId: AgentSessionIdSchema,
    agentId: z.string().min(1),
    packageId: z.string().min(1),
    runtimeKind: z.string().min(1),
    backendKind: z.string().min(1),
    contentDigest: z.string().min(1),
    snapshot: z.record(z.string(), z.any()),
    createdAt: TimestampSchema,
  })
  .strip();

/** Durable Workspace-owned AEP snapshot record with its validated known-field V4 view. */
export type AgentEnvironmentPackageSnapshotRecord = Omit<
  AppApiAgentEnvironmentPackageSnapshotRecord,
  'snapshot'
> & { readonly snapshot: AgentEnvironmentPackage };

/** Ledger read with digest-verified original JSON for integrity and owned same-identity serialization, excluded from public projections. */
export type AgentEnvironmentPackageSnapshotReadRecord = AgentEnvironmentPackageSnapshotRecord & {
  /** Known core has passed the current schema; ignored stored content remains for integrity, same-identity storage and evidence export. */
  readonly retainedSnapshot: AgentEnvironmentPackage;
};

/** Established retained-file decoding failure, separate from snapshot preparation. */
export class AgentEnvironmentSnapshotReadError extends Error {
  /** @param cause Private retained-file decoder failure. */
  constructor(cause: unknown) {
    super('The retained record could not be read.', { cause });
  }
}

/**
 * Lists redacted AEP snapshots for workspace export.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @returns Exportable snapshot records in stable storage order.
 */
export function listExportableAgentEnvironmentPackageSnapshots(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): AgentEnvironmentPackageSnapshotReadRecord[] {
  assertWorkspaceOwner(workspaceDb, workspaceId);
  const root = agentSessionsRoot(workspaceDb);

  if (!existsSync(root)) {
    return [];
  }
  if (!lstatSync(root).isDirectory()) {
    throw new Error('Agent environment package session root must be a directory.');
  }

  const records: AgentEnvironmentPackageSnapshotReadRecord[] = [];
  for (const sessionEntry of readdirSync(root, { withFileTypes: true })) {
    if (sessionEntry.isSymbolicLink()) {
      throw new Error(`Agent environment package session path is symbolic: ${sessionEntry.name}`);
    }
    if (!sessionEntry.isDirectory()) {
      continue;
    }

    const snapshotsRoot = join(root, sessionEntry.name, 'aep-snapshots');
    if (!existsSync(snapshotsRoot)) {
      continue;
    }
    if (!lstatSync(snapshotsRoot).isDirectory()) {
      throw new Error(
        `Agent environment package snapshot root must be a directory: ${sessionEntry.name}`
      );
    }

    for (const snapshotEntry of readdirSync(snapshotsRoot, { withFileTypes: true })) {
      if (snapshotEntry.isSymbolicLink()) {
        throw new Error(
          `Agent environment package snapshot path is symbolic: ${snapshotEntry.name}`
        );
      }
      if (!snapshotEntry.isFile() || !snapshotEntry.name.endsWith('.json')) {
        continue;
      }

      const snapshotId = snapshotEntry.name.slice(0, -'.json'.length);
      records.push(
        readSnapshotRecord(
          workspaceDb,
          join(snapshotsRoot, snapshotEntry.name),
          sessionEntry.name,
          snapshotId
        )
      );
    }
  }

  records.sort(
    (left, right) =>
      compareCodeUnits(left.createdAt, right.createdAt) ||
      compareCodeUnits(left.snapshotId, right.snapshotId)
  );

  const snapshotIds = new Set<string>();
  for (const record of records) {
    if (snapshotIds.has(record.snapshotId)) {
      throw new Error(`Duplicate agent environment package snapshot: ${record.snapshotId}`);
    }
    snapshotIds.add(record.snapshotId);
  }

  return records;
}

/**
 * Reads and validates one canonical snapshot file.
 *
 * @param workspaceDb Workspace that owns the snapshot.
 * @param path Canonical snapshot file path.
 * @param agentSessionId Parent AgentSession directory name.
 * @param snapshotId Snapshot file name without extension.
 * @returns Validated snapshot record.
 */
export function readSnapshotRecord(
  workspaceDb: WorkspaceDb,
  path: string,
  agentSessionId: string,
  snapshotId: string
): AgentEnvironmentPackageSnapshotReadRecord {
  if (!lstatSync(path).isFile()) {
    throw new Error(`Agent environment package snapshot is not a regular file: ${snapshotId}`);
  }
  let record: AgentEnvironmentPackageSnapshotReadRecord;
  // Marker refusal is a retained decode failure, with the same private cause as malformed JSON.
  try {
    record = readRetainedV1(JSON.parse(readFileSync(path, 'utf8')), (value) =>
      validateSnapshotRecord(workspaceDb, value)
    );
  } catch (cause) {
    if (cause instanceof SyntaxError || cause instanceof z.ZodError || cause instanceof TypeError) {
      throw new AgentEnvironmentSnapshotReadError(cause);
    }
    throw cause;
  }

  if (record.agentSessionId !== agentSessionId || record.snapshotId !== snapshotId) {
    throw new Error(`Agent environment package snapshot path mismatch: ${snapshotId}`);
  }

  return record;
}

/**
 * Parses one retained snapshot record and verifies its original digest and complete AEP lineage.
 *
 * @param workspaceDb Workspace that owns the snapshot.
 * @param value Candidate snapshot record.
 * @returns Validated record with a parsed Agent Environment Package.
 * @throws Error for unsafe original evidence, invalid integrity or lineage, or changed retained core.
 */
export function validateSnapshotRecord(
  workspaceDb: WorkspaceDb,
  value: unknown
): AgentEnvironmentPackageSnapshotReadRecord {
  const candidate = value as AgentEnvironmentPackageSnapshotReadRecord;
  const hasRetainedSnapshot =
    candidate &&
    typeof candidate === 'object' &&
    Object.getOwnPropertyDescriptor(candidate, 'retainedSnapshot')?.enumerable === false;
  const parsed = StoredAgentEnvironmentSnapshotV1Schema.parse(
    hasRetainedSnapshot ? { ...candidate, snapshot: candidate.retainedSnapshot } : value
  );
  // Retained identity covers the stored value; normalization may discard ignored extensions.
  if (parsed.contentDigest !== snapshotDigest(parsed.snapshot)) {
    throw new Error(`Agent environment package snapshot digest mismatch: ${parsed.snapshotId}`);
  }
  const snapshot = RetainedAgentEnvironmentPackageSchema.parse(parsed.snapshot);
  if (
    hasRetainedSnapshot &&
    !isDeepStrictEqual(snapshot, RetainedAgentEnvironmentPackageSchema.parse(candidate.snapshot))
  ) {
    throw new Error(
      `Agent environment package snapshot retained core mismatch: ${parsed.snapshotId}`
    );
  }
  // Check the original before granting preservation eligibility; normalization hides unknown unsafe fields.
  if (
    !isDeepStrictEqual(
      parsed.snapshot,
      redactAgentEnvironmentPackageSnapshot(parsed.snapshot as AgentEnvironmentPackage)
    )
  ) {
    throw new Error(`Agent environment package snapshot is not redacted: ${parsed.snapshotId}`);
  }
  const record: AgentEnvironmentPackageSnapshotRecord = { ...parsed, snapshot };

  assertWorkspaceOwner(workspaceDb, record.workspaceId);
  assertPathSegment(record.agentSessionId, 'AgentSession id');
  assertPathSegment(record.snapshotId, 'snapshot id');

  if (
    record.snapshotId !== snapshot.snapshotId ||
    record.workspaceId !== snapshot.scope.workspaceId ||
    record.turnId !== snapshot.scope.turnId ||
    record.threadId !== snapshot.scope.threadId ||
    record.agentSessionId !== snapshot.scope.agentSessionId ||
    record.agentId !== snapshot.agent.agentId ||
    record.packageId !== snapshot.packageId ||
    record.runtimeKind !== snapshot.agent.runtimeKind ||
    record.backendKind !== snapshot.backend.preferred
  ) {
    throw new Error(`Agent environment package snapshot lineage mismatch: ${record.snapshotId}`);
  }

  // Same-identity storage and evidence export retain this digest-covered representation.
  // Execution and public consumers use only the normalized snapshot.
  return Object.defineProperty(record, 'retainedSnapshot', {
    value: parsed.snapshot,
  }) as AgentEnvironmentPackageSnapshotReadRecord;
}

/**
 * Resolves the workspace-owned AgentSession directory.
 *
 * @param workspaceDb Workspace ownership metadata.
 * @returns Absolute AgentSession root.
 */
export function agentSessionsRoot(workspaceDb: WorkspaceDb): string {
  return join(dirname(dirname(workspaceDb.sqlite.name)), 'runtime', 'agent-sessions');
}

/**
 * Hashes one stored snapshot value using the existing public digest format.
 *
 * @param snapshot Stored snapshot value before package-reader normalization.
 * @returns Lowercase SHA-256 digest.
 */
export function snapshotDigest(snapshot: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

/**
 * Verifies that one API workspace scope matches the open workspace owner.
 *
 * @param workspaceDb Open workspace database metadata.
 * @param workspaceId Workspace id supplied by the record or caller.
 */
export function assertWorkspaceOwner(workspaceDb: WorkspaceDb, workspaceId: string): void {
  if (workspaceId !== workspaceDb.workspaceId) {
    throw new Error(`Agent environment package snapshot workspace mismatch: ${workspaceId}`);
  }
}

/**
 * Rejects ids that would create nested or escaped canonical paths.
 *
 * @param value Candidate file or directory id.
 * @param label Human-readable id label.
 */
export function assertPathSegment(value: string, label: string): void {
  if (value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new Error(`Agent environment package ${label} is not a safe path segment.`);
  }
}
