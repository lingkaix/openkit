import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { chatKeys } from '../data';
import { useThreadAudience } from './audience';

const WORKSPACE = 'ws_00000000-0000-7b10-9af8-12fd37a880e0';
const THREAD = 'th_00000000-0000-70a0-9cde-4561f64881c6';

function Probe() {
  const audience = useThreadAudience([WORKSPACE]);
  const source = audience.sourceFor(THREAD);
  const name = source.status === 'open' ? (source.name ?? '') : '';
  return <p>{`${source.status}:${name}`}</p>;
}

function AudienceHarness({
  client,
  queryClient,
  children,
}: {
  client: CoreClient;
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>{children}</CoreClientProvider>
    </QueryClientProvider>
  );
}

function renderAudience(navigation: () => Promise<unknown>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = {
    operations: { 'conversation.navigation': navigation },
  } as unknown as CoreClient;
  render(
    <AudienceHarness client={client} queryClient={queryClient}>
      <Probe />
    </AudienceHarness>
  );
  return queryClient;
}

describe('thread audience', () => {
  it('does not keep a cached title after a denied navigation refetch', async () => {
    let denied = false;
    const queryClient = renderAudience(async () => {
      if (denied) throw new ApiCallError(403, 'denied');
      return {
        items: [
          {
            activity: 'chat',
            thread: { id: THREAD, name: 'Secret launch' },
          },
        ],
      };
    });
    expect(await screen.findByText('open:Secret launch')).toBeInTheDocument();
    denied = true;
    await queryClient.invalidateQueries({ queryKey: chatKeys.navigation(WORKSPACE) });
    await waitFor(() => expect(screen.getByText('denied:')).toBeInTheDocument());
    expect(screen.queryByText(/Secret launch/)).not.toBeInTheDocument();
  });

  it('does not treat a generic navigation failure as denial', async () => {
    let failed = false;
    const queryClient = renderAudience(async () => {
      if (failed) throw new Error('network');
      return {
        items: [{ activity: 'chat', thread: { id: THREAD, name: 'Secret launch' } }],
      };
    });
    expect(await screen.findByText('open:Secret launch')).toBeInTheDocument();
    failed = true;
    await queryClient.invalidateQueries({ queryKey: chatKeys.navigation(WORKSPACE) });
    await waitFor(() => expect(screen.queryByText(/^denied:/)).not.toBeInTheDocument());
    expect(screen.getByText(/^(open|unknown):/)).toBeInTheDocument();
  });
});
