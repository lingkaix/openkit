import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { SURFACE_ELEMENTS } from '../../app/routes';
import { surfaceById, surfacesInGroup } from '../../app/surfaces';

const SECRET = 'okt_server_audit_poison';
const PRIVATE = 'private-payload-must-not-escape';
const OCCURRED_AT = '2026-09-17T04:00:00.000Z';
const CREATED_AT = '2026-01-02T00:00:00.000Z';
const DECISION_AT = '2026-08-01T18:30:00.000Z';

/** Formats a recorded instant the same way the evidence rows do. */
function formatRecordedTime(value: string) {
  return new Date(value).toLocaleString(undefined, { timeZoneName: 'short' });
}

/** Provides only the two authorized server reads; any other client call fails. */
function makeClient(app: Partial<CoreClient['operations']> = {}): CoreClient {
  return {
    operations: {
      'audit.server-list': vi.fn().mockResolvedValue({
        token: PRIVATE,
        auditEvents: [
          {
            id: 'audit_1',
            category: 'permission',
            action: 'server.inspect',
            outcome: 'succeeded',
            summary: `Inspection ${SECRET}`,
            actor: { kind: 'user', id: 'user_recorded', name: PRIVATE },
            workspaceId: 'ws_recorded',
            threadId: 'th_recorded',
            payload: PRIVATE,
          },
        ],
      }),
      'permission.server-list': vi.fn().mockResolvedValue({
        secret: PRIVATE,
        permissionDecisions: [
          {
            decisionId: 'decision_1',
            action: `server.read ${SECRET}`,
            result: 'deny',
            subjectSummary: PRIVATE,
            resourceSummary: PRIVATE,
            contextSummary: PRIVATE,
            reasonCode: PRIVATE,
          },
        ],
      }),
      ...app,
    },
  } as unknown as CoreClient;
}

/** Renders the production registered screen without any selected Workspace. */
function renderScreen(
  client: CoreClient,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter>{SURFACE_ELEMENTS['server-audit'] ?? null}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...rendered, queryClient };
}

describe('Server audit administration', () => {
  it('shares recorded actor and exact Thread navigation without inventing missing lineage', async () => {
    renderScreen(makeClient({
      'audit.server-list': vi.fn().mockResolvedValue({
        auditEvents: [
          { id: 'recorded', category: 'command', action: 'turn.interrupt', outcome: 'succeeded',
            summary: 'Stop accepted', actor: { kind: 'agent', id: 'agent_recorded', responsibleUserId: PRIVATE },
            workspaceId: 'ws_recorded', threadId: 'th_recorded', turnId: 'turn_recorded', requestId: '019a0000-0000-7000-8000-000000000014' },
          { id: 'historical', category: 'command', action: 'legacy.action', outcome: 'succeeded',
            summary: 'Historical event', actor: null, workspaceId: null, threadId: 'unresolved_thread' },
        ],
      }),
    }));
    expect(await screen.findByText('Actor: agent · agent_recorded')).toBeVisible();
    expect(screen.getByText('Actor not recorded')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Thread th_recorded in Workspace ws_recorded' }))
      .toHaveAttribute('href', '/chat/ws_recorded/th_recorded');
    expect(screen.getAllByRole('link', { name: /^Open Thread / })).toHaveLength(1);
    expect(screen.getByText('Turn: turn_recorded')).toBeVisible();
    expect(screen.getByText('Request: 019a0000-0000-7000-8000-000000000014')).toBeVisible();
    expect(document.body.textContent).not.toContain('unresolved_thread');
    expect(document.body.textContent).not.toContain(PRIVATE);
  });

  it('publishes a distinct Settings admin destination and loads both server APIs without Workspace arguments', async () => {
    expect(surfaceById('server-audit')).toMatchObject({
      path: '/settings/server-audit',
      tier: 'A',
      nav: 'settings-admin',
    });
    expect(surfacesInGroup('settings-admin').map(({ id }) => id)).toContain('server-audit');
    const client = makeClient();
    renderScreen(client);
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    expect(screen.getByText('server.read [redacted]')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(client.operations['audit.server-list']).toHaveBeenCalledExactlyOnceWith({});
    expect(client.operations['permission.server-list']).toHaveBeenCalledExactlyOnceWith({});
  });

  it('whitelists and redacts records before rendering or caching', async () => {
    const { container, queryClient } = renderScreen(makeClient());
    expect(await screen.findByText('Inspection [redacted]')).toBeInTheDocument();
    const cached = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data)
    );
    for (const poison of [SECRET, PRIVATE]) {
      expect(container.innerHTML).not.toContain(poison);
      expect(cached).not.toContain(poison);
    }
  });

  it('shows separate empty states', async () => {
    renderScreen(
      makeClient({
        'audit.server-list': vi.fn().mockResolvedValue({ auditEvents: [] }),
        'permission.server-list': vi.fn().mockResolvedValue({ permissionDecisions: [] }),
      })
    );
    expect(await screen.findByText('No server audit events')).toBeInTheDocument();
    expect(screen.getByText('No server permission decisions')).toBeInTheDocument();
  });

  it.each([
    'audit.server-list',
    'permission.server-list',
  ] as const)('denies access when %s returns 403, hides records, and retries without credentials', async (method) => {
    const client = makeClient();
    vi.mocked(client.operations[method]).mockRejectedValueOnce(
      new ApiCallError(403, PRIVATE, { code: 'forbidden' })
    );
    const { container, queryClient } = renderScreen(client);
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('server.inspect')).not.toBeInTheDocument();
    expect(container.querySelector('input')).toBeNull();
    expect(container.innerHTML).not.toContain(PRIVATE);
    expect(queryClient.getQueryState(['settings', 'server-audit'])?.error?.message).not.toContain(
      PRIVATE
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    expect(client.operations[method]).toHaveBeenCalledTimes(2);
  });

  it('hides previously loaded records when a refetch loses session authority', async () => {
    const client = makeClient();
    const { queryClient, container } = renderScreen(client);
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    vi.mocked(client.operations['permission.server-list']).mockRejectedValue(
      new ApiCallError(401, PRIVATE, { code: 'core.auth.unauthenticated' })
    );
    await queryClient.invalidateQueries({ queryKey: ['settings', 'server-audit'] });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('server.inspect')).not.toBeInTheDocument();
    expect(screen.queryByText('server.read [redacted]')).not.toBeInTheDocument();
    expect(container.querySelector('input')).toBeNull();
  });

  it.each([
    401, 403,
  ])('hides cached rows on remount until current authority is checked, including %s denial', async (status) => {
    const client = makeClient();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const first = renderScreen(client, queryClient);
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    first.unmount();

    let deny!: () => void;
    vi.mocked(client.operations['permission.server-list']).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          deny = () => reject(new ApiCallError(status, PRIVATE, { code: 'forbidden' }));
        })
    );
    const { container } = renderScreen(client, queryClient);
    expect(screen.queryByText('server.inspect')).not.toBeInTheDocument();
    expect(screen.queryByText('server.read [redacted]')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(client.operations['permission.server-list']).toHaveBeenCalledTimes(2)
    );
    deny();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('server.inspect')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(PRIVATE);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    for (const method of ['audit.server-list', 'permission.server-list'] as const) {
      expect(vi.mocked(client.operations[method]).mock.calls).toEqual([[{}], [{}], [{}]]);
    }
  });

  it('discards a previous mount pending read and checks the new session client', async () => {
    const previousClient = makeClient();
    let finishPrevious!: () => void;
    vi.mocked(previousClient.operations['audit.server-list']).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPrevious = () => resolve({ auditEvents: [] });
        })
    );
    const first = renderScreen(previousClient);
    await waitFor(() =>
      expect(previousClient.operations['audit.server-list']).toHaveBeenCalledTimes(1)
    );
    first.unmount();

    const currentClient = makeClient();
    renderScreen(currentClient, first.queryClient);
    await waitFor(() =>
      expect(currentClient.operations['audit.server-list']).toHaveBeenCalledExactlyOnceWith({})
    );
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    await act(async () => finishPrevious());
    expect(first.queryClient.isFetching()).toBe(0);
    expect(screen.getByText('server.inspect')).toBeInTheDocument();
    expect(screen.queryByText('No server audit events')).not.toBeInTheDocument();
    expect(currentClient.operations['permission.server-list']).toHaveBeenCalledExactlyOnceWith({});
  });

  it('refreshes both read-only lists and prevents repeat refresh while pending', async () => {
    const client = makeClient();
    renderScreen(client);
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    let finish!: () => void;
    vi.mocked(client.operations['audit.server-list']).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ auditEvents: [] });
        })
    );
    vi.mocked(client.operations['permission.server-list']).mockResolvedValueOnce({
      permissionDecisions: [],
    });
    const refresh = screen.getByRole('button', { name: 'Refresh audit' });
    await userEvent.click(refresh);
    expect(refresh).toBeDisabled();
    expect(screen.queryByText('server.inspect')).not.toBeInTheDocument();
    expect(screen.queryByText('server.read [redacted]')).not.toBeInTheDocument();
    await userEvent.click(refresh);
    expect(client.operations['audit.server-list']).toHaveBeenCalledTimes(2);
    finish();
    expect(await screen.findByText('No server audit events')).toBeInTheDocument();
    expect(screen.getByText('No server permission decisions')).toBeInTheDocument();
    expect(refresh).toBeEnabled();
    for (const method of ['audit.server-list', 'permission.server-list'] as const) {
      expect(vi.mocked(client.operations[method]).mock.calls).toEqual([[{}], [{}]]);
    }
  });

  it.each([
    401, 403, 500,
  ])('hides prior rows after a failed refresh (%s), then retries only the two safe reads', async (status) => {
    const client = makeClient();
    const { container, queryClient } = renderScreen(client);
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    expect(screen.getByText('Actor: user · user_recorded')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Thread th_recorded in Workspace ws_recorded' })).toBeVisible();
    vi.mocked(client.operations['audit.server-list']).mockRejectedValueOnce(
      new ApiCallError(status, PRIVATE, {
        code: PRIVATE,
        details: PRIVATE,
        cause: new Error(PRIVATE),
      })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Refresh audit' }));
    if (status === 500) {
      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Couldn't load server audit records."
      );
    } else {
      expect(await screen.findByText('Access denied')).toBeInTheDocument();
    }
    expect(screen.queryByText('server.inspect')).not.toBeInTheDocument();
    expect(screen.queryByText('Actor: user · user_recorded')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Thread th_recorded in Workspace ws_recorded' })).not.toBeInTheDocument();
    expect(screen.queryByText('server.read [redacted]')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(PRIVATE);
    expect(container.querySelector('input')).toBeNull();
    const cached = queryClient.getQueryState(['settings', 'server-audit']);
    expect(cached?.error?.message).not.toContain(PRIVATE);
    expect(JSON.stringify(cached)).not.toContain(PRIVATE);
    await userEvent.click(
      screen.getByRole('button', { name: status === 500 ? 'Try again' : 'Retry' })
    );
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    for (const method of ['audit.server-list', 'permission.server-list'] as const) {
      expect(vi.mocked(client.operations[method]).mock.calls).toEqual([[{}], [{}], [{}]]);
    }
  });

  it('prefers occurredAt, falls back to createdAt, and marks missing time as not recorded', async () => {
    const client = makeClient({
      'audit.server-list': vi.fn().mockResolvedValue({
        token: PRIVATE,
        auditEvents: [
          {
            id: 'audit_preferred',
            category: 'system',
            action: 'boot.start',
            outcome: 'succeeded',
            summary: `Inspection ${SECRET}`,
            occurredAt: OCCURRED_AT,
            createdAt: CREATED_AT,
            payload: PRIVATE,
          },
          {
            id: 'audit_fallback',
            category: 'system',
            action: 'boot.outcome',
            outcome: 'succeeded',
            summary: 'NanoCore boot finished.',
            createdAt: CREATED_AT,
          },
          {
            id: 'audit_missing',
            category: 'system',
            action: 'server.inspect',
            outcome: 'succeeded',
            summary: 'Inspection without a recorded time.',
          },
        ],
      }),
      'permission.server-list': vi.fn().mockResolvedValue({
        secret: PRIVATE,
        permissionDecisions: [
          {
            decisionId: 'decision_timed',
            action: `server.read ${SECRET}`,
            result: 'deny',
            createdAt: DECISION_AT,
            reasonCode: PRIVATE,
          },
        ],
      }),
    });
    const { container, queryClient } = renderScreen(client);

    const preferred = (await screen.findByText('boot.start')).parentElement!;
    const preferredTime = within(preferred).getByText(formatRecordedTime(OCCURRED_AT));
    expect(preferredTime.tagName).toBe('TIME');
    expect(preferredTime).toHaveAttribute('datetime', OCCURRED_AT);
    expect(preferredTime).toHaveAttribute('title', OCCURRED_AT);
    expect(within(preferred).queryByText(formatRecordedTime(CREATED_AT))).toBeNull();

    const fallback = screen.getByText('boot.outcome').parentElement!;
    const fallbackTime = within(fallback).getByText(formatRecordedTime(CREATED_AT));
    expect(fallbackTime).toHaveAttribute('datetime', CREATED_AT);
    expect(fallbackTime).toHaveAttribute('title', CREATED_AT);

    const missing = screen.getByText('server.inspect').parentElement!;
    expect(within(missing).getByText('Not recorded')).toBeInTheDocument();
    expect(missing.querySelector('time')).toBeNull();

    const decision = screen.getByText('server.read [redacted]').parentElement!;
    const decisionTime = within(decision).getByText(formatRecordedTime(DECISION_AT));
    expect(decisionTime.tagName).toBe('TIME');
    expect(decisionTime).toHaveAttribute('datetime', DECISION_AT);
    expect(decisionTime).toHaveAttribute('title', DECISION_AT);

    const cached = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data)
    );
    expect(cached).toContain(OCCURRED_AT);
    expect(cached).toContain(CREATED_AT);
    expect(cached).toContain(DECISION_AT);
    for (const poison of [SECRET, PRIVATE]) {
      expect(container.innerHTML).not.toContain(poison);
      expect(cached).not.toContain(poison);
    }
  });

  it('shows a safe load error and recovers on retry', async () => {
    const client = makeClient();
    vi.mocked(client.operations['audit.server-list']).mockRejectedValueOnce(new Error(PRIVATE));
    const { queryClient } = renderScreen(client);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't load server audit records."
    );
    expect(screen.queryByText(PRIVATE)).not.toBeInTheDocument();
    expect(queryClient.getQueryState(['settings', 'server-audit'])?.error?.message).not.toContain(
      PRIVATE
    );
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('server.inspect')).toBeInTheDocument());
  });
});
