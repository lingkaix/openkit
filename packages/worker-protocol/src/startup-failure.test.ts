import { describe, expect, it } from 'vitest';
import { WorkerStartupFailureSchema } from './index.js';

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

describe('startup failure observation', () => {
  it('carries the same closed product explanation', () => {
    expect(
      WorkerStartupFailureSchema.parse({
        stage: explanation.stage,
        reason: explanation.code,
        explanation,
      })
    ).toHaveProperty('explanation', explanation);
  });
  it.each([
    { stage: 'runtime_supply', reason: explanation.code, explanation },
    { stage: explanation.stage, reason: 'git_fetch_tls_failed', explanation },
    { stage: explanation.stage, reason: explanation.code },
    { stage: explanation.stage, reason: 'sandbox_network_denied', explanation },
    {
      stage: explanation.stage,
      reason: explanation.code,
      explanation: { ...explanation, stderr: 'canary-secret' },
    },
  ])('rejects inconsistent stage/reason and untrusted claims: %j', (failure) => {
    expect(WorkerStartupFailureSchema.safeParse(failure).success).toBe(false);
  });
});
