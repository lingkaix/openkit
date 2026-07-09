import { createMemo, createSignal } from 'solid-js';

import type { Item } from '../lib/app-types';

type UserInputRequestItem = Extract<Item, { type: 'user-input-request' }>;

/**
 * Props for one inline agent question card.
 */
export interface QuestionCardProps {
  disabled: boolean;
  item: UserInputRequestItem;
  onSubmit(item: UserInputRequestItem, answer: string): void;
}

/**
 * Renders an inline agent question and answer form.
 */
export function QuestionCard(props: QuestionCardProps) {
  const [answer, setAnswer] = createSignal('');
  const primaryQuestion = createMemo(() => props.item.questions[0] ?? null);
  const canSubmit = createMemo(() => answer().trim().length > 0 && !props.disabled);

  /**
   * Submits the current answer value.
   */
  function submitAnswer(event: SubmitEvent): void {
    event.preventDefault();
    const value = answer().trim();

    if (!value) {
      return;
    }

    props.onSubmit(props.item, value);
  }

  return (
    <form class="approval-placeholder" onSubmit={submitAnswer}>
      <div>
        <span class="badge badge-outline badge-sm">question</span>
        <h3 class="mt-2 font-semibold">{primaryQuestion()?.header ?? 'Question'}</h3>
        <p class="mt-1 text-sm opacity-70">{props.item.prompt}</p>
      </div>
      <label class="form-control mt-4">
        <span class="label-text">Answer</span>
        <input
          class="input input-bordered"
          disabled={props.disabled}
          onInput={(event) => setAnswer(event.currentTarget.value)}
          value={answer()}
        />
      </label>
      <button class="btn btn-neutral btn-sm mt-3" disabled={!canSubmit()} type="submit">
        Submit
      </button>
    </form>
  );
}
