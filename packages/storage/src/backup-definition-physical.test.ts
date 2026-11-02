// openkit-test-platform: posix
import {
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyMissingBackupDefinitions } from './local.js';

const fault = vi.hoisted(() => ({
  target: undefined as string | undefined,
  error: undefined as Error | undefined,
}));

// Preserve native copying except one named failure with actual partial output.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    cpSync(...args: Parameters<typeof actual.cpSync>) {
      if (String(args[1]) === fault.target) {
        actual.writeFileSync(args[1], actual.readFileSync(args[0]).subarray(0, 3));
        throw fault.error;
      }
      return actual.cpSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fault.target = undefined;
  fault.error = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Own private physical trees without inventing app records, snapshots or digests. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'storage-backup-definitions-'));
  roots.push(root);
  return { dataRoot: join(root, 'live'), backupRoot: join(root, 'backup') };
}

const binary = Buffer.from([0, 255, 128, 13, 10, 0, 254]);
const app = 'workspaces/selected/light-apps/app';

// Core Storage shares physical primitives; S51 keeps hot-capture and definition digest checks in NanoCore.
// This characterizes only the original missing-definition copy and its uncleaned failure residue.
describe('missing backup definition physical copy', () => {
  it('copies exact binary and empty files only for the caller-selected app paths', () => {
    const { dataRoot, backupRoot } = fixture();
    const source = join(dataRoot, app, 'definitions');
    const omittedApp = 'workspaces/selected/light-apps/omitted';
    mkdirSync(source, { recursive: true });
    mkdirSync(join(dataRoot, omittedApp, 'definitions'), { recursive: true });
    writeFileSync(join(source, 'original.json'), binary);
    writeFileSync(join(source, 'empty.json'), Buffer.alloc(0));
    writeFileSync(join(dataRoot, omittedApp, 'definitions', 'omitted.json'), 'omit');

    copyMissingBackupDefinitions(dataRoot, backupRoot, [app]);

    const captured = join(backupRoot, app, 'definitions');
    expect(readdirSync(captured).sort()).toEqual(['empty.json', 'original.json']);
    expect(readFileSync(join(captured, 'original.json'))).toEqual(binary);
    expect(readFileSync(join(captured, 'empty.json'))).toEqual(Buffer.alloc(0));
    expect(existsSync(join(backupRoot, omittedApp))).toBe(false);
    expect(readFileSync(join(source, 'original.json'))).toEqual(binary);
  });

  it('keeps existing captured bytes and inode while adding a missing definition', () => {
    const { dataRoot, backupRoot } = fixture();
    const source = join(dataRoot, app, 'definitions');
    const captured = join(backupRoot, app, 'definitions');
    mkdirSync(source, { recursive: true });
    mkdirSync(captured, { recursive: true });
    writeFileSync(join(source, 'existing.json'), 'different current source');
    writeFileSync(join(source, 'missing.json'), binary);
    const retained = join(captured, 'existing.json');
    const previous = Buffer.from([4, 3, 2, 0]);
    writeFileSync(retained, previous);
    const before = statSync(retained);

    copyMissingBackupDefinitions(dataRoot, backupRoot, [app]);

    const after = statSync(retained);
    expect(readFileSync(retained)).toEqual(previous);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(join(captured, 'missing.json'))).toEqual(binary);
    expect(readFileSync(join(source, 'existing.json'), 'utf8')).toBe('different current source');
  });

  it('skips an absent source and creates the captured directory for an empty source', () => {
    const { dataRoot, backupRoot } = fixture();
    const missing = 'workspaces/selected/light-apps/missing';
    mkdirSync(join(dataRoot, app, 'definitions'), { recursive: true });

    copyMissingBackupDefinitions(dataRoot, backupRoot, [missing, app]);

    expect(existsSync(join(backupRoot, missing))).toBe(false);
    expect(statSync(join(backupRoot, app, 'definitions')).isDirectory()).toBe(true);
    expect(readdirSync(join(backupRoot, app, 'definitions'))).toEqual([]);
    expect(readdirSync(join(dataRoot, app, 'definitions'))).toEqual([]);
  });

  it('propagates copy failure without removing earlier or partial output or visiting later apps', () => {
    const { dataRoot, backupRoot } = fixture();
    const apps = ['first', 'failed', 'later'].map(
      (name) => `workspaces/selected/light-apps/${name}`
    );
    for (const path of apps) {
      mkdirSync(join(dataRoot, path, 'definitions'), { recursive: true });
      writeFileSync(join(dataRoot, path, 'definitions', 'original.json'), binary);
    }
    fault.target = join(backupRoot, apps[1]!, 'definitions', 'original.json');
    fault.error = new Error('injected partial definition copy');

    // One entry per app fixes the crossing without depending on readdir order.
    let failure: unknown;
    try {
      copyMissingBackupDefinitions(dataRoot, backupRoot, apps);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(fault.error);

    expect(readFileSync(join(backupRoot, apps[0]!, 'definitions', 'original.json'))).toEqual(
      binary
    );
    expect(readFileSync(fault.target)).toEqual(Buffer.from([0, 255, 128]));
    expect(existsSync(join(backupRoot, apps[2]!))).toBe(false);
    for (const path of apps) {
      expect(readFileSync(join(dataRoot, path, 'definitions', 'original.json'))).toEqual(binary);
    }
  });
});
