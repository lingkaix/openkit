import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import { PolicyDocumentV1Schema } from '@openkit/protocol';
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

/** Maps one current finite statement to the existing Kernel; the native caller supplies current issuer authority. */
export function evaluateWorkerGitReadMaintenance(
  policyDocument: unknown,
  facts: WorkerGitReadMaintenanceFacts,
  authorCurrent: (humanId: string) => boolean
): PolicyDecision {
  const parsed = PolicyDocumentV1Schema.safeParse(policyDocument);
  const candidates = parsed.success
    ? parsed.data.statements.filter((statement) => {
        if (
          statement.kind !== 'permission' ||
          statement.grant.kind !== 'worker-git-read-maintenance'
        )
          return false;
        const subject = statement.scope.subjects[0];
        const resource = statement.scope.resources[0];
        return (
          statement.scope.subjects.length === 1 &&
          subject?.kind === 'human' &&
          subject.id === facts.responsibleUserId &&
          statement.scope.resources.length === 1 &&
          resource?.kind === 'container' &&
          resource.container.owner.kind === 'server' &&
          resource.container.kind === 'agent' &&
          resource.container.id === facts.agentId &&
          statement.grant.networkGrantId === facts.networkGrantId
        );
      })
    : [];
  const statement = candidates.length === 1 ? candidates[0] : null;
  const grant =
    statement?.kind === 'permission' && statement.grant.kind === 'worker-git-read-maintenance'
      ? statement.grant
      : null;
  const now = facts.now.getTime();
  const allowed =
    statement?.kind === 'permission' &&
    grant !== null &&
    statement.state === 'active' &&
    statement.effect === 'allow' &&
    statement.author.kind === 'human' &&
    statement.authority.kind === 'human' &&
    statement.author.id === statement.authority.userId &&
    authorCurrent?.(statement.author.id) === true &&
    statement.scope.actions.length === 1 &&
    statement.scope.actions[0] === 'administration.configuration.apply' &&
    statement.lifetime.anchor.owner.kind === 'server' &&
    statement.lifetime.anchor.kind === 'agent' &&
    statement.lifetime.anchor.id === facts.agentId &&
    statement.lifetime.uses === undefined &&
    statement.lifetime.notAfter !== undefined &&
    Number.isFinite(now) &&
    Date.parse(grant.validFrom) <= now &&
    now < Date.parse(statement.lifetime.notAfter) &&
    grant.host === facts.host &&
    grant.port === facts.port &&
    grant.protocol === facts.protocol &&
    grant.repositoryPaths.includes(facts.repositoryPath) &&
    facts.binaries.length > 0 &&
    facts.binaries.every((binary) => grant.binaries.includes(binary));
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
