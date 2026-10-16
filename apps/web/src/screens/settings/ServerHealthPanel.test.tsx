import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { ServerHealthPanel } from './ServerHealthPanel';

const TIME = '2026-10-16T10:00:00.000Z';

/** Real diagnostic dimensions with a busy deployment and a separate ready host observation. */
function diagnostics() {
  return {
    service: 'nanocore',
    build: { releaseTag: 'v0.1.0-rc.8', sourceCommit: 'a'.repeat(40) },
    boot: {
      bootId: 'boot_one',
      acceptingProductWork: false,
      overall: 'degraded',
      subsystems: {
        config: { state: 'ready', reasons: [] },
        storage: { state: 'ready', reasons: [] },
        policy: {
          state: 'failed',
          reasons: [
            {
              code: 'policy_unavailable',
              message: 'Policy is unavailable.',
              blocks: ['product-work'],
            },
          ],
        },
        vault: { state: 'ready', reasons: [] },
        scheduler: { state: 'ready', reasons: [] },
        llmGateway: { state: 'ready', reasons: [] },
        knowledgeIndex: { state: 'ready', reasons: [] },
      },
    },
    process: {
      observedAt: TIME,
      nodeVersion: 'v24.18.0',
      uptimeSeconds: 42,
      memory: { rssBytes: 1234, heapUsedBytes: 200, heapTotalBytes: 800 },
      telemetry: { enabled: false, exportConfigured: true },
    },
    readiness: {
      serviceAvailability: 'available',
      productWork: 'blocked',
      update: { state: 'configured', qualification: 'prepare-required' },
      maintenanceSafety: {
        state: 'busy',
        observation: {
          observedAt: TIME,
          workspaceCount: 2,
          state: 'busy',
          counts: {
            runningTurns: 1,
            pendingTurns: 0,
            queuedAdmissions: 0,
            openAttempts: 1,
            closingAttempts: 0,
            inFlightCommands: 0,
          },
        },
      },
      executionHost: {
        state: 'ready',
        observedAt: TIME,
        observationAgeMs: 500,
        liveProbe: false,
        freshEmpty: true,
      },
    },
    gateway: { privatePayload: 'private-model-payload' },
    providers: { privatePayload: 'private-provider-payload' },
    runtimeConfig: {
      currentVersion: 3,
      pendingRestart: ['server'],
      privatePayload: 'private-config-payload',
    },
  };
}

/** Only diagnostics is available; any unrelated request is a test failure. */
function renderPanel(
  read = vi.fn().mockResolvedValue(diagnostics()),
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  const client = { operations: { 'diagnostics.app': read } } as unknown as CoreClient;
  return {
    read,
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <ServerHealthPanel />
        </CoreClientProvider>
      </QueryClientProvider>
    ),
  };
}

describe('Server health', () => {
  it('keeps service, product, maintenance, update and stored host observations distinct', async () => {
    const { read } = renderPanel();
    expect(await screen.findByRole('heading', { name: 'Boot readiness' })).toBeInTheDocument();
    expect(read).toHaveBeenCalledExactlyOnceWith({});
    expect(screen.getByText('Product work blocked')).toBeInTheDocument();
    expect(screen.getByText('Service available')).toBeInTheDocument();
    expect(screen.getByText('Maintenance busy')).toBeInTheDocument();
    expect(screen.getByText('Update helper configured; preparation required')).toBeInTheDocument();
    expect(screen.getByText('Stored execution-host observation: ready')).toBeInTheDocument();
    expect(screen.getByText('Observation age: 500 ms')).toBeInTheDocument();
    expect(screen.getByText(/does not prove deployment idleness/)).toBeInTheDocument();
    const policy = screen.getByRole('region', { name: 'Policy' });
    expect(within(policy).getByText('Failed')).toBeInTheDocument();
    expect(within(policy).getByText('Policy is unavailable.')).toBeInTheDocument();
    expect(within(policy).getByText('Blocks: product-work')).toBeInTheDocument();
    expect(screen.getByText('Exporter configured; SDK inactive')).toBeInTheDocument();
    expect(screen.getByText(/does not prove delivery/)).toBeInTheDocument();
    expect(screen.getByText('1,234 bytes')).toBeInTheDocument();
    expect(screen.getByText('v0.1.0-rc.8')).toBeInTheDocument();
    expect(screen.getByText('Configuration version: 3')).toBeInTheDocument();
  });

  it('reports absent optional readiness and build identity as unavailable', async () => {
    const payload = diagnostics();
    const { readiness: _readiness, build: _build, ...without } = payload;
    renderPanel(vi.fn().mockResolvedValue(without));
    expect(await screen.findByText('Operational readiness unavailable')).toBeInTheDocument();
    expect(screen.getByText('Release identity unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Service available')).not.toBeInTheDocument();
  });

  it('whitelists and redacts diagnostics before caching or rendering', async () => {
    const payload = diagnostics();
    payload.boot.subsystems.policy.reasons[0]!.message = 'Failed okt_health_poison';
    const { container, queryClient } = renderPanel(
      vi.fn().mockResolvedValue({ ...payload, extra: 'unowned-private-payload' })
    );
    expect(await screen.findByText('Failed [redacted]')).toBeInTheDocument();
    const bytes = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data)
    );
    for (const forbidden of [
      'private-model-payload',
      'private-provider-payload',
      'private-config-payload',
      'unowned-private-payload',
      'okt_health_poison',
    ]) {
      expect(bytes).not.toContain(forbidden);
      expect(container.textContent).not.toContain(forbidden);
    }
  });

  it.each([
    401, 403,
  ])('hides prior observations after current authority returns %s and retries only the read', async (status) => {
    const user = userEvent.setup();
    const read = vi
      .fn()
      .mockResolvedValueOnce(diagnostics())
      .mockRejectedValueOnce(
        new ApiCallError(status, 'private failure', { details: 'private-body' })
      )
      .mockResolvedValueOnce(diagnostics());
    renderPanel(read);
    expect(await screen.findByText('v0.1.0-rc.8')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh health' }));
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('v0.1.0-rc.8')).not.toBeInTheDocument();
    expect(screen.queryByText('private failure')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('v0.1.0-rc.8')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('hides stale observations on a transport failure and offers a safe read retry', async () => {
    const user = userEvent.setup();
    const read = vi
      .fn()
      .mockResolvedValueOnce(diagnostics())
      .mockRejectedValueOnce(new Error('raw private error'));
    const { queryClient } = renderPanel(read);
    expect(await screen.findByText('v0.1.0-rc.8')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh health' }));
    expect(await screen.findByText("Couldn't load server health.")).toBeInTheDocument();
    const error = queryClient.getQueryCache().getAll()[0]!.state.error;
    expect(error?.message).toBe('Server health unavailable.');
    expect(screen.queryByText('v0.1.0-rc.8')).not.toBeInTheDocument();
    expect(screen.queryByText('raw private error')).not.toBeInTheDocument();
  });

  it('does not display cached administrator data before the remounted authority check completes', async () => {
    const read = vi.fn().mockResolvedValueOnce(diagnostics());
    const first = renderPanel(read);
    expect(await screen.findByText('v0.1.0-rc.8')).toBeInTheDocument();
    first.unmount();
    let settle!: (value: unknown) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    renderPanel(read, first.queryClient);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('v0.1.0-rc.8')).not.toBeInTheDocument();
    settle(diagnostics());
    expect(await screen.findByText('v0.1.0-rc.8')).toBeInTheDocument();
  });
});
