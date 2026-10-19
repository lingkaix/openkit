import {
  AutomationCadenceSchema,
  AutomationDefinitionSnapshotSchema,
  AutomationExpiredRangeSchema,
  AutomationOccurrenceSchema,
  AutomationRecordSchema,
} from '@openkit/app-api-schemas';
import {
  AutomationIdSchema,
  deriveEntityId,
  ReasoningEffortSchema,
  readRetainedV1,
  TurnIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import {
  recurringNominalMatches,
  recurringPrefixThrough,
  validateRecurringRangeCoverage,
} from '../lib/recurring-cadence.js';
import type { CoreDb } from './db.js';
import { listWorkspaceExternalTriggerAdmissions } from './external-trigger-admissions.js';
import {
  ExpiredOccurrenceRangeSchema,
  RECURRING_DEADLINE_MS,
  readRecurringOccurrence,
  readRecurringSchedule,
  recurringRequestId,
} from './recurring-records.js';

/** Required marker for the three inert recurring portable record families. */
export const RECURRING_PORTABLE_FEATURE = 'workspace.recurring-triggers.v1';
/** Core history tables that must not be lost to generic Server-state exclusions. */
export const RECURRING_PORTABLE_CORE_TABLES = [
  'recurring_schedules',
  'recurring_occurrences',
  'recurring_expired_ranges',
  'external_trigger_admissions',
] as const;
/** Exact paths for Core history; scheduler authority is never included. */
export const RECURRING_PORTABLE_PATHS = {
  schedules: 'records/recurring-schedules.jsonl',
  occurrences: 'records/recurring-occurrences.jsonl',
  expiredRanges: 'records/recurring-expired-ranges.jsonl',
} as const;
const requiredFeatures = z.array(z.never()).optional();
const { actor: originActor, ...scheduleFields } = AutomationRecordSchema.shape;
const portableSnapshot = AutomationDefinitionSnapshotSchema.omit({ actor: true }).extend({
  originActor,
  requiredFeatures,
});
/** Inert source-event join, nested under its already exported schedule definition. */
const portableExternalAdmission = z.object({
  scheduleId: AutomationIdSchema,
  eventKey: z.string().min(1).max(1024),
  sourceTurnId: TurnIdSchema,
  queueEntryId: z.string().min(1),
});
const portableSchedule = z
  .object({
    ...scheduleFields,
    originScheduleId: AutomationRecordSchema.shape.id,
    externalAdmissions: z.array(portableExternalAdmission).optional(),
    originActor,
    requiredFeatures,
  })
  .and(AutomationCadenceSchema);
const portableOccurrence = AutomationOccurrenceSchema.omit({
  requestId: true,
  queueEntryId: true,
  snapshot: true,
  schedulerStatus: true,
  publicationIssue: true,
}).extend({
  snapshot: portableSnapshot,
  resolvedSelection: AutomationOccurrenceSchema.shape.resolvedSelection
    .unwrap()
    .extend({
      reasoningEffort: ReasoningEffortSchema.optional(),
    })
    .nullable(),
  originRequestId: AutomationOccurrenceSchema.shape.requestId,
  originQueueEntryId: z.string().min(1).nullable(),
  originTurnId: AutomationOccurrenceSchema.shape.turnId,
  requiredFeatures,
});
const portableRange = z
  .object({
    ...AutomationExpiredRangeSchema.shape,
    snapshot: portableSnapshot,
    requiredFeatures,
  })
  .and(AutomationCadenceSchema);
const historySchema = z.object({
  schedules: z.array(portableSchedule),
  occurrences: z.array(portableOccurrence),
  expiredRanges: z.array(portableRange),
  requiredFeatures,
});
/** Inert history only; no value of this type is a live Core automation or scheduler input. */
export type RecurringPortableHistory = z.infer<typeof historySchema>;
/** Exact exported canonical graph used to verify Thread and retained Turn references. */
export interface RecurringPortableReferences {
  workspaceId: string;
  threadIds: ReadonlySet<string>;
  turns: ReadonlyMap<string, string>;
}

/** Reads the whitelist projection and rejects contradictory identities, coverage, attempts and references. */
export function readRecurringPortableHistory(
  value: unknown,
  references?: RecurringPortableReferences
): RecurringPortableHistory {
  const graph = historySchema.parse(value);
  const schedules = new Map<string, RecurringPortableHistory['schedules'][number]>();
  const ids = new Set<string>();
  const tuples = new Set<string>();
  const linkedTurns = new Set<string>();
  const coverage = new Map<string, RecurringPortableHistory['expiredRanges']>();
  const claimId = (id: string) => {
    if (ids.has(id)) throw new Error('Recurring portable history repeats an identity.');
    ids.add(id);
  };
  const requireThread = (workspaceId: string, threadId: string) => {
    if (
      references &&
      (workspaceId !== references.workspaceId || !references.threadIds.has(threadId))
    )
      throw new Error(
        'Recurring portable history has an unresolved Workspace or Thread reference.'
      );
  };
  for (const schedule of graph.schedules) {
    claimId(schedule.id);
    if (
      schedule.originActor.id !== schedule.originScheduleId ||
      schedule.originActor.responsibleUserId !== schedule.responsibleUserId ||
      (schedule.status === 'deleted') !== (schedule.deletedAt !== null) ||
      (schedule.status === 'active') !== (schedule.nextScheduledAt !== null) ||
      (schedule.nextScheduledAt !== null &&
        !recurringNominalMatches(schedule, Date.parse(schedule.nextScheduledAt))) ||
      (schedule.nextScheduledAt !== null &&
        schedule.greatestAccountedScheduledAt !== null &&
        Date.parse(schedule.nextScheduledAt) <= Date.parse(schedule.greatestAccountedScheduledAt))
    )
      throw new Error('Recurring portable definition contradicts its retained lifecycle.');
    requireThread(schedule.workspaceId, schedule.threadId);
    const eventKeys = new Set<string>();
    for (const admission of schedule.externalAdmissions ?? []) {
      if (admission.scheduleId !== schedule.id || eventKeys.has(admission.eventKey))
        throw new Error('External trigger history repeats or contradicts its schedule identity.');
      eventKeys.add(admission.eventKey);
      if (references && !references.turns.has(admission.sourceTurnId))
        throw new Error('External trigger history has an unresolved source Turn reference.');
    }
    schedules.set(schedule.id, schedule);
  }
  const requireSchedule = (
    row: {
      scheduleId: string;
      workspaceId: string;
      definitionRevision: number;
      snapshot: z.infer<typeof portableSnapshot>;
    },
    last: number
  ) => {
    const schedule = schedules.get(row.scheduleId);
    if (
      !schedule ||
      row.workspaceId !== schedule.workspaceId ||
      row.definitionRevision > schedule.revision ||
      row.snapshot.originActor.id !== schedule.originScheduleId ||
      row.snapshot.originActor.responsibleUserId !== schedule.responsibleUserId ||
      schedule.greatestAccountedScheduledAt === null ||
      last > Date.parse(schedule.greatestAccountedScheduledAt)
    )
      throw new Error(
        'Recurring portable history has contradictory definition ownership or cursor.'
      );
    requireThread(row.workspaceId, row.snapshot.threadId);
    return schedule;
  };
  for (const occurrence of graph.occurrences) {
    claimId(occurrence.id);
    const at = Date.parse(occurrence.scheduledAt);
    const schedule = requireSchedule(occurrence, at);
    const tuple = JSON.stringify([occurrence.scheduleId, at]);
    if (tuples.has(tuple)) throw new Error('Recurring portable history repeats a nominal instant.');
    tuples.add(tuple);
    const accepted = occurrence.state === 'admission-accepted';
    const acceptedAttempts = occurrence.attempts.filter((attempt) => attempt.code === 'accepted');
    if (
      occurrence.id !== deriveEntityId('occ', [occurrence.scheduleId, occurrence.scheduledAt]) ||
      occurrence.originRequestId !==
        recurringRequestId(schedule.originScheduleId, occurrence.scheduledAt) ||
      Date.parse(occurrence.deadline) !== at + RECURRING_DEADLINE_MS ||
      (occurrence.snapshot.monthlyUtc !== undefined &&
        !recurringNominalMatches({ monthlyUtc: occurrence.snapshot.monthlyUtc }, at)) ||
      occurrence.attempts.some(
        (attempt, index) =>
          attempt.number !== index + 1 ||
          Date.parse(attempt.at) < at ||
          Date.parse(attempt.at) >= Date.parse(occurrence.deadline) ||
          (index > 0 && Date.parse(attempt.at) < Date.parse(occurrence.attempts[index - 1]!.at))
      ) ||
      (occurrence.state === 'pending') !== (occurrence.terminalAt === null) ||
      (accepted
        ? acceptedAttempts.length !== 1 ||
          occurrence.attempts.at(-1)?.code !== 'accepted' ||
          !occurrence.originQueueEntryId ||
          !occurrence.originTurnId ||
          !occurrence.turnId ||
          !occurrence.resolvedSelection
        : acceptedAttempts.length !== 0 ||
          occurrence.originQueueEntryId !== null ||
          occurrence.originTurnId !== null ||
          occurrence.turnId !== null) ||
      (occurrence.state === 'admission-failed' && occurrence.attempts.length !== 3) ||
      (occurrence.state === 'pending' && occurrence.attempts.length === 3) ||
      (occurrence.terminalAt !== null &&
        Date.parse(occurrence.terminalAt) <
          Math.max(
            Date.parse(occurrence.createdAt),
            ...occurrence.attempts.map((attempt) => Date.parse(attempt.at))
          ))
    )
      throw new Error('Recurring portable occurrence contradicts its bounded admission history.');
    if (occurrence.turnId !== null) {
      if (linkedTurns.has(occurrence.turnId))
        throw new Error('Recurring portable occurrences share one retained Turn.');
      linkedTurns.add(occurrence.turnId);
    }
    if (
      references &&
      occurrence.turnId !== null &&
      references.turns.get(occurrence.turnId) !== occurrence.snapshot.threadId
    )
      throw new Error('Recurring portable history has an unresolved retained Turn reference.');
  }
  for (const schedule of graph.schedules) {
    for (const admission of schedule.externalAdmissions ?? []) {
      if (
        !graph.occurrences.some(
          (occurrence) =>
            occurrence.scheduleId === schedule.id &&
            occurrence.turnId === admission.sourceTurnId &&
            occurrence.state === 'admission-accepted'
        )
      )
        throw new Error('External trigger history has no accepted source poll occurrence.');
    }
  }
  for (const range of graph.expiredRanges) {
    claimId(range.id);
    const first = Date.parse(range.firstScheduledAt);
    const last = Date.parse(range.lastScheduledAt);
    requireSchedule(range, last);
    validateRecurringRangeCoverage(range);
    if (Date.parse(range.terminalAt) < last + RECURRING_DEADLINE_MS)
      throw new Error('Recurring portable range has contradictory terminal time.');
    const ranges = coverage.get(range.scheduleId) ?? [];
    // A schedule accounts time in ascending order, including across paused definition edits.
    if (
      ranges.some(
        (prior) =>
          first <= Date.parse(prior.lastScheduledAt) && last >= Date.parse(prior.firstScheduledAt)
      )
    )
      throw new Error('Recurring portable ranges overlap.');
    ranges.push(range);
    coverage.set(range.scheduleId, ranges);
  }
  for (const occurrence of graph.occurrences) {
    const at = Date.parse(occurrence.scheduledAt);
    if (
      coverage
        .get(occurrence.scheduleId)
        ?.some(
          (range) =>
            at >= Date.parse(range.firstScheduledAt) &&
            at <= Date.parse(range.lastScheduledAt) &&
            recurringPrefixThrough(range, Date.parse(range.firstScheduledAt), at)?.last === at
        )
    )
      throw new Error('Recurring portable range overlaps an individual nominal instant.');
  }
  return graph;
}

/** Validates the existing inert import file without granting any target execution authority. */
export function validateRecurringPortableHistory(text: string): void {
  readRecurringPortableHistory(JSON.parse(text));
}

/** Captures the whitelist under the caller's Workspace mutation fence and exact exported canonical Turn graph. */
export function exportRecurringPortableHistory(
  coreDb: CoreDb | undefined,
  workspaceId: string,
  inherited: string | null,
  retainedTurns: readonly { id: string; threadId: string }[]
): RecurringPortableHistory {
  const graph =
    inherited === null
      ? ({ schedules: [], occurrences: [], expiredRanges: [] } as RecurringPortableHistory)
      : readRecurringPortableHistory(JSON.parse(inherited));
  if (graph.schedules.some((schedule) => schedule.workspaceId !== workspaceId))
    throw new Error('Imported recurring history contradicts its owning Workspace.');
  if (!coreDb) return graph;
  const readRows = (
    table: 'recurring_schedules' | 'recurring_occurrences' | 'recurring_expired_ranges'
  ) =>
    (
      coreDb.sqlite
        .prepare(
          `SELECT schema_version AS schemaVersion, record_json FROM ${table} WHERE workspace_id = ? ORDER BY id`
        )
        .all(workspaceId) as { schemaVersion: unknown; record_json: string }[]
    ).map((row) => readRetainedV1(row, () => row.record_json));
  const turns = new Map(retainedTurns.map((turn) => [turn.id, turn.threadId]));
  const sourceSchedules = readRows('recurring_schedules').map(readRecurringSchedule);
  const externalAdmissions = listWorkspaceExternalTriggerAdmissions(coreDb, workspaceId);
  const schedules = sourceSchedules.map(({ actor, ...schedule }) => ({
    ...schedule,
    originScheduleId: schedule.id,
    originActor: actor,
    ...(externalAdmissions.some((admission) => admission.scheduleId === schedule.id)
      ? {
          externalAdmissions: externalAdmissions.filter(
            (admission) => admission.scheduleId === schedule.id
          ),
        }
      : {}),
  }));
  const occurrences = readRows('recurring_occurrences')
    .map(readRecurringOccurrence)
    .map((row) => {
      const { actor, ...snapshot } = row.snapshot;
      if (row.state === 'admission-accepted' && (!row.turnId || !turns.has(row.turnId)))
        throw new Error('Recurring publication requires inspection before portable export.');
      if (row.turnId && turns.has(row.turnId) && turns.get(row.turnId) !== row.snapshot.threadId)
        throw new Error('Recurring source Turn contradicts its exported Thread.');
      return portableOccurrence.parse({
        ...row,
        snapshot: { ...snapshot, originActor: actor },
        originRequestId: row.requestId,
        originQueueEntryId: row.queueEntryId,
        originTurnId: row.turnId,
        turnId: row.turnId && turns.has(row.turnId) ? row.turnId : null,
        resolvedSelection: row.resolvedPayload
          ? {
              agentId: row.resolvedPayload.requestedAgentId,
              profileId: row.resolvedPayload.profileRef,
              modelId: row.resolvedPayload.modelId,
              ...(row.resolvedPayload.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: row.resolvedPayload.reasoningEffort }),
            }
          : null,
      });
    });
  const expiredRanges = readRows('recurring_expired_ranges').map((text) => {
    const {
      snapshot: { actor, ...snapshot },
      ...range
    } = ExpiredOccurrenceRangeSchema.parse(JSON.parse(text));
    return { ...range, snapshot: { ...snapshot, originActor: actor } };
  });
  if (schedules.some((schedule) => schedule.workspaceId !== workspaceId))
    throw new Error('Core recurring history contradicts its selected Workspace.');
  return readRecurringPortableHistory({
    schedules: [...graph.schedules, ...schedules],
    occurrences: [...graph.occurrences, ...occurrences],
    expiredRanges: [...graph.expiredRanges, ...expiredRanges],
  });
}

/** Reads all three verified JSONL families; partial families and torn lines fail closed. */
export function readRecurringPortableFiles(
  files: ReadonlyMap<string, string>,
  references: RecurringPortableReferences
): RecurringPortableHistory {
  const values = Object.entries(RECURRING_PORTABLE_PATHS).map(([family, path]) => {
    const text = files.get(path);
    if (text === undefined) throw new Error(`Missing recurring portable file: ${path}`);
    if (text !== '' && !text.endsWith('\n'))
      throw new Error(`Uncommitted recurring portable file: ${path}`);
    return [
      family,
      text === ''
        ? []
        : text
            .slice(0, -1)
            .split('\n')
            .map((line) => JSON.parse(line)),
    ];
  });
  return readRecurringPortableHistory(Object.fromEntries(values), references);
}

/** Approved import allocations and existing canonical import maps, never source-selected authority. */
export interface RecurringPortableImportMaps {
  workspaceId: string;
  scheduleIds: ReadonlyMap<string, string>;
  occurrenceIds: ReadonlyMap<string, string>;
  rangeIds: ReadonlyMap<string, string>;
  threadIds: ReadonlyMap<string, string>;
  turnIds: ReadonlyMap<string, string>;
}

/** Rewrites an already validated history graph; this function allocates no identity or live Core row. */
export function remapRecurringPortableHistory(
  source: RecurringPortableHistory,
  maps: RecurringPortableImportMaps
): RecurringPortableHistory {
  const graph = readRecurringPortableHistory(source);
  const requireId = (ids: ReadonlyMap<string, string>, id: string, kind: string) => {
    const target = ids.get(id);
    if (!target) throw new Error(`Recurring import has no ${kind} import mapping.`);
    return target;
  };
  const rewriteSnapshot = (snapshot: z.infer<typeof portableSnapshot>) => ({
    ...snapshot,
    threadId: requireId(maps.threadIds, snapshot.threadId, 'Thread'),
  });
  const schedules = graph.schedules.map((schedule) => ({
    ...schedule,
    id: requireId(maps.scheduleIds, schedule.id, 'schedule'),
    workspaceId: maps.workspaceId,
    threadId: requireId(maps.threadIds, schedule.threadId, 'Thread'),
    ...(schedule.externalAdmissions
      ? {
          externalAdmissions: schedule.externalAdmissions.map((admission) => ({
            ...admission,
            scheduleId: requireId(maps.scheduleIds, admission.scheduleId, 'schedule'),
            sourceTurnId: requireId(maps.turnIds, admission.sourceTurnId, 'Turn'),
          })),
        }
      : {}),
  }));
  const occurrences = graph.occurrences.map((occurrence) => ({
    ...occurrence,
    id: requireId(maps.occurrenceIds, occurrence.id, 'occurrence'),
    scheduleId: requireId(maps.scheduleIds, occurrence.scheduleId, 'schedule'),
    workspaceId: maps.workspaceId,
    snapshot: rewriteSnapshot(occurrence.snapshot),
    turnId: occurrence.turnId === null ? null : requireId(maps.turnIds, occurrence.turnId, 'Turn'),
  }));
  const expiredRanges = graph.expiredRanges.map((range) => ({
    ...range,
    id: requireId(maps.rangeIds, range.id, 'expired range'),
    scheduleId: requireId(maps.scheduleIds, range.scheduleId, 'schedule'),
    workspaceId: maps.workspaceId,
    snapshot: rewriteSnapshot(range.snapshot),
  }));
  return readRecurringPortableHistory(
    { schedules, occurrences, expiredRanges },
    {
      workspaceId: maps.workspaceId,
      threadIds: new Set(maps.threadIds.values()),
      turns: new Map(
        graph.occurrences
          .filter((row) => row.turnId !== null)
          .map((row) => [
            requireId(maps.turnIds, row.turnId!, 'Turn'),
            requireId(maps.threadIds, row.snapshot.threadId, 'Thread'),
          ])
      ),
    }
  );
}
