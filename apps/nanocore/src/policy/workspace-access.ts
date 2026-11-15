import { OPERATION_DEFINITIONS, type OperationTarget } from '@openkit/app-api-schemas';
import {
  PRODUCT_OPERATION_ACCESS_RIGHTS,
  type ProductOperation,
  parseWorkspacePolicyDocument,
  type WorkspacePolicySubject,
  workspacePolicyRecipient,
} from '@openkit/config-schema';
import {
  type AccessRequest,
  evaluateAccess,
  type PolicyDecision,
  type PolicyState,
} from '@openkit/policy-kernel';
import {
  type ActorRef,
  AgentIdSchema,
  canonicalIdentifierName,
  type PolicyBindingV1,
  type PolicyDocumentV1,
  PolicyDocumentV1Schema,
  PolicyPermissionV1Schema,
  PolicyResourceV1Schema,
  PolicySubjectV1Schema,
  UserIdSchema,
} from '@openkit/protocol';
import { policyDigest } from '@openkit/protocol/digest';
import type { z } from 'zod';
import type { OpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { ThreadPolicyActor } from '../auth/identity.js';
import type { GoalDomainStatement } from './goal-domains.js';
import { policyScopeContains } from './statements.js';

/** Trusted native input after current Goal-domain read and exact scheduler admission readback. */
export interface GoalTaskAccessInput {
  /** Must come from GoalDomainPolicyService.read for this attempt, never cached/model input. */
  readonly domain: GoalDomainStatement | null;
  /** Existing Goal class stays mandatory unless the native Task owner proves no Goal. */
  readonly goalRequired?: boolean;
  /** Current native delegated allows; they can extend only the Task association. */
  readonly permissions?: readonly z.infer<typeof PolicyPermissionV1Schema>[];
  /** Actual agent principal, actor and process restored by the Worker lineage owner. */
  readonly subject: z.infer<typeof PolicySubjectV1Schema>;
  /** Current Goal accountability owner; this can differ from the approving statement author. */
  readonly responsibleHumanId: string;
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
  /** Native refusal destination only; it supplies no authority or permission to dispatch. */
  readonly escalation?: {
    readonly kind: 'coordinator';
    readonly workspaceId: string;
    readonly goalId: string;
    readonly agentId: string;
  };
  /** Scope membership only; this is not permission or evidence that no prohibition exists. */
  readonly inGoalEnvelope: boolean;
  /** Include in existing currentness checks; do not create another retained revision owner. */
  readonly authorizationRevision: string;
  /** The one selected exception, absent when original Task resources suffice. */
  readonly permission?: z.infer<typeof PolicyPermissionV1Schema>;
}

/**
 * Projects native Task selectors and their optional Goal envelope into existing NGAC classes.
 * Linked Tasks require both associations; standalone Tasks retain their Task class and human Kernel.
 * Current domain/credential/lifecycle and Task identity reads stay with their existing owners.
 * Current delegated allows extend only the Task class; the approved Goal and human Kernel stay mandatory.
 */
export function evaluateGoalTaskAccess(input: GoalTaskAccessInput): GoalTaskAccessResult {
  const subject = PolicySubjectV1Schema.parse(input.subject);
  const resource = PolicyResourceV1Schema.parse(input.resource);
  const resources = input.resources.map((value) => PolicyResourceV1Schema.parse(value));
  const domain = input.domain;
  const responsibleHumanId = UserIdSchema.parse(input.responsibleHumanId);
  const resourceDigest = policyDigest(resource);
  const goalRequired = input.goalRequired !== false;
  const inGoalEnvelope = Boolean(
    goalRequired &&
      domain?.state === 'active' &&
      domain.author.kind === 'human' &&
      subject.principal.kind === 'agent' &&
      subject.onBehalfOf === null &&
      subject.actor.kind === 'agent' &&
      subject.actor.id === subject.principal.id &&
      subject.responsibleHumanId === responsibleHumanId &&
      subject.process?.workspaceId === domain.source.workspaceId &&
      domain.scope.subjects.some(
        (value) => value.kind === 'agent' && value.id === subject.principal.id
      ) &&
      domain.scope.actions.includes(input.operation) &&
      domain.scope.resources.some((value) => policyDigest(value) === resourceDigest)
  );
  const standaloneSubject =
    !goalRequired &&
    domain === null &&
    subject.principal.kind === 'agent' &&
    subject.actor.kind === 'agent' &&
    subject.actor.id === subject.principal.id &&
    subject.responsibleHumanId === responsibleHumanId &&
    subject.onBehalfOf === responsibleHumanId &&
    subject.process !== null;
  const selectedByTask =
    (goalRequired || standaloneSubject) &&
    resources.some((value) => policyDigest(value) === resourceDigest);
  const permission =
    selectedByTask || !domain || !goalRequired
      ? undefined
      : input.permissions?.find((value) => {
          const candidate = PolicyPermissionV1Schema.parse(value);
          return (
            candidate.state === 'active' &&
            candidate.effect === 'allow' &&
            candidate.grant.kind === 'ordinary' &&
            candidate.author.kind === 'agent' &&
            candidate.author.id === domain.delegate.id &&
            candidate.authority.kind === 'delegation' &&
            candidate.authority.statement.id === domain.id &&
            candidate.authority.statement.digest === policyDigest(domain) &&
            policyScopeContains(domain.scope, candidate.scope) &&
            candidate.scope.subjects.some(
              (value) => policyDigest(value) === policyDigest(subject.principal)
            ) &&
            candidate.scope.actions.includes(input.operation) &&
            candidate.scope.resources.some((value) => policyDigest(value) === resourceDigest)
          );
        });
  const kernel = evaluatePolicyKernel({
    operation: input.operation,
    goal: {
      user: `${subject.principal.kind}:${subject.principal.id}`,
      ...(subject.process ? { process: subject.process.turnId } : {}),
      inGoalEnvelope,
      goalRequired,
      selectedByTask: selectedByTask || Boolean(permission),
      humanKernel: input.humanKernel,
    },
  });
  return {
    kernel,
    inGoalEnvelope,
    ...(domain &&
    inGoalEnvelope &&
    !selectedByTask &&
    !permission &&
    input.humanKernel.effect === 'allow' &&
    kernel.effect === 'deny' &&
    kernel.reasons.length > 0 &&
    kernel.reasons.every(({ code }) => code === 'missing-privilege')
      ? {
          escalation: {
            kind: 'coordinator' as const,
            workspaceId: domain.source.workspaceId,
            goalId: domain.source.goalId,
            agentId: domain.delegate.id,
          },
        }
      : {}),
    ...(permission ? { permission } : {}),
    authorizationRevision: policyDigest({
      domain: domain ? { id: domain.id, digest: policyDigest(domain) } : null,
      subject,
      responsibleHumanId,
      goalRequired,
      resources,
      permission: permission ? { id: permission.id, digest: policyDigest(permission) } : null,
      operation: input.operation,
      resource,
      humanKernel: input.humanKernel,
    }),
  };
}

/** Ordinary membership never supplies Server, delegated-maintenance or Workspace export authority. */
export const WORKSPACE_MEMBER_OPERATIONS = [
  'approval.respond',
  'artifact.read',
  'artifact.write',
  'audit.read',
  'knowledge.propose',
  'knowledge.read',
  'knowledge.write',
  'llm.gateway.use',
  'membership.manage',
  'network.egress',
  'review.apply',
  'runtime.launch',
  'thread.read',
  'tool.grant',
  'tool.use',
  'turn.run',
  'vault.admin',
  'vault.use',
  'workspace.configure',
  'workspace.leave',
  'workspace.lifecycle',
  'workspace.read',
  'workspace.write',
] satisfies readonly ProductOperation[];

/** Finite delegated maintenance retains its separate assignment and effect owner. */
const IDENTITY_OPERATIONS = (
  Object.keys(PRODUCT_OPERATION_ACCESS_RIGHTS) as ProductOperation[]
).filter((operation) => operation !== 'administration.configuration.apply');
const SERVER_FAMILY_OPERATIONS = {
  administration: IDENTITY_OPERATIONS,
  mcp: ['api.call'],
  knowledge: ['knowledge.read', 'knowledge.write', 'review.apply', 'thread.read', 'turn.run'],
} satisfies Record<
  NonNullable<Extract<OperationTarget, { kind: 'server' }>['family']>,
  readonly ProductOperation[]
>;

/** Exact primary target; an explicit User id selects administrative inspection, while self omits it. */
export type ProductAccessTarget =
  | { readonly kind: 'user'; readonly userId?: string; readonly active?: boolean }
  | {
      readonly kind: 'invitation';
      readonly invitationId: string;
      readonly inviteeUserId: string | null;
    }
  | { readonly kind: 'server'; readonly family?: string | undefined }
  | {
      readonly kind: 'workspace';
      readonly workspaceId: string;
      readonly active: boolean;
      readonly membership: 'owner' | 'member' | null;
      /** Exact current registry/owner facts for original-identity recovery only. */
      readonly deletedRecovery?: { readonly ownerActive: boolean; readonly originalOwner: boolean };
    };

type ExposureGraphFacts = {
  readonly exposure: { readonly group: string; readonly document: PolicyDocumentV1 };
};

/** Immutable current correction facts supplied by the configuration effect owner. */
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

type ThreadGraphFacts = {
  readonly thread: {
    readonly actor: ThreadPolicyActor;
    readonly administrator: boolean;
    readonly visibility: 'workspace' | 'private';
    readonly privateOwnerUserId?: string | undefined;
    readonly personalWorkspaceId?: string | undefined;
    readonly workspaceId: string;
    readonly policy: unknown;
    readonly resource: {
      readonly family: 'thread';
      readonly id: string;
      /** Current native parent chain, nearest first; never supplied by a request payload. */
      readonly ancestors?: readonly string[];
    };
    readonly operation: string;
    /** Current exact human Tool conditions selected by the native MCP owner; restrictions only. */
    readonly toolProhibitions?: readonly string[];
  };
};

function matchesThreadPolicySubject(
  subject: WorkspacePolicySubject,
  actor: ThreadPolicyActor
): boolean {
  return (
    subject.kind === actor.kind &&
    subject.userId === actor.userId &&
    (subject.kind !== 'agent' || (actor.kind === 'agent' && subject.agentId === actor.agentId))
  );
}

/** Evaluates the shared projection once; native callers retain admission and fact ownership. */
export function evaluatePolicyKernel(
  input:
    | ProductPolicyInput
    | ThreadGraphFacts
    | {
        readonly binding: {
          readonly principal: ActorRef & { readonly kind: 'integration' };
          readonly principalOwnerUserId: string;
          readonly token: Readonly<
            Pick<OpenKitAccessTokenRecord, 'tokenId' | 'ownerUserId' | 'scope' | 'workspaceIds'>
          >;
        } | null;
        readonly operation: string;
        /** Verified effect-owner classifications; public discovery keeps its canonical definition. */
        readonly native?: { readonly workspaceScoped: boolean; readonly mutating: boolean };
        readonly target: ProductAccessTarget;
        readonly userKernel: PolicyDecision;
        /** Complete verified credential sequence, immediate issuer through its terminal human. */
        readonly issuerChain:
          | readonly {
              readonly principal: ActorRef;
              readonly active: boolean;
              readonly kernel: PolicyDecision;
            }[]
          | null;
      }
    | {
        readonly operation: string;
        /** Current native scope classifications; neither flag grants an effect. */
        readonly goal:
          | {
              readonly user: string;
              readonly process?: string;
              readonly inGoalEnvelope: boolean;
              /** False only for a canonically classified standalone Task. */
              readonly goalRequired?: boolean;
              readonly selectedByTask: boolean;
              readonly humanKernel: PolicyDecision;
            }
          | {
              /** Current prepared admission has no Worker process or effect credential yet. */
              readonly domain: GoalDomainStatement | null;
              readonly workspaceId: string;
              readonly planVersionId: string;
              readonly agentId: string;
              readonly resources: readonly z.infer<typeof PolicyResourceV1Schema>[];
              readonly humanKernel: PolicyDecision;
            };
      }
    | {
        readonly subject: Pick<z.infer<typeof PolicySubjectV1Schema>, 'principal' | 'process'>;
        readonly operation: string;
        readonly resource: z.infer<typeof PolicyResourceV1Schema>;
        /** Already current agent declaration; this scope grants no initiating-human authority. */
        readonly domain: { readonly id: string; readonly scope: PolicyBindingV1['scope'] } | null;
        readonly policy?: Omit<NonNullable<ProductPolicyInput['policy']>, 'subject'>;
      }
    | {
        readonly subject: Pick<z.infer<typeof PolicySubjectV1Schema>, 'principal' | 'process'>;
        readonly operation: 'administration.configuration.apply';
        readonly maintenance: {
          readonly document: unknown;
          readonly facts: WorkerGitReadMaintenanceFacts;
          readonly authorCurrent: (userId: string) => boolean;
        };
        readonly policy?: Omit<NonNullable<ProductPolicyInput['policy']>, 'subject'>;
      }
): PolicyDecision {
  if ('goal' in input && input.goal.humanKernel.effect === 'deny') return input.goal.humanKernel;
  const { policy, request } = compilePolicyGraph(input);
  return evaluateAccess(policy, request);
}

/** The Kernel's one reading of Thread-container scope: active statements naming each Thread, in order. */
export function selectThreadBoundaries(
  document: PolicyDocumentV1,
  threadIds: readonly string[]
): {
  readonly id: string;
  readonly statements: PolicyDocumentV1['statements'];
  /** Only a managed-boundary statement makes the Thread a managed resource. */
  readonly managed: boolean;
}[] {
  return threadIds.map((id) => {
    const statements = document.statements.filter(
      (statement) =>
        statement.state === 'active' &&
        statement.scope.resources.some(
          (resource) =>
            resource.kind === 'container' &&
            resource.container.kind === 'thread' &&
            resource.container.id === id
        )
    );
    return {
      id,
      statements,
      managed: statements.some((statement) => statement.kind === 'managed-boundary'),
    };
  });
}

/**
 * Pure synchronous projection of current primary, agent-domain and Goal/Task facts.
 * All classes constrain the same subject and target. Processes are mappings, never principals.
 */
export function compilePolicyGraph(input: ExposureGraphFacts): { policy: PolicyState };
export function compilePolicyGraph(input: Parameters<typeof evaluatePolicyKernel>[0]): {
  policy: PolicyState;
  request: AccessRequest;
  /** Current verified credential attribution; never a native grant or lifecycle receipt. */
  principal?: (ActorRef & { readonly kind: 'integration' }) | null;
  onBehalfOfUserId?: string | null;
};
export function compilePolicyGraph(
  input: Parameters<typeof evaluatePolicyKernel>[0] | ExposureGraphFacts
): {
  policy: PolicyState;
  request?: AccessRequest;
  principal?: (ActorRef & { readonly kind: 'integration' }) | null;
  onBehalfOfUserId?: string | null;
} {
  if ('thread' in input) {
    const facts = input.thread;

    // Reparse at the bridge boundary: corrupt or unsupported mandatory facts cannot become unmanaged.
    const document = parseWorkspacePolicyDocument(facts.workspaceId, facts.policy);
    const ancestors = facts.resource.ancestors ?? [];
    const boundaries = selectThreadBoundaries(document, [facts.resource.id, ...ancestors]);
    const user = `user:${facts.actor.userId}`;
    const target = `object:${JSON.stringify(facts.resource)}`;
    const subject = 'ua:thread-subject';
    const baseline = 'ua:thread-shared';
    const privateOwner = 'ua:thread-private-owner';
    const administrator = 'ua:thread-administrator';
    const objects = 'oa:workspace-resource';
    const baselineClass = 'pc:thread-audience';
    const operations = WORKSPACE_MEMBER_OPERATIONS.map(
      (operation) => [operation, PRODUCT_OPERATION_ACCESS_RIGHTS[operation]] as const
    );
    const policy: PolicyState = {
      elements: [
        { id: user, kind: 'user' },
        { id: subject, kind: 'userAttribute' },
        { id: baseline, kind: 'userAttribute' },
        { id: privateOwner, kind: 'userAttribute' },
        { id: administrator, kind: 'userAttribute' },
        { id: target, kind: 'object' },
        { id: objects, kind: 'objectAttribute' },
        { id: baselineClass, kind: 'policyClass' },
      ],
      assignments: [
        { child: user, parent: subject },
        { child: subject, parent: baselineClass },
        ...(facts.visibility === 'workspace' ? [{ child: user, parent: baseline }] : []),
        ...(facts.visibility === 'private' && facts.privateOwnerUserId === facts.actor.userId
          ? [{ child: user, parent: privateOwner }]
          : []),
        ...(facts.administrator ? [{ child: user, parent: administrator }] : []),
        { child: privateOwner, parent: baselineClass },
        { child: administrator, parent: baselineClass },
        { child: baseline, parent: baselineClass },
        { child: target, parent: objects },
        { child: objects, parent: baselineClass },
      ],
      associations: [baseline, privateOwner, administrator].map((attribute) => ({
        id: `assoc:${attribute}`,
        userAttribute: attribute,
        targetAttribute: objects,
        accessRights: operations.map(([, right]) => right),
      })),
      operations: operations.map(([id, right]) => ({ id, accessRights: [right] })),
      ...(facts.actor.kind === 'agent'
        ? { processUsers: [{ process: facts.actor.processId, user }] }
        : {}),
    };
    if (facts.personalWorkspaceId !== undefined) {
      const personalClass = 'pc:personal-workspace-audience';
      const personalObjects = 'oa:personal-workspace';
      const personalOwner = 'ua:personal-workspace-owner';
      const personalAdministrator = 'ua:personal-workspace-administrator';
      policy.elements = [
        ...policy.elements,
        { id: personalClass, kind: 'policyClass' },
        { id: personalObjects, kind: 'objectAttribute' },
        { id: personalOwner, kind: 'userAttribute' },
        { id: personalAdministrator, kind: 'userAttribute' },
      ];
      policy.assignments = [
        ...policy.assignments,
        { child: subject, parent: personalClass },
        { child: target, parent: personalObjects },
        { child: personalObjects, parent: personalClass },
        { child: personalOwner, parent: personalClass },
        { child: personalAdministrator, parent: personalClass },
        ...(facts.workspaceId === facts.personalWorkspaceId
          ? [{ child: user, parent: personalOwner }]
          : []),
        ...(facts.administrator ? [{ child: user, parent: personalAdministrator }] : []),
      ];
      policy.associations = [
        ...policy.associations,
        ...[personalOwner, personalAdministrator].map((attribute) => ({
          id: `assoc:${attribute}`,
          userAttribute: attribute,
          targetAttribute: personalObjects,
          accessRights: operations.map(([, right]) => right),
        })),
      ];
    }
    const ancestorAttribute = (id: string) => `oa:thread:${id}`;
    policy.elements = [
      ...policy.elements,
      ...ancestors.map((id) => ({ id: ancestorAttribute(id), kind: 'objectAttribute' as const })),
    ];
    policy.assignments = [
      ...policy.assignments,
      ...ancestors.map((id, index) => ({
        child: index === 0 ? target : ancestorAttribute(ancestors[index - 1]!),
        parent: ancestorAttribute(id),
      })),
      ...(ancestors.length
        ? [{ child: ancestorAttribute(ancestors.at(-1)!), parent: objects }]
        : []),
    ];
    for (const [boundaryIndex, boundary] of boundaries.entries()) {
      if (!boundary.managed) continue;
      const suffix = boundaryIndex === 0 ? '' : `:${boundary.id}`;
      const managed = {
        grants: boundary.statements.flatMap((statement) =>
          statement.kind === 'permission' && statement.effect === 'allow'
            ? [
                {
                  subject: workspacePolicyRecipient(statement)!,
                  operations: statement.scope.actions,
                },
              ]
            : []
        ),
        prohibitions: boundary.statements.flatMap((statement) =>
          statement.kind === 'permission' && statement.effect === 'prohibit'
            ? [
                {
                  subject: workspacePolicyRecipient(statement)!,
                  operations: statement.scope.actions,
                },
              ]
            : []
        ),
      };
      const resourceClass = `pc:managed-resource${suffix}`;
      const resourceObjects = `oa:managed-resource${suffix}`;
      const elements = [
        ...policy.elements,
        { id: resourceClass, kind: 'policyClass' as const },
        { id: resourceObjects, kind: 'objectAttribute' as const },
      ];
      const assignments = [
        ...policy.assignments,
        {
          child: boundaryIndex === 0 ? target : ancestorAttribute(boundary.id),
          parent: resourceObjects,
        },
        { child: resourceObjects, parent: resourceClass },
      ];
      const associations = [...policy.associations];
      for (const [index, grant] of managed.grants.entries()) {
        const attribute = `ua:resource-allocation${suffix}:${index}`;
        elements.push({ id: attribute, kind: 'userAttribute' });
        assignments.push({ child: attribute, parent: resourceClass });
        if (matchesThreadPolicySubject(grant.subject, facts.actor))
          assignments.push({ child: user, parent: attribute });
        associations.push({
          id: `assoc:resource-allocation${suffix}:${index}`,
          userAttribute: attribute,
          targetAttribute: resourceObjects,
          accessRights: grant.operations.map(
            (operation) =>
              PRODUCT_OPERATION_ACCESS_RIGHTS[
                operation as keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS
              ]
          ),
        });
      }
      policy.elements = elements;
      policy.assignments = assignments;
      policy.associations = associations;
      policy.prohibitions = [
        ...(policy.prohibitions ?? []),
        ...managed.prohibitions.flatMap((prohibition, index) => {
          // A User restriction follows that User's mapped processes; an Agent restriction stays exact.
          const restrictUser =
            prohibition.subject.kind === 'user' &&
            prohibition.subject.userId === facts.actor.userId;
          if (!restrictUser && !matchesThreadPolicySubject(prohibition.subject, facts.actor))
            return [];
          return [
            {
              id: `prohibition:resource${suffix}:${index}`,
              kind: restrictUser ? ('user' as const) : ('process' as const),
              subject: restrictUser
                ? user
                : facts.actor.kind === 'agent'
                  ? facts.actor.processId
                  : user,
              accessRights: prohibition.operations.map(
                (operation) =>
                  PRODUCT_OPERATION_ACCESS_RIGHTS[
                    operation as keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS
                  ]
              ),
              range: { type: 'disjunctive' as const, include: [resourceObjects] },
            },
          ];
        }),
      ];
    }
    policy.prohibitions = [
      ...(policy.prohibitions ?? []),
      ...(facts.toolProhibitions ?? []).map((id) => ({
        id: `prohibition:mcp-tool:${id}`,
        kind: facts.actor.kind === 'agent' ? ('process' as const) : ('user' as const),
        subject: facts.actor.kind === 'agent' ? facts.actor.processId : user,
        accessRights: [PRODUCT_OPERATION_ACCESS_RIGHTS['tool.use']],
        range: { type: 'disjunctive' as const, include: [objects] },
      })),
    ];
    return {
      policy,
      request: {
        user,
        ...(facts.actor.kind === 'agent' ? { process: facts.actor.processId } : {}),
        target,
        operation: facts.operation,
      },
    };
  }
  if ('exposure' in input) {
    const { group, document } = input.exposure;
    if (!group.trim()) throw new Error('Operation exposure group is unavailable.');
    const subject = 'ua:current-subject';
    const target = `object:route-group:${group}`;
    const objects = `oa:route-group:${group}`;
    const policyClass = 'pc:exposure';
    // Resource availability has no requester (for example a signed Discord PING).
    // Its unbound UA is an actual-requester join point, never an implicit wildcard.
    // This parameterized class supplies no Actor, access request or allow association.
    return {
      policy: {
        elements: [
          { id: subject, kind: 'userAttribute' },
          { id: target, kind: 'object' },
          { id: objects, kind: 'objectAttribute' },
          { id: policyClass, kind: 'policyClass' },
        ],
        assignments: [
          { child: subject, parent: policyClass },
          { child: target, parent: objects },
          { child: objects, parent: policyClass },
        ],
        associations: [],
        operations: [],
        prohibitions: document.statements
          .filter(
            (statement) =>
              statement.kind === 'permission' &&
              statement.state === 'active' &&
              statement.effect === 'prohibit' &&
              statement.scope.resources.some(
                (resource) =>
                  resource.kind === 'container' &&
                  resource.container.kind === 'route-group-switch' &&
                  resource.container.id === group
              )
          )
          .map((statement) => ({
            id: statement.id,
            kind: 'userAttribute' as const,
            subject,
            accessRights: Object.values(PRODUCT_OPERATION_ACCESS_RIGHTS),
            range: { type: 'disjunctive' as const, include: [objects] },
          })),
      },
    };
  }
  if ('goal' in input) {
    const native = input.goal;
    const domain = 'domain' in native ? native.domain : null;
    const agentId = 'agentId' in native ? AgentIdSchema.parse(native.agentId) : null;
    const preparedResources =
      'resources' in native
        ? native.resources.map((value) => PolicyResourceV1Schema.parse(value))
        : [];
    const goal =
      'user' in native
        ? native
        : {
            user: `agent:${agentId}`,
            process: undefined,
            goalRequired: true,
            inGoalEnvelope: Boolean(
              domain?.state === 'active' &&
                domain.source.workspaceId === native.workspaceId &&
                domain.source.planVersionId === native.planVersionId &&
                domain.scope.subjects.some(
                  (value) => value.kind === 'agent' && value.id === agentId
                )
            ),
            selectedByTask: Boolean(
              domain &&
                preparedResources.every((resource) =>
                  domain.scope.resources.some(
                    (value) => policyDigest(value) === policyDigest(resource)
                  )
                )
            ),
            humanKernel: native.humanKernel,
          };
    const operation = Object.hasOwn(PRODUCT_OPERATION_ACCESS_RIGHTS, input.operation)
      ? (input.operation as ProductOperation)
      : null;
    const accessRights = operation ? [PRODUCT_OPERATION_ACCESS_RIGHTS[operation]] : [];
    const user = goal.user;
    const classes =
      goal.goalRequired === false
        ? (['goal-task'] as const)
        : (['goal-envelope', 'goal-task'] as const);
    const policy: PolicyState = {
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
        .filter((id) => (id === 'goal-envelope' ? goal.inGoalEnvelope : goal.selectedByTask))
        .map((id) => ({
          id,
          userAttribute: `ua:${id}`,
          targetAttribute: `oa:${id}`,
          accessRights,
        })),
      ...(goal.process ? { processUsers: [{ process: goal.process, user }] } : {}),
    };
    return {
      policy,
      request: {
        operation: input.operation,
        target: 'goal-request',
        user,
        ...(goal.process ? { process: goal.process } : {}),
      },
    };
  }
  if ('issuerChain' in input) {
    const binding = input.binding;
    const matchingOwner =
      !!binding &&
      binding.principal.kind === 'integration' &&
      binding.principal.id.length > 0 &&
      binding.token.tokenId.length > 0 &&
      binding.principalOwnerUserId.length > 0 &&
      binding.principalOwnerUserId === binding.token.ownerUserId;
    const definition = Object.hasOwn(OPERATION_DEFINITIONS, input.operation)
      ? OPERATION_DEFINITIONS[input.operation as keyof typeof OPERATION_DEFINITIONS]
      : null;
    const right = input.native
      ? Object.hasOwn(PRODUCT_OPERATION_ACCESS_RIGHTS, input.operation)
        ? PRODUCT_OPERATION_ACCESS_RIGHTS[input.operation as ProductOperation]
        : null
      : definition
        ? PRODUCT_OPERATION_ACCESS_RIGHTS[definition.policyOperation]
        : null;
    const workspaceScoped =
      input.native?.workspaceScoped ??
      (definition?.scope.kind === 'body-workspace' ||
        definition?.scope.kind === 'opaque-child-workspace' ||
        definition?.scope.kind === 'actor-quick-chat-workspace');
    const chain = input.issuerChain;
    const terminal = chain?.at(-1);
    const facts: readonly (readonly [string, boolean])[] = [
      ['binding', matchingOwner],
      [
        'registered-operation',
        (input.native !== undefined || definition !== null) && right !== null,
      ],
      ['current-user', input.userKernel.effect === 'allow'],
      [
        'scope',
        !!binding &&
          workspaceScoped &&
          input.target.kind === 'workspace' &&
          binding.token.workspaceIds.includes(input.target.workspaceId) &&
          (binding.token.scope === 'workspace' ||
            (binding.token.scope === 'workspace-readonly' &&
              (input.native?.mutating ?? definition?.mutating) === false)),
      ],
      // The credential owner and its terminal issuer are distinct identities; both remain bounded.
      ['complete-issuers', !!chain?.length && terminal?.principal.kind === 'user'],
      ...(chain ?? []).map(
        (issuer, index) =>
          [`issuer:${index}`, issuer.active && issuer.kernel.effect === 'allow'] as const
      ),
    ];
    // NGAC user-kind is the actual Integration, never a substituted human principal.
    const user = `integration:${binding?.principal.id ?? ''}`;
    const target = 'mcp-requested-target';
    const state: PolicyState = {
      elements: [
        ...(matchingOwner ? [{ id: user, kind: 'user' as const }] : []),
        { id: target, kind: 'object' },
        ...facts.flatMap(([name]) => [
          { id: `${name}:subject`, kind: 'userAttribute' as const },
          { id: `${name}:target`, kind: 'objectAttribute' as const },
          { id: `${name}:required`, kind: 'policyClass' as const },
        ]),
      ],
      assignments: facts.flatMap(([name]) => [
        ...(matchingOwner ? [{ child: user, parent: `${name}:subject` }] : []),
        { child: `${name}:subject`, parent: `${name}:required` },
        { child: target, parent: `${name}:target` },
        { child: `${name}:target`, parent: `${name}:required` },
      ]),
      operations: right ? [{ id: input.operation, accessRights: [right] }] : [],
      associations: facts.flatMap(([name, admitted]) =>
        admitted && right
          ? [
              {
                id: `${name}:current`,
                userAttribute: `${name}:subject`,
                targetAttribute: `${name}:target`,
                accessRights: [right],
              },
            ]
          : []
      ),
    };
    return {
      policy: state,
      request: { user, target, operation: input.operation },
      principal: binding?.principal ?? null,
      onBehalfOfUserId: matchingOwner ? binding!.principalOwnerUserId : null,
    };
  }
  const primary = 'facts' in input ? input : null;
  const principal =
    'facts' in input
      ? (input.policy?.subject.principal ?? { kind: 'human', id: input.facts.userId })
      : input.subject.principal;
  const process =
    'facts' in input ? (input.policy?.subject.process ?? null) : input.subject.process;
  const scope = primary?.target;
  const family = scope?.kind === 'server' ? (scope.family ?? 'administration') : undefined;
  const user = `${principal.kind === 'human' ? 'user' : 'agent'}:${principal.id}`;
  const target = primary
    ? scope?.kind === 'server'
      ? `object:server:${family}`
      : `object:${JSON.stringify([
          primary.target.kind,
          primary.target.kind === 'workspace'
            ? primary.target.workspaceId
            : primary.target.kind === 'invitation'
              ? primary.target.invitationId
              : primary.target.kind === 'user'
                ? (primary.target.userId ?? primary.facts.userId)
                : 'server',
        ])}`
    : 'object:target';
  const scopeKind = scope?.kind ?? ('maintenance' in input ? 'server' : 'agent-grant');
  const policyClass = `pc:${scopeKind}`;
  const objects = `oa:${scopeKind}-resource`;
  const subject = 'ua:current-subject';
  const right = (operation: string) =>
    Object.hasOwn(PRODUCT_OPERATION_ACCESS_RIGHTS, operation)
      ? PRODUCT_OPERATION_ACCESS_RIGHTS[operation as ProductOperation]
      : operation;
  const policy: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: target, kind: 'object' },
      { id: subject, kind: 'userAttribute' },
      { id: objects, kind: 'objectAttribute' },
      { id: policyClass, kind: 'policyClass' },
    ],
    assignments: [
      { child: user, parent: subject },
      { child: subject, parent: policyClass },
      { child: target, parent: objects },
      { child: objects, parent: policyClass },
    ],
    associations: [],
    operations: primary
      ? IDENTITY_OPERATIONS.map((id) => ({ id, accessRights: [right(id)] }))
      : [{ id: input.operation, accessRights: [right(input.operation)] }],
  };
  if (primary) {
    const { facts, target: current } = primary;
    const member = `ua:${current.kind}-member`;
    const administrator = `ua:${current.kind}-administrator`;
    const credentialClass = 'pc:credential';
    const credentialObjects = 'oa:credential-resource';
    const authenticated = 'ua:credential-current';
    const writable = 'ua:credential-writable';
    policy.elements = [
      ...policy.elements,
      ...[member, administrator, authenticated, writable].map((id) => ({
        id,
        kind: 'userAttribute' as const,
      })),
      { id: credentialObjects, kind: 'objectAttribute' },
      { id: credentialClass, kind: 'policyClass' },
    ];
    policy.assignments = [
      ...policy.assignments,
      { child: subject, parent: credentialClass },
      { child: member, parent: policyClass },
      { child: administrator, parent: policyClass },
      { child: target, parent: credentialObjects },
      { child: credentialObjects, parent: credentialClass },
      { child: authenticated, parent: credentialClass },
      { child: writable, parent: credentialClass },
    ];
    const bind = (attribute: string, operations: readonly ProductOperation[], id: string) => {
      policy.assignments = [...policy.assignments, { child: user, parent: attribute }];
      policy.associations = [
        ...policy.associations,
        {
          id,
          userAttribute: attribute,
          targetAttribute: objects,
          accessRights: operations.map(right),
        },
      ];
    };
    // Primary human facts cannot silently become an agent grant or another human's authority.
    if (
      principal.kind === 'human' &&
      principal.id === facts.userId &&
      facts.activeUser &&
      facts.userId
    ) {
      if (current.kind === 'workspace') {
        if (current.deletedRecovery) {
          if (current.deletedRecovery.ownerActive) {
            if (current.deletedRecovery.originalOwner)
              bind(member, ['workspace.write'], 'assoc:workspace-recovery-owner');
            if (facts.administrator)
              bind(administrator, ['workspace.write'], 'assoc:workspace-recovery-administrator');
          }
        } else if (current.active && current.workspaceId) {
          if (current.membership)
            bind(member, WORKSPACE_MEMBER_OPERATIONS, 'assoc:workspace-active-member');
          if (facts.administrator)
            bind(administrator, IDENTITY_OPERATIONS, 'assoc:workspace-administrator');
        }
      } else if (current.kind === 'invitation') {
        if (current.inviteeUserId !== null) {
          if (
            current.inviteeUserId === facts.userId &&
            (facts.credential.kind === 'local' || facts.credential.kind === 'session')
          )
            bind(member, ['invitation.respond'], 'assoc:invitation-invitee');
          if (facts.administrator)
            bind(administrator, ['invitation.respond'], 'assoc:invitation-administrator');
        }
      } else if (current.kind === 'user' && current.active !== false) {
        if (
          current.userId === undefined &&
          (facts.credential.kind === 'local' || facts.credential.kind === 'session')
        )
          bind(member, IDENTITY_OPERATIONS, 'assoc:user-authenticated');
        if (facts.administrator)
          bind(administrator, IDENTITY_OPERATIONS, 'assoc:user-administrator');
        const failure = facts.coreConfirmedLoginQuarantine;
        if (
          facts.credential.kind === 'worker-package' &&
          failure?.operation === 'vault.login-quarantine' &&
          failure.failureClass === 'invalid-grant' &&
          current.userId === failure.ownerUserId &&
          failure.referenceId.length > 0 &&
          failure.grantId.length > 0 &&
          Number.isSafeInteger(failure.materialVersion) &&
          failure.materialVersion > 0 &&
          input.operation === 'vault.admin' &&
          primary.mutating
        )
          bind(member, ['vault.admin'], 'assoc:user-core-confirmed-login-quarantine');
      } else if (facts.administrator && family && Object.hasOwn(SERVER_FAMILY_OPERATIONS, family)) {
        bind(
          administrator,
          SERVER_FAMILY_OPERATIONS[family as keyof typeof SERVER_FAMILY_OPERATIONS],
          `assoc:server-administrator:${family}`
        );
      }
    }
    if (
      facts.credential.current &&
      (current.kind !== 'workspace' || facts.credential.workspaceBound || facts.administrator)
    ) {
      policy.assignments = [...policy.assignments, { child: user, parent: authenticated }];
      if (!facts.credential.readOnly)
        policy.assignments = [...policy.assignments, { child: user, parent: writable }];
    }
    const credentialRights = IDENTITY_OPERATIONS.map(right);
    // The catalog's mutation posture remains mandatory, including for administrators.
    policy.associations = [
      ...policy.associations,
      ...(!primary.mutating
        ? [
            {
              id: 'assoc:credential-current',
              userAttribute: authenticated,
              targetAttribute: credentialObjects,
              accessRights: credentialRights,
            },
          ]
        : []),
      {
        id: 'assoc:credential-writable',
        userAttribute: writable,
        targetAttribute: credentialObjects,
        accessRights: credentialRights,
      },
    ];
  }

  if (primary?.context) {
    const context = primary.context;
    const contextClass = 'pc:context';
    const contextObjects = 'oa:context-resource';
    policy.elements = [
      ...policy.elements,
      { id: contextClass, kind: 'policyClass' },
      { id: contextObjects, kind: 'objectAttribute' },
    ];
    policy.assignments = [
      ...policy.assignments,
      { child: subject, parent: contextClass },
      { child: target, parent: contextObjects },
      { child: contextObjects, parent: contextClass },
    ];
    const resolved =
      context.conversationId.length > 0 &&
      primary.target.kind === 'workspace' &&
      ((context.preset === 'owner-direct' && context.privateOwnerUserId === primary.facts.userId) ||
        (context.preset === 'workspace-members' &&
          context.privateOwnerUserId === null &&
          primary.target.membership !== null));
    // Template authorship is not a wildcard requester. The original primary/credential classes
    // still authorize this exact requester. No autonomous association without trusted trigger facts.
    const enabled =
      resolved &&
      context.document.statements.some(
        (statement) =>
          statement.kind === 'permission' &&
          statement.state === 'active' &&
          statement.effect === 'allow' &&
          statement.author.kind === 'human' &&
          context.authorCurrent(statement.author.id) &&
          (statement.lifetime.notAfter === undefined ||
            Date.parse(statement.lifetime.notAfter) > context.now) &&
          statement.scope.resources.some(
            (resource) =>
              resource.kind === 'container' &&
              resource.container.kind === 'context-preset' &&
              resource.container.id === context.preset
          )
      );
    if (enabled)
      policy.associations = [
        ...policy.associations,
        {
          id: `assoc:context:${context.preset}`,
          userAttribute: subject,
          targetAttribute: contextObjects,
          accessRights: [right(input.operation)],
        },
      ];
  }

  // Canonical resource attributes let the Kernel, not string-prefix matching, apply containment.
  const attributes = new Set<string>();
  const resourceAttribute = (resource: z.infer<typeof PolicyResourceV1Schema>): string => {
    const id = `oa:resource:${canonicalIdentifierName(resource)}`;
    if (attributes.has(id)) return id;
    attributes.add(id);
    policy.elements = [...policy.elements, { id, kind: 'objectAttribute' }];
    let parent: z.infer<typeof PolicyResourceV1Schema> | null;
    if (resource.kind === 'mcp-tool') {
      parent = {
        kind: 'container',
        container: {
          owner: { kind: 'workspace', workspaceId: resource.workspaceId },
          kind: 'workspace',
          id: resource.workspaceId,
        },
      };
    } else {
      const { owner, kind, id: containerId } = resource.container;
      parent =
        owner.kind === 'workspace' && (kind !== 'workspace' || containerId !== owner.workspaceId)
          ? { kind: 'container', container: { owner, kind: 'workspace', id: owner.workspaceId } }
          : owner.kind === 'user' && (kind !== 'user' || containerId !== owner.userId)
            ? { kind: 'container', container: { owner, kind: 'user', id: owner.userId } }
            : owner.kind !== 'server' || kind !== 'server' || containerId !== 'server'
              ? {
                  kind: 'container',
                  container: { owner: { kind: 'server' }, kind: 'server', id: 'server' },
                }
              : null;
    }
    const parentId = parent ? resourceAttribute(parent) : policyClass;
    policy.assignments = [...policy.assignments, { child: id, parent: parentId }];
    return id;
  };
  const resource: z.infer<typeof PolicyResourceV1Schema> =
    'maintenance' in input
      ? {
          kind: 'container',
          container: {
            owner: { kind: 'server' },
            kind: 'agent',
            id: input.maintenance.facts.agentId,
          },
        }
      : 'resource' in input
        ? input.resource
        : input.target.kind === 'workspace'
          ? {
              kind: 'container',
              container: {
                owner: { kind: 'workspace', workspaceId: input.target.workspaceId },
                kind: 'workspace',
                id: input.target.workspaceId,
              },
            }
          : input.target.kind === 'user'
            ? {
                kind: 'container',
                container: {
                  owner: { kind: 'user', userId: input.target.userId ?? input.facts.userId },
                  kind: 'user',
                  id: input.target.userId ?? input.facts.userId,
                },
              }
            : {
                kind: 'container',
                container: {
                  owner: { kind: 'server' },
                  kind: input.target.kind,
                  id: input.target.kind === 'invitation' ? input.target.invitationId : 'server',
                },
              };
  const selectedResource = resourceAttribute(resource);
  policy.assignments = [...policy.assignments, { child: target, parent: selectedResource }];
  const processId = process
    ? `process:${JSON.stringify([process.workspaceId, process.threadId, process.turnId])}`
    : undefined;
  if (processId) policy.processUsers = [{ process: processId, user }];
  if ('domain' in input) {
    const { domain } = input;
    if (
      domain &&
      domain.scope.subjects.some(
        (selector) => canonicalIdentifierName(selector) === canonicalIdentifierName(principal)
      )
    )
      policy.associations = domain.scope.resources.map((selected, index) => ({
        id: `${domain.id}:${index}`,
        userAttribute: subject,
        targetAttribute: resourceAttribute(selected),
        accessRights: domain.scope.actions.map(right),
      }));
  }
  if ('maintenance' in input) {
    const { facts, authorCurrent } = input.maintenance;
    const parsed = PolicyDocumentV1Schema.safeParse(input.maintenance.document);
    const candidates = parsed.success
      ? parsed.data.statements.filter((statement) => {
          if (
            statement.kind !== 'permission' ||
            statement.grant.kind !== 'worker-git-read-maintenance'
          )
            return false;
          const recipient = statement.scope.subjects[0];
          const selected = statement.scope.resources[0];
          return (
            statement.scope.subjects.length === 1 &&
            recipient?.kind === 'human' &&
            recipient.id === facts.responsibleUserId &&
            statement.scope.resources.length === 1 &&
            selected?.kind === 'container' &&
            selected.container.owner.kind === 'server' &&
            selected.container.kind === 'agent' &&
            selected.container.id === facts.agentId &&
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
      principal.kind === 'human' &&
      principal.id === facts.responsibleUserId &&
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
    if (allowed)
      policy.associations = [
        {
          id: statement.id,
          userAttribute: subject,
          targetAttribute: objects,
          accessRights: [right(input.operation)],
        },
      ];
  }
  for (const statement of input.policy?.document.statements ?? []) {
    if (
      statement.kind !== 'permission' ||
      statement.state !== 'active' ||
      statement.effect !== 'prohibit'
    )
      continue;
    const lifetime = statement.lifetime;
    if (
      lifetime.anchor.kind !== 'quarantine' &&
      (statement.author.kind !== 'human' ||
        !input.policy!.authorCurrent(statement.author.id) ||
        !input.policy!.anchorCurrent(lifetime.anchor) ||
        (lifetime.notAfter !== undefined && Date.parse(lifetime.notAfter) <= input.policy!.now))
    )
      continue;
    for (const selector of statement.scope.subjects) {
      const selectedProcess =
        selector.kind === 'process' &&
        process !== null &&
        selector.workspaceId === process.workspaceId &&
        selector.threadId === process.threadId &&
        selector.turnId === process.turnId;
      if (
        !selectedProcess &&
        canonicalIdentifierName(selector) !== canonicalIdentifierName(principal)
      )
        continue;
      policy.prohibitions = [
        ...(policy.prohibitions ?? []),
        {
          id: statement.id,
          kind: selectedProcess ? 'process' : 'user',
          subject: selectedProcess ? processId! : user,
          accessRights: statement.scope.actions.map(right),
          range: {
            type: 'disjunctive',
            include: statement.scope.resources.map(resourceAttribute),
          },
        },
      ];
    }
  }
  return {
    policy,
    request: {
      user,
      target,
      operation: input.operation,
      ...(processId ? { process: processId } : {}),
    },
  };
}

/** Current native human facts for the shared compiler and mandatory Kernel. */
export interface ProductPolicyInput {
  readonly facts: {
    readonly userId: string;
    readonly activeUser: boolean;
    readonly administrator: boolean;
    /** Core-only exact failure correlation; authored Policy and operation input cannot supply it. */
    readonly coreConfirmedLoginQuarantine?: {
      readonly operation: 'vault.login-quarantine';
      readonly ownerUserId: string;
      readonly referenceId: string;
      readonly grantId: string;
      readonly materialVersion: number;
      readonly failureClass: 'invalid-grant';
    };
    readonly credential: {
      readonly current: boolean;
      readonly workspaceBound: boolean;
      readonly readOnly: boolean;
      readonly kind: 'local' | 'session' | 'token' | 'retained-author' | 'worker-package';
    };
  };
  readonly target: ProductAccessTarget;
  readonly operation: string;
  readonly mutating: boolean;
  /** Current native conversation and admitted fixed-template activation; never model input. */
  readonly context?: {
    readonly preset: 'owner-direct' | 'workspace-members' | 'agent-initiated';
    readonly conversationId: string;
    readonly privateOwnerUserId: string | null;
    readonly document: PolicyDocumentV1;
    readonly now: number;
    readonly authorCurrent: (userId: string) => boolean;
  };
  /** Already admitted Policy and exact current subject, supplied by the native fact owner. */
  readonly policy?: {
    readonly document: PolicyDocumentV1;
    readonly subject: z.infer<typeof PolicySubjectV1Schema>;
    readonly now: number;
    readonly authorCurrent: (userId: string) => boolean;
    readonly anchorCurrent: (anchor: PolicyBindingV1['lifetime']['anchor']) => boolean;
  };
}
