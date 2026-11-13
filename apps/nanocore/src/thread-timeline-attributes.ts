import { createHash } from 'node:crypto';
import type { TimelineItem, TimelineRunEntry } from '@openkit/app-api-schemas';
import { THREAD_TIMELINE_PLACEMENT } from '@openkit/app-api-schemas';
import { canonicalJsonText, type Item } from '@openkit/protocol';
import type { WorkerObservationFact } from '@openkit/worker-protocol';
import { boundedJsonText } from './bounded-read-text.js';
import type { WorkspaceDb } from './storage/db.js';
import {
  readControlWorkObservations,
  readControlWorkObservationTurnBinding,
} from './storage/work-observations.js';
import type {
  ThreadTimelineSnapshot,
  TimelinePolicyEvidence,
} from './storage/workspace-file-records.js';

type Badge = NonNullable<TimelineItem['policy']>;

/** Hashes complete recorded inputs before preview clipping; outcomes and clocks do not identify a retry. */
export function timelineArgumentDigest(item: Item): string | null {
  const input =
    item.type === 'tool-call' && item.arguments !== null
      ? { type: item.type, server: item.server, tool: item.tool, arguments: item.arguments }
      : item.type === 'command-execution'
        ? { type: item.type, command: item.command, cwd: item.cwd }
        : null;
  if (!input) return null;
  try {
    return `sha256:${createHash('sha256').update(canonicalJsonText(input)).digest('hex')}`;
  } catch {
    // Retained strings can be valid JSON but not canonical Unicode; no identity is safer than a collision.
    return null;
  }
}

/** Uses one existing native observation page; body capture and whole-history readers stay out of this projection. */
export function readTimelineReportedActivity(
  db: WorkspaceDb,
  threadId: string,
  turnId: string,
  budget: number
): NonNullable<TimelineRunEntry['reportedActivity']> | null {
  try {
    return db.sqlite.transaction(() => {
      const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
      const input = { threadId, turnId, limit: 128 };
      const binding = readControlWorkObservationTurnBinding(db.sqlite, owner, input);
      const rows = readControlWorkObservations(db.sqlite, owner, input).flatMap((row) =>
        row.type === 'runtime.observed' && row.obs === 'worker-shim'
          ? // The native reader already parsed this complete payload and checked observer/manifest/lineage.
            // Reuse those admitted facts; a second schema parse adds no source proof.
            [{ row, fact: row.payload.fact as WorkerObservationFact }]
          : []
      );
      // Child names are local display ordinals from this exact admitted prefix, not native identities.
      const children = new Map<string, number>();
      for (const { fact } of rows) {
        if (
          fact.kind === 'origin' &&
          fact.parentRuntimeOriginRef &&
          fact.runtimeOriginRef &&
          !children.has(fact.runtimeOriginRef)
        )
          children.set(fact.runtimeOriginRef, children.size + 1);
      }
      const displayed = new Set<string>();
      const entries: NonNullable<TimelineRunEntry['reportedActivity']>['entries'] = [];
      for (const { row, fact } of rows) {
        if (!['origin', 'assistant', 'tool'].includes(fact.kind)) continue;
        const child = fact.runtimeOriginRef ? children.get(fact.runtimeOriginRef) : undefined;
        const phase = fact.phase ?? 'observed';
        const started =
          fact.kind === 'origin' &&
          child !== undefined &&
          !displayed.has(fact.runtimeOriginRef!) &&
          ['started', 'observed'].includes(phase);
        if (started) displayed.add(fact.runtimeOriginRef!);
        entries.push({
          sequence: row.seq,
          observedAt: row.ts,
          kind: ['failed', 'interrupted'].includes(phase)
            ? 'failure'
            : ['completed', 'closed'].includes(phase)
              ? 'result'
              : started
                ? 'child-started'
                : 'progress',
          label: child === undefined ? 'Worker' : `Child ${child}`,
        });
      }
      const result: NonNullable<TimelineRunEntry['reportedActivity']> = {
        reportedBy: 'worker',
        contentCapture: binding.coverage?.value ?? 'unknown',
        // A finite observation prefix can never certify full reporting coverage or current liveness.
        coverage: entries.length ? 'partial' : 'unavailable',
        entries: entries.slice(-50),
        omittedEntryCount: Math.max(0, entries.length - 50),
      };
      // Count each encoded entry once. Re-encoding a shrinking 50-entry array for every
      // dropped entry multiplied response work across the default 31-run window.
      const entryBytes = result.entries.map((entry) => Buffer.byteLength(JSON.stringify(entry)));
      let remaining = result.entries.length;
      let size =
        Buffer.byteLength(JSON.stringify({ ...result, entries: [] })) +
        entryBytes.reduce((total, length) => total + length, 0) +
        Math.max(0, remaining - 1);
      while (size > budget && remaining) {
        const previousDigits = String(result.omittedEntryCount).length;
        size -= entryBytes[result.entries.length - remaining]! + (remaining > 1 ? 1 : 0);
        remaining--;
        result.omittedEntryCount++;
        size += String(result.omittedEntryCount).length - previousDigits;
      }
      if (size > budget) return null;
      result.entries = result.entries.slice(result.entries.length - remaining);
      return result;
    })();
  } catch {
    // Missing or contradictory native authority is unavailable, never an ordinary-Item fallback.
    return null;
  }
}

/** Exact recorded relations only: execution status, names and clocks never supply a verdict. */
export function projectTimelinePolicy(
  item: Item,
  evidence: TimelinePolicyEvidence | null
): Badge | null {
  if (item.type !== 'tool-call' || !evidence || item.causationId !== evidence.callId) return null;
  const candidates = evidence.decisions.filter(({ decision, audit }) => {
    const mediation = decision.mediation;
    const process = mediation?.subject.process;
    const context = decision.contextSummary as Record<string, unknown> | null;
    const target = decision.resourceSummary as Record<string, unknown> | null;
    return (
      decision.ownerScope === 'workspace' &&
      decision.action === 'tool.use' &&
      mediation?.role === 'final' &&
      mediation.operation === 'mcp.call-tool' &&
      mediation.stage === 'decide' &&
      process?.workspaceId === decision.workspaceId &&
      process?.threadId === item.threadId &&
      process?.turnId === item.turnId &&
      context?.threadId === item.threadId &&
      context?.turnId === item.turnId &&
      typeof target?.serverId === 'string' &&
      target.serverId === evidence.providerRef &&
      typeof target.toolName === 'string' &&
      evidence.serviceRef === `mcp-tool:${target.toolName}` &&
      audit.workspaceId === decision.workspaceId &&
      audit.threadId === item.threadId &&
      audit.turnId === item.turnId &&
      (audit.itemId === null || audit.itemId === item.id) &&
      audit.capabilityCallId === evidence.callId &&
      audit.permissionDecisionId === decision.decisionId
    );
  });
  if (candidates.length !== 1) return null;
  const { decision, pending } = candidates[0]!;
  let outcome: Badge['outcome'];
  if (decision.result === 'allow') outcome = 'allowed';
  else if (decision.result === 'deny') outcome = 'denied';
  else if (decision.result === 'require_approval' || decision.result === 'require_escalation') {
    const target = decision.resourceSummary as Record<string, unknown>;
    const matched = pending.filter(
      (record) =>
        record.state === 'pending' &&
        record.policyDecisionId === decision.decisionId &&
        (decision.approvalId === null || decision.approvalId === record.requestId) &&
        record.workspaceId === decision.workspaceId &&
        record.threadId === item.threadId &&
        record.turnId === item.turnId &&
        record.serverId === target.serverId &&
        record.toolName === target.toolName &&
        record.responsibleUserId === decision.mediation?.subject.responsibleHumanId &&
        decision.mediation?.kernel?.effect === 'allow' &&
        record.requestItem?.type === 'approval-request' &&
        record.requestItem.approvalRequestId === record.requestId
    );
    if (pending.length !== 1 || matched.length !== 1) return null;
    outcome = 'waiting-approval';
  } else return null;
  // providerRef is not a demonstrated scope-qualified connection selector.
  return {
    outcome,
    permissionDecisionId: decision.decisionId,
    capabilityCallId: evidence.callId,
    connectionRef: null,
  };
}

/** Counts immutable first-publication positions between retained active-step observations. */
export function readTimelinePlanSegments(
  snapshot: ThreadTimelineSnapshot,
  turnId: string,
  budget: number
): NonNullable<TimelineRunEntry['planSegments']> {
  const retained = snapshot.planRevisions(turnId);
  const observations = retained.slice(-10);
  let partial = retained.length > 10;
  type Segment = NonNullable<TimelineRunEntry['planSegments']>['segments'][number];
  const segments: Segment[] = [];
  let active: Segment | undefined;
  for (const observation of observations) {
    const plan = observation.item;
    const current =
      plan?.type === 'plan' ? plan.steps.filter((step) => step.status === 'in_progress') : [];
    if (!plan || plan.type !== 'plan' || current.length > 1) partial = true;
    const step = current.length === 1 ? current[0] : undefined;
    if (active && step && plan?.id === active.planItemId && step.id === active.stepId) continue;
    if (active) active.endSequence = observation.sequence;
    active = undefined;
    if (!step || !plan) continue;
    if (Buffer.byteLength(step.id) > 128) {
      partial = true;
      continue;
    }
    active = {
      planItemId: plan.id,
      planRevision: observation.revision,
      stepId: step.id,
      title: boundedJsonText(step.title, 256),
      startSequence: observation.sequence,
      endSequence: null,
      steps: 0,
    };
    segments.push(active);
  }
  for (const segment of segments) {
    const counts = snapshot.segmentCounts(turnId, segment.startSequence, segment.endSequence);
    for (const [type, count] of Object.entries(counts)) {
      if (
        type === 'knowledge-injection' ||
        type === 'artifact-reference' ||
        type === 'generative-ui-reference'
      ) {
        if (count) partial = true;
        continue;
      }
      if (THREAD_TIMELINE_PLACEMENT[type as Item['type']] === 'step') segment.steps += count;
    }
  }
  while (
    segments.length > 8 ||
    Buffer.byteLength(JSON.stringify({ segments, coverage: partial ? 'partial' : 'complete' })) >
      budget
  ) {
    if (!segments.length) break;
    segments.shift();
    partial = true;
  }
  return { segments, coverage: partial ? 'partial' : 'complete' };
}
