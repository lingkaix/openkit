import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  DATA_ROOT_BACKUP_MANIFEST_FILE,
  restoreDataRootBackup,
  verifyDataRootBackupManifest,
  writeColdDataRootBackupManifest,
  writeHotDataRootBackup,
} from './data-root-backup.js';

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

  it('copies a hot backup and snapshots SQLite files through SQLite backup', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-hot-source-'));
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-hot-backup-'));
    mkdirSync(join(dataRoot, 'server', 'db'), { recursive: true });
    mkdirSync(join(dataRoot, 'users', 'user_local'), { recursive: true });
    writeFileSync(join(dataRoot, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeFileSync(join(dataRoot, 'users', 'user_local', 'profile.json'), '{"id":"user_local"}\n');

    const sourceDb = new Database(join(dataRoot, 'server', 'db', 'core.sqlite'));
    sourceDb.pragma('user_version = 7');

    const verified = await writeHotDataRootBackup({
      dataRoot,
      backupRoot,
      backupId: 'drbak_hot',
      sourceDeploymentId: 'dep_local',
      startedAt: timestamp,
      completedAt: '2026-07-06T00:00:01.000Z',
    });

    sourceDb.pragma('user_version = 8');
    sourceDb.close();

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
    expect(verifyDataRootBackupManifest({ backupRoot }).manifest.consistency).toBe(
      'crash-consistent'
    );
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
