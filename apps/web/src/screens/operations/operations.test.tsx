import {
  AppSearchResponseSchema,
  CancelSchedulerAdmissionResponseSchema,
  InterruptedWorkerStateSchema,
  RetryInterruptedWorkerCheckpointResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
  SchedulerAdmissionReadModelSchema,
} from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { isSurfaceLive } from '../../app/flags';
import { AppRoutes } from '../../app/routes';
import { surfaceById } from '../../app/surfaces';
import { useWorkspaceStore } from '../workspace-store';

const TIMESTAMP = '2026-07-21T12:00:00.000Z';
const HOST_PATH = '/Users/secret/openkit-runtime';
const RAW_HANDLE = 'sandbox-pid-7777-gateway-xyz';
const POISON_SECRET = 'sk-secret-should-never-render';
const SEARCH_QUERY = 'pricing';
const WORKSPACE = { id: 'ws1', name: 'Market research' } as const;
const WORKSPACE_B = { id: 'ws2', name: 'Second workspace' } as const;

const WORKER_BASE = {
  kind: 'interrupted_worker_state' as const,
  goalId: null,
  taskId: null,
  iteration: 1,
  workerSessionId: RAW_HANDLE,
  contextDigest: 'sha256:private-context-digest',
  contextAssembly: null,
  stopReason: null,
  replayInstruction: false as const,
  materializedAt: TIMESTAMP,
  sourceUpdatedAt: TIMESTAMP,
};

/** Parses one interrupted-worker fixture, including schema-true null diagnostics. */
function interruptedWorkerState(input: unknown) {
  const parsed = InterruptedWorkerStateSchema.parse(input);
  return {
    ...parsed,
    workspaceCwd: HOST_PATH,
    secret: POISON_SECRET,
  };
}

/** Parses one interrupted-worker fixture and keeps diagnosticsSummary schema-true and non-null. */
function interruptedWorker(input: unknown) {
  const parsed = interruptedWorkerState(input);
  if (parsed.diagnosticsSummary === null) {
    throw new Error(`${parsed.checkpointId} requires a non-null diagnosticsSummary`);
  }
  return {
    ...parsed,
    diagnosticsSummary: parsed.diagnosticsSummary,
  };
}

const INTERRUPTED_WORKER = interruptedWorker({
  ...WORKER_BASE,
  checkpointId: 'ckpt_1',
  workspaceId: WORKSPACE.id,
  threadId: 'th_worker',
  turnId: 'tu_worker',
  stage: 'running_worker',
  diagnosticsSummary: 'Interrupted during running_worker.',
  choices: [
    { kind: 'inspect', label: 'Inspect interrupted worker evidence', recommended: true },
    { kind: 'retry', label: 'Retry interrupted worker turn' },
  ],
});

const INSPECT_WORKER = interruptedWorker({
  ...WORKER_BASE,
  checkpointId: 'ckpt_inspect',
  workspaceId: WORKSPACE.id,
  threadId: 'th_inspect',
  turnId: 'tu_inspect',
  stage: 'waiting_for_user',
  diagnosticsSummary: 'Waiting for a human decision.',
  contextDigest: 'sha256:inspect-context-digest',
  stopReason: 'ask_user',
  choices: [
    { kind: 'inspect', label: 'Inspect interrupted worker evidence', recommended: true },
    { kind: 'request_human', label: 'Ask the user how to recover this worker turn' },
  ],
});

const NULL_DIAGNOSTICS_WORKER = interruptedWorkerState({
  ...WORKER_BASE,
  checkpointId: 'ckpt_null_diag',
  workspaceId: WORKSPACE.id,
  threadId: 'th_null_diag',
  turnId: 'tu_null_diag',
  stage: 'failed',
  diagnosticsSummary: null,
  contextDigest: 'sha256:null-diag-context-digest',
  stopReason: 'error',
  choices: [
    { kind: 'inspect', label: 'Inspect interrupted worker evidence', recommended: true },
    { kind: 'request_human', label: 'Ask the user how to recover this worker turn' },
  ],
});

const INELIGIBLE_AFTER_RECOVERY = interruptedWorker({
  ...INTERRUPTED_WORKER,
  choices: [
    { kind: 'inspect', label: 'Inspect interrupted worker evidence', recommended: true },
    { kind: 'request_human', label: 'Ask the user how to recover this worker turn' },
  ],
});
const INELIGIBLE_AFTER_STALE_READ = interruptedWorker({
  ...INELIGIBLE_AFTER_RECOVERY,
  diagnosticsSummary: 'Interrupted worker now needs a human decision.',
});

const WORKSPACE_B_WORKER = interruptedWorker({
  ...WORKER_BASE,
  checkpointId: 'ckpt_ws2',
  workspaceId: WORKSPACE_B.id,
  threadId: 'th_ws2_worker',
  turnId: 'tu_ws2_worker',
  stage: 'running_worker',
  diagnosticsSummary: 'Interrupted in the second workspace.',
  choices: [
    { kind: 'inspect', label: 'Inspect interrupted worker evidence', recommended: true },
    { kind: 'retry', label: 'Retry interrupted worker turn' },
  ],
});

const ELIGIBLE_PEER_WORKER = interruptedWorker({
  ...WORKER_BASE,
  checkpointId: 'ckpt_peer',
  workspaceId: WORKSPACE.id,
  threadId: 'th_peer',
  turnId: 'tu_peer',
  stage: 'running_worker',
  diagnosticsSummary: 'Unrelated interrupted worker remains eligible.',
  choices: [
    { kind: 'inspect', label: 'Inspect interrupted worker evidence', recommended: true },
    { kind: 'retry', label: 'Retry interrupted worker turn' },
  ],
});
const SAME_WORKSPACE_RETRYABLE_WORKERS = [
  INTERRUPTED_WORKER,
  ELIGIBLE_PEER_WORKER,
  INSPECT_WORKER,
  WORKSPACE_B_WORKER,
];

const DENIED_ADMISSION = {
  ...SchedulerAdmissionReadModelSchema.parse({
    queueEntryId: 'q_denied',
    requestId: 'req_denied',
    workspaceId: WORKSPACE.id,
    threadId: 'th_denied',
    turnId: 'tu_denied',
    requestedAgentId: 'agent_scout',
    profileRef: 'scout/default',
    priorityClass: 'interactive',
    enqueuedAt: TIMESTAMP,
    effectivePriorityAt: TIMESTAMP,
    firstCapDeferredAt: null,
    requiredPoolConstraints: ['linux'],
    status: 'denied',
    denialReason: 'no-healthy-target',
    queuePosition: null,
  }),
  workspaceCwd: HOST_PATH,
  runtimeHandle: RAW_HANDLE,
  secret: POISON_SECRET,
};

const QUEUED_ADMISSION = SchedulerAdmissionReadModelSchema.parse({
  ...DENIED_ADMISSION,
  queueEntryId: 'q_queued',
  requestId: 'req_queued',
  threadId: 'th_queued',
  turnId: 'tu_queued',
  status: 'queued',
  denialReason: null,
  queuePosition: 1,
});

const RETRIED_ADMISSION = SchedulerAdmissionReadModelSchema.parse({
  ...DENIED_ADMISSION,
  status: 'queued',
  denialReason: null,
  queuePosition: 2,
});

const WORKSPACE_B_QUEUED = SchedulerAdmissionReadModelSchema.parse({
  ...QUEUED_ADMISSION,
  queueEntryId: 'q_ws2',
  requestId: 'req_ws2',
  workspaceId: WORKSPACE_B.id,
  threadId: 'th_ws2_sched',
  turnId: 'tu_ws2_sched',
  requestedAgentId: 'agent_ops',
  queuePosition: 3,
});

const WORKSPACE_B_DENIED = SchedulerAdmissionReadModelSchema.parse({
  ...DENIED_ADMISSION,
  queueEntryId: 'q_ws2_denied',
  requestId: 'req_ws2_denied',
  workspaceId: WORKSPACE_B.id,
  threadId: 'th_ws2_denied',
  turnId: 'tu_ws2_denied',
  requestedAgentId: 'agent_ops',
});

const WORKSPACE_B_DENIED_RETRIED = SchedulerAdmissionReadModelSchema.parse({
  ...WORKSPACE_B_DENIED,
  status: 'queued',
  denialReason: null,
  queuePosition: 4,
});

const SEARCH_THREAD = {
  ...AppSearchResponseSchema.parse({
    items: [
      {
        kind: 'thread',
        id: 'th_search',
        title: 'Competitive pricing report',
        workspaceId: WORKSPACE.id,
      },
    ],
  }).items[0]!,
  secret: POISON_SECRET,
  localPath: HOST_PATH,
};

const EMPTY_SEARCH = AppSearchResponseSchema.parse({ items: [] });
const SEARCH_CROSS_WORKSPACE = {
  ...AppSearchResponseSchema.parse({
    items: [
      {
        kind: 'thread',
        id: 'th_ws2_search',
        title: 'Second-workspace pricing thread',
        workspaceId: WORKSPACE_B.id,
      },
    ],
  }).items[0]!,
  secret: POISON_SECRET,
  localPath: HOST_PATH,
};
const SEARCH_WORKSPACE = {
  ...AppSearchResponseSchema.parse({
    items: [
      {
        kind: 'workspace',
        id: WORKSPACE_B.id,
        title: WORKSPACE_B.name,
      },
    ],
  }).items[0]!,
  secret: POISON_SECRET,
  localPath: HOST_PATH,
};
const WORKER_RELEASE_ACTION = /release checkpoint|fresh attempt/i;
const WORKER_RETRY_SUCCESS = RetryInterruptedWorkerCheckpointResponseSchema.parse({
  outcome: 'released_for_retry',
  turnId: INTERRUPTED_WORKER.turnId,
});
const WORKSPACE_B_WORKER_RETRY = RetryInterruptedWorkerCheckpointResponseSchema.parse({
  outcome: 'released_for_retry',
  turnId: WORKSPACE_B_WORKER.turnId,
});
const WORKER_RETRY_MUTATION = RetryInterruptedWorkerCheckpointResponseSchema.parse({
  outcome: 'released_for_retry',
  turnId: 'mutation-only-turn',
});
const SCHEDULER_RETRY_MUTATION = RetrySchedulerAdmissionResponseSchema.parse({ retried: true });
const SCHEDULER_CANCEL_MUTATION = CancelSchedulerAdmissionResponseSchema.parse({ cancelled: true });

const ALL_WORKERS = [INTERRUPTED_WORKER, INSPECT_WORKER, WORKSPACE_B_WORKER];

type AppOverrides = Partial<CoreClient['app']>;
type CoreOverrides = Partial<CoreClient['core']>;
type User = ReturnType<typeof userEvent.setup>;

/** Creates a caller-controlled promise for proving pre-settlement UI state. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/** Returns scheduler admissions owned by one selected Workspace. */
function schedulerItemsFor(workspaceId: string) {
  return workspaceId === WORKSPACE_B.id
    ? [WORKSPACE_B_QUEUED]
    : [DENIED_ADMISSION, QUEUED_ADMISSION];
}

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(app: AppOverrides = {}, core: CoreOverrides = {}): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi.fn().mockResolvedValue({ items: [WORKSPACE, WORKSPACE_B] }),
      listThreads: vi.fn().mockResolvedValue({ items: [] }),
      ...core,
    },
    app: {
      listAuthorizedWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
      getWorkspaceDashboard: vi.fn().mockResolvedValue({ activeWork: [] }),
      listInterruptedWorkers: vi.fn().mockResolvedValue({ items: ALL_WORKERS }),
      retryInterruptedWorkerCheckpoint: vi.fn().mockResolvedValue(WORKER_RETRY_SUCCESS),
      listSchedulerAdmissions: vi
        .fn()
        .mockImplementation((workspaceId: string) =>
          Promise.resolve({ items: schedulerItemsFor(workspaceId) })
        ),
      retrySchedulerAdmission: vi.fn().mockResolvedValue(SCHEDULER_RETRY_MUTATION),
      cancelSchedulerAdmission: vi.fn().mockResolvedValue(SCHEDULER_CANCEL_MUTATION),
      search: vi.fn().mockResolvedValue({ items: [SEARCH_THREAD] }),
      ...app,
    },
    agents: {
      list: vi.fn().mockResolvedValue({ items: [] }),
    },
    actionCenter: {
      listHumanAttention: vi.fn().mockResolvedValue({ items: [] }),
    },
  } as unknown as CoreClient;
}

function LocationProbe({ onChange }: { onChange: (pathname: string) => void }) {
  const location = useLocation();
  onChange(location.pathname);
  return null;
}

function renderApp(path: string, client: CoreClient, onLocation?: (pathname: string) => void) {
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
  return client;
}

/** Types one global search query and submits it. */
async function submitSearch(user: User, query = SEARCH_QUERY) {
  const searchbox = screen.queryByRole('searchbox', { name: /search/i });
  if (!searchbox) {
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(await screen.findByRole('searchbox', { name: /search/i }), query);
  } else {
    await user.type(searchbox, query);
  }
  await user.keyboard('{Enter}');
}

/** Returns the nearest row container for one labeled recovery item. */
function rowFor(region: HTMLElement, label: string) {
  const node = within(region).getByText(label);
  const row = node.closest('li, article, [role="listitem"]') ?? node.parentElement;
  if (!(row instanceof HTMLElement)) {
    throw new Error(`missing recovery row for ${label}`);
  }
  return row;
}

/** Treats a missing control and a disabled control as equally unusable. */
function expectActionUnavailable(scope: HTMLElement, name: string | RegExp) {
  for (const button of within(scope).queryAllByRole('button', { name })) {
    expect(button).toBeDisabled();
  }
}

/** Worker mutation controls: truthful release/fresh-attempt copy, or current generic Retry. */
function workerActionButtons(scope: HTMLElement) {
  const release = within(scope).queryAllByRole('button', { name: WORKER_RELEASE_ACTION });
  return release.length > 0 ? release : within(scope).queryAllByRole('button', { name: 'Retry' });
}

/** Returns the one worker mutation control in a row or workers region. */
function workerActionButton(scope: HTMLElement) {
  const buttons = workerActionButtons(scope);
  if (buttons.length === 0) {
    throw new Error('missing worker mutation action');
  }
  return buttons[0]!;
}

/** Worker mutation is absent or disabled, including generic Retry copy. */
function expectWorkerActionUnavailable(scope: HTMLElement) {
  expectActionUnavailable(scope, WORKER_RELEASE_ACTION);
  expectActionUnavailable(scope, 'Retry');
}

/** Captures the stable request identity from one interrupted-worker retry. */
function workerRetryRequestId(retry: ReturnType<typeof vi.fn>) {
  const requestId = retry.mock.calls[0]?.[3].requestId;
  expect(requestId).toEqual(expect.any(String));
  return requestId as string;
}

/** Returns retryInterruptedWorkerCheckpoint calls for one exact worker lineage. */
function workerRetryCallsFor(
  retry: ReturnType<typeof vi.fn>,
  worker: Pick<typeof INTERRUPTED_WORKER, 'workspaceId' | 'threadId' | 'turnId'>
) {
  return retry.mock.calls.filter(
    (call) =>
      call[0] === worker.workspaceId && call[1] === worker.threadId && call[2] === worker.turnId
  );
}

/** Returns listSchedulerAdmissions calls for one Workspace. */
function schedulerReadsFor(list: ReturnType<typeof vi.fn>, workspaceId: string) {
  return list.mock.calls.filter((call) => call[0] === workspaceId);
}

const INSPECT_FIELD_LABELS = [
  ['Checkpoint ID', INSPECT_WORKER.checkpointId],
  ['Turn ID', INSPECT_WORKER.turnId],
  ['Stage', INSPECT_WORKER.stage],
  ['Context digest', INSPECT_WORKER.contextDigest as string],
  ['Stop reason', INSPECT_WORKER.stopReason as string],
] as const;

/** Returns the ARIA inspect toggle and its controlled panel for one worker row. */
function inspectDisclosure(row: HTMLElement) {
  const toggle = within(row).getByRole('button', { name: /inspect/i });
  expect(toggle).toHaveAttribute('aria-expanded');
  expect(toggle).toHaveAttribute('aria-controls');
  const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  expect(panel).toBeInstanceOf(HTMLElement);
  return { toggle, panel: panel as HTMLElement };
}

/** Asserts inspect is collapsed and every labeled diagnostic field value is absent. */
function expectInspectCollapsed(row: HTMLElement) {
  const disclosure = inspectDisclosure(row);
  expect(disclosure.toggle).toHaveAttribute('aria-expanded', 'false');
  for (const [label, value] of INSPECT_FIELD_LABELS) {
    expect(within(row).queryByText(label, { exact: true })).toBeNull();
    expect(within(row).queryByText(value, { exact: true })).toBeNull();
  }
}

/** Asserts inspect is expanded and each diagnostic field has an explicit accessible label. */
function expectInspectExpanded(row: HTMLElement) {
  const disclosure = inspectDisclosure(row);
  expect(disclosure.toggle).toHaveAttribute('aria-expanded', 'true');
  for (const [label, value] of INSPECT_FIELD_LABELS) {
    expect(within(disclosure.panel).getByText(label, { exact: true })).toBeInTheDocument();
    expect(within(disclosure.panel).getByText(value, { exact: true })).toBeInTheDocument();
  }
}

/** Clicks the inspect disclosure toggle. */
async function toggleInspect(user: User, row: HTMLElement) {
  await user.click(within(row).getByRole('button', { name: /inspect/i }));
}

function poisonDom() {
  const serialized = document.documentElement.outerHTML;
  expect(serialized).not.toContain(HOST_PATH);
  expect(serialized).not.toContain(RAW_HANDLE);
  expect(serialized).not.toContain(POISON_SECRET);
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('Recovery and search', () => {
  it('groups interrupted-worker and scheduler recovery on a published workflow', async () => {
    const user = userEvent.setup();
    let pathname = '';
    const client = makeClient();
    renderApp('/recovery', client, (next) => {
      pathname = next;
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Recovery' })).toBeInTheDocument();
    expect(screen.queryByText(/not yet backed by the kernel/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't exist/i)).not.toBeInTheDocument();

    const destinations = await screen.findByRole('group', { name: 'Workspace destinations' });
    const navButton = screen.getByRole('button', { name: 'Recovery' });
    expect(destinations).toContainElement(navButton);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(workers).getByText(INSPECT_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(
      within(workers).queryByText(WORKSPACE_B_WORKER.diagnosticsSummary)
    ).not.toBeInTheDocument();
    expect(workerActionButtons(workers)).toHaveLength(1);

    const inspectRow = rowFor(workers, INSPECT_WORKER.diagnosticsSummary);
    expect(workerActionButtons(inspectRow)).toHaveLength(0);
    const inspectAffordance = within(inspectRow).queryByRole('button', { name: /inspect/i });
    if (inspectAffordance) {
      await user.click(inspectAffordance);
    }
    expect(client.app.retryInterruptedWorkerCheckpoint).not.toHaveBeenCalled();

    const scheduler = screen.getByRole('region', { name: 'Scheduler admissions' });
    expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument();
    expect(within(scheduler).getByText('Queued', { exact: true })).toBeInTheDocument();
    expect(within(scheduler).getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    expect(within(scheduler).getAllByRole('button', { name: 'Cancel' })).toHaveLength(2);
    expect(within(scheduler).queryByText('agent_ops', { exact: true })).not.toBeInTheDocument();

    expect(
      screen.queryByRole('button', {
        name: /listInterruptedWorkers|retryInterruptedWorkerCheckpoint|listSchedulerAdmissions|searchApp/i,
      })
    ).toBeNull();
    poisonDom();

    await waitFor(() => {
      expect(vi.mocked(client.app.listInterruptedWorkers).mock.calls).toEqual([[]]);
      expect(vi.mocked(client.app.listSchedulerAdmissions).mock.calls).toEqual([[WORKSPACE.id]]);
    });
    expect(client.app.search).not.toHaveBeenCalled();
    expect(client.app.retryInterruptedWorkerCheckpoint).not.toHaveBeenCalled();
    expect(pathname).toBe('/recovery');

    const surface = surfaceById('recovery');
    expect(surface).toMatchObject({
      title: 'Recovery',
      path: '/recovery',
      tier: 'A',
      nav: 'workspace-compact',
    });
    expect(isSurfaceLive(surface!)).toBe(true);
  });

  it('keeps cached recovery actions disabled across route remount until authoritative reads succeed', async () => {
    const user = userEvent.setup();
    const workerReread = createDeferred<{ items: unknown[] }>();
    const schedulerReread = createDeferred<{ items: unknown[] }>();
    const listInterruptedWorkers = vi
      .fn()
      .mockResolvedValueOnce({ items: ALL_WORKERS })
      .mockReturnValueOnce(workerReread.promise);
    const listSchedulerAdmissions = vi
      .fn()
      .mockResolvedValueOnce({ items: schedulerItemsFor(WORKSPACE.id) })
      .mockReturnValueOnce(schedulerReread.promise);
    const client = makeClient({ listInterruptedWorkers, listSchedulerAdmissions });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const scheduler = await screen.findByRole('region', { name: 'Scheduler admissions' });
    await waitFor(() => expect(workerActionButton(workers)).toBeEnabled());
    expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Recovery' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Recovery' })).toBeInTheDocument();
    await waitFor(() => {
      expect(listInterruptedWorkers).toHaveBeenCalledTimes(2);
      expect(listSchedulerAdmissions).toHaveBeenCalledTimes(2);
    });

    expectWorkerActionUnavailable(screen.getByRole('region', { name: 'Interrupted workers' }));
    expectActionUnavailable(screen.getByRole('region', { name: 'Scheduler admissions' }), 'Retry');
    expectActionUnavailable(screen.getByRole('region', { name: 'Scheduler admissions' }), 'Cancel');

    await act(async () => {
      workerReread.reject(new Error('worker reread failed'));
      schedulerReread.reject(new Error('scheduler reread failed'));
      await Promise.allSettled([workerReread.promise, schedulerReread.promise]);
    });

    const remountedWorkers = screen.getByRole('region', { name: 'Interrupted workers' });
    const remountedScheduler = screen.getByRole('region', { name: 'Scheduler admissions' });
    expect(await within(remountedWorkers).findByRole('alert')).toHaveTextContent(
      /couldn't load interrupted workers/i
    );
    expect(await within(remountedScheduler).findByRole('alert')).toHaveTextContent(
      /couldn't load scheduler admissions/i
    );
    expectWorkerActionUnavailable(remountedWorkers);
    expectActionUnavailable(remountedScheduler, 'Retry');
    expectActionUnavailable(remountedScheduler, 'Cancel');
    expect(client.app.retryInterruptedWorkerCheckpoint).not.toHaveBeenCalled();
    expect(client.app.retrySchedulerAdmission).not.toHaveBeenCalled();
    expect(client.app.cancelSchedulerAdmission).not.toHaveBeenCalled();
    poisonDom();
  });

  it('verifies cached scheduler admissions per Workspace after route remount', async () => {
    const user = userEvent.setup();
    const workspaceBReread = createDeferred<{ items: unknown[] }>();
    let workspaceAReads = 0;
    let workspaceBReads = 0;
    const listSchedulerAdmissions = vi.fn().mockImplementation((workspaceId: string) => {
      if (workspaceId === WORKSPACE.id) {
        workspaceAReads += 1;
        return Promise.resolve({ items: [DENIED_ADMISSION] });
      }
      workspaceBReads += 1;
      if (workspaceBReads === 1) return Promise.resolve({ items: [WORKSPACE_B_DENIED] });
      return workspaceBReread.promise;
    });
    const client = makeClient({ listSchedulerAdmissions });
    renderApp('/recovery', client);

    const scheduler = await screen.findByRole('region', { name: 'Scheduler admissions' });
    await waitFor(() =>
      expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled()
    );
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(scheduler).getByText('agent_ops', { exact: true })).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled()
    );

    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    await user.click(screen.getByRole('button', { name: 'Recovery' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Recovery' })).toBeInTheDocument();
    await waitFor(() => expect(workspaceAReads).toBeGreaterThan(1));
    const remountedScheduler = screen.getByRole('region', { name: 'Scheduler admissions' });
    await waitFor(() =>
      expect(within(remountedScheduler).getByRole('button', { name: 'Retry' })).toBeEnabled()
    );

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() => expect(workspaceBReads).toBe(2));
    await waitFor(() =>
      expect(within(remountedScheduler).getByText('agent_ops', { exact: true })).toBeInTheDocument()
    );
    expectActionUnavailable(remountedScheduler, 'Retry');
    expectActionUnavailable(remountedScheduler, 'Cancel');

    await act(async () => {
      workspaceBReread.reject(new Error('workspace B scheduler reread failed'));
      await Promise.allSettled([workspaceBReread.promise]);
    });
    expect(await within(remountedScheduler).findByRole('alert')).toHaveTextContent(
      /couldn't load scheduler admissions/i
    );
    expectActionUnavailable(remountedScheduler, 'Retry');
    expectActionUnavailable(remountedScheduler, 'Cancel');
    expect(client.app.retrySchedulerAdmission).not.toHaveBeenCalled();
    expect(client.app.cancelSchedulerAdmission).not.toHaveBeenCalled();
    poisonDom();
  });

  it('filters recovery rows to the selected Workspace and retries with that row lineage after switch', async () => {
    const user = userEvent.setup();
    const workspaceBScheduler = createDeferred<{ items: unknown[] }>();
    const retryInterruptedWorkerCheckpoint = vi.fn().mockResolvedValue(WORKSPACE_B_WORKER_RETRY);
    const listSchedulerAdmissions = vi.fn().mockImplementation((workspaceId: string) => {
      if (workspaceId === WORKSPACE_B.id) return workspaceBScheduler.promise;
      return Promise.resolve({ items: schedulerItemsFor(workspaceId) });
    });
    const client = makeClient({ retryInterruptedWorkerCheckpoint, listSchedulerAdmissions });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(workers).queryByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeNull();
    const scheduler = screen.getByRole('region', { name: 'Scheduler admissions' });
    expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument();
    expect(within(scheduler).queryByText('agent_ops', { exact: true })).toBeNull();
    expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled();

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));

    await waitFor(() =>
      expect(listSchedulerAdmissions.mock.calls).toEqual([[WORKSPACE.id], [WORKSPACE_B.id]])
    );
    expect(vi.mocked(client.app.listInterruptedWorkers).mock.calls).toEqual([[]]);
    expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull();
    expect(within(workers).queryByText(INSPECT_WORKER.diagnosticsSummary)).toBeNull();
    expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(scheduler).queryByText('agent_ops', { exact: true })).toBeNull();
    expectActionUnavailable(scheduler, 'Retry');
    expectActionUnavailable(scheduler, 'Cancel');
    const staleRetry = within(scheduler).queryByRole('button', { name: 'Retry' });
    if (staleRetry) {
      await user.click(staleRetry);
    }
    expect(client.app.retrySchedulerAdmission).not.toHaveBeenCalled();
    expect(client.app.cancelSchedulerAdmission).not.toHaveBeenCalled();

    workspaceBScheduler.resolve({ items: [WORKSPACE_B_QUEUED] });
    await waitFor(() =>
      expect(within(scheduler).getByText('agent_ops', { exact: true })).toBeInTheDocument()
    );
    expect(within(scheduler).queryByText('Denied', { exact: true })).toBeNull();
    expect(within(scheduler).getByText('Queued', { exact: true })).toBeInTheDocument();
    expect(within(scheduler).queryByRole('button', { name: 'Retry' })).toBeNull();

    await user.click(workerActionButton(workers));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1));
    const requestId = workerRetryRequestId(retryInterruptedWorkerCheckpoint);
    expect(retryInterruptedWorkerCheckpoint.mock.calls).toEqual([
      [
        WORKSPACE_B_WORKER.workspaceId,
        WORKSPACE_B_WORKER.threadId,
        WORKSPACE_B_WORKER.turnId,
        { requestId },
      ],
    ]);
    poisonDom();
  });

  it('retries and cancels through the typed client then settles from an authoritative refetch', async () => {
    const user = userEvent.setup();
    const workerRead = createDeferred<{ items: unknown[] }>();
    const retryRead = createDeferred<{ items: unknown[] }>();
    const cancelRead = createDeferred<{ items: unknown[] }>();
    const listInterruptedWorkers = vi
      .fn()
      .mockResolvedValueOnce({ items: ALL_WORKERS })
      .mockReturnValueOnce(workerRead.promise);
    const listSchedulerAdmissions = vi
      .fn()
      .mockResolvedValueOnce({ items: [DENIED_ADMISSION] })
      .mockReturnValueOnce(retryRead.promise)
      .mockReturnValueOnce(cancelRead.promise);
    const retryInterruptedWorkerCheckpoint = vi.fn().mockResolvedValue(WORKER_RETRY_MUTATION);
    const retrySchedulerAdmission = vi.fn().mockResolvedValue(SCHEDULER_RETRY_MUTATION);
    const cancelSchedulerAdmission = vi.fn().mockResolvedValue(SCHEDULER_CANCEL_MUTATION);
    const client = makeClient({
      listInterruptedWorkers,
      listSchedulerAdmissions,
      retryInterruptedWorkerCheckpoint,
      retrySchedulerAdmission,
      cancelSchedulerAdmission,
    });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const workerRetry = workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    await user.click(workerRetry);

    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1));
    expect(workerRetry).toBeDisabled();
    await user.click(workerRetry);
    expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1);
    const workerRequestId = workerRetryRequestId(retryInterruptedWorkerCheckpoint);
    expect(retryInterruptedWorkerCheckpoint.mock.calls).toEqual([
      [
        WORKSPACE.id,
        INTERRUPTED_WORKER.threadId,
        INTERRUPTED_WORKER.turnId,
        { requestId: workerRequestId },
      ],
    ]);
    await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(2));
    expect(
      workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary))
    ).toBeDisabled();
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(screen.queryByText(WORKER_RETRY_MUTATION.turnId)).not.toBeInTheDocument();
    expect(screen.queryByText(WORKER_RETRY_MUTATION.outcome)).not.toBeInTheDocument();

    workerRead.resolve({ items: [INSPECT_WORKER, WORKSPACE_B_WORKER] });
    await waitFor(() =>
      expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull()
    );

    const scheduler = screen.getByRole('region', { name: 'Scheduler admissions' });
    const schedulerRetry = within(scheduler).getByRole('button', { name: 'Retry' });
    await user.click(schedulerRetry);

    await waitFor(() =>
      expect(retrySchedulerAdmission.mock.calls).toEqual([
        [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
      ])
    );
    expect(schedulerRetry).toBeDisabled();
    await user.click(schedulerRetry);
    expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listSchedulerAdmissions).toHaveBeenCalledTimes(2));
    expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument();

    retryRead.resolve({ items: [RETRIED_ADMISSION] });
    await waitFor(() =>
      expect(within(scheduler).queryByText('Denied', { exact: true })).toBeNull()
    );
    expect(within(scheduler).getByText('Queued', { exact: true })).toBeInTheDocument();
    expect(within(scheduler).queryByRole('button', { name: 'Retry' })).toBeNull();

    const cancel = within(scheduler).getByRole('button', { name: 'Cancel' });
    await user.click(cancel);

    await waitFor(() =>
      expect(cancelSchedulerAdmission.mock.calls).toEqual([
        [WORKSPACE.id, RETRIED_ADMISSION.queueEntryId],
      ])
    );
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    expect(cancelSchedulerAdmission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listSchedulerAdmissions).toHaveBeenCalledTimes(3));
    expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    cancelRead.resolve({ items: [] });
    await waitFor(() =>
      expect(within(scheduler).queryByText('Queued', { exact: true })).toBeNull()
    );
    expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1);
    expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);
    expect(cancelSchedulerAdmission).toHaveBeenCalledTimes(1);
    poisonDom();
  });

  it.each([
    {
      name: 'remains eligible',
      items: ALL_WORKERS,
      retryAfterRead: true,
    },
    {
      name: 'is no longer retryable',
      items: [INELIGIBLE_AFTER_RECOVERY, INSPECT_WORKER, WORKSPACE_B_WORKER],
      retryAfterRead: false,
    },
  ])('keeps stale worker retry hidden after recovery_required until the returned row $name', async (scenario) => {
    const user = userEvent.setup();
    const recoveryRead = createDeferred<{ items: unknown[] }>();
    const listInterruptedWorkers = vi
      .fn()
      .mockResolvedValueOnce({ items: ALL_WORKERS })
      .mockReturnValue(recoveryRead.promise);
    const retryInterruptedWorkerCheckpoint = vi
      .fn()
      .mockRejectedValue(
        new ApiCallError(409, 'recovery-private failure', { code: 'recovery_required' })
      );
    const client = makeClient({
      listInterruptedWorkers,
      retryInterruptedWorkerCheckpoint,
    });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const scheduler = screen.getByRole('region', { name: 'Scheduler admissions' });
    expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument();
    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1));
    expect(workerRetryRequestId(retryInterruptedWorkerCheckpoint)).toEqual(expect.any(String));

    const alert = await within(workers).findByRole('alert');
    expect(within(alert).getByText('Recovery required', { exact: true })).toBeInTheDocument();
    expect(alert).not.toHaveTextContent('recovery-private failure');
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    expect(within(scheduler).queryByRole('alert')).toBeNull();
    expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled();

    if (listInterruptedWorkers.mock.calls.length === 1) {
      await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    }
    await waitFor(() => expect(listInterruptedWorkers.mock.calls.length).toBeGreaterThan(1));
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.app.listSchedulerAdmissions).mock.calls).toEqual([[WORKSPACE.id]]);

    recoveryRead.resolve({ items: scenario.items });
    if (scenario.retryAfterRead) {
      await waitFor(() =>
        expect(
          workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary))
        ).toBeEnabled()
      );
    } else {
      await waitFor(() =>
        expect(workerActionButtons(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary))).toEqual(
          []
        )
      );
    }
    expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1);
    expect(client.app.retrySchedulerAdmission).not.toHaveBeenCalled();
    expect(client.app.cancelSchedulerAdmission).not.toHaveBeenCalled();
    poisonDom();
  });

  it.each([
    {
      name: 'retry failed',
      action: 'Retry',
      label: 'Denied',
      mutate: 'retrySchedulerAdmission' as const,
      code: 'scheduler_admission_retry_failed',
      status: 400,
      message: /couldn't retry scheduler admission/i,
      args: [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
    },
    {
      name: 'cancel failed',
      action: 'Cancel',
      label: 'Queued',
      mutate: 'cancelSchedulerAdmission' as const,
      code: 'scheduler_admission_cancel_failed',
      status: 400,
      message: /couldn't cancel scheduler admission/i,
      args: [WORKSPACE.id, QUEUED_ADMISSION.queueEntryId],
    },
    {
      name: 'retry access denied',
      action: 'Retry',
      label: 'Denied',
      mutate: 'retrySchedulerAdmission' as const,
      code: 'workspace_access_denied',
      status: 403,
      message: /access denied/i,
      args: [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
    },
  ])('isolates a scheduler $name failure and retries only the admissions read', async (scenario) => {
    const user = userEvent.setup();
    const failure = new ApiCallError(scenario.status, 'scheduler-private failure', {
      code: scenario.code,
    });
    const retrySchedulerAdmission =
      scenario.mutate === 'retrySchedulerAdmission'
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue(SCHEDULER_RETRY_MUTATION);
    const cancelSchedulerAdmission =
      scenario.mutate === 'cancelSchedulerAdmission'
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue(SCHEDULER_CANCEL_MUTATION);
    const client = makeClient({ retrySchedulerAdmission, cancelSchedulerAdmission });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const scheduler = screen.getByRole('region', { name: 'Scheduler admissions' });
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(scheduler).getByText(scenario.label, { exact: true })).toBeInTheDocument();

    await user.click(
      within(rowFor(scheduler, scenario.label)).getByRole('button', { name: scenario.action })
    );
    const mutate =
      scenario.mutate === 'retrySchedulerAdmission'
        ? retrySchedulerAdmission
        : cancelSchedulerAdmission;
    await waitFor(() => expect(mutate.mock.calls).toEqual([scenario.args]));

    const alert = await within(scheduler).findByRole('alert');
    expect(alert).toHaveTextContent(scenario.message);
    expect(alert).not.toHaveTextContent('scheduler-private failure');
    expect(within(scheduler).getByText(scenario.label, { exact: true })).toBeInTheDocument();
    expect(within(workers).queryByRole('alert')).toBeNull();
    expect(workerActionButton(workers)).toBeEnabled();

    const workersBefore = vi.mocked(client.app.listInterruptedWorkers).mock.calls.length;
    const schedulerBefore = vi.mocked(client.app.listSchedulerAdmissions).mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(vi.mocked(client.app.listSchedulerAdmissions)).toHaveBeenCalledTimes(
        schedulerBefore + 1
      )
    );
    expect(vi.mocked(client.app.listInterruptedWorkers)).toHaveBeenCalledTimes(workersBefore);
    expect(retrySchedulerAdmission).toHaveBeenCalledTimes(
      scenario.mutate === 'retrySchedulerAdmission' ? 1 : 0
    );
    expect(cancelSchedulerAdmission).toHaveBeenCalledTimes(
      scenario.mutate === 'cancelSchedulerAdmission' ? 1 : 0
    );
    expect(client.app.retryInterruptedWorkerCheckpoint).not.toHaveBeenCalled();
    expect(client.app.search).not.toHaveBeenCalled();
    poisonDom();
  });

  it.each([
    {
      name: 'interrupted workers',
      kind: 'load' as const,
      path: '/recovery',
      region: 'Interrupted workers',
      message: /couldn't load interrupted workers/i,
      privateText: 'workers-private failure',
      retryTarget: 'listInterruptedWorkers' as const,
      retainedRegion: 'Scheduler admissions',
      retainedText: 'Denied',
    },
    {
      name: 'scheduler admissions',
      kind: 'load' as const,
      path: '/recovery',
      region: 'Scheduler admissions',
      message: /couldn't load scheduler admissions/i,
      privateText: 'scheduler-private failure',
      retryTarget: 'listSchedulerAdmissions' as const,
      retainedRegion: 'Interrupted workers',
      retainedText: INTERRUPTED_WORKER.diagnosticsSummary,
    },
    {
      name: 'shell search',
      kind: 'search' as const,
      path: '/chat',
      region: null,
      message: /couldn't search/i,
      privateText: 'search-private failure',
      retryTarget: 'search' as const,
      retainedRegion: null,
      retainedText: null,
    },
  ])('isolates a safe $name error and retries only that owner', async (scenario) => {
    const user = userEvent.setup();
    const listInterruptedWorkers =
      scenario.retryTarget === 'listInterruptedWorkers'
        ? vi.fn().mockRejectedValue(new Error(scenario.privateText))
        : vi.fn().mockResolvedValue({ items: ALL_WORKERS });
    const listSchedulerAdmissions =
      scenario.retryTarget === 'listSchedulerAdmissions'
        ? vi.fn().mockRejectedValue(new Error(scenario.privateText))
        : vi
            .fn()
            .mockImplementation((workspaceId: string) =>
              Promise.resolve({ items: schedulerItemsFor(workspaceId) })
            );
    const search =
      scenario.retryTarget === 'search'
        ? vi.fn().mockRejectedValue(new Error(scenario.privateText))
        : vi.fn().mockResolvedValue({ items: [SEARCH_THREAD] });
    const client = makeClient({ listInterruptedWorkers, listSchedulerAdmissions, search });
    renderApp(scenario.path, client);

    if (scenario.kind === 'search') {
      expect(
        await screen.findByRole('heading', { level: 1, name: 'What can we get done?' })
      ).toBeInTheDocument();
      await submitSearch(user);
    }

    const alert =
      scenario.region === null
        ? await screen.findByRole('alert')
        : await within(await screen.findByRole('region', { name: scenario.region })).findByRole(
            'alert'
          );
    expect(alert).toHaveTextContent(scenario.message);
    expect(alert).not.toHaveTextContent(scenario.privateText);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeEnabled();

    if (scenario.retainedRegion && scenario.retainedText) {
      expect(
        within(screen.getByRole('region', { name: scenario.retainedRegion })).getByText(
          scenario.retainedText,
          { exact: true }
        )
      ).toBeInTheDocument();
      expect(
        within(screen.getByRole('region', { name: scenario.retainedRegion })).queryByRole('alert')
      ).toBeNull();
    } else if (scenario.kind === 'search') {
      expect(screen.getByRole('region', { name: 'Search' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Interrupted workers' })).toBeNull();
    } else {
      expect(
        screen.getByRole('heading', { level: 1, name: 'What can we get done?' })
      ).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Interrupted workers' })).toBeNull();
    }

    const workersBefore = listInterruptedWorkers.mock.calls.length;
    const schedulerBefore = listSchedulerAdmissions.mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    if (scenario.retryTarget === 'listInterruptedWorkers') {
      await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(workersBefore + 1));
      expect(listSchedulerAdmissions).toHaveBeenCalledTimes(schedulerBefore);
      expect(search).not.toHaveBeenCalled();
    } else if (scenario.retryTarget === 'listSchedulerAdmissions') {
      await waitFor(() =>
        expect(listSchedulerAdmissions).toHaveBeenCalledTimes(schedulerBefore + 1)
      );
      expect(listInterruptedWorkers).toHaveBeenCalledTimes(workersBefore);
      expect(search).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(search.mock.calls).toEqual([[SEARCH_QUERY], [SEARCH_QUERY]]));
      expect(listInterruptedWorkers).not.toHaveBeenCalled();
      expect(listSchedulerAdmissions).not.toHaveBeenCalled();
    }
    expect(client.app.retryInterruptedWorkerCheckpoint).not.toHaveBeenCalled();
    expect(client.app.retrySchedulerAdmission).not.toHaveBeenCalled();
    expect(client.app.cancelSchedulerAdmission).not.toHaveBeenCalled();
    poisonDom();
  });

  it.each([
    {
      name: 'interrupted workers',
      path: '/recovery',
      region: 'Interrupted workers' as const,
      empty: /no interrupted workers/i,
      emptyOwner: 'listInterruptedWorkers' as const,
      retainedRegion: 'Scheduler admissions' as const,
      retainedText: 'Denied',
      forbidden: ['Retry'] as const,
    },
    {
      name: 'scheduler admissions',
      path: '/recovery',
      region: 'Scheduler admissions' as const,
      empty: /no scheduler admissions/i,
      emptyOwner: 'listSchedulerAdmissions' as const,
      retainedRegion: 'Interrupted workers' as const,
      retainedText: INTERRUPTED_WORKER.diagnosticsSummary,
      forbidden: ['Retry', 'Cancel'] as const,
    },
    {
      name: 'search',
      path: '/chat',
      region: null,
      empty: /no (search )?results/i,
      emptyOwner: 'search' as const,
      retainedRegion: null,
      retainedText: null,
      forbidden: [] as const,
    },
  ])('shows a compact empty state for $name', async (scenario) => {
    const user = userEvent.setup();
    const emptyApp: AppOverrides =
      scenario.emptyOwner === 'listInterruptedWorkers'
        ? { listInterruptedWorkers: vi.fn().mockResolvedValue({ items: [] }) }
        : scenario.emptyOwner === 'listSchedulerAdmissions'
          ? { listSchedulerAdmissions: vi.fn().mockResolvedValue({ items: [] }) }
          : { search: vi.fn().mockResolvedValue(EMPTY_SEARCH) };
    const client = makeClient(emptyApp);
    renderApp(scenario.path, client);

    if (scenario.region === null) {
      expect(
        await screen.findByRole('heading', { level: 1, name: 'What can we get done?' })
      ).toBeInTheDocument();
      await submitSearch(user);
      await waitFor(() =>
        expect(vi.mocked(client.app.search).mock.calls).toEqual([[SEARCH_QUERY]])
      );
      expect(screen.queryByText(SEARCH_THREAD.title)).not.toBeInTheDocument();
      expect(screen.getByText(scenario.empty)).toBeInTheDocument();
      expect(client.app.listInterruptedWorkers).not.toHaveBeenCalled();
      expect(client.app.listSchedulerAdmissions).not.toHaveBeenCalled();
    } else {
      const region = await screen.findByRole('region', { name: scenario.region });
      expect(within(region).getByText(scenario.empty)).toBeInTheDocument();
      for (const name of scenario.forbidden) {
        expect(within(region).queryByRole('button', { name })).toBeNull();
      }
      expect(
        within(screen.getByRole('region', { name: scenario.retainedRegion! })).getByText(
          scenario.retainedText!,
          { exact: true }
        )
      ).toBeInTheDocument();
    }
    poisonDom();
  });

  it('keeps stale rows after a successful mutation when the authoritative refetch fails', async () => {
    const user = userEvent.setup();
    const listInterruptedWorkers = vi
      .fn()
      .mockResolvedValueOnce({ items: ALL_WORKERS })
      .mockRejectedValue(new Error('workers-private refetch failure'));
    const listSchedulerAdmissions = vi
      .fn()
      .mockImplementation((workspaceId: string) =>
        Promise.resolve({ items: schedulerItemsFor(workspaceId) })
      );
    const retryInterruptedWorkerCheckpoint = vi.fn().mockResolvedValue(WORKER_RETRY_MUTATION);
    const client = makeClient({
      listInterruptedWorkers,
      listSchedulerAdmissions,
      retryInterruptedWorkerCheckpoint,
    });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const scheduler = await screen.findByRole('region', { name: 'Scheduler admissions' });
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(workers).getByText(INSPECT_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument();
    const schedulerReadsBefore = listSchedulerAdmissions.mock.calls.length;

    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(2));

    const alert = await within(workers).findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load interrupted workers/i);
    expect(alert).not.toHaveTextContent('workers-private refetch failure');
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(workers).getByText(INSPECT_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument();
    expect(within(scheduler).queryByRole('alert')).toBeNull();
    expect(screen.queryByText(WORKER_RETRY_MUTATION.turnId)).not.toBeInTheDocument();
    expect(listSchedulerAdmissions).toHaveBeenCalledTimes(schedulerReadsBefore);
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    expect(
      within(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)).getByRole('button', {
        name: /inspect/i,
      })
    ).toBeEnabled();
    expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(3));
    expect(listInterruptedWorkers.mock.calls).toEqual([[], [], []]);
    expect(listSchedulerAdmissions).toHaveBeenCalledTimes(schedulerReadsBefore);
    expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1);
    expect(client.app.retrySchedulerAdmission).not.toHaveBeenCalled();
    expect(client.app.cancelSchedulerAdmission).not.toHaveBeenCalled();
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument();
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    expect(
      within(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)).getByRole('button', {
        name: /inspect/i,
      })
    ).toBeEnabled();
    poisonDom();
  });

  it('runs shell-global search on a second live route and across route changes', async () => {
    const user = userEvent.setup();
    let pathname = '';
    const client = makeClient();
    renderApp('/chat', client, (next) => {
      pathname = next;
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'What can we get done?' })
    ).toBeInTheDocument();
    expect(client.app.listInterruptedWorkers).not.toHaveBeenCalled();
    expect(client.app.listSchedulerAdmissions).not.toHaveBeenCalled();

    await submitSearch(user);
    await waitFor(() => expect(vi.mocked(client.app.search).mock.calls).toEqual([[SEARCH_QUERY]]));
    expect(await screen.findByText(SEARCH_THREAD.title)).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search/i })).toHaveValue(SEARCH_QUERY);
    expect(pathname).toBe('/chat');
    poisonDom();

    await user.keyboard('{Escape}{Escape}');
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    await waitFor(() => expect(pathname).toBe('/'));
    await submitSearch(user);
    expect(screen.getByRole('searchbox', { name: /search/i })).toHaveValue(SEARCH_QUERY);
    expect(await screen.findByText(SEARCH_THREAD.title)).toBeInTheDocument();
    expect(vi.mocked(client.app.search).mock.calls).toEqual([[SEARCH_QUERY], [SEARCH_QUERY]]);
    expect(client.app.listInterruptedWorkers).not.toHaveBeenCalled();
    poisonDom();
  });

  it('keeps scheduler actions locked after a successful retry when the authoritative refetch fails', async () => {
    const user = userEvent.setup();
    const listSchedulerAdmissions = vi
      .fn()
      .mockResolvedValueOnce({ items: [DENIED_ADMISSION] })
      .mockRejectedValue(new Error('scheduler-private refetch failure'));
    const retrySchedulerAdmission = vi.fn().mockResolvedValue(SCHEDULER_RETRY_MUTATION);
    const client = makeClient({ listSchedulerAdmissions, retrySchedulerAdmission });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const scheduler = screen.getByRole('region', { name: 'Scheduler admissions' });
    const workersReadsBefore = vi.mocked(client.app.listInterruptedWorkers).mock.calls.length;
    await user.click(within(scheduler).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listSchedulerAdmissions).toHaveBeenCalledTimes(2));

    const alert = await within(scheduler).findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load scheduler admissions/i);
    expect(alert).not.toHaveTextContent('scheduler-private refetch failure');
    expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument();
    expectActionUnavailable(scheduler, 'Retry');
    expectActionUnavailable(scheduler, 'Cancel');
    expect(workerActionButton(workers)).toBeEnabled();
    expect(within(workers).queryByRole('alert')).toBeNull();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listSchedulerAdmissions).toHaveBeenCalledTimes(3));
    expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.app.listInterruptedWorkers)).toHaveBeenCalledTimes(workersReadsBefore);
    expectActionUnavailable(scheduler, 'Retry');
    expectActionUnavailable(scheduler, 'Cancel');
    poisonDom();
  });

  it('keeps worker actions locked after recovery_required when the authoritative refetch fails', async () => {
    const user = userEvent.setup();
    const listInterruptedWorkers = vi
      .fn()
      .mockResolvedValueOnce({ items: ALL_WORKERS })
      .mockRejectedValue(new Error('workers-private refetch failure'));
    const retryInterruptedWorkerCheckpoint = vi
      .fn()
      .mockRejectedValue(
        new ApiCallError(409, 'recovery-private failure', { code: 'recovery_required' })
      );
    const client = makeClient({ listInterruptedWorkers, retryInterruptedWorkerCheckpoint });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const scheduler = screen.getByRole('region', { name: 'Scheduler admissions' });
    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(2));

    const alert = await within(workers).findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load interrupted workers|recovery required/i);
    expect(alert).not.toHaveTextContent('recovery-private failure');
    expect(alert).not.toHaveTextContent('workers-private refetch failure');
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    expect(
      within(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)).getByRole('button', {
        name: /inspect/i,
      })
    ).toBeEnabled();
    expect(within(scheduler).queryByRole('alert')).toBeNull();
    expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(3));
    expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1);
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    poisonDom();
  });

  it('scopes an uncertain worker failure and retries the exact same requestId', async () => {
    const user = userEvent.setup();
    const retryInterruptedWorkerCheckpoint = vi
      .fn()
      .mockRejectedValue(new Error('worker-private failure'));
    const client = makeClient({ retryInterruptedWorkerCheckpoint });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const scheduler = screen.getByRole('region', { name: 'Scheduler admissions' });
    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1));
    const requestId = workerRetryRequestId(retryInterruptedWorkerCheckpoint);
    const workersReads = vi.mocked(client.app.listInterruptedWorkers).mock.calls.length;

    const alert = await within(workers).findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't (release|retry)/i);
    expect(alert).not.toHaveTextContent('worker-private failure');
    expect(within(scheduler).queryByRole('alert')).toBeNull();
    expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(2));
    expect(retryInterruptedWorkerCheckpoint.mock.calls[1]).toEqual(
      retryInterruptedWorkerCheckpoint.mock.calls[0]
    );
    expect(retryInterruptedWorkerCheckpoint.mock.calls[1]?.[3]).toEqual({ requestId });
    expect(vi.mocked(client.app.listInterruptedWorkers)).toHaveBeenCalledTimes(workersReads);
    poisonDom();
  });

  it.each([
    {
      name: 'recovery_required',
      settle: async (deferred: ReturnType<typeof createDeferred<unknown>>) => {
        deferred.reject(
          new ApiCallError(409, 'recovery-private failure', { code: 'recovery_required' })
        );
        await deferred.promise.catch(() => undefined);
      },
      forbidden: ['Recovery required', 'recovery-private failure'],
    },
    {
      name: 'successful release plus refetch failure',
      settle: async (deferred: ReturnType<typeof createDeferred<unknown>>) => {
        deferred.resolve(WORKER_RETRY_MUTATION);
        await deferred.promise;
      },
      forbidden: [
        WORKER_RETRY_MUTATION.turnId,
        WORKER_RETRY_MUTATION.outcome,
        "Couldn't load interrupted workers.",
        'workers-private refetch failure',
      ],
    },
    {
      name: 'generic worker failure',
      settle: async (deferred: ReturnType<typeof createDeferred<unknown>>) => {
        deferred.reject(new Error('worker-private failure'));
        await deferred.promise.catch(() => undefined);
      },
      forbidden: ["Couldn't retry interrupted worker.", 'worker-private failure'],
    },
  ])('does not apply old-Workspace $name callbacks to a newly selected Workspace', async (scenario) => {
    const user = userEvent.setup();
    const mutation = createDeferred<unknown>();
    const retryInterruptedWorkerCheckpoint = vi.fn().mockReturnValue(mutation.promise);
    const listInterruptedWorkers = vi
      .fn()
      .mockResolvedValueOnce({ items: ALL_WORKERS })
      .mockRejectedValue(new Error('workers-private refetch failure'));
    const client = makeClient({ listInterruptedWorkers, retryInterruptedWorkerCheckpoint });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1));

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      await scenario.settle(mutation);
    });

    expect(screen.queryByRole('alert')).toBeNull();
    for (const text of scenario.forbidden) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
    expect(
      workerActionButton(rowFor(workers, WORKSPACE_B_WORKER.diagnosticsSummary))
    ).toBeEnabled();
    expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1);
    poisonDom();
  });

  it('does not apply old-Workspace scheduler error callbacks to a newly selected Workspace', async () => {
    const user = userEvent.setup();
    const mutation = createDeferred<unknown>();
    const retrySchedulerAdmission = vi.fn().mockReturnValue(mutation.promise);
    const client = makeClient({ retrySchedulerAdmission });
    renderApp('/recovery', client);

    const scheduler = await screen.findByRole('region', { name: 'Scheduler admissions' });
    await user.click(within(scheduler).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1));

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(scheduler).getByText('agent_ops', { exact: true })).toBeInTheDocument()
    );
    expect(within(scheduler).queryByText('Denied', { exact: true })).toBeNull();
    expect(within(scheduler).queryByRole('alert')).toBeNull();

    await act(async () => {
      mutation.reject(
        new ApiCallError(400, 'scheduler-private failure', {
          code: 'scheduler_admission_retry_failed',
        })
      );
      await mutation.promise.catch(() => undefined);
    });

    expect(within(scheduler).queryByRole('alert')).toBeNull();
    expect(screen.queryByText("Couldn't retry scheduler admission.")).not.toBeInTheDocument();
    expect(screen.queryByText('scheduler-private failure')).not.toBeInTheDocument();
    expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);
    poisonDom();
  });

  it('keeps a null-diagnostics interrupted worker visible and inspect-only with truthful action copy', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      listInterruptedWorkers: vi.fn().mockResolvedValue({
        items: [NULL_DIAGNOSTICS_WORKER, INTERRUPTED_WORKER, WORKSPACE_B_WORKER],
      }),
    });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    expect(within(workers).getByText(NULL_DIAGNOSTICS_WORKER.checkpointId)).toBeInTheDocument();
    const inspectRow = rowFor(workers, NULL_DIAGNOSTICS_WORKER.checkpointId);
    expect(workerActionButtons(inspectRow)).toHaveLength(0);
    await user.click(within(inspectRow).getByRole('button', { name: /inspect/i }));
    expect(inspectRow).toHaveTextContent(NULL_DIAGNOSTICS_WORKER.checkpointId);
    expect(inspectRow).toHaveTextContent(NULL_DIAGNOSTICS_WORKER.turnId);
    expect(inspectRow).toHaveTextContent(NULL_DIAGNOSTICS_WORKER.stage);
    expect(inspectRow).toHaveTextContent(NULL_DIAGNOSTICS_WORKER.contextDigest as string);
    expect(inspectRow).toHaveTextContent(NULL_DIAGNOSTICS_WORKER.stopReason as string);
    expect(inspectRow).toHaveTextContent('Inspect interrupted worker evidence');
    expect(inspectRow).toHaveTextContent('Ask the user how to recover this worker turn');
    expect(client.app.retryInterruptedWorkerCheckpoint).not.toHaveBeenCalled();

    const retryRow = rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary);
    expect(within(retryRow).getByRole('button', { name: WORKER_RELEASE_ACTION })).toBeEnabled();
    expect(within(retryRow).queryByRole('button', { name: 'Retry' })).toBeNull();
    await user.click(within(retryRow).getByRole('button', { name: /inspect/i }));
    expect(retryRow).toHaveTextContent('Retry interrupted worker turn');
    poisonDom();
  });

  it('retains search-hit workspaceId and selects that Workspace before navigating the exact destination', async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      if (state.currentWorkspaceId === WORKSPACE_B.id) events.push('workspace');
    });
    let pathname = '';
    const client = makeClient({
      search: vi.fn().mockResolvedValue({ items: [SEARCH_CROSS_WORKSPACE] }),
    });
    renderApp('/chat', client, (next) => {
      pathname = next;
      if (next === `/chat/${WORKSPACE_B.id}/${SEARCH_CROSS_WORKSPACE.id}`) events.push('navigate');
    });

    expect(SEARCH_CROSS_WORKSPACE.workspaceId).toBe(WORKSPACE_B.id);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'What can we get done?' })
    ).toBeInTheDocument();
    await submitSearch(user);
    expect(await screen.findByText(SEARCH_CROSS_WORKSPACE.title)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: SEARCH_CROSS_WORKSPACE.title }));
    await waitFor(() =>
      expect(pathname).toBe(`/chat/${WORKSPACE_B.id}/${SEARCH_CROSS_WORKSPACE.id}`)
    );
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(WORKSPACE_B.id);
    expect(events).toEqual(['workspace', 'navigate']);
    unsubscribe();
    poisonDom();
  });

  it('settles direct /recovery with zero authorized Workspaces into compact empty states', async () => {
    const client = makeClient({}, { listWorkspaces: vi.fn().mockResolvedValue({ items: [] }) });
    renderApp('/recovery', client);

    expect(await screen.findByRole('heading', { level: 1, name: 'Recovery' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument()
    );
    expect(screen.getByText(/no interrupted workers/i)).toBeInTheDocument();
    expect(screen.getByText(/no scheduler admissions/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: WORKER_RELEASE_ACTION })).toBeNull();
    expect(client.app.listSchedulerAdmissions).not.toHaveBeenCalled();
    poisonDom();
  });

  it('clears previous search query and results when submitting an empty query', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderApp('/chat', client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'What can we get done?' })
    ).toBeInTheDocument();
    await submitSearch(user);
    expect(await screen.findByText(SEARCH_THREAD.title)).toBeInTheDocument();

    const searchbox = screen.getByRole('searchbox', { name: /search/i });
    await user.clear(searchbox);
    await user.keyboard('{Enter}');
    expect(searchbox).toHaveValue('');
    expect(screen.queryByText(SEARCH_THREAD.title)).not.toBeInTheDocument();
    expect(screen.queryByText(/no (search )?results/i)).not.toBeInTheDocument();
    expect(vi.mocked(client.app.search).mock.calls).toEqual([[SEARCH_QUERY]]);
    poisonDom();
  });

  it.each([
    {
      name: 'successful worker release',
      mutation: 'worker_success' as const,
      settledWorkers: [ELIGIBLE_PEER_WORKER, INSPECT_WORKER, WORKSPACE_B_WORKER],
    },
    {
      name: 'worker recovery_required',
      mutation: 'recovery_required' as const,
      settledWorkers: [INELIGIBLE_AFTER_STALE_READ, INSPECT_WORKER, WORKSPACE_B_WORKER],
      resolvedText: INELIGIBLE_AFTER_STALE_READ.diagnosticsSummary,
    },
    {
      name: 'successful scheduler retry',
      mutation: 'scheduler_success' as const,
      settledWorkers: ALL_WORKERS,
      resolvedText: 'Queued',
    },
  ])('keeps $name stale through a rejected authoritative refetch then settles from advertised Try again', async (scenario) => {
    const user = userEvent.setup();
    const settled = createDeferred<{ items: unknown[] }>();
    const workerMutation =
      scenario.mutation === 'recovery_required'
        ? vi
            .fn()
            .mockRejectedValue(
              new ApiCallError(409, 'recovery-private failure', { code: 'recovery_required' })
            )
        : vi.fn().mockResolvedValue(WORKER_RETRY_MUTATION);
    const initialWorkers =
      scenario.mutation === 'worker_success'
        ? [INTERRUPTED_WORKER, ELIGIBLE_PEER_WORKER, INSPECT_WORKER, WORKSPACE_B_WORKER]
        : ALL_WORKERS;
    const listInterruptedWorkers =
      scenario.mutation === 'scheduler_success'
        ? vi.fn().mockResolvedValue({ items: ALL_WORKERS })
        : vi
            .fn()
            .mockResolvedValueOnce({ items: initialWorkers })
            .mockRejectedValueOnce(new Error('workers-private refetch failure'))
            .mockReturnValue(settled.promise);
    const retrySchedulerAdmission = vi.fn().mockResolvedValue(SCHEDULER_RETRY_MUTATION);
    const listSchedulerAdmissions =
      scenario.mutation === 'scheduler_success'
        ? vi
            .fn()
            .mockResolvedValueOnce({ items: [DENIED_ADMISSION] })
            .mockRejectedValueOnce(new Error('scheduler-private refetch failure'))
            .mockReturnValue(settled.promise)
        : vi
            .fn()
            .mockImplementation((workspaceId: string) =>
              Promise.resolve({ items: schedulerItemsFor(workspaceId) })
            );
    const client = makeClient({
      listInterruptedWorkers,
      listSchedulerAdmissions,
      retryInterruptedWorkerCheckpoint: workerMutation,
      retrySchedulerAdmission,
    });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const scheduler = await screen.findByRole('region', { name: 'Scheduler admissions' });

    if (scenario.mutation === 'scheduler_success') {
      await user.click(within(scheduler).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(listSchedulerAdmissions).toHaveBeenCalledTimes(2));
      const alert = await within(scheduler).findByRole('alert');
      expect(alert).toHaveTextContent(/couldn't load scheduler admissions/i);
      expect(alert).not.toHaveTextContent('scheduler-private refetch failure');
      expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument();
      expectActionUnavailable(scheduler, 'Retry');
      expectActionUnavailable(scheduler, 'Cancel');
      expect(workerActionButton(workers)).toBeEnabled();
      expect(within(workers).queryByRole('alert')).toBeNull();
      expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);

      await user.click(within(alert).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(listSchedulerAdmissions).toHaveBeenCalledTimes(3));
      expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);
      expectActionUnavailable(scheduler, 'Retry');
      expectActionUnavailable(scheduler, 'Cancel');
      expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument();

      settled.resolve({ items: [RETRIED_ADMISSION] });
      await waitFor(() =>
        expect(within(scheduler).queryByText('Denied', { exact: true })).toBeNull()
      );
      expect(
        within(scheduler).getByText(scenario.resolvedText, { exact: true })
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(within(scheduler).queryByRole('alert')).toBeNull();
        expect(within(scheduler).queryByRole('button', { name: 'Retry' })).toBeNull();
        expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();
      });
      expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);
      expect(workerMutation).not.toHaveBeenCalled();
      poisonDom();
      return;
    }

    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() => expect(workerMutation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(2));
    const alert = await within(workers).findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load interrupted workers|recovery required/i);
    expect(alert).not.toHaveTextContent('workers-private refetch failure');
    expect(alert).not.toHaveTextContent('recovery-private failure');
    expect(alert).not.toHaveTextContent('worker-private failure');
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    if (scenario.mutation === 'worker_success') {
      expectWorkerActionUnavailable(rowFor(workers, ELIGIBLE_PEER_WORKER.diagnosticsSummary));
    }
    expect(within(scheduler).queryByRole('alert')).toBeNull();
    expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.queryByText(WORKER_RETRY_MUTATION.turnId)).not.toBeInTheDocument();
    expect(workerMutation).toHaveBeenCalledTimes(1);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(3));
    expect(workerMutation).toHaveBeenCalledTimes(1);
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    if (scenario.mutation === 'worker_success') {
      expectWorkerActionUnavailable(rowFor(workers, ELIGIBLE_PEER_WORKER.diagnosticsSummary));
    }

    settled.resolve({ items: scenario.settledWorkers });
    if (scenario.mutation === 'worker_success') {
      await waitFor(() =>
        expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull()
      );
      expect(within(workers).queryByText(INTERRUPTED_WORKER.checkpointId)).toBeNull();
      await waitFor(() => {
        expect(within(workers).queryByRole('alert')).toBeNull();
        expect(within(workers).queryByText('Recovery required', { exact: true })).toBeNull();
        expect(
          workerActionButton(rowFor(workers, ELIGIBLE_PEER_WORKER.diagnosticsSummary))
        ).toBeEnabled();
      });
      expect(workerActionButtons(rowFor(workers, INSPECT_WORKER.diagnosticsSummary))).toEqual([]);
    } else {
      await waitFor(() =>
        expect(within(workers).getByText(scenario.resolvedText)).toBeInTheDocument()
      );
      await waitFor(() => {
        expect(within(workers).queryByRole('alert')).toBeNull();
        expect(within(workers).queryByText('Recovery required', { exact: true })).toBeNull();
        expect(workerActionButtons(rowFor(workers, scenario.resolvedText))).toEqual([]);
      });
    }
    expect(workerMutation).toHaveBeenCalledTimes(1);
    expect(retrySchedulerAdmission).not.toHaveBeenCalled();
    expect(client.app.cancelSchedulerAdmission).not.toHaveBeenCalled();
    expect(listSchedulerAdmissions.mock.calls).toEqual([[WORKSPACE.id]]);
    poisonDom();
  });

  it.each([
    {
      name: 'retry',
      action: 'Retry',
      label: 'Denied',
      mutate: 'retrySchedulerAdmission' as const,
      code: 'scheduler_admission_retry_failed',
      args: [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
      settledItems: [RETRIED_ADMISSION],
      originGone: 'Denied' as const,
      retryAfterRead: false,
    },
    {
      name: 'cancel',
      action: 'Cancel',
      label: 'Queued',
      mutate: 'cancelSchedulerAdmission' as const,
      code: 'scheduler_admission_cancel_failed',
      args: [WORKSPACE.id, QUEUED_ADMISSION.queueEntryId],
      settledItems: [DENIED_ADMISSION],
      originGone: 'Queued' as const,
      retryAfterRead: true,
    },
  ])('keeps a scheduler $name row locked after a post-mutation $name failure until the admissions reread', async (scenario) => {
    const user = userEvent.setup();
    const settled = createDeferred<{ items: unknown[] }>();
    const failure = new ApiCallError(400, 'scheduler-private failure', { code: scenario.code });
    const retrySchedulerAdmission =
      scenario.mutate === 'retrySchedulerAdmission'
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue(SCHEDULER_RETRY_MUTATION);
    const cancelSchedulerAdmission =
      scenario.mutate === 'cancelSchedulerAdmission'
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue(SCHEDULER_CANCEL_MUTATION);
    const listSchedulerAdmissions = vi
      .fn()
      .mockResolvedValueOnce({ items: [DENIED_ADMISSION, QUEUED_ADMISSION] })
      .mockReturnValue(settled.promise);
    const client = makeClient({
      listSchedulerAdmissions,
      retrySchedulerAdmission,
      cancelSchedulerAdmission,
    });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const scheduler = await screen.findByRole('region', { name: 'Scheduler admissions' });
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    const origin = rowFor(scheduler, scenario.label);
    await user.click(within(origin).getByRole('button', { name: scenario.action }));
    const mutate =
      scenario.mutate === 'retrySchedulerAdmission'
        ? retrySchedulerAdmission
        : cancelSchedulerAdmission;
    await waitFor(() => expect(mutate.mock.calls).toEqual([scenario.args]));
    expect(listSchedulerAdmissions).toHaveBeenCalledTimes(1);

    const alert = await within(scheduler).findByRole('alert');
    expect(alert).toHaveTextContent(
      scenario.mutate === 'retrySchedulerAdmission'
        ? /couldn't retry scheduler admission/i
        : /couldn't cancel scheduler admission/i
    );
    expect(alert).not.toHaveTextContent('scheduler-private failure');
    expect(within(scheduler).getByText(scenario.label, { exact: true })).toBeInTheDocument();
    expectActionUnavailable(origin, scenario.action);
    expectActionUnavailable(origin, 'Cancel');
    expect(within(workers).queryByRole('alert')).toBeNull();
    expect(workerActionButton(workers)).toBeEnabled();

    const staleRetry = within(origin).queryByRole('button', { name: 'Retry' });
    if (staleRetry) await user.click(staleRetry);
    const staleCancel = within(origin).queryByRole('button', { name: 'Cancel' });
    if (staleCancel) await user.click(staleCancel);
    expect(retrySchedulerAdmission).toHaveBeenCalledTimes(
      scenario.mutate === 'retrySchedulerAdmission' ? 1 : 0
    );
    expect(cancelSchedulerAdmission).toHaveBeenCalledTimes(
      scenario.mutate === 'cancelSchedulerAdmission' ? 1 : 0
    );
    expect(mutate.mock.calls).toEqual([scenario.args]);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listSchedulerAdmissions).toHaveBeenCalledTimes(2));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls).toEqual([scenario.args]);
    expectActionUnavailable(origin, scenario.action);
    expectActionUnavailable(origin, 'Cancel');
    expect(within(scheduler).getByText(scenario.label, { exact: true })).toBeInTheDocument();

    settled.resolve({ items: scenario.settledItems });
    await waitFor(() => {
      expect(within(scheduler).queryByRole('alert')).toBeNull();
      expect(within(scheduler).queryByText(scenario.originGone, { exact: true })).toBeNull();
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls).toEqual([scenario.args]);
    await waitFor(() => {
      if (scenario.retryAfterRead) {
        expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled();
      } else {
        expect(within(scheduler).queryByRole('button', { name: 'Retry' })).toBeNull();
      }
      expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    });
    expect(workerActionButton(workers)).toBeEnabled();
    poisonDom();
  });

  it('selects a workspace search hit from authorized discovery then navigates home', async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      if (state.currentWorkspaceId === SEARCH_WORKSPACE.id) events.push('workspace');
    });
    let pathname = '';
    const client = makeClient({
      search: vi.fn().mockResolvedValue({ items: [SEARCH_WORKSPACE] }),
    });
    renderApp('/chat', client, (next) => {
      pathname = next;
      if (next === '/') events.push('navigate');
    });

    expect(SEARCH_WORKSPACE.kind).toBe('workspace');
    expect(SEARCH_WORKSPACE.id).toBe(WORKSPACE_B.id);
    expect(SEARCH_WORKSPACE.title).toBe(WORKSPACE_B.name);
    expect(SEARCH_WORKSPACE.workspaceId).toBeUndefined();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'What can we get done?' })
    ).toBeInTheDocument();
    await waitFor(() => expect(client.core.listWorkspaces).toHaveBeenCalled());
    const discovered = await vi.mocked(client.core.listWorkspaces).mock.results[0]!.value;
    expect(discovered.items.map((workspace: { id: string }) => workspace.id)).toEqual([
      WORKSPACE.id,
      WORKSPACE_B.id,
    ]);
    await submitSearch(user);
    expect(await screen.findByRole('button', { name: SEARCH_WORKSPACE.title })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: SEARCH_WORKSPACE.title }));
    await waitFor(() => expect(pathname).toBe('/'));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(SEARCH_WORKSPACE.id);
    expect(useWorkspaceStore.getState().currentWorkspaceId).not.toBe(WORKSPACE.id);
    expect(events).toEqual(['workspace', 'navigate']);
    await waitFor(() =>
      expect(vi.mocked(client.app.getWorkspaceDashboard)).toHaveBeenCalledWith(WORKSPACE_B.id)
    );
    expect(vi.mocked(client.app.getWorkspaceDashboard)).not.toHaveBeenCalledWith(WORKSPACE.id);
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    unsubscribe();
    poisonDom();
  });

  it('exposes worker inspection as an accessible disclosure with labeled diagnostic fields', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const inspectRow = rowFor(workers, INSPECT_WORKER.diagnosticsSummary);
    expectInspectCollapsed(inspectRow);

    await toggleInspect(user, inspectRow);
    expectInspectExpanded(inspectRow);

    await toggleInspect(user, inspectRow);
    expectInspectCollapsed(inspectRow);
    expect(client.app.retryInterruptedWorkerCheckpoint).not.toHaveBeenCalled();
    poisonDom();
  });

  it.each([
    {
      name: 'successful release plus failed authoritative refetch',
      kind: 'success' as const,
    },
    {
      name: 'generic failure frozen for exact request-id replay',
      kind: 'generic' as const,
    },
  ])('keeps peer B disabled after $name and preserves frozen worker A command, origin, and settlement', async (scenario) => {
    const user = userEvent.setup();
    const listInterruptedWorkers =
      scenario.kind === 'success'
        ? vi
            .fn()
            .mockResolvedValueOnce({ items: SAME_WORKSPACE_RETRYABLE_WORKERS })
            .mockRejectedValue(new Error('workers-private refetch failure'))
        : vi.fn().mockResolvedValue({ items: SAME_WORKSPACE_RETRYABLE_WORKERS });
    const retryInterruptedWorkerCheckpoint =
      scenario.kind === 'generic'
        ? vi.fn().mockRejectedValue(new Error('worker-private failure'))
        : vi.fn().mockResolvedValue(WORKER_RETRY_MUTATION);
    const client = makeClient({ listInterruptedWorkers, retryInterruptedWorkerCheckpoint });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    const originRow = rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary);
    const peerRow = rowFor(workers, ELIGIBLE_PEER_WORKER.diagnosticsSummary);
    expect(workerActionButton(peerRow)).toBeEnabled();
    await user.click(workerActionButton(originRow));
    await waitFor(() =>
      expect(
        workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)
      ).toHaveLength(1)
    );
    const frozenRequestId = workerRetryCallsFor(
      retryInterruptedWorkerCheckpoint,
      INTERRUPTED_WORKER
    )[0]![3].requestId as string;
    expect(frozenRequestId).toEqual(expect.any(String));

    if (scenario.kind === 'success') {
      await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(2));
      expect(await within(workers).findByRole('alert')).toHaveTextContent(
        /couldn't load interrupted workers/i
      );
    } else {
      const alert = await within(workers).findByRole('alert');
      expect(alert).toHaveTextContent(/couldn't (release|retry)/i);
      expect(alert).not.toHaveTextContent('worker-private failure');
    }
    expectWorkerActionUnavailable(originRow);
    expectWorkerActionUnavailable(peerRow);
    expect(
      workerRetryCallsFor(retryInterruptedWorkerCheckpoint, ELIGIBLE_PEER_WORKER)
    ).toHaveLength(0);
    expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
    const retainedOriginAlert = within(workers).getByRole('alert');

    const frozenACall = [
      WORKSPACE.id,
      INTERRUPTED_WORKER.threadId,
      INTERRUPTED_WORKER.turnId,
      { requestId: frozenRequestId },
    ];
    if (scenario.kind === 'generic') {
      await user.click(within(retainedOriginAlert).getByRole('button', { name: 'Try again' }));
      await waitFor(() =>
        expect(
          workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER).length
        ).toBeGreaterThan(1)
      );
      expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual(
        workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER).map(
          () => frozenACall
        )
      );
    } else {
      expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
        frozenACall,
      ]);
      const reads = listInterruptedWorkers.mock.calls.length;
      await user.click(within(retainedOriginAlert).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(listInterruptedWorkers.mock.calls.length).toBeGreaterThan(reads));
      expectWorkerActionUnavailable(originRow);
      expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument();
      expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
        frozenACall,
      ]);
    }
    expectWorkerActionUnavailable(peerRow);
    expect(
      workerRetryCallsFor(retryInterruptedWorkerCheckpoint, ELIGIBLE_PEER_WORKER)
    ).toHaveLength(0);
    poisonDom();
  });

  it('keeps returning worker A locked until the first authoritative settlement restores eligibility', async () => {
    const user = userEvent.setup();
    const firstARefetch = createDeferred<{ items: unknown[] }>();
    const secondAMutation = createDeferred<unknown>();
    const listInterruptedWorkers = vi
      .fn()
      .mockResolvedValueOnce({ items: ALL_WORKERS })
      .mockReturnValueOnce(firstARefetch.promise)
      .mockResolvedValue({ items: ALL_WORKERS });
    const retryInterruptedWorkerCheckpoint = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiCallError(409, 'recovery-private failure', { code: 'recovery_required' })
      )
      .mockReturnValueOnce(secondAMutation.promise);
    const client = makeClient({ listInterruptedWorkers, retryInterruptedWorkerCheckpoint });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1));
    const firstRequestId = workerRetryRequestId(retryInterruptedWorkerCheckpoint);
    const frozenACall = [
      WORKSPACE.id,
      INTERRUPTED_WORKER.threadId,
      INTERRUPTED_WORKER.turnId,
      { requestId: firstRequestId },
    ];
    await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(2));

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull();

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    await waitFor(() =>
      expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    const returnedRow = rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary);
    expectWorkerActionUnavailable(returnedRow);
    const staleRetry = workerActionButtons(returnedRow)[0];
    if (staleRetry) await user.click(staleRetry);
    expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1);
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
      frozenACall,
    ]);

    await act(async () => {
      firstARefetch.resolve({ items: ALL_WORKERS });
      await firstARefetch.promise;
    });

    await waitFor(() =>
      expect(
        workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary))
      ).toBeEnabled()
    );
    expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1);
    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(2));
    const secondRequestId = retryInterruptedWorkerCheckpoint.mock.calls[1]?.[3].requestId as string;
    expect(secondRequestId).toEqual(expect.any(String));
    expect(secondRequestId).not.toBe(firstRequestId);
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    poisonDom();
  });

  it('keeps returning scheduler A locked until the first authoritative settlement restores eligibility', async () => {
    const user = userEvent.setup();
    const firstARefetch = createDeferred<{ items: unknown[] }>();
    const secondAMutation = createDeferred<unknown>();
    let workspaceAReads = 0;
    const listSchedulerAdmissions = vi.fn().mockImplementation((workspaceId: string) => {
      if (workspaceId === WORKSPACE_B.id) {
        return Promise.resolve({ items: [WORKSPACE_B_QUEUED] });
      }
      workspaceAReads += 1;
      if (workspaceAReads === 1) return Promise.resolve({ items: [DENIED_ADMISSION] });
      if (workspaceAReads === 2) return firstARefetch.promise;
      return Promise.resolve({ items: [DENIED_ADMISSION] });
    });
    const retrySchedulerAdmission = vi
      .fn()
      .mockResolvedValueOnce(SCHEDULER_RETRY_MUTATION)
      .mockReturnValueOnce(secondAMutation.promise);
    const client = makeClient({ listSchedulerAdmissions, retrySchedulerAdmission });
    renderApp('/recovery', client);

    const scheduler = await screen.findByRole('region', { name: 'Scheduler admissions' });
    await user.click(within(scheduler).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(retrySchedulerAdmission.mock.calls).toEqual([
        [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
      ])
    );
    await waitFor(() => expect(workspaceAReads).toBe(2));

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(scheduler).getByText('agent_ops', { exact: true })).toBeInTheDocument()
    );
    expect(within(scheduler).queryByText('Denied', { exact: true })).toBeNull();

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    await waitFor(() =>
      expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument()
    );
    expectActionUnavailable(scheduler, 'Retry');
    expectActionUnavailable(scheduler, 'Cancel');
    const staleRetry = within(scheduler).queryByRole('button', { name: 'Retry' });
    if (staleRetry) await user.click(staleRetry);
    const staleCancel = within(scheduler).queryByRole('button', { name: 'Cancel' });
    if (staleCancel) await user.click(staleCancel);
    expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);
    expect(retrySchedulerAdmission.mock.calls).toEqual([
      [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
    ]);

    await act(async () => {
      firstARefetch.resolve({ items: [DENIED_ADMISSION] });
      await firstARefetch.promise;
    });

    await waitFor(() =>
      expect(within(scheduler).getByRole('button', { name: 'Retry' })).toBeEnabled()
    );
    expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);
    await user.click(within(scheduler).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retrySchedulerAdmission).toHaveBeenCalledTimes(2));
    expect(retrySchedulerAdmission.mock.calls[1]).toEqual([
      WORKSPACE.id,
      DENIED_ADMISSION.queueEntryId,
    ]);
    expectActionUnavailable(scheduler, 'Retry');
    expectActionUnavailable(scheduler, 'Cancel');
    poisonDom();
  });

  it('retains Workspace A frozen worker failure and replays the identical requestId after A→B→A', async () => {
    const user = userEvent.setup();
    const retryInterruptedWorkerCheckpoint = vi
      .fn()
      .mockRejectedValue(new Error('worker-private failure'));
    const client = makeClient({ retryInterruptedWorkerCheckpoint });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1));
    const requestId = workerRetryRequestId(retryInterruptedWorkerCheckpoint);
    const frozenACall = [
      WORKSPACE.id,
      INTERRUPTED_WORKER.threadId,
      INTERRUPTED_WORKER.turnId,
      { requestId },
    ];
    const originAlert = await within(workers).findByRole('alert');
    expect(originAlert).toHaveTextContent(/couldn't (release|retry)/i);
    expect(originAlert).not.toHaveTextContent('worker-private failure');
    expect(within(originAlert).getByRole('button', { name: 'Try again' })).toBeEnabled();
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull();
    expect(within(workers).queryByRole('alert')).toBeNull();
    expect(
      workerActionButton(rowFor(workers, WORKSPACE_B_WORKER.diagnosticsSummary))
    ).toBeEnabled();

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    await waitFor(() =>
      expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    const returnedAlert = within(workers).getByRole('alert');
    expect(returnedAlert).toHaveTextContent(/couldn't (release|retry)/i);
    expect(returnedAlert).not.toHaveTextContent('worker-private failure');
    const tryAgain = within(returnedAlert).getByRole('button', { name: 'Try again' });
    expect(tryAgain).toBeEnabled();
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    expect(retryInterruptedWorkerCheckpoint.mock.calls).toEqual([frozenACall]);

    await user.click(tryAgain);
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(2));
    expect(retryInterruptedWorkerCheckpoint.mock.calls).toEqual([frozenACall, frozenACall]);
    expect(retryInterruptedWorkerCheckpoint.mock.calls[1]?.[3]).toEqual({ requestId });
    poisonDom();
  });

  it('settles an in-flight Workspace A worker release against A only while B is selected', async () => {
    const user = userEvent.setup();
    const mutation = createDeferred<unknown>();
    const listInterruptedWorkers = vi
      .fn()
      .mockResolvedValueOnce({ items: ALL_WORKERS })
      .mockResolvedValue({ items: [INSPECT_WORKER, WORKSPACE_B_WORKER] });
    const retryInterruptedWorkerCheckpoint = vi.fn().mockReturnValue(mutation.promise);
    const client = makeClient({ listInterruptedWorkers, retryInterruptedWorkerCheckpoint });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1));
    const requestId = workerRetryRequestId(retryInterruptedWorkerCheckpoint);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      workerActionButton(rowFor(workers, WORKSPACE_B_WORKER.diagnosticsSummary))
    ).toBeEnabled();

    await act(async () => {
      mutation.resolve(WORKER_RETRY_MUTATION);
      await mutation.promise;
    });
    await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull();
    expect(
      workerActionButton(rowFor(workers, WORKSPACE_B_WORKER.diagnosticsSummary))
    ).toBeEnabled();
    expect(screen.queryByText(WORKER_RETRY_MUTATION.turnId)).not.toBeInTheDocument();
    expect(screen.queryByText(WORKER_RETRY_MUTATION.outcome)).not.toBeInTheDocument();
    expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(1);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    await waitFor(() =>
      expect(within(workers).getByText(INSPECT_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull();
    expect(within(workers).queryByRole('alert')).toBeNull();
    expect(workerActionButtons(rowFor(workers, INSPECT_WORKER.diagnosticsSummary))).toEqual([]);
    expect(listInterruptedWorkers.mock.calls).toEqual([[], []]);
    expect(retryInterruptedWorkerCheckpoint.mock.calls).toEqual([
      [WORKSPACE.id, INTERRUPTED_WORKER.threadId, INTERRUPTED_WORKER.turnId, { requestId }],
    ]);
    poisonDom();
  });

  it.each([
    {
      name: 'generic retry failure after A→B→A',
      mode: 'failure' as const,
    },
    {
      name: 'successful settlement while B is selected',
      mode: 'settlement' as const,
    },
  ])('preserves Workspace A scheduler $name', async (scenario) => {
    const user = userEvent.setup();
    const mutation = createDeferred<unknown>();
    let workspaceAReads = 0;
    const listSchedulerAdmissions = vi.fn().mockImplementation((workspaceId: string) => {
      if (workspaceId === WORKSPACE_B.id) {
        return Promise.resolve({ items: [WORKSPACE_B_QUEUED] });
      }
      workspaceAReads += 1;
      if (workspaceAReads === 1) return Promise.resolve({ items: [DENIED_ADMISSION] });
      if (scenario.mode === 'settlement' && workspaceAReads === 2) {
        return Promise.resolve({ items: [RETRIED_ADMISSION] });
      }
      return Promise.resolve({ items: [DENIED_ADMISSION] });
    });
    const retrySchedulerAdmission =
      scenario.mode === 'failure'
        ? vi.fn().mockRejectedValue(
            new ApiCallError(400, 'scheduler-private failure', {
              code: 'scheduler_admission_retry_failed',
            })
          )
        : vi.fn().mockReturnValue(mutation.promise);
    const client = makeClient({ listSchedulerAdmissions, retrySchedulerAdmission });
    renderApp('/recovery', client);

    const scheduler = await screen.findByRole('region', { name: 'Scheduler admissions' });
    const workers = screen.getByRole('region', { name: 'Interrupted workers' });
    await user.click(within(scheduler).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(retrySchedulerAdmission.mock.calls).toEqual([
        [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
      ])
    );

    if (scenario.mode === 'failure') {
      const originAlert = await within(scheduler).findByRole('alert');
      expect(originAlert).toHaveTextContent(/couldn't retry scheduler admission/i);
      expect(originAlert).not.toHaveTextContent('scheduler-private failure');
      expect(within(originAlert).getByRole('button', { name: 'Try again' })).toBeEnabled();
      expectActionUnavailable(scheduler, 'Retry');
      expect(workerActionButton(workers)).toBeEnabled();

      act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
      await waitFor(() =>
        expect(within(scheduler).getByText('agent_ops', { exact: true })).toBeInTheDocument()
      );
      expect(within(scheduler).queryByText('Denied', { exact: true })).toBeNull();
      expect(within(scheduler).queryByRole('alert')).toBeNull();
      expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();

      act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
      await waitFor(() =>
        expect(within(scheduler).getByText('Denied', { exact: true })).toBeInTheDocument()
      );
      const returnedAlert = within(scheduler).getByRole('alert');
      expect(returnedAlert).toHaveTextContent(/couldn't retry scheduler admission/i);
      expect(returnedAlert).not.toHaveTextContent('scheduler-private failure');
      const tryAgain = within(returnedAlert).getByRole('button', { name: 'Try again' });
      expect(tryAgain).toBeEnabled();
      expectActionUnavailable(scheduler, 'Retry');
      expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);
      const aReadsBeforeRetry = listSchedulerAdmissions.mock.calls.filter(
        ([workspaceId]) => workspaceId === WORKSPACE.id
      ).length;

      await user.click(tryAgain);
      await waitFor(() =>
        expect(
          listSchedulerAdmissions.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id)
            .length
        ).toBe(aReadsBeforeRetry + 1)
      );
      expect(retrySchedulerAdmission.mock.calls).toEqual([
        [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
      ]);
      expectActionUnavailable(scheduler, 'Retry');
      poisonDom();
      return;
    }

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(scheduler).getByText('agent_ops', { exact: true })).toBeInTheDocument()
    );
    expect(within(scheduler).queryByText('Denied', { exact: true })).toBeNull();
    expect(within(scheduler).queryByRole('alert')).toBeNull();
    expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();

    await act(async () => {
      mutation.resolve(SCHEDULER_RETRY_MUTATION);
      await mutation.promise;
    });
    await waitFor(() =>
      expect(
        listSchedulerAdmissions.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id)
          .length
      ).toBe(2)
    );
    expect(within(scheduler).getByText('agent_ops', { exact: true })).toBeInTheDocument();
    expect(within(scheduler).queryByRole('alert')).toBeNull();
    expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(retrySchedulerAdmission).toHaveBeenCalledTimes(1);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    await waitFor(() =>
      expect(within(scheduler).getByText('Queued', { exact: true })).toBeInTheDocument()
    );
    expect(within(scheduler).queryByText('Denied', { exact: true })).toBeNull();
    expect(within(scheduler).queryByRole('alert')).toBeNull();
    expect(within(scheduler).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(retrySchedulerAdmission.mock.calls).toEqual([
      [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
    ]);
    poisonDom();
  });

  it('allows an independent Workspace B worker release while Workspace A remains unsettled', async () => {
    const user = userEvent.setup();
    const pendingA = createDeferred<typeof WORKER_RETRY_MUTATION>();
    const retryInterruptedWorkerCheckpoint = vi
      .fn()
      .mockImplementation((workspaceId: string) =>
        workspaceId === WORKSPACE.id ? pendingA.promise : Promise.resolve(WORKSPACE_B_WORKER_RETRY)
      );
    const client = makeClient({ retryInterruptedWorkerCheckpoint });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() =>
      expect(
        workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)
      ).toHaveLength(1)
    );
    const aRequestId = workerRetryCallsFor(
      retryInterruptedWorkerCheckpoint,
      INTERRUPTED_WORKER
    )[0]![3].requestId as string;
    expect(aRequestId).toEqual(expect.any(String));
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull();
    expect(within(workers).queryByRole('alert')).toBeNull();
    const bAction = workerActionButton(rowFor(workers, WORKSPACE_B_WORKER.diagnosticsSummary));
    expect(bAction).toBeEnabled();

    await user.click(bAction);
    await waitFor(() =>
      expect(
        workerRetryCallsFor(retryInterruptedWorkerCheckpoint, WORKSPACE_B_WORKER)
      ).toHaveLength(1)
    );
    const bRequestId = workerRetryCallsFor(
      retryInterruptedWorkerCheckpoint,
      WORKSPACE_B_WORKER
    )[0]![3].requestId as string;
    expect(bRequestId).toEqual(expect.any(String));
    expect(bRequestId).not.toBe(aRequestId);
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
      [
        WORKSPACE.id,
        INTERRUPTED_WORKER.threadId,
        INTERRUPTED_WORKER.turnId,
        { requestId: aRequestId },
      ],
    ]);
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, WORKSPACE_B_WORKER)).toEqual([
      [
        WORKSPACE_B.id,
        WORKSPACE_B_WORKER.threadId,
        WORKSPACE_B_WORKER.turnId,
        { requestId: bRequestId },
      ],
    ]);
    await waitFor(() => expect(client.app.listInterruptedWorkers).toHaveBeenCalledTimes(2));
    expect(within(workers).queryByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeNull();
    expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument();

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    await waitFor(() =>
      expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
      [
        WORKSPACE.id,
        INTERRUPTED_WORKER.threadId,
        INTERRUPTED_WORKER.turnId,
        { requestId: aRequestId },
      ],
    ]);
    poisonDom();
  });

  it.each([
    {
      name: 'success',
      mode: 'success' as const,
    },
    {
      name: 'generic failure',
      mode: 'generic' as const,
    },
    {
      name: 'recovery_required failure',
      mode: 'recovery' as const,
    },
  ])('closes a pending Workspace A worker $name after Workspace B starts and completes an independent release', async (scenario) => {
    const user = userEvent.setup();
    const pendingA = createDeferred<unknown>();
    const pendingB = createDeferred<unknown>();
    const aSettlement = createDeferred<{ items: unknown[] }>();
    let workerReads = 0;
    const listInterruptedWorkers = vi.fn().mockImplementation(() => {
      workerReads += 1;
      if (scenario.mode !== 'generic' && workerReads >= 3) return aSettlement.promise;
      return Promise.resolve({ items: ALL_WORKERS });
    });
    const retryInterruptedWorkerCheckpoint = vi
      .fn()
      .mockImplementation((workspaceId: string) =>
        workspaceId === WORKSPACE.id ? pendingA.promise : pendingB.promise
      );
    const client = makeClient({ listInterruptedWorkers, retryInterruptedWorkerCheckpoint });
    renderApp('/recovery', client);

    const workers = await screen.findByRole('region', { name: 'Interrupted workers' });
    await user.click(workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)));
    await waitFor(() =>
      expect(
        workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)
      ).toHaveLength(1)
    );
    const aRequestId = workerRetryCallsFor(
      retryInterruptedWorkerCheckpoint,
      INTERRUPTED_WORKER
    )[0]![3].requestId as string;
    expect(aRequestId).toEqual(expect.any(String));
    const frozenACall = [
      WORKSPACE.id,
      INTERRUPTED_WORKER.threadId,
      INTERRUPTED_WORKER.turnId,
      { requestId: aRequestId },
    ];
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    const bAction = workerActionButton(rowFor(workers, WORKSPACE_B_WORKER.diagnosticsSummary));
    expect(bAction).toBeEnabled();
    await user.click(bAction);
    await waitFor(() =>
      expect(
        workerRetryCallsFor(retryInterruptedWorkerCheckpoint, WORKSPACE_B_WORKER)
      ).toHaveLength(1)
    );
    const bRequestId = workerRetryCallsFor(
      retryInterruptedWorkerCheckpoint,
      WORKSPACE_B_WORKER
    )[0]![3].requestId as string;
    expect(bRequestId).toEqual(expect.any(String));
    expect(bRequestId).not.toBe(aRequestId);
    const frozenBCall = [
      WORKSPACE_B.id,
      WORKSPACE_B_WORKER.threadId,
      WORKSPACE_B_WORKER.turnId,
      { requestId: bRequestId },
    ];
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
      frozenACall,
    ]);
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, WORKSPACE_B_WORKER)).toEqual([
      frozenBCall,
    ]);

    await act(async () => {
      pendingB.resolve(WORKSPACE_B_WORKER_RETRY);
      await pendingB.promise;
    });
    await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(2));
    expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(workers).queryByRole('alert')).toBeNull();
    expect(
      workerActionButton(rowFor(workers, WORKSPACE_B_WORKER.diagnosticsSummary))
    ).toBeEnabled();
    expect(screen.queryByText(WORKER_RETRY_MUTATION.turnId)).not.toBeInTheDocument();
    expect(screen.queryByText(WORKSPACE_B_WORKER_RETRY.turnId)).not.toBeInTheDocument();

    if (scenario.mode === 'success') {
      await act(async () => {
        pendingA.resolve(WORKER_RETRY_MUTATION);
        await pendingA.promise;
      });
      await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(3));
      expect(listInterruptedWorkers.mock.calls).toEqual([[], [], []]);
      expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument();
      expect(within(workers).queryByRole('alert')).toBeNull();
      expect(
        workerActionButton(rowFor(workers, WORKSPACE_B_WORKER.diagnosticsSummary))
      ).toBeEnabled();
      expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
        frozenACall,
      ]);
      expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, WORKSPACE_B_WORKER)).toEqual([
        frozenBCall,
      ]);

      act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
      await waitFor(() =>
        expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument()
      );
      expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
      expect(within(workers).queryByRole('alert')).toBeNull();

      await act(async () => {
        aSettlement.resolve({ items: ALL_WORKERS });
        await aSettlement.promise;
      });
      await waitFor(() =>
        expect(
          workerActionButton(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary))
        ).toBeEnabled()
      );
      expect(within(workers).queryByRole('alert')).toBeNull();
      expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
        frozenACall,
      ]);
      expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, WORKSPACE_B_WORKER)).toEqual([
        frozenBCall,
      ]);
      expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(2);
      poisonDom();
      return;
    }

    await act(async () => {
      if (scenario.mode === 'recovery') {
        pendingA.reject(
          new ApiCallError(409, 'recovery-private failure', { code: 'recovery_required' })
        );
      } else {
        pendingA.reject(new Error('worker-private failure'));
      }
      await pendingA.promise.catch(() => undefined);
    });

    if (scenario.mode === 'recovery') {
      await waitFor(() => expect(listInterruptedWorkers).toHaveBeenCalledTimes(3));
      expect(listInterruptedWorkers.mock.calls).toEqual([[], [], []]);
    } else {
      expect(listInterruptedWorkers).toHaveBeenCalledTimes(2);
    }
    expect(within(workers).getByText(WORKSPACE_B_WORKER.diagnosticsSummary)).toBeInTheDocument();
    expect(within(workers).queryByRole('alert')).toBeNull();
    expect(within(workers).queryByText('Recovery required', { exact: true })).toBeNull();
    expect(screen.queryByText('worker-private failure')).not.toBeInTheDocument();
    expect(screen.queryByText('recovery-private failure')).not.toBeInTheDocument();
    expect(
      workerActionButton(rowFor(workers, WORKSPACE_B_WORKER.diagnosticsSummary))
    ).toBeEnabled();
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
      frozenACall,
    ]);
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, WORKSPACE_B_WORKER)).toEqual([
      frozenBCall,
    ]);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    await waitFor(() =>
      expect(within(workers).getByText(INTERRUPTED_WORKER.diagnosticsSummary)).toBeInTheDocument()
    );
    const returnedAlert = await within(workers).findByRole('alert');
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    expect(returnedAlert).not.toHaveTextContent('worker-private failure');
    expect(returnedAlert).not.toHaveTextContent('recovery-private failure');
    const staleRetry = workerActionButtons(
      rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary)
    )[0];
    if (staleRetry) await user.click(staleRetry);
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
      frozenACall,
    ]);
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, WORKSPACE_B_WORKER)).toEqual([
      frozenBCall,
    ]);

    if (scenario.mode === 'recovery') {
      expect(returnedAlert).toHaveTextContent('Recovery required');
      expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
        frozenACall,
      ]);
      expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, WORKSPACE_B_WORKER)).toEqual([
        frozenBCall,
      ]);
      expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
      poisonDom();
      return;
    }

    expect(returnedAlert).toHaveTextContent(/couldn't (release|retry)/i);
    await user.click(within(returnedAlert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(retryInterruptedWorkerCheckpoint).toHaveBeenCalledTimes(3));
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, INTERRUPTED_WORKER)).toEqual([
      frozenACall,
      frozenACall,
    ]);
    expect(workerRetryCallsFor(retryInterruptedWorkerCheckpoint, WORKSPACE_B_WORKER)).toEqual([
      frozenBCall,
    ]);
    expect(retryInterruptedWorkerCheckpoint.mock.calls[2]?.[3]).toEqual({ requestId: aRequestId });
    expectWorkerActionUnavailable(rowFor(workers, INTERRUPTED_WORKER.diagnosticsSummary));
    poisonDom();
  });

  it.each([
    {
      name: 'retry success',
      mode: 'success' as const,
      action: 'Retry',
      aLabel: 'Denied',
      mutate: 'retrySchedulerAdmission' as const,
      aArgs: [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
      bArgs: [WORKSPACE_B.id, WORKSPACE_B_DENIED.queueEntryId],
      aInitial: [DENIED_ADMISSION, QUEUED_ADMISSION],
      bInitial: [WORKSPACE_B_DENIED],
      bSettled: [WORKSPACE_B_DENIED_RETRIED],
      aSettled: [RETRIED_ADMISSION, QUEUED_ADMISSION],
      originGone: 'Denied' as const,
      errorMessage: /couldn't retry scheduler admission/i,
      errorCode: 'scheduler_admission_retry_failed',
    },
    {
      name: 'retry failure',
      mode: 'failure' as const,
      action: 'Retry',
      aLabel: 'Denied',
      mutate: 'retrySchedulerAdmission' as const,
      aArgs: [WORKSPACE.id, DENIED_ADMISSION.queueEntryId],
      bArgs: [WORKSPACE_B.id, WORKSPACE_B_DENIED.queueEntryId],
      aInitial: [DENIED_ADMISSION, QUEUED_ADMISSION],
      bInitial: [WORKSPACE_B_DENIED],
      bSettled: [WORKSPACE_B_DENIED_RETRIED],
      aSettled: [DENIED_ADMISSION, QUEUED_ADMISSION],
      originGone: 'Denied' as const,
      errorMessage: /couldn't retry scheduler admission/i,
      errorCode: 'scheduler_admission_retry_failed',
    },
    {
      name: 'cancel success',
      mode: 'success' as const,
      action: 'Cancel',
      aLabel: 'Queued',
      mutate: 'cancelSchedulerAdmission' as const,
      aArgs: [WORKSPACE.id, QUEUED_ADMISSION.queueEntryId],
      bArgs: [WORKSPACE_B.id, WORKSPACE_B_QUEUED.queueEntryId],
      aInitial: [DENIED_ADMISSION, QUEUED_ADMISSION],
      bInitial: [WORKSPACE_B_QUEUED],
      bSettled: [] as unknown[],
      aSettled: [DENIED_ADMISSION],
      originGone: 'Queued' as const,
      errorMessage: /couldn't cancel scheduler admission/i,
      errorCode: 'scheduler_admission_cancel_failed',
    },
    {
      name: 'cancel failure',
      mode: 'failure' as const,
      action: 'Cancel',
      aLabel: 'Queued',
      mutate: 'cancelSchedulerAdmission' as const,
      aArgs: [WORKSPACE.id, QUEUED_ADMISSION.queueEntryId],
      bArgs: [WORKSPACE_B.id, WORKSPACE_B_QUEUED.queueEntryId],
      aInitial: [DENIED_ADMISSION, QUEUED_ADMISSION],
      bInitial: [WORKSPACE_B_QUEUED],
      bSettled: [] as unknown[],
      aSettled: [DENIED_ADMISSION, QUEUED_ADMISSION],
      originGone: 'Queued' as const,
      errorMessage: /couldn't cancel scheduler admission/i,
      errorCode: 'scheduler_admission_cancel_failed',
    },
  ])('closes a pending Workspace A scheduler $name after Workspace B starts and completes an independent $action', async (scenario) => {
    const user = userEvent.setup();
    const pendingA = createDeferred<unknown>();
    const pendingB = createDeferred<unknown>();
    const aSettlement = createDeferred<{ items: unknown[] }>();
    let aReads = 0;
    let bReads = 0;
    const listSchedulerAdmissions = vi.fn().mockImplementation((workspaceId: string) => {
      if (workspaceId === WORKSPACE_B.id) {
        bReads += 1;
        return Promise.resolve({ items: bReads === 1 ? scenario.bInitial : scenario.bSettled });
      }
      aReads += 1;
      if (aReads === 1) return Promise.resolve({ items: scenario.aInitial });
      return aSettlement.promise;
    });
    const retrySchedulerAdmission =
      scenario.mutate === 'retrySchedulerAdmission'
        ? vi
            .fn()
            .mockImplementation((workspaceId: string) =>
              workspaceId === WORKSPACE.id ? pendingA.promise : pendingB.promise
            )
        : vi.fn().mockResolvedValue(SCHEDULER_RETRY_MUTATION);
    const cancelSchedulerAdmission =
      scenario.mutate === 'cancelSchedulerAdmission'
        ? vi
            .fn()
            .mockImplementation((workspaceId: string) =>
              workspaceId === WORKSPACE.id ? pendingA.promise : pendingB.promise
            )
        : vi.fn().mockResolvedValue(SCHEDULER_CANCEL_MUTATION);
    const mutate =
      scenario.mutate === 'retrySchedulerAdmission'
        ? retrySchedulerAdmission
        : cancelSchedulerAdmission;
    const client = makeClient({
      listSchedulerAdmissions,
      retrySchedulerAdmission,
      cancelSchedulerAdmission,
    });
    renderApp('/recovery', client);

    const scheduler = await screen.findByRole('region', { name: 'Scheduler admissions' });
    const workers = screen.getByRole('region', { name: 'Interrupted workers' });
    await user.click(
      within(rowFor(scheduler, scenario.aLabel)).getByRole('button', { name: scenario.action })
    );
    await waitFor(() => expect(mutate.mock.calls).toEqual([scenario.aArgs]));
    expectActionUnavailable(scheduler, 'Retry');
    expectActionUnavailable(scheduler, 'Cancel');

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B.id }));
    await waitFor(() =>
      expect(within(scheduler).getByText('agent_ops', { exact: true })).toBeInTheDocument()
    );
    const bButton = within(scheduler).getByRole('button', { name: scenario.action });
    expect(bButton).toBeEnabled();
    await user.click(bButton);
    await waitFor(() => expect(mutate.mock.calls).toEqual([scenario.aArgs, scenario.bArgs]));

    await act(async () => {
      pendingB.resolve(
        scenario.mutate === 'retrySchedulerAdmission'
          ? SCHEDULER_RETRY_MUTATION
          : SCHEDULER_CANCEL_MUTATION
      );
      await pendingB.promise;
    });
    await waitFor(() =>
      expect(schedulerReadsFor(listSchedulerAdmissions, WORKSPACE_B.id).length).toBe(2)
    );
    expect(schedulerReadsFor(listSchedulerAdmissions, WORKSPACE.id)).toEqual([[WORKSPACE.id]]);
    expect(within(scheduler).queryByRole('alert')).toBeNull();
    if (scenario.bSettled.length === 0) {
      expect(within(scheduler).getByText('No scheduler admissions')).toBeInTheDocument();
    } else {
      expect(within(scheduler).getByText('Queued', { exact: true })).toBeInTheDocument();
      expect(within(scheduler).queryByText('Denied', { exact: true })).toBeNull();
      expect(within(scheduler).queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    }
    expect(mutate.mock.calls).toEqual([scenario.aArgs, scenario.bArgs]);
    expect(workerActionButton(workers)).toBeEnabled();

    if (scenario.mode === 'success') {
      await act(async () => {
        pendingA.resolve(
          scenario.mutate === 'retrySchedulerAdmission'
            ? SCHEDULER_RETRY_MUTATION
            : SCHEDULER_CANCEL_MUTATION
        );
        await pendingA.promise;
      });
      await waitFor(() =>
        expect(schedulerReadsFor(listSchedulerAdmissions, WORKSPACE.id).length).toBe(2)
      );
      expect(schedulerReadsFor(listSchedulerAdmissions, WORKSPACE.id)).toEqual([
        [WORKSPACE.id],
        [WORKSPACE.id],
      ]);
      expect(schedulerReadsFor(listSchedulerAdmissions, WORKSPACE_B.id).length).toBe(2);
      expect(mutate.mock.calls).toEqual([scenario.aArgs, scenario.bArgs]);
      expect(within(scheduler).queryByRole('alert')).toBeNull();
      if (scenario.bSettled.length === 0) {
        expect(within(scheduler).getByText('No scheduler admissions')).toBeInTheDocument();
      } else {
        expect(within(scheduler).getByText('Queued', { exact: true })).toBeInTheDocument();
        expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();
      }

      act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
      await waitFor(() =>
        expect(within(scheduler).getByText(scenario.aLabel, { exact: true })).toBeInTheDocument()
      );
      expectActionUnavailable(scheduler, 'Retry');
      expectActionUnavailable(scheduler, 'Cancel');

      await act(async () => {
        aSettlement.resolve({ items: scenario.aSettled });
        await aSettlement.promise;
      });
      await waitFor(() => {
        expect(within(scheduler).queryByText(scenario.originGone, { exact: true })).toBeNull();
        expect(within(scheduler).queryByRole('alert')).toBeNull();
        const cancelButtons = within(scheduler).getAllByRole('button', { name: 'Cancel' });
        expect(cancelButtons).toHaveLength(scenario.aSettled.length);
        expect(cancelButtons.every((button) => !button.hasAttribute('disabled'))).toBe(true);
      });
      expect(mutate.mock.calls).toEqual([scenario.aArgs, scenario.bArgs]);
      expect(schedulerReadsFor(listSchedulerAdmissions, WORKSPACE_B.id).length).toBe(2);
      expect(workerActionButton(workers)).toBeEnabled();
      poisonDom();
      return;
    }

    await act(async () => {
      pendingA.reject(
        new ApiCallError(400, 'scheduler-private failure', { code: scenario.errorCode })
      );
      await pendingA.promise.catch(() => undefined);
    });
    expect(schedulerReadsFor(listSchedulerAdmissions, WORKSPACE.id)).toEqual([[WORKSPACE.id]]);
    expect(schedulerReadsFor(listSchedulerAdmissions, WORKSPACE_B.id).length).toBe(2);
    expect(within(scheduler).queryByRole('alert')).toBeNull();
    expect(screen.queryByText('scheduler-private failure')).not.toBeInTheDocument();
    if (scenario.bSettled.length === 0) {
      expect(within(scheduler).getByText('No scheduler admissions')).toBeInTheDocument();
    } else {
      expect(within(scheduler).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    }
    expect(mutate.mock.calls).toEqual([scenario.aArgs, scenario.bArgs]);

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id }));
    await waitFor(() =>
      expect(within(scheduler).getByText(scenario.aLabel, { exact: true })).toBeInTheDocument()
    );
    const returnedAlert = await within(scheduler).findByRole('alert');
    expect(returnedAlert).toHaveTextContent(scenario.errorMessage);
    expect(returnedAlert).not.toHaveTextContent('scheduler-private failure');
    expectActionUnavailable(scheduler, 'Retry');
    expectActionUnavailable(scheduler, 'Cancel');
    const staleRetry = within(scheduler).queryByRole('button', { name: 'Retry' });
    if (staleRetry) await user.click(staleRetry);
    for (const staleCancel of within(scheduler).queryAllByRole('button', { name: 'Cancel' })) {
      await user.click(staleCancel);
    }
    expect(mutate.mock.calls).toEqual([scenario.aArgs, scenario.bArgs]);

    const aReadsBeforeRetry = schedulerReadsFor(listSchedulerAdmissions, WORKSPACE.id).length;
    const bReadsBeforeRetry = schedulerReadsFor(listSchedulerAdmissions, WORKSPACE_B.id).length;
    await user.click(within(returnedAlert).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(schedulerReadsFor(listSchedulerAdmissions, WORKSPACE.id).length).toBe(
        aReadsBeforeRetry + 1
      )
    );
    expect(schedulerReadsFor(listSchedulerAdmissions, WORKSPACE_B.id).length).toBe(
      bReadsBeforeRetry
    );
    expect(mutate.mock.calls).toEqual([scenario.aArgs, scenario.bArgs]);
    expectActionUnavailable(scheduler, 'Retry');
    expectActionUnavailable(scheduler, 'Cancel');
    expect(workerActionButton(workers)).toBeEnabled();
    poisonDom();
  });

  it.each([
    {
      name: 'Workspace search result',
      items: [SEARCH_WORKSPACE],
      title: SEARCH_WORKSPACE.title,
      destination: '/',
    },
    {
      name: 'cross-Workspace thread result',
      items: [SEARCH_CROSS_WORKSPACE],
      title: SEARCH_CROSS_WORKSPACE.title,
      destination: `/chat/${WORKSPACE_B.id}/${SEARCH_CROSS_WORKSPACE.id}`,
    },
  ])('does not navigate or read a $name under the wrong Workspace while authorized discovery is pending', async (scenario) => {
    const user = userEvent.setup();
    const discovery = createDeferred<{ items: Array<{ id: string; name: string }> }>();
    const events: string[] = [];
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      if (state.currentWorkspaceId === WORKSPACE_B.id) events.push('workspace');
    });
    let pathname = '';
    const getThread = vi.fn().mockResolvedValue({
      id: SEARCH_CROSS_WORKSPACE.id,
      workspaceId: WORKSPACE_B.id,
      name: SEARCH_CROSS_WORKSPACE.title,
      preview: SEARCH_CROSS_WORKSPACE.title,
      status: 'active',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    const listThreadItems = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const getThreadDashboard = vi.fn().mockResolvedValue({ turns: [] });
    const getWorkspaceDashboard = vi.fn().mockResolvedValue({ activeWork: [] });
    const listThreads = vi.fn().mockResolvedValue({ items: [] });
    const client = makeClient(
      {
        search: vi.fn().mockResolvedValue({ items: scenario.items }),
        getThreadDashboard,
        getWorkspaceDashboard,
      },
      {
        listWorkspaces: vi.fn().mockReturnValue(discovery.promise),
        getThread,
        listThreadItems,
        listThreads,
      }
    );
    useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id });
    renderApp('/chat', client, (next) => {
      pathname = next;
      if (next === scenario.destination) events.push('navigate');
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'What can we get done?' })
    ).toBeInTheDocument();
    await submitSearch(user);
    expect(await screen.findByText(scenario.title)).toBeInTheDocument();
    expect(pathname).toBe('/chat');
    const readsBeforePendingActivation = [
      getWorkspaceDashboard.mock.calls.length,
      getThread.mock.calls.length,
      getThreadDashboard.mock.calls.length,
      listThreadItems.mock.calls.length,
      listThreads.mock.calls.length,
    ];
    await user.click(screen.getByRole('button', { name: scenario.title }));
    expect(pathname).toBe('/chat');
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(WORKSPACE.id);
    expect([
      getWorkspaceDashboard.mock.calls.length,
      getThread.mock.calls.length,
      getThreadDashboard.mock.calls.length,
      listThreadItems.mock.calls.length,
      listThreads.mock.calls.length,
    ]).toEqual(readsBeforePendingActivation);
    expect(events).toEqual([]);

    await act(async () => {
      discovery.resolve({ items: [WORKSPACE, WORKSPACE_B] });
      await discovery.promise;
    });
    await waitFor(() => expect(listThreads).toHaveBeenCalledWith(WORKSPACE.id));
    const workspaceAReadsBeforeDestination = [
      getWorkspaceDashboard.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id)
        .length,
      getThread.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id).length,
      getThreadDashboard.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id).length,
      listThreadItems.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id).length,
      listThreads.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id).length,
    ];

    if (pathname !== scenario.destination) {
      await user.click(screen.getByRole('button', { name: scenario.title }));
    }
    await waitFor(() => expect(pathname).toBe(scenario.destination));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(WORKSPACE_B.id);
    expect(events).toEqual(['workspace', 'navigate']);
    expect([
      getWorkspaceDashboard.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id)
        .length,
      getThread.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id).length,
      getThreadDashboard.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id).length,
      listThreadItems.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id).length,
      listThreads.mock.calls.filter(([workspaceId]) => workspaceId === WORKSPACE.id).length,
    ]).toEqual(workspaceAReadsBeforeDestination);
    if (scenario.destination === '/') {
      await waitFor(() => expect(getWorkspaceDashboard).toHaveBeenCalledWith(WORKSPACE_B.id));
    } else {
      await waitFor(() =>
        expect(getThread).toHaveBeenCalledWith(WORKSPACE_B.id, SEARCH_CROSS_WORKSPACE.id)
      );
      expect(getThreadDashboard).not.toHaveBeenCalledWith(WORKSPACE.id, expect.anything());
    }
    unsubscribe();
    poisonDom();
  });

  it.each([
    {
      name: 'thread hit with workspaceId while authorized Workspace discovery is pending',
      admitted: null,
      hit: SEARCH_CROSS_WORKSPACE,
    },
    {
      name: 'workspace hit whose target is its id while authorized Workspace discovery is pending',
      admitted: null,
      hit: SEARCH_WORKSPACE,
    },
    {
      name: 'thread hit with workspaceId for an unadmitted Workspace target',
      admitted: [WORKSPACE],
      hit: SEARCH_CROSS_WORKSPACE,
    },
    {
      name: 'workspace hit whose target is its id for an unadmitted Workspace target',
      admitted: [WORKSPACE],
      hit: SEARCH_WORKSPACE,
    },
  ])('disables AppSearch hit buttons for a $name', async (scenario) => {
    const user = userEvent.setup();
    const discovery = createDeferred<{ items: Array<{ id: string; name: string }> }>();
    const client = makeClient(
      { search: vi.fn().mockResolvedValue({ items: [scenario.hit] }) },
      { listWorkspaces: vi.fn().mockReturnValue(discovery.promise) }
    );
    useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE.id });
    renderApp('/chat', client);

    expect(scenario.hit.kind === 'workspace' ? scenario.hit.id : scenario.hit.workspaceId).toBe(
      WORKSPACE_B.id
    );
    if (scenario.hit.kind === 'workspace') {
      expect(scenario.hit.workspaceId).toBeUndefined();
    } else {
      expect(scenario.hit.workspaceId).toBe(WORKSPACE_B.id);
    }
    expect(
      await screen.findByRole('heading', { level: 1, name: 'What can we get done?' })
    ).toBeInTheDocument();
    if (scenario.admitted) {
      await act(async () => {
        discovery.resolve({ items: scenario.admitted });
        await discovery.promise;
      });
    }

    await submitSearch(user);
    expect(await screen.findByRole('button', { name: scenario.hit.title })).toBeDisabled();
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(WORKSPACE.id);
    poisonDom();
  });
});
