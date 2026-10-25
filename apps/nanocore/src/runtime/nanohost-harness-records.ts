import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import {
  canonicalNativeEnvironment,
  HARNESS_DEFAULT_MAX_ACTIVE_TURNS,
  HarnessCommandBodySchemas,
  HarnessQueuedCommandBodySchemas,
  HarnessResultEnvelopeReaderSchema,
  NativeEnvironmentRecordSchema,
  parseHarnessResultBody,
} from '@openkit/worker-protocol';
import type { CoreDb } from '../storage/db.js';
import { bindNanoHostAttemptRouteTokenHashes } from './nanohost-attempt-records.js';
import { hashWorkerRouteToken } from './worker-control-gateway.js';

/** Exact enqueue-to-result outage budget for one private Harness operation. */
export const NANO_HOST_HARNESS_RESULT_BUDGET_MS = 300_000;

/** Exact private Harness operation vocabulary. */
export const NANO_HOST_HARNESS_OPERATIONS = [
  'session.open',
  'session.inspect',
  'turn.start',
  'turn.interrupt',
  'session.close',
  'harness.drain',
] as const;

/** One exact private Harness operation. */
export type NanoHostHarnessOperation = (typeof NANO_HOST_HARNESS_OPERATIONS)[number];

/** One private Harness command returned only on the exact pull route. */
export interface NanoHostHarnessCommand {
  readonly harnessInstanceId: string;
  readonly schemaVersion: 2;
  readonly operationId: string;
  readonly sequence: number;
  readonly operation: NanoHostHarnessOperation;
  readonly body: Readonly<Record<string, unknown>>;
}

/** One exact private Harness operation result. */
export interface NanoHostHarnessResult {
  readonly harnessInstanceId: string;
  readonly schemaVersion: 2;
  readonly operationId: string;
  readonly sequence: number;
  readonly disposition: 'succeeded' | 'refused' | 'unknown';
  readonly body: Readonly<Record<string, unknown>>;
}

/** Input for adding one Harness Instance to a Sandbox runtime projection. */
export interface CreateNanoHostHarnessRuntimeInput {
  /** Authored operating bound for new Sandbox/Harness declarations; defaults to 20. */
  readonly maxActiveTurns?: number;
  /** Opaque adapter identity; the Harness's static registry decides whether it is supported. */
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly harnessBindingRef: string;
  readonly harnessCompatibilityKey: string;
  readonly harnessInstanceId: string;
  readonly imageDigest: string;
  readonly originPhysicalEpoch: string;
  readonly sandboxBindingRef: string;
  readonly sandboxCompatibilityKey: string;
  readonly sandboxIntegrationBindingRef: string;
  readonly sandboxRuntimeId: string;
  readonly runtimeTargetId: string;
  readonly timestamp: string;
}

/** Input for opening one Core AgentSession binding on the current Harness. */
export interface OpenNanoHostAgentSessionBindingInput {
  /** Existing binding's admitted package projection; application is acknowledged separately. */
  readonly nativeEnvironment?:
    | {
        readonly agentId: string;
        readonly imageDigest: string;
        readonly defaultsDigest: string;
        readonly values: Record<string, string>;
      }
    | undefined;
  readonly agentSessionCompatibilityKey: string;
  readonly agentSessionId: string;
  readonly agentSessionRuntimeBindingId: string;
  readonly effectiveSetupGeneration: number;
  readonly harnessInstanceId: string;
  readonly threadId: string;
  readonly timestamp: string;
  readonly workspaceId: string;
}

/** Exact durable command identity and its separately retained transient wire body. */
export interface PreparedNanoHostHarnessOperation {
  readonly command: NanoHostHarnessCommand;
  readonly wireBody: Readonly<Record<string, unknown>>;
}

/** Read-only preparation after the existing Harness slot wait, before native child admission. */
export interface PrepareNanoHostHarnessOperationInput {
  readonly body: Readonly<Record<string, unknown>>;
  readonly harnessInstanceId: string;
  readonly operation: NanoHostHarnessOperation;
  readonly timestamp: string;
  /** Test seam for the three turn.start route tokens. */
  readonly routeToken?: () => string;
  /** Test seam for the two session.open loopback credentials. */
  readonly loopbackCredential?: () => string;
}

/** Input for queueing one fixed Harness operation. */
export interface QueueNanoHostHarnessOperationInput {
  readonly prepared: PreparedNanoHostHarnessOperation;
  readonly body: Readonly<Record<string, unknown>>;
  readonly harnessInstanceId: string;
  readonly operation: NanoHostHarnessOperation;
  readonly timestamp: string;
}

/** Input for dispatching the next exact Harness operation. */
export interface DispatchNanoHostHarnessOperationInput {
  readonly sandboxIntegrationBindingRef: string;
  readonly now?: () => string;
}

/** Input for settling one exact Harness result. */
export interface SettleNanoHostHarnessOperationInput {
  readonly sandboxIntegrationBindingRef: string;
  readonly result: NanoHostHarnessResult;
  readonly timestamp: string;
}

/** Input for widening one dispatched operation to unknown cleanup. */
export interface MarkNanoHostHarnessOperationUnknownInput {
  readonly harnessBindingRef: string;
  readonly operationId: string;
  readonly timestamp: string;
}

/** Input for expiring one command that was never delivered. */
export interface ExpireNanoHostHarnessQueuedOperationInput {
  readonly harnessBindingRef: string;
  readonly timestamp: string;
}

/** Input for fencing one Sandbox after destructive cleanup becomes uncertain. */
export interface FenceNanoHostSandboxRuntimeInput {
  readonly harnessBindingRef?: string;
  readonly sandboxBindingRef?: string;
  readonly timestamp: string;
}

/** Exact current-owner inputs for one read-only AgentSession continuity inspection. */
export interface InspectNanoHostAgentSessionContinuityInput {
  readonly admissionAgentSessionId?: string;
  readonly admissionAttemptId?: string;
  /** No desired key means proof-only inspection cannot establish reuse. */
  readonly agentSessionCompatibilityKey?: string;
  readonly agentSessionId: string;
  readonly threadId: string;
  readonly workspaceId: string;
}

/** Durable private binding selected for reuse or exact local close. */
export interface NanoHostAgentSessionContinuityInspection {
  readonly agentSessionId: string;
  readonly agentSessionRuntimeBindingId: string;
  readonly harnessBindingRef: string;
  readonly harnessCompatibilityKey: string;
  readonly harnessInstanceId: string;
  /** Accepted ready proof is independent of current compatibility and reusability. */
  readonly nativeHandleDigest: string | null;
  readonly reusable: boolean;
}

/** Derives the private native-continuity key from the owning SessionCompatibilityKey. */
export function deriveNanoHostAgentSessionCompatibilityKey(input: {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly harnessCompatibilityKey: string;
  readonly sessionCompatibilityKey: string;
  readonly threadId: string;
}): string {
  requireIdentity(input.adapterId, 'Adapter');
  requireIdentity(input.adapterVersion, 'Adapter version');
  requireSha256(input.harnessCompatibilityKey, 'Harness compatibility key');
  if (!/^sha256:[0-9a-f]{64}$/.test(input.sessionCompatibilityKey)) {
    throw new Error('NanoHost SessionCompatibilityKey is invalid.');
  }
  requireIdentity(input.threadId, 'Thread');
  return createHash('sha256')
    .update(
      JSON.stringify({
        nativeConversation: {
          adapterId: input.adapterId,
          adapterVersion: input.adapterVersion,
          harnessCompatibilityKey: input.harnessCompatibilityKey,
        },
        sessionCompatibilityKey: input.sessionCompatibilityKey,
        threadId: input.threadId,
      })
    )
    .digest('hex');
}

/** Raw durable Harness row used by checked transitions. */
interface HarnessRow {
  readonly schemaVersion: unknown;
  readonly sandbox_runtime_id: string;
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly harness_instance_id: string;
  readonly harness_binding_ref: string;
  readonly max_open_sessions: number;
  readonly max_active_turns: number;
  readonly open_session_count: number;
  readonly active_turn_count: number;
  readonly lifecycle_state: string;
  readonly drain_state: string;
  readonly next_sequence: number;
  readonly operation_state: string;
  readonly operation_id: string | null;
  readonly operation_sequence: number | null;
  readonly operation: NanoHostHarnessOperation | null;
  readonly command_body_json: string | null;
  readonly command_fingerprint: string | null;
  readonly result_json: string | null;
  readonly result_fingerprint: string | null;
  readonly updated_at: string;
}

/** Creates the private Sandbox projection when absent and adds one resident Harness to it. */
export function createNanoHostHarnessRuntime(
  coreDb: CoreDb,
  input: CreateNanoHostHarnessRuntimeInput
): void {
  const capacity = input.maxActiveTurns ?? HARNESS_DEFAULT_MAX_ACTIVE_TURNS;
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new Error('NanoHost active-Turn capacity is invalid.');
  requireIdentity(input.runtimeTargetId, 'RuntimeTarget');
  requireIdentity(input.sandboxRuntimeId, 'Sandbox runtime');
  requireIdentity(input.sandboxBindingRef, 'Sandbox binding');
  requireIdentity(input.harnessInstanceId, 'Harness');
  requireIdentity(input.harnessBindingRef, 'Harness binding');
  requireSha256(input.harnessCompatibilityKey, 'Harness compatibility key');
  requireIdentity(input.sandboxIntegrationBindingRef, 'Sandbox Integration binding');
  requireIdentity(input.adapterVersion, 'Adapter version');
  requireSha256(input.sandboxCompatibilityKey, 'Sandbox compatibility key');
  if (!/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) {
    throw new Error('NanoHost image digest is invalid.');
  }
  if (!/^[0-9a-f]{64}$/.test(input.originPhysicalEpoch)) {
    throw new Error('NanoHost Sandbox physical Epoch origin is invalid.');
  }
  if (
    new Set([input.sandboxBindingRef, input.sandboxIntegrationBindingRef, input.harnessBindingRef])
      .size !== 3
  ) {
    throw new Error('Sandbox, Integration, and Harness bindings must be distinct.');
  }

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const sandbox = coreDb.sqlite
      .prepare('SELECT * FROM sandbox_runtime_records WHERE sandbox_runtime_id = ?')
      .get(input.sandboxRuntimeId) as
      | {
          readonly image_digest: string;
          readonly max_harnesses: number;
          readonly origin_physical_epoch: string;
          readonly runtime_target_id: string;
          readonly sandbox_binding_ref: string;
          readonly sandbox_compatibility_key: string;
          readonly sandbox_integration_binding_ref: string;
          readonly lifecycle_state: string;
          readonly health_state: string;
          readonly drain_state: string;
          readonly cleanup_state: string;
        }
      | undefined;
    const target = coreDb.sqlite
      .prepare(
        `SELECT physical_epoch AS physicalEpoch, predecessor_fenced AS predecessorFenced,
                ready, fresh_empty AS freshEmpty
         FROM nanohost_runtime_targets WHERE target_id = ?`
      )
      .get(input.runtimeTargetId) as
      | {
          readonly freshEmpty: 0 | 1;
          readonly physicalEpoch: string | null;
          readonly predecessorFenced: 0 | 1;
          readonly ready: 0 | 1;
        }
      | undefined;
    if (
      !target ||
      target.predecessorFenced !== 1 ||
      target.ready !== 1 ||
      target.freshEmpty !== 1 ||
      target.physicalEpoch !== input.originPhysicalEpoch
    ) {
      throw new Error('NanoHost Sandbox publication physical Epoch is not current.');
    }
    if (!sandbox) {
      coreDb.sqlite
        .prepare(
          `INSERT INTO sandbox_runtime_records (
             sandbox_runtime_id, runtime_target_id, origin_physical_epoch, sandbox_binding_ref,
             sandbox_integration_binding_ref, sandbox_compatibility_key, image_digest,
             environment_class, max_open_sessions, max_harnesses, max_active_turns,
             lifecycle_state, health_state, drain_state, cleanup_state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'shared-worker', ?, 8, ?,
             'open', 'ready', 'accepting', 'clean', ?, ?)`
        )
        .run(
          input.sandboxRuntimeId,
          input.runtimeTargetId,
          input.originPhysicalEpoch,
          input.sandboxBindingRef,
          input.sandboxIntegrationBindingRef,
          input.sandboxCompatibilityKey,
          input.imageDigest,
          Math.max(64, capacity),
          capacity,
          input.timestamp,
          input.timestamp
        );
    } else if (
      sandbox.runtime_target_id !== input.runtimeTargetId ||
      sandbox.origin_physical_epoch !== input.originPhysicalEpoch ||
      sandbox.sandbox_binding_ref !== input.sandboxBindingRef ||
      sandbox.sandbox_integration_binding_ref !== input.sandboxIntegrationBindingRef ||
      sandbox.sandbox_compatibility_key !== input.sandboxCompatibilityKey ||
      sandbox.image_digest !== input.imageDigest
    ) {
      throw new Error('NanoHost retained Sandbox is incompatible with the requested Harness.');
    } else {
      // A producer admitted before cleanup began must not create a fresh accepting Harness.
      if (
        sandbox.lifecycle_state !== 'open' ||
        sandbox.health_state !== 'ready' ||
        sandbox.drain_state !== 'accepting' ||
        sandbox.cleanup_state !== 'clean'
      )
        throw new Error('NanoHost retained Sandbox is not admitting a new Harness.');
      const count = coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM harness_instance_records WHERE sandbox_runtime_id = ?'
        )
        .get(input.sandboxRuntimeId) as { readonly count: number };
      if (count.count >= sandbox.max_harnesses) {
        throw new Error('NanoHost retained Sandbox has no Harness capacity.');
      }
    }
    coreDb.sqlite
      .prepare(
        `INSERT INTO harness_instance_records (
           harness_instance_id, sandbox_runtime_id, harness_binding_ref, harness_compatibility_key,
           runtime_family, adapter_id, adapter_version, protocol_version,
           capabilities_json, max_open_sessions, max_active_turns,
           open_session_count, active_turn_count, lifecycle_state, drain_state,
           next_sequence, operation_state, created_at, updated_at, schema_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, '[]', ?, ?, 0, 0, 'open', 'accepting', 0, 'idle', ?, ?, ?)`
      )
      .run(
        input.harnessInstanceId,
        input.sandboxRuntimeId,
        input.harnessBindingRef,
        input.harnessCompatibilityKey,
        input.adapterId,
        input.adapterId,
        input.adapterVersion,
        Math.max(8, capacity),
        capacity,
        input.timestamp,
        input.timestamp,
        writeRetainedV1({}).schemaVersion
      );
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Removes one fully deleted physical Sandbox projection and its cascading private bindings. */
export function removeNanoHostSandboxRuntimeForHarness(
  coreDb: CoreDb,
  harnessInstanceId: string
): void {
  requireIdentity(harnessInstanceId, 'Harness');
  const row = coreDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, sandbox_runtime_id AS sandboxRuntimeId FROM harness_instance_records WHERE harness_instance_id = ?'
    )
    .get(harnessInstanceId) as
    | { readonly schemaVersion: unknown; readonly sandboxRuntimeId: string }
    | undefined;
  if (!row) {
    return;
  }
  readRetainedV1(row, () => row);
  const removed = coreDb.sqlite
    .prepare('DELETE FROM sandbox_runtime_records WHERE sandbox_runtime_id = ?')
    .run(row.sandboxRuntimeId);
  if (removed.changes !== 1) {
    throw new Error('NanoHost deleted Sandbox runtime projection changed concurrently.');
  }
}

/** Removes one definitely deleted Sandbox projection by its exact physical binding. */
export function removeNanoHostSandboxRuntimeByBinding(
  coreDb: CoreDb,
  sandboxBindingRef: string
): void {
  requireIdentity(sandboxBindingRef, 'Sandbox binding');
  coreDb.sqlite
    .prepare('DELETE FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?')
    .run(sandboxBindingRef);
}

/**
 * Stops Harness admission after `cleanup_required` without marking Sandbox cleanup unknown and
 * without releasing occupancy. Idempotent when the Harness is already failed and draining.
 * A crash after this commit and before the first wider effect is dispatched cannot be told from
 * a crash after that effect was sent, so a later process must not invent a fresh delete.
 *
 * @param coreDb Core database that owns the Harness row.
 * @param input Harness binding and the settlement timestamp.
 */
export function drainNanoHostHarnessAdmission(
  coreDb: CoreDb,
  input: { readonly harnessBindingRef: string; readonly timestamp: string }
): void {
  requireIdentity(input.harnessBindingRef, 'Harness binding');
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    drainNanoHostHarnessAdmissionInTransaction(coreDb, input);
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Applies one admission fence inside the caller's write transaction. */
function drainNanoHostHarnessAdmissionInTransaction(
  coreDb: CoreDb,
  input: { readonly harnessBindingRef: string; readonly timestamp: string }
): void {
  const harness = requireHarnessByBinding(coreDb, input.harnessBindingRef);
  if (harness.lifecycle_state === 'failed' && harness.drain_state === 'draining') {
    return;
  }
  const update = coreDb.sqlite
    .prepare(
      `UPDATE harness_instance_records
       SET lifecycle_state = 'failed', drain_state = 'draining', updated_at = ?
       WHERE harness_instance_id = ? AND lifecycle_state = ? AND drain_state = ?`
    )
    .run(
      input.timestamp,
      harness.harness_instance_id,
      harness.lifecycle_state,
      harness.drain_state
    );
  if (update.changes !== 1) {
    throw new Error('NanoHost Harness admission fence changed concurrently.');
  }
}

/**
 * Drains the exact resident and all its Harnesses without claiming unknown cleanup or changing occupancy.
 *
 * @param coreDb Existing runtime record owner.
 * @param input Exact original physical Sandbox and Epoch.
 */
export function drainNanoHostSandboxAdmission(
  coreDb: CoreDb,
  input: { readonly sandboxBindingRef: string; readonly originPhysicalEpoch: string }
): void {
  coreDb.sqlite
    .transaction(() => {
      coreDb.sqlite
        .prepare(`UPDATE sandbox_runtime_records SET drain_state = 'draining'
      WHERE sandbox_binding_ref = ? AND origin_physical_epoch = ?`)
        .run(input.sandboxBindingRef, input.originPhysicalEpoch);
      coreDb.sqlite
        .prepare(`UPDATE harness_instance_records SET lifecycle_state = 'failed', drain_state = 'draining'
      WHERE sandbox_runtime_id IN (SELECT sandbox_runtime_id FROM sandbox_runtime_records
        WHERE sandbox_binding_ref = ? AND origin_physical_epoch = ?)`)
        .run(input.sandboxBindingRef, input.originPhysicalEpoch);
    })
    .immediate();
}

/** Fences one uncertain Sandbox and drains its Harness without changing scheduler capacity. */
export function fenceNanoHostSandboxRuntime(
  coreDb: CoreDb,
  input: FenceNanoHostSandboxRuntimeInput
): void {
  if ((input.harnessBindingRef ? 1 : 0) + (input.sandboxBindingRef ? 1 : 0) !== 1) {
    throw new Error('NanoHost Sandbox fence requires exactly one binding reference.');
  }
  if (input.harnessBindingRef) {
    requireIdentity(input.harnessBindingRef, 'Harness binding');
  }
  if (input.sandboxBindingRef) {
    requireIdentity(input.sandboxBindingRef, 'Sandbox binding');
  }

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    fenceNanoHostSandboxRuntimeInTransaction(coreDb, input);
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Reads one exact durable AgentSession binding and proves whether it is reusable before a lease.
 *
 * A null result proves that neither a binding nor a conflicting live lease exists for the
 * AgentSession. Post-dispatch inspection may ignore only the exact newly acquired admission lease.
 */
export function inspectNanoHostAgentSessionContinuity(
  coreDb: CoreDb,
  input: InspectNanoHostAgentSessionContinuityInput
): NanoHostAgentSessionContinuityInspection | null {
  requireIdentity(input.agentSessionId, 'AgentSession');
  requireIdentity(input.threadId, 'Thread');
  requireIdentity(input.workspaceId, 'Workspace');
  const hasAdmissionLease = input.admissionAttemptId !== undefined;
  if (hasAdmissionLease !== (input.admissionAgentSessionId !== undefined)) {
    throw new Error('NanoHost AgentSession inspection requires complete admission lease lineage.');
  }
  if (input.admissionAttemptId && input.admissionAgentSessionId) {
    requireIdentity(input.admissionAttemptId, 'execution attempt');
    requireIdentity(input.admissionAgentSessionId, 'Admission AgentSession');
    const admissionLease = coreDb.sqlite
      .prepare(
        `SELECT workspace_id AS workspaceId, thread_id AS threadId,
                agent_session_id AS agentSessionId
         FROM scheduler_execution_attempts
         WHERE attempt_id = ?
           AND phase <> 'closed'`
      )
      .get(input.admissionAttemptId) as
      | {
          readonly agentSessionId: string;
          readonly threadId: string;
          readonly workspaceId: string;
        }
      | undefined;
    if (
      !admissionLease ||
      admissionLease.workspaceId !== input.workspaceId ||
      admissionLease.threadId !== input.threadId ||
      admissionLease.agentSessionId !== input.admissionAgentSessionId
    ) {
      throw new Error('NanoHost AgentSession admission lease lineage changed concurrently.');
    }
  }
  const hasActiveLease = Boolean(
    coreDb.sqlite
      .prepare(
        `SELECT 1 FROM scheduler_execution_attempts
         WHERE agent_session_id = ?
           AND phase <> 'closed'
           AND (? IS NULL OR attempt_id <> ?)
         LIMIT 1`
      )
      .get(input.agentSessionId, input.admissionAttemptId ?? null, input.admissionAttemptId ?? null)
  );
  const row = coreDb.sqlite
    .prepare(
      `SELECT b.schema_version AS schemaVersion, h.schema_version AS harnessSchemaVersion,
              b.agent_session_runtime_binding_id AS agentSessionRuntimeBindingId,
              b.workspace_id AS workspaceId, b.thread_id AS threadId,
              b.agent_session_compatibility_key AS agentSessionCompatibilityKey,
              b.native_handle_state AS nativeHandleState,
              b.native_handle_digest AS nativeHandleDigest,
              b.lifecycle_state AS bindingLifecycleState,
              b.current_turn_id AS currentTurnId, b.current_attempt_id AS currentAttemptId,
              b.cleanup_state AS bindingCleanupState,
              h.harness_instance_id AS harnessInstanceId,
              h.harness_binding_ref AS harnessBindingRef,
              h.harness_compatibility_key AS harnessCompatibilityKey,
              h.adapter_id AS adapterId,
              h.adapter_version AS adapterVersion,
              h.lifecycle_state AS harnessLifecycleState,
              h.drain_state AS harnessDrainState,
              h.operation_state AS operationState,
              s.lifecycle_state AS sandboxLifecycleState,
              s.health_state AS sandboxHealthState,
              s.drain_state AS sandboxDrainState,
              s.cleanup_state AS sandboxCleanupState
       FROM agent_session_runtime_bindings b
       JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
       JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
       WHERE b.agent_session_id = ?`
    )
    .get(input.agentSessionId) as
    | {
        readonly schemaVersion: unknown;
        readonly harnessSchemaVersion: unknown;
        readonly adapterId: string;
        readonly adapterVersion: string;
        readonly agentSessionCompatibilityKey: string;
        readonly agentSessionRuntimeBindingId: string;
        readonly bindingCleanupState: string;
        readonly bindingLifecycleState: string;
        readonly currentAttemptId: string | null;
        readonly currentTurnId: string | null;
        readonly harnessBindingRef: string;
        readonly harnessCompatibilityKey: string;
        readonly harnessDrainState: string;
        readonly harnessInstanceId: string;
        readonly harnessLifecycleState: string;
        readonly nativeHandleDigest: string | null;
        readonly nativeHandleState: string;
        readonly operationState: string;
        readonly sandboxCleanupState: string;
        readonly sandboxDrainState: string;
        readonly sandboxHealthState: string;
        readonly sandboxLifecycleState: string;
        readonly threadId: string;
        readonly workspaceId: string;
      }
    | undefined;
  if (!row) {
    if (hasActiveLease) {
      throw new Error('NanoHost AgentSession has a live lease without its durable binding.');
    }
    return null;
  }
  readRetainedV1(row, () => row);
  readRetainedV1({ schemaVersion: row.harnessSchemaVersion }, () => row);
  const expectedRuntimeCompatibilityKey =
    input.agentSessionCompatibilityKey === undefined
      ? null
      : deriveNanoHostAgentSessionCompatibilityKey({
          adapterId: row.adapterId,
          adapterVersion: row.adapterVersion,
          harnessCompatibilityKey: row.harnessCompatibilityKey,
          sessionCompatibilityKey: input.agentSessionCompatibilityKey,
          threadId: input.threadId,
        });
  if (hasActiveLease) {
    throw new Error('NanoHost AgentSession still owns a live execution attempt.');
  }
  if (
    row.workspaceId !== input.workspaceId ||
    row.threadId !== input.threadId ||
    row.harnessLifecycleState !== 'open' ||
    row.harnessDrainState !== 'accepting' ||
    row.currentTurnId !== null ||
    row.currentAttemptId !== null ||
    !['idle', 'settled'].includes(row.operationState) ||
    row.sandboxLifecycleState !== 'open' ||
    row.sandboxHealthState !== 'ready' ||
    row.sandboxDrainState !== 'accepting' ||
    row.sandboxCleanupState !== 'clean' ||
    row.bindingCleanupState === 'unknown' ||
    !['open', 'opening', 'closing'].includes(row.bindingLifecycleState)
  ) {
    throw new Error('NanoHost AgentSession durable binding is not safe for reuse or local close.');
  }
  const nativeHandleReady =
    row.nativeHandleState === 'ready' &&
    typeof row.nativeHandleDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(row.nativeHandleDigest);
  return {
    agentSessionId: input.agentSessionId,
    agentSessionRuntimeBindingId: row.agentSessionRuntimeBindingId,
    harnessBindingRef: row.harnessBindingRef,
    harnessCompatibilityKey: row.harnessCompatibilityKey,
    harnessInstanceId: row.harnessInstanceId,
    nativeHandleDigest: nativeHandleReady ? row.nativeHandleDigest : null,
    reusable:
      row.agentSessionCompatibilityKey === expectedRuntimeCompatibilityKey &&
      row.bindingLifecycleState === 'open' &&
      row.bindingCleanupState === 'clean' &&
      row.currentTurnId === null &&
      row.currentAttemptId === null &&
      nativeHandleReady,
  };
}

/** Reads the sole native AgentSession occupying one Workspace Thread, if any. */
export function readNanoHostThreadAgentSessionBinding(
  coreDb: CoreDb,
  input: {
    readonly threadId: string;
    readonly workspaceId: string;
  }
): { readonly agentSessionId: string } | null {
  requireIdentity(input.workspaceId, 'Workspace');
  requireIdentity(input.threadId, 'Thread');
  const rows = coreDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, agent_session_id AS agentSessionId
       FROM agent_session_runtime_bindings
       WHERE workspace_id = ? AND thread_id = ?`
    )
    .all(input.workspaceId, input.threadId) as Array<{
    readonly schemaVersion: unknown;
    readonly agentSessionId: string;
  }>;
  if (rows.length > 1) {
    throw new Error('NanoHost Harness already has a current AgentSession for this Thread.');
  }
  const row = rows[0];
  return row ? readRetainedV1(row, () => ({ agentSessionId: row.agentSessionId })) : null;
}

/** Opens one pending native-conversation binding, copies measured image digest, and consumes only open-session capacity. */
export function openNanoHostAgentSessionBinding(
  coreDb: CoreDb,
  input: OpenNanoHostAgentSessionBindingInput
): void {
  requireIdentity(input.agentSessionId, 'AgentSession');
  requireIdentity(input.agentSessionRuntimeBindingId, 'AgentSession runtime binding');
  requireIdentity(input.harnessInstanceId, 'Harness');
  requireIdentity(input.workspaceId, 'Workspace');
  requireIdentity(input.threadId, 'Thread');
  requireSha256(input.agentSessionCompatibilityKey, 'AgentSession compatibility key');
  if (!Number.isSafeInteger(input.effectiveSetupGeneration) || input.effectiveSetupGeneration < 1) {
    throw new Error('Effective setup generation is invalid.');
  }

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const harness = requireHarness(coreDb, input.harnessInstanceId);
    if (
      harness.lifecycle_state !== 'open' ||
      harness.drain_state !== 'accepting' ||
      harness.open_session_count >= harness.max_open_sessions
    ) {
      throw new Error('NanoHost Harness cannot admit another AgentSession.');
    }
    const measuredImageDigest = readSandboxMeasuredImageDigest(coreDb, input.harnessInstanceId);
    if (input.nativeEnvironment) {
      requireIdentity(input.nativeEnvironment.agentId, 'Agent');
      const record = NativeEnvironmentRecordSchema.parse(input.nativeEnvironment);
      if (record.imageDigest !== measuredImageDigest)
        throw new Error('Native environment image conflicts with the measured Sandbox.');
      input = {
        ...input,
        nativeEnvironment: { agentId: input.nativeEnvironment.agentId, ...record },
      };
    }
    const threadBinding = coreDb.sqlite
      .prepare(
        `SELECT 1 FROM agent_session_runtime_bindings
         WHERE workspace_id = ? AND thread_id = ? LIMIT 1`
      )
      .get(input.workspaceId, input.threadId);
    if (threadBinding) {
      throw new Error('NanoHost Harness already has a current AgentSession for this Thread.');
    }
    coreDb.sqlite
      .prepare(
        `INSERT INTO agent_session_runtime_bindings (
           agent_session_runtime_binding_id, harness_instance_id, agent_session_id,
           workspace_id, thread_id, agent_session_compatibility_key,
           effective_setup_generation, native_handle_state, native_handle_digest,
           lifecycle_state, current_turn_id, current_attempt_id, next_turn_sequence, cleanup_state,
           created_at, updated_at, image_digest, native_environment_json, schema_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'opening', NULL, NULL, 0, 'clean', ?, ?, ?, ?, ?)`
      )
      .run(
        input.agentSessionRuntimeBindingId,
        input.harnessInstanceId,
        input.agentSessionId,
        input.workspaceId,
        input.threadId,
        input.agentSessionCompatibilityKey,
        input.effectiveSetupGeneration,
        input.timestamp,
        input.timestamp,
        measuredImageDigest,
        input.nativeEnvironment ? JSON.stringify(input.nativeEnvironment) : null,
        writeRetainedV1({}).schemaVersion
      );
    persistCopiedMeasuredHarnessIdentity(
      coreDb,
      input.agentSessionRuntimeBindingId,
      measuredImageDigest,
      input.timestamp
    );
    const updated = coreDb.sqlite
      .prepare(
        `UPDATE harness_instance_records
         SET open_session_count = open_session_count + 1, updated_at = ?
         WHERE harness_instance_id = ? AND open_session_count < max_open_sessions`
      )
      .run(input.timestamp, input.harnessInstanceId);
    if (updated.changes !== 1) {
      throw new Error('NanoHost Harness open-session capacity changed concurrently.');
    }
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Copies the measured image digest onto an existing AgentSession binding.
 *
 * @param coreDb Durable Core database.
 * @param input Binding identity, digest value, and timestamp.
 */
export function copyNanoHostMeasuredHarnessIdentity(
  coreDb: CoreDb,
  input: {
    readonly agentSessionRuntimeBindingId: string;
    readonly imageDigest: string;
    readonly timestamp: string;
  }
): void {
  requireIdentity(input.agentSessionRuntimeBindingId, 'AgentSession runtime binding');
  if (!/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) {
    throw new Error('NanoHost image digest is invalid.');
  }
  const row = coreDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, image_digest AS imageDigest
       FROM agent_session_runtime_bindings
       WHERE agent_session_runtime_binding_id = ?`
    )
    .get(input.agentSessionRuntimeBindingId) as
    | { readonly schemaVersion: unknown; readonly imageDigest: string | null }
    | undefined;
  if (!row) {
    throw new Error('NanoHost AgentSession binding is missing.');
  }
  readRetainedV1(row, () => row);
  if (!row.imageDigest) {
    const updated = coreDb.sqlite
      .prepare(
        `UPDATE agent_session_runtime_bindings
         SET image_digest = ?, updated_at = ?
         WHERE agent_session_runtime_binding_id = ?
           AND image_digest IS NULL`
      )
      .run(input.imageDigest, input.timestamp, input.agentSessionRuntimeBindingId);
    if (updated.changes !== 1) {
      throw new Error('NanoHost measured harness identity changed concurrently.');
    }
  }
  persistCopiedMeasuredHarnessIdentity(
    coreDb,
    input.agentSessionRuntimeBindingId,
    input.imageDigest,
    input.timestamp
  );
}

/**
 * Reads the current measured image digest copied for one AgentSession binding.
 *
 * @param coreDb Durable Core database.
 * @param agentSessionRuntimeBindingId Exact binding identity.
 * @returns Live binding copy, else the latest surviving copy, or null when none exist.
 */
export function readNanoHostMeasuredHarnessIdentity(
  coreDb: CoreDb,
  agentSessionRuntimeBindingId: string
): string | null {
  requireIdentity(agentSessionRuntimeBindingId, 'AgentSession runtime binding');
  const row = coreDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, image_digest AS imageDigest
       FROM agent_session_runtime_bindings
       WHERE agent_session_runtime_binding_id = ?`
    )
    .get(agentSessionRuntimeBindingId) as
    | { readonly schemaVersion: unknown; readonly imageDigest: string | null }
    | undefined;
  if (row) readRetainedV1(row, () => row);
  if (typeof row?.imageDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(row.imageDigest)) {
    return row.imageDigest;
  }
  const copied = coreDb.sqlite
    .prepare(
      `SELECT image_digest AS imageDigest
       FROM agent_session_runtime_binding_image_digests
       WHERE agent_session_runtime_binding_id = ?
       ORDER BY copied_at DESC, image_digest DESC`
    )
    .get(agentSessionRuntimeBindingId) as { readonly imageDigest: string } | undefined;
  if (copied && /^sha256:[0-9a-f]{64}$/.test(copied.imageDigest)) {
    return copied.imageDigest;
  }
  return null;
}

/**
 * Lists every surviving measured image digest copied for one derived binding identity.
 *
 * @param coreDb Durable Core database.
 * @param agentSessionRuntimeBindingId Exact binding identity.
 * @returns Distinct copied digests in stable order so a new base image can false-split.
 */
export function listNanoHostMeasuredHarnessIdentities(
  coreDb: CoreDb,
  agentSessionRuntimeBindingId: string
): readonly string[] {
  requireIdentity(agentSessionRuntimeBindingId, 'AgentSession runtime binding');
  const rows = coreDb.sqlite
    .prepare(
      `SELECT image_digest AS imageDigest
       FROM agent_session_runtime_binding_image_digests
       WHERE agent_session_runtime_binding_id = ?
       ORDER BY image_digest`
    )
    .all(agentSessionRuntimeBindingId) as Array<{ readonly imageDigest: string }>;
  return rows
    .map((row) => row.imageDigest)
    .filter((digest) => /^sha256:[0-9a-f]{64}$/.test(digest));
}

/**
 * Prepares exact native identity after serialization and before native child admission.
 * This owner reads current lineage without SQL writes. Raw credentials stay transient.
 */
export function prepareNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: PrepareNanoHostHarnessOperationInput
): PreparedNanoHostHarnessOperation {
  const body = requireHarnessOperationBody(input.operation, input.body);
  const harness = requireHarness(coreDb, input.harnessInstanceId);
  requireOperationLineage(coreDb, harness, input.operation, body);
  let wireBody = body;
  if (input.operation === 'turn.start') {
    const token = input.routeToken ?? (() => randomBytes(32).toString('base64url'));
    const workerControlToken = requireRouteToken(token());
    let inferenceToken = requireRouteToken(token());
    while (inferenceToken === workerControlToken) inferenceToken = requireRouteToken(token());
    let capabilityToken = requireRouteToken(token());
    while (capabilityToken === workerControlToken || capabilityToken === inferenceToken)
      capabilityToken = requireRouteToken(token());
    wireBody = { ...body, capabilityToken, inferenceToken, workerControlToken };
  } else if (input.operation === 'session.open') {
    const credential = input.loopbackCredential ?? (() => randomBytes(32).toString('base64url'));
    const inferenceLoopbackCredential = requireRouteToken(credential());
    let capabilityLoopbackCredential = requireRouteToken(credential());
    while (capabilityLoopbackCredential === inferenceLoopbackCredential)
      capabilityLoopbackCredential = requireRouteToken(credential());
    wireBody = { ...body, capabilityLoopbackCredential, inferenceLoopbackCredential };
  }
  // Compare the same JSON representation that survives Core publication and reopen.
  const durableBody = readJsonObject(
    canonicalJson(redactHarnessWireBody(input.operation, wireBody))
  );
  return {
    command: {
      body: durableBody,
      harnessInstanceId: harness.harness_instance_id,
      operation: input.operation,
      operationId: harnessOperationId(harness, input.operation, harness.next_sequence, durableBody),
      schemaVersion: 2,
      sequence: harness.next_sequence,
    },
    wireBody,
  };
}

/** Queues the prepared identity without credentials or unconsumed receipt retirement. */
export function queueNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: QueueNanoHostHarnessOperationInput
): number {
  const startedAt = performance.now();
  try {
    const body = requireHarnessOperationBody(input.operation, input.body);
    coreDb.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const harness = requireHarness(coreDb, input.harnessInstanceId);
      if (!['idle', 'settled'].includes(harness.operation_state)) {
        throw new Error('NanoHost Harness already has an unsettled operation.');
      }
      // Queueing retains the predecessor receipt; only physical dispatch may retire it.
      if (
        (input.operation === 'session.open' || input.operation === 'turn.start') &&
        (harness.lifecycle_state !== 'open' || harness.drain_state !== 'accepting')
      ) {
        throw new Error('NanoHost Harness is not accepting new work.');
      }
      requireOperationLineage(coreDb, harness, input.operation, body);
      const command = input.prepared.command;
      const durableBody = redactHarnessWireBody(input.operation, input.prepared.wireBody);
      const commandBodyJson = canonicalJson(durableBody);
      if (
        command.schemaVersion !== 2 ||
        command.harnessInstanceId !== harness.harness_instance_id ||
        command.operation !== input.operation ||
        command.sequence !== harness.next_sequence ||
        canonicalJson(command.body) !== commandBodyJson ||
        canonicalJson(requireDurableHarnessBody(input.operation, command.body)) !==
          canonicalJson(body) ||
        command.operationId !==
          harnessOperationId(harness, input.operation, command.sequence, durableBody)
      ) {
        throw new Error(
          'NanoHost Harness prepared identity conflicts with current binding or sequence.'
        );
      }
      const update = coreDb.sqlite
        .prepare(
          `UPDATE harness_instance_records
         SET operation_state = 'queued', operation_id = ?,
             operation_sequence = next_sequence, operation = ?, command_body_json = ?,
             command_fingerprint = ?, updated_at = ?
         WHERE harness_instance_id = ? AND operation_state IN ('idle', 'settled')
           AND next_sequence = ?`
        )
        .run(
          command.operationId,
          input.operation,
          commandBodyJson,
          sha256(commandBodyJson),
          input.timestamp,
          input.harnessInstanceId,
          command.sequence
        );
      if (update.changes !== 1) throw new Error('NanoHost Harness changed before enqueue.');
      coreDb.sqlite.exec('COMMIT');
      return command.sequence;
    } catch (error) {
      coreDb.sqlite.exec('ROLLBACK');
      throw error;
    }
  } finally {
    try {
      const durationMs = performance.now() - startedAt;
      if (durationMs >= 100) {
        console.error(
          JSON.stringify({
            stage: 'harness-enqueue',
            durationMs: Math.round(durationMs),
            timestamp: new Date().toISOString(),
            harnessInstanceId: input.harnessInstanceId,
          })
        );
      }
    } catch {
      // Diagnostics must not change the owning operation.
    }
  }
}

/**
 * Dispatches stored identity after current lineage and retained consumer proof checks.
 * Raw credentials are supplied by the caller only after its native child acknowledgement.
 */
export function dispatchNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: DispatchNanoHostHarnessOperationInput
): NanoHostHarnessCommand | null {
  requireIdentity(input.sandboxIntegrationBindingRef, 'Sandbox Integration binding');
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const integration = coreDb.sqlite
      .prepare(
        'SELECT sandbox_runtime_id AS sandboxRuntimeId FROM sandbox_runtime_records WHERE sandbox_integration_binding_ref = ?'
      )
      .get(input.sandboxIntegrationBindingRef) as { readonly sandboxRuntimeId: string } | undefined;
    if (!integration) {
      throw new Error('NanoHost Sandbox Integration binding is missing or stale.');
    }
    const harness = coreDb.sqlite
      .prepare(
        `SELECT *, schema_version AS schemaVersion FROM harness_instance_records
         WHERE sandbox_runtime_id = ? AND operation_state = 'queued'
         ORDER BY updated_at, harness_instance_id LIMIT 1`
      )
      .get(integration.sandboxRuntimeId) as HarnessRow | undefined;
    if (!harness) {
      coreDb.sqlite.exec('COMMIT');
      return null;
    }
    readRetainedV1(harness, () => harness);
    const receipt = readHarnessResultReceipt(harness);
    if (receipt && receipt.retained.consumption === undefined) {
      coreDb.sqlite.exec('COMMIT');
      return null;
    }
    requireConsumedHarnessResult(harness);
    const now = input.now?.() ?? new Date().toISOString();
    if (Date.parse(now) >= Date.parse(harness.updated_at) + NANO_HOST_HARNESS_RESULT_BUDGET_MS) {
      setHarnessUnknown(coreDb, harness.harness_instance_id, now, 'queued');
      coreDb.sqlite.exec('COMMIT');
      return null;
    }
    if (
      harness.operation_sequence !== harness.next_sequence ||
      !harness.operation ||
      !harness.operation_id ||
      !harness.command_body_json ||
      sha256(harness.command_body_json) !== harness.command_fingerprint
    ) {
      throw new Error('NanoHost Harness queued operation is incomplete or corrupt.');
    }
    const durableBody = readJsonObject(harness.command_body_json);
    const body = requireDurableHarnessBody(harness.operation, durableBody);
    if (
      harness.operation_id !==
      harnessOperationId(harness, harness.operation, harness.next_sequence, durableBody)
    )
      throw new Error('NanoHost Harness prepared operation identity conflicts.');
    requireOperationLineage(coreDb, harness, harness.operation, body);
    if (harness.operation === 'turn.start') {
      const attemptId = body.leaseId as string;
      const lease = coreDb.sqlite
        .prepare(
          'SELECT binding_ref AS bindingRef FROM scheduler_execution_attempts WHERE attempt_id = ?'
        )
        .get(attemptId) as { readonly bindingRef: string } | undefined;
      if (!lease) throw new Error('NanoHost Harness Turn lease is missing.');
      bindNanoHostAttemptRouteTokenHashes(coreDb, {
        attemptId,
        ...(input.now ? { now: input.now } : {}),
        sandboxBindingRef: lease.bindingRef,
        workerCapabilityTokenHash: requireSha256(
          durableBody.capabilityTokenHash,
          'capability token hash'
        ),
        workerControlTokenHash: requireSha256(
          durableBody.workerControlTokenHash,
          'worker control token hash'
        ),
        workerInferenceTokenHash: requireSha256(
          durableBody.inferenceTokenHash,
          'inference token hash'
        ),
      });
    }
    if (harness.operation === 'session.open') {
      const bound = coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET inference_loopback_credential_digest = ?, capability_loopback_credential_digest = ?,
               updated_at = ?
           WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?
             AND agent_session_id = ? AND lifecycle_state = 'opening'
             AND inference_loopback_credential_digest IS NULL
             AND capability_loopback_credential_digest IS NULL`
        )
        .run(
          requireSha256(
            durableBody.inferenceLoopbackCredentialHash,
            'inference loopback credential hash'
          ),
          requireSha256(
            durableBody.capabilityLoopbackCredentialHash,
            'capability loopback credential hash'
          ),
          now,
          body.agentSessionRuntimeBindingId,
          harness.harness_instance_id,
          body.agentSessionId
        );
      if (bound.changes !== 1) {
        throw new Error('NanoHost AgentSession loopback credentials were already delivered.');
      }
    }
    const update = coreDb.sqlite
      .prepare(
        `UPDATE harness_instance_records
         SET operation_state = 'dispatched', result_json = NULL, result_fingerprint = NULL,
             updated_at = ?
         WHERE harness_instance_id = ? AND operation_state = 'queued'
           AND operation_id = ? AND operation_sequence = ? AND next_sequence = ?`
      )
      .run(
        now,
        harness.harness_instance_id,
        harness.operation_id,
        harness.next_sequence,
        harness.next_sequence
      );
    if (update.changes !== 1)
      throw new Error('NanoHost Harness operation changed before dispatch.');
    coreDb.sqlite.exec('COMMIT');
    return {
      body: durableBody,
      harnessInstanceId: harness.harness_instance_id,
      operation: harness.operation,
      operationId: harness.operation_id,
      schemaVersion: 2,
      sequence: harness.next_sequence,
    };
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Expires one exact queued command before it can be delivered. */
export function expireNanoHostHarnessQueuedOperation(
  coreDb: CoreDb,
  input: ExpireNanoHostHarnessQueuedOperationInput
): void {
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const harness = requireHarnessByBinding(coreDb, input.harnessBindingRef);
    if (harness.operation_state !== 'queued') {
      throw new Error('NanoHost Harness enqueue expiry does not match a queued operation.');
    }
    setHarnessUnknown(coreDb, harness.harness_instance_id, input.timestamp, 'queued');
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Settles one exact dispatched result, or acknowledges the identical prior result
 * while that receipt is still retained in settled or queued state.
 *
 * @returns `settled` on the first durable settlement, `replayed` when the exact
 *   prior result is acknowledged without mutation.
 */
export function settleNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: SettleNanoHostHarnessOperationInput
): 'settled' | 'replayed' {
  input = { ...input, result: HarnessResultEnvelopeReaderSchema.parse(input.result) };
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const harness = requireHarnessForIntegration(
      coreDb,
      input.sandboxIntegrationBindingRef,
      input.result.harnessInstanceId
    );
    // Verify the retained representation before parsing or comparing a descriptive view.
    if (harness.result_json && sha256(harness.result_json) !== harness.result_fingerprint)
      throw new Error('NanoHost Harness retained result fingerprint conflicts.');
    const retained = harness.result_json ? readJsonObject(harness.result_json) : null;
    const isPriorReceipt =
      ['settled', 'queued', 'unknown'].includes(harness.operation_state) &&
      retained?.operationId === input.result.operationId;
    if (isPriorReceipt && retained) {
      const receipt = HarnessResultEnvelopeReaderSchema.parse(retained);
      // A queued successor overwrote operation provenance. Every plausible reader must see an unchanged core; shared refusal grammar needs no unique operation name, and a collision cannot hide a change seen by another reader.
      const candidates =
        harness.operation_state === 'queued'
          ? NANO_HOST_HARNESS_OPERATIONS.filter((candidate) => {
              try {
                requireHarnessResult(candidate, receipt, harness.max_active_turns);
                return true;
              } catch {
                return false;
              }
            })
          : harness.operation
            ? [harness.operation]
            : [];
      if (candidates.length === 0)
        throw new Error(
          'NanoHost Harness result replay conflicts with unmatched retained operation.'
        );
      for (const operation of candidates) {
        let identical = false;
        try {
          identical =
            canonicalJson(
              requireHarnessResult(
                operation,
                receipt,
                harness.max_active_turns
              ) as unknown as Record<string, unknown>
            ) ===
            canonicalJson(
              requireHarnessResult(
                operation,
                input.result,
                harness.max_active_turns
              ) as unknown as Record<string, unknown>
            );
        } catch {
          // Reader refusal is a replay conflict, just like a changed normalized core.
        }
        if (!identical)
          throw new Error('NanoHost Harness result replay conflicts with the settled result.');
      }
      coreDb.sqlite.exec('COMMIT');
      return 'replayed';
    } else if (harness.operation) {
      input = {
        ...input,
        result: requireHarnessResult(harness.operation, input.result, harness.max_active_turns),
      };
    }
    if (harness.operation_state === 'settled') {
      throw new Error('NanoHost Harness result replay conflicts with the settled result.');
    }
    if (
      harness.operation_state !== 'dispatched' ||
      harness.operation_id !== input.result.operationId ||
      harness.operation_sequence !== input.result.sequence ||
      !harness.operation
    ) {
      throw new Error('NanoHost Harness result does not match the dispatched operation.');
    }
    if (harness.operation === 'session.close') {
      if (
        !harness.command_body_json ||
        sha256(harness.command_body_json) !== harness.command_fingerprint
      )
        throw new Error('NanoHost close command fingerprint conflicts before Core consumption.');
      const closeBody = readJsonObject(harness.command_body_json);
      requireDurableHarnessBody('session.close', closeBody);
      if (
        harness.operation_id !==
        harnessOperationId(harness, 'session.close', input.result.sequence, closeBody)
      )
        throw new Error('NanoHost close operation identity conflicts before Core consumption.');
    }
    const consumerContext =
      harness.operation === 'session.close'
        ? readHarnessConsumerContext(coreDb, harness)
        : undefined;
    // An idle AgentSession close is Core binding lifecycle work, not historical Turn work.
    // Consume its exact receipt in this same physical-state/capacity transaction before ACK.
    const command =
      harness.operation === 'session.close' && harness.command_body_json
        ? readJsonObject(harness.command_body_json)
        : null;
    const idleConsumerReceipt = command
      ? readNanoHostIdleCloseConsumerReceipt(coreDb, {
          harnessInstanceId: harness.harness_instance_id,
          harnessBindingRef: harness.harness_binding_ref,
          agentSessionId: requireIdentity(command.agentSessionId, 'close AgentSession'),
          agentSessionRuntimeBindingId: requireIdentity(
            command.agentSessionRuntimeBindingId,
            'close binding'
          ),
        })
      : null;
    const consumption: HarnessResultConsumption | undefined =
      idleConsumerReceipt === null
        ? undefined
        : {
            consumerReceipt: idleConsumerReceipt,
            harnessBindingRef: harness.harness_binding_ref,
            operationId: input.result.operationId,
            sequence: input.result.sequence,
            resultFingerprint: sha256(
              canonicalJson(input.result as unknown as Record<string, unknown>)
            ),
          };
    const resultJson = canonicalJson({
      ...input.result,
      ...(consumerContext ? { consumerContext } : {}),
      ...(consumption ? { consumption } : {}),
    });
    if (
      input.result.disposition === 'refused' &&
      input.result.body.reasonCode === 'cleanup_required'
    ) {
      // Admission stops here. Sandbox cleanup stays clean so the live owner can issue the first
      // wider delete; an unknown fence would skip that delete.
      drainNanoHostHarnessAdmissionInTransaction(coreDb, {
        harnessBindingRef: harness.harness_binding_ref,
        timestamp: input.timestamp,
      });
    }
    if (input.result.disposition === 'unknown') {
      setHarnessUnknown(coreDb, harness.harness_instance_id, input.timestamp);
      const retainedUnknown = coreDb.sqlite
        .prepare(`UPDATE harness_instance_records SET result_json = ?, result_fingerprint = ?
          WHERE harness_instance_id = ? AND operation_state = 'unknown'
            AND operation_id = ? AND operation_sequence = ?`)
        .run(
          resultJson,
          sha256(resultJson),
          harness.harness_instance_id,
          input.result.operationId,
          input.result.sequence
        );
      if (retainedUnknown.changes !== 1)
        throw new Error('NanoHost Harness unknown receipt changed concurrently.');
      coreDb.sqlite.exec('COMMIT');
    } else {
      if (input.result.disposition === 'succeeded') {
        projectSuccessfulResult(coreDb, harness, input.result.body, input.timestamp);
      }
      const update = coreDb.sqlite
        .prepare(
          `UPDATE harness_instance_records
         SET operation_state = 'settled', result_json = ?, result_fingerprint = ?,
             next_sequence = next_sequence + 1, updated_at = ?
         WHERE harness_instance_id = ? AND operation_state = 'dispatched'
           AND operation_id = ? AND operation_sequence = ?`
        )
        .run(
          resultJson,
          sha256(resultJson),
          input.timestamp,
          harness.harness_instance_id,
          input.result.operationId,
          input.result.sequence
        );
      if (update.changes !== 1) {
        throw new Error('NanoHost Harness result settlement changed concurrently.');
      }
      coreDb.sqlite.exec('COMMIT');
    }
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
  return 'settled';
}

/** Marks one exact dispatched operation unknown and drains the Harness before capacity returns. */
export function markNanoHostHarnessOperationUnknown(
  coreDb: CoreDb,
  input: MarkNanoHostHarnessOperationUnknownInput
): void {
  requireSha256(input.operationId, 'Harness operation id');
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const harness = requireHarnessByBinding(coreDb, input.harnessBindingRef);
    if (harness.operation_state !== 'dispatched' || harness.operation_id !== input.operationId) {
      throw new Error('NanoHost Harness unknown result does not match a dispatched operation.');
    }
    setHarnessUnknown(coreDb, harness.harness_instance_id, input.timestamp);
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Projects operation-specific success without giving a Harness result product terminal authority. */
function projectSuccessfulResult(
  coreDb: CoreDb,
  harness: HarnessRow,
  body: Readonly<Record<string, unknown>>,
  timestamp: string
): void {
  const command = readJsonObject(harness.command_body_json ?? '{}');
  const bindingId = command.agentSessionRuntimeBindingId;
  if (typeof bindingId !== 'string') {
    if (harness.operation === 'harness.drain') {
      coreDb.sqlite
        .prepare(
          "UPDATE harness_instance_records SET drain_state = 'draining' WHERE harness_instance_id = ?"
        )
        .run(harness.harness_instance_id);
      return;
    }
    throw new Error('NanoHost Harness operation has no AgentSession binding.');
  }
  const retainedBinding = coreDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion FROM agent_session_runtime_bindings
    WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?`)
    .get(bindingId, harness.harness_instance_id);
  if (retainedBinding) readRetainedV1(retainedBinding, () => retainedBinding);
  if (harness.operation === 'session.close') {
    const removed = coreDb.sqlite
      .prepare(
        `DELETE FROM agent_session_runtime_bindings
         WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?
         RETURNING current_turn_id AS currentTurnId`
      )
      .get(bindingId, harness.harness_instance_id) as { currentTurnId: string | null } | undefined;
    if (!removed) {
      throw new Error('NanoHost AgentSession close binding is missing.');
    }
    // A failed Turn inspection can leave the binding holding its Turn slot until this close.
    const releasedTurns = removed.currentTurnId === null ? 0 : 1;
    const released = coreDb.sqlite
      .prepare(
        `UPDATE harness_instance_records
         SET open_session_count = open_session_count - 1, active_turn_count = active_turn_count - ?
         WHERE harness_instance_id = ? AND open_session_count > 0 AND active_turn_count >= ?`
      )
      .run(releasedTurns, harness.harness_instance_id, releasedTurns);
    if (released.changes !== 1) {
      throw new Error('NanoHost AgentSession close capacity changed concurrently.');
    }
    return;
  }
  // An interrupt proves cancellation only. The Turn keeps its occupancy and lineage until a
  // later terminal inspection proves the clean barrier, or `session.close` or wider cleanup
  // proves release.
  if (harness.operation === 'turn.interrupt') {
    return;
  }
  const nativeHandleState = body.nativeHandleState;
  const nativeHandleDigest = body.nativeHandleDigest;
  const bindingState = coreDb.sqlite
    .prepare(
      `SELECT lifecycle_state AS lifecycleState FROM agent_session_runtime_bindings
       WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?`
    )
    .get(bindingId, harness.harness_instance_id) as { readonly lifecycleState: string } | undefined;
  if (!bindingState) {
    throw new Error('NanoHost Harness result binding is missing.');
  }
  if (harness.operation === 'turn.start') {
    const started = coreDb.sqlite
      .prepare(
        `UPDATE agent_session_runtime_bindings
         SET lifecycle_state = 'active', current_turn_id = ?, current_attempt_id = ?, native_environment_applied = 1,
             native_handle_state = ?, native_handle_digest = ?,
             next_turn_sequence = next_turn_sequence + 1, updated_at = ?
         WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?
           AND lifecycle_state IN ('open', 'opening') AND next_turn_sequence = ?`
      )
      .run(
        command.turnId,
        command.leaseId,
        nativeHandleState,
        nativeHandleDigest,
        timestamp,
        bindingId,
        harness.harness_instance_id,
        command.turnSequence
      );
    const occupied = coreDb.sqlite
      .prepare(
        'UPDATE harness_instance_records SET active_turn_count = active_turn_count + 1 WHERE harness_instance_id = ? AND active_turn_count < max_active_turns'
      )
      .run(harness.harness_instance_id);
    if (started.changes !== 1 || occupied.changes !== 1) {
      throw new Error('NanoHost Harness active-Turn capacity changed before start settlement.');
    }
    return;
  }
  // A resident host keeps running after its Turn, so the Turn barrier is the binding leaving
  // `active` with clean disposable state: settled `open`, or `failed` because the host ended.
  // A failed binding without clean state keeps its Turn slot until `session.close`.
  if (
    harness.operation === 'session.inspect' &&
    bindingState.lifecycleState === 'active' &&
    body.cleanupState === 'clean' &&
    (body.state === 'open' || body.state === 'failed')
  ) {
    const inspected = coreDb.sqlite
      .prepare(
        `UPDATE agent_session_runtime_bindings
         SET lifecycle_state = ?, current_turn_id = NULL, current_attempt_id = NULL,
             native_handle_state = ?, native_handle_digest = ?, cleanup_state = 'clean', updated_at = ?
         WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?`
      )
      .run(
        body.state,
        nativeHandleState,
        nativeHandleDigest,
        timestamp,
        bindingId,
        harness.harness_instance_id
      );
    const released = coreDb.sqlite
      .prepare(
        'UPDATE harness_instance_records SET active_turn_count = active_turn_count - 1 WHERE harness_instance_id = ? AND active_turn_count > 0'
      )
      .run(harness.harness_instance_id);
    if (inspected.changes !== 1 || released.changes !== 1) {
      throw new Error('NanoHost Harness terminal inspection capacity changed concurrently.');
    }
    return;
  }
  coreDb.sqlite
    .prepare(
      `UPDATE agent_session_runtime_bindings
       SET lifecycle_state = ?, native_handle_state = ?, native_handle_digest = ?, updated_at = ?
       WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?`
    )
    .run(
      harness.operation === 'session.open' ? 'open' : body.state,
      nativeHandleState,
      nativeHandleDigest,
      timestamp,
      bindingId,
      harness.harness_instance_id
    );
}

/** Validates operation lineage against the current binding and Turn lease owners. */
function requireOperationLineage(
  coreDb: CoreDb,
  harness: HarnessRow,
  operation: NanoHostHarnessOperation,
  body: Readonly<Record<string, unknown>>
): void {
  if (operation === 'harness.drain') {
    return;
  }
  const binding = coreDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, agent_session_id AS agentSessionId, workspace_id AS workspaceId,
              thread_id AS threadId, lifecycle_state AS lifecycleState,
              current_turn_id AS currentTurnId, current_attempt_id AS currentAttemptId,
              next_turn_sequence AS nextTurnSequence, native_environment_json AS nativeEnvironment
       FROM agent_session_runtime_bindings
       WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?`
    )
    .get(body.agentSessionRuntimeBindingId, harness.harness_instance_id) as
    | {
        readonly schemaVersion: unknown;
        readonly agentSessionId: string;
        readonly currentAttemptId: string | null;
        readonly currentTurnId: string | null;
        readonly workspaceId: string;
        readonly threadId: string;
        readonly lifecycleState: string;
        readonly nextTurnSequence: number;
        readonly nativeEnvironment: string | null;
      }
    | undefined;
  if (binding) readRetainedV1(binding, () => binding);
  if (!binding || binding.agentSessionId !== body.agentSessionId) {
    throw new Error('NanoHost Harness AgentSession binding lineage conflicts.');
  }
  if (operation === 'session.open') {
    const expected =
      binding.nativeEnvironment === null
        ? null
        : NativeEnvironmentRecordSchema.parse(JSON.parse(binding.nativeEnvironment)).values;
    if (
      (expected === null) !== (body.nativeEnvironment === undefined) ||
      (expected !== null &&
        canonicalNativeEnvironment(expected) !==
          canonicalNativeEnvironment(body.nativeEnvironment as Record<string, string>))
    )
      throw new Error('NanoHost public native environment conflicts with the exact binding.');
  }
  if (operation === 'turn.interrupt') {
    if (
      harness.active_turn_count < 1 ||
      binding.lifecycleState !== 'active' ||
      binding.currentTurnId !== body.turnId ||
      binding.currentAttemptId !== body.leaseId
    ) {
      throw new Error('NanoHost Harness interrupt conflicts with the active Turn binding.');
    }
    const lease = coreDb.sqlite
      .prepare(
        `SELECT workspace_id AS workspaceId, thread_id AS threadId, turn_id AS turnId,
                agent_session_id AS agentSessionId, input_ref AS inputRef,
                phase
         FROM scheduler_execution_attempts WHERE attempt_id = ?`
      )
      .get(body.leaseId) as
      | {
          readonly agentSessionId: string;
          readonly inputRef: string;
          readonly phase: string;
          readonly threadId: string;
          readonly turnId: string;
          readonly workspaceId: string;
        }
      | undefined;
    const acceptedFinal = lease
      ? coreDb.sqlite
          .prepare(
            `SELECT 1 FROM worker_control_records
             WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
               AND agent_session_id = ? AND package_snapshot_id = ?
               AND operation = 'final_status' LIMIT 1`
          )
          .get(
            lease.workspaceId,
            lease.threadId,
            lease.turnId,
            lease.agentSessionId,
            lease.inputRef
          )
      : null;
    // The immutable backend session preserves the admitted AEP after a sibling replaces
    // the Harness command cell. Keep the same exact-package guard, not a last-command guess.
    const launch = coreDb.sqlite
      .prepare(`
      SELECT package_snapshot_id AS packageSnapshotId FROM worker_backend_sessions
      WHERE attempt_id = ? AND agent_session_id = ? AND workspace_id = ? AND thread_id = ? AND turn_id = ?
    `)
      .get(body.leaseId, body.agentSessionId, binding.workspaceId, binding.threadId, body.turnId) as
      | { packageSnapshotId: string }
      | undefined;
    if (
      !lease ||
      !['open', 'closing'].includes(lease.phase) ||
      lease.workspaceId !== binding.workspaceId ||
      lease.threadId !== binding.threadId ||
      lease.turnId !== body.turnId ||
      lease.agentSessionId !== body.agentSessionId ||
      launch?.packageSnapshotId !== lease.inputRef ||
      acceptedFinal
    ) {
      throw new Error('NanoHost Harness interrupt conflicts with the live lease lineage.');
    }
    return;
  }
  if (operation !== 'turn.start') {
    return;
  }
  // A queued/dispatched start reserves aggregate capacity before its native result arrives.
  // Other Harnesses have independent command cells but share this one Sandbox bound.
  const aggregate = coreDb.sqlite
    .prepare(`
    SELECT s.max_active_turns AS capacity,
           SUM(h.active_turn_count + CASE
             WHEN h.harness_instance_id <> ? AND h.operation = 'turn.start'
                  AND h.operation_state IN ('queued', 'dispatched') THEN 1 ELSE 0 END) AS occupied
    FROM sandbox_runtime_records s JOIN harness_instance_records h
      ON h.sandbox_runtime_id = s.sandbox_runtime_id
    WHERE s.sandbox_runtime_id = ? GROUP BY s.sandbox_runtime_id
  `)
    .get(harness.harness_instance_id, harness.sandbox_runtime_id) as {
    capacity: number;
    occupied: number;
  };
  if (aggregate.occupied >= aggregate.capacity) {
    throw Object.assign(new Error('NanoHost Sandbox active-Turn capacity is exhausted.'), {
      reasonCode: 'busy',
      exhaustedBound: 'sandbox.activeTurns',
    });
  }
  if (
    harness.active_turn_count >= harness.max_active_turns ||
    binding.workspaceId !== body.workspaceId ||
    binding.threadId !== body.threadId ||
    binding.nextTurnSequence !== body.turnSequence ||
    !['open', 'opening'].includes(binding.lifecycleState)
  ) {
    throw new Error('NanoHost Harness Turn admission conflicts with binding or capacity.');
  }
  const lease = coreDb.sqlite
    .prepare(
      `SELECT workspace_id AS workspaceId, thread_id AS threadId, turn_id AS turnId,
              agent_session_id AS agentSessionId, input_ref AS inputRef,
              phase
       FROM scheduler_execution_attempts WHERE attempt_id = ?`
    )
    .get(body.leaseId) as
    | {
        readonly workspaceId: string;
        readonly threadId: string;
        readonly turnId: string;
        readonly agentSessionId: string;
        readonly inputRef: string;
        readonly phase: string;
      }
    | undefined;
  if (
    !lease ||
    lease.phase !== 'open' ||
    lease.workspaceId !== body.workspaceId ||
    lease.threadId !== body.threadId ||
    lease.turnId !== body.turnId ||
    lease.agentSessionId !== body.agentSessionId ||
    lease.inputRef !== body.packageSnapshotId
  ) {
    throw new Error('NanoHost Harness Turn lease lineage conflicts.');
  }
}

/** Returns the queued instruction after checking its closed credential-digest extension. */
function requireDurableHarnessBody(
  operation: NanoHostHarnessOperation,
  durableBody: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const body = { ...durableBody };
  const digestNames =
    operation === 'turn.start'
      ? ['capabilityTokenHash', 'inferenceTokenHash', 'workerControlTokenHash']
      : operation === 'session.open'
        ? ['capabilityLoopbackCredentialHash', 'inferenceLoopbackCredentialHash']
        : [];
  const digests = digestNames.map((name) => {
    const digest = requireSha256(body[name], name);
    delete body[name];
    return digest;
  });
  if (new Set(digests).size !== digests.length)
    throw new Error('NanoHost Harness credential digests must be distinct.');
  return requireHarnessOperationBody(operation, body);
}

/** Redacts the exact wire schema before credentials can enter durable command bytes. */
function redactHarnessWireBody(
  operation: NanoHostHarnessOperation,
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const parsed = HarnessCommandBodySchemas[operation].safeParse(value);
  if (!parsed.success) throw new Error(`NanoHost ${operation} prepared wire body is invalid.`);
  const body: Record<string, unknown> = { ...parsed.data };
  if (operation === 'turn.start') {
    body.capabilityTokenHash = hashWorkerRouteToken(
      requireRouteToken(body.capabilityToken as string)
    );
    body.inferenceTokenHash = hashWorkerRouteToken(
      requireRouteToken(body.inferenceToken as string)
    );
    body.workerControlTokenHash = hashWorkerRouteToken(
      requireRouteToken(body.workerControlToken as string)
    );
    delete body.capabilityToken;
    delete body.inferenceToken;
    delete body.workerControlToken;
  } else if (operation === 'session.open') {
    body.capabilityLoopbackCredentialHash = hashLoopbackCredential(
      requireRouteToken(body.capabilityLoopbackCredential as string)
    );
    body.inferenceLoopbackCredentialHash = hashLoopbackCredential(
      requireRouteToken(body.inferenceLoopbackCredential as string)
    );
    delete body.capabilityLoopbackCredential;
    delete body.inferenceLoopbackCredential;
  }
  requireDurableHarnessBody(operation, body);
  return body;
}

/** Derives identity from current binding, exact sequence and redacted instruction. */
function harnessOperationId(
  harness: HarnessRow,
  operation: NanoHostHarnessOperation,
  sequence: number,
  body: Readonly<Record<string, unknown>>
): string {
  return sha256(
    canonicalJson({ body, harnessBindingRef: harness.harness_binding_ref, operation, sequence })
  );
}

/** Existing result receipt progress; this metadata grants no new execution authority. */
interface HarnessResultConsumption {
  readonly consumerReceipt: string;
  readonly harnessBindingRef: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly resultFingerprint: string;
}

/** Reads the original normalized result separately from receiver-owned progress metadata. */
function readHarnessResultReceipt(harness: HarnessRow): {
  readonly retained: Record<string, unknown>;
  readonly result: NanoHostHarnessResult;
  readonly resultFingerprint: string;
} | null {
  if (harness.result_json === null) {
    if (harness.result_fingerprint !== null)
      throw new Error('NanoHost Harness result fingerprint has no receipt.');
    return null;
  }
  if (sha256(harness.result_json) !== harness.result_fingerprint)
    throw new Error('NanoHost Harness retained result fingerprint conflicts.');
  const retained = readJsonObject(harness.result_json);
  const original = { ...retained };
  delete original.consumption;
  delete original.consumerContext;
  const result = HarnessResultEnvelopeReaderSchema.parse(original);
  if (result.harnessInstanceId !== harness.harness_instance_id)
    throw new Error('NanoHost Harness retained result owner conflicts.');
  return { retained, result, resultFingerprint: sha256(canonicalJson(original)) };
}

/** Exact existing Workspace-step or Core idle-binding consumer identity. */
type HarnessConsumerReceipt =
  | {
      readonly workspaceId: string;
      readonly turnId: string;
      readonly executionId: string;
      readonly stepId: string;
    }
  | {
      readonly workspaceId: string;
      readonly threadId: string;
      readonly agentSessionId: string;
      readonly agentSessionRuntimeBindingId: string;
    };

/** Checks closed consumer identity without crossing into Workspace SQL. */
function readHarnessConsumerReceipt(value: unknown): HarnessConsumerReceipt {
  if (typeof value !== 'string' || value.length > 4096)
    throw new Error('NanoHost Harness consumer receipt is invalid.');
  const receipt = readJsonObject(value);
  const fields = Object.keys(receipt).sort().join(',');
  if (fields === 'agentSessionId,agentSessionRuntimeBindingId,threadId,workspaceId') {
    return {
      workspaceId: requireIdentity(receipt.workspaceId, 'consumer Workspace'),
      threadId: requireIdentity(receipt.threadId, 'consumer Thread'),
      agentSessionId: requireIdentity(receipt.agentSessionId, 'consumer AgentSession'),
      agentSessionRuntimeBindingId: requireIdentity(
        receipt.agentSessionRuntimeBindingId,
        'consumer binding'
      ),
    };
  }
  if (fields !== 'executionId,stepId,turnId,workspaceId')
    throw new Error('NanoHost Harness consumer receipt fields are invalid.');
  return {
    workspaceId: requireIdentity(receipt.workspaceId, 'consumer Workspace'),
    turnId: requireIdentity(receipt.turnId, 'consumer Turn'),
    executionId: requireIdentity(receipt.executionId, 'consumer execution'),
    stepId: requireIdentity(receipt.stepId, 'consumer step'),
  };
}

/**
 * Reads positive idle Core binding authority under AgentSession Core and DX receipt consumption.
 * Missing binding or any open/closing attempt supplies no idle authority. Historical Turns and
 * process-local callback presence cannot establish this Core lifecycle owner.
 */
export function readNanoHostIdleCloseConsumerReceipt(
  coreDb: CoreDb,
  input: {
    readonly harnessInstanceId: string;
    readonly harnessBindingRef: string;
    readonly agentSessionId: string;
    readonly agentSessionRuntimeBindingId: string;
  }
): string | null {
  const harness = requireHarnessByBinding(coreDb, input.harnessBindingRef);
  if (harness.harness_instance_id !== input.harnessInstanceId)
    throw new Error('NanoHost idle close Harness binding conflicts.');
  const binding = coreDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, workspace_id AS workspaceId,
      thread_id AS threadId, agent_session_id AS agentSessionId, lifecycle_state AS lifecycleState,
      current_turn_id AS currentTurnId, current_attempt_id AS currentAttemptId
      FROM agent_session_runtime_bindings
      WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?`)
    .get(input.agentSessionRuntimeBindingId, harness.harness_instance_id) as
    | {
        schemaVersion: unknown;
        workspaceId: string;
        threadId: string;
        agentSessionId: string;
        lifecycleState: string;
        currentTurnId: string | null;
        currentAttemptId: string | null;
      }
    | undefined;
  if (!binding) return null;
  readRetainedV1(binding, () => binding);
  if (binding.agentSessionId !== input.agentSessionId)
    throw new Error('NanoHost idle close AgentSession binding conflicts.');
  if (
    binding.currentTurnId !== null ||
    binding.currentAttemptId !== null ||
    !['opening', 'open', 'failed'].includes(binding.lifecycleState)
  )
    return null;
  const attempts = coreDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, phase FROM scheduler_execution_attempts
      WHERE agent_session_id = ?`)
    .all(binding.agentSessionId) as { schemaVersion: unknown; phase: string }[];
  for (const attempt of attempts) {
    readRetainedV1(attempt, () => attempt);
    if (!['open', 'closing', 'closed'].includes(attempt.phase))
      throw new Error('NanoHost idle close attempt phase is invalid.');
    if (attempt.phase !== 'closed') return null;
  }
  return canonicalJson({
    workspaceId: requireIdentity(binding.workspaceId, 'idle Workspace'),
    threadId: requireIdentity(binding.threadId, 'idle Thread'),
    agentSessionId: binding.agentSessionId,
    agentSessionRuntimeBindingId: input.agentSessionRuntimeBindingId,
  });
}

/** Reads exact Workspace/Thread context before session.close removes the binding. */
function readHarnessConsumerContext(
  coreDb: CoreDb,
  harness: HarnessRow
): {
  readonly workspaceId: string;
  readonly threadId: string;
} {
  if (!harness.command_body_json) throw new Error('NanoHost Harness consumer command is missing.');
  const command = readJsonObject(harness.command_body_json);
  const binding = coreDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, workspace_id AS workspaceId,
      thread_id AS threadId, agent_session_id AS agentSessionId
      FROM agent_session_runtime_bindings
      WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?`)
    .get(command.agentSessionRuntimeBindingId, harness.harness_instance_id) as
    | {
        readonly schemaVersion: unknown;
        readonly workspaceId: string;
        readonly threadId: string;
        readonly agentSessionId: string;
      }
    | undefined;
  if (!binding || binding.agentSessionId !== command.agentSessionId)
    throw new Error('NanoHost Harness consumer binding is missing or stale.');
  readRetainedV1(binding, () => binding);
  return { workspaceId: binding.workspaceId, threadId: binding.threadId };
}

/** Validates exact consumer progress before a successor may retire this result. */
function requireConsumedHarnessResult(harness: HarnessRow): HarnessResultConsumption | null {
  const receipt = readHarnessResultReceipt(harness);
  if (!receipt) return null;
  const value = receipt.retained.consumption;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('NanoHost Harness retained result has no exact consumer acknowledgement.');
  const consumption = value as Record<string, unknown>;
  if (
    Object.keys(consumption).sort().join(',') !==
      'consumerReceipt,harnessBindingRef,operationId,resultFingerprint,sequence' ||
    consumption.harnessBindingRef !== harness.harness_binding_ref ||
    consumption.operationId !== receipt.result.operationId ||
    consumption.sequence !== receipt.result.sequence ||
    consumption.resultFingerprint !== receipt.resultFingerprint
  )
    throw new Error('NanoHost Harness retained consumer acknowledgement conflicts.');
  const consumer = readHarnessConsumerReceipt(consumption.consumerReceipt);
  if (canonicalJson(consumer) !== consumption.consumerReceipt)
    throw new Error('NanoHost Harness retained consumer receipt is not canonical.');
  if ('agentSessionRuntimeBindingId' in consumer) {
    const context = receipt.retained.consumerContext;
    if (
      !context ||
      typeof context !== 'object' ||
      Array.isArray(context) ||
      Object.keys(context).sort().join(',') !== 'threadId,workspaceId' ||
      (context as Record<string, unknown>).workspaceId !== consumer.workspaceId ||
      (context as Record<string, unknown>).threadId !== consumer.threadId
    )
      throw new Error('NanoHost idle Core consumer namespace conflicts.');
  }
  return consumption as unknown as HarnessResultConsumption;
}

/** Confirms an exact already-acknowledged replay after its live Workspace consumer has left. */
export function hasConsumedNanoHostHarnessResult(
  coreDb: CoreDb,
  result: NanoHostHarnessResult
): boolean {
  const incoming = HarnessResultEnvelopeReaderSchema.parse(result);
  const harness = requireHarness(coreDb, incoming.harnessInstanceId);
  const receipt = readHarnessResultReceipt(harness);
  if (!receipt || receipt.retained.consumption === undefined) return false;
  if (
    incoming.operationId !== receipt.result.operationId ||
    incoming.sequence !== receipt.result.sequence
  )
    return false;
  requireConsumedHarnessResult(harness);
  const operations =
    harness.operation_id === incoming.operationId && harness.operation
      ? [harness.operation]
      : NANO_HOST_HARNESS_OPERATIONS.filter((operation) => {
          try {
            requireHarnessResult(operation, receipt.result, harness.max_active_turns);
            return true;
          } catch {
            return false;
          }
        });
  if (operations.length === 0)
    throw new Error('NanoHost Harness consumed result operation is invalid.');
  for (const operation of operations) {
    if (
      canonicalJson(
        requireHarnessResult(operation, incoming, harness.max_active_turns) as unknown as Record<
          string,
          unknown
        >
      ) !==
      canonicalJson(
        requireHarnessResult(
          operation,
          receipt.result,
          harness.max_active_turns
        ) as unknown as Record<string, unknown>
      )
    )
      throw new Error('NanoHost Harness consumed result replay conflicts.');
  }
  return true;
}

/**
 * Records exact native consumer ACK after its Workspace outcome and consume intent commit.
 * The trusted internal consumer supplies its existing receipt after Worker ACK. Core checks
 * the original keyed result, binding and namespace without claiming cross-database atomicity.
 * Additive consumption and close-only consumerContext remain inside the existing result cell.
 */
export function acknowledgeNanoHostHarnessResult(
  coreDb: CoreDb,
  input: {
    readonly result: NanoHostHarnessResult;
    readonly harnessBindingRef: string;
    readonly consumerReceipt: string;
    readonly timestamp: string;
  }
): void {
  const incoming = HarnessResultEnvelopeReaderSchema.parse(input.result);
  const consumer = readHarnessConsumerReceipt(input.consumerReceipt);
  const consumerReceipt = canonicalJson(consumer);
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const harness = requireHarnessByBinding(coreDb, input.harnessBindingRef);
    const receipt = readHarnessResultReceipt(harness);
    if (
      !receipt ||
      incoming.harnessInstanceId !== harness.harness_instance_id ||
      incoming.operationId !== receipt.result.operationId ||
      incoming.sequence !== receipt.result.sequence
    )
      throw new Error('NanoHost Harness consumer acknowledgement does not match retained result.');
    // The original command remains available until its first ACK; an identical later ACK can
    // arrive after a successor queues, so validate replay from the retained keyed proof itself.
    const candidates =
      harness.operation_id === incoming.operationId && harness.operation
        ? [harness.operation]
        : NANO_HOST_HARNESS_OPERATIONS.filter((operation) => {
            try {
              requireHarnessResult(operation, receipt.result, harness.max_active_turns);
              return true;
            } catch {
              return false;
            }
          });
    if (candidates.length === 0)
      throw new Error('NanoHost Harness consumer result operation is invalid.');
    for (const operation of candidates) {
      if (
        canonicalJson(
          requireHarnessResult(operation, incoming, harness.max_active_turns) as unknown as Record<
            string,
            unknown
          >
        ) !==
        canonicalJson(
          requireHarnessResult(
            operation,
            receipt.result,
            harness.max_active_turns
          ) as unknown as Record<string, unknown>
        )
      )
        throw new Error(
          'NanoHost Harness consumer result conflicts with retained normalized core.'
        );
    }
    const consumption: HarnessResultConsumption = {
      consumerReceipt,
      harnessBindingRef: input.harnessBindingRef,
      operationId: incoming.operationId,
      sequence: incoming.sequence,
      resultFingerprint: receipt.resultFingerprint,
    };
    if (receipt.retained.consumption !== undefined) {
      const previous = requireConsumedHarnessResult(harness);
      if (
        canonicalJson(previous as unknown as Record<string, unknown>) !==
        canonicalJson(consumption as unknown as Record<string, unknown>)
      )
        throw new Error('NanoHost Harness consumer acknowledgement replay conflicts.');
      coreDb.sqlite.exec('COMMIT');
      return;
    }
    if (
      !['settled', 'unknown'].includes(harness.operation_state) ||
      harness.operation_id !== incoming.operationId ||
      harness.operation_sequence !== incoming.sequence ||
      !harness.operation ||
      !harness.command_body_json ||
      sha256(harness.command_body_json) !== harness.command_fingerprint
    )
      throw new Error('NanoHost Harness consumer command binding is stale.');
    if (!('turnId' in consumer))
      throw new Error('NanoHost idle Core consumption must commit with its physical transition.');
    const command = requireDurableHarnessBody(
      harness.operation,
      readJsonObject(harness.command_body_json)
    );
    const context =
      receipt.retained.consumerContext === undefined
        ? readHarnessConsumerContext(coreDb, harness)
        : receipt.retained.consumerContext;
    if (!context || typeof context !== 'object' || Array.isArray(context))
      throw new Error('NanoHost Harness consumer namespace is missing.');
    const namespace = context as Record<string, unknown>;
    const workspaceId = requireIdentity(namespace.workspaceId, 'consumer Workspace');
    const threadId = requireIdentity(namespace.threadId, 'consumer Thread');
    if (
      Object.keys(namespace).sort().join(',') !== 'threadId,workspaceId' ||
      consumer.workspaceId !== workspaceId ||
      (command.workspaceId !== undefined && command.workspaceId !== consumer.workspaceId) ||
      (command.threadId !== undefined && command.threadId !== threadId) ||
      (command.turnId !== undefined && command.turnId !== consumer.turnId)
    )
      throw new Error('NanoHost Harness consumer namespace conflicts with exact command.');
    const resultJson = canonicalJson({ ...receipt.retained, consumption });
    const update = coreDb.sqlite
      .prepare(`UPDATE harness_instance_records SET result_json = ?, result_fingerprint = ?
        WHERE harness_instance_id = ? AND result_fingerprint = ?
          AND operation_id = ? AND operation_sequence = ?`)
      .run(
        resultJson,
        sha256(resultJson),
        harness.harness_instance_id,
        harness.result_fingerprint,
        incoming.operationId,
        incoming.sequence
      );
    if (update.changes !== 1)
      throw new Error('NanoHost Harness consumer acknowledgement changed concurrently.');
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Requires the exact queued effect instruction before identity or dispatch. */
function requireHarnessOperationBody(
  operation: NanoHostHarnessOperation,
  body: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const parsed = HarnessQueuedCommandBodySchemas[operation].safeParse(body);
  if (!parsed.success) throw new Error(`NanoHost ${operation} command body fields are invalid.`);
  return parsed.data;
}

/** Reads the result core and requires the exact admitted Harness capacity declaration. */
function requireHarnessResult(
  operation: NanoHostHarnessOperation,
  result: NanoHostHarnessResult,
  maxActiveTurns: number
): NanoHostHarnessResult {
  let body: Record<string, unknown>;
  try {
    body = parseHarnessResultBody(operation, result);
  } catch (error) {
    if (result.body.startupFailure !== undefined)
      throw new Error('NanoHost Harness startup failure is invalid.', { cause: error });
    throw new Error(`NanoHost Harness ${operation} result is invalid.`, { cause: error });
  }
  if (
    operation === 'session.open' &&
    result.disposition === 'succeeded' &&
    body.maxActiveTurns !== maxActiveTurns
  )
    throw new Error('NanoHost Harness session.open success is invalid.');
  return { ...result, body };
}

/** Widens uncertain execution to the existing Harness admission fence. */
function setHarnessUnknown(
  coreDb: CoreDb,
  harnessInstanceId: string,
  timestamp: string,
  fromState: 'queued' | 'dispatched' = 'dispatched'
): void {
  const harness = requireHarness(coreDb, harnessInstanceId);
  const update = coreDb.sqlite
    .prepare(
      `UPDATE harness_instance_records
       SET operation_state = 'unknown', lifecycle_state = 'failed',
           drain_state = 'draining', updated_at = ?
       WHERE harness_instance_id = ? AND operation_state = ?`
    )
    .run(timestamp, harnessInstanceId, fromState);
  if (update.changes !== 1) {
    throw new Error('NanoHost Harness unknown cleanup transition changed concurrently.');
  }
  fenceNanoHostSandboxRuntimeInTransaction(coreDb, {
    harnessBindingRef: harness.harness_binding_ref,
    timestamp,
  });
}

/** Applies one Sandbox/Harness fence inside the caller's write transaction. */
function fenceNanoHostSandboxRuntimeInTransaction(
  coreDb: CoreDb,
  input: FenceNanoHostSandboxRuntimeInput
): void {
  const sandbox = input.sandboxBindingRef
    ? (coreDb.sqlite
        .prepare(
          'SELECT sandbox_runtime_id AS sandboxRuntimeId FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?'
        )
        .get(input.sandboxBindingRef) as { readonly sandboxRuntimeId: string } | undefined)
    : (coreDb.sqlite
        .prepare(
          `SELECT s.sandbox_runtime_id AS sandboxRuntimeId
           FROM sandbox_runtime_records s
           JOIN harness_instance_records h ON h.sandbox_runtime_id = s.sandbox_runtime_id
           WHERE h.harness_binding_ref = ?`
        )
        .get(input.harnessBindingRef) as { readonly sandboxRuntimeId: string } | undefined);
  if (!sandbox) {
    return;
  }
  const harnesses = coreDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion FROM harness_instance_records WHERE sandbox_runtime_id = ?'
    )
    .all(sandbox.sandboxRuntimeId);
  for (const harness of harnesses) readRetainedV1(harness, () => harness);
  const sandboxUpdate = coreDb.sqlite
    .prepare(
      `UPDATE sandbox_runtime_records
       SET lifecycle_state = 'failed', health_state = 'unknown', drain_state = 'draining',
           cleanup_state = 'unknown', updated_at = ?
       WHERE sandbox_runtime_id = ?`
    )
    .run(input.timestamp, sandbox.sandboxRuntimeId);
  if (sandboxUpdate.changes !== 1) {
    throw new Error('NanoHost Sandbox fence changed concurrently.');
  }
  coreDb.sqlite
    .prepare(
      `UPDATE harness_instance_records
       SET lifecycle_state = 'failed', drain_state = 'draining', updated_at = ?
       WHERE sandbox_runtime_id = ?`
    )
    .run(input.timestamp, sandbox.sandboxRuntimeId);
}

/** Reads one Harness by durable identity. */
function requireHarness(coreDb: CoreDb, harnessInstanceId: string): HarnessRow {
  const row = coreDb.sqlite
    .prepare(
      'SELECT *, schema_version AS schemaVersion FROM harness_instance_records WHERE harness_instance_id = ?'
    )
    .get(harnessInstanceId) as HarnessRow | undefined;
  if (!row) {
    throw new Error('NanoHost Harness is missing.');
  }
  return readRetainedV1(row, () => row);
}

/** Reads one Harness by the current private bridge binding. */
function requireHarnessByBinding(coreDb: CoreDb, harnessBindingRef: string): HarnessRow {
  requireIdentity(harnessBindingRef, 'Harness binding');
  const row = coreDb.sqlite
    .prepare(
      'SELECT *, schema_version AS schemaVersion FROM harness_instance_records WHERE harness_binding_ref = ?'
    )
    .get(harnessBindingRef) as HarnessRow | undefined;
  if (!row) {
    throw new Error('NanoHost Harness binding is missing or stale.');
  }
  return readRetainedV1(row, () => row);
}

/** Reads one NanoCore-selected Harness through its owning Sandbox Integration. */
function requireHarnessForIntegration(
  coreDb: CoreDb,
  sandboxIntegrationBindingRef: string,
  harnessInstanceId: string
): HarnessRow {
  requireIdentity(sandboxIntegrationBindingRef, 'Sandbox Integration binding');
  requireIdentity(harnessInstanceId, 'Harness');
  const row = coreDb.sqlite
    .prepare(
      `SELECT h.*, h.schema_version AS schemaVersion FROM harness_instance_records h
       JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
       WHERE s.sandbox_integration_binding_ref = ? AND h.harness_instance_id = ?`
    )
    .get(sandboxIntegrationBindingRef, harnessInstanceId) as HarnessRow | undefined;
  if (!row) {
    throw new Error('NanoHost Harness is not owned by the current Sandbox Integration.');
  }
  return readRetainedV1(row, () => row);
}

/** Reads a canonical stored JSON object. */
function readJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('NanoHost Harness stored body is invalid.');
  }
  return parsed as Record<string, unknown>;
}

/** Returns stable JSON for bounded flat private envelopes. */
function canonicalJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, item]) => [
          name,
          item && typeof item === 'object' && !Array.isArray(item)
            ? JSON.parse(canonicalJson(item as Record<string, unknown>))
            : item,
        ])
    )
  );
}

/** Returns a lowercase SHA-256 identity. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Digests one session loopback credential over its 43 encoded UTF-8 bytes, the form the
 * collection scan compares against every 43-byte window of the credential alphabet.
 */
export function hashLoopbackCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

/** Writes one immutable binding-time digest copy that survives Sandbox deletion. */
function persistCopiedMeasuredHarnessIdentity(
  coreDb: CoreDb,
  agentSessionRuntimeBindingId: string,
  imageDigest: string,
  timestamp: string
): void {
  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO agent_session_runtime_binding_image_digests (
         agent_session_runtime_binding_id, image_digest, copied_at
       ) VALUES (?, ?, ?)`
    )
    .run(agentSessionRuntimeBindingId, imageDigest, timestamp);
}

/** Reads the live Sandbox digest so the binding can copy it as a value. */
function readSandboxMeasuredImageDigest(coreDb: CoreDb, harnessInstanceId: string): string {
  const sandbox = coreDb.sqlite
    .prepare(
      `SELECT s.image_digest AS imageDigest
       FROM harness_instance_records h
       JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
       WHERE h.harness_instance_id = ?`
    )
    .get(harnessInstanceId) as { readonly imageDigest: string } | undefined;
  if (!sandbox || !/^sha256:[0-9a-f]{64}$/.test(sandbox.imageDigest)) {
    throw new Error('NanoHost measured harness identity is missing at binding time.');
  }
  return sandbox.imageDigest;
}

/** Requires a non-empty bounded opaque identity. */
function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new Error(`NanoHost ${label} is invalid.`);
  }
  return value;
}

/** Requires one lowercase SHA-256 projection. */
function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`NanoHost ${label} is invalid.`);
  }
  return value;
}

/** Requires one canonical 32-byte unpadded base64url route token. */
function requireRouteToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('NanoHost Harness route token is invalid.');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) {
    throw new Error('NanoHost Harness route token is invalid.');
  }
  return value;
}
