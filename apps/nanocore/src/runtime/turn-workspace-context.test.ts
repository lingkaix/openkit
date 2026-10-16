import {
  resolveWorkspaceDataSourceReference,
  type WorkspaceDataSourceCatalog,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';

import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { materializeWorkspaceRootsForTurn } from './turn-workspace-context.js';
import { workerStorageDefaultWorkSlotRef } from './worker-storage-bindings.js';

const REMOTE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const REMOTE_URL = 'https://git.example.test/openkit/repository.git';

describe('turn workspace context', () => {
  it.each([
    'read-write',
    'read-only',
  ] as const)('retains the exact source-kind refusal for an authored %s folder input', (access) => {
    const setup = createTestAgentSetup();
    const manifest = {
      ...setup.manifest,
      workspace: { inputs: [{ id: 'documents', access, sourceRef: 'main-repo' }] },
    };
    const catalog = remoteGitCatalog({ path: 'files/contracts' });
    catalog.sources[0]!.kind = 'workspace-dir';
    catalog.sources[0]!.allowedSlotKinds = ['input'];
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      workspaceDataSourceCatalogs: [
        {
          catalog,
          path: 'workspaces/ws_00000000-0000-7000-8000-000000000001/config/data-sources.jsonc',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
      ],
    });
    expect(() =>
      materializeWorkspaceRootsForTurn(
        snapshot,
        createDemoStore(),
        'ws_00000000-0000-7000-8000-000000000001',
        manifest
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace_data_source_blocked',
        status: 409,
        message:
          'Only credential-free remote Git sources can be materialized into a work slot in this release. Folder and other source kinds are not supported yet. Work without a source input still runs.',
      })
    );
  });
  it('retains the exact source-kind refusal for an authored inline folder input', () => {
    const manifest = {
      ...createTestAgentSetup().manifest,
      workspace: {
        inputs: [
          {
            id: 'documents',
            access: 'read-write',
            source: { kind: 'workspace-dir', pathRef: 'files/contracts' },
          },
        ],
      },
    };
    expect(() =>
      materializeWorkspaceRootsForTurn(
        createInMemoryRuntimeConfigSnapshot({ dataRoot: null }),
        createDemoStore(),
        'ws_00000000-0000-7000-8000-000000000001',
        manifest
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'workspace_data_source_blocked',
        status: 409,
        message:
          'Only credential-free remote Git sources can be materialized into a work slot in this release. Folder and other source kinds are not supported yet. Work without a source input still runs.',
      })
    );
  });
  it('admits an empty source input list into a plain work slot', () => {
    const store = createDemoStore();
    const agentSetup = createTestAgentSetup();
    agentSetup.manifest.workspace = { inputs: [] };
    const snapshot = createInMemoryRuntimeConfigSnapshot({ dataRoot: null });
    const workspaceRoots = materializeWorkspaceRootsForTurn(
      snapshot,
      store,
      'ws_00000000-0000-7000-8000-000000000001',
      agentSetup.manifest
    );
    expect(workspaceRoots).toEqual([]);
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Organize the supplied context',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const pkg = resolveAgentEnvironmentPackage({
      agentSetup,
      agentSessionId: 'as_00000000-0000-7c67-b2b1-57b016d05568',
      triggerActor: turn.triggerActor,
      backend: { kind: 'openshell' },
      createdAt: '2026-10-10T00:00:00.000Z',
      turn,
      userId: LOCAL_USER_ID,
      workspaceRoots,
    });
    expect(pkg.workspace.inputs).toEqual([]);
    expect(pkg.runtime.command.workingDirectory).toBe(
      `/workspace/worktrees/${workerStorageDefaultWorkSlotRef(turn.workspaceId, turn.threadId)}`
    );
  });
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
        {
          catalog,
          path: 'workspaces/ws_00000000-0000-7000-8000-000000000001/config/data-sources.jsonc',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
      ],
    });

    const workspaceRoots = materializeWorkspaceRootsForTurn(
      snapshot,
      store,
      'ws_00000000-0000-7000-8000-000000000001',
      manifest
    );
    const sourceContext = {
      workspaceDataSourceCatalog: catalog,
      workspaceSourceRefs: { repo_remote: 'main-repo' },
    };
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Use the remote repository',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const environmentPackage = resolveAgentEnvironmentPackage({
      agentSetup: { ...agentSetup, manifest },
      agentSessionId: 'as_00000000-0000-7dc7-b48e-63a78132fa1d',
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
    const expectedWorktree = `/workspace/worktrees/${workerStorageDefaultWorkSlotRef(
      turn.workspaceId,
      turn.threadId
    )}`;

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
    expect(environmentPackage.runtime.command.workingDirectory).toBe(expectedWorktree);
    expect(environmentPackage.workspace.root).toBe('/workspace');
    expect(remoteInput).toEqual({
      access: 'read-write',
      id: 'repo_remote',
      kind: 'directory',
      materialization: {
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
      target: expectedWorktree,
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
      vaultGrantRef: 'grant_00000000-0000-7899-9b3f-8965fec90404',
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
          path: 'workspaces/ws_00000000-0000-7000-8000-000000000001/config/data-sources.jsonc',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
      ],
    });

    expect(() =>
      materializeWorkspaceRootsForTurn(
        snapshot,
        createDemoStore(),
        'ws_00000000-0000-7000-8000-000000000001',
        manifest
      )
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
