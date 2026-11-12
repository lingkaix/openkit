import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { BackLink } from './BackLink';

function renderLink(ui: ReactNode) {
  const client = { operations: {} } as unknown as CoreClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter>{ui}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

describe('timeline back link', () => {
  it('omits run at when the only timestamp is not the run start', async () => {
    renderLink(
      <BackLink
        workspaceId="ws_00000000-0000-7b10-9af8-12fd37a880e0"
        threadId="th_00000000-0000-70a0-9cde-4561f64881c6"
        turnId="tu_00000000-0000-7da3-a7fc-80982f9b215e"
        recordedAt="2026-11-08T10:02:00.000Z"
        audience={{ status: 'open', name: 'Launch notes', activity: 'chat' }}
      />
    );
    const link = await screen.findByRole('link');
    await waitFor(() => expect(link).toHaveTextContent('From: Launch notes'));
    expect(link).not.toHaveTextContent('run at');
  });
});
