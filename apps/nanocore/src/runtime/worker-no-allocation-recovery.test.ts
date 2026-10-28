import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from '../mode-entry-routes.js';
import {
  ControlStoreWorkerError,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import {
  DEMO_THREAD_ID,
  DEMO_WORKSPACE_ID,
  seedDemoWorkspace,
} from '../test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { requireSchedulerExecutionAttempt } from './execution-attempt-records.js';
import { hasNanoHostAttemptPreEffectProof } from './nanohost-attempt-recovery.js';
import { getSchedulerPreparationClaims } from './scheduler-dispatch-loop.js';
import { runSchedulerRestartRecovery } from './scheduler-restart-recovery.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import { getWorkerCheckpoint } from './worker-checkpoints.js';
import { endWorkerTurnMaterialization } from './worker-governance-turn-executor.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';

const requestId = '0190f4c8-0000-7000-8000-000000000997';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.restoreAllMocks();
});

/** Syntax detection avoids inherited eval-only flags; process exit removes the real scheduler claim. */
const producer = String.raw`
import { readFileSync } from 'node:fs';
import { createApp } from './src/app.ts';
import { FsStore } from './src/lib/store.ts';
import { ProviderRegistry } from './src/providers/registry.ts';
import { FileStorageAdmission } from './src/storage/artifacts/file-admission.ts';
import { openCoreDb } from './src/storage/db.ts';
import { operationRequest } from './src/test-support/operation-request.ts';
import { WorkerGovernanceTurnExecutor } from './src/runtime/worker-governance-turn-executor.ts';
const { dataRoot, setup, gatewayConfig, target, requestId, workspaceId, threadId, userId } =
  JSON.parse(readFileSync(0, 'utf8'));
const coreDb = openCoreDb(dataRoot);
const store = new FsStore({ dataRoot });
const accepted = Promise.withResolvers();
let externalCalls = 0;
const forbidden = async () => {
  externalCalls++;
  throw new Error('No Worker effect is authorized.');
};
const backend = {
  id: 'nanohost', submit: forbidden, inspect: forbidden, cancel: forbidden, release: forbidden,
  describeCapabilities: async () => ({
    kind: 'openshell', version: 'test', capabilities: ['worker.runtime-provenance.v1'],
    dynamicCapabilities: [],
  }),
  validatePackage: async () => [],
  prepareAgentSessionContinuity: async () => 'absent',
  planSession: (pkg) => ({
    agentSessionId: pkg.scope.agentSessionId, backendKind: 'openshell',
    backendSessionId: 'unused_' + pkg.snapshotId, deploymentId: target.deploymentId,
    packageSnapshotId: pkg.snapshotId, runtimeTargetId: target.targetId,
    stagingDirectoryRef: 'server/runtime/worker-backend-sessions/' + pkg.snapshotId,
    transientProviderInstanceId: null,
  }),
  materialize: async (_pkg, context) => {
    await context.beforeMaterialization();
    return forbidden();
  },
  cleanupSession: forbidden, update: async () => [], collectEvidence: async () => [],
  collectTranscript: async () => ({ itemsJsonl: '' }), collectWorkspaceChanges: async () => [],
};
const publishTurn = store.updateTurn.bind(store);
store.updateTurn = async (...args) => {
  const turn = await publishTurn(...args);
  if (args[2]?.journalIntents) {
    const response = await accepted.promise;
    if (response.turnId !== turn.id) throw new Error('Accepted Turn differs from native binding.');
    await new Promise((resolve) => process.stdout.write(JSON.stringify({
      boundary: 'original-journal-ack', ...response, externalCalls,
    }) + '\n', resolve));
    process.exit(23);
  }
  return turn;
};
const fileAdmission = new FileStorageAdmission(dataRoot, () => 0n);
const executor = new WorkerGovernanceTurnExecutor({ coreDb, backend, fileAdmission });
const app = createApp({
  coreDb, dataRoot, store, turnExecutor: executor, fileAdmission, localUserId: userId,
  agentManifests: [setup.manifest], gatewayConfig,
  providerRegistry: new ProviderRegistry([{
    defaultModel: 'openai/gpt-5.2', displayName: 'Test inference provider',
    id: 'agent-openrouter', kind: 'local', models: ['openai/gpt-5.2'],
  }]),
  openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
});
const response = await app.request(...operationRequest('task.start', { workspaceId, threadId }, {
  body: JSON.stringify({ requestId, input: 'Inspect the admitted request without effects.' }),
}));
if (response.status !== 202) throw new Error(await response.text());
accepted.resolve({ status: response.status, turnId: (await response.json()).turn.id });
await new Promise(() => {});
`;

/** Runs the real Task and Worker producer until journal acknowledgement, then reads only fresh owners. */
async function stoppedOriginalWorker() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-no-allocation-'));
  let coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  let store: FsStore = createTestStore({ dataRoot });
  await seedDemoWorkspace(store);
  let workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
  cleanup.push(async () => {
    await shutdownControlStoreWorkerClient();
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  const target = recordTestNativeRuntimeTarget(coreDb);
  const setup = createTestAgentSetup({ requiredCapabilities: ['worker.runtime-provenance.v1'] });
  admitTestNativeEnvironment(coreDb, setup.manifest);
  await shutdownControlStoreWorkerClient();
  workspaceDb.sqlite.close();
  coreDb.sqlite.close();
  const child = spawnSync(process.execPath, ['--import', 'tsx', '-e', producer], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8',
    timeout: 60_000,
    input: JSON.stringify({
      dataRoot,
      setup,
      gatewayConfig: createTestGatewayConfig(),
      target,
      requestId,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      userId: FIXTURE_LOCAL_USER_ID,
    }),
  });
  expect(child.status, child.stderr).toBe(23);
  const stopped = JSON.parse(
    child.stdout
      .trim()
      .split('\n')
      .find((line) => line.startsWith('{"boundary":"original-journal-ack",'))!
  );
  expect(stopped).toMatchObject({
    boundary: 'original-journal-ack',
    status: 202,
    externalCalls: 0,
  });
  const turnId = stopped.turnId as string;
  coreDb = openCoreDb(dataRoot);
  workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
  store = new FsStore({ dataRoot });
  const attemptId = (
    coreDb.sqlite
      .prepare('SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE turn_id=?')
      .get(turnId) as { id: string }
  ).id;
  const originalAttempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  expect(getSchedulerPreparationClaims(coreDb).has(originalAttempt.queueEntryId)).toBe(false);
  const originalPackage = requireAgentEnvironmentPackageSnapshot(
    workspaceDb,
    DEMO_WORKSPACE_ID,
    originalAttempt.inputRef!
  );
  const roots = () =>
    workspaceDb.sqlite
      .prepare('SELECT * FROM control_executions WHERE work_id=? ORDER BY id')
      .all(turnId) as Array<{ id: string; phase: string }>;
  const originalRoot = roots()[0]!;
  const steps = () =>
    workspaceDb.sqlite
      .prepare(
        'SELECT step_id AS id, state, control_json AS control FROM control_execution_steps WHERE execution_id=? ORDER BY ordinal'
      )
      .all(originalRoot.id) as Array<{ id: string; state: string; control: string }>;
  const originalSteps = steps();
  const nativeCalls: Array<{ mock: { calls: unknown[][] } }> = [];
  let checkpointClassifications = 0;
  const checkpoint = () =>
    getWorkerCheckpoint(workspaceDb, DEMO_WORKSPACE_ID, DEMO_THREAD_ID, turnId);
  const input = store.getTurnById(turnId).items.find((item) => item.type === 'user-message');
  const reopen = async () => {
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);
    workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    store = new FsStore({ dataRoot });
  };
  /** Composes boot's real scheduler, native lifecycle and initiating Task checkpoint owners. */
  const recover = async (beforeCheckpoint?: () => Promise<void>) => {
    const runtime = createConfiguredWorkerLifecycleRuntime({ env: {}, coreDb, store });
    const native = runtime.turnExecutor.executionBackend!;
    for (const method of ['submit', 'inspect', 'cancel', 'release'] as const)
      nativeCalls.push(vi.spyOn(native, method));
    await runSchedulerRestartRecovery(coreDb, {
      executionBackend: native,
      projectRecoveredTurn: async (subject) => {
        const turn = await terminalizeGovernedWorkerTurn({
          agentSessionId: subject.agentSessionId,
          completedAt: new Date().toISOString(),
          errorCode: 'worker_governance_restart_recovery',
          message: 'Worker execution stopped during scheduler recovery.',
          outcome: 'failed',
          requestId,
          store,
          turnId: subject.turnId,
        });
        if (turn.status !== 'failed') throw new Error('Original Turn failed closeout is unproved.');
        return { status: 'failed' };
      },
    });
    await beforeCheckpoint?.();
    const pending = checkpoint();
    if (pending) {
      checkpointClassifications++;
      return classifyDirectTaskCheckpointAfterSchedulerRecovery({
        coreDb,
        store,
        workspaceDb,
        checkpoint: pending,
      });
    }
    return 'complete';
  };
  expect(roots()).toHaveLength(1);
  expect(originalSteps.map((step) => [JSON.parse(step.control).kind, step.state])).toEqual([
    ['materialize', 'intent'],
    ['terminal-publication', 'intent'],
    ['release', 'intent'],
  ]);
  expect(originalAttempt).toMatchObject({ phase: 'open', operationId: null, fenceRef: null });
  expect(checkpoint()).toMatchObject({ stage: 'running_worker', stopReason: null });
  return {
    get coreDb() {
      return coreDb;
    },
    get workspaceDb() {
      return workspaceDb;
    },
    get store() {
      return store;
    },
    get checkpointClassifications() {
      return checkpointClassifications;
    },
    turnId,
    attemptId,
    originalAttempt,
    originalRoot,
    originalSteps,
    input,
    roots,
    steps,
    checkpoint,
    reopen,
    recover,
    originalPackage,
    assertNoEffects() {
      for (const call of nativeCalls) expect(call).not.toHaveBeenCalled();
    },
  };
}

describe('original native Worker restart before allocation', () => {
  it('skips a committed materialize cancellation after caller acknowledgement loss', async () => {
    const f = await stoppedOriginalWorker();
    const materialize = f.originalSteps.find(
      (step) => JSON.parse(step.control).kind === 'materialize'
    )!;
    const release = f.originalSteps.find((step) => JSON.parse(step.control).kind === 'release')!;
    const materializeRow = () =>
      f.workspaceDb.sqlite
        .prepare('SELECT * FROM control_execution_steps WHERE execution_id=? AND step_id=?')
        .get(f.originalRoot.id, materialize.id);
    const settle = f.store.settleWorkspaceExecutionJournalStep.bind(f.store);
    const loss = vi
      .spyOn(f.store, 'settleWorkspaceExecutionJournalStep')
      .mockImplementation(async (...args) => {
        const result = await settle(...args);
        if (args[1].ref.stepId === materialize.id && args[1].state === 'cancelled')
          throw new ControlStoreWorkerError('unavailable', 'unknown');
        return result;
      });
    await expect(f.recover()).rejects.toThrow();
    expect(loss.mock.calls.map((args) => args[1].ref.stepId)).toEqual([materialize.id]);
    loss.mockRestore();
    const ended = materializeRow();
    expect(ended).toMatchObject({ state: 'cancelled' });
    expect(f.steps().find((step) => step.id === release.id)).toMatchObject({ state: 'intent' });
    expect(f.roots()).toMatchObject([
      {
        id: f.originalRoot.id,
        phase: 'closing',
        exclusion_refs_json: JSON.stringify([f.attemptId, f.originalAttempt.bindingRef]),
      },
    ]);
    expect(f.checkpoint()).not.toBeNull();
    await f.reopen();
    await expect(f.recover()).resolves.toBe('complete');
    expect(materializeRow()).toEqual(ended);
    expect(f.steps().map((step) => step.id)).toEqual(f.originalSteps.map((step) => step.id));
    expect(f.steps().find((step) => step.id === release.id)).toMatchObject({ state: 'cancelled' });
    expect(f.roots()).toMatchObject([
      { id: f.originalRoot.id, phase: 'closed', exclusion_refs_json: '[]' },
    ]);
    expect(f.checkpoint()).toBeNull();
    f.assertNoEffects();
  });

  it('retains unused obligations until the native terminal write is acknowledged', async () => {
    const f = await stoppedOriginalWorker();
    f.workspaceDb.sqlite.exec(`CREATE TRIGGER refuse_original_terminal
      BEFORE UPDATE ON control_turns WHEN NEW.id='${f.turnId}' AND NEW.status='failed'
      BEGIN SELECT RAISE(ABORT, 'Controlled original terminal refusal.'); END`);
    try {
      await expect(f.recover()).rejects.toThrow();
      expect(f.checkpointClassifications).toBe(0);
      expect(f.steps()).toEqual(f.originalSteps);
      expect(f.roots()[0]!.phase).not.toBe('closed');
      expect(f.checkpoint()).not.toBeNull();
    } finally {
      f.workspaceDb.sqlite.exec('DROP TRIGGER refuse_original_terminal');
    }
    await f.reopen();
    await expect(f.recover()).resolves.toBe('complete');
    expect(f.roots()).toMatchObject([{ id: f.originalRoot.id, phase: 'closed' }]);
    expect(f.checkpoint()).toBeNull();
    f.assertNoEffects();
  });

  it('closes original obligations without a physical fence and remains unchanged after reopen', async () => {
    const f = await stoppedOriginalWorker();
    await expect(f.recover()).resolves.toBe('complete');
    expect(hasNanoHostAttemptPreEffectProof(f.coreDb, f.attemptId)).toBe(true);
    expect(requireSchedulerExecutionAttempt(f.coreDb, f.attemptId)).toMatchObject({
      phase: 'closed',
      disposition: 'not_accepted',
      terminalCause: 'restart-before-effects',
      operationId: null,
      outcomeRef: null,
      fenceRef: null,
    });
    expect(f.store.getTurnById(f.turnId)).toMatchObject({ status: 'failed' });
    expect(f.store.getAgentSession(f.originalAttempt.agentSessionId!).status).toBe('failed');
    expect(
      f.store.getTurnById(f.turnId).items.find((item) => item.type === 'user-message')
    ).toEqual(f.input);
    expect(
      requireAgentEnvironmentPackageSnapshot(
        f.workspaceDb,
        DEMO_WORKSPACE_ID,
        f.originalAttempt.inputRef!
      )
    ).toEqual(f.originalPackage);
    expect(f.steps().map((step) => [step.id, JSON.parse(step.control).kind, step.state])).toEqual(
      f.originalSteps.map((step) => [
        step.id,
        JSON.parse(step.control).kind,
        JSON.parse(step.control).kind === 'terminal-publication' ? 'completed' : 'cancelled',
      ])
    );
    expect(f.roots()).toMatchObject([{ id: f.originalRoot.id, phase: 'closed' }]);
    for (const step of f.steps()) expect(JSON.parse(step.control).physicalFenceRefs).toEqual([]);
    const terminal = f.store
      .getTurnEvents(f.turnId)
      .filter((event) => event.event === 'turn.completed');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.data).toMatchObject({ stopReason: 'error' });
    expect(
      f.store.getCommandRequest(
        'task.start',
        requestId,
        {
          actorId: FIXTURE_LOCAL_USER_ID,
          workspaceId: DEMO_WORKSPACE_ID,
          threadId: DEMO_THREAD_ID,
        },
        f.workspaceDb
      )
    ).toMatchObject({ response: { kind: 'turn', id: f.turnId } });
    expect(
      f.workspaceDb.sqlite
        .prepare("SELECT action FROM audit_events WHERE request_id=? AND action='task.start'")
        .all(requestId)
    ).toHaveLength(1);
    expect(f.checkpoint()).toBeNull();
    const snapshot = () => ({
      turn: f.store.getTurnById(f.turnId),
      session: f.store.getAgentSession(f.originalAttempt.agentSessionId!),
      roots: f.roots(),
      steps: f.steps(),
      terminal: f.store.getTurnEvents(f.turnId).filter((event) => event.event === 'turn.completed'),
    });
    const decided = snapshot();
    await f.reopen();
    await expect(f.recover()).resolves.toBe('complete');
    expect(snapshot()).toEqual(decided);
    f.assertNoEffects();
  });

  it.each([
    'unknown-materialize',
    'missing-release',
    'worker-sequence',
    'recovery-owner',
    'recovery-deadline',
    'descriptor-authority',
    'descriptor-backend',
    'missing-native-target',
  ] as const)('preserves original authority for %s', async (fault) => {
    const f = await stoppedOriginalWorker();
    let unresolved = f.originalSteps;
    let mutationError: unknown;
    await expect(
      f.recover(async () => {
        // Reach the named checkpoint refusal after real terminal acknowledgement and absent live claims.
        expect(hasNanoHostAttemptPreEffectProof(f.coreDb, f.attemptId)).toBe(true);
        expect(
          f.steps().find((step) => JSON.parse(step.control).kind === 'terminal-publication')!.state
        ).toBe('completed');
        if (fault === 'unknown-materialize') {
          await endWorkerTurnMaterialization(f.store, f.workspaceDb, f.turnId, 'unknown');
        } else {
          const sql = {
            'missing-release':
              "DELETE FROM control_execution_steps WHERE execution_id=? AND json_extract(control_json, '$.kind')='release'",
            'worker-sequence':
              'UPDATE scheduler_execution_attempts SET last_worker_sequence=1 WHERE attempt_id=?',
            'recovery-owner':
              "UPDATE scheduler_execution_attempts SET recovery_state='awaiting-reconnect' WHERE attempt_id=?",
            'recovery-deadline':
              "UPDATE scheduler_execution_attempts SET recovery_deadline='2999-01-01T00:00:00.000Z' WHERE attempt_id=?",
            'descriptor-authority':
              "UPDATE control_execution_steps SET control_json=json_set(control_json, '$.permittingDecisionRef', 'unrelated-permission') WHERE execution_id=? AND json_extract(control_json, '$.kind')='materialize'",
            'descriptor-backend':
              "UPDATE control_execution_steps SET control_json=json_set(control_json, '$.target.backendKind', 'unadmitted-backend') WHERE execution_id=? AND json_extract(control_json, '$.kind') IN ('materialize','release')",
            'missing-native-target': 'DELETE FROM nanohost_runtime_targets WHERE target_id=?',
          }[fault];
          const native = !fault.startsWith('descriptor') && fault !== 'missing-release';
          const identity =
            fault === 'missing-native-target'
              ? JSON.parse(f.originalSteps[0]!.control).target.targetId
              : native
                ? f.attemptId
                : f.originalRoot.id;
          try {
            (native ? f.coreDb : f.workspaceDb).sqlite.prepare(sql).run(identity);
          } catch (error) {
            mutationError = error;
            throw error;
          }
        }
        unresolved = f.steps();
      })
    ).rejects.toThrow();
    const immutable = fault.startsWith('descriptor');
    expect(f.checkpointClassifications).toBe(immutable ? 0 : 1);
    if (immutable)
      expect(mutationError).toMatchObject({
        code: 'SQLITE_CONSTRAINT_TRIGGER',
        message: 'Execution step identity is immutable and an outcome settles once.',
      });
    else expect(mutationError).toBeUndefined();
    expect(hasNanoHostAttemptPreEffectProof(f.coreDb, f.attemptId)).toBe(
      fault !== 'worker-sequence'
    );
    expect(f.checkpoint()).not.toBeNull();
    expect(f.roots()[0]!.phase).not.toBe('closed');
    expect(
      f.steps().filter((step) => JSON.parse(step.control).kind !== 'terminal-publication')
    ).toEqual(
      unresolved.filter((step) => JSON.parse(step.control).kind !== 'terminal-publication')
    );
    f.assertNoEffects();
  });
});
