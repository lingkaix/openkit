import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  verifyOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import {
  createLightApp,
  createRecord,
  getRecord,
  listLightAppSnapshots,
  rollbackLightAppSnapshot,
  updateLightAppSchema,
} from '../generative-kernel/commands.js';
import { FsStore } from '../lib/store.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  bindThreadMaterial,
  createWorkspaceMaterial,
  saveWorkspaceMaterialRevision,
} from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  assertExternalColdBackupDestination,
  copyColdDataRoot,
  DATA_ROOT_BACKUP_MANIFEST_FILE,
  inventoryRegularFiles,
  restoreDataRootBackup,
  verifyDataRootBackupManifest,
  writeColdDataRootBackupManifest,
  writeHotDataRootBackup,
} from './data-root-backup.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

const timestamp = '2026-07-06T00:00:00.000Z';

describe('data-root backup manifest', () => {
  describe.each(['cold', 'hot'] as const)('%s writer identifier admission', (mode) => {
    it.each([
      { field: 'backupId', value: 'backup_invalid', name: 'malformed backup' },
      {
        field: 'backupId',
        value: testEntityId('ws', 'backup_wrong_kind'),
        name: 'wrong-kind backup',
      },
      { field: 'sourceDeploymentId', value: 'deployment_invalid', name: 'malformed deployment' },
      {
        field: 'sourceDeploymentId',
        value: testEntityId('drb', 'deployment_wrong_kind'),
        name: 'wrong-kind deployment',
      },
    ] as const)('refuses $name before replacing any backup bytes', async ({ field, value }) => {
      const parent = mkdtempSync(join(tmpdir(), 'openkit-backup-id-admission-'));
      const dataRoot = join(parent, 'source');
      const backupRoot = join(parent, 'backup');
      mkdirSync(dataRoot);
      mkdirSync(backupRoot);
      writeFileSync(join(dataRoot, 'source.txt'), 'unchanged source bytes\n');
      writeFileSync(join(backupRoot, DATA_ROOT_BACKUP_MANIFEST_FILE), 'unchanged prior manifest\n');
      writeFileSync(join(backupRoot, 'prior.txt'), 'unchanged backup bytes\n');
      const sourceBefore = inventoryRegularFiles(dataRoot);
      const backupBefore = inventoryRegularFiles(backupRoot);
      const input = {
        backupId: testEntityId('drb', 'admitted_backup'),
        sourceDeploymentId: testEntityId('dep', 'admitted_deployment'),
        backupRoot,
        dataRoot,
        startedAt: timestamp,
        completedAt: timestamp,
        [field]: value,
      };
      try {
        const refusal = expect.objectContaining({
          name: 'ZodError',
          issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_format' })]),
        });
        if (mode === 'hot')
          await expect(writeHotDataRootBackup(input)).rejects.toThrowError(refusal);
        else expect(() => writeColdDataRootBackupManifest(input)).toThrowError(refusal);
        expect(inventoryRegularFiles(dataRoot)).toEqual(sourceBefore);
        expect(inventoryRegularFiles(backupRoot)).toEqual(backupBefore);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  });

  it('captures one file and multi-database state before queued writes can run', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-backup-write-pause-'));
    const dataRoot = join(parent, 'data');
    const backupRoot = join(parent, 'backup');
    mkdirSync(dataRoot);
    const file = join(dataRoot, 'record.txt');
    const databases = ['first.sqlite', 'second.sqlite'].map((name) => {
      const sqlite = new Database(join(dataRoot, name));
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('wal_autocheckpoint = 0');
      sqlite.exec('CREATE TABLE state (version INTEGER); INSERT INTO state VALUES (1)');
      return sqlite;
    });
    try {
      writeFileSync(file, '1');
      for (const path of [
        'server/indexes/retrieval',
        'users/example/indexes/retrieval',
        'workspaces/example/indexes/retrieval',
        'workspaces/.staging',
      ]) {
        mkdirSync(join(dataRoot, path), { recursive: true });
        writeFileSync(join(dataRoot, path, 'temporary'), 'not retained authority');
      }
      const pending = writeHotDataRootBackup({
        dataRoot,
        backupRoot,
        backupId: testEntityId('drb', 'write_pause'),
        sourceDeploymentId: testEntityId('dep', 'write_pause'),
        startedAt: timestamp,
        completedAt: timestamp,
      });
      queueMicrotask(() => {
        writeFileSync(file, '2');
        for (const sqlite of databases) sqlite.exec('UPDATE state SET version = 2');
      });
      const verified = await pending;
      expect(verified.manifest.consistency).toBe('clean');
      expect(verified.checkedFiles).not.toContain('server/indexes/retrieval/temporary');
      expect(verified.checkedFiles).not.toContain('users/example/indexes/retrieval/temporary');
      expect(verified.checkedFiles).not.toContain('workspaces/example/indexes/retrieval/temporary');
      expect(verified.checkedFiles).not.toContain('workspaces/.staging/temporary');
      expect(readFileSync(file, 'utf8')).toBe('2');
      expect(readFileSync(join(backupRoot, 'record.txt'), 'utf8')).toBe('1');
      for (const name of ['first.sqlite', 'second.sqlite']) {
        const captured = new Database(join(backupRoot, name), { readonly: true });
        try {
          expect(captured.pragma('integrity_check', { simple: true })).toBe('ok');
          expect(captured.prepare('SELECT version FROM state').pluck().get()).toBe(1);
        } finally {
          captured.close();
        }
      }
    } finally {
      for (const sqlite of databases) sqlite.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('copies a cold backup without a maintenance-owned live lock', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-data-root-cold-copy-'));
    const dataRoot = join(parent, 'data');
    const backupRoot = join(parent, 'external', 'backup');
    const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');

    mkdirSync(join(dataRoot, 'server', 'runtime'), { recursive: true });
    writeFileSync(join(dataRoot, 'preserved.txt'), 'preserved\n');
    writeFileSync(lockPath, 'maintenance lock\n');

    assertExternalColdBackupDestination(dataRoot, backupRoot);
    copyColdDataRoot({ backupRoot, dataRoot, omitActiveDataRootLock: true });

    expect(readFileSync(join(backupRoot, 'preserved.txt'), 'utf8')).toBe('preserved\n');
    expect(existsSync(join(backupRoot, 'server', 'runtime', 'nanocore.lock'))).toBe(false);
  });

  it('retains owner-only vault directory mode through hot backup and restore under umask 022', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-data-root-vault-mode-'));
    const previousUmask = process.umask(0o022);

    try {
      const dataRoot = join(parent, 'data');
      const backupRoot = join(parent, 'backup');
      const restoredRoot = join(parent, 'restored', 'data');
      const vaultDir = join(dataRoot, 'server', 'vault');
      const vaultFile = join(vaultDir, 'secret.bin');
      onTestFinished(() => {
        // Restore only fixture permissions after the backup and restore mode assertions.
        for (const root of [dataRoot, backupRoot, restoredRoot]) {
          const path = join(root, 'server', 'readonly');
          if (existsSync(path)) chmodSync(path, 0o755);
        }
        rmSync(parent, { recursive: true, force: true });
      });

      mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
      chmodSync(vaultDir, 0o700);
      chmodSync(join(dataRoot, 'server'), 0o755);
      writeFileSync(join(dataRoot, 'server', 'layout.json'), '{"layoutVersion":1}\n');
      writeFileSync(vaultFile, 'secret\n', { mode: 0o600 });
      chmodSync(vaultFile, 0o600);
      const readonlyDir = join(dataRoot, 'server', 'readonly');
      mkdirSync(readonlyDir, { recursive: true });
      writeFileSync(join(readonlyDir, 'note.txt'), 'note\n');
      chmodSync(readonlyDir, 0o555);
      const stickyDir = join(dataRoot, 'server', 'sticky');
      mkdirSync(stickyDir, { recursive: true });
      chmodSync(stickyDir, 0o1777);
      const stickySupported = (statSync(stickyDir).mode & 0o7777) === 0o1777;

      expect(statSync(vaultDir).mode & 0o777).toBe(0o700);
      expect(statSync(vaultFile).mode & 0o777).toBe(0o600);

      await writeHotDataRootBackup({
        dataRoot,
        backupRoot,
        backupId: testEntityId('drb', 'drbak_vault_mode'),
        sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
        startedAt: timestamp,
        completedAt: timestamp,
      });

      expect(statSync(join(backupRoot, 'server', 'vault')).mode & 0o777).toBe(0o700);
      expect(statSync(join(backupRoot, 'server', 'vault', 'secret.bin')).mode & 0o777).toBe(0o600);
      expect(statSync(join(backupRoot, 'server')).mode & 0o777).toBe(0o755);
      expect(statSync(join(backupRoot, 'server', 'readonly')).mode & 0o777).toBe(0o555);
      if (stickySupported) {
        expect(statSync(join(backupRoot, 'server', 'sticky')).mode & 0o7777).toBe(0o1777);
      }

      restoreDataRootBackup({ backupRoot, dataRoot: restoredRoot });

      expect(statSync(join(restoredRoot, 'server', 'vault')).mode & 0o777).toBe(0o700);
      expect(statSync(join(restoredRoot, 'server', 'vault', 'secret.bin')).mode & 0o777).toBe(
        0o600
      );
      expect(statSync(join(restoredRoot, 'server')).mode & 0o777).toBe(0o755);
      expect(statSync(join(restoredRoot, 'server', 'readonly')).mode & 0o777).toBe(0o555);
      if (stickySupported) {
        expect(statSync(join(restoredRoot, 'server', 'sticky')).mode & 0o7777).toBe(0o1777);
      }
    } finally {
      process.umask(previousUmask);
      // Restore only fixture permissions after proving backup and restore preserved them.
      for (const root of ['data', 'backup', 'restored/data']) {
        const directory = join(parent, root, 'server', 'readonly');
        if (existsSync(directory)) chmodSync(directory, 0o755);
      }
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('writes and verifies a cold backup manifest over a copied data root', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-data-root-backup-'));
    mkdirSync(join(root, 'server'), { recursive: true });
    mkdirSync(join(root, 'users', 'usr_00000000-0000-7000-8000-000000000001'), { recursive: true });
    writeFileSync(join(root, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeFileSync(
      join(root, 'users', 'usr_00000000-0000-7000-8000-000000000001', 'profile.json'),
      '{"id":"usr_00000000-0000-7000-8000-000000000001"}\n'
    );

    const verified = writeColdDataRootBackupManifest({
      backupRoot: root,
      backupId: testEntityId('drb', 'drbak_demo'),
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      startedAt: timestamp,
      completedAt: timestamp,
    });

    expect(existsSync(join(root, DATA_ROOT_BACKUP_MANIFEST_FILE))).toBe(true);
    expect(verified.manifest.consistency).toBe('clean');
    expect(verified.checkedFiles).toEqual([
      'server/layout.json',
      'users/usr_00000000-0000-7000-8000-000000000001/profile.json',
    ]);
  });

  it('rejects tampered backup files and extra files', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-data-root-backup-'));
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeColdDataRootBackupManifest({
      backupRoot: root,
      backupId: testEntityId('drb', 'drbak_demo'),
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
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
      backupId: testEntityId('drb', 'drbak_demo'),
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
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
      backupId: testEntityId('drb', 'drbak_demo'),
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
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
    mkdirSync(join(dataRoot, 'users', 'usr_00000000-0000-7000-8000-000000000001'), {
      recursive: true,
    });
    writeFileSync(
      join(dataRoot, 'server', 'layout.json'),
      `${JSON.stringify({ schemaVersion: 1, layoutVersion: 2, deploymentId: testEntityId('dep', 'deployment_backup_test') })}\n`
    );
    writeFileSync(
      join(dataRoot, 'users', 'usr_00000000-0000-7000-8000-000000000001', 'profile.json'),
      '{"id":"usr_00000000-0000-7000-8000-000000000001"}\n'
    );

    const workspaceId = 'ws_00000000-0000-743a-9259-d9081224a961';
    const sourceDb = openCoreDb(dataRoot);
    applyMigrations(sourceDb);
    sourceDb.sqlite.pragma('user_version = 7');
    const createdAt = new Date(timestamp).getTime();
    sourceDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
        ) VALUES
          ('usr_00000000-0000-780b-b93c-e2479beb99f1', 'Backup Owner', 'backup-owner@example.com', false, ?, ?, 'human', 'active', NULL),
          ('usr_00000000-0000-76cb-b20d-44f52b4392e7', 'Backup Editor', 'backup-editor@example.com', false, ?, ?, 'human', 'active', NULL),
          ('usr_00000000-0000-7165-91a2-29989585336e', 'Backup Removed', 'backup-removed@example.com', false, ?, ?, 'human', 'active', NULL),
          ('usr_00000000-0000-76b4-848a-9317f97cc918', 'Backup Invitee', 'backup-invitee@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(createdAt, createdAt, createdAt, createdAt, createdAt, createdAt, createdAt, createdAt);
    recordWorkspaceOwnerMembership({
      coreDb: sourceDb,
      ownerUserId: 'usr_00000000-0000-780b-b93c-e2479beb99f1',
      workspaceId,
      now: new Date(timestamp),
    });
    sourceDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES
          (?, 'usr_00000000-0000-76cb-b20d-44f52b4392e7', 'active', NULL, ?, NULL, 2, ?, ?),
          (?, 'usr_00000000-0000-7165-91a2-29989585336e', 'removed', NULL, ?, ?, 3, ?, ?)`
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
          invitation_id, workspace_id, invitee_user_id, inviter_user_id,
          status, expires_at, accepted_at, declined_at, revoked_at, revision, created_at, updated_at
        ) VALUES (
          'inv_00000000-0000-7848-9a05-d8546fadfe1d', ?, 'usr_00000000-0000-76b4-848a-9317f97cc918', 'usr_00000000-0000-780b-b93c-e2479beb99f1',
          'pending', '2026-07-13T00:00:00.000Z', NULL, NULL, NULL, 4, ?, ?
        )`
      )
      .run(workspaceId, timestamp, timestamp);
    const issuedToken = createOpenKitAccessTokenRecord(sourceDb, {
      expiresAt: '2026-08-06T00:00:00.000Z',
      now: new Date(timestamp),
      ownerUserId: 'usr_00000000-0000-76cb-b20d-44f52b4392e7',
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
      invitation: sourceDb.sqlite
        .prepare(authoritySql.invitation)
        .get('inv_00000000-0000-7848-9a05-d8546fadfe1d'),
      memberships: sourceDb.sqlite.prepare(authoritySql.memberships).all(workspaceId),
      registry: sourceDb.sqlite.prepare(authoritySql.registry).get(workspaceId),
      tokenMetadata: sourceDb.sqlite.prepare(authoritySql.tokenMetadata).get(issuedToken.tokenId),
      users: sourceDb.sqlite.prepare(authoritySql.users).all(),
    };
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(workspaceDb);
    const material = createWorkspaceMaterial(workspaceDb, {
      acceptedAt: timestamp,
      actor: { kind: 'user', id: LOCAL_USER_ID },
      kind: 'markdown',
      requestId: 'backup-material-create',
      sensitivity: 'internal',
      title: 'Backup material',
    });
    const content = '# Backup material';
    saveWorkspaceMaterialRevision(workspaceDb, {
      acceptedAt: timestamp,
      actor: { kind: 'user', id: LOCAL_USER_ID },
      content,
      contentDigest: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
      expectedRevisionId: null,
      materialId: material.materialId,
      requestId: 'backup-material-save',
    });
    bindThreadMaterial(workspaceDb, {
      acceptedAt: timestamp,
      expectedBindingState: 'not_bound',
      materialId: material.materialId,
      requestId: 'backup-material-bind',
      threadId: 'th_00000000-0000-71a4-b9b8-03317f9c1744',
    });

    const verified = await writeHotDataRootBackup({
      dataRoot,
      backupRoot,
      backupId: testEntityId('drb', 'drbak_hot'),
      sourceDeploymentId: testEntityId('dep', 'deployment_backup_test'),
      startedAt: timestamp,
      completedAt: '2026-07-06T00:00:01.000Z',
    });

    sourceDb.sqlite.pragma('user_version = 8');
    sourceDb.sqlite.close();
    workspaceDb.sqlite.close();

    expect(verified.manifest.backupMode).toBe('hot');
    expect(verified.manifest.consistency).toBe('clean');
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
    expect(verifyDataRootBackupManifest({ backupRoot }).manifest.consistency).toBe('clean');

    restoreDataRootBackup({ backupRoot, dataRoot: restoredDataRoot });
    const restoredDb = new Database(join(restoredDataRoot, 'server', 'db', 'core.sqlite'), {
      readonly: true,
    });
    try {
      expect({
        invitation: restoredDb
          .prepare(authoritySql.invitation)
          .get('inv_00000000-0000-7848-9a05-d8546fadfe1d'),
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
        ownerUserId: 'usr_00000000-0000-76cb-b20d-44f52b4392e7',
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
      backupId: testEntityId('drb', 'drbak_restore'),
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      startedAt: timestamp,
      completedAt: timestamp,
    });

    const restored = restoreDataRootBackup({ backupRoot, dataRoot });

    expect(restored.manifest.id).toBe(testEntityId('drb', 'drbak_restore'));
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
      backupId: testEntityId('drb', 'drbak_restore'),
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
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
      backupId: testEntityId('drb', 'drbak_restore'),
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
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

  it('preserves immutable Light App snapshots through hot backup and restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-hot-snapshot-'));
    const dataRoot = join(root, 'source');
    const backupRoot = join(root, 'backup');
    const restoredRoot = join(root, 'restored');
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(dataRoot, 'server'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'server', 'layout.json'),
      `${JSON.stringify({ schemaVersion: 1, layoutVersion: 2, deploymentId: testEntityId('dep', 'snapshot_backup') })}\n`
    );
    const store = createDemoStore({ dataRoot });
    const context = {
      dataRoot,
      store,
      inflightCommands: new WeakMap(),
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      actor: { kind: 'user' as const, id: LOCAL_USER_ID },
      requestId: randomUUID(),
    };
    const schema: LightAppSchemaInput = {
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: 'Snapshot notes',
      purpose: 'Local notes.',
      collections: [
        {
          name: 'notes',
          type: 'base',
          description: 'Notes.',
          fields: [
            { name: 'key', type: 'text', required: false, description: 'Retained key.' },
            { name: 'note', type: 'text', required: false, description: 'Retained note.' },
          ],
          indexes: [],
        },
      ],
    };
    const app = await createLightApp(context, schema);
    const record = await createRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'notes',
      app.schemaRevision,
      { note: 'Before migration' }
    );
    const { appId: _appId, schemaRevision: _schemaRevision, ...next } = app.schema!;
    next.collections[0]!.fields = next.collections[0]!.fields.filter(
      (field) => field.name !== 'note'
    );
    const changed = await updateLightAppSchema(
      { ...context, requestId: randomUUID() },
      app.appId,
      app.appRevision,
      app.schemaRevision,
      next
    );
    const snapshot = listLightAppSnapshots(dataRoot, context.workspaceId, app.appId).snapshots[0]!;
    await writeHotDataRootBackup({
      dataRoot,
      backupRoot,
      backupId: testEntityId('drb', 'snapshot_backup'),
      sourceDeploymentId: testEntityId('dep', 'snapshot_backup'),
      startedAt: timestamp,
      completedAt: timestamp,
    });
    restoreDataRootBackup({ backupRoot, dataRoot: restoredRoot });
    const restoredContext = {
      ...context,
      dataRoot: restoredRoot,
      store: new FsStore({ dataRoot: restoredRoot }),
      requestId: randomUUID(),
    };
    const restored = await rollbackLightAppSnapshot(
      restoredContext,
      app.appId,
      changed.appRevision,
      snapshot.snapshotId
    );
    expect(
      getRecord(
        restoredRoot,
        context.workspaceId,
        app.appId,
        'notes',
        record.id,
        restored.schemaRevision
      ).data.note
    ).toBe('Before migration');
  });

  it('verifies captured Light App definition bytes against the app database', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-light-app-source-'));
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-light-app-backup-'));
    mkdirSync(join(dataRoot, 'server', 'db'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'server', 'layout.json'),
      `${JSON.stringify({ schemaVersion: 1, layoutVersion: 2, deploymentId: testEntityId('dep', 'deployment_backup_test') })}\n`
    );
    const store = createDemoStore({ dataRoot });
    const schema: LightAppSchemaInput = {
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: 'Membership CRM map',
      purpose: 'Local membership-to-CRM mappings.',
      collections: [
        {
          name: 'mappings',
          type: 'base',
          description: 'Mappings.',
          fields: [
            {
              name: 'membership_id',
              type: 'text',
              required: true,
              description: 'Membership id.',
            },
            {
              name: 'active',
              type: 'bool',
              required: true,
              description: 'Whether the mapping is active.',
            },
          ],
          indexes: [],
        },
      ],
    };
    await createLightApp(
      {
        store,
        inflightCommands: new WeakMap(),
        dataRoot,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        requestId: randomUUID(),
      },
      schema
    );
    const verified = await writeHotDataRootBackup({
      dataRoot,
      backupRoot,
      backupId: testEntityId('drb', 'drbak_light_app'),
      sourceDeploymentId: testEntityId('dep', 'deployment_backup_test'),
      startedAt: timestamp,
      completedAt: '2026-09-09T00:00:01.000Z',
    });
    expect(
      verified.checkedFiles.some(
        (path) => path.includes('/light-apps/') && path.endsWith('/data.sqlite')
      )
    ).toBe(true);
    expect(
      verified.checkedFiles.some(
        (path) => path.includes('/light-apps/') && path.includes('/definitions/')
      )
    ).toBe(true);
    const appDirs = readdirSync(
      join(backupRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001', 'light-apps')
    );
    rmSync(
      join(
        backupRoot,
        'workspaces',
        'ws_00000000-0000-7000-8000-000000000001',
        'light-apps',
        appDirs[0]!,
        'definitions'
      ),
      {
        recursive: true,
        force: true,
      }
    );
    expect(() => verifyDataRootBackupManifest({ backupRoot })).toThrow(/definition/i);
  });
});
