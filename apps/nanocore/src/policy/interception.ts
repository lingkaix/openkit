import { isDeepStrictEqual } from 'node:util';
import {
  type RuntimeConfigFileReadResponse,
  VAULT_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import type { PolicyDecision } from '@openkit/policy-kernel';
import {
  allocateEntityId,
  isSealedTurnTerminal,
  POLICY_OPERATION_REFERENCE_INPUT_V1,
  PolicyAgentGateOutputV1Schema,
  type PolicyApprovalBindingV1Schema,
  type PolicyBindingV1,
  type PolicyDecisionV1,
  type PolicyDocumentV1,
  type PolicyInvocationV1,
  type PolicyPermissionV1Schema,
  PolicySubjectV1Schema,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import { z } from 'zod';
import { prepareAuditEvent } from '../audit-events.js';
import {
  currentWorkspaceAuthority,
  evaluateCoreConfirmedLoginQuarantine,
  isCurrentServerPolicyAuthor,
  readCurrentWorkspacePolicy,
} from '../auth/operation-authorizer.js';
import type { ThreadVisibilityReadPort } from '../auth/thread-visibility.js';
import { parseJsoncObject } from '../config/jsonc.js';
import { RuntimeConfigFileServiceError } from '../config/runtime-config-files.js';
import type { requireAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { GoalCommandError } from '../runtime/goal-error.js';
import { requireNativeCoordinatorGoal } from '../runtime/goal-owner.js';
import {
  type GoalTaskPolicyReadPort,
  readGoalTaskPolicyContext,
} from '../runtime/goal-task-policy-context.js';
import { readVaultRequesterAuthority } from '../runtime/worker-credential-authority.js';
import type { SchedulerExecutionLineage } from '../scheduler-records.js';
import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  nativeUserDatabasePath,
} from '../storage/control-store-worker-client.js';
import type { CoreDb, UserDb, WorkspaceDb } from '../storage/db.js';
import type { NativeRuntimePolicyPublication } from '../storage/runtime-policy-publication.js';
import type { PermissionDecisionResult } from '../storage/schema/permission-decisions.js';
import type {
  ControlVaultInput,
  VaultBindingPolicyProof,
  VaultBindingRequester,
} from '../storage/vault-native-codecs.js';
import { readAdmittedPolicyDocument } from './configuration.js';
import { createGoalDomainPolicyService } from './goal-domains.js';
import type { GoalTaskAccessResult } from './goal-task-access.js';
import { createGoalTaskPolicyService } from './goal-task-policy.js';
import {
  type PolicyUseDecision,
  policyStatementUsedByDecision,
  type RecordProductPermissionDecisionInput,
  readPolicyStatementUseCount,
  recordProductPermissionDecision,
} from './permission-decisions.js';
import { readAuditEventRowV1, readPermissionDecisionRowV1 } from './retained-records-v1.js';
import {
  EMPTY_POLICY_DOCUMENT,
  type PolicyProposal,
  policyDigest,
  policyOperationDefinition,
  policyProposalDigest,
  policyResourceUser,
  policyResourceWorkspace,
  policyScopeIncludesProposal,
  readPolicyAgentPrincipal,
  selectPolicyBindings,
} from './statements.js';

const GateOutput = z.object({ decision: z.enum(['allow', 'deny', 'escalate']) }).strict();
const ObservationOutput = z.object({ observed: z.literal(true) }).strict();
type InvocationReference = PolicyDecisionV1['invocations'][number];

/** One injected deterministic participant; this is not a provider adapter or loader. */
export interface DeterministicPolicyParticipant {
  readonly id: string;
  readonly version: string;
  invoke(input: {
    readonly binding: PolicyBindingV1;
    readonly proposal: PolicyProposal;
    readonly advice: readonly unknown[];
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/** A single bounded native agent runner; optional selectors are useful for isolated transport fakes. */
export interface AgentPolicyParticipant {
  readonly id?: string;
  readonly version?: string;
  invoke: DeterministicPolicyParticipant['invoke'];
}

/** Current owner facts and existing durable owner used by the I16 pilot. */
interface InterceptionFacts {
  readonly document: PolicyDocumentV1;
  readonly proposal: PolicyProposal;
  readonly authorizationRevision: string;
  /** Current conditions selected by the operation's existing resource owner. */
  readonly permissions?: readonly z.infer<typeof PolicyPermissionV1Schema>[];
  /** Explicit safe evidence projections retained by the existing decision owner. */
  readonly resourceSummary?: Readonly<Record<string, unknown>>;
  readonly contextSummary?: Readonly<Record<string, unknown>>;
  /** Existing approved command lineage; this does not assert a mediated human-approval source. */
  readonly decisionLineage?: {
    readonly requestId: string;
    readonly approvalId: string;
  };
  /** Current finite grants used by the native mandatory Kernel adapter, not participant results. */
  readonly authorizationUses?: RecordProductPermissionDecisionInput['uses'];
  /** Exact human response context supplied only by the existing captured approval owner. */
  readonly humanApproval?: {
    readonly requestId: string;
    readonly sourceDecisionId: string;
    readonly deciderId: string;
    readonly binding: z.infer<typeof PolicyApprovalBindingV1Schema>;
  };
  readonly authorCurrent: (userId: string) => boolean;
  readonly anchorCurrent: (anchor: PolicyBindingV1['lifetime']['anchor']) => boolean;
  /** Kernel-only participant admission: no bindings or investigative recursion. */
  readonly participantAuthorized: (binding: PolicyBindingV1) => boolean;
  /** A changed Policy, input, current authority or binding invalidates this attempt. */
  readonly stillCurrent: () => boolean;
  /** Actual pure synchronous Kernel evaluation is always last, including after a gate deny. */
  readonly finalKernel: (context: {
    readonly proposal: PolicyProposal;
    readonly advice: readonly unknown[];
  }) => PolicyDecision | GoalTaskAccessResult;
}

/** Same interception owners, with an explicit actual database home. */
export type InterceptionInput = InterceptionFacts &
  (
    | { readonly workspaceDb: WorkspaceDb; readonly userDb?: never }
    | { readonly userDb: UserDb; readonly workspaceDb?: never }
  );

/** A final allow is permission to attempt the effect, not an effect result. */
export interface InterceptionDecision {
  readonly result: PermissionDecisionResult;
  readonly decisionId: string;
  readonly proposalDigest: string;
  readonly policyRevision: string;
  readonly authorizationRevision: string;
  /** Present only for the current Goal Task association gap, never a human/participant refusal. */
  readonly escalation?: GoalTaskAccessResult['escalation'];
}

/** Bounded process-local availability state; restart never replays participant work. */
export class PolicyInterception {
  private readonly circuits = new Map<
    string,
    { failures: number; retryAt: number; probing: boolean }
  >();

  constructor(
    private readonly participant?: DeterministicPolicyParticipant,
    private readonly agentParticipant?: AgentPolicyParticipant
  ) {}

  /** Repeats the actual caller, Coordinator and optional Task composition for all governed Vault operations. */
  static readVaultAuthority(input: {
    readonly coreDb: CoreDb;
    readonly workspaceDb: WorkspaceDb;
    readonly workspaceId: string;
    readonly requester: VaultBindingRequester;
    readonly coordinator: Parameters<typeof requireNativeCoordinatorGoal>[1] | null;
    readonly worker: {
      readonly lineage: SchedulerExecutionLineage;
      readonly goalLinked: boolean;
    } | null;
    readonly subject: PolicyProposal['subject'];
    readonly resource: PolicyProposal['resource'];
    readonly operation: string;
    readonly mutating: boolean;
    readonly taskPolicy:
      | Pick<ReturnType<typeof createGoalTaskPolicyService>, 'evaluateTask' | 'readTaskDecision'>
      | null
      | undefined;
    readonly decision?: PolicyUseDecision;
  }): {
    kernel: PolicyDecision;
    goal: GoalTaskAccessResult | null;
    revision: string;
    authorizationUses: InterceptionInput['authorizationUses'];
    callerRevision: string;
    coordinator: ReturnType<typeof requireNativeCoordinatorGoal> | null;
  } {
    const evaluated = readVaultRequesterAuthority(
      input.coreDb,
      input.workspaceId,
      input.requester,
      input.operation,
      input.mutating
    );
    const currentCoordinator = input.coordinator
      ? requireNativeCoordinatorGoal(input.workspaceDb, input.coordinator)
      : null;
    const goalInput = input.worker
      ? {
          workspaceDb: input.workspaceDb,
          lineage: input.worker.lineage,
          subject: input.subject,
          operation: input.operation,
          resource: input.resource,
          humanKernel: evaluated.decision,
        }
      : null;
    let goal: GoalTaskAccessResult | null = null;
    let authorizationUses: InterceptionInput['authorizationUses'] = [];
    if (input.taskPolicy && goalInput) {
      if (input.decision)
        goal = input.taskPolicy.readTaskDecision({ ...goalInput, decision: input.decision });
      else {
        const evaluatedTask = input.taskPolicy.evaluateTask(goalInput);
        goal = evaluatedTask;
        authorizationUses = evaluatedTask?.authorizationUses ?? [];
      }
    }
    if (input.worker?.goalLinked && !goal)
      throw new Error('Current Goal Task authority is unavailable.');
    return {
      kernel: goal?.kernel ?? evaluated.decision,
      goal,
      revision: policyDigest({
        caller: evaluated,
        goalTask: goal?.authorizationRevision ?? null,
        coordinator: currentCoordinator,
      }),
      authorizationUses,
      callerRevision: policyDigest(evaluated),
      coordinator: currentCoordinator,
    };
  }

  /** Reads the original Login intent before native physical preparation, without granting an effect. */
  static readVaultBindingIntent(
    kind: 'reference-advance' | 'receipt-create' | 'reference-login-state',
    binding: NonNullable<
      Extract<ControlVaultInput, { kind: 'receipt-create' }>['record']['loginBinding']
    >
  ): { proof: VaultBindingPolicyProof; requester: VaultBindingRequester } {
    const proof = binding.policyProof;
    if (
      !proof ||
      (kind === 'reference-login-state' && proof.caller.kind !== 'worker') ||
      binding.binding.declaration.visibility !== 'runtime-token' ||
      binding.binding.declaration.consumer !== 'codex-login'
    )
      throw new ControlProductPreconditionError();
    const consumer = binding.binding.consumer;
    const workspaceId = consumer.scope.workspaceId;
    const caller = proof.caller;
    const requester: VaultBindingRequester =
      caller.kind === 'worker'
        ? { kind: 'worker', actor: caller.actor, lineage: caller.lineage }
        : { kind: 'public', actor: caller.actor, actorRef: caller.actorRef };
    const proposal = proof.proposal;
    const originalVersion = proposal.inputAttributes.materialVersion;
    const refresh = binding.refreshContext;
    const successorOffset = kind === 'receipt-create' ? 1 : 0;
    // Delivery stages retain their original receipt; failed refresh remains at original X.
    if (
      typeof originalVersion !== 'number' ||
      !Number.isSafeInteger(originalVersion) ||
      originalVersion < 1 ||
      !Number.isSafeInteger(originalVersion + successorOffset) ||
      originalVersion + successorOffset !== binding.binding.materialVersion
    )
      throw new ControlProductPreconditionError();
    if (
      proof.proposal.operation !== 'vault.binding-deliver' ||
      proposal.workspaceId !== workspaceId ||
      binding.requester.workspaceId !== workspaceId ||
      !isDeepStrictEqual(requester, binding.requester.requester) ||
      proposal.resource.kind !== 'container' ||
      proposal.resource.container.kind !== 'workspace' ||
      proposal.resource.container.owner.kind !== 'workspace' ||
      proposal.resource.container.owner.workspaceId !== workspaceId ||
      proposal.resource.container.id !== workspaceId ||
      proposal.inputReferences.planId !== binding.planId ||
      proposal.inputReferences.grantId !== binding.binding.declaration.vaultGrantId ||
      proposal.inputReferences.receiptId !== binding.receiptId ||
      (proposal.inputReferences.previousReceiptId ?? undefined) !== binding.previousReceiptId ||
      (binding.previousReceiptId !== undefined) !== (refresh !== undefined) ||
      (proposal.inputReferences.refreshContextDigest ?? undefined) !==
        (refresh ? policyDigest(refresh) : undefined) ||
      (refresh &&
        (caller.kind !== 'worker' ||
          typeof proposal.inputReferences.requestId !== 'string' ||
          binding.receiptId !== `receipt_${proposal.inputReferences.requestId}` ||
          binding.receiptId === binding.previousReceiptId ||
          refresh.leaseId !== binding.attemptId ||
          refresh.workspaceId !== workspaceId ||
          refresh.threadId !== consumer.scope.threadId ||
          refresh.turnId !== consumer.scope.turnId ||
          refresh.agentSessionId !== consumer.scope.agentSessionId ||
          refresh.packageSnapshotId !== consumer.snapshotId)) ||
      proposal.inputReferences.packageSnapshotId !== consumer.snapshotId ||
      proposal.inputAttributes.contract !== POLICY_OPERATION_REFERENCE_INPUT_V1 ||
      proposal.inputAttributes.format !== 'chatgptAuthTokens' ||
      proposal.inputAttributes.access !== 'access-token-only' ||
      proposal.inputAttributes.ephemeral !== true ||
      proposal.inputAttributes.outsideRetainedStorage !== true ||
      proposal.capabilityCallId !== null
    )
      throw new ControlProductPreconditionError();
    return { proof, requester };
  }

  /** Repeats Policy meaning from actual native read ports; never invokes participants or records another decision. */
  static assertVaultRead(input: {
    readonly coreDb: CoreDb;
    readonly workspaceDb: WorkspaceDb;
    readonly kind: 'reference-advance' | 'receipt-create' | 'reference-login-state';
    readonly binding: NonNullable<
      Extract<ControlVaultInput, { kind: 'receipt-create' }>['record']['loginBinding']
    >;
    readonly callerPackage:
      | ReturnType<typeof requireAgentEnvironmentPackageSnapshot>['snapshot']
      | null;
    readonly store: GoalTaskPolicyReadPort &
      Omit<ThreadVisibilityReadPort, 'getWorkspaceResourceAccess'> & {
        getTurnById(
          turnId: string
        ): Pick<
          ReturnType<GoalTaskPolicyReadPort['getTurnMetadata']>,
          'owner' | 'threadId' | 'status'
        >;
      };
    readonly sampled: {
      readonly server:
        | { readonly value: RuntimeConfigFileReadResponse }
        | { readonly error: unknown };
      readonly workspace:
        | { readonly value: RuntimeConfigFileReadResponse }
        | { readonly error: unknown };
    };
    readonly policyState: NativeRuntimePolicyPublication | undefined;
    /** Actual owner User reader and distinct decision for the failed-refresh stage only. */
    readonly userDb?: UserDb;
    readonly quarantine?: Extract<
      Extract<ControlVaultInput, { kind: 'reference-login-state' }>['record'],
      { coreConfirmedQuarantine: unknown }
    >['coreConfirmedQuarantine'];
  }): void {
    const { coreDb: actualCore, workspaceDb, callerPackage, sampled, policyState, binding } = input;
    const { proof, requester } = PolicyInterception.readVaultBindingIntent(input.kind, binding);
    const consumer = binding.binding.consumer;
    const workspaceId = consumer.scope.workspaceId;
    const caller = proof.caller;
    const proposal = proof.proposal;
    if (
      policyState?.state !== 'active' ||
      !policyState.identity ||
      policyState.identity.serverRevision !== policyDigest(proof.document)
    )
      throw new ControlProductPreconditionError();
    const workspaceRevision = policyState.identity.workspaceRevisions.find(
      (entry) => entry.workspaceId === workspaceId
    );
    if (workspaceRevision) {
      if (workspaceRevision.revision !== policyDigest(proof.workspaceDocument))
        throw new ControlProductPreconditionError();
    } else {
      if (policyDigest(proof.workspaceDocument) !== policyDigest(EMPTY_POLICY_DOCUMENT))
        throw new ControlProductPreconditionError();
      if ('error' in sampled.workspace) {
        if (
          !(sampled.workspace.error instanceof RuntimeConfigFileServiceError) ||
          sampled.workspace.error.code !== 'config_file_not_found'
        )
          throw sampled.workspace.error;
      } else {
        const authored = WorkspaceConfigSchema.parse(
          parseJsoncObject(sampled.workspace.value.content, sampled.workspace.value.file.id)
        );
        if ((authored.workspace.policy?.mediation ?? EMPTY_POLICY_DOCUMENT).statements.length)
          throw new ControlProductPreconditionError();
      }
    }
    readCurrentWorkspacePolicy({
      coreDb: actualCore,
      workspaceId,
      policy: proof.workspaceDocument,
    });
    const document = readAdmittedPolicyDocument(actualCore, proof.document);
    const original = PolicyInterception.originalVaultDecision(workspaceDb, proof);
    const store = {
      ...input.store,
      getWorkspaceResourceAccess(id: string) {
        if (id !== workspaceId) throw new ControlProductPreconditionError();
        return readCurrentWorkspacePolicy({
          coreDb: actualCore,
          workspaceId,
          policy: proof.workspaceDocument,
        });
      },
    };
    const context =
      caller.kind === 'worker'
        ? readGoalTaskPolicyContext({
            coreDb: actualCore,
            db: workspaceDb,
            store,
            lineage: caller.lineage,
          })
        : null;
    if (caller.kind === 'worker' && caller.goalLinked !== (context !== null))
      throw new ControlProductPreconditionError();
    const responsibleHumanId =
      context?.responsibleUserId ??
      responsibleUserIdForActor(caller.kind === 'worker' ? caller.actor : caller.actorRef);
    if (!responsibleHumanId) throw new ControlProductPreconditionError();
    const agentId =
      context?.agentId ??
      (caller.kind === 'coordinator' ? 'goal-coordinator' : callerPackage?.agent.agentId);
    const subject = PolicySubjectV1Schema.parse({
      principal: context
        ? { kind: 'agent', id: agentId }
        : { kind: 'human', id: responsibleHumanId },
      onBehalfOf: null,
      actor: agentId
        ? { kind: 'agent', id: agentId, responsibleUserId: responsibleHumanId }
        : caller.kind === 'worker'
          ? caller.actor
          : caller.actorRef,
      process:
        caller.kind === 'worker'
          ? {
              workspaceId: caller.lineage.workspaceId,
              threadId: caller.lineage.threadId,
              turnId: caller.lineage.turnId,
            }
          : caller.kind === 'coordinator'
            ? {
                workspaceId: caller.workspaceId,
                threadId: caller.threadId,
                turnId: caller.turnId,
              }
            : null,
      credentialKind: caller.kind === 'worker' ? 'worker-package' : caller.actor.kind,
      responsibleHumanId,
    });
    if (!isDeepStrictEqual(subject, proof.proposal.subject))
      throw new ControlProductPreconditionError();
    const domains = context
      ? createGoalDomainPolicyService({
          mode: 'read',
          coreDb: actualCore,
          store,
          repositoryWorkspaceDb(id) {
            if (id !== workspaceId) throw new ControlProductPreconditionError();
            return workspaceDb;
          },
          files: {
            readFile(id) {
              if (id !== 'server.jsonc') throw new ControlProductPreconditionError();
              if ('error' in sampled.server) throw sampled.server.error;
              return structuredClone(sampled.server.value);
            },
          },
          currentPolicy: () => document,
        })
      : null;
    const coordinatorBinding =
      caller.kind === 'coordinator'
        ? {
            ...caller,
            actor: {
              kind: caller.actor.kind,
              userId: caller.actor.userId,
              ...(caller.actor.sessionId !== undefined
                ? { sessionId: caller.actor.sessionId }
                : {}),
              ...(caller.actor.tokenId !== undefined ? { tokenId: caller.actor.tokenId } : {}),
              ...(caller.actor.tokenScope !== undefined
                ? { tokenScope: caller.actor.tokenScope }
                : {}),
              ...(caller.actor.tokenWorkspaceIds !== undefined
                ? { tokenWorkspaceIds: caller.actor.tokenWorkspaceIds }
                : {}),
              ...(caller.actor.adminTokenId !== undefined
                ? { adminTokenId: caller.actor.adminTokenId }
                : {}),
            },
          }
        : null;
    const definition = VAULT_OPERATION_DEFINITIONS['vault.binding-deliver'];
    let authority: ReturnType<typeof PolicyInterception.readVaultAuthority>;
    try {
      authority = PolicyInterception.readVaultAuthority({
        coreDb: actualCore,
        workspaceDb,
        workspaceId,
        requester,
        coordinator: coordinatorBinding,
        worker:
          caller.kind === 'worker'
            ? { lineage: caller.lineage, goalLinked: caller.goalLinked }
            : null,
        subject,
        resource: proposal.resource,
        operation: definition.policyOperation,
        mutating: definition.mutating,
        taskPolicy:
          context && domains
            ? createGoalTaskPolicyService({ coreDb: actualCore, store, domains })
            : null,
        decision: proof.decision,
      });
    } catch (error) {
      // Current Goal authority loss is a native precondition refusal, not an SQL failure.
      if (
        error instanceof GoalCommandError &&
        ['coordinator_authority_denied', 'goal_closed', 'not_found'].includes(error.code)
      )
        throw new ControlProductPreconditionError();
      throw error;
    }
    const coordinator = authority.coordinator;
    if (coordinator) {
      const target = readGoalTaskPolicyContext({
        coreDb: actualCore,
        db: workspaceDb,
        store,
        lineage: { ...consumer.scope, packageSnapshotId: consumer.snapshotId },
      });
      if (
        !target ||
        target.goalId !== coordinator.goalId ||
        target.planVersionId !== coordinator.activePlanVersionId ||
        target.responsibleUserId !== coordinator.responsibleUserId ||
        target.taskThreadId !== consumer.scope.threadId
      )
        throw new ControlProductPreconditionError();
    }
    if (
      (context && !authority.goal) ||
      authority.kernel.effect !== 'allow' ||
      authority.callerRevision !== binding.requester.revision ||
      authority.revision !== proof.decision.authorizationRevision
    )
      throw new ControlProductPreconditionError();
    const authorCurrent = (userId: string) =>
      !!currentWorkspaceAuthority(
        actualCore,
        workspaceId,
        { kind: 'user', id: userId },
        'vault.use',
        true,
        undefined,
        { retainedPolicyAuthor: true, dependencyFailure: 'throw', mutating: true }
      );
    const bindings = selectPolicyBindings({
      document,
      proposal,
      stage: 'decide',
      now: Date.now(),
      authorCurrent,
      anchorCurrent(anchor) {
        if (anchor.owner.kind !== 'workspace' || anchor.owner.workspaceId !== workspaceId)
          return false;
        if (anchor.kind === 'workspace') return anchor.id === workspaceId;
        return anchor.kind === 'turn' && !isSealedTurnTerminal(store.getTurnById(anchor.id).status);
      },
    });
    for (const reference of original.consumedStatements) {
      const statement = document.statements.find(
        (value) => value.id === reference.id && policyDigest(value) === reference.digest
      );
      if (
        !statement ||
        statement.state !== 'active' ||
        statement.lifetime.uses === undefined ||
        (statement.lifetime.notAfter && Date.parse(statement.lifetime.notAfter) <= Date.now()) ||
        !policyStatementUsedByDecision(workspaceDb, reference, proof.decision) ||
        readPolicyStatementUseCount(workspaceDb, reference) - 1 >= statement.lifetime.uses ||
        (statement.kind === 'binding' &&
          !bindings.some(
            (value) => value.id === statement.id && policyDigest(value) === reference.digest
          ))
      )
        throw new ControlProductPreconditionError();
    }
    if (input.kind === 'reference-login-state') {
      const { quarantine, userDb } = input;
      if (!quarantine || !userDb || !isDeepStrictEqual(quarantine.binding, binding))
        throw new ControlProductPreconditionError();
      PolicyInterception.assertLoginQuarantineDecision(actualCore, userDb, quarantine);
    }
  }

  /** Reads the distinct User decision without deciding, consuming or invoking Policy again. */
  private static assertLoginQuarantineDecision(
    coreDb: CoreDb,
    userDb: UserDb,
    authority: Extract<
      Extract<ControlVaultInput, { kind: 'reference-login-state' }>['record'],
      { coreConfirmedQuarantine: unknown }
    >['coreConfirmedQuarantine']
  ): void {
    const { binding, quarantine, failureClass } = authority;
    const originalProof = binding.policyProof;
    const selected = evaluateCoreConfirmedLoginQuarantine(coreDb, { binding, failureClass });
    const userId = selected.reference.userId;
    const proposal = quarantine.proposal;
    if (
      !userId ||
      userDb.scope !== 'user' ||
      userDb.userId !== userId ||
      userDb.dataRoot !== coreDb.dataRoot ||
      !userDb.sqlite.open ||
      proposal.operation !== 'vault.login-quarantine' ||
      proposal.workspaceId !== null ||
      proposal.capabilityCallId !== null ||
      proposal.resource.kind !== 'container' ||
      proposal.resource.container.kind !== 'user' ||
      proposal.resource.container.id !== userId ||
      proposal.resource.container.owner.kind !== 'user' ||
      proposal.resource.container.owner.userId !== userId ||
      !isDeepStrictEqual(proposal.subject, originalProof.proposal.subject) ||
      proposal.inputReferences.referenceId !== selected.reference.referenceId ||
      proposal.inputReferences.grantId !== selected.grant.grantId ||
      proposal.inputReferences.bindingDecisionId !== originalProof.decision.decisionId ||
      proposal.inputAttributes.contract !== POLICY_OPERATION_REFERENCE_INPUT_V1 ||
      proposal.inputAttributes.materialVersion !== binding.binding.materialVersion ||
      proposal.inputAttributes.failureClass !== failureClass ||
      policyDigest(quarantine.document) !== policyDigest(originalProof.document) ||
      quarantine.decision.authorizationRevision !== policyDigest({ ...selected, items: null }) ||
      selected.kernel.effect !== 'allow'
    )
      throw new ControlProductPreconditionError();
    const document = readAdmittedPolicyDocument(coreDb, quarantine.document);
    const decision = PolicyInterception.originalVaultDecision(userDb, quarantine);
    if (
      !isDeepStrictEqual(decision.kernel, {
        effect: selected.kernel.effect,
        reason: selected.kernel.reasons[0]?.code ?? 'not_granted',
      })
    )
      throw new ControlProductPreconditionError();
    const bindings = selectPolicyBindings({
      document,
      proposal,
      stage: 'decide',
      now: Date.now(),
      // The selected owner is already canonically active in the shared Auth read.
      authorCurrent: (id) => id === userId || isCurrentServerPolicyAuthor(coreDb, id),
      anchorCurrent: (anchor) =>
        anchor.owner.kind === 'user' &&
        anchor.owner.userId === userId &&
        anchor.kind === 'user' &&
        anchor.id === userId,
    });
    for (const reference of decision.consumedStatements) {
      const statement = document.statements.find(
        (value) => value.id === reference.id && policyDigest(value) === reference.digest
      );
      if (
        !statement ||
        statement.state !== 'active' ||
        statement.lifetime.uses === undefined ||
        (statement.lifetime.notAfter && Date.parse(statement.lifetime.notAfter) <= Date.now()) ||
        readPolicyStatementUseCount(userDb, reference) - 1 >= statement.lifetime.uses ||
        (statement.kind === 'binding' &&
          !bindings.some(
            (value) => value.id === statement.id && policyDigest(value) === reference.digest
          ))
      )
        throw new ControlProductPreconditionError();
    }
  }

  /** Reads an existing final allow and linked Audit on its actual Workspace or owner User connection. */
  private static originalVaultDecision(
    db: WorkspaceDb | UserDb,
    proof: Pick<VaultBindingPolicyProof, 'proposal' | 'decision' | 'document'>
  ) {
    const workspaceId = db.scope === 'workspace' ? db.workspaceId : null;
    const row =
      db.scope === 'workspace'
        ? db.sqlite
            .prepare(
              "SELECT * FROM permission_decisions WHERE decision_id=? AND owner_scope='workspace' AND workspace_id=?"
            )
            .get(proof.decision.decisionId, workspaceId)
        : db.sqlite
            .prepare(
              "SELECT * FROM permission_decisions WHERE decision_id=? AND owner_scope='user' AND workspace_id IS NULL"
            )
            .get(proof.decision.decisionId);
    if (!row) throw new ControlProductPreconditionError();
    const decision = readPermissionDecisionRowV1(row);
    const mediation = decision.mediation;
    const proposal = proof.proposal;
    const definition =
      VAULT_OPERATION_DEFINITIONS[
        db.scope === 'workspace' ? 'vault.binding-deliver' : 'vault.login-quarantine'
      ];
    const context = decision.contextSummary as Record<string, unknown> | null;
    const resource = decision.resourceSummary as Record<string, unknown> | null;
    if (
      decision.result !== 'allow' ||
      decision.action !== definition.policyOperation ||
      decision.policySnapshotId !== proof.decision.policyRevision ||
      mediation?.role !== 'final' ||
      mediation.stage !== 'decide' ||
      mediation.operation !== proposal.operation ||
      mediation.kernel?.effect !== 'allow' ||
      mediation.proposalDigest !== proof.decision.proposalDigest ||
      mediation.authorizationRevision !== proof.decision.authorizationRevision ||
      !isDeepStrictEqual(mediation.subject, proposal.subject) ||
      policyProposalDigest(proposal) !== proof.decision.proposalDigest ||
      policyDigest(proof.document) !== proof.decision.policyRevision ||
      (db.scope === 'workspace'
        ? resource?.selectionDigest !== proposal.inputReferences.selectionDigest ||
          context?.requestId !== proposal.inputReferences.requestId
        : !isDeepStrictEqual(resource, proposal.inputReferences) ||
          context?.threadId !== proposal.subject.process?.threadId ||
          context?.turnId !== proposal.subject.process?.turnId) ||
      context?.capabilityCallId !== proposal.capabilityCallId
    )
      throw new ControlProductPreconditionError();
    const auditRow = db.sqlite
      .prepare('SELECT * FROM audit_events WHERE audit_event_id=?')
      .get(decision.auditEventId);
    if (!auditRow) throw new ControlProductPreconditionError();
    const audit = readAuditEventRowV1(auditRow);
    if (
      audit.permissionDecisionId !== decision.decisionId ||
      audit.workspaceId !== workspaceId ||
      audit.action !== 'permission.decision' ||
      audit.outcome !== 'succeeded' ||
      audit.resource !== `permission:${decision.action}` ||
      audit.capabilityCallId !== proposal.capabilityCallId ||
      !isDeepStrictEqual(audit.actor, proposal.subject.actor) ||
      (proposal.subject.process !== null &&
        (audit.threadId !== proposal.subject.process.threadId ||
          audit.turnId !== proposal.subject.process.turnId))
    )
      throw new ControlProductPreconditionError();
    return mediation;
  }

  /** Shares exact invocation validation between synchronous and awaited decision entry points. */
  private prepareDecision(input: InterceptionInput) {
    const { points } = policyOperationDefinition(input.proposal.operation);
    assertInterceptionOwner(input);
    if (!points.stages.includes('decide'))
      throw new Error('Policy deciding point or resource is unavailable.');
    if (
      input.document.statements.some(
        (statement) =>
          statement.kind === 'binding' &&
          statement.state !== 'inactive' &&
          (statement.mode === 'advise' || statement.mode === 'transform')
      )
    )
      throw new Error('I16 safe participant output reference is unavailable.');
    const policyRevision = policyDigest(input.document);
    const proposalDigest = policyProposalDigest(input.proposal);
    for (const { statement, limit } of input.authorizationUses ?? []) {
      const current = input.document.statements.find((value) => value.id === statement.id);
      if (
        !current ||
        current.state !== 'active' ||
        policyDigest(current) !== statement.digest ||
        current.lifetime.uses !== limit
      )
        throw new Error('Finite authorization must match the current Policy statement and limit.');
    }
    const bindings = selectPolicyBindings({ ...input, stage: 'decide', now: Date.now() });
    const invocations: InvocationReference[] = [];
    const advice: unknown[] = [];
    const results: PermissionDecisionResult[] = [];
    const used: PolicyBindingV1[] = [];
    const humanApproved =
      input.humanApproval &&
      input.humanApproval.binding.proposalDigest === proposalDigest &&
      input.humanApproval.binding.policyRevision === policyRevision &&
      input.humanApproval.binding.authorizationRevision === input.authorizationRevision;
    const conditions = input.permissions ?? [];
    if (conditions.some((statement) => statement.effect === 'require_approval') && !humanApproved)
      results.push('require_approval');
    return {
      bindings,
      advice,
      invocations,
      results,
      used,
      policyRevision,
      proposalDigest,
      humanApproved,
    };
  }

  /** Runs the supported pilot modes and retains evidence before releasing a result. */
  async decide(input: InterceptionInput): Promise<InterceptionDecision> {
    const prepared = this.prepareDecision(input);
    const { bindings, advice, invocations, results, used, humanApproved } = prepared;
    const { policyRevision, proposalDigest } = prepared;
    for (const binding of bindings.filter((value) => value.mode === 'gate')) {
      if (
        binding.lifetime.uses !== undefined &&
        readPolicyStatementUseCount(input.userDb ?? input.workspaceDb, {
          id: binding.id,
          digest: policyDigest(binding),
        }) >= binding.lifetime.uses
      )
        continue;
      const evaluated = await this.invoke(input, binding, advice, policyRevision, proposalDigest);
      invocations.push(evaluated.reference);
      if (binding.state === 'shadow') continue;
      used.push(binding);
      results.push(
        evaluated.result === 'require_escalation' && humanApproved ? 'allow' : evaluated.result
      );
    }
    const preparedDecision = this.prepareFinalDecision(input, prepared);
    await recordProductPermissionDecision(preparedDecision.record);
    return preparedDecision.decision;
  }

  /** Prepares a participant-free decision for the native admission tuple without writing. */
  prepareSynchronousDecision(input: InterceptionInput) {
    const prepared = this.prepareDecision(input);
    if (prepared.bindings.some((binding) => binding.mode !== 'observe')) return undefined;
    return this.prepareFinalDecision(input, prepared);
  }

  /** Prepares current Kernel facts; the native owner decides finite-use consumption and Audit. */
  private prepareFinalDecision(
    input: InterceptionInput,
    prepared: ReturnType<PolicyInterception['prepareDecision']>
  ): {
    readonly record: RecordProductPermissionDecisionInput;
    readonly decision: InterceptionDecision;
  } {
    const { results, used, advice, policyRevision, proposalDigest, invocations } = prepared;
    let current = false;
    try {
      current = input.stillCurrent();
    } catch {
      /* Missing mandatory facts are an evaluation error. */
    }
    if (!current) results.push('error');
    // Recheck agent authority after participant work and before the final mandatory Kernel.
    // Only active gates decide; shadow failures remain evidence without a veto.
    for (const binding of used.filter((value) => value.participant.kind === 'agent')) {
      try {
        readPolicyAgentPrincipal({ ...input, binding, now: Date.now() });
        if (!input.participantAuthorized(binding))
          throw new Error('Agent disclosure authority changed.');
      } catch {
        results.push('error');
      }
    }
    let kernel: PolicyDecision | null = null;
    let escalation: GoalTaskAccessResult['escalation'];
    try {
      const evaluated = input.finalKernel({ proposal: input.proposal, advice });
      const goal = 'kernel' in evaluated ? evaluated : undefined;
      kernel = 'kernel' in evaluated ? evaluated.kernel : evaluated;
      if (
        kernel.reasons.some(({ code }) =>
          ['invalid-policy', 'invalid-request', 'missing-operation'].includes(code)
        )
      ) {
        results.push('error');
      } else if (goal?.escalation && !kernel.reasons.some(({ code }) => code === 'restriction')) {
        if (
          input.proposal.workspaceId === null ||
          !goal.inGoalEnvelope ||
          kernel.effect !== 'deny' ||
          kernel.reasons.length === 0 ||
          kernel.reasons.some(({ code }) => code !== 'missing-privilege') ||
          goal.escalation.workspaceId !== input.proposal.workspaceId
        )
          throw new Error('Goal escalation contradicts the current mandatory Kernel evaluation.');
        // A Task association gap cannot redirect a human-only condition or a
        // participant failure. Keep their existing result and destination.
        if (!results.some((value) => value !== 'allow' && value !== 'not_applicable')) {
          results.push('require_escalation');
          escalation = goal.escalation;
        }
      } else {
        results.push(kernel.effect);
      }
    } catch {
      results.push('error');
    }
    const result = combineResults(results);
    const decisionId = allocateEntityId('pd');
    const consumed =
      result === 'allow'
        ? [
            ...new Map(
              [
                ...(input.authorizationUses ?? []),
                ...used
                  .filter((binding) => binding.lifetime.uses !== undefined)
                  .map((binding) => ({
                    statement: { id: binding.id, digest: policyDigest(binding) },
                    limit: binding.lifetime.uses!,
                  })),
              ].map((value) => [value.statement.id, value])
            ).values(),
          ]
        : [];
    const finalInput = decisionInput(input, policyRevision);
    const record: RecordProductPermissionDecisionInput = {
      ...finalInput,
      contextSummary: {
        ...finalInput.contextSummary,
        ...(kernel
          ? {
              kernelTrace: {
                matchedAssociations: kernel.trace.matchedAssociations,
                matchedProhibitions: kernel.trace.matchedProhibitions,
              },
            }
          : {}),
      },
      decisionId,
      result,
      ...(result === 'require_approval' ? { requiredApprovalKind: 'permission' } : {}),
      reasonCode:
        result === 'deny'
          ? kernel?.effect === 'allow' || kernel?.reasons.some(({ code }) => code === 'restriction')
            ? 'prohibited'
            : 'not_granted'
          : result === 'require_escalation' || result === 'require_approval'
            ? 'require_approval'
            : result === 'allow'
              ? 'granted'
              : 'evaluation_error',
      mediation: {
        operation: input.proposal.operation,
        stage: 'decide',
        proposalDigest,
        authorizationRevision: input.authorizationRevision,
        subject: input.proposal.subject,
        role: 'final',
        kernel: kernel
          ? { effect: kernel.effect, reason: kernel.reasons[0]?.code ?? 'not_granted' }
          : null,
        invocations,
        consumedStatements: consumed.map(({ statement }) => statement),
      },
      ...(consumed.length
        ? {
            uses: consumed,
          }
        : {}),
    };
    return {
      record,
      decision: {
        result,
        decisionId,
        proposalDigest,
        policyRevision,
        authorizationRevision: input.authorizationRevision,
        ...(result === 'require_escalation' && escalation ? { escalation } : {}),
      },
    };
  }

  /** Completed observations cannot change an already settled effect or authorize a retry. */
  async observe(input: InterceptionInput): Promise<void> {
    assertInterceptionOwner(input);
    if (!policyOperationDefinition(input.proposal.operation).points.stages.includes('completed'))
      throw new Error('Policy completed point is unavailable.');
    const bindings = selectPolicyBindings({ ...input, stage: 'completed', now: Date.now() });
    for (const binding of bindings.filter((value) => value.mode === 'observe'))
      await this.invoke(
        input,
        binding,
        [],
        policyDigest(input.document),
        policyProposalDigest(input.proposal)
      );
  }

  private async invoke(
    input: InterceptionInput,
    binding: PolicyBindingV1,
    advice: readonly unknown[],
    policyRevision: string,
    proposalDigest: string
  ): Promise<{
    reference: InvocationReference;
    result: PermissionDecisionResult;
  }> {
    const { points } = policyOperationDefinition(input.proposal.operation);
    if (
      binding.operation !== input.proposal.operation ||
      !points.stages.includes(binding.stage) ||
      !points.modes.includes(binding.mode) ||
      !points.participantKinds.includes(binding.participant.kind) ||
      (binding.mode === 'gate' &&
        !points.gateFailures.includes(binding.failure as 'error' | 'escalate-to-human'))
    )
      throw new Error('Policy participation is unavailable at this operation point.');
    const startedAt = new Date().toISOString();
    const bindingRef = { id: binding.id, digest: policyDigest(binding) };
    const key = bindingRef.digest;
    const circuit = this.circuits.get(key) ?? { failures: 0, retryAt: 0, probing: false };
    let outcome: PolicyInvocationV1['outcome'] = 'unavailable';
    let output: unknown = null;
    let result: PermissionDecisionResult =
      binding.failure === 'continue'
        ? 'not_applicable'
        : binding.failure === 'error'
          ? 'error'
          : 'require_escalation';
    let current = false;
    let participantAuthorized = false;
    let authorityError = false;
    let agent: ReturnType<typeof readPolicyAgentPrincipal> | undefined;
    try {
      if (binding.participant.kind === 'agent') {
        if (binding.author.kind !== 'human' || !input.authorCurrent(binding.author.id))
          throw new Error('Current agent activation authority is unavailable.');
        agent = readPolicyAgentPrincipal({ ...input, binding, now: Date.now() });
      }
      current = input.stillCurrent();
      if (current)
        participantAuthorized =
          policyScopeIncludesProposal(binding.inputDisclosure, input.proposal) &&
          input.participantAuthorized(binding);
    } catch {
      authorityError = true;
    }
    const participant =
      binding.participant.kind === 'agent' ? this.agentParticipant : this.participant;
    if (authorityError) {
      outcome = 'error';
      result = 'error';
    } else if (!current) {
      outcome = 'stale';
      result = 'error';
    } else if (!participantAuthorized) outcome = 'unavailable';
    else if (circuit.probing || circuit.retryAt > Date.now()) outcome = 'open-circuit';
    else if (
      participant &&
      (binding.participant.kind === 'agent' ||
        (participant.id === binding.participant.id &&
          participant.version === binding.participant.version)) &&
      (participant.id === undefined || participant.id === binding.participant.id) &&
      (participant.version === undefined || participant.version === binding.participant.version)
    ) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      circuit.probing = circuit.retryAt > 0;
      this.circuits.set(key, circuit);
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ParticipantTimeout());
          }, binding.timeoutMs);
        });
        output = await Promise.race([
          participant.invoke({
            binding: structuredClone(binding),
            proposal: structuredClone(input.proposal),
            advice: structuredClone(advice),
            signal: controller.signal,
          }),
          timeout,
        ]);
        const parsed =
          binding.mode === 'gate'
            ? (binding.participant.kind === 'agent'
                ? PolicyAgentGateOutputV1Schema
                : GateOutput
              ).safeParse(output)
            : ObservationOutput.safeParse(output);
        if (
          !parsed.success ||
          (binding.mode === 'gate' &&
            !policyOperationDefinition(input.proposal.operation).points.gateResults.includes(
              binding.participant.kind === 'agent'
                ? PolicyAgentGateOutputV1Schema.parse(parsed.data).decision
                : GateOutput.parse(parsed.data).decision
            ))
        )
          outcome = 'malformed';
        else if (!input.stillCurrent()) outcome = 'stale';
        else {
          if (binding.participant.kind === 'agent') {
            try {
              agent = readPolicyAgentPrincipal({ ...input, binding, now: Date.now() });
              if (!input.participantAuthorized(binding))
                throw new Error('Agent disclosure authority changed.');
            } catch {
              authorityError = true;
              throw new Error('Agent authority changed during review.');
            }
          }
          outcome = 'completed';
          output = parsed.data;
          if (binding.mode === 'gate') {
            const gate =
              binding.participant.kind === 'agent'
                ? PolicyAgentGateOutputV1Schema.parse(parsed.data).decision
                : GateOutput.parse(parsed.data).decision;
            result = gate === 'escalate' ? 'require_escalation' : gate;
          } else {
            result = 'not_applicable';
          }
        }
      } catch (error) {
        outcome = error instanceof ParticipantTimeout ? 'timeout' : 'error';
      } finally {
        if (timer) clearTimeout(timer);
        circuit.probing = false;
      }
      if (outcome === 'completed') {
        circuit.failures = 0;
        circuit.retryAt = 0;
      } else {
        circuit.failures += 1;
        if (circuit.failures >= binding.circuit.failures)
          circuit.retryAt = Date.now() + binding.circuit.recoveryAfterMs;
      }
    }
    if (authorityError) result = 'error';
    const subject = agent
      ? {
          ...input.proposal.subject,
          principal: { kind: 'agent' as const, id: agent.agentId },
          onBehalfOf: null,
          actor: {
            kind: 'agent' as const,
            id: agent.agentId,
            responsibleUserId: agent.responsibleHumanId,
          },
          responsibleHumanId: agent.responsibleHumanId,
        }
      : input.proposal.subject;
    const invocation: PolicyInvocationV1 = {
      binding: bindingRef,
      operation: binding.operation,
      stage: binding.stage,
      mode: binding.mode,
      policyRevision,
      authorizationRevision: input.authorizationRevision,
      proposalDigest,
      subject,
      participant: { id: binding.participant.id, version: binding.participant.version },
      inputDigest: policyDigest({ proposal: input.proposal, advice }),
      outputDigest: outcome === 'completed' ? policyDigest(output) : null,
      outcome,
      startedAt,
      completedAt: new Date().toISOString(),
      capabilityCallId: input.proposal.capabilityCallId,
    };
    if (binding.mode === 'gate') {
      const decisionId = allocateEntityId('pd');
      await recordProductPermissionDecision({
        ...decisionInput(input, policyRevision),
        // Participant evidence cannot claim the approved command's final authorizer link.
        approvalId: null,
        ...(agent
          ? {
              subjectSummary: {
                principal: subject.principal,
                responsibleHumanId: subject.responsibleHumanId,
              },
              auditActor: subject.actor,
            }
          : {}),
        decisionId,
        result,
        reasonCode:
          outcome !== 'completed'
            ? 'participant_unavailable'
            : result === 'deny'
              ? 'prohibited'
              : result === 'require_escalation'
                ? 'require_approval'
                : 'granted',
        policyInvocation: invocation,
        mediation: {
          operation: binding.operation,
          stage: binding.stage,
          authorizationRevision: input.authorizationRevision,
          proposalDigest,
          subject,
          role: 'gate',
          binding: bindingRef,
          invocations: [],
          consumedStatements: [],
        },
      });
      return { reference: { kind: 'decision', id: decisionId }, result };
    }
    const auditEventId = allocateEntityId('aud');
    const event = {
      ...prepareAuditEvent({
        workspaceId: input.proposal.workspaceId,
        auditEventId,
        actor: input.proposal.subject.actor,
        category: 'system',
        action: 'policy.participant',
        ...(input.proposal.capabilityCallId
          ? { capabilityCallId: input.proposal.capabilityCallId }
          : {}),
        ...(input.proposal.subject.process
          ? {
              threadId: input.proposal.subject.process.threadId,
              turnId: input.proposal.subject.process.turnId,
            }
          : {}),
        policyInvocation: invocation,
        outcome: outcome === 'completed' ? 'succeeded' : 'failed',
        summary: `Policy participant ${binding.id}: ${outcome}.`,
      }),
      action: 'policy.participant' as const,
    };
    if (input.userDb) {
      await getControlStoreWorkerClient().userCapability(input.userDb, {
        kind: 'user-participant-audit',
        userId: input.userDb.userId,
        event: { ...event, workspaceId: null },
      });
    } else {
      await getControlStoreWorkerClient().workspaceCapability(input.workspaceDb, {
        kind: 'participant-audit',
        workspaceId: input.workspaceDb.workspaceId,
        event,
      });
    }
    return {
      reference: { kind: 'audit', id: auditEventId },
      result,
    };
  }
}

/** Both deciding and completed points must match the actual database before disclosure. */
function assertInterceptionOwner(input: InterceptionInput): void {
  if ((input.userDb !== undefined) === (input.workspaceDb !== undefined))
    throw new Error('Policy resource database owner is unavailable.');
  if (input.userDb) nativeUserDatabasePath(input.userDb);
  const matches = input.userDb
    ? input.proposal.workspaceId === null &&
      policyResourceUser(input.proposal.resource) === input.userDb.userId
    : input.workspaceDb.scope === 'workspace' &&
      input.workspaceDb.workspaceId === input.proposal.workspaceId &&
      policyResourceWorkspace(input.proposal.resource) === input.proposal.workspaceId;
  if (!matches) throw new Error('Policy resource database owner is unavailable.');
}

class ParticipantTimeout extends Error {}

/** Existing closed precedence; a neutral participant never supplies missing authority. */
function combineResults(results: readonly PermissionDecisionResult[]): PermissionDecisionResult {
  const applicable = results.some((value) => value !== 'not_applicable')
    ? results.filter((value) => value !== 'not_applicable')
    : results;
  return (
    (
      [
        'error',
        'deny',
        'require_escalation',
        'require_approval',
        'defer',
        'not_applicable',
        'allow',
      ] as const
    ).find((value) => applicable.includes(value)) ?? 'not_applicable'
  );
}

function decisionInput(input: InterceptionInput, policyRevision: string) {
  return {
    ...(input.userDb
      ? { userDb: input.userDb, workspaceId: null, ownerScope: 'user' as const }
      : {
          workspaceDb: input.workspaceDb,
          workspaceId: input.workspaceDb.workspaceId,
          ownerScope: 'workspace' as const,
        }),
    action: policyOperationDefinition(input.proposal.operation).policyOperation,
    enforcementPoint: `${input.proposal.operation}@decide`,
    policyEngineVersion: 'nanocore-policy:v1',
    policySnapshotId: policyRevision,
    ...(input.decisionLineage ? { approvalId: input.decisionLineage.approvalId } : {}),
    subjectSummary: {
      principal: input.proposal.subject.principal,
      responsibleHumanId: input.proposal.subject.responsibleHumanId,
    },
    resourceSummary: input.resourceSummary ?? input.proposal.resource,
    contextSummary: {
      capabilityCallId: input.proposal.capabilityCallId,
      ...input.contextSummary,
      ...(input.decisionLineage ? { requestId: input.decisionLineage.requestId } : {}),
      threadId: input.proposal.subject.process?.threadId ?? input.contextSummary?.threadId,
      turnId: input.proposal.subject.process?.turnId ?? input.contextSummary?.turnId,
      ...(input.humanApproval
        ? {
            humanApprovalRequestId: input.humanApproval.requestId,
            approvalSourceDecisionId: input.humanApproval.sourceDecisionId,
            humanApprovalDeciderId: input.humanApproval.deciderId,
          }
        : {}),
    },
    auditActor: input.humanApproval
      ? { kind: 'user' as const, id: input.humanApproval.deciderId }
      : input.proposal.subject.actor,
  };
}
