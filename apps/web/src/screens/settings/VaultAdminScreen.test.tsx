import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { SURFACE_ELEMENTS } from '../../app/routes';
import { surfaceById, surfacesInGroup } from '../../app/surfaces';

const KEY = 'dGVzdC1vbmx5LW1hc3Rlci1rZXktbXVzdC1ub3QtbGVhaw==';
const POISON = 'okt_poison_secret_must_not_escape';
const STATUS = {
  backendKind: 'encrypted-file' as const,
  state: 'locked' as const,
  diagnostic: 'Vault is locked.',
  masterKeyBase64: KEY,
  secret: POISON,
};

/** Only the three accepted deployment Vault operations are available. */
function makeClient(): CoreClient {
  return {
    app: {
      getVaultAdminStatus: vi.fn().mockResolvedValue(STATUS),
      unlockVaultAdminBackend: vi.fn().mockResolvedValue({ ...STATUS, state: 'available' }),
      lockVaultAdminBackend: vi.fn().mockResolvedValue(STATUS),
    },
  } as unknown as CoreClient;
}

/** Render the production route mapping without a selected Workspace. */
function renderScreen(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          {SURFACE_ELEMENTS['vault-admin'] ?? null}
        </CoreClientProvider>
      </QueryClientProvider>
    ),
    queryClient,
  };
}

/** Submit a synthetic key through the password control and explicit action. */
async function unlock() {
  await userEvent.type(await screen.findByLabelText('Master key (base64)'), KEY);
  await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
}

/** Check both caches, including mutation variables and errors, for secret retention. */
function expectSafeCaches(queryClient: QueryClient) {
  const states = [
    ...queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state),
    ...queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  ];
  const bytes = JSON.stringify(states, (_key, value) =>
    value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value
  );
  expect(bytes).not.toContain(KEY);
  expect(bytes).not.toContain(POISON);
}

describe('Vault backend administration', () => {
  it('registers a Tier-A Settings Administration surface', () => {
    expect(surfaceById('vault-admin')).toMatchObject({
      title: 'Vault backend',
      path: '/settings/vault-admin',
      tier: 'A',
      nav: 'settings-admin',
    });
    expect(surfacesInGroup('settings-admin').map(({ id }) => id)).toContain('vault-admin');
  });

  it('reads status, explicitly unlocks with only the key, then locks and refreshes status', async () => {
    const client = makeClient();
    const { container, queryClient } = renderScreen(client);
    expect(await screen.findByText('Vault is locked.')).toBeInTheDocument();
    expect(client.app.getVaultAdminStatus).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByLabelText('Master key (base64)')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Lock' })).toBeDisabled();
    expect(client.app.unlockVaultAdminBackend).not.toHaveBeenCalled();
    vi.mocked(client.app.getVaultAdminStatus).mockResolvedValueOnce({
      ...STATUS,
      state: 'available',
      diagnostic: 'Vault is available.',
    });
    await unlock();
    expect(await screen.findByText('Vault is available.')).toBeInTheDocument();
    expect(client.app.unlockVaultAdminBackend).toHaveBeenCalledExactlyOnceWith({
      masterKeyBase64: KEY,
    });
    expect(screen.getByLabelText('Master key (base64)')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Lock' }));
    expect(await screen.findByText('Vault is locked.')).toBeInTheDocument();
    expect(client.app.lockVaultAdminBackend).toHaveBeenCalledExactlyOnceWith();
    expect(client.app.getVaultAdminStatus).toHaveBeenCalledTimes(3);
    expect(container.innerHTML).not.toContain(KEY);
    expect(container.innerHTML).not.toContain(POISON);
    expectSafeCaches(queryClient);
    expect(queryClient.getQueryData(['settings', 'vault-admin'])).toEqual({
      backendKind: 'encrypted-file',
      state: 'locked',
      diagnostic: 'Vault is locked.',
    });
  });

  it.each([401, 403])('recovers initial %s denial without mutating', async (status) => {
    const client = makeClient();
    vi.mocked(client.app.getVaultAdminStatus).mockRejectedValueOnce(
      new ApiCallError(status, POISON)
    );
    const { container, queryClient } = renderScreen(client);
    await screen.findByText('Access denied');
    expect(container.querySelector('input')).toBeNull();
    expect(container.innerHTML).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Vault is locked.');
    expect(client.app.unlockVaultAdminBackend).not.toHaveBeenCalled();
    expect(client.app.lockVaultAdminBackend).not.toHaveBeenCalled();
    expectSafeCaches(queryClient);
  });

  it.each([
    'unlock',
    'lock',
    'refetch',
  ] as const)('hides prior status on %s denial and recovers without replay', async (action) => {
    const client = makeClient();
    if (action === 'lock')
      vi.mocked(client.app.getVaultAdminStatus).mockResolvedValueOnce({
        ...STATUS,
        state: 'available',
      });
    const { container, queryClient } = renderScreen(client);
    await screen.findByText('Vault is locked.');
    if (action === 'refetch') {
      await userEvent.type(screen.getByLabelText('Master key (base64)'), KEY);
      vi.mocked(client.app.getVaultAdminStatus).mockRejectedValueOnce(
        new ApiCallError(401, POISON)
      );
      await act(() => queryClient.invalidateQueries({ queryKey: ['settings', 'vault-admin'] }));
    } else if (action === 'unlock') {
      vi.mocked(client.app.unlockVaultAdminBackend).mockRejectedValueOnce(
        new ApiCallError(403, KEY)
      );
      await unlock();
    } else {
      vi.mocked(client.app.lockVaultAdminBackend).mockRejectedValueOnce(
        new ApiCallError(403, POISON)
      );
      await userEvent.click(screen.getByRole('button', { name: 'Lock' }));
    }
    await screen.findByText('Access denied');
    expect(screen.queryByText('Vault is locked.')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(KEY);
    expect(container.innerHTML).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Vault is locked.');
    expect(screen.getByLabelText('Master key (base64)')).toHaveValue('');
    expect(client.app.unlockVaultAdminBackend).toHaveBeenCalledTimes(action === 'unlock' ? 1 : 0);
    expect(client.app.lockVaultAdminBackend).toHaveBeenCalledTimes(action === 'lock' ? 1 : 0);
    expectSafeCaches(queryClient);
  });

  it.each([
    400, 429, 500,
  ])('clears failed unlock input and safely retries a %s error without resubmitting', async (status) => {
    const client = makeClient();
    vi.mocked(client.app.unlockVaultAdminBackend).mockRejectedValueOnce(
      new ApiCallError(status, `${POISON} ${KEY}`)
    );
    const { container, queryClient } = renderScreen(client);
    await unlock();
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Master key (base64)')).toHaveValue('');
    expect(container.innerHTML).not.toContain(KEY);
    expect(container.innerHTML).not.toContain(POISON);
    expectSafeCaches(queryClient);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(client.app.unlockVaultAdminBackend).toHaveBeenCalledTimes(1);
    expect(client.app.lockVaultAdminBackend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();
  });

  it.each([
    'unlock',
    'lock',
  ] as const)('blocks edits and overlapping actions while %s is pending', async (action) => {
    const client = makeClient();
    const method = action === 'unlock' ? 'unlockVaultAdminBackend' : 'lockVaultAdminBackend';
    if (action === 'lock')
      vi.mocked(client.app.getVaultAdminStatus).mockResolvedValueOnce({
        ...STATUS,
        state: 'available',
      });
    let finish = () => {};
    vi.mocked(client.app[method]).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(STATUS);
        })
    );
    const { queryClient } = renderScreen(client);
    if (action === 'unlock') await unlock();
    else await userEvent.click(await screen.findByRole('button', { name: 'Lock' }));
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.getByLabelText('Master key (base64)')).toBeDisabled();
    expect(screen.getByLabelText('Master key (base64)')).toHaveValue('');
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    expectSafeCaches(queryClient);
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(client.app[method]).toHaveBeenCalledTimes(1);
  });

  it('rechecks status after a failed lock without repeating it', async () => {
    const client = makeClient();
    vi.mocked(client.app.getVaultAdminStatus).mockResolvedValueOnce({
      ...STATUS,
      state: 'available',
    });
    vi.mocked(client.app.lockVaultAdminBackend).mockRejectedValueOnce(new Error(POISON));
    const { queryClient } = renderScreen(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Lock' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Lock' })).toBeDisabled();
    expectSafeCaches(queryClient);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('locked', { exact: true });
    expect(client.app.lockVaultAdminBackend).toHaveBeenCalledTimes(1);
    expect(client.app.unlockVaultAdminBackend).not.toHaveBeenCalled();
  });

  it('waits for the post-unlock status read and handles its failure without replay', async () => {
    const client = makeClient();
    renderScreen(client);
    await screen.findByText('Vault is locked.');
    let fail = () => {};
    vi.mocked(client.app.getVaultAdminStatus).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new ApiCallError(500, POISON));
        })
    );
    await unlock();
    await waitFor(() => expect(client.app.getVaultAdminStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Master key (base64)')).toBeDisabled();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    await act(async () => fail());
    await screen.findByRole('alert');
    expect(screen.queryByText('Vault is locked.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Vault is locked.');
    expect(client.app.unlockVaultAdminBackend).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Master key (base64)')).toHaveValue('');
  });

  it('redacts secret-shaped diagnostic text before caching', async () => {
    const client = makeClient();
    vi.mocked(client.app.getVaultAdminStatus).mockResolvedValueOnce({
      ...STATUS,
      diagnostic: `Failure: ${POISON}`,
    });
    const { container, queryClient } = renderScreen(client);
    await screen.findByText('Failure: [redacted]');
    expect(container.innerHTML).not.toContain(POISON);
    expectSafeCaches(queryClient);
  });

  it('blocks both actions when unavailable', async () => {
    const client = makeClient();
    vi.mocked(client.app.getVaultAdminStatus).mockResolvedValueOnce({
      ...STATUS,
      state: 'unavailable',
    });
    renderScreen(client);
    await screen.findByText('unavailable');
    expect(screen.getByLabelText('Master key (base64)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Lock' })).toBeDisabled();
  });

  it('retries status failure without leaking errors or mutating', async () => {
    const client = makeClient();
    vi.mocked(client.app.getVaultAdminStatus).mockRejectedValueOnce(new Error(POISON));
    const { container, queryClient } = renderScreen(client);
    await screen.findByRole('alert');
    expect(container.innerHTML).not.toContain(POISON);
    expectSafeCaches(queryClient);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Vault is locked.');
    expect(client.app.unlockVaultAdminBackend).not.toHaveBeenCalled();
    expect(client.app.lockVaultAdminBackend).not.toHaveBeenCalled();
  });
});
