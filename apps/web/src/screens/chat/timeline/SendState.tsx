import { timelineCopy } from './copy';
import { classifySendFailure, sendFailureCopy } from './degraded';

/** Sending is its own state and is never styled as a sent message. */
export function SendPending() {
  return (
    <p role="status" data-send-state="sending" className="ok-send-pending mb-2">
      {timelineCopy.sending}
    </p>
  );
}

/** Sending, not-sent, unknown, or a kept draft. A retry reuses the caller's request id. */
export function SendFailure({
  error,
  requestId,
  onRetry,
  onEdit,
}: {
  error: unknown;
  requestId?: string;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const kind = classifySendFailure(error);
  const copy = sendFailureCopy(kind);
  return (
    <div className="mb-2 flex flex-col gap-2" data-send-state={kind} data-request-id={requestId}>
      <p role="alert" className="text-xs font-medium text-negative-fg">
        {copy}
      </p>
      <div className="flex gap-2">
        {kind === 'unknown' ? (
          <button type="button" className="min-h-11 underline" onClick={onRetry}>
            {timelineCopy.checkSend}
          </button>
        ) : null}
        {kind === 'not-sent' ? (
          <button type="button" className="min-h-11 underline" onClick={onRetry}>
            {timelineCopy.retry}
          </button>
        ) : null}
        <button type="button" className="min-h-11 underline" onClick={onEdit}>
          {timelineCopy.editDraft}
        </button>
      </div>
    </div>
  );
}
