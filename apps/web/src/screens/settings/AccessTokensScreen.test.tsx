import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AccessTokensScreen } from './AccessTokensScreen';

const TIMESTAMP = '2026-08-30T00:00:00.000Z';
const RAW_TOKEN = 'okt_issued_once_never_cached';
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
      'token.list': vi.fn().mockResolvedValue({ items: [RECORD] }),
      'token.create': vi.fn().mockResolvedValue({ token: RAW_TOKEN, record: RECORD }),
      'token.revoke': vi.fn().mockResolvedValue({ record: { ...RECORD, status: 'revoked' } }),
      'token.rotate': vi.fn().mockResolvedValue({
        token: RAW_TOKEN,
        record: { ...RECORD, tokenId: 'tok_00000000-0000-7c9e-a136-86e094ee0dc9' },
        rotatedRecord: { ...RECORD, status: 'rotated' },
      }),
      'nanohost.token-list': vi.fn().mockResolvedValue({ items: [] }),
      'nanohost.token-revoke': vi.fn().mockResolvedValue({
        record: { ...NANOHOST_TOKEN, status: 'revoked' },
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
      expect(client.operations['token.revoke']).toHaveBeenCalledWith({
        tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
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
    renderScreen(makeClient({ 'token.list': listOpenKitAccessTokens }));

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue token' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listOpenKitAccessTokens).toHaveBeenCalledTimes(2));
  });

  it('explains that access tokens exist only in server mode', async () => {
    renderScreen(
      makeClient({
        'token.list': vi.fn().mockRejectedValue(
          new ApiCallError(404, 'Access-token administration is only available in server mode.', {
            code: 'access_token_admin_server_mode_required',
          })
        ),
      })
    );

    expect(
      await screen.findByText('Access tokens are used only when OpenKit runs as a server.')
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load access tokens.")).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue token' })).not.toBeInTheDocument();
  });

  it('lists a NanoHost transport token and revokes it only after review', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      'nanohost.token-list': vi.fn().mockResolvedValue({ items: [NANOHOST_TOKEN] }),
    });
    renderScreen(client);

    const section = await screen.findByRole('region', { name: 'NanoHost transport tokens' });
    await user.click(await within(section).findByRole('button', { name: 'Records' }));
    expect(
      within(section).getByText('nhtok_00000000-0000-7000-8000-000000000001')
    ).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Review revoke' }));
    expect(client.operations['nanohost.token-revoke']).not.toHaveBeenCalled();
    await user.click(within(section).getByRole('button', { name: 'Revoke transport token' }));
    await waitFor(() =>
      expect(client.operations['nanohost.token-revoke']).toHaveBeenCalledWith({
        tokenId: 'nhtok_00000000-0000-7000-8000-000000000001',
      })
    );
  });

  it('keeps a NanoHost transport token when review is cancelled', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      'nanohost.token-list': vi.fn().mockResolvedValue({ items: [NANOHOST_TOKEN] }),
    });
    renderScreen(client);

    const section = await screen.findByRole('region', { name: 'NanoHost transport tokens' });
    await user.click(await within(section).findByRole('button', { name: 'Records' }));
    await user.click(within(section).getByRole('button', { name: 'Review revoke' }));
    await user.click(within(section).getByRole('button', { name: 'Keep transport token' }));
    expect(
      within(section).queryByRole('button', { name: 'Revoke transport token' })
    ).not.toBeInTheDocument();
    expect(client.operations['nanohost.token-revoke']).not.toHaveBeenCalled();
  });

  it('does not offer revoke for an already revoked NanoHost transport token', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      'nanohost.token-list': vi.fn().mockResolvedValue({
        items: [{ ...NANOHOST_TOKEN, status: 'revoked' }],
      }),
    });
    renderScreen(client);

    const section = await screen.findByRole('region', { name: 'NanoHost transport tokens' });
    await user.click(await within(section).findByRole('button', { name: 'Records' }));
    expect(within(section).getByRole('button', { name: 'Review revoke' })).toBeDisabled();
  });

  it('explains that NanoHost transport tokens exist only in server mode', async () => {
    renderScreen(
      makeClient({
        'nanohost.token-list': vi
          .fn()
          .mockRejectedValue(
            new ApiCallError(
              404,
              'NanoHost transport administration is only available in server mode.',
              { code: 'nanohost_transport_admin_server_mode_required' }
            )
          ),
      })
    );

    expect(
      await screen.findByText(
        'NanoHost transport tokens are used only when OpenKit runs as a server.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review revoke' })).not.toBeInTheDocument();
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
        'nanohost.token-list': vi.fn().mockResolvedValue({ items: [NANOHOST_TOKEN] }),
        'nanohost.token-revoke': vi
          .fn()
          .mockRejectedValue(
            new ApiCallError(403, 'deployment admin required', { code: 'forbidden' })
          ),
      });
      renderScreen(client);
      const section = await screen.findByRole('region', { name: 'NanoHost transport tokens' });
      await waitFor(() =>
        expect(within(section).queryByLabelText('Search')).not.toBeInTheDocument()
      );
      await user.click(within(section).getByRole('button', { name: 'Records' }));
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
        screen.getByRole('heading', { name: 'Access tokens', hidden: true })
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Issue token', hidden: true })).toBeInTheDocument();
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
