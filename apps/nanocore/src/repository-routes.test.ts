import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWorkspaceDataSourceCatalog,
  requireCredentialFreeHttpsGitLocator,
  resolveWorkspaceDataSourceReference,
} from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { createDemoWorkspaceForUser, FsStore } from './lib/store.js';
import * as gitPushExecutor from './runtime/git-push-executor.js';
import {
  getGitPushRecord,
  listGitPushRecords,
  recordGitPushRecord,
} from './runtime/git-push-records.js';
import { commandInputHash } from './runtime/idempotent-command.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { type CreateAppOptions, createApp as createNanoCoreApp } from './test-support/app.js';
import { upsertWorkspaceRepositoryResource } from './workspace/repository-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

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
      agentSessions: [],
      turnEvents: [],
    });
  }
  if (options.coreDb) {
    ensureLocalUser(options.coreDb);
    const registered = options.coreDb.sqlite
      .prepare('SELECT 1 FROM workspace_registry WHERE workspace_id = ?')
      .get(demo.workspace.id);
    if (!registered) {
      recordWorkspaceOwnerMembership({
        coreDb: options.coreDb,
        ownerUserId: LOCAL_USER_ID,
        workspaceId: demo.workspace.id,
      });
    }
  }

  return createNanoCoreApp({ ...options, store });
}

/** Creates one linked GitHub-remote repository with a single host commit. */
function createLinkedPushRepository(cwd: string): string {
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'repository-local@example.invalid'], {
    cwd,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Repository Local'], {
    cwd,
    stdio: 'ignore',
  });
  writeFileSync(join(cwd, 'README.md'), '# Approval\n');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'approvable change'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/openkit/openkit.git'], {
    cwd,
    stdio: 'ignore',
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

/** Deterministic host publication Turn id for one git_push.approval.request. */
function publicationTurnId(input: {
  readonly requestId: string;
  readonly resourceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceId: string;
}): string {
  return `tu_repo_push_${commandInputHash({
    actorId: LOCAL_USER_ID,
    command: 'git_push.approval.request',
    repositoryResourceId: input.resourceId,
    requestId: input.requestId,
    threadId: input.threadId,
    turnId: input.turnId,
    workspaceId: input.workspaceId,
  }).slice('sha256:'.length)}`;
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

  it('does not backfill existing repository rows during app construction', () => {
    const coreDb = createCoreDb();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-backfill-repository-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
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
        'workspaces',
        'ws_demo',
        'config',
        'data-sources.jsonc'
      );
      expect(existsSync(catalogPath)).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves an existing network git catalog when setDefault links a missing apply-target path', async () => {
    const coreDb = createCoreDb();
    const catalogPath = join(
      coreDb.dataRoot,
      'workspaces',
      'ws_demo',
      'config',
      'data-sources.jsonc'
    );
    const gitUrl = 'https://github.com/lingkaix/openkit.git';
    const gitCommit = '1bc77878b4607f6b1b4fc7f175536ae1a8ee8de2';
    const catalog = {
      schemaVersion: 1,
      sources: [
        {
          access: 'read-write',
          allowedSlotKinds: ['worktree'],
          displayName: 'OpenKit public main',
          id: 'task-mode-repository',
          kind: 'git',
          locator: { commit: gitCommit, url: gitUrl },
          sensitivity: 'public',
          status: 'active',
        },
      ],
    };
    mkdirSync(join(coreDb.dataRoot, 'workspaces', 'ws_demo', 'config'), { recursive: true });
    writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    const missingPath = join(
      mkdtempSync(join(tmpdir(), 'openkit-absent-apply-target-')),
      'not-cloned'
    );

    try {
      const app = createApp({ coreDb });
      const setRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'OpenKit public main',
          localPath: missingPath,
          resourceId: 'task-mode-repository',
        }),
      });

      expect(setRes.status).toBe(200);
      expect(await setRes.json()).toMatchObject({
        repository: {
          diagnosticsStatus: 'missing',
          resourceId: 'task-mode-repository',
        },
      });

      const parsed = parseWorkspaceDataSourceCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')));
      const source = parsed.sources.find((candidate) => candidate.id === 'task-mode-repository');
      expect(source).toMatchObject({
        id: 'task-mode-repository',
        locator: { commit: gitCommit, url: gitUrl },
        status: 'active',
      });
      expect(Object.keys(source?.locator ?? {}).sort()).toEqual(['commit', 'url']);
      expect(requireCredentialFreeHttpsGitLocator(source?.locator)).toEqual({
        commit: gitCommit,
        url: gitUrl,
      });
      expect(
        resolveWorkspaceDataSourceReference({
          access: 'read-write',
          catalog: parsed,
          slotKind: 'worktree',
          sourceRef: 'task-mode-repository',
        })
      ).toMatchObject({
        sourceId: 'task-mode-repository',
        sourceKind: 'git',
      });

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              'SELECT resource_id AS resourceId, diagnostics_status AS diagnosticsStatus FROM workspace_repository_resources WHERE resource_id = ?'
            )
            .get('task-mode-repository')
        ).toEqual({
          diagnosticsStatus: 'missing',
          resourceId: 'task-mode-repository',
        });
      } finally {
        workspaceDb.sqlite.close();
      }
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
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      try {
        const workspaceRepositoryCount = workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM workspace_repository_resources')
          .get() as { count: number };
        const catalogPath = join(
          coreDb.dataRoot,
          'workspaces',
          'ws_demo',
          'config',
          'data-sources.jsonc'
        );

        expect(serverRepositoryTable.count).toBe(0);
        expect(workspaceRepositoryCount.count).toBe(1);
        expect(existsSync(catalogPath)).toBe(false);
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

  it('denies missing and foreign Git push children without changing state', async () => {
    const coreDb = createCoreDb();
    const store = new FsStore();
    const app = createApp({ coreDb, store });
    const timestamp = '2026-07-19T00:00:00.000Z';

    try {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: LOCAL_USER_ID,
        workspaceId: 'ws_demo',
      });
      const turn = store.createTurn('ws_demo', 'th_demo', 'Check Git push lineage.', {
        kind: 'user',
        id: 'user_local',
      });
      store.createApproval({
        createdAt: timestamp,
        description: 'Foreign Git push approval.',
        id: 'ap_foreign_git_push',
        kind: 'permission',
        resolvedAt: timestamp,
        status: 'granted',
        threadId: 'th_foreign',
        title: 'Foreign approval',
        turnId: 'tu_foreign',
        workspaceId: 'ws_foreign',
      });

      const seededForeignDb = openWorkspaceDb(coreDb.dataRoot, 'ws_foreign');
      try {
        applyScopedMigrations(seededForeignDb);
        recordGitPushRecord(seededForeignDb, {
          record: {
            actorId: LOCAL_USER_ID,
            approvalRowId: null,
            commitIds: ['abc123'],
            createdAt: timestamp,
            errorSummary: 'Refused by policy.',
            id: 'gpr_foreign',
            outcome: 'refused-policy',
            policyDecisionId: null,
            remoteHeadAfter: null,
            remoteHeadBefore: null,
            remoteSummary: 'Git repository on origin',
            repositoryResourceId: 'repo_foreign',
            reviewIds: [],
            sourceRef: 'HEAD',
            targetBranch: 'main',
            updatedAt: timestamp,
            workspaceId: 'ws_foreign',
          },
          requestId: '00000000-0000-4000-8000-000000000101',
        });
      } finally {
        seededForeignDb.sqlite.close();
      }

      const missingRecord = await app.request(
        '/api/app/workspaces/ws_demo/repositories/git-push-records/gpr_missing'
      );
      const foreignRecord = await app.request(
        '/api/app/workspaces/ws_demo/repositories/git-push-records/gpr_foreign'
      );
      const missingRepository = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_missing/git-push/approval',
        {
          body: JSON.stringify({
            commitIds: ['abc123'],
            requestId: '00000000-0000-4000-8000-000000000102',
            sourceRef: 'HEAD',
            targetBranch: 'main',
            threadId: turn.threadId,
            turnId: turn.id,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      const foreignApproval = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_missing/git-push',
        {
          body: JSON.stringify({
            approvalRequestId: 'ap_foreign_git_push',
            requestId: '00000000-0000-4000-8000-000000000103',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      const responses = [missingRecord, foreignRecord, missingRepository, foreignApproval];
      const bodies = await Promise.all(responses.map((response) => response.clone().json()));

      expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 404]);
      expect(bodies).toEqual([
        expect.objectContaining({ code: 'workspace_access_denied' }),
        bodies[0],
        bodies[0],
        expect.objectContaining({ code: 'not_found', message: 'Thread not found.' }),
      ]);
      expect(store.getTurn('ws_demo', 'th_demo', turn.id)).toMatchObject({ status: 'running' });
      expect(store.getApproval('ap_foreign_git_push')).toMatchObject({
        status: 'granted',
        workspaceId: 'ws_foreign',
      });
      expect(store.listCommandRequests()).toEqual([]);

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      const foreignDb = openWorkspaceDb(coreDb.dataRoot, 'ws_foreign');
      try {
        expect(listGitPushRecords(workspaceDb, 'ws_demo')).toEqual([]);
        expect(getGitPushRecord(foreignDb, 'ws_foreign', 'gpr_foreign')).toMatchObject({
          id: 'gpr_foreign',
          outcome: 'refused-policy',
          workspaceId: 'ws_foreign',
        });
      } finally {
        workspaceDb.sqlite.close();
        foreignDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a DATA_ROOT-contained replacement without mutating the existing repository row or catalog bytes', async () => {
    const coreDb = createCoreDb();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-preseed-repository-'));
    mkdirSync(join(repositoryPath, '.git'));
    const catalogPath = join(
      coreDb.dataRoot,
      'workspaces',
      'ws_demo',
      'config',
      'data-sources.jsonc'
    );

    try {
      const app = createApp({ coreDb });
      const seedRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'External repository',
          localPath: repositoryPath,
        }),
      });

      expect(seedRes.status).toBe(200);
      expect(existsSync(catalogPath)).toBe(false);

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      try {
        const beforeRow = workspaceDb.sqlite
          .prepare('SELECT * FROM workspace_repository_resources')
          .get();
        const containedPath = join(coreDb.dataRoot, 'contained-repo');

        const replaceRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            displayName: 'Contained repository',
            localPath: containedPath,
          }),
        });
        const replacePayload = (await replaceRes.json()) as Record<string, unknown>;
        const replaceJson = JSON.stringify(replacePayload);
        const afterRow = workspaceDb.sqlite
          .prepare('SELECT * FROM workspace_repository_resources')
          .get();

        expect(replaceRes.status).toBe(400);
        expect(replacePayload).toMatchObject({
          code: 'repository_resource_failed',
        });
        expect(afterRow).toEqual(beforeRow);
        expect(existsSync(catalogPath)).toBe(false);
        expect(replaceJson).not.toContain(containedPath);
        expect(replaceJson).not.toContain(coreDb.dataRoot);
        expect(replaceJson).not.toContain(repositoryPath);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('opens one publication Turn for host push approval when the source Worker Turn is terminal', async () => {
    const coreDb = createCoreDb();
    const store = new FsStore();
    const app = createApp({ coreDb, store });
    const thread = store.createThread('ws_demo', 'Publish accepted worker work');
    const sourceTurn = store.createTurn('ws_demo', thread.id, 'Accepted apply', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    store.updateTurn(sourceTurn.id, {
      completedAt: '2026-07-19T00:00:00.000Z',
      status: 'completed',
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-git-push-terminal-source-'));
    const commitId = createLinkedPushRepository(repositoryPath);
    const requestId = '00000000-0000-4000-8000-000000000201';
    const body = {
      commitIds: [commitId],
      requestId,
      sourceRef: 'HEAD',
      targetBranch: 'main',
      threadId: thread.id,
      turnId: sourceTurn.id,
    };

    try {
      const repositoryRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        body: JSON.stringify({
          displayName: 'Publish repository',
          git: {
            allowedPushTargets: ['main'],
            authorEmail: null,
            authorName: null,
            commitOnApply: true,
          },
          localPath: repositoryPath,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'PUT',
      });
      expect(repositoryRes.status).toBe(200);

      const approvalRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(approvalRes.status).toBe(200);
      const expectedPublicationTurnId = publicationTurnId({
        requestId,
        resourceId: 'repo_default',
        threadId: thread.id,
        turnId: sourceTurn.id,
        workspaceId: 'ws_demo',
      });
      const approvalPayload = await approvalRes.json();
      expect(approvalPayload).toMatchObject({
        approval: {
          kind: 'permission',
          status: 'pending',
          threadId: thread.id,
          turnId: expectedPublicationTurnId,
        },
      });
      expect(store.getTurn('ws_demo', thread.id, sourceTurn.id).status).toBe('completed');
      expect(store.getTurn('ws_demo', thread.id, expectedPublicationTurnId).status).toBe(
        'awaiting_human'
      );

      const replayRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(replayRes.status).toBe(200);
      expect(
        store
          .listThreadTurns('ws_demo', thread.id)
          .filter((turn) => turn.id !== sourceTurn.id)
          .map((turn) => turn.id)
      ).toEqual([expectedPublicationTurnId]);

      const conflictRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify({ ...body, targetBranch: 'other' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(conflictRes.status).toBe(409);
      await expect(conflictRes.json()).resolves.toMatchObject({ code: 'idempotency_key_conflict' });
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(2);

      const grantRes = await app.request(`/api/approvals/${approvalPayload.approval.id}/respond`, {
        body: JSON.stringify({
          decision: 'granted',
          requestId: '00000000-0000-4000-8000-000000000206',
          threadId: thread.id,
          turnId: expectedPublicationTurnId,
          workspaceId: 'ws_demo',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(grantRes.status).toBe(200);
      expect(store.getTurn('ws_demo', thread.id, sourceTurn.id)).toMatchObject({
        completedAt: '2026-07-19T00:00:00.000Z',
        status: 'completed',
      });
      expect(store.getTurn('ws_demo', thread.id, expectedPublicationTurnId)).toMatchObject({
        humanGate: null,
        status: 'completed',
      });

      const executeRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push',
        {
          body: JSON.stringify({
            approvalRequestId: approvalPayload.approval.id,
            requestId: '00000000-0000-4000-8000-000000000207',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(executeRes.status).toBe(200);
      await expect(executeRes.json()).resolves.toMatchObject({
        commitIds: [commitId],
        repositoryResourceId: 'repo_default',
        targetBranch: 'main',
        workspaceId: 'ws_demo',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('terminalizes only the publication Turn when the host push approval is denied', async () => {
    const coreDb = createCoreDb();
    const store = new FsStore();
    const app = createApp({ coreDb, store });
    const thread = store.createThread('ws_demo', 'Deny publication of accepted work');
    const sourceTurn = store.createTurn('ws_demo', thread.id, 'Accepted apply', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    store.updateTurn(sourceTurn.id, {
      completedAt: '2026-07-19T00:00:00.000Z',
      status: 'completed',
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-git-push-terminal-deny-'));
    const commitId = createLinkedPushRepository(repositoryPath);
    const requestId = '00000000-0000-4000-8000-000000000208';

    try {
      expect(
        (
          await app.request('/api/app/workspaces/ws_demo/repositories/default', {
            body: JSON.stringify({
              displayName: 'Publish repository',
              git: {
                allowedPushTargets: ['main'],
                authorEmail: null,
                authorName: null,
                commitOnApply: true,
              },
              localPath: repositoryPath,
            }),
            headers: { 'content-type': 'application/json' },
            method: 'PUT',
          })
        ).status
      ).toBe(200);

      const approvalRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify({
            commitIds: [commitId],
            requestId,
            sourceRef: 'HEAD',
            targetBranch: 'main',
            threadId: thread.id,
            turnId: sourceTurn.id,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(approvalRes.status).toBe(200);
      const approvalPayload = await approvalRes.json();
      const expectedPublicationTurnId = publicationTurnId({
        requestId,
        resourceId: 'repo_default',
        threadId: thread.id,
        turnId: sourceTurn.id,
        workspaceId: 'ws_demo',
      });
      const denyRes = await app.request(`/api/approvals/${approvalPayload.approval.id}/respond`, {
        body: JSON.stringify({
          decision: 'denied',
          requestId: '00000000-0000-4000-8000-000000000209',
          threadId: thread.id,
          turnId: expectedPublicationTurnId,
          workspaceId: 'ws_demo',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(denyRes.status).toBe(200);
      expect(store.getTurn('ws_demo', thread.id, sourceTurn.id)).toMatchObject({
        completedAt: '2026-07-19T00:00:00.000Z',
        status: 'completed',
      });
      expect(store.getTurn('ws_demo', thread.id, expectedPublicationTurnId)).toMatchObject({
        humanGate: null,
        status: 'cancelled',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps a running host Turn as the Git push approval owner', async () => {
    const coreDb = createCoreDb();
    const store = new FsStore();
    const app = createApp({ coreDb, store });
    const thread = store.createThread('ws_demo', 'Publish from a live host Turn');
    const turn = store.createTurn('ws_demo', thread.id, 'Publish accepted work', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-git-push-running-host-'));
    const commitId = createLinkedPushRepository(repositoryPath);

    try {
      expect(
        (
          await app.request('/api/app/workspaces/ws_demo/repositories/default', {
            body: JSON.stringify({
              displayName: 'Publish repository',
              git: {
                allowedPushTargets: ['main'],
                authorEmail: null,
                authorName: null,
                commitOnApply: true,
              },
              localPath: repositoryPath,
            }),
            headers: { 'content-type': 'application/json' },
            method: 'PUT',
          })
        ).status
      ).toBe(200);

      const approvalRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify({
            commitIds: [commitId],
            requestId: '00000000-0000-4000-8000-000000000202',
            sourceRef: 'HEAD',
            targetBranch: 'main',
            threadId: thread.id,
            turnId: turn.id,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(approvalRes.status).toBe(200);
      await expect(approvalRes.json()).resolves.toMatchObject({
        approval: { threadId: thread.id, turnId: turn.id },
      });
      expect(store.getTurn('ws_demo', thread.id, turn.id).status).toBe('awaiting_human');
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('executes a terminal-source auto_allow host push using the source command Turn receipt', async () => {
    const coreDb = createCoreDb();
    const store = new FsStore();
    const app = createApp({
      coreDb,
      openKitConfig: {
        policy: { workspaceApprovalModes: { ws_demo: { 'repo.push': 'auto_allow' } } },
      },
      store,
    });
    const thread = store.createThread('ws_demo', 'Trusted workspace publication');
    const sourceTurn = store.createTurn('ws_demo', thread.id, 'Accepted apply', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    store.updateTurn(sourceTurn.id, {
      completedAt: '2026-07-19T00:00:00.000Z',
      status: 'completed',
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-git-push-auto-allow-terminal-'));
    const commitId = createLinkedPushRepository(repositoryPath);
    const requestId = '00000000-0000-4000-8000-000000000211';
    const runner = vi.spyOn(gitPushExecutor, 'runGitPushCommand').mockResolvedValue({
      exitCode: 1,
      stderr: 'mocked Git push effect',
      stdout: '',
    });

    try {
      expect(
        (
          await app.request('/api/app/workspaces/ws_demo/repositories/default', {
            body: JSON.stringify({
              displayName: 'Publish repository',
              git: {
                allowedPushTargets: ['main'],
                authorEmail: null,
                authorName: null,
                commitOnApply: true,
              },
              localPath: repositoryPath,
            }),
            headers: { 'content-type': 'application/json' },
            method: 'PUT',
          })
        ).status
      ).toBe(200);

      const approvalRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify({
            commitIds: [commitId],
            requestId,
            sourceRef: 'HEAD',
            targetBranch: 'main',
            threadId: thread.id,
            turnId: sourceTurn.id,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(approvalRes.status).toBe(200);
      const expectedPublicationTurnId = publicationTurnId({
        requestId,
        resourceId: 'repo_default',
        threadId: thread.id,
        turnId: sourceTurn.id,
        workspaceId: 'ws_demo',
      });
      const approvalPayload = await approvalRes.json();
      expect(approvalPayload).toMatchObject({
        approval: {
          status: 'granted',
          threadId: thread.id,
          turnId: expectedPublicationTurnId,
        },
      });
      expect(store.getTurn('ws_demo', thread.id, sourceTurn.id).status).toBe('completed');
      expect(store.getTurn('ws_demo', thread.id, expectedPublicationTurnId).status).toBe(
        'completed'
      );

      const executeRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push',
        {
          body: JSON.stringify({
            approvalRequestId: approvalPayload.approval.id,
            requestId: '00000000-0000-4000-8000-000000000212',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(executeRes.status).toBe(200);
      await expect(executeRes.json()).resolves.toMatchObject({
        commitIds: [commitId],
        repositoryResourceId: 'repo_default',
        targetBranch: 'main',
        workspaceId: 'ws_demo',
      });
      expect(store.getTurn('ws_demo', thread.id, sourceTurn.id)).toMatchObject({
        completedAt: '2026-07-19T00:00:00.000Z',
        status: 'completed',
      });
      expect(store.getTurn('ws_demo', thread.id, expectedPublicationTurnId).status).toBe(
        'completed'
      );
    } finally {
      runner.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('refuses a terminal-source Git push approval while the Thread is busy', async () => {
    const coreDb = createCoreDb();
    const store = new FsStore();
    const app = createApp({ coreDb, store });
    const thread = store.createThread('ws_demo', 'Busy publication Thread');
    const sourceTurn = store.createTurn('ws_demo', thread.id, 'Accepted apply', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    store.updateTurn(sourceTurn.id, {
      completedAt: '2026-07-19T00:00:00.000Z',
      status: 'completed',
    });
    const competing = store.createTurn('ws_demo', thread.id, 'Other active work', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-git-push-busy-thread-'));
    const commitId = createLinkedPushRepository(repositoryPath);

    try {
      expect(
        (
          await app.request('/api/app/workspaces/ws_demo/repositories/default', {
            body: JSON.stringify({
              displayName: 'Publish repository',
              git: {
                allowedPushTargets: ['main'],
                authorEmail: null,
                authorName: null,
                commitOnApply: true,
              },
              localPath: repositoryPath,
            }),
            headers: { 'content-type': 'application/json' },
            method: 'PUT',
          })
        ).status
      ).toBe(200);

      const approvalRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify({
            commitIds: [commitId],
            requestId: '00000000-0000-4000-8000-000000000203',
            sourceRef: 'HEAD',
            targetBranch: 'main',
            threadId: thread.id,
            turnId: sourceTurn.id,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(approvalRes.status).toBe(409);
      await expect(approvalRes.json()).resolves.toMatchObject({ code: 'thread_busy' });
      expect(store.getTurn('ws_demo', thread.id, sourceTurn.id).status).toBe('completed');
      expect(store.getTurn('ws_demo', thread.id, competing.id).status).toBe('running');
      expect(store.listThreadTurns('ws_demo', thread.id)).toHaveLength(2);
      expect(store.listCommandRequests()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses a wrong-scope Git push approval before creating a Gate', async () => {
    const coreDb = createCoreDb();
    const store = new FsStore();
    const app = createApp({ coreDb, store });
    const sourceThread = store.createThread('ws_demo', 'Source worker thread');
    const otherThread = store.createThread('ws_demo', 'Other thread');
    const sourceTurn = store.createTurn('ws_demo', sourceThread.id, 'Accepted apply', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    store.updateTurn(sourceTurn.id, {
      completedAt: '2026-07-19T00:00:00.000Z',
      status: 'completed',
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-git-push-wrong-scope-'));
    const commitId = createLinkedPushRepository(repositoryPath);

    try {
      expect(
        (
          await app.request('/api/app/workspaces/ws_demo/repositories/default', {
            body: JSON.stringify({
              displayName: 'Publish repository',
              git: {
                allowedPushTargets: ['main'],
                authorEmail: null,
                authorName: null,
                commitOnApply: true,
              },
              localPath: repositoryPath,
            }),
            headers: { 'content-type': 'application/json' },
            method: 'PUT',
          })
        ).status
      ).toBe(200);

      const approvalRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify({
            commitIds: [commitId],
            requestId: '00000000-0000-4000-8000-000000000204',
            sourceRef: 'HEAD',
            targetBranch: 'main',
            threadId: otherThread.id,
            turnId: sourceTurn.id,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(approvalRes.status).toBe(404);
      await expect(approvalRes.json()).resolves.toMatchObject({ code: 'not_found' });
      expect(store.getTurn('ws_demo', sourceThread.id, sourceTurn.id).status).toBe('completed');
      expect(store.listThreadTurns('ws_demo', otherThread.id)).toEqual([]);
      expect(store.listCommandRequests()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns recovery_required for an orphan running publication Turn without a Gate or receipt', async () => {
    const coreDb = createCoreDb();
    const store = new FsStore();
    const app = createApp({ coreDb, store });
    const thread = store.createThread('ws_demo', 'Publish with an orphan publication Turn');
    const sourceTurn = store.createTurn('ws_demo', thread.id, 'Accepted apply', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    store.updateTurn(sourceTurn.id, {
      completedAt: '2026-07-19T00:00:00.000Z',
      status: 'completed',
    });
    const requestId = '00000000-0000-4000-8000-000000000210';
    const publicationTurn = store.createTurn(
      'ws_demo',
      thread.id,
      'Orphan publication Turn',
      { kind: 'user', id: LOCAL_USER_ID },
      null,
      {
        turnId: publicationTurnId({
          requestId,
          resourceId: 'repo_default',
          threadId: thread.id,
          turnId: sourceTurn.id,
          workspaceId: 'ws_demo',
        }),
      }
    );
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-git-push-orphan-publication-'));
    const commitId = createLinkedPushRepository(repositoryPath);
    const body = {
      commitIds: [commitId],
      requestId,
      sourceRef: 'HEAD',
      targetBranch: 'main',
      threadId: thread.id,
      turnId: sourceTurn.id,
    };

    try {
      expect(
        (
          await app.request('/api/app/workspaces/ws_demo/repositories/default', {
            body: JSON.stringify({
              displayName: 'Publish repository',
              git: {
                allowedPushTargets: ['main'],
                authorEmail: null,
                authorName: null,
                commitOnApply: true,
              },
              localPath: repositoryPath,
            }),
            headers: { 'content-type': 'application/json' },
            method: 'PUT',
          })
        ).status
      ).toBe(200);

      const approvalRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(approvalRes.status).toBe(409);
      await expect(approvalRes.json()).resolves.toMatchObject({ code: 'recovery_required' });

      const changedRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify({ ...body, targetBranch: 'other' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(changedRes.status).toBe(409);
      await expect(changedRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(store.getTurn('ws_demo', thread.id, sourceTurn.id).status).toBe('completed');
      expect(store.getTurn('ws_demo', thread.id, publicationTurn.id)).toEqual(publicationTurn);
      expect(store.listThreadTurns('ws_demo', thread.id).map((turn) => turn.id)).toEqual([
        sourceTurn.id,
        publicationTurn.id,
      ]);
      expect(store.listThreadItems('ws_demo', thread.id)).toEqual([]);
      expect(store.listCommandRequests()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns recovery_required when a terminal-source Gate exists without its receipt', async () => {
    const coreDb = createCoreDb();
    const store = new FsStore();
    const app = createApp({ coreDb, store });
    const thread = store.createThread('ws_demo', 'Publish with a missing receipt');
    const sourceTurn = store.createTurn('ws_demo', thread.id, 'Accepted apply', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    store.updateTurn(sourceTurn.id, {
      completedAt: '2026-07-19T00:00:00.000Z',
      status: 'completed',
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-git-push-receipt-gap-'));
    const commitId = createLinkedPushRepository(repositoryPath);
    const requestId = '00000000-0000-4000-8000-000000000205';

    try {
      expect(
        (
          await app.request('/api/app/workspaces/ws_demo/repositories/default', {
            body: JSON.stringify({
              displayName: 'Publish repository',
              git: {
                allowedPushTargets: ['main'],
                authorEmail: null,
                authorName: null,
                commitOnApply: true,
              },
              localPath: repositoryPath,
            }),
            headers: { 'content-type': 'application/json' },
            method: 'PUT',
          })
        ).status
      ).toBe(200);

      const recordSpy = vi.spyOn(store, 'recordCommandRequest').mockImplementationOnce(() => {
        throw new Error('Injected Git push approval receipt failure.');
      });
      const approvalRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify({
            commitIds: [commitId],
            requestId,
            sourceRef: 'HEAD',
            targetBranch: 'main',
            threadId: thread.id,
            turnId: sourceTurn.id,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      recordSpy.mockRestore();
      expect(approvalRes.status).toBe(409);
      await expect(approvalRes.json()).resolves.toMatchObject({ code: 'recovery_required' });

      const retryRes = await app.request(
        '/api/app/workspaces/ws_demo/repositories/repo_default/git-push/approval',
        {
          body: JSON.stringify({
            commitIds: [commitId],
            requestId,
            sourceRef: 'HEAD',
            targetBranch: 'main',
            threadId: thread.id,
            turnId: sourceTurn.id,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      expect(retryRes.status).toBe(409);
      await expect(retryRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      expect(store.getTurn('ws_demo', thread.id, sourceTurn.id).status).toBe('completed');
      expect(store.listCommandRequests()).toEqual([]);
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
