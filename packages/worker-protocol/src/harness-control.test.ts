import { describe, expect, it } from 'vitest';

import {
  HarnessCommandBodySchemas,
  HarnessCommandEnvelopeSchema,
  HarnessOperationSchema,
  HarnessQueuedCommandBodySchemas,
  HarnessResultEnvelopeSchema,
  isHarnessResultBodyValid,
} from './index.js';

const credential = (letter: string) => letter.repeat(43);
const digest = 'a'.repeat(64);

const sessionOpen = {
  adapterId: 'pi',
  agentSessionCompatibilityKey: digest,
  agentSessionId: 'as_1',
  agentSessionRuntimeBindingId: 'asrb_1',
  capabilityLoopbackCredential: credential('c'),
  effectiveSetupGeneration: 1,
  inferenceLoopbackCredential: credential('i'),
  resume: null,
  threadId: 'th_1',
  workspaceId: 'ws_1',
};

const turnStart = {
  aepRef: '/openkit/sessions/as_1/config/package.json',
  agentSessionId: 'as_1',
  agentSessionRuntimeBindingId: 'asrb_1',
  capabilityToken: credential('c'),
  contextPackageId: 'ctxpkg_tu_1',
  contextRef: '/openkit/sessions/as_1/context',
  deadline: '2026-09-30T00:00:00.000Z',
  inferenceToken: credential('i'),
  leaseId: 'lease_1',
  packageSnapshotId: 'aep_1',
  threadId: 'th_1',
  turnId: 'tu_1',
  turnSequence: 0,
  workerControlToken: credential('w'),
  workspaceId: 'ws_1',
};

describe('private Harness command bodies', () => {
  it('has exactly the six fixed operations', () => {
    expect(HarnessOperationSchema.options).toEqual([
      'session.open',
      'session.inspect',
      'turn.start',
      'turn.interrupt',
      'session.close',
      'harness.drain',
    ]);
  });

  it('requires both distinct session loopback credentials on every session.open', () => {
    const schema = HarnessCommandBodySchemas['session.open'];
    expect(schema.safeParse(sessionOpen).success).toBe(true);
    const { capabilityLoopbackCredential: _c, ...withoutCapability } = sessionOpen;
    const { inferenceLoopbackCredential: _i, ...withoutInference } = sessionOpen;
    expect(schema.safeParse(withoutCapability).success).toBe(false);
    expect(schema.safeParse(withoutInference).success).toBe(false);
    expect(
      schema.safeParse({ ...sessionOpen, capabilityLoopbackCredential: credential('i') }).success
    ).toBe(false);
    expect(schema.safeParse({ ...sessionOpen, inferenceLoopbackCredential: 'short' }).success).toBe(
      false
    );
  });

  it('carries resume as null or the exact predecessor locator and digest pair', () => {
    const schema = HarnessCommandBodySchemas['session.open'];
    expect(schema.safeParse({ ...sessionOpen, resume: { digest, locator: 'as_0' } }).success).toBe(
      true
    );
    const { resume: _resume, ...withoutResume } = sessionOpen;
    expect(schema.safeParse(withoutResume).success).toBe(false);
    for (const resume of [
      { locator: 'as_0' },
      { digest, locator: 'as_0', path: '/sandbox' },
      { digest: 'A'.repeat(64), locator: 'as_0' },
      { digest, locator: '' },
    ]) {
      expect(schema.safeParse({ ...sessionOpen, resume }).success).toBe(false);
    }
  });

  it('accepts the session-static runtime environment only on session.open', () => {
    const runtimeEnvironment = { GITHUB_TOKEN: 'value' };
    expect(
      HarnessCommandBodySchemas['session.open'].safeParse({ ...sessionOpen, runtimeEnvironment })
        .success
    ).toBe(true);
    expect(
      HarnessCommandBodySchemas['turn.start'].safeParse({ ...turnStart, runtimeEnvironment })
        .success
    ).toBe(false);
    expect(
      HarnessCommandBodySchemas['session.open'].safeParse({
        ...sessionOpen,
        runtimeEnvironment: { 'BAD-NAME': 'value' },
      }).success
    ).toBe(false);
  });

  it('rejects retired and extra session.open fields', () => {
    for (const extra of [{ storageRef: 'st_1' }, { workSlotRef: 'slot' }, { argv: ['sh'] }]) {
      expect(
        HarnessCommandBodySchemas['session.open'].safeParse({ ...sessionOpen, ...extra }).success
      ).toBe(false);
    }
  });

  it('keeps raw credentials out of the queued bodies', () => {
    const {
      capabilityLoopbackCredential: _c,
      inferenceLoopbackCredential: _i,
      ...queuedOpen
    } = sessionOpen;
    expect(HarnessQueuedCommandBodySchemas['session.open'].safeParse(queuedOpen).success).toBe(
      true
    );
    expect(HarnessQueuedCommandBodySchemas['session.open'].safeParse(sessionOpen).success).toBe(
      false
    );
    const {
      capabilityToken: _ct,
      inferenceToken: _it,
      workerControlToken: _wt,
      ...queuedStart
    } = turnStart;
    expect(HarnessQueuedCommandBodySchemas['turn.start'].safeParse(queuedStart).success).toBe(true);
    expect(HarnessQueuedCommandBodySchemas['turn.start'].safeParse(turnStart).success).toBe(false);
  });

  it('requires three distinct turn.start route tokens', () => {
    const schema = HarnessCommandBodySchemas['turn.start'];
    expect(schema.safeParse(turnStart).success).toBe(true);
    expect(schema.safeParse({ ...turnStart, inferenceToken: credential('w') }).success).toBe(false);
  });

  it('accepts only the interrupt purpose', () => {
    const body = {
      agentSessionId: 'as_1',
      agentSessionRuntimeBindingId: 'asrb_1',
      leaseId: 'lease_1',
      purpose: 'interrupt',
      turnId: 'tu_1',
    };
    const schema = HarnessCommandBodySchemas['turn.interrupt'];
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, purpose: 'human-gate' }).success).toBe(false);
    const { purpose: _purpose, ...withoutPurpose } = body;
    expect(schema.safeParse(withoutPurpose).success).toBe(false);
  });

  it('has a closed command envelope without an adapter selector', () => {
    const command = {
      body: {},
      harnessInstanceId: 'hi_1',
      operation: 'harness.drain',
      operationId: digest,
      schemaVersion: 2,
      sequence: 0,
    };
    expect(HarnessCommandEnvelopeSchema.safeParse(command).success).toBe(true);
    expect(HarnessCommandEnvelopeSchema.safeParse({ ...command, adapterId: 'pi' }).success).toBe(
      false
    );
    expect(
      HarnessCommandEnvelopeSchema.safeParse({ ...command, operation: 'shell.exec' }).success
    ).toBe(false);
  });
});

describe('private Harness results', () => {
  const envelope = {
    body: { reasonCode: 'outcome_unknown' },
    disposition: 'unknown',
    harnessInstanceId: 'hi_1',
    operationId: digest,
    schemaVersion: 2,
    sequence: 3,
  };

  it('has a closed result envelope', () => {
    expect(HarnessResultEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(HarnessResultEnvelopeSchema.safeParse({ ...envelope, extra: true }).success).toBe(false);
  });

  it('validates each success body exactly', () => {
    const valid: Array<[Parameters<typeof isHarnessResultBodyValid>[0], Record<string, unknown>]> =
      [
        [
          'session.open',
          {
            maxActiveTurns: 1,
            nativeHandleDigest: null,
            nativeHandleState: 'pending',
            state: 'open',
          },
        ],
        [
          'turn.start',
          { nativeHandleDigest: digest, nativeHandleState: 'ready', state: 'started' },
        ],
        ['turn.interrupt', { state: 'interrupted' }],
        ['turn.interrupt', { childState: 'running', state: 'interrupted' }],
        ['session.close', { privateState: 'absent', state: 'closed' }],
        [
          'session.inspect',
          {
            childState: 'running',
            cleanupState: 'clean',
            nativeHandleDigest: digest,
            nativeHandleState: 'ready',
            state: 'open',
          },
        ],
        ['harness.drain', { activeTurns: 0, openSessions: 2, state: 'draining' }],
      ];
    for (const [operation, body] of valid) {
      expect(isHarnessResultBodyValid(operation, { body, disposition: 'succeeded' })).toBe(true);
    }
    const invalid: Array<
      [Parameters<typeof isHarnessResultBodyValid>[0], Record<string, unknown>]
    > = [
      [
        'session.open',
        {
          maxActiveTurns: 1,
          nativeHandleDigest: digest,
          nativeHandleState: 'pending',
          state: 'open',
        },
      ],
      ['turn.start', { nativeHandleDigest: null, nativeHandleState: 'ready', state: 'started' }],
      ['turn.interrupt', { state: 'interrupted', status: 'blocked' }],
      ['session.close', { state: 'closed' }],
    ];
    for (const [operation, body] of invalid) {
      expect(isHarnessResultBodyValid(operation, { body, disposition: 'succeeded' })).toBe(false);
    }
  });

  it('accepts startup failure only on a dependency-failed turn.start refusal', () => {
    const startupFailure = { reason: 'failed', stage: 'package_validation' };
    expect(
      isHarnessResultBodyValid('turn.start', {
        body: { reasonCode: 'dependency_failed', startupFailure },
        disposition: 'refused',
      })
    ).toBe(true);
    expect(
      isHarnessResultBodyValid('session.open', {
        body: { reasonCode: 'dependency_failed', startupFailure },
        disposition: 'refused',
      })
    ).toBe(false);
    expect(
      isHarnessResultBodyValid('turn.start', {
        body: { reasonCode: 'ask_user' },
        disposition: 'refused',
      })
    ).toBe(false);
    expect(
      isHarnessResultBodyValid('turn.start', {
        body: { reasonCode: 'outcome_unknown' },
        disposition: 'unknown',
      })
    ).toBe(true);
  });
});
