import { describe, expect, it } from 'vitest';
import { parseWorkObservationRecord } from './work-observations.js';

const environment = {
  v: 1,
  seq: 1,
  id: 'env-one',
  turnId: 'turn-one',
  ts: '2026-09-29T00:00:00.000Z',
  type: 'env.bound',
  obs: 'core',
  payload: {
    version: '0.0.0',
    workspaceId: 'ws-one',
    systemPromptDigest: `sha256:${'a'.repeat(64)}`,
    tools: [{ name: 'read_status', inputSchemaDigest: 'b'.repeat(64) }],
  },
};

describe('internal environment observation boundary', () => {
  it('preserves Core metadata through the shared portable parser', () => {
    expect(parseWorkObservationRecord(environment)).toEqual(environment);
  });

  it('rejects non-Core claims and omits inline prompt or tool schema content', () => {
    expect(() => parseWorkObservationRecord({ ...environment, obs: 'gateway' })).toThrow();
    expect(
      parseWorkObservationRecord({
        ...environment,
        payload: { ...environment.payload, prompt: 'private prompt body' },
      })
    ).toEqual(environment);
    expect(
      parseWorkObservationRecord({
        ...environment,
        payload: {
          ...environment.payload,
          tools: [{ ...environment.payload.tools[0], inputSchema: { type: 'object' } }],
        },
      })
    ).toEqual(environment);
  });
});

describe('Core recovery observation boundary', () => {
  const reap = {
    ...environment,
    id: 'reap-one',
    type: 'turn.reap',
    payload: {
      reason: 'pre-anchor',
      lastObservedTs: null,
      unresolvedCalls: [
        { corr: 'call-one', type: 'model.observed', name: null, ts: environment.ts },
      ],
      inferredBy: 'scheduler-restart-recovery',
    },
  };

  it('retains the recovery decision without treating unknown last activity as a timestamp', () => {
    expect(parseWorkObservationRecord(reap)).toEqual(reap);
  });

  it('rejects a non-Core decision and omits inline call arguments', () => {
    expect(() => parseWorkObservationRecord({ ...reap, obs: 'sidecar' })).toThrow();
    expect(
      parseWorkObservationRecord({
        ...reap,
        payload: {
          ...reap.payload,
          unresolvedCalls: [{ ...reap.payload.unresolvedCalls[0], arguments: { text: 'private' } }],
        },
      })
    ).toEqual(reap);
  });
});
