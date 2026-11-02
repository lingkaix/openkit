// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { type FileHandle, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { FileStorageAdmission, type FileStorageReservation } from './file-admission.js';
import { ArtifactPayloadCleanupError, stageArtifactPayload } from './file-payload.js';

const mutation = vi.hoisted(() => ({
  opened: undefined as undefined | ((path: string, handle: FileHandle) => void),
  removing: undefined as undefined | ((path: string) => void),
}));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      mutation.opened?.(String(args[0]), handle);
      return handle;
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      mutation.removing?.(String(args[0]));
      return actual.rm(...args);
    },
  };
});

const fixtures: Array<{ root: string; reservation: FileStorageReservation }> = [];
afterEach(async () => {
  mutation.opened = undefined;
  mutation.removing = undefined;
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    await rm(fixture.root, { recursive: true, force: true });
    fixture.reservation.release();
  }
});

/** A held real I/O result makes each lifetime boundary observable without a timer race. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Uses the real capacity owner and filesystem; the injected free-space source is fixture-local. */
async function fixture(length: number) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-physical-lifetime-'));
  const workspaceRoot = join(root, 'workspaces', 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const capacity = BigInt(length) + 64n;
  const admission = new FileStorageAdmission(
    root,
    () => 0n,
    () => capacity
  );
  const reservation = admission.reserve({
    stagingBytes: BigInt(length),
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 64n,
  });
  fixtures.push({ root, reservation });
  const staging = join(root, 'workspaces', '.staging');
  return {
    workspaceRoot,
    reservation,
    admission,
    capacity,
    staging,
    payload: (path: string) => path.startsWith(`${staging}/artifact-`) && path.endsWith('/payload'),
  };
}

/** Hashes original fixture bytes independently of the capture implementation. */
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

it('joins an accepted pending write before abort cleanup and applies stream backpressure', async () => {
  const chunk = Buffer.alloc(65_536, 0xff),
    bytes = Buffer.concat(Array(64).fill(chunk));
  const f = await fixture(bytes.length),
    entered = gate(),
    pending = gate();
  const events: string[] = [];
  mutation.opened = (path, handle) => {
    if (!f.payload(path)) return;
    const write = handle.write.bind(handle),
      close = handle.close.bind(handle);
    vi.spyOn(handle, 'write').mockImplementation((async (buffer: Buffer, offset = 0) => {
      const result = await write(buffer, offset);
      entered.release();
      await pending.promise;
      return result;
    }) as FileHandle['write']);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      events.push('close');
      await close();
    });
  };
  mutation.removing = (path) => {
    if (path.startsWith(`${f.staging}/artifact-`)) events.push('remove');
  };
  let produced = 0,
    settled = false;
  const source = Readable.from(
    (function* () {
      for (let index = 0; index < 64; index++) {
        produced++;
        yield chunk;
      }
    })()
  );
  const controller = new AbortController();
  const work = stageArtifactPayload({
    ...f,
    source,
    expectedByteLength: bytes.length,
    expectedDigest: digest(bytes),
    signal: controller.signal,
  });
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await entered.promise;
    expect(produced).toBeLessThan(64);
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(events).toEqual([]);
    pending.release();
    await rejected;
    expect(source.destroyed).toBe(true);
    expect(events).toEqual(['close', 'remove']);
    expect(await readdir(f.staging)).toEqual([]);
  } finally {
    pending.release();
    await Promise.allSettled([work]);
  }
});

it('accounts real short writes before durable payload sync, close and request-directory acknowledgement', async () => {
  // Work Resource Interaction: actual accepted bytes become occupied disk; durable bytes precede references.
  const bytes = Buffer.from('00ffc328800a010203', 'hex'),
    f = await fixture(bytes.length);
  const fileEntered = gate(),
    fileContinue = gate(),
    directoryEntered = gate(),
    directoryContinue = gate();
  const events: string[] = [],
    written: number[] = [];
  let payload = '',
    settled = false;
  const record = f.reservation.recordWritten.bind(f.reservation);
  vi.spyOn(f.reservation, 'recordWritten').mockImplementation((count) => {
    written.push(count);
    record(count);
  });
  mutation.opened = (path, handle) => {
    const sync = handle.sync.bind(handle),
      close = handle.close.bind(handle);
    if (f.payload(path)) {
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
  const work = stageArtifactPayload({
    ...f,
    source: Readable.from([bytes]),
    expectedByteLength: bytes.length,
    expectedDigest: digest(bytes),
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
    await fileEntered.promise;
    expect(written).toEqual([2, 2, 2, 2, 1]);
    expect(await readFile(payload)).toEqual(bytes);
    expect(settled).toBe(false);
    fileContinue.release();
    await directoryEntered.promise;
    expect(events).toEqual(['payload-sync', 'payload-close']);
    expect(settled).toBe(false);
    directoryContinue.release();
    const staged = await work;
    expect(events).toEqual(['payload-sync', 'payload-close', 'directory-sync']);
    expect(staged).toMatchObject({ byteLength: bytes.length, contentDigest: digest(bytes) });
    await staged.remove();
  } finally {
    fileContinue.release();
    directoryContinue.release();
    await Promise.allSettled([work]);
  }
});

it('preserves accepted accounting, remaining capacity and flat original causes when cleanup fails', async () => {
  const bytes = Buffer.from('original'),
    f = await fixture(bytes.length);
  const writeFailure = new Error('Selected write failure'),
    closeFailure = new Error('Selected close failure'),
    removeFailure = new Error('Selected removal failure');
  let payload = '',
    writes = 0;
  const recorded = vi.spyOn(f.reservation, 'recordWritten'),
    release = vi.spyOn(f.reservation, 'release');
  mutation.opened = (path, handle) => {
    if (!f.payload(path)) return;
    payload = path;
    const write = handle.write.bind(handle),
      close = handle.close.bind(handle);
    vi.spyOn(handle, 'write').mockImplementation((async (buffer: Buffer, offset = 0) => {
      if (writes++ > 0) throw writeFailure;
      return write(buffer, offset, 2);
    }) as FileHandle['write']);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      await close();
      throw closeFailure;
    });
  };
  mutation.removing = (path) => {
    if (path === dirname(payload)) throw removeFailure;
  };
  const error = await stageArtifactPayload({
    ...f,
    source: Readable.from([bytes]),
    expectedByteLength: bytes.length,
    expectedDigest: digest(bytes),
  }).then(
    () => undefined,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(ArtifactPayloadCleanupError);
  expect((error as Error).cause).toBeInstanceOf(AggregateError);
  const causes = ((error as Error).cause as AggregateError).errors;
  expect(causes).toHaveLength(3);
  for (const [index, cause] of [writeFailure, closeFailure, removeFailure].entries())
    expect(causes[index]).toBe(cause);
  expect(recorded.mock.calls).toEqual([[2]]);
  expect(await readFile(payload)).toEqual(bytes.subarray(0, 2));
  expect(release).not.toHaveBeenCalled();
  // Work Resource Interaction: failed cleanup retains the remaining forecast, never free capacity.
  expect(() =>
    f.admission.reserve({
      stagingBytes: f.capacity,
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: 0n,
    })
  ).toThrow('Storage capacity');
});
