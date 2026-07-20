import { randomUUID } from 'node:crypto';
import type {
  KnowledgeManagerAnswerResponse,
  KnowledgeManagerCallerSchema,
  KnowledgeManagerDraftProposalResponse,
  KnowledgeManagerHealthCheckResponse,
  KnowledgeManagerPrepareContextResponse,
  KnowledgeManagerSuggestRepairResponse,
} from '@openkit/app-api-schemas';
import type { KnowledgeEntrySchema } from '@openkit/protocol';
import type { z } from 'zod';
import { createWorkerContextPackageAuthorityReader } from './context/worker-context-authorities.js';
import { readPortableWorkerContextPackageTrace } from './context/worker-context-package.js';
import { type KnowledgePageReferenceProof, KnowledgePageValidationError } from './knowledge/okf.js';
import type { FsStore, KnowledgeProposalRecord } from './lib/store.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { resolveDataRootPath } from './storage/fs-layout.js';
import {
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';

/** Workspace Knowledge Page projection consumed by request-scoped Knowledge operations. */
export type WorkspaceKnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

/** Input for one deterministic Knowledge Manager answer operation. */
export interface AnswerKnowledgeManagerInput {
  /** File-backed NanoCore data root that owns the governed retrieval trace. */
  dataRoot: string;
  /** Operation id assigned by NanoCore. */
  operationId: string;
  /** Workspace that owns the query. */
  workspaceId: string;
  /** Caller that requested the answer. */
  caller: 'assistant' | 'app-api';
  /** User or coordinator query. */
  query: string;
  /** Maximum number of selected Knowledge Pages. */
  limit?: number | undefined;
  /** Exact Page-bound source-authority proofs for this request. */
  referenceProofs?: ReadonlyMap<string, KnowledgePageReferenceProof> | undefined;
}

/** Input for one deterministic Knowledge Manager context-material operation. */
export interface PrepareKnowledgeContextInput {
  /** File-backed NanoCore data root that owns the governed retrieval trace. */
  dataRoot: string;
  /** Operation id assigned by NanoCore. */
  operationId: string;
  /** Workspace that owns the context request. */
  workspaceId: string;
  /** Caller that requested context material. */
  caller: 'app-api';
  /** Coordinator query used to select material. */
  query: string;
  /** Maximum number of source entries to include. */
  limit?: number | undefined;
  /** Exact Page-bound source-authority proofs for this request. */
  referenceProofs?: ReadonlyMap<string, KnowledgePageReferenceProof> | undefined;
}

/** Input for the direct Task Mode Knowledge preparation boundary. */
export interface PrepareTaskKnowledgeContextInput {
  /** File-backed NanoCore data root that owns the governed retrieval trace. */
  readonly dataRoot: string;
  /** Workspace that owns the direct Task. */
  readonly workspaceId: string;
  /** Exact immutable Task input used as the governed retrieval query. */
  readonly query: string;
  /** Deterministic Task-owned retrieval trace id. */
  readonly traceId: string;
  /** Exact Page-bound source-authority proofs for this request. */
  readonly referenceProofs?: ReadonlyMap<string, KnowledgePageReferenceProof> | undefined;
}

/** Exact S17 result consumed by the direct Task owner. */
export interface PreparedTaskKnowledgeContext {
  /** Existing S61 trace that owns the Task Knowledge selection. */
  readonly retrievalTraceId: string;
}

/** Input for one deterministic Knowledge Manager proposal draft operation. */
export interface DraftKnowledgeProposalInput {
  /** Operation id assigned by NanoCore. */
  operationId: string;
  /** Workspace that owns the proposal. */
  workspaceId: string;
  /** Caller that requested the proposal. */
  caller: z.infer<typeof KnowledgeManagerCallerSchema>;
  /** Stored pending proposal. */
  proposal: KnowledgeProposalRecord;
  /** Whether exact current owners prove the completed-work reference trio. */
  generatedFromCompletedWorkHistory: boolean;
}

/** Exact completed-work evidence accepted from one proposal request. */
export interface KnowledgeProposalWorkHistoryVerification {
  /** Exact non-Knowledge references already verified by their owning domains. */
  readonly verifiedExternalReferences: readonly string[];
}

/**
 * Verifies the sole completed-work reference shape against current Turn, Item, and S39 owners.
 *
 * @param input Proposal references and existing owner handles.
 * @returns Exact references safe to pass through the Knowledge Store boundary.
 * @throws KnowledgePageValidationError when any claimed completed-work owner is absent or changed.
 */
export function verifyKnowledgeProposalWorkHistory(input: {
  /** Allows imported-history proof only while reading an already accepted imported Page. */
  readonly allowImportedHistory?: boolean | undefined;
  /** Core scheduler and worker-session authority when available. */
  readonly coreDb: CoreDb | undefined;
  /** Closed normalized references carried by the Proposal. */
  readonly sourceReferences: readonly string[];
  /** Product Turn and Item owner. */
  readonly store: FsStore;
  /** Workspace S39 authority when available. */
  readonly workspaceDb: WorkspaceDb | undefined;
  /** Workspace that must own every completed-work record. */
  readonly workspaceId: string;
}): KnowledgeProposalWorkHistoryVerification {
  const workReferences = input.sourceReferences.filter((reference) =>
    /^(?:turn|item|context-package):/.test(reference)
  );
  if (workReferences.length === 0) {
    return {
      verifiedExternalReferences: [],
    };
  }

  const turnReferences = workReferences.filter((reference) => reference.startsWith('turn:'));
  const itemReferences = workReferences.filter((reference) => reference.startsWith('item:'));
  const contextReferences = workReferences.filter((reference) =>
    reference.startsWith('context-package:')
  );
  if (
    workReferences.length !== 3 ||
    turnReferences.length !== 1 ||
    itemReferences.length !== 1 ||
    contextReferences.length !== 1 ||
    !input.coreDb ||
    !input.workspaceDb
  ) {
    throw new KnowledgePageValidationError();
  }

  const turnId = turnReferences[0]!.slice('turn:'.length);
  const itemId = itemReferences[0]!.slice('item:'.length);
  const contextMatch = /^context-package:([^@]+)@(ctxpkg_sha256_[a-f0-9]{64})$/.exec(
    contextReferences[0]!
  );
  try {
    if (!contextMatch || contextMatch[1] !== turnId) {
      throw new Error('Completed-work reference lineage does not match.');
    }
    const turn = input.store.getTurnById(turnId);
    if (turn.workspaceId !== input.workspaceId || turn.status !== 'completed') {
      throw new Error('Completed-work Turn is not eligible.');
    }

    const finalAssistantItem = input.store
      .listThreadItems(input.workspaceId, turn.threadId)
      .filter(
        (item) =>
          item.turnId === turn.id &&
          item.type === 'assistant-message' &&
          item.status === 'completed'
      )
      .at(-1);
    if (!finalAssistantItem || finalAssistantItem.id !== itemId) {
      throw new Error('Completed-work Item is not the final assistant result.');
    }

    const { trace, verification } = readPortableWorkerContextPackageTrace({
      authorities: createWorkerContextPackageAuthorityReader({
        coreDb: input.coreDb,
        store: input.store,
        workspaceDb: input.workspaceDb,
      }),
      workspaceId: input.workspaceId,
      threadId: turn.threadId,
      turnId,
      workspaceRoot: resolveDataRootPath(
        input.workspaceDb.dataRoot,
        'workspaces',
        input.workspaceId
      ),
    });
    if (
      (verification !== 'strict' && !input.allowImportedHistory) ||
      trace.goalId !== null ||
      trace.taskId !== null ||
      trace.knowledgeSelectionInput === null ||
      trace.contextPackageDigest !== contextMatch[2]
    ) {
      throw new Error('Completed-work Context Package is not an exact direct-Task trace.');
    }
  } catch {
    throw new KnowledgePageValidationError();
  }

  return {
    verifiedExternalReferences: workReferences,
  };
}

/**
 * Resolves current Page-bound source proof for accepted local and portable Pages.
 *
 * @param input Existing Proposal, Review, Page, Turn, Item, and S39 authorities.
 * @returns Exact Page and digest keyed proofs whose current owner tuples remain coherent.
 */
export function resolveWorkspaceKnowledgeReferenceProofs(input: {
  /** Core scheduler and worker-session authority when available. */
  readonly coreDb: CoreDb | undefined;
  /** Product Proposal, Review, Page, Turn, and Item owner. */
  readonly store: FsStore;
  /** Workspace S39 authority when available. */
  readonly workspaceDb: WorkspaceDb | undefined;
  /** Workspace that must own every referenced record. */
  readonly workspaceId: string;
}): ReadonlyMap<string, KnowledgePageReferenceProof> {
  const referenceProofs = new Map<string, KnowledgePageReferenceProof>();

  for (const proposal of input.store.listKnowledgeProposals(input.workspaceId)) {
    const review = input.store.getKnowledgeProposalReviewDecision(proposal.id);
    if (!review || review.decision !== 'accepted') {
      continue;
    }

    try {
      const verification = verifyKnowledgeProposalWorkHistory({
        coreDb: input.coreDb,
        sourceReferences: proposal.sourceReferences,
        store: input.store,
        workspaceDb: input.workspaceDb,
        workspaceId: input.workspaceId,
      });
      const proof = input.store.projectKnowledgeProposalReferenceProof(
        input.workspaceId,
        review.reviewId,
        verification.verifiedExternalReferences
      );
      referenceProofs.set(proof.knowledgePageId, proof);
    } catch {
      // An incoherent owner tuple remains excluded by normal Knowledge validation.
    }
  }

  if (input.store.getWorkspace(input.workspaceId).importedFrom) {
    for (const entry of input.store.getWorkspaceResources(input.workspaceId).knowledge) {
      if (referenceProofs.has(entry.id)) {
        continue;
      }
      try {
        const verification = verifyKnowledgeProposalWorkHistory({
          allowImportedHistory: true,
          coreDb: input.coreDb,
          sourceReferences: entry.sourceReferences ?? [],
          store: input.store,
          workspaceDb: input.workspaceDb,
          workspaceId: input.workspaceId,
        });
        const proof = input.store.projectImportedKnowledgePageReferenceProof(
          input.workspaceId,
          entry.id,
          verification.verifiedExternalReferences
        );
        referenceProofs.set(proof.knowledgePageId, proof);
      } catch {
        // Imported Pages remain excluded when their reminted current owners do not verify.
      }
    }
  }

  return referenceProofs;
}

/** Input for one deterministic Knowledge Manager repair suggestion operation. */
export interface SuggestKnowledgeRepairsInput {
  /** Operation id assigned by NanoCore. */
  operationId: string;
  /** Workspace that owns the repair scan. */
  workspaceId: string;
  /** Caller that requested repair suggestions. */
  caller: z.infer<typeof KnowledgeManagerCallerSchema>;
  /** Candidate knowledge entries from the workspace store. */
  entries: readonly WorkspaceKnowledgeEntry[];
  /** Maximum number of suggestions to return. */
  limit: number;
}

/** Input for one deterministic Knowledge Manager health-check operation. */
export interface CheckKnowledgeHealthInput {
  /** Operation id assigned by NanoCore. */
  operationId: string;
  /** Workspace that owns the health check. */
  workspaceId: string;
  /** Caller that requested the health check. */
  caller: z.infer<typeof KnowledgeManagerCallerSchema>;
  /** Candidate knowledge entries from the workspace store. */
  entries: readonly WorkspaceKnowledgeEntry[];
  /** Maximum number of repair suggestions to include. */
  limit: number;
}

/**
 * Answers one bounded knowledge question from workspace knowledge entries.
 *
 * @param input Answer operation input.
 * @returns Source-traceable answer or an insufficient-evidence response.
 */
export function answerKnowledgeManager(
  input: AnswerKnowledgeManagerInput
): KnowledgeManagerAnswerResponse {
  const retrieval = retrieveWorkspaceKnowledge({
    dataRoot: input.dataRoot,
    workspaceId: input.workspaceId,
    caller: input.caller,
    query: input.query,
    limit: input.limit ?? 5,
    pinnedConceptIds: [],
    referenceProofs: input.referenceProofs,
    traceId: `krt_${randomUUID()}`,
  });
  const pages = resolveWorkspaceKnowledgeRetrievalPages({
    caller: input.caller,
    dataRoot: input.dataRoot,
    referenceProofs: input.referenceProofs,
    retrievalTraceId: retrieval.traceId,
    workspaceId: input.workspaceId,
  });
  if (!pages) {
    throw new Error('Knowledge retrieval selected an unavailable page.');
  }
  const matches = pages.map((page) => ({
    id: page.knowledgePageId,
    content: page.body,
    kind: page.kind,
    sourceReferences: page.sourceRefs,
    title: page.title,
  }));

  if (matches.length === 0) {
    return {
      operationId: input.operationId,
      operation: 'answer',
      workspaceId: input.workspaceId,
      caller: input.caller,
      retrievalTraceId: retrieval.traceId,
      query: input.query,
      outcome: 'insufficient-evidence',
      answer: 'I do not have enough source-traceable workspace knowledge to answer that.',
      citations: [],
      confidence: 0,
      uncertainty: 'No matching workspace knowledge entries were found.',
    };
  }

  const citations = matches.map((entry) => ({
    knowledgeEntryId: entry.id,
    kind: entry.kind,
    title: entry.title,
    excerpt: excerpt(entry.content),
  }));

  return {
    operationId: input.operationId,
    operation: 'answer',
    workspaceId: input.workspaceId,
    caller: input.caller,
    retrievalTraceId: retrieval.traceId,
    query: input.query,
    outcome: 'answered',
    answer: matches[0]?.content ?? citations[0]?.excerpt ?? 'Knowledge matched the query.',
    citations,
    confidence: Math.min(0.9, 0.55 + citations.length * 0.1),
    uncertainty: null,
  };
}

/**
 * Prepares source-traceable knowledge material for later Coordinator assembly.
 *
 * @param input Context material operation input.
 * @returns Bounded material references or an insufficient-evidence response.
 */
export function prepareKnowledgeContext(
  input: PrepareKnowledgeContextInput
): KnowledgeManagerPrepareContextResponse {
  const retrieval = retrieveWorkspaceKnowledge({
    dataRoot: input.dataRoot,
    workspaceId: input.workspaceId,
    caller: 'app-api',
    query: input.query,
    limit: input.limit ?? 5,
    pinnedConceptIds: [],
    referenceProofs: input.referenceProofs,
    traceId: `krt_${randomUUID()}`,
  });

  return {
    operationId: input.operationId,
    operation: 'prepare-context-material',
    workspaceId: input.workspaceId,
    caller: input.caller,
    retrievalTraceId: retrieval.traceId,
    outcome: retrieval.selected.length > 0 ? 'prepared' : 'insufficient-evidence',
    selected: retrieval.selected,
    excluded: retrieval.excluded,
  };
}

/**
 * Selects governed Knowledge once for one direct Task without assembling worker context.
 *
 * @param input Direct Task Knowledge preparation input.
 * @returns The existing S61 retrieval trace reference and no second selection projection.
 * @throws Error when S61 cannot create the exact deterministic retrieval trace.
 */
export function prepareTaskKnowledgeContext(
  input: PrepareTaskKnowledgeContextInput
): PreparedTaskKnowledgeContext {
  const retrieval = retrieveWorkspaceKnowledge({
    dataRoot: input.dataRoot,
    workspaceId: input.workspaceId,
    caller: 'task-mode',
    query: input.query,
    limit: 5,
    pinnedConceptIds: [],
    referenceProofs: input.referenceProofs,
    traceId: input.traceId,
  });

  return { retrievalTraceId: retrieval.traceId };
}

/**
 * Projects a stored pending proposal into the Knowledge Manager draft response.
 *
 * @param input Proposal draft operation input.
 * @returns Source-traceable proposal draft response.
 */
export function draftKnowledgeProposal(
  input: DraftKnowledgeProposalInput
): KnowledgeManagerDraftProposalResponse {
  return {
    operationId: input.operationId,
    operation: 'draft-proposal',
    workspaceId: input.workspaceId,
    caller: input.caller,
    proposal: {
      ...input.proposal,
      status: 'pending',
    },
    validation: {
      conformance: 'Workspace-schema-valid',
      generatedFromCompletedWorkHistory: input.generatedFromCompletedWorkHistory,
    },
  };
}

/**
 * Suggests review-required knowledge repairs without mutating the store.
 *
 * @param input Repair suggestion operation input.
 * @returns Bounded repair suggestions.
 */
export function suggestKnowledgeRepairs(
  input: SuggestKnowledgeRepairsInput
): KnowledgeManagerSuggestRepairResponse {
  const byTitle = new Map<string, WorkspaceKnowledgeEntry[]>();

  for (const entry of input.entries) {
    const key = normalizeTitle(entry.title);
    const group = byTitle.get(key) ?? [];
    group.push(entry);
    byTitle.set(key, group);
  }

  const suggestions = [...byTitle.entries()]
    .filter(([, entries]) => entries.length > 1)
    .slice(0, input.limit)
    .map(([titleKey, entries]) => ({
      id: `repair_duplicate_title_${repairIdPart(titleKey)}`,
      kind: 'duplicate-title' as const,
      title: `Duplicate title: ${displayTitle(entries[0]?.title ?? titleKey)}`,
      detail: `${entries.length} knowledge entries share the same normalized title.`,
      affectedKnowledgeEntryIds: entries.map((entry) => entry.id),
      autoApplicable: false as const,
      reviewRequired: true as const,
    }));

  return {
    operationId: input.operationId,
    operation: 'suggest-repair',
    workspaceId: input.workspaceId,
    caller: input.caller,
    outcome: suggestions.length > 0 ? 'suggested' : 'healthy',
    suggestions,
  };
}

/**
 * Produces one bounded Knowledge Manager health report without mutating knowledge.
 *
 * @param input Health-check operation input.
 * @returns Health report with review-required repair suggestions.
 */
export function checkKnowledgeHealth(
  input: CheckKnowledgeHealthInput
): KnowledgeManagerHealthCheckResponse {
  const repairReport = suggestKnowledgeRepairs(input);
  const repairCount = repairReport.suggestions.length;

  return {
    operationId: input.operationId,
    operation: 'health-check',
    workspaceId: input.workspaceId,
    caller: input.caller,
    outcome: repairCount > 0 ? 'needs-attention' : 'healthy',
    summary:
      repairCount > 0
        ? `Knowledge Manager found ${repairCount} repair suggestion${repairCount === 1 ? '' : 's'}.`
        : 'Knowledge Manager found no repair suggestions.',
    checks: [
      {
        code: 'knowledge-present',
        status: input.entries.length > 0 ? 'pass' : 'warn',
        detail:
          input.entries.length > 0
            ? `${input.entries.length} knowledge entr${input.entries.length === 1 ? 'y is' : 'ies are'} available.`
            : 'No workspace knowledge entries are available.',
      },
      {
        code: 'repair-suggestions',
        status: repairCount > 0 ? 'warn' : 'pass',
        detail:
          repairCount > 0
            ? `${repairCount} review-required repair suggestion${repairCount === 1 ? ' was' : 's were'} found.`
            : 'No review-required repair suggestions were found.',
      },
    ],
    repairSuggestions: repairReport.suggestions,
  };
}

/**
 * Builds a compact citation excerpt.
 *
 * @param content Knowledge entry body.
 * @returns Single-line citation excerpt.
 */
function excerpt(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

/**
 * Normalizes a knowledge title for duplicate-title repair detection.
 *
 * @param title Knowledge entry title.
 * @returns Collapsed title with stable casing.
 */
function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Collapses title whitespace for human-readable output.
 *
 * @param title Knowledge entry title.
 * @returns Display title.
 */
function displayTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * Converts a repair title into a compact stable id suffix.
 *
 * @param title Normalized repair title.
 * @returns Lowercase id-safe suffix.
 */
function repairIdPart(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'untitled'
  );
}
