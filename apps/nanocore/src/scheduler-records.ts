import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import {
  type ActorRef,
  ActorRefSchema,
  type ReasoningEffort,
  ReasoningEffortSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { commandInputHash } from './runtime/idempotent-command.js';
import type { CoreDb } from './storage/db.js';
import type {
  SchedulerAdmissionDenialReason,
  SchedulerAdmissionStatus,
} from './storage/schema/index.js';
/** Known scheduler admission transition refusal; the admission family owns its projection. */
export class SchedulerAdmissionTransitionError extends Error {
  /** Definite refusal classified by the existing admission owner. */
  constructor(
    message: string,
    readonly reason: SchedulerAdmissionDenialReason = 'invalid-request'
  ) {
    super(message);
  }
}

/** Explicit retained-storage choice captured with one scheduler admission request. */
export type SchedulerWorkerStorageChoice =
  | {
      readonly goalId: string | null;
      readonly kind: 'fresh';
      readonly taskId: string | null;
    }
  | {
      readonly adjudicatedThreadIds?: readonly string[] | undefined;
      readonly expectedRevision: number;
      readonly goalId: string | null;
      readonly kind: 'selected';
      readonly purpose: 'work' | 'independent-review';
      readonly reuseWorkSlotRef?: string | undefined;
      readonly storageRef: string;
      readonly taskId: string | null;
    };

/** Durable checked FIFO admission bound to one configured backend. */
export interface SchedulerAdmissionEntryRecord {
  /** Stable queue entry id. */
  readonly queueEntryId: string;
  /** Configured backend identity captured on acceptance, never selected by placement. */
  readonly backendId: string;
  /** Exact normalized command/provenance hash; replay cannot change the queued work. */
  readonly inputHash: string;
  /** Original command request id used for event correlation. */
  readonly requestId: string | null;
  /** Exact actor that triggered the admission. */
  readonly triggerActor: ActorRef;
  /** Non-secret id of the presented server-admin token, checked again at each effect. */
  readonly serverAdminTokenId: string | null;
  /** Host-local working directory captured for delayed worker startup. */
  readonly workspaceCwd: string | null;
  /** Materialized workspace roots captured for delayed worker startup. */
  readonly workspaceRoots: MaterializedWorkspaceRoot[];
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** Worker turn input captured when the entry is queued. */
  readonly turnInput: string;
  /** Exact retained-storage choice captured before package planning. */
  readonly workerStorageChoice: SchedulerWorkerStorageChoice | null;
  /** Requested agent id. */
  readonly requestedAgentId: string;
  /** Requested agent profile reference. */
  readonly profileRef: string | null;
  /** Requested logical model id. */
  readonly modelId: string | null;
  /** Explicit Turn preference carried across delayed dispatch. */
  readonly reasoningEffort?: ReasoningEffort;
  /** Entry enqueue timestamp. */
  readonly enqueuedAt: string;
  /** Admission entry status. */
  readonly status: SchedulerAdmissionStatus;
  /** Typed denial reason when denied. */
  readonly denialReason: SchedulerAdmissionDenialReason | null;
}

/** Raw scheduler admission row. */
interface SchedulerAdmissionEntryRow {
  readonly backend_id: string;
  readonly input_hash: string;
  readonly queue_entry_id: string;
  readonly request_id: string | null;
  readonly trigger_actor_json: string;
  readonly server_admin_token_id: string | null;
  readonly workspace_cwd: string | null;
  readonly workspace_roots_json: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly turn_input: string;
  readonly worker_storage_choice_json: string | null;
  readonly requested_agent_id: string;
  readonly profile_ref: string | null;
  readonly model_id: string | null;
  readonly reasoning_effort: string | null;
  readonly enqueued_at: string;
  readonly status: SchedulerAdmissionStatus;
  readonly denial_reason: SchedulerAdmissionDenialReason | null;
}

/** Input used to enqueue one scheduler admission entry. */
export interface CreateSchedulerAdmissionEntryInput {
  /** Configured backend identity supplied by application composition. */
  readonly backendId: string;
  /** Stable queue entry id. */
  readonly queueEntryId: string;
  /** Original command request id used for event correlation. */
  readonly requestId?: string | null;
  /** Exact actor that triggered the admission. */
  readonly triggerActor: ActorRef;
  /** Non-secret id of a presented server-admin bearer bound to the triggering user. */
  readonly serverAdminTokenId?: string | null;
  /** Host-local working directory captured for delayed worker startup. */
  readonly workspaceCwd?: string | null;
  /** Materialized workspace roots captured for delayed worker startup. */
  readonly workspaceRoots?: MaterializedWorkspaceRoot[];
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** Worker turn input captured when the entry is queued. */
  readonly turnInput: string;
  /** Exact retained-storage choice captured before package planning. */
  readonly workerStorageChoice?: SchedulerWorkerStorageChoice | null;
  /** Requested agent id. */
  readonly requestedAgentId: string;
  /** Requested agent profile reference. */
  readonly profileRef?: string | null;
  /** Requested logical model id. */
  readonly modelId?: string | null;
  /** Explicit Turn preference captured before package planning. */
  readonly reasoningEffort?: ReasoningEffort;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to deny one queued scheduler admission entry. */
export interface DenySchedulerAdmissionEntryInput {
  /** Queue entry to deny. */
  readonly queueEntryId: string;
  /** Typed denial reason. */
  readonly denialReason: SchedulerAdmissionDenialReason;
}

/** Input used to retry one denied scheduler admission entry. */
export interface RetryDeniedSchedulerAdmissionEntryInput {
  /** Queue entry to retry. */
  readonly queueEntryId: string;
  /** Workspace that owns the scheduler admission. */
  readonly workspaceId: string;
}

/** Input used to cancel one human-actionable scheduler admission entry. */
export interface CancelSchedulerAdmissionEntryInput {
  /** Queue entry to cancel. */
  readonly queueEntryId: string;
  /** Workspace that owns the scheduler admission. */
  readonly workspaceId: string;
}

/** Input used to list scheduler admission entries for one workspace projection. */
export interface ListSchedulerAdmissionEntriesForWorkspaceInput {
  /** Workspace lineage id to project. */
  readonly workspaceId: string;
  /** Admission statuses to include. */
  readonly statuses: readonly SchedulerAdmissionStatus[];
}

/**
 * Creates one queued scheduler admission entry.
 *
 * @param coreDb Open Core database handle.
 * @param input Admission metadata.
 * @returns Stored admission entry.
 * @throws SchedulerAdmissionTransitionError on changed-input replay or the internal queue bound.
 */
export function createSchedulerAdmissionEntry(
  coreDb: CoreDb,
  input: CreateSchedulerAdmissionEntryInput
): SchedulerAdmissionEntryRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const triggerActor = ActorRefSchema.parse(input.triggerActor);
  const storageChoice = input.workerStorageChoice
    ? parseSchedulerWorkerStorageChoice(input.workerStorageChoice)
    : null;
  if (!input.backendId)
    throw new SchedulerAdmissionTransitionError('Configured backend identity is required.');
  const inputHash = commandInputHash({
    backendId: input.backendId,
    requestId: input.requestId ?? null,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    turnInput: input.turnInput,
    workerStorageChoice: storageChoice,
    requestedAgentId: input.requestedAgentId,
    profileRef: input.profileRef ?? null,
    modelId: input.modelId ?? null,
    reasoningEffort:
      input.reasoningEffort !== undefined
        ? ReasoningEffortSchema.parse(input.reasoningEffort)
        : null,
    triggerActor,
    serverAdminTokenId: input.serverAdminTokenId ?? null,
    workspaceCwd: input.workspaceCwd ?? null,
    workspaceRoots: input.workspaceRoots ?? [],
  });
  return coreDb.sqlite
    .transaction(() => {
      const existing = coreDb.sqlite
        .prepare(`${schedulerAdmissionSelectSql()}
      WHERE queue_entry_id = ? OR turn_id = ?
      ORDER BY rowid LIMIT 1`)
        .get(input.queueEntryId, input.turnId) as SchedulerAdmissionEntryRow | undefined;
      if (existing) {
        if (existing.queue_entry_id !== input.queueEntryId || existing.input_hash !== inputHash)
          throw new SchedulerAdmissionTransitionError(
            'Scheduler admission request conflicts with its retained input.'
          );
        return mapSchedulerAdmissionEntryRow(existing);
      }
      const queued = coreDb.sqlite
        .prepare(
          "SELECT count(*) AS count FROM scheduler_admission_entries WHERE status = 'queued'"
        )
        .get() as { count: number };
      if (queued.count >= 20)
        throw new SchedulerAdmissionTransitionError(
          'Scheduler admission queue is full.',
          'queue-full'
        );
      coreDb.sqlite
        .prepare(`INSERT INTO scheduler_admission_entries (
      queue_entry_id, backend_id, input_hash, request_id, workspace_id, thread_id, turn_id, turn_input,
      worker_storage_choice_json, requested_agent_id, profile_ref, model_id, reasoning_effort,
      enqueued_at, status, denial_reason, trigger_actor_json,
      server_admin_token_id, workspace_cwd, workspace_roots_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.queueEntryId,
          input.backendId,
          inputHash,
          input.requestId ?? null,
          input.workspaceId,
          input.threadId,
          input.turnId,
          input.turnInput,
          storageChoice ? JSON.stringify(storageChoice) : null,
          input.requestedAgentId,
          input.profileRef ?? null,
          input.modelId ?? null,
          input.reasoningEffort !== undefined
            ? ReasoningEffortSchema.parse(input.reasoningEffort)
            : null,
          timestamp,
          'queued',
          null,
          JSON.stringify(triggerActor),
          input.serverAdminTokenId ?? null,
          input.workspaceCwd ?? null,
          JSON.stringify(input.workspaceRoots ?? [])
        );
      return requireSchedulerAdmissionEntry(coreDb, input.queueEntryId);
    })
    .immediate();
}

/**
 * Denies one queued scheduler admission entry.
 *
 * @param coreDb Open Core database handle.
 * @param input Denial input.
 * @returns Denied admission entry.
 * @throws Error when the entry does not exist or is not queued.
 */
export function denySchedulerAdmissionEntry(
  coreDb: CoreDb,
  input: DenySchedulerAdmissionEntryInput
): SchedulerAdmissionEntryRecord {
  const entry = requireSchedulerAdmissionEntry(coreDb, input.queueEntryId);

  if (entry.status !== 'queued') {
    throw new Error(`Scheduler admission entry ${input.queueEntryId} is not queued.`);
  }

  coreDb.sqlite
    .prepare(
      "UPDATE scheduler_admission_entries SET status = 'denied', denial_reason = ? WHERE queue_entry_id = ?"
    )
    .run(input.denialReason, input.queueEntryId);

  return requireSchedulerAdmissionEntry(coreDb, input.queueEntryId);
}

/**
 * Requeues one denied scheduler admission entry for explicit human retry.
 *
 * @param coreDb Open Core database handle.
 * @param input Retry input.
 * @returns Requeued admission entry.
 * @throws Error when the entry does not exist or is not denied.
 */
export function retryDeniedSchedulerAdmissionEntry(
  coreDb: CoreDb,
  input: RetryDeniedSchedulerAdmissionEntryInput
): SchedulerAdmissionEntryRecord {
  return coreDb.sqlite
    .transaction(() => {
      const entry = requireSchedulerAdmissionEntry(coreDb, input.queueEntryId, input);

      if (entry.status !== 'denied') {
        throw new SchedulerAdmissionTransitionError(
          `Scheduler admission entry ${input.queueEntryId} is not denied.`
        );
      }

      const queued = coreDb.sqlite
        .prepare(
          "SELECT count(*) AS count FROM scheduler_admission_entries WHERE status = 'queued'"
        )
        .get() as { count: number };
      if (queued.count >= 20)
        throw new SchedulerAdmissionTransitionError(
          'Scheduler admission queue is full.',
          'queue-full'
        );
      const updated = coreDb.sqlite
        .prepare(
          "UPDATE scheduler_admission_entries SET status = 'queued', denial_reason = NULL WHERE queue_entry_id = ? AND workspace_id = ? AND status = 'denied'"
        )
        .run(input.queueEntryId, entry.workspaceId);

      if (updated.changes !== 1) {
        throw new SchedulerAdmissionTransitionError(
          `Scheduler admission entry could not be retried: ${input.queueEntryId}`
        );
      }

      return requireSchedulerAdmissionEntry(coreDb, input.queueEntryId, input);
    })
    .immediate();
}

/**
 * Cancels one queued or denied scheduler admission entry.
 *
 * @param coreDb Open Core database handle.
 * @param input Cancellation input.
 * @returns Cancelled admission entry.
 * @throws Error when the entry does not exist or is not human-actionable.
 */
export function cancelSchedulerAdmissionEntry(
  coreDb: CoreDb,
  input: CancelSchedulerAdmissionEntryInput
): SchedulerAdmissionEntryRecord {
  const entry = requireSchedulerAdmissionEntry(coreDb, input.queueEntryId, input);

  if (entry.status !== 'queued' && entry.status !== 'denied') {
    throw new SchedulerAdmissionTransitionError(
      `Scheduler admission entry ${input.queueEntryId} cannot be cancelled.`
    );
  }

  const updated = coreDb.sqlite
    .prepare(
      "UPDATE scheduler_admission_entries SET status = 'cancelled', denial_reason = NULL WHERE queue_entry_id = ? AND workspace_id = ? AND status = ?"
    )
    .run(input.queueEntryId, entry.workspaceId, entry.status);

  if (updated.changes !== 1) {
    throw new SchedulerAdmissionTransitionError(
      `Scheduler admission entry could not be cancelled: ${input.queueEntryId}`
    );
  }

  return requireSchedulerAdmissionEntry(coreDb, input.queueEntryId, input);
}

/**
 * Lists queued admission entries in scheduler dispatch order for the baseline profile.
 *
 * @param coreDb Open Core database handle.
 * @returns Queued admission entries.
 */
export function listQueuedSchedulerAdmissionEntries(
  coreDb: CoreDb
): SchedulerAdmissionEntryRecord[] {
  return (
    coreDb.sqlite
      .prepare(
        `${schedulerAdmissionSelectSql()}
        WHERE status = 'queued'
        ORDER BY rowid ASC`
      )
      .all() as SchedulerAdmissionEntryRow[]
  ).map(mapSchedulerAdmissionEntryRow);
}

/**
 * Lists scheduler admission entries for one workspace read model.
 *
 * @param coreDb Open Core database handle.
 * @param input Workspace and status filter.
 * @returns Matching admission entries in deterministic enqueue order.
 */
export function listSchedulerAdmissionEntriesForWorkspace(
  coreDb: CoreDb,
  input: ListSchedulerAdmissionEntriesForWorkspaceInput
): SchedulerAdmissionEntryRecord[] {
  if (input.statuses.length === 0) {
    return [];
  }

  const placeholders = input.statuses.map(() => '?').join(', ');

  return (
    coreDb.sqlite
      .prepare(
        `${schedulerAdmissionSelectSql()}
        WHERE workspace_id = ? AND status IN (${placeholders})
        ORDER BY enqueued_at ASC, queue_entry_id ASC`
      )
      .all(input.workspaceId, ...input.statuses) as SchedulerAdmissionEntryRow[]
  ).map(mapSchedulerAdmissionEntryRow);
}

/**
 * Reads one admission entry or throws.
 *
 * @param coreDb Open Core database handle.
 * @param queueEntryId Queue entry id.
 * @param ownership Optional user and workspace ownership guard.
 * @returns Stored admission entry.
 * @throws Error when the entry does not exist in the guarded owner scope.
 */
export function requireSchedulerAdmissionEntry(
  coreDb: CoreDb,
  queueEntryId: string,
  ownership?: { readonly workspaceId: string }
): SchedulerAdmissionEntryRecord {
  const row = coreDb.sqlite
    .prepare(`${schedulerAdmissionSelectSql()} WHERE queue_entry_id = ?`)
    .get(queueEntryId) as SchedulerAdmissionEntryRow | undefined;

  if (!row || (ownership !== undefined && row.workspace_id !== ownership.workspaceId)) {
    throw new SchedulerAdmissionTransitionError(
      `Scheduler admission entry not found: ${queueEntryId}`
    );
  }

  return mapSchedulerAdmissionEntryRow(row);
}

/**
 * Returns the shared scheduler admission SELECT list.
 *
 * @returns SQL select fragment.
 */
function schedulerAdmissionSelectSql(): string {
  return `SELECT
    queue_entry_id,
    backend_id,
    input_hash,
    request_id,
    trigger_actor_json,
    server_admin_token_id,
    workspace_cwd,
    workspace_roots_json,
    workspace_id,
    thread_id,
    turn_id,
    turn_input,
    worker_storage_choice_json,
    requested_agent_id,
    profile_ref,
    model_id,
    reasoning_effort,
    enqueued_at,
    status,
    denial_reason
  FROM scheduler_admission_entries`;
}

/**
 * Maps one raw admission row to the public record shape.
 *
 * @param row Raw SQLite row.
 * @returns Admission entry record.
 */
function mapSchedulerAdmissionEntryRow(
  row: SchedulerAdmissionEntryRow
): SchedulerAdmissionEntryRecord {
  return {
    queueEntryId: row.queue_entry_id,
    backendId: row.backend_id,
    inputHash: row.input_hash,
    requestId: row.request_id,
    triggerActor: ActorRefSchema.parse(JSON.parse(row.trigger_actor_json)),
    serverAdminTokenId: row.server_admin_token_id,
    workspaceCwd: row.workspace_cwd,
    workspaceRoots: JSON.parse(row.workspace_roots_json) as MaterializedWorkspaceRoot[],
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    turnInput: row.turn_input,
    workerStorageChoice: row.worker_storage_choice_json
      ? parseSchedulerWorkerStorageChoice(JSON.parse(row.worker_storage_choice_json), true)
      : null,
    requestedAgentId: row.requested_agent_id,
    profileRef: row.profile_ref,
    modelId: row.model_id,
    ...(row.reasoning_effort !== null
      ? { reasoningEffort: ReasoningEffortSchema.parse(row.reasoning_effort) }
      : {}),
    enqueuedAt: row.enqueued_at,
    status: z.enum(['queued', 'admitted', 'denied', 'cancelled', 'expired']).parse(row.status),
    denialReason: z
      .enum(['queue-full', 'authority-denied', 'invalid-request'])
      .nullable()
      .parse(row.denial_reason),
  };
}

/** Parses storage selection exactly for fresh commands and drops only descriptive additions from retained reads. */
function parseSchedulerWorkerStorageChoice(
  input: unknown,
  retained = false
): SchedulerWorkerStorageChoice {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new z.ZodError([
      { code: 'custom', message: 'Scheduler Worker storage choice is invalid.', path: [] },
    ]);
  }
  const record = input as Record<string, unknown>;
  if (
    record.requiredFeatures !== undefined &&
    (!Array.isArray(record.requiredFeatures) || record.requiredFeatures.length !== 0)
  ) {
    throw new z.ZodError([
      { code: 'custom', message: 'Scheduler Worker storage choice is invalid.', path: [] },
    ]);
  }
  if (
    record.kind === 'fresh' &&
    (retained || Object.keys(record).length === 3) &&
    (record.goalId === null || isNonemptyString(record.goalId)) &&
    (record.taskId === null || isNonemptyString(record.taskId))
  ) {
    return {
      goalId: record.goalId as string | null,
      kind: 'fresh',
      taskId: record.taskId as string | null,
    };
  }
  const allowed = new Set([
    'adjudicatedThreadIds',
    'expectedRevision',
    'goalId',
    'kind',
    'purpose',
    'reuseWorkSlotRef',
    'storageRef',
    'taskId',
  ]);
  const adjudicatedThreadIds = record.adjudicatedThreadIds;
  if (
    record.kind !== 'selected' ||
    (!retained && Object.keys(record).some((field) => !allowed.has(field))) ||
    !Number.isSafeInteger(record.expectedRevision) ||
    (record.expectedRevision as number) < 1 ||
    (record.purpose !== 'work' && record.purpose !== 'independent-review') ||
    !isSchedulerStorageIdentity(record.storageRef) ||
    (record.reuseWorkSlotRef !== undefined &&
      !isSchedulerStorageIdentity(record.reuseWorkSlotRef)) ||
    (record.goalId !== null && !isNonemptyString(record.goalId)) ||
    (record.taskId !== null && !isNonemptyString(record.taskId)) ||
    (adjudicatedThreadIds !== undefined &&
      (!Array.isArray(adjudicatedThreadIds) ||
        adjudicatedThreadIds.length > 1_000 ||
        !adjudicatedThreadIds.every(isNonemptyString) ||
        new Set(adjudicatedThreadIds).size !== adjudicatedThreadIds.length))
  ) {
    throw new z.ZodError([
      { code: 'custom', message: 'Scheduler Worker storage choice is invalid.', path: [] },
    ]);
  }
  return {
    ...(adjudicatedThreadIds === undefined
      ? {}
      : { adjudicatedThreadIds: [...adjudicatedThreadIds] as string[] }),
    expectedRevision: record.expectedRevision as number,
    goalId: record.goalId as string | null,
    kind: 'selected',
    purpose: record.purpose,
    ...(record.reuseWorkSlotRef === undefined
      ? {}
      : { reuseWorkSlotRef: record.reuseWorkSlotRef as string }),
    storageRef: record.storageRef,
    taskId: record.taskId as string | null,
  };
}

/** Returns whether one private storage identity is bounded and path-safe. */
function isSchedulerStorageIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}

/** Returns whether one optional lineage id is a nonempty bounded string. */
function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

/** Exact package/product authority, independent of any backend's proof profile. */
export interface SchedulerExecutionLineage {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly agentSessionId: string;
  readonly packageSnapshotId: string;
}

/** Selects the oldest eligible queued entry without imposing a global backend fence. */
export function findNextDispatchableSchedulerAdmissionEntry(
  coreDb: CoreDb,
  unpublishedQueueEntryIds: ReadonlySet<string> = new Set()
): SchedulerAdmissionEntryRecord | null {
  return (
    listQueuedSchedulerAdmissionEntries(coreDb).find(
      (entry) =>
        !unpublishedQueueEntryIds.has(entry.queueEntryId) &&
        !coreDb.sqlite
          .prepare(
            "SELECT 1 FROM scheduler_execution_attempts WHERE phase <> 'closed' AND (turn_id = ? OR (workspace_id = ? AND thread_id = ?)) LIMIT 1"
          )
          .get(entry.turnId, entry.workspaceId, entry.threadId)
    ) ?? null
  );
}

/** Resolves exactly one accepted product request for current authority checks. */
export function findSchedulerAdmissionForTurn(
  coreDb: CoreDb,
  lineage: { readonly workspaceId: string; readonly threadId: string; readonly turnId: string }
): Pick<
  SchedulerAdmissionEntryRecord,
  'workspaceId' | 'triggerActor' | 'serverAdminTokenId'
> | null {
  const row = coreDb.sqlite
    .prepare(
      `${schedulerAdmissionSelectSql()} WHERE workspace_id = ? AND thread_id = ? AND turn_id = ? AND status IN ('queued', 'admitted')`
    )
    .get(lineage.workspaceId, lineage.threadId, lineage.turnId) as
    | SchedulerAdmissionEntryRow
    | undefined;
  return row ? mapSchedulerAdmissionEntryRow(row) : null;
}

/** Joins generic attempt/package correlation to its original admission, never to a backend family. */
export function findSchedulerAdmissionForWorkerLineage(
  coreDb: CoreDb,
  lineage: SchedulerExecutionLineage
): Pick<
  SchedulerAdmissionEntryRecord,
  'workspaceId' | 'triggerActor' | 'serverAdminTokenId'
> | null {
  const rows = coreDb.sqlite
    .prepare(`SELECT admission.* FROM scheduler_execution_attempts attempt
    JOIN scheduler_admission_entries admission ON admission.queue_entry_id = attempt.queue_entry_id
    WHERE attempt.workspace_id = ? AND attempt.thread_id = ? AND attempt.turn_id = ?
      AND attempt.agent_session_id = ? AND attempt.input_ref = ?
      AND NOT (attempt.phase = 'closed' AND attempt.disposition = 'not_accepted' AND attempt.operation_id IS NULL AND attempt.terminal_cause = 'backend-busy')
      AND admission.workspace_id = attempt.workspace_id AND admission.thread_id = attempt.thread_id AND admission.turn_id = attempt.turn_id`)
    .all(
      lineage.workspaceId,
      lineage.threadId,
      lineage.turnId,
      lineage.agentSessionId,
      lineage.packageSnapshotId
    ) as SchedulerAdmissionEntryRow[];
  return rows.length === 1 ? mapSchedulerAdmissionEntryRow(rows[0]!) : null;
}

/** Reads the exact original admission for an attempt without reconstructing a placement graph. */
export function requireSchedulerExecutionAttemptAdmissionContext(
  coreDb: CoreDb,
  attemptId: string
): SchedulerAdmissionEntryRecord {
  const row = coreDb.sqlite
    .prepare(`SELECT admission.* FROM scheduler_execution_attempts attempt
    JOIN scheduler_admission_entries admission ON admission.queue_entry_id = attempt.queue_entry_id
    WHERE attempt.attempt_id = ? AND admission.workspace_id = attempt.workspace_id
      AND admission.thread_id = attempt.thread_id AND admission.turn_id = attempt.turn_id`)
    .get(attemptId) as SchedulerAdmissionEntryRow | undefined;
  if (!row) throw new Error('Execution attempt has no exact admission owner.');
  return mapSchedulerAdmissionEntryRow(row);
}
