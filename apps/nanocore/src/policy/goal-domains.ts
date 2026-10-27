import { createHash } from 'node:crypto';
import { OpenKitConfigSchema } from '@openkit/config-schema';
import {
  allocateEntityId,
  isSealedTurnTerminal,
  PolicyDelegationV1Schema,
  PolicyDigestV1Schema,
  type PolicyDocumentV1,
  PolicyPermissionV1Schema,
  type PolicySubjectV1Schema,
  PolicyWriteProposalV1Schema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import {
  authorizeWorkspace,
  evaluateProductAuthorization,
  isCurrentDeploymentAdministrator,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { parseJsoncObject } from '../config/jsonc.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import type { FsStore } from '../lib/store.js';
import { goalActor, readGoalView, requireCoordinatorGoal } from '../runtime/goal-owner.js';
import {
  type GoalTaskPolicyContext,
  readGoalTaskPolicyContext,
} from '../runtime/goal-task-policy-context.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import type { SchedulerExecutionLineage } from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { readAdmittedPolicyDocument } from './configuration.js';
import {
  type PolicyUseDecision,
  policyStatementUsedByDecision,
  readPolicyStatementUseCount,
  recordProductPermissionDecision,
} from './permission-decisions.js';
import {
  EMPTY_POLICY_DOCUMENT,
  policyDigest,
  policyScopeContains,
  validatePolicyDocument,
} from './statements.js';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from './workspace-access.js';

/** Existing delegation format with the Goal lineage required by its native consumer. */
export type GoalDomainStatement = z.infer<typeof PolicyDelegationV1Schema>;

/** Existing permission grammar; native admission supplies its current Goal delegation. */
export type GoalDomainPermission = z.infer<typeof PolicyPermissionV1Schema>;

/** The actual Coordinator and affected Worker are separate native authority facts. */
export interface GoalDomainAdministrationInput {
  readonly workspaceDb: WorkspaceDb;
  readonly goalId: string;
  readonly coordinatorTurnId: string;
  readonly taskLineage: SchedulerExecutionLineage;
  readonly expectedPolicyRevision: string;
  readonly grant: {
    readonly id: string;
    readonly scope: GoalDomainPermission['scope'];
    readonly lifetime: GoalDomainPermission['lifetime'];
    readonly rationale: string;
  };
}

/** A Goal and its jointly approved request remain in their existing Workspace owner. */
export interface GoalDomainKey {
  readonly workspaceId: string;
  readonly goalId: string;
}

/** Existing Policy persistence and live Goal/credential owners; no second grant store. */
export interface GoalDomainPolicyDependencies {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly files: Pick<RuntimeConfigFileService, 'readFile' | 'validate' | 'updateFile'>;
  readonly currentPolicy: () => unknown;
  readonly reload: () => ReturnType<RuntimeConfigManager['reload']>;
}

/** Known ended or unapproved authority is distinct from a failed dependency read. */
class GoalDomainUnavailable extends Error {}

const CapturedDomain = z
  .object({
    statement: PolicyDelegationV1Schema,
    digest: PolicyDigestV1Schema,
  })
  .strict();

/** Returns a safe repair instruction for unsupported native proposal semantics; grants no authority. */
export function goalDomainSupportError(input: {
  readonly statement: Pick<GoalDomainStatement, 'scope' | 'lifetime'>;
  readonly workspaceId: string;
  readonly goalId: string;
  readonly store: FsStore;
  readonly actor: Actor;
  readonly administratorEligible: boolean;
}): string | null {
  const { statement, workspaceId, goalId, store, actor, administratorEligible } = input;
  const anchor = statement.lifetime.anchor;
  if (
    anchor.owner.kind !== 'workspace' ||
    anchor.owner.workspaceId !== workspaceId ||
    anchor.kind !== 'goal' ||
    anchor.id !== goalId
  )
    return 'goalDomain.lifetime.anchor must reference this exact Workspace and Goal.';
  if (
    statement.scope.actions.some(
      (action) => !Object.hasOwn(PRODUCT_OPERATION_ACCESS_RIGHTS, action)
    )
  )
    return 'goalDomain.scope.actions must use registered product operations, such as knowledge.read.';
  for (const resource of statement.scope.resources) {
    if (resource.kind === 'mcp-tool') {
      if (resource.workspaceId !== workspaceId)
        return 'goalDomain.scope.resources must reference this exact Workspace.';
      continue;
    }
    const container = resource.container;
    if (container.owner.kind !== 'workspace' || container.owner.workspaceId !== workspaceId)
      return 'goalDomain.scope.resources.container.owner must reference this exact Workspace.';
    let valid =
      (container.kind === 'goal' && container.id === goalId) ||
      (container.kind === 'workspace' && container.id === workspaceId);
    if (container.kind === 'thread')
      valid = isThreadIdVisible(
        store,
        workspaceId,
        container.id,
        actor.userId,
        administratorEligible
      );
    if (container.kind === 'turn') {
      try {
        const turn = store.getTurnById(container.id);
        valid =
          workspaceIdForOwner(turn.owner) === workspaceId &&
          isThreadIdVisible(store, workspaceId, turn.threadId, actor.userId, administratorEligible);
      } catch {
        valid = false;
      }
    }
    if (!valid)
      return 'goalDomain.scope.resources.container must reference this Goal, Workspace, or a currently visible Thread or Turn.';
  }
  return null;
}

/** Publishes only a committed, jointly approved Plan/domain through the sole config CAS writer. */
export function createGoalDomainPolicyService(deps: GoalDomainPolicyDependencies) {
  function saved() {
    const file = deps.files.readFile('server.jsonc');
    const raw = parseJsoncObject(file.content, 'server.jsonc');
    const config = OpenKitConfigSchema.parse(raw);
    const document = validatePolicyDocument(config.policy?.mediation ?? EMPTY_POLICY_DOCUMENT);
    return { file, raw, document, revision: policyDigest(document) };
  }

  function loaded() {
    const current = saved();
    const document = readAdmittedPolicyDocument(deps.coreDb, deps.currentPolicy());
    if (policyDigest(document) !== current.revision)
      throw new Error('Goal-domain Policy file and loaded revision differ; inspect and reload.');
    return current;
  }

  function approved(workspaceId: string, requestId: string, ownDecision?: PolicyUseDecision) {
    const db = deps.repositoryWorkspaceDb(workspaceId);
    const request = readPendingRequest(db.sqlite, requestId);
    const intent = request?.governedIntent;
    const capture = CapturedDomain.parse(intent?.goalDomain);
    const statement = capture.statement;
    const source = statement.source;
    if (
      statement.kind !== 'delegation' ||
      statement.purpose !== 'goal-domain' ||
      statement.state !== 'inactive' ||
      !source ||
      policyDigest(statement) !== capture.digest ||
      source.workspaceId !== workspaceId ||
      source.approvalRequestId !== requestId ||
      request?.workspaceId !== workspaceId ||
      request.kind !== 'approval' ||
      request.requesterKind !== 'coordinator' ||
      request.state !== 'resolved' ||
      request.resolution !== 'granted' ||
      request.claim !== 'finished' ||
      request.disposition !== 'approved-executed' ||
      request.decidingActor?.kind !== 'user' ||
      !request.decidingActorContext ||
      request.decidingActor.id !== request.decidingActorContext.userId ||
      !request.decidedAt ||
      intent?.operation !== 'goal.plan.approve' ||
      intent.goalId !== source.goalId ||
      intent.planVersionId !== source.planVersionId ||
      intent.digest !== source.planDigest ||
      statement.delegate.kind !== 'agent' ||
      statement.delegate.id !== request.agentId
    )
      throw new GoalDomainUnavailable(
        'Goal domain requires the exact completed joint human approval.'
      );
    const view = readGoalView(deps.store, db, source.goalId);
    const version = view.versions.find((item) => item.planVersionId === source.planVersionId);
    if (
      !view.goal ||
      view.goal.workspaceId !== workspaceId ||
      view.goal.disposition !== null ||
      view.goal.threadId !== request.threadId ||
      view.goal.activePlanVersionId !== source.planVersionId ||
      !version ||
      version.goalId !== source.goalId ||
      version.pendingRequestId !== requestId ||
      version.digest !== source.planDigest ||
      version.bytes !== intent.bytes ||
      `sha256:${createHash('sha256').update(version.bytes).digest('hex')}` !== source.planDigest
    )
      throw new GoalDomainUnavailable('Goal-domain Plan is absent, obsolete or closed.');
    const actor = request.decidingActorContext;
    const active: GoalDomainStatement = {
      ...statement,
      purpose: 'goal-domain',
      source,
      state: 'active',
      author: { kind: 'human', id: actor.userId },
      authority: { kind: 'human', userId: actor.userId },
      authoredAt: request.decidedAt,
    };
    validatePolicyDocument({ schemaVersion: 1, statements: [active] });
    const anchor = active.lifetime.anchor;
    if (
      anchor.owner.kind !== 'workspace' ||
      anchor.owner.workspaceId !== workspaceId ||
      anchor.kind !== 'goal' ||
      anchor.id !== source.goalId ||
      (active.lifetime.notAfter && Date.now() >= Date.parse(active.lifetime.notAfter)) ||
      (active.lifetime.uses !== undefined &&
        readPolicyStatementUseCount(db, { id: active.id, digest: policyDigest(active) }) -
          (ownDecision &&
          policyStatementUsedByDecision(
            db,
            { id: active.id, digest: policyDigest(active) },
            ownDecision
          )
            ? 1
            : 0) >=
          active.lifetime.uses)
    )
      throw new GoalDomainUnavailable('Goal-domain lifetime is unavailable.');
    if (
      !authorizeWorkspace(deps.coreDb, actor, workspaceId, {
        policyOperation: 'workspace.write',
        mutating: true,
      })
    )
      throw new GoalDomainUnavailable('Goal-domain deciding credential is no longer authorized.');
    const supportError = goalDomainSupportError({
      statement: active,
      workspaceId,
      goalId: source.goalId,
      store: deps.store,
      actor,
      administratorEligible: isCurrentDeploymentAdministrator(deps.coreDb, actor),
    });
    if (supportError) throw new GoalDomainUnavailable(supportError);
    for (const action of active.scope.actions) {
      if (
        !authorizeWorkspace(deps.coreDb, actor, workspaceId, {
          policyOperation: action as keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS,
          mutating: true,
        })
      )
        throw new GoalDomainUnavailable('Goal-domain scope exceeds the deciding human authority.');
    }
    return { statement: active, actor, goal: view.goal, request };
  }

  function coordinatorAuthority(input: GoalDomainAdministrationInput) {
    if (input.workspaceDb.workspaceId !== input.taskLineage.workspaceId)
      throw new Error('Goal administration Workspace differs from its Task lineage.');
    const context = readGoalTaskPolicyContext({
      coreDb: deps.coreDb,
      store: deps.store,
      db: input.workspaceDb,
      lineage: input.taskLineage,
    });
    if (!context || context.goalId !== input.goalId)
      throw new Error('Goal administration requires its exact current Task.');
    const key = { workspaceId: context.workspaceId, goalId: context.goalId };
    const current = loaded();
    if (current.revision !== input.expectedPolicyRevision)
      throw new Error('Goal-domain Policy revision changed.');
    const domain = readCurrent(key);
    if (!domain) throw new Error('Goal administration delegation is unavailable.');
    const goal = readGoalView(deps.store, input.workspaceDb, input.goalId).goal!;
    const actor = goalActor(goal);
    requireCoordinatorGoal(deps.store, input.workspaceDb, {
      actor,
      ...key,
      threadId: goal.threadId,
      turnId: input.coordinatorTurnId,
    });
    if (
      domain.delegate.kind !== 'agent' ||
      domain.delegate.id !== 'goal-coordinator' ||
      context.agentId === domain.delegate.id
    )
      throw new Error('Coordinator cannot widen its own Goal authority.');
    const kernel = currentGoalHuman(goal, key.workspaceId);
    const subject: z.infer<typeof PolicySubjectV1Schema> = {
      principal: domain.delegate,
      onBehalfOf: null,
      actor: { kind: 'agent', id: domain.delegate.id, responsibleUserId: goal.responsibleUserId },
      process: {
        workspaceId: key.workspaceId,
        threadId: goal.threadId,
        turnId: input.coordinatorTurnId,
      },
      credentialKind: actor.kind,
      responsibleHumanId: goal.responsibleUserId,
    };
    return { current, context, key, domain, goal, actor, kernel, subject };
  }

  function currentGoalHuman(
    goal: NonNullable<ReturnType<typeof readGoalView>['goal']>,
    workspaceId: string
  ) {
    const actor = goalActor(goal);
    if (
      !authorizeWorkspace(deps.coreDb, actor, workspaceId, {
        policyOperation: 'workspace.configure',
        mutating: true,
      })
    )
      throw new Error('Goal Coordinator human credential is no longer authorized.');
    const kernel = evaluateProductAuthorization(
      deps.coreDb,
      actor,
      { kind: 'workspace', workspaceId },
      'workspace.configure',
      true
    );
    if (kernel.effect !== 'allow') throw new Error('Goal administration Kernel admission failed.');
    return kernel;
  }

  function permissionAnchorCurrent(
    permission: GoalDomainPermission,
    context: GoalTaskPolicyContext
  ) {
    const anchor = permission.lifetime.anchor;
    return (
      anchor.owner.kind === 'workspace' &&
      anchor.owner.workspaceId === context.workspaceId &&
      ((anchor.kind === 'goal' && anchor.id === context.goalId) ||
        (anchor.kind === 'thread' && anchor.id === context.taskThreadId) ||
        (anchor.kind === 'turn' &&
          anchor.id === context.turnId &&
          !isSealedTurnTerminal(deps.store.getTurnById(anchor.id).status)))
    );
  }

  function persist(
    current: ReturnType<typeof saved>,
    document: PolicyDocumentV1,
    context: {
      key: GoalDomainKey;
      actor?: Actor;
      requestId?: string;
      responsibleUserId: string;
      administration?: {
        recheck: () => ReturnType<typeof coordinatorAuthority>;
        proposal: z.infer<typeof PolicyWriteProposalV1Schema>;
      };
    }
  ) {
    const revision = policyDigest(document);
    const content = `${JSON.stringify(
      {
        ...current.raw,
        policy: {
          ...(current.raw.policy as Record<string, unknown> | undefined),
          mediation: document,
        },
      },
      null,
      2
    )}\n`;
    const validation = deps.files.validate({
      files: [{ id: 'server.jsonc', content }],
      mode: 'safe',
    });
    if (!validation.valid) throw new Error('Goal-domain Policy configuration validation failed.');
    // Validation reads an overlay from disk; reread live approval and credentials
    // before the final Kernel and Server file effect, rather than trusting its old snapshot.
    const administration = context.administration?.recheck();
    if (context.actor) approved(context.key.workspaceId, context.requestId!);

    const kernel =
      administration?.kernel ??
      (context.actor
        ? evaluateProductAuthorization(
            deps.coreDb,
            context.actor,
            { kind: 'workspace', workspaceId: context.key.workspaceId },
            'workspace.write',
            true
          )
        : null);
    const subject =
      administration?.subject ??
      (context.actor
        ? {
            principal: { kind: 'human' as const, id: context.actor.userId },
            onBehalfOf: null,
            actor: { kind: 'user' as const, id: context.actor.userId },
            process: null,
            credentialKind: context.actor.kind,
            responsibleHumanId: context.actor.userId,
          }
        : null);
    if (kernel && kernel.effect !== 'allow')
      throw new Error('Goal-domain Kernel admission failed.');
    // Closure is a native withdrawal, not an impersonated human authorization.
    // Both changes retain the existing Policy decision/Audit before the sole CAS.
    recordProductPermissionDecision({
      coreDb: deps.coreDb,
      ownerScope: 'server',
      decisionId: allocateEntityId('pd'),
      action: 'workspace.configure',
      result: 'allow',
      reasonCode: subject ? 'granted' : 'goal_domain_withdrawn',
      policyEngineVersion: 'nanocore-policy:v1',
      policySnapshotId: current.revision,
      subjectSummary: {
        principal: subject?.principal ?? null,
        responsibleHumanId: context.responsibleUserId,
      },
      resourceSummary: { kind: 'policy', policyRevision: revision },
      contextSummary: {
        operation: 'policy.write',
        cause: administration
          ? 'goal-domain.administer'
          : context.actor
            ? 'goal-domain.activate'
            : 'goal-domain.close',
        ...(context.administration
          ? {
              proposal: context.administration.proposal,
              threadId: subject!.process!.threadId,
              turnId: subject!.process!.turnId,
            }
          : {}),
        ...context.key,
        requestId: context.requestId ?? null,
        responsibleUserId: context.responsibleUserId,
      },
      enforcementPoint: 'policy.write@decide',
      ...(subject
        ? {
            mediation: {
              operation: 'policy.write',
              stage: 'decide' as const,
              proposalDigest: policyDigest(
                context.administration?.proposal ?? {
                  requestId: context.requestId,
                  proposed: document,
                }
              ),
              authorizationRevision: policyDigest({
                actor: administration?.actor ?? context.actor,
                kernel,
              }),
              subject,
              role: 'final' as const,
              kernel: { effect: kernel!.effect, reason: kernel!.reasons[0]?.code ?? 'not_granted' },
              invocations: [],
              consumedStatements: [],
            },
          }
        : {}),
      auditActor: subject
        ? subject.actor
        : {
            kind: 'system',
            id: 'goal-domain-closure',
            responsibleUserId: context.responsibleUserId,
          },
    });
    deps.files.updateFile(
      { id: 'server.jsonc', kind: 'server', content, expectedRevision: current.file.file.revision },
      { policyWrite: true }
    );
    const reload = deps.reload();
    if (reload.status !== 'applied' || loaded().revision !== revision)
      throw new Error('Goal-domain Policy was saved but not admitted; inspect and reload.');
    return revision;
  }

  return {
    /** Publishes only an explicitly bounded exception under the current human-approved domain. */
    administer(input: GoalDomainAdministrationInput) {
      const authority = coordinatorAuthority(input);
      const { current, context, domain, goal, key } = authority;
      const grant = input.grant;
      const permission = PolicyPermissionV1Schema.parse({
        id: grant.id,
        kind: 'permission',
        state: 'active',
        effect: 'allow',
        grant: { kind: 'ordinary' },
        author: domain.delegate,
        authority: {
          kind: 'delegation',
          statement: { id: domain.id, digest: policyDigest(domain) },
        },
        authoredAt: new Date().toISOString(),
        scope: grant.scope,
        lifetime: grant.lifetime,
      });
      if (
        !grant.rationale.trim() ||
        permission.scope.subjects.length !== 1 ||
        permission.scope.subjects[0]?.kind !== 'agent' ||
        permission.scope.subjects[0].id !== context.agentId ||
        !policyScopeContains(domain.scope, permission.scope) ||
        !permissionAnchorCurrent(permission, context) ||
        (permission.lifetime.notAfter &&
          (Date.now() >= Date.parse(permission.lifetime.notAfter) ||
            (domain.lifetime.notAfter &&
              Date.parse(permission.lifetime.notAfter) > Date.parse(domain.lifetime.notAfter)))) ||
        (domain.lifetime.uses !== undefined &&
          permission.lifetime.uses !== undefined &&
          permission.lifetime.uses > domain.lifetime.uses)
      )
        throw new Error(
          'Goal permission exceeds its current delegation, Task identity or lifetime.'
        );
      const previous = current.document.statements.find(({ id }) => id === permission.id);
      if (
        previous &&
        (previous.kind !== 'permission' ||
          previous.authority.kind !== 'delegation' ||
          policyDigest(previous.authority) !== policyDigest(permission.authority) ||
          policyDigest(previous.author) !== policyDigest(permission.author))
      )
        throw new Error('Policy statement identity belongs to another authority.');
      const document = validatePolicyDocument({
        schemaVersion: 1,
        statements: [
          ...current.document.statements.filter(({ id }) => id !== permission.id),
          permission,
        ],
      });
      const proposal = PolicyWriteProposalV1Schema.parse({
        schemaVersion: 1,
        proposer: domain.delegate,
        rationale: grant.rationale,
        baseRevision: current.revision,
        proposed: document,
        validation: 'valid',
      });
      const policyRevision = persist(current, document, {
        key,
        responsibleUserId: goal.responsibleUserId,
        administration: { proposal, recheck: () => coordinatorAuthority(input) },
      });
      return { statement: permission, policyRevision };
    },

    /** Current native Task facts select only live exceptions; a historical allow is never a new use. */
    readPermissions(input: {
      readonly context: GoalTaskPolicyContext;
      readonly decision?: PolicyUseDecision;
    }): GoalDomainPermission[] {
      const { context, decision } = input;
      const key = { workspaceId: context.workspaceId, goalId: context.goalId };
      const current = loaded();
      const domain = readCurrent(key, decision);
      if (!domain) return [];
      const goal = readGoalView(
        deps.store,
        deps.repositoryWorkspaceDb(context.workspaceId),
        context.goalId
      ).goal!;
      currentGoalHuman(goal, context.workspaceId);
      const reference = { id: domain.id, digest: policyDigest(domain) };
      const db = deps.repositoryWorkspaceDb(context.workspaceId);
      return current.document.statements.filter((value): value is GoalDomainPermission => {
        if (
          value.kind !== 'permission' ||
          value.state !== 'active' ||
          value.effect !== 'allow' ||
          value.grant.kind !== 'ordinary' ||
          value.authority.kind !== 'delegation' ||
          policyDigest(value.authority.statement) !== policyDigest(reference) ||
          policyDigest(value.author) !== policyDigest(domain.delegate) ||
          value.scope.subjects.length !== 1 ||
          value.scope.subjects[0]?.kind !== 'agent' ||
          value.scope.subjects[0].id !== context.agentId ||
          !policyScopeContains(domain.scope, value.scope) ||
          !permissionAnchorCurrent(value, context) ||
          (value.lifetime.notAfter && Date.now() >= Date.parse(value.lifetime.notAfter))
        )
          return false;
        if (value.lifetime.uses === undefined) return true;
        const ref = { id: value.id, digest: policyDigest(value) };
        const own = decision && policyStatementUsedByDecision(db, ref, decision) ? 1 : 0;
        return readPolicyStatementUseCount(db, ref) - own < value.lifetime.uses;
      });
    },

    /** Reads all authority from the completed joint request; no second human approval exists. */
    activate(input: {
      readonly workspaceId: string;
      readonly requestId: string;
      readonly expectedPolicyRevision: string;
    }) {
      // Publication is a Server file effect and must follow the Goal SQL commit.
      if (deps.repositoryWorkspaceDb(input.workspaceId).sqlite.inTransaction)
        throw new Error('Goal-domain publication requires the committed Goal transaction.');
      const current = loaded();
      if (current.revision !== input.expectedPolicyRevision)
        throw new Error('Goal-domain Policy revision changed.');
      const approval = approved(input.workspaceId, input.requestId);
      const statement = approval.statement;
      const existing = current.document.statements.find(({ id }) => id === statement.id);
      if (existing && policyDigest(existing) === policyDigest(statement))
        return { statement, policyRevision: current.revision };
      if (existing) {
        if (
          existing.kind !== 'delegation' ||
          existing.source.workspaceId !== input.workspaceId ||
          existing.source.goalId !== statement.source.goalId
        )
          throw new Error('Goal-domain statement identity belongs to another authority.');
        // A withdrawn current declaration cannot be revived by its old approval.
        // A later joint Plan approval can replace the same Goal-owned identity.
        if (existing.source.approvalRequestId === input.requestId)
          throw new Error(
            'Goal-domain statement is inactive or changed; a new joint approval is required.'
          );
      }
      const document = validatePolicyDocument({
        schemaVersion: 1,
        statements: [
          ...current.document.statements.filter((item) => item.id !== statement.id),
          statement,
        ],
      });
      const policyRevision = persist(current, document, {
        key: { workspaceId: input.workspaceId, goalId: statement.source.goalId },
        actor: approval.actor,
        requestId: input.requestId,
        responsibleUserId: approval.goal.responsibleUserId,
      });
      return { statement, policyRevision };
    },

    /** Rechecks the recorded human, exact Plan, saved/loaded revision and lifetime on every use. */
    read(key: GoalDomainKey): GoalDomainStatement | null {
      return readCurrent(key);
    },

    /** Dispatch-only readback: recognizes this exact allow's own use, never a new authorization. */
    readForDecision(
      key: GoalDomainKey & { readonly decision: PolicyUseDecision }
    ): GoalDomainStatement | null {
      return readCurrent(key, key.decision);
    },

    /** Withdraws only this Goal without requiring its old Plan or human credential to remain valid. */
    close(key: GoalDomainKey) {
      const current = saved();
      const statements = current.document.statements.map((statement) =>
        statement.kind === 'delegation' &&
        statement.purpose === 'goal-domain' &&
        statement.state === 'active' &&
        statement.source?.workspaceId === key.workspaceId &&
        statement.source.goalId === key.goalId
          ? { ...statement, state: 'inactive' as const }
          : statement
      );
      if (policyDigest(statements) === policyDigest(current.document.statements))
        return { changed: false, policyRevision: current.revision };
      const previous = current.document.statements.find(
        (statement) =>
          statement.kind === 'delegation' &&
          statement.source?.workspaceId === key.workspaceId &&
          statement.source.goalId === key.goalId
      )!;
      const policyRevision = persist(
        current,
        validatePolicyDocument({ schemaVersion: 1, statements }),
        {
          key,
          responsibleUserId:
            readGoalView(deps.store, deps.repositoryWorkspaceDb(key.workspaceId), key.goalId).goal
              ?.responsibleUserId ?? previous.author.id,
        }
      );
      return { changed: true, policyRevision };
    },
  };

  function readCurrent(
    key: GoalDomainKey,
    ownDecision?: PolicyUseDecision
  ): GoalDomainStatement | null {
    const current = loaded();
    if (ownDecision && ownDecision.policyRevision !== current.revision) return null;
    const candidates = current.document.statements.filter(
      (statement) =>
        statement.kind === 'delegation' &&
        statement.purpose === 'goal-domain' &&
        statement.state === 'active' &&
        statement.source?.workspaceId === key.workspaceId &&
        statement.source.goalId === key.goalId
    );
    const currentStatements = candidates.filter((value) => {
      const statement = value as GoalDomainStatement;
      try {
        const approval = approved(key.workspaceId, statement.source.approvalRequestId, ownDecision);
        return policyDigest(approval.statement) === policyDigest(statement);
      } catch (error) {
        if (error instanceof GoalDomainUnavailable) return false;
        throw error;
      }
    });
    return currentStatements.length === 1 ? (currentStatements[0]! as GoalDomainStatement) : null;
  }
}

/** Native Goal consumers use the same instance shape without importing transport types. */
export type GoalDomainPolicyService = ReturnType<typeof createGoalDomainPolicyService>;
