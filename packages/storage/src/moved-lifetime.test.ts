// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import {
  type FileHandle,
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
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  measureDerivedTreeBytes,
  removePrivateTreeStrict,
  stagePrivateFile,
  withStagedMediaSource,
  writeVerifiedRepresentation,
} from './local.js';

const faults = vi.hoisted(() => ({
  opened: undefined as undefined | ((path: string, handle: FileHandle) => void),
  removing: undefined as undefined | ((path: string) => void),
}));

// Only selected syscalls are intercepted. Successful effects retain real Node handles and bytes.
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      faults.opened?.(String(args[0]), handle);
      return handle;
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      faults.removing?.(String(args[0]));
      return actual.rm(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  faults.opened = undefined;
  faults.removing = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A concrete counter implements the required structural input without importing domain policy. */
class ByteCounter {
  byteLength = 0;
  consume(bytes: number): void {
    this.byteLength += bytes;
  }
}

/** The caller selects its refusal type; these fixtures preserve its code and cause objects. */
class IntegrityFailure extends Error {
  constructor(readonly code: 'invalid_request' | 'source_digest_mismatch') {
    super(code);
  }
}

/** Cleanup preserves the original effect and cleanup causes without interpreting them. */
class CleanupFailure extends Error {
  constructor(readonly causes: readonly unknown[]) {
    super('Private cleanup failed.');
  }
}

/** Media refusal reasons belong to the caller's existing closed input contract. */
class MediaFailure extends Error {
  constructor(
    readonly reason:
      | 'source-unavailable'
      | 'source-changed'
      | 'resource-limited'
      | 'cleanup-unavailable'
  ) {
    super(reason);
  }
}

/** Unsafe derived bytes retain the caller-selected unavailable result. */
class RetrievalFailure extends Error {
  constructor(readonly code: 'unavailable') {
    super(code);
  }
}

/** Each scenario owns a fresh real temporary root. */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'storage-lifetime-'));
  roots.push(root);
  return root;
}

/** Expected identity comes from fixture bytes, independently of the physical helper. */
function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Holds an explicit I/O or consumer boundary without elapsed-time polling. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** This is an actual supplied reservation: it records accepted writes, not admission policy. */
function reservation() {
  return { assertAvailable: vi.fn(), recordWritten: vi.fn<(bytes: number) => void>() };
}

/** Calls the package boundary with the required concrete counter and caller error constructors. */
function capture(root: string, input: Parameters<typeof stagePrivateFile>[1]) {
  return stagePrivateFile(root, input, ByteCounter, IntegrityFailure, CleanupFailure);
}

describe('durable private file lifetime', () => {
  it('accounts actual short writes and waits for payload and directory acknowledgement', async () => {
    // Work Resource Interaction / File Admission: occupied bytes precede durable publication.
    const root = await temporaryRoot();
    const bytes = Buffer.from('00ffc328800a010203', 'hex');
    const capacity = reservation();
    const fileEntered = gate();
    const fileContinue = gate();
    const directoryEntered = gate();
    const directoryContinue = gate();
    const events: string[] = [];
    let payload = '';
    let settled = false;
    faults.opened = (path, handle) => {
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      if (path.endsWith('/payload')) {
        payload = path;
        const write = handle.write.bind(handle);
        vi.spyOn(handle, 'write').mockImplementation(((buffer: Buffer, offset = 0) =>
          write(buffer, offset, Math.min(2, buffer.length - offset))) as FileHandle['write']);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          fileEntered.release();
          await fileContinue.promise;
          await sync();
          events.push('payload-sync');
        });
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          events.push('payload-close');
        });
      } else if (payload && path === dirname(payload)) {
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          directoryEntered.release();
          await directoryContinue.promise;
          await sync();
          events.push('directory-sync');
        });
      }
    };
    const inspected = vi.fn();
    const submitted = vi.fn();
    const work = capture(root, {
      source: Readable.from([bytes]),
      expectedByteLength: bytes.length,
      expectedDigest: digest(bytes),
      reservation: capacity,
      inspectChunk: inspected,
      submission: { consume: submitted },
    });
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      await Promise.race([fileEntered.promise, work]);
      expect(capacity.recordWritten.mock.calls.flat()).toEqual([2, 2, 2, 2, 1]);
      expect(await readFile(payload)).toEqual(bytes);
      expect((await stat(payload)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(payload))).mode & 0o777).toBe(0o700);
      expect(settled).toBe(false);
      expect(capacity.assertAvailable).not.toHaveBeenCalled();
      fileContinue.release();
      await Promise.race([directoryEntered.promise, work]);
      expect(events).toEqual(['payload-sync', 'payload-close']);
      expect(settled).toBe(false);
      directoryContinue.release();
      const staged = await work;
      expect(events).toEqual(['payload-sync', 'payload-close', 'directory-sync']);
      expect(staged).toMatchObject({ byteLength: bytes.length, contentDigest: digest(bytes) });
      expect(inspected).toHaveBeenCalledWith(bytes);
      expect(submitted).toHaveBeenCalledWith(bytes.length);
      expect(capacity.assertAvailable).toHaveBeenCalledOnce();
      await staged.remove();
      expect(await readdir(root)).toEqual([]);
    } finally {
      fileContinue.release();
      directoryContinue.release();
      await Promise.allSettled([work]);
    }
  });

  it.each(['short', 'long', 'digest'] as const)(
    'refuses %s source metadata and removes its incomplete private tree',
    async (fault) => {
      const root = await temporaryRoot();
      const bytes = Buffer.from([0, 255, 128, 1]);
      const capacity = reservation();
      await expect(
        capture(root, {
          source: Readable.from([bytes]),
          expectedByteLength: bytes.length + (fault === 'short' ? 1 : fault === 'long' ? -1 : 0),
          expectedDigest: digest(fault === 'digest' ? Buffer.from('other') : bytes),
          reservation: capacity,
        })
      ).rejects.toMatchObject({
        code: fault === 'digest' ? 'source_digest_mismatch' : 'invalid_request',
      });
      expect(capacity.assertAvailable).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    }
  );

  it.each(['inspection', 'submission'] as const)(
    'preserves the caller refusal from %s before accepting file bytes',
    async (fault) => {
      const root = await temporaryRoot();
      const bytes = Buffer.from('bounded');
      const capacity = reservation();
      const refusal = new Error(`Selected ${fault} refusal.`);
      const refuse = () => {
        throw refusal;
      };
      await expect(
        capture(root, {
          source: Readable.from([bytes]),
          expectedByteLength: bytes.length,
          expectedDigest: digest(bytes),
          reservation: capacity,
          ...(fault === 'inspection'
            ? { inspectChunk: refuse }
            : { submission: { consume: refuse } }),
        })
      ).rejects.toBe(refusal);
      expect(capacity.recordWritten).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    }
  );

  it('refuses a zero-progress descriptor without charging unwritten bytes', async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from('not written');
    const capacity = reservation();
    faults.opened = (path, handle) => {
      if (!path.endsWith('/payload')) return;
      vi.spyOn(handle, 'write').mockImplementation((async (buffer: Buffer) => ({
        buffer,
        bytesWritten: 0,
      })) as FileHandle['write']);
    };
    await expect(
      capture(root, {
        source: Readable.from([bytes]),
        expectedByteLength: bytes.length,
        expectedDigest: digest(bytes),
        reservation: capacity,
      })
    ).rejects.toThrow();
    expect(capacity.recordWritten).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('retains actual partial bytes and original causes when close and cleanup fail', async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from('original');
    const capacity = reservation();
    const writeFailure = new Error('Selected write refusal.');
    const closeFailure = new Error('Selected close refusal.');
    const removeFailure = new Error('Selected cleanup refusal.');
    let payload = '';
    let writes = 0;
    faults.opened = (path, handle) => {
      if (!path.endsWith('/payload')) return;
      payload = path;
      const write = handle.write.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'write').mockImplementation((async (buffer: Buffer, offset = 0) => {
        if (writes++ > 0) throw writeFailure;
        return write(buffer, offset, 2);
      }) as FileHandle['write']);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        throw closeFailure;
      });
    };
    faults.removing = (path) => {
      if (payload && path === dirname(payload)) throw removeFailure;
    };
    const failure = await capture(root, {
      source: Readable.from([bytes]),
      expectedByteLength: bytes.length,
      expectedDigest: digest(bytes),
      reservation: capacity,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CleanupFailure);
    expect((failure as CleanupFailure).causes).toEqual([writeFailure, closeFailure, removeFailure]);
    for (const [index, cause] of [writeFailure, closeFailure, removeFailure].entries())
      expect((failure as CleanupFailure).causes[index]).toBe(cause);
    expect(capacity.recordWritten.mock.calls).toEqual([[2]]);
    expect(capacity.assertAvailable).not.toHaveBeenCalled();
    expect(await readFile(payload)).toEqual(bytes.subarray(0, 2));
  });

  it('joins an accepted pending write before cancellation closes or removes its file', async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.alloc(65_536, 0xff);
    const capacity = reservation();
    const entered = gate();
    const finishWrite = gate();
    const events: string[] = [];
    faults.opened = (path, handle) => {
      if (!path.endsWith('/payload')) return;
      const write = handle.write.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'write').mockImplementation((async (buffer: Buffer, offset = 0) => {
        const result = await write(buffer, offset);
        entered.release();
        await finishWrite.promise;
        return result;
      }) as FileHandle['write']);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        events.push('close');
        await close();
      });
    };
    faults.removing = () => events.push('remove');
    const controller = new AbortController();
    const source = Readable.from([bytes]);
    const work = capture(root, {
      source,
      expectedByteLength: bytes.length,
      expectedDigest: digest(bytes),
      reservation: capacity,
      signal: controller.signal,
    });
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await Promise.race([entered.promise, work]);
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toEqual([]);
      finishWrite.release();
      await rejected;
      expect(events).toEqual(['close', 'remove']);
      expect(source.destroyed).toBe(true);
      expect(capacity.recordWritten.mock.calls).toEqual([[bytes.length]]);
      expect(await readdir(root)).toEqual([]);
    } finally {
      finishWrite.release();
      await Promise.allSettled([work]);
    }
  });
});

/** Concrete supplied media capacity records writes and proves deletion before release. */
function mediaCapacity(root: string) {
  const written: bigint[] = [];
  let releases = 0;
  return {
    written,
    released: () => releases,
    reserve: vi.fn((_bytes: number) => ({
      recordWritten(bytes: bigint) {
        written.push(bytes);
      },
      release() {
        expect(readdirSync(root)).toEqual([]);
        releases++;
      },
    })),
    async assertRemoved() {
      expect(await readdir(root)).toEqual([]);
      expect(releases).toBe(1);
    },
  };
}

/** Original source bytes arrive through the helper's structural source contract. */
function mediaSource(bytes: Uint8Array) {
  return {
    originalDigest: digest(bytes),
    byteLength: bytes.byteLength,
    async *open(_signal: AbortSignal) {
      yield bytes;
    },
  };
}

describe('private media input lifetime', () => {
  it('copies producer-owned chunks and keeps verified read-only bytes until consumption ends', async () => {
    // Work Resource Interaction / Bounded Media Processors: exact private input and proved cleanup.
    const root = await temporaryRoot();
    const bytes = Buffer.from('original media bytes');
    const expected = Buffer.from(bytes);
    const capacity = mediaCapacity(root);
    const writeEntered = gate();
    const writeContinue = gate();
    const consumeEntered = gate();
    const consumeContinue = gate();
    let stagedPath = '';
    faults.opened = (path, handle) => {
      if (!path.endsWith('/input.pdf')) return;
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
        writeEntered.release();
        await writeContinue.promise;
        return write(data, options);
      });
    };
    const work = withStagedMediaSource(
      mediaSource(bytes),
      root,
      capacity.reserve,
      new AbortController().signal,
      'media-',
      async (path) => {
        stagedPath = path;
        expect(await readFile(path)).toEqual(expected);
        expect((await stat(path)).mode & 0o777).toBe(0o400);
        expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
        consumeEntered.release();
        await consumeContinue.promise;
        return { processed: true };
      },
      MediaFailure
    );
    try {
      await Promise.race([writeEntered.promise, work]);
      bytes.fill(0x78);
      writeContinue.release();
      await Promise.race([consumeEntered.promise, work]);
      expect(await readFile(stagedPath)).toEqual(expected);
      expect(capacity.released()).toBe(0);
      consumeContinue.release();
      await expect(work).resolves.toEqual({ processed: true });
      expect(capacity.reserve).toHaveBeenCalledWith(expected.length);
      expect(capacity.written).toEqual([BigInt(expected.length)]);
      await capacity.assertRemoved();
    } finally {
      writeContinue.release();
      consumeContinue.release();
      await Promise.allSettled([work]);
    }
  });

  it.each([
    ['empty', 'source-unavailable'],
    ['oversized chunk', 'source-unavailable'],
    ['excess length', 'source-changed'],
    ['short source', 'source-changed'],
    ['wrong digest', 'source-changed'],
    ['non-byte chunk', 'source-changed'],
  ] as const)('refuses %s without exposing an input to the consumer', async (fault, reason) => {
    const root = await temporaryRoot();
    const bytes = Buffer.from('media');
    const capacity = mediaCapacity(root);
    const consumer = vi.fn(async () => 'must not consume');
    const source = {
      ...mediaSource(bytes),
      ...(fault === 'oversized chunk' ? { byteLength: 65_537 } : {}),
      ...(fault === 'wrong digest' ? { originalDigest: digest(Buffer.from('other')) } : {}),
      async *open() {
        if (fault === 'empty') yield Buffer.alloc(0);
        else if (fault === 'oversized chunk') yield Buffer.alloc(65_537);
        else if (fault === 'excess length') yield Buffer.alloc(bytes.length + 1);
        else if (fault === 'short source') yield bytes.subarray(0, 2);
        else if (fault === 'non-byte chunk') yield 'unsafe source' as unknown as Uint8Array;
        else yield bytes;
      },
    };
    await expect(
      withStagedMediaSource(
        source,
        root,
        capacity.reserve,
        new AbortController().signal,
        'media-',
        consumer,
        MediaFailure
      )
    ).rejects.toMatchObject({ reason });
    expect(consumer).not.toHaveBeenCalled();
    await capacity.assertRemoved();
  });

  it('maps unavailable reservation to resource refusal before opening the source', async () => {
    const root = await temporaryRoot();
    const source = mediaSource(Buffer.from('media'));
    const opened = vi.spyOn(source, 'open');
    const consume = vi.fn(async () => undefined);
    await expect(
      withStagedMediaSource(
        source,
        root,
        () => {
          throw new Error('Capacity unavailable.');
        },
        new AbortController().signal,
        'media-',
        consume,
        MediaFailure
      )
    ).rejects.toMatchObject({ reason: 'resource-limited' });
    expect(opened).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['already aborted', 'pending read'] as const)(
    'cancels a %s source without waiting for its uncooperative iterator',
    async (timing) => {
      const root = await temporaryRoot();
      const capacity = mediaCapacity(root);
      const reading = gate();
      const controller = new AbortController();
      const cancelled = new Error('Caller cancelled.');
      let returned = 0;
      const source = {
        ...mediaSource(Buffer.from('undelivered')),
        open() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  reading.release();
                  return new Promise<IteratorResult<Uint8Array>>(() => {});
                },
                return() {
                  returned++;
                  return new Promise<IteratorResult<Uint8Array>>(() => {});
                },
              };
            },
          };
        },
      };
      if (timing === 'already aborted') controller.abort(cancelled);
      const consumer = vi.fn(async () => undefined);
      const work = withStagedMediaSource(
        source,
        root,
        capacity.reserve,
        controller.signal,
        'media-',
        consumer,
        MediaFailure
      );
      const rejected = expect(work).rejects.toBe(cancelled);
      if (timing === 'pending read') {
        await reading.promise;
        controller.abort(cancelled);
      }
      await rejected;
      expect(returned).toBe(1);
      expect(consumer).not.toHaveBeenCalled();
      await capacity.assertRemoved();
    }
  );

  it('retains its reservation and partial bytes when private cleanup cannot be proved', async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from('media');
    const capacity = mediaCapacity(root);
    const sourceFailure = new Error('Source interrupted.');
    const consumer = vi.fn(async () => undefined);
    faults.removing = (path) => {
      if (path.startsWith(`${root}/media-`)) throw new Error('Selected cleanup refusal.');
    };
    await expect(
      withStagedMediaSource(
        {
          ...mediaSource(bytes),
          async *open() {
            yield bytes.subarray(0, 2);
            throw sourceFailure;
          },
        },
        root,
        capacity.reserve,
        new AbortController().signal,
        'media-',
        consumer,
        MediaFailure
      )
    ).rejects.toMatchObject({ reason: 'cleanup-unavailable' });
    expect(capacity.released()).toBe(0);
    expect(capacity.written).toEqual([2n]);
    expect(consumer).not.toHaveBeenCalled();
    const entries = await readdir(root);
    expect(entries).toHaveLength(1);
    expect(await readFile(join(root, entries[0]!, 'input.pdf'))).toEqual(bytes.subarray(0, 2));
  });

  it('removes verified input and releases capacity before propagating a consumer refusal', async () => {
    const root = await temporaryRoot();
    const capacity = mediaCapacity(root);
    const refusal = new Error('Consumer refused.');
    await expect(
      withStagedMediaSource(
        mediaSource(Buffer.from('media')),
        root,
        capacity.reserve,
        new AbortController().signal,
        'media-',
        async (path) => {
          expect(await readFile(path)).toEqual(Buffer.from('media'));
          expect(capacity.released()).toBe(0);
          throw refusal;
        },
        MediaFailure
      )
    ).rejects.toBe(refusal);
    await capacity.assertRemoved();
  });
});

describe('current retrieval representation copy', () => {
  it('preserves exact bytes and original method receivers through the final current-source proof', async () => {
    // Retrieval Kernel / Sidecar Cache Lifecycle: exact current bytes, never a partial representation.
    const root = await temporaryRoot();
    const path = join(root, 'representation');
    const bytes = Buffer.from('00ff800102030405', 'hex');
    const controller = new AbortController();
    const capacity = { recordWritten: vi.fn<(bytes: number) => void>() };
    let closed = false;
    let finalAdmission = false;
    let unchanged = false;
    faults.opened = (openedPath, handle) => {
      if (openedPath !== path) return;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closed = true;
      });
    };
    const input = {
      source: { projection: { representationDigest: digest(bytes) } },
      signal: controller.signal,
      assertCurrent() {
        expect(this).toBe(input);
        if (unchanged) {
          expect(closed).toBe(true);
          finalAdmission = true;
        }
      },
    };
    const current = {
      bytes,
      async *openRepresentation(signal: AbortSignal) {
        expect(this).toBe(current);
        expect(signal).toBe(controller.signal);
        yield this.bytes.subarray(0, 3);
        yield this.bytes.subarray(3);
      },
      async assertUnchanged(signal?: AbortSignal) {
        expect(this).toBe(current);
        expect(signal).toBe(controller.signal);
        expect(closed).toBe(true);
        expect(await readFile(path)).toEqual(this.bytes);
        unchanged = true;
      },
    };
    await writeVerifiedRepresentation(input, current, path, bytes.length, capacity);
    expect(await readFile(path)).toEqual(bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(capacity.recordWritten.mock.calls.flat()).toEqual([3, bytes.length - 3]);
    expect(finalAdmission).toBe(true);
    expect(unchanged).toBe(true);
  });

  it.each(['oversized chunk', 'excess length', 'short source', 'wrong digest'] as const)(
    'refuses a %s and leaves cleanup of private bytes with its caller',
    async (fault) => {
      const root = await temporaryRoot();
      const path = join(root, 'representation');
      const bytes = fault === 'oversized chunk' ? Buffer.alloc(65_537) : Buffer.from('complete');
      const size =
        bytes.length + (fault === 'short source' ? 1 : fault === 'excess length' ? -1 : 0);
      let closed = false;
      faults.opened = (openedPath, handle) => {
        if (openedPath !== path) return;
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          closed = true;
        });
      };
      const capacity = { recordWritten: vi.fn<(bytes: number) => void>() };
      const input = {
        source: {
          projection: {
            representationDigest: digest(fault === 'wrong digest' ? Buffer.from('other') : bytes),
          },
        },
        assertCurrent: vi.fn(),
      };
      const current = {
        async *openRepresentation() {
          yield bytes;
        },
        assertUnchanged: vi.fn(),
      };
      await expect(
        writeVerifiedRepresentation(input, current, path, size, capacity)
      ).rejects.toThrow();
      expect(closed).toBe(true);
      expect(await readFile(path)).toEqual(
        fault === 'oversized chunk' || fault === 'excess length' ? Buffer.alloc(0) : bytes
      );
      if (fault === 'oversized chunk' || fault === 'excess length')
        expect(capacity.recordWritten).not.toHaveBeenCalled();
      else expect(capacity.recordWritten).toHaveBeenCalledWith(bytes.length);
      await removePrivateTreeStrict(root);
    }
  );

  it.each(['cancelled', 'current refusal', 'unchanged refusal'] as const)(
    'closes private output and preserves the original %s',
    async (fault) => {
      const root = await temporaryRoot();
      const path = join(root, 'representation');
      const bytes = Buffer.from('current');
      const refusal = new Error(`Selected ${fault}.`);
      const controller = new AbortController();
      if (fault === 'cancelled') controller.abort(refusal);
      const capacity = { recordWritten: vi.fn<(bytes: number) => void>() };
      let closed = false;
      faults.opened = (openedPath, handle) => {
        if (openedPath !== path) return;
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          closed = true;
        });
      };
      await expect(
        writeVerifiedRepresentation(
          {
            source: { projection: { representationDigest: digest(bytes) } },
            signal: controller.signal,
            assertCurrent() {
              if (fault === 'current refusal') throw refusal;
            },
          },
          {
            async *openRepresentation() {
              yield bytes;
            },
            assertUnchanged() {
              if (fault === 'unchanged refusal') throw refusal;
            },
          },
          path,
          bytes.length,
          capacity
        )
      ).rejects.toBe(refusal);
      expect(closed).toBe(true);
      expect(await readFile(path)).toEqual(fault === 'unchanged refusal' ? bytes : Buffer.alloc(0));
    }
  );
});

describe('derived tree measurement and strict cleanup', () => {
  it('measures actual nested regular files and signals a crossed byte ceiling', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'one'), Buffer.alloc(3));
    await writeFile(join(root, 'nested', 'two'), Buffer.alloc(5));
    expect(await measureDerivedTreeBytes(root, 8, RetrievalFailure)).toBe(8);
    expect(await measureDerivedTreeBytes(root, 4, RetrievalFailure)).toBeGreaterThan(4);
  });

  it.each(['file', 'directory'] as const)(
    'refuses a derived %s symlink without changing its target',
    async (kind) => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      const sentinel = join(outside, 'sentinel');
      await writeFile(sentinel, 'retained original');
      await symlink(kind === 'file' ? sentinel : outside, join(root, 'link'));
      await expect(measureDerivedTreeBytes(root, 100, RetrievalFailure)).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect(await readFile(sentinel, 'utf8')).toBe('retained original');
    }
  );

  it('removes the selected private tree and preserves absent-path cleanup failure', async () => {
    const root = await temporaryRoot();
    const tree = join(root, 'private');
    await mkdir(join(tree, 'nested'), { recursive: true });
    await writeFile(join(tree, 'nested', 'bytes'), 'derived bytes');
    await writeFile(join(root, 'unselected'), 'retained bytes');
    await removePrivateTreeStrict(tree);
    expect(await readdir(root)).toEqual(['unselected']);
    await expect(removePrivateTreeStrict(tree)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'unselected'), 'utf8')).toBe('retained bytes');
  });
});
