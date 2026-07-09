import { createHash } from 'node:crypto';
import type {
  KnowledgeManagerAnswerResponse,
  KnowledgeManagerCallerSchema,
  KnowledgeManagerDraftProposalResponse,
  KnowledgeManagerHealthCheckResponse,
  KnowledgeManagerPrepareContextResponse,
  KnowledgeManagerSuggestRepairResponse,
} from '@openkit/app-api-schemas';
import type { ArtifactSchema } from '@openkit/protocol';
import type { z } from 'zod';
import { searchKnowledgeEntries, type WorkspaceKnowledgeEntry } from './knowledge-search.js';
import type {
  KnowledgeClaimRecord,
  KnowledgeConflictRecord,
  KnowledgeProposalRecord,
  KnowledgeSourceRecord,
} from './lib/store.js';

const KNOWLEDGE_CONTEXT_POLICY_VERSION = 'knowledge-context-v1';

type KnowledgeManagerContextMaterial = KnowledgeManagerPrepareContextResponse['materials'][number];
type KnowledgeManagerContextExclusion =
  KnowledgeManagerPrepareContextResponse['exclusions'][number];
type KnowledgeManagerContextPolicy = KnowledgeManagerPrepareContextResponse['policy'];
type KnowledgeManagerContextPackageTrace = KnowledgeManagerPrepareContextResponse['packageTrace'];
type KnowledgeManagerWorkspaceFile =
  KnowledgeManagerPrepareContextResponse['workspaceFiles'][number];
type KnowledgeManagerWorkspaceRootFile =
  KnowledgeManagerPrepareContextResponse['workspaceRootFiles'][number];
type Artifact = z.infer<typeof ArtifactSchema>;

const KNOWLEDGE_CONTEXT_POLICY: KnowledgeManagerContextPolicy = {
  version: KNOWLEDGE_CONTEXT_POLICY_VERSION,
  claimReviewState: 'accepted',
  conflictResolution: 'exclude-resolved',
};

/** Input for deriving a package-level trace from selected Knowledge Manager material. */
interface BuildKnowledgeContextPackageTraceInput {
  /** Original context preparation input. */
  input: PrepareKnowledgeContextInput;
  /** Material selected for later Coordinator context assembly. */
  materials: readonly KnowledgeManagerContextMaterial[];
  /** Candidate exclusions surfaced by Knowledge Manager. */
  exclusions: readonly KnowledgeManagerContextExclusion[];
  /** Effective selection limit used as the first context budget. */
  requestedLimit: number;
}

/** Input for one deterministic Knowledge Manager answer operation. */
export interface AnswerKnowledgeManagerInput {
  /** Operation id assigned by NanoCore. */
  operationId: string;
  /** Workspace that owns the query. */
  workspaceId: string;
  /** Caller that requested the answer. */
  caller: z.infer<typeof KnowledgeManagerCallerSchema>;
  /** User or coordinator query. */
  query: string;
  /** Candidate knowledge entries from the workspace store. */
  entries: readonly WorkspaceKnowledgeEntry[];
  /** Maximum number of source entries to cite. */
  limit?: number | undefined;
}

/** Input for one deterministic Knowledge Manager context-material operation. */
export interface PrepareKnowledgeContextInput {
  /** Operation id assigned by NanoCore. */
  operationId: string;
  /** Workspace that owns the context request. */
  workspaceId: string;
  /** Caller that requested context material. */
  caller: z.infer<typeof KnowledgeManagerCallerSchema>;
  /** Coordinator query used to select material. */
  query: string;
  /** Candidate knowledge entries from the workspace store. */
  entries: readonly WorkspaceKnowledgeEntry[];
  /** Workspace claim ledger rows available for governed context selection. */
  claims?: readonly KnowledgeClaimRecord[] | undefined;
  /** Workspace conflict ledger rows available for governed context selection. */
  conflicts?: readonly KnowledgeConflictRecord[] | undefined;
  /** Explicit artifact records selected by the caller for worker context. */
  artifacts?: readonly Artifact[] | undefined;
  /** Explicit workspace file summaries selected by the caller for worker context. */
  workspaceFiles?: readonly KnowledgeManagerWorkspaceFile[] | undefined;
  /** Explicit workspace root file summaries selected by the caller for worker context. */
  workspaceRootFiles?: readonly KnowledgeManagerWorkspaceRootFile[] | undefined;
  /** Maximum number of source entries to include. */
  limit?: number | undefined;
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
  /** Source references supporting the draft. */
  sourceReferences: readonly string[];
  /** Workspace knowledge entries available for lineage resolution. */
  entries: readonly WorkspaceKnowledgeEntry[];
  /** Registered source records available for lineage resolution. */
  sources: readonly KnowledgeSourceRecord[];
  /** Draft confidence. */
  confidence: number;
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
  const matches = searchKnowledgeEntries(input.entries, input.query, input.limit ?? 3);

  if (matches.length === 0) {
    return {
      operationId: input.operationId,
      operation: 'answer',
      workspaceId: input.workspaceId,
      caller: input.caller,
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
  const requestedLimit = input.limit ?? 5;
  const matches = searchKnowledgeEntries(input.entries, input.query, requestedLimit);
  const artifacts = [...(input.artifacts ?? [])];
  const workspaceFiles = [...(input.workspaceFiles ?? [])];
  const workspaceRootFiles = [...(input.workspaceRootFiles ?? [])];

  if (
    matches.length === 0 &&
    artifacts.length === 0 &&
    workspaceFiles.length === 0 &&
    workspaceRootFiles.length === 0
  ) {
    const exclusions: KnowledgeManagerContextExclusion[] = [
      {
        reason: 'no-matching-knowledge',
        detail: 'No matching workspace knowledge entries were found.',
      },
    ];

    return {
      operationId: input.operationId,
      operation: 'prepare-context-material',
      workspaceId: input.workspaceId,
      caller: input.caller,
      query: input.query,
      outcome: 'insufficient-evidence',
      materials: [],
      exclusions,
      artifacts: [],
      workspaceFiles: [],
      workspaceRootFiles: [],
      claims: [],
      conflicts: [],
      policy: KNOWLEDGE_CONTEXT_POLICY,
      packageTrace: buildKnowledgeContextPackageTrace({
        input,
        materials: [],
        exclusions,
        requestedLimit,
      }),
      confidence: 0,
      uncertainty: 'No matching workspace knowledge entries were found.',
    };
  }

  const materials = matches.map((entry) => ({
    knowledgeEntryId: entry.id,
    kind: entry.kind,
    title: entry.title,
    excerpt: excerpt(entry.content),
    sourceReferences: entry.sourceReferences ?? [],
    trace: {
      source: 'workspace-knowledge' as const,
      reason: 'matched-query' as const,
    },
  }));
  const claims = selectContextClaims({
    claims: input.claims ?? [],
    materials,
    query: input.query,
  });
  const conflicts = selectContextConflicts({
    conflicts: input.conflicts ?? [],
    materials,
    claims,
  });
  const exclusions: KnowledgeManagerContextExclusion[] =
    matches.length === 0
      ? [
          {
            reason: 'no-matching-knowledge',
            detail: 'No matching workspace knowledge entries were found.',
          },
        ]
      : [];

  return {
    operationId: input.operationId,
    operation: 'prepare-context-material',
    workspaceId: input.workspaceId,
    caller: input.caller,
    query: input.query,
    outcome: 'prepared',
    materials,
    exclusions,
    artifacts,
    workspaceFiles,
    workspaceRootFiles,
    claims,
    conflicts,
    policy: KNOWLEDGE_CONTEXT_POLICY,
    packageTrace: buildKnowledgeContextPackageTrace({
      input,
      materials,
      exclusions,
      requestedLimit,
    }),
    confidence: Math.min(
      0.9,
      0.45 +
        matches.length * 0.1 +
        artifacts.length * 0.05 +
        workspaceFiles.length * 0.05 +
        workspaceRootFiles.length * 0.05
    ),
    uncertainty:
      matches.length === 0 ? 'No matching workspace knowledge entries were found.' : null,
  };
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
  const sourceLineage = input.sourceReferences.map((reference) =>
    classifyProposalSourceReference(reference, input.entries, input.sources)
  );
  const unresolvedCount = sourceLineage.filter((lineage) => lineage.reviewRequired).length;
  const hasReferences = input.sourceReferences.length > 0;

  return {
    operationId: input.operationId,
    operation: 'draft-proposal',
    workspaceId: input.workspaceId,
    caller: input.caller,
    proposal: {
      id: input.proposal.id,
      workspaceId: input.proposal.workspaceId,
      title: input.proposal.title,
      summary: input.proposal.summary,
      status: 'pending',
      createdAt: input.proposal.createdAt,
      updatedAt: input.proposal.updatedAt,
    },
    sourceReferences: [...input.sourceReferences],
    sourceLineage,
    validation: {
      status: hasReferences && unresolvedCount === 0 ? 'ready-for-review' : 'needs-source-review',
      checks: buildProposalValidationChecks(hasReferences, sourceLineage),
    },
    confidence: input.confidence,
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
 * Builds a deterministic package-level trace for prepared knowledge context material.
 *
 * @param traceInput Selected material and original request data.
 * @returns Context package trace with stable digest and budget summary.
 */
function buildKnowledgeContextPackageTrace(
  traceInput: BuildKnowledgeContextPackageTraceInput
): KnowledgeManagerContextPackageTrace {
  const selectedKnowledgeEntryIds = traceInput.materials.map(
    (material) => material.knowledgeEntryId
  );
  const selectedArtifactIds = (traceInput.input.artifacts ?? []).map((artifact) => artifact.id);
  const selectedWorkspaceFilePaths = (traceInput.input.workspaceFiles ?? []).map(
    (file) => file.path
  );
  const selectedWorkspaceRootFiles = (traceInput.input.workspaceRootFiles ?? []).map((file) => ({
    rootId: file.rootId,
    path: file.path,
  }));
  const selectedClaimIds = (traceInput.input.claims ?? [])
    .filter((claim) => isSelectedClaim(claim, traceInput.materials, traceInput.input.query))
    .map((claim) => claim.id);
  const selectedConflictIds = (traceInput.input.conflicts ?? [])
    .filter((conflict) =>
      isSelectedConflict(conflict, traceInput.materials, new Set(selectedClaimIds))
    )
    .map((conflict) => conflict.id);
  const digestInput = {
    policyVersion: KNOWLEDGE_CONTEXT_POLICY_VERSION,
    policy: KNOWLEDGE_CONTEXT_POLICY,
    workspaceId: traceInput.input.workspaceId,
    caller: traceInput.input.caller,
    query: traceInput.input.query,
    selectedKnowledgeEntryIds,
    selectedArtifactIds,
    selectedWorkspaceFilePaths,
    selectedWorkspaceRootFiles,
    selectedClaimIds,
    selectedConflictIds,
    materials: traceInput.materials,
    artifacts: traceInput.input.artifacts ?? [],
    workspaceFiles: traceInput.input.workspaceFiles ?? [],
    workspaceRootFiles: traceInput.input.workspaceRootFiles ?? [],
    exclusions: traceInput.exclusions,
    budget: {
      requestedLimit: traceInput.requestedLimit,
      selectedCount: traceInput.materials.length,
      excludedCount: traceInput.exclusions.length,
    },
  };

  return {
    contextPackageId: `ctxpkg_${traceInput.input.operationId}`,
    contextPackageDigest: `ctxpkg_sha256_${createHash('sha256')
      .update(stableStringify(digestInput))
      .digest('hex')}`,
    policyVersion: KNOWLEDGE_CONTEXT_POLICY_VERSION,
    selectedKnowledgeEntryIds,
    selectedArtifactIds,
    selectedWorkspaceFilePaths,
    selectedWorkspaceRootFiles,
    selectedClaimIds,
    selectedConflictIds,
    excludedCandidateCount: traceInput.exclusions.length,
    budget: {
      requestedLimit: traceInput.requestedLimit,
      selectedCount: traceInput.materials.length,
      excludedCount: traceInput.exclusions.length,
    },
  };
}

/**
 * Selects accepted claims relevant to selected context material.
 *
 * @param input Available claims, selected materials, and query.
 * @returns Claims safe to include in a first-slice context package.
 */
function selectContextClaims(input: {
  claims: readonly KnowledgeClaimRecord[];
  materials: readonly KnowledgeManagerContextMaterial[];
  query: string;
}): KnowledgeClaimRecord[] {
  return input.claims.filter((claim) => isSelectedClaim(claim, input.materials, input.query));
}

/**
 * Returns whether a claim is eligible and relevant for context selection.
 *
 * @param claim Candidate claim.
 * @param materials Selected knowledge materials.
 * @param query Original context query.
 * @returns True when the claim is accepted and related to selected context.
 */
function isSelectedClaim(
  claim: KnowledgeClaimRecord,
  materials: readonly KnowledgeManagerContextMaterial[],
  query: string
): boolean {
  if (materials.length === 0) {
    return false;
  }

  if (
    claim.reviewState !== 'accepted' ||
    claim.freshness === 'stale' ||
    claim.conflictStatus !== 'none'
  ) {
    return false;
  }

  const selectedRefs = new Set(
    materials.map((material) => `knowledge:${material.knowledgeEntryId}`)
  );

  return (
    claim.sourceReferences.some((reference) => selectedRefs.has(reference)) ||
    queryMatchesText(query, claim.statement)
  );
}

/**
 * Selects unresolved conflicts related to selected knowledge material or selected claims.
 *
 * @param input Available conflicts, selected materials, and selected claims.
 * @returns Unresolved conflicts relevant to the first-slice context package.
 */
function selectContextConflicts(input: {
  conflicts: readonly KnowledgeConflictRecord[];
  materials: readonly KnowledgeManagerContextMaterial[];
  claims: readonly KnowledgeClaimRecord[];
}): KnowledgeConflictRecord[] {
  const selectedClaimIds = new Set(input.claims.map((claim) => claim.id));

  return input.conflicts.filter((conflict) =>
    isSelectedConflict(conflict, input.materials, selectedClaimIds)
  );
}

/**
 * Returns whether a conflict is unresolved and related to selected context.
 *
 * @param conflict Candidate conflict.
 * @param materials Selected knowledge materials.
 * @param selectedClaimIds Claim ids selected for context.
 * @returns True when the conflict should be carried for worker-visible caution.
 */
function isSelectedConflict(
  conflict: KnowledgeConflictRecord,
  materials: readonly KnowledgeManagerContextMaterial[],
  selectedClaimIds: ReadonlySet<string>
): boolean {
  if (conflict.status === 'resolved' || conflict.resolvedAt) {
    return false;
  }

  const selectedRefs = new Set([
    ...materials.map((material) => `knowledge:${material.knowledgeEntryId}`),
    ...[...selectedClaimIds].map((claimId) => `claim:${claimId}`),
  ]);

  return conflict.subjectReferences.some((reference) => selectedRefs.has(reference));
}

/**
 * Checks whether query terms appear in a candidate text.
 *
 * @param query Context query.
 * @param text Candidate text.
 * @returns True when at least one non-trivial query token appears.
 */
function queryMatchesText(query: string, text: string): boolean {
  const normalized = text.toLowerCase();

  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 2)
    .some((token) => normalized.includes(token));
}

/**
 * Serializes JSON-like input with stable object key ordering.
 *
 * @param value Value to serialize.
 * @returns Deterministic JSON string.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));

    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
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

/**
 * Classifies one proposal source reference against known workspace records.
 *
 * @param reference Raw source reference from the draft request.
 * @param entries Workspace knowledge entries.
 * @param sources Registered source records.
 * @returns Deterministic lineage projection.
 */
function classifyProposalSourceReference(
  reference: string,
  entries: readonly WorkspaceKnowledgeEntry[],
  sources: readonly KnowledgeSourceRecord[]
): KnowledgeManagerDraftProposalResponse['sourceLineage'][number] {
  const sourceId = stripReferencePrefix(reference, 'source');
  const source = sources.find((candidate) => candidate.id === sourceId);

  if (source) {
    return {
      reference,
      classification: 'registered-source',
      sourceId: source.id,
      knowledgeEntryId: null,
      title: source.title,
      reviewRequired: false,
      detail: 'Reference resolves to a registered workspace knowledge source.',
    };
  }

  const knowledgeEntryId = stripReferencePrefix(reference, 'knowledge');
  const entry = entries.find((candidate) => candidate.id === knowledgeEntryId);

  if (entry) {
    return {
      reference,
      classification: 'workspace-knowledge',
      sourceId: null,
      knowledgeEntryId: entry.id,
      title: entry.title,
      reviewRequired: false,
      detail: 'Reference resolves to an existing workspace knowledge entry.',
    };
  }

  return {
    reference,
    classification: 'external-reference',
    sourceId: null,
    knowledgeEntryId: null,
    title: null,
    reviewRequired: true,
    detail: 'Reference is not registered as a workspace knowledge source or knowledge entry.',
  };
}

/**
 * Builds proposal validation checks from source-lineage results.
 *
 * @param hasReferences Whether the draft carried source references.
 * @param sourceLineage Classified source lineage.
 * @returns Validation checks for the draft operation.
 */
function buildProposalValidationChecks(
  hasReferences: boolean,
  sourceLineage: KnowledgeManagerDraftProposalResponse['sourceLineage']
): KnowledgeManagerDraftProposalResponse['validation']['checks'] {
  if (!hasReferences) {
    return [
      {
        code: 'no-source-references',
        passed: false,
        detail: 'Proposal draft has no source references and requires source review.',
      },
    ];
  }

  return sourceLineage.map((lineage) => ({
    code: lineage.reviewRequired
      ? ('source-reference-unregistered' as const)
      : ('source-reference-resolved' as const),
    passed: !lineage.reviewRequired,
    detail: lineage.detail,
  }));
}

/**
 * Returns the id part of a typed reference when the prefix matches.
 *
 * @param reference Raw proposal source reference.
 * @param prefix Expected reference prefix.
 * @returns Stripped id or original reference.
 */
function stripReferencePrefix(reference: string, prefix: 'knowledge' | 'source'): string {
  const expected = `${prefix}:`;
  return reference.startsWith(expected) ? reference.slice(expected.length) : reference;
}
