import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { Item } from '../lib/app-types';
import { ApprovalCard } from './ApprovalCard';

const approvalItem: Extract<Item, { type: 'approval-request' }> = {
  id: 'it_approval',
  workspaceId: 'ws_demo',
  threadId: 'th_demo',
  turnId: 'tu_demo',
  type: 'approval-request',
  status: 'completed',
  approvalRequestId: 'ap_demo',
  title: 'Approve workspace update',
  description: 'Allow the simulator to continue to the question step.',
  kind: 'permission',
  createdAt: '2026-04-15T09:00:00.000Z',
  completedAt: '2026-04-15T09:00:00.000Z',
};

afterEach(() => {
  cleanup();
});

describe('ApprovalCard', () => {
  it('submits a grant decision', () => {
    const decisions: string[] = [];

    render(() => (
      <ApprovalCard
        disabled={false}
        item={approvalItem}
        onRespond={(_, decision) => {
          decisions.push(decision);
        }}
      />
    ));

    expect(screen.getByRole('heading', { name: /approve workspace update/i })).toBeInTheDocument();
    expect(screen.getByText(/allow the simulator/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(decisions).toEqual(['granted']);
  });

  it('submits a deny decision', () => {
    const decisions: string[] = [];

    render(() => (
      <ApprovalCard
        disabled={false}
        item={approvalItem}
        onRespond={(_, decision) => {
          decisions.push(decision);
        }}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: /deny/i }));

    expect(decisions).toEqual(['denied']);
  });
});
