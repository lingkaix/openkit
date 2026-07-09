import type { LlmProjectionResult } from '../context/llm-projection.js';
import {
  createStructuredWorkerDelegationRequest,
  type DelegationContextRef,
  STRUCTURED_WORKER_DELEGATION_MAX_CONTEXT_TOKENS,
  type StructuredWorkerDelegationRequest,
  type StructuredWorkerDelegationRequestInput,
} from '../internal-agents/delegation.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  getDefaultWorkspaceRepositoryResource,
  type WorkspaceRepositoryResourceRecord,
} from '../workspace/repository-store.js';
import type { QueuedFollowUpInput, SafePointSteeringMessage } from './user-turn-queues.js';

const REVIEW_INSTRUCTIONS_MAX_LENGTH = 2_000;
const TRUNCATION_SUFFIX = '\n[truncated]';

/**
 * Goal state needed to prepare the next bounded worker turn.
 */
export interface PrepareNextTurnGoalState {
  /** Goal id that owns the task. */
  readonly goalId: string;
  /** Human-readable goal title. */
  readonly title: string;
  /** Goal objective that frames the worker task. */
  readonly objective: string;
  /** Goal-level acceptance criteria. */
  readonly acceptanceCriteria: readonly string[];
}

/**
 * Task state needed to prepare the next bounded worker turn.
 */
export interface PrepareNextTurnTaskState {
  /** Task id selected for the next worker turn. */
  readonly taskId: string;
  /** Human-readable task title. */
  readonly title: string;
  /** Worker-facing task objective. */
  readonly objective: string;
  /** Task-level acceptance criteria. */
  readonly acceptanceCriteria: readonly string[];
  /** Expected artifacts or file changes from the worker task. */
  readonly expectedArtifacts: StructuredWorkerDelegationRequestInput['expectedArtifacts'];
  /** Verification commands or checks expected after worker execution. */
  readonly verification: StructuredWorkerDelegationRequestInput['verification'];
  /** Stop conditions for the worker turn. */
  readonly stopConditions: readonly string[];
}

/**
 * Input used to prepare the next worker turn.
 */
export interface PrepareNextTurnInput {
  /** User that owns the workspace storage; defaults to local-mode user for current callers. */
  readonly userId?: string;
  /** Workspace that owns the worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the worker turn. */
  readonly threadId: string;
  /** Goal state that frames the selected task. */
  readonly goalState: PrepareNextTurnGoalState;
  /** Task state selected for worker execution. */
  readonly taskState: PrepareNextTurnTaskState;
  /** Provider-visible context projection for the worker. */
  readonly contextProjection: LlmProjectionResult;
  /** Queued safe-point steering messages selected for this turn. */
  readonly steeringMessages: readonly SafePointSteeringMessage[];
  /** Queued follow-up inputs selected for this turn. */
  readonly followUpInputs: readonly QueuedFollowUpInput[];
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
  /** Queued safe-point steering messages included in the prepared turn. */
  readonly steeringMessages: readonly SafePointSteeringMessage[];
  /** Queued follow-up inputs included in the prepared turn. */
  readonly followUpInputs: readonly QueuedFollowUpInput[];
}

/**
 * Prepares the next bounded worker turn without starting worker execution.
 *
 * @param coreDb Open Core database handles.
 * @param input Next-turn preparation input.
 * @returns Prepared worker-turn inputs.
 * @throws Error when no ready repository or no included context is available.
 */
export function prepareNextTurn(coreDb: CoreDb, input: PrepareNextTurnInput): PreparedNextTurn {
  const repository = requireReadyRepository(
    coreDb,
    input.userId ?? LOCAL_USER_ID,
    input.workspaceId
  );
  const contextRefs = createContextRefs(input);

  return {
    repository,
    delegationRequest: createStructuredWorkerDelegationRequest({
      objective: input.taskState.objective,
      acceptanceCriteria: input.taskState.acceptanceCriteria,
      contextRefs,
      expectedArtifacts: input.taskState.expectedArtifacts,
      constraints: {
        maxContextTokens: STRUCTURED_WORKER_DELEGATION_MAX_CONTEXT_TOKENS,
        maxWorkerIterations: 1,
        requiresUserConfirmation: true,
        stopConditions: [...input.taskState.stopConditions],
      },
      verification: input.taskState.verification,
      reviewPolicy: {
        required: true,
        reviewers: ['internal'],
        instructions: createReviewInstructions(input.goalState, input.taskState),
      },
    }),
    contextPackageDigest: input.contextProjection.contextPackageDigest,
    steeringMessages: [...input.steeringMessages],
    followUpInputs: [...input.followUpInputs],
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
  userId: string,
  workspaceId: string
): WorkspaceRepositoryResourceRecord {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, userId, workspaceId);
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
    throw new Error('prepareNextTurn requires at least one included context item.');
  }

  return dedupeContextRefs([
    { kind: 'workspace', id: input.workspaceId },
    { kind: 'thread', id: input.threadId },
    ...input.contextProjection.includedItemIds.map((itemId) => ({
      kind: 'item' as const,
      id: itemId,
    })),
    ...input.steeringMessages.flatMap((message) => itemRefForPendingTurn(message.pendingTurn)),
    ...input.followUpInputs.flatMap((followUpInput) =>
      itemRefForPendingTurn(followUpInput.pendingTurn)
    ),
  ]);
}

/**
 * Builds an item reference for a queued pending input when an item id exists.
 *
 * @param pendingTurn Pending input row carried by a queue delivery record.
 * @returns Item context reference or an empty list.
 */
function itemRefForPendingTurn(
  pendingTurn: SafePointSteeringMessage['pendingTurn']
): DelegationContextRef[] {
  return pendingTurn.contentItemId ? [{ kind: 'item', id: pendingTurn.contentItemId }] : [];
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

/**
 * Creates internal review instructions from goal and task state.
 *
 * @param goalState Goal state that frames the worker task.
 * @param taskState Task state selected for worker execution.
 * @returns Review instruction text.
 */
function createReviewInstructions(
  goalState: PrepareNextTurnGoalState,
  taskState: PrepareNextTurnTaskState
): string {
  return truncateReviewInstructions(
    [
      `Review worker output for goal "${goalState.title}" (${goalState.goalId}).`,
      `Goal objective: ${goalState.objective}`,
      `Task "${taskState.title}" (${taskState.taskId}) must satisfy its task acceptance criteria and remain aligned with the goal criteria.`,
      `Goal criteria: ${goalState.acceptanceCriteria.join(' | ')}`,
    ].join('\n')
  );
}

/**
 * Truncates review instructions to the structured delegation schema limit.
 *
 * @param instructions Generated review instructions.
 * @returns Schema-safe review instructions.
 */
function truncateReviewInstructions(instructions: string): string {
  if (instructions.length <= REVIEW_INSTRUCTIONS_MAX_LENGTH) {
    return instructions;
  }

  return `${instructions.slice(0, REVIEW_INSTRUCTIONS_MAX_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}
