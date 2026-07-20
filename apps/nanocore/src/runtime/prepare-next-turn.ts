import type { LlmProjectionResult } from '../context/llm-projection.js';
import type {
  DelegationContextRef,
  StructuredWorkerDelegationRequest,
  StructuredWorkerDelegationRequestInput,
} from '../internal-agents/delegation.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  getDefaultWorkspaceRepositoryResource,
  type WorkspaceRepositoryResourceRecord,
} from '../workspace/repository-store.js';

/**
 * Task state needed to prepare the next bounded worker turn.
 */
export interface PrepareNextTurnTaskState {
  /** Worker-facing task objective. */
  readonly objective: string;
  /** Task-level acceptance criteria. */
  readonly acceptanceCriteria: readonly string[];
  /** Exact semantic resources selected by the approved Plan. */
  readonly resources: StructuredWorkerDelegationRequestInput['resources'];
  /** Expected artifacts or file changes from the worker task. */
  readonly expectedArtifacts: StructuredWorkerDelegationRequestInput['expectedArtifacts'];
  /** Maximum worker context budget approved for the Task. */
  readonly contextBudgetTokens: number;
  /** Verification commands or checks expected after worker execution. */
  readonly verification: StructuredWorkerDelegationRequestInput['verification'];
  /** Human review policy approved for the Task. */
  readonly reviewPolicy: StructuredWorkerDelegationRequestInput['reviewPolicy'];
  /** Conditions that require worker escalation. */
  readonly escalationConditions: StructuredWorkerDelegationRequestInput['escalationConditions'];
}

/**
 * Input used to prepare the next worker turn.
 */
export interface PrepareNextTurnInput {
  /** Workspace that owns the worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the worker turn. */
  readonly threadId: string;
  /** Task state selected for worker execution. */
  readonly taskState: PrepareNextTurnTaskState;
  /** Provider-visible context projection for the worker. */
  readonly contextProjection: LlmProjectionResult;
  /** Resolved Goal Review context carried into a continuation attempt. */
  readonly reviewContext?: StructuredWorkerDelegationRequestInput['reviewContext'];
}

/**
 * Authorized context and request facts prepared before Coordinator composition.
 */
export interface PreparedNextTurnContext {
  /** Ready repository resource selected for the worker. */
  readonly repository: WorkspaceRepositoryResourceRecord;
  /** Worker objective read from the selected durable Task. */
  readonly objective: string;
  /** Source refs that Coordinator must place after Workspace and Thread refs. */
  readonly contextRefs: readonly DelegationContextRef[];
  /** Authorized request facts that do not include objective or context ownership. */
  readonly workerRequestDetails: Omit<
    StructuredWorkerDelegationRequestInput,
    'objective' | 'contextRefs'
  >;
  /** Context package digest from the selected projection. */
  readonly contextPackageDigest: string;
}

/**
 * Prepared worker-turn inputs.
 */
export interface PreparedNextTurn {
  /** Ready repository resource selected for the worker. */
  readonly repository: WorkspaceRepositoryResourceRecord;
  /** Structured worker delegation request for bounded execution. */
  readonly delegationRequest: StructuredWorkerDelegationRequest;
  /** Context package digest from the selected projection. */
  readonly contextPackageDigest: string;
  /** Governed Knowledge selection consumed by a direct Task, or null for non-Task turns. */
  readonly knowledgeSelectionInput: { readonly retrievalTraceId: string } | null;
}

/**
 * Prepares authorized context and request facts without composing or starting a worker request.
 *
 * @param coreDb Open Core database handles.
 * @param input Next-turn preparation input.
 * @returns Prepared context and request facts for Coordinator composition.
 * @throws Error when no ready repository or no included context is available.
 */
export function prepareNextTurnContext(
  coreDb: CoreDb,
  input: PrepareNextTurnInput
): PreparedNextTurnContext {
  const repository = requireReadyRepository(coreDb, input.workspaceId);
  const contextRefs = createContextRefs(input);

  return {
    repository,
    objective: input.taskState.objective,
    contextRefs,
    workerRequestDetails: {
      acceptanceCriteria: input.taskState.acceptanceCriteria,
      resources: input.taskState.resources,
      expectedArtifacts: input.taskState.expectedArtifacts,
      constraints: {
        maxContextTokens: input.taskState.contextBudgetTokens,
        maxWorkerIterations: 1,
      },
      verification: input.taskState.verification,
      reviewPolicy: input.taskState.reviewPolicy,
      escalationConditions: input.taskState.escalationConditions,
      reviewContext: input.reviewContext ?? null,
    },
    contextPackageDigest: input.contextProjection.contextPackageDigest,
  };
}

/**
 * Reads the default ready repository for one workspace.
 *
 * @param coreDb Open Core database handles.
 * @param workspaceId Workspace id to inspect.
 * @returns Ready repository resource.
 * @throws Error when no ready repository exists.
 */
function requireReadyRepository(
  coreDb: CoreDb,
  workspaceId: string
): WorkspaceRepositoryResourceRecord {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspaceId);
  let repository: WorkspaceRepositoryResourceRecord | null;
  try {
    applyScopedMigrations(workspaceDb);
    repository = getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId);
  } finally {
    workspaceDb.sqlite.close();
  }

  if (!repository || repository.diagnosticsStatus !== 'ready') {
    throw new Error(`Workspace repository not ready: ${workspaceId}`);
  }

  return repository;
}

/**
 * Creates structured delegation context references for one prepared turn.
 *
 * @param input Next-turn preparation input.
 * @returns Deduplicated context references.
 * @throws Error when the context projection has no included item ids.
 */
function createContextRefs(input: PrepareNextTurnInput): DelegationContextRef[] {
  if (input.contextProjection.includedItemIds.length === 0) {
    throw new Error('prepareNextTurnContext requires at least one included context item.');
  }

  return dedupeContextRefs([
    ...input.contextProjection.includedItemIds.map((itemId) => ({
      kind: 'item' as const,
      id: itemId,
    })),
  ]);
}

/**
 * Removes duplicate context references while preserving first-seen order.
 *
 * @param refs Context references to deduplicate.
 * @returns Deduplicated context references.
 */
function dedupeContextRefs(refs: readonly DelegationContextRef[]): DelegationContextRef[] {
  const seen = new Set<string>();
  const deduped: DelegationContextRef[] = [];

  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`;

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ref);
    }
  }

  return deduped;
}
