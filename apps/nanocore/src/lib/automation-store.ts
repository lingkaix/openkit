import {
  type AutomationRecord,
  type CreateAutomationRequest,
  CreateAutomationRequestSchema,
  type UpdateAutomationRequest,
  UpdateAutomationRequestSchema,
} from '@openkit/app-api-schemas';
import { allocateEntityId, readRetainedV1 } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import { selectAutomationScan } from '../storage/automation-scanner-selection.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import {
  type ExpiredOccurrenceRange,
  ExpiredOccurrenceRangeSchema,
  type RecurringOccurrence,
  type RecurringPreparation,
  readRecurringOccurrence,
  readRecurringSchedule,
} from '../storage/recurring-records.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

const SCAN_LIMIT = 128;

export {
  AutomationMutationError,
  AutomationRecordNotFoundError,
} from '../storage/scheduler-admission-codecs.js';

import {
  findRecurringAutomationFromDb,
  readRecurringOccurrenceFromDb,
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

  /** Holds actual Workspace guards and original callbacks outside the exact native scan publication. */
  public async collectScanCandidates(
    timestamp: string,
    onError?: (error: unknown) => void
  ): Promise<RecurringOccurrence[]> {
    const scope = nativeProductScope(this.coreDb.dataRoot, { kind: 'server' });
    const database = `core:${scope.path}`;
    const client = getControlStoreWorkerClient();
    await client.open({
      database,
      path: scope.path,
      dataRoot: this.coreDb.dataRoot,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const result = await client.automationScanner(database, { action: 'plan', timestamp });
    if (result.kind !== 'plan') throw new Error('Native scan returned no plan.');
    const plan = result.plan;
    const releases = new Map<string, () => void>();
    try {
      for (const record of [...plan.pending, ...plan.due, ...plan.stale, ...plan.expired]) {
        if (releases.has(record.workspaceId)) continue;
        const release = this.mutationAdmission.enter(record.workspaceId);
        if (release) releases.set(record.workspaceId, release);
      }
      const workspaceIds = [...releases.keys()];
      selectAutomationScan(plan, timestamp, workspaceIds, onError);
      const published = await client.automationScanner(database, {
        action: 'publish',
        timestamp,
        expected: plan,
        workspaceIds,
      });
      if (published.kind !== 'published') throw new Error('Native scan returned no publication.');
      return published.occurrences;
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
