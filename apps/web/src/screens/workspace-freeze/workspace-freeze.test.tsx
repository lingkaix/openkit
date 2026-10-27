import type { WorkspaceFreezeRefusal } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { workspaceBlockerReferenceLabel } from './labels';
import { parseWorkspaceFreezeRefusal } from './parse';
import {
  inspectQuickActionHref,
  isInspectQuickAction,
  workspaceQuickActionLabel,
} from './quick-actions';
import { WorkspaceFreezeRefusalPanel } from './WorkspaceFreezeRefusalPanel';

const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');
const requestId = '0a37c5a6-6df4-4bcf-a714-09e42e4e8bd2';

const blockedRefusal: WorkspaceFreezeRefusal = {
  workspaceId,
  operation: 'archive' as const,
  retryable: false,
  blockers: [
    {
      kind: 'turn' as const,
      reason: 'active-work' as const,
      reference: { threadId, turnId },
      actions: [
        {
          operationId: 'turn.interrupt' as const,
          input: { workspaceId, threadId, turnId, requestId },
        },
      ],
    },
    {
      kind: 'unavailable' as const,
      reason: 'unavailable' as const,
      actions: [],
    },
  ],
};

const frozenRefusal: WorkspaceFreezeRefusal = {
  workspaceId,
  operation: 'capture',
  retryable: true,
  blockers: [
    {
      kind: 'snapshot',
      reason: 'frozen',
      reference: { backupId: allocateEntityId('wsbak') },
      actions: [],
    },
  ],
};

function renderPanel(refusal: WorkspaceFreezeRefusal, client: CoreClient, onRetry = vi.fn()) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <CoreClientProvider client={client}>
        <MemoryRouter>
          <WorkspaceFreezeRefusalPanel refusal={refusal} onRetry={onRetry} />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

describe('parseWorkspaceFreezeRefusal', () => {
  it('parses workspace_blocked and workspace_frozen details', () => {
    for (const code of ['workspace_blocked', 'workspace_frozen'] as const) {
      const error = new ApiCallError(409, 'private', { code, details: blockedRefusal });
      expect(parseWorkspaceFreezeRefusal(error)).toEqual(blockedRefusal);
    }
  });

  it('returns null for unrelated errors', () => {
    expect(
      parseWorkspaceFreezeRefusal(new ApiCallError(409, 'x', { code: 'conflict' }))
    ).toBeNull();
    expect(parseWorkspaceFreezeRefusal(new Error('x'))).toBeNull();
  });
});

describe('WorkspaceFreezeRefusalPanel', () => {
  it('renders blocked guidance and every safe blocker field', () => {
    const client = {
      operations: { 'turn.interrupt': vi.fn().mockResolvedValue({}) },
    } as unknown as CoreClient;
    renderPanel(blockedRefusal, client);

    expect(screen.getByLabelText('Workspace blocked')).toBeInTheDocument();
    expect(screen.getByText(/resolve the blockers below/i)).toBeInTheDocument();
    expect(screen.getByText('Turn')).toBeInTheDocument();
    expect(screen.getByText('Active work')).toBeInTheDocument();
    expect(
      screen.getByText(workspaceBlockerReferenceLabel(blockedRefusal.blockers[0]!)!)
    ).toBeInTheDocument();
    expect(screen.getByText('Unavailable obstruction')).toBeInTheDocument();
    expect(screen.queryByText(/private/i)).not.toBeInTheDocument();
  });

  it('renders frozen guidance and a retry action', async () => {
    const onRetry = vi.fn();
    renderPanel(frozenRefusal, { operations: {} } as unknown as CoreClient, onRetry);
    expect(screen.getByLabelText('Workspace temporarily frozen')).toBeInTheDocument();
    expect(screen.getByText(/backup is in progress/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry shortly' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('maps inspect quick actions to existing views and mutating actions to operations', async () => {
    const interrupt = vi.fn().mockResolvedValue({});
    const withdraw = vi.fn().mockResolvedValue({});
    const cleanupHref = inspectQuickActionHref({
      operationId: 'administration.cleanup-read',
      input: {},
    });
    expect(cleanupHref).toBe('/settings/server-operations');
    expect(isInspectQuickAction('worker.list')).toBe(true);

    const refusal: WorkspaceFreezeRefusal = {
      workspaceId,
      operation: 'delete',
      retryable: false,
      blockers: [
        {
          kind: 'pending-request' as const,
          reason: 'active-work' as const,
          reference: { threadId, pendingRequestId: 'prq_owner' },
          actions: [
            {
              operationId: 'pending-request.withdraw' as const,
              input: { workspaceId, threadId, pendingRequestId: 'prq_owner', requestId },
            },
            {
              operationId: 'administration.cleanup-read' as const,
              input: {},
            },
          ],
        },
        {
          kind: 'synchronization' as const,
          reason: 'pending-publication' as const,
          reference: { reviewId: 'rev_owner' },
          actions: [
            {
              operationId: 'sync.review-read' as const,
              input: { workspaceId, reviewId: 'rev_owner' },
            },
          ],
        },
        {
          kind: 'scheduler-admission' as const,
          reason: 'active-work' as const,
          reference: { queueEntryId: 'queue_owner' },
          actions: [
            {
              operationId: 'scheduler.cancel' as const,
              input: { workspaceId, queueEntryId: 'queue_owner' },
            },
          ],
        },
      ],
    };

    const client = {
      operations: {
        'pending-request.withdraw': withdraw,
        'scheduler.cancel': vi.fn().mockResolvedValue({}),
        'turn.interrupt': interrupt,
      },
    } as unknown as CoreClient;

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
      >
        <CoreClientProvider client={client}>
          <MemoryRouter>
            <WorkspaceFreezeRefusalPanel refusal={refusal} />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );

    expect(
      screen.getByRole('link', {
        name: workspaceQuickActionLabel(refusal.blockers[0]!.actions[1]!),
      })
    ).toHaveAttribute('href', '/settings/server-operations');
    expect(screen.getByRole('link', { name: 'Open workspace changes' })).toHaveAttribute(
      'href',
      '/workspace-changes'
    );

    await userEvent.click(screen.getByRole('button', { name: 'Withdraw pending request' }));
    await waitFor(() =>
      expect(withdraw).toHaveBeenCalledWith({
        workspaceId,
        threadId,
        pendingRequestId: 'prq_owner',
        requestId,
      })
    );
  });
});
