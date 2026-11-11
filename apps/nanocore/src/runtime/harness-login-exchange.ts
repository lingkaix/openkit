import { randomUUID } from 'node:crypto';
import { isEntityId } from '@openkit/protocol';
import { asApiError } from '../api-errors.js';
import type { FsStore } from '../lib/store.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import { OperationError } from '../operation-error.js';
import { createOperationEngine } from '../operation-invocation.js';
import { readProduct } from '../storage/control-store-product-records.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  type NativeThreadLogin,
  NativeThreadLoginSchema,
  nextNativeThreadLogin,
} from '../storage/native-thread-login.js';
import { getVaultInjectionPlan } from '../storage/vault-native-codecs.js';
import { hasCurrentHarnessLoginExhaustion } from '../vault/login-selection.js';
import { createVaultOperationImplementations } from '../vault/vault-operation-implementations.js';
import { authenticateHarnessLoginRequest } from './harness-login-authority.js';
import type { NanoHostHarnessLoginHandler } from './nanohost-session-dispatch.js';
import type { ConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import type { WorkerControlGateway } from './worker-control-gateway.js';
import {
  requireDeclarationGrant,
  requireDeclarationReference,
} from './worker-credential-authority.js';

/**
 * Composes governed Login access, completion and bounded native observations.
 * This factory installs no route or capability. Replacement remains unavailable.
 * @param input Actual Core, operation, transport and configured placement owners.
 * @returns An uninstalled private handler that acknowledges completion only after receipt and affinity.
 */
export function createHarnessLoginExchange(input: {
  readonly operations: OperationInvocationDependencies & {
    readonly coreDb: CoreDb;
    readonly store: FsStore;
    readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  };
  readonly gateway: WorkerControlGateway;
  readonly runtime: ConfiguredWorkerLifecycleRuntime;
}): NanoHostHarnessLoginHandler {
  const dependencies = { ...input.operations, turnExecutor: input.runtime.turnExecutor };
  const invoke = createOperationEngine(
    createVaultOperationImplementations(dependencies),
    dependencies
  );
  const unavailable = () =>
    new OperationError('worker_login_unavailable', 'Native Login lifecycle is unavailable.', 409);

  return async (request, physical) => {
    try {
      const authenticated = await authenticateHarnessLoginRequest({
        coreDb: dependencies.coreDb,
        gateway: input.gateway,
        physical,
        request,
      });
      const { context, environmentPackage, request: command } = authenticated;
      let checkSelection: (() => void) | undefined;
      const currentCheck = async () => {
        authenticated.recheck();
        checkSelection?.();
      };
      if (command.kind === 'complete') {
        await input.runtime.completeHarnessLogin(
          context,
          command.receiptId,
          command.materialGeneration,
          request.signal,
          currentCheck
        );
        authenticated.recheck();
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      }
      // The private body selects neither a declaration nor a Vault family.
      const declarations = environmentPackage.credentials.declarations.filter(
        (declaration) =>
          declaration.visibility === 'runtime-token' && declaration.consumer === 'codex-login'
      );
      const declaration = declarations.length === 1 ? declarations[0] : undefined;
      if (!declaration) throw unavailable();
      const grant = requireDeclarationGrant(dependencies.coreDb, declaration);
      const reference = requireDeclarationReference(dependencies.coreDb, grant);
      const referenceId = reference.referenceId;
      if (!isEntityId('vault', referenceId)) throw unavailable();
      const planId = `plan_${environmentPackage.snapshotId}_${declaration.id}`;
      const plan = getVaultInjectionPlan(dependencies.coreDb, planId);
      if (
        !plan ||
        plan.packageSnapshotId !== environmentPackage.snapshotId ||
        plan.grantId !== grant.grantId ||
        plan.injectionVisibility !== 'runtime-token'
      )
        throw unavailable();

      const readAffinity = (): NativeThreadLogin | undefined => {
        const db = dependencies.repositoryWorkspaceDb(context.workspaceId);
        try {
          const thread = readProduct(
            db.sqlite,
            { kind: 'workspace', workspaceId: context.workspaceId },
            'thread',
            context.threadId
          );
          if (!thread) throw unavailable();
          return thread.record.login === undefined
            ? undefined
            : NativeThreadLoginSchema.parse(thread.record.login);
        } finally {
          db.sqlite.close();
        }
      };
      if (command.kind === 'observe') {
        const accountId = reference.login?.accountId;
        if (!accountId || command.materialGeneration !== reference.currentVersion)
          throw unavailable();
        const recheckObservation = () => {
          request.signal.throwIfAborted();
          authenticated.recheck();
          const completed = input.runtime.readCompletedHarnessLoginReceipt(context);
          if (
            completed.receiptId !== command.receiptId ||
            completed.materialGeneration !== command.materialGeneration ||
            readAffinity()?.referenceId !== referenceId
          )
            throw unavailable();
        };
        recheckObservation();
        const observedAt = new Date().toISOString();
        await getControlStoreWorkerClient().vault(
          dependencies.coreDb,
          'reference-login-observe',
          {
            context,
            referenceId,
            grantId: grant.grantId,
            planId,
            receiptId: command.receiptId,
            materialGeneration: command.materialGeneration,
            accountId,
            now: () => observedAt,
            observations: {
              ...command.observation,
              observedAt,
              bindingId: context.agentSessionRuntimeBindingId,
              materialGeneration: command.materialGeneration,
            },
          },
          recheckObservation
        );
        recheckObservation();
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      }

      const refreshing = command.reason === 'refresh';
      const requestId = randomUUID();
      const receiptId = refreshing
        ? `receipt_${requestId}`
        : `receipt_${environmentPackage.snapshotId}_${declaration.id}`;
      const refresh = refreshing
        ? Object.freeze({
            previousReceiptId: input.runtime.readCompletedHarnessLoginReceipt(context).receiptId,
            receiptId,
            context,
          })
        : undefined;
      const previous = readAffinity();
      const expectedReferenceId = previous?.referenceId ?? null;
      if (expectedReferenceId !== null && !isEntityId('vault', expectedReferenceId))
        throw unavailable();
      // Same-family refresh never establishes new affinity or claims cross-account continuation.
      if (
        (refreshing || expectedReferenceId !== null) &&
        expectedReferenceId !== reference.referenceId
      )
        throw unavailable();
      let affinityPublished = false;
      checkSelection = () => {
        // The retained package selects one reviewed grant. Refuse its known exhausted
        // generation before entering governed material use, without looking for another grant.
        const latest = requireDeclarationReference(
          dependencies.coreDb,
          requireDeclarationGrant(dependencies.coreDb, declaration)
        );
        if (
          latest.referenceId !== referenceId ||
          hasCurrentHarnessLoginExhaustion(
            latest.login?.observations ?? undefined,
            latest.currentVersion
          )
        )
          throw unavailable();
        const current = readAffinity();
        if (
          (current?.referenceId ?? null) !==
          (affinityPublished ? reference.referenceId : expectedReferenceId)
        )
          throw unavailable();
        // Initial selection checks re-entry before access; same-family refresh leaves affinity intact.
        if (!refreshing)
          nextNativeThreadLogin(current, reference.referenceId, new Date().toISOString());
      };
      await currentCheck();
      const materialVersion = reference.currentVersion;
      const access = await input.runtime.acquireHarnessLogin(
        context,
        request.signal,
        currentCheck,
        async (signal) => {
          await invoke(
            'vault.binding-deliver',
            {
              workspaceId: context.workspaceId,
              bindingThreadId: context.threadId,
              planId,
              receiptId,
              materialVersion,
              requestId,
            },
            {
              kind: 'worker',
              actor: environmentPackage.scope.triggerActor,
              lineage: {
                workspaceId: context.workspaceId,
                threadId: context.threadId,
                turnId: context.turnId,
                agentSessionId: context.agentSessionId,
                packageSnapshotId: context.packageSnapshotId,
              },
              requestId,
              bindings: { workspaceId: context.workspaceId, requestId },
              signal,
              recheckEntry: currentCheck,
              ...(refresh ? { harnessLoginRefresh: refresh } : {}),
            }
          );
        },
        async (effect, signal) => {
          signal.throwIfAborted();
          authenticated.recheck();
          if (
            effect.receiptId !== receiptId ||
            effect.materialGeneration !== materialVersion + 1 ||
            effect.accountId !== reference.login?.accountId
          )
            throw unavailable();
          if (refreshing) {
            await currentCheck();
            return;
          }
          const workspaceDb = dependencies.repositoryWorkspaceDb(context.workspaceId);
          try {
            await getControlStoreWorkerClient().vault(
              workspaceDb,
              'thread-login-activate',
              {
                context,
                referenceId,
                grantId: grant.grantId,
                planId,
                receiptId: effect.receiptId,
                materialGeneration: effect.materialGeneration,
                accountId: effect.accountId,
                expectedReferenceId,
                now: () => new Date().toISOString(),
              },
              async () => {
                signal.throwIfAborted();
                await currentCheck();
              }
            );
            affinityPublished = true;
            signal.throwIfAborted();
            authenticated.recheck();
          } finally {
            workspaceDb.sqlite.close();
          }
        },
        refresh
      );
      authenticated.recheck();
      return Response.json(access, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      // Never publish decoder values, provider failures, account identities or private causes.
      const response = asApiError(
        'Native Login lifecycle is unavailable. Inspect the original effect before retrying.',
        error instanceof OperationError ? error.code : 'worker_login_unavailable',
        error instanceof OperationError ? error.status : 409
      );
      response.headers.set('cache-control', 'no-store');
      return response;
    }
  };
}
