import { describe, expect, it } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
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
    const turn = store.createTurn('ws_demo', 'th_demo', 'Update docs');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = resolveAgentEnvironmentPackage({
      agent,
      agentSessionId: 'session_1',
      userId: 'user_local',
      backend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
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
          sourcePath: '/Users/m5pro/Documents/AI/openkit',
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

  it('carries catalog source ids into workspace lineage records', () => {
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Update docs from catalog source');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const environmentPackage = resolveAgentEnvironmentPackage({
      agent,
      agentSessionId: 'session_source_1',
      userId: 'user_local',
      backend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
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
          sourcePath: '/Users/m5pro/Documents/AI/openkit',
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
