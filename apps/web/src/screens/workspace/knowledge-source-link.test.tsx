import { operationHttpPath } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';
import { workspaceKeys } from './data';
import { KnowledgeScreen } from './KnowledgeScreen';

const TIMESTAMP = '2026-10-16T00:00:00.000Z';
const WORKSPACE_A = allocateEntityId('ws');
const WORKSPACE_B = allocateEntityId('ws');
const OWNER_USER_ID = allocateEntityId('usr');
const CONTENT = 'The reading room opens at 09:00 on weekdays. Bring the blue access card.';
// SHA-256 of CONTENT: equal captured bytes must not select a Source identity.
const DIGEST = 'sha256:9426dd5546dcc43161aeef04bfa87967e8e6f41ece421019a0e7e19747fe8d96';
const SOURCE_A = {
  id: allocateEntityId('ks'),
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
  id: allocateEntityId('ks'),
  title: 'Selected reading-room document',
};
const SOURCE_B = {
  ...SOURCE_A,
  id: allocateEntityId('ks'),
  workspaceId: WORKSPACE_B,
  title: 'Other Workspace reading-room document',
};
const PAGE = {
  id: 'reading-room',
  contentDigest: `sha256:${'a'.repeat(64)}`,
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
function renderKnowledge({ failFirstCreate = false } = {}) {
  const creates: CreateInput[] = [];
  let sources = [SOURCE_A, SELECTED_SOURCE];
  let sourceRead: (() => Promise<Response>) | undefined;
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
              isOwner: true,
              membershipRevision: 1,
              ownerUserId: OWNER_USER_ID,
              registryRevision: 1,
            })),
          };
          break;
        case operationHttpPath('knowledge.list'):
          body = {
            notebookRevision: 'notebook-fixture-revision',
            items: creates.some((command) => command.workspaceId === request.workspaceId)
              ? [PAGE]
              : [],
          };
          break;
        case operationHttpPath('knowledge.source.list'):
          if (sourceRead) return sourceRead();
          body = {
            items: request.workspaceId === WORKSPACE_A ? sources : [SOURCE_B],
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
          if (failFirstCreate && creates.length === 1) throw new TypeError('Response lost.');
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
  return {
    creates,
    fetch,
    queryClient,
    setSources: (next: typeof sources) => {
      sources = next;
    },
    setSourceRead: (read: typeof sourceRead) => {
      sourceRead = read;
    },
  };
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
      baseRevision: 'notebook-fixture-revision',
      knowledgePageId: expect.any(String),
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

  it('does not offer a foreign Workspace Source returned in the current catalog', async () => {
    const fixture = renderKnowledge();
    const user = userEvent.setup();
    await openAddForm(user);
    fixture.setSources([SOURCE_A, SOURCE_B]);
    await act(async () => {
      await fixture.queryClient.invalidateQueries({
        queryKey: workspaceKeys.knowledgeSources(WORKSPACE_A),
      });
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Registered source/i })).toBeEnabled()
    );
    await user.click(screen.getByRole('button', { name: /Registered source/i }));

    expect(await screen.findByRole('option', { name: SOURCE_A.title })).toBeVisible();
    expect(screen.queryByRole('option', { name: SOURCE_B.title })).not.toBeInTheDocument();
  });

  it('blocks a new save while the selected Source catalog is being refreshed', async () => {
    const fixture = renderKnowledge();
    const user = userEvent.setup();
    await openAddForm(user);
    await fillEntry(user);
    await user.click(screen.getByRole('button', { name: /Registered source/i }));
    await user.click(await screen.findByRole('option', { name: SELECTED_SOURCE.title }));
    let finishRead!: (response: Response) => void;
    fixture.setSourceRead(
      () =>
        new Promise<Response>((resolve) => {
          finishRead = resolve;
        })
    );
    let refresh!: Promise<void>;
    act(() => {
      refresh = fixture.queryClient.invalidateQueries({
        queryKey: workspaceKeys.knowledgeSources(WORKSPACE_A),
      });
    });
    try {
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Registered source/i })).toBeDisabled()
      );
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(fixture.creates).toHaveLength(0);
    } finally {
      await act(async () => {
        finishRead(
          new Response(JSON.stringify({ items: [SOURCE_A, SELECTED_SOURCE] }), {
            headers: { 'content-type': 'application/json' },
          })
        );
        await refresh;
      });
    }
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  });

  it.each([
    'missing',
    'changed',
    'denied',
  ] as const)('blocks a selected Source after a %s catalog refresh', async (outcome) => {
    const fixture = renderKnowledge();
    const user = userEvent.setup();
    await openAddForm(user);
    await fillEntry(user);
    await user.click(screen.getByRole('button', { name: /Registered source/i }));
    await user.click(await screen.findByRole('option', { name: SELECTED_SOURCE.title }));
    if (outcome === 'denied') {
      fixture.setSourceRead(
        async () =>
          new Response(
            JSON.stringify({
              code: 'workspace_access_denied',
              message: 'Access denied.',
            }),
            { status: 403, headers: { 'content-type': 'application/json' } }
          )
      );
    } else {
      fixture.setSources(
        outcome === 'missing'
          ? [SOURCE_A]
          : [SOURCE_A, { ...SELECTED_SOURCE, contentDigest: `sha256:${'a'.repeat(64)}` }]
      );
    }
    await act(async () => {
      await fixture.queryClient.invalidateQueries({
        queryKey: workspaceKeys.knowledgeSources(WORKSPACE_A),
      });
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(
      screen.getByText('The selected source is unavailable. Select a current source before saving.')
    ).toBeVisible();
    expect(fixture.creates).toHaveLength(0);
    if (outcome !== 'denied') {
      await user.click(screen.getByRole('button', { name: /Registered source/i }));
      await user.click(await screen.findByRole('option', { name: 'No registered source' }));
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    }
  });

  it('retries the exact failed Source-bound command after draft and catalog changes', async () => {
    const fixture = renderKnowledge({ failFirstCreate: true });
    const user = userEvent.setup();
    await openAddForm(user);
    await fillEntry(user);
    await user.click(screen.getByRole('button', { name: /Registered source/i }));
    await user.click(await screen.findByRole('option', { name: SELECTED_SOURCE.title }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Couldn't save that entry.")).toBeVisible();
    await user.clear(screen.getByRole('textbox', { name: 'Title' }));
    await user.paste('Changed draft title');
    fixture.setSources([SOURCE_A]);
    await act(async () => {
      await fixture.queryClient.invalidateQueries({
        queryKey: workspaceKeys.knowledgeSources(WORKSPACE_A),
      });
    });
    const retry = within(screen.getByText("Couldn't save that entry.").parentElement!).getByRole(
      'button',
      { name: 'Try again' }
    );
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);

    await waitFor(() => expect(fixture.creates).toHaveLength(2));
    expect(fixture.creates[1]).toEqual(fixture.creates[0]);
    const commands = fixture.fetch.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === operationHttpPath('knowledge.create')
    );
    const requestIds = commands.map(([, init]) =>
      new Headers(init?.headers).get('x-openkit-request-id')
    );
    expect(requestIds[0]).toBeTruthy();
    expect(requestIds[1]).toBe(requestIds[0]);
  });
});
