import type { OperationTarget } from '@openkit/app-api-schemas';
import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import { PRODUCT_OPERATION_ACCESS_RIGHTS, type ProductOperation } from './workspace-access.js';

/** Current identity facts supplied only after the owning credential and scope eligibility checks. */
interface IdentityAccessInput {
  readonly userId: string;
  readonly operation: string;
}

/** The finite delegated-maintenance right has its own exact assignment and effect owner. */
const ELIGIBILITY_OPERATIONS = (
  Object.keys(PRODUCT_OPERATION_ACCESS_RIGHTS) as ProductOperation[]
).filter((operation) => operation !== 'administration.configuration.apply');

/** Current Server families reuse registered rights; none supplies the separate delegated effect. */
const SERVER_FAMILY_OPERATIONS = {
  administration: ELIGIBILITY_OPERATIONS,
  mcp: ['api.call'],
  knowledge: ['knowledge.read', 'knowledge.write', 'review.apply', 'thread.read', 'turn.run'],
} satisfies Record<
  NonNullable<Extract<OperationTarget, { kind: 'server' }>['family']>,
  readonly ProductOperation[]
>;

/** Projects already-established identity eligibility onto one resource without granting another scope. */
function evaluateIdentityAccess(
  input: IdentityAccessInput,
  scope: 'user' | 'workspace',
  resourceId: string
): PolicyDecision {
  const user = `user:${input.userId}`;
  const target = `object:${JSON.stringify([scope, resourceId])}`;
  const attribute = `ua:${scope}-eligible-actor`;
  const objects = `oa:${scope}-resource`;
  const policyClass = `pc:${scope}`;
  const policy: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: attribute, kind: 'userAttribute' },
      { id: target, kind: 'object' },
      { id: objects, kind: 'objectAttribute' },
      { id: policyClass, kind: 'policyClass' },
    ],
    assignments: [
      { child: user, parent: attribute },
      { child: attribute, parent: policyClass },
      { child: target, parent: objects },
      { child: objects, parent: policyClass },
    ],
    operations: ELIGIBILITY_OPERATIONS.map((operation) => ({
      id: operation,
      accessRights: [PRODUCT_OPERATION_ACCESS_RIGHTS[operation]],
    })),
    associations:
      input.userId && resourceId
        ? [
            {
              id: `assoc:${scope}-eligible-actor`,
              userAttribute: attribute,
              targetAttribute: objects,
              accessRights: ELIGIBILITY_OPERATIONS.map(
                (operation) => PRODUCT_OPERATION_ACCESS_RIGHTS[operation]
              ),
            },
          ]
        : [],
  };
  return evaluateAccess(policy, { user, target, operation: input.operation });
}

/** Evaluates the declared Server family after current administrator eligibility, without storage reads or durable assignments. */
export function evaluateServerAccess(
  input: IdentityAccessInput & { readonly family?: string | undefined }
): PolicyDecision {
  const family = input.family === undefined ? 'administration' : input.family;
  const operations = Object.hasOwn(SERVER_FAMILY_OPERATIONS, family)
    ? SERVER_FAMILY_OPERATIONS[family as keyof typeof SERVER_FAMILY_OPERATIONS]
    : [];
  const user = `user:${input.userId}`;
  const target = `object:server:${family}`;
  const administrator = 'ua:server-administrator';
  const objects = `oa:server-${family}`;
  const policyClass = 'pc:server';
  const policy: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: administrator, kind: 'userAttribute' },
      { id: target, kind: 'object' },
      { id: objects, kind: 'objectAttribute' },
      { id: policyClass, kind: 'policyClass' },
    ],
    assignments: [
      { child: user, parent: administrator },
      { child: administrator, parent: policyClass },
      { child: target, parent: objects },
      { child: objects, parent: policyClass },
    ],
    operations: ELIGIBILITY_OPERATIONS.map((operation) => ({
      id: operation,
      accessRights: [PRODUCT_OPERATION_ACCESS_RIGHTS[operation]],
    })),
    associations:
      input.userId && operations.length
        ? [
            {
              id: `assoc:server-administrator:${family}`,
              userAttribute: administrator,
              targetAttribute: objects,
              accessRights: operations.map(
                (operation) => PRODUCT_OPERATION_ACCESS_RIGHTS[operation]
              ),
            },
          ]
        : [],
  };
  return evaluateAccess(policy, { user, target, operation: input.operation });
}

/** Evaluates primary User admission after current canonical-user eligibility; target-owner checks remain mandatory. */
export function evaluateUserAccess(input: IdentityAccessInput): PolicyDecision {
  return evaluateIdentityAccess(input, 'user', input.userId);
}

/** Evaluates current administrator eligibility on one active Workspace without manufacturing membership. */
export function evaluateAdministratorWorkspaceAccess(
  input: IdentityAccessInput & { readonly workspaceId: string }
): PolicyDecision {
  return evaluateIdentityAccess(input, 'workspace', input.workspaceId);
}
