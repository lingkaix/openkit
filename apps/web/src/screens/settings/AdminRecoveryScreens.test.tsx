import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { SURFACE_ELEMENTS } from '../../app/routes';
import { surfaceById, surfacesInGroup } from '../../app/surfaces';

const POISON = 'okt_private_payload_must_not_escape';
const RECOVERY = {
  recovery: {
    workspaceId: 'ws_fixture',
    ownerUserId: 'user_owner',
    administratorRole: null,
    registryRevision: 7,
    secret: POISON,
  },
  token: POISON,
};
const DISABLED = {
  user: {
    userId: 'user_fixture',
    status: 'disabled',
    disabledAt: '2026-09-14T10:00:00.000Z',
    secret: POISON,
  },
  token: POISON,
};

/** Only the session probe and the three scoped operations are available. */
function makeClient(): CoreClient {
  return {
    app: {
      listOpenKitAccessTokens: vi.fn().mockResolvedValue({ items: [] }),
      getWorkspaceAccessRecoveryState: vi.fn().mockResolvedValue(RECOVERY),
      recoverWorkspaceAccess: vi.fn().mockResolvedValue({
        recovery: { ...RECOVERY.recovery, administratorRole: 'editor', registryRevision: 8 },
      }),
      disableUser: vi.fn().mockResolvedValue(DISABLED),
    },
  } as unknown as CoreClient;
}

/** Mount the actual registered surface without a selected Workspace. */
function renderScreen(client: CoreClient, id = 'workspace-access-recovery') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>{SURFACE_ELEMENTS[id] ?? null}</CoreClientProvider>
      </QueryClientProvider>
    ),
    queryClient,
  };
}

/** Load a deliberately named fixture through the visible form. */
async function loadRecovery() {
  await userEvent.type(await screen.findByLabelText('Workspace ID'), '  ws_fixture  ');
  await userEvent.click(screen.getByRole('button', { name: 'Load recovery state' }));
  await screen.findByText('user_owner');
}

/** Confirm one fixture user explicitly; production identities never enter these tests. */
async function confirmDisable() {
  await userEvent.type(await screen.findByLabelText('User ID'), 'user_fixture');
  await userEvent.type(screen.getByLabelText('Confirm user ID'), 'user_fixture');
  await userEvent.click(screen.getByRole('button', { name: 'Disable user' }));
}

describe('Web admin recovery and user disable', () => {
  it.each([
    'workspace-access-recovery',
    'disable-user',
  ])('registers %s under Settings Administration', (id) => {
    expect(surfaceById(id)).toMatchObject({
      path: `/settings/${id}`,
      tier: 'A',
      nav: 'settings-admin',
    });
    expect(surfacesInGroup('settings-admin').map(({ id }) => id)).toContain(id);
    expect(SURFACE_ELEMENTS[id]).toBeTruthy();
  });

  it('loads only on request and recovers with the loaded revision and generated request ID', async () => {
    const client = makeClient();
    const { container, queryClient } = renderScreen(client);
    expect(await screen.findByRole('button', { name: 'Load recovery state' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add myself as editor' })).toBeDisabled();
    expect(client.app.getWorkspaceAccessRecoveryState).not.toHaveBeenCalled();
    await loadRecovery();
    expect(client.app.getWorkspaceAccessRecoveryState).toHaveBeenCalledExactlyOnceWith(
      'ws_fixture'
    );
    for (const value of ['ws_fixture', 'user_owner', 'No active membership', '7'])
      expect(screen.getByText(value)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add myself as editor' }));
    await screen.findByText('editor');
    expect(client.app.recoverWorkspaceAccess).toHaveBeenCalledExactlyOnceWith('ws_fixture', {
      action: 'add-self-as-editor',
      expectedRegistryRevision: 7,
      requestId: expect.any(String),
    });
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(POISON);
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data)
      )
    ).not.toContain(POISON);
  });

  it('requires exact target confirmation for ownership transfer and clears it after use or target edits', async () => {
    const client = makeClient();
    renderScreen(client);
    await loadRecovery();
    const transfer = screen.getByRole('button', { name: 'Transfer ownership to myself' });
    expect(transfer).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Confirm workspace ID'), 'wrong');
    expect(transfer).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Confirm workspace ID'));
    await userEvent.type(screen.getByLabelText('Confirm workspace ID'), 'ws_fixture');
    await userEvent.click(transfer);
    await screen.findByText('editor');
    expect(client.app.recoverWorkspaceAccess).toHaveBeenCalledExactlyOnceWith('ws_fixture', {
      action: 'transfer-ownership-to-self',
      expectedRegistryRevision: 7,
      requestId: expect.any(String),
    });
    expect(screen.getByLabelText('Confirm workspace ID')).toHaveValue('');
    await userEvent.type(screen.getByLabelText('Workspace ID'), '2');
    expect(screen.queryByText('user_owner')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add myself as editor' })).toBeDisabled();
  });

  it('starts disable dry, requires matching confirmation, and projects only lifecycle fields', async () => {
    const client = makeClient();
    const { container, queryClient } = renderScreen(client, 'disable-user');
    const input = await screen.findByLabelText('User ID');
    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Disable user' })).toBeDisabled();
    await userEvent.type(input, 'user_fixture');
    expect(screen.getByRole('button', { name: 'Disable user' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Confirm user ID'), 'wrong');
    expect(screen.getByRole('button', { name: 'Disable user' })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Confirm user ID'));
    await userEvent.type(screen.getByLabelText('Confirm user ID'), 'user_fixture');
    expect(client.app.disableUser).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Disable user' }));
    await screen.findByText('disabled');
    expect(client.app.disableUser).toHaveBeenCalledExactlyOnceWith('user_fixture', {
      requestId: expect.any(String),
    });
    for (const value of ['user_fixture', DISABLED.user.disabledAt])
      expect(screen.getByText(value)).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm user ID')).toHaveValue('');
    expect(container.innerHTML).not.toContain(POISON);
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data)
      )
    ).not.toContain(POISON);
    await userEvent.type(input, '2');
    expect(screen.queryByText('disabled')).not.toBeInTheDocument();
  });

  describe.each(['workspace-access-recovery', 'disable-user'])('%s authority', (id) => {
    it.each([401, 403])('handles initial %s and probes again without mutations', async (status) => {
      const client = makeClient();
      vi.mocked(client.app.listOpenKitAccessTokens).mockRejectedValueOnce(
        new ApiCallError(status, POISON)
      );
      const { container } = renderScreen(client, id);
      await screen.findByText('Access denied');
      expect(container.querySelector('input')).toBeNull();
      expect(container.innerHTML).not.toContain(POISON);
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await screen.findByLabelText(id === 'disable-user' ? 'User ID' : 'Workspace ID');
      expect(client.app.listOpenKitAccessTokens).toHaveBeenCalledTimes(2);
      expect(client.app.recoverWorkspaceAccess).not.toHaveBeenCalled();
      expect(client.app.disableUser).not.toHaveBeenCalled();
    });

    it('hides prior results on session refetch denial and clears them on retry', async () => {
      const client = makeClient();
      const { container, queryClient } = renderScreen(client, id);
      if (id === 'disable-user') {
        await confirmDisable();
        await screen.findByText('disabled');
      } else await loadRecovery();
      vi.mocked(client.app.listOpenKitAccessTokens).mockRejectedValueOnce(
        new ApiCallError(403, POISON)
      );
      await act(() =>
        queryClient.invalidateQueries({ queryKey: ['settings', id, 'admin-access'] })
      );
      await screen.findByText('Access denied');
      expect(container.innerHTML).not.toContain(
        id === 'disable-user' ? 'user_fixture' : 'user_owner'
      );
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(
        await screen.findByLabelText(id === 'disable-user' ? 'User ID' : 'Workspace ID')
      ).toHaveValue('');
      expect(screen.queryByText('disabled')).not.toBeInTheDocument();
      expect(screen.queryByText('user_owner')).not.toBeInTheDocument();
    });
  });

  it.each([
    'getWorkspaceAccessRecoveryState',
    'recoverWorkspaceAccess',
    'disableUser',
  ] as const)('denies %s and never replays on Retry', async (method) => {
    const client = makeClient();
    const { container } = renderScreen(
      client,
      method === 'disableUser' ? 'disable-user' : 'workspace-access-recovery'
    );
    vi.mocked(client.app[method]).mockRejectedValueOnce(new ApiCallError(401, POISON));
    if (method === 'disableUser') await confirmDisable();
    else if (method === 'recoverWorkspaceAccess') {
      await loadRecovery();
      await userEvent.click(screen.getByRole('button', { name: 'Add myself as editor' }));
    } else {
      await userEvent.type(await screen.findByLabelText('Workspace ID'), 'ws_fixture');
      await userEvent.click(screen.getByRole('button', { name: 'Load recovery state' }));
    }
    await screen.findByText('Access denied');
    expect(container.innerHTML).not.toContain(POISON);
    expect(screen.queryByText('user_owner')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByLabelText(method === 'disableUser' ? 'User ID' : 'Workspace ID');
    expect(client.app[method]).toHaveBeenCalledTimes(1);
  });

  it.each([
    'recoverWorkspaceAccess',
    'disableUser',
  ] as const)('resets %s errors without replaying or retaining confirmation', async (method) => {
    const client = makeClient();
    vi.mocked(client.app[method]).mockRejectedValueOnce(new Error(POISON));
    const { container } = renderScreen(
      client,
      method === 'disableUser' ? 'disable-user' : 'workspace-access-recovery'
    );
    if (method === 'disableUser') await confirmDisable();
    else {
      await loadRecovery();
      await userEvent.click(screen.getByRole('button', { name: 'Add myself as editor' }));
    }
    await screen.findByRole('alert');
    expect(container.innerHTML).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(client.app[method]).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', {
        name: method === 'disableUser' ? 'Disable user' : 'Add myself as editor',
      })
    ).toBeDisabled();
  });
  it('requires a fresh revision after conflict and a new request ID for another explicit recovery', async () => {
    const client = makeClient();
    vi.mocked(client.app.recoverWorkspaceAccess).mockRejectedValueOnce(
      new ApiCallError(409, POISON)
    );
    renderScreen(client);
    await loadRecovery();
    await userEvent.click(screen.getByRole('button', { name: 'Add myself as editor' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Add myself as editor' })).toBeDisabled();
    const firstRequest = vi.mocked(client.app.recoverWorkspaceAccess).mock.calls[0][1];
    expect(firstRequest.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    vi.mocked(client.app.getWorkspaceAccessRecoveryState).mockResolvedValueOnce({
      recovery: { ...RECOVERY.recovery, registryRevision: 9 },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Load recovery state' }));
    await screen.findByText('9');
    await userEvent.click(screen.getByRole('button', { name: 'Add myself as editor' }));
    await screen.findByText('editor');
    const secondRequest = vi.mocked(client.app.recoverWorkspaceAccess).mock.calls[1][1];
    expect(secondRequest.expectedRegistryRevision).toBe(9);
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
  });

  it.each([
    'workspace-access-recovery',
    'disable-user',
  ])('recovers a safe probe error on %s', async (id) => {
    const client = makeClient();
    vi.mocked(client.app.listOpenKitAccessTokens).mockRejectedValueOnce(new Error(POISON));
    const { container } = renderScreen(client, id);
    await screen.findByRole('alert');
    expect(container.innerHTML).not.toContain(POISON);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByLabelText(id === 'disable-user' ? 'User ID' : 'Workspace ID');
    expect(client.app.disableUser).not.toHaveBeenCalled();
    expect(client.app.recoverWorkspaceAccess).not.toHaveBeenCalled();
  });

  it.each([
    'getWorkspaceAccessRecoveryState',
    'recoverWorkspaceAccess',
    'disableUser',
  ] as const)('blocks all target edits and overlapping actions while %s is pending', async (method) => {
    const client = makeClient();
    let finish = () => {};
    vi.mocked(client.app[method]).mockImplementationOnce(
      () =>
        new Promise<never>((resolve) => {
          finish = () => resolve((method === 'disableUser' ? DISABLED : RECOVERY) as never);
        })
    );
    renderScreen(client, method === 'disableUser' ? 'disable-user' : 'workspace-access-recovery');
    if (method === 'disableUser') await confirmDisable();
    else if (method === 'recoverWorkspaceAccess') {
      await loadRecovery();
      await userEvent.click(screen.getByRole('button', { name: 'Add myself as editor' }));
    } else {
      await userEvent.type(await screen.findByLabelText('Workspace ID'), 'ws_fixture');
      await userEvent.click(screen.getByRole('button', { name: 'Load recovery state' }));
    }
    await screen.findByRole('status');
    for (const input of screen.getAllByRole('textbox')) expect(input).toBeDisabled();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    await act(async () => finish());
    await screen.findByText(method === 'disableUser' ? 'disabled' : 'user_owner');
    expect(client.app[method]).toHaveBeenCalledTimes(1);
  });
});
