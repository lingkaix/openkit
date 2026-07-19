import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertTaskModeAgentEnvironment,
  assertTaskModeRuntimeProvenance,
  DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH,
  evaluateTaskModeRealWorkerPrerequisites,
  runTaskModeRealWorkerStory,
  TASK_MODE_REAL_WORKER_HTTP_TIMEOUTS,
} from './task-mode-real-worker-runner.mjs';

const taskWorkerImageRef = 'openkit/worker-codex:0123456789ab-a1';
const fakeSecret = 'task-mode-secret-canary-value';

/** Configures the synthetic runtime without external effects. */
async function configureTestRuntime() {}

/** Returns the critical public provenance surfaces for one root and two children. */
function completeProvenanceSurface() {
  const capabilityCalls = [
    ['cap_root', 'req_root', 'rto_111111111111111111111111', 'rcl_aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['cap_child_a', 'req_child_a', 'rto_222222222222222222222222', 'rcl_bbbbbbbbbbbbbbbbbbbbbbbb'],
    ['cap_child_b', 'req_child_b', 'rto_333333333333333333333333', 'rcl_bbbbbbbbbbbbbbbbbbbbbbbb'],
  ].map(([id, requestId, runtimeOriginRef, runtimeCacheLineageRef]) => ({
    agentSessionId: 'ags_1',
    family: 'llm',
    id,
    packageSnapshotId: 'aep_snapshot_1',
    requestId,
    runtimeCacheLineageRef,
    runtimeOriginRef,
    serviceRef: 'worker-inference-gateway',
    status: 'succeeded',
    threadId: 'thread_1',
    turnId: 'turn_1',
  }));

  return {
    capabilityCalls,
    runtimeEvidence: [
      {
        agentSessionId: 'ags_1',
        backendType: 'openshell',
        backendVersion: '0.0.80',
        outcome: 'succeeded',
        phase: 'transcript-collection',
        requiredFeatures: ['runtime.evidence.v1', 'worker.runtime-provenance.v1'],
        summary:
          'Worker runtime provenance complete: 4 streams, 16 frames, 15 attributed, 1 unattributed, 1 root, 2 children, 3/3 gateway calls reconciled, gateway complete, bundles bundle_raw and bundle_index.',
        threadId: 'thread_1',
        turnId: 'turn_1',
      },
    ],
    threadItems: [
      {
        status: 'completed',
        text: 'Outer result.',
        turnId: 'turn_1',
        type: 'assistant-message',
      },
    ],
    turnId: 'turn_1',
    usageRecords: [
      ...capabilityCalls.map((call) => ({
        capabilityCallId: call.id,
        quantity: 100,
        source: 'llm-gateway-adapter-reported:input',
      })),
      {
        capabilityCallId: 'cap_child_b',
        quantity: 64,
        source: 'llm-gateway-adapter-reported:cache_read',
      },
    ],
  };
}

/** Returns one trusted AEP for the critical real-worker story. */
function completeAepSurface(imageRef = taskWorkerImageRef) {
  return {
    items: [
      {
        agentSessionId: 'ags_1',
        backendKind: 'openshell',
        runtimeKind: 'codex',
        snapshotId: 'aep_snapshot_1',
        snapshot: {
          backend: {
            requiredCapabilities: [
              'trusted-worker-inference-relay',
              'worker.runtime-provenance.v1',
            ],
          },
          control: { mode: 'direct-nanocore' },
          credentials: { declarations: [] },
          llm: {
            mode: 'gateway',
            routes: [
              {
                credentialVisibility: 'placeholder',
                endpoint: { upstream: { kind: 'nanocore-gateway' } },
                model: 'openai-codex/gpt-5.6-sol',
                providerInstanceId: 'openai_codex',
              },
            ],
          },
          policy: { secrets: { visibility: 'none' } },
          providers: { attachments: [] },
          runtime: { image: { ref: imageRef } },
          vault: { grants: [], references: [] },
        },
        turnId: 'turn_1',
      },
    ],
  };
}

/** Returns the enabled runner environment for disposable fixture paths. */
function enabledRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }) {
  return {
    OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
    OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
    OPENKIT_L6_NANOCORE_DATA_ROOT: dataRoot,
    OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
    OPENKIT_L6_TASK_REAL_WORKER: '1',
    OPENKIT_L6_TASK_REPO_ROOT: repositoryRoot,
    OPENKIT_L6_TASK_WORKER_IMAGE_REF: taskWorkerImageRef,
  };
}

/** Creates the two filesystem entries required by runner preflight. */
function initializeRunnerPaths(dataRoot, repositoryRoot) {
  mkdirSync(join(dataRoot, 'server', 'db'), { recursive: true });
  writeFileSync(join(dataRoot, 'server', 'db', 'core.sqlite'), '');
  mkdirSync(join(repositoryRoot, '.git'), { recursive: true });
}

/** Returns injected Core Client behavior for one complete critical story. */
function completeTaskModeClients() {
  const provenance = completeProvenanceSurface();
  const rejectedReviewIds = [];
  let workspaceCreated = false;
  const workspaceId = 'ws_task_acceptance';

  return {
    core: {
      app: {
        getCapabilityUsage: async () => ({
          capabilityCalls: provenance.capabilityCalls,
          usageRecords: provenance.usageRecords,
        }),
        getDiagnostics: async () => ({ boot: { acceptingProductWork: true } }),
        listAgentEnvironmentPackageSnapshots: async () => completeAepSurface(),
        listWorkspaceRuntimeEvidence: async () => ({
          runtimeEvidence: provenance.runtimeEvidence,
        }),
        startTaskMode: async () => ({
          evidence: { reviewIds: ['swr_1'] },
          state: 'completed',
          turn: { id: 'turn_1' },
        }),
        submitWorkspaceSyncReviewDecision: async (_workspaceId, reviewId, input) => {
          assert.equal(input.decision, 'rejected');
          rejectedReviewIds.push(reviewId);
          return { review: { id: reviewId, status: 'rejected' } };
        },
      },
      core: {
        createThread: async (input) => {
          assert.equal(workspaceCreated, true);
          assert.equal(input.workspaceId, workspaceId);
          return { id: 'thread_1' };
        },
        createWorkspace: async () => {
          workspaceCreated = true;
          return { id: workspaceId };
        },
        listThreadItems: async () => ({ items: provenance.threadItems, nextCursor: null }),
      },
      repositories: {
        setDefault: async () => ({ repository: { resourceId: 'default' } }),
      },
    },
    rejectedReviewIds,
  };
}

describe('real Task Mode worker L6 runner', () => {
  it('leaves the long request deadline to the story supervisor', () => {
    assert.deepEqual(TASK_MODE_REAL_WORKER_HTTP_TIMEOUTS, {
      bodyTimeout: 0,
      headersTimeout: 0,
    });
  });

  it('skips by default without real worker opt-in', () => {
    const result = evaluateTaskModeRealWorkerPrerequisites({ env: {}, fileExists: () => false });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_TASK_REAL_WORKER=1/);
  });

  it('requires explicit provider quota opt-in', () => {
    const result = evaluateTaskModeRealWorkerPrerequisites({
      env: { OPENKIT_L6_TASK_REAL_WORKER: '1' },
      fileExists: () => true,
    });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1/);
  });

  it('requires the local NanoCore data root', () => {
    const result = evaluateTaskModeRealWorkerPrerequisites({
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
        OPENKIT_L6_TASK_REAL_WORKER: '1',
      },
      fileExists: () => true,
    });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_NANOCORE_DATA_ROOT/);
  });

  it('accepts complete explicit real-worker prerequisites', () => {
    const env = enabledRunnerEnv({
      dataRoot: '/tmp/data',
      evidenceDir: '/tmp/evidence',
      repositoryRoot: '/tmp/repo',
    });
    const result = evaluateTaskModeRealWorkerPrerequisites({ env, fileExists: () => true });

    assert.equal(result.enabled, true);
    assert.equal(result.config.workerImageRef, taskWorkerImageRef);
  });

  it('requires an explicit worker image before quota use', () => {
    const env = enabledRunnerEnv({
      dataRoot: '/tmp/data',
      evidenceDir: '/tmp/evidence',
      repositoryRoot: '/tmp/repo',
    });
    delete env.OPENKIT_L6_TASK_WORKER_IMAGE_REF;
    const result = evaluateTaskModeRealWorkerPrerequisites({ env, fileExists: () => true });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_TASK_WORKER_IMAGE_REF/);
  });

  it('writes a skipped result without touching NanoCore', async () => {
    const result = await runTaskModeRealWorkerStory({
      env: {},
      fileExists: () => false,
      stdout: () => {},
    });

    assert.equal(result.status, 'skipped');
  });

  it('preserves controlled assertions in owner-only failure evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-assertion-'));
    const dataRoot = join(tempRoot, 'data');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    initializeRunnerPaths(dataRoot, repositoryRoot);

    await assert.rejects(
      () =>
        runTaskModeRealWorkerStory({
          clients: {
            core: {
              app: {
                getDiagnostics: async () => ({ boot: { acceptingProductWork: false } }),
              },
            },
          },
          configureRuntime: configureTestRuntime,
          env: {
            ...enabledRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
            OPENKIT_NANOCORE_TOKEN: fakeSecret,
          },
          stdout: () => {},
        }),
      /not accepting product work/i
    );

    const failurePath = join(evidenceDir, 'task-mode-real-worker-failure.json');
    const failureText = readFileSync(failurePath, 'utf8');
    assert.equal(failureText.includes(dataRoot), false);
    assert.equal(failureText.includes(fakeSecret), false);
    assert.equal(statSync(failurePath).mode & 0o777, 0o600);
    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('rejects a story that does not require real provider and Codex execution', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-story-'));
    const dataRoot = join(tempRoot, 'data');
    const storyPath = join(tempRoot, 'fake.story.md');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    initializeRunnerPaths(dataRoot, repositoryRoot);
    writeFileSync(
      storyPath,
      readFileSync(DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH, 'utf8')
        .replace('requires_real_provider: true', 'requires_real_provider: false')
        .replace('requires_real_codex: true', 'requires_real_codex: false')
    );

    await assert.rejects(
      () =>
        runTaskModeRealWorkerStory({
          configureRuntime: configureTestRuntime,
          env: enabledRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          stdout: () => {},
          storyPath,
        }),
      /must require real provider and real Codex execution/
    );
    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('asserts the real runtime forest, Gateway attribution, cache, and outer result', () => {
    const surface = completeProvenanceSurface();
    surface.capabilityCalls.push({
      family: 'llm',
      id: 'cap_unrelated',
      packageSnapshotId: 'aep_snapshot_1',
      requestId: 'req_unrelated',
      runtimeCacheLineageRef: 'rcl_cccccccccccccccccccccccc',
      runtimeOriginRef: 'rto_444444444444444444444444',
      serviceRef: 'quick-chat',
      status: 'succeeded',
      turnId: 'turn_1',
    });

    assert.deepEqual(assertTaskModeRuntimeProvenance(surface), {
      backendType: 'openshell',
      backendVersion: '0.0.80',
      cacheLineageCount: 2,
      cachedInputTokens: 64,
      capabilityCallCount: 3,
      childOriginCount: 2,
      packageSnapshotId: 'aep_snapshot_1',
      runtimeOriginCount: 3,
      runtimeRootCount: 1,
      streamCount: 4,
    });
  });

  it('accepts an attributed cancellation but rejects a failed Gateway call', () => {
    const surface = completeProvenanceSurface();
    const terminalCall = {
      ...surface.capabilityCalls[0],
      id: 'cap_terminal',
      requestId: 'req_terminal',
      status: 'cancelled',
    };
    surface.capabilityCalls.push(terminalCall);
    surface.runtimeEvidence[0].summary = surface.runtimeEvidence[0].summary.replace(
      '3/3 gateway calls',
      '4/4 gateway calls'
    );

    assert.equal(assertTaskModeRuntimeProvenance(surface).capabilityCallCount, 4);
    terminalCall.status = 'failed';
    assert.throws(() => assertTaskModeRuntimeProvenance(surface), /unsupported terminal status/i);
  });

  it('requires exactly one root and two children', () => {
    const surface = completeProvenanceSurface();
    surface.runtimeEvidence[0].summary = surface.runtimeEvidence[0].summary.replace(
      '1 root, 2 children',
      '2 roots, 2 children'
    );

    assert.throws(
      () => assertTaskModeRuntimeProvenance(surface),
      /exactly one root and two children/
    );
  });

  it('requires one trusted AEP and the exact worker image', () => {
    assert.deepEqual(
      assertTaskModeAgentEnvironment({
        aepRead: completeAepSurface(),
        expectedImageRef: taskWorkerImageRef,
        packageSnapshotId: 'aep_snapshot_1',
        turnId: 'turn_1',
      }),
      {
        agentSessionId: 'ags_1',
        backendKind: 'openshell',
        controlMode: 'direct-nanocore',
        imageRef: taskWorkerImageRef,
        modelId: 'openai-codex/gpt-5.6-sol',
        providerId: 'openai_codex',
        runtimeKind: 'codex',
        snapshotId: 'aep_snapshot_1',
      }
    );
    assert.throws(
      () =>
        assertTaskModeAgentEnvironment({
          aepRead: completeAepSurface('openkit/worker-codex:wrong'),
          expectedImageRef: taskWorkerImageRef,
          packageSnapshotId: 'aep_snapshot_1',
          turnId: 'turn_1',
        }),
      /acceptance image/
    );
  });

  it('completes the critical story and rejects returned reviews as cleanup', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-success-'));
    const dataRoot = join(tempRoot, 'data');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    initializeRunnerPaths(dataRoot, repositoryRoot);
    const clients = completeTaskModeClients();

    const result = await runTaskModeRealWorkerStory({
      clients,
      configureRuntime: configureTestRuntime,
      env: enabledRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
      stdout: () => {},
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.cleanup.rejectedReviewCount, 1);
    assert.deepEqual(clients.rejectedReviewIds, ['swr_1']);
    assert.equal(result.provenance.runtimeOriginCount, 3);
    for (const fileName of [
      'task-mode-real-worker-result.json',
      'task-mode-real-worker-redaction-notes.md',
    ]) {
      assert.equal(statSync(join(evidenceDir, fileName)).mode & 0o777, 0o600);
    }
    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('preserves a story assertion when review cleanup also fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-cleanup-failure-'));
    const dataRoot = join(tempRoot, 'data');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    initializeRunnerPaths(dataRoot, repositoryRoot);
    const clients = completeTaskModeClients();
    clients.core.app.listWorkspaceRuntimeEvidence = async () => ({ runtimeEvidence: [] });
    clients.core.app.submitWorkspaceSyncReviewDecision = async () => {
      throw new Error('synthetic cleanup failure');
    };

    await assert.rejects(
      () =>
        runTaskModeRealWorkerStory({
          clients,
          configureRuntime: configureTestRuntime,
          env: enabledRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          stdout: () => {},
        }),
      /did not produce runtime provenance evidence/
    );
    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('rejects needs-review as an unowned Task acceptance state', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-missing-review-'));
    const dataRoot = join(tempRoot, 'data');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    initializeRunnerPaths(dataRoot, repositoryRoot);
    const clients = completeTaskModeClients();
    clients.core.app.startTaskMode = async () => ({
      evidence: { reviewIds: ['review_1'] },
      state: 'needs-review',
      turn: { id: 'turn_1' },
    });

    await assert.rejects(
      () =>
        runTaskModeRealWorkerStory({
          clients,
          configureRuntime: configureTestRuntime,
          env: enabledRunnerEnv({ dataRoot, evidenceDir, repositoryRoot }),
          stdout: () => {},
        }),
      /non-acceptance state: needs-review/
    );
    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('records optional cache telemetry and rejects collapsed or leaked lineage', () => {
    const missingTelemetry = completeProvenanceSurface();
    missingTelemetry.usageRecords = missingTelemetry.usageRecords.filter(
      (row) => row.source !== 'llm-gateway-adapter-reported:cache_read'
    );
    assert.equal(assertTaskModeRuntimeProvenance(missingTelemetry).cachedInputTokens, 0);

    const isolated = completeProvenanceSurface();
    isolated.capabilityCalls[2].runtimeCacheLineageRef = 'rcl_cccccccccccccccccccccccc';
    assert.equal(assertTaskModeRuntimeProvenance(isolated).cacheLineageCount, 3);

    const leaked = completeProvenanceSurface();
    leaked.runtimeEvidence.push({ nativeThreadId: 'native-leak' });
    assert.throws(() => assertTaskModeRuntimeProvenance(leaked), /runtime-native metadata/);

    const collapsed = completeProvenanceSurface();
    for (const call of collapsed.capabilityCalls) {
      call.runtimeCacheLineageRef = 'rcl_aaaaaaaaaaaaaaaaaaaaaaaa';
    }
    assert.throws(
      () => assertTaskModeRuntimeProvenance(collapsed),
      /collapsed onto one cache lineage/
    );
  });
});
