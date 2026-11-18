import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OpenKitConfigSchema,
  WorkspaceConfigSchema,
  type WorkspaceDataSourceCatalog,
} from '@openkit/config-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { CoreDb } from '../storage/db.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { closeTestCoreDb, createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { materializeWorkspaceRootsForTurn } from './turn-workspace-context.js';

const WORKSPACE_ID = 'ws_00000000-0000-7000-8000-000000000001';
const THREAD_ID = 'th_00000000-0000-7000-8000-000000000001';
const USER_ID = 'usr_00000000-0000-7000-8000-000000000001';
const COMMIT = 'a'.repeat(40);
const BLOCKED = { code: 'workspace_data_source_blocked', status: 409 };
const constraints = [
  { subpath: 'src' },
  { ref: 'refs/heads/review' },
  { commit: 'b'.repeat(40) },
  { objects: ['src/index.ts'] },
  { filter: '*.ts' },
  { narrowing: { subpath: 'src' } },
  { selection: { files: ['src/index.ts'] } },
  { target: '/workspace/selected' },
];
let dataRoot: string;
let fixtureCoreDb: CoreDb | undefined;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'workspace-source-admission-'));
});
afterEach(async () => {
  if (fixtureCoreDb) closeTestCoreDb(fixtureCoreDb);
  fixtureCoreDb = undefined;
  await disposeTestStore(dataRoot);
});

/** Builds a current configuration and a separately captured Git source snapshot. */
async function fixture() {
  const store = await createDemoStore({ dataRoot });
  const coreDb = createTestCoreDb(dataRoot);
  fixtureCoreDb = coreDb;
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: WORKSPACE_ID, ownerUserId: USER_ID });
  const setup = createTestAgentSetup();
  admitTestNativeEnvironment(coreDb, setup.manifest);
  setup.manifest.workspace = {
    inputs: [{ id: 'repo', sourceRef: 'main-repo', access: 'read-write' }],
  };
  const catalog: WorkspaceDataSourceCatalog = {
    schemaVersion: 1,
    requiredFeatures: [],
    extensions: {},
    sources: [
      {
        id: 'main-repo',
        displayName: 'Main repository',
        kind: 'git',
        locator: { url: 'https://git.example.test/repository.git', commit: COMMIT },
        access: 'read-write',
        allowedSlotKinds: ['worktree'],
        sensitivity: 'internal',
        status: 'active',
        requiredFeatures: [],
        extensions: {},
        syncHints: {},
      },
    ],
  };
  const currentCatalog = structuredClone(catalog);
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot: null,
    agentManifests: [setup.manifest],
    workspaceConfigs: [
      {
        workspaceId: WORKSPACE_ID,
        path: 'workspace.jsonc',
        config: WorkspaceConfigSchema.parse({ schemaVersion: 1, workspace: { name: 'Sources' } }),
      },
    ],
    workspaceDataSourceCatalogs: [
      { workspaceId: WORKSPACE_ID, path: 'data-sources.jsonc', catalog: currentCatalog },
    ],
  });
  const turn = await store.createTurn(WORKSPACE_ID, THREAD_ID, 'Use the selected source', {
    kind: 'user',
    id: USER_ID,
  });
  const roots = [
    {
      id: 'repo',
      access: 'read-write' as const,
      sourceKind: 'remote-git' as const,
      sourceCommit: COMMIT,
      workerPath: '/workspace/openkit',
    },
  ];
  const sourceRefs = { repo: 'main-repo' };
  const resolve = (readRuntimeConfig: (() => typeof snapshot) | null = () => snapshot) =>
    resolveAgentEnvironmentPackage({
      coreDb,
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: setup,
      backend: { kind: 'openshell' },
      agentSessionId: 'as_00000000-0000-7dc7-b48e-63a78132fa1d',
      turn,
      triggerActor: turn.triggerActor,
      workspaceRoots: roots,
      workspaceDataSourceCatalog: catalog,
      workspaceSourceRefs: sourceRefs,
      ...(readRuntimeConfig ? { readRuntimeConfig } : {}),
    });
  const materialize = () =>
    materializeWorkspaceRootsForTurn(snapshot, store, WORKSPACE_ID, setup.manifest);
  return {
    setup,
    snapshot,
    catalog,
    currentCatalog,
    materialize,
    resolve,
    turn,
    store,
    coreDb,
    sourceRefs,
  };
}

/** Adds an admitted Policy condition whose source intersection the Git path cannot prove. */
function restrictPolicy(f: Awaited<ReturnType<typeof fixture>>, scope: 'server' | 'workspace') {
  const owner = { kind: 'workspace' as const, workspaceId: WORKSPACE_ID };
  const envelope = {
    author: { kind: 'human', id: USER_ID },
    authority: { kind: 'human', userId: USER_ID },
    authoredAt: '2026-11-17T00:00:00.000Z',
    state: 'active',
    lifetime: { anchor: { owner, kind: 'workspace', id: WORKSPACE_ID } },
  };
  const resource = { kind: 'container', container: { owner, kind: 'thread', id: THREAD_ID } };
  const policy = {
    schemaVersion: 1,
    statements: [
      {
        ...envelope,
        id: 'source-boundary',
        kind: 'managed-boundary',
        scope: { subjects: [], actions: [], resources: [resource] },
      },
      {
        ...envelope,
        id: 'source-network-condition',
        kind: 'permission',
        effect: 'prohibit',
        grant: { kind: 'ordinary' },
        scope: {
          subjects: [{ kind: 'human', id: USER_ID }],
          actions: ['network.egress'],
          resources: [resource],
        },
      },
    ],
  };
  if (scope === 'server') {
    f.snapshot.openKitConfig = OpenKitConfigSchema.parse({
      schemaVersion: 1,
      policy: { mediation: policy },
    });
  } else {
    f.snapshot.workspaceConfigs[0]!.config = WorkspaceConfigSchema.parse({
      ...f.snapshot.workspaceConfigs[0]!.config,
      requiredFeatures: ['openkit.workspace-resource-policy.v1'],
      workspace: { name: 'Sources', policy: { mediation: policy } },
    });
  }
}

describe('bounded workspace source admission', () => {
  it.each(constraints)(
    'refuses unsupported requested constraints before admission: %j',
    async (constraint) => {
      const f = await fixture();
      Object.assign(f.setup.manifest.workspace!.inputs![0]!, constraint);
      expect(f.materialize).toThrowError(expect.objectContaining(BLOCKED));
    }
  );

  it.each(constraints)(
    'rechecks requested constraints during AEP preparation: %j',
    async (constraint) => {
      const f = await fixture();
      Object.assign(f.setup.manifest.workspace!.inputs![0]!, constraint);
      await expect(f.resolve()).rejects.toMatchObject(BLOCKED);
    }
  );

  it.each(['server', 'workspace'] as const)(
    'refuses unproved current %s Policy during preparation',
    async (scope) => {
      const f = await fixture();
      restrictPolicy(f, scope);
      await expect(f.resolve()).rejects.toMatchObject(BLOCKED);
    }
  );

  it('refuses preparation without a current authority reader', async () => {
    const f = await fixture();
    await expect(f.resolve(null)).rejects.toMatchObject(BLOCKED);
  });

  it.each(['disabled', 'removed', 'read-only', 'grant', 'url', 'commit', 'slot'] as const)(
    'refuses a source whose current authority changed: %s',
    async (change) => {
      const f = await fixture();
      const source = f.currentCatalog.sources[0]!;
      if (change === 'disabled') source.status = 'disabled';
      if (change === 'removed') f.currentCatalog.sources = [];
      if (change === 'read-only') source.access = 'read-only';
      if (change === 'grant') source.vaultGrantRef = 'grant_00000000-0000-7899-9b3f-8965fec90404';
      if (change === 'url') source.locator.url = 'https://git.example.test/another.git';
      if (change === 'commit') source.locator.commit = 'b'.repeat(40);
      if (change === 'slot') source.allowedSlotKinds = ['input'];
      await expect(f.resolve()).rejects.toMatchObject(BLOCKED);
    }
  );

  it('refuses a source revoked while asynchronous preparation settles', async () => {
    const f = await fixture();
    const pending = f.resolve();
    f.currentCatalog.sources[0]!.status = 'disabled';
    await expect(pending).rejects.toMatchObject(BLOCKED);
  });

  it('refuses a reader failure without producing a source package', async () => {
    const f = await fixture();
    await expect(
      f.resolve(() => {
        throw new Error('Reader unavailable');
      })
    ).rejects.toMatchObject(BLOCKED);
  });

  it('refuses preparation without a current source catalog', async () => {
    const f = await fixture();
    f.snapshot.workspaceDataSourceCatalogs = [];
    await expect(f.resolve()).rejects.toMatchObject(BLOCKED);
  });

  it('keeps another source usable after one source request is refused', async () => {
    const f = await fixture();
    const other = { ...structuredClone(f.catalog.sources[0]!), id: 'other-repo' };
    f.catalog.sources.push(other);
    f.currentCatalog.sources.push(structuredClone(other));
    f.currentCatalog.sources[0]!.status = 'disabled';
    await expect(f.resolve()).rejects.toMatchObject({
      ...BLOCKED,
      message: expect.stringMatching(/retry|remove/i),
    });
    f.sourceRefs.repo = 'other-repo';
    f.setup.manifest.workspace!.inputs![0]!.sourceRef = 'other-repo';
    expect((await f.resolve()).workspace.inputs[0]!.source.sourceId).toBe('other-repo');
  });

  it.each(['server', 'workspace'] as const)(
    'keeps a sibling Thread source usable under unrelated %s Policy',
    async (scope) => {
      const f = await fixture();
      restrictPolicy(f, scope);
      await expect(f.resolve()).rejects.toMatchObject(BLOCKED);
      const sibling = await f.store.createThread(WORKSPACE_ID, 'Independent source request');
      const turn = await f.store.createTurn(WORKSPACE_ID, sibling.id, 'Use the admitted source', {
        kind: 'user',
        id: USER_ID,
      });
      Object.assign(f.turn, turn);
      expect((await f.resolve()).workspace.inputs[0]!.source.sourceId).toBe('main-repo');
    }
  );

  it('refuses a child source when its parent Thread has conditional Policy', async () => {
    const f = await fixture();
    restrictPolicy(f, 'workspace');
    const child = await f.store.createThread(
      WORKSPACE_ID,
      'Child source request',
      undefined,
      'conversation',
      { visibility: 'workspace', parentThreadId: THREAD_ID }
    );
    const turn = await f.store.createTurn(WORKSPACE_ID, child.id, 'Use a source', {
      kind: 'user',
      id: USER_ID,
    });
    Object.assign(f.turn, turn);
    await expect(f.resolve()).rejects.toMatchObject(BLOCKED);
  });

  it('preserves the proved credential-free Git source and its existing snapshot', async () => {
    const f = await fixture();
    expect(f.materialize()).toMatchObject([{ id: 'repo', sourceCommit: COMMIT }]);
    expect((await f.resolve()).workspace.inputs[0]!.source).toMatchObject({
      sourceId: 'main-repo',
      sourceRef: 'main-repo',
      commit: COMMIT,
      catalogEntryDigest: expect.stringMatching(/^sha256:/),
    });
  });
});
