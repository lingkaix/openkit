import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
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
    operations: {
      'token.list': vi.fn().mockResolvedValue({ items: [] }),
      'backup.create': vi.fn().mockResolvedValue(RESPONSE),
      'backup.verify': vi.fn().mockResolvedValue(RESPONSE),
    },
  } as unknown as CoreClient;
}

/** Exercise the production surface mapping without selecting a Workspace. */
function renderScreen(
  client: CoreClient,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } })
) {
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
  it('requires current admission when remounted over a fresh success', async () => {
    const client = makeClient();
    const first = renderScreen(client);
    await screen.findByRole('button', { name: 'Create backup' });
    first.unmount();
    const pending = deferred<{ items: [] }>();
    vi.mocked(client.operations['token.list']).mockImplementationOnce(() => pending.promise);
    renderScreen(client, first.queryClient);
    expect(client.operations['token.list']).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Create backup' })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ items: [] }));
    expect(await screen.findByRole('button', { name: 'Create backup' })).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Create backup' })).not.toBeInTheDocument();
    await act(async () => current.resolve({ items: [] }));
    expect(await screen.findByRole('button', { name: 'Create backup' })).toBeInTheDocument();
  });

  it.each([401, 403])('keeps prior summary hidden through an unresolved retry after %s', async (status) => {
    const client = makeClient();
    const { queryClient, container } = renderScreen(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    await screen.findByText('Backup created');
    vi.mocked(client.operations['token.list']).mockRejectedValueOnce(new ApiCallError(status, POISON));
    await act(() => queryClient.invalidateQueries({ queryKey: ['settings', 'data-root-backup', 'admin-access'] }));
    await screen.findByText('Access denied');
    const pending = deferred<{ items: [] }>();
    vi.mocked(client.operations['token.list']).mockImplementationOnce(() => pending.promise);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(container.innerHTML).not.toContain(BACKUP_ID);
    expect(screen.queryByRole('button', { name: 'Create backup' })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ items: [] }));
    await screen.findByRole('button', { name: 'Create backup' });
    expect(client.operations['backup.create']).toHaveBeenCalledTimes(1);
    expect(client.operations['backup.verify']).not.toHaveBeenCalled();
    expect(screen.queryByText('Backup created')).not.toBeInTheDocument();
  });

  it('blocks effects after an ordinary failed admission refetch', async () => {
    const client = makeClient();
    const { queryClient } = renderScreen(client);
    await screen.findByRole('button', { name: 'Create backup' });
    vi.mocked(client.operations['token.list']).mockRejectedValueOnce(new ApiCallError(500, POISON));
    await act(() => queryClient.invalidateQueries({ queryKey: ['settings', 'data-root-backup', 'admin-access'] }));
    await screen.findByText("Couldn't verify deployment-admin authority.");
    expect(screen.queryByRole('button', { name: 'Create backup' })).not.toBeInTheDocument();
    expect(client.operations['backup.create']).not.toHaveBeenCalled();
  });

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
    expect(client.operations['backup.create']).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Verify backup' })).toBeDisabled();
    await userEvent.click(create);
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
    expect(client.operations['backup.create']).toHaveBeenCalledExactlyOnceWith({});
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
    expect(client.operations['backup.verify']).toHaveBeenCalledExactlyOnceWith({
      backupId: BACKUP_ID,
    });
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
    expect(client.operations['backup.verify']).toHaveBeenCalledExactlyOnceWith({
      backupId: BACKUP_ID,
    });
    expect(client.operations['backup.create']).not.toHaveBeenCalled();
  });

  it.each([
    401, 403,
  ])('handles initial %s denial and recovers without credentials', async (status) => {
    const client = makeClient();
    vi.mocked(client.operations['token.list']).mockRejectedValueOnce(
      new ApiCallError(status, POISON)
    );
    const { container } = renderScreen(client);
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(container.querySelector('input')).toBeNull();
    expect(container.innerHTML).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Create backup' })).toBeInTheDocument();
    expect(client.operations['backup.create']).not.toHaveBeenCalled();
  });

  it.each([
    'backup.create',
    'backup.verify',
  ] as const)('clears prior records on %s denial; Retry never replays a mutation', async (method) => {
    const client = makeClient();
    const { container } = renderScreen(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    await screen.findByText('Backup created');
    vi.mocked(client.operations[method]).mockRejectedValueOnce(new ApiCallError(403, POISON));
    await userEvent.click(
      screen.getByRole('button', {
        name: method === 'backup.create' ? 'Create backup' : 'Verify backup',
      })
    );
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(BACKUP_ID);
    expect(container.innerHTML).not.toContain(POISON);
    const calls = vi.mocked(client.operations[method]).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Create backup' });
    expect(client.operations[method]).toHaveBeenCalledTimes(calls);
    expect(screen.queryByText('Backup created')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
  });

  it('hides a successful summary when the session loses authority on refetch', async () => {
    const client = makeClient();
    const { container, queryClient } = renderScreen(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    await screen.findByText('Backup created');
    vi.mocked(client.operations['token.list']).mockRejectedValueOnce(new ApiCallError(401, POISON));
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
    let resolve: (value: Awaited<ReturnType<CoreClient['operations']['backup.create']>>) => void =
      () => {};
    vi.mocked(client.operations['backup.create']).mockImplementationOnce(
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
      resolve(RESPONSE as unknown as Awaited<ReturnType<CoreClient['operations']['backup.create']>>)
    );
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
    expect(client.operations['backup.create']).toHaveBeenCalledTimes(1);
  });

  it('keeps raw denial details out of query and mutation caches', async () => {
    const client = makeClient();
    const { queryClient } = renderScreen(client);
    await screen.findByRole('button', { name: 'Create backup' });
    vi.mocked(client.operations['backup.create']).mockRejectedValueOnce(new ApiCallError(403, POISON, { details: POISON }));
    await userEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    await screen.findByText('Access denied');
    vi.mocked(client.operations['token.list']).mockRejectedValueOnce(new ApiCallError(403, POISON, { details: POISON }));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Access denied');
    await waitFor(() => expect(queryClient.getQueryState(['settings', 'data-root-backup', 'admin-access'])?.status).toBe('error'));
    expect(queryClient.getQueryCache().getAll().some((query) => query.state.error?.message.includes(POISON))).toBe(false);
    expect(queryClient.getMutationCache().getAll().some((mutation) => mutation.state.error?.message.includes(POISON))).toBe(false);
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.error))).not.toContain(POISON);
    expect(JSON.stringify(queryClient.getMutationCache().getAll().map((mutation) => mutation.state.error))).not.toContain(POISON);
  });

  it('retries an authority-check failure without leaking its raw message', async () => {
    const client = makeClient();
    vi.mocked(client.operations['token.list']).mockRejectedValueOnce(new Error(POISON));
    const { container } = renderScreen(client);
    await screen.findByRole('button', { name: 'Try again' });
    expect(container.innerHTML).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Create backup' })).toBeInTheDocument();
  });

  it('uses a safe retryable error without automatically repeating create', async () => {
    const client = makeClient();
    vi.mocked(client.operations['backup.create']).mockRejectedValueOnce(new Error(POISON));
    const { container } = renderScreen(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(client.operations['backup.create']).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
  });
});

/** Hold a transport response independently of query cancellation. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
