import type { CoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { surfaceById } from '../../app/surfaces';
import { accountChannelsKey, useAccountMutation } from '../account/session';
import { ChannelsScreen } from './ChannelsScreen';

const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const recipientUserId = allocateEntityId('usr');

function client(operations: Partial<CoreClient['operations']> = {}) {
  return {
    auth: { email: { signOut: vi.fn().mockResolvedValue({}) } },
    core: { meta: vi.fn().mockResolvedValue({}) },
    operations: {
      'channel.discord.status': vi
        .fn()
        .mockResolvedValue({ configured: true, sendingAvailable: true, binding: null }),
      'channel.discord.pair': vi.fn().mockResolvedValue({
        challenge: 'one-use-test-challenge',
        expiresAt: Date.now() + 300_000,
      }),
      'channel.discord.revoke': vi.fn().mockResolvedValue(null),
      'notification.list': vi.fn().mockResolvedValue({ items: [] }),
      'notification.send': vi.fn(),
      ...operations,
    },
  } as unknown as CoreClient;
}
function show(
  value: CoreClient,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={value}>
        <MemoryRouter>
          <ChannelsScreen />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

describe('Discord settings', () => {
  it('removes prior-user bindings, private routes and pairing results at account transition', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
    });
    const oldStatusKey = [...accountChannelsKey, 'status'];
    const oldDeliveriesKey = [...accountChannelsKey, 'deliveries'];
    queryClient.setQueryData(oldStatusKey, {
      configured: true,
      sendingAvailable: true,
      binding: { discordUserId: 'prior-account', pairedAt: 1 },
    });
    queryClient.setQueryData(oldDeliveriesKey, {
      items: [{ appPath: `/chat/${workspaceId}/${threadId}` }],
    });
    const pairing = queryClient.getMutationCache().build(queryClient, {
      mutationKey: [...accountChannelsKey, 'pair'],
      mutationFn: async () => ({ challenge: 'prior-user-challenge' }),
    });
    await pairing.execute(undefined);
    const value = client();
    const transition = renderHook(() => useAccountMutation(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <CoreClientProvider client={value}>{children}</CoreClientProvider>
        </QueryClientProvider>
      ),
    });
    await act(async () => {
      await transition.result.current.mutateAsync({
        operation: 'signOut',
        email: '',
        password: '',
        name: '',
      });
    });
    expect(queryClient.getQueryData(oldStatusKey)).toBeUndefined();
    expect(queryClient.getQueryData(oldDeliveriesKey)).toBeUndefined();
    expect(queryClient.getMutationCache().findAll({ mutationKey: accountChannelsKey })).toEqual([]);
    transition.unmount();
    const nextUser = client();
    show(nextUser, queryClient);
    expect(await screen.findByRole('button', { name: 'Pair Discord account' })).toBeInTheDocument();
    expect(nextUser.operations['channel.discord.status']).toHaveBeenCalledOnce();
    expect(nextUser.operations['notification.list']).toHaveBeenCalledOnce();
    expect(screen.queryByText('prior-account')).not.toBeInTheDocument();
    expect(screen.queryByText('prior-user-challenge')).not.toBeInTheDocument();
  });

  it('publishes the live user settings surface and starts pairing only on an explicit action', async () => {
    const value = client();
    show(value);
    expect(surfaceById('channels')).toMatchObject({ tier: 'A', nav: 'settings-user' });
    const button = await screen.findByRole('button', { name: 'Pair Discord account' });
    expect(value.operations['channel.discord.pair']).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(
      await screen.findByText('/openkit pair challenge:one-use-test-challenge')
    ).toBeInTheDocument();
    expect(value.operations['channel.discord.pair']).toHaveBeenCalledWith({});
  });

  it('explains missing deployment configuration without offering a false connection', async () => {
    show(
      client({
        'channel.discord.status': vi
          .fn()
          .mockResolvedValue({ configured: false, sendingAvailable: false, binding: null }),
      })
    );
    expect(
      await screen.findByText('Discord is not configured on this deployment.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pair Discord account' })).not.toBeInTheDocument();
  });

  it('can revoke a retained binding after deployment configuration is removed', async () => {
    const value = client({
      'channel.discord.status': vi.fn().mockResolvedValue({
        configured: false,
        sendingAvailable: false,
        binding: { discordUserId: '123456789012345678', pairedAt: 1 },
      }),
    });
    show(value);
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Discord binding' }));
    expect(value.operations['channel.discord.revoke']).toHaveBeenCalledWith({});
    expect(screen.queryByRole('button', { name: 'Pair Discord account' })).not.toBeInTheDocument();
  });

  it('requires the exact failed attempt for retry and offers no resend after an unknown outcome', async () => {
    const base = {
      source: {
        workspaceId,
        threadId,
        requestId: 'req_channels',
        kind: 'approval-request',
      },
      recipientUserId,
      channel: 'discord',
      createdAt: '2026-10-16T00:00:00Z',
      appPath: `/tasks/${workspaceId}/${threadId}?requestId=req_channels`,
    };
    const value = client({
      'channel.discord.status': vi.fn().mockResolvedValue({
        configured: true,
        sendingAvailable: true,
        binding: { discordUserId: '123456789012345678', pairedAt: 1 },
      }),
      'notification.list': vi.fn().mockResolvedValue({
        items: [
          {
            ...base,
            id: '10000000-0000-4000-8000-000000000001',
            status: 'failed-no-send',
            attempt: { id: 7 },
          },
          {
            ...base,
            id: '10000000-0000-4000-8000-000000000002',
            status: 'delivery-unknown',
            attempt: { id: 8 },
          },
        ],
      }),
      'notification.send': vi.fn().mockResolvedValue({ ...base, status: 'sent' }),
    });
    show(value);
    expect(await screen.findByText('Delivery unknown')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry send' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Retry send' }));
    await waitFor(() =>
      expect(value.operations['notification.send']).toHaveBeenCalledWith({
        deliveryId: '10000000-0000-4000-8000-000000000001',
        expectedAttemptId: 7,
      })
    );
    expect(screen.getAllByRole('link', { name: 'Inspect request' })).toHaveLength(2);
  });
});
