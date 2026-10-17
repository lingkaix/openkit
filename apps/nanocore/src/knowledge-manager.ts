import type {
  KnowledgeManagerCallerSchema,
  KnowledgeManagerDraftProposalResponse,
  KnowledgeManagerHealthCheckResponse,
  KnowledgeManagerPrepareContextResponse,
  KnowledgeManagerSuggestRepairResponse,
} from '@openkit/app-api-schemas';
import type { KnowledgeEntrySchema, RetrievalTraceReference } from '@openkit/protocol';
import { allocateEntityId } from '@openkit/protocol';
import type { z } from 'zod';
import type { KnowledgeProposalRecord } from './lib/store.js';
import {
  type KnowledgeRetrievalAccess,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';

/** Workspace Knowledge Page projection consumed by request-scoped Knowledge operations. */
export type WorkspaceKnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

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
  readonly retrievalTraceRef: RetrievalTraceReference;
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
    pinnedReferences: [],
    traceId: allocateEntityId('krt'),
  });

  return {
    operationId: input.operationId,
    operation: 'prepare-context-material',
    workspaceId: input.workspaceId,
    caller: input.caller,
    ...(retrieval.retrievalTraceRef ? { retrievalTraceRef: retrieval.retrievalTraceRef } : {}),
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
    pinnedReferences: [],
    traceId: input.traceId,
  });

  if (!retrieval.retrievalTraceRef)
    throw new Error('Task Knowledge selection requires its query-owned trace.');
  return { retrievalTraceRef: retrieval.retrievalTraceRef };
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
      conformance: 'scope-schema-valid',
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
