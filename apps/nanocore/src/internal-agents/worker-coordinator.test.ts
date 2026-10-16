import { describe, expect, it } from 'vitest';

import { createWorkerCoordinatorDecision } from './worker-coordinator.js';

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

describe('Worker Coordinator explicit selection', () => {
  it.each([
    { agentId: 'agent_pi', displayName: 'Pi Agent' },
    { agentId: 'agent_fourth_runtime', displayName: 'Fourth Runtime Agent' },
  ])('selects opaque ready agent $agentId without runtime-name routing', (candidate) => {
    const readyCandidate = { ...candidate, readiness: 'ready' as const };
    const decision = createWorkerCoordinatorDecision({
      entryIntent: 'explicit_task',
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
      entryIntent: 'explicit_task',
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

  it('creates a stable app-level worker delegation draft without a sustained loop', () => {
    const decision = createWorkerCoordinatorDecision({
      entryIntent: 'explicit_task',
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
      entryIntent: 'explicit_task',
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
          kind: 'artifact',
          description:
            'The outputs the objective requires, such as changed files, documents or submitted Artifacts.',
        },
      ],
      constraints: {
        maxContextTokens: 240_000,
        maxWorkerIterations: 1,
      },
      verification: [
        {
          kind: 'manual',
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
    });
  });

  it('emits domain-neutral defaults for a non-software direct Task', () => {
    const prompt =
      'Collect the March supplier invoices into one summary table and list any invoice missing a tax number.';
    const decision = createWorkerCoordinatorDecision({
      entryIntent: 'explicit_task',
      prompt,
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(decision.decision).toBe('worker_turn');
    expect(decision.workerRequest).toEqual({
      schemaVersion: 1,
      objective: prompt,
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
          kind: 'artifact',
          description:
            'The outputs the objective requires, such as changed files, documents or submitted Artifacts.',
        },
      ],
      constraints: {
        maxContextTokens: 240_000,
        maxWorkerIterations: 1,
      },
      verification: [
        {
          kind: 'manual',
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
    });
  });

  it('keeps candidate order when the prompt names a runtime', () => {
    const decision = createWorkerCoordinatorDecision({
      entryIntent: 'explicit_task',
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

  it('returns blocked when worker execution is needed but no worker is ready', () => {
    const decision = createWorkerCoordinatorDecision({
      entryIntent: 'explicit_task',
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
});

describe('explicit Task delegation', () => {
  it.each([
    'Read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title.',
    'Could you read issue 110 of lingkaix/openkit with the github MCP tools and reply with its title?',
    'Help.',
    'What is OpenKit?',
    'Plan a multi-step release goal for NanoCore.',
    'Review the previous worker output.',
    'Refine the previous result.',
    'Retry the previous worker turn.',
    'Hand off this work to another worker.',
    'Read issue 110. Do not deploy to production.',
    'Deploy to production, rotate credentials, and charge the customer card.',
  ])('preserves selected Task intent and exact objective: %s', (prompt) => {
    const decision = createWorkerCoordinatorDecision({
      entryIntent: 'explicit_task',
      prompt,
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });
    expect(decision).toMatchObject({
      decision: 'worker_turn',
      selectedWorkerCandidate: READY_CODEX,
      requiredUserAction: 'none',
      workerRequest: { objective: prompt, constraints: { maxWorkerIterations: 1 } },
      delegationDraft: { prompt },
    });
  });

  it('blocks explicit delegation without eligible supply', () => {
    const decision = createWorkerCoordinatorDecision({
      entryIntent: 'explicit_task',
      prompt: 'Help.',
      readiness: [{ ...READY_CODEX, readiness: 'blocked' }],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });
    expect(decision).toMatchObject({
      decision: 'blocked',
      selectedWorkerCandidate: null,
      workerRequest: null,
      delegationDraft: null,
    });
  });
});
