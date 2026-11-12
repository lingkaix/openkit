import type { TimelineRunEntry } from '@openkit/app-api-schemas';
import type { ReactNode, Ref } from 'react';
import { Link } from 'react-router-dom';
import { Button, Icon } from '../../../primitives';
import type { ThreadItem } from '../data';
import { ItemView } from '../ItemView';
import { timelineCopy } from './copy';
import { RunEnvironment } from './environment';
import { isStepItem } from './present';
import { auditUsageHref } from './resolve';
import { captureCopy, coverageCopy, omittedActivityCopy } from './source';

/** Worker-reported activity as today's dashboard returns it. */
export interface ReportedActivity {
  contentCapture: string;
  coverage: string;
  omittedEntryCount: number;
  entries: {
    sequence: number;
    observedAt: string;
    kind: 'child-started' | 'progress' | 'result' | 'failure';
    label?: string;
    text?: string;
    textTruncated: boolean;
  }[];
}

/**
 * One run's identifiers, raw outputs, audit link, and worker-reported markers.
 * Desktop uses the side slot. Phone uses the same panel as a sheet.
 */
export function Inspector({
  turnId,
  items,
  activity,
  interrupted,
  onClose,
  panelRef,
  sheet,
  expanded,
  onExpand,
  usage = null,
  fallback = null,
}: {
  turnId: string;
  usage?: TimelineRunEntry['usage'];
  fallback?: TimelineRunEntry['fallback'];
  items: readonly ThreadItem[];
  activity?: ReportedActivity | null;
  /** Today's read has no interrupt actor, so an interrupted run says so here. */
  interrupted?: boolean;
  onClose: () => void;
  panelRef?: Ref<HTMLElement>;
  /** Phone sheet at 60% of the viewport, expandable. Desktop keeps the side slot. */
  sheet?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
}) {
  return (
    <aside
      ref={panelRef}
      aria-label={timelineCopy.inspectorLabel}
      data-surface="inspector"
      data-sheet={sheet ? 'partial' : undefined}
      data-expanded={sheet ? (expanded ? 'true' : 'false') : undefined}
      tabIndex={-1}
      role={sheet ? 'dialog' : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        if (!sheet && event.target instanceof Element && event.target.closest('[role="dialog"]'))
          return;
        event.preventDefault();
        onClose();
      }}
      className={
        sheet
          ? `fixed inset-x-0 bottom-0 z-40 flex flex-col overflow-y-auto rounded-t-ok-xl border border-separator bg-layer-1 p-3 shadow-ok-modal outline-none focus:ring-2 focus:ring-focus ${expanded ? 'top-0 h-full' : 'h-[60vh]'}`
          : 'absolute inset-y-0 right-0 z-10 flex w-full shrink-0 flex-col overflow-y-auto border-l border-separator bg-layer-1 p-3 shadow-ok-menu outline-none focus:ring-2 focus:ring-focus @min-[47rem]/thread:static @min-[47rem]/thread:w-60 @min-[47rem]/thread:shadow-none'
      }
    >
      {sheet ? (
        <button
          type="button"
          className="flex min-h-11 w-full items-center justify-center"
          aria-label={expanded ? timelineCopy.collapseSheet : timelineCopy.expandSheet}
          onClick={onExpand}
        >
          <span className="h-1 w-10 rounded-full bg-border" aria-hidden="true" />
        </button>
      ) : (
        <div
          className="mx-auto mt-1 h-1 w-10 shrink-0 rounded-full bg-border @min-[47rem]/thread:hidden"
          aria-hidden="true"
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">{timelineCopy.inspectorLabel}</h2>
        <Button
          size="sm"
          variant="quiet"
          aria-label={timelineCopy.closeInspector}
          className="min-h-11 min-w-11 shrink-0 px-0!"
          onPress={onClose}
        >
          <Icon name="close" />
        </Button>
      </div>
      {sheet ? <RunEnvironment usage={usage} fallback={fallback} /> : null}
      <section className="mt-3" aria-label={timelineCopy.identifiersHeading}>
        <h3 className="text-xs font-semibold text-fg">{timelineCopy.identifiersHeading}</h3>
        <p className="mt-1 break-all text-xs text-fg-muted">{turnId}</p>
        <ul className="mt-2 flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id} className="break-all text-xs text-fg-muted">
              {item.id}
              {recordedActorId(item) ? (
                <span className="mt-0.5 block">{recordedActorId(item)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <section className="mt-4" aria-label={timelineCopy.rawOutputs}>
        <h3 className="text-xs font-semibold text-fg">{timelineCopy.rawOutputs}</h3>
        <div className="mt-2 flex flex-col gap-3">
          {items
            .filter((item) => isStepItem(item))
            .map((item) => (
              <ItemView key={item.id} item={item} />
            ))}
          {artifactCards(items).map((item) => (
            <ItemView key={item.id} item={item} />
          ))}
          {items.map((item) => rawOutput(item))}
        </div>
      </section>
      <p className="mt-4 text-sm">
        <Link to={auditUsageHref({ turnId })} className="text-accent-content underline">
          {timelineCopy.auditRecords}
        </Link>
      </p>
      {activity ? (
        <section aria-label="Runtime activity" aria-live="polite" className="mt-4 text-sm">
          <h3 className="font-semibold text-fg">Runtime activity</h3>
          {activity.entries.length > 0 ? (
            <p className="mt-1 text-fg-muted">{timelineCopy.reportedByWorker}</p>
          ) : null}
          <p className="mt-1 text-fg-muted">{coverageCopy(activity.coverage)}</p>
          <p className="mt-1 text-fg-muted">{captureCopy(activity.contentCapture)}</p>
          {activity.omittedEntryCount > 0 ? (
            <p className="mt-1 text-fg-muted">{omittedActivityCopy(activity.omittedEntryCount)}</p>
          ) : null}
          {activity.entries.length > 0 ? (
            <ol className="mt-3 flex flex-col gap-3">
              {activity.entries.map((entry) => (
                <li key={entry.sequence}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium text-fg">
                      {entry.label ??
                        {
                          'child-started': timelineCopy.childStarted,
                          progress: timelineCopy.reportedProgress,
                          result: timelineCopy.reportedResult,
                          failure: timelineCopy.reportedFailure,
                        }[entry.kind]}
                    </span>
                    <time dateTime={entry.observedAt} className="text-xs text-fg-muted">
                      {new Date(entry.observedAt).toLocaleTimeString()}
                    </time>
                  </div>
                  {entry.text !== undefined ? (
                    <p className="mt-1 whitespace-pre-wrap break-words text-fg">{entry.text}</p>
                  ) : null}
                  {entry.textTruncated ? (
                    <p className="mt-1 text-xs text-fg-muted">{timelineCopy.textShortened}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}
      {interrupted ? (
        <p className="mt-4 text-xs text-fg-muted">{timelineCopy.actorNotRecorded}</p>
      ) : null}
    </aside>
  );
}

function recordedActorId(item: ThreadItem): string | null {
  if (!('actor' in item) || item.actor == null || typeof item.actor !== 'object') return null;
  return 'id' in item.actor && typeof item.actor.id === 'string' ? item.actor.id : null;
}

function artifactCards(items: readonly ThreadItem[]): ThreadItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.type !== 'artifact-reference') return false;
    const identity = `${item.artifactId}:${item.artifactVersion}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function rawOutput(item: ThreadItem): ReactNode {
  if (item.type === 'user-message') {
    return (
      <pre key={item.id} className="whitespace-pre-wrap break-words text-xs text-fg">
        {item.text}
      </pre>
    );
  }
  if (item.type === 'tool-call' && (item.result || item.error)) {
    return (
      <pre key={item.id} className="whitespace-pre-wrap break-words text-xs text-fg">
        {item.error ?? item.result}
      </pre>
    );
  }
  if (item.type === 'command-execution' && item.output) {
    return (
      <pre key={item.id} className="whitespace-pre-wrap break-words text-xs text-fg">
        {item.output}
      </pre>
    );
  }
  if (item.type === 'status') {
    return (
      <p key={item.id} className="text-xs text-fg">
        {item.title}
        {item.summary ? ` — ${item.summary}` : ''}
      </p>
    );
  }
  return null;
}
