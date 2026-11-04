import { operationHttpPath } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId, PROTOCOL_VERSION } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';
import { KnowledgeScreen } from './KnowledgeScreen';
import { knowledgeNotebookPageFixture } from './knowledge-test-fixtures';

const TIMESTAMP = '2026-10-16T00:00:00.000Z';
const WORKSPACE_ID = allocateEntityId('ws');
const KNOWLEDGE_BASE_ID = allocateEntityId('kb');
const OWNER_USER_ID = allocateEntityId('usr');
const PAGE = knowledgeNotebookPageFixture({
  id: 'reading-room',
  title: 'Reading room opening hours',
  body: 'The reading room opens at 09:00 on weekdays. Bring the blue access card.',
  workspaceId: WORKSPACE_ID,
  timestamp: TIMESTAMP,
  contentDigest: `sha256:${'a'.repeat(64)}`,
});
const queryClients: QueryClient[] = [];

/** Renders the Knowledge screen with only the HTTP responses replaced. */
function renderKnowledgeScreen() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    let body: unknown;
    if (path === '/api/meta') {
      body = { protocolVersion: PROTOCOL_VERSION, capabilities: [], eventFamilies: [] };
    } else {
      expect(init?.method).toBe('POST');
      switch (path) {
        case operationHttpPath('workspace.list'):
          body = {
            items: [
              {
                workspace: {
                  id: WORKSPACE_ID,
                  name: 'Reading room team',
                  kind: 'general',
                  status: 'active',
                  counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 1 },
                  createdAt: TIMESTAMP,
                  updatedAt: TIMESTAMP,
                },
                membershipStatus: 'active',
                accessCause: 'membership',
                isOwner: true,
                membershipRevision: 1,
                ownerUserId: OWNER_USER_ID,
                registryRevision: 1,
              },
            ],
          };
          break;
        case operationHttpPath('knowledge.notebook.list'):
          body = {
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            notebookRevision: 'notebook-fixture-revision',
            pages: [PAGE],
          };
          break;
        case operationHttpPath('knowledge.indexes'):
          body = {
            linkGraph: {
              schemaVersion: 1,
              workspaceId: WORKSPACE_ID,
              rebuiltAt: null,
              edges: [],
            },
            validation: {
              schemaVersion: 1,
              workspaceId: WORKSPACE_ID,
              rebuiltAt: null,
              records: [],
            },
            sourceReferences: {
              schemaVersion: 1,
              workspaceId: WORKSPACE_ID,
              rebuiltAt: null,
              references: [],
            },
          };
          break;
        case operationHttpPath('knowledge.source.list'):
        case operationHttpPath('attention.list'):
          body = { items: [] };
          break;
        default:
          throw new Error(`Unexpected HTTP request: ${path}`);
      }
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  const client = createCoreClient({ baseUrl: 'http://openkit.invalid', fetch });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClients.push(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={['/knowledge']}>
          <KnowledgeScreen />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { queryClient };
}

/** Returns the element or throws a readable test failure when it is absent. */
function requireElement<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});

afterEach(() => {
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe('Knowledge Maintain disclosure', () => {
  it('keeps Maintain collapsed until the person opens it', async () => {
    renderKnowledgeScreen();

    const maintain = await screen.findByRole('button', { name: 'Maintain' });

    expect(maintain).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Maintain' })).not.toBeInTheDocument();
  });

  it('hides Sources, Retrieval, Manager, and their actions before Maintain opens', async () => {
    renderKnowledgeScreen();

    await screen.findByRole('button', { name: 'Maintain' });

    expect(screen.queryByRole('region', { name: 'Sources' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Retrieval' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Manager' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suggest repairs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check health' })).not.toBeInTheDocument();
  });

  it('puts Sources, Retrieval, Manager, and their actions inside the open Maintain region', async () => {
    const user = userEvent.setup();
    renderKnowledgeScreen();

    const maintain = await screen.findByRole('button', { name: 'Maintain' });
    await user.click(maintain);

    expect(maintain).toHaveAttribute('aria-expanded', 'true');

    const maintainRegion = requireElement(
      screen.queryByRole('region', { name: 'Maintain' }),
      'Expected an open region named Maintain'
    );

    expect(within(maintainRegion).getByRole('region', { name: 'Sources' })).toBeVisible();
    expect(within(maintainRegion).getByRole('region', { name: 'Retrieval' })).toBeVisible();
    expect(within(maintainRegion).getByRole('region', { name: 'Manager' })).toBeVisible();
    expect(within(maintainRegion).getByRole('button', { name: 'Suggest repairs' })).toBeVisible();
    expect(within(maintainRegion).getByRole('button', { name: 'Check health' })).toBeVisible();
    // Indexes stay with Retrieval. This test requires no Indexes region and adds no Indexes control.
  });

  it('keeps Personal Memory out of the Knowledge screen, open or closed', async () => {
    const user = userEvent.setup();
    renderKnowledgeScreen();

    await screen.findByRole('button', { name: 'Maintain' });

    expect(screen.queryByRole('region', { name: 'Personal Memory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Personal Memory' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Maintain' }));

    expect(screen.queryByRole('region', { name: 'Personal Memory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Personal Memory' })).not.toBeInTheDocument();
  });
});

describe('Knowledge primary rows', () => {
  it('shows the page title and updated time in the primary row, with the digest in Details', async () => {
    renderKnowledgeScreen();

    const pages = await screen.findByRole('list', { name: 'Pages' });
    const row = requireElement(
      within(pages)
        .getAllByRole('listitem')
        .find((item) => within(item).queryByRole('button', { name: PAGE.title })),
      `Expected a Pages listitem for ${PAGE.title}`
    );

    expect(within(row).getByRole('button', { name: PAGE.title })).toBeVisible();

    const updatedTime = requireElement(
      row.querySelector('time'),
      'Expected an updated time element'
    );
    expect(updatedTime).toHaveAttribute('dateTime', TIMESTAMP);

    expect(row).not.toHaveTextContent(PAGE.contentDigest);

    await userEvent
      .setup()
      .click(within(row).getByRole('button', { name: `Details for ${PAGE.title}` }));

    expect(row).toHaveTextContent(PAGE.contentDigest);
  });
});
