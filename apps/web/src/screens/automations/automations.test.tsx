import type { AutomationHistoryResponse, AutomationRecord } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient, type WorkspaceRecord } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';
import { AutomationsScreen } from './AutomationsScreen';

const connection = vi.hoisted(() => ({ failed: false }));

vi.mock('../../app/core-client', async (original) => ({
  ...(await original<typeof import('../../app/core-client')>()),
  useConnection: () => ({ checking: false, failed: connection.failed }),
}));

const at = '2026-10-16T00:00:00.000Z';
const resumeAt = '2999-01-01T00:00:00.000Z';
const workspace: WorkspaceRecord = {
  id: 'ws1',
  kind: 'general',
  name: 'Project',
  status: 'active',
  createdAt: at,
  updatedAt: at,
  counts: { artifactCount: 0, knowledgeEntryCount: 0, threadCount: 1 },
};
const original: AutomationRecord = {
  id: 'auto_one',
  workspaceId: 'ws1',
  threadId: 'th1',
  name: 'Poll status',
  intervalSeconds: 60,
  prompt: 'Inspect the build',
  responsibleUserId: 'user_creator',
  actor: { kind: 'automation', id: 'auto_one', responsibleUserId: 'user_creator' },
  status: 'paused',
  revision: 1,
  nextScheduledAt: null,
  greatestAccountedScheduledAt: null,
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
};

type Occurrence = Extract<
  AutomationHistoryResponse['items'][number],
  { kind: 'occurrence' }
>['record'];
/** A returned admission projection, distinct from an actual retained Turn. */
function occurrenceRecord(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: 'occ1',
    scheduleId: original.id,
    workspaceId: 'ws1',
    definitionRevision: 1,
    scheduledAt: at,
    deadline: '2026-10-16T00:10:00.000Z',
    snapshot: original,
    state: 'admission-accepted',
    attempts: [{ number: 1, at, code: 'accepted', summary: 'Accepted' }],
    requestId: '7ac2de20-ea21-4d37-8f16-62532bf2871d',
    queueEntryId: 'queue1',
    turnId: 'turn1',
    createdAt: at,
    terminalAt: at,
    resolvedSelection: { agentId: 'worker', profileId: null, modelId: 'model' },
    schedulerStatus: 'queued',
    publicationIssue: null,
    ...overrides,
  };
}

/** Real typed operation boundary; mutable fixture records model only returned server truth. */
function fixture(overrides: Partial<CoreClient['operations']> = {}, initial = [original]) {
  let records = initial;
  const operations = {
    'workspace.list': vi.fn<CoreClient['operations']['workspace.list']>().mockResolvedValue({
      items: [workspace, { ...workspace, id: 'ws2', name: 'Other' }].map((record) => ({
        workspace: record,
        effectiveRole: 'owner',
        membershipStatus: 'active',
        accessCause: 'membership',
        membershipRevision: 1,
        ownerUserId: 'user_creator',
        registryRevision: 1,
      })),
    }),
    'thread.list': vi
      .fn<CoreClient['operations']['thread.list']>()
      .mockImplementation(async ({ workspaceId }) => ({
        items: [
          {
            id: 'th1',
            workspaceId,
            name: 'Target thread',
            preview: 'Target',
            status: 'active',
            entryPath: 'conversation',
            visibility: 'workspace',
            createdAt: at,
            updatedAt: at,
          },
        ],
      })),
    'automation.list': vi
      .fn<CoreClient['operations']['automation.list']>()
      .mockImplementation(async () => ({ items: records })),
    'automation.create': vi
      .fn<CoreClient['operations']['automation.create']>()
      .mockImplementation(async (input) => {
        const record = {
          ...original,
          ...input,
          id: 'auto_new',
          actor: { ...original.actor, id: 'auto_new' },
          status: 'paused' as const,
        };
        if (input.monthlyUtc) Reflect.deleteProperty(record, 'intervalSeconds');
        records = [...records, record];
        return record;
      }),
    'automation.update': vi
      .fn<CoreClient['operations']['automation.update']>()
      .mockImplementation(async ({ automationId, expectedRevision, scheduledAt, ...input }) => {
        const record = records.find((r) => r.id === automationId)!;
        const updated = {
          ...record,
          ...input,
          revision: expectedRevision + 1,
          nextScheduledAt: scheduledAt ?? null,
        } as AutomationRecord;
        if (input.monthlyUtc) Reflect.deleteProperty(updated, 'intervalSeconds');
        if (input.intervalSeconds !== undefined) Reflect.deleteProperty(updated, 'monthlyUtc');
        records = records.map((r) => (r.id === automationId ? updated : r));
        return updated;
      }),
    'automation.delete': vi
      .fn<CoreClient['operations']['automation.delete']>()
      .mockImplementation(async ({ automationId }) => {
        records = records.map((r) => (r.id === automationId ? { ...r, status: 'deleted' } : r));
        return null;
      }),
    'scheduler.cancel': vi
      .fn<CoreClient['operations']['scheduler.cancel']>()
      .mockResolvedValue({ cancelled: true }),
    'automation.history': vi
      .fn<CoreClient['operations']['automation.history']>()
      .mockResolvedValue({ items: [], nextBefore: null }),
    ...overrides,
  };
  const client = { operations } as unknown as CoreClient;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <AutomationsScreen />
        </CoreClientProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
  return { operations, queryClient };
}

beforeEach(() => {
  connection.failed = false;
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1', selectionUserKey: null });
});
afterEach(cleanup);

it('creates a paused fixed-interval schedule in the selected Workspace and existing Thread', async () => {
  const user = userEvent.setup();
  const { operations } = fixture({}, []);
  expect(await screen.findByText('No automations')).toBeInTheDocument();
  await user.type(screen.getByLabelText('Name'), 'Daily check');
  await user.type(screen.getByLabelText('Worker input'), 'Inspect status');
  await user.click(screen.getByRole('button', { name: /Target Thread/ }));
  await user.click(screen.getByRole('option', { name: 'Target thread' }));
  await user.dblClick(screen.getByRole('button', { name: 'Create paused automation' }));
  await waitFor(() =>
    expect(operations['automation.create']).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      threadId: 'th1',
      name: 'Daily check',
      prompt: 'Inspect status',
      intervalSeconds: 60,
    })
  );
  expect(operations['automation.create']).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('Daily check')).toBeInTheDocument();
  expect(screen.getByText('Automation created paused.')).toBeInTheDocument();
});

it('edits paused bytes, resumes at an explicit UTC instant, pauses, then confirms deletion using current revisions', async () => {
  const user = userEvent.setup();
  const { operations } = fixture();
  await user.click(await screen.findByRole('button', { name: 'Edit Poll status' }));
  await user.clear(screen.getByLabelText('Edit name'));
  await user.type(screen.getByLabelText('Edit name'), 'Edited schedule');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(operations['automation.update']).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: original.id,
        expectedRevision: 1,
        name: 'Edited schedule',
      })
    )
  );
  await user.click(await screen.findByRole('button', { name: 'Resume Edited schedule' }));
  await user.type(screen.getByLabelText('Next nominal instant (UTC)'), resumeAt);
  await user.click(screen.getByRole('button', { name: 'Confirm resume' }));
  await waitFor(() =>
    expect(operations['automation.update']).toHaveBeenLastCalledWith({
      automationId: original.id,
      expectedRevision: 2,
      status: 'active',
      scheduledAt: resumeAt,
    })
  );
  await user.click(await screen.findByRole('button', { name: 'Pause Edited schedule' }));
  await waitFor(() =>
    expect(operations['automation.update']).toHaveBeenLastCalledWith({
      automationId: original.id,
      expectedRevision: 3,
      status: 'paused',
    })
  );
  await user.click(await screen.findByRole('button', { name: 'Delete Edited schedule' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete automation' });
  expect(within(dialog).getByText(/Accepted work continues/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Delete automation' }));
  await waitFor(() =>
    expect(operations['automation.delete']).toHaveBeenCalledWith({ automationId: original.id })
  );
  expect(await screen.findByText('deleted')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Resume Edited schedule' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit Edited schedule' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Delete Edited schedule' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'History Edited schedule' }));
  expect(await screen.findByText('No occurrences recorded.')).toBeInTheDocument();
  expect(operations['automation.history']).toHaveBeenCalledWith({
    automationId: original.id,
    limit: 32,
  });
});

it('shows accepted-but-queued, typed failed attempts, exact ranges and bounded history pagination', async () => {
  const user = userEvent.setup();
  const occurrence = { kind: 'occurrence' as const, record: occurrenceRecord() };
  const first: AutomationHistoryResponse = {
    items: [
      occurrence,
      {
        ...occurrence,
        record: {
          ...occurrence.record,
          id: 'occ2',
          state: 'admission-failed',
          queueEntryId: null,
          turnId: null,
          schedulerStatus: null,
          attempts: [
            {
              number: 1,
              at,
              code: 'queue_backlog_full',
              summary: 'Do not display raw dependency diagnostics',
            },
          ],
        },
      },
    ],
    nextBefore: at,
  };
  const second: AutomationHistoryResponse = {
    items: [
      {
        kind: 'expired-range',
        record: {
          id: 'range1',
          scheduleId: original.id,
          workspaceId: 'ws1',
          definitionRevision: 1,
          intervalSeconds: 60,
          firstScheduledAt: '2026-10-15T00:00:00.000Z',
          lastScheduledAt: '2026-10-15T00:59:00.000Z',
          count: 60,
          reason: 'deadline_elapsed',
          snapshot: original,
          createdAt: at,
          terminalAt: at,
        },
      },
    ],
    nextBefore: null,
  };
  const history = vi
    .fn<CoreClient['operations']['automation.history']>()
    .mockResolvedValueOnce(first)
    .mockResolvedValue(second);
  fixture({ 'automation.history': history });
  await user.click(await screen.findByRole('button', { name: 'History Poll status' }));
  expect(await screen.findByText('Admission accepted')).toBeInTheDocument();
  expect(screen.getByText('Scheduler: queued')).toBeInTheDocument();
  expect(screen.getByText(/queue_backlog_full/)).toBeInTheDocument();
  expect(screen.queryByText('Do not display raw dependency diagnostics')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View Turn turn1' })).toHaveAttribute(
    'href',
    '/chat/ws1/th1?turnId=turn1'
  );
  await user.click(screen.getByRole('button', { name: 'Load older history' }));
  expect(await screen.findByText(/60 expired instants/)).toBeInTheDocument();
  expect(screen.getByText(/2026-10-15T00:59:00.000Z/)).toBeInTheDocument();
  expect(history).toHaveBeenLastCalledWith({ automationId: original.id, limit: 32, before: at });
});

it('blocks duplicate pending actions and isolates late responses after a Workspace switch', async () => {
  const user = userEvent.setup();
  let resolve!: (record: AutomationRecord) => void;
  const update = vi.fn<CoreClient['operations']['automation.update']>().mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  fixture({ 'automation.update': update });
  await user.click(await screen.findByRole('button', { name: 'Resume Poll status' }));
  await user.type(screen.getByLabelText('Next nominal instant (UTC)'), resumeAt);
  await user.dblClick(screen.getByRole('button', { name: 'Confirm resume' }));
  expect(update).toHaveBeenCalledTimes(1);
  act(() => useWorkspaceStore.getState().setCurrentWorkspaceId('ws2'));
  await waitFor(() => expect(screen.queryByText('Poll status')).not.toBeInTheDocument());
  await act(async () => resolve({ ...original, status: 'active', revision: 2 }));
  expect(screen.queryByText('Poll status')).not.toBeInTheDocument();
  expect(screen.queryByText('Automation resumed.')).not.toBeInTheDocument();
});

it.each([
  { kind: 'transport', failure: new TypeError('private transport detail') },
  { kind: 'HTTP 500', failure: new ApiCallError(500, 'private transport detail') },
])('$kind: hides denied reads, keeps errors safe and prevents blind retry after an unknown create outcome', async ({
  failure,
}) => {
  const user = userEvent.setup();
  const denied = new ApiCallError(403, 'private dependency diagnostics', {
    code: 'workspace_access_denied',
  });
  const listed = vi
    .fn<CoreClient['operations']['automation.list']>()
    .mockRejectedValueOnce(denied)
    .mockResolvedValue({ items: [] });
  const create = vi.fn<CoreClient['operations']['automation.create']>().mockRejectedValue(failure);
  fixture({ 'automation.list': listed, 'automation.create': create }, []);
  expect(await screen.findByText('Access denied.')).toBeInTheDocument();
  expect(screen.queryByText('No automations')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Refresh automations' }));
  await user.type(await screen.findByLabelText('Name'), 'Check');
  await user.type(screen.getByLabelText('Worker input'), 'Inspect');
  await user.click(screen.getByRole('button', { name: /Target Thread/ }));
  await user.click(screen.getByRole('option', { name: 'Target thread' }));
  await user.click(screen.getByRole('button', { name: 'Create paused automation' }));
  expect(await screen.findByText(/Outcome unknown/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create paused automation' })).toBeDisabled();
  expect(
    screen.queryByText(/private transport detail|private dependency diagnostics/)
  ).not.toBeInTheDocument();
});

it('isolates a late collection response after the selected Workspace changes', async () => {
  let resolve!: (value: { items: AutomationRecord[] }) => void;
  const listed = vi
    .fn<CoreClient['operations']['automation.list']>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    )
    .mockResolvedValue({
      items: [{ ...original, id: 'auto_other', workspaceId: 'ws2', name: 'Other schedule' }],
    });
  fixture({ 'automation.list': listed });
  await waitFor(() => expect(listed).toHaveBeenCalledTimes(1));
  act(() => useWorkspaceStore.getState().setCurrentWorkspaceId('ws2'));
  expect(await screen.findByText('Other schedule')).toBeInTheDocument();
  await act(async () => resolve({ items: [original] }));
  expect(screen.queryByText('Poll status')).not.toBeInTheDocument();
  expect(screen.getByText('Other schedule')).toBeInTheDocument();
});

it('retains a conflicted draft and requires a read before a new revision-bound request', async () => {
  const user = userEvent.setup();
  const changed = { ...original, name: 'Changed elsewhere', revision: 5 };
  let conflicted = false;
  const listed = vi
    .fn<CoreClient['operations']['automation.list']>()
    .mockImplementation(async () => ({ items: [conflicted ? changed : original] }));
  const update = vi
    .fn<CoreClient['operations']['automation.update']>()
    .mockImplementation(async () => {
      conflicted = true;
      throw new ApiCallError(409, 'private conflict details');
    });
  fixture({ 'automation.list': listed, 'automation.update': update });
  await user.click(await screen.findByRole('button', { name: 'Edit Poll status' }));
  await user.clear(screen.getByLabelText('Edit name'));
  await user.type(screen.getByLabelText('Edit name'), 'Keep my draft');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText(/The automation changed/)).toBeInTheDocument();
  expect(screen.getByLabelText('Edit name')).toHaveValue('Keep my draft');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  expect(screen.queryByText('private conflict details')).not.toBeInTheDocument();
  await user.click(
    screen.getByRole('button', { name: 'Refresh definition before another action' })
  );
  await user.click(await screen.findByRole('button', { name: 'Edit Changed elsewhere' }));
  expect(screen.getByLabelText('Edit name')).toHaveValue('Changed elsewhere');
  expect(update).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ automationId: original.id, expectedRevision: 5 })
    )
  );
});

it('keeps known definitions readable while disabling changes during a disconnected state', async () => {
  connection.failed = true;
  fixture();
  expect(await screen.findByText('Poll status')).toBeInTheDocument();
  expect(screen.getByText(/Changes are disabled until the connection returns/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Resume Poll status' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Edit Poll status' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Delete Poll status' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Create paused automation' })).toBeDisabled();
});

it('removes previously readable rows when an explicit refetch is denied', async () => {
  const user = userEvent.setup();
  const listed = vi
    .fn<CoreClient['operations']['automation.list']>()
    .mockResolvedValueOnce({ items: [original] })
    .mockRejectedValue(
      new ApiCallError(403, 'private denial detail', { code: 'workspace_access_denied' })
    );
  fixture({ 'automation.list': listed });
  expect(await screen.findByText('Poll status')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Refresh automations' }));
  expect(await screen.findByText('Access denied.')).toBeInTheDocument();
  expect(screen.queryByText('Poll status')).not.toBeInTheDocument();
  expect(screen.queryByText('No automations')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Create paused automation' })
  ).not.toBeInTheDocument();
});

it.each([
  'turn_missing',
  'turn_contradictory',
] as const)('shows %s without a Turn link and cancels only the existing queued admission', async (publicationIssue) => {
  const user = userEvent.setup();
  let cancelled = false;
  let finish!: (value: { cancelled: boolean }) => void;
  const history = vi
    .fn<CoreClient['operations']['automation.history']>()
    .mockImplementation(async () => ({
      items: [
        {
          kind: 'occurrence',
          record: occurrenceRecord({
            publicationIssue,
            turnId: publicationIssue === 'turn_missing' ? null : 'turn1',
            schedulerStatus: cancelled ? 'cancelled' : 'queued',
          }),
        },
      ],
      nextBefore: null,
    }));
  const cancel = vi.fn<CoreClient['operations']['scheduler.cancel']>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = (value) => {
          cancelled = true;
          resolve(value);
        };
      })
  );
  const { operations } = fixture({ 'automation.history': history, 'scheduler.cancel': cancel });
  await user.click(await screen.findByRole('button', { name: 'History Poll status' }));
  expect(await screen.findByText(/Inspection required \(recovery_required\)/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /View Turn/ })).not.toBeInTheDocument();
  await user.dblClick(screen.getByRole('button', { name: 'Cancel queued admission' }));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith({ workspaceId: 'ws1', queueEntryId: 'queue1' });
  expect(screen.getByRole('button', { name: 'Cancelling queued admission…' })).toBeDisabled();
  await act(async () => finish({ cancelled: true }));
  expect(await screen.findByText('Scheduler: cancelled')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel queued admission' })).not.toBeInTheDocument();
  expect(operations['automation.create']).not.toHaveBeenCalled();
  expect(operations['automation.update']).not.toHaveBeenCalled();
  expect(history).toHaveBeenCalledTimes(2);
});

it('does not replay a queue cancellation after an unknown outcome', async () => {
  const user = userEvent.setup();
  const cancel = vi
    .fn<CoreClient['operations']['scheduler.cancel']>()
    .mockRejectedValue(new TypeError('private cancellation detail'));
  fixture({
    'automation.history': vi
      .fn<CoreClient['operations']['automation.history']>()
      .mockResolvedValue({
        items: [
          {
            kind: 'occurrence',
            record: occurrenceRecord({ publicationIssue: 'turn_missing', turnId: null }),
          },
        ],
        nextBefore: null,
      }),
    'scheduler.cancel': cancel,
  });
  await user.click(await screen.findByRole('button', { name: 'History Poll status' }));
  await user.click(await screen.findByRole('button', { name: 'Cancel queued admission' }));
  expect(await screen.findByText(/Outcome unknown/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel queued admission' })).toBeDisabled();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('private cancellation detail')).not.toBeInTheDocument();
  await user.click(
    screen.getByRole('button', { name: 'Refresh history before another cancellation' })
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Cancel queued admission' })).not.toBeDisabled()
  );
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('creates only the admitted monthly UTC rule and rejects day 29 before submission', async () => {
  const user = userEvent.setup();
  const { operations } = fixture({}, []);
  await screen.findByText('No automations');
  await user.type(screen.getByLabelText('Name'), 'Monthly review');
  await user.type(screen.getByLabelText('Worker input'), 'Inspect monthly status');
  await user.click(screen.getByRole('button', { name: /Target Thread/ }));
  await user.click(screen.getByRole('option', { name: 'Target thread' }));
  await user.click(screen.getByRole('button', { name: /Cadence/ }));
  await user.click(screen.getByRole('option', { name: 'Monthly UTC' }));
  await user.clear(screen.getByLabelText('Day of month (UTC)'));
  await user.type(screen.getByLabelText('Day of month (UTC)'), '29');
  expect(screen.getByRole('button', { name: 'Create paused automation' })).toBeDisabled();
  expect(operations['automation.create']).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText('Day of month (UTC)'));
  await user.type(screen.getByLabelText('Day of month (UTC)'), '28');
  await user.clear(screen.getByLabelText('Time (UTC)'));
  await user.type(screen.getByLabelText('Time (UTC)'), '09:30:00');
  await user.click(screen.getByRole('button', { name: 'Create paused automation' }));
  await waitFor(() =>
    expect(operations['automation.create']).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      threadId: 'th1',
      name: 'Monthly review',
      prompt: 'Inspect monthly status',
      monthlyUtc: { zone: 'UTC', dayOfMonth: 28, hour: 9, minute: 30, second: 0 },
    })
  );
  expect(operations['automation.create']).toHaveBeenCalledTimes(1);
  expect(
    await screen.findByText('Monthly UTC · day 28 at 09:30:00 · revision 1')
  ).toBeInTheDocument();
});

it('keeps monthly edit values and rejects a resume instant outside the recorded UTC rule', async () => {
  const user = userEvent.setup();
  const { intervalSeconds: _interval, ...base } = original;
  const monthly: AutomationRecord = {
    ...base,
    monthlyUtc: { zone: 'UTC', dayOfMonth: 28, hour: 9, minute: 30, second: 0 },
  };
  const { operations } = fixture({}, [monthly]);
  await user.click(await screen.findByRole('button', { name: 'Edit Poll status' }));
  expect(screen.getByLabelText('Edit day of month (UTC)')).toHaveValue('28');
  expect(screen.getByLabelText('Edit time (UTC)')).toHaveValue('09:30:00');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(operations['automation.update']).toHaveBeenCalledWith({
      automationId: original.id,
      expectedRevision: 1,
      name: original.name,
      prompt: original.prompt,
      threadId: original.threadId,
      monthlyUtc: monthly.monthlyUtc,
      agentId: null,
      profileId: null,
      modelId: null,
    })
  );
  await user.click(screen.getByRole('button', { name: 'Close edit' }));
  await user.click(screen.getByRole('button', { name: 'Resume Poll status' }));
  const instant = screen.getByLabelText('Next nominal instant (UTC)');
  await user.type(instant, '2999-02-27T09:30:00.000Z');
  expect(screen.getByRole('button', { name: 'Confirm resume' })).toBeDisabled();
  await user.clear(instant);
  await user.type(instant, '2999-02-28T09:30:00.001Z');
  expect(screen.getByRole('button', { name: 'Confirm resume' })).toBeDisabled();
  await user.clear(instant);
  await user.type(instant, '2999-02-28T09:30:00.000Z');
  await user.click(screen.getByRole('button', { name: 'Confirm resume' }));
  await waitFor(() =>
    expect(operations['automation.update']).toHaveBeenLastCalledWith({
      automationId: original.id,
      expectedRevision: 2,
      status: 'active',
      scheduledAt: '2999-02-28T09:30:00.000Z',
    })
  );
});
