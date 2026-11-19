import { spawnSync } from 'node:child_process';
import type * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { onTestFinished, type TestContext } from 'vitest';

type PublicationEvent =
  | { kind: 'sync' | 'remove'; path: string }
  | { kind: 'rename'; path: string; from: string };

export const publicationSyncFailure = new Error('Injected publication sync failure.');

/** Runs one fresh boot or stopped restore process with an optional persistent parent sync fault. */
export function runDataRootPublicationAttempt(input: {
  dataRoot: string;
  backupRoot?: string;
  faultParent?: string;
}) {
  const script = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const { dataRoot, backupRoot, faultParent } = JSON.parse(fs.readFileSync(0, 'utf8'));
const failure = Object.assign(new Error('Injected parent sync failure.'), { code: 'EIO' });
if (faultParent !== undefined) {
  const { openSync, closeSync, fsyncSync } = fs;
  const parents = new Set();
  fs.openSync = (path, ...args) => {
    const descriptor = openSync(path, ...args);
    if (path === faultParent) parents.add(descriptor);
    return descriptor;
  };
  fs.closeSync = (descriptor) => {
    parents.delete(descriptor);
    return closeSync(descriptor);
  };
  fs.fsyncSync = (descriptor) => {
    if (parents.has(descriptor)) throw failure;
    return fsyncSync(descriptor);
  };
  syncBuiltinESMExports();
}

try {
  if (backupRoot === undefined) {
    const { ensureConfigTemplateSurface, ensureLayout } = await import('./src/storage/fs-layout.ts');
    ensureConfigTemplateSurface(dataRoot);
    ensureLayout(dataRoot);
  } else {
    const { runDataRootRestoreCli } = await import('./src/storage/data-root-restore-cli.ts');
    await runDataRootRestoreCli(['--backup-root', backupRoot, '--data-root', dataRoot]);
  }
} catch (error) {
  if (error !== failure) throw error;
  console.error(failure.code);
  process.exitCode = 1;
}
`;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { TMPDIR: tmpdir(), TZ: 'UTC' },
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 10_000,
    }
  );
  if (result.error) throw result.error;
  return result;
}

/** Applies an owner-only default ACL through the Linux filesystem interface. */
export function setOwnerOnlyDefaultAcl(path: string, context: TestContext): void {
  if (process.platform !== 'linux')
    context.skip('Linux POSIX default ACL interface is unavailable.');
  const result = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      `
import errno, os, struct, sys

# POSIX ACL xattr version 2, with owner rwx and no group or other permissions.
entries = [(0x01, 7), (0x04, 0), (0x20, 0)]
acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', tag, mode, 0xffffffff) for tag, mode in entries)
try:
    os.setxattr(sys.argv[1], 'system.posix_acl_default', acl)
except OSError as error:
    if error.errno == errno.ENOTSUP:
        sys.exit(77)
    raise
`,
      path,
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }
  );
  if (result.error) throw result.error;
  if (result.status === 77) context.skip('Fixture filesystem does not support POSIX default ACLs.');
  if (result.status !== 0) throw new Error(`Cannot set fixture default ACL: ${result.stderr}`);
}

let observation:
  | { events: PublicationEvent[]; failSync: ((path: string) => boolean) | undefined }
  | undefined;

/** Records completed filesystem operations and optionally fails selected syncs. */
export function observeSyncPublication(failSync?: (path: string) => boolean): PublicationEvent[] {
  const events: PublicationEvent[] = [];
  observation = { events, failSync };
  onTestFinished(() => {
    observation = undefined;
  });
  return events;
}

/** Wraps the real synchronous filesystem at the descriptor and path boundaries. */
export function publicationFileSystem(actual: typeof fs): typeof fs {
  const descriptors = new Map<number, string>();
  return {
    ...actual,
    openSync(...args) {
      const descriptor = actual.openSync(...args);
      if (observation) descriptors.set(descriptor, String(args[0]));
      return descriptor;
    },
    fsyncSync(descriptor) {
      const path = descriptors.get(descriptor);
      if (path !== undefined && observation?.failSync?.(path)) throw publicationSyncFailure;
      actual.fsyncSync(descriptor);
      if (path !== undefined) observation?.events.push({ kind: 'sync', path });
    },
    closeSync(descriptor) {
      actual.closeSync(descriptor);
      descriptors.delete(descriptor);
    },
    renameSync(from, to) {
      actual.renameSync(from, to);
      observation?.events.push({ kind: 'rename', path: String(to), from: String(from) });
    },
    rmSync(path, options) {
      actual.rmSync(path, options);
      observation?.events.push({ kind: 'remove', path: String(path) });
    },
  };
}
