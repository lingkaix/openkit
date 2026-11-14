import type { OperationTarget } from '@openkit/app-api-schemas';
import { PRODUCT_OPERATION_ACCESS_RIGHTS, type ProductOperation } from '@openkit/config-schema';
import {
  type AccessRequest,
  evaluateAccess,
  type PolicyDecision,
  type PolicyState,
} from '@openkit/policy-kernel';
import {
  canonicalIdentifierName,
  type PolicyBindingV1,
  type PolicyDocumentV1,
  type PolicyResourceV1Schema,
  type PolicySubjectV1Schema,
} from '@openkit/protocol';
import type { z } from 'zod';

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

/** Evaluates the shared projection once; native callers retain admission and fact ownership. */
export function evaluatePolicyKernel(
  input:
    | Parameters<typeof evaluateProductAccess>[0]
    | {
        readonly subject: Pick<z.infer<typeof PolicySubjectV1Schema>, 'principal' | 'process'>;
        readonly operation: string;
        readonly resource: z.infer<typeof PolicyResourceV1Schema>;
        /** Already current agent declaration; this scope grants no initiating-human authority. */
        readonly domain: { readonly id: string; readonly scope: PolicyBindingV1['scope'] };
        readonly policy?: Omit<
          NonNullable<Parameters<typeof evaluateProductAccess>[0]['policy']>,
          'subject'
        >;
      }
): PolicyDecision {
  const { policy, request } = compilePolicyGraph(input);
  return evaluateAccess(policy, request);
}

/**
 * Pure synchronous projection of current primary/domain facts and admitted prohibitions.
 * All classes constrain the same subject and target. Processes are mappings, never principals.
 */
export function compilePolicyGraph(input: ExposureGraphFacts): { policy: PolicyState };
export function compilePolicyGraph(input: Parameters<typeof evaluatePolicyKernel>[0]): {
  policy: PolicyState;
  request: AccessRequest;
};
export function compilePolicyGraph(
  input: Parameters<typeof evaluatePolicyKernel>[0] | ExposureGraphFacts
): {
  policy: PolicyState;
  request?: AccessRequest;
} {
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
  const policyClass = `pc:${scope?.kind ?? 'agent-grant'}`;
  const objects = `oa:${scope?.kind ?? 'agent-grant'}-resource`;
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
    'resource' in input
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

/** Projects current native human facts through the shared compiler and the mandatory Kernel. */
export function evaluateProductAccess(input: {
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
  /** Already admitted Policy and exact current subject, supplied by the native fact owner. */
  readonly policy?: {
    readonly document: PolicyDocumentV1;
    readonly subject: z.infer<typeof PolicySubjectV1Schema>;
    readonly now: number;
    readonly authorCurrent: (userId: string) => boolean;
    readonly anchorCurrent: (anchor: PolicyBindingV1['lifetime']['anchor']) => boolean;
  };
}): PolicyDecision {
  return evaluatePolicyKernel(input);
}
