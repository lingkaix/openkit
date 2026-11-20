import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { inventoryRegularFiles, writeColdDataRootBackupManifest } from './data-root-backup.js';
import { parseDataRootRestoreArgs, runDataRootRestoreCli } from './data-root-restore-cli.js';
import { openCoreDb, serverStoragePath } from './db.js';
import { coreDbPath, readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations, type SplitStorageOwner } from './migrate.js';

const timestamp = '2026-07-06T00:00:00.000Z';

function restoreFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'openkit-restore-cli-'));
  const backupRoot = join(parent, 'backup');
  const dataRoot = join(parent, 'target');
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    rmSync(parent, { recursive: true, force: true });
  });
  const core = openCoreDb(backupRoot);
  try {
    applyMigrations(core);
  } finally {
    core.sqlite.close();
  }
  const sourceDeploymentId = readDataRootLayoutMarker(backupRoot).deploymentId;
  const seal = (backupId: string, deployment = sourceDeploymentId) =>
    writeColdDataRootBackupManifest({
      backupRoot,
      backupId,
      sourceDeploymentId: deployment,
      startedAt: timestamp,
      completedAt: timestamp,
    });
  return { backupRoot, dataRoot, seal };
}

async function provisionOwner(dataRoot: string, owner: SplitStorageOwner): Promise<string> {
  const client = getControlStoreWorkerClient();
  expect(await client.provisionServerOwner(dataRoot, { owner })).toEqual({ state: 'ready', owner });
  await client.closeServerOwner(dataRoot, owner);
  return serverStoragePath(dataRoot, owner);
}

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

  it('refuses to restore while a NanoCore lock file is present', async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-restore-cli-backup-'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-restore-cli-target-'));

    mkdirSync(join(dataRoot, 'server', 'runtime'), { recursive: true });
    writeFileSync(join(dataRoot, 'server', 'runtime', 'nanocore.lock'), '{"bootId":"boot_1"}\n');

    await expect(
      Promise.resolve().then(() =>
        runDataRootRestoreCli(['--backup-root', backupRoot, '--data-root', dataRoot])
      )
    ).rejects.toThrow('Refusing to restore while NanoCore appears to be running');
  });

  it('restores one verified backup and prints a redacted summary', async () => {
    const { backupRoot, dataRoot, seal } = restoreFixture();
    const stdout: string[] = [];

    mkdirSync(dataRoot);
    const originalMarker = readFileSync(join(backupRoot, 'server', 'layout.json'), 'utf8');
    writeFileSync(join(dataRoot, 'stale.txt'), 'stale\n');
    const backup = seal('drb_0190f4c8-0000-7000-8000-000000000001');

    const summary = await runDataRootRestoreCli(
      ['--backup-root', backupRoot, '--data-root', dataRoot],
      (line) => stdout.push(line)
    );

    expect(summary).toEqual({
      backupId: 'drb_0190f4c8-0000-7000-8000-000000000001',
      backupMode: 'cold',
      checkedFiles: backup.checkedFiles,
      consistency: 'clean',
      restored: true,
    });
    expect(stdout).toEqual([`${JSON.stringify(summary, null, 2)}\n`]);
    expect(existsSync(join(dataRoot, 'stale.txt'))).toBe(false);
    expect(readFileSync(join(dataRoot, 'server', 'layout.json'), 'utf8')).toBe(originalMarker);
    expect(summary.checkedFiles).toContain('server/db/core.sqlite');
    expect(JSON.stringify(summary)).not.toContain(dataRoot);
    expect(JSON.stringify(summary)).not.toContain(backupRoot);
  });

  it('restores into an absent child of a writable parent', async () => {
    const { backupRoot, dataRoot, seal } = restoreFixture();
    const stdout: string[] = [];

    await provisionOwner(backupRoot, 'nanohost');
    seal('drb_0190f4c8-0000-7000-8000-000000000002');

    expect(existsSync(dataRoot)).toBe(false);

    const summary = await runDataRootRestoreCli(
      ['--backup-root', backupRoot, '--data-root', dataRoot],
      (line) => stdout.push(line)
    );

    expect(summary.backupId).toBe('drb_0190f4c8-0000-7000-8000-000000000002');
    expect(summary.restored).toBe(true);
    expect(summary.checkedFiles).toContain('server/extensions/nanohost/state.sqlite');
    expect(existsSync(join(dataRoot, 'server', 'layout.json'))).toBe(true);
    expect(existsSync(`${dataRoot}.restore-staging`)).toBe(false);
    expect(stdout).toEqual([`${JSON.stringify(summary, null, 2)}\n`]);
  });

  it.each(['wrong hash in committed WAL', 'Server Work file at NanoHost path'] as const)(
    'refuses incompatible split owner bytes before placement (%s)',
    async (failure) => {
      const { backupRoot, dataRoot, seal } = restoreFixture();
      mkdirSync(dataRoot);
      writeFileSync(join(dataRoot, 'predecessor.txt'), 'retain the original deployment\n');
      const original = inventoryRegularFiles(dataRoot);
      const nanoHostPath = serverStoragePath(backupRoot, 'nanohost');
      let writer: Database.Database | undefined;
      try {
        if (failure === 'wrong hash in committed WAL') {
          await provisionOwner(backupRoot, 'nanohost');
          writer = new Database(nanoHostPath, { fileMustExist: true });
          writer.pragma('wal_autocheckpoint = 0');
          const originalBase = readFileSync(nanoHostPath);
          writer.prepare('UPDATE __drizzle_migrations SET hash = ?').run('predecessor');
          expect(readFileSync(nanoHostPath)).toEqual(originalBase);
          expect(readFileSync(`${nanoHostPath}-wal`).length).toBeGreaterThan(0);
        } else {
          const serverWorkPath = await provisionOwner(backupRoot, 'server-work');
          mkdirSync(dirname(nanoHostPath), { recursive: true });
          copyFileSync(serverWorkPath, nanoHostPath);
        }
        seal('drb_0190f4c8-0000-7000-8000-000000000003');
        const stdout: string[] = [];
        await expect(
          runDataRootRestoreCli(['--backup-root', backupRoot, '--data-root', dataRoot], (line) =>
            stdout.push(line)
          )
        ).rejects.toThrow('Server owner storage admission failed (unsupported)');
        expect(stdout).toEqual([]);
        expect(inventoryRegularFiles(dataRoot)).toEqual(original);
        expect(existsSync(`${dataRoot}.restore-previous`)).toBe(false);
      } finally {
        writer?.close();
      }
    }
  );

  it.each([
    { failure: 'missing Core', message: /missing its canonical Core database/ },
    { failure: 'orphaned NanoHost WAL', message: /sidecar without its database/ },
    { failure: 'deployment marker mismatch', message: /does not match the staged Data Root/ },
    {
      failure: 'split owner only on target',
      message: /missing the target's existing Server owner/,
    },
    {
      failure: 'unknown extension only on target',
      message:
        /target has an unsupported Server owner: server\/extensions\/later-adapter\/state\.sqlite/,
    },
  ] as const)('refuses a partial or inconsistent root ($failure)', async ({ failure, message }) => {
    const { backupRoot, dataRoot, seal } = restoreFixture();
    mkdirSync(dataRoot);
    writeFileSync(join(dataRoot, 'predecessor.txt'), 'retain the original deployment\n');
    let deployment: string | undefined;
    if (failure === 'missing Core') unlinkSync(coreDbPath(backupRoot));
    if (failure === 'orphaned NanoHost WAL') {
      const path = serverStoragePath(backupRoot, 'nanohost');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}-wal`, 'retained WAL without its base');
    }
    if (failure === 'deployment marker mismatch')
      deployment = 'dep_00000000-0000-7562-9a88-afe7e367ea27';
    if (failure === 'split owner only on target') await provisionOwner(dataRoot, 'nanohost');
    if (failure === 'unknown extension only on target') {
      const known = await provisionOwner(dataRoot, 'nanohost');
      const unknown = join(dataRoot, 'server', 'extensions', 'later-adapter', 'state.sqlite');
      mkdirSync(dirname(unknown), { recursive: true });
      copyFileSync(known, unknown);
      unlinkSync(known);
      copyFileSync(
        join(backupRoot, 'server', 'layout.json'),
        join(dataRoot, 'server', 'layout.json')
      );
    }
    const original = inventoryRegularFiles(dataRoot);
    seal('drb_0190f4c8-0000-7000-8000-000000000004', deployment);
    const stdout: string[] = [];
    await expect(
      runDataRootRestoreCli(['--backup-root', backupRoot, '--data-root', dataRoot], (line) =>
        stdout.push(line)
      )
    ).rejects.toThrow(message);
    expect(stdout).toEqual([]);
    expect(inventoryRegularFiles(dataRoot)).toEqual(original);
    expect(existsSync(`${dataRoot}.restore-previous`)).toBe(false);
  });
});
