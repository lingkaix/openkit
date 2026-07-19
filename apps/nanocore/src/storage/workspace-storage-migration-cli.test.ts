import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runWorkspaceStorageMigrationCli } from './workspace-storage-migration-cli.js';

describe('workspace storage migration CLI', () => {
  it('refuses to migrate while the NanoCore process lock exists', () => {
    const parent = mkdtempSync(join(tmpdir(), 'openkit-workspace-storage-migration-cli-'));
    const dataRoot = join(parent, 'data');
    const backupRoot = join(parent, 'backup');
    const lockPath = join(dataRoot, 'server', 'runtime', 'nanocore.lock');

    mkdirSync(join(dataRoot, 'server', 'runtime'), { recursive: true });
    writeFileSync(lockPath, 'locked\n');

    expect(() =>
      runWorkspaceStorageMigrationCli(
        ['--data-root', dataRoot, '--backup-root', backupRoot],
        () => undefined
      )
    ).toThrow(/Refusing to migrate while NanoCore appears to be running/);
    expect(existsSync(backupRoot)).toBe(false);
  });
});
