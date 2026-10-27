// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyVerifiedFile, publishDurableFile } from './local.js';

const faults = vi.hoisted(() => ({
  sync: false,
  directorySync: false,
  afterParentInspection: undefined as undefined | ((path: string) => Promise<void>),
  opened: undefined as undefined | ((path: string) => void),
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const resolved = await actual.realpath(...args);
      await faults.afterParentInspection?.(String(resolved));
      return resolved;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (faults.opened || faults.afterParentInspection) {
        const resolved = String(await actual.realpath(`/proc/self/fd/${handle.fd}`));
        faults.opened?.(resolved);
        await faults.afterParentInspection?.(resolved);
      }
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (faults.sync || (faults.directorySync && (await handle.stat()).isDirectory()))
          throw new Error('Injected durable-byte synchronization failure.');
        await sync();
      };
      return handle;
    },
  };
});
const roots: string[] = [];
const original = Buffer.from([0, 255, 128, 13, 10, 1, 0, 254]);

/** Derives the oracle from authored bytes rather than the byte owner. */
function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Supplies a disposable regular source and an absent destination in a private directory. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-durable-'));
  roots.push(root);
  const sourcePath = join(root, 'source');
  const destinationPath = join(root, 'destination');
  await writeFile(sourcePath, original, { mode: 0o640 });
  return { root, sourcePath, destinationPath };
}

afterEach(async () => {
  faults.sync = false;
  faults.directorySync = false;
  faults.afterParentInspection = undefined;
  faults.opened = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('snapshot Storage byte primitives', () => {
  it('copies exact original bytes and mode into an independent durable file', async () => {
    const f = await fixture();
    const result = await copyVerifiedFile({
      ...f,
      expectedBytes: original.length,
      expectedSha256: sha256(original),
      mode: 0o640,
      maxBytes: original.length,
    });
    expect(result).toEqual({ bytes: original.length, sha256: sha256(original), mode: 0o640 });
    expect(await readFile(f.destinationPath)).toEqual(original);
    expect((await stat(f.destinationPath)).mode & 0o777).toBe(0o640);
    expect((await stat(f.destinationPath)).ino).not.toBe((await stat(f.sourcePath)).ino);
    await writeFile(f.sourcePath, 'A later source mutation');
    await rm(f.sourcePath);
    expect(await readFile(f.destinationPath)).toEqual(original);
  });

  it.each([
    'digest',
    'length',
    'bound',
  ] as const)('refuses %s failure without exposing destination bytes', async (fault) => {
    const f = await fixture();
    await expect(
      copyVerifiedFile({
        sourcePath: f.sourcePath,
        destinationPath: f.destinationPath,
        expectedBytes: fault === 'length' ? original.length + 1 : original.length,
        expectedSha256:
          fault === 'digest' ? sha256(Buffer.from('wrong original')) : sha256(original),
        maxBytes: fault === 'bound' ? original.length - 1 : original.length,
      })
    ).rejects.toThrow();
    expect(await readdir(f.root)).toEqual(['source']);
    expect(await readFile(f.sourcePath)).toEqual(original);
  });

  it.each([
    'source',
    'destination',
    'parent',
  ] as const)('refuses a linked %s without changing outside bytes', async (link) => {
    const f = await fixture();
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    const protectedPath = join(outside, 'protected');
    await writeFile(protectedPath, original);
    if (link === 'source') {
      await rm(f.sourcePath);
      await symlink(protectedPath, f.sourcePath);
    } else if (link === 'destination') {
      await symlink(protectedPath, f.destinationPath);
    } else {
      const linkedParent = join(f.root, 'linked');
      await symlink(outside, linkedParent);
      f.destinationPath = join(linkedParent, 'new');
    }
    await expect(
      copyVerifiedFile({
        sourcePath: f.sourcePath,
        destinationPath: f.destinationPath,
        expectedBytes: original.length,
        expectedSha256: sha256(original),
        maxBytes: original.length,
      })
    ).rejects.toThrow();
    expect(await readFile(protectedPath)).toEqual(original);
    expect(await readdir(outside)).toEqual(['protected']);
  });

  it('hashes a first bounded independent copy without a previous identity', async () => {
    const f = await fixture();
    expect(
      await copyVerifiedFile({
        sourcePath: f.sourcePath,
        destinationPath: f.destinationPath,
        maxBytes: original.length,
        mode: 0o600,
      })
    ).toEqual({ bytes: original.length, sha256: sha256(original), mode: 0o600 });
    expect(await readFile(f.destinationPath)).toEqual(original);
  });

  it('never overwrites an unrelated destination', async () => {
    const f = await fixture();
    const predecessor = Buffer.from('The previously published authority');
    await writeFile(f.destinationPath, predecessor);
    await expect(
      publishDurableFile({ destinationPath: f.destinationPath, bytes: original, mode: 0o600 })
    ).rejects.toThrow();
    await expect(
      copyVerifiedFile({
        sourcePath: f.sourcePath,
        destinationPath: f.destinationPath,
        expectedBytes: original.length,
        expectedSha256: sha256(original),
        maxBytes: original.length,
      })
    ).rejects.toThrow();
    expect(await readFile(f.destinationPath)).toEqual(predecessor);
  });

  it('publishes exact bytes and private mode before success', async () => {
    const f = await fixture();
    expect(
      await publishDurableFile({ destinationPath: f.destinationPath, bytes: original, mode: 0o600 })
    ).toEqual({ bytes: original.length, sha256: sha256(original), mode: 0o600 });
    expect(await readFile(f.destinationPath)).toEqual(original);
    expect((await stat(f.destinationPath)).mode & 0o777).toBe(0o600);
  });

  it.each([
    'copy',
    'publish',
  ] as const)('does not acknowledge %s when durability fails', async (operation) => {
    const f = await fixture();
    faults.sync = true;
    const pending =
      operation === 'copy'
        ? copyVerifiedFile({
            sourcePath: f.sourcePath,
            destinationPath: f.destinationPath,
            expectedBytes: original.length,
            expectedSha256: sha256(original),
            maxBytes: original.length,
          })
        : publishDurableFile({ destinationPath: f.destinationPath, bytes: original, mode: 0o600 });
    await expect(pending).rejects.toThrow();
    faults.sync = false;
    expect(await readFile(f.sourcePath)).toEqual(original);
    // Failure before the first successful byte synchronization cannot publish a destination.
    expect(await readdir(f.root)).toEqual(['source']);
    await publishDurableFile({ destinationPath: f.destinationPath, bytes: original, mode: 0o600 });
    expect(await readFile(f.destinationPath)).toEqual(original);
  });
  it('does not acknowledge publication when final directory synchronization fails', async () => {
    const f = await fixture();
    faults.directorySync = true;
    const pending = publishDurableFile({
      destinationPath: f.destinationPath,
      bytes: original,
      mode: 0o600,
    });
    await expect(pending).rejects.toThrow();
    faults.directorySync = false;
    expect(await readFile(f.sourcePath)).toEqual(original);
    const exposed = (await readdir(f.root)).includes('destination');
    // A post-placement failure is uncertain. Any surviving candidate must still contain exact bytes.
    if (exposed) {
      expect(await readFile(f.destinationPath)).toEqual(original);
      await expect(
        publishDurableFile({
          destinationPath: f.destinationPath,
          bytes: Buffer.from('unrelated later bytes'),
          mode: 0o600,
        })
      ).rejects.toThrow();
      expect(await readFile(f.destinationPath)).toEqual(original);
    }
  });
  it('refuses source and destination parent substitution during verified copy', async () => {
    for (const family of ['source', 'destination'] as const) {
      const f = await fixture();
      const parent = join(f.root, 'admitted-parent');
      const moved = join(f.root, 'moved-original-parent');
      const outside = join(f.root, 'outside-parent');
      await mkdir(parent);
      await mkdir(outside);
      await writeFile(join(outside, 'protected'), 'Outside bytes must stay unchanged.');
      const sourcePath = family === 'source' ? join(parent, 'original') : f.sourcePath;
      const destinationPath = family === 'destination' ? join(parent, 'copied') : f.destinationPath;
      if (family === 'source') {
        await writeFile(sourcePath, original);
        await writeFile(join(outside, 'original'), 'Substituted outside private bytes.');
      }
      const originalInode = (await stat(sourcePath)).ino;
      let substituted = false;
      let outsideOpens = 0;
      faults.opened = (path) => {
        if (path === outside || path.startsWith(`${outside}/`)) outsideOpens += 1;
      };
      faults.afterParentInspection = async (path) => {
        if (path !== parent || substituted) return;
        substituted = true;
        await rename(parent, moved);
        await symlink(outside, parent);
      };
      await expect
        .soft(
          copyVerifiedFile({
            sourcePath,
            destinationPath,
            expectedBytes: original.length,
            expectedSha256: sha256(original),
            maxBytes: original.length,
          })
        )
        .rejects.toThrow();
      expect
        .soft(substituted, 'The fault must cross an actual admitted-parent inspection.')
        .toBe(true);
      expect.soft(outsideOpens).toBe(0);
      expect
        .soft((await readdir(outside)).sort())
        .toEqual(family === 'source' ? ['original', 'protected'] : ['protected']);
      expect
        .soft(await readFile(join(outside, 'protected'), 'utf8'))
        .toBe('Outside bytes must stay unchanged.');
      const retainedSource =
        family === 'source' && substituted ? join(moved, 'original') : sourcePath;
      expect.soft((await stat(retainedSource)).ino).toBe(originalInode);
      expect.soft(await readFile(retainedSource)).toEqual(original);
      faults.afterParentInspection = undefined;
      faults.opened = undefined;
    }
  });

  it('refuses destination parent substitution during durable publication', async () => {
    const f = await fixture();
    const parent = join(f.root, 'admitted-parent');
    const moved = join(f.root, 'moved-original-parent');
    const outside = join(f.root, 'outside-parent');
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(join(outside, 'protected'), 'Outside bytes must stay unchanged.');
    let substituted = false;
    let outsideOpens = 0;
    faults.opened = (path) => {
      if (path === outside || path.startsWith(`${outside}/`)) outsideOpens += 1;
    };
    faults.afterParentInspection = async (path) => {
      if (path !== parent || substituted) return;
      substituted = true;
      await rename(parent, moved);
      await symlink(outside, parent);
    };
    await expect(
      publishDurableFile({
        destinationPath: join(parent, 'published'),
        bytes: original,
        mode: 0o600,
      })
    ).rejects.toThrow();
    expect(substituted, 'The fault must cross an actual admitted-parent inspection.').toBe(true);
    expect(outsideOpens).toBe(0);
    expect(await readdir(outside)).toEqual(['protected']);
    expect(await readFile(join(outside, 'protected'), 'utf8')).toBe(
      'Outside bytes must stay unchanged.'
    );
  });
});
