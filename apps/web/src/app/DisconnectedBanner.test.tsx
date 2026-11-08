import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from './core-client';
import { DisconnectedBanner } from './DisconnectedBanner';

function renderBanner(meta: () => Promise<unknown>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = { core: { meta: vi.fn(meta) }, operations: {} } as unknown as CoreClient;
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <DisconnectedBanner />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return client;
}

function setBrowserOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

describe('DisconnectedBanner', () => {
  afterEach(() => {
    setBrowserOnline(true);
  });

  it('follows the browser going offline and back online with no other update', async () => {
    const client = renderBanner(async () => ({}));
    await waitFor(() => expect(client.core.meta).toHaveBeenCalled());
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();

    setBrowserOnline(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText('Offline')).toBeInTheDocument();

    setBrowserOnline(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
  });
});
