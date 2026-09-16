import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
function makeClient(app: Partial<CoreClient['app']> = {}): CoreClient {
  return {
    app: {
      listServerAuditEvents: vi.fn().mockResolvedValue({
        token: PRIVATE,
        auditEvents: [
          {
            id: 'audit_1',
            category: 'permission',
            action: 'server.inspect',
            outcome: 'succeeded',
            summary: `Inspection ${SECRET}`,
            actor: { name: PRIVATE },
            payload: PRIVATE,
          },
        ],
      }),
      listServerPermissionDecisions: vi.fn().mockResolvedValue({
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
function renderScreen(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        {SURFACE_ELEMENTS['server-audit'] ?? null}
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...rendered, queryClient };
}

describe('Server audit administration', () => {
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
    expect(client.app.listServerAuditEvents).toHaveBeenCalledExactlyOnceWith();
    expect(client.app.listServerPermissionDecisions).toHaveBeenCalledExactlyOnceWith();
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
        listServerAuditEvents: vi.fn().mockResolvedValue({ auditEvents: [] }),
        listServerPermissionDecisions: vi.fn().mockResolvedValue({ permissionDecisions: [] }),
      })
    );
    expect(await screen.findByText('No server audit events')).toBeInTheDocument();
    expect(screen.getByText('No server permission decisions')).toBeInTheDocument();
  });

  it.each([
    'listServerAuditEvents',
    'listServerPermissionDecisions',
  ] as const)('denies access when %s returns 403, hides records, and retries without credentials', async (method) => {
    const client = makeClient();
    vi.mocked(client.app[method]).mockRejectedValueOnce(
      new ApiCallError(403, PRIVATE, { code: 'forbidden' })
    );
    const { container } = renderScreen(client);
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('server.inspect')).not.toBeInTheDocument();
    expect(container.querySelector('input')).toBeNull();
    expect(container.innerHTML).not.toContain(PRIVATE);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    expect(client.app[method]).toHaveBeenCalledTimes(2);
  });

  it('hides previously loaded records when a refetch loses session authority', async () => {
    const client = makeClient();
    const { queryClient, container } = renderScreen(client);
    expect(await screen.findByText('server.inspect')).toBeInTheDocument();
    vi.mocked(client.app.listServerPermissionDecisions).mockRejectedValue(
      new ApiCallError(401, PRIVATE, { code: 'core.auth.unauthenticated' })
    );
    await queryClient.invalidateQueries({ queryKey: ['settings', 'server-audit'] });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('server.inspect')).not.toBeInTheDocument();
    expect(screen.queryByText('server.read [redacted]')).not.toBeInTheDocument();
    expect(container.querySelector('input')).toBeNull();
  });

  it('prefers occurredAt, falls back to createdAt, and marks missing time as not recorded', async () => {
    const client = makeClient({
      listServerAuditEvents: vi.fn().mockResolvedValue({
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
      listServerPermissionDecisions: vi.fn().mockResolvedValue({
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
    vi.mocked(client.app.listServerAuditEvents).mockRejectedValueOnce(new Error(PRIVATE));
    renderScreen(client);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't load server audit records."
    );
    expect(screen.queryByText(PRIVATE)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('server.inspect')).toBeInTheDocument());
  });
});
