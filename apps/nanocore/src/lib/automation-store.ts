import { randomUUID } from 'node:crypto';
import {
  type AutomationRecord,
  AutomationRecordSchema,
  type CreateAutomationRequest,
  CreateAutomationRequestSchema,
  type UpdateAutomationRequest,
  UpdateAutomationRequestSchema,
} from '@openkit/app-api-schemas';
import { recordServerAuditEvent } from '../audit-events.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
  SchedulerAdmissionTransitionError,
  schedulerAdmissionInputHash,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import {
  RECURRING_DEADLINE_MS as DEADLINE_MS,
  type ExpiredOccurrenceRange,
  ExpiredOccurrenceRangeSchema,
  RecurringAdmissionPayloadSchema,
  type RecurringOccurrence,
  type RecurringPreparation,
  readRecurringOccurrence,
  recurringRequestId,
  recurringSchedulerAdmissionInput,
} from '../storage/recurring-records.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

const SCAN_LIMIT = 128;

/** Native record absence, distinguished from unexpected storage failures. */
export class AutomationRecordNotFoundError extends Error {}
/** A stale revision or invalid lifecycle request has no effect. */
export class AutomationMutationError extends Error {}

/** Durable Workspace schedule authority sharing the scheduler's Core SQLite connection. */
export class AutomationStore {
  public constructor(
    public readonly coreDb: CoreDb,
    public readonly mutationAdmission: WorkspaceMutationAdmission,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

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
      `status <> 'deleted' AND workspace_id IN (${workspaceIds.map(() => '?').join(',')})`,
      ...workspaceIds
    );
  }

  /** Reads the definition, including a retained deleted identity tombstone. */
  public getAutomation(automationId: string): AutomationRecord {
    const record = this.findSchedule(automationId);
    if (!record) throw new AutomationRecordNotFoundError(`Automation not found: ${automationId}`);
    return record;
  }

  /** Creates a paused definition with an immutable exact automation actor. */
  public createAutomation(userId: string, value: CreateAutomationRequest): AutomationRecord {
    const input = CreateAutomationRequestSchema.strict().parse(value);
    const timestamp = this.now();
    const id = `auto_${randomUUID()}`;
    const record: AutomationRecord = {
      ...input,
      id,
      responsibleUserId: userId,
      actor: { kind: 'automation', id, responsibleUserId: userId },
      status: 'paused',
      revision: 1,
      nextScheduledAt: null,
      greatestAccountedScheduledAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    return this.withMutation(record.workspaceId, () =>
      this.coreDb.sqlite
        .transaction(() => {
          this.writeSchedule(record, true);
          this.auditDefinition(record, userId, 'created');
          return record;
        })
        .immediate()
    );
  }

  /** Pauses or resumes a schedule, or edits an already-paused definition with revision protection. */
  public updateAutomation(
    userId: string,
    automationId: string,
    value: UpdateAutomationRequest
  ): AutomationRecord {
    const input = UpdateAutomationRequestSchema.strict().parse(value);
    return this.withMutation(this.getAutomation(automationId).workspaceId, () =>
      this.coreDb.sqlite
        .transaction(() => {
          let schedule = this.getAutomation(automationId);
          if (schedule.status === 'deleted' || schedule.revision !== input.expectedRevision)
            throw new AutomationMutationError(
              'Recurring schedule revision or lifecycle conflicts.'
            );
          const timestamp = this.now();
          const { expectedRevision: _revision, status, scheduledAt, ...edits } = input;
          const editing = Object.keys(edits).length > 0;
          if (!editing && status === undefined)
            throw new AutomationMutationError('A recurring schedule mutation is required.');
          if (editing && (schedule.status !== 'paused' || status === 'active'))
            throw new AutomationMutationError('Edit requires a paused recurring schedule.');
          if (status === 'active') {
            if (
              schedule.status !== 'paused' ||
              !scheduledAt ||
              Date.parse(scheduledAt) < Date.parse(timestamp) ||
              (schedule.greatestAccountedScheduledAt !== null &&
                Date.parse(scheduledAt) <= Date.parse(schedule.greatestAccountedScheduledAt))
            )
              throw new AutomationMutationError(
                'Resume requires a new current-or-future nominal instant.'
              );
            schedule = {
              ...schedule,
              status,
              nextScheduledAt: new Date(scheduledAt).toISOString(),
            };
          } else {
            if (scheduledAt !== undefined)
              throw new AutomationMutationError('A nominal instant is accepted only on resume.');
            if (status === 'paused') schedule = this.sealSchedule(schedule, timestamp);
            const candidate = { ...schedule, ...edits };
            for (const field of ['agentId', 'profileId', 'modelId'] as const)
              if (candidate[field] === null) delete candidate[field];
            schedule = AutomationRecordSchema.parse(candidate);
          }
          const updated = { ...schedule, revision: schedule.revision + 1, updatedAt: timestamp };
          this.writeSchedule(updated);
          this.auditDefinition(
            updated,
            userId,
            status === 'active' ? 'resumed' : status === 'paused' ? 'paused' : 'edited'
          );
          return updated;
        })
        .immediate()
    );
  }

  /** Seals the old cadence and retains a terminal identity tombstone without cancelling accepted work. */
  public deleteAutomation(userId: string, automationId: string): void {
    this.withMutation(this.getAutomation(automationId).workspaceId, () =>
      this.coreDb.sqlite
        .transaction(() => {
          let schedule = this.getAutomation(automationId);
          if (schedule.status === 'deleted') return;
          const timestamp = this.now();
          schedule = this.sealSchedule(schedule, timestamp);
          const deleted: AutomationRecord = {
            ...schedule,
            status: 'deleted',
            revision: schedule.revision + 1,
            updatedAt: timestamp,
            deletedAt: timestamp,
          };
          this.writeSchedule(deleted);
          this.auditDefinition(deleted, userId, 'deleted');
        })
        .immediate()
    );
  }

  /** Selects at most 128 live candidates before recording bounded expired backlog; no worker runs here. */
  public collectScanCandidates(timestamp: string): RecurringOccurrence[] {
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
            .prepare(`SELECT occurrence.record_json FROM recurring_occurrences occurrence
        JOIN recurring_schedules schedule ON schedule.id = occurrence.schedule_id
        WHERE occurrence.state = 'pending' AND occurrence.deadline > ? AND occurrence.scheduled_at <= ?
          AND schedule.status = 'active' ORDER BY occurrence.deadline, occurrence.id LIMIT ?`)
            .all(now, now, SCAN_LIMIT) as JsonRow[];
          for (const row of pending) {
            const occurrence = readRecurringOccurrence(row.record_json);
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
            .prepare(`SELECT record_json FROM recurring_schedules
        WHERE status = 'active' AND next_scheduled_at <= ?
        ORDER BY CASE WHEN next_scheduled_at > ? THEN next_scheduled_at ELSE
          next_scheduled_at + (CAST((? - next_scheduled_at) /
            (json_extract(record_json, '$.intervalSeconds') * 1000) AS INTEGER) + 1) *
            (json_extract(record_json, '$.intervalSeconds') * 1000) END, id LIMIT ?`)
            .all(now, now - DEADLINE_MS, now - DEADLINE_MS, SCAN_LIMIT) as JsonRow[];
          for (const row of schedules) {
            const schedule = readSchedule(row.record_json);
            if (!admit(schedule.workspaceId)) continue;
            const next = Date.parse(schedule.nextScheduledAt!);
            const step = schedule.intervalSeconds * 1000;
            const first =
              next + Math.max(0, Math.floor((now - DEADLINE_MS - next) / step) + 1) * step;
            for (let at = first, count = 0; at <= now && count < SCAN_LIMIT; at += step, count++)
              candidates.push({ schedule, at });
          }
          candidates.sort((a, b) => a.at - b.at || a.schedule.id.localeCompare(b.schedule.id));
          let expiredRangeCount = 0;
          const selected = candidates.slice(0, SCAN_LIMIT).map((candidate) => {
            if (candidate.occurrence) return candidate.occurrence;
            let schedule = this.getAutomation(candidate.schedule.id);
            if (Date.parse(schedule.nextScheduledAt!) <= now - DEADLINE_MS) expiredRangeCount++;
            schedule = this.accountExpiredPrefix(schedule, now, timestamp);
            const occurrence = this.newOccurrence(schedule, candidate.at, timestamp);
            this.writeOccurrence(occurrence, true);
            this.advanceSchedule(schedule, candidate.at);
            return occurrence;
          });
          // Expiring pending history and expired-only schedules also have a fixed per-scan bound.
          const stale = this.coreDb.sqlite
            .prepare(`SELECT record_json FROM recurring_occurrences
        WHERE state = 'pending' AND deadline <= ? ORDER BY deadline, id LIMIT ?`)
            .all(now, SCAN_LIMIT) as JsonRow[];
          for (const row of stale) {
            const occurrence = readRecurringOccurrence(row.record_json);
            if (admit(occurrence.workspaceId)) this.finish(occurrence, 'expired', timestamp);
          }
          for (const row of this.coreDb.sqlite
            .prepare(`SELECT record_json FROM recurring_schedules
        WHERE status = 'active' AND next_scheduled_at <= ? ORDER BY next_scheduled_at, id LIMIT ?`)
            .all(now - DEADLINE_MS, SCAN_LIMIT - expiredRangeCount) as JsonRow[]) {
            const schedule = readSchedule(row.record_json);
            if (admit(schedule.workspaceId)) this.accountExpiredPrefix(schedule, now, timestamp);
          }
          return selected;
        })
        .immediate();
    } finally {
      for (const release of releases.values()) release();
    }
  }

  /** Atomically records one attempt and exact queue acceptance, or proves an existing deterministic acceptance. */
  public commitAttempt(
    occurrenceId: string,
    definitionRevision: number,
    preparation: RecurringPreparation,
    revalidate?: () => RecurringPreparation | undefined
  ): RecurringOccurrence | null {
    return this.withMutation(this.getOccurrence(occurrenceId).workspaceId, () =>
      this.coreDb.sqlite
        .transaction(() => {
          let occurrence = this.getOccurrence(occurrenceId);
          if (occurrence.state !== 'pending') return occurrence;
          const schedule = this.getAutomation(occurrence.scheduleId);
          if (
            schedule.status !== 'active' ||
            schedule.revision !== definitionRevision ||
            occurrence.definitionRevision !== definitionRevision
          )
            return null;
          const timestamp = this.now();
          const now = Date.parse(timestamp);
          if (now < Date.parse(occurrence.scheduledAt)) return occurrence;
          if (now >= Date.parse(occurrence.deadline))
            return this.finish(occurrence, 'expired', timestamp);
          const payload =
            preparation.kind === 'ready' || preparation.kind === 'failure'
              ? preparation.payload
              : undefined;
          const resolved =
            occurrence.resolvedPayload ??
            (payload ? RecurringAdmissionPayloadSchema.parse(payload) : null);
          if (
            occurrence.resolvedPayload &&
            payload &&
            JSON.stringify(RecurringAdmissionPayloadSchema.parse(payload)) !==
              JSON.stringify(occurrence.resolvedPayload)
          )
            return this.finish(occurrence, 'recovery_required', timestamp);
          const request = resolved
            ? recurringSchedulerAdmissionInput(occurrence, resolved, timestamp)
            : null;
          const ownQueues = this.coreDb.sqlite
            .prepare(`SELECT queue_entry_id FROM scheduler_admission_entries
        WHERE queue_entry_id = ? OR request_id = ? OR turn_id = ? LIMIT 2`)
            .all(
              `queue_recurring_${occurrence.requestId}`,
              occurrence.requestId,
              `turn_recurring_${occurrence.requestId}`
            ) as { queue_entry_id: string }[];
          if (ownQueues.length > 1) return this.finish(occurrence, 'recovery_required', timestamp);
          if (ownQueues[0]) {
            const existing = requireSchedulerAdmissionEntry(
              this.coreDb,
              ownQueues[0].queue_entry_id
            );
            if (
              !request ||
              existing.queueEntryId !== request.queueEntryId ||
              existing.inputHash !== schedulerAdmissionInputHash(request) ||
              schedulerAdmissionInputHash(existing) !== schedulerAdmissionInputHash(request)
            )
              return this.finish(occurrence, 'recovery_required', timestamp);
            occurrence = {
              ...occurrence,
              resolvedPayload: resolved,
              queueEntryId: existing.queueEntryId,
              turnId: existing.turnId,
            };
            return this.finish(occurrence, 'admission-accepted', timestamp);
          }
          const current = revalidate?.() ?? preparation;
          if (current.kind === 'recovery_required')
            return this.finish(occurrence, 'recovery_required', timestamp);
          let code = current.kind === 'failure' ? current.code : ('accepted' as const);
          if (code === 'accepted') {
            const waiting = this.coreDb.sqlite
              .prepare(`SELECT 1 FROM recurring_occurrences occurrence
          JOIN scheduler_admission_entries entry ON entry.queue_entry_id = occurrence.queue_entry_id
          WHERE occurrence.schedule_id = ? AND occurrence.id <> ?
            AND occurrence.state = 'admission-accepted' AND entry.status = 'queued' LIMIT 1`)
              .get(occurrence.scheduleId, occurrence.id);
            if (waiting) code = 'queue_backlog_full';
            else if (!request) code = 'selection_unavailable';
            else {
              try {
                const entry = createSchedulerAdmissionEntry(this.coreDb, request);
                occurrence = {
                  ...occurrence,
                  queueEntryId: entry.queueEntryId,
                  turnId: entry.turnId,
                };
              } catch (error) {
                if (!(error instanceof SchedulerAdmissionTransitionError)) throw error;
                code = error.reason === 'queue-full' ? 'queue_full' : 'admission_failed';
              }
            }
          }
          occurrence = {
            ...occurrence,
            resolvedPayload: resolved,
            attempts: [
              ...occurrence.attempts,
              {
                number: occurrence.attempts.length + 1,
                at: timestamp,
                code,
                summary:
                  code === 'accepted'
                    ? 'Scheduler admission accepted.'
                    : `Admission refused: ${code}.`,
              },
            ],
          };
          if (code === 'accepted') return this.finish(occurrence, 'admission-accepted', timestamp);
          if (occurrence.attempts.length === 3)
            return this.finish(occurrence, 'admission-failed', timestamp);
          this.writeOccurrence(occurrence);
          return occurrence;
        })
        .immediate()
    );
  }

  /** Reads one validated individual occurrence, including its immutable input and bounded attempts. */
  public getOccurrence(id: string): RecurringOccurrence {
    const row = this.coreDb.sqlite
      .prepare('SELECT record_json FROM recurring_occurrences WHERE id = ?')
      .get(id) as JsonRow | undefined;
    if (!row) throw new AutomationRecordNotFoundError(`Recurring occurrence not found: ${id}`);
    return readRecurringOccurrence(row.record_json);
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
      SELECT 'occurrence' AS kind, scheduled_at AS instant, record_json FROM recurring_occurrences WHERE schedule_id = ?
      UNION ALL SELECT 'expired-range' AS kind, first_scheduled_at AS instant, record_json FROM recurring_expired_ranges WHERE schedule_id = ?
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
          ? { kind: 'occurrence' as const, record: readRecurringOccurrence(row.record_json) }
          : {
              kind: 'expired-range' as const,
              record: ExpiredOccurrenceRangeSchema.parse(JSON.parse(row.record_json)),
            }
      ),
      nextBefore: rows.length > limit ? new Date(selected.at(-1)!.instant).toISOString() : null,
    };
  }

  /** Seals all old-cadence instants through the mutation time before pause, edit or delete. */
  private sealSchedule(schedule: AutomationRecord, timestamp: string): AutomationRecord {
    const now = Date.parse(timestamp);
    if (schedule.status === 'active' && schedule.nextScheduledAt) {
      schedule = this.accountExpiredPrefix(schedule, now, timestamp);
      const first = Date.parse(schedule.nextScheduledAt!);
      for (let at = first; at <= now; at += schedule.intervalSeconds * 1000) {
        const occurrence = this.newOccurrence(schedule, at, timestamp);
        this.finish(occurrence, 'cancelled', timestamp, true);
        schedule = this.advanceSchedule(schedule, at);
      }
    }
    for (const row of this.coreDb.sqlite
      .prepare(`SELECT record_json FROM recurring_occurrences
      WHERE schedule_id = ? AND state = 'pending'`)
      .all(schedule.id) as JsonRow[])
      this.finish(readRecurringOccurrence(row.record_json), 'cancelled', timestamp);
    return { ...schedule, status: 'paused', nextScheduledAt: null };
  }

  /** Records one exact old prefix and moves the same definition cursor atomically. */
  private accountExpiredPrefix(
    schedule: AutomationRecord,
    now: number,
    timestamp: string
  ): AutomationRecord {
    if (!schedule.nextScheduledAt) return schedule;
    const first = Date.parse(schedule.nextScheduledAt);
    if (first > now - DEADLINE_MS) return schedule;
    const step = schedule.intervalSeconds * 1000;
    const count = Math.floor((now - DEADLINE_MS - first) / step) + 1;
    const last = first + (count - 1) * step;
    const record: ExpiredOccurrenceRange = {
      id: `range_${recurringRequestId(schedule.id, schedule.nextScheduledAt)}`,
      scheduleId: schedule.id,
      workspaceId: schedule.workspaceId,
      definitionRevision: schedule.revision,
      intervalSeconds: schedule.intervalSeconds,
      firstScheduledAt: new Date(first).toISOString(),
      lastScheduledAt: new Date(last).toISOString(),
      count,
      snapshot: snapshot(schedule),
      reason: 'deadline_elapsed',
      createdAt: timestamp,
      terminalAt: timestamp,
    };
    this.coreDb.sqlite
      .prepare(`INSERT INTO recurring_expired_ranges
      (id, schedule_id, workspace_id, definition_revision, first_scheduled_at, last_scheduled_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.scheduleId,
        record.workspaceId,
        record.definitionRevision,
        first,
        last,
        JSON.stringify(record)
      );
    recordServerAuditEvent({
      coreDb: this.coreDb,
      workspaceId: schedule.workspaceId,
      actor: schedule.actor,
      threadId: schedule.threadId,
      action: 'recurring.range.expired',
      resource: record.id,
      resourceRevision: schedule.revision,
      outcome: 'failed',
      summary: `Expired nominal range ${record.firstScheduledAt} through ${record.lastScheduledAt}; count ${count}.`,
      now: new Date(timestamp),
    });
    return this.advanceSchedule(schedule, last);
  }

  /** Advances only nominal integer arithmetic, never callback time. */
  private advanceSchedule(schedule: AutomationRecord, at: number): AutomationRecord {
    const updated = {
      ...schedule,
      greatestAccountedScheduledAt: new Date(at).toISOString(),
      nextScheduledAt: new Date(at + schedule.intervalSeconds * 1000).toISOString(),
    };
    this.writeSchedule(updated);
    return updated;
  }

  /** Captures immutable authored inputs before any bounded preparation starts. */
  private newOccurrence(
    schedule: AutomationRecord,
    at: number,
    timestamp: string
  ): RecurringOccurrence {
    const scheduledAt = new Date(at).toISOString();
    const requestId = recurringRequestId(schedule.id, scheduledAt);
    return {
      id: `occ_${requestId}`,
      requestId,
      scheduleId: schedule.id,
      workspaceId: schedule.workspaceId,
      definitionRevision: schedule.revision,
      scheduledAt,
      deadline: new Date(at + DEADLINE_MS).toISOString(),
      snapshot: snapshot(schedule),
      resolvedPayload: null,
      state: 'pending',
      attempts: [],
      queueEntryId: null,
      turnId: null,
      createdAt: timestamp,
      terminalAt: null,
    };
  }

  /** Commits a terminal trigger outcome without rewriting prior terminal history. */
  private finish(
    occurrence: RecurringOccurrence,
    state: RecurringOccurrence['state'],
    timestamp: string,
    insert = false
  ): RecurringOccurrence {
    const updated = { ...occurrence, state, terminalAt: timestamp };
    this.writeOccurrence(updated, insert);
    recordServerAuditEvent({
      coreDb: this.coreDb,
      workspaceId: occurrence.workspaceId,
      actor: occurrence.snapshot.actor,
      threadId: occurrence.snapshot.threadId,
      turnId: occurrence.turnId,
      requestId: occurrence.requestId,
      action: `recurring.occurrence.${state}`,
      resource: occurrence.id,
      outcome:
        state === 'admission-accepted'
          ? 'succeeded'
          : state === 'cancelled'
            ? 'cancelled'
            : state === 'recovery_required'
              ? 'unknown'
              : 'failed',
      summary: `Recurring occurrence terminal: ${state}.`,
      now: new Date(timestamp),
    });
    return updated;
  }

  /** Uses the existing Workspace fence for every recurrence mutation, including scanner writes. */
  private withMutation<T>(workspaceId: string, operation: () => T): T {
    const release = this.mutationAdmission.enter(workspaceId);
    if (!release) throw new AutomationMutationError('Workspace mutations are fenced.');
    try {
      return operation();
    } finally {
      release();
    }
  }

  /** Attributes a definition mutation to its actual caller in the same Core transaction. */
  private auditDefinition(schedule: AutomationRecord, userId: string, action: string): void {
    recordServerAuditEvent({
      coreDb: this.coreDb,
      workspaceId: schedule.workspaceId,
      actor: { kind: 'user', id: userId },
      threadId: schedule.threadId,
      category: 'command',
      action: `recurring.schedule.${action}`,
      resource: schedule.id,
      resourceRevision: schedule.revision,
      outcome: 'succeeded',
      summary: `Recurring schedule ${action}.`,
      now: new Date(schedule.updatedAt),
    });
  }

  /** Writes both indexed selectors and the validated known-core payload in one owner mutation. */
  private writeOccurrence(record: RecurringOccurrence, insert = false): void {
    readRecurringOccurrence(JSON.stringify(record));
    if (insert)
      this.coreDb.sqlite
        .prepare(`INSERT INTO recurring_occurrences
      (id, schedule_id, workspace_id, scheduled_at, deadline, state, queue_entry_id, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.id,
          record.scheduleId,
          record.workspaceId,
          Date.parse(record.scheduledAt),
          Date.parse(record.deadline),
          record.state,
          record.queueEntryId,
          JSON.stringify(record)
        );
    else
      this.coreDb.sqlite
        .prepare(
          `UPDATE recurring_occurrences SET state = ?, queue_entry_id = ?, record_json = ? WHERE id = ?`
        )
        .run(record.state, record.queueEntryId, JSON.stringify(record), record.id);
  }

  /** Writes one definition and the indexed cursor under the caller's transaction when present. */
  private writeSchedule(record: AutomationRecord, insert = false): void {
    readSchedule(JSON.stringify(record));
    const values = [
      record.workspaceId,
      record.responsibleUserId,
      record.status,
      record.revision,
      record.nextScheduledAt === null ? null : Date.parse(record.nextScheduledAt),
      JSON.stringify(record),
    ];
    if (insert)
      this.coreDb.sqlite
        .prepare(`INSERT INTO recurring_schedules
      (workspace_id, responsible_user_id, status, revision, next_scheduled_at, record_json, id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(...values, record.id);
    else
      this.coreDb.sqlite
        .prepare(`UPDATE recurring_schedules SET workspace_id = ?, responsible_user_id = ?,
      status = ?, revision = ?, next_scheduled_at = ?, record_json = ? WHERE id = ?`)
        .run(...values, record.id);
  }

  /** Reads the one definition authority without private content enumeration. */
  private findSchedule(id: string): AutomationRecord | null {
    const row = this.coreDb.sqlite
      .prepare('SELECT record_json FROM recurring_schedules WHERE id = ?')
      .get(id) as JsonRow | undefined;
    return row ? readSchedule(row.record_json) : null;
  }

  /** Reads a bounded owner-selected definition collection. */
  private readSchedules(where: string, ...parameters: string[]): AutomationRecord[] {
    return (
      this.coreDb.sqlite
        .prepare(`SELECT record_json FROM recurring_schedules WHERE ${where} ORDER BY id`)
        .all(...parameters) as JsonRow[]
    ).map((row) => readSchedule(row.record_json));
  }
}

type JsonRow = { record_json: string };
/** Preserves the exact old authored request in each occurrence and missed-history range. */
function snapshot(schedule: AutomationRecord): RecurringOccurrence['snapshot'] {
  return {
    threadId: schedule.threadId,
    actor: schedule.actor,
    prompt: schedule.prompt,
    ...(schedule.agentId === undefined ? {} : { agentId: schedule.agentId }),
    ...(schedule.profileId === undefined ? {} : { profileId: schedule.profileId }),
    ...(schedule.modelId === undefined ? {} : { modelId: schedule.modelId }),
  };
}
/** Retained descriptive additions are ignored; unsupported required semantics fail closed. */
function readSchedule(json: string): AutomationRecord {
  const value = JSON.parse(json);
  if (
    value.requiredFeatures !== undefined &&
    (!Array.isArray(value.requiredFeatures) || value.requiredFeatures.length)
  )
    throw new Error('RecurringSchedule has unsupported required semantics.');
  const record = AutomationRecordSchema.parse(value);
  if (record.actor.id !== record.id || record.actor.responsibleUserId !== record.responsibleUserId)
    throw new Error('RecurringSchedule has contradictory automation identity.');
  return record;
}
