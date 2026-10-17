import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import { snapshotDigest } from '../runtime/aep-snapshot-ledger.js';
import type { PermissionDecisionResult } from '../storage/schema/index.js';
import { PRODUCT_OPERATION_ACCESS_RIGHTS, type ProductOperation } from './workspace-access.js';

/** Current owner-validated facts for one concrete governed effect, not caller-supplied authority. */
export interface EffectPolicyInput {
  /** Current responsible user admitted by the effect owner. */
  readonly subjectId: string;
  /** Registered product operation, mapped to its existing access right. */
  readonly operation: ProductOperation;
  /** Concrete target identity from the owning record. */
  readonly resourceId: string;
  /** Current eligibility and effect-specific authority from the existing owner. */
  readonly authorityAllowed: boolean;
  /** Other mandatory Policy domains; an approval never overrides another domain's refusal. */
  readonly mandatoryResults?: readonly PermissionDecisionResult[];
}

/** Exact kernel result and digest projected into the existing product decision owner. */
export interface EffectPolicyEvaluation {
  /** Structural decision from the unchanged NGAC evaluator. */
  readonly policyDecision: PolicyDecision;
  /** Existing digest representation over the exact evaluated graph. */
  readonly policySnapshotId: string;
  /** Combined mandatory product result; only allow permits dispatch. */
  readonly result: PermissionDecisionResult;
}

/** Combines applicable mandatory results under the Permissions owner; no applicable authority blocks. */
export function combineEffectPolicyResults(
  results: readonly PermissionDecisionResult[]
): PermissionDecisionResult {
  const applicable = results.filter((result) => result !== 'not_applicable');
  if (!applicable.length) return 'not_applicable';
  for (const result of [
    'error',
    'deny',
    'require_escalation',
    'require_approval',
    'defer',
  ] as const) {
    if (applicable.includes(result)) return result;
  }
  return 'allow';
}

/** Projects the current finite effect baseline into NGAC, then combines its mandatory domains. */
export function evaluateEffectPolicy(input: EffectPolicyInput): EffectPolicyEvaluation {
  const right = PRODUCT_OPERATION_ACCESS_RIGHTS[input.operation];
  const policy: PolicyState = {
    elements: [
      { id: input.subjectId, kind: 'user' },
      { id: input.resourceId, kind: 'object' },
      { id: 'ua:current-effect-authority', kind: 'userAttribute' },
      { id: 'oa:exact-effect-target', kind: 'objectAttribute' },
      { id: 'pc:effect', kind: 'policyClass' },
    ],
    assignments: [
      { child: input.subjectId, parent: 'ua:current-effect-authority' },
      { child: 'ua:current-effect-authority', parent: 'pc:effect' },
      { child: input.resourceId, parent: 'oa:exact-effect-target' },
      { child: 'oa:exact-effect-target', parent: 'pc:effect' },
    ],
    operations: [{ id: input.operation, accessRights: [right] }],
    associations: input.authorityAllowed
      ? [
          {
            id: 'assoc:current-effect-authority',
            userAttribute: 'ua:current-effect-authority',
            targetAttribute: 'oa:exact-effect-target',
            accessRights: [right],
          },
        ]
      : [],
  };
  const policyDecision = evaluateAccess(policy, {
    user: input.subjectId,
    operation: input.operation,
    target: input.resourceId,
  });
  const invalid = policyDecision.reasons.some(
    (reason) =>
      reason.code === 'invalid-policy' ||
      reason.code === 'invalid-request' ||
      reason.code === 'missing-operation'
  );
  return {
    policyDecision,
    policySnapshotId: snapshotDigest(policy),
    result: combineEffectPolicyResults([
      invalid ? 'error' : policyDecision.effect,
      ...(input.mandatoryResults ?? []),
    ]),
  };
}
