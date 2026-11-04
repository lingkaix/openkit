import { operationHttpPath } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId, PROTOCOL_VERSION } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});

afterEach(() => {
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe('Knowledge package host', () => {
  it('starts with Maintain collapsed before it is pressed', async () => {
    renderKnowledgeScreen();

    const maintain = await screen.findByRole('button', { name: 'Maintain' });

    expect(maintain).toHaveAttribute('aria-expanded', 'false');
  });

  it('lists the page title and keeps the content digest out of the primary row', async () => {
    renderKnowledgeScreen();

    expect(await screen.findByText(PAGE.title)).toBeVisible();
    expect(screen.queryByText(/Content digest/)).not.toBeInTheDocument();
  });

  it('reveals the content digest when Details for the page is pressed', async () => {
    const user = userEvent.setup();
    renderKnowledgeScreen();

    expect(await screen.findByText(PAGE.title)).toBeVisible();
    expect(screen.queryByText(/Content digest/)).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: `Details for ${PAGE.title}` }));

    expect(screen.getByText(/Content digest/)).toBeVisible();
  });
});
