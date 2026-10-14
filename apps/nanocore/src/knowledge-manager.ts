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
import type { KnowledgeProposalRecord } from './lib/store.js';
import { analyzeKnowledgePage } from './retrieval-knowledge-adapter.js';
import type { RetrievalAnalysis } from './retrieval-service.js';
import {
  type KnowledgeRetrievalAccess,
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
  /** Current trusted actor, source, and output-audience authority. */
  access: KnowledgeRetrievalAccess;
  /** User or coordinator query. */
  query: string;
  /** Maximum number of selected Knowledge Pages. */
  limit?: number | undefined;
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
  /** Current trusted actor, source, and output-audience authority. */
  access: KnowledgeRetrievalAccess;
  /** Coordinator query used to select material. */
  query: string;
  /** Maximum number of source entries to include. */
  limit?: number | undefined;
}

/** Input for the direct Task Mode Knowledge preparation boundary. */
export interface PrepareTaskKnowledgeContextInput {
  /** File-backed NanoCore data root that owns the governed retrieval trace. */
  readonly dataRoot: string;
  /** Workspace that owns the direct Task. */
  readonly workspaceId: string;
  /** Exact immutable Task input used as the governed retrieval query. */
  readonly query: string;
  /** Current trusted actor, source, and output-audience authority. */
  readonly access: KnowledgeRetrievalAccess;
  /** Deterministic Task-owned retrieval trace id. */
  readonly traceId: string;
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
export async function answerKnowledgeManager(
  input: AnswerKnowledgeManagerInput
): Promise<KnowledgeManagerAnswerResponse> {
  const retrieval = await retrieveWorkspaceKnowledge({
    access: input.access,
    dataRoot: input.dataRoot,
    workspaceId: input.workspaceId,
    caller: input.caller,
    query: input.query,
    limit: input.limit ?? 5,
    pinnedConceptIds: [],
    traceId: `krt_${randomUUID()}`,
  });
  const pages = resolveWorkspaceKnowledgeRetrievalPages({
    access: input.access,
    caller: input.caller,
    dataRoot: input.dataRoot,
    retrievalTraceId: retrieval.traceId,
    workspaceId: input.workspaceId,
  });
  if (!pages) {
    throw new Error('Knowledge retrieval selected an unavailable page.');
  }
  const analyzedPages = await Promise.all(
    pages.map(async (page) => ({
      id: page.knowledgePageId,
      content: page.body,
      kind: page.kind,
      sourceReferences: page.sourceRefs,
      title: page.title,
      analysis: await analyzeKnowledgePage({
        body: page.body,
        content: page.content,
        dataRoot: input.dataRoot,
        query: input.query,
        title: page.title,
        workspaceId: input.workspaceId,
      }),
    }))
  );
  const pagesAfterAnalysis = resolveWorkspaceKnowledgeRetrievalPages({
    access: input.access,
    caller: input.caller,
    dataRoot: input.dataRoot,
    retrievalTraceId: retrieval.traceId,
    workspaceId: input.workspaceId,
  });
  if (
    !pagesAfterAnalysis ||
    pagesAfterAnalysis.length !== analyzedPages.length ||
    pagesAfterAnalysis.some((page, index) => {
      const analyzed = analyzedPages[index];
      return (
        !analyzed ||
        analyzed.id !== page.knowledgePageId ||
        analyzed.content !== page.body ||
        analyzed.title !== page.title
      );
    })
  ) {
    throw new Error('Knowledge retrieval authority changed during answer analysis.');
  }
  const matches = analyzedPages.filter((page) => knowledgeAnswerCoversAnalysis(page.analysis));

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
      uncertainty:
        pages.length === 0
          ? 'No matching workspace knowledge entries were found.'
          : 'Retrieved workspace knowledge does not sufficiently cover the query.',
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
export async function prepareKnowledgeContext(
  input: PrepareKnowledgeContextInput
): Promise<KnowledgeManagerPrepareContextResponse> {
  const retrieval = await retrieveWorkspaceKnowledge({
    access: input.access,
    dataRoot: input.dataRoot,
    workspaceId: input.workspaceId,
    caller: 'app-api',
    query: input.query,
    limit: input.limit ?? 5,
    pinnedConceptIds: [],
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
export async function prepareTaskKnowledgeContext(
  input: PrepareTaskKnowledgeContextInput
): Promise<PreparedTaskKnowledgeContext> {
  const retrieval = await retrieveWorkspaceKnowledge({
    access: input.access,
    dataRoot: input.dataRoot,
    workspaceId: input.workspaceId,
    caller: 'task-mode',
    query: input.query,
    limit: 5,
    pinnedConceptIds: [],
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
 * Returns whether kernel term evidence is sufficient for one selected page to answer.
 *
 * @param analysis Terms produced by the kernel's selected analyzer for the query, title, and body.
 * @returns True when two distinct query terms appear on the page, or a one-term query matches its title.
 */
function knowledgeAnswerCoversAnalysis(analysis: RetrievalAnalysis): boolean {
  const queryTerms = new Set(analysis.query_terms);
  if (queryTerms.size === 0) {
    return false;
  }
  const titleTerms = new Set(analysis.title_terms);
  if (queryTerms.size === 1) {
    return [...queryTerms].every((term) => titleTerms.has(term));
  }
  const pageTerms = new Set([...titleTerms, ...analysis.body_terms]);
  let covered = 0;
  for (const term of queryTerms) {
    if (pageTerms.has(term)) {
      covered += 1;
    }
  }
  return covered >= 2;
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
