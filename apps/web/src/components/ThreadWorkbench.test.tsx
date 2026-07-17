import { PROTOCOL_VERSION } from '@openkit/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Item, ThreadGoalPlanReview, ThreadGoalSummary, TurnEvent } from '../lib/app-types';
import { reconcileTurnItems, ThreadWorkbench } from './ThreadWorkbench';

const baseItem = {
  id: 'it_user',
  workspaceId: 'ws_demo',
  threadId: 'th_demo',
  turnId: 'tu_demo',
  status: 'completed' as const,
  createdAt: '2026-04-15T09:00:00.000Z',
  completedAt: '2026-04-15T09:00:00.000Z',
};
const composerProps = {
  canQuickChat: true,
  composerMode: 'agent' as const,
  goal: null,
  goalPlan: null,
  goalPlanFeedback: null,
  goalExecutionFeedback: null,
  isApprovingGoalPlan: false,
  isCreatingGoalPlan: false,
  isRunningGoalStep: false,
  isStartingGoal: false,
  models: [{ id: 'model_codex', name: 'Codex', enabled: true }],
  quickChatDisabledMessage: 'Quick chat is not configured.',
  quickChatResponse: null,
  selectedModelId: 'model_codex',
  selectedWorkspaceId: 'ws_demo',
  workspaceName: 'Demo Workspace',
  onModelChange: () => undefined,
  onModeChange: () => undefined,
  onApproveGoalPlan: async () => undefined,
  onCreateGoalPlan: async () => undefined,
  onRejectGoalPlan: () => undefined,
  onReviseGoalPlan: () => undefined,
  onRunGoalStep: async () => undefined,
  onStartGoal: async () => undefined,
  onSubmitQuickChat: async () => undefined,
};
const workStatusProps = {
  currentMode: 'automation' as const,
  latestArtifact: null,
  pendingApprovalCount: 0,
  pendingQuestionCount: 0,
  routingExplanation:
    'NanoCore routes thread prompts through WorkerCoordinator to the selected worker agent because automation changes workspace state.',
  selectedAgentId: 'agent_codex_host',
  threadArtifacts: [],
  workerConnectionStatus: 'idle',
};

/**
 * Builds one turn stream event for component tests.
 */
function event(sequence: number, data: TurnEvent['data']): TurnEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    event:
      sequence === 1
        ? 'item.created'
        : data.type === 'item-delta'
          ? 'item.delta'
          : 'item.completed',
    requestId: '0190f4c8-0000-7000-8000-000000000401',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    turnId: 'tu_demo',
    sequence,
    data,
    timestamp: '2026-04-15T09:00:00.000Z',
  };
}

/**
 * Builds one Goal Mode summary fixture for workbench state tests.
 */
function goalFixture(
  status: ThreadGoalSummary['status'],
  overrides: Partial<ThreadGoalSummary> = {}
): ThreadGoalSummary {
  return {
    goalId: 'goal_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    status,
    title: 'Ship v0.0.6',
    objective: 'Make the release ready for end users.',
    currentTask: null,
    taskCounts: {
      pending: 0,
      ready: 0,
      running: 0,
      reviewing: 0,
      completed: 0,
      blocked: 0,
      failed: 0,
    },
    pendingHumanAttention: {
      required: false,
      reason: null,
    },
    terminalState: null,
    updatedAt: '2026-04-15T09:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ThreadWorkbench', () => {
  it('renders scripted stream items and reconciles completed snapshots', async () => {
    const [items, setItems] = createSignal<Item[]>([]);
    const completedAssistant: Item = {
      ...baseItem,
      id: 'it_assistant',
      type: 'assistant-message',
      text: 'Final assistant payload.',
    };
    const sequence = [
      event(1, {
        type: 'item-created',
        item: {
          ...baseItem,
          id: 'it_user',
          type: 'user-message',
          text: 'User prompt',
        },
      }),
      event(2, {
        type: 'item-created',
        item: {
          ...baseItem,
          id: 'it_assistant',
          status: 'in_progress',
          completedAt: null,
          type: 'assistant-message',
          text: '',
        },
      }),
      event(3, {
        type: 'item-delta',
        itemId: 'it_assistant',
        deltaKind: 'text-delta',
        delta: 'Streaming assistant payload.',
      }),
      event(4, {
        type: 'item-completed',
        itemId: 'it_assistant',
        item: completedAssistant,
      }),
      event(5, {
        type: 'item-created',
        item: {
          ...baseItem,
          id: 'it_reasoning',
          type: 'reasoning',
          summary: ['Reasoning summary'],
          content: ['Reasoning content'],
        },
      }),
      event(6, {
        type: 'item-created',
        item: {
          ...baseItem,
          id: 'it_command',
          type: 'command-execution',
          command: 'pnpm test',
          cwd: '/workspace',
          output: '',
          exitCode: 0,
          durationMs: 12,
        },
      }),
      event(7, {
        type: 'item-created',
        item: {
          ...baseItem,
          id: 'it_file',
          type: 'file-change',
          path: 'src/App.tsx',
          changeKind: 'modified',
        },
      }),
    ];

    render(() => (
      <ThreadWorkbench
        activeTurnStatus="idle"
        canInterrupt={false}
        canStartTurn={true}
        {...composerProps}
        {...workStatusProps}
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={items()}
        onInterrupt={async () => undefined}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => {
          for (const envelope of sequence) {
            setItems((current) => reconcileTurnItems(current, envelope));
          }
        }}
      />
    ));

    fireEvent.input(screen.getByLabelText(/turn prompt/i), {
      target: { value: 'Run the scripted stream' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send turn/i }));

    expect(await screen.findByText(/user prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/final assistant payload/i)).toBeInTheDocument();
    expect(screen.queryByText(/streaming assistant payload/i)).toBeNull();
    expect(screen.getByText(/reasoning summary/i)).toBeInTheDocument();
    expect(screen.getByText(/pnpm test/i)).toBeInTheDocument();
    expect(screen.getByText(/src\/app.tsx/i)).toBeInTheDocument();
  });

  it('ignores unknown forward-compatible item stream payloads', () => {
    const currentItems: Item[] = [
      {
        ...baseItem,
        id: 'it_assistant',
        type: 'assistant-message',
        text: 'Known assistant text.',
      },
    ];
    const unknownEvent: TurnEvent = {
      protocolVersion: PROTOCOL_VERSION,
      event: 'item.futureDelta',
      requestId: null,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      sequence: 99,
      data: {
        type: 'item-future-delta',
        deltaKind: 'semantic-patch',
        payload: { summary: 'Future additive stream payload.' },
      },
      timestamp: '2026-04-15T09:00:00.000Z',
    };

    expect(reconcileTurnItems(currentItems, unknownEvent)).toEqual(currentItems);
  });

  it('shows a local interrupting hint until the terminal turn state arrives', async () => {
    const [status, setStatus] = createSignal<'running' | 'interrupted'>('running');
    const [isInterrupting, setIsInterrupting] = createSignal(false);

    render(() => (
      <ThreadWorkbench
        activeTurnStatus={status()}
        canInterrupt={status() === 'running' && !isInterrupting()}
        canStartTurn={false}
        {...composerProps}
        {...workStatusProps}
        isAnsweringUserInput={false}
        isInterrupting={isInterrupting()}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[]}
        onInterrupt={async () => {
          setIsInterrupting(true);
        }}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: /stop turn/i }));

    expect(await screen.findByText(/interrupting/i)).toBeInTheDocument();

    setStatus('interrupted');
    setIsInterrupting(false);

    await waitFor(() => {
      expect(screen.getAllByText(/^interrupted$/i).length).toBeGreaterThan(0);
      expect(screen.queryByText(/interrupting/i)).toBeNull();
    });
  });

  it('renders command output deltas before completed snapshots replace them', async () => {
    const [items, setItems] = createSignal<Item[]>([]);
    const commandItem: Item = {
      ...baseItem,
      id: 'it_command',
      status: 'in_progress',
      completedAt: null,
      type: 'command-execution',
      command: 'pnpm test',
      cwd: '/workspace',
      output: '',
      exitCode: null,
      durationMs: null,
    };
    const completedCommandItem: Item = {
      ...commandItem,
      status: 'completed',
      completedAt: '2026-04-15T09:00:00.000Z',
      output: 'streaming chunk',
      exitCode: 0,
      durationMs: 42,
    };
    const sequence = [
      event(1, {
        type: 'item-created',
        item: commandItem,
      }),
      event(2, {
        type: 'item-delta',
        itemId: 'it_command',
        itemType: 'command-execution',
        deltaKind: 'output-delta',
        delta: 'streaming chunk',
      }),
      event(3, {
        type: 'item-completed',
        itemId: 'it_command',
        item: completedCommandItem,
      }),
    ];

    render(() => (
      <ThreadWorkbench
        activeTurnStatus="running"
        canInterrupt={false}
        canStartTurn={false}
        {...composerProps}
        {...workStatusProps}
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={items()}
        onInterrupt={async () => undefined}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    setItems((current) => reconcileTurnItems(current, sequence[0]));
    setItems((current) => reconcileTurnItems(current, sequence[1]));

    expect(screen.getByText(/streaming chunk/i)).toBeInTheDocument();
    expect(screen.queryByText(/exit 0/i)).toBeNull();

    setItems((current) => reconcileTurnItems(current, sequence[2]));

    await waitFor(() => {
      expect(screen.getByText(/streaming chunk/i)).toBeInTheDocument();
      expect(screen.getByText(/exit 0/i)).toBeInTheDocument();
    });
  });

  it('renders product work status and worker routing explanation', () => {
    render(() => (
      <ThreadWorkbench
        activeTurnStatus="awaiting_human"
        canInterrupt={false}
        canStartTurn={false}
        {...composerProps}
        currentMode="automation"
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[]}
        latestArtifact={{
          id: 'ar_latest',
          title: 'Latest release notes',
          status: 'ready',
          summary: 'Release notes are ready.',
          updatedAt: '2026-04-15T09:40:00.000Z',
        }}
        pendingApprovalCount={1}
        pendingQuestionCount={1}
        routingExplanation="NanoCore routes thread prompts through WorkerCoordinator to the selected worker agent because automation changes workspace state."
        selectedAgentId="agent_codex_host"
        threadArtifacts={[]}
        workerConnectionStatus="idle"
        onInterrupt={async () => undefined}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    expect(screen.getByRole('heading', { name: /work status/i })).toBeInTheDocument();
    expect(screen.getByText(/^automation$/i)).toBeInTheDocument();
    expect(screen.getByText(/agent_codex_host/i)).toBeInTheDocument();
    expect(screen.getByText(/1 approval/i)).toBeInTheDocument();
    expect(screen.getByText(/1 question/i)).toBeInTheDocument();
    expect(screen.getAllByText(/latest release notes/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/workercoordinator/i)).toBeInTheDocument();
  });

  it('renders quick chat routing separately from worker execution', () => {
    render(() => (
      <ThreadWorkbench
        activeTurnStatus="idle"
        canInterrupt={false}
        canStartTurn={true}
        {...composerProps}
        composerMode="quick"
        currentMode="chat"
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[]}
        latestArtifact={null}
        pendingApprovalCount={0}
        pendingQuestionCount={0}
        quickChatResponse="Quick answer from NanoCore."
        routingExplanation="NanoCore routed the prompt to QuickChatAgent for a lightweight answer without starting a worker turn."
        selectedAgentId="quick-chat"
        threadArtifacts={[]}
        workerConnectionStatus="idle"
        onInterrupt={async () => undefined}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    expect(screen.getByText(/^chat$/i)).toBeInTheDocument();
    expect(screen.getAllByText(/quick-chat/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/quickchatagent/i)).toBeInTheDocument();
    expect(screen.getByText(/without starting a worker turn/i)).toBeInTheDocument();
    expect(screen.getByText(/quick answer from nanocore/i)).toBeInTheDocument();
  });

  it.each([
    {
      goal: goalFixture('planning'),
      label: 'planning',
      text: /waiting for plan review/i,
    },
    {
      goal: goalFixture('running', {
        currentTask: {
          taskId: 'task_1',
          title: 'Run release smoke',
          status: 'running',
          orderIndex: 0,
        },
        taskCounts: {
          pending: 0,
          ready: 1,
          running: 1,
          reviewing: 0,
          completed: 2,
          blocked: 0,
          failed: 0,
        },
      }),
      label: 'running',
      text: /run release smoke/i,
    },
    {
      goal: goalFixture('awaiting_user', {
        pendingHumanAttention: {
          required: true,
          reason: 'Choose the release artifact to publish.',
        },
      }),
      label: 'awaiting-human',
      text: /choose the release artifact/i,
    },
    {
      goal: goalFixture('completed', {
        taskCounts: {
          pending: 0,
          ready: 0,
          running: 0,
          reviewing: 0,
          completed: 3,
          blocked: 0,
          failed: 0,
        },
        terminalState: {
          status: 'completed',
          stopReason: 'completed',
        },
      }),
      label: 'terminal',
      text: /finished with completed/i,
    },
  ])('renders Goal Mode $label progress state', ({ goal, text }) => {
    render(() => (
      <ThreadWorkbench
        activeTurnStatus="idle"
        canInterrupt={false}
        canStartTurn={true}
        {...composerProps}
        {...workStatusProps}
        goal={goal}
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[]}
        onInterrupt={async () => undefined}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    const goalMode = screen.getByRole('region', { name: /goal mode/i });

    expect(goalMode).toHaveTextContent(new RegExp(goal.status.replaceAll('_', ' '), 'i'));
    expect(goalMode).toHaveTextContent(/progress/i);
    expect(goalMode).toHaveTextContent(text);
  });

  it('does not expose Goal steering before worker delivery proof exists', () => {
    render(() => (
      <ThreadWorkbench
        activeTurnStatus="idle"
        canInterrupt={false}
        canStartTurn={true}
        {...composerProps}
        {...workStatusProps}
        goal={goalFixture('running', {})}
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[]}
        onInterrupt={async () => undefined}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    const goalMode = screen.getByRole('region', { name: /goal mode/i });

    expect(within(goalMode).queryByLabelText(/steering input/i)).not.toBeInTheDocument();
    expect(
      within(goalMode).queryByRole('button', { name: /submit steering/i })
    ).not.toBeInTheDocument();
  });

  it('renders completed Goal Mode terminal evidence and artifact links', () => {
    let openedArtifactId: string | null = null;

    render(() => (
      <ThreadWorkbench
        activeTurnStatus="idle"
        canInterrupt={false}
        canStartTurn={true}
        {...composerProps}
        {...workStatusProps}
        goal={goalFixture('completed', {
          terminalState: {
            status: 'completed',
            stopReason: 'completed',
          },
          terminalSummary: {
            completedTaskIds: ['task_1'],
            blockedTaskIds: [],
            artifactIds: ['artifact_release_log'],
            verificationEvidence: [
              {
                verificationId: 'verify_release',
                status: 'passed',
                summary: 'Release verification passed.',
                command: 'pnpm -w verify:release',
                artifactIds: ['artifact_release_log'],
              },
            ],
            risks: [],
            suggestedNextWork: ['Publish v0.0.6.'],
          },
        })}
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[]}
        threadArtifacts={[
          {
            id: 'artifact_release_log',
            title: 'Release verification log',
            status: 'ready',
            summary: 'Verification output.',
            updatedAt: '2026-04-15T09:00:00.000Z',
          },
        ]}
        onInterrupt={async () => undefined}
        onOpenArtifact={(artifactId) => {
          openedArtifactId = artifactId;
        }}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    const goalMode = screen.getByRole('region', { name: /goal mode/i });

    expect(goalMode).toHaveTextContent(/finished with completed/i);
    expect(goalMode).toHaveTextContent(/release verification passed/i);
    expect(goalMode).toHaveTextContent(/pnpm -w verify:release/i);
    expect(goalMode).toHaveTextContent(/publish v0.0.6/i);

    fireEvent.click(
      within(goalMode).getByRole('button', { name: /open release verification log/i })
    );

    expect(openedArtifactId).toBe('artifact_release_log');
  });

  it('renders failed Goal Mode terminal risks and blocked tasks', () => {
    render(() => (
      <ThreadWorkbench
        activeTurnStatus="idle"
        canInterrupt={false}
        canStartTurn={true}
        {...composerProps}
        {...workStatusProps}
        goal={goalFixture('failed', {
          terminalState: {
            status: 'failed',
            stopReason: 'error',
          },
          terminalSummary: {
            completedTaskIds: ['task_1'],
            blockedTaskIds: ['task_2'],
            artifactIds: [],
            verificationEvidence: [
              {
                verificationId: 'verify_failed',
                status: 'failed',
                summary: 'Release verification failed.',
                command: 'pnpm test',
                artifactIds: [],
              },
            ],
            risks: ['1 required task is blocked or failed.'],
            suggestedNextWork: ['Fix failing checks before publishing.'],
          },
        })}
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[]}
        onInterrupt={async () => undefined}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    const goalMode = screen.getByRole('region', { name: /goal mode/i });

    expect(goalMode).toHaveTextContent(/finished with failed/i);
    expect(goalMode).toHaveTextContent(/task_2/i);
    expect(goalMode).toHaveTextContent(/release verification failed/i);
    expect(goalMode).toHaveTextContent(/1 required task is blocked or failed/i);
    expect(goalMode).toHaveTextContent(/fix failing checks before publishing/i);
  });

  it('renders a Goal Mode plan and exposes approve, reject, and revise actions', async () => {
    const actions: string[] = [];
    const plan: ThreadGoalPlanReview['plan'] = {
      schemaVersion: 1,
      goalSummary: 'Make the release ready for end users.',
      assumptions: ['The release can be verified locally.'],
      tasks: [
        {
          taskId: 'task_1',
          title: 'Verify release',
          objective: 'Run the release checks.',
          acceptanceCriteria: ['Release checks pass.'],
          contextBudgetTokens: 12_000,
          resources: [],
          expectedArtifacts: [
            {
              kind: 'test-result',
              description: 'Release verification result.',
            },
          ],
          verificationChecks: [
            {
              kind: 'test',
              description: 'Run the release smoke suite.',
            },
          ],
          reviewPolicy: {
            required: true,
            reviewers: ['human'],
            instructions: 'Review the smoke result.',
          },
          dependsOnTaskIds: [],
          escalationConditions: [],
        },
      ],
      risks: [],
      questions: ['Which release artifact should be published first?'],
      verificationApproach: 'Run deterministic release checks.',
    };

    render(() => (
      <ThreadWorkbench
        activeTurnStatus="idle"
        canInterrupt={false}
        canStartTurn={true}
        {...composerProps}
        {...workStatusProps}
        goal={{
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'awaiting_plan_approval',
          title: 'Ship v0.0.6',
          objective: 'Make the release ready for end users.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 0,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: true,
            reason: 'Plan approval is required.',
          },
          terminalState: null,
          updatedAt: '2026-04-15T09:00:00.000Z',
        }}
        goalPlan={{
          status: 'awaiting_plan_approval',
          planItemId: 'it_plan_demo',
          goal: {
            goalId: 'goal_demo',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            status: 'awaiting_plan_approval',
            title: 'Ship v0.0.6',
            objective: 'Make the release ready for end users.',
            currentTask: null,
            taskCounts: {
              pending: 0,
              ready: 0,
              running: 0,
              reviewing: 0,
              completed: 0,
              blocked: 0,
              failed: 0,
            },
            pendingHumanAttention: {
              required: true,
              reason: 'Plan approval is required.',
            },
            terminalState: null,
            updatedAt: '2026-04-15T09:00:00.000Z',
          },
          planner: {
            mode: 'goal',
            sourceAgentId: 'worker-coordinator',
            confidence: 0.84,
            rationale: 'Worker Coordinator drafted a reviewable Goal Mode plan.',
            contextRefs: [
              { kind: 'workspace', id: 'ws_demo' },
              { kind: 'thread', id: 'th_demo' },
            ],
            requiredApprovals: ['plan_approval'],
            plan,
          },
          plan,
        }}
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[]}
        onApproveGoalPlan={async () => {
          actions.push('approve');
        }}
        onInterrupt={async () => undefined}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRejectGoalPlan={() => actions.push('reject')}
        onRespondApproval={async () => undefined}
        onReviseGoalPlan={(revision?: string) => actions.push(`revise:${revision}`)}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    const planReview = screen.getByRole('region', { name: /goal plan review/i });

    expect(planReview).toHaveTextContent(/the release can be verified locally/i);
    expect(planReview).toHaveTextContent(/verify release/i);
    expect(planReview).toHaveTextContent(/which release artifact should be published first/i);

    const revision = within(planReview).getByRole('textbox', {
      name: /requested plan changes/i,
    });
    const requestChanges = within(planReview).getByRole('button', {
      name: /request changes/i,
    });

    expect(requestChanges).toBeDisabled();
    fireEvent.input(revision, { target: { value: '  Reduce the release scope.  ' } });
    expect(requestChanges).toBeEnabled();

    fireEvent.click(within(planReview).getByRole('button', { name: /approve plan/i }));
    fireEvent.click(within(planReview).getByRole('button', { name: /reject plan/i }));
    fireEvent.click(requestChanges);

    await waitFor(() => {
      expect(actions).toEqual(['approve', 'reject', 'revise:Reduce the release scope.']);
    });
  });

  it('renders artifact summaries and opens current thread artifacts', () => {
    let openedArtifactId: string | null = null;

    render(() => (
      <ThreadWorkbench
        activeTurnStatus="completed"
        canInterrupt={false}
        canStartTurn={true}
        {...composerProps}
        {...workStatusProps}
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[]}
        latestArtifact={{
          id: 'ar_review',
          title: 'Review artifact',
          status: 'ready',
          summary: 'A current thread artifact summary.',
          updatedAt: '2026-04-15T09:50:00.000Z',
        }}
        threadArtifacts={[
          {
            id: 'ar_review',
            title: 'Review artifact',
            status: 'ready',
            summary: 'A current thread artifact summary.',
            updatedAt: '2026-04-15T09:50:00.000Z',
          },
        ]}
        onInterrupt={async () => undefined}
        onOpenArtifact={(artifactId) => {
          openedArtifactId = artifactId;
        }}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    expect(screen.getByRole('heading', { name: /artifacts/i })).toBeInTheDocument();
    expect(screen.getByText(/a current thread artifact summary/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open review artifact/i }));

    expect(openedArtifactId).toBe('ar_review');
  });

  it('groups approvals and questions as attention-needed work', () => {
    const approvalItem: Item = {
      ...baseItem,
      id: 'it_attention_approval',
      type: 'approval-request',
      status: 'in_progress',
      completedAt: null,
      approvalRequestId: 'ap_attention',
      title: 'Approve package update',
      description: 'The worker wants to update dependencies.',
      kind: 'permission',
    };
    const questionItem: Item = {
      ...baseItem,
      id: 'it_attention_question',
      type: 'user-input-request',
      status: 'in_progress',
      completedAt: null,
      userInputRequestId: 'ui_attention',
      prompt: 'Choose release scope.',
      questions: [
        {
          id: 'scope',
          header: 'Scope',
          question: 'Which scope should continue?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
    };

    render(() => (
      <ThreadWorkbench
        activeTurnStatus="awaiting_human"
        canInterrupt={false}
        canStartTurn={false}
        {...composerProps}
        {...workStatusProps}
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[approvalItem, questionItem]}
        pendingApprovalCount={1}
        pendingQuestionCount={1}
        onInterrupt={async () => undefined}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    const attention = screen.getByRole('region', { name: /attention needed/i });

    expect(attention).toHaveTextContent(/approve package update/i);
    expect(attention).toHaveTextContent(/choose release scope/i);
  });

  it('shows next actions for terminal turns and disconnected workers', () => {
    render(() => (
      <ThreadWorkbench
        activeTurnStatus="interrupted"
        canInterrupt={false}
        canStartTurn={true}
        {...composerProps}
        {...workStatusProps}
        isAnsweringUserInput={false}
        isInterrupting={false}
        isRespondingToApproval={false}
        isStartingTurn={false}
        items={[]}
        workerConnectionStatus="failed"
        onInterrupt={async () => undefined}
        onOpenArtifact={() => undefined}
        onOpenItemLog={() => undefined}
        onRespondApproval={async () => undefined}
        onSubmitUserInput={async () => undefined}
        onSubmitTurn={async () => undefined}
      />
    ));

    expect(screen.getAllByText(/start a follow-up turn/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/worker connection needs attention/i).length).toBeGreaterThan(0);
  });
});
