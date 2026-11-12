import type { TurnErrorPresentation } from '@openkit/protocol';
import { Link } from 'react-router-dom';
import { timelineCopy } from './copy';

/** The server summary when this read returned one, otherwise the retained message. */
export function recordedFailureText(
  error: { message?: string; presentation?: { summary?: string } | null } | null | undefined,
  fallback: string | null
): string | null {
  return error?.presentation?.summary ?? error?.message ?? fallback;
}

/**
 * The owner-supplied error for one run. Actions are only those the server returned.
 * An unknown or unclassified read stays the summary, with no invented action.
 */
export function OwnerRunError({ presentation }: { presentation: TurnErrorPresentation }) {
  const action = presentation.actions.find((candidate) => candidate.kind === 'inspect');
  return (
    <div data-owner-error={presentation.class}>
      <p className="ok-meta">{presentation.summary}</p>
      {action ? (
        <Link to={{ search: `?turn=${action.input.turnId}` }}>
          {timelineCopy.inspectRecordedRun}
        </Link>
      ) : null}
    </div>
  );
}
