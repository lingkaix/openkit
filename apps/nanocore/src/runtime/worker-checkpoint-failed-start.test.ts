import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { deriveEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerInputWithKnowledgeOverview } from '../context/worker-overview-input.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { commandRequestKey, FsStore } from '../lib/store.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from '../mode-entry-routes.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { requireSchedulerExecutionAttempt } from './execution-attempt-records.js';
import { createNanoHostHarnessRuntime } from './nanohost-harness-records.js';
import { getSchedulerPreparationClaims } from './scheduler-dispatch-loop.js';
import {
  getWorkerBackendSession,
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions.js';
import { getWorkerCheckpoint, listExportableWorkerCheckpoints } from './worker-checkpoints.js';
import type { WorkerGovernanceBackend } from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import {
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
} from './workspace-sync-records.js';

/** Captures exact retained JSON and JSONL file bytes, complementing the SQLite byte oracle. */
function retainedFileBytes(dataRoot: string) {
  return readdirSync(dataRoot, { recursive: true })
    .filter((path) => typeof path === 'string' && /\.jsonl?$/.test(path))
    .sort()
    .map((path) => [path, readFileSync(join(dataRoot, path), 'base64')]);
}

/** Refuses one actual SQLite mutation; the native savepoint must roll back its whole transition. */
function refuseNativeWrite(workspaceDb: WorkspaceDb, edge: string) {
  workspaceDb.sqlite.exec(
    `CREATE TRIGGER failed_start_native_refusal ${edge} BEGIN SELECT RAISE(ABORT, 'Controlled native publication rollback.'); END`
  );
  return () => workspaceDb.sqlite.exec('DROP TRIGGER failed_start_native_refusal');
}

/** Captures exact SQL payloads for every member of the local terminal transition. */
function nativeTerminalRows(workspaceDb: WorkspaceDb) {
  return Object.fromEntries(
    [
      'control_turns',
      'control_agent_sessions',
      'control_product_entries',
      'control_work_observations',
      'task_turn_terminal_facts',
      'control_executions',
      'control_execution_steps',
      'runtime_evidence',
      'idempotency_requests',
      'audit_events',
    ].map((table) => [
      table,
      workspaceDb.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ])
  );
}

/** Runs the real executor through its post-binding failure, rolling back native publication before restart. */
async function failedStart(entry: 'conversation' | 'direct', provenance = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-d8-checkpoint-'));
  let coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  let store: FsStore = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const target = recordTestNativeRuntimeTarget(coreDb);
  const execution = new SimulatedTurnExecutor({ coreDb });
  const materialized = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const backend: WorkerGovernanceBackend = {
    id: execution.id,
    submit: vi.fn((input) => execution.submit(input)),
    inspect: (input) => execution.inspect(input),
    cancel: (input) => execution.cancel(input),
    release: vi.fn((input) => execution.release(input)),
    prepareLaunch: async () => undefined,
    describeCapabilities: async () => ({
      capabilities: [
        'container',
        'transcript-sink',
        'worker-control',
        'worker.runtime-provenance.v1',
        'trusted-worker-inference-relay',
      ],
      dynamicCapabilities: [],
      kind: 'openshell',
      version: 'test',
    }),
    validatePackage: async () => [],
    planSession: (pkg) => ({
      agentSessionId: pkg.scope.agentSessionId,
      backendKind: 'openshell',
      backendSessionId: `unused_${pkg.snapshotId}`,
      deploymentId: target.deploymentId,
      packageSnapshotId: pkg.snapshotId,
      runtimeTargetId: target.targetId,
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${pkg.snapshotId}`,
      transientProviderInstanceId: null,
    }),
    prepareAgentSessionContinuity: async () => 'absent',
    materialize: async (_pkg, context) => {
      await context!.beforeMaterialization!();
      materialized.resolve();
      await fail.promise;
      throw new Error('Controlled post-binding pre-operation failure.');
    },
    // Interrupt physical cleanup too; the later orphan cleanup observation below supplies only physical absence.
    cleanupSession: async () => {
      throw new Error('Controlled cleanup interruption.');
    },
    update: async () => [],
    collectEvidence: async () => [],
    collectTranscript: async () => ({ itemsJsonl: '' }),
    collectWorkspaceChanges: async () => [],
  };
  const executor = new WorkerGovernanceTurnExecutor({
    fileAdmission: new FileStorageAdmission(coreDb.dataRoot, () => 0n),
    backend,
    coreDb,
  });
  const setup = createTestAgentSetup({
    requiredCapabilities: provenance ? ['worker.runtime-provenance.v1'] : [],
  });
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    turnExecutor: executor,
    agentManifests: [setup.manifest],
    openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
  });
  const requestId = '0190f4c8-0000-7000-8000-000000000998';
  const request = () =>
    app.request(
      ...operationRequest(
        entry === 'direct' ? 'task.start' : 'conversation.submit',
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        },
        {
          body: JSON.stringify({
            requestId,
            input: 'Implement a focused change and run its tests.',
            ...(entry === 'conversation' ? { targetRef: 'new-task-worker', artifactRefs: [] } : {}),
          }),
        }
      )
    );
  const accepted = await request();
  expect(accepted.status, await accepted.clone().text()).toBe(202);
  const body = await accepted.json();
  const turnId = body.turn.id as string;
  await materialized.promise;
  const publicationDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  // This late journal write follows all local terminal products inside the same native transaction.
  const removeRefusal = refuseNativeWrite(
    publicationDb,
    `BEFORE UPDATE OF phase ON control_executions WHEN NEW.work_id = '${turnId}' AND NEW.phase = 'closing'`
  );
  const client = getControlStoreWorkerClient();
  const terminal = client.terminal.bind(client);
  let nativeRefusals = 0;
  const publication = vi.spyOn(client, 'terminal').mockImplementation(async (database, input) => {
    try {
      return await terminal(database, input);
    } catch (error) {
      if (database === `workspace:${publicationDb.sqlite.name}`) {
        expect(error).toMatchObject({ code: 'constraint', commit: 'not-committed' });
        nativeRefusals++;
      }
      throw error;
    }
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const claims = getSchedulerPreparationClaims(coreDb);
    const admission = coreDb.sqlite
      .prepare('SELECT queue_entry_id AS id FROM scheduler_admission_entries WHERE turn_id = ?')
      .get(turnId) as { id: string };
    // Capture the live invocation before releasing materialization; it joins full scheduler closeout.
    const dispatch = claims.get(admission.id);
    fail.resolve();
    expect(dispatch).toBeDefined();
    await expect(dispatch).rejects.toBeInstanceOf(AggregateError);
    expect(executor.isTurnExecutionActive(turnId)).toBe(false);
    expect(claims.has(admission.id)).toBe(false);
    expect(nativeRefusals).toBeGreaterThan(0);
    expect(store.getTurnEvents(turnId).filter((event) => event.event === 'turn.completed')).toEqual(
      []
    );
    expect(
      publicationDb.sqlite
        .prepare('SELECT phase FROM control_executions WHERE work_id = ?')
        .all(turnId)
    ).toEqual([{ phase: 'open' }]);
    expect(
      publicationDb.sqlite
        .prepare('SELECT * FROM task_turn_terminal_facts WHERE turn_id = ?')
        .all(turnId)
    ).toEqual([]);
    expect(
      publicationDb.sqlite
        .prepare(
          "SELECT * FROM control_work_observations WHERE turn_id = ? AND json_extract(record_json, '$.type') = 'turn.reap'"
        )
        .all(turnId)
    ).toEqual([]);
  } finally {
    publication.mockRestore();
    log.mockRestore();
    removeRefusal();
    publicationDb.sqlite.close();
  }
  const attemptRow = coreDb.sqlite
    .prepare('SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE turn_id = ?')
    .get(turnId) as { id: string };
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptRow.id);
  expect(attempt).toMatchObject({
    phase: 'closed',
    disposition: 'not_accepted',
    terminalCause: 'turn-start-failed',
    operationId: null,
    deadline: null,
    outcomeRef: null,
    fenceRef: null,
  });
  const anchor = getWorkerBackendSession(coreDb, attempt.attemptId)!;
  for (const state of ['cleanup-pending', 'physical-cleaned', 'cleaned'] as const) {
    const current = getWorkerBackendSession(coreDb, attempt.attemptId)!;
    if (current.state !== state)
      transitionWorkerBackendSessionState(coreDb, {
        attemptId: attempt.attemptId,
        fromState: current.state,
        toState: state,
      });
  }
  expect(getWorkerBackendSession(coreDb, attempt.attemptId)!.workspaceHandoffState).toBe('pending');
  expect(store.getTurnById(turnId).status).toBe('running');
  expect(store.getAgentSession(attempt.agentSessionId!).status).toBe('created');
  await shutdownControlStoreWorkerClient();
  coreDb.sqlite.close();
  coreDb = openCoreDb(dataRoot);
  store = new FsStore({ dataRoot });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  const checkpoint = getWorkerCheckpoint(
    workspaceDb,
    'ws_00000000-0000-7000-8000-000000000001',
    anchor.threadId,
    turnId
  )!;
  expect(checkpoint).toMatchObject({ stage: 'running_worker', stopReason: null, iteration: 0 });
  const classify = () =>
    classifyDirectTaskCheckpointAfterSchedulerRecovery({
      coreDb,
      store,
      workspaceDb,
      checkpoint:
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          anchor.threadId,
          turnId
        ) ?? checkpoint,
    });
  const pkg = requireAgentEnvironmentPackageSnapshot(
    workspaceDb,
    'ws_00000000-0000-7000-8000-000000000001',
    attempt.inputRef!
  );
  const restartedExecutor = new WorkerGovernanceTurnExecutor({
    fileAdmission: new FileStorageAdmission(coreDb.dataRoot, () => 0n),
    backend,
    coreDb,
  });
  const restartedApp = createApp({
    coreDb,
    dataRoot,
    store,
    turnExecutor: restartedExecutor,
    agentManifests: [setup.manifest],
    openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
  });
  const replay = () =>
    restartedApp.request(
      ...operationRequest(
        entry === 'direct' ? 'task.start' : 'conversation.submit',
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        },
        {
          body: JSON.stringify({
            requestId,
            input: 'Implement a focused change and run its tests.',
            ...(entry === 'conversation' ? { targetRef: 'new-task-worker', artifactRefs: [] } : {}),
          }),
        }
      )
    );
  const fresh = async () => {
    const response = await restartedApp.request(
      ...operationRequest(
        'task.start',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', threadId: anchor.threadId },
        {
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000999',
            input: 'Start independent work after the failed Turn.',
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(202);
    const accepted = await response.json();
    await vi.waitFor(() =>
      expect(restartedExecutor.isTurnExecutionActive(accepted.turn.id)).toBe(false)
    );
    await setImmediate();
  };
  return {
    coreDb,
    workspaceDb,
    store,
    checkpoint,
    classify,
    replay,
    fresh,
    attempt,
    pkg,
    backend,
    dataRoot,
    turnId,
    cleanup: async () => {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

describe('checkpoint-owned never-submitted failed start', () => {
  it('settles with an earlier proved busy refusal at the same creation timestamp', async () => {
    const f = await failedStart('conversation', true);
    try {
      const row = f.coreDb.sqlite
        .prepare('SELECT rowid, * FROM scheduler_execution_attempts WHERE attempt_id = ?')
        .get(f.attempt.attemptId) as Record<string, unknown>;
      row.rowid = Number(row.rowid) - 1;
      row.attempt_id = testEntityId('attempt', 'earlier-busy-attempt');
      row.terminal_cause = 'backend-busy';
      row.agent_session_id = null;
      row.input_ref = null;
      row.binding_ref = null;
      f.coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_execution_attempts (${Object.keys(row).join(',')}) VALUES (${Object.keys(
            row
          )
            .map(() => '?')
            .join(',')})`
        )
        .run(...Object.values(row));
      expect((f.pkg.snapshot.extensions.openkit as { turnInput: string }).turnInput).toBe(
        workerInputWithKnowledgeOverview(
          f.store.getTurnById(f.turnId).items.find((item) => item.type === 'user-message')!.text,
          f.attempt.agentSessionId!
        )
      );
      const core = f.coreDb.sqlite.serialize();
      await expect(f.classify()).resolves.toBe('complete');
      expect(f.store.getTurnById(f.turnId).status).toBe('failed');
      expect(f.store.getAgentSession(f.attempt.agentSessionId!).status).toBe('failed');
      expect(
        getWorkerCheckpoint(
          f.workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          f.checkpoint.threadId,
          f.turnId
        )
      ).toBeNull();
      expect(f.coreDb.sqlite.serialize().equals(core)).toBe(true);
      expect(f.backend.submit).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  // Real database setup, restart and byte comparisons share this fixture budget, not a product deadline.
  it.each([
    { entry: 'conversation', provenance: false },
    { entry: 'direct', provenance: false },
    { entry: 'conversation', provenance: true },
    { entry: 'direct', provenance: true },
  ] as const)('settles the original $entry tuple after executor publication interruption and restart (provenance=$provenance)', async ({
    entry,
    provenance,
  }) => {
    const f = await failedStart(entry, provenance);
    expect(Boolean(f.pkg.snapshot.control.transcript?.runtimeProvenance)).toBe(provenance);
    try {
      const coreBytes = f.coreDb.sqlite.serialize();
      const originalInput = f.store
        .getTurnById(f.turnId)
        .items.find((item) => item.type === 'user-message');
      const receipts = JSON.stringify(f.store.listCommandRequests());
      const runtimeEvidence = JSON.stringify({
        evidence: f.workspaceDb.sqlite.prepare('SELECT * FROM evidence_bundles').all(),
        runtime: f.workspaceDb.sqlite
          .prepare("SELECT * FROM runtime_evidence WHERE phase <> 'checkpoint'")
          .all(),
      });
      const owners = JSON.stringify({
        attempt: f.coreDb.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').all(),
        anchor: f.coreDb.sqlite.prepare('SELECT * FROM worker_backend_sessions').all(),
        package: readFileSync(
          join(
            dirname(dirname(f.workspaceDb.sqlite.name)),
            'runtime/agent-sessions',
            f.attempt.agentSessionId!,
            'aep-snapshots',
            `${f.attempt.inputRef}.json`
          ),
          'utf8'
        ),
      });
      let failure: unknown;
      try {
        if (provenance) {
          const response = await f.replay();
          expect(response.status, await response.clone().text()).toBe(202);
        } else await f.classify();
      } catch (error) {
        failure = error;
      }
      expect(f.store.getTurnById(f.turnId).status, String(failure)).toBe('failed');
      expect(f.store.getAgentSession(f.attempt.agentSessionId!).status).toBe('failed');
      expect(
        getWorkerCheckpoint(
          f.workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          f.checkpoint.threadId,
          f.turnId
        )
      ).toBeNull();
      const events = f.store.getTurnEvents(f.turnId);
      expect(events.filter((event) => event.event === 'turn.completed')).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.event === 'agent.session.updated' &&
            event.data.type === 'agent-session-updated' &&
            event.data.agentSession.status === 'failed'
        )
      ).toHaveLength(1);
      expect(
        JSON.stringify({
          attempt: f.coreDb.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').all(),
          anchor: f.coreDb.sqlite.prepare('SELECT * FROM worker_backend_sessions').all(),
          package: readFileSync(
            join(
              dirname(dirname(f.workspaceDb.sqlite.name)),
              'runtime/agent-sessions',
              f.attempt.agentSessionId!,
              'aep-snapshots',
              `${f.attempt.inputRef}.json`
            ),
            'utf8'
          ),
        })
      ).toBe(owners);
      expect(f.coreDb.sqlite.serialize().equals(coreBytes)).toBe(true);
      expect(
        f.store.getTurnById(f.turnId).items.find((item) => item.type === 'user-message')
      ).toEqual(originalInput);
      expect(JSON.stringify(f.store.listCommandRequests())).toBe(receipts);
      expect(
        JSON.stringify({
          evidence: f.workspaceDb.sqlite.prepare('SELECT * FROM evidence_bundles').all(),
          runtime: f.workspaceDb.sqlite
            .prepare("SELECT * FROM runtime_evidence WHERE phase <> 'checkpoint'")
            .all(),
        })
      ).toBe(runtimeEvidence);
      // Ordinary Task closeout records real Core checkpoint evidence; it supplies no Worker transcript or provenance.
      expect(
        f.workspaceDb.sqlite
          .prepare(
            "SELECT outcome, stop_reason FROM runtime_evidence WHERE phase = 'checkpoint' AND turn_id = ?"
          )
          .all(f.turnId)
      ).toEqual([{ outcome: 'failed', stop_reason: 'error' }]);
      expect(f.store.getTurnById(f.turnId).error?.code).toBe('worker_governance_turn_failed');
      const settled = JSON.stringify(f.store.getTurnEvents(f.turnId));
      for (let pass = 0; pass < 3; pass++) {
        for (const checkpoint of listExportableWorkerCheckpoints(
          f.workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001'
        ))
          await classifyDirectTaskCheckpointAfterSchedulerRecovery({ ...f, checkpoint });
        const replay = await f.replay();
        expect(replay.status, await replay.clone().text()).toBe(202);
        expect((await replay.json()).turn).toMatchObject({ id: f.turnId, status: 'failed' });
      }
      expect(JSON.stringify(f.store.getTurnEvents(f.turnId))).toBe(settled);
      expect(
        f.store.listCommandRequests().filter((receipt) => receipt.command === 'task.start')
      ).toHaveLength(entry === 'direct' ? 1 : 0);
      expect(f.backend.submit).not.toHaveBeenCalled();
      expect(f.backend.release).not.toHaveBeenCalled();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await f.fresh();
      } finally {
        log.mockRestore();
      }
      expect(f.backend.submit).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  }, 60_000);

  it.each(
    (['conversation', 'direct'] as const).flatMap((entry) =>
      [
        'turn-only',
        'session-only',
        'terminal-event',
        'session-event',
        ...(entry === 'direct' ? ['receipt-write'] : ['item-write']),
      ].map((partial) => ({ entry, partial }))
    )
  )('keeps atomic $entry $partial publication and retries without replacing decided bytes', async ({
    entry,
    partial,
  }) => {
    const f = await failedStart(entry, true);
    const beforeEvents = f.store.getTurnEvents(f.turnId);
    try {
      const terminalize = async () =>
        await terminalizeGovernedWorkerTurn({
          store: f.store,
          turnId: f.turnId,
          agentSessionId: f.attempt.agentSessionId,
          requestId: f.checkpoint.requestId,
          completedAt: new Date().toISOString(),
          outcome: 'failed',
          errorCode: 'worker_governance_turn_failed',
          message: 'The worker attempt failed to start.',
        });
      if (partial === 'receipt-write') {
        f.workspaceDb.sqlite
          .prepare("DELETE FROM idempotency_requests WHERE command_name = 'task.start'")
          .run();
        const removeRefusal = refuseNativeWrite(
          f.workspaceDb,
          "BEFORE INSERT ON idempotency_requests WHEN NEW.command_name = 'task.start'"
        );
        try {
          await expect(f.classify()).rejects.toMatchObject({
            code: 'constraint',
            commit: 'not-committed',
          });
        } finally {
          removeRefusal();
        }
        expect(
          getWorkerCheckpoint(
            f.workspaceDb,
            'ws_00000000-0000-7000-8000-000000000001',
            f.checkpoint.threadId,
            f.turnId
          )
        ).toMatchObject({ stage: 'failed', stopReason: 'error' });
        expect(
          f.store.listCommandRequests().filter((receipt) => receipt.command === 'task.start')
        ).toEqual([]);
      } else if (partial === 'item-write') {
        const resultId = deriveEntityId('it', ['worker-result', f.turnId]);
        const result = f.store.getTurnById(f.turnId).items.find((item) => item.id === resultId);
        const removeRefusal = refuseNativeWrite(
          f.workspaceDb,
          `BEFORE INSERT ON control_product_entries WHEN NEW.kind = 'item' AND NEW.id = '${resultId}'`
        );
        try {
          await expect(f.classify()).rejects.toMatchObject({
            code: 'constraint',
            commit: 'not-committed',
          });
        } finally {
          removeRefusal();
        }
        expect(f.store.getTurnById(f.turnId).items.find((item) => item.id === resultId)).toEqual(
          result
        );
        expect(
          getWorkerCheckpoint(
            f.workspaceDb,
            'ws_00000000-0000-7000-8000-000000000001',
            f.checkpoint.threadId,
            f.turnId
          )
        ).not.toBeNull();
      } else if (partial === 'terminal-event') {
        // Both terminal events share the commit. Lose the native result at its caller boundary,
        // not a post-COMMIT observer notification, then inspect that exact committed identity.
        const originalExclusion = f.workspaceDb.sqlite
          .prepare('SELECT exclusion_refs_json FROM control_executions WHERE work_id = ?')
          .get(f.turnId);
        const originalRelease = f.workspaceDb.sqlite
          .prepare(
            "SELECT * FROM control_execution_steps WHERE json_extract(control_json, '$.workId') = ? AND json_extract(control_json, '$.kind') = 'release'"
          )
          .all(f.turnId);
        expect(originalExclusion).not.toEqual({ exclusion_refs_json: '[]' });
        expect(originalRelease).toEqual([expect.objectContaining({ state: 'intent' })]);
        const client = getControlStoreWorkerClient();
        const terminal = client.terminal.bind(client);
        let lostAcknowledgements = 0;
        const acknowledgement = vi
          .spyOn(client, 'terminal')
          .mockImplementation(async (database, input) => {
            const result = await terminal(database, input);
            if (database === `workspace:${f.workspaceDb.sqlite.name}`) {
              lostAcknowledgements++;
              throw new ControlStoreWorkerError('unavailable', 'unknown');
            }
            return result;
          });
        try {
          await expect(terminalize()).rejects.toMatchObject({
            errors: [expect.objectContaining({ commit: 'unknown' })],
          });
          expect(lostAcknowledgements).toBe(1);
        } finally {
          acknowledgement.mockRestore();
        }
        expect(f.store.getTurnById(f.turnId).status).toBe('failed');
        expect(f.store.getAgentSession(f.attempt.agentSessionId!).status).toBe('failed');
        expect(
          f.store.getTurnEvents(f.turnId).filter((event) => event.event === 'turn.completed')
        ).toHaveLength(1);
        expect(
          f.store
            .getTurnEvents(f.turnId)
            .filter(
              (event) =>
                event.data.type === 'agent-session-updated' &&
                event.data.agentSession.status === 'failed'
            )
        ).toHaveLength(1);
        expect(
          f.workspaceDb.sqlite
            .prepare('SELECT phase FROM control_executions WHERE work_id = ?')
            .all(f.turnId)
        ).toEqual([{ phase: 'closing' }]);
        expect(
          f.workspaceDb.sqlite
            .prepare('SELECT exclusion_refs_json FROM control_executions WHERE work_id = ?')
            .get(f.turnId)
        ).toEqual(originalExclusion);
        expect(
          f.workspaceDb.sqlite
            .prepare(
              "SELECT * FROM control_execution_steps WHERE json_extract(control_json, '$.workId') = ? AND json_extract(control_json, '$.kind') = 'release'"
            )
            .all(f.turnId)
        ).toEqual(originalRelease);
      } else {
        // These historical partial-write windows now prove that one SQL refusal leaves no local terminal member.
        const before = nativeTerminalRows(f.workspaceDb);
        const edge =
          partial === 'turn-only'
            ? `BEFORE UPDATE OF status ON control_agent_sessions WHEN NEW.id = '${f.attempt.agentSessionId}' AND NEW.status = 'failed'`
            : partial === 'session-only'
              ? `BEFORE UPDATE OF status ON control_turns WHEN NEW.id = '${f.turnId}' AND NEW.status = 'failed'`
              : `BEFORE INSERT ON control_product_entries WHEN NEW.turn_id = '${f.turnId}' AND NEW.kind = 'event' AND NEW.sequence = ${(beforeEvents.at(-1)?.sequence ?? 0) + 1}`;
        const removeRefusal = refuseNativeWrite(f.workspaceDb, edge);
        try {
          await expect(terminalize()).rejects.toMatchObject({
            errors: [expect.objectContaining({ code: 'constraint', commit: 'not-committed' })],
          });
          expect(nativeTerminalRows(f.workspaceDb)).toEqual(before);
          expect(f.store.getTurnById(f.turnId).status).toBe('running');
          expect(f.store.getAgentSession(f.attempt.agentSessionId!).status).toBe('created');
          expect(f.store.getTurnEvents(f.turnId)).toEqual(beforeEvents);
        } finally {
          removeRefusal();
        }
      }
      const decidedTurn = f.store.getTurnById(f.turnId);
      const decidedSession = f.store.getAgentSession(f.attempt.agentSessionId!);
      const decidedEvents = f.store.getTurnEvents(f.turnId);
      await expect(f.classify()).resolves.toBe('complete');
      const turn = f.store.getTurnById(f.turnId);
      expect(turn.status).toBe('failed');
      if (decidedTurn.status === 'failed')
        expect({ ...turn, items: decidedTurn.items }).toEqual(decidedTurn);
      if (decidedSession.status === 'failed')
        expect(f.store.getAgentSession(decidedSession.id)).toEqual(decidedSession);
      const events = f.store.getTurnEvents(f.turnId);
      for (const event of [...beforeEvents, ...decidedEvents])
        expect(JSON.stringify(events.find((current) => current.sequence === event.sequence))).toBe(
          JSON.stringify(event)
        );
      expect(events.filter((event) => event.event === 'turn.completed')).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.data.type === 'agent-session-updated' &&
            event.data.agentSession.id === f.attempt.agentSessionId &&
            event.data.agentSession.status === 'failed'
        )
      ).toHaveLength(1);
      expect(
        getWorkerCheckpoint(
          f.workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          f.checkpoint.threadId,
          f.turnId
        )
      ).toBeNull();
      expect(f.backend.submit).not.toHaveBeenCalled();
      expect(f.backend.release).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });

  // Allow fixture I/O and both byte-proof passes; product deadlines remain unchanged.
  it.each([
    'open',
    'reconnecting',
    'unknown',
    'closing',
    'later',
    'later-busy-equal-time',
    'binding',
    'heartbeat',
    'sequence',
    'process',
    'control-token',
    'inference-token',
    'capability-token',
    'operation',
    'deadline',
    'outcome',
    'fence',
    'native-handle',
    'gate',
    'delivery',
    'missing-outer-receipt',
    'bad-input',
    'bad-admission',
    'materialization',
    'live-invocation',
    'terminal-conflict',
    'terminal-item-text',
    'terminal-item-identity',
    'terminal-item-order',
    'accepted-final',
    'gate-receipt',
    'unclean-anchor',
    'missing-physical-proof',
    'missing-result-item',
  ] as const)('preserves owned bytes for unproved %s', async (gap) => {
    const f = await failedStart('conversation', true);
    const sql = f.coreDb.sqlite;
    const attemptId = f.attempt.attemptId;
    try {
      const columns: Partial<Record<typeof gap, [string, string | number]>> = {
        open: ['phase', 'open'],
        reconnecting: ['phase', 'open'],
        unknown: ['disposition', 'unknown'],
        closing: ['phase', 'closing'],
        heartbeat: ['last_accepted_heartbeat_at', '2026-10-09T00:00:00.000Z'],
        sequence: ['last_worker_sequence', 1],
        process: ['worker_process_key_hash', 'a'.repeat(64)],
        'control-token': ['worker_control_token_hash', 'a'.repeat(64)],
        'inference-token': ['worker_inference_token_hash', 'a'.repeat(64)],
        'capability-token': ['worker_capability_token_hash', 'a'.repeat(64)],
        operation: ['operation_id', 'original-operation'],
        deadline: ['deadline', '2026-10-09T00:00:00.000Z'],
        outcome: ['outcome_ref', 'unproved'],
        fence: ['fence_ref', 'unproved'],
      };
      const column = columns[gap];
      if (column)
        sql
          .prepare(`UPDATE scheduler_execution_attempts SET ${column[0]} = ? WHERE attempt_id = ?`)
          .run(column[1], attemptId);
      if (gap === 'reconnecting')
        sql
          .prepare(
            "UPDATE scheduler_execution_attempts SET recovery_state = 'awaiting-reconnect' WHERE attempt_id = ?"
          )
          .run(attemptId);
      if (gap === 'later' || gap === 'later-busy-equal-time') {
        const row = sql
          .prepare('SELECT * FROM scheduler_execution_attempts WHERE attempt_id = ?')
          .get(attemptId) as Record<string, unknown>;
        row.attempt_id = testEntityId('attempt', 'later-attempt');
        if (gap === 'later-busy-equal-time') {
          row.terminal_cause = 'backend-busy';
          row.agent_session_id = null;
          row.input_ref = null;
          row.binding_ref = null;
        } else row.created_at = new Date(Date.now() + 1000).toISOString();
        sql
          .prepare(
            `INSERT INTO scheduler_execution_attempts (${Object.keys(row).join(',')}) VALUES (${Object.keys(
              row
            )
              .map(() => '?')
              .join(',')})`
          )
          .run(...Object.values(row));
      }
      if (gap === 'binding') {
        const anchor = getWorkerBackendSession(f.coreDb, attemptId)!;
        createNanoHostHarnessRuntime(f.coreDb, {
          adapterId: 'codex',
          adapterVersion: 'test',
          harnessBindingRef: 'harness-binding',
          harnessCompatibilityKey: 'a'.repeat(64),
          harnessInstanceId: 'harness',
          imageDigest: `sha256:${'a'.repeat(64)}`,
          originPhysicalEpoch: anchor.originPhysicalEpoch,
          sandboxBindingRef: 'sandbox-binding',
          sandboxCompatibilityKey: 'b'.repeat(64),
          sandboxIntegrationBindingRef: 'integration-binding',
          sandboxRuntimeId: 'sandbox',
          runtimeTargetId: anchor.runtimeTargetId,
          timestamp: f.attempt.createdAt,
        });
        sql
          .prepare(`INSERT INTO agent_session_runtime_bindings
        (agent_session_runtime_binding_id, harness_instance_id, agent_session_id, workspace_id, thread_id, agent_session_compatibility_key, effective_setup_generation, native_handle_state, lifecycle_state, next_turn_sequence, cleanup_state, created_at, updated_at, image_digest)
        VALUES ('pending-binding', 'harness', ?, 'ws_00000000-0000-7000-8000-000000000001', ?, 'key', 1, 'pending', 'open', 1, 'clean', ?, ?, ?)`)
          .run(
            f.attempt.agentSessionId,
            f.checkpoint.threadId,
            f.attempt.createdAt,
            f.attempt.createdAt,
            `sha256:${'a'.repeat(64)}`
          );
      }
      if (gap === 'native-handle')
        await f.store.updateAgentSession(f.attempt.agentSessionId!, {
          nativeHandleDigest: 'a'.repeat(64),
        });
      if (gap === 'gate' || gap === 'delivery')
        f.workspaceDb.sqlite
          .prepare(`INSERT INTO pending_requests (request_id, workspace_id, thread_id, raising_turn_id, request_item_id, kind, requester_kind, responsible_user_id, state, claim, delivery, delivery_turn_id, created_at, updated_at)
        VALUES ('pending-owner', 'ws_00000000-0000-7000-8000-000000000001', ?, ?, 'request-item', 'user-input', 'worker', 'usr_00000000-0000-7000-8000-000000000001', 'pending', 'unclaimed', 'undelivered', ?, ?, ?)`)
          .run(
            f.checkpoint.threadId,
            gap === 'gate' ? f.turnId : 'earlier-turn',
            gap === 'delivery' ? f.turnId : null,
            f.attempt.createdAt,
            f.attempt.createdAt
          );
      if (gap === 'missing-outer-receipt')
        f.workspaceDb.sqlite
          .prepare("DELETE FROM idempotency_requests WHERE command_name = 'conversation.submit'")
          .run();
      if (gap === 'bad-input')
        f.workspaceDb.sqlite
          .prepare('UPDATE worker_turn_checkpoints SET context_digest = ? WHERE turn_id = ?')
          .run('sha256:contradiction', f.turnId);
      if (gap === 'bad-admission')
        sql
          .prepare('UPDATE scheduler_admission_entries SET turn_input = ? WHERE turn_id = ?')
          .run('{}', f.turnId);
      if (gap === 'materialization') {
        const inputs = recordWorkspaceInputSnapshots(
          f.workspaceDb,
          buildWorkspaceInputSnapshots({
            backendCapabilities: ['trusted-worker-inference-relay'],
            backendKind: 'openshell',
            createdAt: f.attempt.createdAt,
            environmentPackage: f.pkg.snapshot,
          })
        );
        recordWorkspaceMaterializationRecords(
          f.workspaceDb,
          buildWorkspaceMaterializationRecords({
            createdAt: f.attempt.createdAt,
            inputSnapshots: inputs,
            materialization: {
              backendKind: 'openshell',
              packageSnapshotId: f.pkg.snapshot.snapshotId,
              requiredCapabilities: [],
              workspaceInputs: f.pkg.snapshot.workspace.inputs.map((input) => ({
                id: input.id,
                target: input.target,
              })),
            },
          })
        );
      }
      if (gap === 'live-invocation')
        getSchedulerPreparationClaims(f.coreDb).set(
          f.attempt.queueEntryId,
          Promise.withResolvers<never>().promise
        );
      if (
        gap === 'terminal-conflict' ||
        gap === 'terminal-item-text' ||
        gap === 'terminal-item-identity' ||
        gap === 'terminal-item-order'
      ) {
        await terminalizeGovernedWorkerTurn({
          store: f.store,
          turnId: f.turnId,
          agentSessionId: f.attempt.agentSessionId,
          requestId: f.checkpoint.requestId,
          completedAt: new Date().toISOString(),
          outcome: 'failed',
          errorCode: 'worker_governance_turn_failed',
          message: 'The worker attempt failed to start.',
        });
        const getEvents = f.store.getTurnEvents.bind(f.store);
        // Native publication cannot create a conflicting terminal tuple. Corrupt its retained-read
        // observation to retain the recovery refusal guard without bypassing the terminal writer.
        vi.spyOn(f.store, 'getTurnEvents').mockImplementation((id) =>
          getEvents(id).map((event) => {
            if (id !== f.turnId || event.data.type !== 'turn-completed') return event;
            if (gap === 'terminal-conflict')
              return { ...event, data: { ...event.data, stopReason: 'completed' as const } };
            const items = event.data.turn.items.map((item) => {
              if (item.type !== 'user-message') return item;
              return gap === 'terminal-item-text'
                ? { ...item, text: 'CONTRADICTORY ORIGINAL INPUT' }
                : gap === 'terminal-item-identity'
                  ? { ...item, id: 'contradictory-original-item' }
                  : item;
            });
            if (gap === 'terminal-item-order') items.reverse();
            return { ...event, data: { ...event.data, turn: { ...event.data.turn, items } } };
          })
        );
      }
      if (gap === 'accepted-final')
        sql
          .prepare(
            `INSERT INTO worker_control_records (workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id, request_id, operation, record_key, record_json, accepted_at) VALUES ('ws_00000000-0000-7000-8000-000000000001', ?, ?, ?, ?, ?, 'final_status', 'original-final', '{}', ?)`
          )
          .run(
            f.checkpoint.threadId,
            f.turnId,
            f.attempt.agentSessionId,
            f.attempt.inputRef,
            f.checkpoint.requestId,
            f.attempt.createdAt
          );
      if (gap === 'gate-receipt') {
        await shutdownControlStoreWorkerClient();
        // Stopped private-history fault only; the real native admission must already own the original receipt.
        const record = {
          command: 'approval.respond',
          requestId: 'gate-response',
          inputHash: 'a'.repeat(64),
          scope: {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: f.checkpoint.threadId,
            turnId: f.turnId,
            approvalRequestId: 'missing-gate',
          },
          response: { kind: 'approval', id: 'missing-gate' },
          createdAt: f.attempt.createdAt,
        };
        expect(
          f.workspaceDb.sqlite
            .prepare(
              `INSERT INTO idempotency_requests (request_key,command_name,request_id,scope_json,input_hash,response_kind,response_id,response_json,created_at,expires_at,schema_version) SELECT @key,json_extract(@record,'$.command'),json_extract(@record,'$.requestId'),json_extract(@record,'$.scope'),json_extract(@record,'$.inputHash'),json_extract(@record,'$.response.kind'),json_extract(@record,'$.response.id'),NULL,json_extract(@record,'$.createdAt'),expires_at,schema_version FROM idempotency_requests WHERE command_name='conversation.submit' AND request_id=@source`
            )
            .run({
              key: commandRequestKey('approval.respond', record.requestId, record.scope),
              record: JSON.stringify(record),
              source: f.checkpoint.requestId,
            }).changes
        ).toBe(1);
      }
      if (gap === 'unclean-anchor')
        sql
          .prepare(
            "UPDATE worker_backend_sessions SET state = 'cleanup-failed' WHERE attempt_id = ?"
          )
          .run(attemptId);
      if (gap === 'missing-physical-proof')
        sql
          .prepare(
            'UPDATE worker_backend_sessions SET physical_cleaned_at = NULL WHERE attempt_id = ?'
          )
          .run(attemptId);
      if (gap === 'missing-result-item')
        vi.spyOn(f.store, 'getTurnById').mockImplementation((id) => {
          const turn = f.store.getTurn(
            'ws_00000000-0000-7000-8000-000000000001',
            f.checkpoint.threadId,
            id
          );
          return {
            ...turn,
            items: turn.items.filter(
              (item) => item.id !== deriveEntityId('it', ['worker-result', id])
            ),
          };
        });
      const files = retainedFileBytes(f.dataRoot);
      const core = sql.serialize();
      const workspace = f.workspaceDb.sqlite.serialize();
      const product = JSON.stringify({
        turn: f.store.getTurnById(f.turnId),
        session: f.store.getAgentSession(f.attempt.agentSessionId!),
        events: f.store.getTurnEvents(f.turnId),
        receipts: f.store.listCommandRequests(),
      });
      for (let pass = 0; pass < 2; pass++) {
        await f.classify().catch(() => {});
        expect(
          getWorkerCheckpoint(
            f.workspaceDb,
            'ws_00000000-0000-7000-8000-000000000001',
            f.checkpoint.threadId,
            f.turnId
          )
        ).not.toBeNull();
        expect(sql.serialize().equals(core)).toBe(true);
        expect(f.workspaceDb.sqlite.serialize().equals(workspace)).toBe(true);
        expect(retainedFileBytes(f.dataRoot)).toEqual(files);
        expect(
          JSON.stringify({
            turn: f.store.getTurnById(f.turnId),
            session: f.store.getAgentSession(f.attempt.agentSessionId!),
            events: f.store.getTurnEvents(f.turnId),
            receipts: f.store.listCommandRequests(),
          })
        ).toBe(product);
      }
      expect(f.backend.submit).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      getSchedulerPreparationClaims(f.coreDb).delete(f.attempt.queueEntryId);
      await f.cleanup();
    }
  }, 60_000);
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
