import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import type {
  PolicyContainerV1Schema,
  PolicyResourceV1Schema,
  PolicyScopeV1Schema,
  PolicySubjectV1Schema,
} from '@openkit/protocol';
import type { z } from 'zod';
import { policyDigest, policyScopeContains } from './statements.js';

/** Current canonical audience projection, supplied by the existing visibility owner. */
export type ContextAudience =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'workspace'; readonly workspaceId: string };

/** Trusted current read facts; this is neither a retained context nor an identity issuer. */
export interface AgentContextReadAccessInput {
  readonly subject: z.infer<typeof PolicySubjectV1Schema>;
  readonly operation: string;
  readonly resource: z.infer<typeof PolicyResourceV1Schema>;
  /** Includes current accountability, human-approved domain and credential constraints. */
  readonly agentKernel: PolicyDecision;
  /** Current on-behalf-of User authority, bound to this same native read. */
  readonly initiatorKernel: PolicyDecision | null;
  readonly envelope: z.infer<typeof PolicyScopeV1Schema>;
  readonly context: {
    readonly preset: 'owner-direct' | 'workspace-members' | 'agent-initiated';
    readonly surface: 'app' | 'channel-direct';
    readonly conversation: z.infer<typeof PolicyContainerV1Schema>;
    readonly initiative: 'requested' | 'self';
    readonly audience: ContextAudience | null;
    /** Canonical source classification, never inferred from requester read authority. */
    readonly resourceAudience: ContextAudience;
    readonly trigger: {
      readonly agentId: string;
      readonly responsibleHumanId: string;
      readonly targets: readonly z.infer<typeof PolicyResourceV1Schema>[];
    } | null;
  };
}

/** Refuses absent or unsupported classification rather than treating it as shared material. */
function knownAudience(audience: ContextAudience | null | undefined): audience is ContextAudience {
  return (
    (audience?.kind === 'user' &&
      typeof audience.userId === 'string' &&
      audience.userId.length > 0) ||
    (audience?.kind === 'workspace' &&
      typeof audience.workspaceId === 'string' &&
      audience.workspaceId.length > 0)
  );
}

/** Intersects current upstream Kernel facts with a closed read context using mandatory classes.
 * Human-credential and Goal/Task calls retain their existing admission owners. This projection
 * covers resource reads only; it supplies no source-free effect or outbound approval authority.
 */
export function evaluateAgentContextReadAccess(input: AgentContextReadAccessInput): PolicyDecision {
  if (input.agentKernel.effect === 'deny') return input.agentKernel;
  if (input.subject.onBehalfOf !== null && input.initiatorKernel?.effect === 'deny')
    return input.initiatorKernel;

  const { subject, context } = input;
  const audience = context.audience;
  const source = context.resourceAudience;
  const requested =
    context.initiative === 'requested' &&
    typeof subject.onBehalfOf === 'string' &&
    subject.onBehalfOf.length > 0 &&
    input.initiatorKernel?.effect === 'allow';
  const establishedTrigger =
    context.initiative === 'self' &&
    subject.onBehalfOf === null &&
    input.initiatorKernel === null &&
    subject.principal.kind === 'agent' &&
    typeof subject.responsibleHumanId === 'string' &&
    subject.responsibleHumanId.length > 0 &&
    context.trigger?.agentId === subject.principal.id &&
    context.trigger.responsibleHumanId === subject.responsibleHumanId &&
    context.trigger.targets.some((target) => policyDigest(target) === policyDigest(input.resource));
  const preset =
    (context.preset === 'owner-direct' &&
      requested &&
      audience?.kind === 'user' &&
      audience.userId === subject.onBehalfOf) ||
    (context.preset === 'workspace-members' && requested && audience?.kind === 'workspace') ||
    (context.preset === 'agent-initiated' && establishedTrigger);
  const audienceBound =
    knownAudience(audience) &&
    knownAudience(source) &&
    (audience.kind === 'user'
      ? (source.kind === 'user' && source.userId === audience.userId) ||
        (requested && audience.userId === subject.onBehalfOf && source.kind === 'workspace')
      : context.surface === 'app' &&
        context.conversation.owner.kind === 'workspace' &&
        context.conversation.owner.workspaceId === audience.workspaceId &&
        source.kind === 'workspace' &&
        source.workspaceId === audience.workspaceId);
  const facts: readonly (readonly [string, boolean])[] = [
    ['agent', input.agentKernel.effect === 'allow'],
    [
      'preset',
      subject.principal.kind === 'agent' &&
        !!preset &&
        (context.surface === 'app' || context.surface === 'channel-direct'),
    ],
    [
      'envelope',
      policyScopeContains(input.envelope, {
        subjects: [subject.principal],
        actions: [input.operation],
        resources: [input.resource],
      }),
    ],
    ['audience', !!audienceBound],
  ];
  // These are opaque NGAC nodes, not newly invented Protocol principals or grant records.
  const user = 'context-reader';
  const target = 'context-source';
  const state: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: target, kind: 'object' },
      ...facts.flatMap(([name]) => [
        { id: `${name}:reader`, kind: 'userAttribute' as const },
        { id: `${name}:source`, kind: 'objectAttribute' as const },
        { id: `${name}:required`, kind: 'policyClass' as const },
      ]),
    ],
    assignments: facts.flatMap(([name]) => [
      { child: user, parent: `${name}:reader` },
      { child: `${name}:reader`, parent: `${name}:required` },
      { child: target, parent: `${name}:source` },
      { child: `${name}:source`, parent: `${name}:required` },
    ]),
    operations: [{ id: input.operation, accessRights: ['read'] }],
    associations: facts.flatMap(([name, allowed]) =>
      allowed
        ? [
            {
              id: `${name}:current-read`,
              userAttribute: `${name}:reader`,
              targetAttribute: `${name}:source`,
              accessRights: ['read'],
            },
          ]
        : []
    ),
  };
  return evaluateAccess(state, { user, target, operation: input.operation });
}
