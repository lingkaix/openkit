import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import { PolicyResourceV1Schema, PolicySubjectV1Schema } from '@openkit/protocol';
import type { z } from 'zod';
import type { GoalDomainStatement } from './goal-domains.js';
import { policyDigest } from './statements.js';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from './workspace-access.js';

/** Trusted native input after current Goal-domain read and exact scheduler admission readback. */
export interface GoalTaskAccessInput {
  /** Must come from GoalDomainPolicyService.read for this attempt, never cached/model input. */
  readonly domain: GoalDomainStatement | null;
  /** Actual agent principal, actor and process restored by the Worker lineage owner. */
  readonly subject: z.infer<typeof PolicySubjectV1Schema>;
  /** Only explicit Policy resources from the exact retained Task request. */
  readonly resources: readonly z.infer<typeof PolicyResourceV1Schema>[];
  readonly operation: string;
  readonly resource: z.infer<typeof PolicyResourceV1Schema>;
  /** Existing current human/credential admission remains independently mandatory. */
  readonly humanKernel: PolicyDecision;
}

/** Current Kernel result and non-retained scope/revision projections for the native caller. */
export interface GoalTaskAccessResult {
  readonly kernel: PolicyDecision;
  /** Scope membership only; this is not permission or evidence that no prohibition exists. */
  readonly inGoalEnvelope: boolean;
  /** Include in existing currentness checks; do not create another retained revision owner. */
  readonly authorizationRevision: string;
}

/**
 * Projects the explicit Goal and Task selectors into two NGAC policy classes.
 * Both associations are mandatory in the existing Kernel; no local scope check returns allow.
 * Current domain/credential/lifecycle and Task identity reads stay with their existing owners.
 * This initial hook does not activate delegated permissions or perform Coordinator administration.
 */
export function evaluateGoalTaskAccess(input: GoalTaskAccessInput): GoalTaskAccessResult {
  const subject = PolicySubjectV1Schema.parse(input.subject);
  const resource = PolicyResourceV1Schema.parse(input.resource);
  const resources = input.resources.map((value) => PolicyResourceV1Schema.parse(value));
  const domain = input.domain;
  const resourceDigest = policyDigest(resource);
  const inGoalEnvelope = Boolean(
    domain?.state === 'active' &&
      domain.author.kind === 'human' &&
      subject.principal.kind === 'agent' &&
      subject.onBehalfOf === null &&
      subject.actor.kind === 'agent' &&
      subject.actor.id === subject.principal.id &&
      subject.actor.responsibleUserId === subject.responsibleHumanId &&
      subject.responsibleHumanId === domain.author.id &&
      subject.process?.workspaceId === domain.source.workspaceId &&
      domain.scope.subjects.some(
        (value) => value.kind === 'agent' && value.id === subject.principal.id
      ) &&
      domain.scope.actions.includes(input.operation) &&
      domain.scope.resources.some((value) => policyDigest(value) === resourceDigest)
  );
  const selectedByTask = resources.some((value) => policyDigest(value) === resourceDigest);
  const operation = Object.hasOwn(PRODUCT_OPERATION_ACCESS_RIGHTS, input.operation)
    ? (input.operation as keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS)
    : null;
  const accessRights = operation ? [PRODUCT_OPERATION_ACCESS_RIGHTS[operation]] : [];
  // Graph-local names are disjoint from attributes and are not product identifiers.
  const user = `${subject.principal.kind}:${subject.principal.id}`;
  const classes = ['goal-envelope', 'goal-task'] as const;
  const graph: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: 'goal-request', kind: 'object' },
      ...classes.flatMap((id) => [
        { id: `ua:${id}`, kind: 'userAttribute' as const },
        { id: `oa:${id}`, kind: 'objectAttribute' as const },
        { id: `pc:${id}`, kind: 'policyClass' as const },
      ]),
    ],
    assignments: classes.flatMap((id) => [
      { child: user, parent: `ua:${id}` },
      { child: `ua:${id}`, parent: `pc:${id}` },
      { child: 'goal-request', parent: `oa:${id}` },
      { child: `oa:${id}`, parent: `pc:${id}` },
    ]),
    operations: operation ? [{ id: operation, accessRights }] : [],
    associations: classes
      .filter((id) => (id === 'goal-envelope' ? inGoalEnvelope : selectedByTask))
      .map((id) => ({ id, userAttribute: `ua:${id}`, targetAttribute: `oa:${id}`, accessRights })),
    ...(subject.process ? { processUsers: [{ process: subject.process.turnId, user }] } : {}),
  };
  const kernel =
    input.humanKernel.effect === 'deny'
      ? input.humanKernel
      : evaluateAccess(graph, {
          operation: input.operation,
          target: 'goal-request',
          user,
          ...(subject.process ? { process: subject.process.turnId } : {}),
        });
  return {
    kernel,
    inGoalEnvelope,
    authorizationRevision: policyDigest({
      domain: domain ? { id: domain.id, digest: policyDigest(domain) } : null,
      subject,
      resources,
      operation: input.operation,
      resource,
      humanKernel: input.humanKernel,
    }),
  };
}
