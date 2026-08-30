import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AccessTokensScreen } from './AccessTokensScreen';

const TIMESTAMP = '2026-08-30T00:00:00.000Z';
const RAW_TOKEN = 'okt_issued_once_never_cached';
const RECORD = {
  tokenId: 'tok_1',
  ownerUserId: 'user_owner',
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

function makeClient(app: Partial<CoreClient['app']> = {}): CoreClient {
  return {
    app: {
      listOpenKitAccessTokens: vi.fn().mockResolvedValue({ items: [RECORD] }),
      createOpenKitAccessToken: vi.fn().mockResolvedValue({ token: RAW_TOKEN, record: RECORD }),
      revokeOpenKitAccessToken: vi
        .fn()
        .mockResolvedValue({ record: { ...RECORD, status: 'revoked' } }),
      rotateOpenKitAccessToken: vi.fn().mockResolvedValue({
        token: RAW_TOKEN,
        record: { ...RECORD, tokenId: 'tok_2' },
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

    expect(await screen.findByText('tok_1')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Owner user id'), 'user_owner');
    await user.click(screen.getByRole('button', { name: 'Issue token' }));

    await waitFor(() =>
      expect(client.app.createOpenKitAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: 'user_owner',
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

    expect(await screen.findByText('tok_1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(client.app.revokeOpenKitAccessToken).toHaveBeenCalledWith('tok_1'));

    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(client.app.rotateOpenKitAccessToken).toHaveBeenCalledWith('tok_1'));
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
    renderScreen(makeClient({ listOpenKitAccessTokens }));

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue token' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listOpenKitAccessTokens).toHaveBeenCalledTimes(2));
  });
});
