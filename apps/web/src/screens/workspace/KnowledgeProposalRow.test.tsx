import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import type { AttentionRow } from './data';
import { KnowledgeProposalRow } from './KnowledgeProposalRow';
import { composeUserAuthoredKnowledgePage } from './knowledge-okf';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const activePage = composeUserAuthoredKnowledgePage({
  workspaceId,
  path: 'notes.md',
  title: 'Whole page',
  body: 'new tail',
  timestamp: '2026-10-17T00:00:00.000Z',
});
const lifecycleLabel =
  /^(active|draft, excluded from ordinary retrieval|archived|superseded|invalid|deleted)$/;

it.each([
  {
    lifecycle: 'draft',
    candidate: activePage.replace('status: active\nstatus: stable', 'status: draft\nstatus: draft'),
    label: 'draft, excluded from ordinary retrieval',
  },
  {
    lifecycle: 'active with expired freshness',
    candidate: activePage.replace('freshness: current', 'freshness: expired'),
    label: 'active',
  },
  ...['archived', 'superseded', 'invalid', 'deleted'].map((state) => ({
    lifecycle: state,
    candidate: activePage.replace(
      'status: active\nstatus: stable',
      `status: ${state}\nstatus: deprecated`
    ),
    label: state,
  })),
  {
    lifecycle: 'duplicate lifecycle keys',
    candidate: activePage.replace(
      'openkit_status: active',
      'openkit_status: draft\nopenkit_status: active'
    ),
    label: null,
  },
  {
    lifecycle: 'unclosed frontmatter',
    candidate: activePage.replace('\n---\n', '\n'),
    label: null,
  },
  {
    lifecycle: 'malformed YAML in another field',
    candidate: activePage.replace('\n---\n', '\nreview_extra: [\n---\n'),
    label: null,
  },
  {
    lifecycle: 'non-mapping YAML',
    candidate: '---\n- openkit_status: active\n---\nnew tail\n',
    label: null,
  },
  {
    lifecycle: 'YAML conversion failure',
    candidate: activePage.replace('\n---\n', '\nreview_extra: *missing\n---\n'),
    label: null,
  },
])(
  'keeps the exact diff and checks the lifecycle label for $lifecycle',
  async ({ candidate, label }) => {
    const user = userEvent.setup();
    const offset = candidate.indexOf('openkit_status:') + 'openkit_st'.length;
    const firstPart = candidate.slice(0, offset);
    const after = candidate.slice(offset);
    const source = {
      type: 'knowledge' as const,
      workspaceId,
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
        ? {
            ...identity,
            path: 'notes.md',
            before: 'old tail',
            after,
            nextOffset: null,
          }
        : {
            ...identity,
            path: 'notes.md',
            before: 'old head',
            after: firstPart,
            nextOffset: firstPart.length,
          };
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
    expect(
      screen.getByRole('button', { name: 'Inspect changes', expanded: false })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Inspect changes', expanded: false }));
    expect(
      screen.getByRole('button', { name: 'Hide changes', expanded: true })
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Read notes.md', expanded: false })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Read notes.md', expanded: false }));
    expect(
      screen.getByRole('button', { name: 'Hide notes.md', expanded: true })
    ).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't read notes.md");
    expect(accept).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      (await screen.findByRole('region', { name: 'notes.md after, part 1' })).textContent
    ).toBe(firstPart);
    expect(screen.queryByText(lifecycleLabel)).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark notes.md inspected' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Read next part of notes.md' }));
    expect(
      (await screen.findByRole('region', { name: 'notes.md after, part 2' })).textContent
    ).toBe(after);
    if (label) {
      expect(screen.getByText(label, { exact: true })).toBeVisible();
    } else {
      expect(screen.queryByText(lifecycleLabel)).toBeNull();
    }
    await user.click(screen.getByRole('button', { name: 'Mark notes.md inspected' }));
    await waitFor(() => expect(accept).toBeEnabled());
    await user.click(accept);
    expect(decide).toHaveBeenCalledWith({ source, decision: 'accepted' });
    expect(read).toHaveBeenLastCalledWith({
      workspaceId: source.workspaceId,
      proposalId: source.knowledgeProposalId,
      path: 'notes.md',
      offset: firstPart.length,
    });
  }
);
