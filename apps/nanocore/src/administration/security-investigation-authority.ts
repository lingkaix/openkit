import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import type { PolicySubjectV1Schema } from '@openkit/protocol';
import type { z } from 'zod';

type InvestigationSubject = z.infer<typeof PolicySubjectV1Schema>;

/** Source-owned E7 principal; neither report text nor an ordinary delegation supplies its grant. */
export const SECURITY_INVESTIGATION_AGENT_ID = 'security-investigation';

/** The fixed E7 grant changes permission, never the ordinary administration Tool supply. */
const INVESTIGATION_RIGHTS = [
  'administration.configuration.read',
  'administration.schema.read',
  'administration.configuration.propose',
  'worker-environment.list',
  'worker-environment.status',
  'nanohost.runtime-target',
] as const;

/**
 * Evaluates the fixed investigation grant with the existing NGAC Kernel.
 *
 * The trusted entry supplies the execution Subject and the asking human's current
 * Kernel decision. A wider ordinary delegation cannot supply a missing agent right.
 * This adapter creates no Policy assignment, authority cache or retained writer.
 *
 * @param operation Exact operation requested through an unchanged administration Tool.
 * @param subject Server-derived execution principal and responsible-human lineage.
 * @param humanAuthority Current authority of the asking administrator for this operation.
 * @returns The human refusal unchanged, or the bounded agent Kernel decision.
 */
export function evaluateSecurityInvestigationOperation(
  operation: string,
  subject: InvestigationSubject,
  humanAuthority: PolicyDecision
): PolicyDecision {
  if (humanAuthority.effect !== 'allow') return humanAuthority;
  return evaluateSecurityInvestigationGrant(operation, subject);
}

/**
 * Evaluates only the source-owned agent grant after an existing owner has required
 * current human authority. Owners with an imperative authority guard use the same
 * Kernel here; the grant cannot substitute for that separate human check.
 *
 * @param operation Exact administration operation.
 * @param subject Trusted execution principal and original human lineage.
 * @returns The fixed agent grant, with absent privileges reported by the Kernel.
 */
export function evaluateSecurityInvestigationGrant(
  operation: string,
  subject: InvestigationSubject
): PolicyDecision {
  const initiated =
    subject.principal.kind === 'agent' &&
    subject.principal.id === SECURITY_INVESTIGATION_AGENT_ID &&
    subject.onBehalfOf !== null &&
    subject.responsibleHumanId === subject.onBehalfOf &&
    subject.actor.kind === 'agent' &&
    subject.actor.id === SECURITY_INVESTIGATION_AGENT_ID &&
    subject.actor.responsibleUserId === subject.onBehalfOf;
  const policy: PolicyState = {
    elements: [
      { id: 'agent:security-investigation', kind: 'user' },
      { id: 'ua:security-investigation', kind: 'userAttribute' },
      { id: 'object:administration', kind: 'object' },
      { id: 'oa:security-investigation', kind: 'objectAttribute' },
      { id: 'pc:security-investigation', kind: 'policyClass' },
    ],
    assignments: [
      { child: 'agent:security-investigation', parent: 'ua:security-investigation' },
      { child: 'ua:security-investigation', parent: 'pc:security-investigation' },
      { child: 'object:administration', parent: 'oa:security-investigation' },
      { child: 'oa:security-investigation', parent: 'pc:security-investigation' },
    ],
    operations: [{ id: operation, accessRights: [operation] }],
    associations: initiated
      ? [
          {
            id: 'assoc:security-investigation',
            userAttribute: 'ua:security-investigation',
            targetAttribute: 'oa:security-investigation',
            accessRights: INVESTIGATION_RIGHTS,
          },
        ]
      : [],
  };
  return evaluateAccess(policy, {
    user: 'agent:security-investigation',
    operation,
    target: 'object:administration',
  });
}
