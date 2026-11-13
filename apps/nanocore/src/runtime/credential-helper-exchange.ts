import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import {
  credentialHelperComparisonValues,
  WORKER_CREDENTIAL_HELPER_BODY_MAX_BYTES,
  WorkerCredentialHelperCommandSchema,
  type WorkerCredentialHelperReply,
  type WorkerLineage,
  WorkerLineageSchema,
} from '@openkit/worker-protocol';
import { z } from 'zod';
import { asApiError } from '../api-errors.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import { OperationError } from '../operation-error.js';
import { createOperationEngine } from '../operation-invocation.js';
import { getVaultInjectionPlan } from '../storage/vault-native-codecs.js';
import {
  assertCredentialHelperTarget,
  performCredentialHelperUse,
} from '../vault/credential-helper-use.js';
import { createVaultOperationImplementations } from '../vault/vault-operation-implementations.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { type WorkerControlGateway, WorkerControlGatewayError } from './worker-control-gateway.js';
import { assertCurrentWorkerCredentialAuthority } from './worker-credential-authority.js';

const requestSchema = z
  .object({
    lineage: WorkerLineageSchema,
    declarationId: z.string().min(1),
    request: WorkerCredentialHelperCommandSchema,
  })
  .strict();

/** Read one bounded request; no parser error can echo request bytes into diagnostics. */
async function readHelperRequest(request: Request): Promise<z.infer<typeof requestSchema>> {
  const invalid = () =>
    new OperationError('invalid_request', 'Credential helper request is invalid.', 400);
  if (
    request.method !== 'POST' ||
    new URL(request.url).pathname !== '/api/worker-control/credential-helper'
  )
    throw invalid();
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const encoded = Buffer.allocUnsafe(WORKER_CREDENTIAL_HELPER_BODY_MAX_BYTES);
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    request.signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > encoded.byteLength - length) {
        cancel();
        throw new OperationError(
          'worker_control_payload_too_large',
          'Credential helper request is too large.',
          413
        );
      }
      encoded.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    request.signal.throwIfAborted();
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw invalid();
  } finally {
    request.signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, length))
    );
  } catch {
    throw invalid();
  }
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/**
 * Compose the one private helper consumer over the existing worker-control token and Vault operation owners.
 * There is no NanoHost assumption, separate listener, material cache or Worker-selected Vault reference.
 * @param input Existing App operation dependencies and actual durable worker-control gateway.
 * @returns Request handler whose private response is released only after fresh governed use and its evidence.
 */
export function createCredentialHelperHandler(input: {
  readonly operations: OperationInvocationDependencies;
  readonly gateway: WorkerControlGateway;
  /** Native App composition supplies the actual comparison owner; dormant Core-use tests omit it. */
  readonly registerCredentialValues?: (
    lineage: WorkerLineage,
    receiptId: string,
    values: readonly string[]
  ) => void;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const { operations, gateway } = input;
    const unavailable = (): never => {
      throw new OperationError('credential_helper_unavailable', 'Credential unavailable.', 403);
    };
    try {
      const coreDb = operations.coreDb;
      const workspaceDb = operations.repositoryWorkspaceDb;
      const vault = operations.vaultUnlockState;
      if (
        !coreDb ||
        !workspaceDb ||
        !operations.store ||
        !vault ||
        !operations.workspaceMutationAdmission ||
        (!operations.readRuntimePolicy && !operations.runtimeConfigManager)
      )
        throw new OperationError(
          'credential_helper_unavailable',
          'Credential helper is unavailable.',
          503
        );
      const authorization = request.headers.get('authorization');
      // Refuse unknown or retired tokens before collecting any private request body.
      gateway.authenticatePackageToken(authorization, { tokenFamily: 'worker-control' });
      const command = await readHelperRequest(request);
      const currentPackage = () => {
        request.signal.throwIfAborted();
        const authenticated = gateway.authenticatePackageRequest({
          authorization,
          tokenFamily: 'worker-control',
          lineage: command.lineage,
        });
        if (!authenticated.scope.workspaceId) return unavailable();
        operations.store!.getWorkspace(authenticated.scope.workspaceId);
        const db = workspaceDb(authenticated.scope.workspaceId);
        try {
          const canonical = AgentEnvironmentPackageSchema.parse(
            requireAgentEnvironmentPackageSnapshot(
              db,
              authenticated.scope.workspaceId,
              authenticated.snapshotId
            ).snapshot
          );
          if (!isDeepStrictEqual(canonical, authenticated)) return unavailable();
          return canonical;
        } finally {
          db.sqlite.close();
        }
      };
      const original = currentPackage();
      const declarations = original.credentials.declarations.filter(
        (value) => value.id === command.declarationId
      );
      const declaration = declarations.length === 1 ? declarations[0] : undefined;
      if (!declaration) return unavailable();
      assertCredentialHelperTarget(declaration, command.request);
      const planId = `plan_${original.snapshotId}_${declaration.id}`;
      const current = () => {
        const pkg = currentPackage();
        if (!isDeepStrictEqual(pkg, original)) return unavailable();
        const authority = assertCurrentWorkerCredentialAuthority(
          coreDb,
          pkg,
          () => new Date().toISOString(),
          declaration
        );
        const plan = getVaultInjectionPlan(coreDb, planId);
        if (
          !plan ||
          plan.status !== 'active' ||
          plan.packageSnapshotId !== original.snapshotId ||
          plan.grantId !== authority.grant.grantId ||
          plan.injectionVisibility !== declaration.visibility
        )
          return unavailable();
        return authority;
      };
      const selected = current();
      const check = async () => {
        const value = current();
        if (
          value.reference.currentVersion !== selected.reference.currentVersion ||
          value.reference.referenceId !== selected.reference.referenceId
        )
          unavailable();
      };
      const requestId = randomUUID();
      const receiptId = `receipt_${requestId}`;
      let reply: WorkerCredentialHelperReply | undefined;
      const invoke = createOperationEngine(
        createVaultOperationImplementations({
          ...operations,
          credentialHelperUse: {
            declarationId: declaration.id,
            command: command.request,
            run: async (effect) => {
              const result = await performCredentialHelperUse(
                effect,
                vault.backend(),
                command.request
              );
              reply = result.reply;
              return result.receipt;
            },
          },
        }),
        operations
      );
      const receipt = await invoke(
        'vault.binding-deliver',
        {
          workspaceId: original.scope.workspaceId!,
          bindingThreadId: original.scope.threadId,
          planId,
          requestId,
          receiptId,
          materialVersion: selected.reference.currentVersion,
        },
        {
          kind: 'worker',
          actor: original.scope.triggerActor,
          lineage: {
            workspaceId: original.scope.workspaceId!,
            threadId: original.scope.threadId,
            turnId: command.lineage.turnId,
            agentSessionId: original.scope.agentSessionId,
            packageSnapshotId: original.snapshotId,
          },
          requestId,
          bindings: { workspaceId: original.scope.workspaceId!, requestId },
          signal: request.signal,
          recheckEntry: check,
        }
      );
      await check();
      if (!reply || receipt.receiptId !== receiptId) return unavailable();
      if ('credential' in reply && input.registerCredentialValues) {
        input.registerCredentialValues(
          command.lineage,
          receiptId,
          credentialHelperComparisonValues(command.request, reply)
        );
        await check();
      }
      return Response.json(reply, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      const status =
        error instanceof OperationError || error instanceof WorkerControlGatewayError
          ? error.status
          : 500;
      const code =
        error instanceof OperationError || error instanceof WorkerControlGatewayError
          ? error.code
          : 'credential_helper_unavailable';
      const response = asApiError('Credential unavailable.', code, status);
      response.headers.set('cache-control', 'no-store');
      return response;
    }
  };
}
