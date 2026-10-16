import { WorkerGitReadMaintenanceAssignmentSchema } from '@openkit/config-schema';
import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from './workspace-access.js';

/** Immutable facts derived by the configuration owner before an exact Server-scoped effect. */
export interface WorkerGitReadMaintenanceFacts {
  readonly responsibleUserId: string;
  readonly agentId: string;
  readonly networkGrantId: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: string;
  readonly repositoryPath: string;
  readonly binaries: readonly string[];
  readonly now: Date;
}

/** Maps one current finite assignment to existing NGAC evaluation without storing authority. Missing, malformed, conflicting, disabled and out-of-scope assignments supply no association. */
export function evaluateWorkerGitReadMaintenance(
  assignments: readonly unknown[],
  facts: WorkerGitReadMaintenanceFacts
): PolicyDecision {
  const candidates = assignments.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const value = entry as Record<string, unknown>;
    return (
      value.responsibleUserId === facts.responsibleUserId &&
      value.agentId === facts.agentId &&
      value.networkGrantId === facts.networkGrantId
    );
  });
  const parsed =
    candidates.length === 1
      ? WorkerGitReadMaintenanceAssignmentSchema.safeParse(candidates[0])
      : null;
  const assignment = parsed?.success ? parsed.data : null;
  const now = facts.now.getTime();
  const allowed =
    assignment !== null &&
    assignment.enabled &&
    Number.isFinite(now) &&
    Date.parse(assignment.validFrom) <= now &&
    now < Date.parse(assignment.expiresAt) &&
    assignment.host === facts.host &&
    assignment.port === facts.port &&
    assignment.protocol === facts.protocol &&
    assignment.repositoryPaths.includes(facts.repositoryPath) &&
    facts.binaries.length > 0 &&
    facts.binaries.every((binary) => assignment.binaries.includes(binary));
  const operation = 'administration.configuration.apply';
  const accessRight = PRODUCT_OPERATION_ACCESS_RIGHTS[operation];
  const policy: PolicyState = {
    elements: [
      { id: 'user:maintenance-actor', kind: 'user' },
      { id: 'ua:finite-maintenance', kind: 'userAttribute' },
      { id: 'object:registered-server-agent', kind: 'object' },
      { id: 'oa:git-read-correction', kind: 'objectAttribute' },
      { id: 'pc:server-maintenance', kind: 'policyClass' },
    ],
    assignments: [
      { child: 'user:maintenance-actor', parent: 'ua:finite-maintenance' },
      { child: 'ua:finite-maintenance', parent: 'pc:server-maintenance' },
      { child: 'object:registered-server-agent', parent: 'oa:git-read-correction' },
      { child: 'oa:git-read-correction', parent: 'pc:server-maintenance' },
    ],
    associations: allowed
      ? [
          {
            id: 'assoc:finite-git-read-maintenance',
            userAttribute: 'ua:finite-maintenance',
            targetAttribute: 'oa:git-read-correction',
            accessRights: [accessRight],
          },
        ]
      : [],
    operations: [{ id: operation, accessRights: [accessRight] }],
  };
  return evaluateAccess(policy, {
    user: 'user:maintenance-actor',
    target: 'object:registered-server-agent',
    operation,
  });
}
