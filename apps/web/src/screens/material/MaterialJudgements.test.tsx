import { ApiCallError } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MaterialJudgements } from './MaterialJudgements';

const { add, correct } = vi.hoisted(() => ({ add: vi.fn(), correct: vi.fn() }));
vi.mock('../../app/core-client', () => ({
  useCoreClient: () => ({
    operations: {
      'evaluation.judgement-add': add,
      'material.range-correct': correct,
    },
  }),
}));
const digest = `sha256:${'a'.repeat(64)}`;
const resultDigest = `sha256:${'b'.repeat(64)}`;
const revision = {
  workspaceId: 'workspace-a',
  materialId: 'material-a',
  revisionId: 'revision-1',
  parentRevisionId: null,
  mediaType: 'text/plain' as const,
  contentDigest: digest,
  authorId: 'human',
  createdAt: '2026-10-17T01:00:00.000Z',
  content: 'A\r\n😀e\u0301\rZ',
  judgements: [],
};
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  correct.mockImplementation(async (input) => ({
    judgement: {
      formatVersion: 1,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      actor: { kind: 'user', id: 'human-editor' },
      recordedAt: '2026-10-17T02:00:00.000Z',
      kind: 'correct',
      target: input.target,
      note: input.note,
      extensions: {},
      choice: {
        outcome: input.decision,
        replacementText: input.replacementText,
        resultingRevision:
          input.decision === 'apply'
            ? {
                materialId: revision.materialId,
                revisionId: 'revision-2',
                contentDigest: resultDigest,
              }
            : null,
      },
    },
  }));
});
afterEach(() => client.clear());
async function prepare() {
  render(
    <QueryClientProvider client={client}>
      <MaterialJudgements workspaceId="workspace-a" revision={revision} disabled={false} />
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Assess selected revision' }));
  await user.type(screen.getByRole('textbox', { name: 'Range start' }), '3');
  await user.type(screen.getByRole('textbox', { name: 'Range end' }), '7');
  await user.click(screen.getByRole('button', { name: 'Use feedback range' }));
  await user.type(screen.getByRole('textbox', { name: 'Replacement text' }), 'replacement');
  return user;
}
it('applies one exact original UTF-16 range and displays the server resulting revision and digest', async () => {
  const user = await prepare();
  await user.click(screen.getByRole('button', { name: 'Apply range correction' }));
  await waitFor(() => expect(correct).toHaveBeenCalledOnce());
  expect(correct.mock.calls[0][0]).toEqual({
    workspaceId: 'workspace-a',
    requestId: expect.any(String),
    target: {
      kind: 'material-range',
      materialId: 'material-a',
      revisionId: 'revision-1',
      contentDigest: digest,
      start: 3,
      end: 7,
      originalText: '😀e\u0301',
    },
    replacementText: 'replacement',
    decision: 'apply',
    note: null,
    extensions: {},
  });
  expect(await screen.findByText('Applied correction')).toBeVisible();
  expect(screen.getByText('revision-2')).toBeVisible();
  expect(screen.getByText(resultDigest)).toBeVisible();
  expect(screen.getByText('human-editor')).toBeVisible();
});
it('reports a stale correction without a resulting revision and keeps the typed replacement', async () => {
  correct.mockRejectedValue(new ApiCallError(409, 'internal', { code: 'stale' }));
  const user = await prepare();
  await user.click(screen.getByRole('button', { name: 'Apply range correction' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('stale');
  expect(screen.getByRole('textbox', { name: 'Replacement text' })).toHaveValue('replacement');
  expect(screen.queryByText('Applied correction')).not.toBeInTheDocument();
  expect(screen.queryByText('revision-2')).not.toBeInTheDocument();
});
it('records an explicit correction rejection without claiming a content change', async () => {
  const user = await prepare();
  await user.click(screen.getByRole('button', { name: 'Reject range correction' }));
  expect(await screen.findByText('Rejected correction')).toBeVisible();
  expect(correct.mock.calls[0][0].decision).toBe('reject');
  expect(screen.queryByText('revision-2')).not.toBeInTheDocument();
});

it('annotates the selected exact range without requesting a correction', async () => {
  add.mockImplementation(async (input) => ({
    judgement: {
      ...input.judgement,
      formatVersion: 1,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      actor: { kind: 'user', id: 'human-assessor' },
      recordedAt: '2026-10-17T03:00:00.000Z',
    },
  }));
  const user = await prepare();
  await user.click(screen.getByRole('button', { name: 'Record reject assessment' }));
  expect(await screen.findByText('human-assessor')).toBeVisible();
  expect(add.mock.calls[0][0].judgement).toEqual({
    kind: 'reject',
    target: {
      kind: 'material-range',
      materialId: 'material-a',
      revisionId: 'revision-1',
      contentDigest: digest,
      start: 3,
      end: 7,
      originalText: '😀e\u0301',
    },
    choice: null,
    note: null,
    extensions: {},
  });
  expect(correct).not.toHaveBeenCalled();
});
