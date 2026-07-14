import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  redactAgentEnvironmentPackageSnapshot,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import {
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { rebuildWorkerControlGatewaySessions } from './worker-control-rebuild.js';

interface RestorableWorkerControlFixture {
  /** Migrated Core database containing the live scheduler lease. */
  readonly coreDb: CoreDb;
  /** Durable package expected to hydrate into the gateway. */
  readonly environmentPackage: AgentEnvironmentPackage;
  /** Sandbox binding used as the restored bearer token. */
  readonly token: string;
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
    /** User id stored on the originating admission. */
    readonly admissionUserId?: string;
    /** Agent session stored on the lease instead of the AEP owner. */
    readonly leaseAgentSessionId?: string;
    /** Whether to persist the owning AEP snapshot. */
    readonly recordSnapshot?: boolean;
  } = {}
): RestorableWorkerControlFixture {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-rebuild-'));
  const coreDb = openCoreDb(dataRoot);

  applyMigrations(coreDb);
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Restore worker inference identity');
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agent: store.getAgent('ws_demo', 'agent_codex_host'),
      agentSessionId: 'as_restore_1',
      backend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_restore_1',
      turn,
      userId: 'user_restore_1',
      workspaceCwd: '/workspace/openkit',
      workspaceRoots: [],
    })
  );
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_restore_1', 'ws_demo');

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
    userId: options.admissionUserId ?? 'user_restore_1',
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
  const token = 'lease-binding:restore_1';

  createSchedulerSessionLease(coreDb, {
    agentSessionId: options.leaseAgentSessionId ?? environmentPackage.scope.agentSessionId,
    expiresAt: '2026-07-13T00:15:04.000Z',
    heartbeatDeadline: '2026-07-13T00:00:34.000Z',
    leaseId: 'lease_restore_1',
    now: () => '2026-07-13T00:00:04.000Z',
    packageSnapshotId: environmentPackage.snapshotId,
    planId: 'plan_restore_1',
    sandboxTokenBindingRef: token,
    sessionCompatibilityKey: 'sha256:restore-1',
    startupDeadline: '2026-07-13T00:02:04.000Z',
  });

  return { coreDb, environmentPackage, token };
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

      expect(gateway.authenticatePackageToken(`Bearer ${fixture.token}`)).toEqual(
        redactAgentEnvironmentPackageSnapshot(fixture.environmentPackage)
      );
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('fails closed when the durable AEP snapshot is missing or mismatched', () => {
    for (const options of [
      { recordSnapshot: false },
      { leaseAgentSessionId: 'as_wrong_owner' },
      { admissionRequestId: 'req_wrong_owner' },
      { admissionUserId: 'user_wrong_owner' },
    ]) {
      const fixture = createRestorableWorkerControlFixture(options);
      const gateway = new WorkerControlGateway();

      try {
        expect(() => rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway)).toThrow();
        expect(() => gateway.authenticatePackageToken(`Bearer ${fixture.token}`)).toThrow();
      } finally {
        fixture.coreDb.sqlite.close();
      }
    }
  });
});
