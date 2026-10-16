import {
  createStructuredWorkerDelegationRequest,
  createWorkerDelegationDraft,
  type DelegationContextRef,
  type StructuredWorkerDelegationRequest,
  type StructuredWorkerDelegationRequestInput,
  type WorkerDelegationDraft,
} from './delegation.js';

/**
 * Routing decision kind produced by WorkerCoordinatorAgent.
 */
export type WorkerCoordinatorDecisionKind = 'worker_turn' | 'blocked';

/** Required user action when explicit delegation lacks eligible supply. */
export type WorkerCoordinatorRequiredUserAction = 'none' | 'refine_request';

/**
 * Worker readiness state consumed by WorkerCoordinatorAgent.
 */
export type WorkerCoordinatorReadiness = 'ready' | 'blocked' | 'unknown';

/**
 * Worker candidate visible to WorkerCoordinatorAgent.
 */
export interface WorkerCoordinatorCandidate {
  /** Stable agent id from Core readiness. */
  readonly agentId: string;
  /** Human-readable agent name. */
  readonly displayName: string;
  /** Readiness status. */
  readonly readiness: WorkerCoordinatorReadiness;
  /** Optional readiness reasons. */
  readonly reasons?: readonly string[] | undefined;
}

/**
 * Bounded workspace summary read model consumed by WorkerCoordinatorAgent.
 */
export interface WorkerCoordinatorWorkspaceSummary {
  /** Workspace id. */
  readonly workspaceId: string;
  /** Optional workspace display name. */
  readonly name?: string;
}

/**
 * Bounded thread state read model consumed by WorkerCoordinatorAgent.
 */
export interface WorkerCoordinatorThreadState {
  /** Thread id. */
  readonly threadId: string;
  /** Thread status summarized for routing. */
  readonly status: 'idle' | 'running' | 'failed' | 'completed';
}

/**
 * Input read model for WorkerCoordinatorAgent.
 */
export interface WorkerCoordinatorInput {
  /** Trusted mode-service intent from the operation or accepted handoff, never prompt prose. */
  readonly entryIntent: 'explicit_task';
  /** Exact selected Task instruction. */
  readonly prompt: string;
  /** Available worker readiness summaries. */
  readonly readiness: readonly WorkerCoordinatorCandidate[];
  /** Thread state summary. */
  readonly threadState: WorkerCoordinatorThreadState;
  /** Workspace summary. */
  readonly workspaceSummary: WorkerCoordinatorWorkspaceSummary;
  /** Source context references prepared before worker delegation. */
  readonly contextRefs?: readonly DelegationContextRef[];
  /** Authorized request facts that Coordinator must compose with objective and context refs. */
  readonly workerRequestDetails?: Omit<
    StructuredWorkerDelegationRequestInput,
    'objective' | 'contextRefs'
  >;
}

/**
 * Structured WorkerCoordinatorAgent decision.
 */
export interface WorkerCoordinatorDecision {
  /** Routing decision kind. */
  readonly decision: WorkerCoordinatorDecisionKind;
  /** Confidence from 0 to 1. */
  readonly confidence: number;
  /** Human-readable explanation for the decision. */
  readonly explanation: string;
  /** Selected worker candidate, if a worker turn is appropriate. */
  readonly selectedWorkerCandidate: WorkerCoordinatorCandidate | null;
  /** User action required before Core should continue. */
  readonly requiredUserAction: WorkerCoordinatorRequiredUserAction;
  /** Worker delegation draft when a worker turn is recommended. */
  readonly delegationDraft: WorkerDelegationDraft | null;
  /** Structured worker request when a worker turn is recommended. */
  readonly workerRequest: StructuredWorkerDelegationRequest | null;
}

/**
 * Composes explicit Task delegation from trusted entry intent and current eligible supply.
 *
 * @param input Worker coordinator input read model.
 * @returns Structured routing decision.
 */
export function createWorkerCoordinatorDecision(
  input: WorkerCoordinatorInput
): WorkerCoordinatorDecision {
  if (input.entryIntent !== 'explicit_task') {
    throw new Error('Invalid Workflow Coordinator entry intent.');
  }
  const prompt = input.prompt;
  const selected = selectWorkerCandidate(input.readiness);

  if (!selected) {
    return blockedDecision('No ready worker candidate is available.');
  }

  const contextRefs = [
    { kind: 'workspace' as const, id: input.workspaceSummary.workspaceId },
    { kind: 'thread' as const, id: input.threadState.threadId },
    ...(input.contextRefs ?? []),
  ];
  const workerRequestDetails = input.workerRequestDetails ?? {
    acceptanceCriteria: [
      'The bounded worker task satisfies the requested objective.',
      'The worker reports verification evidence or a clear blocker.',
    ],
    expectedArtifacts: [
      {
        kind: 'artifact' as const,
        description:
          'The outputs the objective requires, such as changed files, documents or submitted Artifacts.',
      },
    ],
    resources: [],
    constraints: {
      maxContextTokens: 240_000,
      maxWorkerIterations: 1,
    },
    verification: [
      {
        kind: 'manual' as const,
        description:
          'Check the result against the objective, run any checks the objective names, or explain why they cannot run.',
      },
    ],
    reviewPolicy: {
      required: false,
      reviewers: ['human'],
      instructions: 'Review the worker result, its outputs and verification evidence.',
    },
    escalationConditions: [
      'Escalate if a source, tool or authorization required to complete the objective is unavailable or invalid.',
      'An empty local work slot alone is not a blocker when admitted tools can complete the objective. Stay within the objective and current authorization, and follow the existing approval requirements for every governed effect.',
      'Escalate if the task requires broader decomposition.',
    ],
    reviewContext: null,
  };

  return {
    decision: 'worker_turn',
    confidence: 0.8,
    explanation: `The request needs bounded worker execution and ${selected.displayName} is ready.`,
    selectedWorkerCandidate: selected,
    requiredUserAction: 'none',
    delegationDraft: createWorkerDelegationDraft({
      prompt,
      workspaceId: input.workspaceSummary.workspaceId,
      threadId: input.threadState.threadId,
      target: selected,
      ...(input.contextRefs ? { contextRefs: input.contextRefs } : {}),
    }),
    workerRequest: createStructuredWorkerDelegationRequest({
      ...workerRequestDetails,
      objective: prompt,
      contextRefs,
    }),
  };
}

/**
 * Selects a ready worker candidate.
 *
 * @param candidates Worker readiness candidates.
 * @returns Selected candidate, or null when none is ready.
 */
function selectWorkerCandidate(
  candidates: readonly WorkerCoordinatorCandidate[]
): WorkerCoordinatorCandidate | null {
  return candidates.find((candidate) => candidate.readiness === 'ready') ?? null;
}

/**
 * Creates a blocked routing decision.
 *
 * @param explanation Explanation for the blocked decision.
 * @returns Blocked decision.
 */
function blockedDecision(explanation: string): WorkerCoordinatorDecision {
  return {
    decision: 'blocked',
    confidence: 0.9,
    explanation,
    selectedWorkerCandidate: null,
    requiredUserAction: 'refine_request',
    delegationDraft: null,
    workerRequest: null,
  };
}
