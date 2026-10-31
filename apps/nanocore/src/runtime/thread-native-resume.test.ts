// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnSchema, workspaceIdForOwner } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { AgentSessionRecordSchema } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import {
  createDemoWorkspaceForUser,
  DEMO_THREAD_ID,
  DEMO_WORKSPACE_ID,
} from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
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

// Confirm synthetic image admission without replacing production package or resume selection.
vi.mock('./agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    '../test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

it.each([
  { name: 'no earlier proof', oldAgentId: null, oldAdapter: 'codex', resumes: false },
  {
    name: 'a previous Codex Agent',
    oldAgentId: 'agent_codex_host',
    oldAdapter: 'codex',
    resumes: false,
  },
  {
    name: 'the same Agent switched from Codex',
    oldAgentId: 'agent_opencode_server',
    oldAdapter: 'codex',
    resumes: false,
  },
  {
    name: 'a different Agent on OpenCode',
    oldAgentId: 'agent_other_opencode',
    oldAdapter: 'opencode',
    resumes: false,
  },
  {
    name: 'the same Agent on OpenCode',
    oldAgentId: 'agent_opencode_server',
    oldAdapter: 'opencode',
    resumes: true,
  },
])('selects native continuity after failed preparation with $name', async ({
  oldAgentId,
  oldAdapter,
  resumes,
}) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-switch-resume-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const demo = createDemoWorkspaceForUser(FIXTURE_LOCAL_USER_ID);
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: DEMO_WORKSPACE_ID,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
    });
    const oldSessionId = testEntityId('as', 'resume-old-codex');
    const failedSessionId = testEntityId('as', 'resume-failed-opencode');
    const timestamp = '2026-10-17T15:00:00.000Z';
    const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
    const storage = {
      storageRef: 'wst_00000000-0000-7ac8-9f6c-13552db6aa87',
      workSlotRef: workerStorageDefaultWorkSlotRef(DEMO_WORKSPACE_ID, DEMO_THREAD_ID),
    };
    const oldTurn = oldAgentId
      ? TurnSchema.parse({
          id: testEntityId('tu', 'resume-old-turn'),
          owner: demo.thread.owner,
          threadId: DEMO_THREAD_ID,
          triggerActor: actor,
          agentId: oldAgentId,
          agentSessionId: oldSessionId,
          items: [],
          status: 'completed',
          error: null,
          configVersion: null,
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 0,
        })
      : null;
    const oldPackage = oldTurn
      ? resolveAgentEnvironmentPackage({
          coreDb,
          agentSetup: createTestAgentSetup({ agentId: oldAgentId!, adapter: oldAdapter }),
          agentSessionId: oldSessionId,
          triggerActor: actor,
          backend: { kind: 'openshell' },
          turn: oldTurn,
          turnInput: 'Earlier work',
          workspaceCwd: '/workspace',
          workspaceRoots: [],
        })
      : null;
    const failedTurn = TurnSchema.parse({
      id: testEntityId('tu', 'resume-failed-turn'),
      owner: demo.thread.owner,
      threadId: DEMO_THREAD_ID,
      triggerActor: actor,
      agentId: 'agent_opencode_server',
      agentSessionId: failedSessionId,
      items: [],
      status: 'failed',
      error: {
        code: 'worker_preparation_failed',
        message: 'Preparation failed before native open.',
      },
      configVersion: null,
      startedAt: '2026-10-17T15:01:00.000Z',
      completedAt: '2026-10-17T15:02:00.000Z',
      durationMs: 60_000,
    });
    const historicalSession = {
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      configVersion: null,
      environmentPackageSnapshotId: null,
      nativeHandleDigest: null,
      retainedStorage: null,
      policySnapshotId: null,
      sessionCompatibilityKey: null,
      sandboxSummary: null,
      stale: false,
      workspaceRoots: [],
    };
    // Import authored retained history, not live worker completion or physical release proof.
    // The later failed preparation captured no package or native reference; selection must walk past it.
    await store.importWorkspaceSnapshot({
      workspace: demo.workspace,
      threads: [demo.thread],
      knowledge: demo.knowledge,
      turns: [...(oldTurn ? [oldTurn] : []), failedTurn],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [
        ...(oldPackage
          ? [
              AgentSessionRecordSchema.parse({
                ...historicalSession,
                id: oldSessionId,
                agentId: oldAgentId,
                environmentPackageSnapshotId: oldPackage.snapshotId,
                status: 'closed',
                message: null,
                nativeHandleDigest: 'a'.repeat(64),
                retainedStorage: storage,
                createdAt: timestamp,
                updatedAt: timestamp,
              }),
            ]
          : []),
        AgentSessionRecordSchema.parse({
          ...historicalSession,
          id: failedSessionId,
          agentId: 'agent_opencode_server',
          status: 'failed',
          message: failedTurn.error!.message,
          createdAt: failedTurn.startedAt,
          updatedAt: failedTurn.completedAt,
        }),
      ],
      turnEvents: [],
      notebookInitialization: {
        requestId: '00000000-0000-4000-8000-000000000390',
        producer: actor,
        instructionReference: 'test-fixture:retained-native-resume-history',
      },
      initialNotebookFiles: Object.fromEntries(
        demo.knowledge.map((page) => [page.path, page.content])
      ),
    });
    if (oldPackage) {
      const workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
      try {
        applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          environmentPackage: oldPackage,
          createdAt: timestamp,
        });
      } finally {
        workspaceDb.sqlite.close();
      }
    }
    expect(store.getAgentSession(failedSessionId)).toMatchObject({
      status: 'failed',
      environmentPackageSnapshotId: null,
      nativeHandleDigest: null,
    });

    const turn = await store.createTurn(
      DEMO_WORKSPACE_ID,
      DEMO_THREAD_ID,
      'Try OpenCode again',
      actor
    );
    await store.updateTurn(turn.id, { agentId: 'agent_opencode_server' });
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
      workspaceId: workspaceIdForOwner(turn.owner),
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
      prepareAgentSessionContinuity: async () => 'absent',
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
    const agentSetup = createTestAgentSetup({
      agentId: 'agent_opencode_server',
      adapter: 'opencode',
    });
    if (!resumes) {
      const prepared = await executor.prepareAgentSessionForTurn(store, {
        turn: store.getTurnById(turn.id),
        turnInput: 'Try OpenCode again',
        freshAgentSessionId: agentSessionId,
        triggerActor: actor,
        agentSetup,
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      expect(prepared.workerStorageChoice).toBeUndefined();
    }
    await expect(
      executor.startTurn(store, turn.id, 'Try OpenCode again', {
        agentSessionId,
        attemptId,
        sandboxBindingRef: bindingRef,
        requestId: entry.requestId,
        triggerActor: actor,
        workspaceRoots: [],
        agentSetup,
      })
    ).rejects.toThrow('resume probe boundary');
    expect(offered).toEqual(resumes ? { locator: oldSessionId, digest: 'a'.repeat(64) } : null);
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
