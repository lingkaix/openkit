import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  assertTaskModeAgentEnvironment,
  assertTaskModeRuntimeProvenance,
  assertTaskModeWorkspaceProof,
  DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH,
  evaluateTaskModeRealWorkerPrerequisites,
  runTaskModeRealWorkerStory,
  TASK_MODE_REAL_WORKER_PROOF_PATH,
} from './task-mode-real-worker-runner.mjs';

const rawBundleId = 'evb_0123456789abcdef01234567';
const indexBundleId = 'evb_89abcdef0123456789abcdef';

/** Returns one complete public provenance surface for runner assertions. */
function completeProvenanceSurface() {
  const capabilityCalls = [
    ['cap_root', 'rto_111111111111111111111111', 'rcl_aaaaaaaaaaaaaaaaaaaaaaaa', 'req_root'],
    ['cap_child_a', 'rto_222222222222222222222222', 'rcl_bbbbbbbbbbbbbbbbbbbbbbbb', 'req_child_a'],
    ['cap_child_b', 'rto_333333333333333333333333', 'rcl_aaaaaaaaaaaaaaaaaaaaaaaa', 'req_child_b'],
  ].map(([id, runtimeOriginRef, runtimeCacheLineageRef, requestId]) => ({
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
    auditEvents: capabilityCalls.map((call) => ({
      action: 'capability.finish',
      capabilityCallId: call.id,
      outcome: 'succeeded',
      summary: 'Capability call succeeded.',
    })),
    capabilityCalls,
    evidenceBundles: [
      {
        id: rawBundleId,
        importStatus: 'promoted',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [],
        retentionClass: 'restricted-raw',
        sensitivityClass: 'restricted',
        sourceKind: 'worker-runtime-provenance-raw',
        turnId: 'turn_1',
      },
      {
        id: indexBundleId,
        importStatus: 'promoted',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [
          { kind: 'worker-runtime-provenance-index', ref: 'runtime-origin-index.jsonl' },
        ],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'product-safe',
        sourceKind: 'worker-runtime-provenance-index',
        turnId: 'turn_1',
      },
    ],
    runtimeEvidence: [
      {
        agentSessionId: 'ags_1',
        backendType: 'openshell',
        backendVersion: '0.0.80',
        evidenceBundleIds: [rawBundleId, indexBundleId],
        id: 'rte_0123456789abcdef01234567',
        outcome: 'succeeded',
        phase: 'transcript-collection',
        requiredFeatures: ['runtime.evidence.v1', 'worker.runtime-provenance.v1'],
        summary: `Worker runtime provenance complete: 4 streams, 16 frames, 15 attributed, 1 unattributed, 1 root, 2 children, 3/3 gateway calls reconciled, gateway complete, bundles ${rawBundleId} and ${indexBundleId}.`,
        threadId: 'thread_1',
        turnId: 'turn_1',
      },
      {
        agentSessionId: 'ags_1',
        outcome: 'succeeded',
        phase: 'teardown',
        stopReason: 'completed',
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

/** Returns one trusted AEP bound to the disposable repository base. */
function completeAepSurface(initialHead = 'a'.repeat(40)) {
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
                model: 'openai-codex/gpt-5.5',
                providerInstanceId: 'openai_codex',
              },
            ],
          },
          policy: { secrets: { visibility: 'none' } },
          providers: { attachments: [] },
          runtime: { image: { ref: 'openkit/worker-codex:dev' } },
          vault: { grants: [], references: [] },
          workspace: {
            inputs: [
              {
                access: 'read-write',
                materialization: { strategy: 'git' },
                source: { commit: initialHead },
              },
            ],
          },
        },
        turnId: 'turn_1',
      },
    ],
  };
}

/** Returns one pending review and its cleaned backend workspace handle. */
function completeWorkspaceProofSurface(initialHead = 'a'.repeat(40)) {
  const patchText = `diff --git a/${TASK_MODE_REAL_WORKER_PROOF_PATH} b/${TASK_MODE_REAL_WORKER_PROOF_PATH}
new file mode 100644
--- /dev/null
+++ b/${TASK_MODE_REAL_WORKER_PROOF_PATH}
@@ -0,0 +1,3 @@
+- Root inspected the repository.
+- Child A inspected runtime code.
+- Child B inspected story coverage.
`;
  return {
    backendHandles: [
      {
        cleanupStatus: 'cleaned',
        id: 'bwh_1',
        materializationRecordId: 'wmr_1',
      },
    ],
    review: {
      artifactId: 'artifact_1',
      changeSet: {
        base: { commit: initialHead },
        changedPaths: [{ path: TASK_MODE_REAL_WORKER_PROOF_PATH, status: 'added' }],
        materializationRecordId: 'wmr_1',
      },
      patchPayload: { text: patchText },
      review: {
        diffSummary: { additions: 3, deletions: 0, filesChanged: 1 },
        id: 'swr_1',
        status: 'pending',
      },
    },
    taskEvidence: {
      artifactIds: ['artifact_1'],
      reviewIds: ['swr_1'],
    },
  };
}

/**
 * Creates the empty Core database owned by one fresh Task acceptance data root.
 *
 * @param {string} dataRoot Fresh NanoCore data root.
 * @returns {void}
 */
function initializeTaskDataRoot(dataRoot) {
  const databasePath = join(dataRoot, 'server', 'db', 'core.sqlite');
  mkdirSync(join(dataRoot, 'server', 'db'), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE scheduler_session_leases (
      turn_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      status TEXT NOT NULL,
      release_reason TEXT,
      recovery_state TEXT
    );
    CREATE TABLE scheduler_capacity_records (
      target_id TEXT PRIMARY KEY,
      in_use_count INTEGER NOT NULL
    );
    CREATE TABLE worker_control_records (
      turn_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      record_key TEXT NOT NULL
    )
  `);
  database.close();
}

/**
 * Records the scheduler outcome emitted by the fake completed Task turn.
 *
 * @param {string} dataRoot Fresh NanoCore data root.
 * @param {{ finalStatusRecordCount?: number, inUseCount?: number, releaseReason: string, status: string }} lease Terminal or stale lease outcome.
 * @returns {void}
 */
function recordTaskLease(
  dataRoot,
  { finalStatusRecordCount = 1, inUseCount = 0, releaseReason, status }
) {
  const database = new DatabaseSync(join(dataRoot, 'server', 'db', 'core.sqlite'));
  database
    .prepare(
      'INSERT INTO scheduler_session_leases (turn_id, target_id, status, release_reason) VALUES (?, ?, ?, ?)'
    )
    .run('turn_1', 'target_1', status, releaseReason);
  database
    .prepare('INSERT INTO scheduler_capacity_records (target_id, in_use_count) VALUES (?, ?)')
    .run('target_1', inUseCount);
  const insertFinalStatus = database.prepare(
    'INSERT INTO worker_control_records (turn_id, operation, record_key) VALUES (?, ?, ?)'
  );
  for (let index = 0; index < finalStatusRecordCount; index += 1) {
    insertFinalStatus.run('turn_1', 'final_status', String(7 + index));
  }
  database.close();
}

/**
 * Returns complete fake clients with a configurable finalization defect.
 *
 * @param {{ dataRoot: string, initialHead: string, lease?: { finalStatusRecordCount?: number, inUseCount?: number, releaseReason: string, status: string }, reconciliationRecords?: Array<Record<string, unknown>> }} input Fixture input.
 * @returns {{ core: Record<string, unknown> }} Fake runner clients.
 */
function completeTaskModeClients({
  dataRoot,
  initialHead,
  lease = { releaseReason: 'turn-completed', status: 'released' },
  reconciliationRecords = [],
}) {
  const provenance = completeProvenanceSurface();
  const aepRead = completeAepSurface(initialHead);
  const workspaceProof = completeWorkspaceProofSurface(initialHead);
  let taskStarted = false;

  return {
    core: {
      actionCenter: {
        listHumanAttention: async () => ({ items: [] }),
      },
      app: {
        getCapabilityUsage: async () => ({
          capabilityCalls: provenance.capabilityCalls,
          usageRecords: provenance.usageRecords,
        }),
        getDiagnostics: async () => ({ boot: { acceptingProductWork: true } }),
        listAgentEnvironmentPackageSnapshots: async () => aepRead,
        listBackendWorkspaceHandles: async () => ({ items: workspaceProof.backendHandles }),
        listWorkspaceAuditEvents: async () => ({ auditEvents: provenance.auditEvents }),
        listWorkspaceEvidenceBundles: async () => ({
          evidenceBundles: provenance.evidenceBundles,
        }),
        listWorkspaceReconciliationRecords: async () => ({
          items: taskStarted ? reconciliationRecords : [],
        }),
        listWorkspaceRuntimeEvidence: async () => ({
          runtimeEvidence: provenance.runtimeEvidence,
        }),
        listWorkspaceSyncReviews: async () => ({ items: [workspaceProof.review] }),
        startTaskMode: async () => {
          taskStarted = true;
          recordTaskLease(dataRoot, lease);
          return {
            decision: {
              mode: 'task',
              worker: { agentId: 'agent_codex_host', runtime: 'codex' },
            },
            evidence: workspaceProof.taskEvidence,
            state: 'completed',
            turn: { id: 'turn_1' },
          };
        },
        submitWorkspaceSyncReviewDecision: async (_workspaceId, reviewId, input) => {
          assert.equal(reviewId, 'swr_1');
          assert.equal(input.decision, 'rejected');
          return { review: { id: reviewId, status: 'rejected' } };
        },
      },
      core: {
        createThread: async () => ({ id: 'thread_1' }),
        listThreadItems: async () => ({ items: provenance.threadItems, nextCursor: null }),
      },
      repositories: {
        setDefault: async () => ({ repository: { resourceId: 'default' } }),
      },
    },
  };
}

describe('real Task Mode worker L6 runner', () => {
  it('skips by default without real worker opt-in', () => {
    const result = evaluateTaskModeRealWorkerPrerequisites({
      env: {},
      fileExists: () => false,
    });

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

  it('requires the local NanoCore data root for scheduler finalization evidence', () => {
    const result = evaluateTaskModeRealWorkerPrerequisites({
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_EVIDENCE_DIR: '/tmp/openkit-task-evidence',
        OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
        OPENKIT_L6_TASK_REAL_WORKER: '1',
        OPENKIT_L6_TASK_REPO_ROOT: '/tmp/openkit-task-repo',
      },
      fileExists: () => true,
    });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_TASK_NANOCORE_DATA_ROOT/);
  });

  it('accepts complete explicit real-worker prerequisites', () => {
    const result = evaluateTaskModeRealWorkerPrerequisites({
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_EVIDENCE_DIR: '/tmp/openkit-task-evidence',
        OPENKIT_L6_TASK_NANOCORE_DATA_ROOT: '/tmp/openkit-task-data',
        OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
        OPENKIT_L6_TASK_REAL_WORKER: '1',
        OPENKIT_L6_TASK_REPO_ROOT: '/tmp/openkit-task-repo',
      },
      fileExists: (path) =>
        path === '/tmp/openkit-task-repo/.git' ||
        path === '/tmp/openkit-task-data' ||
        path === '/tmp/openkit-task-data/server/db/core.sqlite' ||
        path.endsWith('task-mode-real-worker-release.story.md'),
    });

    assert.equal(result.enabled, true);
    assert.equal(result.config.nanoCoreDataRoot, '/tmp/openkit-task-data');
    assert.match(result.config.taskInput, /exactly two Codex sub-agents/);
  });

  it('writes a skipped result without touching NanoCore when opt-in is absent', async () => {
    const result = await runTaskModeRealWorkerStory({
      env: {},
      fileExists: () => false,
      stdout: () => {},
    });

    assert.equal(result.status, 'skipped');
  });

  it('uses only the Core Client public surface', () => {
    const source = readFileSync(
      new URL('./task-mode-real-worker-runner.mjs', import.meta.url),
      'utf8'
    );

    assert.doesNotMatch(source, /mcp\/dist/);
    assert.doesNotMatch(source, /\bregistry\b/);
  });

  it('rejects a story that does not require real provider and Codex execution', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-runner-'));
    const dataRoot = join(tempRoot, 'data');
    const storyPath = join(tempRoot, 'fake.story.md');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    const storyText = readFileSync(DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH, 'utf8')
      .replace('requires_real_provider: true', 'requires_real_provider: false')
      .replace('requires_real_codex: true', 'requires_real_codex: false');

    initializeTaskDataRoot(dataRoot);
    mkdirSync(join(repositoryRoot, '.git'), { recursive: true });
    mkdirSync(evidenceDir, { recursive: true });
    await import('node:fs/promises').then((fs) => fs.writeFile(storyPath, storyText));

    await assert.rejects(
      () =>
        runTaskModeRealWorkerStory({
          env: {
            OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
            OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
            OPENKIT_L6_TASK_NANOCORE_DATA_ROOT: dataRoot,
            OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
            OPENKIT_L6_TASK_REAL_WORKER: '1',
            OPENKIT_L6_TASK_REPO_ROOT: repositoryRoot,
          },
          stdout: () => {},
          storyPath,
        }),
      /must require real provider and real Codex execution/
    );

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('asserts the public runtime forest, relay, cache, telemetry, audit, and outer result', () => {
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
      auditEventCount: 3,
      backendType: 'openshell',
      backendVersion: '0.0.80',
      cacheLineageCount: 2,
      cachedInputTokens: 64,
      capabilityCallCount: 3,
      childOriginCount: 2,
      indexBundleId,
      positiveCacheReadObserved: true,
      rawBundleId,
      packageSnapshotId: 'aep_snapshot_1',
      runtimeOriginCount: 3,
      runtimeRootCount: 1,
      streamCount: 4,
      teardownEvidenceCount: 1,
    });
  });

  it('requires exactly one root, two children, and successful teardown evidence', () => {
    const extraRoot = completeProvenanceSurface();
    extraRoot.runtimeEvidence[0].summary = extraRoot.runtimeEvidence[0].summary.replace(
      '1 root, 2 children',
      '2 roots, 2 children'
    );
    assert.throws(
      () => assertTaskModeRuntimeProvenance(extraRoot),
      /exactly one root and two children/
    );

    const missingTeardown = completeProvenanceSurface();
    missingTeardown.runtimeEvidence = missingTeardown.runtimeEvidence.filter(
      (record) => record.phase !== 'teardown'
    );
    assert.throws(
      () => assertTaskModeRuntimeProvenance(missingTeardown),
      /successful terminal teardown/
    );
  });

  it('requires one trusted gpt-5.5 AEP bound to the exact repository base', () => {
    const initialHead = 'a'.repeat(40);
    assert.deepEqual(
      assertTaskModeAgentEnvironment({
        aepRead: completeAepSurface(initialHead),
        initialHead,
        packageSnapshotId: 'aep_snapshot_1',
        turnId: 'turn_1',
      }),
      {
        agentSessionId: 'ags_1',
        backendKind: 'openshell',
        controlMode: 'direct-nanocore',
        imageRef: 'openkit/worker-codex:dev',
        modelId: 'openai-codex/gpt-5.5',
        providerId: 'openai_codex',
        runtimeKind: 'codex',
        snapshotId: 'aep_snapshot_1',
        sourceCommitMatched: true,
      }
    );

    const stale = completeAepSurface('b'.repeat(40));
    assert.throws(
      () =>
        assertTaskModeAgentEnvironment({
          aepRead: stale,
          initialHead,
          packageSnapshotId: 'aep_snapshot_1',
          turnId: 'turn_1',
        }),
      /repository base/
    );
  });

  it('requires one exact pending proof review and a cleaned backend handle', () => {
    const initialHead = 'a'.repeat(40);
    assert.deepEqual(
      assertTaskModeWorkspaceProof({ initialHead, ...completeWorkspaceProofSurface(initialHead) }),
      {
        backendHandleCount: 1,
        changedPaths: [TASK_MODE_REAL_WORKER_PROOF_PATH],
        reviewId: 'swr_1',
      }
    );

    const retained = completeWorkspaceProofSurface(initialHead);
    retained.backendHandles[0].cleanupStatus = 'retained';
    assert.throws(
      () => assertTaskModeWorkspaceProof({ initialHead, ...retained }),
      /backend workspace cleanup/
    );
  });

  it('uses the story timeout and closes the runner transport after failure', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-timeout-'));
    const dataRoot = join(tempRoot, 'data');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    initializeTaskDataRoot(dataRoot);
    initializeRepository(repositoryRoot);
    let clientTimeoutMs;
    let closed = false;
    let failure;
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = async () => {
        throw new Error('Runner used the default fetch instead of the injected client factory.');
      };
      await runTaskModeRealWorkerStory({
        createClients: async (_config, timeoutMs) => {
          clientTimeoutMs = timeoutMs;
          return {
            close: async () => {
              closed = true;
            },
            core: {
              app: {
                getDiagnostics: async () => {
                  throw new Error('Expected Core Client failure.');
                },
              },
            },
          };
        },
        env: {
          OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
          OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
          OPENKIT_L6_TASK_NANOCORE_DATA_ROOT: dataRoot,
          OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
          OPENKIT_L6_TASK_REAL_WORKER: '1',
          OPENKIT_L6_TASK_REPO_ROOT: repositoryRoot,
        },
        stdout: () => {},
      });
    } catch (error) {
      failure = error;
    } finally {
      globalThis.fetch = originalFetch;
    }

    rmSync(tempRoot, { force: true, recursive: true });
    assert.match(String(failure), /Expected Core Client failure/);
    assert.equal(clientTimeoutMs, 3_600_000);
    assert.equal(closed, true);
  });

  it('enforces the absolute story budget and closes the runner transport', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-deadline-'));
    const dataRoot = join(tempRoot, 'data');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    initializeTaskDataRoot(dataRoot);
    initializeRepository(repositoryRoot);
    const controller = new AbortController();
    controller.abort();
    let clientDeadlineSignal;
    let closed = false;

    const storyRun = runTaskModeRealWorkerStory({
      createClients: async (_config, _timeoutMs, deadlineSignal) => {
        clientDeadlineSignal = deadlineSignal;
        return {
          close: async () => {
            closed = true;
          },
          core: {},
        };
      },
      createDeadlineSignal: (timeoutMs) => {
        assert.equal(timeoutMs, 3_600_000);
        return controller.signal;
      },
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
        OPENKIT_L6_TASK_NANOCORE_DATA_ROOT: dataRoot,
        OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
        OPENKIT_L6_TASK_REAL_WORKER: '1',
        OPENKIT_L6_TASK_REPO_ROOT: repositoryRoot,
      },
      stdout: () => {},
    });
    const outcome = await Promise.race([
      storyRun.then(
        () => new Error('Runner unexpectedly completed.'),
        (error) => error
      ),
      new Promise((resolve) => {
        setTimeout(() => resolve(new Error('Runner ignored the story execution budget.')), 50);
      }),
    ]);

    rmSync(tempRoot, { force: true, recursive: true });
    assert.match(String(outcome), /exceeded its 3600000 ms execution budget/);
    assert.equal(clientDeadlineSignal, controller.signal);
    assert.equal(closed, true);
  });

  it('rejects the staged review after a complete real Task proof flow', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-success-'));
    const dataRoot = join(tempRoot, 'data');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    initializeTaskDataRoot(dataRoot);
    initializeRepository(repositoryRoot);
    const initialHead = git(repositoryRoot, ['rev-parse', 'HEAD']);
    const clients = completeTaskModeClients({ dataRoot, initialHead });

    const result = await runTaskModeRealWorkerStory({
      clients,
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
        OPENKIT_L6_TASK_NANOCORE_DATA_ROOT: dataRoot,
        OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
        OPENKIT_L6_TASK_REAL_WORKER: '1',
        OPENKIT_L6_TASK_REPO_ROOT: repositoryRoot,
      },
      stdout: () => {},
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.cleanup.reviewDecision, 'rejected');
    assert.equal(result.git.headUnchanged, true);
    assert.equal(result.git.statusShort, '');
    assert.equal(git(repositoryRoot, ['status', '--short', '--untracked-files=all']), '');

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('rejects incomplete finalization evidence on fresh data roots', async () => {
    const timestamp = '2026-07-14T00:00:00.000Z';
    const reconciliationRecord = {
      affectedRecordIds: ['wmr_1', 'bwh_1'],
      backendHandleSummary: {
        backendKind: 'openshell',
        cleanupStatus: 'pending',
        handleId: 'bwh_1',
        workerSessionId: 'session_1',
      },
      backendReachability: {
        checkedAt: timestamp,
        detail: 'heartbeat-timeout',
        status: 'unavailable',
      },
      collectedOutputManifestIds: [],
      evidenceBundleIds: [],
      finishedAt: null,
      id: 'wrr_1',
      quarantineRefs: [],
      requiredHumanDecision: 'inspect_recovery',
      retentionDecision: 'retain-backend',
      startedAt: timestamp,
      stateAfter: 'requires-human',
      stateBefore: 'lease-stale',
      triggerReason: 'backend_takeover',
      workspaceId: 'ws_demo',
    };
    const scenarios = [
      {
        expected: /scheduler lease was not released with turn-completed/,
        lease: { releaseReason: 'heartbeat-timeout', status: 'stale' },
        reconciliationRecords: [],
      },
      {
        expected: /requires-human backend_takeover workspace reconciliation/,
        lease: { releaseReason: 'turn-completed', status: 'released' },
        reconciliationRecords: [reconciliationRecord],
      },
      {
        expected: /scheduler capacity was not released/,
        lease: { inUseCount: 1, releaseReason: 'turn-completed', status: 'released' },
        reconciliationRecords: [],
      },
      {
        expected: /exactly one accepted final_status record/,
        lease: {
          finalStatusRecordCount: 0,
          releaseReason: 'turn-completed',
          status: 'released',
        },
        reconciliationRecords: [],
      },
      {
        expected: /exactly one accepted final_status record/,
        lease: {
          finalStatusRecordCount: 2,
          releaseReason: 'turn-completed',
          status: 'released',
        },
        reconciliationRecords: [],
      },
    ];

    for (const scenario of scenarios) {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-finalization-'));
      const dataRoot = join(tempRoot, 'data');
      const repositoryRoot = join(tempRoot, 'repo');
      const evidenceDir = join(tempRoot, 'evidence');
      initializeTaskDataRoot(dataRoot);
      initializeRepository(repositoryRoot);
      const initialHead = git(repositoryRoot, ['rev-parse', 'HEAD']);
      const clients = completeTaskModeClients({
        dataRoot,
        initialHead,
        lease: scenario.lease,
        reconciliationRecords: scenario.reconciliationRecords,
      });

      try {
        await assert.rejects(
          () =>
            runTaskModeRealWorkerStory({
              clients,
              env: {
                OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
                OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
                OPENKIT_L6_TASK_NANOCORE_DATA_ROOT: dataRoot,
                OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
                OPENKIT_L6_TASK_REAL_WORKER: '1',
                OPENKIT_L6_TASK_REPO_ROOT: repositoryRoot,
              },
              stdout: () => {},
            }),
          scenario.expected
        );
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    }
  });

  it('reports zero or unreported cache reads and rejects runtime-native leaks', () => {
    const missingTelemetry = completeProvenanceSurface();
    missingTelemetry.usageRecords = missingTelemetry.usageRecords.filter(
      (row) => row.source !== 'llm-gateway-adapter-reported:cache_read'
    );
    assert.equal(
      assertTaskModeRuntimeProvenance(missingTelemetry).positiveCacheReadObserved,
      false
    );
    assert.equal(assertTaskModeRuntimeProvenance(missingTelemetry).cachedInputTokens, 0);

    const isolated = completeProvenanceSurface();
    isolated.capabilityCalls[2].runtimeCacheLineageRef = 'rcl_cccccccccccccccccccccccc';
    assert.equal(assertTaskModeRuntimeProvenance(isolated).cacheLineageCount, 3);

    const leaked = completeProvenanceSurface();
    leaked.auditEvents.push({
      capabilityCallId: null,
      outcome: 'succeeded',
      summary: 'nativeThreadId leaked',
    });
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

/** Initializes one clean disposable repository with a baseline commit. */
function initializeRepository(repositoryRoot) {
  mkdirSync(repositoryRoot, { recursive: true });
  writeFileSync(join(repositoryRoot, 'README.md'), '# Disposable Task L6 Repository\n');
  execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot });
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=OpenKit L6',
      '-c',
      'user.email=l6@example.test',
      'commit',
      '--quiet',
      '-m',
      'chore: initialize disposable Task repository',
    ],
    { cwd: repositoryRoot }
  );
}

/** Runs one read-only Git command in a disposable repository. */
function git(repositoryRoot, args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
