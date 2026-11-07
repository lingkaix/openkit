// openkit-test-platform: posix
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanonicalPublicationError,
  publishCanonicalPath,
  publishCanonicalPathAsync,
  syncCanonicalTreeAsync,
} from '@openkit/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  descriptors: new Map<number, string>(),
  handles: new Map<number, { close: () => Promise<void> }>(),
  opened: [] as string[],
  closed: [] as string[],
  events: [] as Array<{ operation: 'sync' | 'rename'; path: string; from?: string }>,
  failSync: undefined as string | undefined,
  failure: new Error('Injected canonical publication sync failure.'),
}));

// Observe actual descriptor commits and rename; inject only the selected synchronization failure.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      const path = String(args[0]);
      io.descriptors.set(descriptor, path);
      io.opened.push(path);
      return descriptor;
    }) as typeof actual.openSync,
    fsyncSync: ((descriptor: number) => {
      const path = io.descriptors.get(descriptor)!;
      if (path === io.failSync) throw io.failure;
      actual.fsyncSync(descriptor);
      io.events.push({ operation: 'sync', path });
    }) as typeof actual.fsyncSync,
    closeSync: ((descriptor: number) => {
      const path = io.descriptors.get(descriptor)!;
      actual.closeSync(descriptor);
      io.descriptors.delete(descriptor);
      io.closed.push(path);
    }) as typeof actual.closeSync,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args);
      io.events.push({ operation: 'rename', from: String(args[0]), path: String(args[1]) });
    }) as typeof actual.renameSync,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const descriptor = handle.fd;
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      io.handles.set(descriptor, { close });
      io.opened.push(path);
      handle.sync = async () => {
        if (path === io.failSync) throw io.failure;
        await sync();
        io.events.push({ operation: 'sync', path });
      };
      handle.close = async () => {
        await close();
        io.handles.delete(descriptor);
        io.closed.push(path);
      };
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      io.events.push({ operation: 'rename', from: String(args[0]), path: String(args[1]) });
    },
  };
});

const roots: string[] = [];
const sourceBytes = Buffer.from([0, 255, 128, 13, 10, 1]);
const priorBytes = Buffer.from('Prior canonical bytes.');
const publishers = [
  { name: 'synchronous', publish: publishCanonicalPath },
  { name: 'asynchronous', publish: publishCanonicalPathAsync },
] as const;

afterEach(async () => {
  io.failSync = undefined;
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  for (const descriptor of io.descriptors.keys()) actual.closeSync(descriptor);
  await Promise.all([...io.handles.values()].map((handle) => handle.close()));
  io.descriptors.clear();
  io.handles.clear();
  io.opened.length = 0;
  io.closed.length = 0;
  io.events.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Supplies caller-owned real staging and publication parents without a domain publisher. */
function fixture(sameParent = false) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-canonical-publication-'));
  roots.push(root);
  const sourceParent = join(root, 'staging');
  const destinationParent = sameParent ? sourceParent : join(root, 'published');
  mkdirSync(sourceParent);
  if (!sameParent) mkdirSync(destinationParent);
  return {
    root,
    sourceParent,
    destinationParent,
    staged: join(sourceParent, 'candidate'),
    destination: join(destinationParent, 'canonical'),
  };
}

/** Captures a refusal without changing the synchronous or asynchronous public error boundary. */
async function refusal(operation: () => void | Promise<void>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Verifies real descriptor closure before fallback test cleanup can hide a leak. */
function expectClosedDescriptors(): void {
  expect(io.opened.length).toBeGreaterThan(0);
  expect([...io.closed].sort()).toEqual([...io.opened].sort());
  expect(io.descriptors.size).toBe(0);
  expect(io.handles.size).toBe(0);
}

describe('canonical path publication through the original NanoCore exports', () => {
  it.each(publishers)(
    '$name publication commits a complete tree before rename and both parents afterward',
    async ({ publish }) => {
      const f = fixture();
      const child = join(f.staged, 'child');
      const nestedFile = join(child, 'nested.bin');
      const directFile = join(f.staged, 'direct.bin');
      mkdirSync(f.staged);
      mkdirSync(child);
      writeFileSync(nestedFile, sourceBytes);
      writeFileSync(directFile, 'Direct tree bytes.');

      await publish(f.staged, f.destination);

      // Storage requires durable bytes before publication; this observes completed real fsync calls.
      const renameAt = io.events.findIndex((event) => event.operation === 'rename');
      expect(renameAt).toBeGreaterThan(0);
      const beforeRename = io.events.slice(0, renameAt);
      expect(beforeRename.every((event) => event.operation === 'sync')).toBe(true);
      const synced = beforeRename.map((event) => event.path);
      expect([...synced].sort()).toEqual([nestedFile, directFile, child, f.staged].sort());
      expect(synced.indexOf(nestedFile)).toBeLessThan(synced.indexOf(child));
      expect(synced.indexOf(child)).toBeLessThan(synced.indexOf(f.staged));
      expect(synced.indexOf(directFile)).toBeLessThan(synced.indexOf(f.staged));
      // Preserve the existing destination-then-distinct-source acknowledgement boundary.
      expect(io.events.slice(renameAt)).toEqual([
        { operation: 'rename', from: f.staged, path: f.destination },
        { operation: 'sync', path: f.destinationParent },
        { operation: 'sync', path: f.sourceParent },
      ]);
      expect(existsSync(f.staged)).toBe(false);
      expect(readFileSync(join(f.destination, 'child', 'nested.bin'))).toEqual(sourceBytes);
      expect(readFileSync(join(f.destination, 'direct.bin'), 'utf8')).toBe('Direct tree bytes.');
      expectClosedDescriptors();
    }
  );

  it.each(publishers)(
    '$name same-parent publication replaces a file and commits its parent once',
    async ({ publish }) => {
      const f = fixture(true);
      writeFileSync(f.staged, sourceBytes);
      writeFileSync(f.destination, priorBytes);

      await publish(f.staged, f.destination);

      // A shared source/destination parent has one existing acknowledgement barrier.
      expect(io.events).toEqual([
        { operation: 'sync', path: f.staged },
        { operation: 'rename', from: f.staged, path: f.destination },
        { operation: 'sync', path: f.destinationParent },
      ]);
      expect(existsSync(f.staged)).toBe(false);
      expect(readFileSync(f.destination)).toEqual(sourceBytes);
      expectClosedDescriptors();
    }
  );

  it.each(publishers)(
    '$name publication preserves both files and the raw error when staging sync fails',
    async ({ publish }) => {
      const f = fixture();
      writeFileSync(f.staged, sourceBytes);
      writeFileSync(f.destination, priorBytes);
      io.failSync = f.staged;

      expect(await refusal(() => publish(f.staged, f.destination))).toBe(io.failure);

      // No acknowledgement or replacement is allowed before the staged bytes are durable.
      expect(io.events).toEqual([]);
      expect(readFileSync(f.staged)).toEqual(sourceBytes);
      expect(readFileSync(f.destination)).toEqual(priorBytes);
      expectClosedDescriptors();
    }
  );

  it.each(publishers)(
    '$name publication refuses acknowledgement after a real rename without rollback',
    async ({ name, publish }) => {
      const f = fixture();
      writeFileSync(f.staged, sourceBytes);
      writeFileSync(f.destination, priorBytes);
      io.failSync = f.sourceParent;

      const error = await refusal(() => publish(f.staged, f.destination));

      // Characterization: only sync publication classifies a post-rename parent failure.
      if (name === 'synchronous') {
        expect(error).toBeInstanceOf(CanonicalPublicationError);
        expect(error).toMatchObject({
          name: 'CanonicalPublicationError',
          code: 'recovery_required',
          status: 409,
          cause: io.failure,
        });
        expect((error as CanonicalPublicationError).cause).toBe(io.failure);
      } else {
        expect(error).toBe(io.failure);
      }
      expect(io.events).toEqual([
        { operation: 'sync', path: f.staged },
        { operation: 'rename', from: f.staged, path: f.destination },
        { operation: 'sync', path: f.destinationParent },
      ]);
      expect(existsSync(f.staged)).toBe(false);
      expect(readFileSync(f.destination)).toEqual(sourceBytes);
      expectClosedDescriptors();
    }
  );

  it('standalone asynchronous tree synchronization refuses a link without changing either target', async () => {
    const f = fixture();
    const linkedMember = join(f.staged, 'linked-member');
    writeFileSync(f.destination, priorBytes);
    mkdirSync(f.staged);
    symlinkSync(f.destination, linkedMember, 'file');

    await expect(syncCanonicalTreeAsync(f.staged)).rejects.toThrow(/must be a regular file/);

    expect(io.events).toEqual([]);
    expect(io.opened).toEqual([]);
    expect(readlinkSync(linkedMember)).toBe(f.destination);
    expect(readFileSync(f.destination)).toEqual(priorBytes);
    expect(io.descriptors.size).toBe(0);
    expect(io.handles.size).toBe(0);
  });
});
