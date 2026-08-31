import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { STATUS_CLASS } from '../../primitives';
import { workspaceKeys } from '../workspace/data';
import { useWorkspaceStore } from '../workspace-store';
import { goalKeys } from './data';

const TIMESTAMP = '2026-07-21T00:00:00.000Z';

const GOAL_BASE = {
  goalId: 'goal1',
  workspaceId: 'ws1',
  threadId: 'th1',
  title: 'Ship release',
  objective: 'Make v0.0.6 ready.',
  currentTask: {
    taskId: 'task_demo',
    title: 'Run verification',
    status: 'running',
    orderIndex: 1,
  },
  taskCounts: {
    pending: 1,
    ready: 0,
    running: 1,
    reviewing: 0,
    completed: 2,
    blocked: 0,
    failed: 0,
  },
  pendingHumanAttention: { required: false, reason: null },
  terminalState: null,
  updatedAt: TIMESTAMP,
};

const PLAN = {
  schemaVersion: 1 as const,
  goalSummary: 'Make v0.0.6 ready.',
  assumptions: ['The goal can be attempted as one bounded worker task.'],
  tasks: [
    {
      taskId: 'task_1',
      title: 'Ship release',
      objective: 'Make v0.0.6 ready.',
      acceptanceCriteria: ['The requested objective is implemented and verified.'],
      contextBudgetTokens: 12_000,
      resources: [
        {
          kind: 'repository',
          reference: 'linked workspace repository',
          reason: 'Default workspace context for the bounded worker task.',
        },
      ],
      expectedArtifacts: [
        { kind: 'artifact', description: 'Worker result summary and implementation evidence.' },
      ],
      verificationChecks: [
        {
          kind: 'manual',
          description: 'Review the worker output and confirm the objective is satisfied.',
        },
      ],
      reviewPolicy: {
        required: true,
        reviewers: ['human'],
        instructions: 'Review deterministic fallback output before continuing Goal Mode.',
      },
      dependsOnTaskIds: [],
      escalationConditions: ['Escalate if the objective needs decomposition into multiple tasks.'],
    },
  ],
  risks: [],
  questions: [],
  verificationApproach: 'Review worker output.',
};

const ARTIFACT = {
  id: 'artifact1',
  workspaceId: 'ws1',
  threadId: 'th1',
  turnId: 'turn1',
  kind: 'report',
  title: 'Release notes draft',
  status: 'ready',
  summary: 'Draft release notes.',
  version: 1,
  content: { format: 'markdown', body: '# Release notes' },
  contentDigest: `sha256:${'a'.repeat(64)}`,
  lastMutationRequestId: 'req_artifact',
  origin: {
    kind: 'turn-output',
    threadId: 'th1',
    turnId: 'turn1',
    requestId: 'req_artifact',
  },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const REVIEW = {
  workspaceId: 'ws1',
  reviewId: 'review1',
  artifactId: 'artifact1',
  artifactVersion: 1,
  contentDigest: ARTIFACT.contentDigest,
  sourceThreadId: 'th1',
  sourceTurnId: 'turn1',
  sourceAgentId: 'agent1',
  materialProposal: null,
  decision: null,
  decisionActorId: null,
  feedback: null,
  decidedAt: null,
  followUpTurnId: null,
  appliedMaterialRevisionId: null,
  createdAt: TIMESTAMP,
};

const PROPOSAL_ARTIFACT = {
  ...ARTIFACT,
  title: 'Worker release-notes proposal',
  content: { format: 'markdown' as const, body: '# Proposed release notes\nShip the fix.\n' },
  contentDigest: `sha256:${'b'.repeat(64)}`,
};

const MATERIAL_BASE_REVISION = {
  workspaceId: 'ws1',
  materialId: 'material_release_notes',
  revisionId: 'revision_base',
  parentRevisionId: null,
  mediaType: 'text/markdown' as const,
  contentDigest: `sha256:${'c'.repeat(64)}`,
  authorId: 'user1',
  createdAt: TIMESTAMP,
  content: '# Release notes\nBefore worker proposal.\n',
};

const MATERIAL_CURRENT_REVISION = {
  ...MATERIAL_BASE_REVISION,
  revisionId: 'revision_user_newer',
  parentRevisionId: MATERIAL_BASE_REVISION.revisionId,
  contentDigest: `sha256:${'d'.repeat(64)}`,
  createdAt: '2026-07-21T00:01:00.000Z',
  content: '# Release notes\nUser saved newer work.\n',
};

const PROPOSAL_REVIEW = {
  ...REVIEW,
  contentDigest: PROPOSAL_ARTIFACT.contentDigest,
  materialProposal: {
    materialId: MATERIAL_BASE_REVISION.materialId,
    baseRevisionId: MATERIAL_BASE_REVISION.revisionId,
    baseContentDigest: MATERIAL_BASE_REVISION.contentDigest,
  },
};

const REVIEWING_SUMMARY = {
  goal: {
    ...GOAL_BASE,
    status: 'reviewing',
    currentTask: { ...GOAL_BASE.currentTask, status: 'reviewing' },
    taskCounts: { ...GOAL_BASE.taskCounts, running: 0, reviewing: 1 },
    pendingHumanAttention: { required: true, reason: 'Review worker output.' },
  },
};

const GOAL_REVIEW_ROW = {
  id: 'goal-review:ws1:th1:goal1:goal_review_1',
  kind: 'artifact_review',
  workspaceId: 'ws1',
  threadId: 'th1',
  turnId: 'turn_reviewed',
  artifactId: 'artifact1',
  goalId: 'goal1',
  taskId: 'task_demo',
  title: 'Review worker output',
  summary: 'Confirm the verification evidence before the goal advances.',
  severity: 'needs_input',
  createdAt: TIMESTAMP,
  source: {
    type: 'goal_review',
    reviewId: 'goal_review_1',
    goalId: 'goal1',
    taskId: 'task_demo',
    workspaceId: 'ws1',
    threadId: 'th1',
  },
  actions: [
    { kind: 'accept_review', label: 'Accept review', method: 'POST' },
    { kind: 'request_refinement', label: 'Request refinement', method: 'POST' },
    { kind: 'retry_work', label: 'Retry work', method: 'POST' },
    { kind: 'abort', label: 'Abort goal', method: 'POST' },
  ],
};

type GoalReviewVerdict = 'accept' | 'refine' | 'retry' | 'abort';

/** Build one schema-valid bounded Goal Review decision response. */
function goalReviewDecisionResponse(verdict: GoalReviewVerdict, detail?: string) {
  const terminal = verdict === 'abort';
  const accepted = verdict === 'accept';
  return {
    review: {
      reviewId: 'goal_review_1',
      workspaceId: 'ws1',
      threadId: 'th1',
      goalId: 'goal1',
      taskId: 'task_demo',
      turnId: 'turn_reviewed',
      itemIds: ['item_reviewed'],
      artifactIds: ['artifact1'],
      verificationEvidence: [],
      prompt: GOAL_REVIEW_ROW.summary,
      createdByRequestId: 'request_goal_step',
      verdict,
      reason: verdict === 'retry' || terminal ? detail : null,
      revisionInstruction: verdict === 'refine' ? detail : null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      resolvedAt: TIMESTAMP,
      resolutionRequestId: 'request_review_decision',
      resolvedByActorId: 'user1',
    },
    advance: {
      outcome: accepted
        ? ('complete_next_task' as const)
        : verdict === 'refine'
          ? ('refine' as const)
          : verdict === 'retry'
            ? ('retry' as const)
            : ('aborted' as const),
      task: {
        taskId: 'task_demo',
        status: accepted
          ? ('completed' as const)
          : terminal
            ? ('failed' as const)
            : ('ready' as const),
      },
      goal: {
        goalId: 'goal1',
        status: terminal ? ('aborted' as const) : ('running' as const),
        currentTaskId: null,
        terminalStopReason: terminal ? ('aborted' as const) : null,
      },
      nextReadyTaskId: terminal ? null : accepted ? 'task_next' : 'task_demo',
    },
  };
}

/** Build a goal summary fixture for a lifecycle status. */
function goalSummary(status: string) {
  if (status === 'no_goal') return { goal: null };

  if (status === 'planning' || status === 'awaiting_plan_approval') {
    return {
      goal: {
        ...GOAL_BASE,
        status,
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
      },
    };
  }

  if (status === 'completed') {
    return {
      goal: {
        ...GOAL_BASE,
        status,
        currentTask: null,
        taskCounts: {
          pending: 0,
          ready: 0,
          running: 0,
          reviewing: 0,
          completed: 3,
          blocked: 0,
          failed: 0,
        },
        terminalState: { status: 'completed', stopReason: 'completed' },
        terminalSummary: {
          completedTaskIds: ['task_1', 'task_2', 'task_3'],
          blockedTaskIds: [],
          artifactIds: ['artifact1'],
          verificationEvidence: [
            {
              verificationId: 'verify_release',
              status: 'passed',
              summary: 'Release verification passed.',
              command: 'pnpm -w verify:release',
              artifactIds: ['artifact1'],
            },
          ],
          risks: [],
          suggestedNextWork: ['Publish v0.0.6.'],
        },
      },
    };
  }

  return { goal: { ...GOAL_BASE, status } };
}

/** Build a running or paused goal at the safe boundary required by lifecycle commands. */
function safeBoundaryGoalSummary(status: 'running' | 'paused') {
  return {
    goal: {
      ...GOAL_BASE,
      status,
      currentTask: null,
      taskCounts: { ...GOAL_BASE.taskCounts, ready: 1, running: 0 },
    },
  };
}

type MethodOverrides = Partial<Record<string, unknown>>;

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(
  overrides: { core?: MethodOverrides; app?: MethodOverrides; actionCenter?: MethodOverrides } = {}
): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [{ id: 'ws1', name: 'Market research' }] }),
      listThreads: vi.fn().mockResolvedValue({ items: [] }),
      listThreadItems: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      getArtifact: vi.fn().mockResolvedValue(ARTIFACT),
      listArtifacts: vi.fn().mockResolvedValue({ items: [ARTIFACT] }),
      startTurn: vi.fn(),
      ...overrides.core,
    },
    app: {
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [] } satisfies Awaited<
          ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
        >),
      getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('running')),
      startThreadGoal: vi.fn().mockResolvedValue({
        goal: goalSummary('planning').goal,
        objectiveItemId: 'it_goal_objective',
      }),
      createThreadGoalPlan: vi.fn().mockResolvedValue({
        status: 'awaiting_plan_approval',
        goal: goalSummary('awaiting_plan_approval').goal,
        planItemId: 'it_goal_plan_goal1',
        planner: {
          mode: 'goal',
          sourceAgentId: 'worker-coordinator',
          confidence: 0.84,
          rationale: 'Workflow Coordinator drafted a reviewable Goal Mode plan.',
          contextRefs: [
            { kind: 'workspace', id: 'ws1' },
            { kind: 'thread', id: 'th1' },
          ],
          requiredApprovals: ['plan_approval'],
          plan: PLAN,
        },
        plan: PLAN,
      }),
      approveThreadGoalPlan: vi.fn().mockResolvedValue({
        goal: goalSummary('running').goal,
        readyTasks: [{ taskId: 'task_1', status: 'ready' }],
        startsWorkerTurn: false,
      }),
      reviseThreadGoalPlan: vi.fn().mockResolvedValue({
        goal: goalSummary('planning').goal,
        revisionItemId: 'it_goal_plan_revision',
        startsWorkerTurn: false,
      }),
      pauseThreadGoal: vi.fn().mockResolvedValue({
        outcome: 'paused',
        goal: safeBoundaryGoalSummary('paused').goal,
      }),
      resumeThreadGoal: vi.fn().mockResolvedValue({
        outcome: 'resumed',
        goal: safeBoundaryGoalSummary('running').goal,
      }),
      runThreadGoalStep: vi.fn().mockResolvedValue({
        goal: goalSummary('reviewing').goal,
      }),
      submitGoalReviewDecision: vi.fn().mockResolvedValue(goalReviewDecisionResponse('accept')),
      submitThreadGoalSteering: vi.fn().mockResolvedValue({
        state: 'queued',
        pendingTurnId: 'pending_steer',
        requestId: 'req_steer',
        contentItemId: 'it_steer',
        goalId: 'goal1',
        activeTurnId: 'turn_worker',
      }),
      listArtifactReviews: vi.fn().mockResolvedValue({ reviews: [REVIEW] }),
      getWorkspaceMaterial: vi.fn().mockResolvedValue({
        material: {
          workspaceId: 'ws1',
          materialId: MATERIAL_BASE_REVISION.materialId,
          title: 'Release notes',
          kind: 'markdown',
          currentRevisionId: MATERIAL_CURRENT_REVISION.revisionId,
          sensitivity: 'internal',
          createdAt: TIMESTAMP,
          updatedAt: MATERIAL_CURRENT_REVISION.createdAt,
        },
      }),
      getWorkspaceMaterialRevision: vi
        .fn()
        .mockImplementation(async (_workspaceId, _materialId, revisionId) => ({
          revision:
            revisionId === MATERIAL_BASE_REVISION.revisionId
              ? MATERIAL_BASE_REVISION
              : MATERIAL_CURRENT_REVISION,
        })),
      saveWorkspaceMaterialRevision: vi.fn(),
      submitArtifactReviewDecision: vi.fn().mockResolvedValue({
        reviewId: 'review1',
        artifactId: 'artifact1',
        artifactVersion: 1,
        decision: 'accepted',
        followUpTurnId: null,
      }),
      ...overrides.app,
    },
    actionCenter: {
      listHumanAttention: vi.fn().mockResolvedValue({ items: [] }),
      ...overrides.actionCenter,
    },
  } as unknown as CoreClient;
}

/** Captures the current router location for search-param assertions. */
function LocationProbe({ onChange }: { onChange: (search: string, pathname: string) => void }) {
  const location = useLocation();
  onChange(location.search, location.pathname);
  return null;
}

/** Render one app route with an isolated server-state cache. */
function renderApp(
  path: string,
  client: CoreClient,
  onLocation?: (search: string, pathname: string) => void
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          {onLocation ? <LocationProbe onChange={onLocation} /> : null}
          {children}
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(<AppRoutes />));
  return queryClient;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('goal surfaces (WP-5)', () => {
  it('shows a loading skeleton for the goal route', async () => {
    const client = makeClient({
      app: { getThreadGoalSummary: vi.fn().mockReturnValue(new Promise(() => {})) },
    });
    renderApp('/goals/ws1/th1', client);
    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
  });

  it('renders plan title/objective and approval controls when awaiting plan approval', async () => {
    const client = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('awaiting_plan_approval')),
      },
    });
    renderApp('/goals/ws1/th1?lens=plan', client);
    expect(await screen.findByText('Ship release')).toBeInTheDocument();
    expect(screen.getByText('Make v0.0.6 ready.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /approve plan/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /adjust plan/i })).toBeInTheDocument();
    expect(screen.getByText('Planned')).toBeInTheDocument();
  });

  it('calls app.approveThreadGoalPlan when approving the plan', async () => {
    const user = userEvent.setup();
    const approveThreadGoalPlan = vi.fn().mockResolvedValue({
      goal: goalSummary('running').goal,
      readyTasks: [{ taskId: 'task_1', status: 'ready' }],
      startsWorkerTurn: false,
    });
    const client = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('awaiting_plan_approval')),
        approveThreadGoalPlan,
      },
    });
    renderApp('/goals/ws1/th1?lens=plan', client);
    await user.click(await screen.findByRole('button', { name: /approve plan/i }));
    await waitFor(() =>
      expect(approveThreadGoalPlan).toHaveBeenCalledWith(
        'ws1',
        'th1',
        expect.objectContaining({ planItemId: 'it_goal_plan_goal1' })
      )
    );
  });

  it.each([
    {
      actionLabel: 'Accept review',
      verdict: 'accept' as const,
      inputName: null,
      detail: undefined,
      expectedInput: { verdict: 'accept' },
    },
    {
      actionLabel: 'Request refinement',
      verdict: 'refine' as const,
      inputName: /revision instruction/i,
      detail: 'Re-run the verification with the release artifact attached.',
      expectedInput: {
        verdict: 'refine',
        revisionInstruction: 'Re-run the verification with the release artifact attached.',
      },
    },
    {
      actionLabel: 'Retry work',
      verdict: 'retry' as const,
      inputName: /reason/i,
      detail: 'The verification environment was unavailable.',
      expectedInput: {
        verdict: 'retry',
        reason: 'The verification environment was unavailable.',
      },
    },
    {
      actionLabel: 'Abort goal',
      verdict: 'abort' as const,
      inputName: /reason/i,
      detail: 'The release is no longer required.',
      expectedInput: { verdict: 'abort', reason: 'The release is no longer required.' },
    },
  ])('maps $actionLabel to the canonical verdict without inventing decision text', async ({
    actionLabel,
    inputName,
    detail,
    expectedInput,
  }) => {
    const user = userEvent.setup();
    const getThreadGoalSummary = vi.fn().mockResolvedValue(REVIEWING_SUMMARY);
    const listHumanAttention = vi.fn().mockResolvedValue({ items: [GOAL_REVIEW_ROW] });
    const submitGoalReviewDecision = vi.fn().mockReturnValue(new Promise(() => {}));
    const client = makeClient({
      app: { getThreadGoalSummary, submitGoalReviewDecision },
      actionCenter: { listHumanAttention },
    });
    renderApp('/goals/ws1/th1?lens=plan', client);

    const action = await screen.findByRole('button', { name: actionLabel });
    await user.click(action);
    if (inputName && detail) {
      expect(submitGoalReviewDecision).not.toHaveBeenCalled();
      const input = await screen.findByRole('textbox', { name: inputName });
      await user.type(input, detail);
      const confirm = screen
        .getAllByRole('button', {
          name: new RegExp(`${actionLabel}|submit|confirm`, 'i'),
        })
        .at(-1);
      expect(confirm).toBeDefined();
      await user.click(confirm as HTMLElement);
    }

    await waitFor(() => expect(submitGoalReviewDecision).toHaveBeenCalledTimes(1));
    const call = submitGoalReviewDecision.mock.calls[0];
    expect(call?.slice(0, 4)).toEqual(['ws1', 'th1', 'goal1', 'goal_review_1']);
    const actualInput = call?.[4] as Record<string, unknown>;
    expect(actualInput).toMatchObject(expectedInput);
    expect(
      Object.keys(actualInput)
        .filter((key) => key !== 'requestId')
        .sort()
    ).toEqual(Object.keys(expectedInput).sort());
    if (actualInput.requestId !== undefined) {
      expect(actualInput.requestId).toEqual(expect.stringMatching(/\S/));
    }
    const pendingControls = screen.getAllByRole('button', {
      name: /accept review|request refinement|retry work|abort goal|submit|confirm/i,
    });
    await waitFor(() => {
      for (const control of pendingControls) expect(control).toBeDisabled();
    });
    for (const control of pendingControls) await user.click(control);
    expect(submitGoalReviewDecision).toHaveBeenCalledTimes(1);
    expect(getThreadGoalSummary).toHaveBeenCalledTimes(1);
    expect(listHumanAttention).toHaveBeenCalledTimes(1);
    expect(screen.getByText(GOAL_REVIEW_ROW.title)).toBeInTheDocument();
  });

  it('re-reads the full Goal summary and Action Center after an accepted decision', async () => {
    const user = userEvent.setup();
    const authoritativeSummary = {
      goal: {
        ...safeBoundaryGoalSummary('running').goal,
        title: 'Authoritative post-review summary',
      },
    };
    const response = goalReviewDecisionResponse('accept');
    const getThreadGoalSummary = vi
      .fn()
      .mockResolvedValueOnce(REVIEWING_SUMMARY)
      .mockResolvedValueOnce(authoritativeSummary);
    const listHumanAttention = vi
      .fn()
      .mockResolvedValueOnce({ items: [GOAL_REVIEW_ROW] })
      .mockResolvedValueOnce({ items: [] });
    const submitGoalReviewDecision = vi.fn().mockResolvedValue(response);
    const client = makeClient({
      app: { getThreadGoalSummary, submitGoalReviewDecision },
      actionCenter: { listHumanAttention },
    });
    const queryClient = renderApp('/goals/ws1/th1?lens=plan', client);

    await user.click(await screen.findByRole('button', { name: 'Accept review' }));

    await waitFor(() => {
      expect(getThreadGoalSummary).toHaveBeenCalledTimes(2);
      expect(listHumanAttention).toHaveBeenCalledTimes(2);
    });
    expect(getThreadGoalSummary).toHaveBeenNthCalledWith(2, 'ws1', 'th1');
    expect(listHumanAttention).toHaveBeenNthCalledWith(2, 'ws1');
    expect(queryClient.getQueryData(goalKeys.summary('ws1', 'th1'))).toEqual(authoritativeSummary);
    expect(queryClient.getQueryData(goalKeys.summary('ws1', 'th1'))).not.toEqual({
      goal: response.advance.goal,
    });
    expect(await screen.findByText('Authoritative post-review summary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept review' })).not.toBeInTheDocument();
  });

  it.each([
    'plan',
    'board',
    'thread',
  ] as const)('keeps the current review gate visible or directly reachable from the %s lens', async (lens) => {
    const user = userEvent.setup();
    let search = '';
    let pathname = '';
    const listHumanAttention = vi.fn().mockResolvedValue({ items: [GOAL_REVIEW_ROW] });
    const client = makeClient({
      app: { getThreadGoalSummary: vi.fn().mockResolvedValue(REVIEWING_SUMMARY) },
      actionCenter: { listHumanAttention },
    });
    renderApp(`/goals/ws1/th1?lens=${lens}`, client, (nextSearch, nextPathname) => {
      search = nextSearch;
      pathname = nextPathname;
    });
    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledWith('ws1'));

    let accept = screen.queryByRole('button', { name: 'Accept review' });
    if (!accept) {
      const open =
        screen.queryByRole('button', { name: /open review|review worker output/i }) ??
        screen.queryByRole('link', { name: /open review|review worker output/i });
      expect(open).not.toBeNull();
      await user.click(open as HTMLElement);
      accept = await screen.findByRole('button', { name: 'Accept review' });
    }
    expect(accept).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request refinement' })).toBeInTheDocument();
    expect(search).toBe(`?lens=${lens}`);
    expect(pathname).toBe('/goals/ws1/th1');
  });

  it('keeps the cached current Goal Review visible and read-only after an attention refetch fails', async () => {
    const user = userEvent.setup();
    const submitGoalReviewDecision = vi.fn();
    const listHumanAttention = vi
      .fn()
      .mockResolvedValueOnce({ items: [GOAL_REVIEW_ROW] })
      .mockRejectedValueOnce(new Error('sensitive attention read failure'));
    const client = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(REVIEWING_SUMMARY),
        submitGoalReviewDecision,
      },
      actionCenter: { listHumanAttention },
    });
    const queryClient = renderApp('/goals/ws1/th1?lens=plan', client);

    expect(await screen.findByText(GOAL_REVIEW_ROW.title)).toBeInTheDocument();
    await queryClient.refetchQueries({
      queryKey: workspaceKeys.attention('ws1'),
      exact: true,
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't|failed|try again/i);
    expect(alert).not.toHaveTextContent('sensitive attention read failure');
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByText(GOAL_REVIEW_ROW.title)).toBeInTheDocument();
    const controls = [
      screen.getByRole('button', { name: 'Accept review' }),
      screen.getByRole('button', { name: 'Request refinement' }),
      screen.getByRole('button', { name: 'Retry work' }),
      screen.getByRole('button', { name: 'Abort goal' }),
    ];
    for (const control of controls) {
      expect(control).toBeDisabled();
      await user.click(control);
    }
    expect(listHumanAttention).toHaveBeenCalledTimes(2);
    expect(submitGoalReviewDecision).not.toHaveBeenCalled();
  });

  it('selects only the exact current Goal Review source lineage as the active gate', async () => {
    const invalidRows = [
      {
        id: 'goal:ws1:th1:goal1',
        kind: 'blocked_turn',
        workspaceId: 'ws1',
        threadId: 'th1',
        goalId: 'goal1',
        title: 'Unrelated attention row',
        summary: 'Open the current goal.',
        severity: 'needs_input',
        createdAt: TIMESTAMP,
        source: {
          type: 'goal',
          goalId: 'goal1',
          workspaceId: 'ws1',
          threadId: 'th1',
          status: 'reviewing',
        },
        actions: [
          {
            kind: 'open_thread',
            label: 'Open thread',
            method: 'GET',
            href: '/threads/th1',
          },
        ],
      },
      {
        ...GOAL_REVIEW_ROW,
        id: 'goal-review:ws2:th1:goal1:goal_review_1',
        workspaceId: 'ws2',
        title: 'Cross-workspace review',
        source: { ...GOAL_REVIEW_ROW.source, workspaceId: 'ws2' },
      },
      {
        ...GOAL_REVIEW_ROW,
        id: 'goal-review:ws1:th2:goal1:goal_review_1',
        threadId: 'th2',
        title: 'Cross-thread review',
        source: { ...GOAL_REVIEW_ROW.source, threadId: 'th2' },
      },
      {
        ...GOAL_REVIEW_ROW,
        id: 'goal-review:ws1:th1:goal2:goal_review_1',
        goalId: 'goal2',
        title: 'Cross-goal review',
        source: { ...GOAL_REVIEW_ROW.source, goalId: 'goal2' },
      },
      {
        ...GOAL_REVIEW_ROW,
        taskId: 'task_other',
        title: 'Different-task review',
        source: { ...GOAL_REVIEW_ROW.source, taskId: 'task_other' },
      },
    ];
    const client = makeClient({
      app: { getThreadGoalSummary: vi.fn().mockResolvedValue(REVIEWING_SUMMARY) },
      actionCenter: {
        listHumanAttention: vi.fn().mockResolvedValue({
          items: [...invalidRows, GOAL_REVIEW_ROW],
        }),
      },
    });
    renderApp('/goals/ws1/th1?lens=plan', client);

    expect(await screen.findByText(GOAL_REVIEW_ROW.title)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Accept review' })).toHaveLength(1);
    for (const row of invalidRows) {
      expect(screen.queryByText(row.title)).not.toBeInTheDocument();
    }
  });

  it('does not infer an executable Goal Review gate from multiple unresolved current-task rows', async () => {
    const user = userEvent.setup();
    const competingReview = {
      ...GOAL_REVIEW_ROW,
      id: 'goal-review:ws1:th1:goal1:goal_review_2',
      turnId: 'turn_reviewed_2',
      artifactId: 'artifact2',
      title: 'Review competing worker output',
      summary: 'Confirm the competing verification evidence before the goal advances.',
      source: { ...GOAL_REVIEW_ROW.source, reviewId: 'goal_review_2' },
    };
    const listHumanAttention = vi.fn().mockResolvedValue({
      items: [GOAL_REVIEW_ROW, competingReview],
    });
    const submitGoalReviewDecision = vi.fn().mockReturnValue(new Promise(() => {}));
    const client = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(REVIEWING_SUMMARY),
        submitGoalReviewDecision,
      },
      actionCenter: { listHumanAttention },
    });
    renderApp('/goals/ws1/th1?lens=plan', client);

    await waitFor(() => expect(listHumanAttention).toHaveBeenCalledWith('ws1'));
    await user.click(screen.getByRole('tab', { name: 'Thread' }));
    await user.click(screen.getByRole('tab', { name: 'Plan' }));
    const decisionControls = screen.queryAllByRole('button', {
      name: /accept review|request refinement|retry work|abort goal/i,
    });
    for (const control of decisionControls) await user.click(control);

    expect.soft(decisionControls).toHaveLength(0);
    expect(submitGoalReviewDecision).not.toHaveBeenCalled();
  });

  it('does not expose decisions for an exact-lineage Goal Review with an incomplete action set', async () => {
    const user = userEvent.setup();
    const submitGoalReviewDecision = vi.fn().mockReturnValue(new Promise(() => {}));
    const client = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(REVIEWING_SUMMARY),
        submitGoalReviewDecision,
      },
      actionCenter: {
        listHumanAttention: vi.fn().mockResolvedValue({
          items: [
            {
              ...GOAL_REVIEW_ROW,
              actions: GOAL_REVIEW_ROW.actions.filter((action) => action.kind !== 'abort'),
            },
          ],
        }),
      },
    });
    renderApp('/goals/ws1/th1?lens=plan', client);

    await screen.findByText('Ship release');
    await waitFor(() =>
      expect(screen.queryByText('Current review details are loading.')).not.toBeInTheDocument()
    );
    const decisionControls = screen.queryAllByRole('button', {
      name: /accept review|request refinement|retry work|abort goal/i,
    });
    for (const control of decisionControls) await user.click(control);

    expect.soft(decisionControls).toHaveLength(0);
    expect(submitGoalReviewDecision).not.toHaveBeenCalled();
  });

  it('preserves the full Goal, review row, and lens context when a decision fails', async () => {
    const user = userEvent.setup();
    let search = '';
    let pathname = '';
    const getThreadGoalSummary = vi.fn().mockResolvedValue(REVIEWING_SUMMARY);
    const listHumanAttention = vi.fn().mockResolvedValue({ items: [GOAL_REVIEW_ROW] });
    const submitGoalReviewDecision = vi
      .fn()
      .mockRejectedValue(new Error('sensitive internal review failure'));
    const client = makeClient({
      app: { getThreadGoalSummary, submitGoalReviewDecision },
      actionCenter: { listHumanAttention },
    });
    const queryClient = renderApp(
      '/goals/ws1/th1?lens=board',
      client,
      (nextSearch, nextPathname) => {
        search = nextSearch;
        pathname = nextPathname;
      }
    );

    await user.click(await screen.findByRole('button', { name: 'Accept review' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't|failed|try again/i);
    expect(alert).not.toHaveTextContent('sensitive internal review failure');
    expect(screen.getByText(GOAL_REVIEW_ROW.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept review' })).toBeInTheDocument();
    expect(queryClient.getQueryData(goalKeys.summary('ws1', 'th1'))).toEqual(REVIEWING_SUMMARY);
    expect(getThreadGoalSummary).toHaveBeenCalledTimes(1);
    expect(listHumanAttention).toHaveBeenCalledTimes(1);
    expect(search).toBe('?lens=board');
    expect(pathname).toBe('/goals/ws1/th1');
  });

  it('keeps a disconnected Goal Review visible and read-only without a decision call', async () => {
    const user = userEvent.setup();
    const disconnectedSubmit = vi.fn();
    const disconnectedClient = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(REVIEWING_SUMMARY),
        submitGoalReviewDecision: disconnectedSubmit,
      },
      actionCenter: {
        listHumanAttention: vi.fn().mockResolvedValue({ items: [GOAL_REVIEW_ROW] }),
      },
    });
    renderApp('/goals/ws1/th1?lens=thread', disconnectedClient);
    expect(await screen.findByText(GOAL_REVIEW_ROW.title)).toBeInTheDocument();
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    for (const control of screen.queryAllByRole('button', {
      name: /accept review|request refinement|retry work|abort goal/i,
    })) {
      expect(control).toBeDisabled();
      await user.click(control);
    }
    expect(disconnectedSubmit).not.toHaveBeenCalled();
  });

  it('does not expose a stale Goal Review decision on the terminal Completed view', async () => {
    const client = makeClient({
      app: { getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('completed')) },
      actionCenter: {
        listHumanAttention: vi.fn().mockResolvedValue({ items: [GOAL_REVIEW_ROW] }),
      },
    });
    renderApp('/goals/ws1/th1?lens=plan', client);

    expect(await screen.findByText(/Goal completed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept review' })).not.toBeInTheDocument();
    expect(screen.queryByText(GOAL_REVIEW_ROW.title)).not.toBeInTheDocument();
  });

  it('starts the no-goal route through app.startThreadGoal and installs its returned goal', async () => {
    const user = userEvent.setup();
    let search = '';
    let pathname = '';
    const authoritativeGoal = {
      ...goalSummary('planning').goal,
      title: 'Authoritative started goal',
      objective: 'Investigate the release blocker.',
    };
    const startThreadGoal = vi.fn().mockResolvedValue({
      goal: authoritativeGoal,
      objectiveItemId: 'it_goal_started',
    });
    const client = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('no_goal')),
        startThreadGoal,
      },
    });
    const queryClient = renderApp(
      '/goals/ws1/th1?lens=plan',
      client,
      (nextSearch, nextPathname) => {
        search = nextSearch;
        pathname = nextPathname;
      }
    );
    const unrelatedSummary = goalSummary('completed');
    queryClient.setQueryData(goalKeys.summary('ws2', 'th2'), unrelatedSummary);

    const main = await screen.findByRole('main', { name: 'Workspace' });
    await user.type(await within(main).findByRole('textbox'), 'Investigate the release blocker.');
    await user.click(within(main).getByRole('button'));

    await waitFor(() => expect(startThreadGoal).toHaveBeenCalledTimes(1));
    expect(startThreadGoal.mock.calls[0]?.slice(0, 2)).toEqual(['ws1', 'th1']);
    expect(startThreadGoal.mock.calls[0]?.[2]).toEqual({
      objective: 'Investigate the release blocker.',
      requestId: expect.stringMatching(/\S/),
    });
    expect(queryClient.getQueryData(goalKeys.summary('ws1', 'th1'))).toEqual({
      goal: authoritativeGoal,
    });
    expect(queryClient.getQueryData(goalKeys.summary('ws2', 'th2'))).toEqual(unrelatedSummary);
    expect(await screen.findByText('Authoritative started goal')).toBeInTheDocument();
    expect(search).toBe('?lens=plan');
    expect(pathname).toBe('/goals/ws1/th1');
  });

  it('reuses the caller request id when the unchanged start objective is retried', async () => {
    const user = userEvent.setup();
    const authoritativeGoal = {
      ...goalSummary('planning').goal,
      title: 'Authoritative retried goal',
      objective: 'Investigate the release blocker.',
    };
    const startThreadGoal = vi
      .fn()
      .mockRejectedValueOnce(new Error('sensitive internal start failure'))
      .mockResolvedValueOnce({
        goal: authoritativeGoal,
        objectiveItemId: 'it_goal_retried',
      });
    const client = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('no_goal')),
        startThreadGoal,
      },
    });
    const queryClient = renderApp('/goals/ws1/th1?lens=plan', client);

    await user.type(await screen.findByRole('textbox'), 'Investigate the release blocker.');
    await user.click(screen.getByRole('button', { name: 'Start Goal' }));
    expect(await screen.findByText("Couldn't start Goal Mode.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(startThreadGoal).toHaveBeenCalledTimes(2));
    const firstRequest = startThreadGoal.mock.calls[0]?.[2];
    const retryRequest = startThreadGoal.mock.calls[1]?.[2];
    expect(firstRequest).toMatchObject({
      objective: 'Investigate the release blocker.',
      requestId: expect.stringMatching(/\S/),
    });
    expect(retryRequest?.requestId).toBe(firstRequest?.requestId);
    expect(queryClient.getQueryData(goalKeys.summary('ws1', 'th1'))).toEqual({
      goal: authoritativeGoal,
    });
    expect(await screen.findByText('Authoritative retried goal')).toBeInTheDocument();
  });

  it('uses a new caller request id when a failed start is retried with a changed objective', async () => {
    const user = userEvent.setup();
    const startThreadGoal = vi.fn().mockRejectedValue(new Error('start failed'));
    const client = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('no_goal')),
        startThreadGoal,
      },
    });
    renderApp('/goals/ws1/th1', client);
    const objective = await screen.findByRole('textbox');

    await user.type(objective, '  Investigate the release blocker.  ');
    await user.click(screen.getByRole('button', { name: 'Start Goal' }));
    expect(await screen.findByText("Couldn't start Goal Mode.")).toBeInTheDocument();
    await user.clear(objective);
    await user.type(objective, '  Publish the corrected release.  ');
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(startThreadGoal).toHaveBeenCalledTimes(2));
    const firstRequest = startThreadGoal.mock.calls[0]?.[2];
    const changedRequest = startThreadGoal.mock.calls[1]?.[2];
    expect(firstRequest).toEqual({
      objective: 'Investigate the release blocker.',
      requestId: expect.stringMatching(/\S/),
    });
    expect(changedRequest).toEqual({
      objective: 'Publish the corrected release.',
      requestId: expect.stringMatching(/\S/),
    });
    expect(changedRequest?.requestId).not.toBe(firstRequest?.requestId);
  });

  it('does not repeat start or lifecycle commands while their mutation is pending', async () => {
    const user = userEvent.setup();
    const startThreadGoal = vi.fn().mockReturnValue(new Promise(() => {}));
    const startClient = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('no_goal')),
        startThreadGoal,
      },
    });
    renderApp('/goals/ws1/th1', startClient);
    await user.type(await screen.findByRole('textbox'), 'Investigate the release blocker.');
    const startControl = screen.getByRole('button', { name: 'Start Goal' });

    await user.click(startControl);
    await waitFor(() => expect(startControl).toBeDisabled());
    await user.click(startControl);
    expect(startThreadGoal).toHaveBeenCalledTimes(1);
    cleanup();

    const pauseThreadGoal = vi.fn().mockReturnValue(new Promise(() => {}));
    const runThreadGoalStep = vi.fn();
    const lifecycleClient = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(safeBoundaryGoalSummary('running')),
        pauseThreadGoal,
        runThreadGoalStep,
      },
    });
    renderApp('/goals/ws1/th1', lifecycleClient);
    const pauseControl = await screen.findByRole('button', { name: /pause goal/i });
    const stepControl = screen.getByRole('button', { name: /one (?:bounded )?step/i });

    await user.click(pauseControl);
    await waitFor(() => {
      expect(pauseControl).toBeDisabled();
      expect(stepControl).toBeDisabled();
    });
    await user.click(pauseControl);
    await user.click(stepControl);
    expect(pauseThreadGoal).toHaveBeenCalledTimes(1);
    expect(runThreadGoalStep).not.toHaveBeenCalled();
  });

  it('does not allow a failed start retry after the connection becomes disconnected', async () => {
    const user = userEvent.setup();
    const meta = vi.fn().mockResolvedValueOnce({}).mockRejectedValue(new Error('down'));
    const startThreadGoal = vi
      .fn()
      .mockRejectedValue(new Error('sensitive internal start failure'));
    const client = makeClient({
      core: { meta },
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('no_goal')),
        startThreadGoal,
      },
    });
    const queryClient = renderApp('/goals/ws1/th1', client);
    const main = await screen.findByRole('main', { name: 'Workspace' });
    const objective = await within(main).findByRole('textbox');

    await user.type(objective, 'Investigate the release blocker.');
    await user.click(within(main).getByRole('button', { name: 'Start Goal' }));
    expect(await within(main).findByText("Couldn't start Goal Mode.")).toBeInTheDocument();
    await queryClient.refetchQueries({ queryKey: ['core', 'meta'] });
    await waitFor(
      () => expect(within(main).getByRole('button', { name: 'Start Goal' })).toBeDisabled(),
      { timeout: 3000 }
    );

    expect(objective).toHaveValue('Investigate the release blocker.');
    expect(screen.queryByText('sensitive internal start failure')).not.toBeInTheDocument();
    const retry = within(main).queryByRole('button', { name: 'Try again' });
    expect
      .soft(
        retry === null ||
          retry.hasAttribute('disabled') ||
          retry.getAttribute('aria-disabled') === 'true'
      )
      .toBe(true);
    if (retry) await user.click(retry);
    expect(startThreadGoal).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'pause',
      initialSummary: safeBoundaryGoalSummary('running'),
      buttonName: /pause goal/i,
      method: 'pauseThreadGoal' as const,
      response: {
        outcome: 'paused',
        goal: {
          ...safeBoundaryGoalSummary('paused').goal,
          title: 'Authoritative paused goal',
        },
      },
    },
    {
      label: 'resume',
      initialSummary: safeBoundaryGoalSummary('paused'),
      buttonName: /resume goal/i,
      method: 'resumeThreadGoal' as const,
      response: {
        outcome: 'resumed',
        goal: {
          ...safeBoundaryGoalSummary('running').goal,
          title: 'Authoritative resumed goal',
        },
      },
    },
    {
      label: 'one bounded step',
      initialSummary: safeBoundaryGoalSummary('running'),
      buttonName: /one (?:bounded )?step/i,
      method: 'runThreadGoalStep' as const,
      response: {
        goal: {
          ...GOAL_BASE,
          status: 'reviewing',
          title: 'Authoritative stepped goal',
          currentTask: { ...GOAL_BASE.currentTask, status: 'reviewing' },
          taskCounts: { ...GOAL_BASE.taskCounts, running: 0, reviewing: 1 },
        },
      },
    },
  ])('runs the $label command once and installs only its authoritative goal summary', async ({
    initialSummary,
    buttonName,
    method,
    response,
  }) => {
    const user = userEvent.setup();
    let search = '';
    let pathname = '';
    const mutation = vi.fn().mockResolvedValue(response);
    const client = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(initialSummary),
        [method]: mutation,
      },
    });
    const queryClient = renderApp(
      '/goals/ws1/th1?lens=plan',
      client,
      (nextSearch, nextPathname) => {
        search = nextSearch;
        pathname = nextPathname;
      }
    );
    const unrelatedSummary = goalSummary('completed');
    queryClient.setQueryData(goalKeys.summary('ws2', 'th2'), unrelatedSummary);

    await user.click(await screen.findByRole('button', { name: buttonName }));

    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    expect(mutation.mock.calls[0]?.slice(0, 2)).toEqual(['ws1', 'th1']);
    expect(queryClient.getQueryData(goalKeys.summary('ws1', 'th1'))).toEqual({
      goal: response.goal,
    });
    expect(queryClient.getQueryData(goalKeys.summary('ws2', 'th2'))).toEqual(unrelatedSummary);
    expect(await screen.findByText(response.goal.title)).toBeInTheDocument();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(search).toBe('?lens=plan');
    expect(pathname).toBe('/goals/ws1/th1');
  });

  it('keeps the authoritative goal and route context visible when a command fails', async () => {
    const user = userEvent.setup();
    let search = '';
    let pathname = '';
    const priorSummary = safeBoundaryGoalSummary('running');
    const pauseThreadGoal = vi
      .fn()
      .mockRejectedValue(new Error('sensitive internal mutation failure'));
    const client = makeClient({
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(priorSummary),
        pauseThreadGoal,
      },
    });
    const queryClient = renderApp(
      '/goals/ws1/th1?lens=plan',
      client,
      (nextSearch, nextPathname) => {
        search = nextSearch;
        pathname = nextPathname;
      }
    );

    expect(await screen.findByText('Ship release')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /pause goal/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't|failed|try again/i);
    expect(alert).not.toHaveTextContent('sensitive internal mutation failure');
    expect(screen.getByText('Ship release')).toBeInTheDocument();
    expect(screen.getByText('Make v0.0.6 ready.')).toBeInTheDocument();
    expect(queryClient.getQueryData(goalKeys.summary('ws1', 'th1'))).toEqual(priorSummary);
    expect(search).toBe('?lens=plan');
    expect(pathname).toBe('/goals/ws1/th1');
  });

  it('does not invoke lifecycle commands outside their summary-visible safe boundaries', async () => {
    const user = userEvent.setup();
    /** Invalid summary/control pairs decidable from the Goal projection alone. */
    const invalidCases = [
      {
        label: 'pause with a current task',
        summary: goalSummary('running'),
        buttonName: /pause goal/i,
        method: 'pauseThreadGoal' as const,
      },
      {
        label: 'step with a current task',
        summary: goalSummary('running'),
        buttonName: /one (?:bounded )?step/i,
        method: 'runThreadGoalStep' as const,
      },
      {
        label: 'pause with a running task count',
        summary: {
          goal: {
            ...safeBoundaryGoalSummary('running').goal,
            taskCounts: { ...GOAL_BASE.taskCounts, ready: 1, running: 1 },
          },
        },
        buttonName: /pause goal/i,
        method: 'pauseThreadGoal' as const,
      },
      {
        label: 'step with a running task count',
        summary: {
          goal: {
            ...safeBoundaryGoalSummary('running').goal,
            taskCounts: { ...GOAL_BASE.taskCounts, ready: 1, running: 1 },
          },
        },
        buttonName: /one (?:bounded )?step/i,
        method: 'runThreadGoalStep' as const,
      },
      {
        label: 'step with no ready task',
        summary: {
          goal: {
            ...safeBoundaryGoalSummary('running').goal,
            taskCounts: { ...GOAL_BASE.taskCounts, ready: 0, running: 0 },
          },
        },
        buttonName: /one (?:bounded )?step/i,
        method: 'runThreadGoalStep' as const,
      },
      {
        label: 'resume outside a paused safe boundary',
        summary: goalSummary('paused'),
        buttonName: /resume goal/i,
        method: 'resumeThreadGoal' as const,
      },
    ];
    const offered: string[] = [];
    const invoked: string[] = [];

    for (const invalidCase of invalidCases) {
      const mutation = vi.fn().mockRejectedValue(new Error('must not be called'));
      const client = makeClient({
        app: {
          getThreadGoalSummary: vi.fn().mockResolvedValue(invalidCase.summary),
          [invalidCase.method]: mutation,
        },
      });
      renderApp('/goals/ws1/th1', client);
      await screen.findByText('Ship release');
      const control = screen.queryByRole('button', { name: invalidCase.buttonName });
      if (control) {
        offered.push(invalidCase.label);
        await user.click(control);
      }
      if (mutation.mock.calls.length > 0) invoked.push(invalidCase.label);
      cleanup();
    }

    expect.soft(offered).toEqual([]);
    expect(invoked).toEqual([]);
  });

  it('does not invoke lifecycle commands while disconnected', async () => {
    const user = userEvent.setup();
    const pauseThreadGoal = vi.fn();
    const runThreadGoalStep = vi.fn();
    const runningClient = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(safeBoundaryGoalSummary('running')),
        pauseThreadGoal,
        runThreadGoalStep,
      },
    });
    renderApp('/goals/ws1/th1', runningClient);
    const pauseControl = await screen.findByRole('button', { name: /pause goal/i });
    const stepControl = screen.getByRole('button', { name: /one (?:bounded )?step/i });

    await waitFor(
      () => {
        expect(pauseControl).toBeDisabled();
        expect(stepControl).toBeDisabled();
      },
      { timeout: 3000 }
    );
    await user.click(pauseControl);
    await user.click(stepControl);
    expect(pauseThreadGoal).not.toHaveBeenCalled();
    expect(runThreadGoalStep).not.toHaveBeenCalled();
    cleanup();

    const resumeThreadGoal = vi.fn();
    const pausedClient = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
      app: {
        getThreadGoalSummary: vi.fn().mockResolvedValue(safeBoundaryGoalSummary('paused')),
        resumeThreadGoal,
      },
    });
    renderApp('/goals/ws1/th1', pausedClient);
    const resumeControl = await screen.findByRole('button', { name: /resume goal/i });

    await waitFor(() => expect(resumeControl).toBeDisabled(), { timeout: 3000 });
    await user.click(resumeControl);
    expect(resumeThreadGoal).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'planning', selectedLens: 'Thread', content: 'Catch-up' },
    {
      status: 'awaiting_plan_approval',
      selectedLens: 'Thread',
      content: 'Catch-up',
    },
    { status: 'running', selectedLens: 'Plan', content: 'Run verification' },
  ])('defaults a $status goal to the $selectedLens lens', async ({
    status,
    selectedLens,
    content,
  }) => {
    const client = makeClient({
      app: { getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary(status)) },
    });
    renderApp('/goals/ws1/th1', client);

    expect(await screen.findByRole('tab', { name: selectedLens })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(await screen.findByText(content)).toBeInTheDocument();
  });

  it('switches Thread ↔ Plan ↔ Board lenses while keeping the thread id in the URL', async () => {
    const user = userEvent.setup();
    let search = '';
    let pathname = '';
    const client = makeClient();
    renderApp('/goals/ws1/th1?lens=plan', client, (s, p) => {
      search = s;
      pathname = p;
    });
    expect(await screen.findByText('Ship release')).toBeInTheDocument();
    expect(pathname).toBe('/goals/ws1/th1');

    await user.click(screen.getByRole('tab', { name: 'Thread' }));
    await waitFor(() => expect(search).toContain('lens=thread'));
    expect(pathname).toBe('/goals/ws1/th1');

    await user.click(screen.getByRole('tab', { name: 'Board' }));
    await waitFor(() => expect(search).toContain('lens=board'));
    expect(pathname).toBe('/goals/ws1/th1');
    expect(screen.getByText('To do')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: 'Plan' }));
    await waitFor(() => expect(search).toContain('lens=plan'));
    expect(pathname).toBe('/goals/ws1/th1');
  });

  it('opens board cards into the thread lens and offers no Done drop control', async () => {
    const user = userEvent.setup();
    let search = '';
    const client = makeClient();
    renderApp('/goals/ws1/th1?lens=board', client, (s) => {
      search = s;
    });
    const card = await screen.findByRole('button', { name: /Run verification/i });
    expect(
      screen.queryByRole('button', { name: /move to done|drop.*done/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/drop into done/i)).not.toBeInTheDocument();
    await user.click(card);
    await waitFor(() => expect(search).toContain('lens=thread'));
  });

  it('shows the completed closeout when the goal is completed', async () => {
    const client = makeClient({
      app: { getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('completed')) },
    });
    renderApp('/goals/ws1/th1', client);
    expect(await screen.findByText(/Goal completed/i)).toBeInTheDocument();
    expect(screen.getByText('Release verification passed.')).toBeInTheDocument();
    expect(screen.getByText('Publish v0.0.6.')).toBeInTheDocument();
  });

  it('disables the steer bar when core.meta fails', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
    });
    renderApp('/goals/ws1/th1', client);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled(), {
      timeout: 3000,
    });
  });

  it('shows empty and error states for missing or failed goal fetches', async () => {
    const emptyClient = makeClient({
      app: { getThreadGoalSummary: vi.fn().mockResolvedValue(goalSummary('no_goal')) },
    });
    const emptyQuery = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const emptyView = render(
      <QueryClientProvider client={emptyQuery}>
        <CoreClientProvider client={emptyClient}>
          <MemoryRouter initialEntries={['/goals/ws1/th1']}>
            <AppRoutes />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText(/No goal on this thread/i)).toBeInTheDocument();
    emptyView.unmount();

    const errorClient = makeClient({
      app: { getThreadGoalSummary: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    renderApp('/goals/ws1/th1', errorClient);
    expect(await screen.findByText(/Couldn't load this goal/i)).toBeInTheDocument();
  });
});

describe('Artifact Review S14', () => {
  it('compares the exact reviewed proposal with its recorded immutable base revision', async () => {
    const getWorkspaceMaterialRevision = vi
      .fn()
      .mockImplementation(async (workspaceId: string, materialId: string, revisionId: string) => {
        if (
          workspaceId === 'ws1' &&
          materialId === MATERIAL_BASE_REVISION.materialId &&
          revisionId === MATERIAL_BASE_REVISION.revisionId
        ) {
          return { revision: MATERIAL_BASE_REVISION };
        }
        throw new Error(
          `Unexpected Material revision tuple: ${workspaceId}/${materialId}/${revisionId}`
        );
      });
    const client = makeClient({
      core: { getArtifact: vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT) },
      app: {
        listArtifactReviews: vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }),
        getWorkspaceMaterialRevision,
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const proposal = await screen.findByRole('region', { name: /reviewed artifact proposal/i });
    const base = screen.getByRole('region', { name: /recorded base revision/i });
    expect(proposal).toHaveTextContent(/# Proposed release notes\s+Ship the fix\./);
    expect(proposal).toHaveTextContent(PROPOSAL_ARTIFACT.contentDigest);
    expect(base).toHaveTextContent(/# Release notes\s+Before worker proposal\./);
    expect(base).toHaveTextContent(MATERIAL_BASE_REVISION.contentDigest);
    expect(base).toHaveTextContent(MATERIAL_BASE_REVISION.revisionId);
    expect(getWorkspaceMaterialRevision).toHaveBeenCalledTimes(1);
    expect(getWorkspaceMaterialRevision).toHaveBeenCalledWith(
      'ws1',
      MATERIAL_BASE_REVISION.materialId,
      MATERIAL_BASE_REVISION.revisionId
    );
  });

  it.each([
    {
      mismatch: 'a newer current Artifact version',
      artifact: {
        ...PROPOSAL_ARTIFACT,
        version: PROPOSAL_REVIEW.artifactVersion + 1,
        contentDigest: `sha256:${'e'.repeat(64)}`,
      },
    },
    {
      mismatch: 'a different current Artifact digest at the reviewed version',
      artifact: {
        ...PROPOSAL_ARTIFACT,
        contentDigest: `sha256:${'f'.repeat(64)}`,
      },
    },
  ])('fails closed for an unresolved Review with $mismatch', async ({ artifact }) => {
    const submitArtifactReviewDecision = vi.fn();
    const client = makeClient({
      core: { getArtifact: vi.fn().mockResolvedValue(artifact) },
      app: {
        listArtifactReviews: vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }),
        submitArtifactReviewDecision,
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const unavailable = await screen.findByRole('alert');
    expect(unavailable).toHaveTextContent(/review (?:is )?unavailable|recovery required/i);
    expect(unavailable).not.toHaveTextContent(/decision evidence remains/i);
    for (const name of [/^accept$/i, /request refinement/i, /^redo$/i, /^reject$/i, /^defer$/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(submitArtifactReviewDecision).not.toHaveBeenCalled();
  });

  it.each([
    { label: /^accept$/i, decision: 'accepted' as const, feedback: undefined },
    {
      label: /request refinement/i,
      decision: 'needs_refinement' as const,
      feedback: 'Keep the user-authored heading.',
    },
    { label: /^redo$/i, decision: 'redo' as const, feedback: 'Rebuild from the recorded base.' },
    { label: /^reject$/i, decision: 'rejected' as const, feedback: undefined },
    { label: /^defer$/i, decision: 'deferred' as const, feedback: undefined },
  ])('submits the exact version-keyed $decision decision', async ({
    label,
    decision,
    feedback,
  }) => {
    const user = userEvent.setup();
    const submitArtifactReviewDecision = vi.fn().mockResolvedValue({
      reviewId: PROPOSAL_REVIEW.reviewId,
      artifactId: PROPOSAL_REVIEW.artifactId,
      artifactVersion: PROPOSAL_REVIEW.artifactVersion,
      decision,
      followUpTurnId:
        decision === 'needs_refinement' || decision === 'redo' ? 'turn_follow_up' : null,
    });
    const client = makeClient({
      core: { getArtifact: vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT) },
      app: {
        listArtifactReviews: vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }),
        submitArtifactReviewDecision,
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const action = await screen.findByRole('button', { name: label });
    if (feedback) {
      const feedbackField = screen.getByRole('textbox', { name: /review feedback/i });
      expect(action).toBeDisabled();
      await user.type(feedbackField, '   ');
      expect(action).toBeDisabled();
      await user.clear(feedbackField);
      await user.type(feedbackField, feedback);
      expect(action).toBeEnabled();
    }
    await user.click(action);

    await waitFor(() =>
      expect(submitArtifactReviewDecision).toHaveBeenCalledWith(
        'ws1',
        PROPOSAL_REVIEW.artifactId,
        PROPOSAL_REVIEW.artifactVersion,
        feedback ? { decision, feedback } : { decision }
      )
    );
    expect(client.core.startTurn).not.toHaveBeenCalled();
    expect(client.app.saveWorkspaceMaterialRevision).not.toHaveBeenCalled();
  });

  it('keeps the review pending and preserves both sides after a typed apply conflict', async () => {
    const user = userEvent.setup();
    const submitArtifactReviewDecision = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiCallError(409, 'Material changed since the proposal base.', {
          code: 'conflict',
        })
      )
      .mockResolvedValueOnce({
        reviewId: PROPOSAL_REVIEW.reviewId,
        artifactId: PROPOSAL_REVIEW.artifactId,
        artifactVersion: PROPOSAL_REVIEW.artifactVersion,
        decision: 'rejected',
        followUpTurnId: null,
      });
    const listArtifactReviews = vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] });
    const getWorkspaceMaterial = vi
      .fn()
      .mockImplementation(async (workspaceId: string, materialId: string) => {
        if (workspaceId === 'ws1' && materialId === MATERIAL_CURRENT_REVISION.materialId) {
          return {
            material: {
              workspaceId,
              materialId,
              title: 'Release notes',
              kind: 'markdown',
              currentRevisionId: MATERIAL_CURRENT_REVISION.revisionId,
              sensitivity: 'internal',
              createdAt: TIMESTAMP,
              updatedAt: MATERIAL_CURRENT_REVISION.createdAt,
            },
          };
        }
        throw new Error(`Unexpected Material identity tuple: ${workspaceId}/${materialId}`);
      });
    const getWorkspaceMaterialRevision = vi
      .fn()
      .mockImplementation(async (workspaceId: string, materialId: string, revisionId: string) => {
        if (
          workspaceId === 'ws1' &&
          materialId === MATERIAL_BASE_REVISION.materialId &&
          revisionId === MATERIAL_BASE_REVISION.revisionId
        ) {
          return { revision: MATERIAL_BASE_REVISION };
        }
        if (
          workspaceId === 'ws1' &&
          materialId === MATERIAL_CURRENT_REVISION.materialId &&
          revisionId === MATERIAL_CURRENT_REVISION.revisionId
        ) {
          return { revision: MATERIAL_CURRENT_REVISION };
        }
        throw new Error(
          `Unexpected Material revision tuple: ${workspaceId}/${materialId}/${revisionId}`
        );
      });
    const client = makeClient({
      core: { getArtifact: vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT) },
      app: {
        listArtifactReviews,
        getWorkspaceMaterial,
        getWorkspaceMaterialRevision,
        submitArtifactReviewDecision,
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    await user.click(await screen.findByRole('button', { name: /^accept$/i }));

    expect(
      await screen.findByText(/conflict|changed since the proposal base/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/awaiting decision/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /reviewed artifact proposal/i })).toHaveTextContent(
      /# Proposed release notes\s+Ship the fix\./
    );
    expect(screen.getByRole('region', { name: /current material revision/i })).toHaveTextContent(
      /# Release notes\s+User saved newer work\./
    );
    expect(getWorkspaceMaterial).toHaveBeenCalledTimes(1);
    expect(getWorkspaceMaterial).toHaveBeenCalledWith('ws1', MATERIAL_CURRENT_REVISION.materialId);
    expect(getWorkspaceMaterialRevision).toHaveBeenCalledTimes(2);
    expect(getWorkspaceMaterialRevision).toHaveBeenCalledWith(
      'ws1',
      MATERIAL_BASE_REVISION.materialId,
      MATERIAL_BASE_REVISION.revisionId
    );
    expect(getWorkspaceMaterialRevision).toHaveBeenCalledWith(
      'ws1',
      MATERIAL_CURRENT_REVISION.materialId,
      MATERIAL_CURRENT_REVISION.revisionId
    );
    expect(client.app.saveWorkspaceMaterialRevision).not.toHaveBeenCalled();
    expect(submitArtifactReviewDecision).toHaveBeenCalledTimes(1);
    expect(submitArtifactReviewDecision).toHaveBeenNthCalledWith(
      1,
      'ws1',
      PROPOSAL_REVIEW.artifactId,
      PROPOSAL_REVIEW.artifactVersion,
      { decision: 'accepted' }
    );

    const retry = screen.queryByRole('button', { name: /try again|refresh|reload/i });
    if (retry) {
      const readsBefore = listArtifactReviews.mock.calls.length;
      await user.click(retry);
      await waitFor(() =>
        expect(listArtifactReviews.mock.calls.length).toBeGreaterThan(readsBefore)
      );
      expect(submitArtifactReviewDecision).toHaveBeenCalledTimes(1);
    }

    const reject = screen.getByRole('button', { name: /^reject$/i });
    expect(reject).toBeEnabled();
    await user.click(reject);
    await waitFor(() => expect(submitArtifactReviewDecision).toHaveBeenCalledTimes(2));
    expect(submitArtifactReviewDecision).toHaveBeenNthCalledWith(
      2,
      'ws1',
      PROPOSAL_REVIEW.artifactId,
      PROPOSAL_REVIEW.artifactVersion,
      { decision: 'rejected' }
    );
  });

  it('shows a successful decision only after the exact Review refetch settles', async () => {
    const user = userEvent.setup();
    let resolveReviews: ((value: { reviews: unknown[] }) => void) | undefined;
    const decidedReview = {
      ...PROPOSAL_REVIEW,
      decision: 'accepted' as const,
      decisionActorId: 'user_reviewer',
      decidedAt: '2026-07-21T00:02:00.000Z',
      appliedMaterialRevisionId: 'revision_applied',
    };
    const listArtifactReviews = vi
      .fn()
      .mockResolvedValueOnce({ reviews: [PROPOSAL_REVIEW] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReviews = resolve;
          })
      );
    const client = makeClient({
      core: { getArtifact: vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT) },
      app: { listArtifactReviews },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    await user.click(await screen.findByRole('button', { name: /^accept$/i }));
    await waitFor(() => expect(listArtifactReviews).toHaveBeenCalledTimes(2));
    expect(document.body).not.toHaveTextContent(/\baccepted\b/i);
    expect(screen.getByText(/awaiting decision/i)).toBeInTheDocument();

    resolveReviews?.({ reviews: [decidedReview] });

    const status = await screen.findByRole('status', { name: /artifact review/i });
    expect(status).toHaveTextContent(/^approved/i);
    expect(status).toHaveTextContent(`Version ${PROPOSAL_REVIEW.artifactVersion}`);
    expect(status).toHaveTextContent(PROPOSAL_REVIEW.contentDigest);
  });

  it('renders durable decision evidence without fabricating unavailable historical bytes', async () => {
    const newerArtifact = {
      ...PROPOSAL_ARTIFACT,
      version: 2,
      content: { format: 'markdown' as const, body: '# Unrelated newer artifact bytes\n' },
      contentDigest: `sha256:${'e'.repeat(64)}`,
    };
    const decidedReview = {
      ...PROPOSAL_REVIEW,
      decision: 'accepted' as const,
      decisionActorId: 'user_reviewer',
      decidedAt: '2026-07-21T00:02:00.000Z',
      appliedMaterialRevisionId: 'revision_applied',
    };
    const client = makeClient({
      core: { getArtifact: vi.fn().mockResolvedValue(newerArtifact) },
      app: { listArtifactReviews: vi.fn().mockResolvedValue({ reviews: [decidedReview] }) },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const status = await screen.findByRole('status', { name: /artifact review/i });
    expect(status).toHaveTextContent(/approved/i);
    expect(status).toHaveTextContent(`Version ${decidedReview.artifactVersion}`);
    expect(status).toHaveTextContent(decidedReview.contentDigest);
    expect(screen.getByText(decidedReview.decisionActorId)).toBeInTheDocument();
    expect(screen.getByText(/2026-07-21/)).toBeInTheDocument();
    expect(screen.getByText(decidedReview.appliedMaterialRevisionId)).toBeInTheDocument();
    const historicalReview = screen.getByRole('region', {
      name: /historical artifact review|reviewed artifact proposal/i,
    });
    expect(
      within(historicalReview).queryByText(PROPOSAL_ARTIFACT.content.body)
    ).not.toBeInTheDocument();
    expect(
      within(historicalReview).queryByText(newerArtifact.content.body)
    ).not.toBeInTheDocument();
  });

  it('maps every decided Review to fixed status vocabulary, tone, and separate decision evidence', async () => {
    const matrix = [
      {
        decision: 'accepted' as const,
        status: 'Approved',
        tone: 'positive' as const,
        evidence: 'Accepted',
      },
      {
        decision: 'rejected' as const,
        status: 'Rejected',
        tone: 'negative' as const,
        evidence: 'Rejected',
      },
      {
        decision: 'deferred' as const,
        status: 'Paused',
        tone: 'neutral' as const,
        evidence: 'Deferred',
      },
      {
        decision: 'needs_refinement' as const,
        status: 'Needs review',
        tone: 'notice' as const,
        evidence: 'Needs refinement',
      },
      {
        decision: 'redo' as const,
        status: 'In progress',
        tone: 'informative' as const,
        evidence: 'Redo',
      },
    ];

    for (const { decision, status: statusText, tone, evidence } of matrix) {
      const decidedReview = {
        ...PROPOSAL_REVIEW,
        decision,
        decisionActorId: 'user_reviewer',
        decidedAt: '2026-07-21T00:02:00.000Z',
        feedback:
          decision === 'needs_refinement' || decision === 'redo' ? 'Revise this output.' : null,
        followUpTurnId:
          decision === 'needs_refinement' || decision === 'redo' ? 'turn_follow_up' : null,
        appliedMaterialRevisionId: decision === 'accepted' ? 'revision_applied' : null,
      };
      const client = makeClient({
        core: { getArtifact: vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT) },
        app: { listArtifactReviews: vi.fn().mockResolvedValue({ reviews: [decidedReview] }) },
      });
      renderApp('/goals/ws1/th1/artifacts/artifact1', client);

      const status = await screen.findByRole('status', { name: /artifact review/i });
      const chip = within(status).queryByText(new RegExp(`^${statusText}$`, 'i'));
      expect.soft(chip, `${decision} status text`).not.toBeNull();
      if (chip) {
        expect.soft(chip, `${decision} status tone`).toHaveClass(...STATUS_CLASS[tone].split(' '));
      }
      const evidenceNodes = screen
        .queryAllByText(new RegExp(`^${evidence}$`, 'i'))
        .filter((node) => !status.contains(node));
      expect.soft(evidenceNodes, `${decision} decision evidence`).toHaveLength(1);
      if (decision === 'needs_refinement') {
        expect.soft(document.body).not.toHaveTextContent(/needs_refinement/i);
      }
      cleanup();
    }
  });

  it('disables every review write while the connection probe is checking', async () => {
    const client = makeClient({
      core: {
        meta: vi.fn().mockImplementation(() => new Promise(() => undefined)),
        getArtifact: vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT),
      },
      app: { listArtifactReviews: vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }) },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const actions = await Promise.all(
      [/^accept$/i, /request refinement/i, /^redo$/i, /^reject$/i, /^defer$/i].map((name) =>
        screen.findByRole('button', { name })
      )
    );
    for (const action of actions) expect(action).toBeDisabled();
  });

  it('keeps all review actions visible but disabled when disconnected', async () => {
    const client = makeClient({
      core: {
        meta: vi.fn().mockRejectedValue(new Error('down')),
        getArtifact: vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT),
      },
      app: { listArtifactReviews: vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }) },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const actions = await Promise.all(
      [/^accept$/i, /request refinement/i, /^redo$/i, /^reject$/i, /^defer$/i].map((name) =>
        screen.findByRole('button', { name })
      )
    );
    await waitFor(() => {
      for (const action of actions) expect(action).toBeDisabled();
    });
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it('disables every sibling decision while one mutation is pending', async () => {
    const user = userEvent.setup();
    const submitArtifactReviewDecision = vi.fn().mockImplementation(() => new Promise(() => {}));
    const client = makeClient({
      core: { getArtifact: vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT) },
      app: {
        listArtifactReviews: vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }),
        submitArtifactReviewDecision,
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const actions = await Promise.all(
      [/^accept$/i, /request refinement/i, /^redo$/i, /^reject$/i, /^defer$/i].map((name) =>
        screen.findByRole('button', { name })
      )
    );
    await user.click(actions[0]);
    await waitFor(() => expect(submitArtifactReviewDecision).toHaveBeenCalledOnce());
    for (const action of actions) expect(action).toBeDisabled();
  });
});
