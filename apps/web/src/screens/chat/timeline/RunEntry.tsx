import { type ReactNode, type Ref, useState } from 'react';
import { Button } from '../../../primitives';
import type { ThreadItem } from '../data';
import { fillCopy, timelineCopy } from './copy';
import { resolveRender } from './lens';
import {
  formatRunDuration,
  groupSteps,
  isStepItem,
  noteWindow,
  stepsFoldLabel,
  summaryLine,
  voiceClass,
} from './present';
import type { TimelineEntry, TimelineTurn } from './source';
import { durationDateTime } from './time';
import type { LensName } from './types';

function SummaryText({ summary, durationMs }: { summary: string; durationMs: number | null }) {
  if (durationMs == null || durationMs < 1000) return summary;
  const label = formatRunDuration(durationMs);
  const index = summary.indexOf(label);
  if (index < 0) return summary;
  return (
    <>
      {summary.slice(0, index)}
      <time dateTime={durationDateTime(durationMs)}>{label}</time>
      {summary.slice(index + label.length)}
    </>
  );
}

function planMark(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '●';
  if (status === 'blocked') return '?';
  return '○';
}

/**
 * One run: trigger, narrative, summary, long-run plan and notes, and the step fold.
 * The step fold opens in place. A running line can still show Full for this run only.
 */
export function RunEntry({
  entry,
  items,
  turn,
  lens,
  expanded,
  actorName,
  omitTrigger,
  durationMs,
  hiddenIds,
  renderItem,
  inspectRef,
  inspected,
  onInspect,
  stepsInSheet,
  onOpenSteps,
  onOpenAllSteps,
  stepsSheetOpen,
  runningStatus,
  showActivity,
  activityLine,
  workerCue,
}: {
  entry: TimelineEntry;
  items: readonly ThreadItem[];
  turn?: TimelineTurn;
  lens: LensName;
  expanded: boolean;
  actorName: string;
  omitTrigger: boolean;
  durationMs: number | null;
  hiddenIds: ReadonlySet<string>;
  renderItem: (item: ThreadItem, voiceClassName: string) => ReactNode;
  inspectRef?: Ref<HTMLButtonElement>;
  inspected: boolean;
  onInspect: () => void;
  /** Phone opens steps in a sheet instead of in the run. */
  stepsInSheet?: boolean;
  onOpenSteps?: () => void;
  onOpenAllSteps?: () => void;
  stepsSheetOpen?: boolean;
  runningStatus?: ReactNode;
  showActivity: boolean;
  activityLine?: ReactNode;
  workerCue?: boolean;
}) {
  const runLens: LensName = lens === 'full' || expanded ? 'full' : 'work';
  const byId = new Map(items.map((item) => [item.id, item]));
  const notes = noteWindow(
    entry.notes.map((note) => note.itemId),
    runLens,
    entry.long
  );
  const visibleNotes = new Set(notes.visible);
  const steps = items.filter((item) => isStepItem(item));
  const groups = groupSteps(steps);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const [showEarlierNotes, setShowEarlierNotes] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [showEarlierPlans, setShowEarlierPlans] = useState(false);
  const plans = items.filter((item) => item.type === 'plan');
  const latestPlan = plans.at(-1);
  const earlierPlans = plans.slice(0, -1);
  const showChecklist = Boolean(latestPlan) && (runLens === 'full' || entry.long);
  const knowledge = items.filter((item) => item.type === 'knowledge-injection');
  const showKnowledgeRows = runLens === 'full';
  let knowledgeLineShown = false;
  const summary = summaryLine({
    actor: actorName,
    running: turn?.status === 'running',
    durationMs,
    stats: entry.stats,
  });

  function row(item: ThreadItem): ReactNode {
    if (hiddenIds.has(item.id) || isStepItem(item)) return null;
    if (item.type === 'plan') return null;
    if (item.type === 'assistant-message' && entry.notes.some((note) => note.itemId === item.id)) {
      return null;
    }
    if (item.type === 'knowledge-injection' && !showKnowledgeRows) {
      if (knowledgeLineShown) return null;
      knowledgeLineShown = true;
      return (
        <p key="sources" data-voice="fact" className="ok-voice-fact ok-meta">
          {fillCopy(timelineCopy.usedSources, { count: knowledge.length })}
        </p>
      );
    }
    const decision = resolveRender(
      item.type === 'assistant-message' ? 'assistant-message' : item.type,
      runLens
    );
    const className = voiceClass(decision.voice);
    return (
      <div
        key={item.id}
        id={`timeline-item-${item.id}`}
        tabIndex={-1}
        data-voice={decision.voice}
        data-disclosure={decision.disclosure}
        data-invariant={
          decision.voice === 'human' ||
          decision.voice === 'decision' ||
          decision.voice === 'output' ||
          item.type === 'status'
            ? 'true'
            : undefined
        }
        className={className}
      >
        {(decision.voice === 'output' || decision.voice === 'derived') && (
          <span className="ok-generated-chip">{timelineCopy.generatedChip}</span>
        )}
        {renderItem(item, className)}
      </div>
    );
  }

  return (
    <article data-voice="fact" data-entry="run" className="ok-run flex flex-col gap-2">
      {!omitTrigger && turn ? (
        <p data-voice="fact" className="ok-voice-fact ok-meta">
          {timelineCopy['run-trigger']} · {actorName}
        </p>
      ) : null}
      {runningStatus}
      {items.map((item) => row(item))}
      {showChecklist && latestPlan?.type === 'plan' ? (
        <ul data-voice="claim" className="ok-voice-claim ok-prose" aria-label={timelineCopy.plan}>
          {latestPlan.steps.map((step) => (
            <li key={step.id}>
              {planMark(step.status)} {step.title}
            </li>
          ))}
        </ul>
      ) : latestPlan ? (
        <p data-voice="claim" className="ok-voice-claim ok-meta">
          {timelineCopy.plan}
        </p>
      ) : null}
      {earlierPlans.length > 0 ? (
        <div data-fold-depth="1">
          <Button
            variant="quiet"
            size="sm"
            aria-expanded={showEarlierPlans}
            onPress={() => setShowEarlierPlans((open) => !open)}
          >
            {fillCopy(timelineCopy.earlierPlans, { count: earlierPlans.length })}
          </Button>
          {showEarlierPlans ? (
            <ul data-fold-depth="2">
              {earlierPlans.map((plan) => (
                <li key={plan.id} className="ok-meta">
                  {plan.title}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {notes.visible.map((id) => {
        const item = byId.get(id);
        if (!item) return null;
        return (
          <div key={id} data-voice="claim" className="ok-voice-claim ok-prose">
            {renderItem(item, 'ok-prose')}
          </div>
        );
      })}
      {notes.earlierCount > 0 ? (
        <div data-fold-depth="1">
          <Button
            variant="quiet"
            size="sm"
            aria-expanded={showEarlierNotes}
            onPress={() => setShowEarlierNotes((open) => !open)}
          >
            {fillCopy(timelineCopy.earlierNotes, { count: notes.earlierCount })}
          </Button>
          {showEarlierNotes
            ? entry.notes
                .map((note) => note.itemId)
                .filter((id) => !visibleNotes.has(id))
                .map((id) => {
                  const item = byId.get(id);
                  if (!item) return null;
                  return (
                    <div key={id} data-fold-depth="2" data-voice="claim" className="ok-prose">
                      {renderItem(item, 'ok-prose')}
                    </div>
                  );
                })
            : null}
        </div>
      ) : null}
      {turn ? (
        <p data-voice="fact" className="ok-voice-fact ok-meta">
          <SummaryText summary={summary} durationMs={durationMs} />
          <span aria-hidden="true"> · </span>
          <span>{timelineCopy.countedFromRecords}</span>
        </p>
      ) : null}
      {entry.outcome && turn?.status !== 'failed' ? (
        <p data-voice="fact" data-invariant="true" className="ok-voice-fact ok-outcome">
          {entry.outcome.text}
        </p>
      ) : null}
      {steps.length > 0 || entry.stats.stepCount > 0 ? (
        <div data-fold-depth="1">
          <Button
            variant="quiet"
            size="sm"
            data-fold-control="true"
            aria-expanded={stepsInSheet ? Boolean(stepsSheetOpen) : runLens === 'full' || stepsOpen}
            onPress={() => {
              if (stepsInSheet) {
                onOpenSteps?.();
                return;
              }
              setStepsOpen((open) => !open);
            }}
          >
            {stepsFoldLabel(entry.stats.stepCount, entry.stats.failedStepCount)}
          </Button>
          {entry.stats.stepCount > 500 ? (
            <Button variant="quiet" size="sm" onPress={onOpenAllSteps}>
              {timelineCopy.openAllSteps}
            </Button>
          ) : null}
          {!stepsInSheet && (runLens === 'full' || stepsOpen) ? (
            <ul data-fold-depth="2" className="mt-2 flex flex-col gap-2">
              {groups.map((group) =>
                group.items.length > 1 ? (
                  <li key={group.key}>
                    <Button
                      variant="quiet"
                      size="sm"
                      aria-expanded={openGroups.has(group.key)}
                      onPress={() =>
                        setOpenGroups((current) => {
                          const next = new Set(current);
                          if (next.has(group.key)) next.delete(group.key);
                          else next.add(group.key);
                          return next;
                        })
                      }
                    >
                      {group.label}
                    </Button>
                    {openGroups.has(group.key)
                      ? group.items.map((item) => (
                          <div key={item.id} data-voice="process" className="ok-step">
                            {renderItem(item, 'ok-step')}
                          </div>
                        ))
                      : null}
                  </li>
                ) : (
                  <li key={group.key} data-voice="process" className="ok-step">
                    {renderItem(group.items[0]!, 'ok-step')}
                  </li>
                )
              )}
            </ul>
          ) : null}
        </div>
      ) : null}
      {workerCue ? (
        <p data-voice="claim" className="ok-voice-claim ok-meta">
          {timelineCopy.reportedByWorker}
        </p>
      ) : null}
      {showActivity ? activityLine : null}
      <Button
        ref={inspectRef}
        variant="quiet"
        size="sm"
        aria-expanded={inspected}
        onPress={onInspect}
      >
        {timelineCopy.inspectRun}
      </Button>
    </article>
  );
}
