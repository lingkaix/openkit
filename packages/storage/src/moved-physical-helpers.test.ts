// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assertCanonicalDirectory,
  assertCanonicalRegularFile,
  CanonicalPublicationError,
  createPrivateTree,
  createPrivateTreeSync,
  directoryContainsFiles,
  ensureCanonicalDirectory,
  ensureTreeDirectory,
  makePrivateTreeDirectory,
  materializeSnapshot,
  measureCanonicalFile,
  measureCanonicalFileDescriptor,
  movePrivateTree,
  publishCanonicalPath,
  publishCanonicalPathAsync,
  readCanonicalFile,
  readCanonicalTextFile,
  removePrivateTree,
  removePrivateTreeSync,
  syncCanonicalTree,
  syncCanonicalTreeAsync,
  writePrivateTreeFile,
  writePrivateTreeMetadata,
} from './local.js';

const fault = vi.hoisted(() => ({
  directory: undefined as string | undefined,
  error: undefined as Error | undefined,
}));

// The selected parent acknowledgement fails; all other real syscalls still complete.
vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync(descriptor: number) {
      if (fault.directory && actual.readlinkSync(`/proc/self/fd/${descriptor}`) === fault.directory)
        throw fault.error;
      return actual.fsyncSync(descriptor);
    },
  };
});
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  const { readlinkSync } = await import('node:fs');
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (fault.directory && readlinkSync(`/proc/self/fd/${handle.fd}`) === fault.directory)
          throw fault.error;
        await sync();
      };
      return handle;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  fault.directory = undefined;
  fault.error = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every fixture owns a new private subtree; no server or retained product record is fabricated. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'storage-moved-helpers-'));
  roots.push(root);
  return root;
}

const original = Buffer.from([0, 255, 1, 128, 13, 10, 2]);
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

it('reads and measures exact canonical bytes without consuming or closing a borrowed descriptor', () => {
  const root = fixture();
  const directory = join(root, 'nested', 'bytes');
  ensureCanonicalDirectory(directory);
  ensureCanonicalDirectory(directory);
  const path = join(directory, 'original');
  writeFileSync(path, original);
  expect(readCanonicalFile(path)).toEqual(original);
  expect(measureCanonicalFile(path)).toEqual({
    byteLength: original.length,
    contentDigest: digest(original),
  });
  assertCanonicalRegularFile(path);
  assertCanonicalDirectory(directory);
  const descriptor = openSync(path, 'r');
  try {
    const first = Buffer.alloc(2);
    readSync(descriptor, first);
    expect(first).toEqual(original.subarray(0, 2));
    expect(measureCanonicalFileDescriptor(descriptor)).toEqual({
      byteLength: original.length,
      contentDigest: digest(original),
    });
    const rest = Buffer.alloc(original.length - 2);
    readSync(descriptor, rest);
    expect(rest).toEqual(original.subarray(2));
  } finally {
    closeSync(descriptor);
  }
  const text = join(directory, 'text');
  writeFileSync(text, 'Canonical UTF-8 café\n');
  expect(readCanonicalTextFile(text)).toBe('Canonical UTF-8 café\n');
});

it('refuses canonical link and wrong-kind inputs without changing their targets', async () => {
  const root = fixture();
  const target = join(root, 'target');
  const link = join(root, 'link');
  writeFileSync(target, original);
  symlinkSync(target, link);
  expect(() => readCanonicalFile(link)).toThrow();
  expect(() => readCanonicalTextFile(link)).toThrow();
  expect(() => measureCanonicalFile(link)).toThrow();
  expect(() => assertCanonicalRegularFile(root)).toThrow();
  expect(() => assertCanonicalDirectory(target)).toThrow();
  expect(() => ensureCanonicalDirectory(link)).toThrow();
  await expect(ensureTreeDirectory(link)).rejects.toThrow();
  expect(() => syncCanonicalTree(link)).toThrow();
  await expect(syncCanonicalTreeAsync(link)).rejects.toThrow();
  expect(readFileSync(target)).toEqual(original);
});

it.each(['sync', 'async'] as const)('publishes a complete %s tree across parents', async (mode) => {
  const root = fixture();
  const source = join(root, 'source');
  const receiving = join(root, 'receiving');
  mkdirSync(source);
  mkdirSync(receiving);
  const staged = join(source, 'staged');
  mkdirSync(join(staged, 'nested'), { recursive: true });
  writeFileSync(join(staged, 'nested', 'file'), original);
  const destination = join(receiving, 'accepted');
  if (mode === 'sync') publishCanonicalPath(staged, destination);
  else await publishCanonicalPathAsync(staged, destination);
  expect(existsSync(staged)).toBe(false);
  expect(readFileSync(join(destination, 'nested', 'file'))).toEqual(original);
});

it.each([
  'sync',
  'async',
] as const)('retains a renamed %s tree when parent acknowledgement fails', async (mode) => {
  const root = fixture();
  const staged = join(root, 'staged');
  const receiving = join(root, 'receiving');
  mkdirSync(staged);
  mkdirSync(receiving);
  writeFileSync(join(staged, 'file'), original);
  const destination = join(receiving, 'accepted');
  const refused = new Error('Selected parent acknowledgement failed.');
  fault.directory = receiving;
  fault.error = refused;
  if (mode === 'sync') {
    try {
      publishCanonicalPath(staged, destination);
      expect.unreachable('Publication must not acknowledge failed parent synchronization.');
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalPublicationError);
      expect(error).toMatchObject({ cause: refused, code: 'recovery_required' });
    }
  } else {
    await expect(publishCanonicalPathAsync(staged, destination)).rejects.toBe(refused);
  }
  expect(existsSync(staged)).toBe(false);
  expect(readFileSync(join(destination, 'file'))).toEqual(original);
});

it('materializes exact catalog entries once and ignores incomplete trees during file discovery', () => {
  const root = fixture();
  const target = join(root, 'accepted');
  expect(directoryContainsFiles(target)).toBe(false);
  materializeSnapshot(target, [
    { kind: 0, path: 'empty' },
    { kind: 1, path: 'nested/bytes', content: original },
    { kind: 2, path: 'run', content: Buffer.from('#!/bin/sh\nexit 0\n') },
  ]);
  expect(readFileSync(join(target, 'nested', 'bytes'))).toEqual(original);
  expect(statSync(join(target, 'run')).mode & 0o777).toBe(0o755);
  materializeSnapshot(target, [
    { kind: 1, path: 'nested/bytes', content: Buffer.from('different') },
  ]);
  expect(readFileSync(join(target, 'nested', 'bytes'))).toEqual(original);
  expect(existsSync(`${target}.staging`)).toBe(false);
  const unfinished = join(root, 'unfinished');
  mkdirSync(join(unfinished, 'partial.staging'), { recursive: true });
  writeFileSync(join(unfinished, 'partial.staging', 'bytes'), original);
  mkdirSync(join(unfinished, 'empty'));
  expect(directoryContainsFiles(unfinished)).toBe(false);
  writeFileSync(join(unfinished, 'empty', 'accepted'), original);
  expect(directoryContainsFiles(unfinished)).toBe(true);
  expect(directoryContainsFiles(target)).toBe(true);
});

it('keeps a visible snapshot inspectable after failed acknowledgement without reconstructing it', () => {
  const root = fixture();
  const parent = join(root, 'catalog');
  mkdirSync(parent);
  const target = join(parent, 'accepted');
  const entries = [{ kind: 1 as const, path: 'bytes', content: original }];
  // Parent preparation synchronizes root; only the post-rename catalog acknowledgement fails.
  fault.directory = parent;
  fault.error = new Error('Selected catalogue acknowledgement failed.');
  expect(() => materializeSnapshot(target, entries)).toThrow(CanonicalPublicationError);
  expect(readFileSync(join(target, 'bytes'))).toEqual(original);
  expect(existsSync(`${target}.staging`)).toBe(false);
  fault.directory = undefined;
  materializeSnapshot(target, [{ kind: 1, path: 'bytes', content: Buffer.from('replacement') }]);
  expect(readFileSync(join(target, 'bytes'))).toEqual(original);
});

it('owns private ZIP tree bytes, metadata accounting, moves and recursive cleanup', async () => {
  const root = fixture();
  const privateTree = await createPrivateTree(root, 'zip-');
  expect((await stat(privateTree)).mode & 0o777).toBe(0o700);
  await makePrivateTreeDirectory(join(privateTree, 'members', 'nested'));
  const path = join(privateTree, 'members', 'nested', 'member');
  const seen: Buffer[] = [];
  let written = 0;
  let checked = false;
  await writePrivateTreeFile({
    path,
    source: Readable.from([original.subarray(0, 3), original.subarray(3)]),
    signal: new AbortController().signal,
    onChunk: (chunk) => {
      seen.push(Buffer.from(chunk));
    },
    onWritten: (bytes) => {
      written += bytes;
    },
    validate: () => {
      checked = true;
      expect(readFileSync(path)).toEqual(original);
    },
    cancellationMessage: 'Private caller cancelled.',
  });
  expect(Buffer.concat(seen)).toEqual(original);
  expect(written).toBe(original.length);
  expect(checked).toBe(true);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const metadata = Buffer.from('verified inventory\n');
  await writePrivateTreeMetadata(join(privateTree, 'inventory'), metadata, (bytes) => {
    expect(bytes).toBe(metadata.length);
    expect(readFileSync(join(privateTree, 'inventory'))).toEqual(metadata);
  });
  const destination = join(root, 'cache');
  await movePrivateTree(privateTree, destination);
  expect(await readFile(join(destination, 'members', 'nested', 'member'))).toEqual(original);
  await removePrivateTree(destination);
  await removePrivateTree(destination);
  expect(await readdir(root)).toEqual([]);
  const synchronous = createPrivateTreeSync(root, 'version-');
  writeFileSync(join(synchronous, 'bytes'), original);
  removePrivateTreeSync(synchronous);
  removePrivateTreeSync(synchronous);
  expect(await readdir(root)).toEqual([]);
});
