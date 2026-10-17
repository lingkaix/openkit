import type { JudgementRecord } from '@openkit/app-api-schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
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
  create.mockImplementation((input) => {
    const result = { ...set, candidateSetId: input.requestId };
    list.mockResolvedValue({ items: [result] });
    read.mockResolvedValue(result);
    return Promise.resolve(result);
  });
  read.mockResolvedValue(set);
  versionRead.mockImplementation(({ artifactVersion }: { artifactVersion: number }) =>
    Promise.resolve(version(artifactVersion === 1 ? first : second))
  );
  threads.mockResolvedValue({
    items: [{ id: threadId, name: 'Continue report', status: 'active' }],
  });
  const judgements: JudgementRecord[] = [];
  select.mockImplementation((input) => {
    judgements.push({
      formatVersion: 1,
      workspaceId,
      requestId: input.requestId,
      kind: 'select',
      target: { kind: 'candidate-set', candidateSetId: input.candidateSetId },
      choice: input.choice,
      actor,
      recordedAt,
      note: input.note ?? null,
      extensions: {},
    });
    const result = { ...set, candidateSetId: input.candidateSetId, judgements: [...judgements] };
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
  const onClearDraft = vi.fn();
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
                onClearDraft={onClearDraft}
                onDraftLockedChange={vi.fn()}
              />
            }
          />
          <Route path="/chat/:workspaceId/:threadId" element={<DraftHandoff />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { client, onClearDraft };
}

describe('exact Artifact candidate comparison', () => {
  it('keeps an unknown choice frozen through current refresh and retries its exact request', async () => {
    list.mockResolvedValue({ items: [set] });
    select.mockRejectedValue(new Error('private transport failure'));
    mount();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: `Open comparison ${set.candidateSetId}` })
    );
    await screen.findByText('# First exact original');
    await user.click(screen.getByRole('button', { name: /Candidate choice/ }));
    await user.click(await screen.findByRole('option', { name: /Report · version 1/ }));
    await user.type(screen.getByRole('textbox', { name: 'Choice note' }), 'Frozen choice.');
    await user.click(screen.getByRole('button', { name: 'Record choice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The result is unknown.');
    await user.click(screen.getByRole('button', { name: 'Refresh comparisons' }));
    expect(screen.getByRole('textbox', { name: 'Choice note' })).toHaveValue('Frozen choice.');
    expect(screen.getByRole('button', { name: 'Record choice' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Edit refused request' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry same choice request' }));
    await waitFor(() => expect(select).toHaveBeenCalledTimes(2));
    expect(select.mock.calls[1]).toEqual(select.mock.calls[0]);
    expect(screen.queryByText('private transport failure')).not.toBeInTheDocument();
  });

  it('hides protected originals and choices when the current comparison read fails', async () => {
    list.mockResolvedValue({ items: [set] });
    const { client } = mount();
    await userEvent.click(
      await screen.findByRole('button', { name: `Open comparison ${set.candidateSetId}` })
    );
    expect(await screen.findByText('# First exact original')).toBeInTheDocument();
    read.mockRejectedValue(new Error('private membership failure'));
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ['candidate-set', workspaceId, set.candidateSetId],
      });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't read that comparison.");
    expect(screen.queryByText('# First exact original')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download version 1' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Use selected in next Turn' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('private membership failure')).not.toBeInTheDocument();
  });

  it('does not open a late create result after the user inspects another comparison', async () => {
    list.mockResolvedValue({ items: [set] });
    let settle!: (record: typeof set) => void;
    create.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const { onClearDraft } = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create comparison' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: `Open comparison ${set.candidateSetId}` }));
    await screen.findByText('# First exact original');
    const createdId = create.mock.calls[0][0].requestId;
    await act(async () => settle({ ...set, candidateSetId: createdId }));
    expect(onClearDraft).not.toHaveBeenCalled();
    expect(read.mock.calls.some(([input]) => input.candidateSetId === createdId)).toBe(false);
    expect(screen.getByText('# First exact original')).toBeInTheDocument();
  });

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
    await user.click(await screen.findByRole('option', { name: /Report · version 2/ }));
    await user.type(
      screen.getByRole('textbox', { name: 'Choice note' }),
      'Later edition considered.'
    );
    await user.click(screen.getByRole('button', { name: 'Record choice' }));
    expect(await screen.findByText('Later edition considered.')).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox', { name: 'Choice note' }));
    await user.click(screen.getByRole('button', { name: /Candidate choice/ }));
    await user.click(await screen.findByRole('option', { name: /Report · version 1/ }));
    await user.type(
      screen.getByRole('textbox', { name: 'Choice note' }),
      'Keep the earlier result.'
    );
    await user.click(screen.getByRole('button', { name: 'Record choice' }));
    await waitFor(() => expect(select).toHaveBeenCalledTimes(2));
    expect(select.mock.calls[1][0]).toMatchObject({
      workspaceId,
      candidateSetId: create.mock.calls[0][0].requestId,
      choice: first,
      note: 'Keep the earlier result.',
    });
    expect(await screen.findByText('Keep the earlier result.')).toBeInTheDocument();
    expect(screen.getByText('Later edition considered.')).toBeInTheDocument();
    expect(screen.getAllByText(actor.id).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /Next conversation/ }));
    await user.click(await screen.findByRole('option', { name: 'Continue report' }));
    await user.click(screen.getByRole('button', { name: 'Use selected in next Turn' }));
    expect(JSON.parse(screen.getByLabelText('Draft handoff').textContent ?? '{}')).toEqual({
      candidateInput: { workspaceId, threadId, ...first },
    });
    expect(versionRead).toHaveBeenCalledWith({ workspaceId, artifactId, artifactVersion: 1 });
  });
});
