import { type KnowledgeManagerAnswerResponse, operationHttpPath } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId, PROTOCOL_VERSION } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useWorkspaceStore } from '../workspace-store';
import { workspaceKeys } from './data';
import { KnowledgeScreen } from './KnowledgeScreen';
import { readKnowledgePageDisplay } from './knowledge-okf';
import {
  knowledgeNotebookPageFixture,
  knowledgePageContentDigest,
} from './knowledge-test-fixtures';

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

function register_KnowledgePackage_test_tsx_0() {
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
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
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

  describe('Knowledge package host', () => {
    beforeEach(() => {
      localStorage.clear();
      useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
    });
    afterEach(() => {
      for (const queryClient of queryClients.splice(0)) queryClient.clear();
    });

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
}
register_KnowledgePackage_test_tsx_0();

function register_knowledge_citations_test_tsx_1() {
  const TIMESTAMP = '2026-10-16T00:00:00.000Z';

  const WORKSPACE_ID = allocateEntityId('ws');

  const OTHER_WORKSPACE_ID = allocateEntityId('ws');

  const KNOWLEDGE_BASE_ID = allocateEntityId('kb');

  const OTHER_KNOWLEDGE_BASE_ID = allocateEntityId('kb');

  const OWNER_USER_ID = allocateEntityId('usr');

  const WORKSPACE_PAGE_SCOPE = `page/workspace/${WORKSPACE_ID}/${KNOWLEDGE_BASE_ID}`;

  const QUESTION = 'When does the reading room open?';

  const PAGE = knowledgeNotebookPageFixture({
    id: 'reading-room',
    title: 'Reading room opening hours',
    body: 'The reading room opens at 09:00 on weekdays. Bring the blue access card.',
    workspaceId: WORKSPACE_ID,
    timestamp: TIMESTAMP,
    contentDigest: `sha256:${'a'.repeat(64)}`,
  });

  const UNRELATED_PAGE = knowledgeNotebookPageFixture({
    id: 'unrelated-page',
    title: 'Unrelated current page title',
    body: 'Unrelated current page content must not become a citation.',
    workspaceId: WORKSPACE_ID,
    timestamp: TIMESTAMP,
    contentDigest: `sha256:${'b'.repeat(64)}`,
  });

  const CITATION = {
    reference: { scopeId: WORKSPACE_PAGE_SCOPE, objectId: PAGE.id },
    revision: 'reading-room-revision-fixture',
    contentDigest: PAGE.contentDigest,
    observedAt: TIMESTAMP,
    sourceCitations: [],
    kind: 'preference',
    title: PAGE.title,
    excerpt: 'The reading room opens at 09:00 on weekdays.',
  };

  const ANSWER: KnowledgeManagerAnswerResponse = {
    operationId: 'km_cited_answer',
    operation: 'answer',
    workspaceId: WORKSPACE_ID,
    caller: 'app-api',
    query: QUESTION,
    outcome: 'answered',
    answer: 'The reading room opens at 09:00.',
    citations: [CITATION],
    confidence: 0.9,
    uncertainty: null,
  };

  const queryClients: QueryClient[] = [];

  /** Renders the public panel and real client parser with only HTTP responses replaced. */
  function renderKnowledge(answer: KnowledgeManagerAnswerResponse) {
    let pageRead: (() => Promise<Response>) | undefined;
    let answerRead: (() => Promise<Response>) | undefined;
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
              items: [WORKSPACE_ID, OTHER_WORKSPACE_ID].map((workspaceId) => ({
                workspace: {
                  id: workspaceId,
                  name: 'Reading room team',
                  kind: 'general',
                  status: 'active',
                  counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 2 },
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
          case operationHttpPath('knowledge.notebook.list'):
            if (pageRead) return pageRead();
            body = {
              knowledgeBaseId: KNOWLEDGE_BASE_ID,
              notebookRevision: 'notebook-fixture-revision',
              pages: [UNRELATED_PAGE, PAGE],
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
          case operationHttpPath('knowledge.answer'):
            expect(JSON.parse(String(init?.body))).toEqual({
              workspaceId: WORKSPACE_ID,
              query: QUESTION,
            });
            if (answerRead) return answerRead();
            body = answer;
            break;
          case operationHttpPath('knowledge.source.list'):
          case operationHttpPath('attention.list'):
            body = { items: [] };
            break;
          default:
            throw new Error(`Unexpected HTTP request: ${path}`);
        }
      }
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
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
      queryClient,
      setPageRead: (read: typeof pageRead) => {
        pageRead = read;
      },
      setAnswerRead: (read: typeof answerRead) => {
        answerRead = read;
      },
    };
  }

  /**
   * Opens Maintain, which owns the Manager panel and starts collapsed (A-Q2, A3).
   * Testing Library skips the hidden section, so the panel is unreachable before this step.
   */
  async function openMaintain(user: ReturnType<typeof userEvent.setup>) {
    const toggle = await screen.findByRole('button', { name: 'Maintain' });
    if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
  }

  /** Submits the question through the visible Manager controls. */
  async function askManager() {
    const user = userEvent.setup();
    await openMaintain(user);
    const manager = await screen.findByRole('region', { name: 'Manager' });
    const question = within(manager).getByRole('textbox', { name: 'Question' });
    await waitFor(() => expect(question).toBeEnabled());
    await user.click(question);
    await user.paste(QUESTION);
    await user.click(within(manager).getByRole('button', { name: 'Answer' }));
    expect(await within(manager).findByText(ANSWER.answer)).toBeVisible();
    return manager;
  }

  describe('Knowledge Manager answer citations', () => {
    beforeEach(() => {
      localStorage.clear();
      useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
    });
    afterEach(() => {
      for (const queryClient of queryClients.splice(0)) queryClient.clear();
    });

    it('shows a returned citation and links to the exact owned page full content', async () => {
      renderKnowledge(ANSWER);
      const manager = await askManager();

      expect(within(manager).getByText(CITATION.title)).toBeVisible();
      const link = within(manager).getByRole('link', { name: new RegExp(CITATION.title) });
      expect(link).toHaveAttribute('href', `#knowledge-content-${WORKSPACE_ID}-reading-room`);
      const target = document.getElementById(
        decodeURIComponent(link.getAttribute('href')?.slice(1) ?? '')
      );
      expect(target).not.toBeNull();
      expect(target).toHaveTextContent(PAGE.title);
      expect(target).toHaveTextContent(PAGE.body);
      expect(target).not.toHaveTextContent(UNRELATED_PAGE.title);
      expect(manager).not.toContainElement(target);
      expect(within(manager).getAllByRole('link')).toHaveLength(1);
      expect(within(manager).queryByText(UNRELATED_PAGE.title)).not.toBeInTheDocument();
      expect(within(manager).queryByText(UNRELATED_PAGE.body)).not.toBeInTheDocument();
    });

    it.each([
      {
        name: 'another Workspace with the same page id',
        scopeId: `page/workspace/${OTHER_WORKSPACE_ID}/${OTHER_KNOWLEDGE_BASE_ID}`,
        objectId: PAGE.id,
      },
      {
        name: 'a missing page in this Workspace',
        scopeId: CITATION.reference.scopeId,
        objectId: 'missing-page',
      },
    ])('does not alias $name to an available local page', async ({ scopeId, objectId }) => {
      renderKnowledge({
        ...ANSWER,
        citations: [
          {
            ...CITATION,
            reference: { scopeId, objectId },
            title: 'Returned citation title',
            excerpt: 'Returned citation excerpt.',
          },
        ],
      });
      const manager = await askManager();

      expect(within(manager).queryByRole('link')).not.toBeInTheDocument();
      expect(within(manager).queryByText(PAGE.title)).not.toBeInTheDocument();
      expect(within(manager).queryByText(PAGE.body)).not.toBeInTheDocument();
      expect(within(manager).queryByText(UNRELATED_PAGE.title)).not.toBeInTheDocument();
      expect(within(manager).queryByText(UNRELATED_PAGE.body)).not.toBeInTheDocument();
    });

    it('does not invent citations from available pages when the answer returns none', async () => {
      renderKnowledge({ ...ANSWER, citations: [] });
      const manager = await askManager();

      expect(within(manager).queryByRole('link')).not.toBeInTheDocument();
      expect(within(manager).queryByText(PAGE.title)).not.toBeInTheDocument();
      expect(within(manager).queryByText(PAGE.body)).not.toBeInTheDocument();
      expect(within(manager).queryByText(UNRELATED_PAGE.title)).not.toBeInTheDocument();
    });

    it('withholds the current-content link when a failed refetch retains a cached page', async () => {
      const fixture = renderKnowledge(ANSWER);
      const manager = await askManager();
      expect(within(manager).getByRole('link')).toBeVisible();
      fixture.setPageRead(
        async () =>
          new Response(
            JSON.stringify({ code: 'workspace_access_denied', message: 'Access denied.' }),
            { status: 403, headers: { 'content-type': 'application/json' } }
          )
      );
      await act(async () => {
        await fixture.queryClient.invalidateQueries({
          queryKey: workspaceKeys.knowledge(WORKSPACE_ID),
        });
      });

      expect(
        fixture.queryClient.getQueryData<{ pages: (typeof PAGE)[] }>(
          workspaceKeys.knowledge(WORKSPACE_ID)
        )?.pages
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: PAGE.id,
            path: PAGE.path,
            contentDigest: PAGE.contentDigest,
          }),
        ])
      );
      await waitFor(() => expect(within(manager).queryByRole('link')).not.toBeInTheDocument());
      expect(within(manager).getByText('Current content unavailable.')).toBeVisible();
    });

    it('hides a completed answer and its citation after switching Workspaces while it is pending', async () => {
      const fixture = renderKnowledge(ANSWER);
      let finishAnswer!: (response: Response) => void;
      fixture.setAnswerRead(
        () =>
          new Promise<Response>((resolve) => {
            finishAnswer = resolve;
          })
      );
      const user = userEvent.setup();
      await openMaintain(user);
      const manager = await screen.findByRole('region', { name: 'Manager' });
      const question = within(manager).getByRole('textbox', { name: 'Question' });
      await waitFor(() => expect(question).toBeEnabled());
      await user.click(question);
      await user.paste(QUESTION);
      await user.click(within(manager).getByRole('button', { name: 'Answer' }));
      await waitFor(() => expect(finishAnswer).toBeTypeOf('function'));
      act(() => useWorkspaceStore.setState({ currentWorkspaceId: OTHER_WORKSPACE_ID }));
      await act(async () => {
        finishAnswer(
          new Response(JSON.stringify(ANSWER), { headers: { 'content-type': 'application/json' } })
        );
      });

      await waitFor(() =>
        expect(
          fixture.queryClient
            .getMutationCache()
            .getAll()
            .some((mutation) => mutation.state.status === 'success')
        ).toBe(true)
      );
      await waitFor(() =>
        expect(within(manager).getByRole('textbox', { name: 'Question' })).toHaveValue('')
      );
      expect(within(manager).queryByText(ANSWER.answer)).not.toBeInTheDocument();
      expect(within(manager).queryByText(CITATION.title)).not.toBeInTheDocument();
      expect(within(manager).queryByRole('link')).not.toBeInTheDocument();
      act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_ID }));
      expect(await within(manager).findByText(ANSWER.answer)).toBeVisible();
    });
  });
}
register_knowledge_citations_test_tsx_1();

function register_knowledge_source_link_test_tsx_2() {
  const TIMESTAMP = '2026-10-16T00:00:00.000Z';

  const WORKSPACE_A = allocateEntityId('ws');

  const WORKSPACE_B = allocateEntityId('ws');

  const KNOWLEDGE_BASE_ID = allocateEntityId('kb');

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

  const PAGE = knowledgeNotebookPageFixture({
    id: 'reading-room',
    title: 'Reading room opening hours',
    body: CONTENT,
    workspaceId: WORKSPACE_A,
    timestamp: TIMESTAMP,
    contentDigest: `sha256:${'a'.repeat(64)}`,
  });

  type CreateInput = Parameters<
    ReturnType<typeof createCoreClient>['operations']['knowledge.notebook.create']
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
        body = { protocolVersion: PROTOCOL_VERSION, capabilities: [], eventFamilies: [] };
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
          case operationHttpPath('knowledge.notebook.list'):
            body = {
              knowledgeBaseId: KNOWLEDGE_BASE_ID,
              notebookRevision: 'notebook-fixture-revision',
              pages: creates
                .filter((command) => command.workspaceId === request.workspaceId)
                .map((command) => ({
                  id: command.path.replace(/\.md$/, ''),
                  path: command.path,
                  content: command.content,
                  contentDigest: knowledgePageContentDigest(command.content),
                })),
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
          case operationHttpPath('knowledge.notebook.create'): {
            const requestId = new Headers(init?.headers).get('x-openkit-request-id');
            creates.push({ ...request, requestId });
            if (failFirstCreate && creates.length === 1) throw new TypeError('Response lost.');
            body = {
              outcome: 'published',
              ownerScope: { kind: 'workspace', workspaceId: request.workspaceId },
              baseRevision: request.baseRevision,
              notebookRevision: 'notebook-fixture-revision-next',
              changedPageIds: [request.path.replace(/\.md$/, '')],
              receiptRef: {
                operation: 'knowledge.notebook.create',
                requestId,
                ownerScope: { kind: 'workspace', workspaceId: request.workspaceId },
              },
            };
            break;
          }
          case operationHttpPath('attention.list'):
            body = { items: [] };
            break;
          default:
            throw new Error(`Unexpected HTTP request: ${path}`);
        }
      }
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
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

  describe('Add knowledge registered Source relationship', () => {
    beforeEach(() => {
      localStorage.clear();
      useWorkspaceStore.setState({
        currentWorkspaceId: WORKSPACE_A,
        selectionUserKey: 'test-user',
      });
    });
    afterEach(() => {
      for (const queryClient of queryClients.splice(0)) queryClient.clear();
    });

    it('sends only the exact selected Source id and captured digest when equal-digest Sources exist', async () => {
      const { creates } = renderKnowledge();
      const user = userEvent.setup();
      await openAddForm(user);
      await fillEntry(user);
      await user.click(screen.getByRole('button', { name: /Registered source/i }));
      await user.click(await screen.findByRole('option', { name: SELECTED_SOURCE.title }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(creates).toHaveLength(1));
      expect(creates[0]).toMatchObject({
        workspaceId: WORKSPACE_A,
        baseRevision: 'notebook-fixture-revision',
        path: expect.stringMatching(/^notes\/.+\.md$/),
        summary: expect.stringMatching(/^Create notes\/.+\.md$/),
      });
      expect(creates[0]?.content).toContain(`title: ${PAGE.title}`);
      expect(creates[0]?.content).toContain(CONTENT);
      expect(creates[0]?.content).toContain(`source:${SELECTED_SOURCE.id}@${DIGEST}`);
      const createdTitle = readKnowledgePageDisplay(creates[0]!.path, creates[0]!.content).title;
      await waitFor(() => expect(screen.queryByText('New notebook page')).not.toBeInTheDocument());
      expect(await screen.findByText(createdTitle)).toBeVisible();
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
        path: expect.stringMatching(/^notes\/.+\.md$/),
      });
      expect(creates[0]?.content).toContain(`title: ${PAGE.title}`);
      expect(creates[0]?.content).toContain(CONTENT);
      expect(creates[0]?.content).toContain('source_refs: []');
      const paths = fetch.mock.calls.map(([input]) => new URL(String(input)).pathname);
      expect(paths).not.toContain(operationHttpPath('knowledge.source.register'));
      await waitFor(() => expect(screen.queryByText('New notebook page')).not.toBeInTheDocument());
      expect(
        await screen.findByText(
          readKnowledgePageDisplay(creates[0]!.path, creates[0]!.content).title
        )
      ).toBeVisible();
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
      expect(creates[0]).toMatchObject({
        workspaceId: WORKSPACE_B,
        path: expect.stringMatching(/^notes\/.+\.md$/),
      });
      expect(creates[0]?.content).toContain(CONTENT);
      expect(creates[0]?.content).toContain('source_refs: []');
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
        screen.getByText(
          'The selected source is unavailable. Select a current source before saving.'
        )
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
        ([input]) =>
          new URL(String(input)).pathname === operationHttpPath('knowledge.notebook.create')
      );
      const requestIds = commands.map(([, init]) =>
        new Headers(init?.headers).get('x-openkit-request-id')
      );
      expect(requestIds[0]).toBeTruthy();
      expect(requestIds[1]).toBe(requestIds[0]);
    });
  });
}
register_knowledge_source_link_test_tsx_2();

function register_notebook_history_test_tsx_3() {
  const WORKSPACE = 'ws_00000000-0000-7000-8000-000000000001';

  const OTHER = 'ws_00000000-0000-7000-8000-000000000003';

  const KNOWLEDGE_BASE_ID = 'kb_0190f4c8-0000-7000-8000-000000000001';

  const USER = 'usr_00000000-0000-7000-8000-000000000002';

  const BASE = 'a'.repeat(40);

  const FROM = 'b'.repeat(40);

  const PUBLISHED = 'c'.repeat(40);

  const timestamp = '2026-10-16T00:00:00.000Z';

  const clients: QueryClient[] = [];

  /** Real hooks and public Core client replace only HTTP, including one unknown restore result. */
  function renderNotebook({
    deferDiff = false,
    truncatedDiff = false,
    unknownUpdate = false,
    deniedUpdate = false,
    conflictUpdate = false,
  } = {}) {
    const updates: Array<Record<string, unknown>> = [];
    const restores: Array<Record<string, unknown>> = [];
    const diffs: Array<Record<string, unknown>> = [];
    let currentRevision = BASE;
    let historyDenied = false;
    let resolveOldDiff: (() => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/meta')
        return Response.json({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: [],
          eventFamilies: [],
        });
      const body = JSON.parse(String(init?.body));
      switch (path) {
        case operationHttpPath('workspace.list'):
          return Response.json({
            items: [WORKSPACE, OTHER].map((workspaceId) => ({
              workspace: {
                id: workspaceId,
                name: 'Notebook team',
                kind: 'general',
                status: 'active',
                counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              membershipStatus: 'active',
              accessCause: 'membership',
              isOwner: true,
              membershipRevision: 1,
              ownerUserId: USER,
              registryRevision: 1,
            })),
          });
        case operationHttpPath('knowledge.notebook.list'):
          return Response.json({
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            notebookRevision: currentRevision,
            pages: [],
          });
        case operationHttpPath('knowledge.indexes'):
          return Response.json({
            linkGraph: {
              schemaVersion: 1,
              workspaceId: body.workspaceId,
              rebuiltAt: null,
              edges: [],
            },
            validation: {
              schemaVersion: 1,
              workspaceId: body.workspaceId,
              rebuiltAt: null,
              records: [],
            },
            sourceReferences: {
              schemaVersion: 1,
              workspaceId: body.workspaceId,
              rebuiltAt: null,
              references: [],
            },
          });
        case operationHttpPath('knowledge.source.list'):
        case operationHttpPath('attention.list'):
          return Response.json({ items: [] });
        case operationHttpPath('knowledge.notebook.history'):
          if (historyDenied)
            return Response.json({
              notebookRevision: currentRevision,
              nextRevision: null,
              revisions: [currentRevision, FROM].map((revision) => ({
                revision,
                parentRevision: null,
                availability: 'unavailable',
              })),
            });
          return Response.json({
            notebookRevision: currentRevision,
            nextRevision: null,
            revisions: [
              {
                revision: currentRevision,
                parentRevision: FROM,
                availability: 'available',
                summary: body.workspaceId === OTHER ? 'Other Workspace edit' : 'Current team edit',
                producer: { kind: 'user', id: USER },
                changedPaths: ['notes/one.md', 'notes/obsolete.md'],
              },
              {
                revision: FROM,
                parentRevision: null,
                availability: 'available',
                summary: 'Earlier human edit',
                producer: { kind: 'user', id: USER },
                changedPaths: ['notes/one.md'],
              },
              { revision: 'd'.repeat(40), parentRevision: null, availability: 'unavailable' },
            ],
          });
        case operationHttpPath('knowledge.notebook.diff'):
          diffs.push(body);
          if (historyDenied)
            return Response.json(
              { code: 'workspace_access_denied', message: 'Knowledge page is unavailable.' },
              { status: 403 }
            );
          if (deferDiff && body.workspaceId === WORKSPACE)
            return new Promise<Response>((resolve) => {
              resolveOldDiff = () =>
                resolve(
                  Response.json({
                    baseRevision: body.baseRevision,
                    fromRevision: body.fromRevision,
                    forRestore: Boolean(body.forRestore),
                    truncated: truncatedDiff && !body.forRestore,
                    changes: [
                      {
                        path: 'notes/one.md',
                        before: 'Private old Workspace text.',
                        after: 'Earlier old Workspace text.',
                      },
                    ],
                  })
                );
            });
          return Response.json({
            baseRevision: body.baseRevision,
            fromRevision: body.fromRevision,
            forRestore: Boolean(body.forRestore),
            truncated: truncatedDiff && !body.forRestore,
            changes: [
              {
                path: 'notes/one.md',
                before: 'Current exact text.',
                after: body.forRestore
                  ? 'review_state: user-authored\nEarlier exact text.'
                  : 'review_state: accepted\nEarlier exact text.',
              },
              { path: 'notes/obsolete.md', before: 'Obsolete exact text.', after: null },
            ].filter((change) => !body.pageIds || body.pageIds.includes(change.path.slice(0, -3))),
          });
        case operationHttpPath('knowledge.notebook.update'): {
          const requestId = new Headers(init?.headers).get('x-openkit-request-id');
          updates.push({ ...body, requestId });
          if (deniedUpdate) {
            historyDenied = true;
            return Response.json(
              {
                protocolVersion: PROTOCOL_VERSION,
                code: 'workspace_access_denied',
                message: 'Source access denied.',
              },
              { status: 403 }
            );
          }
          if (conflictUpdate && updates.length === 1) {
            currentRevision = 'e'.repeat(40);
            return Response.json(
              { protocolVersion: PROTOCOL_VERSION, code: 'conflict', message: 'Notebook changed.' },
              { status: 409 }
            );
          }
          if (unknownUpdate && updates.length === 1) throw new TypeError('Response lost.');
          currentRevision = PUBLISHED;
          return Response.json({
            outcome: 'published',
            ownerScope: { kind: 'workspace', workspaceId: body.workspaceId },
            baseRevision: body.baseRevision,
            notebookRevision: PUBLISHED,
            changedPageIds: ['notes/one'],
            receiptRef: {
              operation: 'knowledge.notebook.update',
              requestId,
              ownerScope: { kind: 'workspace', workspaceId: body.workspaceId },
            },
          });
        }
        case operationHttpPath('knowledge.notebook.restore'): {
          const requestId = new Headers(init?.headers).get('x-openkit-request-id');
          restores.push({ ...body, requestId });
          if (restores.length === 1) throw new TypeError('Response lost.');
          currentRevision = PUBLISHED;
          return Response.json({
            outcome: 'published',
            ownerScope: { kind: 'workspace', workspaceId: WORKSPACE },
            baseRevision: BASE,
            notebookRevision: PUBLISHED,
            changedPageIds: ['notes/one', 'notes/obsolete'],
            receiptRef: {
              operation: 'knowledge.notebook.restore',
              requestId,
              ownerScope: { kind: 'workspace', workspaceId: WORKSPACE },
            },
          });
        }
        default:
          throw new Error(`Unexpected HTTP request: ${path}`);
      }
    });
    const client = createCoreClient({ baseUrl: 'http://openkit.invalid', fetch });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    clients.push(queryClient);
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
      restores,
      updates,
      diffs,
      queryClient,
      denyHistory: () => {
        historyDenied = true;
      },
      hasDeferredDiff: () => Boolean(resolveOldDiff),
      resolveOldDiff: () => resolveOldDiff?.(),
    };
  }

  describe('Notebook history and restore', () => {
    beforeEach(() => {
      localStorage.clear();
      useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
    });
    afterEach(() => {
      for (const client of clients.splice(0)) client.clear();
    });

    it('labels a truncated display and requests a complete preview only for the selected pages', async () => {
      const user = userEvent.setup();
      const f = renderNotebook({ truncatedDiff: true });
      await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
      await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
      expect(await screen.findByText(/This diff is truncated/)).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Edit current notes/one.md' })
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Review restore' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: /notes\/obsolete.md/ }));
      await user.click(screen.getByRole('button', { name: 'Prepare restore' }));
      await screen.findByRole('region', { name: 'Restored notes/one.md' });
      expect(f.diffs.at(-1)).toMatchObject({ forRestore: true, pageIds: ['notes/one'] });
      expect(screen.queryByText(/This diff is truncated/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('region', { name: 'Restored notes/obsolete.md' })
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Review restore' })).toBeEnabled();
      expect(f.restores).toHaveLength(0);
    });

    it('withholds a cached diff when refreshed history and current page access become unavailable', async () => {
      const user = userEvent.setup();
      const f = renderNotebook();
      await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
      await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
      await screen.findByRole('region', { name: 'Historical notes/one.md' });
      await user.click(screen.getByRole('button', { name: 'Edit current notes/one.md' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Page text/Markdown' }), {
        target: { value: 'REVOKED-DRAFT-MARKER' },
      });
      f.denyHistory();
      await user.click(screen.getByRole('button', { name: 'Refresh history' }));
      await waitFor(() => expect(screen.getAllByText('Unavailable revision')).toHaveLength(2));
      expect(
        screen.queryByRole('region', { name: 'Historical notes/one.md' })
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Current exact text.')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Page text/Markdown' })).not.toBeInTheDocument();
      expect(screen.queryByText('REVOKED-DRAFT-MARKER')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Prepare restore' })).not.toBeInTheDocument();
      await waitFor(() => expect(f.diffs).toHaveLength(2));
      expect(f.restores).toHaveLength(0);
    });

    it('shows exact normalized changes and removal before confirmation, then retries the identical command after an unknown result', async () => {
      const user = userEvent.setup();
      const f = renderNotebook();
      await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
      await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
      await screen.findByRole('region', { name: 'Historical notes/one.md' });
      expect(screen.getByRole('region', { name: 'Historical notes/one.md' })).toHaveTextContent(
        'review_state: accepted'
      );
      await user.click(screen.getByRole('button', { name: 'Prepare restore' }));
      await screen.findByRole('region', { name: 'Restored notes/one.md' });
      expect(screen.getByRole('region', { name: 'Current notes/one.md' })).toHaveTextContent(
        'Current exact text.'
      );
      expect(screen.getByRole('region', { name: 'Restored notes/one.md' })).toHaveTextContent(
        'review_state: user-authored'
      );
      expect(screen.getByText('Unavailable revision')).toBeVisible();
      expect(f.restores).toHaveLength(0);
      expect(f.diffs.find((diff) => diff.forRestore === true)).toMatchObject({
        workspaceId: WORKSPACE,
        baseRevision: BASE,
        fromRevision: FROM,
        forRestore: true,
      });
      await user.click(screen.getByRole('button', { name: 'Review restore' }));
      const dialog = screen.getByRole('dialog', { name: 'Restore Notebook pages' });
      expect(within(dialog).getByText(/notes\/obsolete.md/)).toBeVisible();
      expect(within(dialog).getByText(/remove/i)).toBeVisible();
      await user.click(within(dialog).getByRole('button', { name: 'Confirm restore' }));
      await screen.findByText(
        'Restore result is unknown. Retry the same request or inspect history.'
      );
      expect(f.restores).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: 'Retry restore' }));
      await waitFor(() => expect(f.restores).toHaveLength(2));
      expect(f.restores[1]).toEqual(f.restores[0]);
      expect(f.restores[0]).toMatchObject({
        workspaceId: WORKSPACE,
        baseRevision: BASE,
        fromRevision: FROM,
        pageIds: ['notes/one', 'notes/obsolete'],
        confirmRemoval: true,
      });
      expect(f.restores[0]?.requestId).toEqual(expect.any(String));
      await screen.findByText('Selected pages were restored in a new revision.');
    });

    it('clears the selected revision on a Workspace switch and never renders a late old-scope diff', async () => {
      const user = userEvent.setup();
      const f = renderNotebook({ deferDiff: true });
      await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
      await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
      await waitFor(() => expect(f.hasDeferredDiff()).toBe(true));
      act(() => useWorkspaceStore.setState({ currentWorkspaceId: OTHER }));
      await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
      await screen.findByRole('radio', { name: 'Other Workspace edit' });
      await act(async () => f.resolveOldDiff());
      expect(screen.queryByText('Private old Workspace text.')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Review restore' })).not.toBeInTheDocument();
      expect(f.restores).toHaveLength(0);
    });
  });

  describe('Notebook current page editing', () => {
    beforeEach(() => {
      localStorage.clear();
      useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
    });
    afterEach(() => {
      for (const client of clients.splice(0)) client.clear();
    });

    it('publishes exact current page bytes and a fixed base through the composed client, then refreshes dependent views', async () => {
      const user = userEvent.setup();
      const f = renderNotebook({ conflictUpdate: true });
      const invalidate = vi.spyOn(f.queryClient, 'invalidateQueries');
      await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
      await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
      await user.click(await screen.findByRole('button', { name: 'Edit current notes/one.md' }));
      const text = screen.getByRole('textbox', { name: 'Page text/Markdown' });
      expect(text).toHaveValue('Current exact text.');
      const edited = '---\ncustom: {preserved: true}\n---\nExact edited page.\n';
      fireEvent.change(text, { target: { value: edited } });
      await user.type(screen.getByRole('textbox', { name: 'Edit summary' }), 'Correct the page');
      expect(screen.getByRole('region', { name: 'Current page text' })).toHaveTextContent(
        'Current exact text.'
      );
      expect(screen.getByRole('region', { name: 'Edited page text' }).textContent).toBe(edited);
      await user.click(screen.getByRole('button', { name: 'Apply page edit' }));
      await screen.findByText(
        'The Notebook changed. This edit was refused. Inspect current history and start a new edit.'
      );
      expect(screen.getByRole('textbox', { name: 'Page text/Markdown' })).toHaveValue(edited);
      expect(screen.getByRole('textbox', { name: 'Page text/Markdown' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Apply page edit' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Retry saved page edit' })
      ).not.toBeInTheDocument();
      expect(f.updates).toEqual([
        {
          workspaceId: WORKSPACE,
          baseRevision: BASE,
          changes: [{ path: 'notes/one.md', content: edited }],
          summary: 'Correct the page',
          requestId: expect.any(String),
        },
      ]);
      await user.click(
        screen.getByRole('button', { name: 'Close edit and inspect current history' })
      );
      await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
      await user.click(await screen.findByRole('button', { name: 'Edit current notes/one.md' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Page text/Markdown' }), {
        target: { value: edited },
      });
      await user.type(screen.getByRole('textbox', { name: 'Edit summary' }), 'Correct the page');
      await user.click(screen.getByRole('button', { name: 'Apply page edit' }));
      await screen.findByText('Page was published in a new revision.');
      expect(f.updates).toHaveLength(2);
      expect(f.updates[1]).toMatchObject({
        workspaceId: WORKSPACE,
        baseRevision: 'e'.repeat(40),
        changes: [{ path: 'notes/one.md', content: edited }],
        summary: 'Correct the page',
      });
      expect(f.updates[1]?.requestId).not.toBe(f.updates[0]?.requestId);
      for (const key of [
        ['knowledge', WORKSPACE],
        ['knowledge-indexes', WORKSPACE],
        ['attention', WORKSPACE],
      ])
        expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
      expect(screen.queryByRole('textbox', { name: 'Page text/Markdown' })).not.toBeInTheDocument();
    });

    it('refuses oversized edits without clipping and retries an unknown result with only the saved identical command', async () => {
      const user = userEvent.setup();
      const f = renderNotebook({ unknownUpdate: true });
      await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
      await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
      await user.click(await screen.findByRole('button', { name: 'Edit current notes/one.md' }));
      const text = screen.getByRole('textbox', { name: 'Page text/Markdown' });
      const summary = screen.getByRole('textbox', { name: 'Edit summary' });
      const tooLarge = 'x'.repeat(2 * 1024 * 1024 + 1);
      fireEvent.change(text, { target: { value: tooLarge } });
      expect(text).toHaveValue(tooLarge);
      expect(screen.getByRole('button', { name: 'Apply page edit' })).toBeDisabled();
      fireEvent.change(text, { target: { value: 'Saved exact draft.' } });
      fireEvent.change(summary, { target: { value: 'é'.repeat(2049) } });
      expect(screen.getByRole('button', { name: 'Apply page edit' })).toBeDisabled();
      fireEvent.change(summary, { target: { value: 'Fixed summary' } });
      await user.click(screen.getByRole('button', { name: 'Apply page edit' }));
      await screen.findByText(/Page edit result is unknown.*connection or response failure/);
      expect(text).toBeDisabled();
      expect(summary).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Retry saved page edit' }));
      await screen.findByText('Page was published in a new revision.');
      expect(f.updates).toHaveLength(2);
      expect(f.updates[1]).toEqual(f.updates[0]);
      expect(f.updates[0]).toMatchObject({
        baseRevision: BASE,
        changes: [{ path: 'notes/one.md', content: 'Saved exact draft.' }],
        summary: 'Fixed summary',
        requestId: expect.any(String),
      });
    });

    it('hides draft and preview bytes on direct denial, refreshed denial and Workspace changes', async () => {
      const user = userEvent.setup();
      const f = renderNotebook({ deniedUpdate: true });
      await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
      await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
      await user.click(await screen.findByRole('button', { name: 'Edit current notes/one.md' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Page text/Markdown' }), {
        target: { value: 'PRIVATE-DRAFT-MARKER' },
      });
      act(() => useWorkspaceStore.setState({ currentWorkspaceId: OTHER }));
      await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
      expect(screen.queryByRole('textbox', { name: 'Page text/Markdown' })).not.toBeInTheDocument();
      expect(screen.queryByText('PRIVATE-DRAFT-MARKER')).not.toBeInTheDocument();
      await user.click(await screen.findByRole('radio', { name: 'Earlier human edit' }));
      await user.click(await screen.findByRole('button', { name: 'Edit current notes/one.md' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Page text/Markdown' }), {
        target: { value: 'DENIED-DRAFT-MARKER' },
      });
      await user.type(screen.getByRole('textbox', { name: 'Edit summary' }), 'Correct page');
      await user.click(screen.getByRole('button', { name: 'Apply page edit' }));
      await screen.findByText('Page access was denied. Read current history before another edit.');
      expect(screen.queryByText('PRIVATE-DRAFT-MARKER')).not.toBeInTheDocument();
      expect(screen.queryByText('Current exact text.')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Page text/Markdown' })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByText('Unavailable revision')).toHaveLength(2));
      expect(f.updates).toHaveLength(1);
      expect(screen.queryByText('DENIED-DRAFT-MARKER')).not.toBeInTheDocument();
      expect(f.updates[0]).toMatchObject({ workspaceId: OTHER });
      act(() => useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE }));
      await user.click(await screen.findByRole('button', { name: 'Notebook history' }));
      expect(screen.queryByText('PRIVATE-DRAFT-MARKER')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Retry saved page edit' })
      ).not.toBeInTheDocument();
    });
  });
}
register_notebook_history_test_tsx_3();
