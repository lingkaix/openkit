import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MediaByteSource, runMediaProcess } from './media-process.js';
import { createVisionView, VISION_VIEW_LIMITS, type VisionViewLimits } from './vision-view.js';

// Every successful or resource-bound path still executes the real native tool and namespaces.
const observations = vi.hoisted(() => ({
  launches: [] as { args: string[]; child: import('node:child_process').ChildProcess }[],
  withoutIsolation: false,
  refuseCleanup: false,
  onDecode: undefined as ((pid: number | undefined) => void) | undefined,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const command = args[1] as string[];
      const child = observations.withoutIsolation
        ? actual.spawn(
            args[0],
            command.map((arg) => (arg === '/usr/bin/bwrap' ? '/fixture-missing-isolation' : arg)),
            args[2]
          )
        : actual.spawn(...args);
      observations.launches.push({ args: command, child });
      if (command.includes('png:-')) observations.onDecode?.(child.pid);
      return child;
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) => {
      if (observations.refuseCleanup && String(args[0]).includes('/vision-view-'))
        return Promise.reject(
          Object.assign(new Error('fixture cleanup refusal'), { code: 'EACCES' })
        );
      return actual.rm(...args);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  observations.onDecode = undefined;
  observations.withoutIsolation = false;
  observations.refuseCleanup = false;
  for (const { child } of observations.launches) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
  }
  observations.launches.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha = (bytes: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function chunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
/** Exact minimal raster fixtures with real CRCs; large headers need no host-side raster allocation. */
function png(
  width = 32,
  height = 16,
  options: { metadata?: Buffer; dimensionsOnly?: boolean; corruptData?: boolean } = {}
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scan = options.dimensionsOnly
    ? Buffer.from([0, 255, 0, 0, 255])
    : Buffer.alloc((width * 4 + 1) * height);
  if (!options.dimensionsOnly)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        scan[y * (width * 4 + 1) + x * 4 + 1] = 255;
        scan[y * (width * 4 + 1) + x * 4 + 4] = 255;
      }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(options.metadata ? [chunk('tEXt', options.metadata)] : []),
    chunk('IDAT', options.corruptData ? Buffer.from('not-zlib') : deflateSync(scan)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function apng(): Buffer {
  const first = png(1, 1);
  const ihdr = first.subarray(8, 33);
  const control = Buffer.alloc(8);
  control.writeUInt32BE(2);
  const frame = (sequence: number) => {
    const bytes = Buffer.alloc(26);
    bytes.writeUInt32BE(sequence);
    bytes.writeUInt32BE(1, 4);
    bytes.writeUInt32BE(1, 8);
    bytes.writeUInt16BE(1, 20);
    bytes.writeUInt16BE(10, 22);
    return bytes;
  };
  return Buffer.concat([
    first.subarray(0, 8),
    ihdr,
    chunk('acTL', control),
    chunk('fcTL', frame(0)),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('fcTL', frame(1)),
    chunk(
      'fdAT',
      Buffer.concat([Buffer.from([0, 0, 0, 2]), deflateSync(Buffer.from([0, 0, 0, 255, 255]))])
    ),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAQACADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcJ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnRDGqYAAAAAAD//Z',
  'base64'
);
const GIF = Buffer.from(
  'R0lGODlhIAAQAPAAAP8AAAAAACH5BAAAAAAALAAAAAAgABAAAAIUhI+py+0Po5y02ouz3rz7D4biSBUAOw==',
  'base64'
);
const WEBP = Buffer.from(
  'UklGRkgAAABXRUJQVlA4IDwAAAAQAwCdASogABAAPpE4l0eloyIhMAgAsBIJQBdl0AAQNgAA/u6mP/4DdfFtMv/3OB/3OB/3OB/HM1mAAAA=',
  'base64'
);
const ANIMATED_GIF = Buffer.from(
  'R0lGODlhIAAQAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAAAAAACwAAAAAIAAQAAACFISPqcvtD6OctNqLs968+w+G4kgVACH5BAAAAAAALAAAAAAgABAAAAIUhI+py+0Po5y02ouz3rz7D4biSBUAOw==',
  'base64'
);
const ANIMATED_WEBP = Buffer.from(
  'UklGRtQAAABXRUJQVlA4WAoAAAACAAAAHwAADwAAQU5JTQYAAAD/////AABBTk1GVAAAAAAAAAAAAB8AAA8AAGQAAAJWUDggPAAAABADAJ0BKiAAEAA+kTiXR6WjIiEwCACwEglAF2XQABA2AAD+7qY//gN18W0y//c4H/c4H/c4H8czWYAAAEFOTUZMAAAAAAAAAAAAHwAADwAAZAAAAFZQOCA0AAAAVAIAnQEqIAAQAD6ROJdHgwCAAAEglAF2AFpIAP71WL//c4H/+zgf/7OB/HX9eqWuTfJsAA==',
  'base64'
);
async function fixture(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'vision-test-'));
  roots.push(root);
  let held = 0;
  let opened = 0;
  let written = 0;
  let releases = 0;
  const source: MediaByteSource = {
    sourceKey: 'artifact:workspace_fixture:artifact_fixture:1',
    revision: '1',
    originalDigest: sha(bytes),
    byteLength: bytes.length,
    async *open() {
      opened++;
      for (let offset = 0; offset < bytes.length; offset += 65536)
        yield bytes.subarray(offset, offset + 65536);
    },
  };
  return {
    root,
    opened: () => opened,
    held: () => held,
    written: () => written,
    releases: () => releases,
    input: {
      requested: true as const,
      resourceProfileDigest: sha('fixture-parser-resources-v1'),
      source,
      temporaryRoot: root,
      reserveTemporaryBytes(size: number) {
        held += size;
        let remaining = size;
        return {
          recordWritten(bytes: bigint) {
            const count = Number(bytes);
            expect(count).toBeLessThanOrEqual(remaining);
            remaining -= count;
            held -= count;
            written += count;
          },
          release() {
            held -= remaining;
            remaining = 0;
            releases++;
          },
        };
      },
    },
  };
}
async function clean(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.held()).toBe(0);
  expect(await readdir(f.root)).toEqual([]);
}
const decodes = () => observations.launches.filter(({ args }) => args.includes('png:-'));
/** Wait for the actual native executable, rather than mistaking the outer launcher for the parser. */
async function findParser(root: number | undefined): Promise<number> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const pending = root ? [root] : [];
    while (pending.length) {
      const pid = pending.shift()!;
      try {
        if ((await readFile(`/proc/${pid}/comm`, 'utf8')).trim() === 'magick') return pid;
        const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
        pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
      } catch {
        /* It can exit between observations. */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Actual fixture parser was not observed');
}

describe('explicit isolated bounded vision views', () => {
  it.each([
    ['PNG', png()],
    ['JPEG', JPEG],
    ['GIF', GIF],
    ['WEBP', WEBP],
  ] as const)('creates a digest-bound exact PNG view of real %s input', async (format, bytes) => {
    const f = await fixture(bytes);
    const result = await createVisionView(f.input);
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error(result.reason);
    const v = result.view;
    expect(v.source.originalDigest).toBe(sha(bytes));
    expect(v.representationDigest).toBe(sha(v.bytes));
    expect(v.mediaType).toBe('image/png');
    expect(v.sourceImage).toMatchObject({ format, width: 32, height: 16, frames: 1 });
    expect(v.deliveredImage).toEqual({
      width: 32,
      height: 16,
      frames: 1,
      bitDepth: 8,
      pixels: 512,
      byteLength: v.bytes.length,
    });
    expect(v.locator).toEqual({
      kind: 'image',
      frame: 1,
      coordinateSpace: 'source-pixels',
      crop: { x: 0, y: 0, width: 32, height: 16 },
    });
    expect(v.processor.configuration).toMatchObject({
      headerGuard: 'raster-header-v1',
      encoding: 'PNG-RGBA8',
      colorSpace: 'sRGB',
      metadata: 'strip',
      orientation: 'auto',
      threadCount: 1,
      parserDescendants: 0,
      addressSpaceScope: 'per-process',
    });
    expect(v.coverage).toMatchObject({
      complete: false,
      provesCompleteBodyAbsence: false,
      omissions: ['metadata'],
    });
    await clean(f);
  });

  it('requires immutable packaged resource identity and changes cache identity when it changes', async () => {
    const f = await fixture(png());
    expect(await createVisionView({ ...f.input, resourceProfileDigest: '' })).toMatchObject({
      status: 'unavailable',
      reason: 'invalid-resource-profile',
    });
    expect(f.opened()).toBe(0);
    const one = await createVisionView(f.input);
    const two = await createVisionView({
      ...f.input,
      resourceProfileDigest: sha('fixture-parser-resources-v2'),
    });
    if (one.status !== 'available' || two.status !== 'available')
      throw new Error('Expected resource-bound views');
    expect(one.view.cacheKey).not.toBe(two.view.cacheKey);
    expect(one.view.representationId).not.toBe(two.view.representationId);
    expect(one.view.representationDigest).toBe(two.view.representationDigest);
    await clean(f);
  });
  it('reports original and delivered dimensions without calling a pure EXIF rotation resolution loss', async () => {
    const exif = Buffer.from(
      '45786966000049492a0008000000010012010300010000000600000000000000',
      'hex'
    );
    const size = Buffer.alloc(2);
    size.writeUInt16BE(exif.length + 2);
    const bytes = Buffer.concat([
      JPEG.subarray(0, 2),
      Buffer.from([255, 225]),
      size,
      exif,
      JPEG.subarray(2),
    ]);
    const f = await fixture(bytes);
    const result = await createVisionView(f.input);
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error(result.reason);
    expect(result.view.sourceImage).toMatchObject({ width: 32, height: 16 });
    expect(result.view.deliveredImage).toMatchObject({ width: 16, height: 32, pixels: 512 });
    expect(result.view.coverage.omissions).toEqual(['metadata']);
    await clean(f);
  });
  it('requires explicit intent before opening or launching anything', async () => {
    const f = await fixture(png());
    expect(
      await createVisionView({ ...f.input, requested: false as unknown as true })
    ).toMatchObject({ status: 'unavailable', reason: 'not-requested' });
    expect(f.opened()).toBe(0);
    expect(observations.launches).toHaveLength(0);
    await clean(f);
  });
  it('binds original/configuration identity, strips private metadata and preserves deterministic output bytes', async () => {
    const f = await fixture(
      png(64, 32, { metadata: Buffer.from('Comment\0PRIVATE_METADATA_CANARY') })
    );
    const first = await createVisionView(f.input);
    const again = await createVisionView(f.input);
    const smaller = await createVisionView({ ...f.input, limits: { maxDeliveredDimension: 16 } });
    if (
      first.status !== 'available' ||
      again.status !== 'available' ||
      smaller.status !== 'available'
    )
      throw new Error('Expected verified raster views');
    expect(first.view.bytes.equals(again.view.bytes)).toBe(true);
    expect(first.view.cacheKey).toBe(again.view.cacheKey);
    expect(first.view.bytes.includes(Buffer.from('PRIVATE_METADATA_CANARY'))).toBe(false);
    expect(smaller.view.deliveredImage).toMatchObject({ width: 16, height: 8 });
    expect(smaller.view.cacheKey).not.toBe(first.view.cacheKey);
    expect(smaller.view.representationId).not.toBe(first.view.representationId);
    expect(smaller.view.coverage.omissions).toContain('original-resolution');
    const changed = await fixture(png(63, 32));
    const other = await createVisionView(changed.input);
    if (other.status !== 'available') throw new Error(other.reason);
    expect(other.view.cacheKey).not.toBe(first.view.cacheKey);
    expect(other.view.source.originalDigest).not.toBe(first.view.source.originalDigest);
    await clean(f);
    await clean(changed);
  });
  it('refuses source dimensions, pixels and decoded-memory forecasts before raster decode', async () => {
    for (const limits of [
      { maxSourceDimension: 16 },
      { maxSourcePixels: 100 },
      { maxDecodedBytes: 1 },
    ]) {
      const f = await fixture(png());
      const result = await createVisionView({ ...f.input, limits });
      expect(result.status).toBe('unavailable');
      expect(decodes()).toHaveLength(0);
      await clean(f);
    }
    const f = await fixture(png(100000, 100000, { dimensionsOnly: true }));
    expect((await createVisionView(f.input)).status).toBe('unavailable');
    expect(decodes()).toHaveLength(0);
    await clean(f);
  });
  it('bounds encoded metadata and chunk framing before any image decode', async () => {
    for (const bytes of [
      png(1, 1, { metadata: Buffer.from('x'.repeat(200)) }),
      Buffer.concat([png(), Buffer.from('tail')]),
      png().subarray(0, 40),
    ]) {
      const f = await fixture(bytes);
      expect((await createVisionView({ ...f.input, limits: { maxHeaderBytes: 128 } })).status).toBe(
        'unavailable'
      );
      expect(decodes()).toHaveLength(0);
      await clean(f);
    }
  });
  it('rejects APNG controls even when the actual native ping reports only one frame', async () => {
    const bytes = apng();
    const f = await fixture(bytes);
    const path = join(f.root, 'proof.png');
    await writeFile(path, bytes);
    const signal = AbortSignal.timeout(3000);
    const proof = await runMediaProcess(
      '/usr/bin/magick',
      ['identify', '-ping', '-format', '%m %n', '/input.pdf'],
      VISION_VIEW_LIMITS,
      signal,
      path,
      4096,
      { MAGICK_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1', MAGICK_OCL_DEVICE: 'OFF' }
    );
    expect(proof.code).toBe(0);
    expect(proof.stdout.toString()).toBe('PNG 1');
    await rm(path);
    expect(await createVisionView(f.input)).toMatchObject({
      status: 'unavailable',
      reason: 'unsupported-animation',
    });
    expect(decodes()).toHaveLength(0);
    await clean(f);
  });
  it.each([
    ['GIF', ANIMATED_GIF],
    ['WEBP', ANIMATED_WEBP],
  ] as const)('rejects actual animated %s before decode', async (_format, bytes) => {
    const f = await fixture(bytes);
    expect(await createVisionView(f.input)).toMatchObject({
      status: 'unavailable',
      reason: 'unsupported-animation',
    });
    expect(decodes()).toHaveLength(0);
    await clean(f);
  });
  it.each([
    Buffer.from('<svg><image href="file:///PRIVATE"/></svg>'),
    Buffer.from('%PDF-1.7\n'),
    Buffer.from('PRIVATE_RAW_FAILURE'),
  ])('rejects delegate/vector/unknown bytes without body or error fallback', async (bytes) => {
    const f = await fixture(bytes);
    const result = await createVisionView(f.input);
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'unsupported-format',
      complete: false,
      provesCompleteBodyAbsence: false,
    });
    expect(decodes()).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    await clean(f);
  });
  it('refuses corrupt compressed pixels rather than returning a header-only success', async () => {
    const f = await fixture(png(32, 16, { corruptData: true }));
    const result = await createVisionView(f.input);
    expect(result.status).toBe('unavailable');
    await clean(f);
  });
  it('kills real encoding output at its independent delivered-byte ceiling', async () => {
    const f = await fixture(png());
    expect(await createVisionView({ ...f.input, limits: { maxDeliveredBytes: 40 } })).toMatchObject(
      { status: 'unavailable', reason: 'resource-limited' }
    );
    expect(decodes()).toHaveLength(1);
    await clean(f);
  });
  it('measures a complete 4MP source view within the pinned native and delivered bounds', async () => {
    const f = await fixture(png(2048, 2048));
    let observation: Promise<void> | undefined;
    let observedPeakKiB = 0;
    observations.onDecode = (root) => {
      observation = (async () => {
        const pid = await findParser(root);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try {
            const status = await readFile(`/proc/${pid}/status`, 'utf8');
            const peak = Number(/^VmHWM:\s+(\d+) kB$/m.exec(status)?.[1] ?? 0);
            observedPeakKiB = Math.max(observedPeakKiB, peak);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('Measured parser exceeded fixture deadline');
      })();
    };
    const started = Date.now();
    const result = await createVisionView(f.input);
    await observation;
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error(result.reason);
    expect(result.view.sourceImage).toMatchObject({
      width: 2048,
      height: 2048,
      decodedMemoryForecast: 536870912,
    });
    expect(result.view.deliveredImage).toMatchObject({
      width: 1024,
      height: 1024,
      pixels: 1048576,
    });
    expect(result.view.bytes.length).toBeLessThanOrEqual(1048576);
    expect(observedPeakKiB).toBeGreaterThan(0);
    expect(observedPeakKiB).toBeLessThan(1048576);
    console.info(
      JSON.stringify({
        fixture: 'vision-2048x2048',
        inputBytes: f.input.source.byteLength,
        deliveredBytes: result.view.bytes.length,
        elapsedMs: Date.now() - started,
        observedNativeVmHwmKiB: observedPeakKiB,
      })
    );
    await clean(f);
  });
  it('observes real parser hard limits and cancels it without retaining a view or stage', async () => {
    const f = await fixture(png(2048, 2048));
    const controller = new AbortController();
    let observation: Promise<void> | undefined;
    let pid: number | undefined;
    let limits = '';
    let parserStart = '';
    observations.onDecode = (root) => {
      observation = (async () => {
        pid = await findParser(root);
        limits = await readFile(`/proc/${pid}/limits`, 'utf8');
        parserStart = processIdentity(await readFile(`/proc/${pid}/stat`, 'utf8')).start;
        controller.abort();
      })();
    };
    const result = await createVisionView({ ...f.input, signal: controller.signal });
    await observation;
    expect(result).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
    expect(pid).toBeTypeOf('number');
    await expectStopped(pid!, parserStart);
    expect(limits).toMatch(/Max address space\s+1073741824\s+1073741824/);
    expect(limits).toMatch(/Max cpu time\s+5\s+5/);
    expect(limits).toMatch(/Max processes\s+0\s+0/);
    expect(limits).toMatch(/Max file size\s+0\s+0/);
    await clean(f);
  });
  it('enforces wall time against a stopped actual image parser and proves stage cleanup', async () => {
    const f = await fixture(png(2048, 2048));
    let observation: Promise<void> | undefined;
    let stopped = false;
    let parserPid = 0;
    let parserStart = '';
    observations.onDecode = (root) => {
      observation = (async () => {
        const pid = await findParser(root);
        parserPid = pid;
        parserStart = processIdentity(await readFile(`/proc/${pid}/stat`, 'utf8')).start;
        process.kill(pid, 'SIGSTOP');
        stopped = true;
      })();
    };
    const started = Date.now();
    const result = await createVisionView({ ...f.input, limits: { wallTimeMs: 1000 } });
    await observation;
    expect(stopped).toBe(true);
    await expectStopped(parserPid, parserStart);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'resource-limited' });
    expect(Date.now() - started).toBeLessThan(3000);
    await clean(f);
  });
  it('bounds a stalled source, rejects drift/storage/staging failures, and preserves the original', async () => {
    const bytes = png();
    const f = await fixture(bytes);
    expect(await createVisionView({ ...f.input, limits: { maxInputBytes: 1 } })).toMatchObject({
      status: 'unavailable',
      reason: 'resource-limited',
    });
    expect(f.opened()).toBe(0);
    expect(
      await createVisionView({
        ...f.input,
        reserveTemporaryBytes() {
          throw new Error('PRIVATE_CAPACITY');
        },
      })
    ).toMatchObject({ status: 'unavailable', reason: 'resource-limited' });
    expect(
      await createVisionView({ ...f.input, temporaryRoot: join(f.root, 'missing') })
    ).toMatchObject({ status: 'unavailable', reason: 'source-unavailable' });
    expect(
      await createVisionView({
        ...f.input,
        source: { ...f.input.source, originalDigest: `sha256:${'0'.repeat(64)}` },
      })
    ).toMatchObject({ status: 'unavailable', reason: 'source-changed' });
    expect(
      await createVisionView({
        ...f.input,
        source: {
          ...f.input.source,
          async *open() {
            await new Promise(() => {});
            yield Buffer.alloc(0);
          },
        },
        limits: { wallTimeMs: 100 },
      })
    ).toMatchObject({ status: 'unavailable', reason: 'resource-limited' });
    expect(sha(bytes)).toBe(f.input.source.originalDigest);
    await clean(f);
  });
  it('accounts completed stage writes before the next source chunk and retains cleanup uncertainty', async () => {
    const bytes = png();
    const f = await fixture(bytes);
    const source = {
      ...f.input.source,
      async *open() {
        yield bytes.subarray(0, 32);
        expect(f.written()).toBe(32);
        yield bytes.subarray(32);
      },
    };
    const result = await createVisionView({ ...f.input, source });
    expect(result.status).toBe('available');
    expect(f.written()).toBe(bytes.length);
    expect(f.releases()).toBe(1);
    await clean(f);
    const refused = await fixture(bytes);
    observations.refuseCleanup = true;
    expect(await createVisionView(refused.input)).toMatchObject({
      status: 'unavailable',
      reason: 'cleanup-unavailable',
    });
    expect(refused.written()).toBe(bytes.length);
    expect(refused.releases()).toBe(0);
    expect(
      (await readdir(refused.root)).filter((name) => name.startsWith('vision-view-'))
    ).toHaveLength(1);
    observations.refuseCleanup = false;
  });
  it('fails closed when the actual isolation executable is unavailable', async () => {
    const f = await fixture(png());
    observations.withoutIsolation = true;
    expect(await createVisionView(f.input)).toEqual({
      status: 'unavailable',
      reason: 'dependency-unavailable',
      complete: false,
      provesCompleteBodyAbsence: false,
    });
    expect(f.opened()).toBe(0);
    await clean(f);
  });
  it('pins finite independent ceilings before any processing begins', () => {
    expect(VISION_VIEW_LIMITS).toEqual({
      maxInputBytes: 33554432,
      maxSourceDimension: 8192,
      maxSourcePixels: 16777216,
      maxFrames: 1,
      maxDecodedBytes: 536870912,
      maxDeliveredDimension: 1024,
      maxDeliveredPixels: 1048576,
      maxDeliveredBytes: 1048576,
      maxHeaderBytes: 65536,
      maxChunkHeaders: 1024,
      addressSpaceBytes: 1073741824,
      cpuSeconds: 5,
      wallTimeMs: 15000,
    } satisfies VisionViewLimits);
  });
});

function processIdentity(stat: string): { state: string; start: string } {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  return { state: fields[0]!, start: fields[19]! };
}
async function expectStopped(pid: number, start: string): Promise<void> {
  try {
    const current = processIdentity(await readFile(`/proc/${pid}/stat`, 'utf8'));
    expect(current.start !== start || ['Z', 'X'].includes(current.state)).toBe(true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
