import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ServerKnowledgeProposalSchema,
  ServerKnowledgeReviewSchema,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { prepareAuditEvent } from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import { requireAdministratorOperation } from '../auth/operation-authorizer.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { type FsStore, knowledgeAuthorityId } from '../lib/store.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import type { CoreDb } from '../storage/db.js';
import {
  ActorRefReaderSchema,
  preserveDescriptiveRecord,
  serializeKnowledgeProposalRecord,
  writeFileAtomic,
} from '../storage/workspace-file-records.js';
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

type Proposal = z.infer<typeof ServerKnowledgeProposalSchema>;
type Review = z.infer<typeof ServerKnowledgeReviewSchema>;
const ProposalReader = ServerKnowledgeProposalSchema.safeExtend({
  ownerScope: z.object({ kind: z.literal('server') }).strip(),
  producer: ActorRefReaderSchema,
}).strip();
const ReviewReader = ServerKnowledgeReviewSchema.safeExtend({
  ownerScope: z.object({ kind: z.literal('server') }).strip(),
  actor: ActorRefReaderSchema,
}).strip();
const ReviewFileReader = z
  .object({
    ownerScope: z.object({ kind: z.literal('server') }).strip(),
    proposalId: z.string().regex(/^kp_[a-f0-9]{64}$/),
    decisions: z.array(ReviewReader),
  })
  .strip();

/** Existing Server authority and publisher dependencies; models cannot supply this context. */
export interface ServerNotebookProposalContext {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly actor: Actor;
  readonly runtimeConfigManager: RuntimeConfigManager;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Native callers supply exact retained candidate or preview-side bytes for current disclosure checks. */
  readonly revalidate: (files?: Readonly<Record<string, string>>) => NotebookPublicationAdmission;
}
/** Same Proposal identity and retained Markdown format, now at its actual Server owner. */
function proposalPath(coreDb: CoreDb, id: string): string {
  if (!/^kp_[a-f0-9]{64}$/.test(id)) throw new NotebookError('invalid_request');
  return join(coreDb.dataRoot, 'server', 'knowledge', 'proposals', `${id}.md`);
}
function notebook(coreDb: CoreDb): KnowledgeNotebook {
  return new KnowledgeNotebook({
    repositoryPath: join(coreDb.dataRoot, 'server', 'knowledge', 'notebook.git'),
  });
}
function digest(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/** Retains a validated candidate through the existing Proposal ref and Markdown family. */
export function createServerNotebookProposal(
  context: ServerNotebookProposalContext,
  edit: NotebookEdit,
  producer: ActorRef & { kind: 'agent' },
  sourceReferences: readonly string[]
): Proposal {
  requireAdministratorOperation(
    context.coreDb,
    context.actor,
    'knowledge.write',
    undefined,
    'knowledge'
  );
  const git = notebook(context.coreDb);
  const changes = prepareNotebookProposalChanges({
    notebook: git,
    ownerScope: { kind: 'server' },
    edit,
    revalidate: (files) => context.revalidate(files),
  });
  const id = knowledgeAuthorityId('kp_', { ownerScope: 'server', requestId: edit.requestId });
  if (existsSync(proposalPath(context.coreDb, id))) throw new NotebookError('conflict');
  const candidateRevision = retainNotebookProposalCandidate({
    notebook: git,
    edit,
    changes,
    producer,
    proposalId: id,
    sourceReferences,
  });
  const proposal = ServerKnowledgeProposalSchema.parse({
    id,
    operation: 'notebook-change',
    ownerScope: { kind: 'server' },
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
  writeFileAtomic(proposalPath(context.coreDb, id), serializeKnowledgeProposalRecord(proposal));
  return proposal;
}
/** Reads exact retained bytes and candidate identity under current Server authority. */
export function readServerNotebookProposal(context: ServerNotebookProposalContext, id: string) {
  requireAdministratorOperation(
    context.coreDb,
    context.actor,
    'knowledge.read',
    undefined,
    'knowledge'
  );
  const bytes = readFileSync(proposalPath(context.coreDb, id), 'utf8');
  const header = /^---\n([\s\S]*?)\n---\n/.exec(bytes);
  if (!header) throw new NotebookError('recovery_required');
  const meta = parseYaml(header[1]!) as Record<string, unknown>;
  if (meta.type !== 'proposal' || meta.review_required !== true)
    throw new NotebookError('recovery_required');
  const git = notebook(context.coreDb);
  const {
    candidate,
    base,
    paths,
    changes,
    proposal: rawProposal,
  } = readNotebookProposalCandidateMaterial(git, id, meta);
  const proposal = ProposalReader.parse(rawProposal);
  if (proposal.baseRevision !== candidate.parentRevision)
    throw new NotebookError('recovery_required');
  if (
    proposal.contentDigest !== digest(JSON.stringify(changes)) ||
    JSON.stringify(proposal.producer) !== JSON.stringify(candidate.metadata.producer) ||
    candidate.metadata.authority.kind !== 'proposal' ||
    candidate.metadata.authority.proposalId !== id ||
    git.retainedCandidate(id).revision !== candidate.revision
  )
    throw new NotebookError('recovery_required');
  const reviewPath = join(context.coreDb.dataRoot, 'server', 'knowledge', 'reviews', `${id}.json`);
  const raw = existsSync(reviewPath)
    ? (JSON.parse(readFileSync(reviewPath, 'utf8')) as { decisions?: unknown })
    : { ownerScope: { kind: 'server' }, proposalId: id, decisions: [] };
  const reviewFile = ReviewFileReader.parse(raw);
  if (reviewFile.proposalId !== id) throw new NotebookError('recovery_required');
  const reviews = reviewFile.decisions;
  const proposalDigest = verifyNotebookProposalReviewEvidence(
    { kind: 'server' },
    proposal,
    bytes,
    reviews
  );
  // Preview discloses both sides; each needs its own exact current Source closure.
  context.revalidate(base.files);
  const validation = validateNotebookCandidate({
    ownerScope: { kind: 'server' },
    base,
    candidate: { files: candidate.files },
    ...context.revalidate(candidate.files),
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
export function readServerNotebookProposalPreview(
  context: ServerNotebookProposalContext,
  input: {
    readonly proposalId: string;
    readonly path?: string | undefined;
    readonly offset: number;
  }
) {
  const selected = readServerNotebookProposal(context, input.proposalId);
  return projectSelectedKnowledgeProposalPreview(selected, input);
}

/** Human Review keeps the original Agent producer and uses the existing fixed-base publisher. */
export async function decideServerNotebookProposal(
  context: ServerNotebookProposalContext,
  request: {
    readonly proposalId: string;
    readonly requestId: string;
    readonly proposalDigest: string;
    readonly baseRevision: string;
    readonly candidateRevision: string;
    readonly decision: 'accepted' | 'rejected' | 'deferred';
  }
): Promise<{ review: Review; notebookRevision: string | null }> {
  const selected = readServerNotebookProposal(context, request.proposalId);
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
        { kind: 'server', coreDb: context.coreDb },
        request,
        prior
      );
      return { review: prior, notebookRevision: null };
    }
  }
  if (!prior && selected.reviews.some((review) => review.decision !== 'deferred'))
    throw new NotebookError('conflict');
  if (!prior)
    assertNotebookProposalDecisionEvidence({ kind: 'server', coreDb: context.coreDb }, request);
  const review =
    prior ??
    ServerKnowledgeReviewSchema.parse(
      prepareNotebookProposalReview({ kind: 'server' }, proposal, request, {
        kind: 'user',
        id: context.actor.userId,
      })
    );
  const recordDecision = async () => {
    requireAdministratorOperation(
      context.coreDb,
      context.actor,
      'review.apply',
      undefined,
      'knowledge'
    );
    if (prior) return;
    const path = join(
      context.coreDb.dataRoot,
      'server',
      'knowledge',
      'reviews',
      `${proposal.id}.json`
    );
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    const previous = raw === undefined ? undefined : ReviewFileReader.parse(raw);
    const next = {
      ownerScope: { kind: 'server' },
      proposalId: proposal.id,
      decisions: [...selected.reviews, review],
    };
    writeFileAtomic(
      path,
      `${JSON.stringify(preserveDescriptiveRecord(raw, previous, next), null, 2)}\n`
    );
    // Accepted decisions receive the common publisher's exact admission/completion Audit.
    if (request.decision !== 'accepted')
      await context.store.commitScopedNotebookStage(context.coreDb, {
        kind: 'audit',
        event: prepareAuditEvent({
          workspaceId: null,
          requestId: request.requestId,
          actor: { kind: 'user', id: context.actor.userId },
          category: 'knowledge',
          action: 'knowledge.proposal.decide',
          resource: `knowledge-proposal:${proposal.id}`,
          outcome: 'succeeded',
          summary: 'Server Knowledge Proposal decision retained.',
        }),
      });
  };
  if (request.decision !== 'accepted') {
    await recordDecision();
    return { review, notebookRevision: null };
  }
  const publication = await publishNotebook(
    {
      owner: { kind: 'server', coreDb: context.coreDb },
      store: context.store,
      inflightCommands: context.inflightCommands,
      notebook: notebook(context.coreDb),
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
        requireAdministratorOperation(
          context.coreDb,
          context.actor,
          'knowledge.write',
          undefined,
          'knowledge'
        );
        return context.revalidate(
          notebook(context.coreDb).readRevision(proposal.candidateRevision).files
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
