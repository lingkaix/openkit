import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { MyAdminAccessScreen } from './MyAdminAccessScreen';

const TIMESTAMP = '2026-08-30T00:00:00.000Z';
const TOKENS = {
  defaultTokenId: 'tok_default',
  items: [
    {
      tokenId: 'tok_default',
      ownerUserId: 'user_1',
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
      tokenId: 'tok_other',
      ownerUserId: 'user_1',
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

function makeClient(app: Partial<CoreClient['app']> = {}): CoreClient {
  return {
    app: {
      listMyAdminAccessTokens: vi.fn().mockResolvedValue(TOKENS),
      setMyAdminAccessTokenDefault: vi.fn().mockResolvedValue({
        ...TOKENS,
        defaultTokenId: 'tok_other',
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

    expect(await screen.findByText('tok_default')).toBeInTheDocument();
    expect(screen.getByText('tok_other')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'tok_other (active)' }));
    await waitFor(() =>
      expect(client.app.setMyAdminAccessTokenDefault).toHaveBeenCalledWith({ tokenId: 'tok_other' })
    );
  });

  it('shows access denied with retry and never asks for a credential', async () => {
    const user = userEvent.setup();
    const listMyAdminAccessTokens = vi.fn().mockRejectedValue(
      new ApiCallError(403, 'canonical session required', {
        code: 'access_token_session_required',
      })
    );
    renderScreen(makeClient({ listMyAdminAccessTokens }));

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
        listMyAdminAccessTokens: vi.fn().mockResolvedValue({
          ...TOKENS,
          items: [
            ...TOKENS.items,
            {
              ...TOKENS.items[1],
              tokenId: 'tok_revoked',
              status: 'revoked',
              revokedAt: TIMESTAMP,
            },
          ],
        }),
        setMyAdminAccessTokenDefault,
      })
    );

    const revoked = await screen.findByRole('radio', { name: 'tok_revoked (revoked)' });
    expect(revoked).toBeEnabled();
    await user.click(revoked);
    await waitFor(() =>
      expect(setMyAdminAccessTokenDefault).toHaveBeenCalledWith({ tokenId: 'tok_revoked' })
    );
    expect(
      await screen.findByText("Couldn't change the default server-admin token.")
    ).toBeInTheDocument();
  });
});
