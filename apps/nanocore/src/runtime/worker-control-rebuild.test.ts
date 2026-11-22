import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  redactAgentEnvironmentPackageSnapshot,
} from '@openkit/config-schema';
import { type ActorRef, writeRetainedV1 } from '@openkit/protocol';
import { canonicalNativeEnvironment } from '@openkit/worker-protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from '../knowledge/notebook.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from '../knowledge/okf.js';
import {
  type CoreDb,
  openBootVerifiedWorkspaceDb,
  openCoreDb,
  openWorkspaceDb,
} from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { resolveAdmittedNanoHostWorkerBinding } from '../storage/nanohost-worker-binding.js';
import { verifyAndMigrateExistingScopedDatabases } from '../storage/workspace-storage-migration.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openNanoHostTestOwner } from '../test-support/nanohost-owner.js';
import { submitTestNanoHostWorkerLease } from '../test-support/nanohost-worker-lease.js';
import { createTestQueueEntry } from '../test-support/scheduler-admissions.js';
import { disposeTestStore } from '../test-support/store.js';
import { materializeRuntimeImage } from '../worker-environments/worker-environment-preparation.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  closeSchedulerExecutionAttemptWithFence,
  markSchedulerExecutionAttemptClosing,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import { commandInputHash } from './idempotent-command.js';
import { hashWorkerRouteToken, WorkerControlGateway } from './worker-control-gateway.js';
import { rebuildWorkerControlGatewaySessions } from './worker-control-rebuild.js';
import { writeWorkerControlAcceptedRecord } from './worker-control-records.js';
import {
  admitWorkerImageEnvironment,
  insertWorkerImageSettlementInTransaction,
} from './worker-image-settlements-records.js';

interface RestorableWorkerControlFixture {
  /** Migrated Core database containing the live execution attempt. */
  readonly coreDb: CoreDb;
  readonly nanoHost: ReturnType<typeof openNanoHostTestOwner>;
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
  const nanoHost = openNanoHostTestOwner();
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
  const agentSetup = createTestAgentSetup();
  const imageDigest = `sha256:${'a'.repeat(64)}`;
  const inputDigest = commandInputHash(materializeRuntimeImage(agentSetup.manifest.runtime.image));
  const values = { REBUILD_FROM_NATIVE_DEFAULT: 'retained' };
  const defaultsDigest = `sha256:${createHash('sha256').update(canonicalNativeEnvironment(values)).digest('hex')}`;
  const imageIdentity = {
    authoredArtifactId: testEntityId('ar', 'restore-image'),
    authoredArtifactVersion: 1 as const,
    authoredContentDigest: inputDigest,
    inputDigest,
  };
  nanoHost.setup((sqlite) => {
    insertWorkerImageSettlementInTransaction(
      { sqlite },
      {
        ...imageIdentity,
        requestId: 'a'.repeat(64),
        operation: 'image.acquire',
        outcome: { kind: 'success', imageDigest },
      }
    );
    admitWorkerImageEnvironment({ sqlite }, imageIdentity, { imageDigest, defaultsDigest, values });
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    await resolveAgentEnvironmentPackage({
      captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
      agentSetup,
      coreDb,
      readNanoHostEnvironment: nanoHost.storage.owner.read,
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
  expect(environmentPackage.runtime.environment).toMatchObject({
    imageDigest,
    defaultsDigest,
    values,
  });
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

  submitTestNanoHostWorkerLease(
    coreDb,
    entry,
    sandboxBindingRef,
    {
      agentSessionId: options.attemptAgentSessionId ?? environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      workerCapabilityTokenHash: hashWorkerRouteToken(workerCapabilityToken),
      workerControlTokenHash: hashWorkerRouteToken(workerControlToken),
      workerInferenceTokenHash: hashWorkerRouteToken(workerInferenceToken),
    },
    { attemptId: testEntityId('attempt', 'lease_restore_1'), nativePath: nanoHost.sqlite.name }
  );

  return {
    coreDb,
    nanoHost,
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
    const read = fixture.nanoHost.storage.owner.read;
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: (input) => {
        const binding = read((sqlite) =>
          resolveAdmittedNanoHostWorkerBinding(fixture.coreDb, sqlite, input)
        );
        if (binding.state !== 'ready') throw new Error('The admitted fixture is unavailable.');
        return binding.value;
      },
    });

    try {
      expect(rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway, read)).toEqual({
        state: 'ready',
        value: undefined,
      });

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
    fixture.nanoHost.setup((sqlite) => {
      writeWorkerControlAcceptedRecord(
        { sqlite },
        {
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
        }
      );
      sqlite
        .prepare(
          "UPDATE worker_control_records SET record_json = '{' WHERE operation = 'heartbeat'"
        )
        .run();
    });
    const rows = () =>
      fixture.nanoHost.sqlite
        .prepare("SELECT * FROM worker_control_records WHERE operation = 'heartbeat'")
        .all();
    const historicalRows = rows();
    expect(historicalRows).toHaveLength(1);
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });
    expect(
      rebuildWorkerControlGatewaySessions(
        fixture.coreDb,
        gateway,
        fixture.nanoHost.storage.owner.read
      )
    ).toEqual({ state: 'ready', value: undefined });
    expect(gateway.authenticatePackageToken(`Bearer ${fixture.workerControlToken}`)).toEqual(
      redactAgentEnvironmentPackageSnapshot(fixture.environmentPackage)
    );
    expect(gateway.getSessionSnapshot(lineage.packageSnapshotId)?.heartbeat).toBeNull();
    expect(rows()).toEqual(historicalRows);
  });

  it('restores closed exact final replay only when NanoHost has the original accepted record', async () => {
    const fixture = await createRestorableWorkerControlFixture();
    const { snapshotId, scope } = fixture.environmentPackage;
    const lineage = {
      agentSessionId: scope.agentSessionId,
      packageSnapshotId: snapshotId,
      requestId: scope.requestId,
      threadId: scope.threadId,
      turnId: scope.turnId,
      workspaceId: scope.workspaceId,
    };
    const closing = markSchedulerExecutionAttemptClosing(fixture.coreDb, {
      attemptId: testEntityId('attempt', 'lease_restore_1'),
      cause: 'turn-completed',
    });
    closeSchedulerExecutionAttemptWithFence(fixture.coreDb, {
      correlation: schedulerExecutionCorrelation(closing),
      fenceRef: 'fixture-original-fence',
      proof: {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      },
    });
    const gateway = new WorkerControlGateway();
    const read = fixture.nanoHost.storage.owner.read;
    expect(rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway, read).state).toBe('ready');
    expect(gateway.getSessionSnapshot(snapshotId)).toBeNull();

    fixture.nanoHost.setup((sqlite) => {
      writeWorkerControlAcceptedRecord(
        { sqlite },
        {
          acceptedAt: '2026-07-13T00:00:05.000Z',
          lineage,
          operation: 'final_status',
          record: { status: 'completed', stopReason: 'completed' },
          recordKey: '0',
          sequence: 0,
        }
      );
    });
    await fixture.nanoHost.reopen();
    const missing = { state: 'unavailable', owner: 'nanohost', reason: 'missing' } as const;
    expect(rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway, () => missing)).toBe(
      missing
    );
    expect(gateway.getSessionSnapshot(snapshotId)).toBeNull();
    expect(rebuildWorkerControlGatewaySessions(fixture.coreDb, gateway, read).state).toBe('ready');
    expect(gateway.getSessionSnapshot(snapshotId)).toMatchObject({ packageSnapshotId: snapshotId });
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
        expect(
          rebuildWorkerControlGatewaySessions(
            fixture.coreDb,
            gateway,
            fixture.nanoHost.storage.owner.read
          )
        ).toEqual({ state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' });
        expect(() =>
          gateway.authenticatePackageToken(`Bearer ${fixture.workerControlToken}`)
        ).toThrow();
      } finally {
        fixture.coreDb.sqlite.close();
      }
    }
  });
});
