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

/** Projects already-established identity eligibility onto one resource without granting another scope. */
function evaluateIdentityAccess(
  input: IdentityAccessInput,
  scope: 'user' | 'server' | 'workspace',
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

/** Evaluates a current administrator's primary Server admission; it supplies no delegated effect authority. */
export function evaluateServerAccess(input: IdentityAccessInput): PolicyDecision {
  return evaluateIdentityAccess(input, 'server', 'server');
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
