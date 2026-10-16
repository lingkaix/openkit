import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { MyAdminAccessScreen } from './MyAdminAccessScreen';

const TIMESTAMP = '2026-08-30T00:00:00.000Z';
const TOKENS = {
  defaultTokenId: 'tok_00000000-0000-7fcf-93d8-22b95fc6c2e6',
  items: [
    {
      tokenId: 'tok_00000000-0000-7fcf-93d8-22b95fc6c2e6',
      ownerUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
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
    },
    {
      tokenId: 'tok_00000000-0000-7358-9dd3-3d116e8695d2',
      ownerUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
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
    },
  ],
};

function makeClient(app: Partial<CoreClient['operations']> = {}): CoreClient {
  return {
    operations: {
      'token.my-admin-list': vi.fn().mockResolvedValue(TOKENS),
      'token.my-admin-default': vi.fn().mockResolvedValue({
        ...TOKENS,
        defaultTokenId: 'tok_00000000-0000-7358-9dd3-3d116e8695d2',
      }),
      ...app,
    },
  } as unknown as CoreClient;
}

function renderScreen(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MyAdminAccessScreen />
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

describe('My admin access', () => {
  it('lists redacted server-admin tokens and selects the effective default', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    expect(await screen.findByText('tok_00000000-0000-7fcf-93d8-22b95fc6c2e6')).toBeInTheDocument();
    expect(screen.getByText('tok_00000000-0000-7358-9dd3-3d116e8695d2')).toBeInTheDocument();
    await user.click(
      screen.getByRole('radio', { name: 'tok_00000000-0000-7358-9dd3-3d116e8695d2 (active)' })
    );
    await waitFor(() =>
      expect(client.operations['token.my-admin-default']).toHaveBeenCalledWith({
        tokenId: 'tok_00000000-0000-7358-9dd3-3d116e8695d2',
      })
    );
  });

  it('shows access denied with retry and never asks for a credential', async () => {
    const user = userEvent.setup();
    const listMyAdminAccessTokens = vi.fn().mockRejectedValue(
      new ApiCallError(403, 'canonical session required', {
        code: 'workspace_access_denied',
      })
    );
    renderScreen(makeClient({ 'token.my-admin-list': listMyAdminAccessTokens }));

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listMyAdminAccessTokens).toHaveBeenCalledTimes(2));
  });

  it('keeps unusable tokens visible and reports a failed default change', async () => {
    const user = userEvent.setup();
    const setMyAdminAccessTokenDefault = vi.fn().mockRejectedValue(new Error('rejected'));
    renderScreen(
      makeClient({
        'token.my-admin-list': vi.fn().mockResolvedValue({
          ...TOKENS,
          items: [
            ...TOKENS.items,
            {
              ...TOKENS.items[1],
              tokenId: 'tok_00000000-0000-72cc-b0c5-e119824039f4',
              status: 'revoked',
              revokedAt: TIMESTAMP,
            },
          ],
        }),
        'token.my-admin-default': setMyAdminAccessTokenDefault,
      })
    );

    const revoked = await screen.findByRole('radio', {
      name: 'tok_00000000-0000-72cc-b0c5-e119824039f4 (revoked)',
    });
    expect(revoked).toBeEnabled();
    await user.click(revoked);
    await waitFor(() =>
      expect(setMyAdminAccessTokenDefault).toHaveBeenCalledWith({
        tokenId: 'tok_00000000-0000-72cc-b0c5-e119824039f4',
      })
    );
    expect(
      await screen.findByText("Couldn't change the default server-admin token.")
    ).toBeInTheDocument();
  });
});
