import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { SURFACE_ELEMENTS } from '../../app/routes';
import { surfaceById, surfacesInGroup } from '../../app/surfaces';

const POISON = '/private/backup/okt_secret_must_not_escape';
const BACKUP_ID = 'drb_example';
const RESPONSE = {
  backupId: BACKUP_ID,
  manifest: {
    backupMode: 'hot',
    consistency: 'crash-consistent',
    backupStartedAt: '2026-09-14T10:00:00.000Z',
    backupCompletedAt: '2026-09-14T10:01:00.000Z',
    contentInventory: [{ path: POISON }],
    extensions: { secret: POISON },
    lineage: { path: POISON },
  },
  fileCount: 12,
  totalBytes: 4096,
  checkedFiles: [POISON, 'another-private-file'],
  backupRoot: POISON,
  token: POISON,
};

/** Minimal deployment client: no Workspace or credential-bearing calls are available. */
function makeClient(): CoreClient {
  return {
    app: {
      listOpenKitAccessTokens: vi.fn().mockResolvedValue({ items: [] }),
      createDataRootBackup: vi.fn().mockResolvedValue(RESPONSE),
      verifyDataRootBackup: vi.fn().mockResolvedValue(RESPONSE),
    },
  } as unknown as CoreClient;
}

/** Exercise the production surface mapping without selecting a Workspace. */
function renderScreen(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          {SURFACE_ELEMENTS['data-root-backup'] ?? null}
        </CoreClientProvider>
      </QueryClientProvider>
    ),
    queryClient,
  };
}

describe('Deployment data-root backup', () => {
  it('registers a Tier-A Settings Administration surface', () => {
    expect(surfaceById('data-root-backup')).toMatchObject({
      path: '/settings/data-root-backup',
      tier: 'A',
      nav: 'settings-admin',
    });
    expect(surfacesInGroup('settings-admin').map(({ id }) => id)).toContain('data-root-backup');
  });

  it('creates explicitly without arguments, projects safe fields, then verifies the returned ID', async () => {
    const client = makeClient();
    const { container, queryClient } = renderScreen(client);
    const create = await screen.findByRole('button', { name: 'Create backup' });
    expect(client.app.createDataRootBackup).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Verify backup' })).toBeDisabled();
    await userEvent.click(create);
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
    expect(client.app.createDataRootBackup).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByDisplayValue(BACKUP_ID)).toBeInTheDocument();
    for (const value of [
      'hot',
      'crash-consistent',
      '12',
      '4096',
      '2',
      RESPONSE.manifest.backupStartedAt,
      RESPONSE.manifest.backupCompletedAt,
    ]) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('button', { name: 'Verify backup' }));
    expect(await screen.findByText('Backup verified')).toBeInTheDocument();
    expect(client.app.verifyDataRootBackup).toHaveBeenCalledExactlyOnceWith(BACKUP_ID);
    expect(container.innerHTML).not.toContain(POISON);
    expect(container.innerHTML).not.toContain('another-private-file');
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data)
      )
    ).not.toContain(POISON);
  });

  it('verifies a known ID without creating a backup and rejects path input', async () => {
    const client = makeClient();
    renderScreen(client);
    const input = await screen.findByLabelText('Backup ID');
    await userEvent.type(input, '../private');
    expect(screen.getByRole('button', { name: 'Verify backup' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, `  ${BACKUP_ID}  `);
    await userEvent.click(screen.getByRole('button', { name: 'Verify backup' }));
    expect(await screen.findByText('Backup verified')).toBeInTheDocument();
    expect(client.app.verifyDataRootBackup).toHaveBeenCalledExactlyOnceWith(BACKUP_ID);
    expect(client.app.createDataRootBackup).not.toHaveBeenCalled();
  });

  it.each([
    401, 403,
  ])('handles initial %s denial and recovers without credentials', async (status) => {
    const client = makeClient();
    vi.mocked(client.app.listOpenKitAccessTokens).mockRejectedValueOnce(
      new ApiCallError(status, POISON)
    );
    const { container } = renderScreen(client);
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(container.querySelector('input')).toBeNull();
    expect(container.innerHTML).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Create backup' })).toBeInTheDocument();
    expect(client.app.createDataRootBackup).not.toHaveBeenCalled();
  });

  it.each([
    'createDataRootBackup',
    'verifyDataRootBackup',
  ] as const)('clears prior records on %s denial; Retry never replays a mutation', async (method) => {
    const client = makeClient();
    const { container } = renderScreen(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    await screen.findByText('Backup created');
    vi.mocked(client.app[method]).mockRejectedValueOnce(new ApiCallError(403, POISON));
    await userEvent.click(
      screen.getByRole('button', {
        name: method === 'createDataRootBackup' ? 'Create backup' : 'Verify backup',
      })
    );
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(BACKUP_ID);
    expect(container.innerHTML).not.toContain(POISON);
    const calls = vi.mocked(client.app[method]).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Create backup' });
    expect(client.app[method]).toHaveBeenCalledTimes(calls);
    expect(screen.queryByText('Backup created')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
  });

  it('hides a successful summary when the session loses authority on refetch', async () => {
    const client = makeClient();
    const { container, queryClient } = renderScreen(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    await screen.findByText('Backup created');
    vi.mocked(client.app.listOpenKitAccessTokens).mockRejectedValueOnce(
      new ApiCallError(401, POISON)
    );
    await act(() =>
      queryClient.invalidateQueries({ queryKey: ['settings', 'data-root-backup', 'admin-access'] })
    );
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(BACKUP_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Create backup' });
    expect(screen.queryByText('Backup created')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Backup ID')).toHaveValue('');
  });

  it('blocks duplicate or overlapping actions while creation is pending', async () => {
    const client = makeClient();
    let resolve: (value: Awaited<ReturnType<CoreClient['app']['createDataRootBackup']>>) => void =
      () => {};
    vi.mocked(client.app.createDataRootBackup).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    renderScreen(client);
    await userEvent.type(await screen.findByLabelText('Backup ID'), BACKUP_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Creating backup');
    expect(screen.getByRole('button', { name: 'Create backup' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Verify backup' })).toBeDisabled();
    expect(screen.getByLabelText('Backup ID')).toBeDisabled();
    await act(async () =>
      resolve(RESPONSE as unknown as Awaited<ReturnType<CoreClient['app']['createDataRootBackup']>>)
    );
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
    expect(client.app.createDataRootBackup).toHaveBeenCalledTimes(1);
  });

  it('retries an authority-check failure without leaking its raw message', async () => {
    const client = makeClient();
    vi.mocked(client.app.listOpenKitAccessTokens).mockRejectedValueOnce(new Error(POISON));
    const { container } = renderScreen(client);
    await screen.findByRole('button', { name: 'Try again' });
    expect(container.innerHTML).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Create backup' })).toBeInTheDocument();
  });

  it('uses a safe retryable error without automatically repeating create', async () => {
    const client = makeClient();
    vi.mocked(client.app.createDataRootBackup).mockRejectedValueOnce(new Error(POISON));
    const { container } = renderScreen(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(client.app.createDataRootBackup).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
  });
});
