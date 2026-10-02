import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppRoutes } from '../../app/routes';
import { STATUS_CLASS } from '../../primitives';
import { useWorkspaceStore } from '../workspace-store';

const TIMESTAMP = '2026-07-21T00:00:00.000Z';

const ARTIFACT = {
  id: 'artifact1',
  workspaceId: 'ws1',
  threadId: 'th1',
  turnId: 'turn1',
  kind: 'report',
  title: 'Release notes draft',
  status: 'ready',
  summary: 'Draft release notes.',
  version: 1,
  content: { format: 'markdown', body: '# Release notes' },
  contentDigest: `sha256:${'a'.repeat(64)}`,
  lastMutationRequestId: 'req_artifact',
  origin: {
    kind: 'turn-output',
    threadId: 'th1',
    turnId: 'turn1',
    requestId: 'req_artifact',
  },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const REVIEW = {
  workspaceId: 'ws1',
  reviewId: 'review1',
  artifactId: 'artifact1',
  artifactVersion: 1,
  contentDigest: ARTIFACT.contentDigest,
  sourceThreadId: 'th1',
  sourceTurnId: 'turn1',
  sourceAgentId: 'agent1',
  materialProposal: null,
  decision: null,
  decisionActorId: null,
  feedback: null,
  decidedAt: null,
  followUpTurnId: null,
  appliedMaterialRevisionId: null,
  createdAt: TIMESTAMP,
};

const PROPOSAL_ARTIFACT = {
  ...ARTIFACT,
  title: 'Worker release-notes proposal',
  content: { format: 'markdown' as const, body: '# Proposed release notes\nShip the fix.\n' },
  contentDigest: `sha256:${'b'.repeat(64)}`,
};

const MATERIAL_BASE_REVISION = {
  workspaceId: 'ws1',
  materialId: 'material_release_notes',
  revisionId: 'revision_base',
  parentRevisionId: null,
  mediaType: 'text/markdown' as const,
  contentDigest: `sha256:${'c'.repeat(64)}`,
  authorId: 'user1',
  createdAt: TIMESTAMP,
  content: '# Release notes\nBefore worker proposal.\n',
};

const MATERIAL_CURRENT_REVISION = {
  ...MATERIAL_BASE_REVISION,
  revisionId: 'revision_user_newer',
  parentRevisionId: MATERIAL_BASE_REVISION.revisionId,
  contentDigest: `sha256:${'d'.repeat(64)}`,
  createdAt: '2026-07-21T00:01:00.000Z',
  content: '# Release notes\nUser saved newer work.\n',
};

const PROPOSAL_REVIEW = {
  ...REVIEW,
  contentDigest: PROPOSAL_ARTIFACT.contentDigest,
  materialProposal: {
    materialId: MATERIAL_BASE_REVISION.materialId,
    baseRevisionId: MATERIAL_BASE_REVISION.revisionId,
    baseContentDigest: MATERIAL_BASE_REVISION.contentDigest,
  },
};

type MethodOverrides = Partial<Record<string, unknown>>;

/** Build a fake CoreClient; per-test overrides replace individual methods. */
function makeClient(
  overrides: { operations?: MethodOverrides; core?: MethodOverrides; app?: MethodOverrides } = {}
): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listThreads: vi.fn().mockResolvedValue({ items: [] }),
      startTurn: vi.fn(),
      ...overrides.core,
    },
    app: {
      getWorkspaceMaterial: vi.fn().mockResolvedValue({
        material: {
          workspaceId: 'ws1',
          materialId: MATERIAL_BASE_REVISION.materialId,
          title: 'Release notes',
          kind: 'markdown',
          currentRevisionId: MATERIAL_CURRENT_REVISION.revisionId,
          sensitivity: 'internal',
          createdAt: TIMESTAMP,
          updatedAt: MATERIAL_CURRENT_REVISION.createdAt,
        },
      }),
      getWorkspaceMaterialRevision: vi
        .fn()
        .mockImplementation(async (_workspaceId, _materialId, revisionId) => ({
          revision:
            revisionId === MATERIAL_BASE_REVISION.revisionId
              ? MATERIAL_BASE_REVISION
              : MATERIAL_CURRENT_REVISION,
        })),
      saveWorkspaceMaterialRevision: vi.fn(),
      ...overrides.app,
    },

    operations: {
      'attention.list': vi.fn().mockResolvedValue({ items: [] }),

      'artifact.read': vi.fn().mockResolvedValue(ARTIFACT),
      'artifact.list': vi.fn().mockResolvedValue({ items: [ARTIFACT] }),
      'artifact.review-list': vi.fn().mockResolvedValue({ reviews: [REVIEW] }),
      'artifact.review.decide': vi.fn().mockResolvedValue({
        reviewId: 'review1',
        artifactId: 'artifact1',
        artifactVersion: 1,
        decision: 'accepted',
        followUpTurnId: null,
      }),
      'thread.items': vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      ...overrides.operations,
      'workspace.list': vi
        .fn()
        .mockResolvedValueOnce({
          items: [{ id: 'ws1', name: 'Market research' }].map((workspace) => ({
            workspace,
            effectiveRole: 'owner',
            membershipRevision: 1,
            ownerUserId: 'user_local',
            registryRevision: 1,
          })),
        })
        .mockImplementation(
          (overrides.operations?.['workspace.list'] as
            | CoreClient['operations']['workspace.list']
            | undefined) ??
            vi.fn().mockResolvedValue({
              items: [{ id: 'ws1', name: 'Market research' }].map((workspace) => ({
                workspace,
                effectiveRole: 'owner',
                membershipRevision: 1,
                ownerUserId: 'user_local',
                registryRevision: 1,
              })),
            })
        ),
    },
  } as unknown as CoreClient;
}

/** Captures the current router location for search-param assertions. */
function LocationProbe({ onChange }: { onChange: (search: string, pathname: string) => void }) {
  const location = useLocation();
  onChange(location.search, location.pathname);
  return null;
}

/** Render one app route with an isolated server-state cache. */
function renderApp(
  path: string,
  client: CoreClient,
  onLocation?: (search: string, pathname: string) => void
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          {onLocation ? <LocationProbe onChange={onLocation} /> : null}
          {children}
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  render(wrapper(<AppRoutes />));
  return queryClient;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('Artifact Review S14', () => {
  it('compares the exact reviewed proposal with its recorded immutable base revision', async () => {
    const getWorkspaceMaterialRevision = vi
      .fn()
      .mockImplementation(async (workspaceId: string, materialId: string, revisionId: string) => {
        if (
          workspaceId === 'ws1' &&
          materialId === MATERIAL_BASE_REVISION.materialId &&
          revisionId === MATERIAL_BASE_REVISION.revisionId
        ) {
          return { revision: MATERIAL_BASE_REVISION };
        }
        throw new Error(
          `Unexpected Material revision tuple: ${workspaceId}/${materialId}/${revisionId}`
        );
      });
    const client = makeClient({
      app: { getWorkspaceMaterialRevision },
      operations: {
        'artifact.read': vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT),
        'artifact.review-list': vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }),
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const proposal = await screen.findByRole('region', { name: /reviewed artifact proposal/i });
    const base = screen.getByRole('region', { name: /recorded base revision/i });
    expect(proposal).toHaveTextContent(/# Proposed release notes\s+Ship the fix\./);
    expect(proposal).toHaveTextContent(PROPOSAL_ARTIFACT.contentDigest);
    expect(base).toHaveTextContent(/# Release notes\s+Before worker proposal\./);
    expect(base).toHaveTextContent(MATERIAL_BASE_REVISION.contentDigest);
    expect(base).toHaveTextContent(MATERIAL_BASE_REVISION.revisionId);
    expect(getWorkspaceMaterialRevision).toHaveBeenCalledTimes(1);
    expect(getWorkspaceMaterialRevision).toHaveBeenCalledWith(
      'ws1',
      MATERIAL_BASE_REVISION.materialId,
      MATERIAL_BASE_REVISION.revisionId
    );
  });

  it.each([
    {
      mismatch: 'a newer current Artifact version',
      artifact: {
        ...PROPOSAL_ARTIFACT,
        version: PROPOSAL_REVIEW.artifactVersion + 1,
        contentDigest: `sha256:${'e'.repeat(64)}`,
      },
    },
    {
      mismatch: 'a different current Artifact digest at the reviewed version',
      artifact: {
        ...PROPOSAL_ARTIFACT,
        contentDigest: `sha256:${'f'.repeat(64)}`,
      },
    },
  ])('fails closed for an unresolved Review with $mismatch', async ({ artifact }) => {
    const submitArtifactReviewDecision = vi.fn();
    const client = makeClient({
      operations: {
        'artifact.read': vi.fn().mockResolvedValue(artifact),
        'artifact.review-list': vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }),
        'artifact.review.decide': submitArtifactReviewDecision,
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const unavailable = await screen.findByRole('alert');
    expect(unavailable).toHaveTextContent(/review (?:is )?unavailable|recovery required/i);
    expect(unavailable).not.toHaveTextContent(/decision evidence remains/i);
    for (const name of [/^accept$/i, /request refinement/i, /^redo$/i, /^reject$/i, /^defer$/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(submitArtifactReviewDecision).not.toHaveBeenCalled();
  });

  it.each([
    { label: /^accept$/i, decision: 'accepted' as const, feedback: undefined },
    {
      label: /request refinement/i,
      decision: 'needs_refinement' as const,
      feedback: 'Keep the user-authored heading.',
    },
    { label: /^redo$/i, decision: 'redo' as const, feedback: 'Rebuild from the recorded base.' },
    { label: /^reject$/i, decision: 'rejected' as const, feedback: undefined },
    { label: /^defer$/i, decision: 'deferred' as const, feedback: undefined },
  ])('submits the exact version-keyed $decision decision', async ({
    label,
    decision,
    feedback,
  }) => {
    const user = userEvent.setup();
    const submitArtifactReviewDecision = vi.fn().mockResolvedValue({
      reviewId: PROPOSAL_REVIEW.reviewId,
      artifactId: PROPOSAL_REVIEW.artifactId,
      artifactVersion: PROPOSAL_REVIEW.artifactVersion,
      decision,
      followUpTurnId:
        decision === 'needs_refinement' || decision === 'redo' ? 'turn_follow_up' : null,
    });
    const client = makeClient({
      operations: {
        'artifact.read': vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT),
        'artifact.review-list': vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }),
        'artifact.review.decide': submitArtifactReviewDecision,
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const action = await screen.findByRole('button', { name: label });
    if (feedback) {
      const feedbackField = screen.getByRole('textbox', { name: /review feedback/i });
      expect(action).toBeDisabled();
      await user.type(feedbackField, '   ');
      expect(action).toBeDisabled();
      await user.clear(feedbackField);
      await user.type(feedbackField, feedback);
      expect(action).toBeEnabled();
    }
    await user.click(action);

    await waitFor(() =>
      expect(submitArtifactReviewDecision).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        artifactId: PROPOSAL_REVIEW.artifactId,
        artifactVersion: PROPOSAL_REVIEW.artifactVersion,
        ...(feedback ? { decision, feedback } : { decision }),
      })
    );
    expect(client.core.startTurn).not.toHaveBeenCalled();
    expect(client.app.saveWorkspaceMaterialRevision).not.toHaveBeenCalled();
  });

  it('keeps the review pending and preserves both sides after a typed apply conflict', async () => {
    const user = userEvent.setup();
    const submitArtifactReviewDecision = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiCallError(409, 'Material changed since the proposal base.', {
          code: 'conflict',
        })
      )
      .mockResolvedValueOnce({
        reviewId: PROPOSAL_REVIEW.reviewId,
        artifactId: PROPOSAL_REVIEW.artifactId,
        artifactVersion: PROPOSAL_REVIEW.artifactVersion,
        decision: 'rejected',
        followUpTurnId: null,
      });
    const listArtifactReviews = vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] });
    const getWorkspaceMaterial = vi
      .fn()
      .mockImplementation(async (workspaceId: string, materialId: string) => {
        if (workspaceId === 'ws1' && materialId === MATERIAL_CURRENT_REVISION.materialId) {
          return {
            material: {
              workspaceId,
              materialId,
              title: 'Release notes',
              kind: 'markdown',
              currentRevisionId: MATERIAL_CURRENT_REVISION.revisionId,
              sensitivity: 'internal',
              createdAt: TIMESTAMP,
              updatedAt: MATERIAL_CURRENT_REVISION.createdAt,
            },
          };
        }
        throw new Error(`Unexpected Material identity tuple: ${workspaceId}/${materialId}`);
      });
    const getWorkspaceMaterialRevision = vi
      .fn()
      .mockImplementation(async (workspaceId: string, materialId: string, revisionId: string) => {
        if (
          workspaceId === 'ws1' &&
          materialId === MATERIAL_BASE_REVISION.materialId &&
          revisionId === MATERIAL_BASE_REVISION.revisionId
        ) {
          return { revision: MATERIAL_BASE_REVISION };
        }
        if (
          workspaceId === 'ws1' &&
          materialId === MATERIAL_CURRENT_REVISION.materialId &&
          revisionId === MATERIAL_CURRENT_REVISION.revisionId
        ) {
          return { revision: MATERIAL_CURRENT_REVISION };
        }
        throw new Error(
          `Unexpected Material revision tuple: ${workspaceId}/${materialId}/${revisionId}`
        );
      });
    const client = makeClient({
      app: { getWorkspaceMaterial, getWorkspaceMaterialRevision },
      operations: {
        'artifact.read': vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT),
        'artifact.review-list': listArtifactReviews,
        'artifact.review.decide': submitArtifactReviewDecision,
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    await user.click(await screen.findByRole('button', { name: /^accept$/i }));

    expect(
      await screen.findByText(/conflict|changed since the proposal base/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/awaiting decision/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /reviewed artifact proposal/i })).toHaveTextContent(
      /# Proposed release notes\s+Ship the fix\./
    );
    expect(screen.getByRole('region', { name: /current material revision/i })).toHaveTextContent(
      /# Release notes\s+User saved newer work\./
    );
    expect(getWorkspaceMaterial).toHaveBeenCalledTimes(1);
    expect(getWorkspaceMaterial).toHaveBeenCalledWith('ws1', MATERIAL_CURRENT_REVISION.materialId);
    expect(getWorkspaceMaterialRevision).toHaveBeenCalledTimes(2);
    expect(getWorkspaceMaterialRevision).toHaveBeenCalledWith(
      'ws1',
      MATERIAL_BASE_REVISION.materialId,
      MATERIAL_BASE_REVISION.revisionId
    );
    expect(getWorkspaceMaterialRevision).toHaveBeenCalledWith(
      'ws1',
      MATERIAL_CURRENT_REVISION.materialId,
      MATERIAL_CURRENT_REVISION.revisionId
    );
    expect(client.app.saveWorkspaceMaterialRevision).not.toHaveBeenCalled();
    expect(submitArtifactReviewDecision).toHaveBeenCalledTimes(1);
    expect(submitArtifactReviewDecision).toHaveBeenNthCalledWith(1, {
      workspaceId: 'ws1',
      artifactId: PROPOSAL_REVIEW.artifactId,
      artifactVersion: PROPOSAL_REVIEW.artifactVersion,
      ...{ decision: 'accepted' },
    });

    const retry = screen.queryByRole('button', { name: /try again|refresh|reload/i });
    if (retry) {
      const readsBefore = listArtifactReviews.mock.calls.length;
      await user.click(retry);
      await waitFor(() =>
        expect(listArtifactReviews.mock.calls.length).toBeGreaterThan(readsBefore)
      );
      expect(submitArtifactReviewDecision).toHaveBeenCalledTimes(1);
    }

    const reject = screen.getByRole('button', { name: /^reject$/i });
    expect(reject).toBeEnabled();
    await user.click(reject);
    await waitFor(() => expect(submitArtifactReviewDecision).toHaveBeenCalledTimes(2));
    expect(submitArtifactReviewDecision).toHaveBeenNthCalledWith(2, {
      workspaceId: 'ws1',
      artifactId: PROPOSAL_REVIEW.artifactId,
      artifactVersion: PROPOSAL_REVIEW.artifactVersion,
      ...{ decision: 'rejected' },
    });
  });

  it('shows a successful decision only after the exact Review refetch settles', async () => {
    const user = userEvent.setup();
    let resolveReviews: ((value: { reviews: unknown[] }) => void) | undefined;
    const decidedReview = {
      ...PROPOSAL_REVIEW,
      decision: 'accepted' as const,
      decisionActorId: 'user_reviewer',
      decidedAt: '2026-07-21T00:02:00.000Z',
      appliedMaterialRevisionId: 'revision_applied',
    };
    const listArtifactReviews = vi
      .fn()
      .mockResolvedValueOnce({ reviews: [PROPOSAL_REVIEW] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReviews = resolve;
          })
      );
    const client = makeClient({
      operations: {
        'artifact.read': vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT),
        'artifact.review-list': listArtifactReviews,
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    await user.click(await screen.findByRole('button', { name: /^accept$/i }));
    await waitFor(() => expect(listArtifactReviews).toHaveBeenCalledTimes(2));
    expect(document.body).not.toHaveTextContent(/\baccepted\b/i);
    expect(screen.getByText(/awaiting decision/i)).toBeInTheDocument();

    resolveReviews?.({ reviews: [decidedReview] });

    const status = await screen.findByRole('status', { name: /artifact review/i });
    expect(status).toHaveTextContent(/^approved/i);
    expect(status).toHaveTextContent(`Version ${PROPOSAL_REVIEW.artifactVersion}`);
    expect(status).toHaveTextContent(PROPOSAL_REVIEW.contentDigest);
  });

  it('renders durable decision evidence without fabricating unavailable historical bytes', async () => {
    const newerArtifact = {
      ...PROPOSAL_ARTIFACT,
      version: 2,
      content: { format: 'markdown' as const, body: '# Unrelated newer artifact bytes\n' },
      contentDigest: `sha256:${'e'.repeat(64)}`,
    };
    const decidedReview = {
      ...PROPOSAL_REVIEW,
      decision: 'accepted' as const,
      decisionActorId: 'user_reviewer',
      decidedAt: '2026-07-21T00:02:00.000Z',
      appliedMaterialRevisionId: 'revision_applied',
    };
    const client = makeClient({
      operations: {
        'artifact.read': vi.fn().mockResolvedValue(newerArtifact),
        'artifact.review-list': vi.fn().mockResolvedValue({ reviews: [decidedReview] }),
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const status = await screen.findByRole('status', { name: /artifact review/i });
    expect(status).toHaveTextContent(/approved/i);
    expect(status).toHaveTextContent(`Version ${decidedReview.artifactVersion}`);
    expect(status).toHaveTextContent(decidedReview.contentDigest);
    expect(screen.getByText(decidedReview.decisionActorId)).toBeInTheDocument();
    expect(screen.getByText(/2026-07-21/)).toBeInTheDocument();
    expect(screen.getByText(decidedReview.appliedMaterialRevisionId)).toBeInTheDocument();
    const historicalReview = screen.getByRole('region', {
      name: /historical artifact review|reviewed artifact proposal/i,
    });
    expect(
      within(historicalReview).queryByText(PROPOSAL_ARTIFACT.content.body)
    ).not.toBeInTheDocument();
    expect(
      within(historicalReview).queryByText(newerArtifact.content.body)
    ).not.toBeInTheDocument();
  });

  it('maps every decided Review to fixed status vocabulary, tone, and separate decision evidence', async () => {
    const matrix = [
      {
        decision: 'accepted' as const,
        status: 'Approved',
        tone: 'positive' as const,
        evidence: 'Accepted',
      },
      {
        decision: 'rejected' as const,
        status: 'Rejected',
        tone: 'negative' as const,
        evidence: 'Rejected',
      },
      {
        decision: 'deferred' as const,
        status: 'Paused',
        tone: 'neutral' as const,
        evidence: 'Deferred',
      },
      {
        decision: 'needs_refinement' as const,
        status: 'Needs review',
        tone: 'notice' as const,
        evidence: 'Needs refinement',
      },
      {
        decision: 'redo' as const,
        status: 'In progress',
        tone: 'informative' as const,
        evidence: 'Redo',
      },
    ];

    for (const { decision, status: statusText, tone, evidence } of matrix) {
      const decidedReview = {
        ...PROPOSAL_REVIEW,
        decision,
        decisionActorId: 'user_reviewer',
        decidedAt: '2026-07-21T00:02:00.000Z',
        feedback:
          decision === 'needs_refinement' || decision === 'redo' ? 'Revise this output.' : null,
        followUpTurnId:
          decision === 'needs_refinement' || decision === 'redo' ? 'turn_follow_up' : null,
        appliedMaterialRevisionId: decision === 'accepted' ? 'revision_applied' : null,
      };
      const client = makeClient({
        core: {},
        app: {},

        operations: {
          'artifact.read': vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT),
          'artifact.review-list': vi.fn().mockResolvedValue({ reviews: [decidedReview] }),
        },
      });
      renderApp('/goals/ws1/th1/artifacts/artifact1', client);

      const status = await screen.findByRole('status', { name: /artifact review/i });
      const chip = within(status).queryByText(new RegExp(`^${statusText}$`, 'i'));
      expect.soft(chip, `${decision} status text`).not.toBeNull();
      if (chip) {
        expect.soft(chip, `${decision} status tone`).toHaveClass(...STATUS_CLASS[tone].split(' '));
      }
      const evidenceNodes = screen
        .queryAllByText(new RegExp(`^${evidence}$`, 'i'))
        .filter((node) => !status.contains(node));
      expect.soft(evidenceNodes, `${decision} decision evidence`).toHaveLength(1);
      if (decision === 'needs_refinement') {
        expect.soft(document.body).not.toHaveTextContent(/needs_refinement/i);
      }
      cleanup();
    }
  });

  it('disables every review write while the connection probe is checking', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockImplementation(() => new Promise(() => undefined)) },
      operations: {
        'artifact.read': vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT),
        'artifact.review-list': vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }),
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const actions = await Promise.all(
      [/^accept$/i, /request refinement/i, /^redo$/i, /^reject$/i, /^defer$/i].map((name) =>
        screen.findByRole('button', { name })
      )
    );
    for (const action of actions) expect(action).toBeDisabled();
  });

  it('keeps all review actions visible but disabled when disconnected', async () => {
    const client = makeClient({
      core: { meta: vi.fn().mockRejectedValue(new Error('down')) },
      operations: {
        'artifact.read': vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT),
        'artifact.review-list': vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }),
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const actions = await Promise.all(
      [/^accept$/i, /request refinement/i, /^redo$/i, /^reject$/i, /^defer$/i].map((name) =>
        screen.findByRole('button', { name })
      )
    );
    await waitFor(() => {
      for (const action of actions) expect(action).toBeDisabled();
    });
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it('disables every sibling decision while one mutation is pending', async () => {
    const user = userEvent.setup();
    const submitArtifactReviewDecision = vi.fn().mockImplementation(() => new Promise(() => {}));
    const client = makeClient({
      operations: {
        'artifact.read': vi.fn().mockResolvedValue(PROPOSAL_ARTIFACT),
        'artifact.review-list': vi.fn().mockResolvedValue({ reviews: [PROPOSAL_REVIEW] }),
        'artifact.review.decide': submitArtifactReviewDecision,
      },
    });
    renderApp('/goals/ws1/th1/artifacts/artifact1', client);

    const actions = await Promise.all(
      [/^accept$/i, /request refinement/i, /^redo$/i, /^reject$/i, /^defer$/i].map((name) =>
        screen.findByRole('button', { name })
      )
    );
    await user.click(actions[0]);
    await waitFor(() => expect(submitArtifactReviewDecision).toHaveBeenCalledOnce());
    for (const action of actions) expect(action).toBeDisabled();
  });
});
