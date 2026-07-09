import { describe, expect, it } from 'vitest';

import {
  createDelegationPreparationSnapshot,
  createStructuredWorkerDelegationRequest,
  createTaskEvaluationNote,
  createWorkerRoutingDecisionSummary,
  DELEGATION_COMPOSITION_PHASES,
  SUSTAINED_MODE_SOURCE_SPEC,
} from './delegation.js';
import { createWorkerCoordinatorDecision } from './worker-coordinator.js';

const READY_CODEX = {
  agentId: 'agent_codex',
  displayName: 'Codex',
  readiness: 'ready' as const,
  runtime: 'codex' as const,
};

describe('delegation preparation hooks', () => {
  it('creates a read-model-backed routing summary from a worker coordinator decision', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Implement the focused release closeout checks.',
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    const summary = createWorkerRoutingDecisionSummary(decision, 'read_model');

    expect(summary).toMatchObject({
      schemaVersion: 1,
      recordKind: 'read_model',
      decision: 'worker_turn',
      selectedAgentId: 'agent_codex',
      sourceAgentId: 'worker-coordinator',
      delegationDraft: {
        schemaVersion: 1,
        source: 'worker-coordinator',
      },
    });
  });

  it('preserves Goal Mode routing decisions in summaries', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Plan a multi-step release goal for NanoCore.',
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    expect(createWorkerRoutingDecisionSummary(decision, 'read_model')).toMatchObject({
      decision: 'goal',
      selectedAgentId: null,
      requiredUserAction: 'review_ready',
      delegationDraft: null,
    });
  });

  it('describes future delegation as a composition without enabling the sustained loop', () => {
    const decision = createWorkerCoordinatorDecision({
      prompt: 'Implement the focused release closeout checks.',
      readiness: [READY_CODEX],
      threadState: { status: 'idle', threadId: 'th_demo' },
      workspaceSummary: { name: 'OpenKit', workspaceId: 'ws_demo' },
    });

    const snapshot = createDelegationPreparationSnapshot(decision);

    expect(DELEGATION_COMPOSITION_PHASES).toEqual([
      'planning',
      'worker_execution',
      'review',
      'handoff',
      'knowledge_proposal',
      'progress_tracking',
    ]);
    expect(snapshot).toMatchObject({
      mode: 'delegation',
      fullLoopEnabled: false,
      sourceSpec: SUSTAINED_MODE_SOURCE_SPEC,
      compositionPhases: DELEGATION_COMPOSITION_PHASES,
      routingSummary: {
        recordKind: 'read_model',
        decision: 'worker_turn',
      },
    });
  });

  it('reserves a task evaluation note shape for later review mode work', () => {
    const note = createTaskEvaluationNote({
      evidenceRefs: [{ kind: 'artifact', id: 'ar_review' }],
      recommendedNextAction: 'Ask the worker to revise failing tests.',
      summary: 'The artifact is useful but still has failing tests.',
    });

    expect(note).toEqual({
      schemaVersion: 1,
      sourceAgentId: 'task-evaluator',
      status: 'reserved',
      outcome: 'revise',
      summary: 'The artifact is useful but still has failing tests.',
      evidenceRefs: [{ kind: 'artifact', id: 'ar_review' }],
      recommendedNextAction: 'Ask the worker to revise failing tests.',
    });
  });

  it('creates a structured app-local worker delegation request', () => {
    const request = createStructuredWorkerDelegationRequest({
      objective: 'Fix the failing projection test.',
      acceptanceCriteria: ['The focused test passes.', 'No unrelated files are changed.'],
      contextRefs: [
        { kind: 'workspace', id: 'ws_demo' },
        { kind: 'thread', id: 'th_demo' },
      ],
      expectedArtifacts: [
        {
          kind: 'code-change',
          description: 'Patch implementing the projection fix.',
        },
      ],
      constraints: {
        maxContextTokens: 12_000,
        maxWorkerIterations: 1,
        requiresUserConfirmation: true,
        stopConditions: ['Stop if repository setup is invalid.'],
      },
      verification: [
        {
          kind: 'command',
          description: 'Run the focused projection test.',
          command:
            'pnpm --filter @openkit/nanocore exec vitest run src/context/llm-projection.test.ts',
        },
      ],
      reviewPolicy: {
        required: true,
        reviewers: ['human', 'internal'],
        instructions: 'Review the diff and test output before continuing.',
      },
    });

    expect(request).toMatchObject({
      schemaVersion: 1,
      objective: 'Fix the failing projection test.',
      acceptanceCriteria: ['The focused test passes.', 'No unrelated files are changed.'],
      constraints: {
        maxContextTokens: 12_000,
        maxWorkerIterations: 1,
        requiresUserConfirmation: true,
      },
      reviewPolicy: {
        required: true,
        reviewers: ['human', 'internal'],
      },
    });
  });

  it('rejects malformed or oversized structured worker delegation requests', () => {
    expect(() =>
      createStructuredWorkerDelegationRequest({
        objective: 'x',
        acceptanceCriteria: [],
        contextRefs: [{ kind: 'workspace', id: 'ws_demo' }],
        expectedArtifacts: [],
        constraints: {
          maxContextTokens: 240_001,
          maxWorkerIterations: 1,
          requiresUserConfirmation: true,
          stopConditions: [],
        },
        verification: [],
        reviewPolicy: {
          required: true,
          reviewers: [],
          instructions: 'Review the work.',
        },
      })
    ).toThrow();
  });
});
