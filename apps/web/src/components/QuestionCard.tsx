import { createMemo, createSignal, For } from 'solid-js';

import type { Item } from '../lib/app-types';

type UserInputRequestItem = Extract<Item, { type: 'user-input-request' }>;
/** Exact protocol answer map returned for one user-input request. */
type UserInputResponseAnswers = Extract<Item, { type: 'user-input-response' }>['answers'];

/**
 * Props for one inline agent question card.
 */
export interface QuestionCardProps {
  disabled: boolean;
  item: UserInputRequestItem;
  onSubmit(item: UserInputRequestItem, answers: UserInputResponseAnswers): void;
}

/**
 * Renders an inline agent question and answer form.
 */
export function QuestionCard(props: QuestionCardProps) {
  const [answers, setAnswers] = createSignal<Record<string, string>>({});
  const canSubmit = createMemo(
    () =>
      props.item.questions.length > 0 &&
      props.item.questions.every((question) => answers()[question.id]?.trim()) &&
      !props.disabled
  );

  /**
   * Submits one exact answer for every question.
   */
  function submitAnswer(event: SubmitEvent): void {
    event.preventDefault();
    if (!canSubmit()) {
      return;
    }
    const values: UserInputResponseAnswers = {};
    for (const question of props.item.questions) {
      values[question.id] = [answers()[question.id]?.trim() ?? ''];
    }
    props.onSubmit(props.item, values);
  }

  return (
    <form class="approval-placeholder" onSubmit={submitAnswer}>
      <div>
        <span class="badge badge-outline badge-sm">question</span>
        <p class="mt-1 text-sm opacity-70">{props.item.prompt}</p>
      </div>
      <For each={props.item.questions}>
        {(question) => (
          <label class="form-control mt-4">
            <h3 class="font-semibold">{question.header}</h3>
            <span class="label-text mt-1">{question.question}</span>
            <input
              aria-label={`${question.header} answer`}
              class="input input-bordered"
              disabled={props.disabled}
              onInput={(event) =>
                setAnswers((current) => ({
                  ...current,
                  [question.id]: event.currentTarget.value,
                }))
              }
              type={question.isSecret ? 'password' : 'text'}
              value={answers()[question.id] ?? ''}
            />
          </label>
        )}
      </For>
      <button class="btn btn-neutral btn-sm mt-3" disabled={!canSubmit()} type="submit">
        Submit
      </button>
    </form>
  );
}
