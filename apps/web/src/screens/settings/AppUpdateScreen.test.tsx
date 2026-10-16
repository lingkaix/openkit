import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppUpdateScreen } from './AppUpdateScreen';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const TIMESTAMP = '2026-09-10T00:00:00.000Z';


const DIAGNOSTICS = {
  readiness: {
    serviceAvailability: 'available',
    productWork: 'blocked',
    update: { state: 'configured', qualification: 'prepare-required' },
    maintenanceSafety: { state: 'busy' },
    executionHost: { state: 'ready', observationAgeMs: 500 },
  },
};
const PREPARED = {
  helperSha256: 'c'.repeat(64),
  preparedHelperSha256: 'c'.repeat(64),
  approvalSummary: {
    targetRelease: { appDigest: DIGEST, sourceCommit: COMMIT, tag: 'v0.1.0' },
    expectedCurrentImageId: DIGEST,
    observedCurrentImageId: DIGEST,
    interruptionScope: 'NanoCore, Web and active client connections are interrupted.',
    safetyEvidence: {
      deploymentBindings: true as const,
      preflight: {
        state: 'idle' as const,
        observedAt: TIMESTAMP,
        workspaceCount: 2,
        counts: {
          runningTurns: 0,
          pendingTurns: 0,
          queuedAdmissions: 0,
          openAttempts: 0,
          closingAttempts: 0,
          inFlightCommands: 0,
        },
      },
    },
    recoveryLimitations: ['No automatic rollback across data migrations.'],
  },
  expectedCurrentImageId: DIGEST,
  preparedAt: TIMESTAMP,
  requestId: REQUEST_ID,
  source: {
    appDigest: DIGEST,
    sourceCommit: COMMIT,
    tag: 'v0.1.0',
  },
  stage: 'prepared' as const,
};

const STARTED = {
  ...PREPARED,
  candidateBoot: null,
  candidateImageId: null,
  completedAt: null,
  error: null,
  jobId: 'job_app-update.service',
  outcome: 'running' as const,
  predicates: null,
  previousAppRestored: null,
  previousBoot: null,
  previousImageId: null,
  stage: 'launching' as const,
  startedAt: TIMESTAMP,
};

const SUCCEEDED = {
  ...STARTED,
  candidateBoot: {
    acceptingProductWork: true,
    blockingReasons: [] as string[],
    bootId: `boot_${REQUEST_ID}`,
    imageId: DIGEST,
    sourceCommit: COMMIT,
  },
  candidateImageId: DIGEST,
  completedAt: TIMESTAMP,
  jobId: 'job_app-update.service',
  outcome: 'succeeded' as const,
  predicates: {
    acceptingProductWork: true,
    helperReachable: true,
    imageMatch: true,
    nanohostReady: null,
    newBoot: true,
    noBlockingReadiness: true,
    retainedAuthRead: true,
    sourceMatch: true,
    webAssets: null,
  },
  previousAppRestored: false,
  previousImageId: DIGEST,
  stage: 'succeeded' as const,
};

function makeClient(app: Partial<CoreClient['app'] & CoreClient['operations']> = {}): CoreClient {
  return {
    app: { ...app },
    operations: {
      'token.list': vi.fn().mockResolvedValue({ items: [] }),
      'diagnostics.app': vi.fn().mockResolvedValue(DIAGNOSTICS),
      ...app,
      'app-update.prepare': vi.fn().mockResolvedValue(PREPARED),
      'app-update.start': vi.fn().mockResolvedValue(STARTED),
      'app-update.status': vi.fn().mockResolvedValue(STARTED),
      ...app,
    },
  } as unknown as CoreClient;
}

function renderScreen(
  client: CoreClient,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } })
) {
  return { queryClient, ...render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <AppUpdateScreen />
      </CoreClientProvider>
    </QueryClientProvider>
  ) };
}

async function fillPublishedSource(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('button', { name: 'Prepare' });
  await user.type(screen.getByLabelText('Release tag'), 'v0.1.0');
  await user.type(screen.getByLabelText('Published App digest'), DIGEST);
  await user.type(screen.getByLabelText('Release source commit'), COMMIT);
  await user.type(screen.getByLabelText('Expected current image'), DIGEST);
}

describe('App update administration', () => {
  it('requires current admission when remounted over a fresh success', async () => {
    const client = makeClient();
    const first = renderScreen(client);
    await screen.findByRole('button', { name: 'Prepare' });
    first.unmount();
    const pending = deferred<{ items: [] }>();
    vi.mocked(client.operations['token.list']).mockImplementationOnce(() => pending.promise);
    renderScreen(client, first.queryClient);
    expect(client.operations['token.list']).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ items: [] }));
    expect(await screen.findByRole('button', { name: 'Prepare' })).toBeInTheDocument();
  });

  it('refreshes fresh cached diagnostics after current mount admission enables the read', async () => {
    const client = makeClient();
    const first = renderScreen(client);
    await screen.findByText('Service availability: available');
    first.unmount();
    const pending = deferred<Awaited<ReturnType<CoreClient['operations']['diagnostics.app']>>>();
    vi.mocked(client.operations['diagnostics.app']).mockImplementationOnce(() => pending.promise);
    renderScreen(client, first.queryClient);
    await waitFor(() => expect(client.operations['token.list']).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.operations['diagnostics.app']).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Service availability: available')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare' })).toBeInTheDocument();
    await act(async () => pending.resolve(DIAGNOSTICS as never));
    expect(await screen.findByText('Service availability: available')).toBeInTheDocument();
  });

  it('does not admit a remount from an abandoned pending transport', async () => {
    const client = makeClient();
    const abandoned = deferred<{ items: [] }>();
    const current = deferred<{ items: [] }>();
    vi.mocked(client.operations['token.list'])
      .mockImplementationOnce(() => abandoned.promise)
      .mockImplementationOnce(() => current.promise);
    const first = renderScreen(client);
    first.unmount();
    renderScreen(client, first.queryClient);
    expect(client.operations['token.list']).toHaveBeenCalledTimes(2);
    await act(async () => abandoned.resolve({ items: [] }));
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    await act(async () => current.resolve({ items: [] }));
    expect(await screen.findByRole('button', { name: 'Prepare' })).toBeInTheDocument();
  });

  it.each([401, 403])('hides a prepared receipt after admission %s through unresolved retry', async (status) => {
    const user = userEvent.setup();
    const client = makeClient();
    const { queryClient } = renderScreen(client);
    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await screen.findByText(REQUEST_ID);
    vi.mocked(client.operations['token.list']).mockRejectedValueOnce(new ApiCallError(status, 'private detail'));
    await act(() => queryClient.invalidateQueries({ queryKey: ['settings', 'app-update', 'admin-access'] }));
    await screen.findByText('Access denied');
    expect(screen.queryByText(REQUEST_ID)).not.toBeInTheDocument();
    const pending = deferred<{ items: [] }>();
    vi.mocked(client.operations['token.list']).mockImplementationOnce(() => pending.promise);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByText(REQUEST_ID)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start update' })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ items: [] }));
    await screen.findByRole('button', { name: 'Prepare' });
    expect(client.operations['app-update.prepare']).toHaveBeenCalledTimes(1);
    expect(client.operations['app-update.start']).not.toHaveBeenCalled();
  });

  it('hides prepared controls while a new admission read is pending', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const { queryClient } = renderScreen(client);
    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await screen.findByText(REQUEST_ID);
    await user.click(screen.getByRole('switch'));
    const pending = deferred<{ items: [] }>();
    vi.mocked(client.operations['token.list']).mockImplementationOnce(() => pending.promise);
    let refetch!: Promise<void>;
    act(() => { refetch = queryClient.invalidateQueries({ queryKey: ['settings', 'app-update', 'admin-access'] }); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Start update' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    await act(async () => { pending.resolve({ items: [] }); await refetch; });
    await screen.findByRole('button', { name: 'Start update' });
    expect(client.operations['app-update.start']).not.toHaveBeenCalled();
  });

  it('blocks effects after an ordinary failed admission refetch', async () => {
    const client = makeClient();
    const { queryClient } = renderScreen(client);
    await screen.findByRole('button', { name: 'Prepare' });
    vi.mocked(client.operations['token.list']).mockRejectedValueOnce(new ApiCallError(500, 'private detail'));
    await act(() => queryClient.invalidateQueries({ queryKey: ['settings', 'app-update', 'admin-access'] }));
    await screen.findByText("Couldn't verify deployment-admin authority.");
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    expect(client.operations['app-update.prepare']).not.toHaveBeenCalled();
  });

  it.each([401, 403])('treats diagnostics %s as denial and keeps receipts hidden during retry', async (status) => {
    const user = userEvent.setup();
    const client = makeClient({ 'diagnostics.app': vi.fn().mockResolvedValue(DIAGNOSTICS) });
    const { queryClient } = renderScreen(client);
    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await screen.findByText(REQUEST_ID);
    vi.mocked(client.operations['diagnostics.app']).mockRejectedValueOnce(new ApiCallError(status, 'private detail'));
    await act(() => queryClient.invalidateQueries({ queryKey: ['settings', 'app-update', 'diagnostics'] }));
    await screen.findByText('Access denied');
    const pending = deferred<{ items: [] }>();
    vi.mocked(client.operations['token.list']).mockImplementationOnce(() => pending.promise);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByText(REQUEST_ID)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ items: [] }));
    await screen.findByRole('button', { name: 'Prepare' });
    expect(client.operations['app-update.prepare']).toHaveBeenCalledTimes(1);
  });

  it('keeps prior receipts hidden when diagnostics denial is followed by a 500 retry', async () => {
    const user = userEvent.setup();
    const client = makeClient({ 'diagnostics.app': vi.fn().mockResolvedValue(DIAGNOSTICS) });
    const { queryClient } = renderScreen(client);
    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await screen.findByText(REQUEST_ID);
    vi.mocked(client.operations['diagnostics.app']).mockRejectedValueOnce(new ApiCallError(403, 'private detail'));
    await act(() => queryClient.invalidateQueries({ queryKey: ['settings', 'app-update', 'diagnostics'] }));
    await screen.findByText('Access denied');
    vi.mocked(client.operations['diagnostics.app']).mockRejectedValue(new ApiCallError(500, 'private detail'));
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(client.operations['diagnostics.app']).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(REQUEST_ID)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start update' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    vi.mocked(client.operations['diagnostics.app']).mockResolvedValue(DIAGNOSTICS as never);
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Prepare' });
    expect(client.operations['app-update.prepare']).toHaveBeenCalledTimes(1);
    expect(client.operations['app-update.start']).not.toHaveBeenCalled();
  });

  it('allows prepare, consented start and receipt inspection after diagnostics 500', async () => {
    const user = userEvent.setup();
    const client = makeClient({ 'diagnostics.app': vi.fn().mockRejectedValue(new ApiCallError(500, 'private detail')) });
    renderScreen(client);
    await screen.findByText('Operational diagnostics unavailable.');
    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await screen.findByText(REQUEST_ID);
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Start update' }));
    await screen.findByText('launching');
    await user.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(client.operations['app-update.status']).toHaveBeenCalledWith({ requestId: REQUEST_ID }));
    expect(client.operations['app-update.start']).toHaveBeenCalledExactlyOnceWith({ maintenanceConsent: true, requestId: REQUEST_ID });
  });

  it('prepares a published-digest source and starts only after maintenance consent', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    await screen.findByRole('button', { name: 'Prepare' });
    expect(screen.queryByRole('radio', { name: 'Exact commit' })).not.toBeInTheDocument();
    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));

    expect(await screen.findByText(REQUEST_ID)).toBeInTheDocument();
    expect(client.operations['app-update.prepare']).toHaveBeenCalledWith({
      expectedCurrentImageId: DIGEST,
      source: PREPARED.source,
    });

    expect(screen.getByText(PREPARED.approvalSummary.interruptionScope)).toBeInTheDocument();
    expect(screen.getByText('No automatic rollback across data migrations.')).toBeInTheDocument();
    expect(screen.getByText('Maintenance safety: idle')).toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Start update' });
    expect(start).toBeDisabled();
    await user.click(
      screen.getByRole('switch', {
        name: 'I consent to the maintenance interruption for this prepared source',
      })
    );
    await user.click(start);

    await waitFor(() => {
      expect(client.operations['app-update.start']).toHaveBeenCalledWith({
        maintenanceConsent: true,
        requestId: REQUEST_ID,
      });
    });
    expect(await screen.findByText('launching')).toBeInTheDocument();
    expect(screen.getByText(`Tag ${PREPARED.source.tag}`)).toBeInTheDocument();
    expect(screen.getByText(`Commit ${COMMIT}`)).toBeInTheDocument();
    expect(screen.getByText(`App digest ${DIGEST}`)).toBeInTheDocument();
    expect(screen.getByText(`Current image ${DIGEST}`)).toBeInTheDocument();
  });

  it('resets maintenance consent when a new prepare replaces the review object', async () => {
    const user = userEvent.setup();
    const nextPrepared = {
      ...PREPARED,
      requestId: '22222222-2222-4222-8222-222222222222',
    };
    const client = makeClient({
      'app-update.prepare': vi
        .fn()
        .mockResolvedValueOnce(PREPARED)
        .mockResolvedValueOnce(nextPrepared),
    });
    renderScreen(client);

    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await screen.findByText(REQUEST_ID);
    await user.click(
      screen.getByRole('switch', {
        name: 'I consent to the maintenance interruption for this prepared source',
      })
    );

    expect(screen.getByRole('button', { name: 'Start update' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await screen.findByText(nextPrepared.requestId);

    expect(
      screen.getByRole('switch', {
        name: 'I consent to the maintenance interruption for this prepared source',
      })
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Start update' })).toBeDisabled();
  });

  it('inspects a known request ID through status without a prepare in this session', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    await screen.findByLabelText('Request ID');
    await user.type(screen.getByLabelText('Request ID'), REQUEST_ID);
    await user.click(screen.getByRole('button', { name: 'Refresh status' }));

    await waitFor(() => {
      expect(client.operations['app-update.status']).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
      });
    });
    expect(await screen.findByText('launching')).toBeInTheDocument();
    expect(screen.getByDisplayValue(REQUEST_ID)).toBeInTheDocument();
  });

  it('lists verification predicates from a succeeded receipt', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      'app-update.status': vi.fn().mockResolvedValue(SUCCEEDED),
    });
    renderScreen(client);

    await screen.findByLabelText('Request ID');
    await user.type(screen.getByLabelText('Request ID'), REQUEST_ID);
    await user.click(screen.getByRole('button', { name: 'Refresh status' }));

    expect(await screen.findByText('Image match: Yes')).toBeInTheDocument();
    expect(screen.getByText('Source match: Yes')).toBeInTheDocument();
    expect(screen.getByText('NanoHost ready: Not applicable')).toBeInTheDocument();
    expect(screen.getByText('Web assets: Not applicable')).toBeInTheDocument();
  });

  it('inspects the same request after an uncertain start without replaying the effect', async () => {
    const user = userEvent.setup();
    const privateDetail = 'private-update-detail';
    const client = makeClient({ 'app-update.start': vi.fn().mockRejectedValue(new Error(privateDetail)) });
    const { queryClient, container } = renderScreen(client);
    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await screen.findByText(REQUEST_ID);
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Start update' }));
    await screen.findByText(/If start was interrupted, its outcome may be unknown/);
    expect(container.innerHTML).not.toContain(privateDetail);
    expect(screen.getByLabelText('Request ID')).toHaveValue(REQUEST_ID);
    await user.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByText('launching');
    expect(client.operations['app-update.status']).toHaveBeenCalledExactlyOnceWith({ requestId: REQUEST_ID });
    expect(client.operations['app-update.start']).toHaveBeenCalledTimes(1);
    expect(queryClient.getMutationCache().getAll().some((mutation) => mutation.state.error?.message.includes(privateDetail))).toBe(false);
  });

  it('keeps raw diagnostics denial details out of the query cache', async () => {
    const privateDetail = 'private-update-detail';
    const client = makeClient({ 'diagnostics.app': vi.fn().mockRejectedValue(new ApiCallError(403, privateDetail, { details: privateDetail })) });
    const { queryClient, container } = renderScreen(client);
    await screen.findByText('Access denied');
    expect(container.innerHTML).not.toContain(privateDetail);
    const errors = queryClient.getQueryCache().getAll().map((query) => query.state.error);
    expect(errors.some((error) => error?.message.includes(privateDetail))).toBe(false);
    expect(JSON.stringify(errors)).not.toContain(privateDetail);
  });

  it('states missing server-admin authority without a credential prompt', async () => {
    const client = makeClient({
      'token.list': vi
        .fn()
        .mockRejectedValue(new ApiCallError(403, 'Server-admin authority is required.')),
    });
    renderScreen(client);

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start update' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
  });

  it('states missing deployment configuration without probing a fake receipt', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      'app-update.prepare': vi.fn().mockRejectedValue(
        new ApiCallError(
          503,
          'App update is disabled because deployment configuration is absent.',
          {
            code: 'app_update_unconfigured',
          }
        )
      ),
    });
    renderScreen(client);

    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));

    expect(await screen.findByText('App update unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start update' })).not.toBeInTheDocument();
    expect(client.operations['app-update.status']).not.toHaveBeenCalled();
  });

  it('keeps the consent review bound to the prepared digest after the form is edited', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await screen.findByText(`App digest ${DIGEST}`);
    await user.type(screen.getByLabelText('Published App digest'), 'ffffffffffffffff');

    expect(screen.getByText(`App digest ${DIGEST}`)).toBeInTheDocument();
    expect(screen.getByText(`Current image ${DIGEST}`)).toBeInTheDocument();
  });

  it('describes the administrator flow without helper or closed-source jargon', async () => {
    renderScreen(makeClient());
    await screen.findByRole('button', { name: 'Prepare' });
    const subtitle = screen.getByText(/Prepare one App update/i);
    expect(subtitle.textContent).not.toMatch(/closed source|helper/i);
  });
});

/** Hold a transport response independently of query cancellation. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
