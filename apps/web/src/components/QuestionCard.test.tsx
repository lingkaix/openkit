import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { Item } from '../lib/app-types';
import { QuestionCard } from './QuestionCard';

const questionItem: Extract<Item, { type: 'user-input-request' }> = {
  id: 'it_question',
  workspaceId: 'ws_demo',
  threadId: 'th_demo',
  turnId: 'tu_demo',
  type: 'user-input-request',
  status: 'completed',
  userInputRequestId: 'question_demo',
  prompt: 'Which summary tone should the simulator use?',
  questions: [
    {
      id: 'tone',
      header: 'Tone',
      question: 'Which summary tone should the simulator use?',
      options: null,
      isOther: false,
      isSecret: false,
    },
    {
      id: 'format',
      header: 'Format',
      question: 'Which output format should the simulator use?',
      options: null,
      isOther: false,
      isSecret: false,
    },
  ],
  createdAt: '2026-04-15T09:00:00.000Z',
  completedAt: '2026-04-15T09:00:00.000Z',
};

afterEach(() => {
  cleanup();
});

describe('QuestionCard', () => {
  it('submits one exact answer for every question', () => {
    const submissions: Array<Record<string, [string]>> = [];

    render(() => (
      <QuestionCard
        disabled={false}
        item={questionItem}
        onSubmit={(_, answers) => {
          submissions.push(answers);
        }}
      />
    ));

    expect(screen.getByRole('heading', { name: /tone/i })).toBeInTheDocument();
    fireEvent.input(screen.getByLabelText(/tone answer/i), {
      target: { value: 'Concise' },
    });
    fireEvent.input(screen.getByLabelText(/format answer/i), {
      target: { value: 'Markdown' },
    });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    expect(submissions).toEqual([{ tone: ['Concise'], format: ['Markdown'] }]);
  });
});
