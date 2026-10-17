// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import type {
  WorkerGovernanceBackend,
  WorkerGovernanceNativeResume,
} from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';
import { workerStorageDefaultWorkSlotRef } from './worker-storage-bindings.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';

// Confirm synthetic image admission without replacing production package or resume selection.
vi.mock('./agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    '../test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

it.each([
  false,
  true,
])('does not demand a native reference after failed OpenCode preparation (earlier Codex reference: %s)', async (hasCodexReference) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-switch-resume-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: DEMO_WORKSPACE_ID,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
    });
    const store = createDemoStore({ dataRoot });
    const oldSessionId = testEntityId('as', 'resume-old-codex');
    const failedSessionId = testEntityId('as', 'resume-failed-opencode');
    const timestamp = '2026-10-17T15:00:00.000Z';
    const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
    const storage = {
      storageRef: 'wst_00000000-0000-7ac8-9f6c-13552db6aa87',
      workSlotRef: workerStorageDefaultWorkSlotRef(DEMO_WORKSPACE_ID, DEMO_THREAD_ID),
    };
    if (hasCodexReference)
      store.createAgentSession({
        id: oldSessionId,
        agentId: 'agent_codex_host',
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: DEMO_THREAD_ID,
        status: 'closed',
        message: null,
        nativeHandleDigest: 'a'.repeat(64),
        retainedStorage: storage,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    // Use the real failure publisher for an allocated Session that failed before native open.
    store.createAgentSession({
      id: failedSessionId,
      agentId: 'agent_opencode_server',
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      status: 'created',
      message: null,
      createdAt: '2026-10-17T15:01:00.000Z',
      updatedAt: '2026-10-17T15:01:00.000Z',
    });
    const failedTurn = store.createTurn(
      DEMO_WORKSPACE_ID,
      DEMO_THREAD_ID,
      'Prepare OpenCode',
      actor
    );
    store.updateTurn(failedTurn.id, {
      agentId: 'agent_opencode_server',
      agentSessionId: failedSessionId,
    });
    terminalizeGovernedWorkerTurn({
      store,
      turnId: failedTurn.id,
      agentSessionId: failedSessionId,
      outcome: 'failed',
      errorCode: 'worker_preparation_failed',
      message: 'Preparation failed before native open.',
      requestId: null,
      completedAt: '2026-10-17T15:02:00.000Z',
    });
    expect(store.getAgentSession(failedSessionId)).toMatchObject({
      status: 'failed',
      nativeHandleDigest: null,
    });

    const turn = store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Try OpenCode again', actor);
    store.updateTurn(turn.id, { agentId: 'agent_opencode_server' });
    const agentSessionId = testEntityId('as', 'resume-next-opencode');
    const attemptId = testEntityId('attempt', 'resume-next-attempt');
    const bindingRef = `fixture-binding:${turn.id}`;
    const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment_fake_executor',
      identityId: 'identity_fake_executor',
      observedAt: timestamp,
      targetId: 'runtime-target-test',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...target,
      freshEmpty: true,
      observedAt: timestamp,
      physicalEpoch: 'b'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      triggerActor: actor,
      queueEntryId: `queue_${turn.id}`,
      requestId: '00000000-0000-4000-8000-000000000392',
      requestedAgentId: 'agent_opencode_server',
      threadId: turn.threadId,
      turnId: turn.id,
      turnInput: 'Try OpenCode again',
      workspaceId: turn.workspaceId,
    });
    recordTestExecutionAttempt(coreDb, {
      entry,
      attemptId,
      agentSessionId,
      inputRef: `aepsnap_${turn.id}_${agentSessionId}`,
      bindingRef,
      sessionCompatibilityKey: 'fixture-compatibility',
      now: () => '2026-10-17T15:03:00.000Z',
    });
    let offered: WorkerGovernanceNativeResume | null | undefined;
    // Observe the real Core resume handoff and stop before any external runtime effect.
    const backend: WorkerGovernanceBackend = {
      id: 'nanohost',
      describeCapabilities: async () => ({
        capabilities: ['container', 'transcript-sink', 'worker-control'],
        dynamicCapabilities: [],
        kind: 'openshell',
        version: '0.0.63',
      }),
      validatePackage: async () => [],
      planSession: (pkg) => ({
        agentSessionId: pkg.scope.agentSessionId,
        backendKind: 'openshell',
        backendSessionId: `fixture-${pkg.scope.agentSessionId}`,
        deploymentId: 'deployment_fake_executor',
        packageSnapshotId: pkg.snapshotId,
        runtimeTargetId: 'runtime-target-test',
        stagingDirectoryRef: `server/runtime/worker-backend-sessions/${pkg.snapshotId}`,
        transientProviderInstanceId: null,
      }),
      materialize: async (_pkg, context) => {
        offered = context?.nativeResume;
        throw new Error('resume probe boundary');
      },
      cleanupSession: async () => {},
      prepareLaunch: async () => {
        throw new Error('Unexpected native launch');
      },
      submit: async () => {
        throw new Error('Unexpected native submit');
      },
      inspect: async () => null,
      cancel: async () => {
        throw new Error('Unexpected cancel');
      },
      release: async () => {
        throw new Error('Unexpected release');
      },
      update: async () => [],
      collectEvidence: async () => [],
      collectWorkspaceChanges: async () => [],
      collectTranscript: async () => {
        throw new Error('Unexpected transcript');
      },
    };
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
    await expect(
      executor.startTurn(store, turn.id, 'Try OpenCode again', {
        agentSessionId,
        attemptId,
        sandboxBindingRef: bindingRef,
        requestId: entry.requestId,
        triggerActor: actor,
        workspaceRoots: [],
        agentSetup: createTestAgentSetup({ agentId: 'agent_opencode_server', adapter: 'opencode' }),
      })
    ).rejects.toThrow('resume probe boundary');
    expect(offered).toEqual(null);
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
