import { readFileSync } from 'node:fs';

import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import type {
  WorkerCanonicalEventRecord,
  WorkerCapabilityCallSummary,
} from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  hashWorkerRouteToken,
  WorkerControlGateway,
  type WorkerControlGatewayError,
  type WorkerControlLineage,
} from './worker-control-gateway.js';

/**
 * Creates an OpenShell-targeted package fixture for worker control tests.
 *
 * @returns Package fixture and lineage expected by the control gateway.
 */
function createWorkerControlFixture(): {
  environmentPackage: AgentEnvironmentPackage;
  lineage: WorkerControlLineage;
} {
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Control worker', {
    kind: 'user',
    id: 'user_local',
  });
  const environmentPackage = resolveAgentEnvironmentPackage({
    agentSetup: createTestAgentSetup(),
    agentSessionId: 'as_control_1',
    triggerActor: { kind: 'user', id: 'user_local' },
    backend: {
      kind: 'openshell',
    },
    createdAt: '2026-06-16T00:00:00.000Z',
    requestId: 'req_control_1',
    turn,
    workspaceCwd: '/workspace/repo',
    workspaceRoots: [],
  });

  return {
    environmentPackage: AgentEnvironmentPackageSchema.parse(environmentPackage),
    lineage: {
      agentSessionId: 'as_control_1',
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: 'req_control_1',
      threadId: 'th_demo',
      turnId: turn.id,
      workspaceId: 'ws_demo',
    },
  };
}

const WORKER_CONTROL_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WORKER_INFERENCE_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const WORKER_CAPABILITY_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

/** Registers one accepted session with a non-secret binding and distinct raw route tokens. */
function registerAcceptedWorkerSession(
  gateway: WorkerControlGateway,
  environmentPackage: AgentEnvironmentPackage,
  sandboxBindingRef: string
) {
  return gateway.registerSession(environmentPackage, {
    sandboxBindingRef,
    workerCapabilityToken: WORKER_CAPABILITY_TOKEN,
    workerControlToken: WORKER_CONTROL_TOKEN,
    workerInferenceToken: WORKER_INFERENCE_TOKEN,
  });
}

/**
 * Creates a canonical worker event record for gateway append tests.
 *
 * @param lineage Worker lineage bound to the active package snapshot.
 * @param sequence Worker event sequence.
 * @param delta Text delta carried by the event.
 * @returns Canonical worker event record.
 */
function createEventRecord(
  lineage: WorkerControlLineage,
  sequence: number,
  delta = 'hello'
): WorkerCanonicalEventRecord {
  return {
    event: {
      data: {
        delta,
        itemId: 'candidate_item_1',
      },
      type: 'item.delta',
    },
    kind: 'event',
    lineage,
    schemaVersion: 1,
    sequence,
  };
}

/**
 * Creates a product-safe capability summary record for gateway tests.
 *
 * @param lineage Worker lineage bound to the active package snapshot.
 * @param sequence Worker sequence.
 * @returns Capability summary record.
 */
function createCapabilitySummary(
  lineage: WorkerControlLineage,
  sequence: number
): WorkerCapabilityCallSummary {
  return {
    capabilityCallId: 'capability_1',
    diagnostics: [],
    family: 'knowledge.search',
    inputSummary: 'Search project knowledge.',
    lineage,
    outputSummary: 'Returned one entry.',
    schemaVersion: 1,
    sequence,
    status: 'succeeded',
  };
}

/** Builds one canonical non-initial heartbeat request for direct gateway tests. */
function heartbeatRequest(
  authorization: string,
  lineage: WorkerControlLineage,
  sequence: number,
  message?: string
) {
  return {
    authorization,
    body: { ...(message ? { message } : {}), status: 'running' as const },
    lineage,
    operation: 'heartbeat' as const,
    schemaVersion: 1 as const,
    sequence,
  };
}

describe('WorkerControlGateway', () => {
  it('authenticates sandbox tokens and records live heartbeat plus artifact notices', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:01.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);

    const heartbeat = gateway.recordHeartbeat(
      heartbeatRequest(`Bearer ${registration.token}`, lineage, 1, 'Codex worker is running.')
    );
    const artifact = gateway.recordArtifactNotice({
      artifact: {
        mediaType: 'text/markdown',
        path: '/openkit/artifacts/report.md',
        title: 'Worker report',
      },
      authorization: `Bearer ${registration.token}`,
      lineage,
      sequence: 2,
    });
    const snapshot = gateway.getSessionSnapshot(environmentPackage.snapshotId);

    expect(heartbeat).toMatchObject({
      lastHeartbeatAt: '2026-06-16T00:00:01.000Z',
      status: 'running',
    });
    expect(artifact).toMatchObject({
      artifactId: expect.stringMatching(/^worker-artifact-/),
      title: 'Worker report',
    });
    expect(snapshot).toMatchObject({
      artifacts: [expect.objectContaining({ title: 'Worker report' })],
      heartbeat: expect.objectContaining({ status: 'running' }),
      packageSnapshotId: environmentPackage.snapshotId,
    });
    expect(gateway.getSessionSnapshotByAgentSessionId(lineage.agentSessionId)).toMatchObject({
      agentSessionId: lineage.agentSessionId,
      heartbeat: expect.objectContaining({ status: 'running' }),
      packageSnapshotId: environmentPackage.snapshotId,
    });
    expect(JSON.stringify(snapshot)).not.toContain('token_control_1');
  });

  it('revokes a registered session and its sandbox token', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_revoke_1',
    });
    const registration = gateway.registerSession(environmentPackage);

    expect(gateway.unregisterSession(environmentPackage.snapshotId)).toBe(true);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)).toBeNull();
    expect(() =>
      gateway.recordHeartbeat(heartbeatRequest(`Bearer ${registration.token}`, lineage, 1))
    ).toThrow('missing a valid sandbox token');
    expect(gateway.unregisterSession(environmentPackage.snapshotId)).toBe(false);
  });

  it('invalidates the prior token when the same package snapshot is registered again', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const tokens = ['token_control_old_1', 'token_control_new_1'];
    const gateway = new WorkerControlGateway({
      createToken: () => tokens.shift() ?? 'unexpected_control_token',
    });
    const firstRegistration = gateway.registerSession(environmentPackage);
    const secondRegistration = gateway.registerSession(environmentPackage);

    expect(() =>
      gateway.recordHeartbeat(heartbeatRequest(`Bearer ${firstRegistration.token}`, lineage, 1))
    ).toThrow('missing a valid sandbox token');
    expect(
      gateway.recordHeartbeat(heartbeatRequest(`Bearer ${secondRegistration.token}`, lineage, 1))
    ).toMatchObject({ sequence: 1, status: 'running' });
  });

  it('delivers interrupt commands to the matching worker session', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:01.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);
    const interruptCommand = gateway.enqueueInterrupt(environmentPackage.snapshotId, 'Stop now');

    const polled = gateway.pollCommands({
      authorization: `Bearer ${registration.token}`,
      lineage,
    });
    gateway.acknowledgeCommand({
      authorization: `Bearer ${registration.token}`,
      commandId: interruptCommand.commandId,
      lineage,
    });

    expect(polled.commands).toEqual([
      expect.objectContaining({
        commandId: interruptCommand.commandId,
        kind: 'interrupt',
        reason: 'Stop now',
      }),
    ]);
    expect(
      gateway.pollCommands({
        authorization: `Bearer ${registration.token}`,
        lineage,
      }).commands
    ).toEqual([]);
  });

  it('does not expose retired approval commands', () => {
    expect(new WorkerControlGateway()).not.toHaveProperty('enqueueApprovalResult');
  });

  it('accepts canonical event append records and exposes them in the session snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:01.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);

    const response = gateway.appendEvent({
      authorization: `Bearer ${registration.token}`,
      lineage,
      record: createEventRecord(lineage, 3),
    });
    const snapshot = gateway.getSessionSnapshot(environmentPackage.snapshotId);

    expect(response).toEqual({
      accepted: true,
      diagnostics: [],
      nextExpectedSequence: 4,
      schemaVersion: 1,
    });
    expect(snapshot?.events).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: 'item.delta' }),
        sequence: 3,
      }),
    ]);
  });

  it('records supply refresh acknowledgements in the session snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:01.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);

    const ack = gateway.recordSupplyRefreshAck({
      authorization: `Bearer ${registration.token}`,
      lineage,
      refreshId: 'refresh_1',
      sequence: 4,
      status: 'applied',
    });

    expect(ack).toMatchObject({
      acknowledgedAt: '2026-06-16T00:00:01.000Z',
      refreshId: 'refresh_1',
      sequence: 4,
      status: 'applied',
    });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.supplyRefreshAcks).toEqual([
      expect.objectContaining({ refreshId: 'refresh_1', status: 'applied' }),
    ]);
  });

  it('records capability summaries in the session snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    const response = gateway.recordCapabilitySummary({
      authorization: `Bearer ${registration.token}`,
      lineage,
      summary: createCapabilitySummary(lineage, 5),
    });

    expect(response).toEqual({
      accepted: true,
      diagnostics: [],
      nextExpectedSequence: 6,
      schemaVersion: 1,
    });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.capabilitySummaries).toEqual([
      expect.objectContaining({ capabilityCallId: 'capability_1', status: 'succeeded' }),
    ]);
  });

  it('does not project knowledge proposal summaries in the session snapshot', () => {
    const { environmentPackage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    gateway.registerSession(environmentPackage);

    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)).not.toHaveProperty(
      'knowledgeProposalSummaries'
    );
  });

  it('deduplicates exact sequenced control operation retries', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    const authorization = `Bearer ${registration.token}`;

    gateway.recordHeartbeat(heartbeatRequest(authorization, lineage, 1));
    gateway.recordHeartbeat(heartbeatRequest(authorization, lineage, 1));
    gateway.recordArtifactNotice({
      artifact: { path: '/openkit/artifacts/report.md', title: 'Worker report' },
      authorization,
      lineage,
      sequence: 2,
    });
    gateway.recordArtifactNotice({
      artifact: { path: '/openkit/artifacts/report.md', title: 'Worker report' },
      authorization,
      lineage,
      sequence: 2,
    });
    gateway.recordSupplyRefreshAck({
      authorization,
      lineage,
      refreshId: 'refresh_1',
      sequence: 3,
      status: 'applied',
    });
    gateway.recordSupplyRefreshAck({
      authorization,
      lineage,
      refreshId: 'refresh_1',
      sequence: 3,
      status: 'applied',
    });
    gateway.recordCapabilitySummary({
      authorization,
      lineage,
      summary: createCapabilitySummary(lineage, 4),
    });
    gateway.recordCapabilitySummary({
      authorization,
      lineage,
      summary: createCapabilitySummary(lineage, 4),
    });
    const snapshot = gateway.getSessionSnapshot(environmentPackage.snapshotId);

    expect(snapshot?.heartbeat).toMatchObject({ sequence: 1, status: 'running' });
    expect(snapshot?.artifacts).toHaveLength(1);
    expect(snapshot?.supplyRefreshAcks).toHaveLength(1);
    expect(snapshot?.capabilitySummaries).toHaveLength(1);
  });

  it('retries heartbeat projection before durably recording or publishing its snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const observations: string[] = [];
    let projectionAttempts = 0;
    let gateway!: WorkerControlGateway;

    gateway = new WorkerControlGateway({
      acceptedRecordRecorder: {
        record: () => {
          observations.push(
            gateway.getSessionSnapshot(environmentPackage.snapshotId)?.heartbeat
              ? 'record:published'
              : 'record:pending'
          );
        },
      },
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:02.000Z',
      onHeartbeatAccepted: () => {
        projectionAttempts += 1;
        observations.push(
          gateway.getSessionSnapshot(environmentPackage.snapshotId)?.heartbeat
            ? 'hook:published'
            : 'hook:pending'
        );

        if (projectionAttempts === 1) {
          throw new Error('heartbeat projection unavailable');
        }
      },
    });
    const registration = registerAcceptedWorkerSession(
      gateway,
      environmentPackage,
      'lease-binding:heartbeat_projection'
    );
    const heartbeat = heartbeatRequest(`Bearer ${registration.token}`, lineage, 1);

    expect(() => gateway.recordHeartbeat(heartbeat)).toThrow('heartbeat projection unavailable');
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.heartbeat).toBeNull();
    expect(gateway.recordHeartbeat(heartbeat)).toMatchObject({ sequence: 1, status: 'running' });
    expect(observations).toEqual(['hook:pending', 'hook:pending', 'record:pending']);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.heartbeat).toMatchObject({
      sequence: 1,
      status: 'running',
    });
  });

  it('rejects stale or conflicting sequenced control operations', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);
    const authorization = `Bearer ${registration.token}`;

    gateway.recordSupplyRefreshAck({
      authorization,
      lineage,
      refreshId: 'refresh_1',
      sequence: 3,
      status: 'applied',
    });

    expect(() =>
      gateway.recordSupplyRefreshAck({
        authorization,
        lineage,
        refreshId: 'refresh_1',
        sequence: 3,
        status: 'rejected',
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_sequence_conflict',
        status: 409,
      }) as WorkerControlGatewayError
    );
    expect(() =>
      gateway.recordSupplyRefreshAck({
        authorization,
        lineage,
        refreshId: 'refresh_older',
        sequence: 2,
        status: 'applied',
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_sequence_stale',
        status: 409,
      }) as WorkerControlGatewayError
    );
  });

  it('deduplicates exact canonical event append retries', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);
    const record = createEventRecord(lineage, 3);

    gateway.appendEvent({
      authorization: `Bearer ${registration.token}`,
      lineage,
      record,
    });
    const retry = gateway.appendEvent({
      authorization: `Bearer ${registration.token}`,
      lineage,
      record,
    });

    expect(retry).toMatchObject({ accepted: true, nextExpectedSequence: 4 });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toHaveLength(1);
  });

  it('retries canonical event persistence before publishing its snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const persistedRecords: unknown[] = [];
    let persistenceAttempts = 0;
    const gateway = new WorkerControlGateway({
      acceptedRecordRecorder: {
        record: (record) => {
          persistenceAttempts += 1;

          if (persistenceAttempts === 1) {
            throw new Error('event persistence unavailable');
          }

          persistedRecords.push(record);
        },
      },
      createToken: () => 'token_control_1',
    });
    const registration = gateway.registerSession(environmentPackage);
    const request = {
      authorization: `Bearer ${registration.token}`,
      lineage,
      record: createEventRecord(lineage, 3),
    };

    expect(() => gateway.appendEvent(request)).toThrow('event persistence unavailable');
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([]);
    expect(gateway.appendEvent(request)).toMatchObject({
      accepted: true,
      nextExpectedSequence: 4,
    });
    expect(persistenceAttempts).toBe(2);
    expect(persistedRecords).toEqual([
      expect.objectContaining({
        operation: 'event_append',
        record: request.record,
        recordKey: '3',
        sequence: 3,
      }),
    ]);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([
      request.record,
    ]);
  });

  it('rejects stale or conflicting canonical event append sequences', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    gateway.appendEvent({
      authorization: `Bearer ${registration.token}`,
      lineage,
      record: createEventRecord(lineage, 3),
    });

    expect(() =>
      gateway.appendEvent({
        authorization: `Bearer ${registration.token}`,
        lineage,
        record: createEventRecord(lineage, 3, 'different'),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_sequence_conflict',
        status: 409,
      }) as WorkerControlGatewayError
    );
    expect(() =>
      gateway.appendEvent({
        authorization: `Bearer ${registration.token}`,
        lineage,
        record: createEventRecord(lineage, 2),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_sequence_stale',
        status: 409,
      }) as WorkerControlGatewayError
    );
  });

  it('rejects canonical event records whose embedded lineage does not match the request', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    expect(() =>
      gateway.appendEvent({
        authorization: `Bearer ${registration.token}`,
        lineage,
        record: createEventRecord({ ...lineage, threadId: 'th_other' }, 3),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_lineage_mismatch',
        status: 403,
      }) as WorkerControlGatewayError
    );
  });

  it('rejects missing tokens and mismatched worker lineage', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    expect(() =>
      gateway.recordHeartbeat(heartbeatRequest('Bearer wrong', lineage, 1))
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_unauthorized',
        status: 401,
      }) as WorkerControlGatewayError
    );
    expect(() =>
      gateway.recordHeartbeat(
        heartbeatRequest(`Bearer ${registration.token}`, { ...lineage, threadId: 'th_other' }, 1)
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_lineage_mismatch',
        status: 403,
      }) as WorkerControlGatewayError
    );
  });

  it('checks registered sandbox tokens against a durable lease binding resolver', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const resolvedBindings: Array<{ sandboxBindingRef: string; lineage: WorkerControlLineage }> =
      [];
    const gateway = new WorkerControlGateway({
      createToken: () => 'lease-binding:control_1',
      resolveTokenBinding: (input) => {
        resolvedBindings.push(input);

        return { status: 'accepted' };
      },
    });
    const registration = registerAcceptedWorkerSession(
      gateway,
      environmentPackage,
      'lease-binding:control_1'
    );

    gateway.recordHeartbeat(heartbeatRequest(`Bearer ${registration.token}`, lineage, 1));

    expect(resolvedBindings).toEqual([
      {
        lineage,
        sandboxBindingRef: 'lease-binding:control_1',
        token: WORKER_CONTROL_TOKEN,
        tokenFamily: 'worker-control',
      },
    ]);
  });

  it('authenticates a package from its bearer token and server-owned lineage only', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const resolvedBindings: Array<{ sandboxBindingRef: string; lineage: WorkerControlLineage }> =
      [];
    const gateway = new WorkerControlGateway({
      createToken: () => 'lease-binding:inference_1',
      resolveTokenBinding: (input) => {
        resolvedBindings.push(input);

        return { status: 'accepted' };
      },
    });
    const registration = registerAcceptedWorkerSession(
      gateway,
      environmentPackage,
      'lease-binding:inference_1'
    );

    expect(gateway.authenticatePackageToken(`Bearer ${registration.token}`)).toEqual(
      environmentPackage
    );
    expect(
      gateway.authenticatePackageToken(`Bearer ${registration.workerCapabilityToken}`, {
        tokenFamily: 'capability',
      })
    ).toEqual(environmentPackage);
    expect(() =>
      gateway.authenticatePackageToken(`Bearer ${registration.workerInferenceToken}`, {
        tokenFamily: 'capability',
      })
    ).toThrowError(expect.objectContaining({ code: 'worker_control_unauthorized' }) as Error);
    expect(resolvedBindings).toEqual([
      {
        lineage,
        sandboxBindingRef: 'lease-binding:inference_1',
        token: WORKER_CONTROL_TOKEN,
        tokenFamily: 'worker-control',
      },
      {
        lineage,
        sandboxBindingRef: 'lease-binding:inference_1',
        token: WORKER_CAPABILITY_TOKEN,
        tokenFamily: 'capability',
      },
    ]);
  });

  it('hydrates token-only package authentication when a durable session is restored', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });

    gateway.restoreSession({
      environmentPackage,
      lineage,
      registeredAt: '2026-06-16T00:00:01.000Z',
      sandboxBindingRef: 'lease-binding:restored_inference_1',
      workerCapabilityTokenHash: hashWorkerRouteToken(WORKER_CAPABILITY_TOKEN),
      workerControlTokenHash: hashWorkerRouteToken(WORKER_CONTROL_TOKEN),
      workerInferenceTokenHash: hashWorkerRouteToken(WORKER_INFERENCE_TOKEN),
    });

    expect(gateway.authenticatePackageToken(`Bearer ${WORKER_CONTROL_TOKEN}`)).toEqual(
      environmentPackage
    );
  });

  it('fails token-only package authentication without a live hydrated package', () => {
    const { lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });

    gateway.restoreSession({
      lineage,
      registeredAt: '2026-06-16T00:00:01.000Z',
      sandboxBindingRef: 'lease-binding:restored_without_package_1',
      workerCapabilityTokenHash: hashWorkerRouteToken(WORKER_CAPABILITY_TOKEN),
      workerControlTokenHash: hashWorkerRouteToken(WORKER_CONTROL_TOKEN),
      workerInferenceTokenHash: hashWorkerRouteToken(WORKER_INFERENCE_TOKEN),
    });

    expect(() => gateway.authenticatePackageToken('Bearer invalid')).toThrowError(
      expect.objectContaining({ code: 'worker_control_unauthorized', status: 401 }) as Error
    );
    expect(() => gateway.authenticatePackageToken(`Bearer ${WORKER_CONTROL_TOKEN}`)).toThrowError(
      expect.objectContaining({
        code: 'worker_control_package_unavailable',
        status: 409,
      }) as Error
    );
  });

  it('requires a durable scheduler lease for token-only package authentication', () => {
    const { environmentPackage } = createWorkerControlFixture();
    const gateways = [
      new WorkerControlGateway({ createToken: () => 'lease-binding:without_resolver' }),
      new WorkerControlGateway({
        createToken: () => 'manual_process_token',
        resolveTokenBinding: () => ({ status: 'accepted' }),
      }),
    ];

    for (const gateway of gateways) {
      const registration = gateway.registerSession(environmentPackage);

      expect(() => gateway.authenticatePackageToken(`Bearer ${registration.token}`)).toThrowError(
        expect.objectContaining({
          code: 'worker_control_lease_binding_required',
          status: 403,
        }) as WorkerControlGatewayError
      );
    }
  });

  it('rejects a restored package whose lineage differs from the token session', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway();

    expect(() =>
      gateway.restoreSession({
        environmentPackage,
        lineage: { ...lineage, requestId: 'req_other' },
        registeredAt: '2026-06-16T00:00:01.000Z',
        sandboxBindingRef: 'lease-binding:restore_mismatch_1',
        workerCapabilityTokenHash: hashWorkerRouteToken(WORKER_CAPABILITY_TOKEN),
        workerControlTokenHash: hashWorkerRouteToken(WORKER_CONTROL_TOKEN),
        workerInferenceTokenHash: hashWorkerRouteToken(WORKER_INFERENCE_TOKEN),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_package_restore_mismatch',
        status: 409,
      }) as WorkerControlGatewayError
    );
  });

  it('binds worker control only to its distinct raw token and durable hash family', () => {
    const source = readFileSync(new URL('./worker-control-gateway.ts', import.meta.url), 'utf8');

    expect(source).toContain('workerControlTokenHash');
    expect(source).toContain('workerInferenceTokenHash');
    expect(source).toContain('timingSafeEqual');
    expect(source).not.toContain('const token = options.sandboxBindingRef');
    expect(source).not.toContain('Sandbox-local bearer token injected through runtime secrets.');
  });

  it('rejects registered sandbox tokens when the durable lease binding is not live', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'lease-binding:control_1',
      resolveTokenBinding: () => ({ status: 'rejected', reason: 'lease-not-live' }),
    });
    const registration = registerAcceptedWorkerSession(
      gateway,
      environmentPackage,
      'lease-binding:control_1'
    );

    expect(() =>
      gateway.recordHeartbeat(heartbeatRequest(`Bearer ${registration.token}`, lineage, 1))
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_lease_not_live',
        status: 403,
      }) as WorkerControlGatewayError
    );
  });

  it('passes owner-independent lineage to final-status lifecycle hooks', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const acceptedInputs: unknown[] = [];
    const committedInputs: unknown[] = [];
    const gateway = new WorkerControlGateway({
      createToken: () => 'lease-binding:final_status_1',
      onFinalStatusAccepted: (input) => acceptedInputs.push(input),
      onFinalStatusCommitted: (input) => committedInputs.push(input),
      resolveFinalStatusTokenBinding: () => ({ replayOnly: false, status: 'accepted' }),
    });
    const registration = registerAcceptedWorkerSession(
      gateway,
      environmentPackage,
      'lease-binding:final_status_1'
    );

    gateway.recordFinalStatus({
      authorization: `Bearer ${registration.token}`,
      lineage,
      sequence: 7,
      status: 'completed',
      stopReason: 'completed',
    });

    const expectedInput = {
      eventType: 'turn.completed',
      lineage,
      sandboxBindingRef: 'lease-binding:final_status_1',
    };
    expect(acceptedInputs).toEqual([expectedInput]);
    expect(committedInputs).toEqual([expectedInput]);
  });
});
