import { createHash } from 'node:crypto';
import { OpenKitConfigSchema } from '@openkit/config-schema';
import {
  allocateEntityId,
  type PolicyDocumentV1,
  PolicyDelegationV1Schema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { authorizeWorkspace, isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { parseJsoncObject } from '../config/jsonc.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import type { FsStore } from '../lib/store.js';
import { readGoalView } from '../runtime/goal-owner.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { readAdmittedPolicyDocument } from './configuration.js';
import {
  readPolicyStatementUseCount,
  recordProductPermissionDecision,
} from './permission-decisions.js';
import { evaluateAdministratorWorkspaceAccess } from './server-access.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest, validatePolicyDocument } from './statements.js';
import { evaluateWorkspaceMemberAccess, PRODUCT_OPERATION_ACCESS_RIGHTS } from './workspace-access.js';

/** Existing delegation format with the Goal lineage required by its native consumer. */
export type GoalDomainStatement = z.infer<typeof PolicyDelegationV1Schema> & {
  purpose: 'goal-domain';
  source: NonNullable<z.infer<typeof PolicyDelegationV1Schema>['source']>;
};

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

const CapturedDomain = z.object({
  statement: PolicyDelegationV1Schema,
  digest: z.string(),
}).strict();

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

  function approved(workspaceId: string, requestId: string) {
    const db = deps.repositoryWorkspaceDb(workspaceId);
    // Goal completion and the Server file are separate commits. Never publish from
    // an in-flight Goal transaction or turn a recorded grant into a completed effect.
    if (db.sqlite.inTransaction)
      throw new Error('Goal-domain publication requires the committed Goal transaction.');
    const request = readPendingRequest(db.sqlite, requestId);
    const intent = request?.governedIntent;
    const capture = CapturedDomain.parse(intent?.goalDomain);
    const statement = capture.statement;
    const source = statement.source;
    if (
      statement.kind !== 'delegation' || statement.purpose !== 'goal-domain' ||
      statement.state !== 'inactive' || !source ||
      policyDigest(statement) !== capture.digest ||
      source.workspaceId !== workspaceId || source.approvalRequestId !== requestId ||
      request?.workspaceId !== workspaceId || request.kind !== 'approval' ||
      request.requesterKind !== 'coordinator' || request.state !== 'resolved' ||
      request.resolution !== 'granted' || request.claim !== 'finished' ||
      request.disposition !== 'approved-executed' ||
      request.decidingActor?.kind !== 'user' || !request.decidingActorContext ||
      request.decidingActor.id !== request.decidingActorContext.userId || !request.decidedAt ||
      intent?.operation !== 'goal.plan.approve' || intent.goalId !== source.goalId ||
      intent.planVersionId !== source.planVersionId || intent.digest !== source.planDigest ||
      statement.delegate.kind !== 'agent' || statement.delegate.id !== request.agentId
    ) throw new Error('Goal domain requires the exact completed joint human approval.');
    const view = readGoalView(deps.store, db, source.goalId);
    const version = view.versions.find((item) => item.planVersionId === source.planVersionId);
    if (
      !view.goal || view.goal.workspaceId !== workspaceId || view.goal.disposition !== null ||
      view.goal.threadId !== request.threadId ||
      view.goal.activePlanVersionId !== source.planVersionId || !version ||
      version.pendingRequestId !== requestId || version.digest !== source.planDigest ||
      version.bytes !== intent.bytes ||
      `sha256:${createHash('sha256').update(version.bytes).digest('hex')}` !== source.planDigest
    ) throw new Error('Goal-domain Plan is absent, obsolete or closed.');
    const actor = request.decidingActorContext;
    const active: GoalDomainStatement = {
      ...statement,
      purpose: 'goal-domain', source, state: 'active',
      author: { kind: 'human', id: actor.userId },
      authority: { kind: 'human', userId: actor.userId },
      authoredAt: request.decidedAt,
    };
    validatePolicyDocument({ schemaVersion: 1, statements: [active] });
    const anchor = active.lifetime.anchor;
    if (
      anchor.owner.kind !== 'workspace' || anchor.owner.workspaceId !== workspaceId ||
      anchor.kind !== 'goal' || anchor.id !== source.goalId ||
      (active.lifetime.notAfter && Date.now() >= Date.parse(active.lifetime.notAfter)) ||
      (active.lifetime.uses !== undefined &&
        readPolicyStatementUseCount(db, { id: active.id, digest: policyDigest(active) }) >= active.lifetime.uses)
    ) throw new Error('Goal-domain lifetime is unavailable.');
    if (!authorizeWorkspace(deps.coreDb, actor, workspaceId, {
      policyOperation: 'workspace.write', mutating: true,
    })) throw new Error('Goal-domain deciding credential is no longer authorized.');
    for (const resource of active.scope.resources) {
      const resourceWorkspaceId = resource.kind === 'mcp-tool' ? resource.workspaceId :
        resource.container.owner.kind === 'workspace' ? resource.container.owner.workspaceId : null;
      if (resourceWorkspaceId !== workspaceId)
        throw new Error('Goal-domain resources must remain in their approved Workspace.');
      if (resource.kind === 'container') {
        const container = resource.container;
        const valid =
          (container.kind === 'goal' && container.id === source.goalId) ||
          (container.kind === 'workspace' && container.id === workspaceId) ||
          (container.kind === 'thread' && isThreadIdVisible(deps.store, workspaceId, container.id,
            actor.userId, isCurrentDeploymentAdministrator(deps.coreDb, actor))) ||
          (container.kind === 'turn' && (() => {
            const turn = deps.store.getTurnById(container.id);
            return turn.workspaceId === workspaceId && isThreadIdVisible(deps.store, workspaceId,
              turn.threadId, actor.userId, isCurrentDeploymentAdministrator(deps.coreDb, actor));
          })());
        if (!valid) throw new Error('Goal-domain resource container is unavailable.');
      }
      for (const action of active.scope.actions) {
        if (!Object.hasOwn(PRODUCT_OPERATION_ACCESS_RIGHTS, action) ||
          !authorizeWorkspace(deps.coreDb, actor, workspaceId, { policyOperation:
            action as keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS, mutating: true }))
          throw new Error('Goal-domain scope exceeds the deciding human authority.');
      }
    }
    return { statement: active, actor, goal: view.goal, request };
  }

  function persist(current: ReturnType<typeof saved>, document: PolicyDocumentV1,
    context: { key: GoalDomainKey; actor?: Actor; requestId?: string; responsibleUserId: string }) {
    const revision = policyDigest(document);
    const content = `${JSON.stringify({ ...current.raw, policy: {
      ...(current.raw.policy as Record<string, unknown> | undefined), mediation: document,
    } }, null, 2)}\n`;
    const validation = deps.files.validate({ files: [{ id: 'server.jsonc', content }], mode: 'safe' });
    if (!validation.valid) throw new Error('Goal-domain Policy configuration validation failed.');
    const kernel = context.actor ?
      isCurrentDeploymentAdministrator(deps.coreDb, context.actor) ?
        evaluateAdministratorWorkspaceAccess({ userId: context.actor.userId,
          workspaceId: context.key.workspaceId, operation: 'workspace.write' }) :
        evaluateWorkspaceMemberAccess({ operation: 'workspace.write' }) : null;
    if (kernel && kernel.effect !== 'allow') throw new Error('Goal-domain Kernel admission failed.');
    // Closure is a native withdrawal, not an impersonated human authorization.
    // Both changes retain the existing Policy decision/Audit before the sole CAS.
    recordProductPermissionDecision({
      coreDb: deps.coreDb, ownerScope: 'server', decisionId: allocateEntityId('pd'),
      action: 'workspace.configure', result: 'allow',
      reasonCode: context.actor ? 'granted' : 'goal_domain_withdrawn',
      policyEngineVersion: 'nanocore-policy:v1', policySnapshotId: current.revision,
      subjectSummary: { principal: context.actor ? { kind: 'human', id: context.actor.userId } : null,
        responsibleHumanId: context.responsibleUserId },
      resourceSummary: { kind: 'policy', policyRevision: revision },
      contextSummary: { operation: 'policy.write', cause: context.actor ? 'goal-domain.activate' :
        'goal-domain.close', ...context.key, requestId: context.requestId ?? null,
        responsibleUserId: context.responsibleUserId },
      enforcementPoint: 'policy.write@decide',
      ...(context.actor ? { mediation: {
        operation: 'policy.write', stage: 'decide' as const, point: 'policy.write@decide',
        proposalDigest: policyDigest({ requestId: context.requestId, proposed: document }),
        policyRevision: current.revision,
        authorizationRevision: policyDigest({ actor: context.actor, kernel }),
        subject: { principal: { kind: 'human' as const, id: context.actor.userId }, onBehalfOf: null,
          actor: { kind: 'user' as const, id: context.actor.userId }, process: null,
          credentialKind: context.actor.kind, responsibleHumanId: context.actor.userId },
        role: 'final' as const, kernel: { effect: kernel!.effect,
          reason: kernel!.reasons[0]?.code ?? 'not_granted' }, invocations: [], consumedStatements: [],
      } } : {}),
      auditActor: context.actor ? { kind: 'user', id: context.actor.userId } :
        { kind: 'system', id: 'goal-domain-closure', responsibleUserId: context.responsibleUserId },
    });
    deps.files.updateFile({ id: 'server.jsonc', kind: 'server', content,
      expectedRevision: current.file.file.revision }, { policyWrite: true });
    const reload = deps.reload();
    if (reload.status !== 'applied' || loaded().revision !== revision)
      throw new Error('Goal-domain Policy was saved but not admitted; inspect and reload.');
    return revision;
  }

  return {
    /** Reads all authority from the completed joint request; no second human approval exists. */
    activate(input: { readonly workspaceId: string; readonly requestId: string;
      readonly expectedPolicyRevision: string }) {
      const current = loaded();
      if (current.revision !== input.expectedPolicyRevision)
        throw new Error('Goal-domain Policy revision changed.');
      const approval = approved(input.workspaceId, input.requestId);
      const statement = approval.statement;
      const existing = current.document.statements.find(({ id }) => id === statement.id);
      if (existing && policyDigest(existing) === policyDigest(statement))
        return { statement, policyRevision: current.revision };
      if (existing && policyDigest(existing) !== policyDigest(CapturedDomain.parse(
        approval.request.governedIntent!.goalDomain).statement))
        throw new Error('Goal-domain statement identity already has different content.');
      const document = validatePolicyDocument({ schemaVersion: 1, statements: [
        ...current.document.statements.filter((item) => item.id !== statement.id), statement,
      ] });
      const policyRevision = persist(current, document, {
        key: { workspaceId: input.workspaceId, goalId: statement.source.goalId },
        actor: approval.actor, requestId: input.requestId,
        responsibleUserId: approval.goal.responsibleUserId,
      });
      return { statement, policyRevision };
    },

    /** Rechecks the recorded human, exact Plan, saved/loaded revision and lifetime on every use. */
    read(key: GoalDomainKey): GoalDomainStatement | null {
      const current = loaded();
      const candidates = current.document.statements.filter((statement) =>
        statement.kind === 'delegation' && statement.purpose === 'goal-domain' &&
        statement.state === 'active' && statement.source?.workspaceId === key.workspaceId &&
        statement.source.goalId === key.goalId);
      if (candidates.length !== 1) return null;
      const statement = candidates[0]! as GoalDomainStatement;
      try {
        const approval = approved(key.workspaceId, statement.source.approvalRequestId);
        return policyDigest(approval.statement) === policyDigest(statement) ? statement : null;
      } catch { return null; }
    },

    /** Withdraws only this Goal without requiring its old Plan or human credential to remain valid. */
    close(key: GoalDomainKey) {
      const current = saved();
      const statements = current.document.statements.map((statement) =>
        statement.kind === 'delegation' && statement.purpose === 'goal-domain' &&
        statement.state === 'active' && statement.source?.workspaceId === key.workspaceId &&
        statement.source.goalId === key.goalId ? { ...statement, state: 'inactive' as const } : statement);
      if (policyDigest(statements) === policyDigest(current.document.statements))
        return { changed: false, policyRevision: current.revision };
      const previous = current.document.statements.find((statement) => statement.kind === 'delegation' &&
        statement.source?.workspaceId === key.workspaceId && statement.source.goalId === key.goalId)!;
      const policyRevision = persist(current, validatePolicyDocument({ schemaVersion: 1, statements }), {
        key, responsibleUserId: previous.author.id,
      });
      return { changed: true, policyRevision };
    },
  };
}

/** Native Goal consumers use the same instance shape without importing transport types. */
export type GoalDomainPolicyService = ReturnType<typeof createGoalDomainPolicyService>;
