import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeColdDataRootBackupManifest } from './data-root-backup.js';
import { parseDataRootRestoreArgs, runDataRootRestoreCli } from './data-root-restore-cli.js';

const timestamp = '2026-07-06T00:00:00.000Z';

describe('data-root restore operator cli', () => {
  it('parses backup and target data-root arguments', () => {
    expect(
      parseDataRootRestoreArgs([
        '--',
        '--backup-root',
        '/tmp/openkit-backup',
        '--data-root',
        '/tmp/openkit-data',
        '--staging-root',
        '/tmp/openkit-restore-stage',
      ])
    ).toEqual({
      backupRoot: '/tmp/openkit-backup',
      dataRoot: '/tmp/openkit-data',
      stagingRoot: '/tmp/openkit-restore-stage',
    });
  });

  it('refuses to restore while a NanoCore lock file is present', () => {
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-restore-cli-backup-'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-restore-cli-target-'));

    mkdirSync(join(dataRoot, 'server', 'runtime'), { recursive: true });
    writeFileSync(join(dataRoot, 'server', 'runtime', 'nanocore.lock'), '{"bootId":"boot_1"}\n');

    expect(() =>
      runDataRootRestoreCli(['--backup-root', backupRoot, '--data-root', dataRoot])
    ).toThrow('Refusing to restore while NanoCore appears to be running');
  });

  it('restores one verified backup and prints a redacted summary', () => {
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-restore-cli-backup-'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-restore-cli-target-'));
    const stdout: string[] = [];

    mkdirSync(join(backupRoot, 'server'), { recursive: true });
    writeFileSync(join(backupRoot, 'server', 'layout.json'), '{"layoutVersion":1}\n');
    writeFileSync(join(dataRoot, 'stale.txt'), 'stale\n');
    writeColdDataRootBackupManifest({
      backupRoot,
      backupId: 'drbak_cli',
      sourceDeploymentId: 'dep_local',
      startedAt: timestamp,
      completedAt: timestamp,
    });

    const summary = runDataRootRestoreCli(
      ['--backup-root', backupRoot, '--data-root', dataRoot],
      (line) => stdout.push(line)
    );

    expect(summary).toEqual({
      backupId: 'drbak_cli',
      backupMode: 'cold',
      checkedFiles: ['server/layout.json'],
      consistency: 'clean',
      restored: true,
    });
    expect(stdout).toEqual([`${JSON.stringify(summary, null, 2)}\n`]);
    expect(existsSync(join(dataRoot, 'stale.txt'))).toBe(false);
    expect(readFileSync(join(dataRoot, 'server', 'layout.json'), 'utf8')).toBe(
      '{"layoutVersion":1}\n'
    );
    expect(JSON.stringify(summary)).not.toContain(dataRoot);
    expect(JSON.stringify(summary)).not.toContain(backupRoot);
  });
});
