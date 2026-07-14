import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadRuntimeConfig } from '../config/runtime-config.js';
import { createDemoStore } from '../test-support/demo-store.js';
import type { WorkspaceRepositoryResourceRecord } from '../workspace/repository-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { materializeWorkspaceRootsForTurn } from './turn-workspace-context.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';

describe('turn workspace context', () => {
  it('pins one linked repository commit through AEP and durable workspace lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-turn-workspace-data-'));
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-turn-workspace-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repositoryPath });
    execFileSync('git', ['config', 'user.email', 'runtime@example.invalid'], {
      cwd: repositoryPath,
    });
    execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd: repositoryPath });
    writeFileSync(join(repositoryPath, 'README.md'), '# Runtime repository\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath });
    execFileSync('git', ['commit', '-qm', 'chore: establish runtime baseline'], {
      cwd: repositoryPath,
    });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryPath,
      encoding: 'utf8',
    }).trim();
    const store = createDemoStore({ dataRoot });
    const repository = {
      createdAt: '2026-07-13T00:00:00.000Z',
      diagnosticsStatus: 'ready',
      displayName: 'Runtime repository',
      git: {
        allowedPushTargets: [],
        authorEmail: null,
        authorName: null,
        commitOnApply: false,
        protectedBranchPatterns: ['main', 'master'],
        requireReviewLinkage: true,
        stagingStrategy: 'staging-root',
        vaultGrantRef: null,
      },
      localPath: repositoryPath,
      resourceId: 'repo_default',
      type: 'git_repository',
      updatedAt: '2026-07-13T00:00:00.000Z',
      workspaceId: 'ws_demo',
    } satisfies WorkspaceRepositoryResourceRecord;
    const workspaceRoots = materializeWorkspaceRootsForTurn(
      loadRuntimeConfig(dataRoot, { version: 1 }),
      store,
      'ws_demo',
      repository
    );
    const turn = store.createTurn('ws_demo', 'th_demo', 'Update repository');
    const environmentPackage = resolveAgentEnvironmentPackage({
      agent: store.getAgent('ws_demo', 'agent_codex_host'),
      agentSessionId: 'as_repository_commit',
      backend: {
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
      },
      createdAt: '2026-07-13T00:01:00.000Z',
      turn,
      userId: store.getUserId(),
      workspaceRoots,
    });
    const inputSnapshots = buildWorkspaceInputSnapshots({
      backendCapabilities: ['git-materialization'],
      backendKind: 'openshell',
      createdAt: '2026-07-13T00:02:00.000Z',
      environmentPackage,
    });
    const materializationRecords = buildWorkspaceMaterializationRecords({
      createdAt: '2026-07-13T00:03:00.000Z',
      inputSnapshots,
      materialization: {
        backendKind: 'openshell',
        packageSnapshotId: environmentPackage.snapshotId,
        requiredCapabilities: ['git-materialization'],
        workspaceInputs: [{ id: 'repo_default', target: '/workspace/openkit' }],
      },
    });

    expect(workspaceRoots).toEqual([
      expect.objectContaining({ id: 'repo_default', sourceCommit: commit }),
    ]);
    expect(environmentPackage.workspace.inputs[0]?.source.commit).toBe(commit);
    expect(inputSnapshots[0]?.base).toEqual({ commit, contentDigest: null });
    expect(materializationRecords[0]?.base).toEqual({ commit, contentDigest: null });
  });
});
