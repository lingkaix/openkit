import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ServerKnowledgeProposalSchema,
  ServerKnowledgeReviewSchema,
} from '@openkit/app-api-schemas';
import { type ActorRef, deriveEntityId } from '@openkit/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { requireCurrentDeploymentAdmin } from '../auth/operation-authorizer.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { type FsStore, knowledgeAuthorityId } from '../lib/store.js';
import { commandInputHash, type InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import type { CoreDb } from '../storage/db.js';
import {
  ActorRefReaderSchema,
  preserveDescriptiveRecord,
  serializeKnowledgeProposalRecord,
  writeFileAtomic,
} from '../storage/workspace-file-records.js';
import { KnowledgeNotebook, NotebookError } from './notebook.js';
import { projectKnowledgeProposalPreview } from './notebook-proposal-preview.js';
import {
  attributedNotebookPageBytes,
  type NotebookEdit,
  type NotebookPublicationAdmission,
  publishNotebook,
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
  readonly revalidate: () => NotebookPublicationAdmission;
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
  requireCurrentDeploymentAdmin(context.coreDb, context.actor);
  const git = notebook(context.coreDb);
  if (git.publishedRevision() !== edit.baseRevision)
    throw new NotebookError('conflict', git.publishedRevision());
  const base = git.readRevision(edit.baseRevision);
  const changes = edit.changes
    .map(({ path, content }) => ({
      path,
      content:
        content === null || base.files[path] === content
          ? content
          : attributedNotebookPageBytes(path, content, { kind: 'server' }, 'delegated'),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = { ...base.files };
  for (const { path, content } of changes) {
    if (content === null) delete files[path];
    else files[path] = content;
  }
  const report = validateNotebookCandidate({
    ownerScope: { kind: 'server' },
    base,
    candidate: { files },
    ...context.revalidate(),
  });
  if (report.errors.length) throw new NotebookError('invalid_request');
  const id = knowledgeAuthorityId('kp_', { ownerScope: 'server', requestId: edit.requestId });
  if (existsSync(proposalPath(context.coreDb, id))) throw new NotebookError('conflict');
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
  requireCurrentDeploymentAdmin(context.coreDb, context.actor);
  const bytes = readFileSync(proposalPath(context.coreDb, id), 'utf8');
  const header = /^---\n([\s\S]*?)\n---\n/.exec(bytes);
  if (!header) throw new NotebookError('recovery_required');
  const meta = parseYaml(header[1]!) as Record<string, unknown>;
  if (meta.type !== 'proposal' || meta.review_required !== true)
    throw new NotebookError('recovery_required');
  const git = notebook(context.coreDb);
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
    proposal.contentDigest !== digest(JSON.stringify(changes)) ||
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
  if (
    reviews.some(
      (review) =>
        review.proposalId !== id ||
        review.baseRevision !== proposal.baseRevision ||
        review.candidateRevision !== proposal.candidateRevision
    )
  )
    throw new NotebookError('recovery_required');
  const validation = validateNotebookCandidate({
    ownerScope: { kind: 'server' },
    base,
    candidate: { files: candidate.files },
    ...context.revalidate(),
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
export function readServerNotebookProposalPreview(
  context: ServerNotebookProposalContext,
  input: { readonly proposalId: string; readonly path?: string; readonly offset: number }
) {
  const selected = readServerNotebookProposal(context, input.proposalId);
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
    if (prior.decision !== 'accepted') return { review: prior, notebookRevision: null };
  }
  if (!prior && selected.reviews.some((review) => review.decision !== 'deferred'))
    throw new NotebookError('conflict');
  const review =
    prior ??
    ServerKnowledgeReviewSchema.parse({
      proposalId: proposal.id,
      ownerScope: { kind: 'server' },
      baseRevision: proposal.baseRevision,
      candidateRevision: proposal.candidateRevision,
      reviewId: deriveEntityId('kr', {
        ownerScope: { kind: 'server' },
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
    requireCurrentDeploymentAdmin(context.coreDb, context.actor);
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
  };
  if (request.decision !== 'accepted') {
    recordDecision();
    return { review, notebookRevision: null };
  }
  const publication = await publishNotebook(
    {
      owner: { kind: 'server', coreDb: context.coreDb },
      store: context.store,
      inflightCommands: context.inflightCommands,
      notebook: notebook(context.coreDb),
      producer: proposal.producer,
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
        requireCurrentDeploymentAdmin(context.coreDb, context.actor);
        return context.revalidate();
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
