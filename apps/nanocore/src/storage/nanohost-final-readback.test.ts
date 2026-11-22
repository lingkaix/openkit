import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { canonicalJsonText, workspaceIdForOwner } from '@openkit/protocol';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  closeSchedulerExecutionAttemptWithFence,
  listOpenSchedulerExecutionAttempts,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import { readExecutionJournalRoot } from '../runtime/execution-journal.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  type RunNanoHostAttemptRecoveryInput,
  runNanoHostAttemptRecoveryMaintenance,
} from '../runtime/nanohost-attempt-recovery.js';
import { runSchedulerRestartRecovery } from '../runtime/scheduler-restart-recovery.js';
import {
  getWorkerBackendSession,
  type WorkerBackendSessionRecord,
} from '../runtime/worker-backend-session-records.js';
import {
  hashWorkerRouteToken,
  WorkerControlGatewayError,
  type WorkerControlLineage,
} from '../runtime/worker-control-gateway.js';
import type { WorkerGovernanceBackend } from '../runtime/worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from '../runtime/worker-governance-turn-executor.js';
import {
  mutateAdmittedTestNanoHost,
  openAdmittedTestNanoHost,
  readAdmittedTestNanoHost,
  reopenAdmittedTestNanoHost,
} from '../test-support/admitted-nanohost.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { testBootNanoHostRecovery } from '../test-support/boot-nanohost-recovery.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { submitTestNanoHostWorkerLease } from '../test-support/nanohost-worker-lease.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createTestQueueEntry } from '../test-support/scheduler-admissions.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  inspectAcceptedNanoHostFinalInDb,
  type NanoHostAcceptedFinalCommitment,
} from './core-journal-native.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { readRetainedNanoHostSubmission } from './nanohost-submitted-lease.js';
import { transitionAdmittedNanoHostRuntimeTarget } from './nanohost-transport-owner.js';
import { nativeProductScope } from './workspace-file-records.js';

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
    /** Commits the whole original final, then loses its acknowledgement before the live waiter. */
    loseFinalAcknowledgement() {
      const { owner } = nativeStorage.value;
      const original = owner.workerControlFinalStatus.bind(owner);
      return vi.spyOn(owner, 'workerControlFinalStatus').mockImplementation(async (input) => {
        await original(input);
        throw new Error('Injected lost final acknowledgement.');
      });
    },
    /**
     * Reopens both owners in index.ts order: Core and the Native owner, the Epoch fence, then the
     * scheduler and Native restart classification. The original process state is gone.
     */
    async restart(input: RunNanoHostAttemptRecoveryInput) {
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
      await runSchedulerRestartRecovery(coreDb, input);
      await classifyNanoHostAttemptsAfterRestart(coreDb, input);
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

describe('K8b accepted-final readback', () => {
  afterEach(() => vi.useRealTimers());

  it('W1 closes the original Turn once from the original receipt after a lost observation ACK', async () => {
    const fixture = await createFixture();
    const lost = fixture.loseFinalAcknowledgement();
    await expect(fixture.recordFinal()).rejects.toThrow();
    lost.mockRestore();
    const observed = fixture.readback();
    expect(observed).toMatchObject({ state: 'settled', sequence: SEQUENCE });
    const steps = fixture.finalSteps();
    // The intake step and the settled observation receipt, keyed by its deterministic request.
    expect(steps.map(({ stepId }) => stepId)).toEqual([
      'worker-route-fixture-submit',
      'worker-final-intake',
      observed.state === 'settled' ? observed.receipt.intent.requestId : 'absent',
    ]);
    const dispatch = fixture.dispatchState();
    const ports = recoveryPorts(() => new Date().toISOString());
    await fixture.restart(ports);
    // The closeout owner keeps the original physical cleanup, so the idle-binding scan defers to it.
    ports.prepareBackendCleanup.mockReturnValue(true);
    const commitments: NanoHostAcceptedFinalCommitment[] = [];
    const closeout = vi.fn(
      async (session: WorkerBackendSessionRecord, commitment: NanoHostAcceptedFinalCommitment) => {
        commitments.push(commitment);
        // The modeled release proof stands in for collection and publication; the attempt closes once.
        closeSchedulerExecutionAttemptWithFence(fixture.coreDb, {
          correlation: schedulerExecutionCorrelation(
            requireSchedulerExecutionAttempt(fixture.coreDb, session.attemptId)
          ),
          fenceRef: 'fence:final-readback-release',
          proof: {
            terminalHandoff: true,
            output: true,
            evidence: true,
            outsideWorkspaceCollection: true,
            integrationDrain: true,
            routesRevoked: true,
          },
        });
      }
    );
    const boot = bootSelection(fixture, closeout);
    // A live closeout of the same Turn keeps the existing active-Turn guard: no second closeout.
    await runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, {
      ...ports,
      ...boot,
      isTurnExecutionActive: () => true,
    });
    expect(closeout).not.toHaveBeenCalled();
    await runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot });

    expect(closeout).toHaveBeenCalledTimes(1);
    expect(
      listOpenSchedulerExecutionAttempts(fixture.coreDb).map(({ attemptId }) => attemptId)
    ).not.toContain(ATTEMPT_ID);
    expect(commitments[0]).toEqual(observed);
    expect(commitments[0]).toMatchObject({
      sequence: SEQUENCE,
      acceptedAt: fixture.now,
      eventAcceptedAt: fixture.now,
      receipt: { disposition: 'applied' },
    });
    expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID).phase).toBe('closed');
    expect(fixture.finalSteps()).toEqual(steps);
    expect(boot.cleanup).not.toHaveBeenCalled();
    expect(ports.cleanupBackendSession).not.toHaveBeenCalled();
    expect(ports.executionBackend.submit).not.toHaveBeenCalled();
    expect(fixture.dispatchState()).toEqual({
      ...dispatch,
      attempts: [{ attempt_id: ATTEMPT_ID, phase: 'closed' }],
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

  it('W3 leaves a Native-only final at the original deadline through closing and the first-cleanup hold', async () => {
    const fixture = await createFixture();
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
    await fixture.restart(ports);
    fixture.readyFreshEpoch();
    const closeout = vi.fn(async () => {});
    const boot = bootSelection(fixture, closeout);

    // No Worker returns. Before the original absolute deadline the Native-only final waits.
    await runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot });
    expect(boot.cleanup).not.toHaveBeenCalled();
    expect(fixture.session().state).toBe('launching');

    // The first pass at the deadline closes, keeps the first cause and hands off to first cleanup.
    clock = deadline;
    await expect(
      runNanoHostAttemptRecoveryMaintenance(fixture.coreDb, { ...ports, ...boot })
    ).rejects.toThrow('Native attempt recovery failed.');
    expect(requireSchedulerExecutionAttempt(fixture.coreDb, ATTEMPT_ID)).toMatchObject({
      phase: 'closing',
      terminalCause: 'worker-final-status',
      fenceRef: null,
    });
    expectRoutesRevoked(fixture);
    expect(boot.cleanup).toHaveBeenCalledTimes(1);
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
});
