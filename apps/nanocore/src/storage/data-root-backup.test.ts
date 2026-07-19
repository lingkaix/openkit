import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  createOpenKitAccessTokenRecord,
  verifyOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import {
  bindThreadMaterial,
  createWorkspaceMaterial,
  saveWorkspaceMaterialRevision,
} from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  DATA_ROOT_BACKUP_MANIFEST_FILE,
  restoreDataRootBackup,
  verifyDataRootBackupManifest,
  writeColdDataRootBackupManifest,
  writeHotDataRootBackup,
} from './data-root-backup.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { LOCAL_USER_ID } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

const timestamp = '2026-07-06T00:00:00.000Z';

describe('data-root backup manifest', () => {
  it('writes and verifies a cold backup manifest over a copied data root', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-data-root-backup-'));
    mkdirSync(join(root, 'server'), { recursive: true });
    mkdirSync(join(root, 'users', 'user_local'), { recursive: true });
    writeFileSync(join(root, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeFileSync(join(root, 'users', 'user_local', 'profile.json'), '{"id":"user_local"}\n');

    const verified = writeColdDataRootBackupManifest({
      backupRoot: root,
      backupId: 'drbak_demo',
      sourceDeploymentId: 'dep_local',
      startedAt: timestamp,
      completedAt: timestamp,
    });

    expect(existsSync(join(root, DATA_ROOT_BACKUP_MANIFEST_FILE))).toBe(true);
    expect(verified.manifest.consistency).toBe('clean');
    expect(verified.checkedFiles).toEqual(['server/layout.json', 'users/user_local/profile.json']);
  });

  it('rejects tampered backup files and extra files', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-data-root-backup-'));
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeColdDataRootBackupManifest({
      backupRoot: root,
      backupId: 'drbak_demo',
      sourceDeploymentId: 'dep_local',
      startedAt: timestamp,
      completedAt: timestamp,
    });

    writeFileSync(join(root, 'server', 'layout.json'), '{"layoutVersion":2}\n');
    expect(() => verifyDataRootBackupManifest({ backupRoot: root })).toThrow(
      'Digest mismatch for backup file server/layout.json'
    );

    const extraRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-backup-'));
    mkdirSync(join(extraRoot, 'server'), { recursive: true });
    writeFileSync(join(extraRoot, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeColdDataRootBackupManifest({
      backupRoot: extraRoot,
      backupId: 'drbak_demo',
      sourceDeploymentId: 'dep_local',
      startedAt: timestamp,
      completedAt: timestamp,
    });
    writeFileSync(join(extraRoot, 'server', 'extra.json'), '{}\n');

    expect(() => verifyDataRootBackupManifest({ backupRoot: extraRoot })).toThrow(
      'Backup file missing from inventory: server/extra.json'
    );
  });

  it('rejects unsupported backup required features', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-data-root-backup-'));
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeColdDataRootBackupManifest({
      backupRoot: root,
      backupId: 'drbak_demo',
      sourceDeploymentId: 'dep_local',
      startedAt: timestamp,
      completedAt: timestamp,
    });
    const manifestPath = join(root, DATA_ROOT_BACKUP_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.requiredFeatures = ['workspace.mount.fuse'];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifyDataRootBackupManifest({ backupRoot: root })).toThrow(
      'Unsupported required feature: workspace.mount.fuse'
    );
  });

  it('restores same-deployment authority from a hot full-data-root backup', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-hot-source-'));
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-hot-backup-'));
    const restoredDataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-hot-restored-'));
    mkdirSync(join(dataRoot, 'server', 'db'), { recursive: true });
    mkdirSync(join(dataRoot, 'users', 'user_local'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'server', 'layout.json'),
      '{"schemaVersion":1,"layoutVersion":2,"deploymentId":"deployment_backup_test"}\n'
    );
    writeFileSync(join(dataRoot, 'users', 'user_local', 'profile.json'), '{"id":"user_local"}\n');

    const workspaceId = 'ws_backup_materials';
    const sourceDb = openCoreDb(dataRoot);
    applyMigrations(sourceDb);
    sourceDb.sqlite.pragma('user_version = 7');
    const createdAt = new Date(timestamp).getTime();
    sourceDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
        ) VALUES
          ('user_backup_owner', 'Backup Owner', 'backup-owner@example.com', false, ?, ?, 'human', 'active', NULL),
          ('user_backup_editor', 'Backup Editor', 'backup-editor@example.com', false, ?, ?, 'human', 'active', NULL),
          ('user_backup_removed', 'Backup Removed', 'backup-removed@example.com', false, ?, ?, 'human', 'active', NULL),
          ('user_backup_invitee', 'Backup Invitee', 'backup-invitee@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(createdAt, createdAt, createdAt, createdAt, createdAt, createdAt, createdAt, createdAt);
    recordWorkspaceOwnerMembership({
      coreDb: sourceDb,
      ownerUserId: 'user_backup_owner',
      workspaceId,
      now: new Date(timestamp),
    });
    sourceDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES
          (?, 'user_backup_editor', 'active', 'editor', NULL, ?, NULL, 2, ?, ?),
          (?, 'user_backup_removed', 'removed', 'viewer', NULL, ?, ?, 3, ?, ?)`
      )
      .run(
        workspaceId,
        timestamp,
        timestamp,
        timestamp,
        workspaceId,
        timestamp,
        '2026-07-06T00:30:00.000Z',
        timestamp,
        '2026-07-06T00:30:00.000Z'
      );
    sourceDb.sqlite
      .prepare(
        `INSERT INTO workspace_invitations (
          invitation_id, workspace_id, invitee_user_id, proposed_access_level, inviter_user_id,
          status, expires_at, accepted_at, declined_at, revoked_at, revision, created_at, updated_at
        ) VALUES (
          'inv_backup_pending', ?, 'user_backup_invitee', 'viewer', 'user_backup_owner',
          'pending', '2026-07-13T00:00:00.000Z', NULL, NULL, NULL, 4, ?, ?
        )`
      )
      .run(workspaceId, timestamp, timestamp);
    const issuedToken = createOpenKitAccessTokenRecord(sourceDb, {
      expiresAt: '2026-08-06T00:00:00.000Z',
      now: new Date(timestamp),
      ownerUserId: 'user_backup_editor',
      scope: 'workspace',
      tokenId: 'token_backup_workspace',
      workspaceIds: [workspaceId],
    });
    verifyOpenKitAccessTokenRecord(sourceDb, issuedToken.secret, {
      channel: 'cli',
      now: new Date('2026-07-06T01:00:00.000Z'),
      source: 'same-deployment-backup-test',
    });
    const authoritySql = {
      invitation: 'SELECT * FROM workspace_invitations WHERE invitation_id = ?',
      memberships: 'SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY user_id',
      registry: 'SELECT * FROM workspace_registry WHERE workspace_id = ?',
      tokenMetadata: `SELECT token_id, owner_user_id, scope, workspace_ids_json, status, issued_at,
                             expires_at, predecessor_token_id, rotated_grace_expires_at,
                             last_used_at, last_used_channel, last_used_source
                      FROM openkit_access_tokens WHERE token_id = ?`,
      users: 'SELECT * FROM users ORDER BY id',
    } as const;
    const expectedAuthority = {
      invitation: sourceDb.sqlite.prepare(authoritySql.invitation).get('inv_backup_pending'),
      memberships: sourceDb.sqlite.prepare(authoritySql.memberships).all(workspaceId),
      registry: sourceDb.sqlite.prepare(authoritySql.registry).get(workspaceId),
      tokenMetadata: sourceDb.sqlite.prepare(authoritySql.tokenMetadata).get(issuedToken.tokenId),
      users: sourceDb.sqlite.prepare(authoritySql.users).all(),
    };
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb);
    const material = createWorkspaceMaterial(workspaceDb, {
      acceptedAt: timestamp,
      actorId: LOCAL_USER_ID,
      kind: 'markdown',
      requestId: 'backup-material-create',
      sensitivity: 'internal',
      title: 'Backup material',
    });
    const content = '# Backup material';
    saveWorkspaceMaterialRevision(workspaceDb, {
      acceptedAt: timestamp,
      actorId: LOCAL_USER_ID,
      content,
      contentDigest: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
      expectedRevisionId: null,
      materialId: material.materialId,
      requestId: 'backup-material-save',
    });
    bindThreadMaterial(workspaceDb, {
      acceptedAt: timestamp,
      expectedBindingState: 'absent',
      materialId: material.materialId,
      requestId: 'backup-material-bind',
      threadId: 'th_backup',
    });

    const verified = await writeHotDataRootBackup({
      dataRoot,
      backupRoot,
      backupId: 'drbak_hot',
      sourceDeploymentId: 'deployment_backup_test',
      startedAt: timestamp,
      completedAt: '2026-07-06T00:00:01.000Z',
    });

    sourceDb.sqlite.pragma('user_version = 8');
    sourceDb.sqlite.close();
    workspaceDb.sqlite.close();

    expect(verified.manifest.backupMode).toBe('hot');
    expect(verified.manifest.consistency).toBe('crash-consistent');
    expect(verified.checkedFiles).toContain('server/db/core.sqlite');
    expect(verified.checkedFiles).toContain('server/layout.json');

    const backupDb = new Database(join(backupRoot, 'server', 'db', 'core.sqlite'), {
      readonly: true,
    });
    try {
      expect(backupDb.pragma('user_version', { simple: true })).toBe(7);
    } finally {
      backupDb.close();
    }
    const backupWorkspaceDb = new Database(
      join(backupRoot, 'workspaces', workspaceId, 'db', 'workspace.sqlite'),
      { readonly: true }
    );
    try {
      expect(
        backupWorkspaceDb.prepare('SELECT COUNT(*) FROM workspace_materials').pluck().get()
      ).toBe(1);
      expect(
        backupWorkspaceDb.prepare('SELECT COUNT(*) FROM workspace_material_revisions').pluck().get()
      ).toBe(1);
      expect(
        backupWorkspaceDb.prepare('SELECT COUNT(*) FROM thread_material_bindings').pluck().get()
      ).toBe(1);
    } finally {
      backupWorkspaceDb.close();
    }
    expect(verifyDataRootBackupManifest({ backupRoot }).manifest.consistency).toBe(
      'crash-consistent'
    );

    restoreDataRootBackup({ backupRoot, dataRoot: restoredDataRoot });
    const restoredDb = new Database(join(restoredDataRoot, 'server', 'db', 'core.sqlite'), {
      readonly: true,
    });
    try {
      expect({
        invitation: restoredDb.prepare(authoritySql.invitation).get('inv_backup_pending'),
        memberships: restoredDb.prepare(authoritySql.memberships).all(workspaceId),
        registry: restoredDb.prepare(authoritySql.registry).get(workspaceId),
        tokenMetadata: restoredDb.prepare(authoritySql.tokenMetadata).get(issuedToken.tokenId),
        users: restoredDb.prepare(authoritySql.users).all(),
      }).toEqual(expectedAuthority);
    } finally {
      restoredDb.close();
    }
    const restoredCoreDb = openCoreDb(restoredDataRoot);
    try {
      expect(
        verifyOpenKitAccessTokenRecord(restoredCoreDb, issuedToken.secret, {
          channel: 'cli',
          now: new Date('2026-07-06T01:00:00.000Z'),
          source: 'same-deployment-backup-test',
        })
      ).toMatchObject({
        ownerUserId: 'user_backup_editor',
        tokenId: issuedToken.tokenId,
        workspaceIds: [workspaceId],
      });
    } finally {
      restoredCoreDb.sqlite.close();
    }
  });

  it('restores a verified backup by replacing the target data root', () => {
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-restore-backup-'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-restore-target-'));
    mkdirSync(join(backupRoot, 'server'), { recursive: true });
    writeFileSync(join(backupRoot, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeFileSync(join(dataRoot, 'stale.txt'), 'stale\n');
    writeColdDataRootBackupManifest({
      backupRoot,
      backupId: 'drbak_restore',
      sourceDeploymentId: 'dep_local',
      startedAt: timestamp,
      completedAt: timestamp,
    });

    const restored = restoreDataRootBackup({ backupRoot, dataRoot });

    expect(restored.manifest.id).toBe('drbak_restore');
    expect(existsSync(join(dataRoot, 'stale.txt'))).toBe(false);
    expect(readFileSync(join(dataRoot, 'server', 'layout.json'), 'utf8')).toBe(
      '{"layoutVersion":1}\n'
    );
    expect(existsSync(join(dataRoot, DATA_ROOT_BACKUP_MANIFEST_FILE))).toBe(true);
  });

  it('rejects restore from a backup that does not verify', () => {
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-restore-bad-backup-'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-restore-target-'));
    mkdirSync(join(backupRoot, 'server'), { recursive: true });
    writeFileSync(join(backupRoot, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeFileSync(join(dataRoot, 'kept.txt'), 'kept\n');
    writeColdDataRootBackupManifest({
      backupRoot,
      backupId: 'drbak_restore',
      sourceDeploymentId: 'dep_local',
      startedAt: timestamp,
      completedAt: timestamp,
    });
    writeFileSync(join(backupRoot, 'server', 'layout.json'), '{"layoutVersion":2}\n');

    expect(() => restoreDataRootBackup({ backupRoot, dataRoot })).toThrow(
      'Digest mismatch for backup file server/layout.json'
    );
    expect(readFileSync(join(dataRoot, 'kept.txt'), 'utf8')).toBe('kept\n');
  });

  it('rejects restore staging inside the backup root', () => {
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-restore-backup-'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-restore-target-'));
    mkdirSync(join(backupRoot, 'server'), { recursive: true });
    writeFileSync(join(backupRoot, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeColdDataRootBackupManifest({
      backupRoot,
      backupId: 'drbak_restore',
      sourceDeploymentId: 'dep_local',
      startedAt: timestamp,
      completedAt: timestamp,
    });

    expect(() =>
      restoreDataRootBackup({
        backupRoot,
        dataRoot,
        stagingRoot: join(backupRoot, '.restore-staging'),
      })
    ).toThrow('Restore staging root must be outside the backup root.');
  });
});
