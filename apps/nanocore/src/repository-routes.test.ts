import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDemoWorkspaceForUser, FsStore } from './lib/store.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { type CreateAppOptions, createApp as createNanoCoreApp } from './test-support/app.js';
import { upsertWorkspaceRepositoryResource } from './workspace/repository-store.js';

/**
 * Opens a migrated Core database for repository route tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-repository-routes-db-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Creates a repository route test app with the Demo Workspace fixture.
 *
 * @param options App options.
 * @returns Test app.
 */
function createApp(options: CreateAppOptions = {}): ReturnType<typeof createNanoCoreApp> {
  const demo = createDemoWorkspaceForUser(LOCAL_USER_ID);
  const store = options.store ?? new FsStore();

  try {
    store.getWorkspace(demo.workspace.id);
  } catch {
    store.importWorkspaceSnapshot({
      workspace: demo.workspace,
      threads: [demo.thread],
      knowledge: demo.knowledge,
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
    });
  }

  return createNanoCoreApp({ ...options, store });
}

describe('workspace repository app API', () => {
  it('rejects repository linking for the Quick Chat workspace', async () => {
    const coreDb = createCoreDb();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-quick-chat-repository-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      const app = createApp({ coreDb });
      const setRes = await app.request('/api/app/workspaces/ws_quick_chat/repositories/default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Quick Chat repository',
          localPath: repositoryPath,
        }),
      });

      expect(setRes.status).toBe(400);
      await expect(setRes.json()).resolves.toMatchObject({
        code: 'workspace_kind_not_supported',
        message: expect.stringContaining('Quick Chat workspace'),
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('backfills existing repository rows into the data source catalog at startup', async () => {
    const coreDb = createCoreDb();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-backfill-repository-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_local', 'ws_demo');
      try {
        applyScopedMigrations(workspaceDb);
        upsertWorkspaceRepositoryResource(workspaceDb, {
          workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
          workspaceId: 'ws_demo',
          displayName: repositoryPath,
          localPath: repositoryPath,
          now: () => '2026-07-05T00:00:00.000Z',
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      createApp({ coreDb });

      const catalogPath = join(
        coreDb.dataRoot,
        'users',
        'user_local',
        'workspaces',
        'ws_demo',
        'config',
        'data-sources.jsonc'
      );
      const catalogText = readFileSync(catalogPath, 'utf8');
      const catalog = JSON.parse(catalogText) as {
        sources: Array<Record<string, unknown>>;
      };

      expect(catalog.sources).toEqual([
        expect.objectContaining({
          displayName: expect.stringMatching(/^local directory "openkit-backfill-repository-/),
          id: 'repo_default',
          kind: 'git',
          locator: { repositoryResourceId: 'repo_default' },
          status: 'active',
        }),
      ]);
      expect(catalogText).not.toContain(repositoryPath);
      expect(catalogText).not.toContain('localPath');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('uses PUT as the only default repository write method', async () => {
    const coreDb = createCoreDb();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-ready-route-repository-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      const app = createApp({ coreDb });
      const postRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'OpenKit',
          localPath: repositoryPath,
        }),
      });

      expect(postRes.status).toBe(404);

      const setRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'OpenKit',
          localPath: repositoryPath,
        }),
      });

      expect(setRes.status).toBe(200);
      const setPayload = (await setRes.json()) as Record<string, unknown>;
      const setJson = JSON.stringify(setPayload);
      expect(setPayload).toMatchObject({
        repository: {
          workspaceId: 'ws_demo',
          resourceId: 'repo_default',
          type: 'git_repository',
          displayName: 'OpenKit',
          diagnosticsStatus: 'ready',
          validation: {
            ok: true,
            status: 'ready',
          },
        },
      });
      expect(setJson).not.toContain(repositoryPath);
      expect(setJson).not.toContain('localPath');

      const listRes = await app.request('/api/app/workspaces/ws_demo/repositories');
      expect(listRes.status).toBe(200);
      const listPayload = (await listRes.json()) as Record<string, unknown>;
      const listJson = JSON.stringify(listPayload);
      expect(listPayload).toMatchObject({
        defaultResourceId: 'repo_default',
        defaultResource: {
          resourceId: 'repo_default',
          diagnosticsStatus: 'ready',
        },
        items: [
          {
            resourceId: 'repo_default',
            diagnosticsStatus: 'ready',
          },
        ],
      });
      expect(listJson).not.toContain(repositoryPath);
      expect(listJson).not.toContain('localPath');

      const serverRepositoryTable = coreDb.sqlite
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('workspace_repository_resources') as { count: number };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_local', 'ws_demo');
      try {
        const workspaceRepositoryCount = workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM workspace_repository_resources')
          .get() as { count: number };
        const catalogPath = join(
          coreDb.dataRoot,
          'users',
          'user_local',
          'workspaces',
          'ws_demo',
          'config',
          'data-sources.jsonc'
        );
        const catalogText = readFileSync(catalogPath, 'utf8');
        const catalog = JSON.parse(catalogText) as {
          sources: Array<Record<string, unknown>>;
        };

        expect(serverRepositoryTable.count).toBe(0);
        expect(workspaceRepositoryCount.count).toBe(1);
        expect(catalog.sources).toEqual([
          expect.objectContaining({
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
            displayName: 'OpenKit',
            id: 'repo_default',
            kind: 'git',
            locator: { repositoryResourceId: 'repo_default' },
            sensitivity: 'internal',
            status: 'active',
          }),
        ]);
        expect(catalogText).not.toContain(repositoryPath);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('sanitizes repository display names that match raw local paths', async () => {
    const coreDb = createCoreDb();
    const tempRoot = mkdtempSync(join(tmpdir(), 'openkit-display-name-leak-root-'));
    const repositoryPath = join(tempRoot, 'repo');
    mkdirSync(join(repositoryPath, '.git'), { recursive: true });

    try {
      const app = createApp({ coreDb });
      const setRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: repositoryPath,
          localPath: repositoryPath,
        }),
      });

      expect(setRes.status).toBe(200);
      const setPayload = (await setRes.json()) as Record<string, unknown>;
      const setJson = JSON.stringify(setPayload);
      expect(setPayload).toMatchObject({
        repository: {
          displayName: 'local directory "repo"',
          diagnosticsStatus: 'ready',
          pathSummary: 'local directory "repo"',
          validation: {
            ok: true,
            status: 'ready',
          },
        },
      });
      expect(setJson).not.toContain(tempRoot);
      expect(setJson).not.toContain(repositoryPath);
      expect(setJson).not.toContain('localPath');

      const listRes = await app.request('/api/app/workspaces/ws_demo/repositories');
      expect(listRes.status).toBe(200);
      const listPayload = (await listRes.json()) as Record<string, unknown>;
      const listJson = JSON.stringify(listPayload);
      expect(listPayload).toMatchObject({
        defaultResource: {
          displayName: 'local directory "repo"',
          diagnosticsStatus: 'ready',
        },
        items: [
          {
            displayName: 'local directory "repo"',
            diagnosticsStatus: 'ready',
          },
        ],
      });
      expect(listJson).not.toContain(tempRoot);
      expect(listJson).not.toContain(repositoryPath);
      expect(listJson).not.toContain('localPath');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('sanitizes repository display names that embed unrelated absolute host paths', async () => {
    const coreDb = createCoreDb();
    const tempRoot = mkdtempSync(join(tmpdir(), 'openkit-embedded-display-name-root-'));
    const repositoryPath = join(tempRoot, 'repo');
    const embeddedPath = '/Users/example/other';
    mkdirSync(join(repositoryPath, '.git'), { recursive: true });

    try {
      const app = createApp({ coreDb });
      const setRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: `Repo at ${embeddedPath}`,
          localPath: repositoryPath,
        }),
      });

      expect(setRes.status).toBe(200);
      const setPayload = (await setRes.json()) as Record<string, unknown>;
      const setJson = JSON.stringify(setPayload);
      expect(setPayload).toMatchObject({
        repository: {
          displayName: 'local directory "repo"',
          diagnosticsStatus: 'ready',
          pathSummary: 'local directory "repo"',
          validation: {
            ok: true,
            status: 'ready',
          },
        },
      });
      expect(setJson).not.toContain(embeddedPath);
      expect(setJson).not.toContain(repositoryPath);
      expect(setJson).not.toContain('localPath');

      const listRes = await app.request('/api/app/workspaces/ws_demo/repositories');
      expect(listRes.status).toBe(200);
      const listPayload = (await listRes.json()) as Record<string, unknown>;
      const listJson = JSON.stringify(listPayload);
      expect(listPayload).toMatchObject({
        defaultResource: {
          displayName: 'local directory "repo"',
          diagnosticsStatus: 'ready',
        },
        items: [
          {
            displayName: 'local directory "repo"',
            diagnosticsStatus: 'ready',
          },
        ],
      });
      expect(listJson).not.toContain(embeddedPath);
      expect(listJson).not.toContain(repositoryPath);
      expect(listJson).not.toContain('localPath');

      const diagnosticsRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/diagnostics'
      );
      expect(diagnosticsRes.status).toBe(200);
      const diagnosticsPayload = (await diagnosticsRes.json()) as Record<string, unknown>;
      const diagnosticsJson = JSON.stringify(diagnosticsPayload);
      expect(diagnosticsPayload).toMatchObject({
        defaultResource: {
          displayName: 'local directory "repo"',
          diagnosticsStatus: 'ready',
        },
        resources: [
          {
            displayName: 'local directory "repo"',
            diagnosticsStatus: 'ready',
          },
        ],
      });
      expect(diagnosticsJson).not.toContain(embeddedPath);
      expect(diagnosticsJson).not.toContain(repositoryPath);
      expect(diagnosticsJson).not.toContain('localPath');
      expect(diagnosticsJson).not.toContain('developer');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('stores invalid repository paths as non-ready diagnostics without exposing raw paths', async () => {
    const coreDb = createCoreDb();
    const plainDirectory = mkdtempSync(join(tmpdir(), 'openkit-invalid-route-repository-'));

    try {
      const app = createApp({ coreDb });
      const setRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Not a Git Repository',
          localPath: plainDirectory,
        }),
      });

      expect(setRes.status).toBe(200);
      const payload = (await setRes.json()) as Record<string, unknown>;
      const json = JSON.stringify(payload);
      expect(payload).toMatchObject({
        repository: {
          diagnosticsStatus: 'not_git',
          pathSummary: expect.stringContaining('local directory'),
          validation: {
            ok: false,
            status: 'not_git',
          },
        },
      });
      expect(json).not.toContain(plainDirectory);
      expect(json).not.toContain('localPath');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns redacted repository diagnostics snapshots for linked resources', async () => {
    const coreDb = createCoreDb();
    const tempRoot = mkdtempSync(join(tmpdir(), 'openkit-repository-diagnostics-root-'));
    const readyPath = join(tempRoot, 'ready');
    const missingPath = join(tempRoot, 'missing');
    const plainDirectory = join(tempRoot, 'plain');
    mkdirSync(join(readyPath, '.git'), { recursive: true });
    mkdirSync(plainDirectory, { recursive: true });

    try {
      const app = createApp({ coreDb });

      for (const repository of [
        { resourceId: 'repo_001_ready', displayName: 'Ready Repo', localPath: readyPath },
        { resourceId: 'repo_002_missing', displayName: 'Missing Repo', localPath: missingPath },
        { resourceId: 'repo_003_plain', displayName: 'Plain Directory', localPath: plainDirectory },
      ]) {
        const setRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(repository),
        });

        expect(setRes.status).toBe(200);
      }

      const res = await app.request('/api/app/workspaces/ws_demo/repositories/diagnostics');
      const payload = (await res.json()) as Record<string, unknown>;
      const json = JSON.stringify(payload);

      expect(res.status).toBe(200);
      expect(payload).toMatchObject({
        workspaceId: 'ws_demo',
        defaultResourceId: 'repo_001_ready',
        defaultResource: {
          resourceId: 'repo_001_ready',
          diagnosticsStatus: 'ready',
          ready: true,
          pathSummary: 'local directory "ready"',
        },
        resources: [
          {
            resourceId: 'repo_001_ready',
            diagnosticsStatus: 'ready',
            ready: true,
            summary: 'local directory "ready" is ready as a git repository.',
          },
          {
            resourceId: 'repo_002_missing',
            diagnosticsStatus: 'missing',
            ready: false,
            summary: 'local directory "missing" does not exist.',
          },
          {
            resourceId: 'repo_003_plain',
            diagnosticsStatus: 'not_git',
            ready: false,
            summary: 'local directory "plain" is not a git repository directory.',
          },
        ],
      });
      expect(json).not.toContain(tempRoot);
      expect(json).not.toContain(readyPath);
      expect(json).not.toContain(missingPath);
      expect(json).not.toContain(plainDirectory);
      expect(json).not.toContain('localPath');
      expect(json).not.toContain('developer');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns a clear App API error when repository storage is unavailable', async () => {
    const app = createApp();
    const res = await app.request('/api/app/workspaces/ws_demo/repositories');

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: 'repository_storage_unavailable',
      message: 'Repository storage is unavailable for this NanoCore instance.',
    });
  });
});
