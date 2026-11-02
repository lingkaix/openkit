// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withStagedMediaSource } from '@openkit/storage';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { FileAdmissionError, FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import {
  type MediaByteSource,
  MediaProcessFailure,
  type MediaStageReservation,
} from './media-process.js';

const faults = vi.hoisted(() => ({
  beforeWrite: undefined as undefined | (() => Promise<void>),
  cleanupRoot: undefined as string | undefined,
}));

// Faults stop only the selected syscall; all accepted bytes use real file handles.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const file = await actual.open(...args);
      const writeFile = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementation(async (data, options) => {
        await faults.beforeWrite?.();
        return writeFile(data, options);
      });
      return file;
    },
    async rm(...args: Parameters<typeof actual.rm>) {
      if (faults.cleanupRoot && String(args[0]).startsWith(`${faults.cleanupRoot}/`))
        throw new Error('Injected private-directory cleanup failure.');
      return actual.rm(...args);
    },
  };
});

afterEach(() => {
  faults.beforeWrite = undefined;
  faults.cleanupRoot = undefined;
  vi.restoreAllMocks();
});

/** Resolves an explicit operation boundary without elapsed-time polling. */
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Adapts the real shared filesystem admission owner to the public media boundary. */
async function fixture(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'media-staging-'));
  let available = 1000n;
  let releases = 0;
  const admission = new FileStorageAdmission(
    root,
    () => 0n,
    () => available
  );
  const reservations: Array<{ release(): void }> = [];
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
    for (const reservation of reservations) reservation.release();
  });
  const source: MediaByteSource = {
    sourceKey: 'artifact:media-staging-fixture',
    revision: '1',
    originalDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byteLength: bytes.length,
    async *open() {
      yield bytes;
    },
  };
  const capacity = (count: number) => ({
    stagingBytes: BigInt(count),
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 0n,
  });
  return {
    root,
    source,
    releases: () => releases,
    reserve(count: number): MediaStageReservation {
      const reservation = admission.reserve(capacity(count));
      reservations.push(reservation);
      return {
        recordWritten(count) {
          reservation.recordWritten(Number(count));
          available -= count;
        },
        release() {
          // Bounded Media Processors requires proved cleanup before storage release.
          expect(readdirSync(root)).toEqual([]);
          releases++;
          reservation.release();
        },
      };
    },
    reserveCompetitor(count: number) {
      return admission.reserve(capacity(count));
    },
  };
}

/** Invokes the current public boundary without substituting its implementation. */
function stage<T>(
  f: Awaited<ReturnType<typeof fixture>>,
  source: MediaByteSource,
  signal: AbortSignal,
  consume: (path: string) => Promise<T>
) {
  return withStagedMediaSource(
    source,
    f.root,
    f.reserve,
    signal,
    'private-',
    consume,
    MediaProcessFailure
  );
}

it('copies producer-owned bytes, verifies the complete source, and retains private staging until consumption ends', async () => {
  const bytes = Buffer.from('immutable original');
  const expected = Buffer.from(bytes);
  const f = await fixture(bytes);
  const writeStarted = latch();
  const permitWrite = latch();
  const sourceDrained = latch();
  const permitEnd = latch();
  const consumeStarted = latch();
  const permitConsume = latch();
  let consumed = false;
  let stagedPath = '';
  faults.beforeWrite = async () => {
    writeStarted.resolve();
    await permitWrite.promise;
  };
  const result = stage(
    f,
    {
      ...f.source,
      async *open() {
        yield bytes;
        sourceDrained.resolve();
        await permitEnd.promise;
      },
    },
    new AbortController().signal,
    async (path) => {
      consumed = true;
      stagedPath = path;
      // The accepted original is complete and read-only before processing starts.
      expect(await readFile(path)).toEqual(expected);
      expect((await stat(path)).mode & 0o777).toBe(0o400);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      consumeStarted.resolve();
      await permitConsume.promise;
      return 'processed';
    }
  );
  await Promise.race([writeStarted.promise, result]);
  bytes.fill(0x78);
  permitWrite.resolve();
  await Promise.race([sourceDrained.promise, result]);
  expect(consumed).toBe(false);
  expect(f.releases()).toBe(0);
  permitEnd.resolve();
  await Promise.race([consumeStarted.promise, result]);
  expect(readFileSync(stagedPath)).toEqual(expected);
  expect(f.releases()).toBe(0);
  permitConsume.resolve();
  await expect(result).resolves.toBe('processed');
  expect(readdirSync(f.root)).toEqual([]);
  expect(f.releases()).toBe(1);
});

it('cancels a stalled source and cleans up without waiting for its uncooperative return', async () => {
  const f = await fixture(Buffer.from('not delivered'));
  const reading = latch();
  const controller = new AbortController();
  const cancelled = new Error('Caller cancelled.');
  let returned = 0;
  let consumed = false;
  const result = stage(
    f,
    {
      ...f.source,
      open() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                reading.resolve();
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
    },
    controller.signal,
    async () => {
      consumed = true;
    }
  );
  const rejected = expect(result).rejects.toBe(cancelled);
  await reading.promise;
  controller.abort(cancelled);
  await rejected;
  expect(returned).toBe(1);
  expect(consumed).toBe(false);
  expect(readdirSync(f.root)).toEqual([]);
  expect(f.releases()).toBe(1);
});

it('retains uncertain cleanup capacity and reports the original media failure class with its closed reason', async () => {
  const bytes = Buffer.from('source');
  const f = await fixture(bytes);
  faults.cleanupRoot = f.root;
  let consumed = false;
  const failure = await stage(
    f,
    {
      ...f.source,
      async *open() {
        yield bytes.subarray(0, 2);
        throw new Error('Source failed after a partial write.');
      },
    },
    new AbortController().signal,
    async () => {
      consumed = true;
    }
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(MediaProcessFailure);
  expect(failure).toMatchObject({ reason: 'cleanup-unavailable', message: 'cleanup-unavailable' });
  expect(consumed).toBe(false);
  expect(f.releases()).toBe(0);
  const directories = readdirSync(f.root);
  expect(directories).toHaveLength(1);
  const directory = join(f.root, directories[0]!);
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  expect(statSync(join(directory, files[0]!)).size).toBe(2);
  // Core Storage counts both occupied bytes and the remaining write forecast.
  // Available 998 minus the held 4-byte forecast cannot admit a 995-byte write.
  expect(() => f.reserveCompetitor(995)).toThrow(FileAdmissionError);
});
