import type { PolicyDecision } from '@openkit/policy-kernel';
import type { PolicyResourceV1Schema, PolicySubjectV1Schema } from '@openkit/protocol';
import type { z } from 'zod';
import type { FsStore } from '../lib/store.js';
import { readGoalView } from '../runtime/goal-owner.js';
import { readGoalTaskPolicyContext } from '../runtime/goal-task-policy-context.js';
import type { SchedulerExecutionLineage } from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { GoalDomainPolicyService } from './goal-domains.js';
import { evaluateGoalTaskAccess, evaluateGoalTaskAdmission } from './goal-task-access.js';
import type { PolicyUseDecision } from './permission-decisions.js';
import { policyDigest } from './statements.js';

/** Actual native Worker facts; the live and captured entry owners keep their own lifecycle guards. */
export interface GoalTaskEvaluationInput {
  readonly workspaceDb: WorkspaceDb;
  readonly lineage: SchedulerExecutionLineage;
  readonly subject: z.infer<typeof PolicySubjectV1Schema>;
  readonly operation: string;
  readonly resource: z.infer<typeof PolicyResourceV1Schema>;
  readonly humanKernel: PolicyDecision;
}

/** Joins the canonical Task reader and current Policy owner without retaining another envelope. */
export function createGoalTaskPolicyService(deps: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly domains: GoalDomainPolicyService;
}) {
  function evaluate(input: GoalTaskEvaluationInput, decision?: PolicyUseDecision) {
    const context = readGoalTaskPolicyContext({
      coreDb: deps.coreDb,
      store: deps.store,
      db: input.workspaceDb,
      lineage: input.lineage,
    });
    if (!context) return null;
    if (
      input.subject.principal.kind !== 'agent' ||
      input.subject.principal.id !== context.agentId ||
      input.subject.responsibleHumanId !== context.responsibleUserId ||
      input.subject.process?.workspaceId !== context.workspaceId ||
      input.subject.process.threadId !== context.taskThreadId ||
      input.subject.process.turnId !== context.turnId
    )
      throw new Error('Goal Task Policy subject must match the canonical current Task context.');
    const key = { workspaceId: context.workspaceId, goalId: context.goalId };
    const domain = decision
      ? deps.domains.readForDecision({ ...key, decision })
      : deps.domains.read(key);
    const result = evaluateGoalTaskAccess({
      ...input,
      domain,
      responsibleHumanId: context.responsibleUserId,
      resources: context.resources,
    });
    return {
      ...result,
      authorizationRevision: policyDigest({
        scope: result.authorizationRevision,
        requestInputHash: context.requestInputHash,
      }),
      authorizationUses:
        domain?.lifetime.uses !== undefined && result.kernel.effect === 'allow'
          ? [
              {
                statement: { id: domain.id, digest: policyDigest(domain) },
                limit: domain.lifetime.uses,
              },
            ]
          : [],
    };
  }
  return {
    /** Null is only an ordinary unlinked Task; a linked unavailable domain produces a Kernel deny. */
    evaluateTask(input: GoalTaskEvaluationInput) {
      return evaluate(input);
    },
    /** Rechecks this same effect after its final atomic allow; never use this to authorize a new call. */
    readTaskDecision(input: GoalTaskEvaluationInput & { readonly decision: PolicyUseDecision }) {
      const result = evaluate(input, input.decision);
      if (!result) return null;
      const { authorizationUses: _uses, ...current } = result;
      return current;
    },
    /** Prepared Task facts precede any Session; this admission does not grant or consume an effect. */
    evaluateAdmission(input: {
      readonly workspaceDb: WorkspaceDb;
      readonly goalId: string;
      readonly planVersionId: string;
      readonly agentId: string;
      readonly responsibleHumanId: string;
      readonly resources: readonly z.infer<typeof PolicyResourceV1Schema>[];
      readonly humanKernel: PolicyDecision;
    }) {
      const workspaceId = input.workspaceDb.workspaceId;
      const goal = readGoalView(deps.store, input.workspaceDb, input.goalId).goal;
      if (
        !goal ||
        goal.disposition ||
        goal.workspaceId !== workspaceId ||
        goal.responsibleUserId !== input.responsibleHumanId ||
        goal.activePlanVersionId !== input.planVersionId
      )
        throw new Error(
          'Prepared Task Policy admission requires the current Goal, Plan and responsible human.'
        );
      return evaluateGoalTaskAdmission({
        ...input,
        workspaceId,
        domain: deps.domains.read({ workspaceId, goalId: input.goalId }),
      });
    },
  };
}

/** Native Goal/Task consumers use the service without importing transport projections. */
export type GoalTaskPolicyService = ReturnType<typeof createGoalTaskPolicyService>;
