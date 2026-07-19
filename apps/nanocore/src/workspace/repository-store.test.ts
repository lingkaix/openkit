import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  getDefaultWorkspaceRepositoryResource,
  listWorkspaceRepositoryResources,
  upsertWorkspaceRepositoryResource,
  type WorkspaceRepositoryStoreWorkspaceExists,
} from './repository-store.js';

/**
 * Opens a migrated workspace database for repository store tests.
 *
 * @returns Migrated workspace database handles.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-repository-store-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'workspace_1');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates a workspace existence guard for repository store tests.
 *
 * @param workspaceIds Workspace ids that should be accepted.
 * @returns Workspace existence callback.
 */
function workspaceExistsFor(workspaceIds: string[]): WorkspaceRepositoryStoreWorkspaceExists {
  return (workspaceId) => workspaceIds.includes(workspaceId);
}

describe('workspace repository store', () => {
  it('creates a workspace repository resource with diagnostics from local validation', () => {
    const workspaceDb = createWorkspaceDb();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-ready-repository-'));
    mkdirSync(join(repositoryPath, '.git'));

    try {
      const resource = upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists: workspaceExistsFor(['workspace_1']),
        workspaceId: 'workspace_1',
        resourceId: 'repo_openkit',
        displayName: 'OpenKit',
        git: {
          authorEmail: 'approver@example.invalid',
          authorName: 'Approving Human',
          allowedPushTargets: ['openkit/release'],
          commitOnApply: true,
          protectedBranchPatterns: ['main', 'release/*'],
          requireReviewLinkage: false,
          stagingStrategy: 'review-branch',
        },
        localPath: repositoryPath,
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(resource).toMatchObject({
        workspaceId: 'workspace_1',
        resourceId: 'repo_openkit',
        type: 'git_repository',
        displayName: 'OpenKit',
        git: {
          authorEmail: 'approver@example.invalid',
          authorName: 'Approving Human',
          allowedPushTargets: ['openkit/release'],
          commitOnApply: true,
          protectedBranchPatterns: ['main', 'release/*'],
          requireReviewLinkage: false,
          stagingStrategy: 'review-branch',
        },
        localPath: repositoryPath,
        diagnosticsStatus: 'ready',
        createdAt: '2026-05-31T00:00:00.000Z',
        updatedAt: '2026-05-31T00:00:00.000Z',
      });
      expect(resource.validation).toMatchObject({ ok: true, status: 'ready' });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('updates an existing workspace repository resource without changing createdAt', () => {
    const workspaceDb = createWorkspaceDb();
    const firstPath = mkdtempSync(join(tmpdir(), 'openkit-first-repository-'));
    const secondPath = mkdtempSync(join(tmpdir(), 'openkit-second-repository-'));
    mkdirSync(join(firstPath, '.git'));

    try {
      const workspaceExists = workspaceExistsFor(['workspace_1']);

      upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists,
        workspaceId: 'workspace_1',
        resourceId: 'repo_openkit',
        displayName: 'OpenKit',
        git: { authorEmail: null, authorName: null, commitOnApply: false },
        localPath: firstPath,
        now: () => '2026-05-31T00:00:00.000Z',
      });

      const updated = upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists,
        workspaceId: 'workspace_1',
        resourceId: 'repo_openkit',
        displayName: 'OpenKit moved',
        git: {
          authorEmail: 'approver@example.invalid',
          authorName: 'Approving Human',
          commitOnApply: true,
        },
        localPath: secondPath,
        now: () => '2026-05-31T00:05:00.000Z',
      });

      expect(updated).toMatchObject({
        workspaceId: 'workspace_1',
        resourceId: 'repo_openkit',
        displayName: 'OpenKit moved',
        git: {
          authorEmail: 'approver@example.invalid',
          authorName: 'Approving Human',
          commitOnApply: true,
        },
        localPath: secondPath,
        diagnosticsStatus: 'not_git',
        createdAt: '2026-05-31T00:00:00.000Z',
        updatedAt: '2026-05-31T00:05:00.000Z',
      });
      expect(listWorkspaceRepositoryResources(workspaceDb, 'workspace_1')).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('defaults repository Git write policy fields safely', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const resource = upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists: workspaceExistsFor(['workspace_1']),
        workspaceId: 'workspace_1',
        resourceId: 'repo_defaults',
        displayName: 'Defaults',
        localPath: '/missing/defaults',
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(resource.git).toEqual({
        authorEmail: null,
        authorName: null,
        allowedPushTargets: [],
        commitOnApply: false,
        protectedBranchPatterns: ['main', 'master', 'release/*', 'v*'],
        requireReviewLinkage: true,
        stagingStrategy: 'staging-root',
        vaultGrantRef: null,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('reads the default repository resource in deterministic order', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const workspaceExists = workspaceExistsFor(['workspace_1']);

      upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists,
        workspaceId: 'workspace_1',
        resourceId: 'repo_later',
        displayName: 'Later',
        localPath: '/missing/later',
        now: () => '2026-05-31T00:02:00.000Z',
      });
      upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists,
        workspaceId: 'workspace_1',
        resourceId: 'repo_earlier_b',
        displayName: 'Earlier B',
        localPath: '/missing/earlier-b',
        now: () => '2026-05-31T00:01:00.000Z',
      });
      upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists,
        workspaceId: 'workspace_1',
        resourceId: 'repo_earlier_a',
        displayName: 'Earlier A',
        localPath: '/missing/earlier-a',
        now: () => '2026-05-31T00:01:00.000Z',
      });

      const resource = getDefaultWorkspaceRepositoryResource(workspaceDb, 'workspace_1');

      expect(resource?.resourceId).toBe('repo_earlier_a');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('lists repository resources for one workspace only in deterministic order', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const workspaceExists = workspaceExistsFor(['workspace_1', 'workspace_2']);

      upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists,
        workspaceId: 'workspace_1',
        resourceId: 'repo_b',
        displayName: 'B',
        localPath: '/missing/b',
        now: () => '2026-05-31T00:01:00.000Z',
      });
      upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists,
        workspaceId: 'workspace_2',
        resourceId: 'repo_other',
        displayName: 'Other',
        localPath: '/missing/other',
        now: () => '2026-05-31T00:00:00.000Z',
      });
      upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists,
        workspaceId: 'workspace_1',
        resourceId: 'repo_a',
        displayName: 'A',
        localPath: '/missing/a',
        now: () => '2026-05-31T00:01:00.000Z',
      });

      expect(
        listWorkspaceRepositoryResources(workspaceDb, 'workspace_1').map((item) => item.resourceId)
      ).toEqual(['repo_a', 'repo_b']);
      expect(getDefaultWorkspaceRepositoryResource(workspaceDb, 'workspace_missing')).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects resources for missing workspaces before writing', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      expect(() =>
        upsertWorkspaceRepositoryResource(workspaceDb, {
          workspaceExists: workspaceExistsFor(['workspace_1']),
          workspaceId: 'workspace_missing',
          resourceId: 'repo_missing',
          displayName: 'Missing',
          localPath: '/missing/repository',
          now: () => '2026-05-31T00:00:00.000Z',
        })
      ).toThrow('Workspace not found: workspace_missing');
      expect(listWorkspaceRepositoryResources(workspaceDb, 'workspace_missing')).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('persists local paths without exposing them in validation diagnostics', () => {
    const workspaceDb = createWorkspaceDb();
    const secretPath = join(
      mkdtempSync(join(tmpdir(), 'openkit-repository-store-')),
      'repo-secret-fragment-123456'
    );

    try {
      const resource = upsertWorkspaceRepositoryResource(workspaceDb, {
        workspaceExists: workspaceExistsFor(['workspace_1']),
        workspaceId: 'workspace_1',
        resourceId: 'repo_secret',
        displayName: 'Secret',
        localPath: secretPath,
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(resource.localPath).toBe(secretPath);
      expect(resource.validation).toMatchObject({ status: 'missing' });
      expect(JSON.stringify(resource.validation)).not.toContain(secretPath);
      expect(JSON.stringify(resource.validation)).not.toContain('secret-fragment-123456');
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
