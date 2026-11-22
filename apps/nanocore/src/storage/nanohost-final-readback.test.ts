import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { canonicalJsonText, workspaceIdForOwner } from '@openkit/protocol';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, type MockInstance, onTestFinished, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { commandRequestExpiresAt, commandRequestKey, type FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  listOpenSchedulerExecutionAttempts,
  requireSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import { readExecutionJournalRoot } from '../runtime/execution-journal.js';
import {
  type AdmittedNanoHostAttemptRecovery,
  classifyNanoHostAttemptsAfterRestart,
  type RunNanoHostAttemptRecoveryInput,
  runNanoHostAttemptRecoveryMaintenance,
} from '../runtime/nanohost-attempt-recovery.js';
import { runSchedulerRestartRecovery } from '../runtime/scheduler-restart-recovery.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import {
  getWorkerBackendSession,
  type WorkerBackendSessionRecord,
} from '../runtime/worker-backend-session-records.js';
import {
  hashWorkerRouteToken,
  WorkerControlGatewayError,
  type WorkerControlLineage,
} from '../runtime/worker-control-gateway.js';
import { waitForWorkerControlFinalStatus } from '../runtime/worker-control-records.js';
import type { WorkerGovernanceBackend } from '../runtime/worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from '../runtime/worker-governance-turn-executor.js';
import { hasPendingWorkspaceCapture } from '../runtime/workspace-reconciliation-records.js';
import {
  currentAdmittedTestNanoHostOwner,
  mutateAdmittedTestNanoHost,
  openAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
  reopenAdmittedTestNanoHost,
} from '../test-support/admitted-nanohost.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { testBootNanoHostRecovery } from '../test-support/boot-nanohost-recovery.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { submitTestNanoHostWorkerLease } from '../test-support/nanohost-worker-lease.js';
import { admitTestNativeEnvironmentForRoot } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { TEST_WORKER_RELEASE_IDENTITY } from '../test-support/release-identity.js';
import { createTestQueueEntry } from '../test-support/scheduler-admissions.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { commandInputHash } from './control-store-input.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  inspectAcceptedNanoHostFinalInDb,
  type NanoHostAcceptedFinalCommitment,
} from './core-journal-native.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './db.js';
import { ensureLayout, readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { readRetainedNanoHostSubmission } from './nanohost-submitted-lease.js';
import { transitionAdmittedNanoHostRuntimeTarget } from './nanohost-transport-owner.js';
import { nativeProductScope } from './workspace-file-records.js';
import { readWorkspaceQueueInput } from './workspace-queue-inputs.js';

// The production factory's capture recovery stays real; the spy only observes and orders it.
vi.mock('../runtime/workspace-reconciliation-records.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../runtime/workspace-reconciliation-records.js')>();
  return { ...actual, hasPendingWorkspaceCapture: vi.fn(actual.hasPendingWorkspaceCapture) };
});

// The original live final waiter stays real unless a case stops its Core process inside it.
vi.mock('../runtime/worker-control-records.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/worker-control-records.js')>();
  return {
    ...actual,
    waitForWorkerControlFinalStatus: vi.fn(actual.waitForWorkerControlFinalStatus),
  };
});

const ATTEMPT_ID = testEntityId('attempt', 'attempt_final_readback');
const BINDING = 'lease-binding:final-readback';
const CONTROL_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const INFERENCE_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CAPABILITY_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const SEQUENCE = 8;
const DIGEST = `sha256:${'a'.repeat(64)}`;

type FinalStage = 'intake' | 'settle' | 'observe';
type FinalStageClient = {
  workerControlFinalStage(
    database: string,
    command: unknown,
    stage: { readonly kind: FinalStage }
  ): Promise<unknown>;
};

/**
 * Real Core admission, Native binding and Worker gateway for one submitted ordinary Turn.
 * The original final passes the production intake, Native FULL and Core observation stages.
 */
async function createFixture() {
  // Native storage keeps its real clock; give each fixture the same current wall-time origin.
  const now = new Date(vi.getRealSystemTime()).toISOString();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-final-readback-'));
  let coreDb = openCoreDb(dataRoot);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
  });
  applyMigrations(coreDb);
  let nativeStorage = await openAdmittedTestNanoHost(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const ownerUserId = 'usr_00000000-0000-7000-8000-000000000001';
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId });
  const turn = await store.createTurn(
    workspaceId,
    'th_00000000-0000-7000-8000-000000000001',
    'Finish one exact worker Turn',
    { kind: 'user', id: ownerUserId }
  );
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    await resolveAgentEnvironmentPackage({
      captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
      agentSetup: createTestAgentSetup(),
      agentSessionId: testEntityId('as', 'as_final_readback'),
      backend: { kind: 'openshell' },
      createdAt: new Date(Date.parse(now) - 6_000).toISOString(),
      requestId: 'req_final_readback',
      triggerActor: { kind: 'user', id: ownerUserId },
      turn,
      workspaceCwd: '/workspace/openkit',
      workspaceRoots: [],
    })
  );
  await store.createAgentSession({
    id: environmentPackage.scope.agentSessionId,
    agentId: environmentPackage.agent.agentId,
    workspaceId: workspaceIdForOwner(turn.owner),
    threadId: turn.threadId,
    status: 'busy',
    message: null,
    createdAt: now,
    updatedAt: now,
  });
  await store.updateTurn(turn.id, { agentSessionId: environmentPackage.scope.agentSessionId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceIdForOwner(turn.owner));
  applyScopedMigrations(workspaceDb);
  await recordAgentEnvironmentPackageSnapshot(workspaceDb, { createdAt: now, environmentPackage });
  workspaceDb.sqlite.close();
  const entry = await createTestQueueEntry(coreDb, {
    backendId: 'nanohost',
    now: () => now,
    profileRef: 'default',
    queueEntryId: 'queue_final_readback',
    requestId: environmentPackage.scope.requestId,
    requestedAgentId: environmentPackage.agent.agentId,
    threadId: turn.threadId,
    triggerActor: environmentPackage.scope.triggerActor,
    turnId: turn.id,
    text: 'Finish one exact worker Turn',
    workspaceId: workspaceIdForOwner(turn.owner),
  });
  submitTestNanoHostWorkerLease(
    coreDb,
    entry,
    BINDING,
    {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      workerCapabilityTokenHash: hashWorkerRouteToken(CAPABILITY_TOKEN),
      workerControlTokenHash: hashWorkerRouteToken(CONTROL_TOKEN),
      workerInferenceTokenHash: hashWorkerRouteToken(INFERENCE_TOKEN),
    },
    { attemptId: ATTEMPT_ID }
  );
  const { deploymentId } = readDataRootLayoutMarker(dataRoot);
  const { image } = environmentPackage.runtime;
  if (image.kind !== 'reference') throw new Error('Fixture package needs a reference image.');
  mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
    sqlite.prepare('UPDATE nanohost_runtime_targets SET deployment_id = ?').run(deploymentId);
    // The launched placement carries the package's own image lineage.
    sqlite
      .prepare(
        'UPDATE worker_backend_sessions SET deployment_id = ?, backend_lineage_json = ? WHERE attempt_id = ?'
      )
      .run(deploymentId, JSON.stringify({ imageRef: image.ref }), ATTEMPT_ID);
  });
  const lineage: WorkerControlLineage = {
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId,
    threadId: turn.threadId,
    turnId: turn.id,
    workspaceId: workspaceIdForOwner(turn.owner),
  };
  const original = readRetainedNanoHostSubmission(coreDb, ATTEMPT_ID);
  if (!original) throw new Error('Fixture has no original submitted grant.');
  let gateway = createDefaultWorkerControlGateway(coreDb, undefined, nativeStorage);
  return {
    get coreDb(): CoreDb {
      return coreDb;
    },
    get gateway() {
      return gateway;
    },
    dataRoot,
    now,
    environmentPackage,
    lineage,
    original,
    store,
    turnId: turn.id,
    /** Posts the Worker's exact ordinary final through the production gateway. */
    recordFinal() {
      return gateway.recordFinalStatus({
        authorization: `Bearer ${CONTROL_TOKEN}`,
        lineage,
        sequence: SEQUENCE,
        status: 'completed',
        stopReason: 'completed',
        evidenceManifestDigests: { transcript: DIGEST },
      });
    },
    /**
     * Reopens both owners in index.ts order: Core and the Native owner, the Epoch fence, then the
     * scheduler and Native restart classification. The original process state is gone.
     */
    async restart(
      input: RunNanoHostAttemptRecoveryInput,
      boot?: () => Pick<RunNanoHostAttemptRecoveryInput, 'admittedNanoHostRecovery'>
    ) {
      coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      coreDb = openCoreDb(dataRoot);
      const { path, contentMount } = nativeProductScope(dataRoot, { kind: 'server' });
      await getControlStoreWorkerClient().open({
        database: `core:${path}`,
        path,
        dataRoot,
        create: false,
        initialize: 'core',
        productOwner: { kind: 'server' },
        contentMount,
      });
      nativeStorage = await reopenAdmittedTestNanoHost(coreDb);
      const fenced = await transitionAdmittedNanoHostRuntimeTarget(nativeStorage.value, {
        kind: 'restart',
        observedAt: new Date().toISOString(),
      });
      if (fenced.state !== 'ready') throw new Error(`Fixture restart: ${fenced.reason}`);
      gateway = createDefaultWorkerControlGateway(coreDb, undefined, nativeStorage);
      // Boot classifies before listen with the reopened admitted owner when the case supplies it.
      const classified = { ...input, ...boot?.() };
      await runSchedulerRestartRecovery(coreDb, classified);
      return classifyNanoHostAttemptsAfterRestart(coreDb, classified);
    },
    /** Lays down the acknowledged fresh, fenced and ready successor Epoch of the same target. */
    readyFreshEpoch() {
      mutateAdmittedTestNanoHost(coreDb, (sqlite) =>
        sqlite
          .prepare(`UPDATE nanohost_runtime_targets SET connection_generation = connection_generation + 1,
            predecessor_fenced = 1, ready = 1, fresh_empty = 1, physical_epoch = ?`)
          .run('b'.repeat(64))
      );
    },
    session(): WorkerBackendSessionRecord {
      const session = readAdmittedTestNanoHost(coreDb, (sqlite) =>
        getWorkerBackendSession({ sqlite }, ATTEMPT_ID)
      );
      if (!session) throw new Error('Fixture backend session is absent.');
      return session;
    },
    /** The current Boot readback through the same admitted Native snapshot as production. */
    readback() {
      return readAdmittedTestNanoHost(coreDb, (sqlite) =>
        inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, ATTEMPT_ID)
      );
    },
    /** Every Core step of the original execution, so that a new observation or intake is visible. */
    finalSteps() {
      return coreDb.sqlite
        .prepare(
          'SELECT step_id AS stepId FROM control_execution_steps WHERE execution_id=? ORDER BY rowid'
        )
        .all(original.lease.grant.execution.executionId) as { stepId: string }[];
    },
    /** All Core attempts and admissions, so that a second dispatch or requeue is visible. */
    dispatchState() {
      return {
        attempts: coreDb.sqlite
          .prepare('SELECT attempt_id, phase FROM scheduler_execution_attempts ORDER BY rowid')
          .all(),
        admissions: coreDb.sqlite
          .prepare('SELECT * FROM scheduler_admission_entries ORDER BY rowid')
          .all(),
      };
    },
    exclusions() {
      return readExecutionJournalRoot(coreDb, original.lease.grant.execution).exclusionRefs;
    },
    /** One active run-bound credential for this attempt and one for an unrelated attempt. */
    seedRunCredentials() {
      const insert = coreDb.sqlite.prepare(`INSERT INTO openkit_access_tokens (token_id, token_hash,
        owner_user_id, scope, schema_version, workspace_ids_json, status, issued_at, expires_at,
        predecessor_token_id, issuer_ref_json, principal_ref_json, run_subject_json)
        VALUES (?, ?, ?, 'workspace', 1, '[]', 'active', ?, ?, NULL, ?, NULL, ?)`);
      const tokens = {
        attempt: testEntityId('tok', 'tok_final_readback_attempt'),
        unrelated: testEntityId('tok', 'tok_final_readback_unrelated'),
      };
      for (const [name, attemptId] of [
        ['attempt', ATTEMPT_ID],
        ['unrelated', testEntityId('attempt', 'attempt_final_readback_unrelated')],
      ] as const)
        insert.run(
          tokens[name],
          name.repeat(8).slice(0, 8).padEnd(64, '0'),
          ownerUserId,
          now,
          original.lease.grant.deadline,
          JSON.stringify({ kind: 'user', id: ownerUserId }),
          JSON.stringify({
            kind: 'automation',
            id: `auto_${name}`,
            responsibleUserId: ownerUserId,
            grants: [],
            lineage,
            attemptId,
            planId: `plan_${name}`,
            grantId: `grant_${name}`,
            referenceId: `reference_${name}`,
            materialVersion: 1,
            receiptId: `receipt_${name}`,
          })
        );
      return () =>
        Object.fromEntries(
          Object.entries(tokens).map(([name, tokenId]) => [
            name,
            coreDb.sqlite
              .prepare('SELECT status FROM openkit_access_tokens WHERE token_id=?')
              .pluck()
              .get(tokenId),
          ])
        );
    },
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** Crashes before the named production final stage reaches Core. */
function crashBeforeFinalStage(stage: FinalStage) {
  const client = getControlStoreWorkerClient() as unknown as FinalStageClient;
  const originalStage = client.workerControlFinalStage.bind(client);
  return vi
    .spyOn(client, 'workerControlFinalStage')
    .mockImplementation(async (database, command, input) => {
      if (input.kind !== stage) return originalStage(database, command, input);
      throw new Error(`Injected crash before ${stage}.`);
    });
}

/** Effect-only ports; any unexpected effect fails instead of fabricating authority or cleanup. */
function recoveryPorts(now: () => string) {
  const failEffect = async () => {
    throw new Error('Backend effect is unavailable in this in-process test.');
  };
  const executionBackend = {
    id: 'nanohost',
    submit: vi.fn(failEffect),
    inspect: vi.fn(failEffect),
    cancel: vi.fn(failEffect),
    release: vi.fn(failEffect),
  };
  return {
    executionBackend,
    cleanupBackendSession:
      vi.fn<RunNanoHostAttemptRecoveryInput['cleanupBackendSession']>(failEffect),
    reconcileExecutions: async () => {},
    prepareBackendCleanup: vi.fn<RunNanoHostAttemptRecoveryInput['prepareBackendCleanup']>(),
    restoreBackendSession: vi.fn(failEffect),
    projectRecoveredTurn: vi.fn(failEffect),
    now,
  } satisfies RunNanoHostAttemptRecoveryInput;
}

/** The Boot selection with the given closeout owner, and a spy on its first-cleanup entry. */
function bootSelection(fixture: Fixture, closeout: Parameters<typeof testBootNanoHostRecovery>[1]) {
  const selection = testBootNanoHostRecovery(fixture.coreDb, closeout);
  if (selection?.state !== 'ready') throw new Error('Fixture has no Boot recovery selection.');
  const cleanup = vi.spyOn(selection.value, 'cleanup');
  return { admittedNanoHostRecovery: selection, cleanup };
}

/**
 * The production lifecycle runtime over the fixture's admitted owners. Only physical contact is
 * stubbed: the restored binding, the restored plan, and the first backend call after the guarded read.
 */
function factoryRuntime(fixture: Fixture) {
  const owner = currentAdmittedTestNanoHostOwner(fixture.coreDb);
  if (!owner) throw new Error('Fixture has no admitted NanoHost owner.');
  const runtime = createConfiguredWorkerLifecycleRuntime({
    env: {},
    coreDb: fixture.coreDb,
    store: fixture.store,
    releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
    nanoHostRecovery: {
      owner: { state: 'ready', value: owner },
      releaseTerminalScopes: owner.releaseTerminalScopes,
      commitCloseout: owner.classifyRecovery,
    },
  });
  const backend = (
    runtime.turnExecutor as unknown as {
      readonly backend: {
        restoreSession(): void;
        planSession(): unknown;
        describeCapabilities(): Promise<unknown>;
      };
    }
  ).backend;
  const session = fixture.session();
  const calls: string[] = [];
  vi.spyOn(backend, 'restoreSession').mockImplementation(() => {
    calls.push('restoreSession');
  });
  vi.spyOn(backend, 'planSession').mockImplementation(() => ({
    agentSessionId: session.agentSessionId,
    backendKind: session.backendKind,
    backendSessionId: session.backendSessionId,
    deploymentId: session.deploymentId,
    packageSnapshotId: session.packageSnapshotId,
    runtimeTargetId: session.runtimeTargetId,
    stagingDirectoryRef: session.stagingDirectoryRef,
    transientProviderInstanceId: session.transientProviderInstanceId,
  }));
  vi.spyOn(backend, 'describeCapabilities').mockImplementation(async () => {
    calls.push('describeCapabilities');
    throw new Error('Restart closeout reached backend describeCapabilities.');
  });
  return { runtime, calls };
}

/** Boot maintenance holds with the recovery diagnostic, zero closeout, zero cleanup and an unchanged session. */
async function expectBootHold(fixture: Fixture, ports: ReturnType<typeof recoveryPorts>) {
  const closeout = vi.fn(async () => {});
  const boot = bootSelection(fixture, closeout);
  const session = fixture.session();
  const phase = requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID).phase;
  await expect(
    runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot })
  ).rejects.toThrow('Native attempt recovery failed.');
  expect(closeout).not.toHaveBeenCalled();
  expect(boot.cleanup).not.toHaveBeenCalled();
  expect(ports.cleanupBackendSession).not.toHaveBeenCalled();
  expect(fixture.session()).toEqual(session);
  expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID).phase).toBe(phase);
}

/** Rewrites the Native final pair consistently with both Native sequence receipts. */
function substituteNativeFinal(
  fixture: Fixture,
  change: {
    readonly sequence?: number;
    readonly digest?: string;
    readonly acceptedAt?: string;
    readonly eventAcceptedAt?: string;
  }
) {
  mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) => {
    const final = sqlite
      .prepare(
        "SELECT record_json AS recordJson, accepted_at AS acceptedAt, sequence FROM worker_control_records WHERE operation='final_status'"
      )
      .get() as { recordJson: string; acceptedAt: string; sequence: number };
    const event = sqlite
      .prepare(
        "SELECT record_json AS recordJson, accepted_at AS acceptedAt FROM worker_control_records WHERE operation='event_append' AND sequence=?"
      )
      .get(final.sequence) as { recordJson: string; acceptedAt: string };
    const {
      acceptedAt: _acceptedAt,
      sequence: _sequence,
      ...data
    } = JSON.parse(final.recordJson) as Record<string, unknown>;
    const { lineage } = JSON.parse(event.recordJson) as { lineage: WorkerControlLineage };
    const sequence = change.sequence ?? final.sequence;
    const acceptedAt = change.acceptedAt ?? final.acceptedAt;
    const terminalData = {
      ...data,
      ...(change.digest ? { evidenceManifestDigests: { transcript: change.digest } } : {}),
    } as Parameters<typeof buildWorkerCanonicalTerminalEventRecord>[0]['data'];
    const terminal = buildWorkerCanonicalTerminalEventRecord({
      data: terminalData,
      lineage,
      sequence,
    });
    sqlite
      .prepare(
        "UPDATE worker_control_records SET record_json=?, accepted_at=?, sequence=?, record_key=? WHERE operation='final_status'"
      )
      .run(
        canonicalJsonText({ ...terminalData, acceptedAt, sequence }),
        acceptedAt,
        sequence,
        String(sequence)
      );
    sqlite
      .prepare(
        "UPDATE worker_control_records SET record_json=?, accepted_at=?, sequence=?, record_key=? WHERE operation='event_append' AND sequence=?"
      )
      .run(
        canonicalJsonText(terminal),
        change.eventAcceptedAt ?? event.acceptedAt,
        sequence,
        String(sequence),
        final.sequence
      );
    const receipt = sqlite.prepare(
      'UPDATE worker_control_sequence_fingerprints SET sequence=?, fingerprint=? WHERE operation=? AND sequence=?'
    );
    receipt.run(
      sequence,
      canonicalJsonText({ ...terminalData, lineage, sequence }),
      'final_status',
      final.sequence
    );
    receipt.run(sequence, canonicalJsonText(terminal), 'event_append', final.sequence);
  });
}

/** Restores the exact original Native final pair after a substitution case. */
function restoreNativeFinal(fixture: Fixture, rows: ReturnType<typeof nativeFinalRows>) {
  mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) => {
    sqlite.prepare('DELETE FROM worker_control_records').run();
    sqlite.prepare('DELETE FROM worker_control_sequence_fingerprints').run();
    for (const [table, list] of [
      ['worker_control_records', rows.records],
      ['worker_control_sequence_fingerprints', rows.receipts],
    ] as const) {
      for (const row of list) {
        const columns = Object.keys(row);
        sqlite
          .prepare(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
          )
          .run(...columns.map((column) => row[column]));
      }
    }
  });
}

function nativeFinalRows(fixture: Fixture) {
  return readAdmittedTestNanoHost(fixture.coreDb, (sqlite) => ({
    records: sqlite.prepare('SELECT * FROM worker_control_records ORDER BY rowid').all() as Record<
      string,
      unknown
    >[],
    receipts: sqlite
      .prepare('SELECT * FROM worker_control_sequence_fingerprints ORDER BY rowid')
      .all() as Record<string, unknown>[],
  }));
}

/** Each route family of the original Worker has lost ordinary effect authority. */
function expectRoutesRevoked(fixture: Fixture) {
  for (const [tokenFamily, token] of [
    ['worker-control', CONTROL_TOKEN],
    ['inference', INFERENCE_TOKEN],
    ['capability', CAPABILITY_TOKEN],
  ] as const)
    expect(() =>
      fixture.gateway.authenticatePackageToken(`Bearer ${token}`, { tokenFamily })
    ).toThrow(WorkerControlGatewayError);
}

/** Records every backend effect; only the restored-lineage plan is answered. */
function recordingBackend(session: WorkerBackendSessionRecord) {
  const calls: string[] = [];
  const backend = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        return (..._args: unknown[]) => {
          calls.push(name);
          if (name === 'planSession')
            return {
              agentSessionId: session.agentSessionId,
              backendKind: session.backendKind,
              backendSessionId: session.backendSessionId,
              deploymentId: session.deploymentId,
              packageSnapshotId: session.packageSnapshotId,
              runtimeTargetId: session.runtimeTargetId,
              stagingDirectoryRef: session.stagingDirectoryRef,
              transientProviderInstanceId: session.transientProviderInstanceId,
            };
          throw new Error(`Restart closeout reached backend ${name}.`);
        };
      },
    }
  ) as WorkerGovernanceBackend;
  return { backend, calls };
}

/** Publishes the pending Turn and ordinary receipt that the command owner writes before dispatch. */
async function publishPendingTurn(
  store: FsStore,
  entry: Awaited<ReturnType<typeof createTestQueueEntry>>
) {
  const dataRoot = store.getDataRoot();
  if (!dataRoot) throw new Error('Fixture Store has no data root.');
  const original = readWorkspaceQueueInput(dataRoot, entry, entry.inputRef);
  if (!original) throw new Error('Fixture has no original Workspace input.');
  const createdAt = new Date().toISOString();
  const scope = {
    workspaceId: entry.workspaceId,
    threadId: entry.threadId,
    actorId:
      entry.triggerActor.kind === 'user'
        ? entry.triggerActor.id
        : entry.triggerActor.responsibleUserId!,
  };
  await store.createTurn(
    entry.workspaceId,
    entry.threadId,
    original.text,
    entry.triggerActor,
    undefined,
    {
      turnId: entry.turnId,
      status: 'pending',
      agentId: entry.requestedAgentId,
      executorKind: 'worker',
      commandReceipt: {
        key: commandRequestKey('turn.start', entry.requestId, scope),
        command: 'turn.start',
        requestId: entry.requestId,
        scope,
        inputHash: commandInputHash({ queueEntryId: entry.queueEntryId, turnInput: original.text }),
        responseKind: 'turn',
        createdAt,
        expiresAt: commandRequestExpiresAt(createdAt),
      },
    }
  );
}

/** Every Core step of the attempt's original execution, so that a new intake or observation shows. */
function executionSteps(coreDb: CoreDb, attemptId: string) {
  const original = readRetainedNanoHostSubmission(coreDb, attemptId);
  if (!original) throw new Error('Attempt has no original submitted grant.');
  return coreDb.sqlite
    .prepare('SELECT step_id FROM control_execution_steps WHERE execution_id=? ORDER BY rowid')
    .pluck()
    .all(original.lease.grant.execution.executionId) as string[];
}

/** All Core attempts and admissions, so that a second dispatch or requeue shows. */
function dispatchRows(coreDb: CoreDb) {
  return {
    attempts: coreDb.sqlite
      .prepare('SELECT attempt_id, phase FROM scheduler_execution_attempts ORDER BY rowid')
      .all(),
    admissions: coreDb.sqlite
      .prepare('SELECT * FROM scheduler_admission_entries ORDER BY rowid')
      .all(),
  };
}

describe('K8b accepted-final readback', () => {
  afterEach(() => vi.useRealTimers());

  it('W1 closes a launched Turn once through the production restart closeout from its original receipt', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-final-readback-launch-'));
    ensureLayout(dataRoot);
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const manifest = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    await admitTestNativeEnvironmentForRoot(coreDb, manifest);
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    const configuration = createInMemoryRuntimeConfigSnapshot({
      ...loadRuntimeConfig(dataRoot),
      agentManifests: [manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Resident fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    const options = { readRuntimeConfig: () => configuration };
    const waiter = vi.mocked(waitForWorkerControlFinalStatus);
    const wait = waiter.getMockImplementation();
    if (!wait) throw new Error('Final waiter spy has no original implementation.');
    const live = await createNativeTaskAdmissionFixture(coreDb, store, options);
    let cold: typeof live | undefined;
    onTestFinished(async () => {
      waiter.mockImplementation(wait);
      await cold?.restore();
      await live.restore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    });
    const attemptId = testEntityId('attempt', 'attempt_final_readback_launch');
    const agentSessionId = testEntityId('as', 'as_final_readback_launch');
    const entry = await createTestQueueEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue:${attemptId}`,
      requestId: testEntityId('tu', 'request_final_readback_launch').slice(3),
      requestedAgentId: manifest.id,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      turnId: testEntityId('tu', 'turn_final_readback_launch'),
      text: 'Finish one exact worker Turn',
      triggerActor: { kind: 'user', id: ownerUserId },
    });
    await publishPendingTurn(store, entry);
    // The original Core process stops inside its live final waiter, so it never runs its own closeout.
    waiter.mockImplementation((...args) =>
      args[1].lineage.turnId === entry.turnId ? new Promise(() => {}) : wait(...args)
    );
    await live.admitTurn(entry, {
      attemptId,
      agentSessionId,
      candidateAgentSessionId: agentSessionId,
    });
    // The Worker reports its final through the production gateway: intake, Native FULL, observation.
    live.executionFor(entry.turnId).completion.resolve();
    const original = await vi.waitFor(() => {
      const read = readAdmittedTestNanoHost(coreDb, (sqlite) =>
        inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, attemptId)
      );
      if (read.state !== 'settled') throw new Error(`Final readback is ${read.state}.`);
      return read;
    });
    const steps = executionSteps(coreDb, attemptId);
    expect(steps.slice(-2)).toEqual(['worker-final-intake', original.receipt.intent.requestId]);
    expect(store.getTurnById(entry.turnId).status).not.toBe('completed');
    const dispatch = dispatchRows(coreDb);

    // A cold Core runtime over the reopened NanoHost owner. The outside peer keeps its accepted facts.
    await live.restore();
    cold = await createNativeTaskAdmissionFixture(coreDb, store, options, live.outside);
    const { runtime } = cold;
    const executionBackend = runtime.turnExecutor.executionBackend!;
    const submit = vi.spyOn(executionBackend, 'submit');
    const closeout = vi.fn(runtime.reconcileAcceptedFinalStatus);
    const recovery: RunNanoHostAttemptRecoveryInput = {
      executionBackend,
      store,
      cleanupBackendSession: runtime.cleanupBackendSession,
      reconcileExecutions: () => runtime.executionReconciler.runOnce(),
      prepareBackendCleanup: runtime.prepareBackendCleanup,
      restoreBackendSession: runtime.restoreBackendSession,
      isTurnExecutionActive: runtime.isTurnExecutionActive,
      projectRecoveredTurn: async () => {
        throw new Error('The accepted final keeps its restart closeout owner.');
      },
      admittedNanoHostRecovery: testBootNanoHostRecovery(coreDb, closeout),
    };
    // Boot order before listen: scheduler restart recovery and Native classification, then maintenance.
    await runSchedulerRestartRecovery(coreDb, recovery);
    await classifyNanoHostAttemptsAfterRestart(coreDb, recovery);
    await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery);
    const effects = cold.effects.length;
    // A second pass finds the attempt closed and has no effect.
    await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery);

    expect(closeout).toHaveBeenCalledTimes(1);
    expect(closeout.mock.calls[0]![1]).toEqual(original);
    expect(store.getTurnById(entry.turnId)).toMatchObject({ status: 'completed' });
    expect(
      store.getTurnEvents(entry.turnId).filter((event) => event.event === 'turn.completed')
    ).toHaveLength(1);
    expect(cold.executor.releaseResults).toEqual([
      expect.objectContaining({ attemptId, state: 'released' }),
    ]);
    expect(requireSchedulerExecutionAttempt(coreDb, attemptId).phase).toBe('closed');
    expect(listOpenSchedulerExecutionAttempts(coreDb)).toEqual([]);
    expect(cold.effects).toHaveLength(effects);
    // The original intake and observation receipt stay the only ones. The closeout appends its release.
    const closed = executionSteps(coreDb, attemptId);
    expect(closed.slice(0, steps.length)).toEqual(steps);
    expect(
      closed.filter(
        (step) => step === 'worker-final-intake' || step === original.receipt.intent.requestId
      )
    ).toEqual(steps.slice(-2));
    expect(closed.filter((step) => step === 'worker-terminal-release')).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
    expect(cold.executor.launches).toBe(0);
    expect(dispatchRows(coreDb)).toEqual({
      ...dispatch,
      attempts: [{ attempt_id: attemptId, phase: 'closed' }],
    });
  });

  it('W2 holds a substituted Native proof before inspection and before the guarded closeout read', async () => {
    const fixture = await createFixture();
    await fixture.recordFinal();
    const original = fixture.readback();
    expect(original.state).toBe('settled');
    const rows = nativeFinalRows(fixture);
    const steps = fixture.finalSteps();
    const ports = recoveryPorts(() => new Date().toISOString());
    await fixture.restart(ports);
    const turn = fixture.store.getTurnById(fixture.turnId);
    const substitutions = [
      { sequence: SEQUENCE + 1 },
      { digest: `sha256:${'c'.repeat(64)}` },
      { acceptedAt: new Date(Date.parse(fixture.original.lease.grant.deadline) - 1).toISOString() },
      {
        eventAcceptedAt: new Date(
          Date.parse(fixture.original.lease.grant.deadline) - 1
        ).toISOString(),
      },
    ];

    // (a) Before inspection: Boot holds and never reaches closeout.
    for (const change of substitutions) {
      substituteNativeFinal(fixture, change);
      expect(fixture.readback()).toEqual({ state: 'held', reason: 'conflict' });
      const closeout = vi.fn(async () => {});
      const boot = bootSelection(fixture, closeout);
      await expect(
        runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot })
      ).rejects.toThrow('Native attempt recovery failed.');
      expect(closeout).not.toHaveBeenCalled();
      expect(boot.cleanup).not.toHaveBeenCalled();
      restoreNativeFinal(fixture, rows);
      expect(fixture.readback()).toEqual(original);
    }

    // (b) After a successful inspection and before closeout's guarded read.
    for (const change of substitutions) {
      const { backend, calls } = recordingBackend(fixture.session());
      const executor = new WorkerGovernanceTurnExecutor({
        backend,
        coreDb: fixture.coreDb,
        environmentBackend: { kind: 'openshell' },
      });
      const closeout = vi.fn(
        async (
          session: WorkerBackendSessionRecord,
          commitment: NanoHostAcceptedFinalCommitment
        ) => {
          expect(commitment).toEqual(original);
          substituteNativeFinal(fixture, change);
          return executor.resumeAcceptedFinalStatus(
            fixture.store,
            fixture.environmentPackage,
            session,
            commitment
          );
        }
      );
      const boot = bootSelection(fixture, closeout);
      await expect(
        runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot })
      ).rejects.toThrow('Native attempt recovery failed.');
      expect(closeout).toHaveBeenCalledTimes(1);
      await expect(closeout.mock.results[0]?.value).rejects.toThrow(
        'Restart closeout final proof changed after recovery inspection.'
      );
      // Zero collection, terminal publication and release.
      expect(calls).toEqual(['planSession']);
      expect(fixture.store.getTurnById(fixture.turnId)).toEqual(turn);
      expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID).phase).toBe('closing');
      expect(boot.cleanup).not.toHaveBeenCalled();
      restoreNativeFinal(fixture, rows);
    }

    // The unchanged commitment passes the same guarded read and reaches collection.
    const { backend, calls } = recordingBackend(fixture.session());
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: fixture.coreDb,
      environmentBackend: { kind: 'openshell' },
    });
    await expect(
      executor.resumeAcceptedFinalStatus(
        fixture.store,
        fixture.environmentPackage,
        fixture.session(),
        original as NanoHostAcceptedFinalCommitment
      )
    ).rejects.toThrow('Restart closeout reached backend describeCapabilities.');
    expect(calls).toEqual(['planSession', 'describeCapabilities']);
    expect(fixture.finalSteps()).toEqual(steps);
    expect(ports.executionBackend.submit).not.toHaveBeenCalled();
    expect(ports.cleanupBackendSession).not.toHaveBeenCalled();
  });

  it('W3 leaves a Native-only final at the original deadline through classification, the closing ACK and the first-cleanup hold', async () => {
    const fixture = await createFixture();
    const credentials = fixture.seedRunCredentials();
    expect(credentials()).toEqual({ attempt: 'active', unrelated: 'active' });
    const crash = crashBeforeFinalStage('observe');
    await expect(fixture.recordFinal()).rejects.toThrow('Injected crash before observe.');
    crash.mockRestore();
    const steps = fixture.finalSteps();
    expect(steps.map(({ stepId }) => stepId)).toEqual([
      'worker-route-fixture-submit',
      'worker-final-intake',
    ]);
    const native = fixture.readback();
    expect(native).toMatchObject({ state: 'native-only', sequence: SEQUENCE, receipt: null });
    const exclusions = fixture.exclusions();
    const dispatch = fixture.dispatchState();
    const { deadline } = fixture.original.lease.grant;
    let clock = new Date(Date.parse(deadline) - 1).toISOString();
    const ports = recoveryPorts(() => clock);
    const closeout = vi.fn(async () => {});
    let boot!: ReturnType<typeof bootSelection>;
    let close!: MockInstance<AdmittedNanoHostAttemptRecovery['close']>;
    // Pre-listen classification runs with the reopened admitted owner, as Boot does.
    await fixture.restart(ports, () => {
      boot = bootSelection(fixture, closeout);
      close = vi.spyOn(boot.admittedNanoHostRecovery.value, 'close');
      return boot;
    });
    expect(close.mock.calls.map(([input]) => input.cause)).toEqual(['restart-native-recovery']);
    fixture.readyFreshEpoch();

    // No Worker returns. Before the original absolute deadline the Native-only final waits.
    await runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot });
    expect(boot.cleanup).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    const waiting = fixture.session();

    // The first pass at the deadline sends the closing ACK, keeps the first cause, then first cleanup.
    clock = deadline;
    await expect(
      runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot })
    ).rejects.toThrow('Native attempt recovery failed.');
    expect(close).toHaveBeenCalledTimes(2);
    expect(close.mock.calls[1]?.[0]).toMatchObject({
      cause: 'native-liveness-expired',
      session: waiting,
      lease: readRetainedNanoHostSubmission(fixture.coreDb, ATTEMPT_ID)?.lease,
    });
    await expect(close.mock.results[1]?.value).resolves.toMatchObject({
      state: 'ready',
      value: { phase: 'closing', terminalCause: 'worker-final-status', fenceRef: null },
    });
    expect(boot.cleanup).toHaveBeenCalledTimes(1);
    expect(close.mock.invocationCallOrder[1]).toBeLessThan(
      boot.cleanup.mock.invocationCallOrder[0] ?? 0
    );
    expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)).toMatchObject({
      phase: 'closing',
      terminalCause: 'worker-final-status',
      fenceRef: null,
    });
    // The run-bound credential of this attempt is durably revoked; an unrelated one stays active.
    expect(credentials()).toEqual({ attempt: 'revoked', unrelated: 'active' });
    expectRoutesRevoked(fixture);
    expect(boot.cleanup.mock.calls[0]?.[2]).toEqual(
      readRetainedNanoHostSubmission(fixture.coreDb, ATTEMPT_ID)?.lease
    );
    await expect(boot.cleanup.mock.results[0]?.value).resolves.toEqual({
      state: 'unavailable',
      owner: 'nanohost',
      reason: 'recovery-required',
    });
    expect(closeout).not.toHaveBeenCalled();
    expect(ports.cleanupBackendSession).not.toHaveBeenCalled();
    expect(ports.executionBackend.submit).not.toHaveBeenCalled();
    expect(fixture.finalSteps()).toEqual(steps);
    expect(fixture.readback()).toEqual(native);
    expect(fixture.dispatchState()).toEqual(dispatch);
    expect(fixture.exclusions()).toEqual(exclusions);
  });

  it('W4 holds a second terminal event at the original sequence under another record key', async () => {
    const fixture = await createFixture();
    await fixture.recordFinal();
    expect(fixture.readback().state).toBe('settled');
    const ports = recoveryPorts(() => new Date().toISOString());
    await fixture.restart(ports);
    mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      sqlite
        .prepare(`INSERT INTO worker_control_records (workspace_id, thread_id, turn_id,
          agent_session_id, package_snapshot_id, request_id, operation, record_key, sequence,
          record_json, accepted_at, schema_version)
          SELECT workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id, request_id,
            operation, 'duplicate', sequence, record_json, accepted_at, schema_version
          FROM worker_control_records WHERE operation='event_append' AND sequence=?`)
        .run(SEQUENCE)
    );
    expect(fixture.readback()).toEqual({ state: 'held', reason: 'duplicate' });
    await expectBootHold(fixture, ports);
  });

  it('W5 holds a Native sequence receipt that carries another request', async () => {
    const fixture = await createFixture();
    await fixture.recordFinal();
    expect(fixture.readback().state).toBe('settled');
    const ports = recoveryPorts(() => new Date().toISOString());
    await fixture.restart(ports);
    mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      sqlite
        .prepare(`UPDATE worker_control_sequence_fingerprints SET request_id='req_other_request'
          WHERE operation='event_append' AND sequence=?`)
        .run(SEQUENCE)
    );
    expect(fixture.readback()).toEqual({ state: 'held', reason: 'conflict' });
    await expectBootHold(fixture, ports);
  });

  it('W6 Boot inspection reads both Native sequence receipts in one snapshot', async () => {
    const fixture = await createFixture();
    await fixture.recordFinal();
    const rows = nativeFinalRows(fixture);
    const eventReceipt = rows.receipts.find((row) => row.operation === 'event_append')?.fingerprint;
    const setReceipt = (sqlite: Database.Database, operation: string, fingerprint: unknown) =>
      sqlite
        .prepare(
          'UPDATE worker_control_sequence_fingerprints SET fingerprint=? WHERE operation=? AND sequence=?'
        )
        .run(fingerprint, operation, SEQUENCE);
    // The first committed state: only the final receipt matches.
    mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      setReceipt(sqlite, 'event_append', '{}')
    );
    expect(fixture.readback()).toEqual({ state: 'held', reason: 'conflict' });
    const closeout = vi.fn(async () => {});
    const { admittedNanoHostRecovery } = bootSelection(fixture, closeout);
    let swapped = false;
    const reader = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) => sqlite);
    const prepare = reader.prepare.bind(reader);
    let checks = 0;
    const spy = vi.spyOn(reader, 'prepare').mockImplementation(((query: string) => {
      // Between the two receipt reads, a second connection commits the swapped state.
      if (
        query.includes('SELECT fingerprint') &&
        query.includes('worker_control_sequence_fingerprints') &&
        ++checks === 2
      ) {
        mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) => {
          setReceipt(sqlite, 'event_append', eventReceipt);
          setReceipt(sqlite, 'final_status', '{}');
        });
        swapped = true;
      }
      return prepare(query);
    }) as typeof reader.prepare);
    try {
      await expect(
        admittedNanoHostRecovery.value.reconcileFinal(fixture.original.lease, fixture.session(), {
          acceptedAt: fixture.now,
          status: 'completed',
          stopReason: 'completed',
        })
      ).rejects.toThrow('Control product transition precondition failed.');
    } finally {
      spy.mockRestore();
    }
    expect(swapped).toBe(true);
    // The second committed state alone also holds; no single snapshot ever matched.
    expect(fixture.readback()).toEqual({ state: 'held', reason: 'conflict' });
    expect(closeout).not.toHaveBeenCalled();
  });

  it('W7 holds a missing Native final record whose final receipt survives, and keeps expiry for a proved absence', async () => {
    const fixture = await createFixture();
    await fixture.recordFinal();
    expect(fixture.readback().state).toBe('settled');
    const ports = recoveryPorts(() => new Date().toISOString());
    await fixture.restart(ports);
    fixture.readyFreshEpoch();
    mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      sqlite.prepare("DELETE FROM worker_control_records WHERE operation='final_status'").run()
    );
    expect(fixture.readback()).toEqual({ state: 'held', reason: 'missing' });
    await expectBootHold(fixture, ports);

    // A crash before Native FULL leaves the Core intake and no Native final: the expiry path stays.
    const absent = await createFixture();
    const crash = crashBeforeFinalStage('settle');
    await expect(absent.recordFinal()).rejects.toThrow('Injected crash before settle.');
    crash.mockRestore();
    expect(absent.finalSteps().map(({ stepId }) => stepId)).toEqual([
      'worker-route-fixture-submit',
      'worker-final-intake',
    ]);
    let clock = new Date(Date.parse(absent.original.lease.grant.deadline) - 1).toISOString();
    const absentPorts = recoveryPorts(() => clock);
    await absent.restart(absentPorts);
    absent.readyFreshEpoch();
    clock = absent.original.lease.grant.deadline;
    const boot = bootSelection(
      absent,
      vi.fn(async () => {})
    );
    await expect(
      runNanoHostAttemptRecoveryMaintenance(absent.coreDb, { ...absentPorts, ...boot })
    ).rejects.toThrow('Native attempt recovery failed.');
    expect(boot.cleanup).toHaveBeenCalledTimes(1);
  });

  it('W8 holds an absent receipt when the original execution history has a gap', async () => {
    const fixture = await createFixture();
    await fixture.recordFinal();
    const settled = fixture.readback();
    if (settled.state !== 'settled') throw new Error('Fixture has no settled readback.');
    const { revision } = readExecutionJournalRoot(
      fixture.coreDb,
      fixture.original.lease.grant.execution
    );
    fixture.coreDb.sqlite
      .prepare('DELETE FROM control_execution_steps WHERE step_id=?')
      .run(settled.receipt.intent.requestId);
    expect(
      readExecutionJournalRoot(fixture.coreDb, fixture.original.lease.grant.execution).revision
    ).toBe(revision);
    expect(fixture.readback()).toEqual({ state: 'held', reason: 'unknown' });
    const { deadline } = fixture.original.lease.grant;
    let clock = new Date(Date.parse(deadline) - 1).toISOString();
    const ports = recoveryPorts(() => clock);
    await fixture.restart(ports);
    fixture.readyFreshEpoch();
    clock = deadline;
    await expectBootHold(fixture, ports);
  });

  it('W9 holds a changed Native deployment before inspection and a changed origin Epoch at the guarded read', async () => {
    const fixture = await createFixture();
    await fixture.recordFinal();
    const original = fixture.readback();
    if (original.state !== 'settled') throw new Error('Fixture has no settled readback.');
    const ports = recoveryPorts(() => new Date().toISOString());
    await fixture.restart(ports);
    // A successor target Epoch still reads back the original session.
    fixture.readyFreshEpoch();
    expect(fixture.readback()).toEqual(original);
    const session = fixture.session();
    const setSession = (column: string, value: string) =>
      mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
        sqlite
          .prepare(`UPDATE worker_backend_sessions SET ${column}=? WHERE attempt_id=?`)
          .run(value, ATTEMPT_ID)
      );

    // (a) Before inspection: another deployment would select another receipt key.
    setSession('deployment_id', '00000000-0000-4000-8000-000000000009');
    expect(fixture.readback()).toEqual({ state: 'held', reason: 'conflict' });
    await expectBootHold(fixture, ports);
    setSession('deployment_id', session.deploymentId);
    expect(fixture.readback()).toEqual(original);

    // (b) After a good inspection: the guarded read compares the original physical session.
    const { backend, calls } = recordingBackend(session);
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: fixture.coreDb,
      environmentBackend: { kind: 'openshell' },
    });
    setSession('origin_physical_epoch', 'f'.repeat(64));
    await expect(
      executor.resumeAcceptedFinalStatus(
        fixture.store,
        fixture.environmentPackage,
        session,
        original
      )
    ).rejects.toThrow('Restart closeout final proof changed after recovery inspection.');
    expect(calls).toEqual(['planSession']);
    expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID).phase).toBe('closing');
  });

  it('W10 keeps one restart closeout when two recovery passes reach the same settled final', async () => {
    const fixture = await createFixture();
    await fixture.recordFinal();
    const original = fixture.readback();
    if (original.state !== 'settled') throw new Error('Fixture has no settled readback.');
    const ports = recoveryPorts(() => new Date().toISOString());
    await fixture.restart(ports);
    const { runtime, calls } = factoryRuntime(fixture);
    const boot = bootSelection(fixture, runtime.reconcileAcceptedFinalStatus);
    const input = { ...ports, ...boot, isTurnExecutionActive: runtime.isTurnExecutionActive };
    const capture = vi.mocked(hasPendingWorkspaceCapture);
    const actual = capture.getMockImplementation();
    if (!actual) throw new Error('Capture spy has no original implementation.');
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captures = 0;
    // Call 1 is the first pass's own capture census; call 2 is its claimed factory closeout.
    capture.mockImplementation(async (...args) => {
      captures += 1;
      if (captures === 2) {
        entered();
        await gate;
      }
      return actual(...args);
    });
    try {
      // Settled at once, so an early failure of this case leaves no unhandled pass.
      const first = runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, input).then(
        () => undefined,
        (error: unknown) => error
      );
      await paused;
      expect(runtime.isTurnExecutionActive(fixture.turnId)).toBe(true);
      // The final-ACK wake and periodic maintenance are separate entries. The second pass cannot enter.
      await runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, input);
      // A direct second closeout of the same Turn is refused by the claim itself.
      await expect(
        runtime.reconcileAcceptedFinalStatus(fixture.session(), original)
      ).rejects.toThrow('Restart closeout already has a live owner for this Turn.');
      release();
      // The one claimed closeout goes on past the guarded read to the first launch record. This
      // fixture has none, so the pass holds with that single cause.
      const failure = await first;
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
        'Error: Worker Turn requires exactly one admitted execution.',
      ]);
    } finally {
      release();
      capture.mockImplementation(actual);
    }
    // The first pass's census, its claimed closeout, and the second pass's census only.
    expect(captures).toBe(3);
    expect(calls).toEqual([]);
    expect(runtime.isTurnExecutionActive(fixture.turnId)).toBe(false);
    expect(ports.executionBackend.submit).not.toHaveBeenCalled();
  });

  it('W11 checks the commitment in the factory before Workspace capture recovery', async () => {
    const fixture = await createFixture();
    await fixture.recordFinal();
    const original = fixture.readback();
    if (original.state !== 'settled') throw new Error('Fixture has no settled readback.');
    const ports = recoveryPorts(() => new Date().toISOString());
    await fixture.restart(ports);
    const { runtime, calls } = factoryRuntime(fixture);
    const capture = vi.mocked(hasPendingWorkspaceCapture);
    capture.mockClear();
    const turn = fixture.store.getTurnById(fixture.turnId);
    // After a good inspection, the Native final changes before the factory reaches capture recovery.
    substituteNativeFinal(fixture, { sequence: SEQUENCE + 1 });
    await expect(runtime.reconcileAcceptedFinalStatus(fixture.session(), original)).rejects.toThrow(
      'Restart closeout final proof changed after recovery inspection.'
    );
    expect(capture).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(fixture.store.getTurnById(fixture.turnId)).toEqual(turn);
    expect(runtime.isTurnExecutionActive(fixture.turnId)).toBe(false);
    expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID).phase).toBe('closing');
  });
});
