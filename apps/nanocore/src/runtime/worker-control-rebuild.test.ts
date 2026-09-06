import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  redactAgentEnvironmentPackageSnapshot,
} from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  bindSchedulerLeaseRouteTokenHashes,
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  deriveWorkerControlCommandId,
  hashWorkerRouteToken,
  WorkerControlGateway,
} from './worker-control-gateway.js';
import { rebuildWorkerControlGatewaySessions } from './worker-control-rebuild.js';

interface RestorableWorkerControlFixture {
  /** Migrated Core database containing the live scheduler lease. */
  readonly coreDb: CoreDb;
  /** Durable package expected to hydrate into the gateway. */
  readonly environmentPackage: AgentEnvironmentPackage;
  /** Non-secret sandbox binding restored independently from route credentials. */
  readonly sandboxBindingRef: string;
  /** Raw worker-control token retained by the restarted client. */
  readonly workerControlToken: string;
  /** Raw worker-inference token retained by the restarted client. */
  readonly workerInferenceToken: string;
  /** Raw worker-capability token retained by the restarted client. */
  readonly workerCapabilityToken: string;
}

/**
 * Creates one durable AEP plus scheduler lease for restart hydration tests.
 *
 * @param options Optional lineage mismatch and snapshot omission controls.
 * @returns Restorable gateway fixture.
 */
function createRestorableWorkerControlFixture(
  options: {
    /** Request id stored on the originating admission. */
    readonly admissionRequestId?: string | null;
    /** Exact trigger actor stored on the originating admission. */
    readonly admissionTriggerActor?: ActorRef;
    /** AgentSession stored on the lease instead of the AEP lineage. */
    readonly leaseAgentSessionId?: string;
    /** Whether to persist the owning AEP snapshot. */
    readonly recordSnapshot?: boolean;
  } = {}
): RestorableWorkerControlFixture {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-rebuild-'));
  const coreDb = openCoreDb(dataRoot);

  applyMigrations(coreDb);
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Restore worker inference identity', {
    kind: 'user',
    id: 'user_local',
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'as_restore_1',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_restore_1',
      triggerActor: { kind: 'user', id: 'user_restore_1' },
      turn,
      workspaceCwd: '/workspace/openkit',
      workspaceRoots: [],
    })
  );
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

  applyScopedMigrations(workspaceDb);
  try {
    if (options.recordSnapshot !== false) {
      recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-13T00:00:01.000Z',
        environmentPackage,
      });
    }
  } finally {
    workspaceDb.sqlite.close();
  }

  createSchedulerAdmissionEntry(coreDb, {
    triggerActor: options.admissionTriggerActor ?? environmentPackage.scope.triggerActor,
    now: () => '2026-07-13T00:00:02.000Z',
    priorityClass: 'interactive',
    profileRef: 'default',
    queueEntryId: 'queue_restore_1',
    requestId:
      options.admissionRequestId === undefined
        ? environmentPackage.scope.requestId
        : options.admissionRequestId,
    requestedAgentId: environmentPackage.agent.agentId,
    requiredPoolConstraints: ['openshell.local'],
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    turnInput: 'Restore worker inference identity',
    workspaceId: environmentPackage.scope.workspaceId,
  });
  createSchedulerPlacementPlan(coreDb, {
    capacitySnapshotRef: 'target_local:1',
    degradedOptionalFeatures: [],
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    failoverTargetId: null,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    now: () => '2026-07-13T00:00:03.000Z',
    planId: 'plan_restore_1',
    plannedLeaseDurationMs: 900_000,
    policyDecisionIds: [],
    queueEntryId: 'queue_restore_1',
    schedulerEpoch: 1,
    selectedPoolId: 'pool_local',
    selectedTargetId: 'target_local',
  });
  const sandboxBindingRef = 'lease-binding:restore_1';
  const workerControlToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const workerInferenceToken = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const workerCapabilityToken = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

  createSchedulerSessionLease(coreDb, {
    agentSessionId: options.leaseAgentSessionId ?? environmentPackage.scope.agentSessionId,
    expiresAt: '2026-07-13T00:15:04.000Z',
    heartbeatDeadline: '2026-07-13T00:00:34.000Z',
    leaseId: 'lease_restore_1',
    now: () => '2026-07-13T00:00:04.000Z',
    packageSnapshotId: environmentPackage.snapshotId,
    planId: 'plan_restore_1',
    sandboxTokenBindingRef: sandboxBindingRef,
    sessionCompatibilityKey: 'sha256:restore-1',
    startupDeadline: '2026-07-13T00:02:04.000Z',
  });
  bindSchedulerLeaseRouteTokenHashes(coreDb, {
    leaseId: 'lease_restore_1',
    now: () => '2026-07-13T00:00:05.000Z',
    sandboxBindingRef,
    workerCapabilityTokenHash: hashWorkerRouteToken(workerCapabilityToken),
    workerControlTokenHash: hashWorkerRouteToken(workerControlToken),
    workerInferenceTokenHash: hashWorkerRouteToken(workerInferenceToken),
  });

  return {
    coreDb,
    environmentPackage,
    sandboxBindingRef,
    workerCapabilityToken,
    workerControlToken,
    workerInferenceToken,
  };
}

describe('worker control gateway restart hydration', () => {
  it('skips restart hydration before the scheduler schema exists', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-control-empty-rebuild-')));
    const gateway = new WorkerControlGateway();

    try {
      expect(() => rebuildWorkerControlGatewaySessions(coreDb, gateway)).not.toThrow();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('restores the owning AEP for token-only package authentication', () => {
    const fixture = createRestorableWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });

    try {
      rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway);

      expect(gateway.authenticatePackageToken(`Bearer ${fixture.workerControlToken}`)).toEqual(
        redactAgentEnvironmentPackageSnapshot(fixture.environmentPackage)
      );
      expect(() =>
        gateway.authenticatePackageToken(`Bearer ${fixture.workerInferenceToken}`)
      ).toThrow();
      expect(() =>
        gateway.authenticatePackageToken(`Bearer ${fixture.sandboxBindingRef}`)
      ).toThrow();
      const source = readFileSync(new URL('./worker-control-rebuild.ts', import.meta.url), 'utf8');
      expect(source).toContain('workerControlTokenHash');
      expect(source).toContain('workerInferenceTokenHash');
      expect(source).not.toContain('token: lease.sandboxBindingRef');
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('restores one active interrupt and rejects a second interrupt for the Turn', () => {
    const fixture = createRestorableWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });
    const lineage = {
      agentSessionId: fixture.environmentPackage.scope.agentSessionId,
      packageSnapshotId: fixture.environmentPackage.snapshotId,
      requestId: fixture.environmentPackage.scope.requestId,
      threadId: fixture.environmentPackage.scope.threadId,
      turnId: fixture.environmentPackage.scope.turnId,
      workspaceId: fixture.environmentPackage.scope.workspaceId,
    };
    const insert = fixture.coreDb.sqlite.prepare(
      `INSERT INTO worker_control_commands (
        workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
        request_id, command_id, command_kind, sequence, payload_json, status,
        queued_at, delivered_at, acknowledged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL)`
    );
    const interrupt = {
      commandId: deriveWorkerControlCommandId(lineage, 1),
      deliveredAt: null,
      kind: 'interrupt',
      queuedAt: '2026-07-13T00:00:05.000Z',
      reason: 'restart test',
      sequence: 1,
    };

    try {
      insert.run(
        lineage.workspaceId,
        lineage.threadId,
        lineage.turnId,
        lineage.agentSessionId,
        lineage.packageSnapshotId,
        lineage.requestId,
        interrupt.commandId,
        interrupt.kind,
        interrupt.sequence,
        JSON.stringify({ reason: interrupt.reason }),
        interrupt.queuedAt
      );
      insert.run(
        lineage.workspaceId,
        lineage.threadId,
        lineage.turnId,
        lineage.agentSessionId,
        lineage.packageSnapshotId,
        lineage.requestId,
        'legacy-terminal-command',
        'terminal-command',
        2,
        '{"argv":["sh","-c","echo legacy"]}',
        '2026-07-13T00:00:06.000Z'
      );
      rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway);

      expect(
        gateway.pollCommands({
          authorization: `Bearer ${fixture.workerControlToken}`,
          lineage,
        }).commands
      ).toEqual([{ ...interrupt, deliveredAt: expect.any(String) }]);
      expect(() => gateway.enqueueInterrupt(lineage.packageSnapshotId, 'after restart')).toThrow(
        'Worker interrupt already admitted for Turn'
      );
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('retains terminal interrupt history across restart', () => {
    for (const status of ['acknowledged', 'undeliverable'] as const) {
      const fixture = createRestorableWorkerControlFixture();
      const gateway = new WorkerControlGateway({
        resolveTokenBinding: () => ({ status: 'accepted' }),
      });
      const lineage = {
        agentSessionId: fixture.environmentPackage.scope.agentSessionId,
        packageSnapshotId: fixture.environmentPackage.snapshotId,
        requestId: fixture.environmentPackage.scope.requestId,
        threadId: fixture.environmentPackage.scope.threadId,
        turnId: fixture.environmentPackage.scope.turnId,
        workspaceId: fixture.environmentPackage.scope.workspaceId,
      };
      const commandId = deriveWorkerControlCommandId(lineage, 4);

      try {
        fixture.coreDb.sqlite
          .prepare(
            `INSERT INTO worker_control_commands (
              workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
              request_id, command_id, command_kind, sequence, payload_json, status,
              queued_at, delivered_at, acknowledged_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'interrupt', 4, ?, ?, ?, ?, ?)`
          )
          .run(
            lineage.workspaceId,
            lineage.threadId,
            lineage.turnId,
            lineage.agentSessionId,
            lineage.packageSnapshotId,
            lineage.requestId,
            commandId,
            '{"reason":"already terminal"}',
            status,
            '2026-07-13T00:00:05.000Z',
            status === 'acknowledged' ? '2026-07-13T00:00:06.000Z' : null,
            status === 'acknowledged' ? '2026-07-13T00:00:07.000Z' : null
          );
        rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway);

        expect(
          gateway.pollCommands({
            authorization: `Bearer ${fixture.workerControlToken}`,
            lineage,
          }).commands
        ).toEqual([]);
        expect(() => gateway.enqueueInterrupt(lineage.packageSnapshotId)).toThrow(
          'Worker interrupt already admitted for Turn'
        );
      } finally {
        fixture.coreDb.sqlite.close();
      }
    }
  });

  it('fails closed on noncanonical durable command rows', () => {
    for (const malformed of [
      {
        commandId: 'worker-command-1',
        commandKind: 'interrupt',
        payloadJson: '{"reason":null}',
        sequence: 1,
      },
      {
        commandId: null,
        commandKind: 'interrupt',
        payloadJson: '{"reason":null}',
        sequence: -1,
      },
      {
        commandId: null,
        commandKind: 'interrupt',
        payloadJson: '{"reason":null,"extra":true}',
        sequence: 1,
      },
    ]) {
      const fixture = createRestorableWorkerControlFixture();
      const gateway = new WorkerControlGateway();
      const lineage = {
        agentSessionId: fixture.environmentPackage.scope.agentSessionId,
        packageSnapshotId: fixture.environmentPackage.snapshotId,
        requestId: fixture.environmentPackage.scope.requestId,
        threadId: fixture.environmentPackage.scope.threadId,
        turnId: fixture.environmentPackage.scope.turnId,
        workspaceId: fixture.environmentPackage.scope.workspaceId,
      };
      const commandId =
        malformed.commandId ?? deriveWorkerControlCommandId(lineage, malformed.sequence);

      try {
        fixture.coreDb.sqlite
          .prepare(
            `INSERT INTO worker_control_commands (
              workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
              request_id, command_id, command_kind, sequence, payload_json, status,
              queued_at, delivered_at, acknowledged_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL)`
          )
          .run(
            lineage.workspaceId,
            lineage.threadId,
            lineage.turnId,
            lineage.agentSessionId,
            lineage.packageSnapshotId,
            lineage.requestId,
            commandId,
            malformed.commandKind,
            malformed.sequence,
            malformed.payloadJson,
            '2026-07-13T00:00:05.000Z'
          );

        expect(() => rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway)).toThrow();
        expect(() =>
          gateway.authenticatePackageToken(`Bearer ${fixture.workerControlToken}`)
        ).toThrow();
      } finally {
        fixture.coreDb.sqlite.close();
      }
    }
  });

  it('fails closed when the durable AEP snapshot is missing or mismatched', () => {
    for (const options of [
      { recordSnapshot: false },
      { leaseAgentSessionId: 'as_wrong_owner' },
      { admissionRequestId: 'req_wrong_owner' },
      {
        admissionTriggerActor: {
          kind: 'automation',
          id: 'automation_wrong_actor',
          responsibleUserId: 'user_restore_1',
        },
      },
    ]) {
      const fixture = createRestorableWorkerControlFixture(options);
      const gateway = new WorkerControlGateway();

      try {
        expect(() => rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway)).toThrow();
        expect(() =>
          gateway.authenticatePackageToken(`Bearer ${fixture.workerControlToken}`)
        ).toThrow();
      } finally {
        fixture.coreDb.sqlite.close();
      }
    }
  });
});
