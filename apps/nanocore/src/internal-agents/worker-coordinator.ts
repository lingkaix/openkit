import { z } from 'zod';

import type { StopAfterTurnDecision } from '../runtime/stop-after-turn.js';
import {
  createStructuredWorkerDelegationRequest,
  createWorkerDelegationDraft,
  type DelegationContextRef,
  type StructuredWorkerDelegationRequest,
  StructuredWorkerDelegationRequestSchema,
  type WorkerDelegationDraft,
  WorkerDelegationDraftSchema,
} from './delegation.js';
import { WORKER_COORDINATOR_AGENT_ID, WORKER_COORDINATOR_CORE_TOOL_ALLOWLIST } from './tools.js';
import type { InternalAgentDefinition } from './types.js';

/**
 * Routing decision kind produced by WorkerCoordinatorAgent.
 */
export type WorkerCoordinatorDecisionKind =
  | 'quick_chat'
  | 'worker_turn'
  | 'goal'
  | 'clarify'
  | 'review'
  | 'refinement'
  | 'retry'
  | 'handoff'
  | 'unsupported'
  | 'blocked';

/**
 * Required user action after a routing decision.
 */
export type WorkerCoordinatorRequiredUserAction =
  | 'none'
  | 'confirm_worker_turn'
  | 'choose_worker'
  | 'refine_request'
  | 'review_ready';

/**
 * Worker runtime family known to v0.0.5 routing.
 */
export type WorkerCoordinatorRuntime = 'codex' | 'opencode';

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
  /** Runtime family. */
  readonly runtime: WorkerCoordinatorRuntime;
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
  readonly status: 'idle' | 'running' | 'awaiting_human' | 'failed' | 'completed';
}

/**
 * Bounded recent failure context consumed by WorkerCoordinatorAgent.
 */
export interface WorkerCoordinatorFailureContext {
  /** Stable failure code or category. */
  readonly code: string;
  /** Short redacted failure summary. */
  readonly summary: string;
}

/**
 * Input read model for WorkerCoordinatorAgent.
 */
export interface WorkerCoordinatorInput {
  /** User prompt to route. */
  readonly prompt: string;
  /** Routing origin used to avoid reclassifying approved Goal Mode steps as new user goals. */
  readonly routingContext?: 'user_prompt' | 'goal_step';
  /** Available worker readiness summaries. */
  readonly readiness: readonly WorkerCoordinatorCandidate[];
  /** Thread state summary. */
  readonly threadState: WorkerCoordinatorThreadState;
  /** Workspace summary. */
  readonly workspaceSummary: WorkerCoordinatorWorkspaceSummary;
  /** Bounded recent failures, if any. */
  readonly recentFailures?: readonly WorkerCoordinatorFailureContext[];
  /** Source context references prepared before worker delegation. */
  readonly contextRefs?: readonly DelegationContextRef[];
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
 * Input used when Workflow Coordinator owns a Goal Mode plan draft.
 */
export interface WorkerCoordinatorGoalPlanDraftInput {
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Goal id being planned. */
  readonly goalId: string;
  /** Goal title being planned. */
  readonly title: string;
  /** Goal objective being planned. */
  readonly objective: string;
}

/**
 * Product-facing Workflow Coordinator summary for one Goal Mode plan draft.
 */
export interface WorkerCoordinatorGoalPlanDraftSummary {
  /** Product mode planned by the Coordinator. */
  readonly mode: 'goal';
  /** Internal agent that owns the planning decision. */
  readonly sourceAgentId: typeof WORKER_COORDINATOR_AGENT_ID;
  /** Rule-based confidence for this V1 plan draft. */
  readonly confidence: number;
  /** User-safe rationale for the generated plan draft. */
  readonly rationale: string;
  /** Source refs used to frame the plan draft. */
  readonly contextRefs: readonly DelegationContextRef[];
  /** Human approvals required before worker execution. */
  readonly requiredApprovals: readonly string[];
}

/**
 * Input used when Workflow Coordinator records a Goal Mode stop decision.
 */
export interface WorkerCoordinatorGoalStopDecisionInput {
  /** Workspace that owns the goal. */
  readonly workspaceId: string;
  /** Thread that owns the goal. */
  readonly threadId: string;
  /** Request id that triggered the stop decision. */
  readonly requestId: string;
  /** Goal id being advanced. */
  readonly goalId: string;
  /** Goal task id that produced the worker turn. */
  readonly taskId: string;
  /** Worker turn id that produced evidence. */
  readonly turnId: string;
  /** Lower-level worker-loop stop decision. */
  readonly stopDecision: StopAfterTurnDecision;
  /** Evidence produced by the worker turn. */
  readonly evidence: {
    /** Worker turn item ids used as evidence. */
    readonly itemIds: readonly string[];
    /** Worker turn artifact ids used as evidence. */
    readonly artifactIds: readonly string[];
  };
}

/**
 * Product-facing Workflow Coordinator stop decision for one Goal Mode step.
 */
export interface WorkerCoordinatorGoalStopDecision {
  /** Stable schema version for Coordinator stop-decision summaries. */
  readonly schemaVersion: 1;
  /** Product mode advanced by the Coordinator. */
  readonly mode: 'goal';
  /** Internal agent that owns the stop decision. */
  readonly sourceAgentId: typeof WORKER_COORDINATOR_AGENT_ID;
  /** Request id that triggered the stop decision. */
  readonly requestId: string;
  /** Higher-level Goal Mode outcome selected by the Coordinator. */
  readonly outcome: StopAfterTurnDecision['outcome'];
  /** True when Goal Mode must pause or terminate before another step. */
  readonly shouldStop: boolean;
  /** Worker stop reason that produced the decision. */
  readonly stopReason: StopAfterTurnDecision['stopReason'];
  /** User-safe explanation for the selected stop decision. */
  readonly rationale: string;
  /** Source refs used to scope the stop decision. */
  readonly contextRefs: readonly DelegationContextRef[];
  /** Evidence refs that justify the stop decision. */
  readonly evidence: {
    /** Worker turn item ids used as evidence. */
    readonly itemIds: readonly string[];
    /** Worker turn artifact ids used as evidence. */
    readonly artifactIds: readonly string[];
  };
}

/**
 * Zod schema for WorkerCoordinatorAgent output validation.
 */
export const WorkerCoordinatorDecisionSchema = z.object({
  decision: z.enum([
    'quick_chat',
    'worker_turn',
    'goal',
    'clarify',
    'review',
    'refinement',
    'retry',
    'handoff',
    'unsupported',
    'blocked',
  ]),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  selectedWorkerCandidate: z
    .object({
      agentId: z.string().min(1),
      displayName: z.string().min(1),
      runtime: z.enum(['codex', 'opencode']),
      readiness: z.enum(['ready', 'blocked', 'unknown']),
      reasons: z.array(z.string()).optional(),
    })
    .nullable(),
  requiredUserAction: z.enum([
    'none',
    'confirm_worker_turn',
    'choose_worker',
    'refine_request',
    'review_ready',
  ]),
  delegationDraft: WorkerDelegationDraftSchema.nullable(),
  workerRequest: StructuredWorkerDelegationRequestSchema.nullable(),
});

/**
 * Built-in lightweight internal agent for worker routing decisions.
 */
export const WORKER_COORDINATOR_AGENT_DEFINITION: InternalAgentDefinition<WorkerCoordinatorDecision> =
  {
    id: WORKER_COORDINATOR_AGENT_ID,
    displayName: 'WorkerCoordinatorAgent',
    purpose:
      'Route user prompts between quick chat, review, refinement, handoff, and worker turns.',
    category: 'routing',
    supportedModes: ['automation', 'plan', 'review', 'delegation'],
    defaultProviderUse: 'internalTasks',
    systemPrompt:
      'You are WorkerCoordinatorAgent, a lightweight OpenKit Core coordination agent. Return structured routing decisions only. Do not start workers, edit files, run shell commands, browse, or call runtime-native tools.',
    allowedTools: WORKER_COORDINATOR_CORE_TOOL_ALLOWLIST,
    limits: {
      maxInputMessages: 8,
      timeoutMs: 20_000,
    },
    outputSchema: WorkerCoordinatorDecisionSchema,
  };

/**
 * Creates a deterministic worker routing decision from bounded Core read models.
 *
 * @param input Worker coordinator input read model.
 * @returns Structured routing decision.
 */
export function createWorkerCoordinatorDecision(
  input: WorkerCoordinatorInput
): WorkerCoordinatorDecision {
  const prompt = input.prompt.trim();
  const normalizedPrompt = prompt.toLowerCase();
  const approvedGoalStep = input.routingContext === 'goal_step';

  if (isUnsupportedPrompt(normalizedPrompt)) {
    return unsupportedDecision('The request asks for sensitive external side effects.');
  }
  if (!approvedGoalStep && isClarifyPrompt(normalizedPrompt)) {
    return {
      decision: 'clarify',
      confidence: 0.72,
      explanation: 'The request needs clarification before routing.',
      selectedWorkerCandidate: null,
      requiredUserAction: 'refine_request',
      delegationDraft: null,
      workerRequest: null,
    };
  }
  if (!approvedGoalStep && isGoalPrompt(normalizedPrompt)) {
    return {
      decision: 'goal',
      confidence: 0.8,
      explanation: 'The request needs explicit Goal Mode planning before worker execution.',
      selectedWorkerCandidate: null,
      requiredUserAction: 'review_ready',
      delegationDraft: null,
      workerRequest: null,
    };
  }
  if (!approvedGoalStep && isReviewPrompt(normalizedPrompt)) {
    return {
      decision: 'review',
      confidence: 0.76,
      explanation: 'The request is asking to evaluate recent work rather than start new execution.',
      selectedWorkerCandidate: null,
      requiredUserAction: 'review_ready',
      delegationDraft: null,
      workerRequest: null,
    };
  }
  if (!approvedGoalStep && isRefinementPrompt(normalizedPrompt)) {
    return {
      decision: 'refinement',
      confidence: 0.72,
      explanation: 'The request appears to refine prior output in the current thread.',
      selectedWorkerCandidate: null,
      requiredUserAction: 'confirm_worker_turn',
      delegationDraft: null,
      workerRequest: null,
    };
  }
  if (!approvedGoalStep && isRetryPrompt(normalizedPrompt)) {
    return {
      decision: 'retry',
      confidence: 0.72,
      explanation: 'The request asks to retry prior worker execution.',
      selectedWorkerCandidate: null,
      requiredUserAction: 'confirm_worker_turn',
      delegationDraft: null,
      workerRequest: null,
    };
  }
  if (!approvedGoalStep && isHandoffPrompt(normalizedPrompt)) {
    return {
      decision: 'handoff',
      confidence: 0.72,
      explanation: 'The request asks to hand work to another worker or phase.',
      selectedWorkerCandidate: null,
      requiredUserAction: 'choose_worker',
      delegationDraft: null,
      workerRequest: null,
    };
  }
  if (!approvedGoalStep && isQuickChatPrompt(normalizedPrompt)) {
    return {
      decision: 'quick_chat',
      confidence: 0.82,
      explanation: 'The request is a simple question that does not require worker execution.',
      selectedWorkerCandidate: null,
      requiredUserAction: 'none',
      delegationDraft: null,
      workerRequest: null,
    };
  }
  if (!requiresWorker(normalizedPrompt)) {
    return {
      decision: 'quick_chat',
      confidence: 0.62,
      explanation: 'The request lacks an execution verb or concrete worker deliverable.',
      selectedWorkerCandidate: null,
      requiredUserAction: 'none',
      delegationDraft: null,
      workerRequest: null,
    };
  }

  const selected = selectWorkerCandidate(input.readiness, normalizedPrompt);

  if (!selected) {
    return blockedDecision('No ready Codex or OpenCode worker candidate is available.');
  }

  const contextRefs = [
    { kind: 'workspace' as const, id: input.workspaceSummary.workspaceId },
    { kind: 'thread' as const, id: input.threadState.threadId },
    ...(input.contextRefs ?? []),
  ];

  return {
    decision: 'worker_turn',
    confidence: selected.runtime === 'codex' ? 0.86 : 0.8,
    explanation: `The request needs bounded worker execution and ${selected.displayName} is ready.`,
    selectedWorkerCandidate: selected,
    requiredUserAction: 'confirm_worker_turn',
    delegationDraft: createWorkerDelegationDraft({
      prompt,
      workspaceId: input.workspaceSummary.workspaceId,
      threadId: input.threadState.threadId,
      target: selected,
      ...(input.contextRefs ? { contextRefs: input.contextRefs } : {}),
    }),
    workerRequest: createStructuredWorkerDelegationRequest({
      objective: prompt,
      acceptanceCriteria: [
        'The bounded worker task satisfies the requested objective.',
        'The worker reports verification evidence or a clear blocker.',
      ],
      contextRefs,
      expectedArtifacts: [
        {
          kind: 'code-change',
          description: 'Focused workspace changes needed to satisfy the objective.',
        },
        {
          kind: 'test-result',
          description: 'Verification evidence from the focused checks.',
        },
      ],
      constraints: {
        maxContextTokens: 240_000,
        maxWorkerIterations: 1,
        requiresUserConfirmation: true,
        stopConditions: [
          'Stop if repository setup is missing or invalid.',
          'Stop if the task requires broader decomposition.',
        ],
      },
      verification: [
        {
          kind: 'manual',
          description: 'Run the checks named by the worker task or explain why they cannot run.',
        },
      ],
      reviewPolicy: {
        required: true,
        reviewers: ['human'],
        instructions: 'Review the worker result, changed files, and verification evidence.',
      },
    }),
  };
}

/**
 * Creates the V1 Workflow Coordinator summary for one Goal Mode plan draft.
 *
 * @param input Goal planning context.
 * @returns Product-facing plan draft summary.
 */
export function createWorkerCoordinatorGoalPlanDraft(
  input: WorkerCoordinatorGoalPlanDraftInput
): WorkerCoordinatorGoalPlanDraftSummary {
  return {
    mode: 'goal',
    sourceAgentId: WORKER_COORDINATOR_AGENT_ID,
    confidence: 0.84,
    rationale: `Workflow Coordinator drafted a reviewable Goal Mode plan for "${input.title}".`,
    contextRefs: [
      { kind: 'workspace', id: input.workspaceId },
      { kind: 'thread', id: input.threadId },
    ],
    requiredApprovals: ['plan_approval'],
  };
}

/**
 * Creates the V1 Workflow Coordinator stop decision for one Goal Mode worker step.
 *
 * @param input Goal step stop-decision context.
 * @returns Product-facing stop decision summary.
 */
export function createWorkerCoordinatorGoalStopDecision(
  input: WorkerCoordinatorGoalStopDecisionInput
): WorkerCoordinatorGoalStopDecision {
  return {
    schemaVersion: 1,
    mode: 'goal',
    sourceAgentId: WORKER_COORDINATOR_AGENT_ID,
    requestId: input.requestId,
    outcome: input.stopDecision.outcome,
    shouldStop: input.stopDecision.shouldStop,
    stopReason: input.stopDecision.stopReason,
    rationale: rationaleForGoalStopDecision(input.stopDecision.outcome),
    contextRefs: [
      { kind: 'workspace', id: input.workspaceId },
      { kind: 'thread', id: input.threadId },
    ],
    evidence: {
      itemIds: [...input.evidence.itemIds],
      artifactIds: [...input.evidence.artifactIds],
    },
  };
}

/**
 * Creates a user-safe rationale for one Goal Mode stop outcome.
 *
 * @param outcome Goal Mode stop outcome.
 * @returns Rationale string.
 */
function rationaleForGoalStopDecision(outcome: StopAfterTurnDecision['outcome']): string {
  switch (outcome) {
    case 'review':
      return 'Worker turn completed and needs human review before Goal Mode continues.';
    case 'ask_user':
      return 'Worker turn requested user input before Goal Mode can continue.';
    case 'block':
      return 'Worker turn ended with a blocker that Goal Mode cannot resolve automatically.';
    case 'abort':
      return 'Worker turn was aborted before Goal Mode could continue.';
    case 'complete':
      return 'Worker turn completed the Goal Mode objective.';
    case 'continue':
      return 'Worker turn can continue to the next bounded Goal Mode step.';
  }
}

/**
 * Checks for prompts that should not be routed automatically.
 *
 * @param prompt Lowercase prompt.
 * @returns True when unsupported.
 */
function isUnsupportedPrompt(prompt: string): boolean {
  return /deploy\s+to\s+production|rotate\s+credentials|charge\s+.*card|wire\s+money|delete\s+production/.test(
    prompt
  );
}

/**
 * Checks for vague prompts that need clarification before routing.
 *
 * @param prompt Lowercase prompt.
 * @returns True when clarification is needed.
 */
function isClarifyPrompt(prompt: string): boolean {
  const normalized = prompt.replace(/[.?!]+$/g, '').trim();

  return [
    'help',
    'help me',
    'can you help',
    'can you help me',
    'can you help with this',
    'what should i do',
    'what do i do',
    'do it',
    'do something',
  ].includes(normalized);
}

/**
 * Checks for prompts that should become Goal Mode planning.
 *
 * @param prompt Lowercase prompt.
 * @returns True when explicit Goal Mode planning is needed.
 */
function isGoalPrompt(prompt: string): boolean {
  return /\b(goal|multi-step|long-running|roadmap|milestone|strategy|strategic|plan|planning)\b/.test(
    prompt
  );
}

/**
 * Checks for review-mode prompts.
 *
 * @param prompt Lowercase prompt.
 * @returns True when review is likely.
 */
function isReviewPrompt(prompt: string): boolean {
  return /\breview\b|\baudit\b|\bcheck\s+the\s+work\b/.test(prompt);
}

/**
 * Checks for refinement-mode prompts.
 *
 * @param prompt Lowercase prompt.
 * @returns True when refinement is likely.
 */
function isRefinementPrompt(prompt: string): boolean {
  return /\brefine\b|\biterate\b|\bmake\s+it\s+better\b|\bupdate\s+the\s+previous\b/.test(prompt);
}

/**
 * Checks for retry-mode prompts.
 *
 * @param prompt Lowercase prompt.
 * @returns True when retry is likely.
 */
function isRetryPrompt(prompt: string): boolean {
  return /\bretry\b|\brerun\b|\btry\s+again\b|\brun\s+it\s+again\b/.test(prompt);
}

/**
 * Checks for handoff-mode prompts.
 *
 * @param prompt Lowercase prompt.
 * @returns True when handoff is likely.
 */
function isHandoffPrompt(prompt: string): boolean {
  return /\bhandoff\b|\bhand\s+off\b|\bpass\s+to\b/.test(prompt);
}

/**
 * Checks whether a prompt is better answered through quick chat.
 *
 * @param prompt Lowercase prompt.
 * @returns True for simple conversational questions.
 */
function isQuickChatPrompt(prompt: string): boolean {
  return (
    prompt.endsWith('?') &&
    !/\b(implement|fix|change|edit|write|create|run|test|build|commit|file|code|repo|app)\b/.test(
      prompt
    )
  );
}

/**
 * Checks whether a prompt asks for bounded worker execution.
 *
 * @param prompt Lowercase prompt.
 * @returns True when the prompt has execution intent.
 */
function requiresWorker(prompt: string): boolean {
  return /\b(implement|fix|change|edit|write|create|delete|remove|run|test|build|commit|inspect|refactor|debug)\b/.test(
    prompt
  );
}

/**
 * Selects a ready worker candidate.
 *
 * @param candidates Worker readiness candidates.
 * @param prompt Lowercase prompt.
 * @returns Selected candidate, or null when none is ready.
 */
function selectWorkerCandidate(
  candidates: readonly WorkerCoordinatorCandidate[],
  prompt: string
): WorkerCoordinatorCandidate | null {
  const ready = candidates.filter((candidate) => candidate.readiness === 'ready');

  if (/\bopencode\b/.test(prompt)) {
    return ready.find((candidate) => candidate.runtime === 'opencode') ?? null;
  }
  if (/\bcodex\b/.test(prompt)) {
    return ready.find((candidate) => candidate.runtime === 'codex') ?? null;
  }

  return (
    ready.find((candidate) => candidate.runtime === 'codex') ??
    ready.find((candidate) => candidate.runtime === 'opencode') ??
    null
  );
}

/**
 * Creates an unsupported routing decision.
 *
 * @param explanation Explanation for the unsupported decision.
 * @returns Unsupported decision.
 */
function unsupportedDecision(explanation: string): WorkerCoordinatorDecision {
  return {
    decision: 'unsupported',
    confidence: 0.9,
    explanation,
    selectedWorkerCandidate: null,
    requiredUserAction: 'refine_request',
    delegationDraft: null,
    workerRequest: null,
  };
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
