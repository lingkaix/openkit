import type { CoreClient } from '@openkit/core-client';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { NotebookHistoryPanel } from '../../workspace/NotebookHistoryPanel';
import type { ThreadItem } from '../data';
import { ItemView } from '../ItemView';

const owner = { kind: 'workspace' as const, workspaceId: allocateEntityId('ws') };
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');

function status(revision: string | null): ThreadItem {
  return ItemSchema.parse({
    id: allocateEntityId('it'),
    owner,
    threadId,
    turnId,
    status: 'completed',
    createdAt: '2026-11-08T02:00:00.000Z',
    completedAt: '2026-11-08T02:01:00.000Z',
    type: 'status',
    level: 'info',
    title: 'Knowledge published',
    summary: 'Published the notebook',
    ...(revision
      ? {
          knowledgeMaintenanceResult: {
            threadId,
            turnId,
            outcome: 'published',
            notebookRevision: revision,
            summary: 'Published pages',
          },
        }
      : {}),
  }) as ThreadItem;
}

function injection(): ThreadItem {
  return ItemSchema.parse({
    id: allocateEntityId('it'),
    owner,
    threadId,
    turnId,
    status: 'completed',
    createdAt: '2026-11-08T02:00:00.000Z',
    completedAt: '2026-11-08T02:01:00.000Z',
    type: 'knowledge-injection',
    summary: 'Used the notebook',
    knowledgeEntryIds: [],
    policySummary: null,
  }) as ThreadItem;
}

afterEach(() => {
  cleanup();
});

describe('knowledge revision links', () => {
  it('links a knowledge change to its published revision and nowhere else', () => {
    render(
      <MemoryRouter>
        <ItemView item={status('rev_published')} />
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: 'Published notebook revision' });
    expect(link).toHaveAttribute('href', '/knowledge?revision=rev_published');
    expect(link.getAttribute('href')).not.toContain(threadId);
    expect(link.getAttribute('href')).not.toContain(turnId);
  });

  it('renders no revision link when the item has no exact revision', () => {
    render(
      <MemoryRouter>
        <ItemView item={status(null)} />
        <ItemView item={injection()} />
      </MemoryRouter>
    );
    expect(
      screen.queryByRole('link', { name: 'Published notebook revision' })
    ).not.toBeInTheDocument();
  });

  it('shows only identities when revision metadata is unavailable', async () => {
    const history = vi.fn(async () => ({
      notebookRevision: 'rev_head',
      nextRevision: null,
      revisions: [
        {
          revision: 'rev_hidden',
          parentRevision: 'rev_parent',
          availability: 'unavailable' as const,
          summary: 'do-not-show-summary',
          producer: { kind: 'user', id: 'usr_hidden' },
          changedPaths: ['secret/page'],
        },
      ],
    }));
    const client = {
      core: { meta: async () => ({}) },
      operations: { 'knowledge.notebook.history': history },
    } as unknown as CoreClient;
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <CoreClientProvider client={client}>
          <MemoryRouter initialEntries={['/knowledge?revision=rev_hidden']}>
            <NotebookHistoryPanel workspaceId={owner.workspaceId} />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(screen.getByText(/rev_hidden/)).toBeInTheDocument());
    expect(screen.getByText(/rev_parent/)).toBeInTheDocument();
    expect(screen.queryByText(/do-not-show-summary/)).not.toBeInTheDocument();
    expect(screen.queryByText(/usr_hidden/)).not.toBeInTheDocument();
    expect(screen.queryByText(/secret\/page/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: owner.workspaceId, revision: 'rev_hidden' })
    );
  });
});
