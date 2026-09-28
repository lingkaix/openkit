import { describe, expect, it } from 'vitest';
import { GitFailureExplanationSchema } from './errors/failure-explanation.js';
import { TurnErrorSchema } from './models/turn.js';

const explanation = {
  code: 'git_fetch_http_refused',
  stage: 'workspace_materialization',
  operation: 'git.fetch',
  dependency: 'git_remote',
  producer: 'worker-shim',
  observedAt: '2026-09-22T00:00:00.000Z',
  basis: 'direct_observation',
  subprocess: 'exit',
  httpStatus: 403,
  enforcement: 'unavailable',
  evidence: { availability: 'partial', outputTruncated: false },
};

describe('durable failure explanation', () => {
  it.each([
    { ...explanation, code: 'sandbox_network_denied' },
    { ...explanation, httpStatus: null },
    { ...explanation, code: 'git_fetch_tls_failed' },
    { ...explanation, subprocess: 'spawn' },
    { ...explanation, subprocess: 'timeout' },
    { ...explanation, operation: 'git.object_check' },
    { ...explanation, evidence: { ...explanation.evidence, stderr: 'secret-canary' } },
    { ...explanation, stderr: 'secret-canary' },
    { ...explanation, enforcement: 'denied' },
    { ...explanation, observedAt: 'secret-canary' },
    { ...explanation, observedAt: `2026-09-22T00:00:00.${'0'.repeat(20000)}Z` },
  ])('rejects unsupported or contradictory evidence case %#', (value) => {
    expect(GitFailureExplanationSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    'exit',
    'signal',
    'spawn',
    'timeout',
  ])('preserves transport outcome %s', (subprocess) => {
    expect(
      GitFailureExplanationSchema.parse({
        ...explanation,
        code: 'git_fetch_transport_failed',
        httpStatus: null,
        subprocess,
      })
    ).toMatchObject({ subprocess });
  });

  it('preserves an unattributed HTTP refusal as structured product data', () => {
    expect(
      TurnErrorSchema.parse({
        code: 'worker_governance_turn_failed',
        message: 'Failed.',
        explanation,
      })
    ).toHaveProperty('explanation', explanation);
  });
});
