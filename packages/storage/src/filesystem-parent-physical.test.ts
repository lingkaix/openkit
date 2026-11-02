// openkit-test-platform: posix
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareFilesystemParent } from './local.js';

const fault = vi.hoisted(() => ({
  mkdirPath: undefined as string | undefined,
  chmodPath: undefined as string | undefined,
  syncPath: undefined as string | undefined,
  error: undefined as Error | undefined,
  events: [] as string[],
  handles: [] as FileHandle[],
}));

// Only named filesystem effects fail; every opened handle and successful sync stays real.
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir(...args: Parameters<typeof actual.mkdir>) {
      if (String(args[0]) === fault.mkdirPath) return Promise.reject(fault.error);
      return actual.mkdir(...args);
    },
    chmod(...args: Parameters<typeof actual.chmod>) {
      if (String(args[0]) === fault.chmodPath) return Promise.reject(fault.error);
      return actual.chmod(...args);
    },
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      fault.handles.push(handle);
      const path = String(args[0]);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        fault.events.push(`start ${path}`);
        if (path === fault.syncPath) throw fault.error;
        await sync();
        fault.events.push(`done ${path}`);
      };
      return handle;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  fault.mkdirPath = undefined;
  fault.chmodPath = undefined;
  fault.syncPath = undefined;
  fault.error = undefined;
  fault.events.length = 0;
  for (const handle of fault.handles.splice(0)) await handle.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Own a private admitted parent without fabricating a synchronization review or apply plan. */
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'storage-filesystem-parent-'));
  roots.push(parent);
  return { parent, candidate: join(parent, 'candidate') };
}

/** Observe actual descriptor closure on success and on uncertain synchronization outcomes. */
async function expectClosed() {
  for (const handle of fault.handles) {
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  }
}

// Core Storage shares physical effects; Workspace Synchronization retains path and apply authority.
// EEXIST is an intentional no-op here. The caller's later type/link/confinement checks remain required.
describe('filesystem synchronization parent preparation', () => {
  it('creates mode 0755 despite umask, then completes child sync before parent sync', async () => {
    const { parent, candidate } = await fixture();
    const previousUmask = process.umask(0o077);
    try {
      await prepareFilesystemParent(candidate, parent);
      expect((await stat(candidate)).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(previousUmask);
    }

    expect(fault.events).toEqual([
      `start ${candidate}`,
      `done ${candidate}`,
      `start ${parent}`,
      `done ${parent}`,
    ]);
    expect(fault.handles).toHaveLength(2);
    await expectClosed();
  });

  it('leaves existing directory, file and symlink entries untouched without synchronization', async () => {
    const { parent, candidate } = await fixture();
    await mkdir(candidate);
    await chmod(candidate, 0o700);
    const file = join(parent, 'retained-file');
    const bytes = Buffer.from([0, 255, 128]);
    await writeFile(file, bytes);
    await chmod(file, 0o640);
    const link = join(parent, 'existing-link');
    await symlink(candidate, link, 'dir');
    const paths = [candidate, file, link];
    const before = await Promise.all(paths.map((path) => lstat(path)));

    for (const path of paths) await prepareFilesystemParent(path, parent);

    const after = await Promise.all(paths.map((path) => lstat(path)));
    for (let index = 0; index < paths.length; index++) {
      expect(after[index]!.dev).toBe(before[index]!.dev);
      expect(after[index]!.ino).toBe(before[index]!.ino);
      expect(after[index]!.mode).toBe(before[index]!.mode);
    }
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(file)).toEqual(bytes);
    expect(await readdir(candidate)).toEqual([]);
    expect(fault.events).toEqual([]);
    expect(fault.handles).toHaveLength(0);
  });

  it('propagates a non-EEXIST mkdir failure without later effects', async () => {
    const { parent, candidate } = await fixture();
    fault.mkdirPath = candidate;
    const failure = Object.assign(new Error('injected mkdir refusal'), { code: 'EACCES' });
    fault.error = failure;

    await expect(prepareFilesystemParent(candidate, parent)).rejects.toBe(failure);

    expect(await readdir(parent)).toEqual([]);
    expect(fault.events).toEqual([]);
    expect(fault.handles).toHaveLength(0);
  });

  it('keeps a created directory when chmod fails and performs no synchronization', async () => {
    const { parent, candidate } = await fixture();
    fault.chmodPath = candidate;
    fault.error = new Error('injected chmod refusal');

    await expect(prepareFilesystemParent(candidate, parent)).rejects.toBe(fault.error);

    expect((await stat(candidate)).isDirectory()).toBe(true);
    expect(await readdir(candidate)).toEqual([]);
    expect(fault.events).toEqual([]);
    expect(fault.handles).toHaveLength(0);
  });

  it('keeps the created directory after child-sync failure and does not sync the parent', async () => {
    const { parent, candidate } = await fixture();
    fault.syncPath = candidate;
    fault.error = new Error('injected child synchronization refusal');

    await expect(prepareFilesystemParent(candidate, parent)).rejects.toBe(fault.error);

    expect((await stat(candidate)).mode & 0o777).toBe(0o755);
    expect(fault.events).toEqual([`start ${candidate}`]);
    expect(fault.handles).toHaveLength(1);
    await expectClosed();
  });

  it('preserves the child after parent-sync failure without claiming rollback', async () => {
    const { parent, candidate } = await fixture();
    fault.syncPath = parent;
    fault.error = new Error('injected parent synchronization refusal');

    await expect(prepareFilesystemParent(candidate, parent)).rejects.toBe(fault.error);

    expect((await stat(candidate)).mode & 0o777).toBe(0o755);
    expect(fault.events).toEqual([`start ${candidate}`, `done ${candidate}`, `start ${parent}`]);
    expect(fault.handles).toHaveLength(2);
    await expectClosed();
  });
});
