import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { SURFACE_ELEMENTS } from '../../app/routes';
import { surfaceById, surfacesInGroup } from '../../app/surfaces';

const SECRET = 'okt_server_audit_poison';
const PRIVATE = 'private-payload-must-not-escape';

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

  it('shows a safe load error and recovers on retry', async () => {
    const client = makeClient();
    vi.mocked(client.app.listServerAuditEvents).mockRejectedValueOnce(new Error(PRIVATE));
    renderScreen(client);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't load server audit records."
    );
    expect(screen.queryByText(PRIVATE)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('server.inspect')).toBeInTheDocument());
  });
});
