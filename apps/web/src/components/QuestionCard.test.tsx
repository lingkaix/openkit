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
  ],
  createdAt: '2026-04-15T09:00:00.000Z',
  completedAt: '2026-04-15T09:00:00.000Z',
};

afterEach(() => {
  cleanup();
});

describe('QuestionCard', () => {
  it('submits the typed answer', () => {
    const answers: string[] = [];

    render(() => (
      <QuestionCard
        disabled={false}
        item={questionItem}
        onSubmit={(_, answer) => {
          answers.push(answer);
        }}
      />
    ));

    expect(screen.getByRole('heading', { name: /tone/i })).toBeInTheDocument();
    fireEvent.input(screen.getByLabelText(/answer/i), {
      target: { value: 'Concise' },
    });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    expect(answers).toEqual(['Concise']);
  });
});
