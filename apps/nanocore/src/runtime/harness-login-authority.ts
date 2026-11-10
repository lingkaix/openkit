import { readRetainedV1 } from '@openkit/protocol';
import type { CoreDb } from '../storage/db.js';
import { resolveNanoHostAttemptTokenBinding } from './nanohost-attempt-records.js';
import { getNanoHostRuntimeTarget } from './nanohost-runtime-target.js';

/** Original private consumer coordinates, never a permission decision or Worker account hint. */
export interface HarnessLoginContext {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly agentSessionId: string;
  readonly agentSessionRuntimeBindingId: string;
  readonly packageSnapshotId: string;
  readonly turnId: string;
  readonly leaseId: string;
  readonly turnSequence: number;
  readonly runtimeTargetId: string;
  readonly physicalEpoch: string;
  readonly connectionGeneration: number;
}

/**
 * Joins the original pending native start or live Turn to its current physical Sandbox.
 * The pending branch is necessary before native activation can acknowledge turn.start.
 * @returns The canonical Integration binding, for comparison with the trusted transport carriage.
 * @throws On changed, closed, ambiguous, expired or foreign execution authority.
 */
export function requireHarnessLoginBinding(
  coreDb: CoreDb,
  input: HarnessLoginContext,
  now: string
): string {
  const row = coreDb.sqlite
    .prepare(`SELECT b.schema_version AS schemaVersion,
    h.schema_version AS harnessVersion, s.schema_version AS sandboxVersion,
    b.agent_session_id AS agentSessionId, b.workspace_id AS workspaceId, b.thread_id AS threadId,
    b.lifecycle_state AS bindingState, b.current_turn_id AS turnId, b.current_attempt_id AS leaseId,
    b.next_turn_sequence AS nextSequence, b.cleanup_state AS bindingCleanup,
    h.lifecycle_state AS harnessState, h.drain_state AS harnessDrain,
    h.operation_state AS operationState, h.operation, h.command_body_json AS command,
    s.sandbox_binding_ref AS sandboxBindingRef, s.sandbox_integration_binding_ref AS integrationRef,
    s.runtime_target_id AS targetId, s.origin_physical_epoch AS physicalEpoch,
    s.lifecycle_state AS sandboxState, s.health_state AS sandboxHealth,
    s.drain_state AS sandboxDrain, s.cleanup_state AS sandboxCleanup
    FROM agent_session_runtime_bindings b
    JOIN harness_instance_records h ON h.harness_instance_id=b.harness_instance_id
    JOIN sandbox_runtime_records s ON s.sandbox_runtime_id=h.sandbox_runtime_id
    WHERE b.agent_session_runtime_binding_id=?`)
    .get(input.agentSessionRuntimeBindingId) as
    | {
        schemaVersion: number;
        harnessVersion: number;
        sandboxVersion: number;
        agentSessionId: string;
        workspaceId: string;
        threadId: string;
        bindingState: string;
        turnId: string | null;
        leaseId: string | null;
        nextSequence: number;
        bindingCleanup: string;
        harnessState: string;
        harnessDrain: string;
        operationState: string;
        operation: string | null;
        command: string | null;
        sandboxBindingRef: string;
        integrationRef: string;
        targetId: string;
        physicalEpoch: string;
        sandboxState: string;
        sandboxHealth: string;
        sandboxDrain: string;
        sandboxCleanup: string;
      }
    | undefined;
  const refuse = (): never => {
    throw new Error('Native Login consumer binding is unavailable.');
  };
  if (!row) return refuse();
  for (const schemaVersion of [row.schemaVersion, row.harnessVersion, row.sandboxVersion])
    readRetainedV1({ schemaVersion }, () => null);
  const resolution = resolveNanoHostAttemptTokenBinding(coreDb, {
    sandboxBindingRef: row.sandboxBindingRef,
    lineage: input,
    now: () => now,
  });
  if (resolution.status !== 'accepted' || resolution.attempt.attemptId !== input.leaseId)
    return refuse();
  const attempt = resolution.attempt;
  const target = getNanoHostRuntimeTarget(coreDb, row.targetId);
  if (
    row.agentSessionId !== input.agentSessionId ||
    row.workspaceId !== input.workspaceId ||
    row.threadId !== input.threadId ||
    row.harnessState !== 'open' ||
    row.harnessDrain !== 'accepting' ||
    row.bindingCleanup !== 'clean' ||
    row.sandboxState !== 'open' ||
    row.sandboxHealth !== 'ready' ||
    row.sandboxDrain !== 'accepting' ||
    row.sandboxCleanup !== 'clean' ||
    row.targetId !== input.runtimeTargetId ||
    row.physicalEpoch !== input.physicalEpoch ||
    !target?.ready ||
    !target.predecessorFenced ||
    !target.freshEmpty ||
    target.physicalEpoch !== input.physicalEpoch ||
    target.connectionGeneration !== input.connectionGeneration ||
    attempt.phase !== 'open' ||
    attempt.agentSessionId !== input.agentSessionId ||
    attempt.inputRef !== input.packageSnapshotId ||
    attempt.bindingRef !== row.sandboxBindingRef ||
    (attempt.deadline !== null && attempt.deadline <= now)
  )
    return refuse();
  if (
    row.bindingState === 'active' &&
    row.turnId === input.turnId &&
    row.leaseId === input.leaseId &&
    row.nextSequence === input.turnSequence + 1
  )
    return row.integrationRef;
  if (
    !['open', 'opening'].includes(row.bindingState) ||
    row.operation !== 'turn.start' ||
    row.operationState !== 'dispatched' ||
    row.nextSequence !== input.turnSequence ||
    row.turnId !== null ||
    row.leaseId !== null ||
    !row.command
  )
    return refuse();
  const command: unknown = JSON.parse(row.command);
  if (!command || typeof command !== 'object' || Array.isArray(command)) return refuse();
  for (const [key, expected] of Object.entries({
    agentSessionId: input.agentSessionId,
    agentSessionRuntimeBindingId: input.agentSessionRuntimeBindingId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    leaseId: input.leaseId,
    packageSnapshotId: input.packageSnapshotId,
    turnSequence: input.turnSequence,
  }))
    if (Reflect.get(command, key) !== expected) return refuse();
  return row.integrationRef;
}
