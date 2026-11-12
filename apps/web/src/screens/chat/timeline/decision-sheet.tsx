import { useState } from 'react';
import { Button, TextField } from '../../../primitives';
import type { ThreadItem } from '../data';
import { fillCopy, timelineCopy } from './copy';
import { PhoneSheetFrame } from './PhoneChrome';
import { TimelineTime } from './TimelineTime';

type DecisionItem = Extract<ThreadItem, { type: 'approval-request' | 'user-input-request' }>;
type QuestionItem = Extract<ThreadItem, { type: 'user-input-request' }>;

/**
 * Full-height decision.
 * A question is shown once, and its answer field sits under that line.
 * Approve stays off until the exact effect is shown. The commit buttons stay in the bottom band.
 */
export function DecisionSheet({
  item,
  actor,
  blocking,
  effectText,
  pending,
  holdReason,
  more,
  onApprove,
  onDeny,
  onSubmitAnswers,
  onNext,
  onClose,
}: {
  item: DecisionItem;
  actor: string;
  blocking: boolean;
  effectText: string | null;
  pending?: boolean;
  holdReason?: string;
  more: number;
  onApprove?: () => void;
  onDeny?: () => void;
  onSubmitAnswers?: (userInputRequestId: string, answers: Record<string, [string]>) => void;
  onNext?: () => void;
  onClose: () => void;
}) {
  const question = item.type === 'user-input-request';
  const missing = !question && !effectText;
  const approveId = `sheet-approve-${item.id}`;
  const denyId = `sheet-deny-${item.id}`;
  const missingId = `sheet-missing-${item.id}`;
  const answerState = useQuestionAnswers(question ? item : null);
  return (
    <PhoneSheetFrame
      label={timelineCopy.decisionSheet}
      mode="full"
      onClose={onClose}
      footer={
        <div data-decision-footer="" className="flex flex-col gap-3">
          <p id={question ? `sheet-answer-${item.id}` : approveId}>
            {question ? timelineCopy.answerConsequence : timelineCopy.approveConsequence}
          </p>
          {!question ? <p id={denyId}>{timelineCopy.denyConsequence}</p> : null}
          {missing ? <p id={missingId}>{timelineCopy.exactEffectMissing}</p> : null}
          {holdReason ? <p>{holdReason}</p> : null}
          {question && answerState ? (
            <QuestionSubmit
              item={item}
              pending={Boolean(pending)}
              state={answerState}
              onSubmit={onSubmitAnswers}
            />
          ) : null}
          {!question ? (
            <div className="flex gap-2">
              <Button
                variant="negative-outline"
                className="min-h-11 flex-1"
                isDisabled={Boolean(pending)}
                aria-describedby={denyId}
                onPress={onDeny}
              >
                Deny
              </Button>
              <Button
                variant="accent"
                className="min-h-11 flex-1"
                isDisabled={missing || Boolean(pending)}
                aria-describedby={missing ? missingId : approveId}
                onPress={onApprove}
              >
                Approve
              </Button>
            </div>
          ) : null}
          {more > 0 && onNext ? (
            <button type="button" className="min-h-11 text-left" onClick={onNext}>
              {fillCopy(timelineCopy.nextDecision, { count: more })}
            </button>
          ) : null}
        </div>
      }
    >
      <div data-decision-body="" className="flex flex-col gap-3">
        {question && answerState ? (
          <QuestionBody item={item} pending={Boolean(pending)} state={answerState} />
        ) : (
          <p className="text-base font-medium text-fg">
            {item.type === 'approval-request' ? item.title : ''}
          </p>
        )}
        <p className="ok-meta">
          <span>{actor}</span>
          <span aria-hidden="true"> · </span>
          <TimelineTime iso={item.createdAt} />
        </p>
        <p className="ok-meta">
          {blocking ? timelineCopy.workIsWaiting : timelineCopy.workContinues}
        </p>
        {!question && effectText ? (
          <section aria-label="Complete exact effect">
            <pre className="overflow-auto whitespace-pre-wrap break-all">{effectText}</pre>
          </section>
        ) : null}
        {!question && !effectText ? <p>{timelineCopy.exactEffectMissing}</p> : null}
      </div>
    </PhoneSheetFrame>
  );
}

/**
 * One attention row whose request item is not in the loaded window.
 * The row's own title is shown. No question text is invented.
 */
export function DecisionRowSheet({
  title,
  createdAt,
  blocking,
  more,
  onNext,
  onClose,
}: {
  title: string;
  createdAt: string;
  blocking: boolean;
  more: number;
  onNext?: () => void;
  onClose: () => void;
}) {
  return (
    <PhoneSheetFrame
      label={timelineCopy.decisionSheet}
      mode="full"
      onClose={onClose}
      footer={
        more > 0 && onNext ? (
          <div data-decision-footer="">
            <button type="button" className="min-h-11 text-left" onClick={onNext}>
              {fillCopy(timelineCopy.nextDecision, { count: more })}
            </button>
          </div>
        ) : undefined
      }
    >
      <div data-decision-body="" className="flex flex-col gap-3">
        <p className="text-base font-medium text-fg">{title}</p>
        <p className="ok-meta">
          <TimelineTime iso={createdAt} />
        </p>
        <p className="ok-meta">
          {blocking ? timelineCopy.workIsWaiting : timelineCopy.workContinues}
        </p>
      </div>
    </PhoneSheetFrame>
  );
}

function useQuestionAnswers(item: QuestionItem | null) {
  const [forItem, setForItem] = useState(item?.id ?? '');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (!item) return null;
  if (forItem !== item.id) {
    setForItem(item.id);
    setAnswers({});
  }
  return {
    answers: forItem === item.id ? answers : {},
    setAnswers,
  };
}

function QuestionBody({
  item,
  pending,
  state,
}: {
  item: QuestionItem;
  pending: boolean;
  state: { answers: Record<string, string>; setAnswers: (value: Record<string, string>) => void };
}) {
  const seen = new Set<string>();
  const prompt = item.prompt.trim();
  const showPrompt = prompt.length > 0 && !seen.has(prompt);
  if (showPrompt) seen.add(prompt);
  return (
    <>
      {showPrompt ? <p className="text-base font-medium text-fg">{item.prompt}</p> : null}
      {item.questions.map((entry) => {
        const text = entry.question.trim();
        const showText = text.length > 0 && !seen.has(text);
        if (showText) seen.add(text);
        return (
          <div key={entry.id} className="flex flex-col gap-2">
            {showText ? <p className="text-base font-medium text-fg">{entry.question}</p> : null}
            <TextField
              label={entry.header}
              isDisabled={pending}
              value={state.answers[entry.id] ?? ''}
              onChange={(value) => state.setAnswers({ ...state.answers, [entry.id]: value })}
            />
          </div>
        );
      })}
    </>
  );
}

function QuestionSubmit({
  item,
  pending,
  state,
  onSubmit,
}: {
  item: QuestionItem;
  pending: boolean;
  state: { answers: Record<string, string> };
  onSubmit?: (userInputRequestId: string, answers: Record<string, [string]>) => void;
}) {
  const complete = item.questions.every((entry) => Boolean(state.answers[entry.id]?.trim()));
  const why = `sheet-answer-${item.id}`;
  return (
    <>
      {!complete && !pending ? <p id={`${why}-wait`}>Answer every question first.</p> : null}
      <Button
        className="min-h-11"
        isDisabled={!complete || pending || !onSubmit}
        aria-describedby={!complete || pending ? `${why}-wait` : why}
        onPress={() => {
          if (!onSubmit || !complete) return;
          onSubmit(
            item.userInputRequestId,
            Object.fromEntries(
              item.questions.map((entry) => [entry.id, [state.answers[entry.id] as string]])
            )
          );
        }}
      >
        {pending ? 'Submitting answers' : 'Submit answers'}
      </Button>
    </>
  );
}
