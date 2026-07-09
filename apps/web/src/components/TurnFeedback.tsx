import { createMemo, createSignal, Show } from 'solid-js';

import type { Turn } from '../lib/app-types';

export type TurnFeedbackRating = 'good' | 'bad' | null;

export interface TurnFeedbackInput {
  rating: TurnFeedbackRating;
  note: string | null;
}

/**
 * Props for the most recent completed turn feedback affordance.
 */
export interface TurnFeedbackProps {
  turn: Turn | null;
  onSubmit(turnId: string, input: TurnFeedbackInput): Promise<void>;
}

/**
 * Renders rating and note controls for a completed turn.
 */
export function TurnFeedback(props: TurnFeedbackProps) {
  const [rating, setRating] = createSignal<TurnFeedbackRating>(null);
  const [note, setNote] = createSignal('');
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [confirmationMessage, setConfirmationMessage] = createSignal<string | null>(null);
  const canSubmit = createMemo(() => props.turn?.status === 'completed' && !isSubmitting());

  /**
   * Submits the selected feedback through the parent API handler.
   */
  async function submitFeedback(event: SubmitEvent): Promise<void> {
    event.preventDefault();

    if (!props.turn || props.turn.status !== 'completed') {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setConfirmationMessage(null);

    try {
      await props.onSubmit(props.turn.id, {
        rating: rating(),
        note: note().trim().length > 0 ? note().trim() : null,
      });
      setConfirmationMessage('Feedback saved.');
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Show when={props.turn?.status === 'completed'}>
      <form class="workspace-panel space-y-3" onSubmit={(event) => void submitFeedback(event)}>
        <div class="ui-section-header flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-display text-lg font-semibold text-base-content">Turn feedback</h2>
          <span class="badge badge-outline">{props.turn?.id}</span>
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            aria-pressed={rating() === 'good'}
            class={`btn btn-sm ${rating() === 'good' ? 'btn-success' : 'btn-outline'}`}
            onClick={() => setRating('good')}
            type="button"
          >
            Good
          </button>
          <button
            aria-pressed={rating() === 'bad'}
            class={`btn btn-sm ${rating() === 'bad' ? 'btn-error' : 'btn-outline'}`}
            onClick={() => setRating('bad')}
            type="button"
          >
            Bad
          </button>
        </div>

        <label class="form-control ui-field">
          <span class="label-text">Feedback note</span>
          <textarea
            class="textarea textarea-bordered min-h-24"
            name="feedbackNote"
            onInput={(event) => setNote(event.currentTarget.value)}
            placeholder="Leave an optional dogfooding note."
            value={note()}
          />
        </label>

        <div class="flex flex-wrap items-center gap-3">
          <button class="btn btn-neutral btn-sm" disabled={!canSubmit()} type="submit">
            Submit feedback
          </button>
          <Show when={confirmationMessage()}>
            <span class="text-sm text-success">{confirmationMessage()}</span>
          </Show>
          <Show when={errorMessage()}>
            <span class="text-sm text-error">{errorMessage()}</span>
          </Show>
        </div>
      </form>
    </Show>
  );
}
