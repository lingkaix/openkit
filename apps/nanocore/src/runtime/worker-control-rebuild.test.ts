import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  redactAgentEnvironmentPackageSnapshot,
} from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { bindNanoHostAttemptRouteTokenHashes } from './nanohost-attempt-records.js';
import { hashWorkerRouteToken, WorkerControlGateway } from './worker-control-gateway.js';
import { rebuildWorkerControlGatewaySessions } from './worker-control-rebuild.js';

interface RestorableWorkerControlFixture {
  /** Migrated Core database containing the live execution attempt. */
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
 * Creates one durable AEP plus submitted Native attempt for restart hydration tests.
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
    /** AgentSession stored on the attempt instead of the AEP lineage. */
    readonly attemptAgentSessionId?: string;
    /** Whether to persist the owning AEP snapshot. */
    readonly recordSnapshot?: boolean;
  } = {}
): RestorableWorkerControlFixture {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-13T00:00:06.000Z'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-rebuild-'));
  const coreDb = openCoreDb(dataRoot);

  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Restore worker inference identity', {
    kind: 'user',
    id: 'user_local',
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'as_restore_1',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_restore_1',
      triggerActor: { kind: 'user', id: 'user_local' },
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

  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: options.admissionTriggerActor ?? environmentPackage.scope.triggerActor,
    now: () => '2026-07-13T00:00:02.000Z',
    profileRef: 'default',
    queueEntryId: 'queue_restore_1',
    requestId:
      options.admissionRequestId === undefined
        ? environmentPackage.scope.requestId
        : options.admissionRequestId,
    requestedAgentId: environmentPackage.agent.agentId,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    turnInput: 'Restore worker inference identity',
    workspaceId: environmentPackage.scope.workspaceId,
  });
  const sandboxBindingRef = 'lease-binding:restore_1';
  const workerControlToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const workerInferenceToken = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const workerCapabilityToken = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: 'lease_restore_1',
    agentSessionId: options.attemptAgentSessionId ?? environmentPackage.scope.agentSessionId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: sandboxBindingRef,
    sessionCompatibilityKey: 'sha256:restore-1',
    operationId: 'submit_restore_1',
    now: () => '2026-07-13T00:00:04.000Z',
  });
  bindNanoHostAttemptRouteTokenHashes(coreDb, {
    attemptId: 'lease_restore_1',
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
  afterEach(() => vi.useRealTimers());
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

  it('fails closed when the durable AEP snapshot is missing or mismatched', () => {
    for (const options of [
      { recordSnapshot: false },
      { attemptAgentSessionId: 'as_wrong_owner' },
      { admissionRequestId: 'req_wrong_owner' },
      {
        admissionTriggerActor: {
          kind: 'automation',
          id: 'automation_wrong_actor',
          responsibleUserId: 'user_local',
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
