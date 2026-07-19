import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Turn } from '../lib/app-types';
import { TurnFeedback } from './TurnFeedback';

const completedTurn: Turn = {
  id: 'turn_demo',
  workspaceId: 'ws_demo',
  threadId: 'th_demo',
  triggerActor: { kind: 'user', id: 'user_demo' },
  items: [],
  status: 'completed',
  humanGate: null,
  error: null,
  startedAt: '2026-04-15T09:00:00.000Z',
  completedAt: '2026-04-15T09:01:00.000Z',
  durationMs: 60_000,
  configVersion: null,
};

afterEach(() => {
  cleanup();
});

describe('TurnFeedback', () => {
  it('submits a good rating and note for the most recent completed turn', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(() => <TurnFeedback onSubmit={onSubmit} turn={completedTurn} />);

    fireEvent.click(screen.getByRole('button', { name: /good/i }));
    fireEvent.input(screen.getByLabelText(/feedback note/i), {
      target: { value: 'This response had the right level of detail.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /submit feedback/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('turn_demo', {
        rating: 'good',
        note: 'This response had the right level of detail.',
      });
    });
    expect(await screen.findByText(/feedback saved/i)).toBeInTheDocument();
  });

  it('shows an inline error when the feedback API fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Feedback service is unavailable.'));

    render(() => <TurnFeedback onSubmit={onSubmit} turn={completedTurn} />);

    fireEvent.click(screen.getByRole('button', { name: /bad/i }));
    fireEvent.input(screen.getByLabelText(/feedback note/i), {
      target: { value: 'The turn missed the required command output.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /submit feedback/i }));

    expect(await screen.findByText(/feedback service is unavailable/i)).toBeInTheDocument();
  });
});
