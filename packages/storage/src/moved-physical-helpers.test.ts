// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
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
  populatePrivateOverlayContentsSync,
  publishCanonicalPath,
  publishCanonicalPathAsync,
  readCanonicalFile,
  readCanonicalTextFile,
  removeCanonicalTreeSync,
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

it('removes only the selected canonical tree and preserves linked bytes, siblings and directory modes', () => {
  const root = fixture();
  const parent = join(root, 'catalog');
  const target = join(parent, 'selected');
  const outside = join(root, 'outside');
  mkdirSync(join(target, 'nested'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(target, 'nested', 'bytes'), original);
  writeFileSync(join(outside, 'retained'), original);
  writeFileSync(join(parent, 'sibling'), original);
  symlinkSync(outside, join(target, 'linked'), 'dir');
  const parentBefore = statSync(parent);

  removeCanonicalTreeSync(target);

  expect(existsSync(target)).toBe(false);
  expect(readFileSync(join(outside, 'retained'))).toEqual(original);
  expect(readFileSync(join(parent, 'sibling'))).toEqual(original);
  // The original recursive/force removal unlinks a selected link without following it.
  symlinkSync(outside, target, 'dir');
  removeCanonicalTreeSync(target);
  expect(() => lstatSync(target)).toThrowError(expect.objectContaining({ code: 'ENOENT' }));
  expect(readFileSync(join(outside, 'retained'))).toEqual(original);
  expect(statSync(parent).ino).toBe(parentBefore.ino);
  expect(statSync(parent).mode).toBe(parentBefore.mode);

  const missing = join(root, 'new', 'entry', 'absent');
  const previousUmask = process.umask(0o027);
  try {
    removeCanonicalTreeSync(missing);
  } finally {
    process.umask(previousUmask);
  }
  expect(existsSync(missing)).toBe(false);
  for (const path of [join(root, 'new'), join(root, 'new', 'entry')])
    expect(statSync(path).mode & 0o777).toBe(0o750);
});

it.each([
  'before',
  'after',
] as const)('preserves the exact deletion boundary when parent acknowledgement fails %s removal', (boundary) => {
  const root = fixture();
  const parent = join(root, 'catalog');
  const target = join(parent, 'selected');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'bytes'), original);
  writeFileSync(join(parent, 'sibling'), original);
  const parentBefore = statSync(parent);
  const refused = new Error('Selected deletion acknowledgement failed.');
  // Parent admission commits its containing entry; retirement then commits the selected parent.
  fault.directory = boundary === 'before' ? root : parent;
  fault.error = refused;
  try {
    removeCanonicalTreeSync(target);
    expect.unreachable('Deletion must not acknowledge failed parent synchronization.');
  } catch (error) {
    expect(error).toBe(refused);
  }
  expect(existsSync(target)).toBe(boundary === 'before');
  if (boundary === 'before') expect(readFileSync(join(target, 'bytes'))).toEqual(original);
  expect(readFileSync(join(parent, 'sibling'))).toEqual(original);
  expect(statSync(parent).ino).toBe(parentBefore.ino);
  expect(statSync(parent).mode).toBe(parentBefore.mode);
  // An absent-entry retry still acknowledges the parent and must preserve its failure.
  if (boundary === 'after') expect(() => removeCanonicalTreeSync(target)).toThrow(refused);
});

it('populates private overlays in caller order with exact bytes, modes and draft overwrites', () => {
  const root = fixture();
  const source = join(root, 'source');
  mkdirSync(join(source, 'nested'), { recursive: true });
  writeFileSync(join(source, 'nested/raw'), original);
  const scoped = join(root, 'scoped');
  writeFileSync(scoped, original);
  chmodSync(scoped, 0o640);
  const target = createPrivateTreeSync(root, 'overlay-');
  const config = join(target, 'config');
  const copied = join(target, 'workspace/config.jsonc');
  const empty = join(target, 'draft/empty');
  populatePrivateOverlayContentsSync(
    source,
    config,
    [
      { sourcePath: join(root, 'missing'), targetPath: join(target, 'missing/ignored') },
      { sourcePath: scoped, targetPath: copied },
    ],
    [
      { targetPath: copied, content: 'first' },
      { targetPath: copied, content: 'last \u03bb\n' },
      { targetPath: empty, content: '' },
    ]
  );
  expect(readFileSync(join(config, 'nested/raw'))).toEqual(original);
  expect(readFileSync(copied)).toEqual(Buffer.from('last \u03bb\n'));
  expect(statSync(copied).mode & 0o777).toBe(0o640);
  expect(readFileSync(empty)).toEqual(Buffer.alloc(0));
  expect(statSync(empty).mode & 0o777).toBe(0o666 & ~process.umask());
  expect(statSync(join(target, 'draft')).mode & 0o777).toBe(0o777 & ~process.umask());
  expect(statSync(target).mode & 0o777).toBe(0o700);
  expect(existsSync(join(target, 'missing'))).toBe(false);
  expect(readFileSync(scoped)).toEqual(original);
  expect(readFileSync(join(source, 'nested/raw'))).toEqual(original);
});

it('creates an absent overlay base without a source and keeps its original default mode', () => {
  const root = fixture();
  const target = createPrivateTreeSync(root, 'overlay-');
  const config = join(target, 'config');
  populatePrivateOverlayContentsSync(
    join(root, 'absent'),
    config,
    [{ sourcePath: join(root, 'optional-absent'), targetPath: join(target, 'optional/ignored') }],
    [{ targetPath: join(config, 'draft'), content: 'draft-only\n' }]
  );
  expect(readFileSync(join(config, 'draft'), 'utf8')).toBe('draft-only\n');
  expect(existsSync(join(target, 'optional'))).toBe(false);
  expect(existsSync(join(root, 'optional-absent'))).toBe(false);
  expect(lstatSync(config).isDirectory()).toBe(true);
  expect(statSync(config).mode & 0o777).toBe(0o777 & ~process.umask());
  expect(existsSync(join(root, 'absent'))).toBe(false);
});

it('preserves the copied prefix and private root when a later file copy refuses a directory', () => {
  const root = fixture();
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'base'), original);
  const first = join(root, 'first');
  writeFileSync(first, original);
  const directory = join(root, 'not-a-file');
  mkdirSync(directory);
  writeFileSync(join(directory, 'untouched'), original);
  const target = createPrivateTreeSync(root, 'overlay-');
  expect(() =>
    populatePrivateOverlayContentsSync(
      source,
      join(target, 'config'),
      [
        { sourcePath: first, targetPath: join(target, 'copies/first') },
        { sourcePath: directory, targetPath: join(target, 'copies/refused') },
        { sourcePath: first, targetPath: join(target, 'later/absent') },
      ],
      [{ targetPath: join(target, 'draft/absent'), content: 'not written' }]
    )
  ).toThrow();
  expect(readFileSync(join(target, 'config/base'))).toEqual(original);
  expect(readFileSync(join(target, 'copies/first'))).toEqual(original);
  expect(existsSync(join(target, 'later'))).toBe(false);
  expect(existsSync(join(target, 'draft'))).toBe(false);
  expect(readFileSync(join(directory, 'untouched'))).toEqual(original);
  expect(readFileSync(first)).toEqual(original);
  expect(lstatSync(target).isDirectory()).toBe(true);
});

it('retains earlier overlay drafts and copied bytes when a later draft refuses a directory', () => {
  const root = fixture();
  const source = join(root, 'source');
  mkdirSync(join(source, 'directory'), { recursive: true });
  writeFileSync(join(source, 'base'), original);
  const target = createPrivateTreeSync(root, 'overlay-');
  const config = join(target, 'config');
  expect(() =>
    populatePrivateOverlayContentsSync(
      source,
      config,
      [],
      [
        { targetPath: join(target, 'draft/first'), content: 'retained' },
        { targetPath: join(config, 'directory'), content: 'refused' },
        { targetPath: join(target, 'later/absent'), content: 'not written' },
      ]
    )
  ).toThrow();
  expect(readFileSync(join(target, 'draft/first'), 'utf8')).toBe('retained');
  expect(readFileSync(join(config, 'base'))).toEqual(original);
  expect(lstatSync(join(config, 'directory')).isDirectory()).toBe(true);
  expect(existsSync(join(target, 'later'))).toBe(false);
  expect(readFileSync(join(source, 'base'))).toEqual(original);
  expect(lstatSync(target).isDirectory()).toBe(true);
});
