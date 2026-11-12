import type { SteerReceiptView, SteerReplay } from './steer';
import { steerCopy, steerOutcomeCopy, steerReplayFrom } from './steer';

/** Outcome line for one retained steer receipt. Check and Retry reuse that receipt. */
export function SteerOutcome({
  receipt,
  onReplay,
}: {
  receipt: SteerReceiptView;
  onReplay?: (replay: SteerReplay) => void;
}) {
  const replay = onReplay ? steerReplayFrom(receipt) : null;
  const copy = steerOutcomeCopy(receipt.state, receipt.reason);
  return (
    <div
      className="ok-outcome max-w-full break-words"
      data-request-id={receipt.requestId}
      data-steer-state={receipt.state}
      data-steer-text={receipt.text ?? ''}
      style={{ overflowWrap: 'anywhere' }}
    >
      <p role="status">{copy.title}</p>
      {copy.detail ? <p>{copy.detail}</p> : null}
      {replay && receipt.state === 'unknown' ? (
        <button type="button" className="min-h-11 underline" onClick={() => onReplay?.(replay)}>
          {steerCopy.check}
        </button>
      ) : null}
      {replay && receipt.state === 'not-delivered' ? (
        <button type="button" className="min-h-11 underline" onClick={() => onReplay?.(replay)}>
          {steerCopy.retry}
        </button>
      ) : null}
    </div>
  );
}
