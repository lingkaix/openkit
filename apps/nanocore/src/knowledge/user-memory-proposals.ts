import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  KnowledgeManagerDraftedProposalSchema,
  KnowledgeProposalReviewSchema,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { prepareAuditEvent } from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import { writeFileAtomic } from '../storage/canonical-write-capacity.js';
import type { CoreDb, UserDb } from '../storage/db.js';
import { knowledgeProposalId } from '../storage/knowledge-proposal-codecs.js';
import {
  ActorRefReaderSchema,
  preserveDescriptiveRecord,
  serializeKnowledgeProposalRecord,
} from '../storage/workspace-file-records.js';
import { admitMemoryContext } from './memory-lifecycle.js';
import { readMemorySuppressions } from './memory-maintenance.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { projectSelectedKnowledgeProposalPreview } from './notebook-proposal-preview.js';
import {
  assertNotebookProposalDecisionEvidence,
  type NotebookEdit,
  type NotebookPublicationAdmission,
  prepareNotebookProposalChanges,
  prepareNotebookProposalReview,
  publishNotebook,
  readNotebookProposalCandidateMaterial,
  retainNotebookProposalCandidate,
  verifyNotebookProposalReviewEvidence,
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
/** Retains a validated candidate through the existing Proposal ref and Markdown family after Workspace acknowledgement. */
export async function createUserMemoryProposal(
  context: UserMemoryProposalContext,
  edit: NotebookEdit,
  producer: ActorRef & { kind: 'agent' },
  sourceReferences: readonly string[]
): Promise<Proposal> {
  admitMemoryContext(context, 'knowledge.write');
  const prepared = await prepareNotebookProposalChanges({
    notebook: notebook(context),
    ownerScope: { kind: 'user', userId: context.userDb.userId },
    edit,
    revalidate: (files, paths) => context.revalidate(files, paths),
  });
  const id = knowledgeProposalId({ kind: 'user', userId: context.userDb.userId }, edit.requestId);
  if (existsSync(proposalPath(context, id))) throw new NotebookError('conflict');
  const revalidate = () => {
    admitMemoryContext(context, 'knowledge.write');
    prepared.revalidate();
  };
  const { changes } = prepared;
  const candidateRevision = await retainNotebookProposalCandidate({
    notebook: prepared.notebook,
    edit,
    changes,
    producer,
    proposalId: id,
    sourceReferences,
    revalidate,
  });
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
  const workspace = await context.store.ensureQuickChatWorkspace(context.userDb.userId);
  admitMemoryContext(context, 'knowledge.write');
  writeFileAtomic(
    proposalPath(context, id),
    serializeKnowledgeProposalRecord({
      ...proposal,
      workspaceId: workspace.id,
    })
  );
  return proposal;
}
/** Reads exact retained bytes and candidate identity under current User Memory authority. */
export async function readUserMemoryProposal(context: UserMemoryProposalContext, id: string) {
  admitMemoryContext(context);
  const bytes = readFileSync(proposalPath(context, id), 'utf8');
  const header = /^---\n([\s\S]*?)\n---\n/.exec(bytes);
  if (!header) throw new NotebookError('recovery_required');
  const meta = parseYaml(header[1]!) as Record<string, unknown>;
  if (meta.type !== 'proposal' || meta.review_required !== true)
    throw new NotebookError('recovery_required');
  const {
    notebook: git,
    candidate,
    base,
    paths,
    changes,
    proposal: rawProposal,
  } = await readNotebookProposalCandidateMaterial(notebook(context), id, meta);
  admitMemoryContext(context);
  const proposal = ProposalReader.parse(rawProposal);
  if (
    proposal.ownerScope.userId !== context.userDb.userId ||
    proposal.baseRevision !== candidate.parentRevision ||
    proposal.producer.kind !== 'agent' ||
    proposal.producer.responsibleUserId !== context.userDb.userId ||
    JSON.stringify(proposal.producer) !== JSON.stringify(candidate.metadata.producer) ||
    proposal.contentDigest !== digest(JSON.stringify(changes)) ||
    candidate.metadata.authority.kind !== 'proposal' ||
    candidate.metadata.authority.proposalId !== id ||
    knowledgeProposalId(proposal.ownerScope, candidate.metadata.changeRequest.requestId) !== id
  )
    throw new NotebookError('recovery_required');
  const retained = await git.retainedCandidateAsync(id);
  admitMemoryContext(context);
  if (retained.revision !== candidate.revision) throw new NotebookError('recovery_required');
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
  const proposalDigest = verifyNotebookProposalReviewEvidence(
    { kind: 'user', userId: context.userDb.userId },
    proposal,
    bytes,
    reviews
  );
  if (
    reviews.some(
      (review) =>
        review.ownerScope.userId !== context.userDb.userId ||
        review.actor.kind !== 'user' ||
        review.actor.id !== context.userDb.userId
    )
  )
    throw new NotebookError('recovery_required');
  if (
    paths.some((path) => ['index.md', 'log.md'].includes(basename(path))) &&
    readMemorySuppressions(admitMemoryContext(context).notebookRoot, context.userDb.userId).length
  )
    throw new NotebookError('invalid_request');
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
    proposalDigest,
    diff: paths.map((path) => ({
      path,
      before: base.files[path] ?? null,
      after: candidate.files[path] ?? null,
    })),
    reviews,
  };
}
/** Uses the existing bounded Unicode candidate preview rather than exposing the private complete record. */
export async function readUserMemoryProposalPreview(
  context: UserMemoryProposalContext,
  input: { readonly proposalId: string; readonly path?: string; readonly offset: number }
) {
  const selected = await readUserMemoryProposal(context, input.proposalId);
  return projectSelectedKnowledgeProposalPreview(selected, input);
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
  admitMemoryContext(context, 'review.apply');
  const selected = await readUserMemoryProposal(context, request.proposalId);
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
    if (prior.decision !== 'accepted') {
      assertNotebookProposalDecisionEvidence(
        { kind: 'user', userDb: context.userDb },
        request,
        prior
      );
      return { review: prior, notebookRevision: null };
    }
  }
  if (!prior && selected.reviews.some((review) => review.decision !== 'deferred'))
    throw new NotebookError('conflict');
  if (
    !prior &&
    request.decision === 'accepted' &&
    notebook(context).publishedRevision() !== proposal.baseRevision
  )
    throw new NotebookError('conflict');
  if (!prior)
    assertNotebookProposalDecisionEvidence({ kind: 'user', userDb: context.userDb }, request);
  const review =
    prior ??
    UserReviewSchema.parse(
      prepareNotebookProposalReview(
        { kind: 'user', userId: context.userDb.userId },
        proposal,
        request,
        { kind: 'user', id: context.actor.userId }
      )
    );
  const recordDecision = async () => {
    admitMemoryContext(context, 'review.apply');
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
      await context.store.commitScopedNotebookStage(context.userDb, {
        kind: 'audit',
        event: prepareAuditEvent({
          workspaceId: null,
          requestId: request.requestId,
          actor: { kind: 'user', id: context.actor.userId },
          category: 'knowledge',
          action: 'knowledge.proposal.decide',
          resource: `knowledge-proposal:${proposal.id}`,
          outcome: 'succeeded',
          summary: 'User Memory Proposal decision retained.',
        }),
      });
  };
  if (request.decision !== 'accepted') {
    await recordDecision();
    return { review, notebookRevision: null };
  }
  admitMemoryContext(context, 'knowledge.write');
  const prepared = await notebook(context).withPreparedReadsAsync([
    proposal.baseRevision,
    proposal.candidateRevision,
  ]);
  const publication = await publishNotebook(
    {
      owner: { kind: 'user', userDb: context.userDb },
      store: context.store,
      inflightCommands: context.inflightCommands,
      notebook: prepared,
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
        admitMemoryContext(context, 'knowledge.write');
        context.revalidate(prepared.readRevision(proposal.baseRevision).files);
        return context.revalidate(
          prepared.readRevision(proposal.candidateRevision).files,
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
