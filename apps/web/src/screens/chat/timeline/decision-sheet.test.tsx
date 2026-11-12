import { ItemSchema } from '@openkit/protocol';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DecisionRowSheet, DecisionSheet } from './decision-sheet';
import { TimelineNowProvider } from './time';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');

const question = ItemSchema.parse({
  id: 'it_00000000-0000-722b-8b9c-ef21b6ead700',
  owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0' },
  threadId: 'th_00000000-0000-70a0-9cde-4561f64881c6',
  turnId: 'tu_00000000-0000-7da3-a7fc-80982f9b215e',
  type: 'user-input-request',
  status: 'completed',
  responsibleUserId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
  userInputRequestId: 'uir1',
  prompt: 'Which date format should exports use?',
  questions: [
    {
      id: 'tone',
      header: 'Tone',
      question: 'Which date format should exports use?',
      options: null,
      isOther: false,
      isSecret: false,
    },
  ],
  createdAt: '2026-11-08T12:00:30.000Z',
  completedAt: '2026-11-08T12:00:30.000Z',
});

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

describe('decision sheet', () => {
  it('shows a question once and puts the answer field under it', () => {
    if (question.type !== 'user-input-request') throw new Error('expected a question');
    render(
      <TimelineNowProvider now={NOW}>
        <DecisionSheet
          item={question}
          actor="Worker"
          blocking={false}
          effectText={null}
          more={0}
          onSubmitAnswers={() => {}}
          onClose={() => {}}
        />
      </TimelineNowProvider>
    );
    expect(screen.getAllByText('Which date format should exports use?')).toHaveLength(1);
    const field = screen.getByRole('textbox', { name: 'Tone' });
    const body = document.querySelector('[data-decision-body]');
    const footer = document.querySelector('[data-decision-footer]');
    expect(body).toContainElement(field);
    expect(footer).not.toContainElement(field);
    const questionText = screen.getByText('Which date format should exports use?');
    expect(questionText.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(footer).toContainElement(screen.getByRole('button', { name: 'Submit answers' }));
    expect(footer?.parentElement?.className).toContain('min-h-[40%]');
    expect(screen.getByText('0 s ago')).toBeInTheDocument();
    expect(screen.queryByText(/Nov/)).not.toBeInTheDocument();
  });

  it('keeps Approve off while the exact effect is missing', () => {
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
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/Exact effect unavailable/);
    expect(screen.getByRole('button', { name: 'Next decision (2 more) ›' })).toBeInTheDocument();
  });

  it('shows an attention row when its request is not loaded', () => {
    render(
      <TimelineNowProvider now={NOW}>
        <DecisionRowSheet
          title="Choose a date format for exports"
          createdAt="2026-11-08T11:00:00.000Z"
          blocking
          more={1}
          onNext={() => {}}
          onClose={() => {}}
        />
      </TimelineNowProvider>
    );
    expect(screen.getByText('Choose a date format for exports')).toBeInTheDocument();
    expect(screen.getByText('Work is waiting')).toBeInTheDocument();
    expect(screen.getByText('1 h ago')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next decision (1 more) ›' })).toBeInTheDocument();
  });
});
