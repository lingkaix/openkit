import { describe, expect, it } from 'vitest';

import {
  createWorkerCoordinatorDecision,
  createWorkerCoordinatorGoalPlanDraft,
  createWorkerCoordinatorGoalStopDecision,
  projectWorkerCoordinatorGoalPlanDraft,
} from './worker-coordinator.js';

const READY_CODEX = {
  agentId: 'agent_codex',
  displayName: 'Codex',
  readiness: 'ready' as const,
};

const READY_OPENCODE = {
  agentId: 'agent_opencode',
  displayName: 'OpenCode',
  readiness: 'ready' as const,
};

describe('WorkerCoordinatorAgent routing decisions', () => {
  it.each([
    { agentId: 'agent_pi', displayName: 'Pi Agent' },
    { agentId: 'agent_fourth_runtime', displayName: 'Fourth Runtime Agent' },
  ])('selects opaque ready agent $agentId without runtime-name routing', (candidate) => {
    const readyCandidate = { ...candidate, readiness: 'ready' as const };
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Use Codex naming in this prompt, but implement the focused fix.',
      readiness: [readyCandidate],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision.selectedWorkerCandidate).toEqual(readyCandidate);
    expect(decision.delegationDraft?.target).toEqual({
      agentId: candidate.agentId,
      displayName: candidate.displayName,
    });
  });

  it('selects Codex for ordinary coding worker tasks', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Implement the failing quick chat test and run the focused suite.',
      readiness: [READY_CODEX, READY_OPENCODE],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'worker_turn',
      requiredUserAction: 'none',
      selectedWorkerCandidate: {
        agentId: 'agent_codex',
      },
    });
    expect(decision.confidence).toBeGreaterThan(0.7);
  });

  it.each([
    { prompt: 'Use the exact queued second release revision.', delegates: true },
    { prompt: 'What should I use?', delegates: false },
    { prompt: 'I use this revision every day.', delegates: false },
    { prompt: 'Use it.', delegates: false },
    { prompt: 'Use was limited in the last release.', delegates: false },
    { prompt: 'Use of this revision is common.', delegates: false },
    { prompt: 'Use it now.', delegates: false },
    { prompt: 'Use is widespread.', delegates: false },
    { prompt: 'Use remains limited.', delegates: false },
    { prompt: 'Use cases are documented.', delegates: false },
    { prompt: 'Use this code?', delegates: false },
    { prompt: 'Use the file?', delegates: false },
    { prompt: 'Use this now.', delegates: false },
    { prompt: 'Use that now.', delegates: false },
    { prompt: 'Use these now.', delegates: false },
    { prompt: 'Use this code?!', delegates: false },
    { prompt: 'Use the file?!', delegates: false },
    { prompt: 'Use the code?!', delegates: false },
  ])('routes concrete use intent without treating every use as work: $prompt', ({
    delegates,
    prompt,
  }) => {
    const decision = createWorkerCoordinatorDecision({
      prompt,
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    if (!delegates) {
      expect(decision.decision).not.toBe('worker_turn');
      expect(decision).toMatchObject({
        selectedWorkerCandidate: null,
        delegationDraft: null,
        workerRequest: null,
      });
      return;
    }

    expect(decision).toMatchObject({
      decision: 'worker_turn',
      requiredUserAction: 'none',
      selectedWorkerCandidate: READY_CODEX,
    });
    expect(decision.delegationDraft?.prompt).toBe(prompt);
    expect(decision.workerRequest?.objective).toBe(prompt);
  });

  it('routes mutating repository file requests to a worker turn', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Delete repository file README.md.',
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'worker_turn',
      requiredUserAction: 'none',
      selectedWorkerCandidate: {
        agentId: 'agent_codex',
      },
    });
  });

  it('creates a stable app-level worker delegation draft without a sustained loop', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Implement the release dashboard and run focused tests.',
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision.delegationDraft).toMatchObject({
      schemaVersion: 1,
      source: 'worker-coordinator',
      mode: 'automation',
      prompt: 'Implement the release dashboard and run focused tests.',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      target: {
        agentId: 'agent_codex',
      },
      constraints: {
        maxWorkerIterations: 1,
      },
      contextRefs: [
        { kind: 'workspace', id: 'ws_demo' },
        { kind: 'thread', id: 'th_demo' },
      ],
    });
    expect(decision.delegationDraft).not.toHaveProperty('runMode');
    expect(decision.delegationDraft).not.toHaveProperty('iterationLoop');
  });

  it('emits a structured worker request for Codex worker turns', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Implement the release dashboard and run focused tests.',
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision.workerRequest).toEqual({
      schemaVersion: 1,
      objective: 'Implement the release dashboard and run focused tests.',
      acceptanceCriteria: [
        'The bounded worker task satisfies the requested objective.',
        'The worker reports verification evidence or a clear blocker.',
      ],
      contextRefs: [
        { kind: 'workspace', id: 'ws_demo' },
        { kind: 'thread', id: 'th_demo' },
      ],
      resources: [],
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
      },
      verification: [
        {
          kind: 'manual',
          description: 'Run the checks named by the worker task or explain why they cannot run.',
        },
      ],
      reviewPolicy: {
        required: false,
        reviewers: ['human'],
        instructions: 'Review the worker result, changed files, and verification evidence.',
      },
      escalationConditions: [
        'Escalate if repository setup is missing or invalid.',
        'Escalate if the task requires broader decomposition.',
      ],
      reviewContext: null,
    });
  });

  it('drafts one complete deterministic Goal Plan for review', () => {
    const input = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      goalId: 'goal_demo',
      title: 'Ship release',
      objective: 'Make the next release ready.',
    };
    const draft = createWorkerCoordinatorGoalPlanDraft(input);

    expect(draft).toMatchObject({
      mode: 'goal',
      sourceAgentId: 'worker-coordinator',
      requiredApprovals: ['plan_approval'],
      plan: {
        schemaVersion: 1,
        goalSummary: 'Make the next release ready.',
        tasks: [
          {
            taskId: 'task_1',
            title: 'Ship release',
            objective: 'Make the next release ready.',
          },
        ],
        questions: [],
      },
    });
    const storedPlan = { ...draft.plan, risks: ['Preserve the immutable Plan on replay.'] };
    expect(projectWorkerCoordinatorGoalPlanDraft(input, storedPlan).plan).toBe(storedPlan);
  });

  it('keeps candidate order when the prompt names a runtime', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Use OpenCode to inspect the project and propose the smallest fix.',
      readiness: [READY_CODEX, READY_OPENCODE],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'worker_turn',
      requiredUserAction: 'none',
      selectedWorkerCandidate: {
        agentId: 'agent_codex',
      },
    });
  });

  it('falls back to quick chat for simple questions', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'What is NanoCore?',
      readiness: [READY_CODEX, READY_OPENCODE],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'quick_chat',
      requiredUserAction: 'none',
      selectedWorkerCandidate: null,
    });
  });

  it('classifies vague requests as clarify', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Help.',
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'clarify',
      requiredUserAction: 'refine_request',
      selectedWorkerCandidate: null,
      workerRequest: null,
    });
  });

  it('returns unsupported for unsafe or out-of-scope requests', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Deploy to production, rotate credentials, and charge the customer card.',
      readiness: [READY_CODEX, READY_OPENCODE],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'unsupported',
      requiredUserAction: 'refine_request',
      selectedWorkerCandidate: null,
      workerRequest: null,
    });
  });

  it('returns blocked when worker execution is needed but no worker is ready', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Implement the focused fix.',
      readiness: [],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'blocked',
      requiredUserAction: 'refine_request',
      selectedWorkerCandidate: null,
      workerRequest: null,
    });
  });

  it('classifies retry requests without selecting a new worker turn', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Retry the previous worker turn.',
      readiness: [READY_CODEX],
      threadState: { status: 'failed', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'retry',
      requiredUserAction: 'confirm_worker_turn',
      selectedWorkerCandidate: null,
      workerRequest: null,
    });
  });

  it('classifies Goal Mode planning requests without selecting a worker turn', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Plan a multi-step release goal for NanoCore.',
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'goal',
      explanation: 'The request needs explicit Goal Mode planning before worker execution.',
      requiredUserAction: 'review_ready',
      selectedWorkerCandidate: null,
      workerRequest: null,
    });
  });

  it.each([
    'Run Goal Mode step: Plan a release checklist.',
    'Run Goal Mode step: Review the current implementation.',
    'Run Goal Mode step: Refine the current implementation.',
    'Run Goal Mode step: Hand off findings into a document.',
    'Run Goal Mode step: Retry the focused verification.',
    '  Run Goal Mode step: Implement the accepted task.\n',
  ])('does not reclassify an approved Goal Mode step prompt: %s', (prompt) => {
    const decision = createWorkerCoordinatorDecision({
      prompt,
      readiness: [READY_CODEX],
      routingContext: 'goal_step',
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'worker_turn',
      selectedWorkerCandidate: {
        agentId: 'agent_codex',
      },
    });
    expect(decision.workerRequest?.objective).toBe(prompt);
  });

  it.each([
    {
      prompt: 'Review the previous worker output.',
      decision: 'review',
      requiredUserAction: 'review_ready',
      explanation: 'The request is asking to evaluate recent work rather than start new execution.',
    },
    {
      prompt: 'Refine the previous result.',
      decision: 'refinement',
      requiredUserAction: 'confirm_worker_turn',
      explanation: 'The request appears to refine prior output in the current thread.',
    },
    {
      prompt: 'Hand off this work to another worker.',
      decision: 'handoff',
      requiredUserAction: 'choose_worker',
      explanation: 'The request asks to hand work to another worker or phase.',
    },
  ] as const)('classifies $decision requests without selecting a worker turn', ({
    decision,
    explanation,
    prompt,
    requiredUserAction,
  }) => {
    const routing = createWorkerCoordinatorDecision({
      prompt,
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(routing).toMatchObject({
      decision,
      explanation,
      requiredUserAction,
      selectedWorkerCandidate: null,
      workerRequest: null,
    });
  });

  it('creates evidence-backed Goal Mode stop decisions', () => {
    const decision = createWorkerCoordinatorGoalStopDecision({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      requestId: 'req_goal_step',
      goalId: 'goal_demo',
      taskId: 'task_demo',
      turnId: 'turn_worker',
      stopDecision: {
        outcome: 'review',
        shouldStop: true,
        stopReason: 'completed',
      },
      hasOtherIncompleteTasksAfterAddressedTaskCompletion: false,
      evidence: {
        itemIds: ['it_worker_terminal'],
        artifactIds: ['artifact_release_log'],
      },
    });

    expect(decision).toEqual({
      schemaVersion: 1,
      mode: 'goal',
      sourceAgentId: 'worker-coordinator',
      requestId: 'req_goal_step',
      outcome: 'review',
      shouldStop: true,
      stopReason: 'completed',
      rationale: 'Worker turn completed and needs human review before Goal Mode continues.',
      contextRefs: [
        { kind: 'workspace', id: 'ws_demo' },
        { kind: 'thread', id: 'th_demo' },
      ],
      evidence: {
        itemIds: ['it_worker_terminal'],
        artifactIds: ['artifact_release_log'],
      },
    });
  });

  it('decides Goal continuation from pre-mutation task state', () => {
    const input = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      requestId: 'req_goal_step',
      goalId: 'goal_demo',
      taskId: 'task_demo',
      turnId: 'turn_worker',
      stopDecision: {
        outcome: 'complete' as const,
        shouldStop: true,
        stopReason: 'completed' as const,
      },
      evidence: { itemIds: [], artifactIds: [] },
    };

    expect(
      createWorkerCoordinatorGoalStopDecision({
        ...input,
        hasOtherIncompleteTasksAfterAddressedTaskCompletion: true,
      })
    ).toMatchObject({ outcome: 'continue', shouldStop: false });
    expect(
      createWorkerCoordinatorGoalStopDecision({
        ...input,
        hasOtherIncompleteTasksAfterAddressedTaskCompletion: false,
      })
    ).toMatchObject({ outcome: 'complete', shouldStop: true });
    expect(() =>
      createWorkerCoordinatorGoalStopDecision({
        ...input,
        hasOtherIncompleteTasksAfterAddressedTaskCompletion: true,
        stopDecision: { outcome: 'continue', shouldStop: false, stopReason: 'length' },
      })
    ).toThrow('lower-level continue');
  });
});
