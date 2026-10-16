import { operationHttpPath } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';
import { KnowledgeScreen } from './KnowledgeScreen';

const TIMESTAMP = '2026-10-16T00:00:00.000Z';
const WORKSPACE_A = 'ws_source_a';
const WORKSPACE_B = 'ws_source_b';
const CONTENT = 'The reading room opens at 09:00 on weekdays. Bring the blue access card.';
// SHA-256 of CONTENT: equal captured bytes must not select a Source identity.
const DIGEST = 'sha256:9426dd5546dcc43161aeef04bfa87967e8e6f41ece421019a0e7e19747fe8d96';
const SOURCE_A = {
  id: 'ks_00000000-0000-4000-8000-000000000001',
  workspaceId: WORKSPACE_A,
  kind: 'document' as const,
  title: 'First registered reading-room document',
  uri: null,
  contentDigest: DIGEST,
  originatingThreadId: null,
  originatingTurnId: null,
  originatingFileId: null,
  capturedAt: TIMESTAMP,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const SELECTED_SOURCE = {
  ...SOURCE_A,
  id: 'ks_00000000-0000-4000-8000-000000000002',
  title: 'Selected reading-room document',
};
const SOURCE_B = {
  ...SOURCE_A,
  id: 'ks_00000000-0000-4000-8000-000000000003',
  workspaceId: WORKSPACE_B,
  title: 'Other Workspace reading-room document',
};
const PAGE = {
  id: 'reading-room',
  kind: 'preference' as const,
  title: 'Reading room opening hours',
  content: CONTENT,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
type CreateInput = Parameters<
  ReturnType<typeof createCoreClient>['operations']['knowledge.create']
>[0];
const queryClients: QueryClient[] = [];

/** Composes the rendered form, hooks and real client; only HTTP is replaced. */
function renderKnowledge() {
  const creates: CreateInput[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    let body: unknown;
    if (path === '/api/meta') {
      body = { protocolVersion: '1', capabilities: [], eventFamilies: [] };
    } else {
      expect(init?.method).toBe('POST');
      const request = JSON.parse(String(init?.body));
      switch (path) {
        case operationHttpPath('workspace.list'):
          body = {
            items: [WORKSPACE_A, WORKSPACE_B].map((workspaceId) => ({
              workspace: {
                id: workspaceId,
                name: workspaceId === WORKSPACE_A ? 'Reading room team' : 'Other team',
                kind: 'general',
                status: 'active',
                counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
                createdAt: TIMESTAMP,
                updatedAt: TIMESTAMP,
              },
              membershipStatus: 'active',
              accessCause: 'membership',
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: 'user_reader',
              registryRevision: 1,
            })),
          };
          break;
        case operationHttpPath('knowledge.list'):
          body = {
            items: creates.some((command) => command.workspaceId === request.workspaceId)
              ? [PAGE]
              : [],
          };
          break;
        case operationHttpPath('knowledge.source.list'):
          body = {
            items: request.workspaceId === WORKSPACE_A ? [SOURCE_A, SELECTED_SOURCE] : [SOURCE_B],
          };
          break;
        case operationHttpPath('knowledge.indexes'):
          body = {
            linkGraph: {
              schemaVersion: 1,
              workspaceId: request.workspaceId,
              rebuiltAt: null,
              edges: [],
            },
            validation: {
              schemaVersion: 1,
              workspaceId: request.workspaceId,
              rebuiltAt: null,
              records: [],
            },
            sourceReferences: {
              schemaVersion: 1,
              workspaceId: request.workspaceId,
              rebuiltAt: null,
              references: [],
            },
          };
          break;
        case operationHttpPath('knowledge.create'):
          creates.push(request);
          body = PAGE;
          break;
        case operationHttpPath('knowledge.observation.list'):
        case operationHttpPath('knowledge.claim.list'):
        case operationHttpPath('knowledge.conflict.list'):
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
  return { creates, fetch };
}

/** Opens the ordinary entry form once authoritative reads permit a new entry. */
async function openAddForm(user: ReturnType<typeof userEvent.setup>) {
  const add = await screen.findByRole('button', { name: 'Add knowledge' });
  await waitFor(() => expect(add).toBeEnabled());
  await user.click(add);
  return screen.getByRole('textbox', { name: 'Title' });
}

/** Enters complete user-authored bytes through the visible draft controls. */
async function fillEntry(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('textbox', { name: 'Title' }));
  await user.paste(PAGE.title);
  await user.click(screen.getByRole('textbox', { name: 'Content' }));
  await user.paste(CONTENT);
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});

afterEach(() => {
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe('Add knowledge registered Source relationship', () => {
  it('sends only the exact selected Source id and captured digest when equal-digest Sources exist', async () => {
    const { creates } = renderKnowledge();
    const user = userEvent.setup();
    await openAddForm(user);
    await fillEntry(user);
    await user.click(screen.getByRole('button', { name: /Registered source/i }));
    await user.click(await screen.findByRole('option', { name: SELECTED_SOURCE.title }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toEqual({
      workspaceId: WORKSPACE_A,
      kind: 'preference',
      title: PAGE.title,
      content: CONTENT,
      sourceReferences: [`source:${SELECTED_SOURCE.id}@${DIGEST}`],
    });
    expect(await screen.findByText(PAGE.title)).toBeVisible();
  });

  it('does not infer a relationship from matching content when the user selects no Source', async () => {
    const { creates, fetch } = renderKnowledge();
    const user = userEvent.setup();
    await openAddForm(user);
    await fillEntry(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({
      workspaceId: WORKSPACE_A,
      title: PAGE.title,
      content: CONTENT,
    });
    expect(creates[0]?.sourceReferences ?? []).toEqual([]);
    const paths = fetch.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).not.toContain(operationHttpPath('knowledge.source.register'));
    expect(await screen.findByText(PAGE.title)).toBeVisible();
  });

  it('does not carry a selected Source into an entry created in another Workspace', async () => {
    const { creates } = renderKnowledge();
    const user = userEvent.setup();
    await openAddForm(user);
    await user.click(screen.getByRole('button', { name: /Registered source/i }));
    await user.click(await screen.findByRole('option', { name: SELECTED_SOURCE.title }));

    act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_B }));
    await openAddForm(user);
    const selector = screen.getByRole('button', { name: /Registered source/i });
    expect(selector).toHaveTextContent('No registered source');
    await user.click(selector);
    expect(await screen.findByRole('option', { name: SOURCE_B.title })).toBeVisible();
    expect(screen.queryByRole('option', { name: SELECTED_SOURCE.title })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: SOURCE_A.title })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'No registered source' }));
    await fillEntry(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ workspaceId: WORKSPACE_B, content: CONTENT });
    expect(creates[0]?.sourceReferences ?? []).toEqual([]);
  });
});
