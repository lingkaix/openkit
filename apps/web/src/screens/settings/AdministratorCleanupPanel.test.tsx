import {
  ADMINISTRATOR_CLEANUP_SOURCE_OWNERS,
  ADMINISTRATOR_CLEANUP_SOURCES,
} from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AdministratorCleanupPanel } from './AdministratorCleanupPanel';

const POISON = '/private/host/okt_cleanup_secret';
const OBSERVED = '2026-10-16T00:00:00.000Z';
const UPDATED = '2026-10-15T12:00:00.000Z';
const BRANCHES = [
  {
    target: {
      kind: 'workspace-deletion',
      workspaceId: 'ws_3c919bf6-f4bd-7d60-8755-c67c20dcf237',
      requestId: 'request-one',
    },
    state: { phase: 'deleted', retainedStaging: true, cleanedAt: null },
  },
  {
    target: {
      kind: 'execution-attempt',
      attemptId: 'attempt_f9c6cef9-2db3-75ed-a8c5-99206a9d11f5',
      workspaceId: 'ws_3c919bf6-f4bd-7d60-8755-c67c20dcf237',
      threadId: 'th_ff796616-1965-7eef-acb4-499c0037e154',
      turnId: 'tu_e4a5f46a-b4b1-74ec-af04-0a61497a90db',
      agentSessionId: null,
    },
    state: { phase: 'closed', disposition: 'unknown' },
  },
  {
    target: {
      kind: 'backend-session',
      attemptId: 'attempt_072ae584-6557-7309-be35-7e25ceeed815',
      workspaceId: 'ws_2a45e7bf-14f3-75a5-b6ba-4c882c39b860',
      threadId: 'th_44a0ec5a-ea17-71c2-b5a5-cf5aec8b20fa',
      turnId: 'tu_ad0b0bac-3955-7171-a6e6-94c53ef0f7d6',
      agentSessionId: 'as_e88d664a-fd4b-799e-a5bf-3bf7f663b027',
    },
    state: {
      state: 'cleanup-failed',
      workspaceHandoffState: 'pending',
      physicalCleanedAt: null,
      physicalEpochRelation: 'different',
    },
  },
  {
    target: {
      kind: 'agent-session-binding',
      agentSessionRuntimeBindingId: 'binding-three',
      agentSessionId: 'as_fee220fe-1629-7f75-9f57-87629c409d80',
      workspaceId: 'ws_683c43e2-2c97-7b27-8e0c-41c76f7818c9',
      threadId: 'th_48e5122c-8863-775b-be40-6388b0b26140',
    },
    state: { lifecycleState: 'closed', cleanupState: 'unknown' },
  },
  {
    target: {
      kind: 'sandbox-runtime',
      sandboxRuntimeId: 'sandbox-four',
      runtimeTargetId: 'runtime-four',
    },
    state: {
      lifecycleState: 'failed',
      healthState: 'unknown',
      drainState: 'draining',
      cleanupState: 'unknown',
      physicalEpochRelation: 'different',
    },
  },
  {
    target: {
      kind: 'worker-storage',
      storageRef: 'wst_2809c9c9-3f50-781c-897b-f0ec89bb00bb',
      workspaceId: 'ws_20d19367-bd48-7cea-9dea-f5f2e5f3c240',
      runtimeTargetId: 'runtime-five',
    },
    state: { state: 'purge-pending', revision: 4, purgedAt: null },
  },
];

/** Produce the six source records with distinct exact identities and no inferred cleanup. */
function response() {
  return {
    observedAt: OBSERVED,
    incomplete: false,
    sources: ADMINISTRATOR_CLEANUP_SOURCES.map((source) => ({
      source,
      availability: 'available',
      incomplete: false,
      reasons: [] as string[],
    })),
    items: ADMINISTRATOR_CLEANUP_SOURCES.map((source, index) => {
      const branch = structuredClone(BRANCHES[index]);
      return {
        source,
        sourceOwner: ADMINISTRATOR_CLEANUP_SOURCE_OWNERS[source],
        ...branch,
        sourceUpdatedAt: UPDATED as string | null,
        observedAt: OBSERVED,
        evidence:
          index === 0
            ? { kind: 'recorded', recordedAt: UPDATED, reference: branch.target }
            : { kind: 'unknown', reason: 'stale' },
        nextInspection: {
          kind: 'source-record',
          sourceOwner: ADMINISTRATOR_CLEANUP_SOURCE_OWNERS[source],
          target: branch.target,
        },
      };
    }),
  };
}

/** Provide only the supported server read; any other operation fails the test. */
function mount(
  read = vi.fn().mockResolvedValue(response()),
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  const client = { operations: { 'administration.cleanup-read': read } } as unknown as CoreClient;
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <AdministratorCleanupPanel />
        </CoreClientProvider>
      </QueryClientProvider>
    ),
    read,
    queryClient,
  };
}

describe('Administrator cleanup inspection', () => {
  it('reads all six sources and discloses exact target, state, evidence and inspection correlation', async () => {
    const { read } = mount();
    await screen.findByRole('heading', { name: 'Workspace deletion' });
    expect(read).toHaveBeenCalledExactlyOnceWith({});
    for (const name of [
      'Workspace deletion',
      'Execution attempts',
      'Backend sessions',
      'AgentSession bindings',
      'Sandbox runtimes',
      'Worker storage',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    const records = screen.getAllByRole('article');
    expect(records).toHaveLength(6);
    expect(within(records[0]).getByText('deleted')).toBeInTheDocument();
    expect(within(records[0]).getByText('Yes')).toBeInTheDocument();
    expect(within(records[0]).getByText('Recorded evidence')).toBeInTheDocument();
    expect(within(records[1]).getByText('closed')).toBeInTheDocument();
    expect(within(records[1]).getByText('Unknown evidence: stale')).toBeInTheDocument();
    expect(within(records[2]).getByText('cleanup-failed')).toBeInTheDocument();
    expect(within(records[2]).getByText('pending')).toBeInTheDocument();
    expect(within(records[2]).getByText('different')).toBeInTheDocument();
    expect(within(records[4]).getByText('draining')).toBeInTheDocument();
    expect(within(records[5]).getByText('purge-pending')).toBeInTheDocument();
    expect(within(records[5]).getByText('4')).toBeInTheDocument();
    for (const [index, record] of records.entries()) {
      for (const value of Object.values(BRANCHES[index].target)) {
        if (value !== null)
          expect(within(record).getAllByText(value, { exact: true })[0]).toBeVisible();
      }
      expect(within(record).getByText(OBSERVED)).toBeInTheDocument();
      expect(within(record).getAllByText(UPDATED).length).toBeGreaterThan(0);
      await userEvent.click(within(record).getByRole('button', { name: 'Inspection correlation' }));
      const disclosure = within(record).getByRole('group', { name: 'Inspection correlation' });
      expect(within(disclosure).getByText('source-record')).toBeInTheDocument();
      expect(
        within(disclosure).getByText(
          ADMINISTRATOR_CLEANUP_SOURCE_OWNERS[ADMINISTRATOR_CLEANUP_SOURCES[index]]
        )
      ).toBeInTheDocument();
      for (const value of Object.values(BRANCHES[index].target)) {
        if (value !== null)
          expect(within(disclosure).getByText(value, { exact: true })).toBeInTheDocument();
      }
    }
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /delete|purge|clean now/i })
    ).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('shows incomplete and unavailable source coverage without an empty all-clear', async () => {
    const data = response();
    data.items = [];
    data.incomplete = true;
    data.sources[0] = {
      ...data.sources[0],
      availability: 'unavailable',
      incomplete: true,
      reasons: ['source_unavailable'],
    };
    data.sources[1] = {
      ...data.sources[1],
      incomplete: true,
      reasons: ['count_limit', 'byte_limit', 'source_changed'],
    };
    mount(vi.fn().mockResolvedValue(data));
    expect(await screen.findByText('Coverage incomplete')).toBeInTheDocument();
    for (const reason of [
      'Source unavailable',
      'Count limit reached',
      'Byte limit reached',
      'Source changed during inspection',
    ]) {
      expect(screen.getByText(reason)).toBeInTheDocument();
    }
    expect(screen.getAllByText('No records returned.').length).toBe(6);
    expect(screen.queryByText(/all clean|cleanup complete/i)).not.toBeInTheDocument();
  });

  it('drops unknown additions before cache and keeps missing evidence unknown', async () => {
    const data = response();
    data.items[1].sourceUpdatedAt = null;
    data.items[1].evidence = { kind: 'unknown', reason: 'missing' };
    const decorated = {
      ...data,
      extra: POISON,
      sources: data.sources.map((source) => ({ ...source, extra: POISON })),
      items: data.items.map((item) => ({
        ...item,
        extra: POISON,
        state: { ...item.state, extra: POISON },
        target: { ...item.target, extra: POISON },
        evidence: { ...item.evidence, extra: POISON },
        nextInspection: {
          ...item.nextInspection,
          extra: POISON,
          target: { ...item.target, extra: POISON },
        },
      })),
    };
    const { container, queryClient } = mount(vi.fn().mockResolvedValue(decorated));
    expect(await screen.findByText('Unknown evidence: missing')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(POISON);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data)
      )
    ).not.toContain(POISON);
  });

  it.each([
    401, 403, 500,
  ])('hides prior records after a %s refresh failure and explicitly retries', async (status) => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new ApiCallError(status, POISON, { details: { secret: POISON } }))
      .mockResolvedValueOnce({ ...response(), items: [] });
    const { container, queryClient } = mount(read);
    await screen.findByRole('article', { name: 'Workspace deletion record' });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh cleanup inspection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      status === 500 ? 'Cleanup inspection failed.' : 'Administrator access required.'
    );
    expect(container.innerHTML).not.toContain('request-one');
    expect(container.innerHTML).not.toContain(POISON);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.error)
      )
    ).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Retry cleanup inspection' }));
    expect(await screen.findAllByText('No records returned.')).toHaveLength(6);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([
    401, 403,
  ])('shows initial %s denial without exposing server error content', async (status) => {
    const { container } = mount(vi.fn().mockRejectedValue(new ApiCallError(status, POISON)));
    expect(await screen.findByRole('alert')).toHaveTextContent('Administrator access required.');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(POISON);
  });

  it('shows loading, blocks repeated refresh, and replaces the observation after refresh', async () => {
    let settle: (value: ReturnType<typeof response>) => void = () => {};
    const read = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          })
      );
    mount(read);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    await screen.findByRole('article', { name: 'Workspace deletion record' });
    const refresh = screen.getByRole('button', { name: 'Refresh cleanup inspection' });
    await userEvent.click(refresh);
    expect(refresh).toBeDisabled();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    await userEvent.click(refresh);
    expect(read).toHaveBeenCalledTimes(2);
    await act(() => settle({ ...response(), items: [] }));
    expect(await screen.findAllByText('No records returned.')).toHaveLength(6);
    expect(screen.queryByText('request-one')).not.toBeInTheDocument();
  });

  it('discards a previous mount pending response and requires a new current-authority read', async () => {
    let oldResult!: (value: ReturnType<typeof response>) => void;
    let currentResult!: (value: ReturnType<typeof response>) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldResult = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            currentResult = resolve;
          })
      );
    const first = mount(read);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    first.unmount();
    mount(read, first.queryClient);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(() => oldResult(response()));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    await act(() => currentResult({ ...response(), items: [] }));
    expect(await screen.findAllByText('No records returned.')).toHaveLength(6);
    expect(screen.queryByText('request-one')).not.toBeInTheDocument();
  });

  it('requires a read on this mount before showing cached source identifiers', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
    });
    queryClient.setQueryData(['settings', 'administrator-cleanup'], response());
    let settle: (value: ReturnType<typeof response>) => void = () => {};
    const read = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const { container } = mount(read, queryClient);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain('request-one');
    expect(read).toHaveBeenCalledExactlyOnceWith({});
    await act(() => settle(response()));
    expect(
      await screen.findByRole('article', { name: 'Workspace deletion record' })
    ).toBeInTheDocument();
  });

  it.each([
    'unknown state',
    'incorrect correlation',
    'too many records',
  ])('fails closed on %s instead of displaying untrusted content', async (invalid) => {
    const data = response();
    if (invalid === 'unknown state') Object.assign(data.items[0].state, { phase: POISON });
    if (invalid === 'incorrect correlation')
      Object.assign(data.items[0].nextInspection, {
        target: { ...data.items[0].target, requestId: POISON },
      });
    if (invalid === 'too many records')
      data.items = Array.from({ length: 101 }, () => data.items[0]);
    const { container, queryClient } = mount(vi.fn().mockResolvedValue(data));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cleanup inspection failed.');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(POISON);
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined)
    ).toBe(true);
  });
});
