import { isDeepStrictEqual } from 'node:util';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { readRetainedV1 } from '@openkit/protocol';
import { z } from 'zod';
import { OperationError } from '../operation-error.js';
import { openControlStoreProductReadHandle } from '../storage/control-store-product-records.js';
import { bindWorkspaceSqlite, type CoreDb } from '../storage/db.js';
import {
  HarnessLoginContextSchema,
  HarnessLoginNativeEffectSchema,
  HarnessLoginObservationsSchema,
} from '../storage/vault-native-codecs.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { resolveNanoHostAttemptTokenBinding } from './nanohost-attempt-records.js';
import { getNanoHostRuntimeTarget } from './nanohost-runtime-target.js';
import type { NanoHostHarnessLoginPhysical } from './nanohost-session-dispatch.js';
import type { WorkerControlGateway } from './worker-control-gateway.js';

const privateLoginLineage = HarnessLoginContextSchema.omit({
  runtimeTargetId: true,
  physicalEpoch: true,
  connectionGeneration: true,
});
const privateLoginReceipt = {
  receiptId: HarnessLoginNativeEffectSchema.shape.receiptId,
  materialGeneration: HarnessLoginNativeEffectSchema.shape.materialGeneration,
};
const privateLoginRequest = z.discriminatedUnion('kind', [
  privateLoginLineage.extend({
    kind: z.literal('acquire'),
    reason: z.enum(['activate', 'refresh']),
  }),
  privateLoginLineage.extend({ kind: z.literal('complete'), ...privateLoginReceipt }),
  privateLoginLineage.extend({
    kind: z.literal('observe'),
    ...privateLoginReceipt,
    observation: HarnessLoginObservationsSchema.omit({
      observedAt: true,
      bindingId: true,
      materialGeneration: true,
    }),
  }),
]);

/** Reads only the existing bounded private carriage; malformed input never enters diagnostics. */
async function readPrivateLoginRequest(request: Request) {
  const invalid = () =>
    new OperationError('invalid_request', 'Native Login request is invalid.', 400);
  if (
    request.method !== 'POST' ||
    new URL(request.url).pathname !== '/worker-control/harness/login'
  )
    throw invalid();
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (request.signal.aborted) {
      cancel();
      throw invalid();
    }
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) {
        cancel();
        throw new OperationError(
          'worker_control_payload_too_large',
          'Native Login request exceeds its private carriage bound.',
          413
        );
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw invalid();
  } finally {
    request.signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  if (request.signal.aborted) throw invalid();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw invalid();
  }
  const parsed = privateLoginRequest.safeParse(body);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

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
 * Authenticates the private Login carriage against its immutable package and current native binding.
 * This grants no Vault use permission and performs no lifecycle effect. Callers must repeat the
 * returned check after waits, then enter the existing governed Vault operation before material use.
 * @param input Actual control gateway, trusted adapter facts and original private HTTP request.
 * @returns Canonical package, closed request, native context and a current-authority check.
 * @throws When token family, retained package, consumer, physical authority or request facts disagree.
 */
export async function authenticateHarnessLoginRequest(input: {
  readonly coreDb: CoreDb;
  readonly gateway: WorkerControlGateway;
  readonly physical: NanoHostHarnessLoginPhysical;
  readonly request: Request;
  readonly now?: () => string;
}) {
  const authorization = input.request.headers.get('authorization');
  const unavailable = (): never => {
    throw new OperationError(
      'worker_login_unavailable',
      'Native Login request is unavailable.',
      403
    );
  };
  const readCurrentPackage = () => {
    if (input.request.signal.aborted) return unavailable();
    input.physical.assertCurrent();
    const authenticated = input.gateway.authenticatePackageToken(authorization, {
      tokenFamily: 'worker-control',
    });
    const scope = nativeProductScope(input.coreDb.dataRoot, {
      kind: 'workspace',
      workspaceId: authenticated.scope.workspaceId,
    });
    let reader: ReturnType<typeof openControlStoreProductReadHandle> | undefined;
    try {
      // Authentication reads an existing owner only; a missing scope must never be provisioned.
      reader = openControlStoreProductReadHandle(scope.path, scope.owner);
      if (!reader.get('workspace', authenticated.scope.workspaceId)) return unavailable();
      const db = bindWorkspaceSqlite(
        reader.sqlite,
        input.coreDb.dataRoot,
        authenticated.scope.workspaceId
      );
      const retained = requireAgentEnvironmentPackageSnapshot(
        db,
        authenticated.scope.workspaceId,
        authenticated.snapshotId
      );
      const environmentPackage = AgentEnvironmentPackageSchema.parse(retained.snapshot);
      if (
        !isDeepStrictEqual(authenticated, environmentPackage) ||
        environmentPackage.llm.mode !== 'harness' ||
        !environmentPackage.credentials.declarations.some(
          (declaration) =>
            declaration.visibility === 'runtime-token' && declaration.consumer === 'codex-login'
        )
      )
        return unavailable();
      return { environmentPackage, contentDigest: retained.contentDigest };
    } catch {
      return unavailable();
    } finally {
      reader?.close();
    }
  };
  const original = readCurrentPackage();
  const request = await readPrivateLoginRequest(input.request);
  const parsedContext = HarnessLoginContextSchema.safeParse({
    workspaceId: request.workspaceId,
    threadId: request.threadId,
    agentSessionId: request.agentSessionId,
    agentSessionRuntimeBindingId: request.agentSessionRuntimeBindingId,
    packageSnapshotId: request.packageSnapshotId,
    turnId: request.turnId,
    leaseId: request.leaseId,
    turnSequence: request.turnSequence,
    runtimeTargetId: input.physical.runtimeTargetId,
    physicalEpoch: input.physical.physicalEpoch,
    connectionGeneration: input.physical.connectionGeneration,
  });
  if (!parsedContext.success) return unavailable();
  const context = Object.freeze(parsedContext.data);
  const recheck = () => {
    const current = readCurrentPackage();
    const pkg = current.environmentPackage;
    if (
      current.contentDigest !== original.contentDigest ||
      pkg.snapshotId !== context.packageSnapshotId ||
      pkg.scope.workspaceId !== context.workspaceId ||
      pkg.scope.threadId !== context.threadId ||
      pkg.scope.turnId !== context.turnId ||
      pkg.scope.agentSessionId !== context.agentSessionId
    )
      return unavailable();
    requireHarnessLoginBinding(input.coreDb, context, input.now?.() ?? new Date().toISOString());
  };
  recheck();
  return { environmentPackage: original.environmentPackage, context, request, recheck };
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
    h.schema_version AS harnessVersion,
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
  for (const schemaVersion of [row.schemaVersion, row.harnessVersion])
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
