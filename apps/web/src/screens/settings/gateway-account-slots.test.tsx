import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AiInterfaceScreen } from './AiInterfaceScreen';

const PROVIDERS = {
  providers: [
    {
      subscriptionProviderId: 'openai-codex' as const,
      displayName: 'OpenAI Codex' as const,
      loginModes: ['device_code'] as ['device_code'],
      quotaCapability: 'available' as const,
    },
    {
      subscriptionProviderId: 'xai' as const,
      displayName: 'xAI' as const,
      loginModes: ['device_code'] as ['device_code'],
      quotaCapability: 'available' as const,
    },
  ],
};

function renderGateway(
  accountList: CoreClient['operations']['provider-subscription.account-list']
) {
  const client = {
    core: { meta: vi.fn().mockResolvedValue({}) },
    operations: {
      'provider-subscription.provider-list': vi.fn().mockResolvedValue(PROVIDERS),
      'provider-subscription.account-list': accountList,
      'diagnostics.app': vi.fn().mockRejectedValue(new ApiCallError(500, 'diagnostics down')),
    },
  } as unknown as CoreClient;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CoreClientProvider client={client}>
        <MemoryRouter>
          <AiInterfaceScreen />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

describe('Gateway account slots', () => {
  it('shows a locked Vault state instead of a generic load error', async () => {
    renderGateway(
      vi.fn().mockRejectedValue(
        new ApiCallError(503, 'Provider subscription Vault is locked.', {
          code: 'provider_subscription_vault_locked',
        })
      )
    );

    expect(await screen.findAllByText('Vault is locked.')).toHaveLength(2);
    const links = screen.getAllByRole('link', { name: 'Vault' });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute('href', '/settings/vault-admin');
    expect(screen.getByRole('region', { name: 'OpenAI Codex account slots' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'xAI account slots' })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load OpenAI Codex account slots.")).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load xAI account slots.")).not.toBeInTheDocument();
  });

  it('keeps the generic account-slot error for any other failure', async () => {
    renderGateway(vi.fn().mockRejectedValue(new ApiCallError(500, 'private-account-list')));

    expect(
      await screen.findByText("Couldn't load OpenAI Codex account slots.")
    ).toBeInTheDocument();
    expect(screen.getByText("Couldn't load xAI account slots.")).toBeInTheDocument();
    expect(screen.queryByText('Vault is locked.')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private-account-list');
  });
});
