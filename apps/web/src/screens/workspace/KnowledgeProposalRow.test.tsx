import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import type { AttentionRow } from './data';
import { KnowledgeProposalRow } from './KnowledgeProposalRow';

it('requires all exact diff parts before acceptance and keeps a failed read unavailable until retry', async () => {
  const user = userEvent.setup();
  const source = {
    type: 'knowledge' as const,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    knowledgeProposalId: 'kp_00000000-0000-7000-8000-000000000001',
    proposalDigest: `sha256:${'a'.repeat(64)}`,
    baseRevision: 'saved-base',
    candidateRevision: 'saved-candidate',
    status: 'pending' as const,
  };
  const identity = {
    proposalId: source.knowledgeProposalId,
    proposalDigest: source.proposalDigest,
    baseRevision: source.baseRevision,
    candidateRevision: source.candidateRevision,
    paths: ['notes.md'],
  };
  let failed = false;
  const read = vi.fn(async (input: { path?: string; offset?: number }) => {
    if (!input.path) return identity;
    if (!failed) {
      failed = true;
      throw new Error('Source temporarily unavailable.');
    }
    return input.offset
      ? { ...identity, path: 'notes.md', before: 'old tail', after: 'new tail', nextOffset: null }
      : { ...identity, path: 'notes.md', before: 'old head', after: 'new head', nextOffset: 9 };
  });
  const decide = vi.fn();
  const row = {
    id: 'proposal',
    kind: 'knowledge_review',
    workspaceId: source.workspaceId,
    title: 'Review notebook changes',
    summary: 'A short summary cannot prove the diff.',
    severity: 'needs_input',
    createdAt: '2026-10-17T00:00:00.000Z',
    source,
    actions: [{ kind: 'accept_knowledge', label: 'Accept', method: 'POST' }],
  } as AttentionRow;
  const client = { operations: { 'knowledge.proposal.read': read } } as unknown as CoreClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <KnowledgeProposalRow row={row} blocked={false} onDecide={decide} />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  const accept = screen.getByRole('button', { name: 'Accept' });
  expect(accept).toBeDisabled();
  await user.click(accept);
  expect(decide).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Inspect changes' }));
  await user.click(await screen.findByRole('button', { name: 'Read notes.md' }));
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't read notes.md");
  expect(accept).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('region', { name: 'notes.md after, part 1' })).toHaveTextContent(
    'new head'
  );
  expect(screen.getByRole('button', { name: 'Mark notes.md inspected' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Read next part of notes.md' }));
  expect(await screen.findByRole('region', { name: 'notes.md after, part 2' })).toHaveTextContent(
    'new tail'
  );
  await user.click(screen.getByRole('button', { name: 'Mark notes.md inspected' }));
  await waitFor(() => expect(accept).toBeEnabled());
  await user.click(accept);
  expect(decide).toHaveBeenCalledWith({ source, decision: 'accepted' });
  expect(read).toHaveBeenLastCalledWith({
    workspaceId: source.workspaceId,
    proposalId: source.knowledgeProposalId,
    path: 'notes.md',
    offset: 9,
  });
});
