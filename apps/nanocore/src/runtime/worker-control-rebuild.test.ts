import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { createDefaultWorkerControlGateway } from '../app.js';
import { refuseScope } from '../bootstrap/readiness.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from '../knowledge/notebook.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from '../knowledge/okf.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import {
  type CoreDb,
  openBootVerifiedWorkspaceDb,
  openCoreDb,
  openWorkspaceDb,
} from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { resolveAdmittedNanoHostWorkerBinding } from '../storage/nanohost-worker-binding.js';
import { verifyAndMigrateExistingScopedDatabases } from '../storage/workspace-storage-migration.js';
import {
  mutateAdmittedTestNanoHost,
  openAdmittedTestNanoHost,
} from '../test-support/admitted-nanohost.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
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

type ClosedPredecessorFault = 'none' | 'retired' | 'package-unreadable' | 'shared-final-record';

const ISOLATION_USER_ID = 'usr_00000000-0000-7000-8000-000000000001';

/**
 * A closed predecessor with an accepted final in Workspace A and a live Turn in a healthy Workspace B,
 * hydrated through the App's own gateway factory on the admitted NanoHost owner.
 *
 * @param fault Deliberate fault applied after the predecessor's real final was accepted.
 * @returns Both owners, the new healthy Session's package and the predecessor's retained AEP path.
 */
async function createClosedPredecessorFixture(fault: ClosedPredecessorFault) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-13T00:00:06.000Z'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-isolation-'));
  const coreDb = openCoreDb(dataRoot);
  const sourceRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-control-isolation-source-'));
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    disposeTestStore(dataRoot, coreDb);
    disposeTestStore(sourceRoot);
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const storage = await openAdmittedTestNanoHost(coreDb);
  const store = await createDemoStore({ dataRoot: sourceRoot });
  const healthyWorkspace = await store.createWorkspace('Healthy restore isolation');
  // Each Turn runs on its own Thread; one Thread admits only one nonterminal Turn.
  const predecessorThread = await store.createThread(DEMO_WORKSPACE_ID, 'Predecessor Thread');
  const healthyThread = await store.createThread(healthyWorkspace.id, 'Healthy Thread');
  const newSessionThread = await store.createThread(healthyWorkspace.id, 'New Session Thread');
  const agentSetup = createTestAgentSetup();
  const imageDigest = `sha256:${'a'.repeat(64)}`;
  const inputDigest = commandInputHash(materializeRuntimeImage(agentSetup.manifest.runtime.image));
  const values = { REBUILD_FROM_NATIVE_DEFAULT: 'retained' };
  const defaultsDigest = `sha256:${createHash('sha256').update(canonicalNativeEnvironment(values)).digest('hex')}`;
  const imageIdentity = {
    authoredArtifactId: testEntityId('ar', 'restore-isolation-image'),
    authoredArtifactVersion: 1 as const,
    authoredContentDigest: inputDigest,
    inputDigest,
  };
  mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
    insertWorkerImageSettlementInTransaction(
      { sqlite },
      {
        ...imageIdentity,
        requestId: 'b'.repeat(64),
        operation: 'image.acquire',
        outcome: { kind: 'success', imageDigest },
      }
    );
    admitWorkerImageEnvironment({ sqlite }, imageIdentity, { imageDigest, defaultsDigest, values });
  });
  const resolvePackage = async (
    workspaceId: string,
    threadId: string,
    agentSessionId: string,
    requestId: string
  ) => {
    const turn = await store.createTurn(workspaceId, threadId, 'Isolate closed replay', {
      kind: 'user',
      id: ISOLATION_USER_ID,
    });
    return AgentEnvironmentPackageSchema.parse(
      await resolveAgentEnvironmentPackage({
        captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
        agentSetup,
        coreDb,
        readNanoHostEnvironment: storage.value.owner.read,
        agentSessionId,
        backend: { kind: 'openshell' },
        createdAt: '2026-07-13T00:00:00.000Z',
        requestId,
        triggerActor: { kind: 'user', id: ISOLATION_USER_ID },
        turn,
        workspaceCwd: '/workspace/openkit',
        workspaceRoots: [],
      })
    );
  };
  for (const workspaceId of [DEMO_WORKSPACE_ID, healthyWorkspace.id]) {
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: ISOLATION_USER_ID });
    const predecessorDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(predecessorDb);
    predecessorDb.sqlite.close();
    initializeWorkspaceKnowledgePredecessor(dataRoot, workspaceId);
  }
  await verifyAndMigrateExistingScopedDatabases(dataRoot);
  const owners = [
    {
      name: 'predecessor',
      environmentPackage: await resolvePackage(
        DEMO_WORKSPACE_ID,
        predecessorThread.id,
        testEntityId('as', 'restore-isolation-predecessor'),
        'req_isolation_predecessor'
      ),
      tokens: ['D', 'E', 'F'].map((letter) => letter.repeat(43)),
    },
    {
      name: 'healthy',
      environmentPackage: await resolvePackage(
        healthyWorkspace.id,
        healthyThread.id,
        testEntityId('as', 'restore-isolation-healthy'),
        'req_isolation_healthy'
      ),
      tokens: ['G', 'H', 'I'].map((letter) => letter.repeat(43)),
    },
  ].map((owner) => ({
    ...owner,
    attemptId: testEntityId('attempt', `restore-isolation-${owner.name}`),
    lineage: {
      agentSessionId: owner.environmentPackage.scope.agentSessionId,
      packageSnapshotId: owner.environmentPackage.snapshotId,
      requestId: owner.environmentPackage.scope.requestId,
      threadId: owner.environmentPackage.scope.threadId,
      turnId: owner.environmentPackage.scope.turnId,
      workspaceId: owner.environmentPackage.scope.workspaceId,
    },
  }));
  for (const owner of owners) {
    const { environmentPackage } = owner;
    const workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, environmentPackage.scope.workspaceId);
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
      queueEntryId: `queue_restore_isolation_${owner.name}`,
      requestId: environmentPackage.scope.requestId!,
      requestedAgentId: environmentPackage.agent.agentId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      text: 'Isolate closed replay',
      workspaceId: environmentPackage.scope.workspaceId,
    });
    const [control, inference, capability] = owner.tokens as [string, string, string];
    submitTestNanoHostWorkerLease(
      coreDb,
      entry,
      `lease-binding:restore-isolation-${owner.name}`,
      {
        agentSessionId: environmentPackage.scope.agentSessionId,
        packageSnapshotId: environmentPackage.snapshotId,
        workerCapabilityTokenHash: hashWorkerRouteToken(capability),
        workerControlTokenHash: hashWorkerRouteToken(control),
        workerInferenceTokenHash: hashWorkerRouteToken(inference),
      },
      { attemptId: owner.attemptId }
    );
  }
  const [predecessor, healthy] = owners as [(typeof owners)[0], (typeof owners)[0]];
  // The predecessor's Turn really ended: Core closed it with its proof, NanoHost kept its final.
  const closing = markSchedulerExecutionAttemptClosing(coreDb, {
    attemptId: predecessor.attemptId,
    cause: 'turn-completed',
  });
  closeSchedulerExecutionAttemptWithFence(coreDb, {
    correlation: schedulerExecutionCorrelation(closing),
    fenceRef: 'restore-isolation-original-fence',
    proof: {
      terminalHandoff: true,
      output: true,
      evidence: true,
      outsideWorkspaceCollection: true,
      integrationDrain: true,
      routesRevoked: true,
    },
  });
  mutateAdmittedTestNanoHost(coreDb, (sqlite) =>
    writeWorkerControlAcceptedRecord(
      { sqlite },
      {
        acceptedAt: '2026-07-13T00:00:05.000Z',
        lineage: predecessor.lineage,
        operation: 'final_status',
        record: { status: 'completed', stopReason: 'completed' },
        recordKey: '0',
        sequence: 0,
      }
    )
  );
  const predecessorPackagePath = join(
    dataRoot,
    'workspaces',
    DEMO_WORKSPACE_ID,
    'runtime/agent-sessions',
    predecessor.lineage.agentSessionId,
    'aep-snapshots',
    `${predecessor.lineage.packageSnapshotId}.json`
  );
  const acceptedPackageBytes = readFileSync(predecessorPackagePath, 'utf8');
  // Faults follow the real final. None of them can be produced by the replay path itself.
  if (fault === 'retired')
    refuseScope(dataRoot, { scope: 'workspace', id: DEMO_WORKSPACE_ID, check: 'retired' });
  if (fault === 'package-unreadable')
    // A historical retained format this build cannot decode; the record is otherwise intact.
    writeFileSync(
      predecessorPackagePath,
      JSON.stringify({ ...JSON.parse(acceptedPackageBytes), schemaVersion: 2 })
    );
  if (fault === 'shared-final-record')
    mutateAdmittedTestNanoHost(coreDb, (sqlite) =>
      sqlite
        .prepare(
          "UPDATE worker_control_records SET record_json = '{' WHERE operation = 'final_status'"
        )
        .run()
    );
  const newSession = await resolvePackage(
    healthyWorkspace.id,
    newSessionThread.id,
    testEntityId('as', 'restore-isolation-new-session'),
    'req_isolation_new_session'
  );
  return {
    storage,
    predecessor,
    healthy,
    newSession,
    predecessorPackagePath,
    acceptedPackageBytes,
    hydrate: () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const gateway = createDefaultWorkerControlGateway(coreDb, undefined, storage);
        const holds = log.mock.calls.flatMap(([line]) => {
          try {
            const event = JSON.parse(String(line)) as { event?: unknown };
            return event.event === 'worker.control.restore-held' ? [event] : [];
          } catch {
            return [];
          }
        });
        return { gateway, holds };
      } finally {
        log.mockRestore();
      }
    },
  };
}

describe('closed predecessor restore isolation', () => {
  afterEach(() => vi.useRealTimers());

  /** The predecessor's own old route: its exact final replay with its original control token. */
  const replayPredecessorFinal = (
    gateway: WorkerControlGateway,
    predecessor: Awaited<ReturnType<typeof createClosedPredecessorFixture>>['predecessor']
  ) =>
    gateway.recordFinalStatus({
      authorization: `Bearer ${predecessor.tokens[0]}`,
      lineage: predecessor.lineage,
      sequence: 0,
      status: 'completed',
      stopReason: 'completed',
    });

  it('restores the closed predecessor with the healthy owner when its own evidence qualifies', async () => {
    const f = await createClosedPredecessorFixture('none');
    const { gateway, holds } = f.hydrate();

    expect(holds).toEqual([]);
    expect(gateway.getSessionSnapshot(f.predecessor.lineage.packageSnapshotId)).toMatchObject({
      packageSnapshotId: f.predecessor.lineage.packageSnapshotId,
    });
    expect(gateway.authenticatePackageToken(`Bearer ${f.healthy.tokens[0]}`)).toEqual(
      redactAgentEnvironmentPackageSnapshot(f.healthy.environmentPackage)
    );
  });

  it.each([
    ['retired', 'workspace-not-admitted'],
    ['package-unreadable', 'package-unreadable'],
  ] as const)(
    'holds only the closed predecessor whose own Workspace cannot prove its replay: %s',
    async (fault, causeCode) => {
      const f = await createClosedPredecessorFixture(fault);
      const { gateway, holds } = f.hydrate();

      // The old route is not restored, so its exact replay stays refused.
      expect(gateway.getSessionSnapshot(f.predecessor.lineage.packageSnapshotId)).toBeNull();
      await expect(replayPredecessorFinal(gateway, f.predecessor)).rejects.toMatchObject({
        code: 'worker_control_unauthorized',
        status: 401,
      });
      // The healthy Workspace keeps serving: its live Turn restores and a new Session registers.
      expect(gateway.authenticatePackageToken(`Bearer ${f.healthy.tokens[0]}`)).toEqual(
        redactAgentEnvironmentPackageSnapshot(f.healthy.environmentPackage)
      );
      expect(gateway.registerSession(f.newSession)).toMatchObject({
        packageSnapshotId: f.newSession.snapshotId,
      });
      // Inspectable, per owner, with finite fields only.
      expect(holds).toEqual([
        {
          event: 'worker.control.restore-held',
          errorCode: 'recovery_required',
          causeCode,
          attemptId: f.predecessor.attemptId,
          workspaceId: DEMO_WORKSPACE_ID,
        },
      ]);
      if (fault === 'package-unreadable') {
        // Hydration never rewrites the retained record. Its exit is same-owner repair: the next
        // hydration of the repaired record restores the exact replay.
        expect(JSON.parse(readFileSync(f.predecessorPackagePath, 'utf8')).schemaVersion).toBe(2);
        writeFileSync(f.predecessorPackagePath, f.acceptedPackageBytes);
        const repaired = f.hydrate();
        expect(repaired.holds).toEqual([]);
        expect(
          repaired.gateway.getSessionSnapshot(f.predecessor.lineage.packageSnapshotId)
        ).toMatchObject({ packageSnapshotId: f.predecessor.lineage.packageSnapshotId });
      }
    }
  );

  it('still holds every owner when the shared replay authority itself is untrustworthy', async () => {
    const f = await createClosedPredecessorFixture('shared-final-record');
    const { gateway, holds } = f.hydrate();

    expect(holds).toEqual([]);
    expect(() => gateway.registerSession(f.newSession)).toThrow(
      expect.objectContaining({ code: 'worker_observation_storage_unavailable', status: 503 })
    );
    expect(() => gateway.authenticatePackageToken(`Bearer ${f.healthy.tokens[0]}`)).toThrow();
    expect(gateway.getSessionSnapshot(f.predecessor.lineage.packageSnapshotId)).toBeNull();
  });
});
