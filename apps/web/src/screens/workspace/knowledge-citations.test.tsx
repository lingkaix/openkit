import { type KnowledgeManagerAnswerResponse, operationHttpPath } from '@openkit/app-api-schemas';
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
const WORKSPACE_ID = allocateEntityId('ws');
const OTHER_WORKSPACE_ID = allocateEntityId('ws');
const OWNER_USER_ID = allocateEntityId('usr');
const QUESTION = 'When does the reading room open?';
const PAGE = {
  id: 'reading-room',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  kind: 'preference' as const,
  title: 'Reading room opening hours',
  content: 'The reading room opens at 09:00 on weekdays. Bring the blue access card.',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const UNRELATED_PAGE = {
  ...PAGE,
  id: 'unrelated-page',
  contentDigest: `sha256:${'b'.repeat(64)}`,
  title: 'Unrelated current page title',
  content: 'Unrelated current page content must not become a citation.',
};
const CITATION = {
  reference: { scopeId: `page/workspace/${WORKSPACE_ID}`, objectId: PAGE.id },
  kind: PAGE.kind,
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
      body = { protocolVersion: '1', capabilities: [], eventFamilies: [] };
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
              effectiveRole: 'owner',
              membershipRevision: 1,
              ownerUserId: OWNER_USER_ID,
              registryRevision: 1,
            })),
          };
          break;
        case operationHttpPath('knowledge.list'):
          if (pageRead) return pageRead();
          body = { notebookRevision: 'notebook-fixture-revision', items: [UNRELATED_PAGE, PAGE] };
          break;
        case operationHttpPath('knowledge.indexes'):
          body = {
            linkGraph: { schemaVersion: 1, workspaceId: WORKSPACE_ID, rebuiltAt: null, edges: [] },
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
    queryClient,
    setPageRead: (read: typeof pageRead) => {
      pageRead = read;
    },
    setAnswerRead: (read: typeof answerRead) => {
      answerRead = read;
    },
  };
}

/** Submits the question through the visible Manager controls. */
async function askManager() {
  const user = userEvent.setup();
  const manager = await screen.findByRole('region', { name: 'Manager' });
  const question = within(manager).getByRole('textbox', { name: 'Question' });
  await waitFor(() => expect(question).toBeEnabled());
  await user.click(question);
  await user.paste(QUESTION);
  await user.click(within(manager).getByRole('button', { name: 'Answer' }));
  expect(await within(manager).findByText(ANSWER.answer)).toBeVisible();
  return manager;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});

afterEach(() => {
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe('Knowledge Manager answer citations', () => {
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
    expect(target).toHaveTextContent(PAGE.content);
    expect(target).not.toHaveTextContent(UNRELATED_PAGE.title);
    expect(manager).not.toContainElement(target);
    expect(within(manager).getAllByRole('link')).toHaveLength(1);
    expect(within(manager).queryByText(UNRELATED_PAGE.title)).not.toBeInTheDocument();
    expect(within(manager).queryByText(UNRELATED_PAGE.content)).not.toBeInTheDocument();
  });

  it.each([
    {
      name: 'another Workspace with the same page id',
      scopeId: `page/workspace/${OTHER_WORKSPACE_ID}`,
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
    expect(within(manager).queryByText(PAGE.content)).not.toBeInTheDocument();
    expect(within(manager).queryByText(UNRELATED_PAGE.title)).not.toBeInTheDocument();
    expect(within(manager).queryByText(UNRELATED_PAGE.content)).not.toBeInTheDocument();
  });

  it('does not invent citations from available pages when the answer returns none', async () => {
    renderKnowledge({ ...ANSWER, citations: [] });
    const manager = await askManager();

    expect(within(manager).queryByRole('link')).not.toBeInTheDocument();
    expect(within(manager).queryByText(PAGE.title)).not.toBeInTheDocument();
    expect(within(manager).queryByText(PAGE.content)).not.toBeInTheDocument();
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
      fixture.queryClient.getQueryData<{ items: (typeof PAGE)[] }>(
        workspaceKeys.knowledge(WORKSPACE_ID)
      )?.items
    ).toContainEqual(PAGE);
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
