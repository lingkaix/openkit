import { resolve } from 'node:path';
import {
  type AutomationRecord,
  type CreateAutomationRequest,
  CreateAutomationRequestSchema,
  type UpdateAutomationRequest,
  UpdateAutomationRequestSchema,
} from '@openkit/app-api-schemas';
import {
  allocateEntityId,
  deriveEntityId,
  readRetainedV1,
  writeRetainedV1,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type { Actor } from '../auth/identity.js';
import { OperationError } from '../operation-error-core.js';
import { StoredRecurringQueueInputSchema } from '../runtime/recurring-queue-input.js';
import { selectAutomationScan } from '../storage/automation-scanner-selection.js';
import type { WorkInputRef } from '../storage/control-kernel-port.js';
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
import {
  findWorkspaceQueueInputRef,
  readWorkspaceQueueInput,
} from '../storage/workspace-queue-inputs.js';

const SCAN_LIMIT = 128;
const DEFINITION_PUBLICATION_WAIT_MS = 3_000;
const schedulePublicationWaiters = new Map<string, Set<() => void>>();

export {
  AutomationMutationError,
  AutomationRecordNotFoundError,
} from '../storage/control-store-admission-codecs.js';

import { admitCoreScheduler } from '../storage/control-store-admission.js';
import {
  type AutomationDefinitionMutation,
  AutomationMutationError,
  AutomationRecordNotFoundError,
  WorkspaceQueueInputRefSchema,
} from '../storage/control-store-admission-codecs.js';
import {
  findRecurringAutomationFromDb,
  readRecurringOccurrenceFromDb,
} from '../storage/recurring-attempt-native.js';

function recurringInputScope(occurrence: RecurringOccurrence) {
  return {
    workspaceId: occurrence.workspaceId,
    threadId: occurrence.snapshot.threadId,
    turnId: deriveEntityId('tu', ['recurring', occurrence.scheduleId, occurrence.scheduledAt]),
  };
}

/** Recovers the first staged resolution when the original occurrence still needs a Core decision. */
export function findStagedRecurringQueueInput(
  dataRoot: string,
  occurrence: RecurringOccurrence
): {
  inputRef: WorkInputRef;
  preparation: Extract<RecurringPreparation, { kind: 'ready' }>;
} | null {
  const scope = recurringInputScope(occurrence);
  const inputRef =
    occurrence.inputRef ??
    findWorkspaceQueueInputRef(dataRoot, scope, {
      inputId: deriveEntityId('it', ['task-user', scope.turnId]),
      originalInvocationId: occurrence.requestId,
    });
  if (!inputRef) return null;
  const staged = readWorkspaceQueueInput(dataRoot, scope, inputRef);
  if (!staged || staged.originalInvocationId !== occurrence.requestId)
    throw new OperationError(
      'recovery_required',
      'The staged recurring input is unavailable.',
      409
    );
  const decoded = StoredRecurringQueueInputSchema.parse(JSON.parse(staged.text));
  if (
    decoded.occurrenceId !== occurrence.id ||
    decoded.definitionRevision !== occurrence.definitionRevision ||
    decoded.text !== occurrence.snapshot.prompt
  )
    throw new Error('The staged recurring input contradicts its occurrence.');
  return { inputRef, preparation: { kind: 'ready', payload: decoded.preparation } };
}

/** Freezes the exact prompt and preparation at the Workspace before a recurring acceptance. */
export function stageRecurringQueueInput(
  dataRoot: string,
  occurrence: RecurringOccurrence,
  preparation: Extract<RecurringPreparation, { kind: 'ready' }>
) {
  const scope = recurringInputScope(occurrence);
  const text = JSON.stringify(
    writeRetainedV1({
      occurrenceId: occurrence.id,
      definitionRevision: occurrence.definitionRevision,
      text: occurrence.snapshot.prompt,
      preparation: preparation.payload,
    })
  );
  return getControlStoreWorkerClient().stageWorkspaceQueueInput(dataRoot, {
    ...scope,
    originalInvocationId: occurrence.requestId,
    input: {
      owner: { kind: 'workspace', workspaceId: scope.workspaceId },
      inputId: deriveEntityId('it', ['task-user', scope.turnId]),
      digest: sha256Hex(text),
    },
    text,
  });
}

/** Durable Workspace schedule authority sharing the scheduler's Core SQLite connection. */
export class AutomationStore {
  public constructor(
    public readonly coreDb: CoreDb,
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

  /** Orders definition changes and deferred publication for this schedule in the Data Root owner. */
  public async withSchedulePublication<T>(
    id: string,
    publish: () => Promise<T>,
    waitMs?: number
  ): Promise<T> {
    const key = JSON.stringify([resolve(this.coreDb.dataRoot), id]);
    const previous = schedulePublicationWaiters.get(key);
    const waiters = previous ?? new Set<() => void>();
    if (previous) {
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          clearTimeout(timeout);
          resolve();
        };
        const timeout =
          waitMs === undefined
            ? undefined
            : setTimeout(() => {
                if (!waiters.delete(grant)) return;
                reject(
                  new OperationError(
                    'schedule_publication_in_progress',
                    'The schedule is busy publishing a change. Retry the definition change.',
                    409,
                    { details: { retryable: true } }
                  )
                );
              }, waitMs);
        waiters.add(grant);
      });
    } else {
      schedulePublicationWaiters.set(key, waiters);
    }
    try {
      return await publish();
    } finally {
      const next = waiters.values().next().value;
      if (next) {
        waiters.delete(next);
        next();
      } else {
        schedulePublicationWaiters.delete(key);
      }
    }
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
    const result = await this.withSchedulePublication(
      automationId,
      () =>
        this.publishDefinition(
          userId,
          this.getAutomation(automationId).workspaceId,
          { action: 'update', id: automationId, input },
          authorization
        ),
      DEFINITION_PUBLICATION_WAIT_MS
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
    await this.withSchedulePublication(
      automationId,
      () =>
        this.publishDefinition(
          userId,
          this.getAutomation(automationId).workspaceId,
          { action: 'delete', id: automationId },
          authorization
        ),
      DEFINITION_PUBLICATION_WAIT_MS
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
        const release = getControlStoreWorkerClient().enterWorkspaceMutation(
          this.coreDb.dataRoot,
          record.workspaceId
        );
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
    revalidate?: () => RecurringPreparation | undefined,
    inputRef?: WorkInputRef
  ): Promise<RecurringOccurrence | null> {
    const occurrence = this.getOccurrence(occurrenceId);
    const release = getControlStoreWorkerClient().enterWorkspaceMutation(
      this.coreDb.dataRoot,
      occurrence.workspaceId
    );
    if (!release) throw new AutomationMutationError('Workspace mutations are fenced.');
    try {
      const staged =
        inputRef ??
        (preparation.kind === 'ready' && occurrence.state !== 'admission-accepted'
          ? await stageRecurringQueueInput(this.coreDb.dataRoot, occurrence, preparation)
          : undefined);
      const result = await admitCoreScheduler(
        this.coreDb,
        {
          mode: 'recurring-attempt',
          occurrenceId,
          definitionRevision,
          preparation: structuredClone(preparation),
          ...(staged ? { inputRef: WorkspaceQueueInputRefSchema.parse(staged) } : {}),
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
    const release = getControlStoreWorkerClient().enterWorkspaceMutation(
      this.coreDb.dataRoot,
      workspaceId
    );
    if (!release) throw new AutomationMutationError('Workspace mutations are fenced.');
    try {
      const result = await admitCoreScheduler(
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
