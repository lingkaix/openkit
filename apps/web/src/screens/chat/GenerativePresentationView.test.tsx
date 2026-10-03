import type { CoreClient } from '@openkit/core-client';
import { GenerativeUiReferenceItemSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { GenerativePresentationView } from './GenerativePresentationView';

const ITEM = GenerativeUiReferenceItemSchema.parse({
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

function Providers({ children, client }: { children: ReactNode; client: CoreClient }) {
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
        {
          version: 'v0.9',
          createSurface: {
            surfaceId: 'surface-item',
            catalogId: 'urn:openkit:a2ui:catalog:native:v1',
            sendDataModel: false,
          },
        },
        {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'surface-item',
            components: [
              {
                id: 'root',
                component: 'Text',
                text: 'Membership mem_1 maps to crm_1',
              },
            ],
          },
        },
      ],
      actions: [],
    });
    const client = {
      operations: { 'generative-ui.get': getGenerativePresentation },
    } as unknown as CoreClient;
    render(
      <Providers client={client}>
        <GenerativePresentationView item={ITEM} />
      </Providers>
    );
    expect(await screen.findByText('Membership mem_1 maps to crm_1')).toBeInTheDocument();
    expect(getGenerativePresentation).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      presentationId: ITEM.presentationId,
    });
  });

  it('passes complete refresh and action selectors and retains the request id after a failed submit', async () => {
    const modelMessage = {
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'surface',
        path: '/',
        value: { records: [{ revision: 1, data: { note: 'Saved' } }] },
      },
    };
    const result = {
      messages: [modelMessage],
      observedAt: '2026-10-03T00:00:00.000Z',
      refreshUnavailable: false,
    };
    const refresh = vi.fn().mockResolvedValue(result);
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error('Retry this write'))
      .mockResolvedValue(result);
    const client = {
      operations: {
        'generative-ui.get': vi.fn().mockResolvedValue({
          messages: [
            {
              version: 'v0.9',
              createSurface: {
                surfaceId: 'surface',
                catalogId: 'urn:openkit:a2ui:catalog:native:v1',
                sendDataModel: false,
              },
            },
            {
              version: 'v0.9',
              updateComponents: {
                surfaceId: 'surface',
                components: [
                  { id: 'root', component: 'Column', children: ['refresh', 'save'] },
                  {
                    id: 'refresh',
                    component: 'Button',
                    child: 'refresh-label',
                    action: { event: { name: 'refresh' } },
                  },
                  { id: 'refresh-label', component: 'Text', text: 'Refresh proof' },
                  {
                    id: 'save',
                    component: 'Button',
                    child: 'save-label',
                    action: {
                      event: {
                        name: 'save',
                        context: {
                          expectedRecordRevision: { path: '/records/0/revision' },
                          values: { path: '/records/0/data' },
                        },
                      },
                    },
                  },
                  { id: 'save-label', component: 'Text', text: 'Save proof' },
                ],
              },
            },
            modelMessage,
          ],
          actions: [
            { name: 'refresh', componentId: 'refresh', kind: 'refresh' },
            { name: 'save', componentId: 'save', kind: 'kernel-record-update' },
          ],
        }),
        'generative-ui.refresh': refresh,
        'generative-ui.action': action,
      },
    } as unknown as CoreClient;
    render(
      <Providers client={client}>
        <GenerativePresentationView item={ITEM} />
      </Providers>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh proof' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(refresh.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws1',
      presentationId: ITEM.presentationId,
      version: 'v0.9',
      action: {
        name: 'refresh',
        surfaceId: 'surface',
        sourceComponentId: 'refresh',
        timestamp: expect.any(String),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save proof' }));
    expect(await screen.findByText('Retry this write')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save proof' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws1',
      presentationId: ITEM.presentationId,
      requestId: expect.any(String),
      version: 'v0.9',
      action: {
        name: 'save',
        surfaceId: 'surface',
        sourceComponentId: 'save',
        context: { expectedRecordRevision: 1, values: { note: 'Saved' } },
      },
    });
    expect(action.mock.calls[1][0].requestId).toBe(action.mock.calls[0][0].requestId);
    await waitFor(() => expect(screen.queryByText('Retry this write')).not.toBeInTheDocument());
  });

  it('falls back to plain content when the presentation cannot load', async () => {
    const client = {
      operations: {
        'generative-ui.get': vi.fn().mockRejectedValue(new Error('unavailable')),
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
