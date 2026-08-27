import {
  resolveWorkspaceDataSourceReference,
  type WorkspaceDataSourceCatalog,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';

import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  materializeWorkspaceRootsForTurn,
  workspaceSourceContextForTurn,
} from './turn-workspace-context.js';

const REMOTE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const REMOTE_URL = 'https://git.example.test/openkit/repository.git';

describe('turn workspace context', () => {
  it('resolves one authored remote Git source without projecting a NanoCore host path', () => {
    const store = createDemoStore();
    const agentSetup = createTestAgentSetup({ imageRef: 'openkit/worker-codex:dev' });
    const manifest = {
      ...agentSetup.manifest,
      workspace: {
        inputs: [{ access: 'read-write', id: 'repo_remote', sourceRef: 'main-repo' }],
      },
    };
    const catalog = remoteGitCatalog({ commit: REMOTE_COMMIT, url: REMOTE_URL });
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: null,
      workspaceDataSourceCatalogs: [
        { catalog, path: 'workspaces/ws_demo/config/data-sources.jsonc', workspaceId: 'ws_demo' },
      ],
    });

    const workspaceRoots = materializeWorkspaceRootsForTurn(snapshot, store, 'ws_demo', manifest);
    const sourceContext = workspaceSourceContextForTurn(
      snapshot,
      'ws_demo',
      workspaceRoots,
      manifest
    );
    const turn = store.createTurn('ws_demo', 'th_demo', 'Use the remote repository', {
      kind: 'user',
      id: 'user_local',
    });
    const environmentPackage = resolveAgentEnvironmentPackage({
      agentSetup: { ...agentSetup, manifest },
      agentSessionId: 'as_remote_git',
      triggerActor: turn.triggerActor,
      backend: { kind: 'openshell' },
      createdAt: '2026-08-22T00:01:00.000Z',
      turn,
      userId: LOCAL_USER_ID,
      workspaceRoots,
      workspaceCwd: '/workspace/openkit',
      ...sourceContext,
    });
    const expectedDigest = resolveWorkspaceDataSourceReference({
      access: 'read-write',
      catalog,
      slotKind: 'worktree',
      sourceRef: 'main-repo',
    }).catalogEntryDigest;
    const remoteInput = environmentPackage.workspace.inputs.find(
      (input) => input.id === 'repo_remote'
    );

    expect(workspaceRoots).toEqual([
      {
        access: 'read-write',
        id: 'repo_remote',
        sourceCommit: REMOTE_COMMIT,
        sourceKind: 'remote-git',
        workerPath: '/workspace/openkit',
      },
    ]);
    expect(workspaceRoots[0]).not.toHaveProperty('sourcePath');
    expect(sourceContext.workspaceSourceRefs).toEqual({ repo_remote: 'main-repo' });
    expect(environmentPackage.runtime.command.workingDirectory).toBe('/workspace/openkit');
    expect(environmentPackage.workspace.root).toBe('/workspace/openkit');
    expect(remoteInput).toEqual({
      access: 'read-write',
      id: 'repo_remote',
      kind: 'directory',
      materialization: {
        changeSetManifestPath: '/openkit/session/workspace-changes.json',
        strategy: 'git',
      },
      source: {
        catalogEntryDigest: expectedDigest,
        commit: REMOTE_COMMIT,
        kind: 'git',
        sensitivity: 'internal',
        sourceId: 'main-repo',
        sourceRef: 'main-repo',
        url: REMOTE_URL,
      },
      target: '/workspace/openkit/worktrees/main',
    });
    expect(remoteInput?.source).not.toHaveProperty('locator');
    expect(remoteInput?.source).not.toHaveProperty('pathRef');
    expect(JSON.stringify({ environmentPackage, workspaceRoots })).not.toContain('sourcePath');
  });

  it.each([
    { kind: 'local-only', locator: { localPath: '/srv/private/repository' } },
    { kind: 'missing-commit', locator: { url: REMOTE_URL } },
    { kind: 'invalid-commit', locator: { commit: 'main', url: REMOTE_URL } },
    {
      kind: 'query-bearing-url',
      locator: { commit: REMOTE_COMMIT, url: `${REMOTE_URL}?ref=private-review` },
    },
    {
      kind: 'fragment-bearing-url',
      locator: { commit: REMOTE_COMMIT, url: `${REMOTE_URL}#private-review` },
    },
    {
      kind: 'credential-bearing',
      locator: { commit: REMOTE_COMMIT, url: REMOTE_URL },
      vaultGrantRef: 'grant_git_read',
    },
  ])('rejects a $kind Git catalog source before exposing a runtime root', ({
    locator,
    vaultGrantRef,
  }) => {
    const agentSetup = createTestAgentSetup();
    const manifest = {
      ...agentSetup.manifest,
      workspace: {
        inputs: [{ access: 'read-write' as const, id: 'repo_remote', sourceRef: 'main-repo' }],
      },
    };
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: null,
      workspaceDataSourceCatalogs: [
        {
          catalog: remoteGitCatalog(locator, vaultGrantRef),
          path: 'workspaces/ws_demo/config/data-sources.jsonc',
          workspaceId: 'ws_demo',
        },
      ],
    });

    expect(() =>
      materializeWorkspaceRootsForTurn(snapshot, createDemoStore(), 'ws_demo', manifest)
    ).toThrow();
  });
});

/** Creates one complete remote Git catalog fixture without a local repository projection. */
function remoteGitCatalog(
  locator: Readonly<Record<string, unknown>>,
  vaultGrantRef?: string
): WorkspaceDataSourceCatalog {
  return {
    extensions: {},
    requiredFeatures: [],
    schemaVersion: 1,
    sources: [
      {
        access: 'read-write',
        allowedSlotKinds: ['worktree'],
        displayName: 'Remote repository',
        extensions: {},
        id: 'main-repo',
        kind: 'git',
        locator,
        requiredFeatures: [],
        sensitivity: 'internal',
        status: 'active',
        syncHints: {},
        ...(vaultGrantRef ? { vaultGrantRef } : {}),
      },
    ],
  };
}
