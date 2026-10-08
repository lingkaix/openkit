import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from '../mode-entry-routes.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
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

/** Runs the real executor through its post-binding failure, interrupting product publication before restart. */
async function failedStart(entry: 'conversation' | 'direct', provenance = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-d8-checkpoint-'));
  let coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  let store: FsStore = createDemoStore({ dataRoot });
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
      context!.beforeMaterialization!();
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
    collectProviderRefreshStatuses: async () => [],
    collectTranscript: async () => ({ itemsJsonl: '' }),
    collectWorkspaceChanges: async () => [],
  };
  const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
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
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
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
  const updateTurn = store.updateTurn.bind(store);
  const updateSession = store.updateAgentSession.bind(store);
  const emit = store.emitTurnEvent.bind(store);
  const turnFailure = vi.spyOn(store, 'updateTurn').mockImplementation((id, patch, authority) => {
    if (id === turnId && patch.status === 'failed')
      throw new Error('Controlled product publication interruption.');
    return updateTurn(id, patch, authority);
  });
  const sessionFailure = vi.spyOn(store, 'updateAgentSession').mockImplementation((id, patch) => {
    if (patch.status === 'failed') throw new Error('Controlled product publication interruption.');
    return updateSession(id, patch);
  });
  const eventFailure = vi
    .spyOn(store, 'emitTurnEvent')
    .mockImplementation((id, event, authority) => {
      if (event.event === 'turn.completed')
        throw new Error('Controlled product publication interruption.');
      return emit(id, event, authority);
    });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  fail.resolve();
  await vi.waitFor(() => expect(executor.isTurnExecutionActive(turnId)).toBe(false));
  await setImmediate();
  turnFailure.mockRestore();
  sessionFailure.mockRestore();
  eventFailure.mockRestore();
  log.mockRestore();
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
  coreDb.sqlite.close();
  coreDb = openCoreDb(dataRoot);
  store = new FsStore({ dataRoot });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  const checkpoint = getWorkerCheckpoint(workspaceDb, 'ws_demo', anchor.threadId, turnId)!;
  expect(checkpoint).toMatchObject({ stage: 'running_worker', stopReason: null, iteration: 0 });
  const classify = () =>
    classifyDirectTaskCheckpointAfterSchedulerRecovery({
      coreDb,
      store,
      workspaceDb,
      checkpoint:
        getWorkerCheckpoint(workspaceDb, 'ws_demo', anchor.threadId, turnId) ?? checkpoint,
    });
  const pkg = requireAgentEnvironmentPackageSnapshot(workspaceDb, 'ws_demo', attempt.inputRef!);
  const restartedExecutor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
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
        { workspaceId: 'ws_demo', threadId: 'th_demo' },
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
        { workspaceId: 'ws_demo', threadId: anchor.threadId },
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
    cleanup: () => {
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
      row.attempt_id = 'earlier-busy-attempt';
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
      const core = f.coreDb.sqlite.serialize();
      await expect(f.classify()).resolves.toBe('complete');
      expect(f.store.getTurnById(f.turnId).status).toBe('failed');
      expect(f.store.getAgentSession(f.attempt.agentSessionId!).status).toBe('failed');
      expect(
        getWorkerCheckpoint(f.workspaceDb, 'ws_demo', f.checkpoint.threadId, f.turnId)
      ).toBeNull();
      expect(f.coreDb.sqlite.serialize().equals(core)).toBe(true);
      expect(f.backend.submit).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

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
        getWorkerCheckpoint(f.workspaceDb, 'ws_demo', f.checkpoint.threadId, f.turnId)
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
        for (const checkpoint of listExportableWorkerCheckpoints(f.workspaceDb, 'ws_demo'))
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
      f.cleanup();
    }
  });

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
  )('repairs partial $entry $partial publication without replacing decided bytes', async ({
    entry,
    partial,
  }) => {
    const f = await failedStart(entry, true);
    const beforeEvents = f.store.getTurnEvents(f.turnId);
    try {
      const terminalize = () =>
        terminalizeGovernedWorkerTurn({
          store: f.store,
          turnId: f.turnId,
          agentSessionId: f.attempt.agentSessionId,
          requestId: f.checkpoint.requestId,
          completedAt: new Date().toISOString(),
          outcome: 'failed',
          errorCode: 'worker_governance_turn_failed',
          message: 'The worker attempt failed to start.',
        });
      const spies: Array<{ mockRestore(): void }> = [];
      if (partial === 'turn-only' || partial === 'terminal-event')
        spies.push(
          vi.spyOn(f.store, 'updateAgentSession').mockImplementation(() => {
            throw new Error('Partial Session write.');
          })
        );
      if (partial === 'session-only' || partial === 'session-event')
        spies.push(
          vi.spyOn(f.store, 'updateTurn').mockImplementation(() => {
            throw new Error('Partial Turn write.');
          })
        );
      const emit = f.store.emitTurnEvent.bind(f.store);
      if (partial !== 'receipt-write' && partial !== 'item-write')
        spies.push(
          vi.spyOn(f.store, 'emitTurnEvent').mockImplementation((id, event, authority) => {
            if (
              partial === 'turn-only' ||
              partial === 'session-only' ||
              (partial === 'terminal-event' && event.event !== 'turn.completed') ||
              (partial === 'session-event' && event.event === 'turn.completed')
            )
              throw new Error('Partial event write.');
            return emit(id, event, authority);
          })
        );
      if (partial === 'receipt-write') {
        f.workspaceDb.sqlite
          .prepare("DELETE FROM idempotency_requests WHERE command_name = 'task.start'")
          .run();
        const receiptFailure = vi.spyOn(f.store, 'recordCommandRequest').mockImplementation(() => {
          throw new Error('Partial receipt write.');
        });
        await expect(f.classify()).rejects.toThrow('Partial receipt write.');
        receiptFailure.mockRestore();
        expect(
          getWorkerCheckpoint(f.workspaceDb, 'ws_demo', f.checkpoint.threadId, f.turnId)
        ).toMatchObject({ stage: 'failed', stopReason: 'error' });
      } else if (partial === 'item-write') {
        const update = f.store.updateItem.bind(f.store);
        const failure = vi
          .spyOn(f.store, 'updateItem')
          .mockImplementation((id, patch, authority) => {
            if (id === `it_worker_result_${f.turnId}`) throw new Error('Partial Item write.');
            return update(id, patch, authority);
          });
        await expect(f.classify()).rejects.toThrow('Partial Item write.');
        failure.mockRestore();
        expect(
          getWorkerCheckpoint(f.workspaceDb, 'ws_demo', f.checkpoint.threadId, f.turnId)
        ).not.toBeNull();
      } else {
        expect(terminalize).toThrow();
        for (const spy of spies) spy.mockRestore();
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
        getWorkerCheckpoint(f.workspaceDb, 'ws_demo', f.checkpoint.threadId, f.turnId)
      ).toBeNull();
      expect(f.backend.submit).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      f.cleanup();
    }
  });

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
        row.attempt_id = 'later-attempt';
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
        VALUES ('pending-binding', 'harness', ?, 'ws_demo', ?, 'key', 1, 'pending', 'open', 1, 'clean', ?, ?, ?)`)
          .run(
            f.attempt.agentSessionId,
            f.checkpoint.threadId,
            f.attempt.createdAt,
            f.attempt.createdAt,
            `sha256:${'a'.repeat(64)}`
          );
      }
      if (gap === 'native-handle')
        f.store.updateAgentSession(f.attempt.agentSessionId!, {
          nativeHandleDigest: 'a'.repeat(64),
        });
      if (gap === 'gate' || gap === 'delivery')
        f.workspaceDb.sqlite
          .prepare(`INSERT INTO pending_requests (request_id, workspace_id, thread_id, raising_turn_id, request_item_id, kind, requester_kind, responsible_user_id, state, claim, delivery, delivery_turn_id, created_at, updated_at)
        VALUES ('pending-owner', 'ws_demo', ?, ?, 'request-item', 'user-input', 'worker', 'user_local', 'pending', 'unclaimed', 'undelivered', ?, ?, ?)`)
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
      if (gap === 'terminal-conflict')
        f.store.emitTurnEvent(f.turnId, {
          event: 'turn.completed',
          data: {
            type: 'turn-completed',
            stopReason: 'completed',
            turn: f.store.getTurnById(f.turnId),
          },
          workspaceId: 'ws_demo',
          threadId: f.checkpoint.threadId,
          turnId: f.turnId,
          requestId: f.checkpoint.requestId,
        });
      if (
        gap === 'terminal-item-text' ||
        gap === 'terminal-item-identity' ||
        gap === 'terminal-item-order'
      ) {
        terminalizeGovernedWorkerTurn({
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
        // Inject a contradiction only at the retained-event observation boundary, preserving the accepted input.
        vi.spyOn(f.store, 'getTurnEvents').mockImplementation((id) =>
          getEvents(id).map((event) => {
            if (id !== f.turnId || event.data.type !== 'turn-completed') return event;
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
            `INSERT INTO worker_control_records (workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id, request_id, operation, record_key, record_json, accepted_at) VALUES ('ws_demo', ?, ?, ?, ?, ?, 'final_status', 'original-final', '{}', ?)`
          )
          .run(
            f.checkpoint.threadId,
            f.turnId,
            f.attempt.agentSessionId,
            f.attempt.inputRef,
            f.checkpoint.requestId,
            f.attempt.createdAt
          );
      if (gap === 'gate-receipt')
        f.store.recordCommandRequest({
          command: 'approval.respond',
          requestId: 'gate-response',
          inputHash: 'a'.repeat(64),
          scope: {
            workspaceId: 'ws_demo',
            threadId: f.checkpoint.threadId,
            turnId: f.turnId,
            approvalRequestId: 'missing-gate',
          },
          response: { kind: 'approval', id: 'missing-gate' },
          createdAt: f.attempt.createdAt,
        });
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
          const turn = f.store.getTurn('ws_demo', f.checkpoint.threadId, id);
          return {
            ...turn,
            items: turn.items.filter((item) => item.id !== `it_worker_result_${id}`),
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
          getWorkerCheckpoint(f.workspaceDb, 'ws_demo', f.checkpoint.threadId, f.turnId)
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
      f.cleanup();
    }
  });
});
