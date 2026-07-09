import { describe, expect, it } from 'vitest';

import {
  createWorkerCoordinatorDecision,
  createWorkerCoordinatorGoalStopDecision,
  WORKER_COORDINATOR_AGENT_DEFINITION,
} from './worker-coordinator.js';

const READY_CODEX = {
  agentId: 'agent_codex',
  displayName: 'Codex',
  readiness: 'ready' as const,
  runtime: 'codex' as const,
};

const READY_OPENCODE = {
  agentId: 'agent_opencode',
  displayName: 'OpenCode',
  readiness: 'ready' as const,
  runtime: 'opencode' as const,
};

describe('WorkerCoordinatorAgent routing decisions', () => {
  it('selects Codex for ordinary coding worker tasks', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Implement the failing quick chat test and run the focused suite.',
      readiness: [READY_CODEX, READY_OPENCODE],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'worker_turn',
      requiredUserAction: 'confirm_worker_turn',
      selectedWorkerCandidate: {
        agentId: 'agent_codex',
        runtime: 'codex',
      },
    });
    expect(decision.confidence).toBeGreaterThan(0.7);
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
      requiredUserAction: 'confirm_worker_turn',
      selectedWorkerCandidate: {
        agentId: 'agent_codex',
        runtime: 'codex',
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
        runtime: 'codex',
      },
      constraints: {
        maxWorkerIterations: 1,
        requiresUserConfirmation: true,
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

    expect(decision.workerRequest).toMatchObject({
      schemaVersion: 1,
      objective: 'Implement the release dashboard and run focused tests.',
      acceptanceCriteria: expect.arrayContaining([
        'The bounded worker task satisfies the requested objective.',
      ]),
      contextRefs: [
        { kind: 'workspace', id: 'ws_demo' },
        { kind: 'thread', id: 'th_demo' },
      ],
      constraints: {
        maxWorkerIterations: 1,
        requiresUserConfirmation: true,
      },
      reviewPolicy: {
        required: true,
        reviewers: ['human'],
      },
    });
  });

  it('selects OpenCode when the user explicitly asks for OpenCode', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Use OpenCode to inspect the project and propose the smallest fix.',
      readiness: [READY_CODEX, READY_OPENCODE],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision).toMatchObject({
      decision: 'worker_turn',
      requiredUserAction: 'confirm_worker_turn',
      selectedWorkerCandidate: {
        agentId: 'agent_opencode',
        runtime: 'opencode',
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
        runtime: 'codex',
      },
    });
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

  it('exposes only readiness, thread, workspace, and delegation-draft tools', () => {
    expect(WORKER_COORDINATOR_AGENT_DEFINITION).toMatchObject({
      id: 'worker-coordinator',
      category: 'routing',
      defaultProviderUse: 'internalTasks',
      allowedTools: [
        'readWorkspaceSummary',
        'readThreadSummary',
        'readAgentReadiness',
        'draftWorkerDelegation',
      ],
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
});
