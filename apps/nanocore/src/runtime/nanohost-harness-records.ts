import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';

import { bindSchedulerLeaseRouteTokenHashes } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import { hashWorkerRouteToken } from './worker-control-gateway.js';

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
  readonly adapterId: 'codex' | 'opencode' | 'pi';
  readonly harnessInstanceId: string;
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly sequence: number;
  readonly operation: NanoHostHarnessOperation;
  readonly body: Readonly<Record<string, unknown>>;
}

/** One exact private Harness operation result. */
export interface NanoHostHarnessResult {
  readonly harnessInstanceId: string;
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly sequence: number;
  readonly disposition: 'succeeded' | 'refused' | 'unknown';
  readonly body: Readonly<Record<string, unknown>>;
}

/** Input for adding one Harness Instance to a Sandbox runtime projection. */
export interface CreateNanoHostHarnessRuntimeInput {
  readonly adapterId: 'codex' | 'opencode' | 'pi';
  readonly adapterVersion: string;
  readonly harnessBindingRef: string;
  readonly harnessCompatibilityKey: string;
  readonly harnessInstanceId: string;
  readonly imageDigest: string;
  readonly sandboxBindingRef: string;
  readonly sandboxCompatibilityKey: string;
  readonly sandboxIntegrationBindingRef: string;
  readonly sandboxRuntimeId: string;
  readonly runtimeTargetId: string;
  readonly timestamp: string;
}

/** Input for opening one Core AgentSession binding on the current Harness. */
export interface OpenNanoHostAgentSessionBindingInput {
  readonly agentSessionCompatibilityKey: string;
  readonly agentSessionId: string;
  readonly agentSessionRuntimeBindingId: string;
  readonly effectiveSetupGeneration: number;
  readonly harnessInstanceId: string;
  readonly threadId: string;
  readonly timestamp: string;
  readonly workspaceId: string;
}

/** Input for queueing one fixed Harness operation. */
export interface QueueNanoHostHarnessOperationInput {
  readonly body: Readonly<Record<string, unknown>>;
  readonly harnessInstanceId: string;
  readonly operation: NanoHostHarnessOperation;
  readonly timestamp: string;
}

/** Input for dispatching the next exact Harness operation. */
export interface DispatchNanoHostHarnessOperationInput {
  readonly sandboxIntegrationBindingRef: string;
  readonly now?: () => string;
  readonly routeToken?: () => string;
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

/** Input for fencing one Sandbox after destructive cleanup becomes uncertain. */
export interface FenceNanoHostSandboxRuntimeInput {
  readonly harnessBindingRef?: string;
  readonly sandboxBindingRef?: string;
  readonly timestamp: string;
}

/** Exact current-owner inputs for one read-only AgentSession continuity inspection. */
export interface InspectNanoHostAgentSessionContinuityInput {
  readonly admissionAgentSessionId?: string;
  readonly admissionLeaseId?: string;
  readonly agentSessionCompatibilityKey: string;
  readonly agentSessionId: string;
  readonly threadId: string;
  readonly workspaceId: string;
}

/** Durable private binding selected for reuse or exact local close. */
export interface NanoHostAgentSessionContinuityInspection {
  readonly agentSessionId: string;
  readonly agentSessionRuntimeBindingId: string;
  readonly harnessBindingRef: string;
  readonly harnessInstanceId: string;
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
          mode: input.adapterId === 'codex' ? 'session-continuity' : 'bounded-turn',
        },
        sessionCompatibilityKey: input.sessionCompatibilityKey,
        threadId: input.threadId,
      })
    )
    .digest('hex');
}

/** Raw durable Harness row used by checked transitions. */
interface HarnessRow {
  readonly adapter_id: 'codex' | 'opencode' | 'pi';
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
  readonly result_json: string | null;
}

/** Creates the fixed first-slice private Sandbox and Codex Harness projections. */
export function createNanoHostHarnessRuntime(
  coreDb: CoreDb,
  input: CreateNanoHostHarnessRuntimeInput
): void {
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
          readonly runtime_target_id: string;
          readonly sandbox_binding_ref: string;
          readonly sandbox_compatibility_key: string;
          readonly sandbox_integration_binding_ref: string;
        }
      | undefined;
    if (!sandbox) {
      coreDb.sqlite
        .prepare(
          `INSERT INTO sandbox_runtime_records (
             sandbox_runtime_id, runtime_target_id, sandbox_binding_ref,
             sandbox_integration_binding_ref, sandbox_compatibility_key, image_digest,
             environment_class, max_open_sessions, max_harnesses, max_active_turns,
             lifecycle_state, health_state, drain_state, cleanup_state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'shared-worker', 64, 8, 1,
             'open', 'ready', 'accepting', 'clean', ?, ?)`
        )
        .run(
          input.sandboxRuntimeId,
          input.runtimeTargetId,
          input.sandboxBindingRef,
          input.sandboxIntegrationBindingRef,
          input.sandboxCompatibilityKey,
          input.imageDigest,
          input.timestamp,
          input.timestamp
        );
    } else if (
      sandbox.runtime_target_id !== input.runtimeTargetId ||
      sandbox.sandbox_binding_ref !== input.sandboxBindingRef ||
      sandbox.sandbox_integration_binding_ref !== input.sandboxIntegrationBindingRef ||
      sandbox.sandbox_compatibility_key !== input.sandboxCompatibilityKey ||
      sandbox.image_digest !== input.imageDigest
    ) {
      throw new Error('NanoHost retained Sandbox is incompatible with the requested Harness.');
    } else {
      const count = coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM harness_instance_records WHERE sandbox_runtime_id = ?'
        )
        .get(input.sandboxRuntimeId) as { readonly count: number };
      if (count.count >= sandbox.max_harnesses) {
        throw new Error('NanoHost retained Sandbox has no Harness capacity.');
      }
    }
    const mode = input.adapterId === 'codex' ? 'session-continuity' : 'bounded-turn';
    coreDb.sqlite
      .prepare(
        `INSERT INTO harness_instance_records (
           harness_instance_id, sandbox_runtime_id, harness_binding_ref, harness_compatibility_key,
           runtime_family, adapter_id, adapter_version, protocol_version,
           capabilities_json, max_open_sessions, max_active_turns,
           open_session_count, active_turn_count, lifecycle_state, drain_state,
           next_sequence, operation_state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 8, 1, 0, 0, 'open', 'accepting', 0, 'idle', ?, ?)`
      )
      .run(
        input.harnessInstanceId,
        input.sandboxRuntimeId,
        input.harnessBindingRef,
        input.harnessCompatibilityKey,
        input.adapterId,
        input.adapterId,
        input.adapterVersion,
        JSON.stringify([mode]),
        input.timestamp,
        input.timestamp
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
      'SELECT sandbox_runtime_id AS sandboxRuntimeId FROM harness_instance_records WHERE harness_instance_id = ?'
    )
    .get(harnessInstanceId) as { readonly sandboxRuntimeId: string } | undefined;
  if (!row) {
    return;
  }
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
  const hasAdmissionLease = input.admissionLeaseId !== undefined;
  if (hasAdmissionLease !== (input.admissionAgentSessionId !== undefined)) {
    throw new Error('NanoHost AgentSession inspection requires complete admission lease lineage.');
  }
  if (input.admissionLeaseId && input.admissionAgentSessionId) {
    requireIdentity(input.admissionLeaseId, 'Scheduler lease');
    requireIdentity(input.admissionAgentSessionId, 'Admission AgentSession');
    const admissionLease = coreDb.sqlite
      .prepare(
        `SELECT workspace_id AS workspaceId, thread_id AS threadId,
                agent_session_id AS agentSessionId
         FROM scheduler_session_leases
         WHERE lease_id = ?
           AND status NOT IN ('released', 'lost', 'failed')`
      )
      .get(input.admissionLeaseId) as
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
        `SELECT 1 FROM scheduler_session_leases
         WHERE agent_session_id = ?
           AND status NOT IN ('released', 'lost', 'failed')
           AND (? IS NULL OR lease_id <> ?)
         LIMIT 1`
      )
      .get(input.agentSessionId, input.admissionLeaseId ?? null, input.admissionLeaseId ?? null)
  );
  const row = coreDb.sqlite
    .prepare(
      `SELECT b.agent_session_runtime_binding_id AS agentSessionRuntimeBindingId,
              b.workspace_id AS workspaceId, b.thread_id AS threadId,
              b.agent_session_compatibility_key AS agentSessionCompatibilityKey,
              b.native_handle_state AS nativeHandleState,
              b.native_handle_digest AS nativeHandleDigest,
              b.lifecycle_state AS bindingLifecycleState,
              b.current_turn_id AS currentTurnId, b.current_lease_id AS currentLeaseId,
              b.cleanup_state AS bindingCleanupState,
              h.harness_instance_id AS harnessInstanceId,
              h.harness_binding_ref AS harnessBindingRef,
              h.harness_compatibility_key AS harnessCompatibilityKey,
              h.adapter_id AS adapterId,
              h.adapter_version AS adapterVersion,
              h.lifecycle_state AS harnessLifecycleState,
              h.drain_state AS harnessDrainState,
              h.active_turn_count AS activeTurnCount,
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
        readonly activeTurnCount: number;
        readonly adapterId: string;
        readonly adapterVersion: string;
        readonly agentSessionCompatibilityKey: string;
        readonly agentSessionRuntimeBindingId: string;
        readonly bindingCleanupState: string;
        readonly bindingLifecycleState: string;
        readonly currentLeaseId: string | null;
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
  const expectedRuntimeCompatibilityKey = deriveNanoHostAgentSessionCompatibilityKey({
    adapterId: row.adapterId,
    adapterVersion: row.adapterVersion,
    harnessCompatibilityKey: row.harnessCompatibilityKey,
    sessionCompatibilityKey: input.agentSessionCompatibilityKey,
    threadId: input.threadId,
  });
  if (hasActiveLease) {
    throw new Error('NanoHost AgentSession still owns a live scheduler lease.');
  }
  if (
    row.workspaceId !== input.workspaceId ||
    row.threadId !== input.threadId ||
    row.harnessLifecycleState !== 'open' ||
    row.harnessDrainState !== 'accepting' ||
    row.activeTurnCount !== 0 ||
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
    harnessInstanceId: row.harnessInstanceId,
    reusable:
      row.agentSessionCompatibilityKey === expectedRuntimeCompatibilityKey &&
      row.bindingLifecycleState === 'open' &&
      row.bindingCleanupState === 'clean' &&
      row.currentTurnId === null &&
      row.currentLeaseId === null &&
      nativeHandleReady,
  };
}

/** Opens one pending native-conversation binding and consumes only open-session capacity. */
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
           lifecycle_state, current_turn_id, current_lease_id, next_turn_sequence, cleanup_state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'opening', NULL, NULL, 0, 'clean', ?, ?)`
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

/** Queues one fixed typed operation without raw route credentials. */
export function queueNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: QueueNanoHostHarnessOperationInput
): void {
  requireHarnessOperationBody(input.operation, input.body);
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const harness = requireHarness(coreDb, input.harnessInstanceId);
    if (!['idle', 'settled'].includes(harness.operation_state)) {
      throw new Error('NanoHost Harness already has an unsettled operation.');
    }
    if (
      (input.operation === 'session.open' || input.operation === 'turn.start') &&
      (harness.lifecycle_state !== 'open' || harness.drain_state !== 'accepting')
    ) {
      throw new Error('NanoHost Harness is not accepting new work.');
    }
    requireOperationLineage(coreDb, harness, input.operation, input.body);
    const commandBodyJson = canonicalJson(input.body);
    coreDb.sqlite
      .prepare(
        `UPDATE harness_instance_records
         SET operation_state = 'queued', operation_id = NULL,
             operation_sequence = next_sequence, operation = ?, command_body_json = ?,
             command_fingerprint = ?, result_json = NULL, result_fingerprint = NULL,
             updated_at = ?
         WHERE harness_instance_id = ? AND operation_state IN ('idle', 'settled')`
      )
      .run(
        input.operation,
        commandBodyJson,
        sha256(commandBodyJson),
        input.timestamp,
        input.harnessInstanceId
      );
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Dispatches one exact operation once and binds Turn route-token hashes in the same transaction. */
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
        `SELECT * FROM harness_instance_records
         WHERE sandbox_runtime_id = ? AND operation_state = 'queued'
         ORDER BY updated_at, harness_instance_id LIMIT 1`
      )
      .get(integration.sandboxRuntimeId) as HarnessRow | undefined;
    if (!harness) {
      coreDb.sqlite.exec('COMMIT');
      return null;
    }
    if (
      harness.operation_sequence !== harness.next_sequence ||
      !harness.operation ||
      !harness.command_body_json
    ) {
      throw new Error('NanoHost Harness queued operation is incomplete.');
    }
    const body = readJsonObject(harness.command_body_json);
    requireHarnessOperationBody(harness.operation, body);
    let wireBody = body;
    let durableBody = body;
    if (harness.operation === 'turn.start') {
      const token = input.routeToken ?? (() => randomBytes(32).toString('base64url'));
      const workerControlToken = requireRouteToken(token());
      let inferenceToken = requireRouteToken(token());
      while (inferenceToken === workerControlToken) {
        inferenceToken = requireRouteToken(token());
      }
      let capabilityToken = requireRouteToken(token());
      while (capabilityToken === workerControlToken || capabilityToken === inferenceToken) {
        capabilityToken = requireRouteToken(token());
      }
      const leaseId = body.leaseId as string;
      const lease = coreDb.sqlite
        .prepare(
          'SELECT sandbox_binding_ref AS sandboxBindingRef FROM scheduler_session_leases WHERE lease_id = ?'
        )
        .get(leaseId) as { readonly sandboxBindingRef: string } | undefined;
      if (!lease) {
        throw new Error('NanoHost Harness Turn lease is missing.');
      }
      const workerControlTokenHash = hashWorkerRouteToken(workerControlToken);
      const workerInferenceTokenHash = hashWorkerRouteToken(inferenceToken);
      const workerCapabilityTokenHash = hashWorkerRouteToken(capabilityToken);
      bindSchedulerLeaseRouteTokenHashes(coreDb, {
        leaseId,
        ...(input.now ? { now: input.now } : {}),
        sandboxBindingRef: lease.sandboxBindingRef,
        workerCapabilityTokenHash,
        workerControlTokenHash,
        workerInferenceTokenHash,
      });
      durableBody = {
        ...body,
        capabilityTokenHash: workerCapabilityTokenHash,
        inferenceTokenHash: workerInferenceTokenHash,
        workerControlTokenHash,
      };
      wireBody = { ...body, capabilityToken, inferenceToken, workerControlToken };
    }
    const operationId = sha256(
      canonicalJson({
        body: durableBody,
        harnessBindingRef: harness.harness_binding_ref,
        operation: harness.operation,
        sequence: harness.next_sequence,
      })
    );
    const durableBodyJson = canonicalJson(durableBody);
    const update = coreDb.sqlite
      .prepare(
        `UPDATE harness_instance_records
         SET operation_state = 'dispatched', operation_id = ?, command_body_json = ?,
             command_fingerprint = ?, updated_at = ?
         WHERE harness_instance_id = ? AND operation_state = 'queued'
           AND operation_sequence = ? AND next_sequence = ?`
      )
      .run(
        operationId,
        durableBodyJson,
        sha256(durableBodyJson),
        input.now?.() ?? new Date().toISOString(),
        harness.harness_instance_id,
        harness.next_sequence,
        harness.next_sequence
      );
    if (update.changes !== 1) {
      throw new Error('NanoHost Harness operation changed before dispatch.');
    }
    coreDb.sqlite.exec('COMMIT');
    return {
      adapterId: harness.adapter_id,
      body: wireBody,
      harnessInstanceId: harness.harness_instance_id,
      operation: harness.operation,
      operationId,
      schemaVersion: 1,
      sequence: harness.next_sequence,
    };
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Settles one exact operation result or accepts an identical immediate replay. */
export function settleNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: SettleNanoHostHarnessOperationInput
): void {
  const resultJson = canonicalJson(input.result as unknown as Record<string, unknown>);
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const harness = requireHarnessForIntegration(
      coreDb,
      input.sandboxIntegrationBindingRef,
      input.result.harnessInstanceId
    );
    if (harness.operation_state === 'settled') {
      if (
        harness.operation_id === input.result.operationId &&
        harness.operation_sequence === input.result.sequence &&
        harness.result_json === resultJson
      ) {
        coreDb.sqlite.exec('COMMIT');
        return;
      }
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
    requireHarnessResult(harness.operation, input.result);
    if (input.result.disposition === 'unknown') {
      setHarnessUnknown(coreDb, harness.harness_instance_id, input.timestamp);
      coreDb.sqlite.exec('COMMIT');
      return;
    }
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
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
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
  if (harness.operation === 'session.close') {
    const removed = coreDb.sqlite
      .prepare(
        'DELETE FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?'
      )
      .run(bindingId, harness.harness_instance_id);
    if (removed.changes !== 1) {
      throw new Error('NanoHost AgentSession close binding is missing.');
    }
    coreDb.sqlite
      .prepare(
        'UPDATE harness_instance_records SET open_session_count = open_session_count - 1 WHERE harness_instance_id = ? AND open_session_count > 0'
      )
      .run(harness.harness_instance_id);
    return;
  }
  if (harness.operation === 'turn.interrupt') {
    coreDb.sqlite
      .prepare(
        `UPDATE agent_session_runtime_bindings
         SET lifecycle_state = 'open', current_turn_id = NULL, current_lease_id = NULL,
             cleanup_state = 'clean', updated_at = ?
         WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?`
      )
      .run(timestamp, bindingId, harness.harness_instance_id);
    coreDb.sqlite
      .prepare(
        'UPDATE harness_instance_records SET active_turn_count = 0 WHERE harness_instance_id = ?'
      )
      .run(harness.harness_instance_id);
    return;
  }
  const nativeHandleState = body.nativeHandleState;
  const nativeHandleDigest = body.nativeHandleDigest;
  if (harness.operation === 'turn.start') {
    const started = coreDb.sqlite
      .prepare(
        `UPDATE agent_session_runtime_bindings
         SET lifecycle_state = 'active', current_turn_id = ?, current_lease_id = ?,
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
        'UPDATE harness_instance_records SET active_turn_count = 1 WHERE harness_instance_id = ? AND active_turn_count = 0'
      )
      .run(harness.harness_instance_id);
    if (started.changes !== 1 || occupied.changes !== 1) {
      throw new Error('NanoHost Harness active-Turn capacity changed before start settlement.');
    }
    return;
  }
  if (
    harness.operation === 'session.inspect' &&
    body.childState === 'absent' &&
    body.cleanupState === 'clean'
  ) {
    const inspected = coreDb.sqlite
      .prepare(
        `UPDATE agent_session_runtime_bindings
         SET lifecycle_state = ?, current_turn_id = NULL, current_lease_id = NULL,
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
        'UPDATE harness_instance_records SET active_turn_count = 0 WHERE harness_instance_id = ? AND active_turn_count IN (0, 1)'
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
      `SELECT agent_session_id AS agentSessionId, workspace_id AS workspaceId,
              thread_id AS threadId, lifecycle_state AS lifecycleState,
              current_turn_id AS currentTurnId, current_lease_id AS currentLeaseId,
              next_turn_sequence AS nextTurnSequence
       FROM agent_session_runtime_bindings
       WHERE agent_session_runtime_binding_id = ? AND harness_instance_id = ?`
    )
    .get(body.agentSessionRuntimeBindingId, harness.harness_instance_id) as
    | {
        readonly agentSessionId: string;
        readonly currentLeaseId: string | null;
        readonly currentTurnId: string | null;
        readonly workspaceId: string;
        readonly threadId: string;
        readonly lifecycleState: string;
        readonly nextTurnSequence: number;
      }
    | undefined;
  if (!binding || binding.agentSessionId !== body.agentSessionId) {
    throw new Error('NanoHost Harness AgentSession binding lineage conflicts.');
  }
  if (operation === 'turn.interrupt') {
    if (
      harness.active_turn_count !== 1 ||
      binding.lifecycleState !== 'active' ||
      binding.currentTurnId !== body.turnId ||
      binding.currentLeaseId !== body.leaseId
    ) {
      throw new Error('NanoHost Harness interrupt conflicts with the active Turn binding.');
    }
    const lease = coreDb.sqlite
      .prepare(
        `SELECT workspace_id AS workspaceId, thread_id AS threadId, turn_id AS turnId,
                agent_session_id AS agentSessionId, package_snapshot_id AS packageSnapshotId,
                status
         FROM scheduler_session_leases WHERE lease_id = ?`
      )
      .get(body.leaseId) as
      | {
          readonly agentSessionId: string;
          readonly packageSnapshotId: string;
          readonly status: string;
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
            lease.packageSnapshotId
          )
      : null;
    const activeTurnStart =
      harness.operation === 'turn.start' && harness.command_body_json
        ? readJsonObject(harness.command_body_json)
        : null;
    if (
      !lease ||
      !['acquired', 'starting', 'active', 'idle'].includes(lease.status) ||
      lease.workspaceId !== binding.workspaceId ||
      lease.threadId !== binding.threadId ||
      lease.turnId !== body.turnId ||
      lease.agentSessionId !== body.agentSessionId ||
      activeTurnStart?.packageSnapshotId !== lease.packageSnapshotId ||
      acceptedFinal
    ) {
      throw new Error('NanoHost Harness interrupt conflicts with the live lease lineage.');
    }
    return;
  }
  if (operation !== 'turn.start') {
    return;
  }
  if (
    harness.active_turn_count !== 0 ||
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
              agent_session_id AS agentSessionId, package_snapshot_id AS packageSnapshotId,
              status
       FROM scheduler_session_leases WHERE lease_id = ?`
    )
    .get(body.leaseId) as
    | {
        readonly workspaceId: string;
        readonly threadId: string;
        readonly turnId: string;
        readonly agentSessionId: string;
        readonly packageSnapshotId: string;
        readonly status: string;
      }
    | undefined;
  if (
    !lease ||
    !['acquired', 'starting', 'active', 'idle'].includes(lease.status) ||
    lease.workspaceId !== body.workspaceId ||
    lease.threadId !== body.threadId ||
    lease.turnId !== body.turnId ||
    lease.agentSessionId !== body.agentSessionId ||
    lease.packageSnapshotId !== body.packageSnapshotId
  ) {
    throw new Error('NanoHost Harness Turn lease lineage conflicts.');
  }
}

/** Validates the closed command-body field set and scalar shapes for one operation. */
function requireHarnessOperationBody(
  operation: NanoHostHarnessOperation,
  body: Readonly<Record<string, unknown>>
): void {
  const fields: Record<NanoHostHarnessOperation, readonly string[]> = {
    'session.open': [
      'adapterId',
      'agentSessionCompatibilityKey',
      'agentSessionId',
      'agentSessionRuntimeBindingId',
      'effectiveSetupGeneration',
      'threadId',
      'workspaceId',
    ],
    'session.inspect': ['agentSessionId', 'agentSessionRuntimeBindingId'],
    'turn.start': [
      'aepRef',
      'agentSessionId',
      'agentSessionRuntimeBindingId',
      'contextPackageId',
      'contextRef',
      'deadline',
      'leaseId',
      'packageSnapshotId',
      'threadId',
      'turnId',
      'turnSequence',
      'workspaceId',
    ],
    'turn.interrupt': [
      'agentSessionId',
      'agentSessionRuntimeBindingId',
      'leaseId',
      'purpose',
      'turnId',
    ],
    'session.close': ['agentSessionId', 'agentSessionRuntimeBindingId'],
    'harness.drain': [],
  };
  requireExactFields(body, fields[operation], `${operation} command body`);
  for (const [name, value] of Object.entries(body)) {
    if (name === 'effectiveSetupGeneration' || name === 'turnSequence') {
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`NanoHost Harness ${name} is invalid.`);
      }
      continue;
    }
    requireIdentity(value, `Harness ${name}`);
  }
  if (operation === 'session.open') {
    requireSha256(body.agentSessionCompatibilityKey, 'AgentSession compatibility key');
    if (
      !['codex', 'opencode', 'pi'].includes(body.adapterId as string) ||
      (body.effectiveSetupGeneration as number) < 1
    ) {
      throw new Error('NanoHost Harness session.open adapter or setup generation is unsupported.');
    }
  }
  if (
    operation === 'turn.interrupt' &&
    body.purpose !== 'interrupt' &&
    body.purpose !== 'human-gate'
  ) {
    throw new Error('NanoHost Harness turn.interrupt purpose is unsupported.');
  }
}

/** Validates one exact result envelope and its operation-specific body. */
function requireHarnessResult(
  operation: NanoHostHarnessOperation,
  result: NanoHostHarnessResult
): void {
  requireExactFields(
    result as unknown as Record<string, unknown>,
    ['body', 'disposition', 'harnessInstanceId', 'operationId', 'schemaVersion', 'sequence'],
    'Harness result'
  );
  if (
    result.schemaVersion !== 1 ||
    !Number.isSafeInteger(result.sequence) ||
    result.sequence < 0 ||
    !['succeeded', 'refused', 'unknown'].includes(result.disposition)
  ) {
    throw new Error('NanoHost Harness result envelope is invalid.');
  }
  requireSha256(result.operationId, 'Harness operation id');
  requireIdentity(result.harnessInstanceId, 'Harness');
  if (result.disposition === 'unknown') {
    requireExactFields(result.body, ['reasonCode'], 'unknown result body');
    if (result.body.reasonCode !== 'outcome_unknown') {
      throw new Error('NanoHost Harness unknown result reason is invalid.');
    }
    return;
  }
  if (result.disposition === 'refused') {
    requireExactFields(result.body, ['reasonCode'], 'refused result body');
    if (
      ![
        'missing',
        'stale',
        'conflict',
        'unsupported',
        'busy',
        'dependency_failed',
        'cleanup_required',
      ].includes(result.body.reasonCode as string)
    ) {
      throw new Error('NanoHost Harness refusal reason is invalid.');
    }
    return;
  }
  const fields: Record<NanoHostHarnessOperation, readonly string[]> = {
    'session.open': ['maxActiveTurns', 'nativeHandleDigest', 'nativeHandleState', 'state'],
    'session.inspect': [
      'childState',
      'cleanupState',
      'nativeHandleDigest',
      'nativeHandleState',
      'state',
    ],
    'turn.start': ['nativeHandleDigest', 'nativeHandleState', 'state'],
    'turn.interrupt': ['childState', 'state'],
    'session.close': ['childState', 'privateState', 'state'],
    'harness.drain': ['activeTurns', 'openSessions', 'state'],
  };
  requireExactFields(result.body, fields[operation], `${operation} success body`);
  if (
    operation === 'session.open' &&
    (result.body.state !== 'open' || result.body.maxActiveTurns !== 1)
  ) {
    throw new Error('NanoHost Harness session.open success is invalid.');
  }
  if (operation === 'turn.start' && result.body.state !== 'started') {
    throw new Error('NanoHost Harness turn.start success is invalid.');
  }
  if (
    operation === 'turn.interrupt' &&
    (result.body.state !== 'interrupted' || result.body.childState !== 'absent')
  ) {
    throw new Error('NanoHost Harness turn.interrupt success is invalid.');
  }
  if (operation === 'turn.interrupt') {
    return;
  }
  if (
    operation === 'session.close' &&
    (result.body.state !== 'closed' ||
      result.body.childState !== 'absent' ||
      result.body.privateState !== 'absent')
  ) {
    throw new Error('NanoHost Harness session.close success is invalid.');
  }
  if (operation === 'session.close') {
    return;
  }
  if (operation === 'harness.drain') {
    if (
      result.body.state !== 'draining' ||
      !Number.isSafeInteger(result.body.openSessions) ||
      !Number.isSafeInteger(result.body.activeTurns) ||
      (result.body.openSessions as number) < 0 ||
      (result.body.activeTurns as number) < 0
    ) {
      throw new Error('NanoHost Harness drain success is invalid.');
    }
    return;
  }
  if (operation === 'session.inspect') {
    if (
      !['open', 'active', 'closing', 'closed', 'failed'].includes(result.body.state as string) ||
      !['absent', 'running', 'stopping', 'unknown'].includes(result.body.childState as string) ||
      !['clean', 'pending', 'unknown'].includes(result.body.cleanupState as string)
    ) {
      throw new Error('NanoHost Harness session.inspect success is invalid.');
    }
  }
  requireNativeHandle(result.body);
}

/** Validates the nullable native-handle state/digest pair. */
function requireNativeHandle(body: Readonly<Record<string, unknown>>): void {
  if (!['pending', 'ready', 'absent', 'unknown'].includes(body.nativeHandleState as string)) {
    throw new Error('NanoHost Harness native handle state is invalid.');
  }
  if (body.nativeHandleState === 'ready') {
    requireSha256(body.nativeHandleDigest, 'Native handle digest');
    return;
  }
  if (body.nativeHandleDigest !== null) {
    throw new Error('NanoHost Harness non-ready native handle digest must be null.');
  }
}

/** Widens uncertain execution to the existing Harness admission fence. */
function setHarnessUnknown(coreDb: CoreDb, harnessInstanceId: string, timestamp: string): void {
  const update = coreDb.sqlite
    .prepare(
      `UPDATE harness_instance_records
       SET operation_state = 'unknown', lifecycle_state = 'failed',
           drain_state = 'draining', updated_at = ?
       WHERE harness_instance_id = ? AND operation_state = 'dispatched'`
    )
    .run(timestamp, harnessInstanceId);
  if (update.changes !== 1) {
    throw new Error('NanoHost Harness unknown cleanup transition changed concurrently.');
  }
  const harness = requireHarness(coreDb, harnessInstanceId);
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
    .prepare('SELECT * FROM harness_instance_records WHERE harness_instance_id = ?')
    .get(harnessInstanceId) as HarnessRow | undefined;
  if (!row) {
    throw new Error('NanoHost Harness is missing.');
  }
  return row;
}

/** Reads one Harness by the current private bridge binding. */
function requireHarnessByBinding(coreDb: CoreDb, harnessBindingRef: string): HarnessRow {
  requireIdentity(harnessBindingRef, 'Harness binding');
  const row = coreDb.sqlite
    .prepare('SELECT * FROM harness_instance_records WHERE harness_binding_ref = ?')
    .get(harnessBindingRef) as HarnessRow | undefined;
  if (!row) {
    throw new Error('NanoHost Harness binding is missing or stale.');
  }
  return row;
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
      `SELECT h.* FROM harness_instance_records h
       JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
       WHERE s.sandbox_integration_binding_ref = ? AND h.harness_instance_id = ?`
    )
    .get(sandboxIntegrationBindingRef, harnessInstanceId) as HarnessRow | undefined;
  if (!row) {
    throw new Error('NanoHost Harness is not owned by the current Sandbox Integration.');
  }
  return row;
}

/** Requires an exact object field set. */
function requireExactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`NanoHost ${label} fields are invalid.`);
  }
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
