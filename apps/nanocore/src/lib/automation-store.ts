import {
  type AutomationRecord,
  type CreateAutomationRequest,
  CreateAutomationRequestSchema,
  type UpdateAutomationRequest,
  UpdateAutomationRequestSchema,
} from '@openkit/app-api-schemas';
import { allocateEntityId, compareCodeUnits, readRetainedV1 } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import {
  accountRecurringExpiredPrefix,
  advanceRecurringSchedule,
  newRecurringOccurrence,
  nextRecurringNominal,
} from '../storage/automation-definition-native.js';
import type { CoreDb } from '../storage/db.js';
import {
  RECURRING_DEADLINE_MS as DEADLINE_MS,
  type ExpiredOccurrenceRange,
  ExpiredOccurrenceRangeSchema,
  type RecurringOccurrence,
  type RecurringPreparation,
  readRecurringOccurrence,
  readRecurringSchedule,
} from '../storage/recurring-records.js';
import { StoredAutomationCadenceV1Schema } from '../storage/recurring-retained-v1.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { recurringPrefixThrough } from './recurring-cadence.js';

const SCAN_LIMIT = 128;

export {
  AutomationMutationError,
  AutomationRecordNotFoundError,
} from '../storage/scheduler-admission-codecs.js';

import {
  findRecurringAutomationFromDb,
  finishRecurringOccurrenceInDb,
  readRecurringOccurrenceFromDb,
  writeRecurringOccurrenceInDb,
} from '../storage/recurring-attempt-native.js';
import {
  type AutomationDefinitionMutation,
  AutomationMutationError,
  AutomationRecordNotFoundError,
} from '../storage/scheduler-admission-codecs.js';
import { publishSchedulerAdmission } from '../storage/scheduler-admission-publication.js';

/** Durable Workspace schedule authority sharing the scheduler's Core SQLite connection. */
export class AutomationStore {
  public constructor(
    public readonly coreDb: CoreDb,
    public readonly mutationAdmission: WorkspaceMutationAdmission,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    // Each actual connection needs this deterministic function before its first scan. Re-registering
    // the same pure callback when another Store uses that connection does not add persistent state.
    coreDb.sqlite.function(
      'recurring_live_frontier',
      { deterministic: true },
      (schemaVersion: unknown, recordJson: unknown, first: unknown, through: unknown) =>
        readRetainedV1({ schemaVersion }, () => {
          if (
            typeof recordJson !== 'string' ||
            typeof first !== 'number' ||
            typeof through !== 'number'
          )
            throw new Error('Recurring scan has invalid required timing values.');
          const cadence = StoredAutomationCadenceV1Schema.parse(JSON.parse(recordJson));
          const coverage = recurringPrefixThrough(cadence, first, through);
          return coverage ? coverage.next : first;
        })
    );
  }

  /** Resolves immutable lineage before current Workspace admission; ownership grants no extra privilege. */
  public getAutomationLineage(
    automationId: string
  ): { workspaceId: string; ownerUserId: string } | null {
    const schedule = this.findSchedule(automationId);
    return schedule
      ? { workspaceId: schedule.workspaceId, ownerUserId: schedule.responsibleUserId }
      : null;
  }

  /** Lists every schedule in the already-admitted Workspace set, without substituting its actor. */
  public listAuthorizedAutomations(workspaceIds: readonly string[]): AutomationRecord[] {
    if (!workspaceIds.length) return [];
    return this.readSchedules(
      `workspace_id IN (${workspaceIds.map(() => '?').join(',')})`,
      ...workspaceIds
    );
  }

  /** Reads the definition, including a retained deleted identity tombstone. */
  public getAutomation(automationId: string): AutomationRecord {
    const record = this.findSchedule(automationId);
    if (!record) throw new AutomationRecordNotFoundError(`Automation not found: ${automationId}`);
    return record;
  }

  /** Creates the exact paused definition through the existing native Core publisher. */
  public async createAutomation(
    userId: string,
    value: CreateAutomationRequest,
    authorization?: { readonly actor: Actor; readonly revalidate?: () => Promise<void> }
  ): Promise<AutomationRecord> {
    const input = CreateAutomationRequestSchema.strict().parse(value);
    const result = await this.publishDefinition(
      userId,
      input.workspaceId,
      { action: 'create', id: allocateEntityId('auto'), input },
      authorization
    );
    if (!result) throw new Error('Native definition create returned no record.');
    return result;
  }

  /** Publishes revision-protected edits and their complete old-cadence history tuple. */
  public async updateAutomation(
    userId: string,
    automationId: string,
    value: UpdateAutomationRequest,
    authorization?: { readonly actor: Actor; readonly revalidate?: () => Promise<void> }
  ): Promise<AutomationRecord> {
    const input = UpdateAutomationRequestSchema.strict().parse(value);
    const result = await this.publishDefinition(
      userId,
      this.getAutomation(automationId).workspaceId,
      { action: 'update', id: automationId, input },
      authorization
    );
    if (!result) throw new Error('Native definition update returned no record.');
    return result;
  }

  /** Publishes the original terminal tombstone without cancelling accepted work. */
  public async deleteAutomation(
    userId: string,
    automationId: string,
    authorization?: { readonly actor: Actor; readonly revalidate?: () => Promise<void> }
  ): Promise<void> {
    await this.publishDefinition(
      userId,
      this.getAutomation(automationId).workspaceId,
      { action: 'delete', id: automationId },
      authorization
    );
  }

  /** Selects at most 128 live candidates before recording bounded expired backlog; no worker runs here. */
  public collectScanCandidates(
    timestamp: string,
    onError?: (error: unknown) => void
  ): RecurringOccurrence[] {
    const now = Date.parse(timestamp);
    const releases = new Map<string, () => void>();
    const admit = (workspaceId: string) => {
      if (releases.has(workspaceId)) return true;
      const release = this.mutationAdmission.enter(workspaceId);
      if (!release) return false;
      releases.set(workspaceId, release);
      return true;
    };
    try {
      return this.coreDb.sqlite
        .transaction(() => {
          const candidates: {
            schedule: AutomationRecord;
            at: number;
            occurrence?: RecurringOccurrence;
          }[] = [];
          const pending = this.coreDb.sqlite
            .prepare(`SELECT occurrence.schema_version AS schemaVersion, occurrence.record_json FROM recurring_occurrences occurrence
        JOIN recurring_schedules schedule ON schedule.id = occurrence.schedule_id
        WHERE occurrence.state = 'pending' AND occurrence.deadline > ? AND occurrence.scheduled_at <= ?
          AND schedule.status = 'active' ORDER BY occurrence.deadline, occurrence.id LIMIT ?`)
            .all(now, now, SCAN_LIMIT) as JsonRow[];
          for (const row of pending) {
            const occurrence = readRetainedV1(row, () => readRecurringOccurrence(row.record_json));
            if (!admit(occurrence.workspaceId)) continue;
            candidates.push({
              schedule: this.getAutomation(occurrence.scheduleId),
              at: Date.parse(occurrence.scheduledAt),
              occurrence,
            });
          }
          // Compute the live frontier directly from the one durable cursor. An arbitrarily old
          // prefix becomes one range in the same transaction that materializes its live successor.
          const schedules = this.coreDb.sqlite
            .prepare(`SELECT schema_version AS schemaVersion, record_json FROM recurring_schedules
        WHERE status = 'active' AND next_scheduled_at <= ?
        ORDER BY recurring_live_frontier(schema_version, record_json, next_scheduled_at, ?), id LIMIT ?`)
            .all(now, now - DEADLINE_MS, SCAN_LIMIT) as JsonRow[];
          for (const row of schedules) {
            const schedule = readRetainedV1(row, () => readRecurringSchedule(row.record_json));
            if (!admit(schedule.workspaceId)) continue;
            const next = Date.parse(schedule.nextScheduledAt!);
            const coverage = recurringPrefixThrough(schedule, next, now - DEADLINE_MS);
            const first = coverage ? coverage.next : next;
            for (
              let at = first, count = 0;
              at !== null && at <= now && count < SCAN_LIMIT;
              at = nextRecurringNominal(schedule, at), count++
            )
              candidates.push({ schedule, at });
          }
          candidates.sort((a, b) => a.at - b.at || compareCodeUnits(a.schedule.id, b.schedule.id));
          let expiredRangeCount = 0;
          const selected = candidates.slice(0, SCAN_LIMIT).map((candidate) => {
            if (candidate.occurrence) return candidate.occurrence;
            let schedule = this.getAutomation(candidate.schedule.id);
            if (Date.parse(schedule.nextScheduledAt!) <= now - DEADLINE_MS) expiredRangeCount++;
            schedule = accountRecurringExpiredPrefix(
              this.coreDb,
              schedule,
              now,
              timestamp,
              onError
            );
            const occurrence = newRecurringOccurrence(schedule, candidate.at, timestamp);
            this.writeOccurrence(occurrence, true);
            advanceRecurringSchedule(this.coreDb, schedule, candidate.at, onError);
            return occurrence;
          });
          // Expiring pending history and expired-only schedules also have a fixed per-scan bound.
          const stale = this.coreDb.sqlite
            .prepare(`SELECT schema_version AS schemaVersion, record_json FROM recurring_occurrences
        WHERE state = 'pending' AND deadline <= ? ORDER BY deadline, id LIMIT ?`)
            .all(now, SCAN_LIMIT) as JsonRow[];
          for (const row of stale) {
            const occurrence = readRetainedV1(row, () => readRecurringOccurrence(row.record_json));
            if (admit(occurrence.workspaceId)) this.finish(occurrence, 'expired', timestamp);
          }
          for (const row of this.coreDb.sqlite
            .prepare(`SELECT schema_version AS schemaVersion, record_json FROM recurring_schedules
        WHERE status = 'active' AND next_scheduled_at <= ? ORDER BY next_scheduled_at, id LIMIT ?`)
            .all(now - DEADLINE_MS, SCAN_LIMIT - expiredRangeCount) as JsonRow[]) {
            const schedule = readRetainedV1(row, () => readRecurringSchedule(row.record_json));
            if (admit(schedule.workspaceId))
              accountRecurringExpiredPrefix(this.coreDb, schedule, now, timestamp, onError);
          }
          return selected;
        })
        .immediate();
    } finally {
      for (const release of releases.values()) release();
    }
  }

  /** Atomically records one attempt and exact queue acceptance, or proves an existing deterministic acceptance. */
  public async commitAttempt(
    occurrenceId: string,
    definitionRevision: number,
    preparation: RecurringPreparation,
    revalidate?: () => RecurringPreparation | undefined
  ): Promise<RecurringOccurrence | null> {
    const release = this.mutationAdmission.enter(this.getOccurrence(occurrenceId).workspaceId);
    if (!release) throw new AutomationMutationError('Workspace mutations are fenced.');
    try {
      const result = await publishSchedulerAdmission(
        this.coreDb,
        {
          mode: 'recurring-attempt',
          occurrenceId,
          definitionRevision,
          preparation: structuredClone(preparation),
        },
        (request) => {
          // A supplied public source preflight stays distinct from the original trusted no-callback domain entry.
          const current =
            preparation.kind === 'recovery_required' || !revalidate
              ? undefined
              : (revalidate() ?? preparation);
          return {
            ...request,
            ...(current ? { current } : {}),
            ...(request.mode === 'recurring-attempt' ? { timestamp: this.now() } : {}),
          };
        }
      );
      if (result.kind !== 'occurrence')
        throw new Error('Native recurring attempt returned the wrong result.');
      return result.occurrence;
    } finally {
      release();
    }
  }

  /** Reads one validated individual occurrence, including its immutable input and bounded attempts. */
  public getOccurrence(id: string): RecurringOccurrence {
    return readRecurringOccurrenceFromDb(this.coreDb, id);
  }

  /** Returns bounded history directly as individual occurrences or lossless ranges, newest first. */
  public listHistory(
    scheduleId: string,
    limit = 50,
    before?: string
  ): {
    items: (
      | { kind: 'occurrence'; record: RecurringOccurrence }
      | { kind: 'expired-range'; record: ExpiredOccurrenceRange }
    )[];
    nextBefore: string | null;
  } {
    if (!Number.isInteger(limit) || limit < 1 || limit > SCAN_LIMIT)
      throw new AutomationMutationError('History limit must be between 1 and 128.');
    const rows = this.coreDb.sqlite
      .prepare(`SELECT * FROM (
      SELECT 'occurrence' AS kind, scheduled_at AS instant, schema_version AS schemaVersion, record_json FROM recurring_occurrences WHERE schedule_id = ?
      UNION ALL SELECT 'expired-range' AS kind, first_scheduled_at AS instant, schema_version AS schemaVersion, record_json FROM recurring_expired_ranges WHERE schedule_id = ?
      ) WHERE instant < ? ORDER BY instant DESC LIMIT ?`)
      .all(
        scheduleId,
        scheduleId,
        before ? Date.parse(before) : Number.MAX_SAFE_INTEGER,
        limit + 1
      ) as (JsonRow & { kind: 'occurrence' | 'expired-range'; instant: number })[];
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) =>
        row.kind === 'occurrence'
          ? {
              kind: 'occurrence' as const,
              record: readRetainedV1(row, () => readRecurringOccurrence(row.record_json)),
            }
          : {
              kind: 'expired-range' as const,
              record: readRetainedV1(row, () =>
                ExpiredOccurrenceRangeSchema.parse(JSON.parse(row.record_json))
              ),
            }
      ),
      nextBefore: rows.length > limit ? new Date(selected.at(-1)!.instant).toISOString() : null,
    };
  }

  /** Commits a terminal trigger outcome without rewriting prior terminal history. */
  private finish(
    occurrence: RecurringOccurrence,
    state: RecurringOccurrence['state'],
    timestamp: string,
    insert = false
  ): RecurringOccurrence {
    return finishRecurringOccurrenceInDb(this.coreDb, occurrence, state, timestamp, insert);
  }

  /** Holds the existing Workspace admission through FULL acknowledgement, with current public admission rechecked after open. */
  private async publishDefinition(
    userId: string,
    workspaceId: string,
    mutation: AutomationDefinitionMutation,
    authorization?: { readonly actor: Actor; readonly revalidate?: () => Promise<void> }
  ): Promise<AutomationRecord | null> {
    const release = this.mutationAdmission.enter(workspaceId);
    if (!release) throw new AutomationMutationError('Workspace mutations are fenced.');
    try {
      const result = await publishSchedulerAdmission(
        this.coreDb,
        {
          mode: 'definition',
          userId,
          workspaceId,
          mutation,
          ...(authorization ? { actor: authorization.actor } : {}),
        },
        async (request) => {
          await authorization?.revalidate?.();
          return { ...request, timestamp: this.now() };
        }
      );
      if (result.kind !== 'definition')
        throw new Error('Native definition returned the wrong result.');
      return result.record;
    } finally {
      release();
    }
  }

  /** Writes both indexed selectors and the validated known-core payload in one owner mutation. */
  private writeOccurrence(record: RecurringOccurrence, insert = false): void {
    writeRecurringOccurrenceInDb(this.coreDb, record, insert);
  }

  /** Reads the one definition authority without private content enumeration. */
  private findSchedule(id: string): AutomationRecord | null {
    return findRecurringAutomationFromDb(this.coreDb, id);
  }

  /** Reads a bounded owner-selected definition collection. */
  private readSchedules(where: string, ...parameters: string[]): AutomationRecord[] {
    return (
      this.coreDb.sqlite
        .prepare(
          `SELECT schema_version AS schemaVersion, record_json FROM recurring_schedules WHERE ${where} ORDER BY id`
        )
        .all(...parameters) as JsonRow[]
    ).map((row) => readRetainedV1(row, () => readRecurringSchedule(row.record_json)));
  }
}

type JsonRow = { schemaVersion: unknown; record_json: string };
