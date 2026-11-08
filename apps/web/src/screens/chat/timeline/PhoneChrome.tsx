import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { usePersistentNavigation } from '../../../app/AppShell';
import { Button, Icon, TextField } from '../../../primitives';
import type { ThreadItem } from '../data';
import { fillCopy, timelineCopy } from './copy';
import type { NowModel } from './now';
import { closeSheetSearch, openSheetSearch, phoneBarLabel, type SheetKind } from './phone';
import { TimelineTime } from './TimelineTime';

export interface TimelineSheets {
  phone: boolean;
  decisionId: string | null;
  stepsTurnId: string | null;
  inspectTurnId: string | null;
  open: (kind: SheetKind, id: string, mode?: 'push' | 'replace') => void;
  close: () => void;
}

/** URL-backed sheets. Back pops the entry and stays on the Thread. */
export function useTimelineSheets(): TimelineSheets {
  const phone = !usePersistentNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const opener = useRef<HTMLElement | null>(null);
  const decisionId = searchParams.get('decision');
  const stepsTurnId = searchParams.get('steps');
  const inspectTurnId = searchParams.get('inspect');
  const open = (kind: SheetKind, id: string, mode: 'push' | 'replace' = 'push') => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const search = openSheetSearch(searchParams.toString(), kind, id);
    navigate(
      { pathname: location.pathname, search },
      { replace: mode === 'replace', state: { okSheet: kind } }
    );
  };
  const close = () => {
    const state = history.state as { usr?: { okSheet?: string }; okSheet?: string } | null;
    if (state?.usr?.okSheet || state?.okSheet) {
      navigate(-1);
      return;
    }
    setSearchParams(closeSheetSearch(searchParams.toString()), { replace: true });
  };
  useEffect(() => {
    if (decisionId || stepsTurnId || inspectTurnId) return;
    const target = opener.current;
    if (!target) return;
    opener.current = null;
    target.focus();
  }, [decisionId, inspectTurnId, stepsTurnId]);
  return { phone, decisionId, stepsTurnId, inspectTurnId, open, close };
}

/** Sticky Now and Needs you line. Tapping opens the next decision. */
export function PhoneBar({
  now,
  needsCount,
  reducedMotion,
  onOpen,
}: {
  now: NowModel;
  needsCount: number;
  reducedMotion: boolean;
  onOpen?: () => void;
}) {
  const nowText = now.kind === 'hidden' ? null : now.text;
  const label = phoneBarLabel(nowText, needsCount);
  if (!label) return null;
  const live = !reducedMotion && (now.kind === 'step' || now.kind === 'thinking') && now.live;
  const className = 'ok-meta flex min-h-11 w-full items-center gap-2 text-left';
  const body = (
    <>
      <span className="ok-now-dot" data-live={live ? 'true' : 'false'} aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </>
  );
  if (!onOpen) {
    return (
      <p data-phone-bar="true" className={className}>
        {body}
      </p>
    );
  }
  return (
    <button type="button" data-phone-bar="true" className={className} onClick={onOpen}>
      {body}
    </button>
  );
}

export function PhoneSheetFrame({
  label,
  mode,
  expanded,
  onExpand,
  onClose,
  children,
  footer,
}: {
  label: string;
  mode: 'full' | 'partial';
  expanded?: boolean;
  onExpand?: () => void;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const full = mode === 'full' || expanded === true;
  return (
    <div className="fixed inset-0 z-40 flex flex-col">
      {mode === 'partial' && !full ? <div className="min-h-0 flex-1" aria-hidden="true" /> : null}
      <div
        role="dialog"
        aria-label={label}
        data-sheet={mode}
        data-expanded={full ? 'true' : 'false'}
        className={`flex flex-col bg-layer-1 shadow-ok-modal ${full ? 'h-full' : 'h-[60vh] rounded-t-ok-xl border border-separator'}`}
      >
        {mode === 'partial' ? (
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-center"
            aria-label={expanded ? timelineCopy.collapseSheet : timelineCopy.expandSheet}
            onClick={onExpand}
          >
            <span className="h-1 w-10 rounded-full bg-border" aria-hidden="true" />
          </button>
        ) : null}
        <div className="flex items-center justify-between gap-2 px-3">
          <h2 className="text-sm font-semibold text-fg">{label}</h2>
          <Button
            size="sm"
            variant="quiet"
            aria-label={timelineCopy.closeSheet}
            className="min-h-11 min-w-11 shrink-0 px-0!"
            onPress={onClose}
          >
            <Icon name="close" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4">{children}</div>
        {footer ? (
          <div
            className={mode === 'full' ? 'flex min-h-[40%] flex-col gap-3 px-4 pt-3' : 'px-4 pb-4'}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Full-height decision. Approve stays off until the exact effect is shown. */
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
  item: Extract<ThreadItem, { type: 'approval-request' | 'user-input-request' }>;
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
  return (
    <PhoneSheetFrame
      label={timelineCopy.decisionSheet}
      mode="full"
      onClose={onClose}
      footer={
        <>
          <p id={question ? `sheet-answer-${item.id}` : approveId}>
            {question ? timelineCopy.answerConsequence : timelineCopy.approveConsequence}
          </p>
          {!question ? <p id={denyId}>{timelineCopy.denyConsequence}</p> : null}
          {missing ? <p id={missingId}>{timelineCopy.exactEffectMissing}</p> : null}
          {holdReason ? <p>{holdReason}</p> : null}
          {question ? (
            <QuestionActions item={item} pending={Boolean(pending)} onSubmit={onSubmitAnswers} />
          ) : (
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
          )}
          {more > 0 && onNext ? (
            <button type="button" className="min-h-11 text-left" onClick={onNext}>
              {fillCopy(timelineCopy.nextDecision, { count: more })}
            </button>
          ) : null}
        </>
      }
    >
      <p className="text-base font-medium text-fg">{question ? item.prompt : item.title}</p>
      <p className="ok-meta mt-2">
        <span>{actor}</span>
        <span aria-hidden="true"> · </span>
        <TimelineTime iso={item.createdAt} />
      </p>
      <p className="ok-meta mt-2">
        {blocking ? timelineCopy.workIsWaiting : timelineCopy.workContinues}
      </p>
      {question ? (
        <div className="mt-4 flex flex-col gap-3">
          {item.questions.map((entry) => (
            <p key={entry.id}>{entry.question}</p>
          ))}
        </div>
      ) : effectText ? (
        <section className="mt-4" aria-label="Complete exact effect">
          <pre className="overflow-auto whitespace-pre-wrap break-all">{effectText}</pre>
        </section>
      ) : (
        <p className="mt-4">{timelineCopy.exactEffectMissing}</p>
      )}
    </PhoneSheetFrame>
  );
}

function QuestionActions({
  item,
  pending,
  onSubmit,
}: {
  item: Extract<ThreadItem, { type: 'user-input-request' }>;
  pending: boolean;
  onSubmit?: (userInputRequestId: string, answers: Record<string, [string]>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete = item.questions.every((entry) => Boolean(answers[entry.id]?.trim()));
  const why = `sheet-answer-${item.id}`;
  return (
    <div className="flex flex-col gap-3">
      {item.questions.map((entry) => (
        <TextField
          key={entry.id}
          label={entry.header}
          isDisabled={pending}
          value={answers[entry.id] ?? ''}
          onChange={(value) => setAnswers((current) => ({ ...current, [entry.id]: value }))}
        />
      ))}
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
              item.questions.map((entry) => [entry.id, [answers[entry.id] as string]])
            )
          );
        }}
      >
        {pending ? 'Submitting answers' : 'Submit answers'}
      </Button>
    </div>
  );
}
