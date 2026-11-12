import type { HumanAttentionRow } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { ToastProvider, toastQueue } from '../../../primitives/Toast';
import { ArtifactReference } from '../../artifacts/ArtifactReference';
import { ArtifactsScreen } from '../../artifacts/ArtifactsScreen';
import { ArtifactReviewScreen } from '../../goal/ArtifactReviewScreen';
import { AuditEventRow } from '../../settings/AuditRows';
import { useWorkspaceStore } from '../../workspace-store';
import { chatKeys } from '../data';
import { useThreadAudience } from './audience';
import { BackLink } from './BackLink';
import { hrefOf, resolve } from './resolve';
import { TimelineToasts } from './TimelineToasts';
import { getToastSession, resetToastPolicy } from './toast-policy';
import { tw8Fixture } from './tw8-verify-fixture';

// The deciding oracles come from conversation_timeline: audience first, exact
// versions/reviews, notifications, and back-links. No hook/renderer is mocked.
const queries: QueryClient[] = [];
beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.getState().setCurrentWorkspaceId(null);
  resetToastPolicy();
  toastQueue.clear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width: 800'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  for (const query of queries.splice(0)) query.clear();
  toastQueue.clear();
  resetToastPolicy();
  useWorkspaceStore.getState().setCurrentWorkspaceId(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeClient(
  f: ReturnType<typeof tw8Fixture>,
  overrides: Record<string, unknown> = {}
): CoreClient {
  return {
    core: { meta: async () => ({}) },
    artifactFiles: { browserDownloadUrl: () => '/download-original' },
    operations: {
      'workspace.list': async () => f.workspaceList,
      'conversation.navigation': async () => f.navigation(),
      'attention.list': async () => ({ items: [] }),
      'thread.list': async () => ({ items: [f.thread] }),
      'artifact.list': async () => ({ items: [f.head] }),
      'artifact.read': async () => f.head,
      'artifact.version-list': async () => ({ items: [f.version(f.old), f.version(f.head)] }),
      'artifact.version-read': async ({ artifactVersion }: { artifactVersion: number }) => {
        const artifact = artifactVersion === 1 ? f.old : f.head;
        return { artifact, version: f.version(artifact) };
      },
      'artifact.review-list': async () => ({ reviews: [f.oldReview, f.pendingReview] }),
      ...overrides,
    },
  } as unknown as CoreClient;
}
function mount(client: CoreClient, ui: ReactNode, initial = '/source') {
  const query = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  queries.push(query);
  render(
    <QueryClientProvider client={query}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return query;
}
async function refresh(query: QueryClient) {
  await act(async () => {
    await query.refetchQueries({ type: 'active' });
  });
}
function toasts() {
  return screen.queryAllByRole('alertdialog');
}

function Source({ f }: { f: ReturnType<typeof tw8Fixture> }) {
  const audience = useThreadAudience([f.workspaceId]).sourceFor(f.threadId);
  return (
    <>
      <output aria-label="Source admission">{audience.status}</output>
      <BackLink workspaceId={f.workspaceId} threadId={f.threadId} audience={audience} />
    </>
  );
}
async function mountToasts(f: ReturnType<typeof tw8Fixture>, client: CoreClient) {
  useWorkspaceStore.getState().setCurrentWorkspaceId(f.workspaceId);
  const query = mount(
    client,
    <>
      <TimelineToasts />
      <ToastProvider />
    </>,
    '/artifacts'
  );
  // Wait for the production policy to record its empty initial attention read.
  await waitFor(() => expect(getToastSession().priming).toBe(false));
  return query;
}

describe('TW8 independent behavior regressions', () => {
  it('R1a timeline View content opens the exact retained output, not its newer head', async () => {
    const f = tw8Fixture();
    mount(
      makeClient(f),
      <Routes>
        <Route path="/source" element={<ArtifactReference item={f.reference()} />} />
        <Route path="/artifacts" element={<ArtifactsScreen />} />
      </Routes>
    );
    await userEvent.setup().click(screen.getByText('View content'));
    expect(await screen.findByText('Exact retained output version one')).toBeVisible();
    expect(screen.queryByText('Current head output version three')).not.toBeInTheDocument();
  });

  it('R1b an unretained output offers the separately labeled version list, never the head as evidence', async () => {
    const f = tw8Fixture();
    mount(
      makeClient(f, {
        'artifact.version-read': async () => {
          throw new ApiCallError(404, 'Exact version unavailable.', { code: 'not_found' });
        },
      }),
      <Routes>
        <Route path="/source" element={<ArtifactReference item={f.reference()} />} />
        <Route path="/artifacts" element={<ArtifactsScreen />} />
      </Routes>
    );
    await userEvent.setup().click(screen.getByText('View content'));
    expect(await screen.findByText('Version 1 unavailable')).toBeVisible();
    const fallback = screen.getByRole('link', { name: "Open the output's version list" });
    expect(fallback).toBeVisible();
    expect(fallback.getAttribute('href')).not.toMatch(/(?:\?|&)version=1(?:&|$)/);
    expect(screen.queryByText('Current head output version three')).not.toBeInTheDocument();
  });

  it('R3 the resolver-to-review journey opens the addressed review and exact version, not pending/latest', async () => {
    const f = tw8Fixture();
    const destination = resolve(
      {
        kind: 'attention',
        workspaceId: f.workspaceId,
        rowId: `artifact-review:${f.oldReview.reviewId}`,
        source: {
          type: 'artifact_review',
          workspaceId: f.workspaceId,
          threadId: f.threadId,
          turnId: f.turnId,
          artifactId: f.artifactId,
          artifactVersion: 1,
          reviewId: f.oldReview.reviewId,
        },
      },
      {
        threads: new Map([[f.threadId, { activity: 'goal', name: f.thread.name }]]),
        versions: new Map([[`${f.artifactId}:1`, { available: true }]]),
      }
    );
    const href = hrefOf(destination);
    if (!href) throw new Error('Readable review has no destination.');
    mount(
      makeClient(f),
      <Routes>
        <Route path="/source" element={<Link to={href}>Open addressed review</Link>} />
        <Route
          path="/goals/:workspaceId/:threadId/artifacts/:artifactId"
          element={<ArtifactReviewScreen />}
        />
      </Routes>
    );
    await userEvent.setup().click(screen.getByRole('link', { name: 'Open addressed review' }));
    expect(await screen.findByText('Review version 1')).toBeVisible();
    expect(screen.getByText('Exact earlier review evidence')).toBeVisible();
    expect(await screen.findByText('Exact retained output version one')).toBeVisible();
    expect(screen.queryByText('Review version 3')).not.toBeInTheDocument();
  });

  it('R4 a 403 audience refetch cannot reuse a cached open audience or title', async () => {
    const f = tw8Fixture();
    let denied = false;
    const query = mount(
      makeClient(f, {
        'conversation.navigation': async () => {
          if (denied)
            throw new ApiCallError(403, 'Source admission denied.', {
              code: 'workspace_access_denied',
            });
          return f.navigation();
        },
      }),
      <Source f={f} />
    );
    await screen.findByRole('link', { name: 'From: Launch notes' });
    denied = true;
    await act(async () => {
      await query.refetchQueries({ queryKey: chatKeys.navigation(f.workspaceId) });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Source admission')).not.toHaveTextContent('open');
      expect(screen.queryByRole('link', { name: /Launch notes/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Launch notes/)).not.toBeInTheDocument();
    });
  });

  it('R5 a visible toast closes in the shared queue when its source becomes denied', async () => {
    const f = tw8Fixture();
    let rows: HumanAttentionRow[] = [];
    let open = true;
    const query = await mountToasts(
      f,
      makeClient(f, {
        'attention.list': async () => ({ items: rows }),
        'conversation.navigation': async () => (open ? f.navigation() : { items: [] }),
      })
    );
    rows = [f.attention('first')];
    await refresh(query);
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toHaveTextContent('Approve the report');
    open = false;
    // The independent source read changes admission; the old attention row stays cached.
    await act(async () => {
      await query.refetchQueries({ queryKey: chatKeys.navigation(f.workspaceId) });
    });
    await waitFor(() => expect(toasts()).toHaveLength(0));
  });

  it('R6 decisions in successive polls update the visible Thread toast to the merged count', async () => {
    const f = tw8Fixture();
    let rows: HumanAttentionRow[] = [];
    const query = await mountToasts(
      f,
      makeClient(f, { 'attention.list': async () => ({ items: rows }) })
    );
    rows = [f.attention('first')];
    await refresh(query);
    await waitFor(() => expect(toasts()).toHaveLength(1));
    rows = [...rows, f.attention('second')];
    await refresh(query);
    await waitFor(() => {
      expect(toasts()).toHaveLength(1);
      expect(toasts()[0]).toHaveTextContent('2 decisions need you in Launch notes');
    });
  });

  it('R7 overflow keeps earlier hidden decisions when another Thread arrives', async () => {
    const f = tw8Fixture();
    let rows: HumanAttentionRow[] = [];
    const ids = Array.from({ length: 5 }, () => allocateEntityId('th'));
    const query = await mountToasts(
      f,
      makeClient(f, {
        'attention.list': async () => ({ items: rows }),
        'conversation.navigation': async () => f.navigation(ids),
      })
    );
    rows = ids
      .slice(0, 4)
      .map((id, index) => f.attention(`request-${index}`, id, `Approve lane ${index + 1}`));
    await refresh(query);
    await waitFor(() =>
      expect(
        toasts().find((toast) => toast.textContent?.includes('Open Action Center'))
      ).toHaveTextContent('+2 more')
    );
    rows = [...rows, f.attention('request-4', ids[4], 'Approve lane 5')];
    await refresh(query);
    await waitFor(() => {
      expect(toasts()).toHaveLength(3);
      expect(
        toasts().find((toast) => toast.textContent?.includes('Open Action Center'))
      ).toHaveTextContent('+3 more');
    });
  });

  it('R8 an audit record time is not presented as the run start on its back-link', () => {
    const f = tw8Fixture();
    mount(
      makeClient(f),
      <AuditEventRow
        event={{
          id: 'audit-record',
          category: 'artifact',
          action: 'artifact.version-commit',
          outcome: 'succeeded',
          summary: 'Saved an output during a long run',
          actor: null,
          workspaceId: f.workspaceId,
          threadId: f.threadId,
          turnId: f.turnId,
          requestId: null,
          recordedAt: f.at,
        }}
        audience={{ status: 'open', name: f.thread.name, activity: 'chat' }}
      />
    );
    const source = screen.getByRole('link', { name: /^From:/ });
    expect(source).toHaveTextContent('From: Launch notes');
    expect(source).not.toHaveTextContent('run at');
  });
});
