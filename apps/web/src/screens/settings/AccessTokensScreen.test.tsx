import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AccessTokensScreen } from './AccessTokensScreen';

const TIMESTAMP = '2026-08-30T00:00:00.000Z';
const RAW_TOKEN = 'okt_FAKE_3';
const RECORD = {
  tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
  ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
  scope: 'server-admin' as const,
  workspaceIds: [],
  status: 'active' as const,
  issuedAt: TIMESTAMP,
  expiresAt: '2027-08-30T00:00:00.000Z',
  revokedAt: null,
  predecessorTokenId: null,
  rotatedGraceExpiresAt: null,
  lastUsedAt: null,
  lastUsedChannel: null,
  lastUsedSource: null,
};

const NANOHOST_TOKEN = {
  tokenId: 'nhtok_00000000-0000-7000-8000-000000000001',
  ownerNanoHostIdentityId: 'nh_00000000-0000-7000-8000-000000000002',
  tokenType: 'nanohost-transport' as const,
  scope: 'nanohost-transport' as const,
  deploymentId: 'dep_00000000-0000-7000-8000-000000000003',
  status: 'active' as const,
  issuedAt: TIMESTAMP,
  expiresAt: '2027-08-30T00:00:00.000Z',
  revokedAt: null,
  predecessorTokenId: null,
  rotationOverlapExpiresAt: null,
  responsibleServerAdminActorId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
  lastUsedAt: null,
  lastUsedChannel: null,
  lastUsedSource: null,
};

function makeClient(app: Partial<CoreClient['operations']> = {}): CoreClient {
  return {
    operations: {
      'credential.list': vi.fn().mockResolvedValue({
        canManageServerCredentials: true,
        items: [{ kind: 'access-token', id: RECORD.tokenId, record: RECORD, integrationId: null }],
      }),
      'token.create': vi.fn().mockResolvedValue({ token: RAW_TOKEN, record: RECORD }),
      'credential.revoke': vi.fn().mockResolvedValue({ status: 'revoked' }),
      'token.rotate': vi.fn().mockResolvedValue({
        token: RAW_TOKEN,
        record: { ...RECORD, tokenId: 'tok_00000000-0000-7c9e-a136-86e094ee0dc9' },
        rotatedRecord: { ...RECORD, status: 'rotated' },
      }),
      ...app,
    },
  } as unknown as CoreClient;
}

function renderScreen(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <AccessTokensScreen />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...rendered, queryClient };
}

describe('Access tokens administration', () => {
  it('lists redacted tokens and issues one to an exact owner without caching the secret', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const { queryClient } = renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Records' }));
    expect(screen.getByText('tok_00000000-0000-71d2-a336-a862021357ff')).toBeInTheDocument();
    await user.type(
      screen.getByLabelText('Owner user id'),
      'usr_00000000-0000-7011-88df-c2b1e8466b6f'
    );
    await user.click(screen.getByRole('button', { name: 'Issue token' }));

    await waitFor(() =>
      expect(client.operations['token.create']).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          scope: 'server-admin',
        })
      )
    );
    expect(await screen.findByLabelText('Issued token')).toHaveValue(RAW_TOKEN);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .findAll()
          .map((query) => query.queryKey)
      )
    ).not.toContain(RAW_TOKEN);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByLabelText('Issued token')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.stringify(
          queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state.data)
        )
      ).not.toContain(RAW_TOKEN)
    );
  });

  it('revokes and rotates listed tokens', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const { queryClient } = renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Records' }));
    expect(screen.getByText('tok_00000000-0000-71d2-a336-a862021357ff')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(client.operations['credential.revoke']).toHaveBeenCalledWith({
        kind: 'access-token',
        id: 'tok_00000000-0000-71d2-a336-a862021357ff',
      })
    );

    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    await waitFor(() =>
      expect(client.operations['token.rotate']).toHaveBeenCalledWith({
        tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
      })
    );
    expect(await screen.findByLabelText('Issued token')).toHaveValue(RAW_TOKEN);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByLabelText('Issued token')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.stringify(
          queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state.data)
        )
      ).not.toContain(RAW_TOKEN)
    );
  });

  it('shows access denied with retry and never asks for a credential', async () => {
    const user = userEvent.setup();
    const listOpenKitAccessTokens = vi
      .fn()
      .mockRejectedValue(new ApiCallError(403, 'deployment admin required', { code: 'forbidden' }));
    renderScreen(makeClient({ 'credential.list': listOpenKitAccessTokens }));

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue token' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listOpenKitAccessTokens).toHaveBeenCalledTimes(2));
  });

  it('shows ordinary users their own sessions, pairing and runs without administrator issuance', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      'credential.list': vi.fn().mockResolvedValue({
        canManageServerCredentials: false,
        items: [
          {
            kind: 'auth-session',
            id: 'auth_owned',
            current: true,
            status: 'active',
            issuedAt: TIMESTAMP,
            expiresAt: TIMESTAMP,
          },
          { kind: 'discord-pairing', id: 'pairing_owned', issuedAt: TIMESTAMP },
          { kind: 'worker-run', id: 'run_owned', status: 'open', issuedAt: TIMESTAMP },
        ],
      }),
    });
    renderScreen(client);
    await user.click(await screen.findByRole('button', { name: 'Records' }));
    expect(screen.getByText('Web session (current)')).toBeInTheDocument();
    expect(screen.getByText('Discord pairing')).toBeInTheDocument();
    expect(screen.getByText('Worker run')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue token' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'End run' }));
    await waitFor(() =>
      expect(client.operations['credential.revoke']).toHaveBeenCalledWith({
        kind: 'worker-run',
        id: 'run_owned',
      })
    );
  });

  it('lists a NanoHost transport token and revokes it only after review', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      'credential.list': vi.fn().mockResolvedValue({
        canManageServerCredentials: true,
        items: [{ kind: 'nanohost-transport', id: NANOHOST_TOKEN.tokenId, record: NANOHOST_TOKEN }],
      }),
    });
    renderScreen(client);

    const section = document.body;
    await user.click(await within(section).findByRole('button', { name: 'Records' }));
    expect(
      within(section).getByText('nhtok_00000000-0000-7000-8000-000000000001')
    ).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Review revoke' }));
    expect(client.operations['credential.revoke']).not.toHaveBeenCalled();
    await user.click(within(section).getByRole('button', { name: 'Revoke transport token' }));
    await waitFor(() =>
      expect(client.operations['credential.revoke']).toHaveBeenCalledWith({
        kind: 'nanohost-transport',
        id: 'nhtok_00000000-0000-7000-8000-000000000001',
      })
    );
  });

  it('keeps a NanoHost transport token when review is cancelled', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      'credential.list': vi.fn().mockResolvedValue({
        canManageServerCredentials: true,
        items: [{ kind: 'nanohost-transport', id: NANOHOST_TOKEN.tokenId, record: NANOHOST_TOKEN }],
      }),
    });
    renderScreen(client);

    const section = document.body;
    await user.click(await within(section).findByRole('button', { name: 'Records' }));
    await user.click(within(section).getByRole('button', { name: 'Review revoke' }));
    await user.click(within(section).getByRole('button', { name: 'Keep transport token' }));
    expect(
      within(section).queryByRole('button', { name: 'Revoke transport token' })
    ).not.toBeInTheDocument();
    expect(client.operations['credential.revoke']).not.toHaveBeenCalled();
  });

  it('does not offer revoke for an already revoked NanoHost transport token', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      'credential.list': vi.fn().mockResolvedValue({
        canManageServerCredentials: true,
        items: [
          {
            kind: 'nanohost-transport',
            id: NANOHOST_TOKEN.tokenId,
            record: { ...NANOHOST_TOKEN, status: 'revoked' },
          },
        ],
      }),
    });
    renderScreen(client);

    const section = document.body;
    await user.click(await within(section).findByRole('button', { name: 'Records' }));
    expect(within(section).getByRole('button', { name: 'Review revoke' })).toBeDisabled();
  });

  it('shows a denied phone revoke inside the Records dialog and keeps access tokens', async () => {
    const user = userEvent.setup();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width: 799px'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const client = makeClient({
        'credential.list': vi.fn().mockResolvedValue({
          canManageServerCredentials: true,
          items: [
            { kind: 'nanohost-transport', id: NANOHOST_TOKEN.tokenId, record: NANOHOST_TOKEN },
          ],
        }),
        'credential.revoke': vi
          .fn()
          .mockRejectedValue(
            new ApiCallError(403, 'deployment admin required', { code: 'forbidden' })
          ),
      });
      renderScreen(client);
      const section = document.body;
      await waitFor(() =>
        expect(within(section).queryByLabelText('Search')).not.toBeInTheDocument()
      );
      await user.click(await within(section).findByRole('button', { name: 'Records' }));
      const dialog = await screen.findByRole('dialog', { name: 'Records' });
      await user.click(within(dialog).getByRole('button', { name: 'Review revoke' }));
      await user.click(within(dialog).getByRole('button', { name: 'Revoke transport token' }));
      const alert = await within(dialog).findByRole('alert');
      expect(alert).toHaveTextContent("Couldn't revoke the NanoHost transport token.");
      expect(dialog.contains(alert)).toBe(true);
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(within(dialog).getByText(NANOHOST_TOKEN.tokenId)).toBeInTheDocument();
      expect(within(dialog).queryByText(RECORD.tokenId)).not.toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Credentials', hidden: true })
      ).toBeInTheDocument();

      expect(
        screen
          .getAllByRole('button', { name: 'Records', hidden: true })
          .some((button) => !dialog.contains(button))
      ).toBe(true);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
