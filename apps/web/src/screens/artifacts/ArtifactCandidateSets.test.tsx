import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactCandidateSets } from './ArtifactCandidateSets';

const { create, list, read, select, versionRead, threads } = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  select: vi.fn(),
  versionRead: vi.fn(),
  threads: vi.fn(),
}));
vi.mock('../../app/core-client', () => ({
  useCoreClient: () => ({
    operations: {
      'evaluation.candidate-set-create': create,
      'evaluation.candidate-set-list': list,
      'evaluation.candidate-set-read': read,
      'evaluation.candidate-set-select': select,
      'artifact.version-read': versionRead,
      'thread.list': threads,
    },
    artifactFiles: {
      browserDownloadUrl: (input: { artifactVersion: number }) =>
        `/download/${input.artifactVersion}`,
    },
  }),
}));

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const artifactId = 'ar_00000000-0000-7000-8000-000000000002';
const threadId = 'th_00000000-0000-7000-8000-000000000003';
const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000004' };
const recordedAt = '2026-10-17T01:00:00.000Z';
const first = { artifactId, artifactVersion: 1, contentDigest: `sha256:${'a'.repeat(64)}` };
const second = { artifactId, artifactVersion: 2, contentDigest: `sha256:${'b'.repeat(64)}` };
const set = {
  formatVersion: 1,
  workspaceId,
  candidateSetId: 'comparison-request',
  createdBy: actor,
  createdAt: recordedAt,
  candidates: [first, second],
  judgements: [],
  extensions: {},
};

/** Exact retained responses deliberately differ despite sharing one Artifact identity. */
function version(candidate: typeof first) {
  return {
    artifact: {
      id: artifactId,
      workspaceId,
      version: candidate.artifactVersion,
      contentDigest: candidate.contentDigest,
      title: 'Report',
      summary: null,
      status: 'ready',
      content: {
        format: 'markdown',
        body: candidate.artifactVersion === 1 ? '# First exact original' : '# Newer head',
      },
    },
    version: {
      ...candidate,
      workspaceId,
      parentVersion: candidate.artifactVersion === 1 ? null : 1,
      actor,
      threadId,
      turnId: 'tu_00000000-0000-7000-8000-000000000005',
      recordedAt,
    },
  };
}
const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});
beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ items: [] });
  create.mockResolvedValue(set);
  read.mockResolvedValue(set);
  versionRead.mockImplementation(({ artifactVersion }: { artifactVersion: number }) =>
    Promise.resolve(version(artifactVersion === 1 ? first : second))
  );
  threads.mockResolvedValue({
    items: [{ id: threadId, name: 'Continue report', status: 'active' }],
  });
  select.mockImplementation((input) => {
    const result = {
      ...set,
      judgements: [
        {
          formatVersion: 1,
          workspaceId,
          requestId: input.requestId,
          kind: 'select',
          target: { kind: 'candidate-set', candidateSetId: set.candidateSetId },
          choice: input.choice,
          actor,
          recordedAt,
          note: input.note ?? null,
          extensions: {},
        },
      ],
    };
    list.mockResolvedValue({ items: [result] });
    read.mockResolvedValue(result);
    return Promise.resolve(result);
  });
});

/** Observes the existing navigation-state contract without submitting a Turn. */
function DraftHandoff() {
  return <output aria-label="Draft handoff">{JSON.stringify(useLocation().state)}</output>;
}

/** Runs real comparison query/mutation and router behavior around controlled public operations. */
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/artifacts']}>
        <Routes>
          <Route
            path="/artifacts"
            element={
              <ArtifactCandidateSets
                workspaceId={workspaceId}
                draftCandidates={[first, second]}
                disabled={false}
                onRemoveCandidate={vi.fn()}
                onClearDraft={vi.fn()}
                onDraftLockedChange={vi.fn()}
              />
            }
          />
          <Route path="/chat/:workspaceId/:threadId" element={<DraftHandoff />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return client;
}

describe('exact Artifact candidate comparison', () => {
  it('creates two versions of one Artifact, records an exact human choice, and hands the older version to the existing unsent draft', async () => {
    mount();
    const user = userEvent.setup();
    expect(create).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Create comparison' }));
    expect(create.mock.calls[0][0]).toMatchObject({ workspaceId, candidates: [first, second] });
    expect(await screen.findByText('# First exact original')).toBeInTheDocument();
    expect(screen.getByText('# Newer head')).toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Candidate choice/ }));
    await user.click(await screen.findByRole('option', { name: /Report · version 1/ }));
    await user.type(
      screen.getByRole('textbox', { name: 'Choice note' }),
      'Keep the earlier result.'
    );
    await user.click(screen.getByRole('button', { name: 'Record choice' }));
    await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    expect(select.mock.calls[0][0]).toMatchObject({
      workspaceId,
      candidateSetId: set.candidateSetId,
      choice: first,
      note: 'Keep the earlier result.',
    });
    expect(await screen.findByText('Keep the earlier result.')).toBeInTheDocument();
    expect(screen.getByText(actor.id)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next conversation/ }));
    await user.click(await screen.findByRole('option', { name: 'Continue report' }));
    await user.click(screen.getByRole('button', { name: 'Use selected in next Turn' }));
    expect(JSON.parse(screen.getByLabelText('Draft handoff').textContent ?? '{}')).toEqual({
      candidateInput: { workspaceId, threadId, ...first },
    });
    expect(versionRead).toHaveBeenCalledWith({ workspaceId, artifactId, artifactVersion: 1 });
  });
});
