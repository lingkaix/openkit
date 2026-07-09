import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import type {
  WorkerCanonicalEventRecord,
  WorkerCapabilityCallSummary,
} from '@openkit/worker-protocol';
import { describe, expect, it } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
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
  const turn = store.createTurn('ws_demo', 'th_demo', 'Control worker');
  const agent = store.getAgent('ws_demo', 'agent_codex_host');
  const environmentPackage = resolveAgentEnvironmentPackage({
    agent,
    agentSessionId: 'as_control_1',
    backend: {
      controlRelayUpstream: 'https://nanocore.local/api/worker-control',
      kind: 'openshell',
      sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
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

describe('WorkerControlGateway', () => {
  it('authenticates sandbox tokens and records live heartbeat plus artifact notices', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:01.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);

    const heartbeat = gateway.recordHeartbeat({
      authorization: `Bearer ${registration.token}`,
      lineage,
      message: 'Codex worker is running.',
      sequence: 1,
      status: 'running',
    });
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

  it('delivers approval and terminal commands to the matching worker session', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:01.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);
    const approvalCommand = gateway.enqueueApprovalResult(environmentPackage.snapshotId, {
      approvalRequestId: 'approval_1',
      decision: 'granted',
    });
    const terminalCommand = gateway.enqueueTerminalCommand(environmentPackage.snapshotId, {
      argv: ['pwd'],
      commandId: 'term_1',
      cwd: '/workspace/repo',
    });

    const polled = gateway.pollCommands({
      authorization: `Bearer ${registration.token}`,
      lineage,
    });
    const terminalResult = gateway.recordTerminalResult({
      authorization: `Bearer ${registration.token}`,
      durationMs: 42,
      exitCode: 0,
      lineage,
      stderr: '',
      stdout: '/workspace/repo\n',
      terminalCommandId: terminalCommand.commandId,
    });

    expect(polled.commands).toEqual([
      expect.objectContaining({
        approvalRequestId: 'approval_1',
        commandId: approvalCommand.commandId,
        decision: 'granted',
        kind: 'approval-result',
      }),
      expect.objectContaining({
        argv: ['pwd'],
        commandId: 'term_1',
        kind: 'terminal-command',
      }),
    ]);
    expect(terminalResult).toMatchObject({
      commandId: 'term_1',
      exitCode: 0,
      stdout: '/workspace/repo\n',
    });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.terminalResults).toEqual([
      expect.objectContaining({ commandId: 'term_1', exitCode: 0 }),
    ]);
  });

  it('acknowledges delivered approval and interrupt commands', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:01.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);
    const approvalCommand = gateway.enqueueApprovalResult(environmentPackage.snapshotId, {
      approvalRequestId: 'approval_1',
      decision: 'granted',
    });
    const interruptCommand = gateway.enqueueInterrupt(environmentPackage.snapshotId, 'Stop now');

    gateway.pollCommands({
      authorization: `Bearer ${registration.token}`,
      lineage,
    });

    expect(
      gateway.acknowledgeCommand({
        authorization: `Bearer ${registration.token}`,
        commandId: approvalCommand.commandId,
        lineage,
      })
    ).toMatchObject({
      commandId: approvalCommand.commandId,
      kind: 'approval-result',
    });
    expect(
      gateway.acknowledgeCommand({
        authorization: `Bearer ${registration.token}`,
        commandId: interruptCommand.commandId,
        lineage,
      })
    ).toMatchObject({
      commandId: interruptCommand.commandId,
      kind: 'interrupt',
    });
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

  it('records knowledge proposal summaries in the session snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    const summary = gateway.recordKnowledgeProposalSummary({
      authorization: `Bearer ${registration.token}`,
      lineage,
      proposalId: 'knowledge_proposal_1',
      sequence: 6,
      summary: 'Persist the worker-discovered project decision.',
      title: 'Remember project decision',
    });

    expect(summary).toMatchObject({
      proposalId: 'knowledge_proposal_1',
      sequence: 6,
      summary: 'Persist the worker-discovered project decision.',
      title: 'Remember project decision',
    });
    expect(
      gateway.getSessionSnapshot(environmentPackage.snapshotId)?.knowledgeProposalSummaries
    ).toEqual([expect.objectContaining({ proposalId: 'knowledge_proposal_1' })]);
  });

  it('deduplicates exact sequenced control operation retries', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    const authorization = `Bearer ${registration.token}`;

    gateway.recordHeartbeat({
      authorization,
      lineage,
      sequence: 1,
      status: 'running',
    });
    gateway.recordHeartbeat({
      authorization,
      lineage,
      sequence: 1,
      status: 'running',
    });
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
    gateway.recordKnowledgeProposalSummary({
      authorization,
      lineage,
      proposalId: 'knowledge_proposal_1',
      sequence: 5,
      summary: 'Persist the worker-discovered project decision.',
      title: 'Remember project decision',
    });
    gateway.recordKnowledgeProposalSummary({
      authorization,
      lineage,
      proposalId: 'knowledge_proposal_1',
      sequence: 5,
      summary: 'Persist the worker-discovered project decision.',
      title: 'Remember project decision',
    });

    const snapshot = gateway.getSessionSnapshot(environmentPackage.snapshotId);

    expect(snapshot?.heartbeat).toMatchObject({ sequence: 1, status: 'running' });
    expect(snapshot?.artifacts).toHaveLength(1);
    expect(snapshot?.supplyRefreshAcks).toHaveLength(1);
    expect(snapshot?.capabilitySummaries).toHaveLength(1);
    expect(snapshot?.knowledgeProposalSummaries).toHaveLength(1);
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
      gateway.recordHeartbeat({
        authorization: 'Bearer wrong',
        lineage,
        sequence: 1,
        status: 'running',
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_unauthorized',
        status: 401,
      }) as WorkerControlGatewayError
    );
    expect(() =>
      gateway.recordHeartbeat({
        authorization: `Bearer ${registration.token}`,
        lineage: { ...lineage, threadId: 'th_other' },
        sequence: 1,
        status: 'running',
      })
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
    const registration = gateway.registerSession(environmentPackage);

    gateway.recordHeartbeat({
      authorization: `Bearer ${registration.token}`,
      lineage,
      sequence: 1,
      status: 'running',
    });

    expect(resolvedBindings).toEqual([
      {
        lineage,
        sandboxBindingRef: 'lease-binding:control_1',
      },
    ]);
  });

  it('uses a scheduler-owned sandbox binding ref as the registered control token', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => {
        throw new Error('random token generator should not run');
      },
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });
    const registration = gateway.registerSession(environmentPackage, {
      sandboxBindingRef: 'lease-binding:control_1',
    });

    gateway.recordHeartbeat({
      authorization: `Bearer ${registration.token}`,
      lineage,
      sequence: 1,
      status: 'running',
    });

    expect(registration.token).toBe('lease-binding:control_1');
  });

  it('rejects registered sandbox tokens when the durable lease binding is not live', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'lease-binding:control_1',
      resolveTokenBinding: () => ({ status: 'rejected', reason: 'lease-not-live' }),
    });
    const registration = gateway.registerSession(environmentPackage);

    expect(() =>
      gateway.recordHeartbeat({
        authorization: `Bearer ${registration.token}`,
        lineage,
        sequence: 1,
        status: 'running',
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_lease_not_live',
        status: 403,
      }) as WorkerControlGatewayError
    );
  });
});
