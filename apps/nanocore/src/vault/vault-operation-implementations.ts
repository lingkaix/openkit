import { Buffer } from 'node:buffer';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type {
  OperationOutput,
  VaultAdminWorkspaceReference,
  VaultLoginView,
  WorkspaceVaultGrant,
} from '@openkit/app-api-schemas';
import {
  ProviderApiKeyProfileIdSchema,
  VAULT_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import {
  allocateEntityId,
  isEntityId,
  isSealedTurnTerminal,
  POLICY_OPERATION_REFERENCE_INPUT_V1,
  PolicySubjectV1Schema,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import { z } from 'zod';
import { type Actor, isDeploymentAdminActor } from '../auth/identity.js';
import {
  currentWorkspaceAuthority,
  evaluateOwnedUserOperation,
  isCanonicalUserActive,
  isCurrentServerPolicyAuthor,
} from '../auth/operation-authorizer.js';
import { loadProviderProfiles } from '../config/providers-loader.js';
import { StoreRecordNotFoundError } from '../lib/store.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from '../operation-contract.js';
import { OperationError, WORKSPACE_ACCESS_DENIED } from '../operation-error.js';
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
import type { InterceptionDecision, InterceptionInput } from '../policy/interception.js';
import { type PolicyProposal, policyDigest } from '../policy/statements.js';
import { readVaultReferenceId } from '../providers/vault-credential-resolver.js';
import { requireAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { requireCoordinatorGoal } from '../runtime/goal-owner.js';
import { readGoalTaskPolicyContext } from '../runtime/goal-task-policy-context.js';
import { readVaultRequesterAuthority } from '../runtime/worker-credential-authority.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  nativeUserDatabasePath,
} from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';
import type {
  ControlVaultMainInputMap,
  VaultBindingRequester,
  VaultReferenceRecord,
} from '../storage/vault-native-codecs.js';
import { getWithdrawableUserVaultGrant } from '../storage/vault-native-codecs.js';
import {
  getVaultInjectionPlan,
  listExportableVaultInjectionPlans,
} from '../vault-injection-plans.js';
import {
  getVaultInjectionReceipt,
  listExportableVaultInjectionReceipts,
  listVaultInjectionReceipts,
} from '../vault-injection-receipts.js';
import { isServerMcpReference } from './server-mcp-authority.js';
import {
  prepareVaultAdminAudit,
  recordVaultAdminAuditEvent,
  recordVaultAuditEvent,
} from './vault-admin-audit-events.js';
import {
  createVaultGrantRequestImplementations,
  type GovernReviewedGrantIssue,
} from './vault-grant-requests.js';
import {
  getVaultGrant,
  listExportableWorkspaceVaultGrants,
  listVaultGrants,
  VaultGrantNarrowingError,
} from './vault-grants.js';
import { loadEncryptedFileVaultKeyFile } from './vault-key-file.js';
import {
  getVaultReference,
  listUserVaultReferences,
  listWorkspaceVaultReferences,
} from './vault-references.js';
import type { VaultUnlockState } from './vault-unlock-state.js';
import {
  listExportableWorkspaceVaultUseRecords,
  listVaultUseRecords,
} from './vault-use-records.js';

const VAULT_UNLOCK_FAILURE_LIMIT = 5;
const VAULT_UNLOCK_FAILURE_WINDOW_MS = 60_000;
const SAFE_PROVIDER_API_KEY_REFERENCE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Shared invocation constructs families per request; retain the existing process-local counters and write fence with the app's unique unlock-state owner across HTTP and MCP entries. */
const administrationStates = new WeakMap<
  VaultUnlockState,
  { vaultUnlockFailuresByActor: Map<string, number[]>; providerApiKeyWrites: Set<string> }
>();

/** Joins possibly exposed bindings after metadata revocation, through the current runtime owner. */
export async function closeRevokedCredentialBindings(
  dependencies: Pick<
    OperationInvocationDependencies,
    'coreDb' | 'store' | 'turnExecutor' | 'closeMcpCredentialGrants'
  >,
  target: { grantId: string } | { referenceId: string }
): Promise<void> {
  const { coreDb } = dependencies;
  try {
    if (!coreDb) throw new Error('Core DB is unavailable for revocation inspection.');
    const grantIds = new Set(
      'grantId' in target
        ? [target.grantId]
        : listVaultGrants(coreDb)
            .filter((grant) => grant.vaultReferenceId === target.referenceId)
            .map((grant) => grant.grantId)
    );
    const agentSessionIds = new Set<string>();
    let missingSession = false;
    let gatewayExposure = false;
    // VaultUse precedes private material delivery; a receipt follows acknowledged completion.
    // Either can identify an affected owner, but neither proves physical exposure or removal.
    for (const evidence of [
      ...listVaultInjectionReceipts(coreDb),
      ...listVaultUseRecords(coreDb),
    ]) {
      if (evidence.grantId === null || !grantIds.has(evidence.grantId)) continue;
      const plan = evidence.planId ? getVaultInjectionPlan(coreDb, evidence.planId) : null;
      // Only exact Gateway-only lineage proves that no runtime material was exposed.
      if (plan?.grantId === evidence.grantId && plan.injectionVisibility === 'gateway-only') {
        gatewayExposure = true;
        continue;
      }
      if (evidence.agentSessionId) agentSessionIds.add(evidence.agentSessionId);
      else missingSession = true;
    }
    // Each existing physical owner must settle even if the other cleanup fails.
    const results = await Promise.allSettled([
      (async () => {
        if (dependencies.closeMcpCredentialGrants)
          await dependencies.closeMcpCredentialGrants([...grantIds]);
        else if (gatewayExposure) throw new Error('Gateway credential revocation is unavailable.');
      })(),
      (async () => {
        if (agentSessionIds.size > 0) {
          if (!dependencies.store || !dependencies.turnExecutor?.revokeCredentialBindings)
            throw new Error('Runtime credential revocation is unavailable.');
          await dependencies.turnExecutor.revokeCredentialBindings(dependencies.store, [
            ...agentSessionIds,
          ]);
        }
        if (missingSession) throw new Error('Runtime credential lineage requires inspection.');
      })(),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason));
  } catch (error) {
    throw new OperationError(
      'recovery_required',
      'Vault revocation requires runtime inspection before a new request.',
      409,
      { cause: error }
    );
  }
}

/** Joins Vault administration and redacted governance to their existing native owners. */
export function createVaultOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    | 'coreDb'
    | 'dataRoot'
    | 'repositoryWorkspaceDb'
    | 'repositoryUserDb'
    | 'store'
    | 'turnExecutor'
    | 'vaultUnlockState'
    | 'pendingRequestServices'
    | 'runtimeConfigManager'
    | 'policyInterception'
    | 'readRuntimePolicy'
    | 'goalTaskPolicy'
    | 'closeMcpCredentialGrants'
  >
) {
  const { coreDb, dataRoot, repositoryWorkspaceDb, vaultUnlockState } = dependencies;
  let administrationState = vaultUnlockState
    ? administrationStates.get(vaultUnlockState)
    : undefined;
  if (!administrationState) {
    administrationState = {
      vaultUnlockFailuresByActor: new Map<string, number[]>(),
      providerApiKeyWrites: new Set<string>(),
    };
    if (vaultUnlockState) administrationStates.set(vaultUnlockState, administrationState);
  }
  const { vaultUnlockFailuresByActor, providerApiKeyWrites } = administrationState;

  /** Submits public metadata mutations with the actual requester; native current facts decide after FIFO. */
  async function publicMutation<
    K extends
      | 'reference-create'
      | 'reference-advance'
      | 'reference-revoke'
      | 'reference-rebind'
      | 'grant-create'
      | 'grant-revoke',
  >(
    kind: K,
    record: ControlVaultMainInputMap[K],
    context: AdmittedOperationContext,
    reference?: VaultReferenceRecord
  ) {
    return getControlStoreWorkerClient().vault(
      coreDb!,
      kind,
      {
        ...record,
        publicMutation: {
          actor: publicOperationActor(context),
          ...(context.scope.kind === 'workspace' ? { workspaceId: context.scope.workspaceId } : {}),
          ...(reference ? { reference } : {}),
        },
      },
      async () => {
        await context.recheckAdmission?.();
      }
    );
  }

  /** One consumer of the existing operation definition and Policy owner for Vault effects and reads. */
  async function governedVaultOperation<T>(
    operation:
      | 'vault.binding-deliver'
      | 'vault.binding-replace'
      | 'vault.binding-revoke'
      | 'vault.injection-plan-list'
      | 'vault.injection-receipt-list'
      | 'vault.grant-issue',
    input: { workspaceId: string; requestId?: string },
    context: AdmittedOperationContext,
    db: WorkspaceDb,
    readFacts: () => unknown,
    references: PolicyProposal['inputReferences'],
    attributes: PolicyProposal['inputAttributes'],
    run: (recheckAuthority: () => Promise<void>, decisionId: string) => Promise<T> | T,
    lineage?: Pick<InterceptionInput, 'decisionLineage' | 'contextSummary'>
  ): Promise<T> {
    if (
      !coreDb ||
      !dependencies.store ||
      !dependencies.policyInterception ||
      !context.recheckAdmission ||
      (!dependencies.readRuntimePolicy && !dependencies.runtimeConfigManager)
    )
      throw new OperationError(
        'credential_binding_unavailable',
        'Vault Policy operation is unavailable.',
        503
      );
    const store = dependencies.store;
    const definition = VAULT_OPERATION_DEFINITIONS[operation];
    const interception = dependencies.policyInterception;
    const readPolicy =
      dependencies.readRuntimePolicy ??
      (() => dependencies.runtimeConfigManager!.current().openKitConfig.policy?.mediation);
    let auditActor = context.actorRef;
    try {
      const document = readAdmittedPolicyDocument(coreDb, readPolicy());
      const policyRevision = policyDigest(document);
      const factsRevision = policyDigest(readFacts());
      const taskContext =
        context.kind === 'worker'
          ? readGoalTaskPolicyContext({
              coreDb,
              store,
              db,
              lineage: context.lineage,
            })
          : null;
      const responsibleHumanId =
        taskContext?.responsibleUserId ?? responsibleUserIdForActor(context.actorRef);
      if (!responsibleHumanId) vaultWorkspaceAccessDenied();
      const workerPackage =
        context.kind === 'worker'
          ? requireAgentEnvironmentPackageSnapshot(
              db,
              input.workspaceId,
              context.lineage.packageSnapshotId
            ).snapshot
          : null;
      const agentId =
        taskContext?.agentId ??
        (context.kind === 'coordinator' ? 'goal-coordinator' : workerPackage?.agent.agentId);
      const subject = PolicySubjectV1Schema.parse({
        principal: taskContext
          ? { kind: 'agent', id: agentId }
          : { kind: 'human', id: responsibleHumanId },
        onBehalfOf: null,
        actor: agentId
          ? { kind: 'agent', id: agentId, responsibleUserId: responsibleHumanId }
          : context.actorRef,
        process:
          context.kind === 'worker'
            ? {
                workspaceId: context.lineage.workspaceId,
                threadId: context.lineage.threadId,
                turnId: context.lineage.turnId,
              }
            : context.kind === 'coordinator'
              ? {
                  workspaceId: context.workspaceId,
                  threadId: context.threadId,
                  turnId: context.turnId,
                }
              : null,
        credentialKind: context.kind === 'worker' ? 'worker-package' : context.actor.kind,
        responsibleHumanId,
      });
      auditActor = subject.actor;
      const resource = {
        kind: 'container' as const,
        container: {
          kind: 'workspace',
          id: input.workspaceId,
          owner: { kind: 'workspace' as const, workspaceId: input.workspaceId },
        },
      };
      const proposal: PolicyProposal = {
        operation,
        workspaceId: input.workspaceId,
        resource,
        capabilityCallId: null,
        subject,
        inputReferences: { ...references, selectionDigest: factsRevision },
        inputAttributes: { contract: POLICY_OPERATION_REFERENCE_INPUT_V1, ...attributes },
      };
      const taskPolicy = taskContext ? dependencies.goalTaskPolicy?.(db, responsibleHumanId) : null;
      if (taskContext && !taskPolicy) throw new Error('Goal Task Policy is unavailable.');
      let ownDecision: InterceptionDecision | undefined;
      const currentAuthority = (
        consumed = false
      ): {
        kernel: import('@openkit/policy-kernel').PolicyDecision;
        goal: import('../policy/goal-task-access.js').GoalTaskAccessResult | null;
        revision: string;
        authorizationUses: InterceptionInput['authorizationUses'];
      } => {
        const evaluated = readVaultRequesterAuthority(
          coreDb,
          input.workspaceId,
          vaultRequesterForContext(context),
          definition.policyOperation,
          definition.mutating
        );
        const currentCoordinator =
          context.kind === 'coordinator' ? requireCoordinatorGoal(store, db, context) : null;
        const goalInput =
          context.kind === 'worker'
            ? {
                workspaceDb: db,
                lineage: context.lineage,
                subject,
                operation: definition.policyOperation,
                resource,
                humanKernel: evaluated.decision,
              }
            : null;
        let goal: import('../policy/goal-task-access.js').GoalTaskAccessResult | null = null;
        let authorizationUses: InterceptionInput['authorizationUses'] = [];
        if (taskPolicy && goalInput) {
          if (consumed && ownDecision)
            goal = taskPolicy.readTaskDecision({ ...goalInput, decision: ownDecision });
          else {
            const evaluatedTask = taskPolicy.evaluateTask(goalInput);
            goal = evaluatedTask;
            authorizationUses = evaluatedTask?.authorizationUses ?? [];
          }
        }
        if (taskContext && !goal) throw new Error('Current Goal Task authority is unavailable.');
        return {
          kernel: goal?.kernel ?? evaluated.decision,
          goal,
          revision: policyDigest({
            caller: evaluated,
            goalTask: goal?.authorizationRevision ?? null,
            coordinator: currentCoordinator,
          }),
          authorizationUses,
        };
      };
      const initial = currentAuthority();
      const authorCurrent = (userId: string) =>
        !!currentWorkspaceAuthority(
          coreDb,
          input.workspaceId,
          { kind: 'user', id: userId },
          definition.policyOperation,
          true,
          undefined,
          {
            retainedPolicyAuthor: true,
            dependencyFailure: 'throw',
            mutating: definition.mutating,
          }
        );
      const anchorCurrent: InterceptionInput['anchorCurrent'] = (anchor) => {
        if (anchor.owner.kind !== 'workspace' || anchor.owner.workspaceId !== input.workspaceId)
          return false;
        if (anchor.kind === 'workspace') return anchor.id === input.workspaceId;
        if (anchor.kind !== 'turn') return false;
        return !isSealedTurnTerminal(store.getTurnById(anchor.id).status);
      };
      const interceptionInput: InterceptionInput = {
        workspaceDb: db,
        document,
        proposal,
        authorizationRevision: initial.revision,
        authorizationUses: initial.authorizationUses,
        resourceSummary: { selectionDigest: factsRevision },
        contextSummary: { requestId: input.requestId ?? null },
        ...lineage,
        authorCurrent,
        anchorCurrent,
        participantAuthorized: (binding) =>
          binding.participant.kind === 'deterministic' &&
          binding.author.kind === 'human' &&
          authorCurrent(binding.author.id),
        stillCurrent: () =>
          !context.signal?.aborted &&
          policyDigest(readAdmittedPolicyDocument(coreDb, readPolicy())) === policyRevision &&
          policyDigest(readFacts()) === factsRevision &&
          currentAuthority(!!ownDecision).revision === initial.revision,
        finalKernel: () => {
          const current = currentAuthority();
          return current.goal ?? current.kernel;
        },
      };
      ownDecision = await interception.decide(interceptionInput);
      if (ownDecision.result !== 'allow') vaultWorkspaceAccessDenied();
      const recheckAuthority = async () => {
        await context.recheckAdmission!();
        if (!interceptionInput.stillCurrent()) vaultWorkspaceAccessDenied();
      };
      await recheckAuthority();
      const result = await run(recheckAuthority, ownDecision.decisionId);
      // Reviewed issuance publishes its exact grant-linked Core Audit in the native effect.
      if (operation !== 'vault.grant-issue')
        await recordVaultAuditEvent({
          coreDb,
          workspaceId: input.workspaceId,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          actor: auditActor,
          action: operation,
          resource: `workspace:${input.workspaceId}`,
          outcome: 'succeeded',
          summary: 'Governed Vault operation completed.',
        });
      // Completed observations are non-decisive and cannot make an effect retryable.
      await interception
        .observe({
          ...interceptionInput,
          stillCurrent: () =>
            !context.signal?.aborted &&
            policyDigest(readAdmittedPolicyDocument(coreDb, readPolicy())) === policyRevision &&
            currentAuthority(true).revision === initial.revision,
        })
        .catch(() => undefined);
      if (!definition.mutating) await recheckAuthority();
      return result;
    } catch (cause) {
      let failure = cause;
      try {
        await recordVaultAuditEvent({
          coreDb,
          workspaceId: input.workspaceId,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          actor: auditActor,
          action: operation,
          resource: `workspace:${input.workspaceId}`,
          outcome: 'failed',
          summary: 'Governed Vault operation failed or requires inspection.',
        });
      } catch (auditError) {
        failure = new AggregateError(
          [cause, auditError],
          'Vault failure evidence could not settle.',
          { cause }
        );
      }
      if (cause instanceof OperationError) {
        if (failure === cause) throw cause;
        throw new OperationError(cause.code, cause.message, cause.status, { cause: failure });
      }
      throw new OperationError('recovery_required', 'Vault operation requires inspection.', 409, {
        cause: failure,
      });
    }
  }

  /** Both automatic admission and agent calls use this reference-only lifecycle handler. */
  async function bindingOperation(
    action: 'deliver' | 'replace' | 'revoke',
    input: {
      workspaceId: string;
      bindingThreadId: string;
      planId: string;
      requestId: string;
      receiptId?: string;
      expectedReceiptId?: string;
      materialVersion?: number;
    },
    context: AdmittedOperationContext
  ) {
    if (
      !coreDb ||
      !dependencies.store ||
      !dependencies.repositoryWorkspaceDb ||
      !dependencies.turnExecutor?.credentialBindingOperation
    )
      throw new OperationError(
        'credential_binding_unavailable',
        'Credential binding operation is unavailable.',
        503
      );
    const db = dependencies.repositoryWorkspaceDb(input.workspaceId);
    try {
      const plan = getVaultInjectionPlan(coreDb, input.planId);
      if (!plan?.packageSnapshotId || plan.injectionVisibility !== 'runtime-file')
        throw new OperationError(
          'credential_binding_not_found',
          'Credential binding not found.',
          404
        );
      const original = requireAgentEnvironmentPackageSnapshot(
        db,
        input.workspaceId,
        plan.packageSnapshotId
      ).snapshot;
      if (
        original.scope.workspaceId !== input.workspaceId ||
        original.scope.threadId !== input.bindingThreadId ||
        (context.kind === 'worker' && context.lineage.threadId !== input.bindingThreadId)
      )
        throw new OperationError(
          'credential_binding_not_found',
          'Credential binding not found.',
          404
        );
      const receiptId = input.expectedReceiptId ?? input.receiptId ?? null;
      const readFacts = () => {
        let target = null;
        if (context.kind === 'coordinator') {
          const goal = requireCoordinatorGoal(dependencies.store!, db, context);
          target = readGoalTaskPolicyContext({
            coreDb,
            store: dependencies.store!,
            db,
            lineage: { ...original.scope, packageSnapshotId: original.snapshotId },
          });
          if (
            !target ||
            target.goalId !== goal.goalId ||
            target.planVersionId !== goal.activePlanVersionId ||
            target.responsibleUserId !== goal.responsibleUserId ||
            target.taskThreadId !== input.bindingThreadId
          )
            vaultWorkspaceAccessDenied();
        }
        const currentPlan = getVaultInjectionPlan(coreDb, input.planId);
        const grant = currentPlan?.grantId ? getVaultGrant(coreDb, currentPlan.grantId) : null;
        return {
          plan: currentPlan,
          grant,
          target,
          reference: grant ? getVaultReference(coreDb, grant.vaultReferenceId) : null,
          receipt: receiptId ? getVaultInjectionReceipt(coreDb, receiptId) : null,
        };
      };
      return await governedVaultOperation(
        `vault.binding-${action}`,
        input,
        context,
        db,
        readFacts,
        {
          planId: input.planId,
          grantId: plan.grantId,
          receiptId,
          requestId: input.requestId,
          packageSnapshotId: plan.packageSnapshotId,
          targetDigest: policyDigest(plan.targetPath),
        },
        {
          materialVersion: input.materialVersion ?? null,
          format: 'utf8',
          access: 'read-only',
          ephemeral: true,
          outsideRetainedStorage: true,
          excludedFromCapture: true,
          excludedFromExport: true,
        },
        (recheckAuthority) =>
          dependencies.turnExecutor!.credentialBindingOperation!(
            dependencies.store!,
            {
              action,
              coreAuthority: {
                workspaceId: input.workspaceId,
                requester: vaultRequesterForContext(context),
                revision: policyDigest(
                  readVaultRequesterAuthority(
                    coreDb,
                    input.workspaceId,
                    vaultRequesterForContext(context),
                    'vault.use',
                    true
                  )
                ),
              },
              workspaceId: input.workspaceId,
              threadId: input.bindingThreadId,
              planId: input.planId,
              requestId: input.requestId,
              ...(input.receiptId ? { receiptId: input.receiptId } : {}),
              ...(input.expectedReceiptId ? { expectedReceiptId: input.expectedReceiptId } : {}),
              ...(input.materialVersion ? { materialVersion: input.materialVersion } : {}),
            },
            recheckAuthority
          )
      );
    } finally {
      db.sqlite.close();
    }
  }

  /** Existing read operations retain their public Workspace scope and narrow agent audiences by immutable AEP lineage. */
  async function inspectBindings(
    operation: 'vault.injection-plan-list' | 'vault.injection-receipt-list',
    input: { workspaceId: string },
    context: AdmittedOperationContext
  ) {
    if (!coreDb || !dependencies.store || !dependencies.repositoryWorkspaceDb)
      throw new OperationError(
        'credential_binding_unavailable',
        'Vault inspection is unavailable.',
        503
      );
    dependencies.store.getWorkspace(input.workspaceId);
    const db = dependencies.repositoryWorkspaceDb(input.workspaceId);
    try {
      const select = () => {
        const grants = listExportableWorkspaceVaultGrants(coreDb, input.workspaceId).map(
          (grant) => grant.grantId
        );
        const caller =
          context.kind === 'worker'
            ? requireAgentEnvironmentPackageSnapshot(
                db,
                input.workspaceId,
                context.lineage.packageSnapshotId
              ).snapshot
            : null;
        const goal =
          context.kind === 'coordinator'
            ? requireCoordinatorGoal(dependencies.store!, db, context)
            : null;
        const scopes = new Map<string, string>();
        const plans = listExportableVaultInjectionPlans(coreDb, grants).filter((plan) => {
          if (!caller && !goal) return true;
          if (!plan.packageSnapshotId) return false;
          let original: ReturnType<typeof requireAgentEnvironmentPackageSnapshot>['snapshot'];
          try {
            original = requireAgentEnvironmentPackageSnapshot(
              db,
              input.workspaceId,
              plan.packageSnapshotId
            ).snapshot;
          } catch {
            return false;
          }
          if (original.scope.workspaceId !== input.workspaceId) return false;
          const selected = (declarations: typeof original.credentials.declarations) =>
            declarations.some(
              (declaration) =>
                declaration.vaultGrantId === plan.grantId &&
                declaration.visibility === plan.injectionVisibility &&
                (declaration.visibility !== 'runtime-file' ||
                  declaration.targetPath === plan.targetPath) &&
                (declaration.visibility !== 'runtime-env' ||
                  declaration.targetEnvVarName === plan.targetEnvVarName)
            );
          if (!selected(original.credentials.declarations)) return false;
          if (
            caller &&
            context.kind === 'worker' &&
            (original.scope.agentSessionId !== context.lineage.agentSessionId ||
              original.scope.threadId !== context.lineage.threadId ||
              !selected(caller.credentials.declarations))
          )
            return false;
          if (goal) {
            let target: ReturnType<typeof readGoalTaskPolicyContext>;
            try {
              target = readGoalTaskPolicyContext({
                coreDb,
                store: dependencies.store!,
                db,
                lineage: { ...original.scope, packageSnapshotId: original.snapshotId },
              });
            } catch {
              return false;
            }
            if (
              !target ||
              target.goalId !== goal.goalId ||
              target.planVersionId !== goal.activePlanVersionId ||
              target.responsibleUserId !== goal.responsibleUserId
            )
              return false;
          }
          scopes.set(plan.planId, original.scope.agentSessionId);
          return true;
        });
        const receipts = listExportableVaultInjectionReceipts(
          coreDb,
          plans.map((plan) => plan.planId)
        ).filter(
          (receipt) => (!caller && !goal) || receipt.agentSessionId === scopes.get(receipt.planId)
        );
        return { plans, receipts };
      };
      return await governedVaultOperation(
        operation,
        input,
        context,
        db,
        select,
        {},
        {},
        async (recheckAuthority) => {
          await recheckAuthority();
          const rows = select();
          return {
            workspaceId: input.workspaceId,
            items: operation === 'vault.injection-plan-list' ? rows.plans : rows.receipts,
          };
        }
      );
    } finally {
      db.sqlite.close();
    }
  }

  /**
   * Returns the redacted vault admin status payload.
   *
   * @returns App API vault status payload.
   */
  function vaultAdminStatus() {
    if (!vaultUnlockState) {
      return {
        backendKind: 'encrypted-file' as const,
        diagnostic: 'Vault backend is not configured.',
        state: 'unavailable' as const,
      };
    }

    const health = vaultUnlockState.backend().health();

    return {
      backendKind: health.kind,
      diagnostic: health.diagnostic,
      state: health.state,
    };
  }

  /**
   * Returns an unavailable vault admin API error when no unlock state exists.
   *
   * @throws OperationError with the fixed unavailable refusal.
   */
  function vaultAdminUnavailableError(): never {
    return vaultFailure('Vault backend is not configured.', 'vault_backend_unavailable', 503);
  }

  /**
   * Returns the actor-scoped key used for vault unlock rate limiting.
   *
   * @param c Trusted admitted operation context.
   * @returns Stable actor key for this process.
   */
  function vaultUnlockActorKey(c: AdmittedOperationContext): string {
    const actor = publicOperationActor(c);

    return `${actor.kind}:${actor.userId}`;
  }

  /**
   * Returns active failed unlock attempts for the actor.
   *
   * @param c Trusted admitted operation context.
   * @returns Mutable active attempt timestamps.
   */
  function activeVaultUnlockFailures(c: AdmittedOperationContext): number[] {
    const key = vaultUnlockActorKey(c);
    const cutoff = Date.now() - VAULT_UNLOCK_FAILURE_WINDOW_MS;
    const active = (vaultUnlockFailuresByActor.get(key) ?? []).filter((at) => at >= cutoff);

    vaultUnlockFailuresByActor.set(key, active);

    return active;
  }

  /**
   * Checks whether the actor has exhausted failed unlock attempts.
   *
   * @param c Trusted admitted operation context.
   * @returns True when the next unlock request should be denied.
   */
  function isVaultUnlockRateLimited(c: AdmittedOperationContext): boolean {
    return activeVaultUnlockFailures(c).length >= VAULT_UNLOCK_FAILURE_LIMIT;
  }

  /**
   * Adds one failed unlock attempt to the actor's process-local window.
   *
   * @param c Trusted admitted operation context.
   */
  function rememberVaultUnlockFailure(c: AdmittedOperationContext): void {
    activeVaultUnlockFailures(c).push(Date.now());
  }

  /**
   * Clears failed unlock attempts after a successful unlock.
   *
   * @param c Trusted admitted operation context.
   */
  function clearVaultUnlockFailures(c: AdmittedOperationContext): void {
    vaultUnlockFailuresByActor.delete(vaultUnlockActorKey(c));
  }

  /**
   * Records a vault admin audit event when server storage is configured.
   *
   * @param c Trusted admitted operation context.
   * @param input Redacted audit fields.
   */
  async function recordVaultAdminAudit(
    c: AdmittedOperationContext,
    input: {
      readonly action:
        | 'vault.unlock'
        | 'vault.lock'
        | 'vault.bootstrap_codex_auth_json'
        | 'vault.set_provider_api_key'
        | 'vault.rebind_workspace_reference';
      readonly outcome: 'succeeded' | 'failed' | 'denied';
      readonly summary: string;
      readonly errorCode?: string;
    }
  ): Promise<void> {
    if (!coreDb) {
      return;
    }

    await recordVaultAdminAuditEvent({
      action: input.action,
      actor: publicOperationActor(c),
      backendKind: vaultUnlockState?.backend().kind ?? 'encrypted-file',
      coreDb: coreDb,
      errorCode: input.errorCode ?? null,
      outcome: input.outcome,
      summary: input.summary,
    });
  }

  /** Returns one redacted provider API-key error after recording the failed mutation. */
  async function providerApiKeyError(
    c: AdmittedOperationContext,
    message: string,
    errorCode: string,
    status: 400 | 404 | 409 | 423,
    outcome: 'failed' | 'denied' = 'failed'
  ): Promise<never> {
    await recordVaultAdminAudit(c, {
      action: 'vault.set_provider_api_key',
      errorCode,
      outcome,
      summary:
        outcome === 'denied'
          ? 'Provider API-key configuration denied.'
          : 'Provider API-key configuration failed.',
    });
    return vaultFailure(message, errorCode, status);
  }

  /** Same actual-caller User Policy/decision/Audit owner for personal Vault lifecycle actions. */
  async function governedUserVaultOperation<
    F extends { kernel: ReturnType<typeof evaluateOwnedUserOperation> },
    T,
  >(
    operation:
      | 'vault.bootstrap-codex-auth'
      | 'vault.grant-withdraw'
      | 'vault.login-list'
      | 'vault.login-quarantine'
      | 'vault.login-release'
      | 'vault.grant-issue',
    context: AdmittedOperationContext,
    readFacts: (actor: Actor) => F,
    references: (selected: F) => Record<string, string>,
    effect: (
      selected: F,
      actor: Actor,
      beforeSubmit: () => Promise<void>,
      decisionId: string
    ) => Promise<T>,
    lineage?: Pick<InterceptionInput, 'decisionLineage' | 'contextSummary'>
  ): Promise<T> {
    const withdrawal = operation === 'vault.grant-withdraw';
    if (
      context.kind !== 'public' ||
      !coreDb ||
      !dependencies.repositoryUserDb ||
      !dependencies.policyInterception ||
      !context.recheckAdmission ||
      (!dependencies.readRuntimePolicy && !dependencies.runtimeConfigManager)
    )
      throw new OperationError(
        withdrawal ? 'vault_withdrawal_unavailable' : 'vault_login_unavailable',
        withdrawal ? 'Vault withdrawal is unavailable.' : 'Login metadata is unavailable.',
        503
      );
    const actor = publicOperationActor(context);
    const currentFacts = () => readFacts(actor);
    const selected = currentFacts();
    const inputReferences = references(selected);
    const resource = inputReferences.grantId
      ? `vault-grant:${inputReferences.grantId}`
      : inputReferences.referenceId
        ? `vault-reference:${inputReferences.referenceId}`
        : `user:${actor.userId}:vault-logins`;
    const auditGrant = inputReferences.grantId ? { vaultGrantId: inputReferences.grantId } : {};
    const userId = actor.userId;
    const userDb = dependencies.repositoryUserDb(userId);
    try {
      // Finite Policy reads need the existing native User migrations before first use.
      const userPath = nativeUserDatabasePath(userDb);
      await getControlStoreWorkerClient().open({
        database: `user:${userPath}`,
        path: userPath,
        create: false,
        initialize: 'user',
      });
      const readPolicy =
        dependencies.readRuntimePolicy ??
        (() => dependencies.runtimeConfigManager!.current().openKitConfig.policy?.mediation);
      const document = readAdmittedPolicyDocument(coreDb, readPolicy());
      const policyRevision = policyDigest(document);
      const authorityRevision = policyDigest(selected);
      const userCurrent = (id: string) => isCanonicalUserActive(coreDb, id);
      const authorCurrent = (id: string) =>
        userCurrent(id) && (id === userId || isCurrentServerPolicyAuthor(coreDb, id));
      const proposal: PolicyProposal = {
        operation,
        workspaceId: null,
        capabilityCallId: null,
        resource: {
          kind: 'container',
          container: { kind: 'user', id: userId, owner: { kind: 'user', userId } },
        },
        subject: PolicySubjectV1Schema.parse({
          principal: { kind: 'human', id: actor.userId },
          onBehalfOf: null,
          actor: context.actorRef,
          process: null,
          credentialKind: actor.kind,
          responsibleHumanId: actor.userId,
        }),
        inputReferences,
        inputAttributes: { contract: POLICY_OPERATION_REFERENCE_INPUT_V1 },
      };
      const policyInput: InterceptionInput = {
        userDb,
        document,
        proposal,
        authorizationRevision: authorityRevision,
        resourceSummary: withdrawal
          ? { grantId: inputReferences.grantId!, referenceId: inputReferences.referenceId! }
          : inputReferences,
        ...lineage,
        authorCurrent,
        anchorCurrent: (anchor) =>
          anchor.owner.kind === 'user' &&
          anchor.owner.userId === userId &&
          anchor.kind === 'user' &&
          anchor.id === userId &&
          userCurrent(userId),
        participantAuthorized: (binding) =>
          binding.participant.kind === 'deterministic' &&
          binding.author.kind === 'human' &&
          authorCurrent(binding.author.id),
        stillCurrent: () =>
          !context.signal?.aborted &&
          policyDigest(readAdmittedPolicyDocument(coreDb, readPolicy())) === policyRevision &&
          policyDigest(currentFacts()) === authorityRevision,
        finalKernel: () => currentFacts().kernel,
      };
      const decision = await dependencies.policyInterception.decide(policyInput);
      if (decision.result !== 'allow') vaultWorkspaceAccessDenied();
      await context.recheckAdmission();
      if (!policyInput.stillCurrent()) vaultWorkspaceAccessDenied();
      const beforeSubmit = async () => {
        await context.recheckAdmission!();
        if (!policyInput.stillCurrent()) vaultWorkspaceAccessDenied();
      };
      const result = await effect(selected, actor, beforeSubmit, decision.decisionId);
      await recordVaultAuditEvent({
        userDb,
        actor: context.actorRef,
        action: operation,
        outcome: 'succeeded',
        resource,
        ...auditGrant,
        permissionDecisionId: decision.decisionId,
        summary: withdrawal
          ? 'Personal credential grant withdrawal completed.'
          : operation === 'vault.grant-issue'
            ? 'Personal Login sharing completed.'
            : 'Personal Login metadata operation completed.',
      });
      await dependencies.policyInterception
        .observe({
          ...policyInput,
          stillCurrent: () =>
            !context.signal?.aborted &&
            policyDigest(readAdmittedPolicyDocument(coreDb, readPolicy())) === policyRevision &&
            userCurrent(userId),
        })
        .catch(() => undefined);
      return result;
    } catch (cause) {
      try {
        await recordVaultAuditEvent({
          userDb,
          actor: context.actorRef,
          action: operation,
          outcome: 'failed',
          resource,
          ...auditGrant,
          summary: withdrawal
            ? 'Personal credential grant withdrawal did not complete.'
            : 'Personal Login metadata operation did not complete.',
        });
      } catch (auditFailure) {
        throw new OperationError(
          withdrawal ? 'vault_withdrawal_incomplete' : 'vault_login_incomplete',
          withdrawal
            ? 'Credential withdrawal did not complete. Inspect its current state before another request.'
            : 'Login metadata operation did not complete. Inspect its current state before another request.',
          409,
          { cause: new AggregateError([cause, auditFailure]) }
        );
      }
      if (cause instanceof OperationError) throw cause;
      throw new OperationError(
        withdrawal ? 'vault_withdrawal_incomplete' : 'vault_login_incomplete',
        withdrawal
          ? 'Credential withdrawal did not complete. Inspect its current state before another request.'
          : 'Login metadata operation did not complete. Inspect its current state before another request.',
        409,
        { cause }
      );
    } finally {
      userDb.sqlite.close();
    }
  }

  /** Trusted source ownership selects the existing decision home independently of destination admission. */
  const governReviewedGrantIssue: GovernReviewedGrantIssue = async (
    input,
    context,
    db,
    readReference,
    effect
  ) => {
    const selected = readReference();
    const references = {
      referenceId: selected.referenceId,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      approvalId: input.requestId,
    };
    const lineage = {
      decisionLineage: { requestId: input.requestId, approvalId: input.requestId },
      contextSummary: {
        requestId: input.requestId,
        approvalRequestId: input.requestId,
        threadId: input.threadId,
        turnId: input.turnId,
        issuingActorId: publicOperationActor(context).userId,
        decidingActorId: input.decidingActorId,
        requesterId: input.requesterId,
      },
    };
    if (selected.ownerScope === 'user' && selected.userId && selected.login) {
      return governedUserVaultOperation(
        'vault.grant-issue',
        context,
        (actor) => {
          const reference = readReference();
          if (reference.ownerScope !== 'user' || !reference.userId || !reference.login)
            vaultWorkspaceAccessDenied();
          const kernel = evaluateOwnedUserOperation(
            coreDb!,
            actor,
            reference.userId,
            'vault.admin',
            true
          );
          if (kernel.effect !== 'allow') vaultWorkspaceAccessDenied();
          return { reference, kernel };
        },
        () => references,
        (_facts, _actor, beforeSubmit, decisionId) => effect(decisionId, beforeSubmit),
        lineage
      );
    }
    return governedVaultOperation(
      'vault.grant-issue',
      { workspaceId: input.workspaceId, requestId: input.requestId },
      context,
      db,
      readReference,
      references,
      {},
      (beforeSubmit, decisionId) => effect(decisionId, beforeSubmit),
      lineage
    );
  };

  /** Withdraws personal reference consent without manufacturing Workspace membership. */
  async function withdrawOwnedGrant(
    input: { workspaceId: string; grantId: string },
    context: AdmittedOperationContext
  ): Promise<WorkspaceVaultGrant> {
    return governedUserVaultOperation(
      'vault.grant-withdraw',
      context,
      (actor) => {
        const target =
          coreDb && getWithdrawableUserVaultGrant(coreDb, input.workspaceId, input.grantId);
        if (!target) vaultWorkspaceAccessDenied();
        const kernel = evaluateOwnedUserOperation(
          coreDb!,
          actor,
          target.reference.userId,
          'vault.admin',
          true
        );
        if (kernel.effect !== 'allow') vaultWorkspaceAccessDenied();
        return { ...target, kernel };
      },
      (selected) => ({
        grantId: input.grantId,
        referenceId: selected.reference.referenceId,
        workspaceId: input.workspaceId,
      }),
      async (selected, actor, beforeSubmit) => {
        const result = await getControlStoreWorkerClient().vault(
          coreDb!,
          'grant-revoke',
          {
            grantId: input.grantId,
            publicMutation: {
              actor,
              workspaceId: input.workspaceId,
              reference: selected.reference,
            },
          },
          beforeSubmit
        );
        await closeRevokedCredentialBindings(dependencies, { grantId: input.grantId });
        return result as WorkspaceVaultGrant;
      }
    );
  }

  /** Uses the same User governance for own-only inventory and exact owner/admin Login restrictions. */
  async function personalLoginOperation(
    operation: 'vault.login-list' | 'vault.login-quarantine' | 'vault.login-release',
    input: { referenceId?: string },
    context: AdmittedOperationContext
  ) {
    return governedUserVaultOperation(
      operation,
      context,
      (actor) => {
        if (operation === 'vault.login-list') {
          const kernel = evaluateOwnedUserOperation(
            coreDb!,
            actor,
            actor.userId,
            'vault.admin',
            VAULT_OPERATION_DEFINITIONS[operation].mutating
          );
          if (kernel.effect !== 'allow') vaultWorkspaceAccessDenied();
          return {
            kernel,
            items: listUserVaultReferences(coreDb!, actor.userId).filter(
              (reference) => reference.login
            ),
            reference: null,
          };
        }
        const reference = getVaultReference(coreDb!, input.referenceId!);
        if (
          !reference?.login ||
          reference.status !== 'active' ||
          reference.ownerScope !== 'user' ||
          !reference.userId
        )
          vaultWorkspaceAccessDenied();
        const kernel = evaluateOwnedUserOperation(
          coreDb!,
          actor,
          reference.userId,
          'vault.admin',
          VAULT_OPERATION_DEFINITIONS[operation].mutating
        );
        if (kernel.effect !== 'allow') vaultWorkspaceAccessDenied();
        return { kernel, items: null, reference };
      },
      (): Record<string, string> => (input.referenceId ? { referenceId: input.referenceId } : {}),
      async (selected, actor, beforeSubmit) => {
        if (operation === 'vault.login-list') return { items: selected.items!.map(projectLogin) };
        const reference = await getControlStoreWorkerClient().vault(
          coreDb!,
          'reference-login-state',
          {
            referenceId: input.referenceId!,
            quarantined: operation === 'vault.login-quarantine',
            publicMutation: { actor, reference: selected.reference! },
          },
          beforeSubmit
        );
        return projectLogin(reference);
      }
    );
  }

  /** Executes the existing Vault lifecycle and awaits required runtime revocation outside SQL. */
  function mutate(
    input: {
      workspaceId: string;
      referenceId?: string;
      grantId?: string;
      material?: string;
      secretKind?: string;
      expiresAt?: string | undefined;
      injectionPath?: 'gateway-only' | 'runtime-env' | 'runtime-file' | undefined;
      targetAgentId?: string | undefined;
      targetAgentSessionId?: string | undefined;
      targetCapabilityId?: string | undefined;
    },
    c: AdmittedOperationContext,
    action: 'grant' | 'revoke-grant'
  ): Promise<WorkspaceVaultGrant>;
  function mutate(
    input: {
      workspaceId: string;
      referenceId?: string;
      grantId?: string;
      material?: string;
      secretKind?: string;
      expiresAt?: string | undefined;
      injectionPath?: 'gateway-only' | 'runtime-env' | 'runtime-file' | undefined;
      targetAgentId?: string | undefined;
      targetAgentSessionId?: string | undefined;
      targetCapabilityId?: string | undefined;
    },
    c: AdmittedOperationContext,
    action: 'create' | 'rotate' | 'revoke'
  ): Promise<VaultAdminWorkspaceReference>;
  async function mutate(
    input: {
      workspaceId: string;
      referenceId?: string;
      grantId?: string;
      material?: string;
      secretKind?: string;
      expiresAt?: string | undefined;
      injectionPath?: 'gateway-only' | 'runtime-env' | 'runtime-file' | undefined;
      targetAgentId?: string | undefined;
      targetAgentSessionId?: string | undefined;
      targetCapabilityId?: string | undefined;
    },
    c: AdmittedOperationContext,
    action: 'create' | 'rotate' | 'revoke' | 'grant' | 'revoke-grant'
  ): Promise<VaultAdminWorkspaceReference | WorkspaceVaultGrant> {
    if (!isDeploymentAdminActor(publicOperationActor(c)))
      return vaultFailure('Vault administration is forbidden.', 'deployment_admin_required', 403);
    if (!coreDb || !vaultUnlockState)
      return vaultFailure('Vault storage is unavailable.', 'vault_storage_unavailable', 503);
    const workspaceId = input.workspaceId;

    const backend = vaultUnlockState.backend();
    /** Record only fixed action and outcome text, never request or exception content. */
    const audit = async (outcome: 'succeeded' | 'failed') =>
      await recordVaultAdminAuditEvent({
        coreDb,
        actor: publicOperationActor(c),
        action: `vault.workspace_${action}`,
        backendKind: backend.kind,
        outcome,
        summary:
          outcome === 'succeeded'
            ? 'Workspace Vault mutation succeeded.'
            : 'Workspace Vault mutation failed.',
      });
    // This pre-existing private boundary compensates partial backend effects and publishes fixed text rather than backend material.
    let storedReferenceId: string | null = null;
    try {
      if (action === 'revoke-grant') {
        const grant = getVaultGrant(coreDb, input.grantId!);
        if (!grant || grant.ownerScope !== 'workspace' || grant.workspaceId !== workspaceId)
          return vaultFailure('Vault grant not found.', 'vault_grant_not_found', 404);
        const result = await publicMutation('grant-revoke', { grantId: grant.grantId }, c);
        await closeRevokedCredentialBindings(dependencies, { grantId: grant.grantId });
        await audit('succeeded');
        return result as WorkspaceVaultGrant;
      }
      if (action !== 'revoke' && backend.health().state !== 'available')
        return vaultFailure('Vault backend is not available.', 'vault_backend_not_available', 423);
      if (action === 'create') {
        const referenceId = allocateEntityId('vault');
        const inventory = backend.store({
          referenceId,
          material: input.material!,
          metadata: { ownerScope: 'workspace', workspaceId },
        });
        storedReferenceId = referenceId;
        if (inventory.currentVersion !== 1 || inventory.revoked)
          throw new Error('Invalid initial version.');
        const created = await publicMutation(
          'reference-create',
          {
            referenceId,
            ownerScope: 'workspace',
            workspaceId,
            secretKind: input.secretKind!,
            displayName: input.secretKind!,
            backendKind: backend.kind,
            backendLocator: `${backend.kind}://workspace/${workspaceId}/vault/${referenceId}`,
          },
          c
        );
        if (!created.inserted) throw new Error('Reference conflict.');
        storedReferenceId = null;
        await audit('succeeded');
        return projectReference(created.reference);
      }
      const referenceId = input.referenceId!;
      const reference = getVaultReference(coreDb, referenceId);
      if (
        !reference ||
        reference.ownerScope !== 'workspace' ||
        reference.workspaceId !== workspaceId
      )
        return vaultFailure('Vault reference not found.', 'vault_reference_not_found', 404);
      if (reference.status !== 'active')
        return vaultFailure('Vault reference is not active.', 'vault_reference_not_active', 409);
      /** Preserve exact backend ownership checks; revocation runs them after its Core fence. */
      const validateInventory = () => {
        const inventory = backend
          .listReferences({ ownerScope: 'workspace', workspaceId })
          .find((entry) => entry.referenceId === referenceId);
        if (
          !inventory ||
          inventory.revoked ||
          inventory.currentVersion !== reference.currentVersion ||
          inventory.backendKind !== reference.backendKind ||
          reference.backendKind !== backend.kind ||
          inventory.workspaceId !== workspaceId ||
          inventory.userId !== undefined ||
          inventory.providerSubscriptionAccount !== undefined ||
          reference.userId !== null ||
          reference.backendLocator !==
            `${backend.kind}://workspace/${workspaceId}/vault/${referenceId}`
        ) {
          return vaultFailure('Vault storage requires inspection.', 'vault_recovery_required', 409);
        }
      };
      if (action === 'revoke') {
        const result = await publicMutation('reference-revoke', { referenceId }, c, reference);
        let backendFailure: { error: unknown } | undefined;
        try {
          validateInventory();
          backend.revoke({ referenceId });
        } catch (error) {
          backendFailure = { error };
        }
        try {
          await closeRevokedCredentialBindings(dependencies, { referenceId });
        } catch (cleanupError) {
          if (backendFailure)
            throw new OperationError(
              'recovery_required',
              'Vault revocation requires runtime inspection before a new request.',
              409,
              { cause: new AggregateError([backendFailure.error, cleanupError]) }
            );
          throw cleanupError;
        }
        if (backendFailure) throw backendFailure.error;
        await audit('succeeded');
        return projectReference(result);
      }
      validateInventory();
      if (action === 'grant') {
        if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
          return vaultFailure('Grant expiry must be in the future.', 'invalid_request', 400);
        if (input.injectionPath === 'runtime-env' && reference.secretKind !== 'github-token')
          return vaultFailure(
            'Worker GitHub grant requires a GitHub token.',
            'invalid_request',
            400
          );
        const workerVisible =
          input.injectionPath === 'runtime-env' || input.injectionPath === 'runtime-file';
        if (workerVisible && input.targetCapabilityId !== undefined)
          return vaultFailure(
            'Worker-visible credential grants cannot prove a capability target.',
            'invalid_request',
            400
          );
        const grant = await publicMutation(
          'grant-create',
          {
            grantId: allocateEntityId('grant'),
            vaultReferenceId: referenceId,
            ownerScope: 'workspace',
            workspaceId,
            allowedInjectionPaths: [input.injectionPath ?? 'gateway-only'],
            targetAgentId: input.targetAgentId ?? null,
            targetAgentSessionId: input.targetAgentSessionId ?? null,
            targetCapabilityId: input.targetCapabilityId ?? null,
            lifetime: 'workspace',
            subjectSummary:
              input.injectionPath === 'runtime-file'
                ? 'High-risk static Worker file'
                : workerVisible
                  ? 'Worker GitHub CLI'
                  : 'Gateway-only credential',
            expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
          },
          c,
          reference
        );
        await audit('succeeded');
        return grant as WorkspaceVaultGrant;
      }
      const rotated = backend.rotate({ referenceId, material: input.material! });
      const result = await publicMutation(
        'reference-advance',
        {
          referenceId,
          currentVersion: rotated.currentVersion,
        },
        c,
        reference
      );
      await audit('succeeded');
      return projectReference(result);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      const unknown = error instanceof ControlStoreWorkerError && error.commit === 'unknown';
      if (storedReferenceId && !unknown) {
        try {
          backend.revoke({ referenceId: storedReferenceId });
        } catch {
          /* Failed cleanup requires inspection. */
        }
      }
      try {
        await audit('failed');
      } catch (auditError) {
        if (!unknown) throw auditError;
        // An unacknowledged original stage stays unknown even if later failure evidence also refuses.
      }
      return vaultFailure(
        'Vault mutation failed; inspect inventory before a new request.',
        'vault_mutation_failed',
        409,
        error
      );
    }
  }

  /** Retained Server shared-MCP history stays scoped to the current supported reference family. */
  function serverMcpGrantIds(): string[] {
    if (!coreDb) return vaultFailure('Core DB is not available.', 'not_found', 404);
    return listVaultGrants(coreDb)
      .filter(
        (grant) =>
          grant.ownerScope === 'server' &&
          isServerMcpReference(getVaultReference(coreDb, grant.vaultReferenceId))
      )
      .map((grant) => grant.grantId);
  }

  return {
    ...createVaultGrantRequestImplementations(dependencies, governReviewedGrantIssue),
    'vault.binding-deliver': async (input, context) => {
      const result = await bindingOperation('deliver', input, context);
      if (!('realizedProtection' in result))
        throw new OperationError(
          'recovery_required',
          'Credential binding requires inspection.',
          409
        );
      return result;
    },
    'vault.binding-replace': async (input, context) => {
      const result = await bindingOperation('replace', input, context);
      if (!('realizedProtection' in result))
        throw new OperationError(
          'recovery_required',
          'Credential binding requires inspection.',
          409
        );
      return result;
    },
    'vault.binding-revoke': async (input, context) => {
      const result = await bindingOperation('revoke', input, context);
      if (!('state' in result))
        throw new OperationError(
          'recovery_required',
          'Credential binding requires inspection.',
          409
        );
      return result;
    },
    'vault.server-mcp-injection-plan-list': () => ({
      items: listExportableVaultInjectionPlans(coreDb!, serverMcpGrantIds()),
    }),
    'vault.server-mcp-injection-receipt-list': () => ({
      items: listExportableVaultInjectionReceipts(
        coreDb!,
        listExportableVaultInjectionPlans(coreDb!, serverMcpGrantIds()).map((plan) => plan.planId)
      ),
    }),
    'vault.status': () => {
      return vaultAdminStatus();
    },
    'vault.provider-api-key-set': async (input, c) => {
      if (!vaultUnlockState || !coreDb || !dataRoot) {
        return vaultFailure('Vault storage is not configured.', 'vault_storage_unavailable', 503);
      }

      const providerId = input.providerId;
      const safeProviderId = ProviderApiKeyProfileIdSchema.safeParse(providerId);

      if (!safeProviderId.success) {
        return providerApiKeyError(
          c,
          'Provider id is not supported for API-key configuration.',
          'provider_api_key_not_supported',
          400
        );
      }
      const response = { configured: true as const, providerId };
      let loaded: ReturnType<typeof loadProviderProfiles>;

      try {
        loaded = loadProviderProfiles(dataRoot);
      } catch (error) {
        if (error instanceof OperationError) throw error;
        return providerApiKeyError(
          c,
          'Provider profile configuration is invalid.',
          'provider_configuration_invalid',
          409
        );
      }
      const matchingProfiles = loaded.profiles.filter((candidate) => candidate.id === providerId);
      const hasProfileDiagnostic = loaded.diagnostics.some(
        (diagnostic) => diagnostic.profileId === providerId
      );

      if (matchingProfiles.length === 0 && !hasProfileDiagnostic) {
        return providerApiKeyError(c, 'Provider profile not found.', 'provider_not_found', 404);
      }
      if (matchingProfiles.length !== 1 || hasProfileDiagnostic) {
        return providerApiKeyError(
          c,
          'Provider profile configuration is invalid.',
          'provider_configuration_invalid',
          409
        );
      }

      const profile = matchingProfiles[0]!;
      const referenceId = profile.secretRef ? readVaultReferenceId(profile.secretRef) : null;

      if (
        !referenceId ||
        !isEntityId('vault', referenceId) ||
        !SAFE_PROVIDER_API_KEY_REFERENCE_ID.test(referenceId)
      ) {
        return providerApiKeyError(
          c,
          'Provider profile does not use a supported Vault API-key reference.',
          'provider_api_key_not_supported',
          400
        );
      }
      if (providerApiKeyWrites.has(referenceId)) {
        return providerApiKeyError(
          c,
          'Provider API-key update is already in progress.',
          'provider_api_key_update_active',
          409,
          'denied'
        );
      }

      providerApiKeyWrites.add(referenceId);
      let storedNewMaterial = false;

      try {
        const backend = vaultUnlockState.backend();

        if (backend.health().state !== 'available') {
          return providerApiKeyError(
            c,
            'Vault backend is not available.',
            'vault_backend_not_available',
            423
          );
        }

        let reference = getVaultReference(coreDb, referenceId);
        const inventory = backend
          .listReferences({ ownerScope: 'server' })
          .find((candidate) => candidate.referenceId === referenceId);

        if (Boolean(reference) !== Boolean(inventory)) {
          return providerApiKeyError(
            c,
            'Provider API-key storage requires recovery.',
            'provider_api_key_recovery_required',
            409
          );
        }

        if (!reference && !inventory) {
          const stored = backend.store({
            material: input.apiKey,
            metadata: { ownerScope: 'server' },
            referenceId,
          });
          storedNewMaterial = true;

          if (stored.currentVersion !== 1 || stored.revoked) {
            throw new Error('Provider API-key Vault store returned an invalid initial version.');
          }

          const created = await publicMutation(
            'reference-create',
            {
              backendKind: backend.kind,
              backendLocator: `${backend.kind}://server/vault/${referenceId}`,
              displayName: 'Provider API key',
              ownerScope: 'server',
              referenceId,
              secretKind: 'provider-api-key',
            },
            c
          );

          if (!created.inserted) {
            throw new Error('Provider API-key Vault reference already exists.');
          }
          reference = created.reference;
          storedNewMaterial = false;
        } else if (reference && inventory) {
          const exactReference =
            reference.ownerScope === 'server' &&
            reference.workspaceId === null &&
            reference.userId === null &&
            reference.displayName === 'Provider API key' &&
            reference.secretKind === 'provider-api-key' &&
            reference.backendKind === backend.kind &&
            reference.backendLocator === `${backend.kind}://server/vault/${referenceId}` &&
            reference.status === 'active';
          const exactInventory =
            inventory.ownerScope === 'server' &&
            inventory.backendKind === backend.kind &&
            !inventory.revoked &&
            inventory.workspaceId === undefined &&
            inventory.userId === undefined &&
            inventory.providerSubscriptionAccount === undefined;

          if (!exactReference || !exactInventory) {
            return providerApiKeyError(
              c,
              'Provider API-key storage requires recovery.',
              'provider_api_key_recovery_required',
              409
            );
          }
          if (inventory.currentVersion === reference.currentVersion + 1) {
            reference = await publicMutation(
              'reference-advance',
              {
                currentVersion: inventory.currentVersion,
                referenceId,
              },
              c,
              reference
            );
          } else if (inventory.currentVersion !== reference.currentVersion) {
            return providerApiKeyError(
              c,
              'Provider API-key storage requires recovery.',
              'provider_api_key_recovery_required',
              409
            );
          }

          await c.recheckAdmission?.();
          const rotated = backend.rotate({ material: input.apiKey, referenceId });
          reference = await publicMutation(
            'reference-advance',
            {
              currentVersion: rotated.currentVersion,
              referenceId,
            },
            c,
            reference
          );
        }

        if (!reference) {
          throw new Error('Provider API-key Vault reference was not stored.');
        }

        await recordVaultAdminAudit(c, {
          action: 'vault.set_provider_api_key',
          outcome: 'succeeded',
          summary: 'Provider API-key configuration succeeded.',
        });

        return response;
      } catch (error) {
        if (error instanceof OperationError) throw error;
        const unknown = error instanceof ControlStoreWorkerError && error.commit === 'unknown';
        let recoveryRequired = unknown;

        if (storedNewMaterial && !unknown) {
          recoveryRequired = true;
          try {
            vaultUnlockState.backend().revoke({ referenceId });
          } catch (error) {
            if (error instanceof OperationError) throw error;
            // The failed write remains recovery-required whether cleanup settles or not.
          }
        }

        try {
          await recordVaultAdminAudit(c, {
            action: 'vault.set_provider_api_key',
            errorCode: recoveryRequired
              ? 'provider_api_key_recovery_required'
              : 'provider_api_key_persistence_failed',
            outcome: 'failed',
            summary: 'Provider API-key configuration failed.',
          });
        } catch (auditError) {
          if (!unknown) throw auditError;
          // Secondary evidence cannot establish rollback of the unacknowledged original stage.
        }

        return recoveryRequired
          ? vaultFailure(
              'Provider API-key storage requires recovery.',
              'provider_api_key_recovery_required',
              409,
              error
            )
          : vaultFailure(
              'Provider API-key configuration failed.',
              'provider_api_key_persistence_failed',
              500,
              error
            );
      } finally {
        providerApiKeyWrites.delete(referenceId);
      }
    },
    'vault.server-use-list': () => {
      try {
        if (!coreDb) {
          return vaultFailure('Core DB is not available.', 'not_found', 404);
        }

        return {
          vaultUseRecords: listVaultUseRecords(coreDb),
        } as OperationOutput<'vault.server-use-list'>;
      } catch (error) {
        vaultReadFailure(error);
      }
    },
    'vault.unlock': async (_input, c) => {
      const unlockState = vaultUnlockState;

      if (!unlockState) {
        return vaultAdminUnavailableError();
      }

      if (isVaultUnlockRateLimited(c)) {
        await recordVaultAdminAudit(c, {
          action: 'vault.unlock',
          errorCode: 'vault_unlock_rate_limited',
          outcome: 'denied',
          summary: 'Vault unlock denied because recent failed attempts exceeded the limit.',
        });

        return vaultFailure('Vault unlock rate limit exceeded.', 'vault_unlock_rate_limited', 429);
      }

      let masterKey: Buffer | undefined;

      try {
        const keyFilePath =
          dependencies.runtimeConfigManager?.current().openKitConfig.vault?.encryptedFile
            ?.keyFilePath;
        if (!dataRoot || !keyFilePath) throw new Error('Vault unlock source is unavailable.');
        masterKey = loadEncryptedFileVaultKeyFile({ dataRoot, keyFilePath });
        unlockState.unlock({ masterKey });
        clearVaultUnlockFailures(c);
        await recordVaultAdminAudit(c, {
          action: 'vault.unlock',
          outcome: 'succeeded',
          summary: 'Vault unlock succeeded.',
        });

        return vaultAdminStatus();
      } catch (error) {
        if (error instanceof OperationError) throw error;
        rememberVaultUnlockFailure(c);
        await recordVaultAdminAudit(c, {
          action: 'vault.unlock',
          errorCode: 'vault_unlock_failed',
          outcome: 'failed',
          summary: 'Vault unlock failed.',
        });

        return vaultFailure('Vault unlock failed.', 'vault_unlock_failed', 400);
      } finally {
        masterKey?.fill(0);
      }
    },
    'vault.bootstrap-codex-auth': async (input, c) => {
      if (c.delivery !== 'human') vaultWorkspaceAccessDenied();
      const referenceId = allocateEntityId('vault');
      return governedUserVaultOperation(
        'vault.bootstrap-codex-auth',
        c,
        (actor) => {
          const kernel = evaluateOwnedUserOperation(
            coreDb!,
            actor,
            actor.userId,
            'vault.admin',
            true
          );
          if (kernel.effect !== 'allow') vaultWorkspaceAccessDenied();
          return { kernel };
        },
        () => ({ referenceId }),
        async (_selected, actor, beforeSubmit) => {
          const backend = vaultUnlockState?.backend();
          if (!backend || backend.health().state !== 'available')
            return vaultFailure(
              'Vault backend is not available.',
              'vault_backend_not_available',
              423
            );

          // Only the stock provider refresh is trusted to establish account equality.
          // Submitted account metadata is checked against that result, never used as authority.
          let material: string;
          let accountId: string;
          try {
            const decoded = z
              .object({
                tokens: z
                  .object({
                    access_token: z.string().min(1),
                    refresh_token: z.string().min(1),
                    account_id: z.string().min(1),
                  })
                  .passthrough(),
              })
              .passthrough()
              .parse(JSON.parse(Buffer.from(input.authJsonBase64, 'base64').toString('utf8')));
            const refreshed = await openaiCodexProvider().auth.oauth!.refresh(
              {
                type: 'oauth',
                access: decoded.tokens.access_token,
                refresh: decoded.tokens.refresh_token,
                expires: 0,
                accountId: decoded.tokens.account_id,
              },
              c.signal ?? new AbortController().signal
            );
            if (
              typeof refreshed.accountId !== 'string' ||
              !refreshed.accountId ||
              refreshed.accountId !== decoded.tokens.account_id ||
              !refreshed.access ||
              !refreshed.refresh
            )
              throw new Error('Codex account verification failed.');
            accountId = refreshed.accountId;
            material = JSON.stringify({
              ...decoded,
              tokens: {
                ...decoded.tokens,
                access_token: refreshed.access,
                refresh_token: refreshed.refresh,
                account_id: accountId,
              },
              last_refresh: new Date().toISOString(),
            });
          } catch {
            return vaultFailure(
              'Codex auth JSON bootstrap failed.',
              'vault_codex_auth_json_bootstrap_failed',
              400
            );
          }

          // Refresh, private material storage and native metadata publication remain separate effects.
          // Recheck the same accepted decision at both existing effect boundaries.
          await beforeSubmit();
          if (vaultUnlockState?.backend() !== backend || backend.health().state !== 'available')
            return vaultFailure(
              'Vault backend is not available.',
              'vault_backend_not_available',
              423
            );
          backend.store({
            material,
            referenceId,
            metadata: { ownerScope: 'user', userId: actor.userId },
          });
          const result = await getControlStoreWorkerClient().vault(
            coreDb!,
            'reference-create',
            {
              referenceId,
              ownerScope: 'user',
              userId: actor.userId,
              displayName: 'Codex harness Login',
              secretKind: 'codex-auth-json',
              backendKind: backend.kind,
              backendLocator: `${backend.kind}://server/vault/${referenceId}`,
              login: { provider: 'codex', accountId, quarantined: false },
              publicMutation: { actor },
            },
            beforeSubmit
          );
          return projectLogin(result.reference);
        }
      );
    },
    'vault.reference-rebind': async (input, c) => {
      const unlockState = vaultUnlockState;

      if (!unlockState) {
        return vaultAdminUnavailableError();
      }
      if (!coreDb) {
        return vaultFailure('Vault storage is not configured.', 'vault_storage_unavailable', 503);
      }

      const workspaceId = input.workspaceId;
      const referenceId = input.referenceId;

      const reference = getVaultReference(coreDb, referenceId);

      if (!reference) {
        return vaultFailure(
          'Workspace vault reference not found.',
          'vault_reference_not_found',
          404
        );
      }
      if (reference.workspaceId !== workspaceId) vaultWorkspaceAccessDenied();
      if (reference.ownerScope !== 'workspace' || reference.workspaceId !== workspaceId) {
        return vaultFailure(
          'Workspace vault reference not found.',
          'vault_reference_not_found',
          404
        );
      }
      if (reference.status !== 'unbound') {
        return vaultFailure(
          'Workspace vault reference is not unbound.',
          'vault_reference_not_unbound',
          409
        );
      }

      const backend = unlockState.backend();
      const health = backend.health();

      if (health.state !== 'available') {
        await recordVaultAdminAudit(c, {
          action: 'vault.rebind_workspace_reference',
          errorCode: 'vault_backend_not_available',
          outcome: 'failed',
          summary:
            'Workspace vault reference rebind failed because the vault backend is not available.',
        });

        return vaultFailure('Vault backend is not available.', 'vault_backend_not_available', 423);
      }

      try {
        const inventory = backend.store({
          material: Buffer.from(input.materialBase64, 'base64'),
          metadata: { ownerScope: 'workspace', workspaceId },
          referenceId,
        });
        const rebound = await publicMutation(
          'reference-rebind',
          {
            backendKind: backend.kind,
            backendLocator: `${backend.kind}://workspace/${workspaceId}/vault/${referenceId}`,
            currentVersion: inventory.currentVersion,
            referenceId,
            workspaceId,
          },
          c,
          reference
        );

        await recordVaultAdminAudit(c, {
          action: 'vault.rebind_workspace_reference',
          outcome: 'succeeded',
          summary: 'Workspace vault reference rebind succeeded.',
        });

        return {
          backendKind: rebound.backendKind,
          currentVersion: rebound.currentVersion,
          ownerScope: rebound.ownerScope,
          referenceId: rebound.referenceId,
          secretKind: rebound.secretKind,
          status: rebound.status,
          workspaceId: rebound.workspaceId,
        } as OperationOutput<'vault.reference-rebind'>;
      } catch (error) {
        if (error instanceof OperationError) throw error;
        await recordVaultAdminAudit(c, {
          action: 'vault.rebind_workspace_reference',
          errorCode: 'vault_reference_rebind_failed',
          outcome: 'failed',
          summary: 'Workspace vault reference rebind failed.',
        });

        return vaultFailure(
          'Workspace vault reference rebind failed.',
          'vault_reference_rebind_failed',
          400
        );
      }
    },
    'vault.reference-list': (input) => {
      if (!coreDb) {
        return vaultFailure('Vault storage is not configured.', 'vault_storage_unavailable', 503);
      }

      const workspaceId = input.workspaceId;
      const items = listWorkspaceVaultReferences(coreDb, workspaceId).map((reference) => ({
        backendKind: reference.backendKind,
        currentVersion: reference.currentVersion,
        ownerScope: reference.ownerScope,
        referenceId: reference.referenceId,
        secretKind: reference.secretKind,
        status: reference.status,
        workspaceId: reference.workspaceId,
      }));

      return {
        items,
        workspaceId,
      } as OperationOutput<'vault.reference-list'>;
    },
    'vault.use-list': (input) => {
      try {
        const workspaceId = input.workspaceId;
        const workspaceDb = repositoryWorkspaceDb!(workspaceId);

        try {
          return {
            workspaceId,
            vaultUseRecords: listExportableWorkspaceVaultUseRecords(workspaceDb, workspaceId),
          } as OperationOutput<'vault.use-list'>;
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        vaultReadFailure(error);
      }
    },
    'vault.lock': async (_input, c) => {
      const unlockState = vaultUnlockState;

      if (!unlockState) {
        return vaultAdminUnavailableError();
      }

      unlockState.lock();
      await recordVaultAdminAudit(c, {
        action: 'vault.lock',
        outcome: 'succeeded',
        summary: 'Vault lock succeeded.',
      });

      return vaultAdminStatus();
    },
    'vault.grant-list': (input) => {
      try {
        const workspaceId = input.workspaceId;
        dependencies.store!.getWorkspace(workspaceId);

        if (!coreDb) {
          return vaultFailure('Core DB is not available.', 'not_found', 404);
        }

        return {
          workspaceId,
          items: listExportableWorkspaceVaultGrants(coreDb, workspaceId),
        } as OperationOutput<'vault.grant-list'>;
      } catch (error) {
        vaultReadFailure(error);
      }
    },
    'vault.injection-plan-list': (input, context) =>
      inspectBindings('vault.injection-plan-list', input, context) as Promise<
        OperationOutput<'vault.injection-plan-list'>
      >,
    'vault.injection-receipt-list': (input, context) =>
      inspectBindings('vault.injection-receipt-list', input, context) as Promise<
        OperationOutput<'vault.injection-receipt-list'>
      >,
    'vault.secret-create': (input, c) => mutate(input, c, 'create'),
    'vault.secret-rotate': (input, c) => mutate(input, c, 'rotate'),
    'vault.secret-revoke': (input, c) => mutate(input, c, 'revoke'),
    'vault.grant-create': (input, c) => mutate(input, c, 'grant'),
    'vault.grant-withdraw': (input, c) => withdrawOwnedGrant(input, c),
    'vault.login-list': (input, c) =>
      personalLoginOperation('vault.login-list', input, c) as Promise<
        OperationOutput<'vault.login-list'>
      >,
    'vault.login-quarantine': (input, c) =>
      personalLoginOperation('vault.login-quarantine', input, c) as Promise<
        OperationOutput<'vault.login-quarantine'>
      >,
    'vault.login-release': (input, c) =>
      personalLoginOperation('vault.login-release', input, c) as Promise<
        OperationOutput<'vault.login-release'>
      >,
    'vault.grant-narrow': async (input, c) => {
      const actor = publicOperationActor(c);
      if (!isDeploymentAdminActor(actor))
        return vaultFailure('Vault administration is forbidden.', 'deployment_admin_required', 403);
      if (!coreDb || !vaultUnlockState)
        return vaultFailure('Vault storage is unavailable.', 'vault_storage_unavailable', 503);
      const source = getVaultGrant(coreDb, input.grantId);
      if (!source || source.ownerScope !== 'workspace' || source.workspaceId !== input.workspaceId)
        return vaultFailure('Vault grant not found.', 'vault_grant_not_found', 404);
      const reference = getVaultReference(coreDb, source.vaultReferenceId);
      if (
        !reference ||
        reference.ownerScope !== 'workspace' ||
        reference.workspaceId !== input.workspaceId ||
        reference.userId !== null
      )
        return vaultFailure('Vault reference is not current.', 'vault_reference_not_active', 409);
      if (
        source.lifetime !== 'workspace' ||
        source.userId !== null ||
        source.allowedInjectionPaths.length !== 1 ||
        !['gateway-only', 'runtime-env', 'runtime-file'].includes(
          source.allowedInjectionPaths[0]!
        ) ||
        (source.allowedInjectionPaths[0] === 'runtime-env' &&
          (reference.secretKind !== 'github-token' ||
            input.constraints.targetCapabilityId !== undefined ||
            source.targetCapabilityId !== null)) ||
        (source.allowedInjectionPaths[0] === 'runtime-file' &&
          (input.constraints.targetCapabilityId !== undefined ||
            source.targetCapabilityId !== null)) ||
        (source.targetCapabilityId !== null &&
          !['mcp.list-tools', 'mcp.call-tool'].includes(source.targetCapabilityId))
      )
        return vaultFailure('Grant shape is not supported for narrowing.', 'invalid_request', 400);
      try {
        const replacementGrantId = allocateEntityId('grant');
        const evidence = prepareVaultAdminAudit({
          actor,
          action: 'vault.workspace_narrow-grant',
          backendKind: vaultUnlockState.backend().kind,
          outcome: 'succeeded',
          summary:
            'Workspace Vault grant narrowed through replacement. Explicit binding update is required.',
          workspaceId: input.workspaceId,
          resource: `vault-grant:${source.grantId}`,
          vaultGrantId: replacementGrantId,
        });
        const result = await getControlStoreWorkerClient().vault(
          coreDb,
          'workspace-grant-narrow',
          {
            grant: { grantId: source.grantId, replacementGrantId, constraints: input.constraints },
            publicMutation: { actor, workspaceId: input.workspaceId, reference },
            ...evidence,
          },
          async () => {
            await c.recheckAdmission?.();
          }
        );
        await closeRevokedCredentialBindings(dependencies, { grantId: source.grantId });
        return result as OperationOutput<'vault.grant-narrow'>;
      } catch (error) {
        if (error instanceof OperationError) throw error;
        if (error instanceof VaultGrantNarrowingError)
          return vaultFailure(
            error.message,
            error.status === 400 ? 'invalid_request' : 'vault_grant_not_active',
            error.status
          );
        return vaultFailure(
          'Vault grant narrowing failed; inspect inventory before a new request.',
          'vault_mutation_failed',
          409
        );
      }
    },
    'vault.grant-revoke': (input, c) => mutate(input, c, 'revoke-grant'),
  } satisfies FamilyImplementations<typeof VAULT_OPERATION_DEFINITIONS>;
}
/** Public Login projection deliberately omits account equality, backend metadata and material. */
function projectLogin(reference: VaultReferenceRecord): VaultLoginView {
  if (!reference.login) vaultWorkspaceAccessDenied();
  return {
    referenceId: reference.referenceId,
    provider: reference.login.provider,
    status: reference.status,
    currentVersion: reference.currentVersion,
    quarantined: reference.login.quarantined,
    observations: null,
  };
}

/** Select public metadata explicitly, excluding backend locators and display content; native Workspace creation and ownership checks establish the narrower type, and shared framing validates it. */
function projectReference(reference: NonNullable<ReturnType<typeof getVaultReference>>) {
  const { backendKind, currentVersion, ownerScope, referenceId, secretKind, status, workspaceId } =
    reference;
  return {
    backendKind,
    currentVersion,
    ownerScope,
    referenceId,
    secretKind,
    status,
    workspaceId,
  } as VaultAdminWorkspaceReference;
}

/** Uses the existing Vault failure owner for every non-enumerating Workspace access refusal. */
function vaultWorkspaceAccessDenied(): never {
  vaultFailure(
    WORKSPACE_ACCESS_DENIED.message,
    WORKSPACE_ACCESS_DENIED.code,
    WORKSPACE_ACCESS_DENIED.status
  );
}

/** Publishes only fixed Vault refusal fields; backend causes stay inside their existing safe boundary. */
function vaultFailure(message: string, code: string, status: number, cause?: unknown): never {
  throw new OperationError(code, message, status, cause === undefined ? {} : { cause });
}
/** Classifies only retained decoder and unavailable-record failures; unexpected read failures escape. */
function vaultReadFailure(error: unknown): never {
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    throw new OperationError('not_found', 'The retained record could not be read.', 404, {
      cause: error,
    });
  if (error instanceof StoreRecordNotFoundError)
    throw new OperationError('not_found', error.message, 404, { cause: error });
  throw error;
}

/** Projects existing trusted invocation identity without callbacks, material or an allow decision. */
function vaultRequesterForContext(context: AdmittedOperationContext): VaultBindingRequester {
  return context.kind === 'worker'
    ? {
        kind: 'worker',
        actor: context.actor,
        lineage: {
          workspaceId: context.lineage.workspaceId,
          threadId: context.lineage.threadId,
          turnId: context.lineage.turnId,
          agentSessionId: context.lineage.agentSessionId,
          packageSnapshotId: context.lineage.packageSnapshotId,
        },
      }
    : { kind: 'public', actor: context.actor, actorRef: context.actorRef };
}
