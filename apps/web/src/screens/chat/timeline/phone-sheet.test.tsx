import { ItemSchema } from '@openkit/protocol';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { barDecisionTarget, openDecisionsAfter } from './needs-you';
import { DecisionSheet, PhoneSheetFrame } from './PhoneChrome';

const approval = ItemSchema.parse({
  id: 'it_00000000-0000-7570-9913-dd37f2bda2fe',
  owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0' },
  threadId: 'th_00000000-0000-70a0-9cde-4561f64881c6',
  turnId: 'tu_00000000-0000-7da3-a7fc-80982f9b215e',
  type: 'approval-request',
  status: 'completed',
  approvalRequestId: 'ap1',
  title: 'Publish the weekly summary',
  description: 'Post it once.',
  kind: 'permission',
  createdAt: '2026-07-21T00:00:02.000Z',
  completedAt: '2026-07-21T00:00:02.000Z',
});

describe('phone bar decision target', () => {
  const question = { id: 'it_question' };
  const walk = [
    { key: 'artifact-review:rev', rowId: 'artifact-review:rev', item: null },
    { key: 'it_question', rowId: 'question:1', itemId: 'it_question', item: question },
  ];

  it('opens the loaded question ahead of a review row the sheet cannot answer', () => {
    expect(barDecisionTarget(walk, ['it_question'])).toBe('it_question');
    expect(
      barDecisionTarget(
        [{ key: 'artifact-review:rev', rowId: 'artifact-review:rev', item: null }],
        ['it_question']
      )
    ).toBe('it_question');
  });

  it('does not offer a review row as the next decision', () => {
    expect(openDecisionsAfter(walk, 'it_question', ['it_question'])).toEqual({
      count: 0,
      nextKey: null,
    });
  });
});

describe('steps sheet', () => {
  it('traps focus and closes from the keyboard', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PhoneSheetFrame label="Steps" mode="partial" onClose={onClose}>
        <button type="button">Earlier</button>
      </PhoneSheetFrame>
    );
    const dialog = screen.getByRole('dialog', { name: 'Steps' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('decision sheet', () => {
  it('shows the consequence and keeps Approve off while the exact effect is missing', () => {
    if (approval.type !== 'approval-request') throw new Error('expected an approval');
    render(
      <DecisionSheet
        item={approval}
        actor="Worker"
        blocking={false}
        effectText={null}
        more={2}
        onNext={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Lets this call run once.')).toBeInTheDocument();
    expect(screen.getByText('The call does not run.')).toBeInTheDocument();
    expect(screen.getByText('Work continues meanwhile')).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/Exact effect unavailable/);
    expect(screen.getByRole('button', { name: 'Next decision (2 more) ›' })).toBeInTheDocument();
  });

  it('enables Approve once the exact effect is shown', () => {
    if (approval.type !== 'approval-request') throw new Error('expected an approval');
    render(
      <DecisionSheet
        item={approval}
        actor="Worker"
        blocking
        effectText={'slack.post_message\n{"channel":"#team"}'}
        more={0}
        onApprove={() => {}}
        onDeny={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByText('Work is waiting')).toBeInTheDocument();
    expect(screen.getByText(/slack.post_message/)).toBeInTheDocument();
  });
});
