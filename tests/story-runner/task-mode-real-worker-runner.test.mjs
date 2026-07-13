import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertTaskModeRuntimeProvenance,
  DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH,
  evaluateTaskModeRealWorkerPrerequisites,
  runTaskModeRealWorkerStory,
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

  it('accepts complete explicit real-worker prerequisites', () => {
    const result = evaluateTaskModeRealWorkerPrerequisites({
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_EVIDENCE_DIR: '/tmp/openkit-task-evidence',
        OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
        OPENKIT_L6_TASK_REAL_WORKER: '1',
        OPENKIT_L6_TASK_REPO_ROOT: '/tmp/openkit-task-repo',
      },
      fileExists: (path) =>
        path === '/tmp/openkit-task-repo/.git' ||
        path.endsWith('task-mode-real-worker-release.story.md'),
    });

    assert.equal(result.enabled, true);
  });

  it('writes a skipped result without touching NanoCore when opt-in is absent', async () => {
    const result = await runTaskModeRealWorkerStory({
      env: {},
      fileExists: () => false,
      stdout: () => {},
    });

    assert.equal(result.status, 'skipped');
  });

  it('rejects a story that does not require real provider and Codex execution', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-runner-'));
    const storyPath = join(tempRoot, 'fake.story.md');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    const storyText = readFileSync(DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH, 'utf8')
      .replace('requires_real_provider: true', 'requires_real_provider: false')
      .replace('requires_real_codex: true', 'requires_real_codex: false');

    mkdirSync(join(repositoryRoot, '.git'), { recursive: true });
    mkdirSync(evidenceDir, { recursive: true });
    await import('node:fs/promises').then((fs) => fs.writeFile(storyPath, storyText));

    await assert.rejects(
      () =>
        runTaskModeRealWorkerStory({
          env: {
            OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
            OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
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
      runtimeOriginCount: 3,
      runtimeRootCount: 1,
      streamCount: 4,
    });
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
