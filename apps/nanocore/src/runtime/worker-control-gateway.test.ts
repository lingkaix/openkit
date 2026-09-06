import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import type {
  WorkerCanonicalEventRecord,
  WorkerCapabilityCallSummary,
} from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import {
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
  markSchedulerSessionLeaseReleasing,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  createWorkerControlCommandDeliveryRecorder,
  recordWorkerControlQueuedCommand,
} from './worker-control-commands.js';
import {
  deriveWorkerControlCommandId,
  hashWorkerRouteToken,
  WorkerControlGateway,
  type WorkerControlGatewayError,
  type WorkerControlLineage,
} from './worker-control-gateway.js';

/**
 * Creates an OpenShell-targeted package fixture for worker control tests.
 *
 * @param suffix Stable suffix used to create a distinct complete lineage.
 * @returns Package fixture and lineage expected by the control gateway.
 */
function createWorkerControlFixture(suffix = '1'): {
  environmentPackage: AgentEnvironmentPackage;
  lineage: WorkerControlLineage;
} {
  const store = createDemoStore();
  const turn = store.createTurn(
    'ws_demo',
    'th_demo',
    'Control worker',
    {
      kind: 'user',
      id: 'user_local',
    },
    null,
    { turnId: `tu_control_${suffix}` }
  );
  const environmentPackage = resolveAgentEnvironmentPackage({
    agentSetup: createTestAgentSetup(),
    agentSessionId: `as_control_${suffix}`,
    triggerActor: { kind: 'user', id: 'user_local' },
    backend: {
      kind: 'openshell',
    },
    createdAt: '2026-06-16T00:00:00.000Z',
    requestId: `req_control_${suffix}`,
    turn,
    workspaceCwd: '/workspace/repo',
    workspaceRoots: [],
  });

  return {
    environmentPackage: AgentEnvironmentPackageSchema.parse(environmentPackage),
    lineage: {
      agentSessionId: `as_control_${suffix}`,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: `req_control_${suffix}`,
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

/** Creates the exact live scheduler lease required by durable command admission. */
function createLiveCommandLease(
  coreDb: CoreDb,
  environmentPackage: AgentEnvironmentPackage,
  suffix: string
): string {
  const scope = environmentPackage.scope;
  createSchedulerAdmissionEntry(coreDb, {
    triggerActor: scope.triggerActor,
    now: () => '2026-06-16T00:00:00.000Z',
    priorityClass: 'interactive',
    queueEntryId: `queue_command_${suffix}`,
    requestId: scope.requestId,
    requestedAgentId: environmentPackage.agent.agentId,
    requiredPoolConstraints: ['openshell.local'],
    threadId: scope.threadId,
    turnId: scope.turnId,
    turnInput: 'Control worker',
    workspaceId: scope.workspaceId,
  });
  createSchedulerPlacementPlan(coreDb, {
    capacitySnapshotRef: null,
    degradedOptionalFeatures: [],
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    failoverTargetId: null,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    now: () => '2026-06-16T00:00:00.000Z',
    planId: `plan_command_${suffix}`,
    plannedLeaseDurationMs: 900_000,
    policyDecisionIds: [],
    queueEntryId: `queue_command_${suffix}`,
    schedulerEpoch: 1,
    selectedPoolId: 'pool_local',
    selectedTargetId: 'target_local',
  });
  createSchedulerSessionLease(coreDb, {
    agentSessionId: scope.agentSessionId,
    expiresAt: '2026-06-16T00:15:00.000Z',
    heartbeatDeadline: '2026-06-16T00:00:30.000Z',
    leaseId: `lease_command_${suffix}`,
    now: () => '2026-06-16T00:00:00.000Z',
    packageSnapshotId: environmentPackage.snapshotId,
    planId: `plan_command_${suffix}`,
    sandboxTokenBindingRef: `lease-binding:command_${suffix}`,
    startupDeadline: '2026-06-16T00:02:00.000Z',
  });
  return `lease_command_${suffix}`;
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
    schemaVersion: 2 as const,
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

  it('rejects a second interrupt for the same Turn without another process-local command', () => {
    const { environmentPackage } = createWorkerControlFixture('second_interrupt');
    const gateway = new WorkerControlGateway();
    gateway.registerSession(environmentPackage);
    const first = gateway.enqueueInterrupt(environmentPackage.snapshotId, 'first');

    expect(() => gateway.enqueueInterrupt(environmentPackage.snapshotId, 'second')).toThrow(
      'Worker interrupt already admitted for Turn'
    );
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.commands).toEqual([first]);
  });

  it('derives globally unique durable command ids from complete lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-command-id-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const first = createWorkerControlFixture('durable_1');
      const second = createWorkerControlFixture('durable_2');
      createLiveCommandLease(coreDb, first.environmentPackage, 'durable_1');
      createLiveCommandLease(coreDb, second.environmentPackage, 'durable_2');
      const gateway = new WorkerControlGateway({
        commandDeliveryRecorder: createWorkerControlCommandDeliveryRecorder(coreDb),
        now: () => '2026-06-16T00:00:01.000Z',
      });
      gateway.registerSession(first.environmentPackage);
      gateway.registerSession(second.environmentPackage);

      const firstCommand = gateway.enqueueInterrupt(first.environmentPackage.snapshotId, null);
      const secondCommand = gateway.enqueueInterrupt(second.environmentPackage.snapshotId, null);
      expect(firstCommand.commandId).toBe(deriveWorkerControlCommandId(first.lineage, 1));
      expect(secondCommand.commandId).toBe(deriveWorkerControlCommandId(second.lineage, 1));
      expect(secondCommand.commandId).not.toBe(firstCommand.commandId);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT command_id AS commandId FROM worker_control_commands ORDER BY command_id'
          )
          .all()
      ).toEqual([{ commandId: firstCommand.commandId }, { commandId: secondCommand.commandId }]);
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('canonicalizes an omitted command request id to explicit null', () => {
    const fixture = createWorkerControlFixture('nullable_request');
    const base = {
      registeredAt: '2026-06-16T00:00:00.000Z',
      sandboxBindingRef: 'binding_nullable_request',
      workerCapabilityTokenHash: 'c'.repeat(64),
      workerControlTokenHash: 'a'.repeat(64),
      workerInferenceTokenHash: 'b'.repeat(64),
    } as const;
    const omittedGateway = new WorkerControlGateway();
    const nullGateway = new WorkerControlGateway();
    const { requestId: _requestId, ...lineageWithoutRequest } = fixture.lineage;
    omittedGateway.restoreSession({ ...base, lineage: lineageWithoutRequest });
    nullGateway.restoreSession({ ...base, lineage: { ...lineageWithoutRequest, requestId: null } });

    expect(omittedGateway.enqueueInterrupt(fixture.environmentPackage.snapshotId).commandId).toBe(
      nullGateway.enqueueInterrupt(fixture.environmentPackage.snapshotId).commandId
    );
  });

  it('replays an exact durable command without replacing timestamps and rejects changed payload', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-command-replay-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const fixture = createWorkerControlFixture('replay');
      createLiveCommandLease(coreDb, fixture.environmentPackage, 'replay');
      const gateway = new WorkerControlGateway({
        commandDeliveryRecorder: createWorkerControlCommandDeliveryRecorder(coreDb),
        now: () => '2026-06-16T00:00:01.000Z',
      });
      gateway.registerSession(fixture.environmentPackage);
      const command = gateway.enqueueInterrupt(fixture.environmentPackage.snapshotId, 'Stop now');

      expect(
        recordWorkerControlQueuedCommand(coreDb, {
          command: { ...command, queuedAt: '2026-06-16T00:00:09.000Z' },
          lineage: fixture.lineage,
        })
      ).toEqual({ command, status: 'queued' });
      expect(() =>
        recordWorkerControlQueuedCommand(coreDb, {
          command: { ...command, reason: 'Changed replay' },
          lineage: fixture.lineage,
        })
      ).toThrow(`Worker command identity conflict: ${command.commandId}`);
      expect(() =>
        recordWorkerControlQueuedCommand(coreDb, {
          command: {
            ...command,
            commandId: deriveWorkerControlCommandId(fixture.lineage, 2),
            reason: 'Second interrupt',
            sequence: 2,
          },
          lineage: fixture.lineage,
        })
      ).toThrow('Worker interrupt already admitted for Turn');
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT payload_json AS payloadJson, queued_at AS queuedAt FROM worker_control_commands'
          )
          .get()
      ).toEqual({
        payloadJson: '{"reason":"Stop now"}',
        queuedAt: '2026-06-16T00:00:01.000Z',
      });
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('rolls back delivery and acknowledgement when a durable command becomes malformed', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-command-malformed-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const fixture = createWorkerControlFixture('malformed');
      createLiveCommandLease(coreDb, fixture.environmentPackage, 'malformed');
      const gateway = new WorkerControlGateway({
        commandDeliveryRecorder: createWorkerControlCommandDeliveryRecorder(coreDb),
      });
      const registration = gateway.registerSession(fixture.environmentPackage);
      const command = gateway.enqueueInterrupt(fixture.environmentPackage.snapshotId, 'Stop');
      const setPayload = coreDb.sqlite.prepare(
        'UPDATE worker_control_commands SET payload_json = ? WHERE command_id = ?'
      );

      setPayload.run('{"reason":"Stop","extra":true}', command.commandId);
      expect(() =>
        gateway.pollCommands({
          authorization: `Bearer ${registration.token}`,
          lineage: fixture.lineage,
        })
      ).toThrow(`Invalid durable worker command payload: ${command.commandId}`);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM worker_control_commands WHERE command_id = ?')
          .get(command.commandId)
      ).toEqual({ status: 'queued' });

      setPayload.run('{"reason":"Stop"}', command.commandId);
      gateway.pollCommands({
        authorization: `Bearer ${registration.token}`,
        lineage: fixture.lineage,
      });
      setPayload.run('{"reason":"Stop","extra":true}', command.commandId);
      expect(() =>
        gateway.acknowledgeCommand({
          authorization: `Bearer ${registration.token}`,
          commandId: command.commandId,
          lineage: fixture.lineage,
        })
      ).toThrow(`Invalid durable worker command payload: ${command.commandId}`);
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM worker_control_commands WHERE command_id = ?')
          .get(command.commandId)
      ).toEqual({ status: 'delivered' });
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('rejects a noncanonical command identity before durable insertion', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-command-invalid-id-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const fixture = createWorkerControlFixture('invalid_id');
      createLiveCommandLease(coreDb, fixture.environmentPackage, 'invalid_id');

      expect(() =>
        recordWorkerControlQueuedCommand(coreDb, {
          command: {
            commandId: 'worker-command-1',
            deliveredAt: null,
            kind: 'interrupt',
            queuedAt: '2026-06-16T00:00:01.000Z',
            reason: null,
            sequence: 1,
          },
          lineage: fixture.lineage,
        })
      ).toThrow('Invalid durable worker command row: worker-command-1');
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_control_commands').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('does not advance command memory or sequence when durable insert fails', () => {
    const fixture = createWorkerControlFixture('insert_failure');
    const attemptedSequences: number[] = [];
    const gateway = new WorkerControlGateway({
      commandDeliveryRecorder: {
        markAcknowledged: () => null,
        markDelivered: () => null,
        recordQueued: ({ command }) => {
          attemptedSequences.push(command.sequence);
          throw new Error('injected durable insert failure');
        },
      },
    });
    gateway.registerSession(fixture.environmentPackage);

    expect(() => gateway.enqueueInterrupt(fixture.environmentPackage.snapshotId)).toThrow(
      'injected durable insert failure'
    );
    expect(() => gateway.enqueueInterrupt(fixture.environmentPackage.snapshotId)).toThrow(
      'injected durable insert failure'
    );
    expect(attemptedSequences).toEqual([1, 1]);
    expect(gateway.getSessionSnapshot(fixture.environmentPackage.snapshotId)?.commands).toEqual([]);
  });

  it('does not expose or acknowledge commands after lease terminalization wins', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-command-terminal-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const fixture = createWorkerControlFixture('terminal');
      const leaseId = createLiveCommandLease(coreDb, fixture.environmentPackage, 'terminal');
      const gateway = new WorkerControlGateway({
        commandDeliveryRecorder: createWorkerControlCommandDeliveryRecorder(coreDb),
        now: () => '2026-06-16T00:00:01.000Z',
      });
      const registration = gateway.registerSession(fixture.environmentPackage);
      const command = gateway.enqueueInterrupt(fixture.environmentPackage.snapshotId);

      markSchedulerSessionLeaseReleasing(coreDb, {
        leaseId,
        now: () => '2026-06-16T00:00:02.000Z',
        releaseReason: 'turn-terminal',
      });

      expect(
        gateway.pollCommands({
          authorization: `Bearer ${registration.token}`,
          lineage: fixture.lineage,
        }).commands
      ).toEqual([]);
      expect(() =>
        gateway.acknowledgeCommand({
          authorization: `Bearer ${registration.token}`,
          commandId: command.commandId,
          lineage: fixture.lineage,
        })
      ).toThrow('Worker command cannot be acknowledged');
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM worker_control_commands WHERE command_id = ?')
          .get(command.commandId)
      ).toEqual({ status: 'undeliverable' });
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('preserves only the durable winner when delivery or acknowledgement precedes terminalization', () => {
    for (const acknowledged of [false, true]) {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-command-race-'));
      const coreDb = openCoreDb(dataRoot);

      try {
        applyMigrations(coreDb);
        const suffix = acknowledged ? 'ack_wins' : 'delivery_wins';
        const fixture = createWorkerControlFixture(suffix);
        const leaseId = createLiveCommandLease(coreDb, fixture.environmentPackage, suffix);
        const gateway = new WorkerControlGateway({
          commandDeliveryRecorder: createWorkerControlCommandDeliveryRecorder(coreDb),
          now: () => '2026-06-16T00:00:01.000Z',
        });
        const registration = gateway.registerSession(fixture.environmentPackage);
        const command = gateway.enqueueInterrupt(fixture.environmentPackage.snapshotId);
        expect(
          gateway.pollCommands({
            authorization: `Bearer ${registration.token}`,
            lineage: fixture.lineage,
          }).commands
        ).toHaveLength(1);
        if (acknowledged) {
          gateway.acknowledgeCommand({
            authorization: `Bearer ${registration.token}`,
            commandId: command.commandId,
            lineage: fixture.lineage,
          });
        }

        markSchedulerSessionLeaseReleasing(coreDb, {
          leaseId,
          now: () => '2026-06-16T00:00:02.000Z',
          releaseReason: 'turn-terminal',
        });

        expect(
          coreDb.sqlite
            .prepare('SELECT status FROM worker_control_commands WHERE command_id = ?')
            .get(command.commandId)
        ).toEqual({ status: acknowledged ? 'acknowledged' : 'undeliverable' });
        if (!acknowledged) {
          expect(() =>
            gateway.acknowledgeCommand({
              authorization: `Bearer ${registration.token}`,
              commandId: command.commandId,
              lineage: fixture.lineage,
            })
          ).toThrow('Worker command cannot be acknowledged');
        }
      } finally {
        coreDb.sqlite.close();
        rmSync(dataRoot, { force: true, recursive: true });
      }
    }
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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
