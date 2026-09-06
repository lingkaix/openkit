import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { seedWritableGitRepository } from '../test-support/git-repository.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
  parseWorkspaceChangeSetManifest,
  stageWorkspaceChangeSet,
} from './workspace-materializer.js';

describe('workspace materializer records', () => {
  it('builds product-safe input snapshots from an Agent Environment Package', () => {
    const store = createDemoStore();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-materializer-snapshot-'));
    seedWritableGitRepository(repositoryPath);
    const turn = store.createTurn('ws_demo', 'th_demo', 'Update docs', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'session_1',
      triggerActor: turn.triggerActor,
      userId: 'user_local',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-06-27T00:00:00.000Z',
      requestId: 'req_1',
      turn,
      turnInput: 'Update docs',
      workspaceCwd: null,
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath: repositoryPath,
          workerPath: '/workspace/openkit',
        },
      ],
    });

    const snapshots = buildWorkspaceInputSnapshots({
      backendCapabilities: ['git-materialization', 'change-set-collection'],
      backendKind: 'openshell',
      createdAt: '2026-06-27T01:00:00.000Z',
      environmentPackage,
    });

    expect(snapshots).toEqual([
      expect.objectContaining({
        backend: {
          capabilitySummary: ['git-materialization', 'change-set-collection'],
          kind: 'openshell',
          label: 'openshell worker backend',
        },
        createdAt: '2026-06-27T01:00:00.000Z',
        pathScope: ['repo'],
        resourceId: 'repo',
        strategy: 'git',
        writableRoots: ['repo'],
      }),
    ]);
    expect(JSON.stringify(snapshots)).not.toContain('/Users/m5pro');
  });

  it('builds the exact S39 context handoff without changing generated near misses', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Use the accepted context package', {
      kind: 'user',
      id: 'user_local',
    });
    const packageRootDigest = `sha256:${'a'.repeat(64)}`;
    const environmentPackage = resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'session_context_1',
      triggerActor: turn.triggerActor,
      userId: 'user_local',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T01:00:00.000Z',
      requestId: 'req_context_1',
      turn,
      turnInput: 'Use the accepted context package',
      workspaceCwd: null,
      workspaceRoots: [],
    });
    const contextInput: AgentEnvironmentPackage['workspace']['inputs'][number] = {
      access: 'read-only',
      id: `context_${turn.id}`,
      kind: 'generated',
      materialization: {
        contentDigest: packageRootDigest,
        slotId: 'context',
        strategy: 'filesystem',
      },
      source: {
        kind: 'generated',
        pathRef: `threads/${turn.threadId}/turns/${turn.id}/context-package`,
      },
      target: '/openkit/sessions/session_context_1/context',
    };
    const nearMissInput: AgentEnvironmentPackage['workspace']['inputs'][number] = {
      ...contextInput,
      id: `context_${turn.id}_near_miss`,
      target: '/openkit/turn-inputs/context',
    };
    const withContextInputs: AgentEnvironmentPackage = {
      ...environmentPackage,
      workspace: {
        ...environmentPackage.workspace,
        generatedFiles: [
          {
            access: 'read-only',
            contentRef: 'inline://worker-request',
            id: 'worker_request',
            target: '/openkit/turn-inputs/request.json',
          },
        ],
        inputs: [contextInput, nearMissInput],
      },
    };
    const snapshots = buildWorkspaceInputSnapshots({
      backendCapabilities: ['filesystem-materialization', 'backend-only-capability'],
      backendKind: 'openshell',
      createdAt: '2026-07-18T01:01:00.000Z',
      environmentPackage: withContextInputs,
    });
    const contextSnapshot = snapshots[0];
    const nearMissSnapshot = snapshots[1];

    expect(contextSnapshot).toEqual({
      backend: {
        capabilitySummary: withContextInputs.backend.requiredCapabilities,
        kind: 'openshell',
        label: 'openshell worker backend',
      },
      base: { commit: null, contentDigest: packageRootDigest },
      createdAt: '2026-07-18T01:01:00.000Z',
      generatedFiles: [],
      id: `wis_${environmentPackage.snapshotId}_context_${turn.id}`,
      ignoredPaths: [],
      pathScope: [`context_${turn.id}`],
      resourceId: `context_${turn.id}`,
      resourceKind: 'filesystem',
      strategy: 'filesystem',
      workspaceId: 'ws_demo',
      writableRoots: [],
    });
    expect(nearMissSnapshot).toMatchObject({
      backend: {
        capabilitySummary: ['filesystem-materialization', 'backend-only-capability'],
        kind: 'openshell',
        label: 'openshell worker backend',
      },
      generatedFiles: [{ id: 'worker_request', target: 'openkit/turn-inputs/request.json' }],
      resourceKind: 'git_repository',
      strategy: 'git',
    });

    const records = buildWorkspaceMaterializationRecords({
      createdAt: '2026-07-18T01:02:00.000Z',
      inputSnapshots: snapshots,
      materialization: {
        backendKind: 'openshell',
        backendStatus: { health: 'ready', version: '0.0.80' },
        packageSnapshotId: environmentPackage.snapshotId,
        requiredCapabilities: ['filesystem-materialization'],
        sandbox: { name: 'backend_session_context_1', state: 'created' },
        workspaceInputs: [
          { id: contextInput.id, target: contextInput.target },
          { id: nearMissInput.id, target: nearMissInput.target },
        ],
      },
    });

    expect(records[0]).toMatchObject({
      backendKind: 'openshell',
      base: { commit: null, contentDigest: packageRootDigest },
      createdAt: '2026-07-18T01:01:00.000Z',
      id: `wmr_${environmentPackage.snapshotId}_context_${turn.id}`,
      inputSnapshotId: `wis_${environmentPackage.snapshotId}_context_${turn.id}`,
      materializedRootRef: '/openkit/sessions/session_context_1/context',
      packageSnapshotId: environmentPackage.snapshotId,
      strategy: 'filesystem',
      workerSessionId: 'backend_session_context_1',
      workspaceId: 'ws_demo',
    });
    expect(records[0]).not.toHaveProperty('sourceId');
    expect(records[1]).toMatchObject({
      createdAt: '2026-07-18T01:02:00.000Z',
      materializedRootRef: '/openkit/turn-inputs/context',
      strategy: 'git',
    });
  });

  it('carries catalog source ids into workspace lineage records', () => {
    const store = createDemoStore();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-materializer-source-'));
    seedWritableGitRepository(repositoryPath);
    const turn = store.createTurn('ws_demo', 'th_demo', 'Update docs from catalog source', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup(),
      agentSessionId: 'session_source_1',
      triggerActor: turn.triggerActor,
      userId: 'user_local',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-06-27T00:00:00.000Z',
      requestId: 'req_source_1',
      turn,
      workspaceCwd: null,
      workspaceDataSourceCatalog: {
        schemaVersion: 1,
        sources: [
          {
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
            displayName: 'Main repository',
            id: 'repo_default',
            kind: 'git',
            locator: { repositoryResourceId: 'repo_default' },
            sensitivity: 'internal',
            status: 'active',
          },
        ],
      },
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo_default',
          sourceKind: 'host-dir',
          sourcePath: repositoryPath,
          workerPath: '/workspace/openkit',
        },
      ],
      workspaceSourceRefs: { repo_default: 'repo_default' },
    });
    const snapshots = buildWorkspaceInputSnapshots({
      backendCapabilities: ['git-materialization'],
      backendKind: 'openshell',
      createdAt: '2026-06-27T01:00:00.000Z',
      environmentPackage,
    });
    const records = buildWorkspaceMaterializationRecords({
      createdAt: '2026-06-27T01:01:00.000Z',
      inputSnapshots: snapshots,
      materialization: {
        backendKind: 'openshell',
        packageSnapshotId: 'pkg_source_1',
        requiredCapabilities: ['container'],
        workspaceInputs: [{ id: 'repo_default', target: '/workspace/openkit' }],
      },
    });

    expect(snapshots[0]).toMatchObject({ resourceId: 'repo_default', sourceId: 'repo_default' });
    expect(records[0]).toMatchObject({
      inputSnapshotId: snapshots[0]?.id,
      sourceId: 'repo_default',
    });
  });

  it('builds product-safe materialization records from backend summaries', () => {
    const snapshots = [
      {
        backend: {
          capabilitySummary: ['git-materialization'],
          kind: 'openshell',
          label: 'openshell worker backend',
        },
        base: { commit: 'abc123', contentDigest: null },
        createdAt: '2026-06-27T01:00:00.000Z',
        generatedFiles: [],
        id: 'wis_pkg_1_repo',
        ignoredPaths: [],
        pathScope: ['repo'],
        resourceId: 'repo',
        resourceKind: 'git_repository',
        strategy: 'git',
        workspaceId: 'ws_demo',
        writableRoots: ['repo'],
      },
    ] as const;

    const records = buildWorkspaceMaterializationRecords({
      createdAt: '2026-06-27T01:01:00.000Z',
      inputSnapshots: snapshots,
      materialization: {
        backendKind: 'openshell',
        backendStatus: { health: 'ready', version: '0.0.63' },
        packageSnapshotId: 'pkg_1',
        requiredCapabilities: ['container', 'transcript-sink'],
        sandbox: { name: 'sandbox_pkg_1', state: 'created' },
        workspaceInputs: [{ id: 'repo', target: '/workspace/openkit' }],
      },
    });

    expect(records).toEqual([
      expect.objectContaining({
        backendKind: 'openshell',
        id: 'wmr_pkg_1_repo',
        inputSnapshotId: 'wis_pkg_1_repo',
        materializedRootRef: '/workspace/openkit',
        packageSnapshotId: 'pkg_1',
        strategy: 'git',
        workerSessionId: 'sandbox_pkg_1',
      }),
    ]);
    expect(records[0]?.policyDigest).toMatch(/^sha256:/);
    expect(records[0]?.readinessEvidence).toEqual([
      { kind: 'backend.ready', ref: 'version:0.0.63' },
      { kind: 'sandbox.created', ref: 'sandbox_pkg_1' },
    ]);
    expect(JSON.stringify(records)).not.toContain('/Users/m5pro');
  });

  it('parses a git workspace change manifest with relative changed paths', () => {
    const parsed = parseWorkspaceChangeSetManifest(
      JSON.stringify({
        id: 'wcs_1',
        materializationRecordId: 'wmr_1',
        inputSnapshotId: 'wis_1',
        workspaceId: 'ws_demo',
        resourceId: 'repo',
        strategy: 'git',
        base: { commit: 'abc123', contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [
          { path: 'docs/spec.md', status: 'modified', binary: false },
          { path: 'apps/nanocore/src/runtime/workspace-materializer.ts', status: 'added' },
        ],
        patch: { ref: 'artifact://patch', digest: 'sha256:patch', bytes: 1200 },
        bundle: null,
        artifactIds: ['ar_patch'],
        evidenceRefs: [{ kind: 'test', ref: 'ev_test' }],
        redaction: { status: 'redacted', notes: [] },
        createdAt: '2026-06-27T01:00:00.000Z',
      })
    );

    expect(parsed.changedPaths.map((entry) => entry.path)).toEqual([
      'docs/spec.md',
      'apps/nanocore/src/runtime/workspace-materializer.ts',
    ]);
  });

  it('rejects a present workspace change manifest with no changed paths', () => {
    expect(() =>
      parseWorkspaceChangeSetManifest(
        JSON.stringify({
          artifactIds: [],
          base: { commit: 'abc123', contentDigest: null },
          bundle: null,
          changedPaths: [],
          createdAt: '2026-06-27T01:00:00.000Z',
          evidenceRefs: [],
          head: { commit: 'abc123', contentDigest: null },
          id: 'wcs_empty',
          inputSnapshotId: 'wis_1',
          materializationRecordId: 'wmr_1',
          patch: null,
          redaction: { notes: [], status: 'no-sensitive-content-found' },
          resourceId: 'repo',
          strategy: 'git',
          workspaceId: 'ws_demo',
        })
      )
    ).toThrow('semantically empty');
  });

  it('rejects manifests that escape the declared workspace path scope', () => {
    expect(() =>
      parseWorkspaceChangeSetManifest(
        JSON.stringify({
          id: 'wcs_1',
          materializationRecordId: 'wmr_1',
          inputSnapshotId: 'wis_1',
          workspaceId: 'ws_demo',
          resourceId: 'repo',
          strategy: 'git',
          base: { commit: 'abc123', contentDigest: null },
          head: { commit: 'def456', contentDigest: null },
          changedPaths: [{ path: 'apps/secret.txt', status: 'modified' }],
          patch: { ref: 'artifact://patch', digest: 'sha256:patch', bytes: 1200 },
          bundle: null,
          artifactIds: [],
          evidenceRefs: [],
          redaction: { status: 'redacted', notes: [] },
          createdAt: '2026-06-27T01:00:00.000Z',
        }),
        { allowedPathPrefixes: ['docs'] }
      )
    ).toThrow('unsafe workspace change path');
  });

  it('stages parsed change sets as pending workspace reviews', () => {
    const patchText = [
      'diff --git a/docs/spec.md b/docs/spec.md',
      '--- a/docs/spec.md',
      '+++ b/docs/spec.md',
      '@@ -1 +1,3 @@',
      '-Old finding',
      '+- Root finding',
      '+- First child finding',
      '+- Second child finding',
      '',
    ].join('\n');
    const changeSet = parseWorkspaceChangeSetManifest(
      JSON.stringify({
        id: 'wcs_1',
        materializationRecordId: 'wmr_1',
        inputSnapshotId: 'wis_1',
        workspaceId: 'ws_demo',
        resourceId: 'repo',
        strategy: 'git',
        base: { commit: 'abc123', contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [{ path: 'docs/spec.md', status: 'modified', binary: false }],
        patch: { ref: 'artifact://patch', digest: 'sha256:patch', bytes: 1200 },
        bundle: null,
        artifactIds: ['ar_patch'],
        evidenceRefs: [{ kind: 'test', ref: 'ev_test' }],
        redaction: { status: 'redacted', notes: [] },
        createdAt: '2026-06-27T01:00:00.000Z',
      })
    );

    expect(
      stageWorkspaceChangeSet(changeSet, {
        createdAt: '2026-06-27T01:05:00.000Z',
        patchPayload: {
          bytes: Buffer.byteLength(patchText, 'utf8'),
          digest: 'sha256:patch',
          mediaType: 'text/x-diff',
          text: patchText,
        },
        reviewId: 'swr_1',
        stagingRef: 'staging://workspace/swr_1',
      })
    ).toMatchObject({
      actionCenterRowId: 'workspace-review:swr_1',
      changeSetId: 'wcs_1',
      diffSummary: { additions: 3, deletions: 1, filesChanged: 1 },
      status: 'pending',
    });
  });

  it('projects binary paths as artifact-only review diagnostics', () => {
    const changeSet = parseWorkspaceChangeSetManifest(
      JSON.stringify({
        id: 'wcs_binary',
        materializationRecordId: 'wmr_1',
        inputSnapshotId: 'wis_1',
        workspaceId: 'ws_demo',
        resourceId: 'repo',
        strategy: 'git',
        base: { commit: 'abc123', contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [
          {
            binary: true,
            digest: 'sha256:image',
            mediaType: 'image/png',
            path: 'assets/screenshot.png',
            size: 2048,
            status: 'modified',
          },
          {
            binary: true,
            digest: 'sha256:video',
            mediaType: 'video/mp4',
            path: 'assets/demo.mp4',
            size: 1_048_577,
            status: 'added',
          },
        ],
        patch: { ref: 'artifact://patch', digest: 'sha256:patch', bytes: 1200 },
        bundle: null,
        artifactIds: ['ar_binary'],
        evidenceRefs: [],
        redaction: { status: 'redacted', notes: [] },
        createdAt: '2026-06-27T01:00:00.000Z',
      })
    );
    const review = stageWorkspaceChangeSet(changeSet, {
      createdAt: '2026-06-27T01:05:00.000Z',
      patchPayload: null,
      reviewId: 'swr_binary',
      stagingRef: 'staging://workspace/swr_binary',
    });

    expect(changeSet.changedPaths[0]?.binaryReview).toEqual({
      bytes: 2048,
      digest: 'sha256:image',
      mediaType: 'image/png',
      mode: 'artifact-only',
      reason: 'binary-path',
      summary: 'Binary change assets/screenshot.png is available as an artifact-only review item.',
    });
    expect(changeSet.changedPaths[1]?.binaryReview).toMatchObject({
      bytes: 1_048_577,
      reason: 'binary-payload-too-large',
    });
    expect(review).toMatchObject({
      riskSummary: '2 changed paths staged for review, including 2 artifact-only binary paths.',
      validation: [
        {
          command: 'workspace.binary_artifact_only',
          ref: 'workspace-path:assets/screenshot.png',
          status: 'skipped',
        },
        {
          command: 'workspace.binary_artifact_only',
          ref: 'workspace-path:assets/demo.mp4',
          status: 'skipped',
        },
      ],
    });
  });
});
