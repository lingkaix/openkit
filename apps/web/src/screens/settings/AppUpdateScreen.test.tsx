import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppUpdateScreen } from './AppUpdateScreen';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const TIMESTAMP = '2026-09-10T00:00:00.000Z';

const PREPARED = {
  expectedCurrentImageId: DIGEST,
  preparedAt: TIMESTAMP,
  requestId: REQUEST_ID,
  source: {
    appDigest: DIGEST,
    kind: 'release' as const,
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

function makeClient(app: Partial<CoreClient['app']> = {}): CoreClient {
  return {
    app: {
      listOpenKitAccessTokens: vi.fn().mockResolvedValue({ items: [] }),
      prepareAppUpdate: vi.fn().mockResolvedValue(PREPARED),
      startAppUpdate: vi.fn().mockResolvedValue(STARTED),
      getAppUpdateStatus: vi.fn().mockResolvedValue(STARTED),
      ...app,
    },
  } as unknown as CoreClient;
}

function renderScreen(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <AppUpdateScreen />
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

async function fillPublishedSource(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('button', { name: 'Prepare' });
  await user.type(screen.getByLabelText('Release tag'), 'v0.1.0');
  await user.type(screen.getByLabelText('Published App digest'), DIGEST);
  await user.type(screen.getByLabelText('Source commit'), COMMIT);
  await user.type(screen.getByLabelText('Expected current image'), DIGEST);
}

describe('App update administration', () => {
  it('prepares a published-digest source and starts only after maintenance consent', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    await fillPublishedSource(user);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));

    expect(await screen.findByText(REQUEST_ID)).toBeInTheDocument();
    expect(client.app.prepareAppUpdate).toHaveBeenCalledWith({
      expectedCurrentImageId: DIGEST,
      source: PREPARED.source,
    });

    const start = screen.getByRole('button', { name: 'Start update' });
    expect(start).toBeDisabled();
    await user.click(
      screen.getByRole('switch', {
        name: 'I consent to the maintenance interruption for this prepared source',
      })
    );
    await user.click(start);

    await waitFor(() => {
      expect(client.app.startAppUpdate).toHaveBeenCalledWith({
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
      prepareAppUpdate: vi.fn().mockResolvedValueOnce(PREPARED).mockResolvedValueOnce(nextPrepared),
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
      expect(client.app.getAppUpdateStatus).toHaveBeenCalledWith(REQUEST_ID);
    });
    expect(await screen.findByText('launching')).toBeInTheDocument();
    expect(screen.getByDisplayValue(REQUEST_ID)).toBeInTheDocument();
  });

  it('lists verification predicates from a succeeded receipt', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getAppUpdateStatus: vi.fn().mockResolvedValue(SUCCEEDED),
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

  it('states missing server-admin authority without a credential prompt', async () => {
    const client = makeClient({
      listOpenKitAccessTokens: vi
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
      prepareAppUpdate: vi.fn().mockRejectedValue(
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
    expect(client.app.getAppUpdateStatus).not.toHaveBeenCalled();
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
