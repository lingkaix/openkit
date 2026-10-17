import { describe, expect, it } from 'vitest';
import { combineEffectPolicyResults, evaluateEffectPolicy } from './effect-policy.js';

describe('current effect Policy', () => {
  it('binds the exact actor, resource and right and blocks every non-allow mandatory result', () => {
    const input = {
      subjectId: 'current-responsible-user',
      operation: 'runtime.launch' as const,
      resourceId: 'exact-worker-turn',
      authorityAllowed: true,
    };
    const allowed = evaluateEffectPolicy(input);
    expect(allowed.result).toBe('allow');
    expect(allowed.policyDecision.trace).toMatchObject({
      user: input.subjectId,
      requiredAccessRights: ['ar:runtime-launch'],
    });
    expect(allowed.policyDecision.trace.targetClosure).toContain(input.resourceId);
    expect(allowed.policySnapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(
      evaluateEffectPolicy({ ...input, resourceId: 'another-turn' }).policySnapshotId
    ).not.toBe(allowed.policySnapshotId);
    expect(evaluateEffectPolicy({ ...input, authorityAllowed: false }).result).toBe('deny');
    for (const result of [
      'error',
      'deny',
      'require_escalation',
      'require_approval',
      'defer',
    ] as const) {
      expect(evaluateEffectPolicy({ ...input, mandatoryResults: [result] }).result).toBe(result);
    }
    expect(evaluateEffectPolicy({ ...input, mandatoryResults: ['not_applicable'] }).result).toBe(
      'allow'
    );
    expect(evaluateEffectPolicy({ ...input, mandatoryResults: ['deny', 'error'] }).result).toBe(
      'error'
    );
    expect(combineEffectPolicyResults(['not_applicable'])).toBe('not_applicable');
    expect(combineEffectPolicyResults([])).toBe('not_applicable');
  });
});
