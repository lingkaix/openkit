import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  KnowledgeManagerDraftedProposalSchema,
  KnowledgeProposalPageIdSchema,
  KnowledgeProposalReviewSchema,
  KnowledgeSourceSchema,
  MaterializedWorkspaceRootSchema,
} from '@openkit/app-api-schemas';
import {
  AgentSandboxSummarySchema,
  AgentSessionSchema,
  ArtifactSchema,
  ItemSchema,
  KnowledgeEntrySchema,
  SseEventEnvelopeSchema,
  ThreadSchema,
  TurnSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { z } from 'zod';

import {
  DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_TEXT,
  DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION,
  parseOkfDocument,
  stringFrontmatterField,
} from '../knowledge/okf.js';
import type {
  AgentSession,
  KnowledgeProposalRecord,
  KnowledgeProposalReviewRecord,
  KnowledgeSourceRecord,
} from '../lib/store.js';
import { ensureLayout, ensureWorkspaceLayoutRoot } from './fs-layout.js';

type WorkspaceRecord = import('zod').infer<typeof WorkspaceRecordSchema>;
type KnowledgeEntry = import('zod').infer<typeof KnowledgeEntrySchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;
type Turn = import('zod').infer<typeof TurnSchema>;
type Item = import('zod').infer<typeof ItemSchema>;
type Artifact = import('zod').infer<typeof ArtifactSchema>;
type SseEventEnvelope = import('zod').infer<typeof SseEventEnvelopeSchema>;

const CanonicalTimestampSchema = z.string().datetime();
export const KnowledgeProposalRecordSchema = KnowledgeManagerDraftedProposalSchema.omit({
  status: true,
})
  .extend({
    id: z.string().regex(/^kp_[a-f0-9]{64}$/),
  })
  .strict();
export const KnowledgeProposalReviewRecordSchema = KnowledgeProposalReviewSchema.extend({
  reviewId: z.string().regex(/^kr_[a-f0-9]{64}$/),
})
  .strict()
  .superRefine((review, context) => {
    const accepted = review.decision === 'accepted';
    if (accepted !== (review.targetAbsentAtDecision === true)) {
      context.addIssue({
        code: 'custom',
        message: 'Only an accepted review may record target absence.',
        path: ['targetAbsentAtDecision'],
      });
    }
  });
const KnowledgeProposalReviewFileSchema = z
  .object({
    proposalId: z.string().regex(/^kp_[a-f0-9]{64}$/),
    workspaceId: z.string().min(1),
    decisions: z.array(KnowledgeProposalReviewRecordSchema).min(1),
  })
  .strict()
  .superRefine((file, context) => {
    const requestIds = new Set<string>();
    const reviewIds = new Set<string>();
    let terminal = false;

    for (const [index, review] of file.decisions.entries()) {
      const expectedReviewId = `kr_${createHash('sha256')
        .update(
          JSON.stringify({
            workspaceId: file.workspaceId,
            proposalId: file.proposalId,
            requestId: review.requestId,
          }),
          'utf8'
        )
        .digest('hex')}`;
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
}).strict();
/** Canonical agent session record schema shared with workspace portability. */
export const AgentSessionRecordSchema = AgentSessionSchema.extend({
  sandboxSummary: AgentSandboxSummarySchema.extend({
    workspaceRootRefs: z.array(z.string().min(1)),
  })
    .strict()
    .nullable(),
  createdAt: CanonicalTimestampSchema,
  updatedAt: CanonicalTimestampSchema,
  configVersion: z.number().int().positive().nullable(),
  environmentPackageSnapshotId: z.string().min(1).nullable(),
  policySnapshotId: z.string().min(1).nullable(),
  sessionCompatibilityKey: z.string().min(1).nullable(),
  stale: z.boolean(),
  workspaceRoots: z.array(MaterializedWorkspaceRootSchema.strict()),
}).strict();

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
  const digest = createHash('sha256')
    .update(JSON.stringify([artifactId, turnId]), 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `it_artifact_${digest}`;
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
          item.workspaceId,
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
            item.workspaceId,
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
 * @param previous Previous canonical Item revision.
 * @param next Proposed later revision for the same Item.
 * @throws Error when actor, responsible user, or command causation changes.
 */
export function assertImmutableItemAttribution(previous: Item, next: Item): void {
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

  if (actorChanged || responsibleUserChanged || causationChanged) {
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
  const workspace = WorkspaceRecordSchema.parse(input.workspace);
  const threads = input.threads.map((record) => ThreadSchema.parse(record));
  const turns = input.turns.map((record) => TurnSchema.parse(record));
  const itemRevisions = input.itemRevisions.map((record) => ItemSchema.parse(record));
  const artifacts = input.artifacts.map((record) => ArtifactSchema.parse(record));
  const knowledgeProposals = (input.knowledgeProposals ?? []).map((record) =>
    KnowledgeProposalRecordSchema.parse(record)
  );
  const knowledgeProposalReviews = (input.knowledgeProposalReviews ?? []).map((record) =>
    KnowledgeProposalReviewRecordSchema.parse(record)
  );
  const knowledgeSources = (input.knowledgeSources ?? []).map((record) =>
    KnowledgeSourceRecordSchema.parse(record)
  );
  const agentSessions = input.agentSessions.map(
    (record) => AgentSessionRecordSchema.parse(record) as AgentSession
  );
  const turnEvents = input.turnEvents.map(
    ([turnId, events]) =>
      [turnId, events.map((event) => SseEventEnvelopeSchema.parse(event))] as [
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
  const itemOrder: string[] = [];
  const latestItems = new Map<string, Item>();

  for (const thread of threads) {
    claimGlobalId(threadIds, thread.id, 'thread');
    if (thread.workspaceId !== workspace.id) {
      throw new Error(`Thread ${thread.id} has invalid lineage.`);
    }
    threadsById.set(thread.id, thread);
  }
  for (const turn of turns) {
    claimGlobalId(turnIds, turn.id, 'turn');
    const thread = threadsById.get(turn.threadId);
    if (!thread || turn.workspaceId !== workspace.id || thread.workspaceId !== workspace.id) {
      throw new Error(`Turn ${turn.id} has invalid lineage.`);
    }
    turnsById.set(turn.id, turn);
  }
  for (const item of itemRevisions) {
    const turn = turnsById.get(item.turnId);
    const previous = latestItems.get(item.id);
    if (
      !turn ||
      item.workspaceId !== workspace.id ||
      item.threadId !== turn.threadId ||
      (previous &&
        (previous.workspaceId !== item.workspaceId ||
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
    const contentDigest = `sha256:${createHash('sha256')
      .update(artifact.content.body, 'utf8')
      .digest('hex')}`;
    if (
      artifact.workspaceId !== workspace.id ||
      artifact.contentDigest !== contentDigest ||
      (artifact.threadId === null) !== (artifact.turnId === null) ||
      (artifact.threadId !== null && !thread) ||
      (artifact.turnId !== null &&
        (!turn ||
          artifact.threadId !== turn.threadId ||
          artifact.workspaceId !== turn.workspaceId)) ||
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
        reference.workspaceId !== artifact.workspaceId ||
        !turn ||
        turn.workspaceId !== artifact.workspaceId ||
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
    claimGlobalId(sessionIds, session.id, 'agent session');
    if (
      session.workspaceId !== workspace.id ||
      session.threadId === null ||
      !threadsById.has(session.threadId)
    ) {
      throw new Error(`Agent session ${session.id} has invalid lineage.`);
    }
    sessionsById.set(session.id, session);
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
 * Resolves one schema-valid Knowledge Page id below the canonical pages root.
 *
 * @param workspaceRoot Published workspace root.
 * @param knowledgePageId Slash-separated Knowledge Page id.
 * @param createParents Whether missing safe parent directories may be created.
 * @returns Canonical page path, or null when a read-only parent is absent.
 */
function resolveWorkspaceKnowledgePagePath(
  workspaceRoot: string,
  knowledgePageId: string,
  createParents: boolean
): string | null {
  const parsedId = KnowledgeProposalPageIdSchema.parse(knowledgePageId);
  const segments = parsedId.split('/');
  const pagesRoot = join(workspaceRoot, 'knowledge', 'pages');

  for (const path of [workspaceRoot, join(workspaceRoot, 'knowledge'), pagesRoot]) {
    assertCanonicalDirectory(path);
  }
  for (const segment of segments) {
    assertSafeWorkspacePathSegment(segment, 'Knowledge Page id segment');
  }

  const target = resolve(pagesRoot, ...segments.slice(0, -1), `${segments.at(-1)!}.md`);
  const targetRelative = relative(resolve(pagesRoot), target);
  if (
    targetRelative === '..' ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw new Error('Knowledge Page path escapes the canonical pages root.');
  }

  let parent = pagesRoot;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    const metadata = lstatSync(parent, { throwIfNoEntry: false });
    if (!metadata) {
      if (!createParents) {
        return null;
      }
      ensureCanonicalDirectory(parent);
      continue;
    }
    assertCanonicalDirectory(parent);
  }

  return target;
}

/**
 * Reads one canonical Knowledge Page without following symbolic links.
 *
 * @param workspaceRoot Published workspace root.
 * @param knowledgePageId Slash-separated Knowledge Page id.
 * @returns Exact UTF-8 page bytes, or null when the page is absent.
 */
export function readWorkspaceKnowledgePage(
  workspaceRoot: string,
  knowledgePageId: string
): string | null {
  const path = resolveWorkspaceKnowledgePagePath(workspaceRoot, knowledgePageId, false);
  if (!path || !lstatSync(path, { throwIfNoEntry: false })) {
    return null;
  }
  return readCanonicalTextFile(path);
}

/**
 * Deletes one canonical knowledge page before its in-memory owner is removed.
 *
 * @param workspaceRoot Published workspace root.
 * @param knowledgeEntryId Knowledge entry id to delete.
 */
export function deleteWorkspaceKnowledgeRecord(
  workspaceRoot: string,
  knowledgeEntryId: string
): void {
  const path = resolveWorkspaceKnowledgePagePath(workspaceRoot, knowledgeEntryId, false);
  if (!path || !lstatSync(path, { throwIfNoEntry: false })) {
    return;
  }
  assertCanonicalRegularFile(path);
  rmSync(path);
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
function readCanonicalFile(path: string): Buffer {
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

/** Complete canonical file records for one workspace. */
export interface WorkspaceFileRecords {
  /** Workspace metadata. */
  readonly workspace: WorkspaceRecord;
  /** Protocol knowledge entries represented by owned OKF pages. */
  readonly knowledge: readonly KnowledgeEntry[];
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
  /** Durable agent sessions. */
  readonly agentSessions: readonly AgentSession[];
  /** Retained turn event windows keyed by turn id. */
  readonly streamEvents: readonly (readonly [string, readonly SseEventEnvelope[]])[];
}

/**
 * Loads every published workspace from canonical file records.
 *
 * @param dataRoot Data root that owns the Workspace tree.
 * @returns Canonical workspace records in workspace-directory order.
 * @throws Error when record lineage is invalid or a global id collides.
 */
export function loadWorkspaceFileRecords(dataRoot: string): WorkspaceFileRecords[] {
  const workspacesRoot = ensureLayout(dataRoot).workspaces;
  assertCanonicalDirectory(workspacesRoot);
  rmSync(join(workspacesRoot, '.staging'), { recursive: true, force: true });

  const records = listDirectoryNames(workspacesRoot).map((workspaceId) => {
    assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
    return loadWorkspace(join(workspacesRoot, workspaceId), workspaceId);
  });
  const threadIds = new Set<string>();
  const turnIds = new Set<string>();
  const itemIds = new Set<string>();
  const artifactIds = new Set<string>();
  const proposalIds = new Set<string>();
  const sourceIds = new Set<string>();
  const agentSessionIds = new Set<string>();

  for (const workspaceRecords of records) {
    for (const thread of workspaceRecords.threads) {
      claimGlobalId(threadIds, thread.id, 'thread');
    }
    for (const turn of workspaceRecords.turns) {
      claimGlobalId(turnIds, turn.id, 'turn');
      for (const item of turn.items) {
        claimGlobalId(itemIds, item.id, 'item');
      }
    }
    for (const artifact of workspaceRecords.artifacts) {
      claimGlobalId(artifactIds, artifact.id, 'artifact');
    }
    for (const proposal of workspaceRecords.knowledgeProposals) {
      claimGlobalId(proposalIds, proposal.id, 'knowledge proposal');
    }
    for (const source of workspaceRecords.knowledgeSources) {
      claimGlobalId(sourceIds, source.id, 'knowledge source');
    }
    for (const session of workspaceRecords.agentSessions) {
      claimGlobalId(agentSessionIds, session.id, 'agent session');
    }
  }

  return records;
}

/**
 * Writes one workspace's mutable canonical file records under a resolved root.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param records Current workspace records.
 */
export function writeWorkspaceFileRecords(
  workspaceRoot: string,
  records: WorkspaceFileRecords
): void {
  assertSafeWorkspaceFileRecordIds(records);
  assertExistingWorkspaceDirectoryParents(workspaceRoot);
  ensureWorkspaceLayoutRoot(workspaceRoot);
  assertExistingWorkspaceDirectoryParents(workspaceRoot);
  writeJsonAtomic(join(workspaceRoot, 'workspace.json'), records.workspace);
  writeThreads(workspaceRoot, records);
  writeKnowledge(workspaceRoot, records);
  writeSources(workspaceRoot, records);
  writeArtifacts(workspaceRoot, records);
  writeAgentSessions(workspaceRoot, records);
}

/**
 * Appends one full item revision to its owning turn log.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param item Item revision to append.
 */
export function appendWorkspaceItemRevision(workspaceRoot: string, item: Item): void {
  const parsed = ItemSchema.parse(item);

  assertSafeWorkspacePathSegment(parsed.id, 'Item id');
  assertSafeWorkspacePathSegment(parsed.threadId, 'Item thread id');
  assertSafeWorkspacePathSegment(parsed.turnId, 'Item turn id');
  const path = join(
    workspaceRoot,
    'threads',
    parsed.threadId,
    'turns',
    parsed.turnId,
    'items.jsonl'
  );

  for (const parent of [
    workspaceRoot,
    join(workspaceRoot, 'threads'),
    join(workspaceRoot, 'threads', parsed.threadId),
    join(workspaceRoot, 'threads', parsed.threadId, 'turns'),
    dirname(path),
  ]) {
    assertCanonicalDirectory(parent);
  }
  appendCanonicalTextFile(path, `${JSON.stringify(parsed)}\n`);
}

/**
 * Appends one validated event envelope to its owning turn event log.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param event Event envelope to append.
 */
export function appendWorkspaceTurnEvent(workspaceRoot: string, event: SseEventEnvelope): void {
  const parsed = SseEventEnvelopeSchema.parse(event);

  if (!parsed.threadId || !parsed.turnId) {
    throw new Error('Turn event storage requires thread and turn lineage.');
  }
  assertSafeWorkspacePathSegment(parsed.threadId, 'Event thread id');
  assertSafeWorkspacePathSegment(parsed.turnId, 'Event turn id');

  const path = join(
    workspaceRoot,
    'threads',
    parsed.threadId,
    'turns',
    parsed.turnId,
    'runtime',
    'events.jsonl'
  );

  for (const parent of [
    workspaceRoot,
    join(workspaceRoot, 'threads'),
    join(workspaceRoot, 'threads', parsed.threadId),
    join(workspaceRoot, 'threads', parsed.threadId, 'turns'),
    join(workspaceRoot, 'threads', parsed.threadId, 'turns', parsed.turnId),
  ]) {
    assertCanonicalDirectory(parent);
  }
  ensureCanonicalDirectory(dirname(path));
  appendCanonicalTextFile(path, `${JSON.stringify(parsed)}\n`);
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
  const workspacePath = join(workspaceRoot, 'workspace.json');

  if (!existsSync(workspacePath)) {
    throw new Error(`Canonical workspace directory is missing workspace.json: ${workspaceId}.`);
  }

  const workspace = WorkspaceRecordSchema.parse(readJson(workspacePath));

  if (workspace.id !== workspaceId) {
    throw new Error(
      `Workspace record ${workspace.id} does not match its directory ${workspaceId}.`
    );
  }

  const threads: Thread[] = [];
  const turns: Turn[] = [];
  const itemRevisions: Item[] = [];
  const streamEvents: Array<readonly [string, readonly SseEventEnvelope[]]> = [];
  const threadsRoot = join(workspaceRoot, 'threads');

  for (const threadId of listDirectoryNames(threadsRoot)) {
    const threadPath = join(threadsRoot, threadId, 'thread.json');

    if (!existsSync(threadPath)) {
      throw new Error(`Canonical thread directory is missing thread.json: ${threadId}.`);
    }

    const thread = ThreadSchema.parse(readJson(threadPath));

    if (thread.id !== threadId || thread.workspaceId !== workspaceId) {
      throw new Error(`Thread record ${thread.id} has invalid workspace or directory lineage.`);
    }

    threads.push(thread);
    const turnsRoot = join(threadsRoot, threadId, 'turns');

    for (const turnId of listDirectoryNames(turnsRoot)) {
      const turnPath = join(turnsRoot, turnId, 'turn.json');

      if (!existsSync(turnPath)) {
        throw new Error(`Canonical turn directory is missing turn.json: ${turnId}.`);
      }

      const rawTurn = readJson(turnPath) as Record<string, unknown>;
      if (
        rawTurn.items !== undefined &&
        (!Array.isArray(rawTurn.items) || rawTurn.items.length > 0)
      ) {
        throw new Error(`Canonical turn metadata must not embed items: ${turnId}.`);
      }
      const turnWithoutItems = TurnSchema.parse({ ...rawTurn, items: [] });

      if (
        turnWithoutItems.id !== turnId ||
        turnWithoutItems.workspaceId !== workspaceId ||
        turnWithoutItems.threadId !== threadId
      ) {
        throw new Error(`Turn record ${turnWithoutItems.id} has invalid lineage.`);
      }

      const itemsPath = join(turnsRoot, turnId, 'items.jsonl');
      if (!existsSync(itemsPath)) {
        throw new Error(`Canonical turn directory is missing items.jsonl: ${turnId}.`);
      }

      const loadedItems = loadItemRevisions(itemsPath, workspaceId, threadId, turnId);
      const turn = TurnSchema.parse({ ...turnWithoutItems, items: loadedItems.current });
      const runtimeRoot = join(turnsRoot, turnId, 'runtime');
      if (lstatSync(runtimeRoot, { throwIfNoEntry: false })) {
        assertCanonicalDirectory(runtimeRoot);
      }
      const events = readWorkspaceTurnEvents(workspaceRoot, turn);

      itemRevisions.push(...loadedItems.revisions);
      turns.push(turn);
      streamEvents.push([turnId, events]);
    }
  }

  const threadIds = new Set(threads.map((thread) => thread.id));
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
  const artifacts = loadArtifacts(workspaceRoot, workspaceId, threadIds, turnsById);
  const knowledge = loadKnowledge(workspaceRoot);
  const knowledgeProposals = loadKnowledgeProposals(workspaceRoot, workspaceId);
  const knowledgeProposalReviews = loadKnowledgeProposalReviews(
    workspaceRoot,
    workspaceId,
    new Map(knowledgeProposals.map((proposal) => [proposal.id, proposal]))
  );
  const knowledgeSources = loadKnowledgeSources(workspaceRoot, workspaceId, threadIds, turnsById);
  const agentSessions = loadAgentSessions(workspaceRoot, workspaceId, threadIds);
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
    turns: history.turns,
    itemRevisions: history.itemRevisions,
    artifacts: history.artifacts,
    knowledgeProposals: history.knowledgeProposals,
    knowledgeProposalReviews: history.knowledgeProposalReviews,
    knowledgeSources: history.knowledgeSources,
    agentSessions: history.agentSessions,
    streamEvents: history.turnEvents.map(([turnId, events]) => [
      turnId,
      events.slice(-TURN_STREAM_EVENT_WINDOW_SIZE),
    ]),
  };
}

/**
 * Reads one turn's complete canonical event history.
 *
 * @param workspaceRoot Owning workspace root.
 * @param turn Turn whose validated event log should be read.
 * @returns Every event from sequence one in append order.
 */
export function readWorkspaceTurnEvents(workspaceRoot: string, turn: Turn): SseEventEnvelope[] {
  assertSafeWorkspacePathSegment(turn.threadId, 'Event thread id');
  assertSafeWorkspacePathSegment(turn.id, 'Event turn id');
  return loadTurnEvents(
    join(workspaceRoot, 'threads', turn.threadId, 'turns', turn.id, 'runtime', 'events.jsonl'),
    turn.workspaceId,
    turn.threadId,
    turn.id,
    new Set(turn.items.map((item) => item.id))
  );
}

/**
 * Loads the latest revision for each item while preserving first-id order.
 *
 * @param path Item JSONL path.
 * @param workspaceId Expected workspace id.
 * @param threadId Expected thread id.
 * @param turnId Expected turn id.
 * @returns Latest item revisions.
 */
function loadItemRevisions(
  path: string,
  workspaceId: string,
  threadId: string,
  turnId: string
): { current: Item[]; revisions: Item[] } {
  const order: string[] = [];
  const items = new Map<string, Item>();
  const revisions: Item[] = [];

  for (const value of readCanonicalJsonLines(path, true)) {
    const item = ItemSchema.parse(value);
    const previous = items.get(item.id);

    if (item.workspaceId !== workspaceId || item.threadId !== threadId || item.turnId !== turnId) {
      throw new Error(`Item record ${item.id} has invalid lineage.`);
    }
    if (previous && (item.type !== previous.type || item.createdAt !== previous.createdAt)) {
      throw new Error(`Item revision changed immutable identity: ${item.id}.`);
    }
    if (previous) {
      assertImmutableItemAttribution(previous, item);
    }
    if (!items.has(item.id)) {
      order.push(item.id);
    }
    items.set(item.id, item);
    revisions.push(item);
  }

  return { current: order.map((itemId) => items.get(itemId) as Item), revisions };
}

/**
 * Loads and validates the retained event window for one turn.
 *
 * @param path Event JSONL path.
 * @param workspaceId Expected workspace id.
 * @param threadId Expected thread id.
 * @param turnId Expected turn id.
 * @param itemIds Item ids owned by the turn.
 * @returns Every event envelope in append order.
 */
function loadTurnEvents(
  path: string,
  workspaceId: string,
  threadId: string,
  turnId: string,
  itemIds: ReadonlySet<string>
): SseEventEnvelope[] {
  const events = readCanonicalJsonLines(path, true).map((value) =>
    SseEventEnvelopeSchema.parse(value)
  );

  for (const [index, event] of events.entries()) {
    if (
      event.workspaceId !== workspaceId ||
      event.threadId !== threadId ||
      event.turnId !== turnId
    ) {
      throw new Error(`Turn event ${event.event} has invalid lineage for ${turnId}.`);
    }
    assertTurnEventPayloadLineage(event, workspaceId, threadId, turnId, itemIds);
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Turn event sequence must be contiguous from 1 for ${turnId}; expected ${expectedSequence}, received ${event.sequence}.`
      );
    }
  }

  return events;
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
      valid = data.thread.workspaceId === workspaceId && data.thread.id === threadId;
      break;
    case 'turn-started':
      valid = data.turnId === turnId;
      break;
    case 'turn-updated':
    case 'turn-completed':
      valid =
        data.turn.workspaceId === workspaceId &&
        data.turn.threadId === threadId &&
        data.turn.id === turnId;
      break;
    case 'item-created':
      valid =
        data.item.workspaceId === workspaceId &&
        data.item.threadId === threadId &&
        data.item.turnId === turnId &&
        itemIds.has(data.item.id);
      break;
    case 'item-completed':
      valid =
        data.item.workspaceId === workspaceId &&
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
 * Parses one owned Knowledge Page into its protocol projection.
 *
 * @param path Canonical page path used for validation diagnostics.
 * @param knowledgePageId Expected bundle-relative page id.
 * @param content Exact page bytes.
 * @returns Parsed Knowledge entry projection.
 * @throws Error when the file is not a valid owned page for the expected id.
 */
export function parseOwnedKnowledgeEntry(
  path: string,
  knowledgePageId: string,
  content: string
): KnowledgeEntry {
  const parsed = parseOkfDocument({ path, content });
  const id = parsed.document ? stringFrontmatterField(parsed.document, 'openkit_entry_id') : null;

  if (!parsed.ok || id !== knowledgePageId || parsed.document.conceptId !== knowledgePageId) {
    throw new Error(`Knowledge page ${knowledgePageId} is not a valid owned record.`);
  }

  const sourceReferences = parsed.document.frontmatter.source_refs;
  return KnowledgeEntrySchema.parse({
    id,
    kind: requiredFrontmatterString(parsed.document, 'openkit_entry_kind', path),
    title: requiredFrontmatterString(parsed.document, 'title', path),
    content: trimCanonicalMarkdownBody(parsed.document.body),
    ...(Array.isArray(sourceReferences) && sourceReferences.length > 0 ? { sourceReferences } : {}),
    createdAt: requiredFrontmatterString(parsed.document, 'created_at', path),
    updatedAt: requiredFrontmatterString(parsed.document, 'updated_at', path),
  });
}

/**
 * Compares two canonical KnowledgeEntry projections while normalizing absent empty sources.
 *
 * @param left First KnowledgeEntry projection.
 * @param right Second KnowledgeEntry projection.
 * @returns True when every authoritative protocol field is equal.
 */
export function knowledgeEntriesEqual(left: KnowledgeEntry, right: KnowledgeEntry): boolean {
  const leftReferences = left.sourceReferences ?? [];
  const rightReferences = right.sourceReferences ?? [];
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.content === right.content &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    leftReferences.length === rightReferences.length &&
    leftReferences.every((reference, index) => reference === rightReferences[index])
  );
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
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${prefix}${name.slice(0, -'.md'.length)}`);
  const nested = listDirectoryNames(pagesRoot).flatMap((name) =>
    listKnowledgePageIds(join(pagesRoot, name), `${prefix}${name}/`)
  );

  const ids = [...direct, ...nested].sort();
  for (const id of ids) {
    if (id !== 'index' && id !== 'log' && !KnowledgeProposalPageIdSchema.safeParse(id).success) {
      throw new Error(`Knowledge Page id is invalid: ${id}.`);
    }
  }
  return ids;
}

/**
 * Loads owned protocol knowledge pages.
 *
 * @param workspaceRoot Published workspace root.
 * @returns Knowledge entries in file-name order.
 */
function loadKnowledge(workspaceRoot: string): KnowledgeEntry[] {
  const pagesRoot = join(workspaceRoot, 'knowledge', 'pages');
  const entries: KnowledgeEntry[] = [];

  for (const knowledgePageId of listKnowledgePageIds(pagesRoot)) {
    const path = join(pagesRoot, `${knowledgePageId}.md`);
    const content = readCanonicalTextFile(path);
    const parsed = parseOkfDocument({ path, content });
    const id = parsed.document ? stringFrontmatterField(parsed.document, 'openkit_entry_id') : null;

    if (!id) {
      continue;
    }
    entries.push(parseOwnedKnowledgeEntry(path, knowledgePageId, content));
  }

  return entries;
}

/**
 * Serializes one immutable Knowledge Proposal owner without review state.
 *
 * @param proposal Proposal tuple to serialize.
 * @returns Exact canonical proposal-file bytes.
 */
export function serializeKnowledgeProposalRecord(proposal: KnowledgeProposalRecord): string {
  return [
    '---',
    'type: "proposal"',
    'operation: "create"',
    `knowledge_page_id: ${JSON.stringify(proposal.knowledgePageId)}`,
    `content_digest: ${JSON.stringify(proposal.contentDigest)}`,
    `source_references: ${JSON.stringify(proposal.sourceReferences)}`,
    `rationale: ${JSON.stringify(proposal.rationale)}`,
    `confidence: ${JSON.stringify(proposal.confidence)}`,
    'review_required: true',
    `producer: ${JSON.stringify(proposal.producer)}`,
    `created_at: ${JSON.stringify(proposal.createdAt)}`,
    '---',
    proposal.canonicalPageBytes,
  ].join('\n');
}

/**
 * Serializes one append-only Knowledge Review file in its canonical JSON encoding.
 *
 * @param proposalId Immutable Proposal that owns the Review history.
 * @param workspaceId Workspace that owns the Proposal and Review.
 * @param decisions Ordered append-only Review rows.
 * @returns Exact canonical Review-file bytes.
 */
export function serializeKnowledgeProposalReviewFile(
  proposalId: string,
  workspaceId: string,
  decisions: readonly KnowledgeProposalReviewRecord[]
): string {
  const reviewFile = KnowledgeProposalReviewFileSchema.parse({
    proposalId,
    workspaceId,
    decisions: [...decisions],
  });
  return `${JSON.stringify(reviewFile, null, 2)}\n`;
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
      const sourceReferences = parsed.document.frontmatter.source_references;
      const producerValue = parsed.document.frontmatter.producer;
      const confidenceValue = parsed.document.frontmatter.confidence;
      if (
        parsed.document.frontmatter.type !== 'proposal' ||
        parsed.document.frontmatter.operation !== 'create' ||
        parsed.document.frontmatter.review_required !== 'true' ||
        !Array.isArray(sourceReferences) ||
        typeof producerValue !== 'string' ||
        typeof confidenceValue !== 'string'
      ) {
        throw new Error(`Knowledge proposal ${id} has invalid immutable metadata.`);
      }

      const proposal = KnowledgeProposalRecordSchema.parse({
        id,
        workspaceId,
        operation: 'create',
        knowledgePageId: requiredFrontmatterString(parsed.document, 'knowledge_page_id', path),
        canonicalPageBytes: parsed.document.body,
        contentDigest: requiredFrontmatterString(parsed.document, 'content_digest', path),
        sourceReferences,
        rationale: requiredFrontmatterString(parsed.document, 'rationale', path),
        confidence: Number(confidenceValue),
        producer: JSON.parse(producerValue) as unknown,
        createdAt: requiredFrontmatterString(parsed.document, 'created_at', path),
      });
      const candidateDigest = `sha256:${createHash('sha256')
        .update(proposal.canonicalPageBytes, 'utf8')
        .digest('hex')}`;
      if (
        proposal.contentDigest !== candidateDigest ||
        content !== serializeKnowledgeProposalRecord(proposal)
      ) {
        throw new Error(`Knowledge proposal ${id} does not preserve its canonical bytes.`);
      }
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
  const root = join(workspaceRoot, 'sources', 'registry');
  const sources = listFileNames(root)
    .filter((name) => name.endsWith('.json'))
    .map((fileName) => {
      const source = KnowledgeSourceRecordSchema.parse(readJson(join(root, fileName)));

      if (
        fileName !== `${source.id}.json` ||
        source.workspaceId !== workspaceId ||
        (source.originatingThreadId !== null && !threadIds.has(source.originatingThreadId)) ||
        (source.originatingTurnId !== null &&
          turnsById.get(source.originatingTurnId)?.threadId !== source.originatingThreadId)
      ) {
        throw new Error(`Knowledge source ${fileName} has invalid lineage.`);
      }

      return source;
    });

  const sourceIds = new Set(sources.map((source) => source.id));
  for (const ownedRoot of [
    join(workspaceRoot, 'sources', 'materials'),
    join(workspaceRoot, 'sources', 'derived'),
  ]) {
    for (const sourceId of listDirectoryNames(ownedRoot)) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(`Source directory has no registry record: ${sourceId}.`);
      }
    }
  }

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

    const metadata = readJson(metadataPath) as Record<string, unknown>;
    const metadataContent = metadata.content as { body?: unknown; format?: unknown } | undefined;
    const format = metadataContent?.format;

    if (metadataContent && Object.hasOwn(metadataContent, 'body')) {
      throw new Error(`Canonical artifact metadata must not embed content body: ${artifactId}.`);
    }

    if (format !== 'markdown' && format !== 'text' && format !== 'json') {
      throw new Error(`Artifact ${artifactId} has an invalid content format.`);
    }

    const contentPath = join(artifactRoot, 'files', artifactContentFileName(format));
    assertCanonicalDirectory(join(artifactRoot, 'files'));
    const artifact = ArtifactSchema.parse({
      ...metadata,
      content: { format, body: readCanonicalTextFile(contentPath) },
    });

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
 * Loads durable agent session JSON records.
 *
 * @param workspaceRoot Published workspace root.
 * @param workspaceId Owning workspace id.
 * @param threadIds Known thread ids.
 * @returns Agent sessions in directory-name order.
 */
function loadAgentSessions(
  workspaceRoot: string,
  workspaceId: string,
  threadIds: ReadonlySet<string>
): AgentSession[] {
  const root = join(workspaceRoot, 'runtime', 'agent-sessions');

  return listDirectoryNames(root).map((sessionId) => {
    const sessionPath = join(root, sessionId, 'session.json');

    if (!existsSync(sessionPath)) {
      throw new Error(`Canonical agent session directory is missing session.json: ${sessionId}.`);
    }

    const session = AgentSessionRecordSchema.parse(readJson(sessionPath)) as AgentSession;

    if (
      session.id !== sessionId ||
      session.workspaceId !== workspaceId ||
      !session.threadId ||
      !threadIds.has(session.threadId)
    ) {
      throw new Error(`Agent session ${sessionId} has invalid lineage.`);
    }

    return session;
  });
}

/**
 * Validates every record id used to derive a canonical file or directory path.
 *
 * @param records Workspace records about to be published.
 * @throws Error when an id is not a safe canonical owner path.
 */
function assertSafeWorkspaceFileRecordIds(records: WorkspaceFileRecords): void {
  assertSafeWorkspacePathSegment(records.workspace.id, 'Workspace id');
  for (const thread of records.threads) {
    assertSafeWorkspacePathSegment(thread.id, 'Thread id');
  }
  for (const turn of records.turns) {
    assertSafeWorkspacePathSegment(turn.id, 'Turn id');
    assertSafeWorkspacePathSegment(turn.threadId, 'Turn thread id');
    for (const item of turn.items) {
      assertSafeWorkspacePathSegment(item.id, 'Item id');
      assertSafeWorkspacePathSegment(item.threadId, 'Item thread id');
      assertSafeWorkspacePathSegment(item.turnId, 'Item turn id');
    }
  }
  for (const item of records.itemRevisions) {
    assertSafeWorkspacePathSegment(item.id, 'Item id');
    assertSafeWorkspacePathSegment(item.threadId, 'Item thread id');
    assertSafeWorkspacePathSegment(item.turnId, 'Item turn id');
  }
  for (const entry of records.knowledge) {
    for (const segment of KnowledgeProposalPageIdSchema.parse(entry.id).split('/')) {
      assertSafeWorkspacePathSegment(segment, 'Knowledge entry id segment');
    }
  }
  for (const proposal of records.knowledgeProposals) {
    assertSafeWorkspacePathSegment(proposal.id, 'Knowledge proposal id');
  }
  for (const review of records.knowledgeProposalReviews) {
    assertSafeWorkspacePathSegment(review.proposalId, 'Knowledge proposal review id');
  }
  for (const source of records.knowledgeSources) {
    assertSafeWorkspacePathSegment(source.id, 'Knowledge source id');
  }
  for (const artifact of records.artifacts) {
    assertSafeWorkspacePathSegment(artifact.id, 'Artifact id');
  }
  for (const session of records.agentSessions) {
    assertSafeWorkspacePathSegment(session.id, 'Agent session id');
  }
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
 * Writes thread and turn metadata while preserving append-only item and event logs.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param records Current workspace records.
 */
function writeThreads(workspaceRoot: string, records: WorkspaceFileRecords): void {
  const root = join(workspaceRoot, 'threads');
  const expectedThreadIds = new Set(records.threads.map((thread) => thread.id));

  ensureCanonicalDirectory(root);
  removeStaleDirectories(root, expectedThreadIds);

  for (const thread of records.threads) {
    const threadRoot = join(root, thread.id);
    const turnsRoot = join(threadRoot, 'turns');
    const threadTurns = records.turns.filter((turn) => turn.threadId === thread.id);
    const expectedTurnIds = new Set(threadTurns.map((turn) => turn.id));

    ensureCanonicalDirectory(threadRoot);
    ensureCanonicalDirectory(turnsRoot);
    writeJsonAtomic(join(threadRoot, 'thread.json'), thread);
    removeStaleDirectories(turnsRoot, expectedTurnIds);

    for (const turn of threadTurns) {
      const turnRoot = join(turnsRoot, turn.id);
      const itemsPath = join(turnRoot, 'items.jsonl');
      const eventsPath = join(turnRoot, 'runtime', 'events.jsonl');
      const runtimeRoot = dirname(eventsPath);

      ensureCanonicalDirectory(turnRoot);
      writeJsonAtomic(join(turnRoot, 'turn.json'), { ...turn, items: [] });
      const revisions = records.itemRevisions.filter((item) => item.turnId === turn.id);
      const itemLogMetadata = lstatSync(itemsPath, { throwIfNoEntry: false });
      if (!itemLogMetadata) {
        writeFileAtomic(
          itemsPath,
          revisions.map((item) => JSON.stringify(item)).join('\n') + (revisions.length ? '\n' : '')
        );
      } else {
        assertCanonicalRegularFile(itemsPath);
      }
      ensureCanonicalDirectory(runtimeRoot);
      const eventLogMetadata = lstatSync(eventsPath, { throwIfNoEntry: false });
      if (!eventLogMetadata) {
        const events = records.streamEvents.find(([turnId]) => turnId === turn.id)?.[1] ?? [];
        if (events.length > 0) {
          writeFileAtomic(
            eventsPath,
            `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
          );
        }
      } else {
        assertCanonicalRegularFile(eventsPath);
      }
    }
  }
}

/**
 * Serializes one direct user-authored Knowledge Page into its canonical bytes.
 *
 * @param entry Knowledge entry projection to serialize.
 * @returns Exact canonical Markdown bytes written to the Knowledge Store.
 */
export function serializeUserAuthoredKnowledgePage(entry: KnowledgeEntry): string {
  return [
    '---',
    'type: "KnowledgePage"',
    `title: ${JSON.stringify(entry.title)}`,
    `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
    'status: "active"',
    'scope: "workspace"',
    `source_refs: ${JSON.stringify(entry.sourceReferences ?? [])}`,
    'review_state: "user-authored"',
    'sensitivity: "normal"',
    'freshness: "current"',
    `openkit_entry_kind: ${JSON.stringify(entry.kind)}`,
    `created_at: ${JSON.stringify(entry.createdAt)}`,
    `updated_at: ${JSON.stringify(entry.updatedAt)}`,
    `openkit_entry_id: ${JSON.stringify(entry.id)}`,
    '---',
    entry.content,
    '',
  ].join('\n');
}

/**
 * Writes owned knowledge pages, proposals, and reviews.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param records Current workspace records.
 */
function writeKnowledge(workspaceRoot: string, records: WorkspaceFileRecords): void {
  const schemaRoot = join(workspaceRoot, 'knowledge', 'schema');
  const pagesRoot = join(workspaceRoot, 'knowledge', 'pages');
  const proposalsRoot = join(workspaceRoot, 'knowledge', 'proposals');
  const reviewsRoot = join(workspaceRoot, 'knowledge', 'reviews');
  const expectedPages = new Set(records.knowledge.map((entry) => entry.id));
  const expectedProposals = new Set(records.knowledgeProposals.map((record) => `${record.id}.md`));
  const expectedReviews = new Set(
    records.knowledgeProposalReviews.map((record) => `${record.proposalId}.json`)
  );
  const proposalsById = new Map(records.knowledgeProposals.map((record) => [record.id, record]));
  const acceptedProposalByPage = new Map<string, KnowledgeProposalRecord>();
  const reviewsByProposal = new Map<string, KnowledgeProposalReviewRecord[]>();

  for (const review of records.knowledgeProposalReviews) {
    reviewsByProposal.set(review.proposalId, [
      ...(reviewsByProposal.get(review.proposalId) ?? []),
      review,
    ]);
    if (review.decision === 'accepted') {
      const proposal = proposalsById.get(review.proposalId);
      if (proposal) {
        acceptedProposalByPage.set(proposal.knowledgePageId, proposal);
      }
    }
  }

  ensureCanonicalDirectory(schemaRoot);
  ensureCanonicalDirectory(pagesRoot);
  ensureCanonicalDirectory(proposalsRoot);
  ensureCanonicalDirectory(reviewsRoot);
  const schemaPath = join(schemaRoot, 'workspace-schema.yaml');
  const schemaMetadata = lstatSync(schemaPath, { throwIfNoEntry: false });

  if (schemaMetadata) {
    assertCanonicalRegularFile(schemaPath);
  } else {
    writeFileAtomic(schemaPath, DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_TEXT);
  }

  removeStaleFiles(proposalsRoot, expectedProposals, '.md');
  for (const proposal of records.knowledgeProposals) {
    writeFileAtomic(
      join(proposalsRoot, `${proposal.id}.md`),
      serializeKnowledgeProposalRecord(proposal)
    );
  }

  removeStaleFiles(reviewsRoot, expectedReviews, '.json');
  for (const [proposalId, decisions] of reviewsByProposal) {
    writeFileAtomic(
      join(reviewsRoot, `${proposalId}.json`),
      serializeKnowledgeProposalReviewFile(proposalId, decisions[0]!.workspaceId, decisions)
    );
  }

  for (const knowledgePageId of listKnowledgePageIds(pagesRoot)) {
    if (expectedPages.has(knowledgePageId)) {
      continue;
    }
    const path = join(pagesRoot, `${knowledgePageId}.md`);
    const parsed = parseOkfDocument({ path, content: readCanonicalTextFile(path) });
    if (parsed.document && stringFrontmatterField(parsed.document, 'openkit_entry_id')) {
      deleteWorkspaceKnowledgeRecord(workspaceRoot, knowledgePageId);
    }
  }

  for (const entry of records.knowledge) {
    const proposal = acceptedProposalByPage.get(entry.id);
    const currentPageBytes = readWorkspaceKnowledgePage(workspaceRoot, entry.id);
    let currentEntry: KnowledgeEntry | null = null;
    if (currentPageBytes !== null) {
      try {
        currentEntry = parseOwnedKnowledgeEntry(
          `knowledge/pages/${entry.id}.md`,
          entry.id,
          currentPageBytes
        );
      } catch {
        currentEntry = null;
      }
    }
    const proposalEntry = proposal
      ? parseOwnedKnowledgeEntry(
          `knowledge/pages/${proposal.knowledgePageId}.md`,
          proposal.knowledgePageId,
          proposal.canonicalPageBytes
        )
      : null;
    const content =
      currentEntry && knowledgeEntriesEqual(currentEntry, entry)
        ? currentPageBytes!
        : proposalEntry && knowledgeEntriesEqual(proposalEntry, entry) && currentPageBytes === null
          ? proposal!.canonicalPageBytes
          : serializeUserAuthoredKnowledgePage(entry);
    const path = resolveWorkspaceKnowledgePagePath(workspaceRoot, entry.id, true);
    if (!path) {
      throw new Error(`Knowledge Page parent could not be created: ${entry.id}.`);
    }
    writeFileAtomic(path, content);
  }
}

/**
 * Writes source registry records and removes stale owned source directories.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param records Current workspace records.
 */
function writeSources(workspaceRoot: string, records: WorkspaceFileRecords): void {
  const registryRoot = join(workspaceRoot, 'sources', 'registry');
  const materialsRoot = join(workspaceRoot, 'sources', 'materials');
  const derivedRoot = join(workspaceRoot, 'sources', 'derived');
  const expectedFiles = new Set(records.knowledgeSources.map((source) => `${source.id}.json`));
  const expectedIds = new Set(records.knowledgeSources.map((source) => source.id));

  ensureCanonicalDirectory(registryRoot);
  ensureCanonicalDirectory(materialsRoot);
  ensureCanonicalDirectory(derivedRoot);
  removeStaleFiles(registryRoot, expectedFiles, '.json');
  removeStaleDirectories(materialsRoot, expectedIds);
  removeStaleDirectories(derivedRoot, expectedIds);
  for (const source of records.knowledgeSources) {
    writeJsonAtomic(join(registryRoot, `${source.id}.json`), source);
  }
}

/**
 * Writes artifact metadata and bodies.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param records Current workspace records.
 */
function writeArtifacts(workspaceRoot: string, records: WorkspaceFileRecords): void {
  const artifactsRoot = join(workspaceRoot, 'artifacts');
  const expectedArtifactIds = new Set(records.artifacts.map((artifact) => artifact.id));

  ensureCanonicalDirectory(artifactsRoot);
  removeStaleDirectories(artifactsRoot, expectedArtifactIds);

  for (const artifact of records.artifacts) {
    const artifactRoot = join(artifactsRoot, artifact.id);
    const filesRoot = join(artifactRoot, 'files');
    const contentFileName = artifactContentFileName(artifact.content.format);

    ensureCanonicalDirectory(artifactRoot);
    ensureCanonicalDirectory(filesRoot);
    for (const staleFileName of ['content.md', 'content.txt', 'content.json']) {
      if (staleFileName !== contentFileName) {
        rmSync(join(filesRoot, staleFileName), { force: true });
      }
    }
    writeJsonAtomic(join(artifactRoot, 'artifact.json'), {
      ...artifact,
      content: { format: artifact.content.format },
    });
    writeFileAtomic(join(filesRoot, contentFileName), artifact.content.body);
  }
}

/**
 * Writes durable agent session records and removes stale session directories.
 *
 * @param workspaceRoot Resolved workspace root.
 * @param records Current workspace records.
 */
function writeAgentSessions(workspaceRoot: string, records: WorkspaceFileRecords): void {
  const root = join(workspaceRoot, 'runtime', 'agent-sessions');
  const expectedIds = new Set(records.agentSessions.map((session) => session.id));

  ensureCanonicalDirectory(root);
  removeStaleDirectories(root, expectedIds);
  for (const session of records.agentSessions) {
    const sessionRoot = join(root, session.id);

    ensureCanonicalDirectory(sessionRoot);
    writeJsonAtomic(join(sessionRoot, 'session.json'), session);
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

  const content = readCanonicalFile(path);
  if (content.length > 0 && content.at(-1) !== 0x0a) {
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
  normalizeAppendBoundary(path);
  const metadata = lstatSync(path, { throwIfNoEntry: false });

  if (metadata) {
    assertCanonicalRegularFile(path);
  }

  let descriptor: number;
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

  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Canonical path must be a regular file: ${path}.`);
    }
    const bytes = Buffer.from(content);
    let offset = 0;

    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) {
        throw new Error(`Canonical append made no progress: ${path}.`);
      }
      offset += written;
    }
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Writes text through a same-directory temporary file and atomic rename.
 *
 * @param path Target file path.
 * @param content Complete file content.
 */
function writeFileAtomic(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const existingMetadata = lstatSync(path, { throwIfNoEntry: false });
  if (existingMetadata) {
    assertCanonicalRegularFile(path);
  }
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);

  try {
    writeFileSync(temporaryPath, content);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
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
function listDirectoryNames(path: string): string[] {
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
function assertCanonicalRegularFile(path: string): void {
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
 * Creates one canonical directory only after rejecting an existing redirect.
 *
 * @param path Canonical directory path with an already verified parent.
 * @throws Error when the existing or created path is not a real directory.
 */
function ensureCanonicalDirectory(path: string): void {
  const metadata = lstatSync(path, { throwIfNoEntry: false });

  if (metadata) {
    assertCanonicalDirectory(path);
    return;
  }

  mkdirSync(path);
  assertCanonicalDirectory(path);
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

/**
 * Removes the single formatting newline added after a canonical Markdown body.
 *
 * @param body Parsed Markdown body.
 * @returns Original record body.
 */
function trimCanonicalMarkdownBody(body: string): string {
  return body.endsWith('\n') ? body.slice(0, -1) : body;
}
