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
  /** Trusted mode-service intent from the operation or accepted handoff, never prompt prose. */
  readonly entryIntent: 'explicit_task' | 'conversation';
  /** User prompt to route. */
  readonly prompt: string;
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
 * Classifies conversational input or composes explicit Task delegation from trusted entry intent.
 *
 * @param input Worker coordinator input read model.
 * @returns Structured routing decision.
 */
export function createWorkerCoordinatorDecision(
  input: WorkerCoordinatorInput
): WorkerCoordinatorDecision {
  if (input.entryIntent !== 'explicit_task' && input.entryIntent !== 'conversation') {
    throw new Error('Invalid Workflow Coordinator entry intent.');
  }
  const prompt = input.prompt;
  if (input.entryIntent === 'conversation') {
    const normalizedPrompt = prompt.trim().toLowerCase();

    if (isUnsupportedPrompt(normalizedPrompt)) {
      return unsupportedDecision('The request asks for sensitive external side effects.');
    }
    if (isClarifyPrompt(normalizedPrompt)) {
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
    if (isGoalPrompt(normalizedPrompt)) {
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
    if (isReviewPrompt(normalizedPrompt)) {
      return {
        decision: 'review',
        confidence: 0.76,
        explanation:
          'The request is asking to evaluate recent work rather than start new execution.',
        selectedWorkerCandidate: null,
        requiredUserAction: 'review_ready',
        delegationDraft: null,
        workerRequest: null,
      };
    }
    if (isRefinementPrompt(normalizedPrompt)) {
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
    if (isRetryPrompt(normalizedPrompt)) {
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
    if (isHandoffPrompt(normalizedPrompt)) {
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
    if (isQuickChatPrompt(normalizedPrompt)) {
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
  }

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
  // ponytail: bounded English request phrases; expand from observed cases, not bare topic words.
  return (
    /\b(plan|planning)\s+(a|an|the|this|our|my|for)\b/.test(prompt) ||
    /\b(create|start|define|draft|set)\s+(a\s+|an\s+|the\s+)?(goal|plan|roadmap|milestone|strategy)\b/.test(
      prompt
    ) ||
    /\b(use|enter|start)\s+(the\s+)?(goal|plan)\s+mode\b/.test(prompt) ||
    /\b(implement|build|execute|run|start|coordinate|complete)\b[^.!?\n]*\b(multi-step|long-running|multi-agent|strategic)\b/.test(
      prompt
    )
  );
}

/**
 * Checks for Task Mode prompts that ask a worker to review/approve/merge a concrete PR.
 *
 * @param prompt Lowercase prompt.
 * @returns True when the prompt names a PR and a review/merge action.
 */
function isConcretePrWorkerPrompt(prompt: string): boolean {
  const hasPr = /\b(pr|pull[\s-]?request)\b|#\d+|github\.com\/[^\s]+\/pull\/\d+/i.test(prompt);
  const hasAction = /\b(review|approve|merge)\b/.test(prompt);
  return hasPr && hasAction;
}

const AFFIRMATIVE_LEADING_EXECUTION =
  /^(please\s+)?(?!run\s+it\s+again\b)(implement|fix|change|edit|write|create|delete|remove|run|test|build|commit|inspect|refactor|debug)\b/;
const AFFIRMATIVE_LEADING_QUICK_CHAT =
  /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(summarize|explain|describe)\b/;
const REQUEST_CLAUSE_SPLIT = /(?<=[.!?])(?:\s+|$)|(?:\n+)/;
const ROUTING_VERB =
  /(?:review|audit|check\s+the\s+work|refine|iterate|make\s+it\s+better|update\s+the\s+previous|retry|rerun|try\s+again|run\s+it\s+again|handoff|hand\s+off|pass\s+to|implement|fix|change|edit|write|create|delete|remove|run|test|build|commit|inspect|refactor|debug|approve|merge|summarize|explain|describe)\b/;
const LEADING_REQUEST = new RegExp(
  `^(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?(?:(?:i|we)\\s+need\\s+(?:you\\s+to\\s+)?)?${ROUTING_VERB.source}`
);
const INTERIOR_REQUEST = new RegExp(
  `[,:]\\s+(?:please\\s+|then\\s+|but\\s+|and\\s+|or\\s+)*(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?${ROUTING_VERB.source}`
);
const INFINITIVE_REQUEST =
  /\bto\s+(?:implement|fix|change|edit|write|create|delete|remove|run|test|build|commit|inspect|refactor|debug|merge|approve)\b/;

/**
 * Splits a lowercase prompt into clauses on sentence punctuation and newlines.
 *
 * @param prompt Lowercase trimmed prompt.
 * @returns Clauses in prompt order.
 */
function splitRequestClauses(prompt: string): string[] {
  return prompt
    .split(REQUEST_CLAUSE_SPLIT)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/**
 * Strips leading please/then so later kind scans see the request verb.
 *
 * @param text Lowercase clause or joined request text.
 * @returns Text without a leading please/then prefix.
 */
function stripRoutingPrefix(text: string): string {
  return text.replace(/^(?:please\s+|then\s+)+/, '');
}

/**
 * True when a clause is an unambiguous negated constraint.
 *
 * @param clause Lowercase clause.
 * @returns True when the clause only forbids work.
 */
function isNegatedConstraintClause(clause: string): boolean {
  const text = stripRoutingPrefix(clause);
  if (/^(?:do\s+not|don't)\b/.test(text)) {
    return true;
  }
  const adverbial = /^([^,]{1,60}),\s+((?:please\s+|then\s+)?(?:do\s+not|don't)\b[\s\S]*)$/.exec(
    text
  );
  const lead = adverbial?.[1]?.trim();
  return Boolean(lead) && !LEADING_REQUEST.test(stripRoutingPrefix(lead ?? ''));
}

/**
 * True when a clause contains a request construction rather than only supplied material.
 *
 * When in doubt the clause is kept.
 *
 * @param clause Lowercase clause.
 * @returns True when the clause asks for work.
 */
function clauseHasRequest(clause: string): boolean {
  const text = stripRoutingPrefix(clause);
  return (
    LEADING_REQUEST.test(text) ||
    INTERIOR_REQUEST.test(text) ||
    INFINITIVE_REQUEST.test(text) ||
    /^use\s+the\s+(?!.*\?[.!]*$)\S/.test(text) ||
    isConcretePrWorkerPrompt(text)
  );
}

/**
 * Prompt text after dropping unambiguous supplied-context and negated-constraint clauses.
 *
 * Kind matchers still scan this text for their keywords anywhere.
 *
 * The filter applies only when at least one clause is recognised as an ask; otherwise the original prompt is scanned so an unrecognised clause cannot hide a HEAD match.
 *
 * @param prompt Lowercase trimmed prompt.
 * @returns Remaining request text, or the original prompt when no clause is recognised as an ask.
 */
function requestText(prompt: string): string {
  const kept = splitRequestClauses(prompt).filter(
    (clause) => !isNegatedConstraintClause(clause) && clauseHasRequest(clause)
  );
  return kept.length > 0 ? kept.join(' ') : prompt;
}

/**
 * True when the remaining request starts with an affirmative worker-execution verb.
 *
 * Later review, refine, retry, or handoff wording is then a constraint.
 *
 * Negated leading execution such as "do not implement" and "run it again" are not this seam.
 *
 * @param prompt Lowercase trimmed prompt.
 * @returns True when leading intent is worker execution.
 */
function hasAffirmativeLeadingExecution(prompt: string): boolean {
  return AFFIRMATIVE_LEADING_EXECUTION.test(stripRoutingPrefix(requestText(prompt)));
}

/**
 * True when the remaining request starts with a quick-chat verb such as summarize.
 *
 * A later review or handoff noun in the same clause does not override that kind.
 *
 * @param prompt Lowercase trimmed prompt.
 * @returns True when leading intent is a direct Assistant answer.
 */
function hasAffirmativeLeadingQuickChat(prompt: string): boolean {
  return AFFIRMATIVE_LEADING_QUICK_CHAT.test(stripRoutingPrefix(requestText(prompt)));
}

/**
 * Checks for review-mode prompts.
 *
 * @param prompt Lowercase prompt.
 * @returns True when review is the routing kind.
 */
function isReviewPrompt(prompt: string): boolean {
  const text = requestText(prompt);
  if (!text) {
    return false;
  }
  // Concrete PR review/approve/merge Tasks are worker execution, not human review-mode.
  if (
    isConcretePrWorkerPrompt(text) ||
    hasAffirmativeLeadingExecution(prompt) ||
    hasAffirmativeLeadingQuickChat(prompt)
  ) {
    return false;
  }
  return /\breview\b|\baudit\b|\bcheck\s+the\s+work\b/.test(text);
}

/**
 * Checks for refinement-mode prompts.
 *
 * @param prompt Lowercase prompt.
 * @returns True when refinement is the routing kind.
 */
function isRefinementPrompt(prompt: string): boolean {
  const text = requestText(prompt);
  return (
    Boolean(text) &&
    !hasAffirmativeLeadingExecution(prompt) &&
    !hasAffirmativeLeadingQuickChat(prompt) &&
    /\brefine\b|\biterate\b|\bmake\s+it\s+better\b|\bupdate\s+the\s+previous\b/.test(text)
  );
}

/**
 * Checks for retry-mode prompts.
 *
 * @param prompt Lowercase prompt.
 * @returns True when retry is the routing kind.
 */
function isRetryPrompt(prompt: string): boolean {
  const text = requestText(prompt);
  return (
    Boolean(text) &&
    !hasAffirmativeLeadingExecution(prompt) &&
    !hasAffirmativeLeadingQuickChat(prompt) &&
    /\bretry\b|\brerun\b|\btry\s+again\b|\brun\s+it\s+again\b/.test(text)
  );
}

/**
 * Checks for handoff-mode prompts.
 *
 * @param prompt Lowercase prompt.
 * @returns True when handoff is the routing kind.
 */
function isHandoffPrompt(prompt: string): boolean {
  const text = requestText(prompt);
  return (
    Boolean(text) &&
    !hasAffirmativeLeadingExecution(prompt) &&
    !hasAffirmativeLeadingQuickChat(prompt) &&
    /\bhandoff\b|\bhand\s+off\b|\bpass\s+to\b/.test(text)
  );
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
  const text = requestText(prompt);
  if (!text) {
    return false;
  }
  return (
    /\b(implement|fix|change|edit|write|create|delete|remove|run|test|build|commit|inspect|refactor|debug|merge|approve)\b/.test(
      text
    ) ||
    isConcretePrWorkerPrompt(text) ||
    /^use\s+the\s+(?!.*\?[.!]*$)\S/.test(text)
  );
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
