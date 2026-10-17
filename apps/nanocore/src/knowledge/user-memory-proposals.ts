import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KnowledgeManagerDraftedProposalSchema,
  KnowledgeProposalReviewSchema,
} from '@openkit/app-api-schemas';
import { type ActorRef, deriveEntityId } from '@openkit/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { recordUserAuditEvent } from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { type FsStore, knowledgeAuthorityId } from '../lib/store.js';
import { commandInputHash, type InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import type { CoreDb, UserDb } from '../storage/db.js';
import {
  ActorRefReaderSchema,
  preserveDescriptiveRecord,
  serializeKnowledgeProposalRecord,
  writeFileAtomic,
} from '../storage/workspace-file-records.js';
import { admitMemoryContext } from './memory-lifecycle.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { projectKnowledgeProposalPreview } from './notebook-proposal-preview.js';
import {
  attributedNotebookPageBytes,
  type NotebookEdit,
  type NotebookPublicationAdmission,
  publishNotebook,
} from './notebook-publication.js';
import { validateNotebookCandidate } from './notebook-validation.js';

const UserOwner = z.object({ kind: z.literal('user'), userId: z.string() }).strip();
const { workspaceId: _proposalWorkspace, ...proposalShape } =
  KnowledgeManagerDraftedProposalSchema.shape;
const UserProposalSchema = z
  .object({ ...proposalShape, ownerScope: UserOwner })
  .refine(
    (proposal) =>
      !!proposal.changes?.length &&
      proposal.knowledgePageId === undefined &&
      proposal.canonicalPageBytes === undefined
  );
const { workspaceId: _reviewWorkspace, ...reviewShape } = KnowledgeProposalReviewSchema.shape;
const UserReviewSchema = z
  .object({ ...reviewShape, ownerScope: UserOwner })
  .refine((review) => !!review.changedPageIds?.length && review.knowledgePageId === undefined);

/** Existing exact multi-page Proposal, with the User owner and no Workspace identity. */
type Proposal = z.infer<typeof UserProposalSchema>;
type Review = z.infer<typeof UserReviewSchema>;
const ProposalReader = UserProposalSchema.safeExtend({
  ownerScope: UserOwner,
  producer: ActorRefReaderSchema,
}).strip();
const ReviewReader = UserReviewSchema.safeExtend({
  ownerScope: UserOwner,
  actor: ActorRefReaderSchema,
}).strip();
const ReviewFileReader = z
  .object({
    ownerScope: UserOwner,
    proposalId: z.string().regex(/^kp_[a-f0-9]{64}$/),
    decisions: z.array(ReviewReader),
  })
  .strip();

/** Existing User Memory authority and publisher dependencies; models cannot supply this context. */
export interface UserMemoryProposalContext {
  readonly coreDb: CoreDb;
  readonly userDb: UserDb;
  readonly store: FsStore;
  readonly actor: Actor;
  readonly runtimeConfigManager: RuntimeConfigManager;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly revalidate: (
    files: Readonly<Record<string, string>>,
    changedPaths?: readonly string[]
  ) => NotebookPublicationAdmission;
}
/** Same Proposal identity and retained Markdown format, now at its actual User Memory owner. */
function proposalPath(context: UserMemoryProposalContext, id: string): string {
  if (!/^kp_[a-f0-9]{64}$/.test(id)) throw new NotebookError('invalid_request');
  return join(admitMemoryContext(context).notebookRoot, 'proposals', `${id}.md`);
}
function notebook(context: UserMemoryProposalContext): KnowledgeNotebook {
  return new KnowledgeNotebook({
    repositoryPath: join(admitMemoryContext(context).notebookRoot, 'notebook.git'),
  });
}
function digest(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/** Retains a validated candidate through the existing Proposal ref and Markdown family. */
export function createUserMemoryProposal(
  context: UserMemoryProposalContext,
  edit: NotebookEdit,
  producer: ActorRef & { kind: 'agent' },
  sourceReferences: readonly string[]
): Proposal {
  admitMemoryContext(context);
  const git = notebook(context);
  if (git.publishedRevision() !== edit.baseRevision)
    throw new NotebookError('conflict', git.publishedRevision());
  const base = git.readRevision(edit.baseRevision);
  const changes = edit.changes
    .map(({ path, content }) => ({
      path,
      content:
        content === null || base.files[path] === content
          ? content
          : attributedNotebookPageBytes(
              path,
              content,
              { kind: 'user', userId: context.userDb.userId },
              'delegated'
            ),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = { ...base.files };
  for (const { path, content } of changes) {
    if (content === null) delete files[path];
    else files[path] = content;
  }
  const report = validateNotebookCandidate({
    ownerScope: { kind: 'user', userId: context.userDb.userId },
    base,
    candidate: { files },
    ...context.revalidate(
      files,
      changes.map(({ path }) => path)
    ),
  });
  if (report.errors.length) throw new NotebookError('invalid_request');
  const id = knowledgeAuthorityId('kp_', {
    ownerScope: `user:${context.userDb.userId}`,
    requestId: edit.requestId,
  });
  if (existsSync(proposalPath(context, id))) throw new NotebookError('conflict');
  const candidateRevision = git.prepare({
    baseRevision: edit.baseRevision,
    changes: Object.fromEntries(changes.map(({ path, content }) => [path, content])),
    metadata: {
      summary: edit.summary,
      changeRequest: {
        requestId: edit.requestId,
        inputDigest: commandInputHash({ ...edit, producer }),
      },
      producer,
      authority: { kind: 'proposal', proposalId: id },
      sourceReferences: [...sourceReferences],
    },
  });
  git.retainCandidate({ proposalId: id, candidateRevision });
  const proposal = UserProposalSchema.parse({
    id,
    operation: 'notebook-change',
    ownerScope: { kind: 'user', userId: context.userDb.userId },
    baseRevision: edit.baseRevision,
    candidateRevision,
    changes,
    contentDigest: digest(JSON.stringify(changes)),
    sourceReferences: [...sourceReferences],
    rationale: edit.summary,
    producer,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  writeFileAtomic(
    proposalPath(context, id),
    serializeKnowledgeProposalRecord({
      ...proposal,
      workspaceId: context.store.ensureQuickChatWorkspace(context.userDb.userId).id,
    })
  );
  return proposal;
}
/** Reads exact retained bytes and candidate identity under current User Memory authority. */
export function readUserMemoryProposal(context: UserMemoryProposalContext, id: string) {
  admitMemoryContext(context);
  const bytes = readFileSync(proposalPath(context, id), 'utf8');
  const header = /^---\n([\s\S]*?)\n---\n/.exec(bytes);
  if (!header) throw new NotebookError('recovery_required');
  const meta = parseYaml(header[1]!) as Record<string, unknown>;
  if (meta.type !== 'proposal' || meta.review_required !== true)
    throw new NotebookError('recovery_required');
  const git = notebook(context);
  if (typeof meta.candidate_revision !== 'string' || typeof meta.base_revision !== 'string')
    throw new NotebookError('recovery_required');
  const candidate = git.readRevision(meta.candidate_revision);
  const base = git.readRevision(meta.base_revision);
  const paths = [...new Set([...Object.keys(base.files), ...Object.keys(candidate.files)])]
    .filter((path) => base.files[path] !== candidate.files[path])
    .sort();
  const changes = paths.map((path) => ({ path, content: candidate.files[path] ?? null }));
  const proposal = ProposalReader.parse({
    id,
    operation: meta.operation,
    ownerScope: meta.owner_scope,
    baseRevision: meta.base_revision,
    candidateRevision: meta.candidate_revision,
    changes,
    contentDigest: meta.content_digest,
    sourceReferences: meta.source_references,
    rationale: meta.rationale,
    producer: meta.producer,
    status: 'pending',
    createdAt: meta.created_at,
  });
  if (
    proposal.ownerScope.userId !== context.userDb.userId ||
    proposal.baseRevision !== candidate.parentRevision ||
    proposal.producer.kind !== 'agent' ||
    proposal.producer.responsibleUserId !== context.userDb.userId ||
    JSON.stringify(proposal.producer) !== JSON.stringify(candidate.metadata.producer) ||
    proposal.contentDigest !== digest(JSON.stringify(changes)) ||
    candidate.metadata.authority.kind !== 'proposal' ||
    candidate.metadata.authority.proposalId !== id ||
    git.retainedCandidate(id).revision !== candidate.revision
  )
    throw new NotebookError('recovery_required');
  const reviewPath = join(admitMemoryContext(context).notebookRoot, 'reviews', `${id}.json`);
  const raw = existsSync(reviewPath)
    ? (JSON.parse(readFileSync(reviewPath, 'utf8')) as { decisions?: unknown })
    : {
        ownerScope: { kind: 'user', userId: context.userDb.userId },
        proposalId: id,
        decisions: [],
      };
  const reviewFile = ReviewFileReader.parse(raw);
  if (reviewFile.proposalId !== id || reviewFile.ownerScope.userId !== context.userDb.userId)
    throw new NotebookError('recovery_required');
  const reviews = reviewFile.decisions;
  if (
    new Set(reviews.map(({ requestId }) => requestId)).size !== reviews.length ||
    reviews.some(
      (review, index) =>
        reviews.slice(0, index).some((prior) => prior.decision !== 'deferred') ||
        review.reviewId !==
          deriveEntityId('kr', {
            ownerScope: { kind: 'user', userId: context.userDb.userId },
            proposalId: id,
            requestId: review.requestId,
          }) ||
        review.proposalDigest !== digest(bytes) ||
        review.contentDigest !== proposal.contentDigest ||
        review.ownerScope.userId !== context.userDb.userId ||
        review.actor.kind !== 'user' ||
        review.actor.id !== context.userDb.userId ||
        review.proposalId !== id ||
        review.baseRevision !== proposal.baseRevision ||
        review.candidateRevision !== proposal.candidateRevision
    )
  )
    throw new NotebookError('recovery_required');
  const baseAdmission = context.revalidate(base.files);
  const candidateAdmission = context.revalidate(candidate.files, paths);
  const validation = validateNotebookCandidate({
    ownerScope: { kind: 'user', userId: context.userDb.userId },
    base,
    candidate: { files: candidate.files },
    ...candidateAdmission,
    registeredSources: new Map([
      ...baseAdmission.registeredSources,
      ...candidateAdmission.registeredSources,
    ]),
  });
  if (validation.errors.length) throw new NotebookError('recovery_required');
  return {
    proposal,
    proposalDigest: digest(bytes),
    diff: paths.map((path) => ({
      path,
      before: base.files[path] ?? null,
      after: candidate.files[path] ?? null,
    })),
    reviews,
  };
}
/** Uses the existing bounded Unicode candidate preview rather than exposing the private complete record. */
export function readUserMemoryProposalPreview(
  context: UserMemoryProposalContext,
  input: { readonly proposalId: string; readonly path?: string; readonly offset: number }
) {
  const selected = readUserMemoryProposal(context, input.proposalId);
  const before = Object.fromEntries(
    selected.diff.flatMap((change) =>
      change.before === null ? [] : [[change.path, change.before]]
    )
  );
  const after = Object.fromEntries(
    selected.diff.flatMap((change) => (change.after === null ? [] : [[change.path, change.after]]))
  );
  return projectKnowledgeProposalPreview(
    {
      proposalId: selected.proposal.id,
      proposalDigest: selected.proposalDigest,
      baseRevision: selected.proposal.baseRevision,
      candidateRevision: selected.proposal.candidateRevision,
      paths: selected.diff.map((change) => change.path),
    },
    before,
    after,
    input
  );
}

/** Human Review keeps the original Agent producer and uses the existing fixed-base publisher. */
export async function decideUserMemoryProposal(
  context: UserMemoryProposalContext,
  request: {
    readonly proposalId: string;
    readonly requestId: string;
    readonly proposalDigest: string;
    readonly baseRevision: string;
    readonly candidateRevision: string;
    readonly decision: 'accepted' | 'rejected' | 'deferred';
  }
): Promise<{ review: Review; notebookRevision: string | null }> {
  const selected = readUserMemoryProposal(context, request.proposalId);
  const { proposal } = selected;
  if (
    selected.proposalDigest !== request.proposalDigest ||
    proposal.baseRevision !== request.baseRevision ||
    proposal.candidateRevision !== request.candidateRevision
  )
    throw new NotebookError('conflict');
  const prior = selected.reviews.find((review) => review.requestId === request.requestId);
  if (prior) {
    if (prior.decision !== request.decision) throw new NotebookError('conflict');
    if (prior.decision !== 'accepted') return { review: prior, notebookRevision: null };
  }
  if (!prior && selected.reviews.some((review) => review.decision !== 'deferred'))
    throw new NotebookError('conflict');
  if (!prior && notebook(context).publishedRevision() !== proposal.baseRevision)
    throw new NotebookError('conflict');
  const review =
    prior ??
    UserReviewSchema.parse({
      proposalId: proposal.id,
      ownerScope: { kind: 'user', userId: context.userDb.userId },
      baseRevision: proposal.baseRevision,
      candidateRevision: proposal.candidateRevision,
      reviewId: deriveEntityId('kr', {
        ownerScope: { kind: 'user', userId: context.userDb.userId },
        proposalId: proposal.id,
        requestId: request.requestId,
      }),
      requestId: request.requestId,
      decision: request.decision,
      actor: { kind: 'user', id: context.actor.userId },
      proposalDigest: request.proposalDigest,
      changedPageIds: proposal.changes!.map(({ path }) => path.slice(0, -3)),
      contentDigest: proposal.contentDigest,
      targetAbsentAtDecision: null,
      decidedAt: new Date().toISOString(),
    });
  const recordDecision = () => {
    admitMemoryContext(context);
    if (prior) return;
    const path = join(admitMemoryContext(context).notebookRoot, 'reviews', `${proposal.id}.json`);
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    const previous = raw === undefined ? undefined : ReviewFileReader.parse(raw);
    const next = {
      ownerScope: { kind: 'user', userId: context.userDb.userId },
      proposalId: proposal.id,
      decisions: [...selected.reviews, review],
    };
    writeFileAtomic(
      path,
      `${JSON.stringify(preserveDescriptiveRecord(raw, previous, next), null, 2)}\n`
    );
    // Accepted decisions receive the common publisher's admission/completion Audit, including its exact tuple.
    if (request.decision !== 'accepted')
      recordUserAuditEvent({
        userDb: context.userDb,
        requestId: request.requestId,
        actor: { kind: 'user', id: context.actor.userId },
        category: 'knowledge',
        action: 'knowledge.proposal.decide',
        resource: `knowledge-proposal:${proposal.id}`,
        outcome: 'succeeded',
        summary: 'User Memory Proposal decision retained.',
      });
  };
  if (request.decision !== 'accepted') {
    recordDecision();
    return { review, notebookRevision: null };
  }
  const publication = await publishNotebook(
    {
      owner: { kind: 'user', userDb: context.userDb },
      store: context.store,
      inflightCommands: context.inflightCommands,
      notebook: notebook(context),
      producer: proposal.producer,
      command: { name: 'knowledge.proposal.decide', input: request },
      actor: { kind: 'user', id: context.actor.userId },
      reviewedCandidate: {
        proposalId: proposal.id,
        candidateRevision: proposal.candidateRevision,
        recordDecision,
      },
      confirmedRemovals: Object.fromEntries(
        selected.diff
          .filter((change) => change.after === null && change.before !== null)
          .map((change) => [change.path, change.before!])
      ),
      revalidate: () => {
        admitMemoryContext(context);
        context.revalidate(notebook(context).readRevision(proposal.baseRevision).files);
        return context.revalidate(
          notebook(context).readRevision(proposal.candidateRevision).files,
          proposal.changes!.map(({ path }) => path)
        );
      },
    },
    {
      requestId: request.requestId,
      baseRevision: proposal.baseRevision,
      changes: proposal.changes!,
      summary: proposal.rationale,
    }
  );
  return { review, notebookRevision: publication.notebookRevision };
}
