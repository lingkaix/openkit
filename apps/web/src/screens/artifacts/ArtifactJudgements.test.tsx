import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtifactJudgements } from './ArtifactJudgements';

const { add, reviews } = vi.hoisted(() => ({ add: vi.fn(), reviews: vi.fn() }));
vi.mock('../../app/core-client', () => ({
  useCoreClient: () => ({
    operations: {
      'evaluation.judgement-add': add,
      'artifact.review-list': reviews,
    },
  }),
}));
const pin = {
  artifactId: 'artifact-a',
  artifactVersion: 1,
  contentDigest: `sha256:${'a'.repeat(64)}`,
};
const actor = { kind: 'user', id: 'human-reader' };
const recordedAt = '2026-10-17T01:00:00.000Z';
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  reviews.mockResolvedValue({ reviews: [] });
  add.mockImplementation(async (input) => ({
    judgement: {
      ...input.judgement,
      formatVersion: 1,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      actor,
      recordedAt,
    },
  }));
});
afterEach(() => client.clear());
function mount() {
  return render(
    <QueryClientProvider client={client}>
      <ArtifactJudgements workspaceId="workspace-a" {...pin} disabled={false} />
    </QueryClientProvider>
  );
}
it('records an exact historical version rating with explicit scale and displays server attribution', async () => {
  reviews.mockResolvedValue({
    reviews: [
      {
        workspaceId: 'workspace-a',
        ...pin,
        judgements: [
          {
            formatVersion: 1,
            workspaceId: 'workspace-a',
            requestId: 'earlier',
            kind: 'accept',
            target: { kind: 'artifact-version', ...pin },
            choice: null,
            note: 'Earlier assessment',
            extensions: {},
            actor: { kind: 'user', id: 'earlier-reviewer' },
            recordedAt,
          },
        ],
      },
    ],
  });
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Assess exact version' }));
  await user.type(await screen.findByRole('textbox', { name: 'Rating value' }), '4');
  await user.type(screen.getByRole('textbox', { name: 'Scale lower bound' }), '1');
  await user.type(screen.getByRole('textbox', { name: 'Scale upper bound' }), '5');
  await user.type(screen.getByRole('textbox', { name: 'Assessment note' }), 'Useful first draft');
  await user.click(screen.getByRole('button', { name: 'Record rating' }));
  await waitFor(() => expect(add).toHaveBeenCalledOnce());
  expect(add.mock.calls[0][0]).toEqual({
    workspaceId: 'workspace-a',
    requestId: expect.any(String),
    judgement: {
      kind: 'rate',
      target: { kind: 'artifact-version', ...pin },
      choice: { value: 4, lowerBound: 1, upperBound: 5 },
      note: 'Useful first draft',
      extensions: {},
    },
  });
  expect(await screen.findByText('human-reader')).toBeVisible();
  expect(screen.getAllByText(recordedAt)).toHaveLength(2);
  expect(screen.getByText('earlier-reviewer')).toBeVisible();
  expect(screen.getByText('4 on scale 1–5')).toBeVisible();
  expect(screen.getByText('Useful first draft', { selector: 'p' })).toBeVisible();
});
it('retains an unknown assessment request and hides history after a current read failure', async () => {
  add.mockRejectedValueOnce(new Error('network lost'));
  const view = mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Assess exact version' }));
  await user.type(
    await screen.findByRole('textbox', { name: 'Assessment note' }),
    'Keep this draft'
  );
  await user.click(screen.getByRole('button', { name: 'Record accept assessment' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('result is unknown');
  expect(screen.getByRole('button', { name: 'Record reject assessment' })).toBeDisabled();
  const attempted = add.mock.calls[0][0];
  view.rerender(
    <QueryClientProvider client={client}>
      <ArtifactJudgements workspaceId="workspace-a" {...pin} disabled={false} unavailable />
    </QueryClientProvider>
  );
  expect(screen.getByRole('textbox', { name: 'Assessment note' })).toHaveValue('Keep this draft');
  expect(screen.getByRole('textbox', { name: 'Assessment note' })).toBeDisabled();
  view.rerender(
    <QueryClientProvider client={client}>
      <ArtifactJudgements workspaceId="workspace-a" {...pin} disabled={false} />
    </QueryClientProvider>
  );
  expect(screen.getByRole('textbox', { name: 'Assessment note' })).toHaveValue('Keep this draft');
  await user.click(screen.getByRole('button', { name: 'Retry same request' }));
  await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
  expect(add.mock.calls[1][0]).toEqual(attempted);
  expect(await screen.findByText('human-reader')).toBeVisible();
  reviews.mockRejectedValue(new Error('access changed'));
  await act(async () => {
    await client.invalidateQueries();
  });
  expect(await screen.findByText("Couldn't load assessment history.")).toBeVisible();
  expect(screen.queryByText('human-reader')).not.toBeInTheDocument();
});
