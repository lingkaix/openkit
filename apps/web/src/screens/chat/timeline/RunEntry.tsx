import type { ThreadDashboardResponse } from '@openkit/app-api-schemas';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, type ReactNode, type Ref, useState } from 'react';
import { useOptionalCoreClient } from '../../../app/core-client';
import { Button } from '../../../primitives';
import { type ThreadItem, useThreadDashboard } from '../data';
import { ItemView } from '../ItemView';
import {
  digestsCarriedWith,
  type ReportedActivityRead,
  reportedActivityFor,
} from './argument-digest';
import { fillCopy, timelineCopy } from './copy';
import { RunEnvironment } from './environment';
import { resolveRender } from './lens';
import { OwnerRunError } from './owner-error';
import {
  type ClosedFold,
  closedDecisionFold,
  closedDecisionLine,
  formatRunDuration,
  groupSteps,
  isStepItem,
  noteWindow,
  plainActorName,
  type RequestLifecycle,
  stepsFoldLabel,
  summaryLine,
  voiceClass,
} from './present';
import { ReportedActivityView } from './reported-activity';
import type { TimelineEntry, TimelineTurn } from './source';
import { PlanSegments, PolicyBadge } from './tb7';

function recordedPolicy(entry: TimelineEntry, itemId: string) {
  return entry.policies?.find((row) => row.id === itemId)?.policy ?? null;
}

import { durationDateTime } from './time';
import type { LensName } from './types';
import { type NarrativePreview, offersOpenAllSteps } from './window';

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

type AdmittedRequest = NonNullable<ThreadDashboardResponse['pendingRequests']>[number];

function workspaceOf(
  items: readonly ThreadItem[]
): { workspaceId: string; threadId: string } | null {
  for (const item of items) {
    const owner = item.owner;
    if (owner?.kind === 'workspace' && item.threadId) {
      return { workspaceId: owner.workspaceId, threadId: item.threadId };
    }
  }
  return null;
}

function lifecycleOf(row: AdmittedRequest | undefined): RequestLifecycle | null {
  if (!row) return null;
  return {
    state: row.state,
    resolution: row.resolution,
    ending: row.ending,
    disposition: row.disposition,
  };
}

function deciderName(
  actor: { kind: string; id: string } | undefined,
  viewerUserId: string | null,
  names: ReadonlyMap<string, string>
): string {
  if (!actor) return timelineCopy.someone;
  if (actor.kind === 'system') return timelineCopy.policyActor;
  if (actor.kind === 'user' && viewerUserId && actor.id === viewerUserId) return 'You';
  const recorded = names.get(`${actor.kind}:${actor.id}`);
  return plainActorName(recorded, actor.kind === 'user' ? 'person' : 'worker');
}

function actorOf(item: ThreadItem | undefined): { kind: string; id: string } | undefined {
  if (!item) return undefined;
  if (
    item.type === 'approval-decision' ||
    item.type === 'user-input-response' ||
    item.type === 'user-message'
  ) {
    return item.actor;
  }
  return undefined;
}

function requestItemId(item: ThreadItem): string | null {
  if (item.type === 'approval-request' || item.type === 'approval-decision') {
    return item.approvalRequestId;
  }
  if (item.type === 'user-input-request' || item.type === 'user-input-response') {
    return item.userInputRequestId;
  }
  return null;
}

function ClosedDecisionFold({
  line,
  members,
  renderMember,
}: {
  line: string;
  members: readonly ThreadItem[];
  renderMember: (item: ThreadItem) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-fold-depth="1" data-decision-fold="closed">
      <Button
        variant="quiet"
        size="sm"
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
      >
        {line}
      </Button>
      {open
        ? members.map((item) => (
            <div key={item.id} data-fold-depth="2" data-decision-member={item.id}>
              {renderMember(item)}
            </div>
          ))
        : null}
    </div>
  );
}

/**
 * One run: trigger, narrative, summary, long-run plan and notes, and the step fold.
 * The step fold opens in place. A running line can still show Full for this run only.
 */
function dashboardPresents(turn: TimelineTurn | undefined): boolean {
  const error = turn?.error as { presentation?: unknown } | null | undefined;
  return error?.presentation != null;
}

function RunEntryBody({
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
  onStepsToggle,
  onOpenAllSteps,
  stepsSheetOpen,
  runningStatus,
  showActivity,
  activityLine,
  workerCue,
  previews,
  onShowFullText,
  requests,
  viewerUserId,
  names,
  digests,
  reported,
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
  /** Records the run fold in history. The parent keeps one expanded run. */
  onStepsToggle?: (open: boolean) => void;
  onOpenAllSteps?: () => void;
  stepsSheetOpen?: boolean;
  runningStatus?: ReactNode;
  showActivity: boolean;
  activityLine?: ReactNode;
  workerCue?: boolean;
  /** Previews in read order. They stay at the Item they follow, including when not truncated. */
  previews?: readonly NarrativePreview[];
  onShowFullText?: (preview: NarrativePreview) => void;
  requests: readonly AdmittedRequest[] | undefined;
  viewerUserId: string | null;
  names: ReadonlyMap<string, string>;
  /** Recorded argument digests from the timeline read. Missing ids stay ungrouped. */
  digests?: ReadonlyMap<string, string | null>;
  /** Bounded reported activity for this run. Absence keeps the dashboard activity line. */
  reported?: ReportedActivityRead;
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
  const groups = groupSteps(steps, digests);
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

  function requestFor(item: ThreadItem): RequestLifecycle | null {
    const id = requestItemId(item);
    if (!id) return null;
    return lifecycleOf(requests?.find((row) => row.requestId === id));
  }

  function decisionFor(item: ThreadItem): ThreadItem | undefined {
    if (item.type === 'approval-request') {
      return items.find(
        (candidate) =>
          candidate.type === 'approval-decision' &&
          candidate.approvalRequestId === item.approvalRequestId
      );
    }
    if (item.type === 'user-input-request') {
      return items.find(
        (candidate) =>
          candidate.type === 'user-input-response' &&
          candidate.userInputRequestId === item.userInputRequestId
      );
    }
    return undefined;
  }

  function foldFor(item: ThreadItem): ClosedFold {
    if (item.type === 'approval-request') {
      const decision = decisionFor(item);
      return closedDecisionFold({
        decision: decision?.type === 'approval-decision' ? decision.decision : null,
        request: requestFor(item),
      });
    }
    if (item.type === 'user-input-request') {
      return closedDecisionFold({
        decision: decisionFor(item) ? 'answered' : null,
        request: requestFor(item),
      });
    }
    return { fold: false };
  }

  function foldedIntoRequest(item: ThreadItem): boolean {
    const request = items.find((candidate) => {
      if (item.type === 'approval-decision' && candidate.type === 'approval-request') {
        return candidate.approvalRequestId === item.approvalRequestId;
      }
      if (item.type === 'user-input-response' && candidate.type === 'user-input-request') {
        return candidate.userInputRequestId === item.userInputRequestId;
      }
      return false;
    });
    return request ? foldFor(request).fold : false;
  }

  function renderMember(item: ThreadItem): ReactNode {
    const decision = resolveRender(
      item.type === 'assistant-message' ? 'assistant-message' : item.type,
      runLens
    );
    const rendered = renderItem(item, voiceClass(decision.voice));
    if (rendered) return rendered;
    return (
      <ItemView
        item={item}
        readOnly
        viewerUserId={viewerUserId ?? undefined}
        authorName={deciderName(actorOf(item), viewerUserId, names)}
      />
    );
  }

  function row(item: ThreadItem): ReactNode {
    if (hiddenIds.has(item.id) || isStepItem(item)) return null;
    if (item.type === 'plan') return null;
    if (foldedIntoRequest(item)) return null;
    const fold = foldFor(item);
    if (fold.fold) {
      const partner = decisionFor(item);
      const members = partner ? [item, partner] : [item];
      const line =
        fold.kind === 'closed'
          ? timelineCopy.closedWithoutDecision
          : closedDecisionLine(
              deciderName(actorOf(partner), viewerUserId, names),
              fold.kind,
              fold.result
            );
      return (
        <ClosedDecisionFold
          key={item.id}
          line={line}
          members={members}
          renderMember={renderMember}
        />
      );
    }
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

  function previewNodes(placement: NarrativePreview['placement'], afterItemId: string | null) {
    return (previews ?? [])
      .filter((preview) => preview.placement === placement && preview.afterItemId === afterItemId)
      .map((preview) => (
        <div key={preview.id} className="ok-prose" data-preview={preview.id}>
          <p>{preview.text}</p>
          {preview.truncated && onShowFullText ? (
            <Button variant="quiet" size="sm" onPress={() => onShowFullText(preview)}>
              {timelineCopy.showFullText}
            </Button>
          ) : null}
        </div>
      ));
  }

  return (
    <article data-voice="fact" data-entry="run" className="ok-run flex flex-col gap-2">
      {!omitTrigger && turn ? (
        <p data-voice="fact" className="ok-voice-fact ok-meta">
          {timelineCopy['run-trigger']} · {actorName}
        </p>
      ) : null}
      {runLens === 'full' || turn?.status === 'pending' ? (
        <RunEnvironment
          usage={runLens === 'full' ? entry.usage : null}
          fallback={runLens === 'full' ? entry.fallback : null}
          turnId={entry.turnId}
          workspaceId={workspaceOf(items)?.workspaceId ?? null}
          threadId={workspaceOf(items)?.threadId ?? null}
          facts={runLens === 'full' ? 'standing' : 'wait'}
        />
      ) : null}
      {runningStatus}
      {previewNodes('narrative', null)}
      {items.map((item) => (
        <Fragment key={item.id}>
          {row(item)}
          {previewNodes('narrative', item.id)}
        </Fragment>
      ))}
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
      <PlanSegments recorded={entry.planSegments} />
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
      {entry.errorPresentation && !dashboardPresents(turn) ? (
        <OwnerRunError presentation={entry.errorPresentation} />
      ) : entry.outcome && !entry.errorPresentation && turn?.status !== 'failed' ? (
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
              const open = expanded || stepsOpen;
              setStepsOpen(!open);
              onStepsToggle?.(!open);
            }}
          >
            {stepsFoldLabel(entry.stats.stepCount, entry.stats.failedStepCount)}
          </Button>
          {offersOpenAllSteps(entry.stats.stepCount) ? (
            <Button variant="quiet" size="sm" onPress={onOpenAllSteps}>
              {timelineCopy.openAllSteps}
            </Button>
          ) : null}
          {!stepsInSheet && (runLens === 'full' || stepsOpen) ? (
            <ul data-fold-depth="2" className="mt-2 flex flex-col gap-2">
              {groups.map((group) =>
                group.items.length > 1 ? (
                  <li key={group.key} data-step-members={group.digest ?? group.key}>
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
                          <div
                            key={item.id}
                            id={`timeline-item-${item.id}`}
                            tabIndex={-1}
                            data-voice="process"
                            data-step-member={item.id}
                            className="ok-step"
                          >
                            {renderItem(item, 'ok-step')}
                            {runLens === 'full' && item.type === 'tool-call' ? (
                              <PolicyBadge policy={recordedPolicy(entry, item.id)} />
                            ) : null}
                            {previewNodes('step', item.id)}
                          </div>
                        ))
                      : null}
                  </li>
                ) : (
                  <li
                    key={group.key}
                    id={`timeline-item-${group.items[0]!.id}`}
                    tabIndex={-1}
                    data-voice="process"
                    className="ok-step"
                  >
                    {renderItem(group.items[0]!, 'ok-step')}
                    {runLens === 'full' && group.items[0]!.type === 'tool-call' ? (
                      <PolicyBadge policy={recordedPolicy(entry, group.items[0]!.id)} />
                    ) : null}
                    {previewNodes('step', group.items[0]!.id)}
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
      {runLens === 'full' && reported && reported.state !== 'absent' ? (
        <ReportedActivityView activity={reported.state === 'present' ? reported.activity : null} />
      ) : showActivity ? (
        activityLine
      ) : null}
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

function AdmittedRequests({
  workspaceId,
  threadId,
  children,
}: {
  workspaceId: string;
  threadId: string;
  children: (lifecycle: {
    requests: readonly AdmittedRequest[] | undefined;
    viewerUserId: string | null;
    names: ReadonlyMap<string, string>;
  }) => ReactNode;
}) {
  const dashboard = useThreadDashboard(workspaceId, threadId, false);
  const names = new Map(
    (dashboard.data?.participants ?? []).map((participant) => [
      `${participant.kind}:${participant.id}`,
      participant.displayName,
    ])
  );
  return children({
    requests: dashboard.data?.pendingRequests,
    viewerUserId: dashboard.data?.viewerUserId ?? null,
    names,
  });
}

function RecordedActivity({
  workspaceId,
  threadId,
  turnId,
  children,
}: {
  workspaceId: string;
  threadId: string;
  turnId: string;
  children: (reported: ReportedActivityRead) => ReactNode;
}) {
  const queryClient = useQueryClient();
  return children(reportedActivityFor(queryClient, turnId, { workspaceId, threadId }));
}

export function RunEntry(
  props: Omit<
    Parameters<typeof RunEntryBody>[0],
    'requests' | 'viewerUserId' | 'names' | 'reported'
  >
) {
  const client = useOptionalCoreClient();
  const scope = workspaceOf(props.items);
  const digests = props.digests ?? digestsCarriedWith(props.items);
  if (!client || !scope) {
    return (
      <RunEntryBody
        {...props}
        requests={undefined}
        viewerUserId={null}
        names={new Map()}
        digests={digests}
      />
    );
  }
  return (
    <AdmittedRequests workspaceId={scope.workspaceId} threadId={scope.threadId}>
      {(lifecycle) => (
        <RecordedActivity
          workspaceId={scope.workspaceId}
          threadId={scope.threadId}
          turnId={props.entry.turnId}
        >
          {(reported) => (
            <RunEntryBody {...props} {...lifecycle} digests={digests} reported={reported} />
          )}
        </RecordedActivity>
      )}
    </AdmittedRequests>
  );
}
