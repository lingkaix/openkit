import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  redactAgentEnvironmentPackageSnapshot,
} from '@openkit/config-schema';
import { type ActorRef, writeRetainedV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import { refuseScope } from '../bootstrap/readiness.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from '../knowledge/notebook.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from '../knowledge/okf.js';
import {
  type CoreDb,
  openBootVerifiedWorkspaceDb,
  openCoreDb,
  openWorkspaceDb,
} from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { verifyAndMigrateExistingScopedDatabases } from '../storage/workspace-storage-migration.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createTestQueueEntry } from '../test-support/scheduler-admissions.js';
import { disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { ExecutionReconciler } from './execution-reconciler.js';
import { bindNanoHostAttemptRouteTokenHashes } from './nanohost-attempt-records.js';
import { hashWorkerRouteToken, WorkerControlGateway } from './worker-control-gateway.js';
import { rebuildWorkerControlGatewaySessions } from './worker-control-rebuild.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';

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

/** Creates the retained predecessor that the real boot migration transfers into native Knowledge. */
function initializeWorkspaceKnowledgePredecessor(dataRoot: string, workspaceId: string): void {
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const knowledgeBaseId = testEntityId('kb', `worker-control-rebuild:${workspaceId}`);
  mkdirSync(join(workspaceRoot, 'config'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, 'config', 'workspace.jsonc'),
    `${JSON.stringify(
      writeRetainedV1({
        workspace: {
          name: workspaceId,
          defaultAgentId: null,
          defaultKnowledgeBaseId: knowledgeBaseId,
          knowledgeMounts: [
            {
              name: 'managed',
              backend: 'local',
              root: 'raw',
              default: true,
              knowledgeBaseId,
            },
          ],
        },
      })
    )}\n`
  );
  const schemaRoot = join(workspaceRoot, 'knowledge', 'schema');
  mkdirSync(schemaRoot, { recursive: true });
  writeFileSync(join(schemaRoot, 'scope-schema.yaml'), DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT);
  new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  }).initialize({
    files: { 'index.md': DEFAULT_NOTEBOOK_INDEX },
    metadata: {
      summary: 'Worker control rebuild fixture',
      producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      authority: { kind: 'direct', instructionReference: 'test-fixture:worker-control-rebuild' },
      changeRequest: { requestId: randomUUID(), inputDigest: `sha256:${'0'.repeat(64)}` },
      sourceReferences: [],
    },
  });
}

/**
 * Creates one durable AEP plus submitted Native attempt for restart hydration tests.
 *
 * @param options Optional lineage mismatch and snapshot omission controls.
 * @returns Restorable gateway fixture.
 */
async function createRestorableWorkerControlFixture(
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
): Promise<RestorableWorkerControlFixture> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-13T00:00:06.000Z'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-rebuild-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(() => disposeTestStore(dataRoot, coreDb));

  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  // Demo supplies the AEP input without populating the independent rebuild target.
  const sourceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-rebuild-source-'));
  onTestFinished(() => disposeTestStore(sourceRoot));
  const store = await createDemoStore({ dataRoot: sourceRoot });
  const turn = await store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Restore worker inference identity',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    await resolveAgentEnvironmentPackage({
      captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'as_00000000-0000-71b5-9df2-90c10d27f16c',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_restore_1',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      turn,
      workspaceCwd: '/workspace/openkit',
      workspaceRoots: [],
    })
  );
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const predecessorDb = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(predecessorDb);
  predecessorDb.sqlite.close();
  initializeWorkspaceKnowledgePredecessor(dataRoot, workspaceId);
  await verifyAndMigrateExistingScopedDatabases(dataRoot);
  const workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, workspaceId);
  try {
    if (options.recordSnapshot !== false) {
      await recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-13T00:00:01.000Z',
        environmentPackage,
      });
    }
  } finally {
    workspaceDb.sqlite.close();
  }

  const entry = await createTestQueueEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: options.admissionTriggerActor ?? environmentPackage.scope.triggerActor,
    now: () => '2026-07-13T00:00:02.000Z',
    profileRef: 'default',
    queueEntryId: 'queue_restore_1',
    requestId:
      options.admissionRequestId === undefined
        ? environmentPackage.scope.requestId!
        : options.admissionRequestId,
    requestedAgentId: environmentPackage.agent.agentId,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    text: 'Restore worker inference identity',
    workspaceId: environmentPackage.scope.workspaceId,
  });
  const sandboxBindingRef = 'lease-binding:restore_1';
  const workerControlToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const workerInferenceToken = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const workerCapabilityToken = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', 'lease_restore_1'),
    agentSessionId: options.attemptAgentSessionId ?? environmentPackage.scope.agentSessionId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: sandboxBindingRef,
    sessionCompatibilityKey: 'sha256:restore-1',
    operationId: 'submit_restore_1',
    now: () => '2026-07-13T00:00:04.000Z',
  });
  bindNanoHostAttemptRouteTokenHashes(coreDb, {
    attemptId: testEntityId('attempt', 'lease_restore_1'),
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
    onTestFinished(() => disposeTestStore(coreDb.dataRoot, coreDb));
    const gateway = new WorkerControlGateway();

    try {
      expect(() => rebuildWorkerControlGatewaySessions(coreDb, gateway)).not.toThrow();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('restores the owning AEP for token-only package authentication', async () => {
    const fixture = await createRestorableWorkerControlFixture();
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
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('ignores damaged historical heartbeat snapshots without changing their retained bytes', async () => {
    const fixture = await createRestorableWorkerControlFixture();
    const lineage = {
      agentSessionId: fixture.environmentPackage.scope.agentSessionId,
      packageSnapshotId: fixture.environmentPackage.snapshotId,
      requestId: fixture.environmentPackage.scope.requestId,
      threadId: fixture.environmentPackage.scope.threadId,
      turnId: fixture.environmentPackage.scope.turnId,
      workspaceId: fixture.environmentPackage.scope.workspaceId,
    };
    // This historical descriptive row grants no sequence or attempt acceptance.
    recordWorkerControlAcceptedRecord(fixture.coreDb, {
      acceptedAt: '2026-07-13T00:00:05.000Z',
      lineage,
      operation: 'heartbeat',
      record: {
        lastHeartbeatAt: '2026-07-13T00:00:05.000Z',
        message: null,
        sequence: 0,
        status: 'starting',
      },
      recordKey: '0',
      sequence: 0,
    });
    fixture.coreDb.sqlite
      .prepare("UPDATE worker_control_records SET record_json = '{' WHERE operation = 'heartbeat'")
      .run();
    const rows = () =>
      fixture.coreDb.sqlite
        .prepare("SELECT * FROM worker_control_records WHERE operation = 'heartbeat'")
        .all();
    const historicalRows = rows();
    expect(historicalRows).toHaveLength(1);
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });
    rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway);
    expect(gateway.authenticatePackageToken(`Bearer ${fixture.workerControlToken}`)).toEqual(
      redactAgentEnvironmentPackageSnapshot(fixture.environmentPackage)
    );
    expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat).toBeNull();
    expect(rows()).toEqual(historicalRows);
  });

  it('fails closed when the durable AEP snapshot is missing or mismatched', async () => {
    for (const options of [
      { recordSnapshot: false },
      { attemptAgentSessionId: 'as_00000000-0000-7862-ab63-7b3f305baefa' },
      { admissionRequestId: 'req_wrong_owner' },
      {
        admissionTriggerActor: {
          kind: 'automation' as const,
          id: 'auto_00000000-0000-7c0a-84d1-ecc00dfd92fa',
          responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        },
      },
    ]) {
      const fixture = await createRestorableWorkerControlFixture(options);
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

describe('closed predecessor restore isolation (#987)', () => {
  const predecessorWorkspaceId = 'ws_00000000-0000-7000-8000-000000000002';
  afterEach(() => vi.useRealTimers());

  /**
   * Adds a second Workspace whose attempt is restorable, beside the fixture's healthy open lease.
   * The AEP is the fixture's package re-addressed to the second Workspace, so no unrelated seam moves.
   */
  async function addPredecessor(
    fixture: RestorableWorkerControlFixture,
    phase: 'open' | 'closing' | 'closed'
  ) {
    const coreDb = fixture.coreDb;
    const dataRoot = coreDb.dataRoot;
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: predecessorWorkspaceId,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const agentSessionId = 'as_00000000-0000-71b5-9df2-90c10d27f2a2';
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...fixture.environmentPackage,
      snapshotId: 'aepsnap_predecessor',
      scope: {
        ...fixture.environmentPackage.scope,
        workspaceId: predecessorWorkspaceId,
        threadId: 'th_00000000-0000-7000-8000-000000000002',
        turnId: testEntityId('tu', 'predecessor'),
        agentSessionId,
        requestId: 'req_restore_predecessor',
      },
    });
    const predecessorDb = openWorkspaceDb(dataRoot, predecessorWorkspaceId);
    applyScopedMigrations(predecessorDb);
    predecessorDb.sqlite.close();
    initializeWorkspaceKnowledgePredecessor(dataRoot, predecessorWorkspaceId);
    await verifyAndMigrateExistingScopedDatabases(dataRoot);
    const workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, predecessorWorkspaceId);
    try {
      await recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-13T00:00:01.000Z',
        environmentPackage,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const entry = await createTestQueueEntry(coreDb, {
      backendId: 'nanohost',
      triggerActor: environmentPackage.scope.triggerActor,
      now: () => '2026-07-13T00:00:02.000Z',
      profileRef: 'default',
      queueEntryId: 'queue_restore_predecessor',
      requestId: environmentPackage.scope.requestId!,
      requestedAgentId: environmentPackage.agent.agentId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      text: 'Restore the predecessor',
      workspaceId: predecessorWorkspaceId,
    });
    const attemptId = testEntityId('attempt', 'lease_restore_predecessor');
    const tokens = {
      control: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
      inference: 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
      capability: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    };
    recordTestExecutionAttempt(coreDb, {
      entry,
      attemptId,
      agentSessionId,
      inputRef: environmentPackage.snapshotId,
      bindingRef: 'lease-binding:restore_predecessor',
      sessionCompatibilityKey: 'sha256:restore-predecessor',
      operationId: 'submit_restore_predecessor',
      now: () => '2026-07-13T00:00:04.000Z',
    });
    bindNanoHostAttemptRouteTokenHashes(coreDb, {
      attemptId,
      now: () => '2026-07-13T00:00:05.000Z',
      sandboxBindingRef: 'lease-binding:restore_predecessor',
      workerCapabilityTokenHash: hashWorkerRouteToken(tokens.capability),
      workerControlTokenHash: hashWorkerRouteToken(tokens.control),
      workerInferenceTokenHash: hashWorkerRouteToken(tokens.inference),
    });
    const lineage = {
      agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: predecessorWorkspaceId,
    };
    if (phase === 'closed') {
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-07-13T00:00:05.500Z',
        lineage,
        operation: 'final_status',
        record: { status: 'completed', stopReason: 'completed' },
        recordKey: 'final',
        sequence: 1,
      });
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET phase = 'closed', disposition = 'accepted', fence_ref = 'fence:predecessor' WHERE attempt_id = ?"
        )
        .run(attemptId);
    } else if (phase === 'closing') {
      // A cancellation first final is still servable: only the closed exact replay may be held locally.
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET phase = 'closing', terminal_cause = 'turn-cancelled', startup_deadline = '2026-07-13T01:00:00.000Z' WHERE attempt_id = ?"
        )
        .run(attemptId);
    }
    return {
      attemptId,
      environmentPackage,
      lineage,
      tokens,
      snapshotPath: join(
        dataRoot,
        'workspaces',
        predecessorWorkspaceId,
        'runtime',
        'agent-sessions',
        agentSessionId,
        'aep-snapshots',
        `${environmentPackage.snapshotId}.json`
      ),
    };
  }

  const faults = {
    retired: (fixture: RestorableWorkerControlFixture) =>
      refuseScope(fixture.coreDb.dataRoot, {
        scope: 'workspace',
        id: predecessorWorkspaceId,
        check: 'retired',
      }),
    quarantined: (fixture: RestorableWorkerControlFixture) =>
      refuseScope(fixture.coreDb.dataRoot, {
        scope: 'workspace',
        id: predecessorWorkspaceId,
        check: 'database',
      }),
    unreadableAep: (_fixture: RestorableWorkerControlFixture, snapshotPath?: string) =>
      writeFileSync(snapshotPath!, '{'),
  } as const;

  const restored = (fixture: RestorableWorkerControlFixture) => {
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });
    rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway);
    return gateway;
  };

  it('restores the healthy lease and the closed replay when no fault is present (control)', async () => {
    const fixture = await createRestorableWorkerControlFixture();
    const predecessor = await addPredecessor(fixture, 'closed');
    const gateway = restored(fixture);
    expect(gateway.authenticatePackageToken(`Bearer ${fixture.workerControlToken}`)).toBeTruthy();
    expect(gateway.authenticatePackageToken(`Bearer ${predecessor.tokens.control}`)).toBeTruthy();
    expect(gateway.getSessionSnapshot(predecessor.lineage.packageSnapshotId)).not.toBeNull();
  });

  for (const fault of ['retired', 'quarantined', 'unreadableAep'] as const) {
    it(`holds only the closed predecessor replay for ${fault} and restores the healthy Workspace`, async () => {
      const fixture = await createRestorableWorkerControlFixture();
      const predecessor = await addPredecessor(fixture, 'closed');
      const original = readFileSync(predecessor.snapshotPath, 'utf8');
      faults[fault](fixture, predecessor.snapshotPath);
      const gateway = restored(fixture);
      expect(gateway.authenticatePackageToken(`Bearer ${fixture.workerControlToken}`)).toEqual(
        redactAgentEnvironmentPackageSnapshot(fixture.environmentPackage)
      );
      expect(gateway.getSessionSnapshot(predecessor.lineage.packageSnapshotId)).toBeNull();
      expect(() =>
        gateway.authenticatePackageToken(`Bearer ${predecessor.tokens.control}`)
      ).toThrow(expect.objectContaining({ code: 'worker_control_unauthorized', status: 401 }));
      if (fault === 'unreadableAep') {
        // The exit: repaired retained bytes restore the replay at the next hydration, nothing else changed.
        writeFileSync(predecessor.snapshotPath, original);
        const repaired = restored(fixture);
        expect(repaired.getSessionSnapshot(predecessor.lineage.packageSnapshotId)).not.toBeNull();
      }
    });
  }

  it('keeps the shared hold for a closing first-final candidate whose Workspace is retired', async () => {
    const fixture = await createRestorableWorkerControlFixture();
    await addPredecessor(fixture, 'closing');
    faults.retired(fixture);
    expect(() => restored(fixture)).toThrow(/quarantined; check=retired/);
  });

  it('keeps the shared hold for a closed predecessor whose accepted record is unreadable', async () => {
    for (const fault of ['retired', 'unreadableAep'] as const) {
      const fixture = await createRestorableWorkerControlFixture();
      const predecessor = await addPredecessor(fixture, 'closed');
      recordWorkerControlAcceptedRecord(fixture.coreDb, {
        acceptedAt: '2026-07-13T00:00:05.600Z',
        lineage: predecessor.lineage,
        operation: 'artifact_notice',
        record: { artifactId: 'artifact_predecessor' },
        recordKey: 'artifact_predecessor',
        sequence: null,
      });
      fixture.coreDb.sqlite
        .prepare(
          "UPDATE worker_control_records SET record_json = '{' WHERE operation = 'artifact_notice'"
        )
        .run();
      faults[fault](fixture, predecessor.snapshotPath);
      expect(() => restored(fixture)).toThrow();
    }
  });

  it('keeps the shared hold for a closed predecessor beside a valid-JSON record that fails the canonical schema', async () => {
    const invalid = {
      capability_summary: '{}',
      event_append: '{"event":{"type":"turn.completed"}}',
      supply_refresh_ack: '{}',
    } as const;
    const cases = [
      ['event_append', 'retired'],
      ['event_append', 'unreadableAep'],
      ['capability_summary', 'retired'],
      ['supply_refresh_ack', 'retired'],
    ] as const;
    for (const [operation, fault] of cases) {
      const fixture = await createRestorableWorkerControlFixture();
      const predecessor = await addPredecessor(fixture, 'closed');
      recordWorkerControlAcceptedRecord(fixture.coreDb, {
        acceptedAt: '2026-07-13T00:00:05.600Z',
        lineage: predecessor.lineage,
        operation: 'artifact_notice',
        record: { artifactId: 'artifact_predecessor' },
        recordKey: 'artifact_predecessor',
        sequence: null,
      });
      fixture.coreDb.sqlite
        .prepare(
          'UPDATE worker_control_records SET operation = ?, record_json = ? WHERE operation = ?'
        )
        .run(operation, invalid[operation], 'artifact_notice');
      faults[fault](fixture, predecessor.snapshotPath);
      // The same record fails the gateway schema when its lease hydrates; the plan must not
      // let an owner-local skip hide it and publish the healthy lease.
      expect(() => restored(fixture), `${operation} + ${fault}`).toThrow();
    }
  }, 120_000);

  it('does not make boot fatal for an open lease in a retired Workspace: global hold, 503, no route served', async () => {
    const fixture = await createRestorableWorkerControlFixture();
    const predecessor = await addPredecessor(fixture, 'open');
    faults.retired(fixture);
    // The plan contract is unchanged: the open lease still throws out of the rebuild itself.
    expect(() => restored(fixture)).toThrow(/quarantined; check=retired/);
    const gateway = createDefaultWorkerControlGateway(fixture.coreDb);
    expect(() => gateway.registerSession(fixture.environmentPackage)).toThrow(
      expect.objectContaining({ code: 'worker_observation_storage_unavailable', status: 503 })
    );
    for (const token of [fixture.workerControlToken, predecessor.tokens.control])
      expect(() => gateway.authenticatePackageToken(`Bearer ${token}`)).toThrow(
        expect.objectContaining({ code: 'worker_control_unauthorized', status: 401 })
      );
    // The same boot's reconciliation pass reads idle-cleanup residents only; it must not throw
    // on an unrestored open lease in the refused Workspace.
    const advanceIdleCleanup = vi.fn(async () => {});
    await expect(
      new ExecutionReconciler({ coreDb: fixture.coreDb, advanceIdleCleanup }).runOnce()
    ).resolves.toBeUndefined();
    expect(advanceIdleCleanup).not.toHaveBeenCalled();
  });

  it('marks the default gateway held only when the restore plan is held', async () => {
    const heldFixture = await createRestorableWorkerControlFixture();
    await addPredecessor(heldFixture, 'open');
    faults.retired(heldFixture);
    expect(createDefaultWorkerControlGateway(heldFixture.coreDb).restoreHeld()).toBe(true);
    const healthyFixture = await createRestorableWorkerControlFixture();
    expect(createDefaultWorkerControlGateway(healthyFixture.coreDb).restoreHeld()).toBe(false);
  });

  it('keeps the default gateway unheld when every lease restores', async () => {
    const fixture = await createRestorableWorkerControlFixture();
    await addPredecessor(fixture, 'closed');
    const gateway = createDefaultWorkerControlGateway(fixture.coreDb);
    expect(gateway.registerSession(fixture.environmentPackage)).toBeTruthy();
  });
});
