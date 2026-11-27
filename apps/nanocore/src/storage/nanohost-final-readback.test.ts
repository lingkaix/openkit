import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
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
import { commandRequestExpiresAt, commandRequestKey, FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  listOpenSchedulerExecutionAttempts,
  requireSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import { markSchedulerExecutionAttemptClosing } from '../runtime/execution-attempts.js';
import { readExecutionJournalRoot } from '../runtime/execution-journal.js';
import {
  type AdmittedNanoHostAttemptRecovery,
  classifyNanoHostAttemptsAfterRestart,
  type RunNanoHostAttemptRecoveryInput,
  runNanoHostAttemptRecoveryMaintenance,
} from '../runtime/nanohost-attempt-recovery.js';
import { nanoHostSandboxIdFromBackendSessionId } from '../runtime/nanohost-effect-identity.js';
import {
  getNanoHostRuntimeTarget,
  NanoHostHarnessOutageError,
} from '../runtime/nanohost-runtime-target-records.js';
import { runSchedulerRestartRecovery } from '../runtime/scheduler-restart-recovery.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import {
  getWorkerBackendSession,
  type WorkerBackendSessionRecord,
} from '../runtime/worker-backend-session-records.js';
import {
  hashWorkerRouteToken,
  WorkerControlGateway,
  WorkerControlGatewayError,
  type WorkerControlGatewayOptions,
  type WorkerControlLineage,
} from '../runtime/worker-control-gateway.js';
import { waitForWorkerControlFinalStatus } from '../runtime/worker-control-records.js';
import type { WorkerGovernanceBackend } from '../runtime/worker-governance-backend.js';
import {
  prepareWorkerTurnJournalIntents,
  WorkerGovernanceTurnExecutor,
} from '../runtime/worker-governance-turn-executor.js';
import { workerStorageScopeDigest } from '../runtime/worker-storage-bindings.js';
import { terminalizeGovernedWorkerTurn } from '../runtime/worker-turn-failure.js';
import { publishWorkspaceCapture } from '../runtime/workspace-capture-publication.js';
import {
  hasPendingWorkspaceCapture,
  listWorkspaceReconciliationRecords,
} from '../runtime/workspace-reconciliation-records.js';
import {
  preserveRawWorkspaceCapture,
  readWorkspaceSnapshotCursor,
} from '../runtime/workspace-snapshot-chain.js';
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
import { FileStorageAdmission } from './artifacts/file-admission.js';
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
import { readNanoHostRecoveryLease } from './nanohost-recovery-native.js';
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
type AdmittedTestOwner = NonNullable<ReturnType<typeof currentAdmittedTestNanoHostOwner>>;
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
    {
      attemptId: ATTEMPT_ID,
      placementDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
    }
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

/** Pauses the authenticated aborted final after its first clocks are sampled, before any post. */
async function pauseCancellationFinal(fixture: Fixture, loseReply = false) {
  const { attempt } = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
    readNanoHostRecoveryLease(sqlite, fixture.original.lease)
  );
  const { startupDeadline: livenessDeadline } = attempt;
  await markSchedulerExecutionAttemptClosing(fixture.coreDb, {
    attemptId: ATTEMPT_ID,
    cause: 'turn-cancelled',
    now: () => fixture.now,
  });
  const entered =
    Promise.withResolvers<
      () => ReturnType<NonNullable<WorkerControlGatewayOptions['publishFinalStatus']>>
    >();
  const publish = Promise.withResolvers<void>();
  const gateway = fixture.gateway as unknown as {
    publishFinalStatus: NonNullable<WorkerControlGatewayOptions['publishFinalStatus']>;
  };
  const original = gateway.publishFinalStatus.bind(gateway);
  const spy = vi.spyOn(gateway, 'publishFinalStatus').mockImplementation(async (command) => {
    entered.resolve(() => original(command));
    await publish.promise;
    const ack = await original(command);
    if (loseReply) throw new Error('Injected loss of the Worker final reply.');
    return ack;
  });
  vi.setSystemTime(Date.parse(livenessDeadline) - 1);
  const reply = fixture.gateway.recordFinalStatus({
    authorization: `Bearer ${CONTROL_TOKEN}`,
    lineage: fixture.lineage,
    sequence: SEQUENCE,
    status: 'cancelled',
    stopReason: 'aborted',
  });
  const restore = async () => {
    publish.resolve();
    await reply.catch(() => undefined);
    spy.mockRestore();
  };
  try {
    const replay = await Promise.race([
      entered.promise,
      reply.then(() => {
        throw new Error('The fixture final did not reach the original publisher.');
      }),
    ]);
    return { livenessDeadline, release: publish.resolve, reply, replay, restore };
  } catch (error) {
    await restore();
    throw error;
  }
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
  fixture: Pick<Fixture, 'coreDb'>,
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
function restoreNativeFinal(
  fixture: Pick<Fixture, 'coreDb'>,
  rows: ReturnType<typeof nativeFinalRows>
) {
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

function nativeFinalRows(fixture: Pick<Fixture, 'coreDb'>) {
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

/**
 * Admits one real Worker Turn through the configured factory. The original Core process stops inside
 * its live final waiter, so it never runs its own closeout.
 */
async function admitLaunchedTurn() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-final-readback-launch-'));
  ensureLayout(dataRoot);
  const owned: {
    coreDb: CoreDb;
    cold?: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>>;
  } = { coreDb: openCoreDb(dataRoot) };
  const { coreDb } = owned;
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
  // The Worker retries an ambiguous final failure with the exact same envelope.
  const options = { readRuntimeConfig: () => configuration, retryAmbiguousFinal: true };
  const waiter = vi.mocked(waitForWorkerControlFinalStatus);
  const wait = waiter.getMockImplementation();
  if (!wait) throw new Error('Final waiter spy has no original implementation.');
  const live = await createNativeTaskAdmissionFixture(coreDb, store, options);
  onTestFinished(async () => {
    waiter.mockImplementation(wait);
    await owned.cold?.restore();
    await live.restore();
    await shutdownControlStoreWorkerClient();
    if (owned.coreDb.sqlite.open) owned.coreDb.sqlite.close();
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
  return { dataRoot, owned, store, options, live, entry, attemptId };
}

/**
 * Parks the Worker's second final delivery (its exact retry) until the case hands it a reopened
 * Core gateway. The first delivery passes the original gateway.
 */
function parkWorkerFinalRetry() {
  const record = WorkerControlGateway.prototype.recordFinalStatus;
  const parked = Promise.withResolvers<void>();
  const reopened = Promise.withResolvers<WorkerControlGateway>();
  const delivered = Promise.withResolvers<Awaited<ReturnType<typeof record>>>();
  let deliveries = 0;
  const spy = vi
    .spyOn(WorkerControlGateway.prototype, 'recordFinalStatus')
    .mockImplementation(async function (this: WorkerControlGateway, final) {
      deliveries += 1;
      if (deliveries === 1) return record.call(this, final);
      parked.resolve();
      const answer = record.call(await reopened.promise, final);
      answer.then(delivered.resolve, delivered.reject);
      return answer;
    });
  onTestFinished(() => spy.mockRestore());
  return {
    parked: parked.promise,
    /** Delivers the parked retry through the given gateway and returns its reply. */
    deliver(gateway: WorkerControlGateway) {
      reopened.resolve(gateway);
      return delivered.promise;
    },
  };
}

/**
 * Launches one real Worker Turn through the configured factory. The original Core process stops inside
 * its live final waiter, so it never runs its own closeout. The Worker's final passes the production
 * gateway: intake, Native FULL, then the deciding observation. With `loseObservationAck`, that
 * observation commits and its reply is lost; the Worker retries the exact envelope. With `parkRetry`,
 * that retry waits until the case delivers it through a reopened Core gateway.
 */
async function launchSettledTurn(input: {
  readonly loseObservationAck: boolean;
  readonly parkRetry?: boolean;
}) {
  const turn = await admitLaunchedTurn();
  const { attemptId, entry, live, owned, store } = turn;
  const { coreDb } = owned;
  // The Worker reports its final through the production gateway: intake, Native FULL, observation.
  const client = getControlStoreWorkerClient() as unknown as FinalStageClient;
  const post = client.workerControlFinalStage.bind(client);
  let observations = 0;
  let finalCommand: unknown;
  const observe = vi
    .spyOn(client, 'workerControlFinalStage')
    .mockImplementation(async (database, command, stage) => {
      finalCommand ??= structuredClone(command);
      const result = await post(database, command, stage);
      if (stage.kind !== 'observe') return result;
      observations += 1;
      if (!input.loseObservationAck || observations > 1) return result;
      throw new Error('Injected loss of the committed observation reply.');
    });
  const retry = input.parkRetry ? parkWorkerFinalRetry() : undefined;
  live.executionFor(entry.turnId).completion.resolve();
  const original = await vi.waitFor(() => {
    const read = readAdmittedTestNanoHost(coreDb, (sqlite) =>
      inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, attemptId)
    );
    if (read.state !== 'settled') throw new Error(`Final readback is ${read.state}.`);
    return read;
  });
  if (retry) {
    // The exact retry is parked before it reaches the gateway; only the lost observation committed.
    await retry.parked;
    expect(observations).toBe(1);
  } else {
    // After a lost reply, the Worker's exact retry replays the committed observation and is accepted.
    await vi.waitFor(() => expect(observations).toBe(input.loseObservationAck ? 2 : 1));
  }
  observe.mockRestore();
  const steps = executionSteps(coreDb, attemptId);
  expect(steps.slice(-2)).toEqual(['worker-final-intake', original.receipt.intent.requestId]);
  expect(store.getTurnById(entry.turnId).status).not.toBe('completed');
  return {
    ...turn,
    original,
    steps,
    dispatch: dispatchRows(coreDb),
    /** The Worker's exact final command, as the production owner received it. */
    finalCommand: finalCommand as Parameters<AdmittedTestOwner['workerControlFinalStatus']>[0],
    retry,
  };
}

/**
 * Launches one real Worker Turn whose Core observation never commits: the Worker's final passes
 * intake and Native FULL, then each delivery stops before the observation. The case restores the
 * stop after the original Core process is gone.
 */
async function launchNativeOnlyTurn() {
  const turn = await admitLaunchedTurn();
  const { attemptId, entry, live, owned } = turn;
  const { coreDb } = owned;
  const stopped = crashBeforeFinalStage('observe');
  live.executionFor(entry.turnId).completion.resolve();
  const native = await vi.waitFor(() => {
    const read = readAdmittedTestNanoHost(coreDb, (sqlite) =>
      inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, attemptId)
    );
    if (read.state !== 'native-only') throw new Error(`Final readback is ${read.state}.`);
    return read;
  });
  const steps = executionSteps(coreDb, attemptId);
  expect(steps.at(-1)).toBe('worker-final-intake');
  return { ...turn, native, steps, stopped };
}

type SettledLaunch = Awaited<ReturnType<typeof launchSettledTurn>>;

/** A cold Core runtime over the current owners. The Boot binding hands off to its factory closeout. */
async function coldRestartRecovery(
  launch: Pick<SettledLaunch, 'owned' | 'store' | 'options' | 'live'>
) {
  const { coreDb } = launch.owned;
  const cold = await createNativeTaskAdmissionFixture(
    coreDb,
    launch.store,
    launch.options,
    launch.live.outside
  );
  launch.owned.cold = cold;
  const { runtime } = cold;
  const executionBackend = runtime.turnExecutor.executionBackend!;
  const submit = vi.spyOn(executionBackend, 'submit');
  const closeout = vi.fn(runtime.reconcileAcceptedFinalStatus);
  const recovery: RunNanoHostAttemptRecoveryInput = {
    executionBackend,
    store: launch.store,
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
  return { cold, submit, closeout, recovery };
}

/**
 * Core restarts: both owners reopen, and Boot fences the RuntimeTarget before it serves (index.ts).
 * With `offline`, the original peer's poller stays disconnected until the case restores it.
 */
async function restartWithFencedTarget(
  launch: SettledLaunch,
  input: { readonly offline: boolean }
) {
  await launch.live.restore();
  launch.owned.coreDb.sqlite.close();
  await shutdownControlStoreWorkerClient();
  const coreDb = openCoreDb(launch.dataRoot);
  launch.owned.coreDb = coreDb;
  const { path, contentMount } = nativeProductScope(launch.dataRoot, { kind: 'server' });
  await getControlStoreWorkerClient().open({
    database: `core:${path}`,
    path,
    dataRoot: launch.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: { kind: 'server' },
    contentMount,
  });
  const binding = launch.live.outside.integrationBindingRef;
  expect(binding).toBeTruthy();
  if (input.offline) launch.live.outside.integrationBindingRef = undefined;
  const restarted = await coldRestartRecovery(launch);
  const native = await reopenAdmittedTestNanoHost(coreDb);
  const fence = await transitionAdmittedNanoHostRuntimeTarget(native.value, {
    kind: 'restart',
    observedAt: new Date().toISOString(),
  });
  expect(fence.state).toBe('ready');
  // Boot order before listen: scheduler restart recovery and Native classification, then maintenance.
  await runSchedulerRestartRecovery(coreDb, restarted.recovery);
  await classifyNanoHostAttemptsAfterRestart(coreDb, restarted.recovery);
  return {
    ...restarted,
    coreDb,
    native,
    /** The original peer's poller connects again. */
    reconnect: () => {
      launch.live.outside.integrationBindingRef = binding;
    },
  };
}

/** The original peer is readmitted with its same physical Epoch on a new connection generation. */
async function readmitOriginalPeer(
  coreDb: CoreDb,
  native: Awaited<ReturnType<typeof reopenAdmittedTestNanoHost>>,
  attemptId: string
) {
  const session = readAdmittedTestNanoHost(coreDb, (sqlite) =>
    getWorkerBackendSession({ sqlite }, attemptId)
  )!;
  const target = readAdmittedTestNanoHost(coreDb, (sqlite) =>
    getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId)
  )!;
  const coordinates = {
    targetId: target.targetId,
    identityId: target.identityId,
    deploymentId: target.deploymentId,
  };
  const allocated = await transitionAdmittedNanoHostRuntimeTarget(native.value, {
    kind: 'allocate',
    ...coordinates,
    observedAt: new Date().toISOString(),
  });
  if (allocated.state !== 'ready' || !allocated.value)
    throw new Error('The readmitted peer has no connection generation.');
  const readmitted = await transitionAdmittedNanoHostRuntimeTarget(native.value, {
    kind: 'ready',
    ...coordinates,
    connectionGeneration: allocated.value.connectionGeneration,
    physicalEpoch: session.originPhysicalEpoch,
    ready: true,
    predecessorFenced: true,
    freshEmpty: true,
    observedAt: new Date().toISOString(),
  });
  expect(readmitted.state).toBe('ready');
}

/** The Turn keeps its last durable state: no terminal event, release, step or attempt change. */
function expectDurableTurn(
  launch: SettledLaunch,
  coreDb: CoreDb,
  cold: Awaited<ReturnType<typeof coldRestartRecovery>>['cold'],
  durable: { readonly turn: unknown; readonly phase: string }
) {
  expect(launch.store.getTurnById(launch.entry.turnId)).toEqual(durable.turn);
  expect(
    launch.store
      .getTurnEvents(launch.entry.turnId)
      .filter((event) => event.event === 'turn.completed' || event.event === 'turn.interrupted')
  ).toEqual([]);
  expect(requireSchedulerExecutionAttempt(coreDb, launch.attemptId).phase).toBe(durable.phase);
  expect(executionSteps(coreDb, launch.attemptId)).toEqual(launch.steps);
  expect(cold.executor.releaseResults).toEqual([]);
}

/**
 * The readmitted peer finishes the Turn once through the original receipt: one completion, one
 * release, zero redispatch. A second pass finds the attempt closed and has no effect.
 */
async function expectCompletedOnce(
  launch: SettledLaunch,
  coreDb: CoreDb,
  restarted: Awaited<ReturnType<typeof coldRestartRecovery>>
) {
  const { attemptId, dispatch, entry, original, steps, store } = launch;
  const { cold, closeout, recovery, submit } = restarted;
  const effects = cold.effects.length;
  await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery);
  expect(closeout.mock.calls.map((call) => call[1])).toEqual(
    closeout.mock.calls.map(() => original)
  );
  expect(store.getTurnById(entry.turnId)).toMatchObject({ status: 'completed' });
  expect(
    store.getTurnEvents(entry.turnId).filter((event) => event.event === 'turn.completed')
  ).toHaveLength(1);
  expect(
    store.getTurnEvents(entry.turnId).filter((event) => event.event === 'turn.interrupted')
  ).toEqual([]);
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
}

/** Each error in a rejection's cause chain, flattened through aggregate errors. */
function causeChain(error: unknown): unknown[] {
  if (error instanceof AggregateError) return [error, ...error.errors.flatMap(causeChain)];
  if (error instanceof Error && error.cause !== undefined)
    return [error, ...causeChain(error.cause)];
  return [error];
}

/**
 * Records the delay of each Harness operation budget armed while it is installed. With `shorten`,
 * each such budget runs after 350 ms, so a queued inspection cannot stay hidden behind the real budget.
 */
function recordHarnessBudgets(input: { readonly shorten: boolean }) {
  const timeout = globalThis.setTimeout;
  const armed: number[] = [];
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (!new Error().stack?.includes('armHarnessOperationTimeout'))
      return timeout(callback, delay, ...args);
    armed.push(delay ?? 0);
    return timeout(callback, input.shorten ? 350 : delay, ...args);
  }) as typeof setTimeout);
  return { armed, restore: () => spy.mockRestore() };
}

/** Stages one real pending turn-end Workspace capture source for the launched Turn. */
async function stagePendingTurnEndCapture(
  launch: Pick<SettledLaunch, 'attemptId' | 'dataRoot' | 'owned' | 'store'>
) {
  const { coreDb } = launch.owned;
  const session = readAdmittedTestNanoHost(coreDb, (sqlite) =>
    getWorkerBackendSession({ sqlite }, launch.attemptId)
  )!;
  const retained = launch.store.getAgentSession(session.agentSessionId).retainedStorage;
  if (!retained?.attachmentGeneration)
    throw new Error('The launched Turn has no retained storage.');
  const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
  const collectionId = `turn-end-${digest(session.packageSnapshotId)}`;
  const bytes = Buffer.from('pending turn-end capture');
  const staging = join(launch.dataRoot, 'server/runtime/k8b-capture-staging');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'complete'), bytes);
  const head = (tree: string, manifest: string) => ({
    tree: tree.repeat(40),
    manifest: manifest.repeat(40),
  });
  const workspace = openWorkspaceDb(launch.dataRoot, session.workspaceId);
  const cursor = (() => {
    try {
      return readWorkspaceSnapshotCursor(workspace, {
        workspaceId: session.workspaceId,
        storageRef: retained.storageRef,
        workSlot: retained.workSlotRef,
      });
    } finally {
      workspace.sqlite.close();
    }
  })();
  const preserved = await preserveRawWorkspaceCapture({
    dataRoot: launch.dataRoot,
    identity: {
      workspaceId: session.workspaceId,
      threadId: session.threadId,
      turnId: session.turnId,
      agentSessionId: session.agentSessionId,
      packageSnapshotId: session.packageSnapshotId,
      storageRef: retained.storageRef,
      workSlot: retained.workSlotRef,
      attachmentGeneration: retained.attachmentGeneration,
      scopeDigest: workerStorageScopeDigest(session.workspaceId),
      sandboxId: nanoHostSandboxIdFromBackendSessionId(session.backendSessionId),
      collectionId,
    },
    staged: { bytes, path: join(staging, 'complete') },
    admission: new FileStorageAdmission(launch.dataRoot, () => 0n),
    result: {
      outcome: 'candidate',
      sha256: `sha256:${digest(bytes)}`,
      byteLength: bytes.length,
      head: head('1', '2'),
      previousHead: cursor?.head ?? head('3', '4'),
      acceptedBase: cursor?.acceptedBase ?? head('3', '4'),
      unstable: false,
    },
  });
  const source = join(
    launch.dataRoot,
    'workspaces',
    session.workspaceId,
    'evidence/backend/workspace-capture',
    collectionId,
    'complete'
  );
  const records = () => {
    const db = openWorkspaceDb(launch.dataRoot, session.workspaceId);
    try {
      return listWorkspaceReconciliationRecords(db, session.workspaceId).filter(
        (record) => record.id === `wrr_capture_${collectionId}`
      );
    } finally {
      db.sqlite.close();
    }
  };
  return {
    /** Durable capture publications for this source. */
    publications: () => records().map((record) => record.stateAfter),
    /** The durable capture publication records for this source. */
    records,
    /** The original collection's acceptance lands late, after recovery published. */
    async accept() {
      const db = openWorkspaceDb(launch.dataRoot, session.workspaceId);
      try {
        return await publishWorkspaceCapture(
          db,
          preserved.identity,
          preserved.result,
          preserved.candidate,
          preserved
        );
      } finally {
        db.sqlite.close();
      }
    },
    /** Whether the original source bytes are still in place. */
    preserved: () => readFileSync(source).equals(bytes),
  };
}

describe('K8b accepted-final readback', () => {
  afterEach(() => vi.useRealTimers());

  it('W1 holds a lost-ACK restart while the original peer is away and closes the Turn once after readmission', async () => {
    const launch = await launchSettledTurn({ loseObservationAck: true });
    const { attemptId, dispatch, entry, original, steps, store } = launch;

    // Core restarts. Both owners reopen, and Boot fences the RuntimeTarget before it serves (index.ts).
    await launch.live.restore();
    launch.owned.coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    const coreDb = openCoreDb(launch.dataRoot);
    launch.owned.coreDb = coreDb;
    const { path, contentMount } = nativeProductScope(launch.dataRoot, { kind: 'server' });
    await getControlStoreWorkerClient().open({
      database: `core:${path}`,
      path,
      dataRoot: launch.dataRoot,
      create: false,
      initialize: 'core',
      productOwner: { kind: 'server' },
      contentMount,
    });
    const { cold, submit, closeout, recovery } = await coldRestartRecovery(launch);
    const native = await reopenAdmittedTestNanoHost(coreDb);
    const fence = await transitionAdmittedNanoHostRuntimeTarget(native.value, {
      kind: 'restart',
      observedAt: new Date().toISOString(),
    });
    expect(fence.state).toBe('ready');
    // Boot order before listen: scheduler restart recovery and Native classification, then maintenance.
    await runSchedulerRestartRecovery(coreDb, recovery);
    await classifyNanoHostAttemptsAfterRestart(coreDb, recovery);
    const durable = store.getTurnById(entry.turnId);
    const phase = requireSchedulerExecutionAttempt(coreDb, attemptId).phase;
    // The original peer is away. Collection has no current physical Epoch authority, which holds.
    await expect(runNanoHostAttemptRecoveryMaintenance(coreDb, recovery)).rejects.toThrow(
      'Native attempt recovery failed.'
    );
    expect(closeout).toHaveBeenCalledTimes(1);
    await expect(closeout.mock.results[0]!.value).rejects.toThrow(
      'NanoHost current physical Epoch authority is unavailable.'
    );
    expect(store.getTurnById(entry.turnId)).toEqual(durable);
    expect(
      store
        .getTurnEvents(entry.turnId)
        .filter((event) => event.event === 'turn.completed' || event.event === 'turn.interrupted')
    ).toEqual([]);
    expect(requireSchedulerExecutionAttempt(coreDb, attemptId).phase).toBe(phase);
    expect(executionSteps(coreDb, attemptId)).toEqual(steps);

    // The original peer is readmitted with its same physical Epoch on a new connection generation.
    const session = readAdmittedTestNanoHost(coreDb, (sqlite) =>
      getWorkerBackendSession({ sqlite }, attemptId)
    )!;
    const target = readAdmittedTestNanoHost(coreDb, (sqlite) =>
      getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId)
    )!;
    const coordinates = {
      targetId: target.targetId,
      identityId: target.identityId,
      deploymentId: target.deploymentId,
    };
    const allocated = await transitionAdmittedNanoHostRuntimeTarget(native.value, {
      kind: 'allocate',
      ...coordinates,
      observedAt: new Date().toISOString(),
    });
    if (allocated.state !== 'ready' || !allocated.value)
      throw new Error('The readmitted peer has no connection generation.');
    const readmitted = await transitionAdmittedNanoHostRuntimeTarget(native.value, {
      kind: 'ready',
      ...coordinates,
      connectionGeneration: allocated.value.connectionGeneration,
      physicalEpoch: session.originPhysicalEpoch,
      ready: true,
      predecessorFenced: true,
      freshEmpty: true,
      observedAt: new Date().toISOString(),
    });
    expect(readmitted.state).toBe('ready');
    await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery);
    const effects = cold.effects.length;
    // A second pass finds the attempt closed and has no effect.
    await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery);

    expect(closeout).toHaveBeenCalledTimes(2);
    expect(closeout.mock.calls.map((call) => call[1])).toEqual([original, original]);
    expect(store.getTurnById(entry.turnId)).toMatchObject({ status: 'completed' });
    expect(
      store.getTurnEvents(entry.turnId).filter((event) => event.event === 'turn.completed')
    ).toHaveLength(1);
    expect(
      store.getTurnEvents(entry.turnId).filter((event) => event.event === 'turn.interrupted')
    ).toEqual([]);
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

  it('W3 leaves a Native-only final at the original deadline through classification, the accepted closing ACK and the first-cleanup hold', async () => {
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

    // At the deadline the closing ACK is delayed. First cleanup waits for it, and a refusal keeps it at zero.
    clock = deadline;
    const { closeRecovery } = boot.admittedNanoHostRecovery.value.owner;
    const delayAck = (answer: Parameters<typeof close.mockImplementationOnce>[0]) => {
      const acknowledge = Promise.withResolvers<void>();
      close.mockImplementationOnce(async (input) => {
        await acknowledge.promise;
        return answer(input);
      });
      const pass = runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, {
        ...ports,
        ...boot,
      }).then(
        () => undefined,
        (error: unknown) => error
      );
      return { acknowledge: acknowledge.resolve, pass };
    };
    const refused = delayAck(async () => ({
      state: 'unavailable',
      owner: 'nanohost',
      reason: 'recovery-required',
    }));
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    await realDelay(1000);
    expect(boot.cleanup).not.toHaveBeenCalled();
    refused.acknowledge();
    expect(((await refused.pass) as AggregateError).errors.map(String)).toEqual([
      'Error: NanoHost recovery has no matching Core close acknowledgement.',
    ]);
    expect(boot.cleanup).not.toHaveBeenCalled();

    // The next pass delays the actual closing ACK. It keeps the first cause, then first cleanup runs.
    const accepted = delayAck(closeRecovery);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(3));
    await realDelay(1000);
    expect(boot.cleanup).not.toHaveBeenCalled();
    accepted.acknowledge();
    expect(await accepted.pass).toBeInstanceOf(AggregateError);
    expect(close).toHaveBeenCalledTimes(3);
    expect(close.mock.calls[2]?.[0]).toMatchObject({
      cause: 'native-liveness-expired',
      session: waiting,
      lease: readRetainedNanoHostSubmission(fixture.coreDb, ATTEMPT_ID)?.lease,
    });
    await expect(close.mock.results[2]?.value).resolves.toMatchObject({
      state: 'ready',
      value: { phase: 'closing', terminalCause: 'worker-final-status', fenceRef: null },
    });
    expect(boot.cleanup).toHaveBeenCalledTimes(1);
    expect(close.mock.invocationCallOrder[2]).toBeLessThan(
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
    const workspace = openWorkspaceDb(absent.dataRoot, absent.lineage.workspaceId);
    try {
      const { backendKind, runtimeTargetId, sandboxBindingRef } = absent.session();
      const journalIntents = prepareWorkerTurnJournalIntents(
        workspace,
        absent.environmentPackage,
        absent.original.lease.attempt,
        { backendKind, targetId: runtimeTargetId, allocationRef: sandboxBindingRef }
      );
      await absent.store.updateTurn(absent.turnId, { status: 'running' }, { journalIntents });
    } finally {
      workspace.sqlite.close();
    }
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
    const boot = bootSelection(
      absent,
      vi.fn(async () => {})
    );
    const close = vi.spyOn(boot.admittedNanoHostRecovery.value, 'close');
    const early = await runNanoHostAttemptRecoveryMaintenance(absent.coreDb, {
      ...absentPorts,
      ...boot,
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(close).not.toHaveBeenCalled();
    expect(boot.cleanup).not.toHaveBeenCalled();
    expect(early).toBeUndefined();
    clock = absent.original.lease.grant.deadline;
    await expect(
      runNanoHostAttemptRecoveryMaintenance(absent.coreDb, { ...absentPorts, ...boot })
    ).rejects.toThrow('Native attempt recovery failed.');
    expect(boot.cleanup).toHaveBeenCalledTimes(1);

    // The admitted Native owner can prove absence in the successor Epoch. That exact cleanup
    // receipt still does not let the restart projector decide the original Worker outcome.
    const owner = currentAdmittedTestNanoHostOwner(absent.coreDb)!;
    const original = readRetainedNanoHostSubmission(absent.coreDb, ATTEMPT_ID)!;
    const { session, proof, target } = readAdmittedTestNanoHost(absent.coreDb, (sqlite) => {
      const lease = readNanoHostRecoveryLease(sqlite, original.lease);
      return {
        ...lease,
        target: getNanoHostRuntimeTarget({ sqlite }, lease.session.runtimeTargetId)!,
      };
    });
    await expect(
      owner.classifyRecovery({
        kind: 'transition',
        toState: 'physical-cleaned',
        target,
        lease: original.lease,
        expectedSession: session,
        expectedRecovery: proof,
        observedAt: clock,
      } as Parameters<typeof owner.classifyRecovery>[0])
    ).resolves.toMatchObject({ state: 'ready', value: { state: 'physical-cleaned' } });
    const before = absent.store.getTurnById(absent.turnId);
    const events = absent.store.getTurnEvents(absent.turnId);
    absentPorts.projectRecoveredTurn.mockImplementation(async (subject) => {
      const { status } = await terminalizeGovernedWorkerTurn({
        agentSessionId: subject.agentSessionId,
        completedAt: clock,
        errorCode: 'worker_governance_restart_recovery',
        message: 'Worker execution was interrupted during scheduler recovery.',
        outcome: 'interrupted',
        requestId: absent.lineage.requestId,
        store: absent.store,
        turnId: subject.turnId,
      });
      return { status };
    });
    const held = await runNanoHostAttemptRecoveryMaintenance(absent.coreDb, {
      ...absentPorts,
      ...boot,
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    const reopened = new FsStore({ dataRoot: absent.dataRoot });
    expect(reopened.getTurnById(absent.turnId)).toEqual(before);
    expect(reopened.getTurnEvents(absent.turnId)).toEqual(events);
    expect(absentPorts.projectRecoveredTurn).not.toHaveBeenCalled();
    expect((held as AggregateError).errors.map(String)).toContain(
      'Error: The original Worker final still owns Turn publication.'
    );
  });

  it('W24 holds cleanup when Core final intake wins during the absence walk', async () => {
    const fixture = await createFixture();
    const { attempt } = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      readNanoHostRecoveryLease(sqlite, fixture.original.lease)
    );
    const livenessDeadline = attempt.startupDeadline;
    expect(livenessDeadline < fixture.original.lease.grant.deadline).toBe(true);
    const originalSession = fixture.session();
    const intakeEntered = Promise.withResolvers<void>();
    const allowIntake = Promise.withResolvers<void>();
    const stoppedBeforeNative = new Error('Injected stop before Native FULL.');
    const client = getControlStoreWorkerClient() as unknown as FinalStageClient;
    const stage = client.workerControlFinalStage.bind(client);
    const finalStage = vi
      .spyOn(client, 'workerControlFinalStage')
      .mockImplementation(async (...args) => {
        if (args[2].kind === 'intake') {
          intakeEntered.resolve();
          await allowIntake.promise;
        }
        if (args[2].kind === 'settle') throw stoppedBeforeNative;
        return stage(...args);
      });
    const capture = vi.mocked(hasPendingWorkspaceCapture);
    const readCapture = capture.getMockImplementation();
    if (!readCapture) throw new Error('Capture spy has no original implementation.');
    vi.setSystemTime(Date.parse(livenessDeadline) - 1);
    const final = fixture.recordFinal().then(
      () => undefined,
      (error: unknown) => error
    );
    try {
      await Promise.race([
        intakeEntered.promise,
        final.then(() => {
          throw new Error('The original final did not reach the Core intake boundary.');
        }),
      ]);
      // Maintenance has read absence and is awaiting the real capture census before posting close.
      capture.mockImplementationOnce(async (...args) => {
        const result = await readCapture(...args);
        allowIntake.resolve();
        expect(await final).toBe(stoppedBeforeNative);
        expect(fixture.finalSteps().map(({ stepId }) => stepId)).toEqual([
          'worker-route-fixture-submit',
          'worker-final-intake',
        ]);
        expect(fixture.readback()).toEqual({ state: 'held', reason: 'missing' });
        return result;
      });

      vi.setSystemTime(Date.parse(livenessDeadline));
      const ports = recoveryPorts(() => livenessDeadline);
      const boot = bootSelection(
        fixture,
        vi.fn(async () => {})
      );
      const close = vi.spyOn(boot.admittedNanoHostRecovery.value, 'close');
      const held = await runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, {
        ...ports,
        ...boot,
      }).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(close).toHaveBeenCalledOnce();
      const retained = fixture.session();
      expect({
        nativeState: retained.state,
        cleanupCalls: boot.cleanup.mock.calls.length,
      }).toEqual({ nativeState: originalSession.state, cleanupCalls: 0 });
      expect(retained).toEqual(originalSession);
      await expect(close.mock.results[0]!.value).resolves.toMatchObject({
        state: 'ready',
        value: { phase: 'closing', terminalCause: 'worker-final-status', fenceRef: null },
      });
      expect(held).toBeInstanceOf(AggregateError);
      expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)).toMatchObject({
        phase: 'closing',
        terminalCause: 'worker-final-status',
        fenceRef: null,
      });
    } finally {
      allowIntake.resolve();
      await final;
      finalStage.mockRestore();
    }
  });

  it.each([
    { order: 'intake before ACK delivery', cut: 'settle', releaseAtClose: true, state: 'held' },
    { order: 'intake after ACK delivery', cut: 'settle', releaseAtClose: false, state: 'held' },
    { order: 'Native-only after ACK', cut: 'observe', releaseAtClose: false, state: 'native-only' },
    { order: 'settled after ACK', cut: null, releaseAtClose: false, state: 'settled' },
    {
      order: 'settled with lost reply after ACK',
      cut: null,
      releaseAtClose: false,
      state: 'settled',
    },
  ] as const)(
    'W25 gives the cancellation final the attempt when $order wins',
    async ({ order, cut, releaseAtClose, state }) => {
      const fixture = await createFixture();
      const original = fixture.session();
      const turn = fixture.store.getTurnById(fixture.turnId);
      const events = fixture.store.getTurnEvents(fixture.turnId);
      const exclusions = fixture.exclusions();
      const dropped = cut ? crashBeforeFinalStage(cut) : undefined;
      const final = await pauseCancellationFinal(fixture, order.includes('lost reply'));
      const allowFinal = async () => {
        final.release();
        if (cut) await expect(final.reply).rejects.toThrow(`Injected crash before ${cut}.`);
        else if (order.includes('lost reply'))
          await expect(final.reply).rejects.toThrow('Injected loss of the Worker final reply.');
        else await expect(final.reply).resolves.toMatchObject({ accepted: true });
        expect(fixture.readback().state).toBe(state);
      };
      try {
        vi.setSystemTime(Date.parse(final.livenessDeadline));
        const ports = recoveryPorts(() => final.livenessDeadline);
        const closeout = vi.fn(async () => {});
        const boot = bootSelection(fixture, closeout);
        const owner = boot.admittedNanoHostRecovery.value;
        const close = owner.close.bind(owner);
        const ack = vi.spyOn(owner, 'close').mockImplementationOnce(async (...args) => {
          const reply = await close(...args);
          expect(reply).toMatchObject({
            state: 'ready',
            value: { terminalCause: 'turn-cancelled' },
          });
          if (releaseAtClose) await allowFinal();
          return reply;
        });
        if (!releaseAtClose) {
          const commit = owner.commit.bind(owner);
          vi.spyOn(owner, 'commit').mockImplementationOnce(async (...args) => {
            await allowFinal();
            return commit(...args);
          });
        }
        const held = await runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, {
          ...ports,
          ...boot,
        }).then(
          () => undefined,
          (error: unknown) => error
        );
        expect(ack).toHaveBeenCalledOnce();
        expect({
          nativeState: fixture.session().state,
          cleanupCalls: boot.cleanup.mock.calls.length,
        }).toEqual({ nativeState: original.state, cleanupCalls: 0 });
        expect(fixture.session()).toEqual(original);
        expect(closeout).toHaveBeenCalledTimes(state === 'settled' ? 1 : 0);
        if (state === 'settled') expect(held).toBeUndefined();
        else expect(held).toBeInstanceOf(AggregateError);
        expect(fixture.finalSteps().map(({ stepId }) => stepId)).toContain('worker-final-intake');
        expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)).toMatchObject({
          phase: 'closing',
          terminalCause: 'turn-cancelled',
          fenceRef: null,
        });
        expect(fixture.exclusions()).toEqual(exclusions);
        expect(fixture.store.getTurnById(fixture.turnId)).toEqual(turn);
        expect(fixture.store.getTurnEvents(fixture.turnId)).toEqual(events);
      } finally {
        await final.restore();
        dropped?.mockRestore();
      }
    }
  );

  it.each(['prepared Native post', 'after cleanup-pending', 'at physical handoff'] as const)(
    'W26 the effective expiry cleanup excludes a late first final at %s',
    async (when) => {
      const fixture = await createFixture();
      const final = await pauseCancellationFinal(fixture);
      const deadline = fixture.original.lease.grant.deadline;
      let clock = new Date(Date.parse(deadline) - 1).toISOString();
      const ports = recoveryPorts(() => clock);
      const closeout = vi.fn(async () => {});
      const boot = bootSelection(fixture, closeout);
      const pass = () =>
        runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot }).then(
          () => undefined,
          (error: unknown) => error
        );
      type NativePost = {
        request(
          input: {
            operation: string;
            mutation?: { kind: string; input: { classification?: { toState?: string } } };
          },
          ...rest: unknown[]
        ): Promise<unknown>;
      };
      const writer = getControlStoreWorkerClient() as unknown as NativePost;
      const request = writer.request.bind(writer);
      const realTimers =
        await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
      let posts = 0;
      // A real final can reach its admitted owner here. The recovery hold keeps intake behind the write.
      const releaseWhileHeld = async () => {
        final.release();
        await Promise.race([final.reply.catch(() => undefined), realTimers.setTimeout(1_000)]);
      };
      const post = vi.spyOn(writer, 'request').mockImplementation(async (input, ...rest) => {
        if (
          input.operation === 'nanohost-owner' &&
          input.mutation?.kind === 'recovery-classification' &&
          input.mutation.input.classification?.toState === 'cleanup-pending'
        ) {
          posts += 1;
          if (when === 'prepared Native post') await releaseWhileHeld();
        }
        return request(input, ...rest);
      });
      try {
        vi.setSystemTime(Date.parse(clock));
        expect(await pass()).toBeInstanceOf(AggregateError);
        expect(posts).toBe(0);
        expect(boot.cleanup).not.toHaveBeenCalled();
        expect(fixture.session().state).toBe('launching');

        clock = deadline;
        vi.setSystemTime(Date.parse(clock));
        if (when === 'after cleanup-pending') {
          const owner = boot.admittedNanoHostRecovery.value;
          const commit = owner.commit.bind(owner);
          vi.spyOn(owner, 'commit').mockImplementationOnce((input, cleanup) =>
            commit(input, {
              authorize: cleanup!.authorize,
              handoff: async (session) => {
                await releaseWhileHeld();
                return cleanup!.handoff(session);
              },
            })
          );
        }
        if (when === 'at physical handoff') {
          const cleanup = boot.cleanup.getMockImplementation()!;
          boot.cleanup.mockImplementationOnce(async (...args) => {
            final.release();
            return cleanup(...args);
          });
        }
        expect(await pass()).toBeInstanceOf(AggregateError);
        // The opposite order is covered by W25. Here expiry wins and writes exactly one pending row.
        expect(posts).toBe(1);
        expect(boot.cleanup).toHaveBeenCalledTimes(1);
        expect(fixture.session().state).toBe('cleanup-pending');
        await expect(final.reply).rejects.toMatchObject({ code: 'worker_control_lease_not_live' });
        expect(fixture.finalSteps().map(({ stepId }) => stepId)).toEqual([
          'worker-route-fixture-submit',
        ]);
        expect(closeout).not.toHaveBeenCalled();
      } finally {
        post.mockRestore();
        await final.restore();
      }
    }
  );

  it.each([
    'settlement during the Core close',
    'settlement before handoff',
    'settlement races an acknowledged cleanup-pending write',
    'physical handoff before settlement',
  ] as const)('W27 orders a Native-only expiry when %s wins', async (order) => {
    const fixture = await createFixture();
    const dropped = crashBeforeFinalStage('observe');
    const final = await pauseCancellationFinal(fixture);
    try {
      final.release();
      await expect(final.reply).rejects.toThrow('Injected crash before observe.');
      dropped.mockRestore();
      expect(fixture.readback().state).toBe('native-only');
      const deadline = fixture.original.lease.grant.deadline;
      const ports = recoveryPorts(() => deadline);
      const closeout = vi.fn(async () => {});
      const boot = bootSelection(fixture, closeout);
      const owner = boot.admittedNanoHostRecovery.value;
      const commit = owner.commit.bind(owner);
      const pass = () =>
        runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot }).then(
          () => undefined,
          (error: unknown) => error
        );
      let observing: ReturnType<typeof final.replay> | undefined;
      let atHandoff: string | undefined;
      vi.setSystemTime(Date.parse(deadline));
      if (order === 'settlement during the Core close') {
        const close = owner.close.bind(owner);
        vi.spyOn(owner, 'close').mockImplementationOnce(async (...args) => {
          await final.replay();
          expect(fixture.readback().state).toBe('settled');
          return close(...args);
        });
        expect(await pass()).toBeInstanceOf(AggregateError);
        expect(boot.cleanup).not.toHaveBeenCalled();
        expect(await pass()).toBeUndefined();
      } else if (order === 'settlement before handoff') {
        vi.spyOn(owner, 'commit').mockImplementationOnce(async (...args) => {
          await final.replay();
          expect(fixture.readback().state).toBe('settled');
          return commit(...args);
        });
        expect(await pass()).toBeUndefined();
        expect(boot.cleanup).not.toHaveBeenCalled();
        expect(fixture.session().state).toBe('launching');
      } else {
        const startObservation = () => {
          observing = final.replay();
          void observing.catch(() => undefined);
          return observing;
        };
        if (order === 'settlement races an acknowledged cleanup-pending write') {
          const realTimers =
            await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
          vi.spyOn(owner, 'commit').mockImplementationOnce((input, cleanup) =>
            commit(input, {
              authorize: cleanup!.authorize,
              handoff: async (session) => {
                expect(session.state).toBe('cleanup-pending');
                await Promise.race([startObservation(), realTimers.setTimeout(1_000)]);
                return cleanup!.handoff(session);
              },
            })
          );
        }
        const cleanup = boot.cleanup.getMockImplementation()!;
        boot.cleanup.mockImplementationOnce(async (...args) => {
          atHandoff = fixture.readback().state;
          if (!observing) startObservation();
          return cleanup(...args);
        });
        expect(await pass()).toBeInstanceOf(AggregateError);
        expect(boot.cleanup).toHaveBeenCalledTimes(1);
        expect(fixture.session().state).toBe('cleanup-pending');
        expect(atHandoff).toBe('native-only');
        expect(observing).toBeDefined();
        await observing;
        expect(fixture.readback().state).toBe('settled');
        expect(await pass()).toBeUndefined();
        expect(boot.cleanup).toHaveBeenCalledTimes(1);
      }
      expect(closeout).toHaveBeenCalledTimes(1);
      expect(fixture.readback().state).toBe('settled');
      expect(ports.executionBackend.submit).not.toHaveBeenCalled();
    } finally {
      await final.restore();
      dropped.mockRestore();
    }
  });

  it('W28 holds an unreceipted cleanup-pending session on reopen', async () => {
    const fixture = await createFixture();
    const { attempt } = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      readNanoHostRecoveryLease(sqlite, fixture.original.lease)
    );
    const ports = recoveryPorts(() => attempt.startupDeadline);
    const boot = bootSelection(
      fixture,
      vi.fn(async () => {})
    );
    await expect(
      runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot })
    ).rejects.toBeInstanceOf(AggregateError);
    expect(boot.cleanup).toHaveBeenCalledTimes(1);
    const pending = fixture.session();
    expect(pending.state).toBe('cleanup-pending');
    const retained = fixture.store.getTurnById(fixture.turnId);
    const events = fixture.store.getTurnEvents(fixture.turnId);
    const exclusions = fixture.exclusions();
    await fixture.restart(ports);
    fixture.readyFreshEpoch();
    const restarted = bootSelection(
      fixture,
      vi.fn(async () => {})
    );
    await expect(
      runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...restarted })
    ).rejects.toBeInstanceOf(AggregateError);
    expect(restarted.cleanup).not.toHaveBeenCalled();
    expect(fixture.session()).toEqual(pending);
    expect(fixture.exclusions()).toEqual(exclusions);
    const reopened = new FsStore({ dataRoot: fixture.dataRoot });
    expect(reopened.getTurnById(fixture.turnId)).toEqual(retained);
    expect(reopened.getTurnEvents(fixture.turnId)).toEqual(events);
  });

  it('W29 revalidates an exact close after losing its ACK across reopen', async () => {
    const fixture = await createFixture();
    const { attempt } = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      readNanoHostRecoveryLease(sqlite, fixture.original.lease)
    );
    let clock = attempt.startupDeadline;
    const ports = recoveryPorts(() => clock);
    const boot = bootSelection(
      fixture,
      vi.fn(async () => {})
    );
    const owner = boot.admittedNanoHostRecovery.value;
    const close = owner.close.bind(owner);
    vi.spyOn(owner, 'close').mockImplementationOnce(async (...args) => {
      expect(await close(...args)).toMatchObject({ state: 'ready' });
      return { state: 'unavailable', owner: 'control-kernel', reason: 'recovery-required' };
    });
    await expect(
      runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot })
    ).rejects.toBeInstanceOf(AggregateError);
    expect(boot.cleanup).not.toHaveBeenCalled();
    expect(fixture.session().state).toBe('launching');
    expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)).toMatchObject({
      phase: 'closing',
      terminalCause: 'native-liveness-expired',
      fenceRef: null,
    });

    clock = fixture.original.lease.grant.deadline;
    await fixture.restart(ports);
    fixture.readyFreshEpoch();
    const restarted = bootSelection(
      fixture,
      vi.fn(async () => {})
    );
    const acknowledged = vi.spyOn(restarted.admittedNanoHostRecovery.value, 'close');
    await expect(
      runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...restarted })
    ).rejects.toBeInstanceOf(AggregateError);
    expect(restarted.cleanup).toHaveBeenCalledOnce();
    expect(fixture.session().state).toBe('cleanup-pending');
    await expect(acknowledged.mock.results[0]!.value).resolves.toMatchObject({
      state: 'ready',
      value: { phase: 'closing', terminalCause: 'native-liveness-expired', fenceRef: null },
    });
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

    // (b) After a good inspection: the guarded read compares the original physical session. The
    // origin Epoch is also in the submit placement digest; the backend session id is only in the proof.
    for (const [column, value, restore] of [
      ['origin_physical_epoch', 'f'.repeat(64), session.originPhysicalEpoch],
      ['backend_session_id', `${session.backendSessionId}-successor`, session.backendSessionId],
    ] as const) {
      const { backend, calls } = recordingBackend(session);
      const executor = new WorkerGovernanceTurnExecutor({
        backend,
        coreDb: fixture.coreDb,
        environmentBackend: { kind: 'openshell' },
      });
      setSession(column, value);
      await expect(
        executor.resumeAcceptedFinalStatus(
          fixture.store,
          fixture.environmentPackage,
          session,
          original
        )
      ).rejects.toThrow('Restart closeout final proof changed after recovery inspection.');
      expect(calls).toEqual(['planSession']);
      setSession(column, restore);
      expect(fixture.readback()).toEqual(original);
    }
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
    // Maintenance inspects a final before any capture census. Call 1 is the claimed factory closeout.
    capture.mockImplementation(async (...args) => {
      captures += 1;
      if (captures === 1) {
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
    // Only the claimed closeout. The second pass skips the live Turn before inspection and capture.
    expect(captures).toBe(1);
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
  it('W13 holds a missing Native final record while other accepted-final evidence survives', async () => {
    // Each case keeps one kind of evidence: all of it, the Core receipt, the terminal event, its
    // receipt, or only the final receipt (the r1 check).
    // The last two keep only the Core receipt and change the original placement: the target and
    // session agree on another deployment, or the session carries another origin Epoch.
    const cases: {
      finalReceipt: boolean;
      event: boolean;
      eventReceipt: boolean;
      coreReceipt: boolean;
      placement?: 'deployment' | 'epoch';
    }[] = [
      { finalReceipt: false, event: true, eventReceipt: true, coreReceipt: true },
      { finalReceipt: false, event: false, eventReceipt: false, coreReceipt: true },
      { finalReceipt: false, event: true, eventReceipt: false, coreReceipt: false },
      { finalReceipt: false, event: false, eventReceipt: true, coreReceipt: false },
      { finalReceipt: true, event: false, eventReceipt: false, coreReceipt: false },
      {
        finalReceipt: false,
        event: false,
        eventReceipt: false,
        coreReceipt: true,
        placement: 'deployment',
      },
      {
        finalReceipt: false,
        event: false,
        eventReceipt: false,
        coreReceipt: true,
        placement: 'epoch',
      },
    ];
    for (const survives of cases) {
      const fixture = await createFixture();
      await fixture.recordFinal();
      const settled = fixture.readback();
      if (settled.state !== 'settled') throw new Error('Fixture has no settled readback.');
      let clock = new Date(Date.parse(fixture.original.lease.grant.deadline) - 1).toISOString();
      const ports = recoveryPorts(() => clock);
      await fixture.restart(ports);
      fixture.readyFreshEpoch();
      mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) => {
        const remove = (table: string, operation: string) =>
          sqlite
            .prepare(`DELETE FROM ${table} WHERE operation=? AND sequence=?`)
            .run(operation, SEQUENCE);
        remove('worker_control_records', 'final_status');
        if (!survives.finalReceipt) remove('worker_control_sequence_fingerprints', 'final_status');
        if (!survives.event) remove('worker_control_records', 'event_append');
        if (!survives.eventReceipt) remove('worker_control_sequence_fingerprints', 'event_append');
        if (survives.placement === 'deployment') {
          const deployment = '00000000-0000-4000-8000-000000000009';
          sqlite
            .prepare('UPDATE worker_backend_sessions SET deployment_id=? WHERE attempt_id=?')
            .run(deployment, ATTEMPT_ID);
          sqlite
            .prepare('UPDATE nanohost_runtime_targets SET deployment_id=? WHERE target_id=?')
            .run(deployment, settled.session.runtimeTargetId);
        }
        if (survives.placement === 'epoch')
          sqlite
            .prepare(
              'UPDATE worker_backend_sessions SET origin_physical_epoch=? WHERE attempt_id=?'
            )
            .run('f'.repeat(64), ATTEMPT_ID);
      });
      if (!survives.coreReceipt)
        fixture.coreDb.sqlite
          .prepare('DELETE FROM control_execution_steps WHERE step_id=?')
          .run(settled.receipt.intent.requestId);
      expect(fixture.readback()).toEqual({ state: 'held', reason: 'missing' });
      // Before and at the original deadline: the original session stays and no cleanup starts.
      await expectBootHold(fixture, ports);
      clock = fixture.original.lease.grant.deadline;
      await expectBootHold(fixture, ports);
      await shutdownControlStoreWorkerClient();
    }
  }, 180_000);

  it('W14 checks the first inspection against the original submit placement digest', async () => {
    const launch = await launchSettledTurn({ loseObservationAck: false });
    const { attemptId, entry, original, store } = launch;
    const { coreDb } = launch.owned;
    // The production submit retains its queue entry and the digest of its exact placement.
    const { grant } = readRetainedNanoHostSubmission(coreDb, attemptId)!.lease;
    const submitted = coreDb.sqlite
      .prepare(
        'SELECT control_json AS control FROM control_execution_steps WHERE execution_id=? AND invocation_id=?'
      )
      .get(grant.execution.executionId, grant.operationId) as { control: string };
    expect(JSON.parse(submitted.control).authorityRefs).toEqual([
      entry.queueEntryId,
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    ]);
    await launch.live.restore();
    const { cold, closeout, recovery } = await coldRestartRecovery(launch);
    await runSchedulerRestartRecovery(coreDb, recovery);
    await classifyNanoHostAttemptsAfterRestart(coreDb, recovery);
    const session = () =>
      readAdmittedTestNanoHost(coreDb, (sqlite) => getWorkerBackendSession({ sqlite }, attemptId))!;
    const placed = session();
    const readback = () =>
      readAdmittedTestNanoHost(coreDb, (sqlite) =>
        inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, attemptId)
      );
    const setPlacement = (originPhysicalEpoch: string, deploymentId: string) =>
      mutateAdmittedTestNanoHost(coreDb, (sqlite) => {
        sqlite
          .prepare(
            'UPDATE worker_backend_sessions SET origin_physical_epoch=?, deployment_id=? WHERE attempt_id=?'
          )
          .run(originPhysicalEpoch, deploymentId, attemptId);
        sqlite
          .prepare('UPDATE nanohost_runtime_targets SET deployment_id=? WHERE target_id=?')
          .run(deploymentId, placed.runtimeTargetId);
      });
    const turn = store.getTurnById(entry.turnId);
    // A changed origin Epoch, then a target and session that agree on another deployment.
    for (const [epoch, deployment] of [
      ['f'.repeat(64), placed.deploymentId],
      [placed.originPhysicalEpoch, 'other-deployment'],
    ] as const) {
      setPlacement(epoch, deployment);
      expect(readback()).toEqual({ state: 'held', reason: 'conflict' });
      // Selection: Boot inspection holds before closeout.
      await expect(runNanoHostAttemptRecoveryMaintenance(coreDb, recovery)).rejects.toThrow(
        'Native attempt recovery failed.'
      );
      expect(closeout).not.toHaveBeenCalled();
      // Handoff: the guarded closeout read holds the original commitment.
      await expect(cold.runtime.reconcileAcceptedFinalStatus(session(), original)).rejects.toThrow(
        'Restart closeout final proof changed after recovery inspection.'
      );
      setPlacement(placed.originPhysicalEpoch, placed.deploymentId);
      expect(readback()).toEqual(original);
    }
    expect(store.getTurnById(entry.turnId)).toEqual(turn);
    expect(cold.executor.releaseResults).toEqual([]);

    // A legitimate successor Epoch keeps the historical readback: the digest uses the original grant
    // generation and the session's origin Epoch.
    const fixture = await createFixture();
    await fixture.recordFinal();
    const settled = fixture.readback();
    expect(settled.state).toBe('settled');
    await fixture.restart(recoveryPorts(() => new Date().toISOString()));
    fixture.readyFreshEpoch();
    const target = readAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      getNanoHostRuntimeTarget({ sqlite }, fixture.session().runtimeTargetId)
    )!;
    expect(target.physicalEpoch).not.toBe(fixture.session().originPhysicalEpoch);
    expect(String(target.connectionGeneration)).not.toBe(fixture.original.lease.grant.generation);
    expect(fixture.readback()).toEqual(settled);
  }, 120_000);
  it('W12 holds changed final proof in production maintenance before a pending capture publishes', async () => {
    const launch = await launchSettledTurn({ loseObservationAck: false });
    const { attemptId, entry, original, store } = launch;
    const { coreDb } = launch.owned;
    await launch.live.restore();
    const { cold, submit, closeout, recovery } = await coldRestartRecovery(launch);
    // Boot order before listen: scheduler restart recovery and Native classification, then maintenance.
    await runSchedulerRestartRecovery(coreDb, recovery);
    await classifyNanoHostAttemptsAfterRestart(coreDb, recovery);
    const capture = await stagePendingTurnEndCapture(launch);
    expect(capture.publications()).toEqual([]);
    const turn = store.getTurnById(entry.turnId);
    const phase = requireSchedulerExecutionAttempt(coreDb, attemptId).phase;
    const effects = cold.effects.length;
    const readback = () =>
      readAdmittedTestNanoHost(coreDb, (sqlite) =>
        inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, attemptId)
      );
    const fingerprint = readAdmittedTestNanoHost(
      coreDb,
      (sqlite) =>
        sqlite
          .prepare(
            "SELECT fingerprint FROM worker_control_sequence_fingerprints WHERE operation='final_status'"
          )
          .get() as { fingerprint: string }
    ).fingerprint;
    const setFinalFingerprint = (value: string) =>
      mutateAdmittedTestNanoHost(coreDb, (sqlite) =>
        sqlite
          .prepare(
            "UPDATE worker_control_sequence_fingerprints SET fingerprint=? WHERE operation='final_status'"
          )
          .run(value)
      );
    const expectSourceHeld = () => {
      expect(capture.publications()).toEqual([]);
      expect(capture.preserved()).toBe(true);
      expect(store.getTurnById(entry.turnId)).toEqual(turn);
      expect(requireSchedulerExecutionAttempt(coreDb, attemptId).phase).toBe(phase);
      expect(cold.executor.releaseResults).toEqual([]);
      expect(cold.effects).toHaveLength(effects);
      expect(submit).not.toHaveBeenCalled();
    };

    const pass = () =>
      runNanoHostAttemptRecoveryMaintenance(coreDb, recovery).then(
        () => 'returned',
        (error: unknown) => error
      );

    // (a) One changed final fingerprint: inspection holds before any capture publication.
    setFinalFingerprint('{}');
    const changed = await pass();
    // The durable publication is the oracle, so it is checked first.
    expectSourceHeld();
    expect(readback().state).toBe('held');
    expect(changed).toBeInstanceOf(AggregateError);
    expect(closeout).not.toHaveBeenCalled();

    // (b) The proof is good at inspection and at the factory's guarded read. It changes on entry to
    // capture recovery, and the guarded read before publication holds.
    setFinalFingerprint(fingerprint);
    expect(readback()).toEqual(original);
    const helper = vi.mocked(hasPendingWorkspaceCapture);
    const actual = helper.getMockImplementation();
    if (!actual) throw new Error('Capture spy has no original implementation.');
    helper.mockImplementationOnce(async (...args) => {
      setFinalFingerprint('{}');
      return actual(...args);
    });
    const late = await pass();
    expectSourceHeld();
    expect(late).toBeInstanceOf(AggregateError);
    expect(closeout).toHaveBeenCalledTimes(1);
    await expect(closeout.mock.results[0]!.value).rejects.toThrow(
      'Restart closeout final proof changed after recovery inspection.'
    );
  });
  it('W15 rechecks the final proof in each capture publication commit: an earlier change holds and a later write waits', async () => {
    const launch = await launchSettledTurn({ loseObservationAck: false });
    const { attemptId, entry, finalCommand, original, store } = launch;
    const { coreDb } = launch.owned;
    await launch.live.restore();
    const { cold, submit, closeout, recovery } = await coldRestartRecovery(launch);
    // Boot order before listen: scheduler restart recovery and Native classification, then maintenance.
    await runSchedulerRestartRecovery(coreDb, recovery);
    await classifyNanoHostAttemptsAfterRestart(coreDb, recovery);
    const capture = await stagePendingTurnEndCapture(launch);
    const turn = store.getTurnById(entry.turnId);
    const phase = requireSchedulerExecutionAttempt(coreDb, attemptId).phase;
    const effects = cold.effects.length;
    const rows = nativeFinalRows(launch.owned);
    const sequence = Number(
      rows.records.find((row) => row.operation === 'final_status')?.sequence ?? Number.NaN
    );
    const readback = () =>
      readAdmittedTestNanoHost(coreDb, (sqlite) =>
        inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, attemptId)
      );
    const expectHeldAfter = (records: ReturnType<typeof capture.records>) => {
      // The durable publication is the oracle, so it is checked first.
      expect(capture.records()).toEqual(records);
      expect(capture.preserved()).toBe(true);
      expect(store.getTurnById(entry.turnId)).toEqual(turn);
      expect(requireSchedulerExecutionAttempt(coreDb, attemptId).phase).toBe(phase);
      expect(cold.executor.releaseResults).toEqual([]);
      expect(cold.effects).toHaveLength(effects);
      expect(submit).not.toHaveBeenCalled();
    };
    const pass = () =>
      runNanoHostAttemptRecoveryMaintenance(coreDb, recovery).then(
        () => 'returned',
        (error: unknown) => error
      );
    const lastCloseout = () =>
      closeout.mock.results.at(-1)!.value.then(
        () => undefined,
        (error: unknown) => error
      );
    const changedProof = 'Workspace capture final proof changed before publication.';
    const client = getControlStoreWorkerClient();
    const post = client.workspaceCapture.bind(client);

    // (a) One final receipt changes while recovery opens the Workspace owner, after the guarded read.
    const open = client.open.bind(client);
    let opened = 0;
    const opening = vi.spyOn(client, 'open').mockImplementation(async (...args) => {
      const publication = new Error().stack?.includes('workspace-capture-publication');
      const value = await open(...args);
      if (publication && opened++ === 0)
        mutateAdmittedTestNanoHost(coreDb, (sqlite) =>
          sqlite
            .prepare(
              "UPDATE worker_control_sequence_fingerprints SET fingerprint='{}' WHERE operation='final_status'"
            )
            .run()
        );
      return value;
    });
    const changedAtOpen = await pass().finally(() => opening.mockRestore());
    expect(opened).toBe(1);
    expectHeldAfter([]);
    expect(readback().state).toBe('held');
    expect(changedAtOpen).toBeInstanceOf(AggregateError);
    expect(causeChain(await lastCloseout()).map(String)).toContain(`Error: ${changedProof}`);
    restoreNativeFinal(launch.owned, rows);
    expect(readback()).toEqual(original);

    // (b) A consistent substitution of the Native final pair on entry to the capture post.
    let atPost: string | undefined;
    const posting = vi.spyOn(client, 'workspaceCapture').mockImplementationOnce(async (...args) => {
      substituteNativeFinal(launch.owned, { sequence: sequence + 1 });
      atPost = readback().state;
      return post(...args);
    });
    const changedAtPost = await pass().finally(() => posting.mockRestore());
    expect(atPost).toBe('held');
    expectHeldAfter([]);
    expect(changedAtPost).toBeInstanceOf(AggregateError);
    expect(causeChain(await lastCloseout()).map(String)).toContain(`Error: ${changedProof}`);
    restoreNativeFinal(launch.owned, rows);
    expect(readback()).toEqual(original);

    // (c) A later proof write, the Worker's exact final replay, starts inside the guarded post. It
    // waits until the Workspace commit returns. The exact proof publishes recovery once.
    const owner = currentAdmittedTestNanoHostOwner(coreDb);
    if (!owner) throw new Error('Launch has no admitted NanoHost owner.');
    const worker = client as unknown as { request(...args: unknown[]): Promise<unknown> };
    const send = worker.request.bind(client);
    const order: string[] = [];
    let replay: Promise<unknown> | undefined;
    const committing = vi.spyOn(worker, 'request').mockImplementation(async (...args) => {
      if ((args[0] as { operation?: string }).operation !== 'workspace-capture' || replay)
        return send(...args);
      replay = owner.workerControlFinalStatus(finalCommand).then(() => order.push('replay'));
      await realDelay(1000);
      order.push('post');
      const reply = await send(...args);
      order.push('commit');
      return reply;
    });
    const exact = await pass().finally(() => committing.mockRestore());
    await replay;
    expect(order).toEqual(['post', 'commit', 'replay']);
    expect(capture.publications()).toEqual(['requires-human']);
    const recovered = capture.records();
    expectHeldAfter(recovered);
    expect(readback()).toEqual(original);
    // The recovered source still requires its durable disposition, so the Turn holds.
    expect(exact).toBeInstanceOf(AggregateError);

    // The collection writer accepts the original bytes before the recovery pass completes them.
    await capture.accept();
    expect(capture.publications()).toEqual(['requires-human']);
    const completing = vi
      .spyOn(client, 'workspaceCapture')
      .mockImplementationOnce(async (database, input, guard) => {
        expect(input.action).toBe('complete');
        substituteNativeFinal(launch.owned, { sequence: sequence + 1 });
        return post(database, input, guard);
      });
    const changedBeforeComplete = await pass().finally(() => completing.mockRestore());
    expectHeldAfter(recovered);
    expect(changedBeforeComplete).toBeInstanceOf(AggregateError);
    expect(causeChain(await lastCloseout()).map(String)).toContain(`Error: ${changedProof}`);
    restoreNativeFinal(launch.owned, rows);
    const completionOrder: string[] = [];
    let completionReplay: Promise<unknown> | undefined;
    const completingRace = vi.spyOn(worker, 'request').mockImplementation(async (...args) => {
      const command = args[0] as { operation?: string; input?: { action?: string } };
      if (
        command.operation !== 'workspace-capture' ||
        command.input?.action !== 'complete' ||
        completionReplay
      )
        return send(...args);
      completionReplay = owner
        .workerControlFinalStatus(finalCommand)
        .then(() => completionOrder.push('replay'));
      await realDelay(1000);
      const reply = await send(...args);
      completionOrder.push('commit');
      return reply;
    });
    await pass().finally(() => completingRace.mockRestore());
    await completionReplay;
    expect(completionOrder).toEqual(['commit', 'replay']);
    expect(capture.publications()).toEqual(['recovered']);
    const completed = capture.records();
    await pass();
    expect(capture.records()).toEqual(completed);
  }, 180_000);

  it('W16 takes the Native-only deadline exit with a pending capture: zero publications, the closing ACK, then first cleanup', async () => {
    const launch = await launchNativeOnlyTurn();
    const { attemptId, entry, native, steps, store } = launch;
    const { coreDb } = launch.owned;
    await launch.live.restore();
    launch.stopped.mockRestore();
    const { deadline } = readRetainedNanoHostSubmission(coreDb, attemptId)!.lease.grant;
    let clock = new Date(Date.parse(deadline) - 1).toISOString();
    const restarted = await coldRestartRecovery(launch);
    const { closeout, submit } = restarted;
    const recovery = { ...restarted.recovery, now: () => clock };
    const selection = recovery.admittedNanoHostRecovery;
    if (selection?.state !== 'ready') throw new Error('Launch has no Boot recovery selection.');
    const close = vi.spyOn(selection.value, 'close');
    const cleanup = vi.spyOn(selection.value, 'cleanup');
    // Boot order before listen: scheduler restart recovery and Native classification, then maintenance.
    await runSchedulerRestartRecovery(coreDb, recovery);
    await classifyNanoHostAttemptsAfterRestart(coreDb, recovery);
    const capture = await stagePendingTurnEndCapture(launch);
    const turn = store.getTurnById(entry.turnId);
    const before = close.mock.calls.length;
    const readback = () =>
      readAdmittedTestNanoHost(coreDb, (sqlite) =>
        inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, attemptId)
      );
    const expectSourceKept = () => {
      expect(capture.publications()).toEqual([]);
      expect(capture.preserved()).toBe(true);
      expect(closeout).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(executionSteps(coreDb, attemptId).slice(0, steps.length)).toEqual(steps);
      expect(readback()).toEqual(native);
    };

    // One millisecond before the original deadline the Native-only final waits with no effect.
    await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery);
    expect(close).toHaveBeenCalledTimes(before);
    expect(cleanup).not.toHaveBeenCalled();
    expect(store.getTurnById(entry.turnId)).toEqual(turn);
    expectSourceKept();

    // At the deadline it owns the next decision: the closing ACK with the first cause and the scoped
    // revoke, then the first-cleanup handoff. Capture publication is not reached.
    clock = deadline;
    const expired = await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(expired).toBeInstanceOf(AggregateError);
    expect(close).toHaveBeenCalledTimes(before + 1);
    expect(close.mock.calls[before]?.[0]).toMatchObject({ cause: 'native-liveness-expired' });
    await expect(close.mock.results[before]?.value).resolves.toMatchObject({
      state: 'ready',
      value: { phase: 'closing', terminalCause: 'worker-final-status' },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(close.mock.invocationCallOrder[before]).toBeLessThan(
      cleanup.mock.invocationCallOrder[0] ?? 0
    );
    expectSourceKept();
  });

  it('W17 rechecks the Native-only final in the Core closing transaction at expiry', async () => {
    const fixture = await createFixture();
    const credentials = fixture.seedRunCredentials();
    const crash = crashBeforeFinalStage('observe');
    await expect(fixture.recordFinal()).rejects.toThrow('Injected crash before observe.');
    crash.mockRestore();
    const native = fixture.readback();
    expect(native).toMatchObject({ state: 'native-only', sequence: SEQUENCE, receipt: null });
    const rows = nativeFinalRows(fixture);
    const steps = fixture.finalSteps();
    const exclusions = fixture.exclusions();
    const ports = recoveryPorts(() => fixture.original.lease.grant.deadline);
    const closeout = vi.fn(async () => {});
    let boot!: ReturnType<typeof bootSelection>;
    let close!: MockInstance<AdmittedNanoHostAttemptRecovery['close']>;
    await fixture.restart(ports, () => {
      boot = bootSelection(fixture, closeout);
      close = vi.spyOn(boot.admittedNanoHostRecovery.value, 'close');
      return boot;
    });
    fixture.readyFreshEpoch();
    const before = close.mock.calls.length;
    const attempt = requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID);
    const session = fixture.session();
    const beforeCredentials = credentials();
    // Pre-listen classification already closed this attempt to ordinary reconnect.
    expect(beforeCredentials).toEqual({ attempt: 'revoked', unrelated: 'active' });

    // A consistent substitution after the maintenance decision reaches the Core closing transaction.
    const { closeRecovery } = boot.admittedNanoHostRecovery.value.owner;
    close.mockImplementationOnce(async (input) => {
      substituteNativeFinal(fixture, { sequence: SEQUENCE + 1 });
      return closeRecovery(input);
    });
    const refused = await runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, {
      ...ports,
      ...boot,
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect((refused as AggregateError).errors.map(String)).toEqual([
      'Error: NanoHost recovery has no matching Core close acknowledgement.',
    ]);
    expect(close).toHaveBeenCalledTimes(before + 1);
    expect(close.mock.calls[before]?.[0]).toMatchObject({ cause: 'native-liveness-expired' });
    await expect(close.mock.results[before]?.value).resolves.toMatchObject({
      state: 'unavailable',
    });
    expect(boot.cleanup).not.toHaveBeenCalled();
    expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)).toEqual(attempt);
    expect(fixture.session()).toEqual(session);
    expect(credentials()).toEqual(beforeCredentials);

    // The exact original pair returns. The next pass closes once, then hands off to first cleanup once.
    restoreNativeFinal(fixture, rows);
    expect(fixture.readback()).toEqual(native);
    await expect(
      runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot })
    ).rejects.toBeInstanceOf(AggregateError);
    expect(close).toHaveBeenCalledTimes(before + 2);
    await expect(close.mock.results[before + 1]?.value).resolves.toMatchObject({
      state: 'ready',
      value: { phase: 'closing', terminalCause: 'worker-final-status', fenceRef: null },
    });
    expect(boot.cleanup).toHaveBeenCalledTimes(1);
    expect(credentials()).toEqual({ attempt: 'revoked', unrelated: 'active' });
    expect(closeout).not.toHaveBeenCalled();
    expect(ports.cleanupBackendSession).not.toHaveBeenCalled();
    expect(fixture.finalSteps()).toEqual(steps);
    expect(fixture.exclusions()).toEqual(exclusions);
  });

  it('W18 queues no Harness inspection without the original peer Epoch, then completes a parked Worker retry once after readmission', async () => {
    const launch = await launchSettledTurn({ loseObservationAck: true, parkRetry: true });
    const { attemptId, entry, store } = launch;
    const restarted = await restartWithFencedTarget(launch, { offline: true });
    const { coreDb, closeout, native, recovery } = restarted;
    const durable = {
      turn: store.getTurnById(entry.turnId),
      phase: requireSchedulerExecutionAttempt(coreDb, attemptId).phase,
    };
    // The peer is fenced and its poller is away. Any Harness budget armed here would be recorded.
    const budgets = recordHarnessBudgets({ shorten: true });
    const held = await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery)
      .then(
        () => undefined,
        (error: unknown) => error
      )
      .finally(budgets.restore);
    expect(held).toBeInstanceOf(AggregateError);
    expect(budgets.armed).toEqual([]);
    expect(closeout).toHaveBeenCalledTimes(1);
    await expect(closeout.mock.results[0]!.value).rejects.toThrow(
      'NanoHost current physical Epoch authority is unavailable.'
    );
    expectDurableTurn(launch, coreDb, restarted.cold, durable);

    // The same peer returns with its physical Epoch. Its parked exact retry reaches the reopened gateway.
    restarted.reconnect();
    await readmitOriginalPeer(coreDb, native, attemptId);
    await expect(
      launch.retry!.deliver(createDefaultWorkerControlGateway(coreDb, undefined, native))
    ).resolves.toMatchObject({ accepted: true });
    expectDurableTurn(launch, coreDb, restarted.cold, durable);
    await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery);
    await expectCompletedOnce(launch, coreDb, restarted);
  });

  it('W23 preserves accepted-final recovery when the collection uncertainty ACK is lost', async () => {
    const launch = await launchSettledTurn({ loseObservationAck: true });
    const { attemptId, entry, store } = launch;
    const restarted = await restartWithFencedTarget(launch, { offline: true });
    const { coreDb, native, recovery, closeout } = restarted;
    const workspace = new FsStore({ dataRoot: launch.dataRoot });
    const durable = {
      turn: workspace.getTurnById(entry.turnId),
      phase: requireSchedulerExecutionAttempt(coreDb, attemptId).phase,
    };
    const exclusions = readExecutionJournalRoot(
      coreDb,
      launch.original.receipt.intent.target.execution
    ).exclusionRefs;
    const lostAck = new Error('Lost ACK after reopened collection settled unknown');
    let collectionStep: string | undefined;
    let dropped = false;
    const write = store.writeWorkspaceExecutionJournalIntent;
    const settle = store.settleWorkspaceExecutionJournalStep;
    store.writeWorkspaceExecutionJournalIntent = async (...args) => {
      const ack = await write.apply(store, args);
      if (args[1].carriage.operation === 'worker.collect.transcript')
        collectionStep = args[1].stepId;
      return ack;
    };
    store.settleWorkspaceExecutionJournalStep = async (...args) => {
      const ack = await settle.apply(store, args);
      if (!dropped && args[1].ref.stepId === collectionStep && args[1].state === 'unknown') {
        dropped = true;
        throw lostAck;
      }
      return ack;
    };
    try {
      await expect(runNanoHostAttemptRecoveryMaintenance(coreDb, recovery)).rejects.toBeInstanceOf(
        AggregateError
      );
    } finally {
      store.writeWorkspaceExecutionJournalIntent = write;
      store.settleWorkspaceExecutionJournalStep = settle;
    }
    expect(dropped).toBe(true);
    expect(new FsStore({ dataRoot: launch.dataRoot }).getTurnById(entry.turnId)).toEqual(
      durable.turn
    );
    expectDurableTurn(launch, coreDb, restarted.cold, durable);
    expect(
      readExecutionJournalRoot(coreDb, launch.original.receipt.intent.target.execution)
        .exclusionRefs
    ).toEqual(exclusions);
    expect(closeout).toHaveBeenCalledTimes(1);
    const error = await closeout.mock.results[0]!.value.catch((cause: unknown) => cause);
    const causes = causeChain(error);
    expect(causes).toContain(lostAck);
    expect(causes).toContainEqual(
      expect.objectContaining({
        message: 'NanoHost current physical Epoch authority is unavailable.',
      })
    );

    await readmitOriginalPeer(coreDb, native, attemptId);
    restarted.reconnect();
    await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery);
    await expectCompletedOnce(launch, coreDb, restarted);
    const reopened = new FsStore({ dataRoot: launch.dataRoot });
    expect(reopened.getTurnById(entry.turnId).status).toBe('completed');
    expect(
      reopened.getTurnEvents(entry.turnId).filter((event) => event.event === 'turn.completed')
    ).toHaveLength(1);
  });

  it('W20 settles an existing cleanup receipt after reconnect without reminting it', async () => {
    const fixture = await createFixture();
    await fixture.recordFinal();
    const clock = () => fixture.original.lease.grant.deadline;
    const ports = recoveryPorts(clock);
    await fixture.restart(ports, () =>
      bootSelection(
        fixture,
        vi.fn(async () => {})
      )
    );
    fixture.readyFreshEpoch();
    const owner = currentAdmittedTestNanoHostOwner(fixture.coreDb);
    if (!owner) throw new Error('The Native recovery owner is not admitted.');
    const original = readRetainedNanoHostSubmission(fixture.coreDb, ATTEMPT_ID)!;
    const read = () =>
      readAdmittedTestNanoHost(fixture.coreDb, (sqlite) => ({
        ...readNanoHostRecoveryLease(sqlite, original.lease),
        target: getNanoHostRuntimeTarget({ sqlite }, fixture.session().runtimeTargetId)!,
      }));
    const post = (
      stage:
        | { kind: 'finish-cleanup' }
        | { kind: 'transition'; toState: 'cleanup-pending' | 'physical-cleaned' }
    ) => {
      const { session, proof, target } = read();
      return owner.classifyRecovery({
        ...(stage.kind === 'transition' ? { ...stage, target } : stage),
        lease: original.lease,
        expectedSession: session,
        expectedRecovery: proof,
        observedAt: clock(),
      } as Parameters<typeof owner.classifyRecovery>[0]);
    };

    // A prior owner has already proved absence in a successor generation; only read it back here.
    await expect(post({ kind: 'transition', toState: 'cleanup-pending' })).resolves.toMatchObject({
      state: 'ready',
    });
    await expect(post({ kind: 'transition', toState: 'physical-cleaned' })).resolves.toMatchObject({
      state: 'ready',
    });
    const cleaned = read();
    expect(cleaned.proof.physicalCleanup).toMatchObject({
      observedAt: clock(),
      connectionGeneration: cleaned.target.connectionGeneration,
      physicalEpoch: cleaned.target.physicalEpoch,
    });
    expect(cleaned.target.connectionGeneration).toBeGreaterThan(
      Number(original.lease.grant.generation)
    );

    fixture.readyFreshEpoch();
    expect(read().target).toMatchObject({
      connectionGeneration: cleaned.target.connectionGeneration + 1,
      physicalEpoch: cleaned.target.physicalEpoch,
    });
    mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      sqlite.prepare('UPDATE nanohost_runtime_targets SET predecessor_fenced = 0').run()
    );
    await expect(post({ kind: 'finish-cleanup' })).resolves.toMatchObject({ state: 'unavailable' });
    expect(read().proof).toEqual(cleaned.proof);
    mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      sqlite.prepare('UPDATE nanohost_runtime_targets SET predecessor_fenced = 1').run()
    );
    mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      sqlite
        .prepare('UPDATE worker_backend_sessions SET origin_physical_epoch = ?')
        .run('c'.repeat(64))
    );
    await expect(post({ kind: 'finish-cleanup' })).resolves.toMatchObject({ state: 'unavailable' });
    expect(read().proof).toEqual(cleaned.proof);
    mutateAdmittedTestNanoHost(fixture.coreDb, (sqlite) =>
      sqlite
        .prepare('UPDATE worker_backend_sessions SET origin_physical_epoch = ?')
        .run(cleaned.session.originPhysicalEpoch)
    );
    await expect(post({ kind: 'finish-cleanup' })).resolves.toMatchObject({
      state: 'ready',
      value: { state: 'cleaned', physicalCleanedAt: clock() },
    });
    expect(read().proof).toEqual(cleaned.proof);
    expect(ports.cleanupBackendSession).not.toHaveBeenCalled();
  });

  it('W21 keeps capture unpublished when an absent final settles before the Workspace post', async () => {
    const launch = await admitLaunchedTurn();
    const { attemptId, entry, live, owned, store } = launch;
    const { coreDb } = owned;
    const client = getControlStoreWorkerClient();
    const finalStages = client as unknown as FinalStageClient;
    const originalStage = finalStages.workerControlFinalStage.bind(finalStages);
    let finalCommand: Parameters<AdmittedTestOwner['workerControlFinalStatus']>[0] | undefined;
    let withheld = 0;
    let allowNative = false;
    const stage = vi
      .spyOn(finalStages, 'workerControlFinalStage')
      .mockImplementation(async (db, command, input) => {
        if (input.kind === 'settle' && !allowNative) {
          finalCommand = command as typeof finalCommand;
          withheld++;
          throw new Error('Injected lost reply before Native final settlement.');
        }
        if (input.kind === 'observe') throw new Error('Injected loss before Core observation.');
        return originalStage(db, command, input);
      });
    onTestFinished(() => stage.mockRestore());
    live.executionFor(entry.turnId).completion.resolve();
    await vi.waitFor(() => expect(withheld).toBe(2));
    expect(executionSteps(coreDb, attemptId).at(-1)).toBe('worker-final-intake');
    const readback = () =>
      readAdmittedTestNanoHost(coreDb, (sqlite) =>
        inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, attemptId)
      );
    expect(readback()).toEqual({ state: 'held', reason: 'missing' });

    await live.restore();
    const { recovery, submit } = await coldRestartRecovery(launch);
    const { grant } = readRetainedNanoHostSubmission(coreDb, attemptId)!.lease;
    const input = { ...recovery, now: () => grant.deadline };
    const selection = input.admittedNanoHostRecovery;
    if (selection?.state !== 'ready' || !finalCommand)
      throw new Error('The original final and the Boot recovery owner are required.');
    const capture = await stagePendingTurnEndCapture(launch);
    const close = vi.spyOn(selection.value, 'close');
    const cleanup = vi.spyOn(selection.value, 'cleanup');
    const publish = client.workspaceCapture.bind(client);
    const command = finalCommand;
    const posting = vi.spyOn(client, 'workspaceCapture').mockImplementationOnce(async (...args) => {
      expect(args[1].action).toBe('recover');
      allowNative = true;
      await expect(selection.value.owner.workerControlFinalStatus(command)).rejects.toThrow(
        'Injected loss before Core observation.'
      );
      expect(readback()).toMatchObject({ state: 'native-only' });
      return publish(...args);
    });
    const refusal = await runNanoHostAttemptRecoveryMaintenance(coreDb, input)
      .then(
        () => undefined,
        (error: unknown) => error
      )
      .finally(() => posting.mockRestore());
    expect(capture.publications()).toEqual([]);
    expect(capture.preserved()).toBe(true);
    expect(causeChain(refusal).map(String)).toContain(
      'Error: Workspace capture final proof changed before publication.'
    );
    expect(close).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(store.getTurnById(entry.turnId).status).toBe('running');

    const commitClose = selection.value.owner.closeRecovery;
    close.mockImplementationOnce(async (proposal) => {
      expect(capture.publications()).toEqual([]);
      expect(cleanup).not.toHaveBeenCalled();
      const acknowledgement = await commitClose(proposal);
      expect(capture.publications()).toEqual([]);
      expect(cleanup).not.toHaveBeenCalled();
      return acknowledgement;
    });
    await expect(runNanoHostAttemptRecoveryMaintenance(coreDb, input)).rejects.toBeInstanceOf(
      AggregateError
    );
    expect(close).toHaveBeenCalledOnce();
    await expect(close.mock.results[0]?.value).resolves.toMatchObject({
      state: 'ready',
      value: { phase: 'closing', terminalCause: 'worker-final-status' },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(capture.publications()).toEqual([]);
    expect(capture.preserved()).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  }, 120_000);

  it('W22 holds one unavailable pre-queue authority read and finishes the original Turn on retry', async () => {
    const launch = await launchSettledTurn({ loseObservationAck: true });
    const { attemptId, entry, store } = launch;
    const restarted = await restartWithFencedTarget(launch, { offline: false });
    const { coreDb, cold, native, recovery } = restarted;
    await readmitOriginalPeer(coreDb, native, attemptId);
    const durable = {
      turn: store.getTurnById(entry.turnId),
      phase: requireSchedulerExecutionAttempt(coreDb, attemptId).phase,
    };
    const exclusions = () =>
      readExecutionJournalRoot(coreDb, launch.original.grant.execution).exclusionRefs;
    const before = exclusions();
    const backend = (
      cold.runtime.turnExecutor as unknown as {
        backend: { nanoHostOwner: { value: AdmittedTestOwner } };
      }
    ).backend;
    const owner = backend.nanoHostOwner.value;
    const readNative = owner.read.bind(owner);
    let faults = 0;
    const fault = vi.spyOn(owner, 'read').mockImplementation((query) => {
      const stack = new Error().stack;
      if (
        faults === 0 &&
        stack?.includes('requireCurrentBackendPhysicalEpoch') &&
        stack.includes('inspectTerminalHarnessSession')
      ) {
        faults++;
        return { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' };
      }
      return readNative(query);
    });
    const held = await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery)
      .then(
        () => undefined,
        (error: unknown) => error
      )
      .finally(() => fault.mockRestore());
    expect(faults).toBe(1);
    expectDurableTurn(launch, coreDb, cold, durable);
    expect(exclusions()).toEqual(before);
    expect(held).toBeInstanceOf(AggregateError);
    await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery);
    await expectCompletedOnce(launch, coreDb, restarted);
  }, 120_000);

  it('W19 holds the Turn while a readmitted peer leaves the inspection unanswered past the real 5-minute budget', async () => {
    const launch = await launchSettledTurn({ loseObservationAck: true });
    const { attemptId, entry, store } = launch;
    const restarted = await restartWithFencedTarget(launch, { offline: true });
    const { coreDb, closeout, native, recovery } = restarted;
    await readmitOriginalPeer(coreDb, native, attemptId);
    const durable = {
      turn: store.getTurnById(entry.turnId),
      phase: requireSchedulerExecutionAttempt(coreDb, attemptId).phase,
    };
    const slot = () =>
      readAdmittedTestNanoHost(coreDb, (sqlite) =>
        sqlite
          .prepare(`SELECT lifecycle_state, drain_state, operation_state, next_sequence,
        result_json, result_fingerprint FROM harness_instance_records`)
          .get()
      );
    const predecessor = slot() as Record<string, unknown>;
    // The readmitted peer's poller stays away. The inspection waits for its real budget.
    const budgets = recordHarnessBudgets({ shorten: false });
    const started = performance.now();
    const held = await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery)
      .then(
        () => undefined,
        (error: unknown) => error
      )
      .finally(budgets.restore);
    const elapsed = performance.now() - started;
    expect(budgets.armed).toHaveLength(1);
    expect(budgets.armed[0]).toBeGreaterThan(299_000);
    expect(elapsed).toBeGreaterThanOrEqual(budgets.armed[0]!);
    expect(held).toBeInstanceOf(AggregateError);
    expect(closeout).toHaveBeenCalledTimes(1);
    const timeout = await closeout.mock.results[0]!.value.then(
      () => undefined,
      (error: unknown) => error
    );
    expect(causeChain(timeout).some((cause) => cause instanceof NanoHostHarnessOutageError)).toBe(
      true
    );
    expectDurableTurn(launch, coreDb, restarted.cold, durable);

    // Only the undispatched inspection was withdrawn. The original receipt and occupancy survive.
    expect(slot()).toEqual({ ...predecessor, operation_state: 'idle' });

    // The poller returns. The same closeout finishes the Turn once.
    restarted.reconnect();
    await runNanoHostAttemptRecoveryMaintenance(coreDb, recovery);
    await expectCompletedOnce(launch, coreDb, restarted);
  }, 420_000);
});
