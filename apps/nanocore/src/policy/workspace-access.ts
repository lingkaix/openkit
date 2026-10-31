import type { OperationTarget } from '@openkit/app-api-schemas';
import { PRODUCT_OPERATION_ACCESS_RIGHTS, type ProductOperation } from '@openkit/config-schema';
import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';

export { PRODUCT_OPERATION_ACCESS_RIGHTS, type ProductOperation } from '@openkit/config-schema';

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

/** Current facts, not an access result; the authorizer reads them from the existing identity owners. */
export interface ProductAccessFacts {
  readonly userId: string;
  readonly activeUser: boolean;
  readonly administrator: boolean;
  readonly credential: {
    readonly current: boolean;
    readonly workspaceBound: boolean;
    readonly readOnly: boolean;
    readonly kind: 'local' | 'session' | 'token' | 'retained-author';
  };
}

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

/**
 * Projects current identity, credential and target facts into the one primary Kernel request.
 * Member/administrator alternatives are associations in one class; the credential class is mandatory.
 * A missing fact leaves a structurally valid subject without the required association.
 */
export function evaluateProductAccess(input: {
  readonly facts: ProductAccessFacts;
  readonly target: ProductAccessTarget;
  readonly operation: string;
  readonly mutating: boolean;
}): PolicyDecision {
  const { facts, target: scope } = input;
  const family = scope.kind === 'server' ? (scope.family ?? 'administration') : undefined;
  const user = `user:${facts.userId}`;
  const target =
    scope.kind === 'server'
      ? `object:server:${family}`
      : `object:${JSON.stringify([
          scope.kind,
          scope.kind === 'workspace'
            ? scope.workspaceId
            : scope.kind === 'invitation'
              ? scope.invitationId
              : (scope.userId ?? facts.userId),
        ])}`;
  const policyClass = `pc:${scope.kind}`;
  const objects = `oa:${scope.kind}-resource`;
  const member = `ua:${scope.kind}-member`;
  const administrator = `ua:${scope.kind}-administrator`;
  const subject = 'ua:current-subject';
  const credentialClass = 'pc:credential';
  const credentialObjects = 'oa:credential-resource';
  const authenticated = 'ua:credential-current';
  const writable = 'ua:credential-writable';
  const policy: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: target, kind: 'object' },
      ...[subject, member, administrator, authenticated, writable].map((id) => ({
        id,
        kind: 'userAttribute' as const,
      })),
      ...[objects, credentialObjects].map((id) => ({ id, kind: 'objectAttribute' as const })),
      ...[policyClass, credentialClass].map((id) => ({ id, kind: 'policyClass' as const })),
    ],
    assignments: [
      { child: user, parent: subject },
      { child: subject, parent: policyClass },
      { child: subject, parent: credentialClass },
      { child: member, parent: policyClass },
      { child: administrator, parent: policyClass },
      { child: target, parent: objects },
      { child: objects, parent: policyClass },
      { child: target, parent: credentialObjects },
      { child: credentialObjects, parent: credentialClass },
      { child: authenticated, parent: credentialClass },
      { child: writable, parent: credentialClass },
    ],
    associations: [],
    operations: IDENTITY_OPERATIONS.map((id) => ({
      id,
      accessRights: [PRODUCT_OPERATION_ACCESS_RIGHTS[id]],
    })),
  };
  const rights = (operations: readonly ProductOperation[]) =>
    operations.map((operation) => PRODUCT_OPERATION_ACCESS_RIGHTS[operation]);
  const bind = (attribute: string, operations: readonly ProductOperation[], id: string) => {
    policy.assignments = [...policy.assignments, { child: user, parent: attribute }];
    policy.associations = [
      ...policy.associations,
      { id, userAttribute: attribute, targetAttribute: objects, accessRights: rights(operations) },
    ];
  };
  // These branches project named current facts; only the Kernel returns an access result.
  if (facts.activeUser && facts.userId) {
    if (scope.kind === 'workspace') {
      if (scope.deletedRecovery) {
        if (scope.deletedRecovery.ownerActive) {
          if (scope.deletedRecovery.originalOwner)
            bind(member, ['workspace.write'], 'assoc:workspace-recovery-owner');
          if (facts.administrator)
            bind(administrator, ['workspace.write'], 'assoc:workspace-recovery-administrator');
        }
      } else if (scope.active && scope.workspaceId) {
        if (scope.membership)
          bind(member, WORKSPACE_MEMBER_OPERATIONS, 'assoc:workspace-active-member');
        if (facts.administrator)
          bind(administrator, IDENTITY_OPERATIONS, 'assoc:workspace-administrator');
      }
    } else if (scope.kind === 'invitation') {
      if (scope.inviteeUserId !== null) {
        if (
          scope.inviteeUserId === facts.userId &&
          (facts.credential.kind === 'local' || facts.credential.kind === 'session')
        )
          bind(member, ['invitation.respond'], 'assoc:invitation-invitee');
        if (facts.administrator)
          bind(administrator, ['invitation.respond'], 'assoc:invitation-administrator');
      }
    } else if (scope.kind === 'user' && scope.active !== false) {
      if (
        scope.userId === undefined &&
        (facts.credential.kind === 'local' || facts.credential.kind === 'session')
      )
        bind(member, IDENTITY_OPERATIONS, 'assoc:user-authenticated');
      if (facts.administrator) bind(administrator, IDENTITY_OPERATIONS, 'assoc:user-administrator');
    } else if (facts.administrator && family && Object.hasOwn(SERVER_FAMILY_OPERATIONS, family)) {
      bind(
        administrator,
        SERVER_FAMILY_OPERATIONS[family as keyof typeof SERVER_FAMILY_OPERATIONS],
        `assoc:server-administrator:${family}`
      );
    }
  }
  const credentialRights = rights(IDENTITY_OPERATIONS);
  if (
    facts.credential.current &&
    (scope.kind !== 'workspace' || facts.credential.workspaceBound || facts.administrator)
  ) {
    policy.assignments = [...policy.assignments, { child: user, parent: authenticated }];
    if (!facts.credential.readOnly)
      policy.assignments = [...policy.assignments, { child: user, parent: writable }];
  }
  // The requested mutation posture is catalog-owned; a read-only Token has no mutation association.
  policy.associations = [
    ...policy.associations,
    ...(!input.mutating
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
  return evaluateAccess(policy, { user, target, operation: input.operation });
}
