/** Native backend-session records and Core attempt-bound operations. */
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { canonicalJsonText, readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { recordServerAuditEvent } from '../audit-events.js';
import type { ExecutionGrant } from '../storage/control-kernel-port.js';
import { commandInputHash } from '../storage/control-store-input.js';
import type { CoreDb } from '../storage/db.js';
import type {
  WorkerBackendSessionState,
  WorkerBackendWorkspaceHandoffState,
} from '../storage/schema/index.js';
import { BackendSessionRefusal } from '../storage/worker-backend-session-codecs.js';
import type { SchedulerExecutionAttemptRecord } from './execution-attempt-records.js';
import { nanoHostStartupDeadline } from './nanohost-attempt-clocks.js';
import {
  getNanoHostRuntimeTarget,
  requireStoredNanoHostPhysicalEpoch,
} from './nanohost-runtime-target-records.js';

export type { WorkerBackendSessionState } from '../storage/schema/index.js';

/** Admitted SQLite connection that holds the native session records. */
type WorkerBackendSessionDb = { readonly sqlite: Database.Database };

/** Authored reference lineage retained by a durable backend anchor. */
export interface WorkerBackendReferenceLineage {
  /** Immutable image reference selected by the AEP. */
  readonly imageRef: string;
}

/** NanoHost build-result lineage retained by a durable backend anchor. */
export interface WorkerBackendBuildLineage {
  /** Digest of the exact authored build arguments. */
  readonly buildArgumentsDigest: string;
  /** Digest of the exact build context. */
  readonly buildContextDigest: string;
  /** Digest of the exact Dockerfile input. */
  readonly buildInputDigest: string;
  /** Digest of the image produced by NanoHost. */
  readonly resultingImageDigest: string;
}

/** Exact reference or NanoHost build-result lineage stored for one backend session. */
export type WorkerBackendLineage = WorkerBackendReferenceLineage | WorkerBackendBuildLineage;

/**
 * Projects resolved AEP image authority into the durable backend lineage input.
 *
 * @param image Resolved AEP image declaration.
 * @param resultingImageDigest NanoHost-produced digest required for build lineage.
 * @returns Exact reference or build-result lineage input.
 * @throws Error when build authority has no NanoHost result digest.
 */
export function workerBackendLineageFromRuntimeImage(
  image: AgentEnvironmentPackage['runtime']['image'],
  resultingImageDigest?: string
): RecordWorkerBackendSessionMaterializingInput['backendLineage'] {
  if (image.kind === 'reference') {
    return { imageRef: image.ref, kind: 'reference' };
  }
  if (!resultingImageDigest) {
    throw new BackendSessionRefusal(
      'NanoHost build result digest is required before backend anchoring.'
    );
  }
  return {
    buildArgumentsDigest: image.argumentsDigest,
    buildContextDigest: image.contextDigest,
    buildInputDigest: image.input.digest,
    kind: 'build',
    resultingImageDigest,
  };
}

/** Returns the effective immutable image identity from persisted backend lineage. */
export function workerBackendImageIdentity(lineage: WorkerBackendLineage): string {
  return 'imageRef' in lineage ? lineage.imageRef : lineage.resultingImageDigest;
}

/** Pre-effect identity owned by one execution attempt and RuntimeTarget. */
export interface WorkerBackendSessionIdentity {
  readonly agentSessionId: string;
  readonly backendKind: string;
  readonly backendSessionId: string;
  readonly deploymentId: string;
  readonly packageSnapshotId: string;
  readonly runtimeTargetId: string;
  readonly stagingDirectoryRef: string;
  readonly transientProviderInstanceId: string | null;
}

/** Durable package-scoped physical backend session. */
export interface WorkerBackendSessionRecord {
  /** execution attempt that exclusively owns the session. */
  readonly attemptId: string;
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** AgentSession lineage id. */
  readonly agentSessionId: string;
  /** Agent environment package snapshot id. */
  readonly packageSnapshotId: string;
  /** Physical backend family. */
  readonly backendKind: string;
  /** Stable data-root deployment that owns every physical artifact. */
  readonly deploymentId: string;
  /** Backend implementation version captured before physical effects. */
  readonly backendVersion: string | null;
  /** Configured RuntimeTarget that owns execution. */
  readonly runtimeTargetId: string;
  /** Immutable physical Epoch captured before the first backend effect. */
  readonly originPhysicalEpoch: string;
  /** Exact reference or NanoHost build-result lineage. */
  readonly backendLineage: WorkerBackendLineage;
  /** Scheduler-owned sandbox binding. */
  readonly sandboxBindingRef: string;
  /** Backend-native physical session id. */
  readonly backendSessionId: string;
  /** Data-root-relative backend-private staging directory. */
  readonly stagingDirectoryRef: string;
  /** Optional backend-private provider identity owned by the physical session. */
  readonly transientProviderInstanceId: string | null;
  /** Cross-database workspace handle publication phase. */
  readonly workspaceHandoffState: WorkerBackendWorkspaceHandoffState;
  /** Durable physical lifecycle state. */
  readonly state: WorkerBackendSessionState;
  /** Stable physical cleanup completion time, when cleanup succeeded. */
  readonly physicalCleanedAt: string | null;
  /** Creation timestamp. */
  readonly createdAt: string;
  /** Last lifecycle transition timestamp. */
  readonly updatedAt: string;
}

/** Input for recording the pre-effect backend identity. */
export interface RecordWorkerBackendSessionMaterializingInput {
  /** One indivisible pure backend plan whose lineage and physical names cannot be mixed. */
  readonly identity: WorkerBackendSessionIdentity;
  /** Backend implementation version captured before physical effects. */
  readonly backendVersion: string | null;
  /** Exact reference selection or NanoHost build-result lineage. */
  readonly backendLineage:
    | { readonly kind: 'reference'; readonly imageRef: string }
    | {
        readonly kind: 'build';
        readonly buildArgumentsDigest: string;
        readonly buildContextDigest: string;
        readonly buildInputDigest: string;
        readonly resultingImageDigest: string;
      };
  /** Scheduler-owned product lineage not duplicated by the physical plan. */
  readonly lineage: {
    /** Workspace lineage id. */
    readonly workspaceId: string;
    /** Thread lineage id. */
    readonly threadId: string;
    /** Turn lineage id. */
    readonly turnId: string;
  };
  /** Deterministic clock for persistence and deadline validation. */
  readonly now?: () => string;
  /** Scheduler-owned non-secret sandbox binding reference. */
  readonly sandboxBindingRef: string;
}

/** Input for one compare-and-set backend session transition. */
export interface TransitionWorkerBackendSessionStateInput {
  /** Expected current state. */
  readonly fromState: WorkerBackendSessionState;
  /** Owning execution attempt id. */
  readonly attemptId: string;
  /** Deterministic transition clock. */
  readonly now?: () => string;
  /** Required next state. */
  readonly toState: WorkerBackendSessionState;
}

/** Input for the atomic live-lease launch gate. */
export interface MarkWorkerBackendSessionLaunchingInput {
  /** Owning execution attempt id. */
  readonly attemptId: string;
  /** Deterministic validation and transition clock. */
  readonly now?: () => string;
}

/** Input for publishing the complete workspace handoff marker. */
export interface MarkWorkerBackendWorkspaceHandoffCompleteInput {
  /** Owning execution attempt id. */
  readonly attemptId: string;
  /** Deterministic marker clock. */
  readonly now?: () => string;
}

/** Raw SQLite worker backend session row. */
interface WorkerBackendSessionRow {
  readonly schemaVersion: unknown;
  readonly attempt_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly agent_session_id: string;
  readonly package_snapshot_id: string;
  readonly backend_kind: string;
  readonly deployment_id: string;
  readonly backend_version: string | null;
  readonly runtime_target_id: string;
  readonly origin_physical_epoch: string;
  readonly backend_lineage_json: string;
  readonly sandbox_binding_ref: string;
  readonly backend_session_id: string;
  readonly staging_directory_ref: string;
  readonly transient_provider_instance_id: string | null;
  readonly workspace_handoff_state: WorkerBackendWorkspaceHandoffState;
  readonly state: WorkerBackendSessionState;
  readonly physical_cleaned_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Raw execution attempt fields required by the pre-effect insertion gate. */
interface WorkerBackendSessionAttemptRow {
  readonly attempt_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly agent_session_id: string;
  readonly input_ref: string;
  readonly phase: string;
  readonly deadline: string | null;
  readonly heartbeat_deadline: string;
  readonly startup_deadline: string;
  readonly last_accepted_heartbeat_at: string | null;
}

/** The split writer receives the current original Core preparation correlation. */
type MaterializingNanoHostAttempt = Pick<
  SchedulerExecutionAttemptRecord,
  | 'attemptId'
  | 'backendId'
  | 'createdAt'
  | 'workspaceId'
  | 'threadId'
  | 'turnId'
  | 'agentSessionId'
  | 'inputRef'
  | 'bindingRef'
  | 'phase'
  | 'deadline'
  | 'operationId'
>;

const ALLOWED_TRANSITIONS: Readonly<
  Record<WorkerBackendSessionState, readonly WorkerBackendSessionState[]>
> = {
  materializing: ['materialized', 'cleanup-pending'],
  materialized: ['launching', 'cleanup-pending'],
  launching: ['cleanup-pending'],
  'cleanup-pending': ['cleanup-failed', 'physical-cleaned'],
  'cleanup-failed': ['cleanup-pending'],
  'physical-cleaned': ['cleaned'],
  cleaned: [],
};

/**
 * Records the deterministic physical session identity before any backend effect.
 *
 * @param coreDb Open Core database handle.
 * @param input Exact backend identity, lease binding, lineage, and validation clock.
 * @returns Inserted or exactly replayed durable session.
 * @throws Error when lease authority is missing, stale, terminal, or conflicting.
 */
export function recordWorkerBackendSessionMaterializing(
  coreDb: CoreDb,
  input: RecordWorkerBackendSessionMaterializingInput,
  admitted?: {
    readonly owner: WorkerBackendSessionDb;
    readonly attempt: MaterializingNanoHostAttempt;
  }
): WorkerBackendSessionRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();
  let attemptId = '';
  const owner = admitted?.owner ?? coreDb;

  {
    const runtimeTarget = owner.sqlite
      .prepare(
        `SELECT deployment_id AS deploymentId, predecessor_fenced AS predecessorFenced,
                ready, fresh_empty AS freshEmpty, physical_epoch AS physicalEpoch
         FROM nanohost_runtime_targets WHERE target_id = ?`
      )
      .get(input.identity.runtimeTargetId) as
      | {
          readonly deploymentId: string;
          readonly freshEmpty: 0 | 1;
          readonly physicalEpoch: string | null;
          readonly predecessorFenced: 0 | 1;
          readonly ready: 0 | 1;
        }
      | undefined;
    if (
      !runtimeTarget ||
      runtimeTarget.deploymentId !== input.identity.deploymentId ||
      runtimeTarget.predecessorFenced !== 1 ||
      runtimeTarget.ready !== 1 ||
      runtimeTarget.freshEmpty !== 1 ||
      !runtimeTarget.physicalEpoch ||
      !/^[0-9a-f]{64}$/.test(runtimeTarget.physicalEpoch)
    ) {
      throw new BackendSessionRefusal(
        'Worker backend materialization requires current physical Epoch authority.'
      );
    }
    const originPhysicalEpoch = runtimeTarget.physicalEpoch;
    const original = admitted?.attempt;
    if (
      original &&
      (original.backendId !== 'nanohost' ||
        original.bindingRef !== input.sandboxBindingRef ||
        original.operationId !== null ||
        !original.agentSessionId ||
        !original.inputRef)
    )
      throw new BackendSessionRefusal('Native materialization has no exact Core preparation.');
    const startupDeadline = original ? nanoHostStartupDeadline(original) : '';
    const lease: WorkerBackendSessionAttemptRow | undefined = original
      ? {
          attempt_id: original.attemptId,
          workspace_id: original.workspaceId,
          thread_id: original.threadId,
          turn_id: original.turnId,
          agent_session_id: original.agentSessionId!,
          input_ref: original.inputRef!,
          phase: original.phase,
          deadline: original.deadline,
          startup_deadline: startupDeadline,
          heartbeat_deadline: startupDeadline,
          last_accepted_heartbeat_at: null,
        }
      : (coreDb.sqlite
          .prepare(
            `SELECT attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
                input_ref, phase, deadline, heartbeat_deadline,
                startup_deadline, last_accepted_heartbeat_at
         FROM scheduler_execution_attempts
         WHERE binding_ref = ?
         ORDER BY created_at DESC, attempt_id DESC
         LIMIT 1`
          )
          .get(input.sandboxBindingRef) as WorkerBackendSessionAttemptRow | undefined);

    if (!lease || !attemptMatchesInput(lease, input)) {
      throw new BackendSessionRefusal(
        'execution attempt binding does not match worker backend session lineage.'
      );
    }
    attemptId = lease.attempt_id;

    const deadline = lease.last_accepted_heartbeat_at
      ? lease.heartbeat_deadline
      : lease.startup_deadline;
    if (
      lease.phase !== 'open' ||
      (lease.deadline !== null && lease.deadline <= timestamp) ||
      deadline <= timestamp
    ) {
      throw new BackendSessionRefusal(
        'execution attempt is not live for worker backend materialization.'
      );
    }

    const existing = selectWorkerBackendSession(owner, attemptId);
    if (existing) {
      const record = mapWorkerBackendSessionRow(existing);
      if (!workerBackendSessionMatchesInput(record, input, originPhysicalEpoch)) {
        throw new BackendSessionRefusal(
          'Worker backend session identity conflicts with its durable lease.'
        );
      }
      if (record.state !== 'materializing') {
        throw new BackendSessionRefusal('Worker backend session is not materializing.');
      }
      return record;
    }

    owner.sqlite
      .prepare(
        `INSERT INTO worker_backend_sessions (
           attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
           package_snapshot_id, backend_kind, deployment_id, backend_version,
           backend_session_id, runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref,
           staging_directory_ref, transient_provider_instance_id, workspace_handoff_state,
           state, physical_cleaned_at, created_at, updated_at, schema_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'materializing', NULL, ?, ?, ?)`
      )
      .run(
        attemptId,
        input.lineage.workspaceId,
        input.lineage.threadId,
        input.lineage.turnId,
        input.identity.agentSessionId,
        input.identity.packageSnapshotId,
        input.identity.backendKind,
        input.identity.deploymentId,
        input.backendVersion,
        input.identity.backendSessionId,
        input.identity.runtimeTargetId,
        originPhysicalEpoch,
        JSON.stringify(normalizeBackendLineage(input.backendLineage)),
        input.sandboxBindingRef,
        input.identity.stagingDirectoryRef,
        input.identity.transientProviderInstanceId,
        timestamp,
        timestamp,
        writeRetainedV1({}).schemaVersion
      );
  }

  return requireWorkerBackendSession(owner, attemptId);
}

/**
 * Applies one allowed compare-and-set lifecycle transition in the owner's write transaction.
 *
 * @param owner Admitted SQLite handle for the native backend-session records.
 * @param input Expected state, next state, lease id, and transition clock.
 * @returns Updated durable session.
 * @throws Error when the requested transition is invalid or the state changed concurrently.
 */
export function transitionWorkerBackendSessionState(
  owner: WorkerBackendSessionDb,
  input: TransitionWorkerBackendSessionStateInput
): WorkerBackendSessionRecord {
  if (!ALLOWED_TRANSITIONS[input.fromState].includes(input.toState)) {
    throw new BackendSessionRefusal(
      `Worker backend session transition is invalid: ${input.fromState} -> ${input.toState}.`
    );
  }
  const timestamp = input.now?.() ?? new Date().toISOString();
  const current = selectWorkerBackendSession(owner, input.attemptId);
  if (current) readRetainedV1(current, () => current);
  const result = owner.sqlite
    .prepare(
      `UPDATE worker_backend_sessions
       SET state = ?,
           physical_cleaned_at = CASE WHEN ? = 'physical-cleaned' THEN ? ELSE physical_cleaned_at END,
           updated_at = ?
       WHERE attempt_id = ? AND state = ?`
    )
    .run(input.toState, input.toState, timestamp, timestamp, input.attemptId, input.fromState);

  if (result.changes !== 1) {
    throw new BackendSessionRefusal('Worker backend session state changed before transition.');
  }
  return requireWorkerBackendSession(owner, input.attemptId);
}

/**
 * Atomically validates live scheduler authority and opens the physical launch gate.
 *
 * @param coreDb Open Core database handle.
 * @param input Owning lease and validation clock.
 * @returns Session transitioned from materialized to launching.
 * @throws Error when lease authority, deadlines, anchor state, or session state is invalid.
 */
export function markWorkerBackendSessionLaunching(
  coreDb: CoreDb,
  input: MarkWorkerBackendSessionLaunchingInput
): WorkerBackendSessionRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();

  {
    const row = coreDb.sqlite
      .prepare(
        `SELECT sessions.schema_version AS schemaVersion, sessions.state,
                sessions.workspace_handoff_state AS workspaceHandoffState,
                leases.phase,
                leases.deadline AS deadline,
                leases.heartbeat_deadline AS heartbeatDeadline,
                leases.startup_deadline AS startupDeadline,
                leases.last_accepted_heartbeat_at AS lastAcceptedHeartbeatAt
         FROM worker_backend_sessions AS sessions
         JOIN scheduler_execution_attempts AS leases ON leases.attempt_id = sessions.attempt_id
         WHERE sessions.attempt_id = ?`
      )
      .get(input.attemptId) as
      | {
          readonly schemaVersion: unknown;
          readonly deadline: string | null;
          readonly heartbeatDeadline: string;
          readonly lastAcceptedHeartbeatAt: string | null;
          readonly startupDeadline: string;
          readonly state: WorkerBackendSessionState;
          readonly phase: string;
          readonly workspaceHandoffState: WorkerBackendWorkspaceHandoffState;
        }
      | undefined;
    if (row) readRetainedV1(row, () => row);
    const deadline = row?.lastAcceptedHeartbeatAt ? row.heartbeatDeadline : row?.startupDeadline;
    if (
      !row ||
      row.state !== 'materialized' ||
      row.workspaceHandoffState !== 'complete' ||
      row.phase !== 'open' ||
      !row.deadline ||
      row.deadline <= timestamp ||
      !deadline ||
      deadline <= timestamp
    ) {
      throw new BackendSessionRefusal('execution attempt is not live for worker backend launch.');
    }
    const transition = coreDb.sqlite
      .prepare(
        `UPDATE worker_backend_sessions
         SET state = 'launching', updated_at = ?
         WHERE attempt_id = ? AND state = 'materialized'`
      )
      .run(timestamp, input.attemptId);
    if (transition.changes !== 1) {
      throw new BackendSessionRefusal('Worker backend session state changed before launch.');
    }
  }

  return requireWorkerBackendSession(coreDb, input.attemptId);
}

/**
 * Marks the exact workspace handle set as published in the owner's write transaction after the workspace commit.
 *
 * @param owner Admitted SQLite handle for the native backend-session records.
 * @param input Owning lease and marker clock.
 * @returns Updated durable backend session.
 * @throws Error when the marker changed concurrently.
 */
export function markWorkerBackendWorkspaceHandoffComplete(
  owner: WorkerBackendSessionDb,
  input: MarkWorkerBackendWorkspaceHandoffCompleteInput
): WorkerBackendSessionRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const current = selectWorkerBackendSession(owner, input.attemptId);
  if (current) readRetainedV1(current, () => current);
  const result = owner.sqlite
    .prepare(
      `UPDATE worker_backend_sessions
       SET workspace_handoff_state = 'complete', updated_at = ?
       WHERE attempt_id = ? AND workspace_handoff_state = 'pending'`
    )
    .run(timestamp, input.attemptId);
  if (result.changes !== 1) {
    throw new BackendSessionRefusal('Worker backend workspace handoff changed before publication.');
  }
  return requireWorkerBackendSession(owner, input.attemptId);
}

export interface NanoHostSubmissionPlacement {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly agentSessionId: string;
  readonly runtimeTargetId: string;
  readonly identityId: string;
  readonly deploymentId: string;
  readonly physicalEpoch: string;
}

type NanoHostSubmitGrant = Extract<ExecutionGrant, { readonly deadline: string }>;

function isNanoHostSubmitGrant(
  grant: ExecutionGrant
): grant is NanoHostSubmitGrant & { readonly inputRef: string; readonly bindingRef: string } {
  return (
    grant.backendId === 'nanohost' &&
    grant.execution.owner.kind === 'server' &&
    grant.execution.executionId === grant.attemptId &&
    grant.deadline !== null &&
    grant.inputRef !== null &&
    grant.bindingRef !== null &&
    grant.operationId ===
      commandInputHash({
        attemptId: grant.attemptId,
        inputRef: grant.inputRef,
        operation: 'submit',
      })
  );
}

/**
 * Verifies the Native side of the original submission grant on the admitted NanoHost reader.
 * The Core deciding writer must verify the independent Workspace handoff before returning its first ACK.
 */
export function readNanoHostSubmissionPlacement(
  owner: WorkerBackendSessionDb,
  grant: ExecutionGrant,
  expected: NanoHostSubmissionPlacement
): WorkerBackendSessionRecord | null {
  return readCurrentSubmitPlacement(owner, grant, expected, 'materialized');
}

function readCurrentSubmitPlacement(
  owner: WorkerBackendSessionDb,
  grant: ExecutionGrant,
  expected: NanoHostSubmissionPlacement,
  state: 'materialized' | 'launching'
): WorkerBackendSessionRecord | null {
  if (!isNanoHostSubmitGrant(grant)) return null;
  const session = getWorkerBackendSession(owner, grant.attemptId);
  if (
    !session ||
    session.state !== state ||
    session.workspaceHandoffState !== 'complete' ||
    session.physicalCleanedAt !== null ||
    session.backendKind !== 'openshell' ||
    session.transientProviderInstanceId !== null ||
    session.packageSnapshotId !== grant.inputRef ||
    session.sandboxBindingRef !== grant.bindingRef ||
    session.turnId !== grant.turnId ||
    session.agentSessionId !== expected.agentSessionId ||
    session.threadId !== expected.threadId ||
    session.workspaceId !== expected.workspaceId ||
    session.runtimeTargetId !== expected.runtimeTargetId ||
    session.deploymentId !== expected.deploymentId ||
    session.originPhysicalEpoch !== expected.physicalEpoch
  )
    return null;

  const target = getNanoHostRuntimeTarget(owner, session.runtimeTargetId);
  return target?.ready &&
    target.freshEmpty &&
    target.predecessorFenced &&
    target.identityId === expected.identityId &&
    target.deploymentId === session.deploymentId &&
    target.physicalEpoch === session.originPhysicalEpoch &&
    String(target.connectionGeneration) === grant.generation
    ? session
    : null;
}

const routeHash = z.string().regex(/^[a-f0-9]{64}$/);
const workerRouteBindingV1 = z
  .strictObject({
    version: z.literal(1),
    operationId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    generation: z.string().regex(/^[1-9][0-9]*$/),
    deadline: z.iso.datetime({ precision: 3 }),
    control: routeHash,
    inference: routeHash,
    capability: routeHash,
    harnessInstanceId: z.string().min(1),
    harnessOperationId: routeHash,
    harnessSequence: z.number().int().nonnegative().safe(),
  })
  .refine((value) => new Set([value.control, value.inference, value.capability]).size === 3);

type WorkerRouteBinding = z.output<typeof workerRouteBindingV1>;

function readRetainedRouteBinding(
  owner: WorkerBackendSessionDb,
  attemptId: string
): WorkerRouteBinding | null {
  const json = owner.sqlite
    .prepare('SELECT worker_route_binding_json FROM worker_backend_sessions WHERE attempt_id = ?')
    .pluck()
    .get(attemptId);
  if (json == null) return null;
  if (typeof json !== 'string')
    throw new BackendSessionRefusal('Native Worker route binding is invalid.');
  const binding = workerRouteBindingV1.parse(JSON.parse(json));
  if (canonicalJsonText(binding) !== json)
    throw new BackendSessionRefusal('Native Worker route binding is not canonical.');
  return binding;
}

/** Inspect the exact historical hashes. Live route use still requires the current Core lease. */
export function readNanoHostWorkerRouteBinding(
  owner: WorkerBackendSessionDb,
  grant: ExecutionGrant
): WorkerRouteBinding | null {
  if (!isNanoHostSubmitGrant(grant)) return null;
  const session = getWorkerBackendSession(owner, grant.attemptId);
  if (
    !session ||
    session.turnId !== grant.turnId ||
    session.packageSnapshotId !== grant.inputRef ||
    session.sandboxBindingRef !== grant.bindingRef
  )
    return null;
  const binding = readRetainedRouteBinding(owner, grant.attemptId);
  return binding &&
    binding.operationId === grant.operationId &&
    binding.generation === grant.generation &&
    binding.deadline === grant.deadline
    ? binding
    : null;
}

/** Joins the original Core submission to its exact admitted Native route tuple. */
export function readNanoHostWorkerLease(
  owner: WorkerBackendSessionDb,
  grant: ExecutionGrant,
  lineage: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly agentSessionId: string;
  }
) {
  const session = getWorkerBackendSession(owner, grant.attemptId);
  if (
    !session ||
    session.workspaceId !== lineage.workspaceId ||
    session.threadId !== lineage.threadId ||
    session.agentSessionId !== lineage.agentSessionId
  )
    return null;
  const binding = readNanoHostWorkerRouteBinding(owner, grant);
  return binding ? { session, binding } : null;
}

/** Read-back for the original boot reconnect census, in the Core owner's retained order. */
export function readNanoHostReconnectCandidates(
  owner: WorkerBackendSessionDb,
  originals: readonly {
    readonly grant: ExecutionGrant;
    readonly lineage: Parameters<typeof readNanoHostWorkerLease>[2];
  }[]
): { readonly attemptId: string; readonly packageSnapshotId: string }[] {
  return originals.map(({ grant, lineage }) => {
    const lease = readNanoHostWorkerLease(owner, grant, lineage);
    if (
      !lease ||
      lease.session.physicalCleanedAt !== null ||
      lease.session.state !== 'launching' ||
      lease.session.workspaceHandoffState !== 'complete'
    )
      throw new BackendSessionRefusal('Native Worker reconnect origin requires recovery.');
    return {
      attemptId: lease.session.attemptId,
      packageSnapshotId: lease.session.packageSnapshotId,
    };
  });
}

/**
 * Retains only the exact redacted turn.start from the current native Harness cell.
 * The caller must have the first Core submission ACK and recheck live authority before contact.
 */
export function bindNanoHostWorkerRoutes(
  owner: WorkerBackendSessionDb,
  grant: ExecutionGrant,
  placement: NanoHostSubmissionPlacement,
  command: {
    readonly harnessInstanceId: string;
    readonly operationId: string;
    readonly sequence: number;
  }
): 'bound-now' | 'already-bound' {
  if (
    !owner.sqlite.inTransaction ||
    !readCurrentSubmitPlacement(owner, grant, placement, 'launching')
  )
    throw new BackendSessionRefusal('Native Worker route binding has no current submission.');
  const row = owner.sqlite
    .prepare(`
    SELECT h.schema_version AS schemaVersion, h.command_body_json AS body,
           h.command_fingerprint AS fingerprint, b.agent_session_runtime_binding_id AS bindingId
    FROM harness_instance_records AS h
    JOIN agent_session_runtime_bindings AS b ON b.harness_instance_id = h.harness_instance_id
    JOIN sandbox_runtime_records AS s ON s.sandbox_runtime_id = h.sandbox_runtime_id
    WHERE h.harness_instance_id = ?
      AND h.lifecycle_state = 'open' AND h.drain_state = 'accepting'
      AND h.operation = 'turn.start' AND h.operation_state = 'queued'
      AND h.operation_id = ? AND h.operation_sequence = ?
      AND b.workspace_id = ? AND b.thread_id = ? AND b.agent_session_id = ?
      AND b.schema_version = 1 AND b.lifecycle_state IN ('open', 'opening')
      AND s.runtime_target_id = ? AND s.origin_physical_epoch = ?
      AND s.lifecycle_state = 'open' AND s.health_state = 'ready'
      AND s.drain_state = 'accepting' AND s.cleanup_state = 'clean'
  `)
    .get(
      command.harnessInstanceId,
      command.operationId,
      command.sequence,
      placement.workspaceId,
      placement.threadId,
      placement.agentSessionId,
      placement.runtimeTargetId,
      placement.physicalEpoch
    ) as
    | { schemaVersion: unknown; body: string | null; fingerprint: string | null; bindingId: string }
    | undefined;
  const bodyJson = row?.body;
  if (!row || !bodyJson || row.fingerprint !== sha256Hex(bodyJson))
    throw new BackendSessionRefusal('Native Worker route binding has no exact queued command.');
  const body = readRetainedV1(row, () =>
    z.record(z.string(), z.unknown()).parse(JSON.parse(bodyJson))
  );
  if (
    body.leaseId !== grant.attemptId ||
    body.packageSnapshotId !== grant.inputRef ||
    body.turnId !== grant.turnId ||
    body.deadline !== grant.deadline ||
    body.workspaceId !== placement.workspaceId ||
    body.threadId !== placement.threadId ||
    body.agentSessionId !== placement.agentSessionId ||
    body.agentSessionRuntimeBindingId !== row.bindingId
  )
    throw new BackendSessionRefusal(
      'Native Worker route binding contradicts the original command.'
    );
  const binding = workerRouteBindingV1.parse({
    version: 1,
    operationId: grant.operationId,
    generation: grant.generation,
    deadline: grant.deadline,
    control: body.workerControlTokenHash,
    inference: body.inferenceTokenHash,
    capability: body.capabilityTokenHash,
    harnessInstanceId: command.harnessInstanceId,
    harnessOperationId: command.operationId,
    harnessSequence: command.sequence,
  });
  const json = canonicalJsonText(binding);
  const prior = readRetainedRouteBinding(owner, grant.attemptId);
  if (prior) {
    if (canonicalJsonText(prior) !== json)
      throw new BackendSessionRefusal('Native Worker route binding conflicts with the original.');
    return 'already-bound';
  }
  const update = owner.sqlite
    .prepare(`UPDATE worker_backend_sessions SET worker_route_binding_json = ?
      WHERE attempt_id = ? AND state = 'launching' AND worker_route_binding_json IS NULL`)
    .run(json, grant.attemptId);
  if (update.changes !== 1)
    throw new BackendSessionRefusal('Native Worker route binding changed concurrently.');
  return 'bound-now';
}

/**
 * Reads one durable backend session by execution attempt.
 *
 * @param owner Admitted SQLite handle for the native backend-session records.
 * @param attemptId Owning execution attempt id.
 * @returns Durable session or null when no physical identity was recorded.
 */
export function getWorkerBackendSession(
  owner: WorkerBackendSessionDb,
  attemptId: string
): WorkerBackendSessionRecord | null {
  const row = selectWorkerBackendSession(owner, attemptId);
  return row ? mapWorkerBackendSessionRow(row) : null;
}

/** Reads the exact retained session for a package snapshot using its unique index. */
export function getWorkerBackendSessionByPackage(
  owner: WorkerBackendSessionDb,
  packageSnapshotId: string
): WorkerBackendSessionRecord | null {
  const row = owner.sqlite
    .prepare(`${workerBackendSessionSelectSql()} WHERE package_snapshot_id = ?`)
    .get(packageSnapshotId) as WorkerBackendSessionRow | undefined;
  return row ? mapWorkerBackendSessionRow(row) : null;
}

/**
 * Lists all durable backend sessions in stable lease order.
 *
 * @param owner Admitted SQLite handle for the native backend-session records.
 * @returns Durable session rows.
 */
export function listWorkerBackendSessions(
  owner: WorkerBackendSessionDb
): WorkerBackendSessionRecord[] {
  const rows = owner.sqlite
    .prepare(`${workerBackendSessionSelectSql()} ORDER BY attempt_id ASC`)
    .all() as WorkerBackendSessionRow[];
  return rows.map(mapWorkerBackendSessionRow);
}

/** Reads one durable backend session or throws. */
function requireWorkerBackendSession(
  owner: WorkerBackendSessionDb,
  attemptId: string
): WorkerBackendSessionRecord {
  const session = getWorkerBackendSession(owner, attemptId);
  if (!session) {
    throw new BackendSessionRefusal(`Worker backend session not found: ${attemptId}`);
  }
  return session;
}

/** Selects one raw durable backend session row. */
function selectWorkerBackendSession(
  owner: WorkerBackendSessionDb,
  attemptId: string
): WorkerBackendSessionRow | undefined {
  return owner.sqlite
    .prepare(`${workerBackendSessionSelectSql()} WHERE attempt_id = ?`)
    .get(attemptId) as WorkerBackendSessionRow | undefined;
}

/** Returns the canonical worker backend session select projection. */
function workerBackendSessionSelectSql(): string {
  return `SELECT schema_version AS schemaVersion, attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
                 package_snapshot_id, backend_kind, deployment_id, backend_version,
                 backend_session_id, runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref,
                 staging_directory_ref, transient_provider_instance_id, workspace_handoff_state,
                 state, physical_cleaned_at, created_at, updated_at
          FROM worker_backend_sessions`;
}

/** Checks complete scheduler lineage equality. */
function attemptMatchesInput(
  lease: WorkerBackendSessionAttemptRow,
  input: RecordWorkerBackendSessionMaterializingInput
): boolean {
  return (
    lease.workspace_id === input.lineage.workspaceId &&
    lease.thread_id === input.lineage.threadId &&
    lease.turn_id === input.lineage.turnId &&
    lease.agent_session_id === input.identity.agentSessionId &&
    lease.input_ref === input.identity.packageSnapshotId
  );
}

/** Checks whether an existing anchor is an exact retry of the insertion input. */
function workerBackendSessionMatchesInput(
  record: WorkerBackendSessionRecord,
  input: RecordWorkerBackendSessionMaterializingInput,
  originPhysicalEpoch: string
): boolean {
  return (
    record.workspaceId === input.lineage.workspaceId &&
    record.threadId === input.lineage.threadId &&
    record.turnId === input.lineage.turnId &&
    record.agentSessionId === input.identity.agentSessionId &&
    record.packageSnapshotId === input.identity.packageSnapshotId &&
    record.backendKind === input.identity.backendKind &&
    record.deploymentId === input.identity.deploymentId &&
    record.backendVersion === input.backendVersion &&
    JSON.stringify(record.backendLineage) ===
      JSON.stringify(normalizeBackendLineage(input.backendLineage)) &&
    record.runtimeTargetId === input.identity.runtimeTargetId &&
    record.originPhysicalEpoch === originPhysicalEpoch &&
    record.sandboxBindingRef === input.sandboxBindingRef &&
    record.backendSessionId === input.identity.backendSessionId &&
    record.stagingDirectoryRef === input.identity.stagingDirectoryRef &&
    record.transientProviderInstanceId === input.identity.transientProviderInstanceId
  );
}

/** Maps a raw SQLite row to the durable public record. */
function mapWorkerBackendSessionRow(row: WorkerBackendSessionRow): WorkerBackendSessionRecord {
  return readRetainedV1(row, () => ({
    attemptId: row.attempt_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    agentSessionId: row.agent_session_id,
    packageSnapshotId: row.package_snapshot_id,
    backendKind: row.backend_kind,
    deploymentId: row.deployment_id,
    backendVersion: row.backend_version,
    runtimeTargetId: row.runtime_target_id,
    originPhysicalEpoch: requireStoredNanoHostPhysicalEpoch(row.origin_physical_epoch),
    backendLineage: parseBackendLineage(row.backend_lineage_json),
    sandboxBindingRef: row.sandbox_binding_ref,
    backendSessionId: row.backend_session_id,
    stagingDirectoryRef: row.staging_directory_ref,
    transientProviderInstanceId: row.transient_provider_instance_id,
    workspaceHandoffState: row.workspace_handoff_state,
    state: row.state,
    physicalCleanedAt: row.physical_cleaned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Removes the input discriminator before persisting the exact lineage payload. */
function normalizeBackendLineage(
  lineage: RecordWorkerBackendSessionMaterializingInput['backendLineage']
): WorkerBackendLineage {
  if (lineage.kind === 'reference') {
    return { imageRef: lineage.imageRef };
  }
  return {
    buildArgumentsDigest: lineage.buildArgumentsDigest,
    buildContextDigest: lineage.buildContextDigest,
    buildInputDigest: lineage.buildInputDigest,
    resultingImageDigest: lineage.resultingImageDigest,
  };
}

/** Reads retained image lineage, dropping descriptive additions while refusing unsupported core or required semantics. */
function parseBackendLineage(value: string): WorkerBackendLineage {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackendSessionRefusal('Worker backend session lineage is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.kind !== undefined ||
    (record.requiredFeatures !== undefined &&
      (!Array.isArray(record.requiredFeatures) || record.requiredFeatures.length !== 0))
  ) {
    throw new BackendSessionRefusal('Worker backend session lineage is invalid.');
  }
  if (typeof record.imageRef === 'string') {
    if (
      [
        'buildArgumentsDigest',
        'buildContextDigest',
        'buildInputDigest',
        'resultingImageDigest',
      ].some((key) => key in record)
    ) {
      throw new BackendSessionRefusal('Worker backend session lineage is invalid.');
    }
    return { imageRef: record.imageRef };
  }
  const keys = [
    'buildArgumentsDigest',
    'buildContextDigest',
    'buildInputDigest',
    'resultingImageDigest',
  ] as const;
  if (!('imageRef' in record) && keys.every((key) => typeof record[key] === 'string')) {
    return {
      buildArgumentsDigest: record.buildArgumentsDigest as string,
      buildContextDigest: record.buildContextDigest as string,
      buildInputDigest: record.buildInputDigest as string,
      resultingImageDigest: record.resultingImageDigest as string,
    };
  }
  throw new BackendSessionRefusal('Worker backend session lineage is invalid.');
}

/** Retires the original orphan and its Server Audit as one native savepoint tuple. */
export function retireOrphanWorkerBackendSession(
  coreDb: CoreDb,
  input: MarkWorkerBackendSessionLaunchingInput
): WorkerBackendSessionRecord {
  const session = transitionWorkerBackendSessionState(coreDb, {
    ...input,
    fromState: 'physical-cleaned',
    toState: 'cleaned',
  });
  recordServerAuditEvent({
    action: 'scheduler.orphan-backend-retired',
    category: 'system',
    coreDb,
    outcome: 'succeeded',
    resource: `server:worker-backend-session:${session.attemptId}`,
    severity: 'warning',
    summary: 'Unowned worker backend session physically cleaned and retired.',
    workspaceId: session.workspaceId,
    threadId: session.threadId,
    turnId: session.turnId,
    agentSessionId: session.agentSessionId,
  });
  return session;
}
