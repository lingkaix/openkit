import type { CoreClient } from '@openkit/core-client';
import { ItemSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { GenerativePresentationView } from './GenerativePresentationView';

const ITEM = ItemSchema.parse({
  id: 'i-gen',
  workspaceId: 'ws1',
  threadId: 'th1',
  turnId: 't1',
  type: 'generative-ui-reference',
  status: 'completed',
  presentationId: '11111111-1111-4111-8111-111111111111',
  title: 'Membership map',
  fallbackText: 'CRM mapping view',
  createdAt: '2026-09-09T00:00:00.000Z',
  completedAt: '2026-09-09T00:00:00.000Z',
});

function Providers({
  children,
  client,
}: {
  children: ReactNode;
  client: CoreClient;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>{children}</CoreClientProvider>
    </QueryClientProvider>
  );
}

describe('GenerativePresentationView', () => {
  it('renders admitted native Text from a published presentation', async () => {
    const getGenerativePresentation = vi.fn().mockResolvedValue({
      id: ITEM.presentationId,
      protocolVersion: 'v0.9',
      catalogId: 'urn:openkit:a2ui:catalog:native:v1',
      messages: [
        { createSurface: { surfaceId: 'surface-item' } },
        {
          updateComponents: {
            components: [
              {
                id: 'root',
                component: { Text: { text: { literalString: 'Membership mem_1 maps to crm_1' } } },
              },
            ],
          },
        },
      ],
      actions: [],
    });
    const client = {
      app: { getGenerativePresentation },
    } as unknown as CoreClient;
    render(
      <Providers client={client}>
        <GenerativePresentationView item={ITEM} />
      </Providers>
    );
    expect(await screen.findByText('Membership mem_1 maps to crm_1')).toBeInTheDocument();
    expect(getGenerativePresentation).toHaveBeenCalledWith('ws1', ITEM.presentationId);
  });

  it('falls back to plain content when the presentation cannot load', async () => {
    const client = {
      app: {
        getGenerativePresentation: vi.fn().mockRejectedValue(new Error('unavailable')),
      },
    } as unknown as CoreClient;
    render(
      <Providers client={client}>
        <GenerativePresentationView item={ITEM} />
      </Providers>
    );
    expect(await screen.findByText('CRM mapping view')).toBeInTheDocument();
  });
});
